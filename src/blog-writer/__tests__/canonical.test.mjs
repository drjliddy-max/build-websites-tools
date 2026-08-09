/**
 * Canonical blog-writer test suite.
 *
 * Regression fixtures are real historical failures, not invented ones:
 *  - the qirofit 2026-08-08 draft's 167-character meta description
 *  - the banned word "cure" in the same draft
 * Both reached a governed queue and were repaired by hand. They must now fail
 * mechanically, before anything irreversible happens.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRegistry,
  validateRegistration,
  RegistrationError,
  DISALLOWED_IMAGE_PATHS,
} from "../registry.js";
import { validateArticle, validateImage, slugify } from "../validators.js";
import { parseModelJson, buildPrompt, generateArticle, GenerationError } from "../generator.js";
import { acquireImage, createPexelsProvider, createMemoryStore, imageFilename } from "../imageProvider.js";
import {
  assertTransition,
  buildProof,
  createDurableReporter,
  createInMemoryTestSink,
  idempotencyKey,
  StateTransitionError,
} from "../proof.js";
import { runBlogWriterPipeline, PIPELINE_VERSION } from "../pipeline.js";

// ── fixtures ───────────────────────────────────────────────────────────────

const SITE = {
  siteId: "qirofit",
  domain: "qirofit.com",
  laneKey: "blog-writer-qirofit",
  repository: { owner: "drjliddy-max", name: "qirofit-web" },
  blogPath: "/blog",
  keywordSource: { primary: "keywords/primary.csv", supporting: "keywords/supporting.csv" },
  contentContext: {
    audience: "athletes and sports-injury rehab patients in Los Angeles",
    voice: "physician-directed, clinical but approachable",
    expertise: "D.C. with 20+ years in performance medicine",
    prohibitedTerms: ["wellness journey", "transform your life", "pain-free"],
  },
  imagePolicy: { required: true, provider: "pexels", queryHint: "athlete recovery rehabilitation" },
  publication: {
    adapter: "github-repo-commit",
    workflowFile: "blog-writer-qirofit-publish.yml",
    schedulePath: "blog-schedule.json",
    draftDir: ".siteclinic/automation/blog-writer-qirofit/drafts",
  },
  credentials: { github: "GITHUB_TOKEN", pexels: "PEXELS_API_KEY" },
  monitorKey: "blog-writer-qirofit",
};

function goodBody() {
  const para = (n) =>
    `This is body paragraph ${n} about cupping therapy for athletes, written to exceed the ` +
    `minimum length while staying readable and specific to the assigned topic of recovery work. ` +
    `It discusses myofascial technique, load management, and how manual work fits training. `;
  return [
    para(1).repeat(3),
    "## What cupping therapy actually does",
    para(2).repeat(3),
    "## Where it fits alongside strength work",
    para(3).repeat(3),
    "## When to book cupping therapy",
    para(4).repeat(3) + "That is the honest summary.",
  ].join("\n\n");
}

const GOOD_ARTICLE = {
  title: "What cupping therapy does for athletes",
  slug: "what-cupping-therapy-does-for-athletes",
  metaDescription:
    "Cupping therapy is not magic and it is not useless. Here is what it helps with, what it will not fix, and how it fits with your strength training.",
  body: goodBody(),
  imageQuery: "athlete recovery massage therapy",
  keyword: "cupping therapy Los Angeles",
  supportingKeywords: [],
};

const NO_HISTORY = { slugs: [], titles: [] };

// ── registry ───────────────────────────────────────────────────────────────

test("registry: a valid registration is accepted", () => {
  assert.equal(validateRegistration(SITE).siteId, "qirofit");
});

test("registry: credentials must be env var NAMES, never values", () => {
  assert.throws(
    () => validateRegistration({ ...SITE, credentials: { pexels: "sk-live-abc123" } }),
    RegistrationError,
  );
});

test("registry: repo-hosted images require an explicit opt-out reason", () => {
  assert.throws(
    () => validateRegistration({ ...SITE, imagePolicy: { required: true, provider: "repo-hosted" } }),
    /optOutReason/,
  );
  assert.ok(
    validateRegistration({
      ...SITE,
      imagePolicy: {
        required: true,
        provider: "repo-hosted",
        repoAsset: "/photos/x.jpg",
        optOutReason: "practice-owned clinical photography",
      },
    }),
  );
});

test("registry: duplicate siteId or laneKey is rejected", () => {
  assert.throws(() => buildRegistry([SITE, SITE]), /duplicate/);
});

test("PART 5 PROOF: an eighth site enrols by registration alone", () => {
  // No file is copied, no writer is cloned. A config object is the whole change.
  const eighth = {
    ...SITE,
    siteId: "test-site",
    domain: "test-site.example",
    laneKey: "blog-writer-test-site",
    repository: { owner: "drjliddy-max", name: "test-site-web" },
    monitorKey: "blog-writer-test-site",
    publication: { ...SITE.publication, workflowFile: "blog-writer-test-site-publish.yml" },
  };
  const registry = buildRegistry([SITE, eighth]);
  assert.equal(registry.ids().length, 2);
  assert.equal(registry.get("test-site").domain, "test-site.example");
  assert.equal(registry.getByLane("blog-writer-test-site").siteId, "test-site");
});

test("PART 5 PROOF: removing the entry removes pipeline participation", () => {
  const registry = buildRegistry([SITE]);
  assert.equal(registry.has("test-site"), false);
  assert.throws(() => registry.get("test-site"), /not registered/);
});

// ── validators: the real historical regressions ────────────────────────────

test("REGRESSION (qirofit 2026-08-08): a 167-character meta description fails", () => {
  // The published meta (147 chars, verified live 2026-08-09) is the REPAIRED
  // one. The pre-repair text was 167 chars; its exact wording is not recorded,
  // so the fixture pins the quantity that is known, the length that breached
  // the 160 limit, rather than inventing prose and presenting it as history.
  const published =
    "Cupping is not magic and it is not useless. Here is what it is good at, what it will not fix, " +
    "and how it fits with the strength work that holds it.";
  assert.equal(published.length, 147, "the live meta description is 147 chars");
  const meta = published.padEnd(167, " x");
  assert.equal(meta.length, 167, "fixture must reproduce the historical length");
  const result = validateArticle({
    article: { ...GOOD_ARTICLE, metaDescription: meta },
    site: SITE,
    history: NO_HISTORY,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "meta-length" && i.detail === 167));
});

test("REGRESSION (qirofit 2026-08-08): the banned word 'cure' fails", () => {
  const result = validateArticle({
    article: { ...GOOD_ARTICLE, body: `${GOOD_ARTICLE.body}\n\nCupping does not cure anything.` },
    site: SITE,
    history: NO_HISTORY,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "prohibited-term" && i.detail === "cure"));
});

test("validators: the corrected article passes", () => {
  const result = validateArticle({ article: GOOD_ARTICLE, site: SITE, history: NO_HISTORY });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
});

test("validators: site-registered prohibited terms are enforced", () => {
  const result = validateArticle({
    article: { ...GOOD_ARTICLE, body: `${GOOD_ARTICLE.body}\n\nStart your wellness journey today.` },
    site: SITE,
    history: NO_HISTORY,
  });
  assert.ok(result.issues.some((i) => i.detail === "wellness journey"));
});

test("validators: duplicate slug and duplicate title are rejected", () => {
  const result = validateArticle({
    article: GOOD_ARTICLE,
    site: SITE,
    history: { slugs: [GOOD_ARTICLE.slug], titles: [GOOD_ARTICLE.title] },
  });
  assert.ok(result.issues.some((i) => i.code === "duplicate-slug"));
  assert.ok(result.issues.some((i) => i.code === "duplicate-title"));
});

test("validators: placeholder residue and truncation are rejected", () => {
  const residue = validateArticle({
    article: { ...GOOD_ARTICLE, body: `${GOOD_ARTICLE.body}\n\n[INSERT CONCLUSION HERE]` },
    site: SITE,
    history: NO_HISTORY,
  });
  assert.ok(residue.issues.some((i) => i.code === "placeholder-residue"));

  const truncated = validateArticle({
    article: { ...GOOD_ARTICLE, body: `${GOOD_ARTICLE.body} and then the sentence just stops` },
    site: SITE,
    history: NO_HISTORY,
  });
  assert.ok(truncated.issues.some((i) => i.code === "truncated-body"));
});

test("validators: an article that drifts off its keyword is rejected", () => {
  const result = validateArticle({
    article: {
      ...GOOD_ARTICLE,
      title: "How to choose running shoes for marathons",
      body: goodBody().replace(/cupping therapy/g, "shoe selection"),
      keyword: "myofascial decompression protocol",
    },
    site: SITE,
    history: NO_HISTORY,
  });
  assert.ok(result.issues.some((i) => i.code === "topic-drift"));
});

test("validators: unsupported fields are a contract breach", () => {
  const result = validateArticle({
    article: { ...GOOD_ARTICLE, publishNow: true },
    site: SITE,
    history: NO_HISTORY,
  });
  assert.ok(result.issues.some((i) => i.code === "unsupported-field"));
});

test("validators: /og-image.jpg is rejected as an article photo", () => {
  const result = validateImage({
    image: { url: "/og-image.jpg", alt: "a sufficiently long alt text", provider: "pexels" },
    site: SITE,
    disallowedPaths: DISALLOWED_IMAGE_PATHS,
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "image-disallowed"));
});

test("validators: image provider must match the registered policy", () => {
  const result = validateImage({
    image: { url: "/photos/x.jpg", alt: "a sufficiently long alt text", provider: "repo-hosted" },
    site: SITE,
    disallowedPaths: DISALLOWED_IMAGE_PATHS,
  });
  assert.ok(result.issues.some((i) => i.code === "image-provider-mismatch"));
});

test("slugify is deterministic and url-safe", () => {
  assert.equal(slugify("What cupping actually does, and when it's worth it"),
    "what-cupping-actually-does-and-when-it-s-worth-it");
});

// ── generator ──────────────────────────────────────────────────────────────

test("generator: the prompt carries every site constraint", () => {
  const prompt = buildPrompt({
    site: SITE,
    keyword: "cupping therapy Los Angeles",
    supportingKeywords: [],
    occurrence: "2026-08-22",
    history: { slugs: [], titles: ["An earlier article"] },
    constraints: { titleMin: 20, titleMax: 70, metaMin: 70, metaMax: 160, bodyMinWords: 400, bodyMaxWords: 2500, minH2Count: 3 },
  });
  assert.match(prompt, /70-160 characters/);
  assert.match(prompt, /wellness journey/);
  assert.match(prompt, /cure, cures, guarantee/);
  assert.match(prompt, /An earlier article/);
  assert.match(prompt, /qirofit\.com/);
});

test("generator: model JSON is extracted from fenced or noisy output", () => {
  const payload = '{"title":"t","metaDescription":"m","body":"b","imageQuery":"q"}';
  assert.equal(parseModelJson(payload).title, "t");
  assert.equal(parseModelJson("```json\n" + payload + "\n```").title, "t");
  assert.equal(parseModelJson("Here you go:\n" + payload + "\nHope that helps!").title, "t");
});

test("generator: malformed or empty model output fails closed", () => {
  assert.throws(() => parseModelJson(""), GenerationError);
  assert.throws(() => parseModelJson("I cannot help with that."), GenerationError);
  assert.throws(() => parseModelJson('{"title":"only"}'), /metaDescription/);
});

test("generator: output is never self-certified, validation runs separately", async () => {
  const stub = {
    id: "stub",
    model: "stub",
    complete: async () =>
      JSON.stringify({
        title: "A guaranteed cure for every athlete injury",
        metaDescription: "short",
        body: "tiny",
        imageQuery: "x",
      }),
  };
  const article = await generateArticle({
    site: SITE,
    keyword: "cupping therapy Los Angeles",
    occurrence: "2026-08-22",
    provider: stub,
    constraints: { titleMin: 20, titleMax: 70, metaMin: 70, metaMax: 160, bodyMinWords: 400, bodyMaxWords: 2500, minH2Count: 3 },
  });
  // generateArticle returns it happily...
  assert.equal(article.title, "A guaranteed cure for every athlete injury");
  // ...and validation is what stops it.
  const result = validateArticle({ article, site: SITE, history: NO_HISTORY });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.detail === "cure"));
  assert.ok(result.issues.some((i) => i.detail === "guaranteed"));
});

// ── image pipeline (recorded fixtures, no credential) ──────────────────────

const PEXELS_FIXTURE = {
  photos: [
    { id: 1, width: 800, height: 600, photographer: "Too Small", src: { large2x: "https://images.pexels.com/small.jpg" } },
    {
      id: 4321,
      width: 3000,
      height: 2000,
      photographer: "Jane Doe",
      photographer_url: "https://pexels.com/@janedoe",
      alt: "An athlete performing a recovery stretch on a gym floor",
      src: { large2x: "https://images.pexels.com/photos/4321/large2x.jpg" },
    },
  ],
};

function fixtureFetch(imageBytes = 250_000) {
  return async (url) => {
    const href = String(url);
    if (href.includes("api.pexels.com")) {
      return { ok: true, status: 200, json: async () => PEXELS_FIXTURE };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new ArrayBuffer(imageBytes),
    };
  };
}

test("image: the real client boundary works from a recorded response", async () => {
  process.env.PEXELS_API_KEY = "fixture-key";
  const provider = createPexelsProvider({ fetchImpl: fixtureFetch() });
  const store = createMemoryStore();
  const result = await acquireImage({ site: SITE, article: GOOD_ARTICLE, provider, store });

  assert.equal(result.status, "acquired");
  assert.equal(result.image.provider, "pexels");
  assert.equal(result.image.photographer, "Jane Doe");
  assert.equal(result.image.licence, "Pexels License");
  // the 800px candidate must be skipped for the 3000px one
  assert.match(result.image.url, /4321/);
  assert.equal(result.image.byteLength, 250_000);
  assert.equal(store.size(), 1);
  delete process.env.PEXELS_API_KEY;
});

test("image: acquisition without a credential fails closed, it does not fall back", async () => {
  delete process.env.PEXELS_API_KEY;
  const provider = createPexelsProvider({ fetchImpl: fixtureFetch() });
  await assert.rejects(
    () => acquireImage({ site: SITE, article: GOOD_ARTICLE, provider, store: createMemoryStore() }),
    /PEXELS_API_KEY is not set/,
  );
});

test("image: a declared repo-hosted policy is recorded as such, not as Pexels", async () => {
  const optOut = {
    ...SITE,
    imagePolicy: {
      required: true,
      provider: "repo-hosted",
      repoAsset: "/photos/modality-cupping.jpg",
      optOutReason: "practice-owned clinical photography",
    },
  };
  const result = await acquireImage({ site: optOut, article: GOOD_ARTICLE, provider: null, store: null });
  assert.equal(result.status, "repo-hosted");
  assert.equal(result.image.provider, "repo-hosted");
  assert.notEqual(result.image.provider, "pexels");
});

test("image: filenames are deterministic and never overwrite", async () => {
  assert.equal(
    imageFilename({ slug: "what-cupping-does", photoId: 4321, contentType: "image/jpeg" }),
    "what-cupping-does-4321.jpg",
  );
  const store = createMemoryStore();
  await store.put({ filename: "a.jpg", buffer: Buffer.alloc(10), contentType: "image/jpeg" });
  await assert.rejects(
    () => store.put({ filename: "a.jpg", buffer: Buffer.alloc(10), contentType: "image/jpeg" }),
    /Refusing to overwrite/,
  );
});

// ── proof + state machine ──────────────────────────────────────────────────

test("proof: illegal state transitions are refused", () => {
  assert.equal(assertTransition("READY", "GENERATED"), "GENERATED");
  assert.throws(() => assertTransition("READY", "PUBLISHED"), StateTransitionError);
  assert.throws(() => assertTransition("COMPLETE", "PUBLISHED"), StateTransitionError);
  assert.throws(() => assertTransition("VALIDATED", "COMPLETE"), StateTransitionError);
});

test("proof: provenance must be declared and cannot be inferred", () => {
  assert.throws(
    () => buildProof({ laneKey: "l", siteId: "s", occurrence: "2026-08-22", state: "COMPLETE", provenance: {}, pipelineVersion: "1" }),
    /provenance\.classification/,
  );
});

test("PART 12 PROOF: a historical article cannot claim canonical provenance", () => {
  const historical = buildProof({
    laneKey: "blog-writer-qirofit",
    siteId: "qirofit",
    occurrence: "2026-08-08",
    state: "COMPLETE",
    article: { title: "What cupping actually does", slug: "what-cupping-actually-does", metaDescription: "m", body: "b" },
    image: { url: "/photos/modality-cupping.jpg", alt: "a", provider: "repo-hosted" },
    publication: { commitSha: "161ec41" },
    verification: { articleStatus: 200, imageStatus: 200 },
    provenance: {
      classification: "HISTORICAL_PRE_CANONICAL",
      generatedBy: "hand-authored",
      imageProvider: "repo-hosted",
      note: "published before the canonical pipeline existed",
    },
    pipelineVersion: PIPELINE_VERSION,
  });
  assert.equal(historical.provenance.classification, "HISTORICAL_PRE_CANONICAL");
  assert.notEqual(historical.provenance.generatedBy, "canonical-pipeline");
  assert.notEqual(historical.provenance.imageProvider, "pexels");
});

test("proof: durable reporter survives a new reporter instance over the same sink", async () => {
  const sink = createInMemoryTestSink();
  const first = createDurableReporter({ sink });
  await first.report(
    buildProof({
      laneKey: "blog-writer-qirofit", siteId: "qirofit", occurrence: "2026-08-22", state: "COMPLETE",
      provenance: { classification: "NEW_CANONICAL" }, pipelineVersion: PIPELINE_VERSION,
    }),
  );
  const second = createDurableReporter({ sink });
  assert.equal(await second.alreadyPublished("blog-writer-qirofit", "2026-08-22"), true);
  assert.equal(await second.alreadyPublished("blog-writer-qirofit", "2026-09-05"), false);
});

test("proof: idempotency key is stable", () => {
  assert.equal(
    idempotencyKey({ laneKey: "blog-writer-qirofit", occurrence: "2026-08-22" }),
    "blog-writer-qirofit:2026-08-22:1",
  );
});

// ── pipeline integration ───────────────────────────────────────────────────

function pipelineDeps({ modelOutput, schedule, sink = createInMemoryTestSink() }) {
  process.env.PEXELS_API_KEY = "fixture-key";
  return {
    registry: buildRegistry([SITE]),
    schedule: { load: async () => schedule },
    keywords: {
      load: async () => [
        { keyword: "cupping therapy Los Angeles", supporting: ["myofascial cupping"] },
      ],
    },
    provider: { id: "stub", model: "stub-1", complete: async () => modelOutput },
    imageProvider: createPexelsProvider({ fetchImpl: fixtureFetch() }),
    imageStore: createMemoryStore(),
    reporter: createDurableReporter({ sink }),
    verifier: { check: async () => ({ status: 200 }) },
    publisher: { publish: async () => ({ commitSha: "deadbeef" }) },
    _sink: sink,
  };
}

const ANCHORED_SCHEDULE = {
  published: [{ slug: "prior", title: "A prior article", target_date: "2026-08-08", keywords: ["other"] }],
  queue: [],
};

test("pipeline: dry-run runs every stage and commits nothing", async () => {
  const deps = pipelineDeps({
    modelOutput: JSON.stringify({
      title: GOOD_ARTICLE.title,
      metaDescription: GOOD_ARTICLE.metaDescription,
      body: GOOD_ARTICLE.body,
      imageQuery: GOOD_ARTICLE.imageQuery,
    }),
    schedule: ANCHORED_SCHEDULE,
  });
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "dry-run" },
    deps,
  );
  assert.equal(result.ok, true, JSON.stringify(result.proof?.failure));
  assert.equal(result.state, "VALIDATED");
  assert.equal(result.proof.publication.committed, false);
  assert.equal(result.image.provider, "pexels");
  const staged = result.stages.map((s) => s.stage);
  for (const stage of ["resolve-registration", "resolve-occurrence", "idempotency", "resolve-topic", "generate", "validate-article", "acquire-image"]) {
    assert.ok(staged.includes(stage), `missing stage ${stage}`);
  }
});

test("pipeline: an off-cadence occurrence is refused", async () => {
  const deps = pipelineDeps({ modelOutput: "{}", schedule: ANCHORED_SCHEDULE });
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-13", mode: "dry-run" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.state, "FAILED");
  assert.match(result.proof.failure.reason, /not on the publication-14d-v1 lattice/);
});

test("pipeline: an unregistered site cannot run", async () => {
  const deps = pipelineDeps({ modelOutput: "{}", schedule: ANCHORED_SCHEDULE });
  const result = await runBlogWriterPipeline(
    { siteId: "not-registered", occurrence: "2026-08-22", mode: "dry-run" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.match(result.proof.failure.reason, /not registered/);
});

test("pipeline: invalid generated content fails closed with no publication", async () => {
  let published = false;
  const deps = pipelineDeps({
    modelOutput: JSON.stringify({
      title: GOOD_ARTICLE.title,
      metaDescription: GOOD_ARTICLE.metaDescription,
      body: `${GOOD_ARTICLE.body}\n\nThis will cure your injury.`,
      imageQuery: "x",
    }),
    schedule: ANCHORED_SCHEDULE,
  });
  deps.publisher = { publish: async () => { published = true; return { commitSha: "x" }; } };
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "publish" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(published, false, "nothing may publish after a validation failure");
  assert.match(result.proof.failure.reason, /prohibited-term/);
});

test("PART 11 PROOF: publish mode requires live verification of article AND image", async () => {
  const deps = pipelineDeps({
    modelOutput: JSON.stringify({
      title: GOOD_ARTICLE.title,
      metaDescription: GOOD_ARTICLE.metaDescription,
      body: GOOD_ARTICLE.body,
      imageQuery: GOOD_ARTICLE.imageQuery,
    }),
    schedule: ANCHORED_SCHEDULE,
  });
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "publish" },
    deps,
  );
  assert.equal(result.ok, true, JSON.stringify(result.proof?.failure));
  assert.equal(result.state, "COMPLETE");
  assert.equal(result.proof.verification.articleStatus, 200);
  assert.equal(result.proof.verification.imageStatus, 200);
  assert.equal(result.proof.provenance.classification, "NEW_CANONICAL");
  assert.equal(result.proof.publication.commitSha, "deadbeef");
});

test("pipeline: a 404 article aborts before COMPLETE", async () => {
  const deps = pipelineDeps({
    modelOutput: JSON.stringify({
      title: GOOD_ARTICLE.title,
      metaDescription: GOOD_ARTICLE.metaDescription,
      body: GOOD_ARTICLE.body,
      imageQuery: GOOD_ARTICLE.imageQuery,
    }),
    schedule: ANCHORED_SCHEDULE,
  });
  deps.verifier = { check: async () => ({ status: 404 }) };
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "publish" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.match(result.proof.failure.reason, /HTTP 404/);
});

test("PART 11 PROOF: a re-run does not create a second article", async () => {
  const sink = createInMemoryTestSink();
  const output = JSON.stringify({
    title: GOOD_ARTICLE.title,
    metaDescription: GOOD_ARTICLE.metaDescription,
    body: GOOD_ARTICLE.body,
    imageQuery: GOOD_ARTICLE.imageQuery,
  });
  const first = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "publish" },
    pipelineDeps({ modelOutput: output, schedule: ANCHORED_SCHEDULE, sink }),
  );
  assert.equal(first.state, "COMPLETE");

  let secondPublishCalled = false;
  const deps2 = pipelineDeps({ modelOutput: output, schedule: ANCHORED_SCHEDULE, sink });
  deps2.publisher = { publish: async () => { secondPublishCalled = true; return { commitSha: "second" }; } };
  const second = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "publish" },
    deps2,
  );
  assert.equal(second.idempotentNoOp, true);
  assert.equal(secondPublishCalled, false, "a re-run must not publish again");
});

test("pipeline: a schedule already carrying the occurrence is a no-op", async () => {
  const deps = pipelineDeps({
    modelOutput: "{}",
    schedule: {
      published: [
        { slug: "prior", title: "A prior article", target_date: "2026-08-08" },
        { slug: "already", title: "Already there", target_date: "2026-08-22" },
      ],
      queue: [],
    },
  });
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "publish" },
    deps,
  );
  assert.equal(result.idempotentNoOp, true);
});

test("pipeline: an exhausted supply with no replenishment fails rather than repeating a topic", async () => {
  const deps = pipelineDeps({ modelOutput: "{}", schedule: ANCHORED_SCHEDULE });
  deps.keywords = { load: async () => ({ primary: [], secondary: [] }) };
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "dry-run" },
    deps,
  );
  assert.equal(result.ok, false);
  assert.match(result.proof.failure.reason, /primary keywords exhausted/);
});

test("pipeline: an exhausted primary pool is rescued by replenishment", async () => {
  const deps = pipelineDeps({
    modelOutput: JSON.stringify({
      title: GOOD_ARTICLE.title,
      metaDescription: GOOD_ARTICLE.metaDescription,
      body: GOOD_ARTICLE.body,
      imageQuery: GOOD_ARTICLE.imageQuery,
    }),
    schedule: {
      published: [{ slug: "prior", title: "A prior article", target_date: "2026-08-08", keywords: ["cupping therapy Los Angeles"] }],
      queue: [],
    },
  });
  deps.keywords = {
    load: async () => ({
      primary: [{ keyword: "cupping therapy Los Angeles" }],
      secondary: [{ keyword: "cupping therapy for athletes" }],
    }),
  };
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "dry-run" },
    deps,
  );
  assert.equal(result.ok, true, JSON.stringify(result.proof?.failure));
  assert.equal(result.proof.provenance.topicProvenance, "REPLENISHED_TOPIC");
});
