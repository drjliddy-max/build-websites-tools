/**
 * Topic supply and provider routing.
 *
 * The exhaustion fixtures are the REAL state of bmj and jeffrystein on
 * origin/main as of 2026-08-09: two primary keywords each, both already
 * published. Those two lanes could not resolve a topic for any future
 * occurrence, which is a permanent deadlock, not a content backlog.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTopic,
  similarity,
  findNearDuplicate,
  isInScope,
  TopicSupplyError,
  TOPIC_PROVENANCE,
} from "../topicSupply.js";
import { generateWithProviderRouting, GenerationError, createHostedProvider } from "../generator.js";
import { validateArticle } from "../validators.js";

// Real exhausted lanes, from site-monitor/projects/<domain>/keywords/primary.csv
// and each repo's blog-schedule.json on origin/main.
const BMJ = {
  siteId: "bmj",
  domain: "babymilestonejournal.com",
  keywordSource: { primary: "primary.csv", secondary: "supporting.csv" },
  contentContext: {
    audience: "new parents",
    voice: "warm, practical",
    prohibitedTerms: ["medical advice"],
    forbiddenTopics: ["ADA compliance", "website monitoring"],
  },
};

const JEFF = {
  siteId: "jeffrystein",
  domain: "jeffrystein.com",
  keywordSource: { primary: "primary.csv", secondary: "supporting.csv" },
  contentContext: {
    audience: "conference organisers booking a keynote speaker",
    voice: "direct, credible",
    prohibitedTerms: [],
    forbiddenTopics: ["podiatry", "baby milestones"],
  },
};

// ── the deadlock, reproduced ───────────────────────────────────────────────

test("REGRESSION (bmj): primary pool exhausted deadlocks without replenishment", () => {
  const primary = ["baby milestone tracker app", "baby photo book"];
  const history = { titles: [], keywords: ["baby milestone tracker app", "baby photo book"] };
  assert.throws(
    () => resolveTopic({ site: BMJ, primary, secondary: [], history }),
    TopicSupplyError,
  );
});

test("REGRESSION (jeffrystein): primary pool exhausted deadlocks without replenishment", () => {
  const primary = ["keynote speaker for conference", "consciousness comedian"];
  const history = { titles: [], keywords: ["keynote speaker for conference", "consciousness comedian"] };
  assert.throws(
    () => resolveTopic({ site: JEFF, primary, secondary: [], history }),
    TopicSupplyError,
  );
});

test("BMJ_TOPIC_SUPPLY_READY: replenishment resolves the exhausted lane", () => {
  const topic = resolveTopic({
    site: BMJ,
    primary: ["baby milestone tracker app", "baby photo book"],
    secondary: ["how to organise baby photos by month", "when do babies start crawling"],
    history: { titles: [], keywords: ["baby milestone tracker app", "baby photo book"] },
  });
  assert.equal(topic.provenance, TOPIC_PROVENANCE.REPLENISHED);
  assert.equal(topic.keyword, "how to organise baby photos by month");
});

test("JEFFRYSTEIN_TOPIC_SUPPLY_READY: replenishment resolves the exhausted lane", () => {
  const topic = resolveTopic({
    site: JEFF,
    primary: ["keynote speaker for conference", "consciousness comedian"],
    secondary: ["what makes a closing keynote land", "booking a speaker for a sales kickoff"],
    history: { titles: [], keywords: ["keynote speaker for conference", "consciousness comedian"] },
  });
  assert.equal(topic.provenance, TOPIC_PROVENANCE.REPLENISHED);
});

// ── primary is preferred and used exactly once ─────────────────────────────

test("an available primary keyword is used before any replenishment", () => {
  const topic = resolveTopic({
    site: BMJ,
    primary: ["baby milestone tracker app", "baby photo book"],
    secondary: ["something else entirely"],
    history: { titles: [], keywords: ["baby milestone tracker app"] },
  });
  assert.equal(topic.provenance, TOPIC_PROVENANCE.PRIMARY);
  assert.equal(topic.keyword, "baby photo book");
});

// ── near-duplicate rejection ───────────────────────────────────────────────

test("near-duplicate candidates are rejected, not merely exact matches", () => {
  assert.ok(similarity("baby sleep regression", "sleep regression in babies") >= 0.6);
  assert.equal(findNearDuplicate("sleep regression in babies", ["baby sleep regression"]), "baby sleep regression");
  assert.equal(findNearDuplicate("choosing a stroller", ["baby sleep regression"]), null);
});

test("a near-duplicate of a published TITLE is rejected", () => {
  assert.throws(
    () => resolveTopic({
      site: BMJ,
      primary: [],
      secondary: ["when do babies start crawling"],
      history: { titles: ["When Do Babies Start Crawling?"], keywords: [] },
    }),
    /no replenishment candidate survived/,
  );
});

test("rejected candidates are reported, so exhaustion is explicable", () => {
  const topic = resolveTopic({
    site: BMJ,
    primary: [],
    secondary: ["baby sleep regression", "choosing a first pair of shoes"],
    history: { titles: ["Sleep regression in babies"], keywords: [] },
  });
  assert.equal(topic.keyword, "choosing a first pair of shoes");
  assert.equal(topic.rejectedCandidates.length, 1);
  assert.match(topic.rejectedCandidates[0].reason, /near-duplicate/);
});

// ── scope enforcement ──────────────────────────────────────────────────────

test("a cross-lane topic is refused, so a site cannot cannibalise a sibling", () => {
  const scope = isInScope("plantar fasciitis and podiatry care", JEFF);
  assert.equal(scope.ok, false);
  assert.match(scope.reason, /forbidden topic/);
});

test("a candidate carrying a prohibited term is refused", () => {
  assert.equal(isInScope("medical advice for newborn fevers", BMJ).ok, false);
});

// ── PART 12: provider routing ──────────────────────────────────────────────

const LIDDY = {
  siteId: "liddy",
  domain: "liddypodiatryandprevention.com",
  contentContext: { audience: "patients", voice: "clinically cautious", prohibitedTerms: [] },
};

const CONSTRAINTS = { titleMin: 20, titleMax: 70, metaMin: 70, metaMax: 160, bodyMinWords: 400, bodyMaxWords: 2500, minH2Count: 3 };

function bodyOf(words) {
  const sentence = "This paragraph explains foot and ankle care in specific practical terms. ";
  return ["## One", sentence.repeat(Math.ceil(words / 3 / 11)), "## Two", sentence.repeat(Math.ceil(words / 3 / 11)), "## Three", sentence.repeat(Math.ceil(words / 3 / 11))].join("\n\n");
}

const GOOD = JSON.stringify({
  title: "Foot numbness and tingling, what to check first",
  metaDescription: "Numbness in the foot has several common causes. Here is how to tell them apart and when it is worth booking an appointment.",
  body: bodyOf(450),
  imageQuery: "clinical foot examination",
});
const SHORT = JSON.stringify({
  title: "Foot numbness and tingling, what to check first",
  metaDescription: "Numbness in the foot has several common causes. Here is how to tell them apart and when it is worth booking an appointment.",
  body: "## One\n\nToo short.",
  imageQuery: "x",
});

const routingArgs = {
  site: LIDDY,
  keyword: "foot numbness and tingling",
  occurrence: "2026-08-22",
  constraints: CONSTRAINTS,
  maxAttempts: 2,
  validate: (candidate) => validateArticle({ article: candidate, site: LIDDY, history: { slugs: [], titles: [] } }),
};

test("LIDDY_PROVIDER_FALLBACK: a failing local provider routes to the alternate", async () => {
  const local = { id: "local", model: "phi4:14b", complete: async () => SHORT };
  const hosted = { id: "hosted", model: "claude-sonnet-5", isAvailable: () => true, complete: async () => GOOD };
  const article = await generateWithProviderRouting({ providers: [local, hosted], ...routingArgs });

  assert.equal(article.generation.providerId, "hosted");
  assert.deepEqual(
    article.generation.route.map((r) => `${r.providerId}:${r.outcome}`),
    ["local:rejected", "hosted:accepted"],
  );
});

test("VALIDATORS_UNCHANGED: routing never lowers the bar, it only changes provider", async () => {
  const badA = { id: "local", model: "a", complete: async () => SHORT };
  const badB = { id: "hosted", model: "b", isAvailable: () => true, complete: async () => SHORT };
  await assert.rejects(
    () => generateWithProviderRouting({ providers: [badA, badB], ...routingArgs }),
    (error) => error instanceof GenerationError && /All 2 provider\(s\) failed/.test(error.message),
  );
});

test("an unavailable hosted provider is skipped and recorded, not fatal", async () => {
  delete process.env.TEST_HOSTED_KEY;
  const hosted = createHostedProvider({ model: "m", endpoint: "https://example.invalid", apiKeyEnv: "TEST_HOSTED_KEY" });
  const local = { id: "local", model: "phi4:14b", complete: async () => GOOD };
  const article = await generateWithProviderRouting({ providers: [hosted, local], ...routingArgs });
  assert.equal(article.generation.providerId, "local");
  assert.equal(article.generation.route[0].outcome, "unavailable");
});

test("the local provider is preferred when it succeeds, per the local-first mandate", async () => {
  const local = { id: "local", model: "phi4:14b", complete: async () => GOOD };
  const hosted = { id: "hosted", model: "x", isAvailable: () => true, complete: async () => { throw new Error("must not be called"); } };
  const article = await generateWithProviderRouting({ providers: [local, hosted], ...routingArgs });
  assert.equal(article.generation.providerId, "local");
  assert.equal(article.generation.route.length, 1);
});

// ── REGRESSION (found by the qirofit migration, v0.15.0) ───────────────────
// v0.15.0 shipped generateWithProviderRouting and the pipeline never called it.
// A consumer passing `providers` got only deps.provider, so liddy's fallback was
// unreachable from every consumer. Same shape as v0.13.0 shipping a pipeline
// whose publisher had no implementation: exported but not wired.

test("REGRESSION: the pipeline routes across `providers`, it does not ignore them", async () => {
  const { runBlogWriterPipeline } = await import("../pipeline.js");
  const { buildRegistry } = await import("../registry.js");
  const { createPexelsProvider, createMemoryStore } = await import("../imageProvider.js");
  const { createDurableReporter, createInMemoryTestSink } = await import("../proof.js");

  const SITE = {
    siteId: "liddy", domain: "liddypodiatryandprevention.com", laneKey: "blog-writer-liddy",
    repository: { owner: "drjliddy-max", name: "liddy-podiatry-site" }, blogPath: "/blog",
    keywordSource: { primary: "p.csv" },
    contentContext: { audience: "patients", voice: "clinically cautious", prohibitedTerms: [] },
    imagePolicy: { required: true, provider: "pexels" },
    publication: { adapter: "github-repo-commit", workflowFile: "w.yml", schedulePath: "s.json", draftDir: "d" },
    monitorKey: "blog-writer-liddy",
  };

  process.env.PEXELS_API_KEY = "fixture-key";
  const fixtureFetch = async (url) => String(url).includes("api.pexels.com")
    ? { ok: true, status: 200, json: async () => ({ photos: [{ id: 1, width: 3000, alt: "a photograph of a clinic room", photographer: "P", src: { large2x: "https://images.pexels.com/x.jpg" } }] }) }
    : { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new ArrayBuffer(300_000) };

  const weak = { id: "local", model: "phi4:14b", complete: async () => SHORT };
  const strong = { id: "hosted", model: "claude-sonnet-5", isAvailable: () => true, complete: async () => GOOD };

  const result = await runBlogWriterPipeline(
    { siteId: "liddy", occurrence: "2026-08-22", mode: "dry-run" },
    {
      registry: buildRegistry([SITE]),
      providers: [weak, strong],
      schedule: { load: async () => ({ published: [{ slug: "prior", title: "Prior", target_date: "2026-08-08", keywords: ["other"] }], queue: [] }) },
      keywords: { load: async () => ({ primary: [{ keyword: "foot numbness and tingling" }], secondary: [] }) },
      imageProvider: createPexelsProvider({ fetchImpl: fixtureFetch }),
      imageStore: createMemoryStore(),
      reporter: createDurableReporter({ sink: createInMemoryTestSink() }),
      verifier: { check: async () => ({ status: 200 }) },
      maxGenerationAttempts: 2,
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result.proof?.failure));
  assert.equal(result.proof.provenance.generationProvider, "hosted",
    "the proof must name the provider that actually produced the article");
  const generate = result.stages.find((s) => s.stage === "generate");
  assert.deepEqual(generate.detail.route.map((r) => `${r.providerId}:${r.outcome}`), ["local:rejected", "hosted:accepted"]);
});

test("REGRESSION: a single `provider` still works and is the one-element route", async () => {
  const { runBlogWriterPipeline } = await import("../pipeline.js");
  const { buildRegistry } = await import("../registry.js");
  const { createPexelsProvider, createMemoryStore } = await import("../imageProvider.js");
  const { createDurableReporter, createInMemoryTestSink } = await import("../proof.js");
  const SITE = {
    siteId: "liddy2", domain: "example.com", laneKey: "lane-2",
    repository: { owner: "o", name: "n" }, blogPath: "/blog", keywordSource: { primary: "p" },
    contentContext: { audience: "patients", voice: "cautious", prohibitedTerms: [] },
    imagePolicy: { required: false, provider: "pexels" },
    publication: { adapter: "github-repo-commit", workflowFile: "w", schedulePath: "s", draftDir: "d" },
    monitorKey: "m",
  };
  const result = await runBlogWriterPipeline(
    { siteId: "liddy2", occurrence: "2026-08-22", mode: "dry-run" },
    {
      registry: buildRegistry([SITE]),
      provider: { id: "local", model: "phi4:14b", complete: async () => GOOD },
      schedule: { load: async () => ({ published: [{ slug: "p", title: "P", target_date: "2026-08-08", keywords: ["x"] }], queue: [] }) },
      keywords: { load: async () => ({ primary: [{ keyword: "foot numbness and tingling" }], secondary: [] }) },
      imageProvider: createPexelsProvider({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ photos: [] }) }) }),
      imageStore: createMemoryStore(),
      reporter: createDurableReporter({ sink: createInMemoryTestSink() }),
      verifier: { check: async () => ({ status: 200 }) },
      maxGenerationAttempts: 2,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result.proof?.failure));
  assert.equal(result.proof.provenance.generationProvider, "local");
});
