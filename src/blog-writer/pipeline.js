/**
 * The canonical blog-writer pipeline. ONE orchestrator for every registered site.
 *
 * Sites differ by registration, keywords, and content context. They do not
 * differ by implementation: nothing below branches on a site identity.
 *
 * MODES
 *
 *   dry-run   every stage runs for real EXCEPT the irreversible ones. Nothing
 *             is committed, nothing is pushed, no live URL is claimed.
 *   publish   the full path, including the irreversible commit.
 *
 * dry-run exists so the whole writer can be proven ahead of a governed
 * occurrence without manufacturing a publication to test with.
 */

import {
  PUBLICATION_INTERVAL_DAYS,
  CADENCE_CONTRACT_ID,
  isGovernedTargetDate,
  resolveCadenceAnchor,
} from "./cadence.js";
import { DISALLOWED_IMAGE_PATHS } from "./registry.js";
import { resolveTopic, TopicSupplyError } from "./topicSupply.js";
import { generateArticle, generateWithProviderRouting } from "./generator.js";
import { acquireImage, preflightImageCredentials } from "./imageProvider.js";
import {
  assertTransition,
  buildProof,
  idempotencyKey,
  STATES,
} from "./proof.js";
import {
  BODY_MAX_WORDS,
  BODY_MIN_WORDS,
  META_MAX,
  META_MIN,
  MIN_H2_COUNT,
  TITLE_MAX,
  TITLE_MIN,
  validateArticle,
  validateImage,
} from "./validators.js";

export const PIPELINE_VERSION = "1.0.0";

const CONSTRAINTS = {
  titleMin: TITLE_MIN,
  titleMax: TITLE_MAX,
  metaMin: META_MIN,
  metaMax: META_MAX,
  bodyMinWords: BODY_MIN_WORDS,
  bodyMaxWords: BODY_MAX_WORDS,
  minH2Count: MIN_H2_COUNT,
};

export class PipelineError extends Error {
  constructor(stage, message, detail) {
    super(message);
    this.name = "PipelineError";
    this.stage = stage;
    this.detail = detail;
  }
}

/**
 * Run the pipeline for one site and one occurrence.
 *
 * @param deps.registry      built site registry
 * @param deps.schedule      { load(site) -> blog-schedule.json object }
 * @param deps.keywords      { load(site) -> [{keyword, supporting[]}] }
 * @param deps.provider      generation provider
 * @param deps.imageProvider image provider
 * @param deps.imageStore    image storage
 * @param deps.reporter      durable reporter
 * @param deps.publisher     publication adapter (publish mode only)
 * @param deps.verifier      { check(url) -> {status, contentType, byteLength} }
 */
/**
 * Live-verification pacing. Injectable via `deps.verifyPolicy` so tests never
 * sleep; production defaults size the article wait to a normal consumer
 * deploy (~1-2 min) with headroom, inside the workflow job budget.
 */
function verifyPolicy(deps) {
  return {
    deployBudgetMs: 300_000,
    idempotentBudgetMs: 60_000,
    intervalMs: 15_000,
    ...(deps.verifyPolicy ?? {}),
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a URL until it serves 200 or the budget runs out. Returns the LAST
 * check result either way - the caller judges it; this helper never throws on
 * a non-200. `deps.sleep` is injectable for tests.
 */
async function waitForLiveUrl(deps, url, { budgetMs, intervalMs }) {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + budgetMs;
  let last = await deps.verifier.check(url);
  while (last.status !== 200 && Date.now() + intervalMs <= deadline) {
    await sleep(intervalMs);
    last = await deps.verifier.check(url);
  }
  return last;
}

export async function runBlogWriterPipeline({ siteId, occurrence, mode = "dry-run", dispatch = null }, deps) {
  const startedAt = new Date().toISOString();
  let state = "NOT_STARTED";
  const stages = [];

  const record = (stage, ok, detail) => {
    stages.push({ stage, ok, detail: detail ?? null, at: new Date().toISOString() });
  };

  const fail = async (stage, error) => {
    state = assertTransition(state, "FAILED");
    record(stage, false, error.message);
    const proof = buildProof({
      laneKey: site?.laneKey ?? siteId,
      siteId,
      occurrence,
      state,
      article: null,
      image: null,
      publication: null,
      verification: null,
      provenance: { classification: "NEW_CANONICAL", generatedBy: "canonical-pipeline" },
      pipelineVersion: PIPELINE_VERSION,
      dispatch,
      failure: { stage, reason: error.message, detail: error.detail ?? null },
      startedAt,
      completedAt: new Date().toISOString(),
    });
    await deps.reporter.report(proof);
    return { ok: false, state, stages, proof };
  };

  let site;

  // ── 1. resolve site registration ─────────────────────────────────────────
  try {
    site = deps.registry.get(siteId);
    record("resolve-registration", true, site.laneKey);
  } catch (error) {
    return fail("resolve-registration", error);
  }

  try {
    // ── 2/3. cadence contract + occurrence ────────────────────────────────
    const schedule = await deps.schedule.load(site);
    const anchor = resolveCadenceAnchor(schedule);
    if (!anchor) {
      throw new PipelineError("resolve-occurrence", `${siteId} has no cadence anchor; cannot resolve an occurrence.`);
    }
    if (!isGovernedTargetDate(anchor, occurrence)) {
      throw new PipelineError(
        "resolve-occurrence",
        `${occurrence} is not on the ${CADENCE_CONTRACT_ID} lattice (anchor ${anchor}, every ${PUBLICATION_INTERVAL_DAYS}d).`,
      );
    }
    record("resolve-occurrence", true, { anchor, occurrence, contract: CADENCE_CONTRACT_ID });

    // ── 4. inspect existing publication state (idempotency) ──────────────
    //
    // An already-published occurrence must still hand THIS dispatch a proof it
    // can stand on. The previous branch returned `reporter.latestFor(...)` —
    // which in CI is null (attempt 1's proof is an artifact, never committed)
    // or a stale proof carrying attempt 1's dispatch identity, which the
    // dispatcher's correlation-matched poll can never accept. Observed
    // 2026-08-27: six lanes published successfully, failed only verify-live
    // against a still-deploying site, and their retries could never have
    // recovered through this branch. Re-verify the live article and mint a
    // FRESH proof bound to the current dispatch - truthfully COMPLETE when the
    // article serves, truthfully FAILED at verify-live when it does not.
    // No second article is ever created here.
    const published = schedule.published ?? [];
    const publishedEntry = published.find((entry) => entry.target_date === occurrence) ?? null;
    const alreadyReported = await deps.reporter.alreadyPublished(site.laneKey, occurrence);
    if (publishedEntry || alreadyReported) {
      record("idempotency", true, "already published, no second article");
      const slug = publishedEntry?.slug ?? (await deps.reporter.latestFor(site.laneKey, occurrence))?.article?.slug ?? null;
      if (!slug) {
        return fail(
          "idempotency",
          new PipelineError(
            "idempotency",
            `${site.laneKey} reports a prior publication for ${occurrence} but no slug is recoverable; cannot verify it.`,
          ),
        );
      }
      const articleUrl = `https://${site.domain}${site.blogPath}/${slug}`;
      const articleCheck = await waitForLiveUrl(deps, articleUrl, {
        budgetMs: verifyPolicy(deps).idempotentBudgetMs,
        intervalMs: verifyPolicy(deps).intervalMs,
      });
      const completedAt = new Date().toISOString();
      const provenance = {
        classification: "NEW_CANONICAL",
        generatedBy: "canonical-pipeline",
        note: `idempotent re-verification of the ${occurrence} publication; no second article was created`,
      };
      const articleFacts = { slug, title: publishedEntry?.title ?? null };
      if (articleCheck.status === 200) {
        record("verify-live", true, { articleUrl, idempotent: true });
        const proof = buildProof({
          laneKey: site.laneKey,
          siteId,
          occurrence,
          state: "COMPLETE",
          article: articleFacts,
          image: null,
          publication: null,
          verification: { articleUrl, articleStatus: 200, checkedAt: completedAt },
          provenance,
          pipelineVersion: PIPELINE_VERSION,
          dispatch,
          startedAt,
          completedAt,
        });
        await deps.reporter.report(proof);
        return {
          ok: true,
          state: "COMPLETE",
          idempotentNoOp: true,
          stages,
          proof,
          note: `${site.laneKey} already published ${occurrence}; live verification re-confirmed ${articleUrl}.`,
        };
      }
      return fail(
        "verify-live",
        new PipelineError(
          "verify-live",
          `Already-published article returned HTTP ${articleCheck.status} at ${articleUrl}.`,
        ),
      );
    }
    state = assertTransition(state, "READY");
    record("idempotency", true, "no prior publication for this occurrence");

    // Fail closed on a missing image credential BEFORE spending a model call.
    // The alternative is an opaque authorization error after generation, which
    // is what every lane would have hit: the publish workflows passed no
    // secrets at all.
    const credentials = preflightImageCredentials(site, deps.env ?? process.env);
    if (!credentials.ok) {
      throw new PipelineError("preflight-credentials", credentials.reason, credentials.code);
    }
    record("preflight-credentials", true, credentials.provider ?? "not-required");

    // ── 5. resolve keyword/topic ──────────────────────────────────────────
    const history = {
      slugs: published.map((entry) => entry.slug).filter(Boolean),
      titles: published.map((entry) => entry.title).filter(Boolean),
    };
    const supply = await deps.keywords.load(site);
    const primary = Array.isArray(supply) ? supply : supply.primary ?? [];
    const secondary = Array.isArray(supply) ? [] : supply.secondary ?? [];
    const topic = resolveTopic({
      site,
      primary,
      secondary,
      history: {
        titles: history.titles,
        keywords: published.flatMap((entry) => entry.keywords ?? []),
      },
    });
    record("resolve-topic", true, { keyword: topic.keyword, provenance: topic.provenance });

    // ── 6/7. context + generation ─────────────────────────────────────────
    // The validator is injected into generation so a rejected draft is repaired
    // BEFORE it can reach the queue, which is the qirofit failure mode. It is the same
    // function that gates admission below, so a repair loop cannot drift from
    // the rule it is repairing against.
    // A consumer may supply an ordered `providers` route or a single
    // `provider`. Routing is the general case: `provider` is the one-element
    // route, so there is a single code path rather than two that can drift.
    const providers = deps.providers ?? (deps.provider ? [deps.provider] : []);
    if (providers.length === 0) {
      throw new PipelineError("generate", "No generation provider configured.");
    }
    const generationArgs = {
      site,
      keyword: topic.keyword,
      supportingKeywords: topic.supporting ?? [],
      occurrence,
      history,
      constraints: CONSTRAINTS,
      validate: (candidate) => validateArticle({ article: candidate, site, history }),
      maxAttempts: deps.maxGenerationAttempts ?? 3,
    };
    const article = providers.length === 1
      ? await generateArticle({ ...generationArgs, provider: providers[0] })
      : await generateWithProviderRouting({ ...generationArgs, providers });
    state = assertTransition(state, "GENERATED");
    record("generate", true, {
      title: article.title,
      provider: article.generation.providerId,
      model: article.generation.model,
      attempts: article.generation.attempts,
      route: article.generation.route ?? null,
    });

    // ── 8. validate independently, after generation ──────────────────────
    const validation = validateArticle({ article, site, history });
    if (!validation.ok) {
      throw new PipelineError(
        "validate-article",
        `Generated article failed ${validation.issues.length} validation rule(s): ` +
          validation.issues.map((i) => i.code).join(", "),
        validation.issues,
      );
    }
    record("validate-article", true, `${article.body.trim().split(/\s+/).length} words`);

    // ── 9/10. image acquisition + validation ──────────────────────────────
    const acquired = await acquireImage({
      site,
      article,
      provider: deps.imageProvider,
    });
    const imageValidation = validateImage({
      image: acquired.image,
      site,
      disallowedPaths: DISALLOWED_IMAGE_PATHS,
    });
    if (!imageValidation.ok) {
      throw new PipelineError(
        "validate-image",
        `Image failed validation: ${imageValidation.issues.map((i) => i.code).join(", ")}`,
        imageValidation.issues,
      );
    }
    // A required image with no bytes is not publishable. The publisher writes
    // image.buffer into the repo; metadata-only success would commit an article
    // referencing an asset that was never written.
    if (mode === "publish" && site.imagePolicy.required
        && acquired.status === "acquired" && !acquired.image?.buffer) {
      throw new PipelineError(
        "acquire-image",
        "Image acquisition returned metadata without publishable bytes; refusing to publish.",
        "IMAGE_ARTIFACT_MISSING",
      );
    }
    state = assertTransition(state, "VALIDATED");
    record("acquire-image", true, { provider: acquired.image?.provider, status: acquired.status });

    // ── 11. publish ───────────────────────────────────────────────────────
    if (mode === "dry-run") {
      const proof = buildProof({
        laneKey: site.laneKey,
        siteId,
        occurrence,
        state: "VALIDATED",
        article,
        image: acquired.image,
        publication: { mode: "dry-run", committed: false },
        verification: null,
        provenance: {
          classification: "NEW_CANONICAL",
          generatedBy: "canonical-pipeline",
          generationProvider: article.generation.providerId,
          generationModel: article.generation.model,
          topicProvenance: topic.provenance,
          imageProvider: acquired.image?.provider ?? null,
          note: "dry-run: generated, validated and image-acquired; nothing committed or published",
        },
        pipelineVersion: PIPELINE_VERSION,
        dispatch,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      await deps.reporter.report(proof);
      record("publish", true, "skipped, dry-run");
      return { ok: true, state: "VALIDATED", mode, stages, article, image: acquired.image, proof };
    }

    const publication = await deps.publisher.publish({
      site,
      article,
      image: acquired.image,
      occurrence,
      idempotencyKey: idempotencyKey({ laneKey: site.laneKey, occurrence }),
    });
    if (!publication?.commitSha) {
      throw new PipelineError("publish", "Publisher returned no commit SHA; publication unproven.");
    }
    state = assertTransition(state, "PUBLISHED");
    record("publish", true, publication.commitSha);

    // ── 12/13. live verification of BOTH artefacts ────────────────────────
    //
    // The publication commit triggers the consumer's own production deploy,
    // which takes minutes; checking the URL once, immediately, races that
    // deploy and loses. Observed 2026-08-27: six lanes published correctly and
    // all six "failed" verify-live against the not-yet-deployed site. Wait,
    // bounded, for the deploy to serve the article; the image ships in the
    // same deploy, so it gets only a short residual wait after the article.
    const articleUrl = `https://${site.domain}${site.blogPath}/${article.slug}`;
    const articleCheck = await waitForLiveUrl(deps, articleUrl, {
      budgetMs: verifyPolicy(deps).deployBudgetMs,
      intervalMs: verifyPolicy(deps).intervalMs,
    });
    if (articleCheck.status !== 200) {
      throw new PipelineError("verify-live", `Article returned HTTP ${articleCheck.status} at ${articleUrl}.`);
    }
    const imageUrl = acquired.image.url.startsWith("http")
      ? acquired.image.url
      : `https://${site.domain}${acquired.image.url}`;
    const imageCheck = await waitForLiveUrl(deps, imageUrl, {
      budgetMs: verifyPolicy(deps).idempotentBudgetMs,
      intervalMs: verifyPolicy(deps).intervalMs,
    });
    if (imageCheck.status !== 200) {
      throw new PipelineError("verify-live", `Image returned HTTP ${imageCheck.status} at ${imageUrl}.`);
    }
    state = assertTransition(state, "VERIFIED");
    record("verify-live", true, { articleUrl, imageUrl });

    // ── 14/15/16. proof, durable report, completion ───────────────────────
    state = assertTransition(state, "COMPLETE");
    const proof = buildProof({
      laneKey: site.laneKey,
      siteId,
      occurrence,
      state,
      article,
      image: acquired.image,
      publication,
      verification: {
        articleUrl,
        articleStatus: articleCheck.status,
        imageUrl,
        imageStatus: imageCheck.status,
        checkedAt: new Date().toISOString(),
      },
      provenance: {
        classification: "NEW_CANONICAL",
        generatedBy: "canonical-pipeline",
        generationProvider: article.generation.providerId,
        generationModel: article.generation.model,
        topicProvenance: topic.provenance,
        imageProvider: acquired.image.provider,
      },
      pipelineVersion: PIPELINE_VERSION,
      dispatch,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    await deps.reporter.report(proof);
    record("report", true, "durable proof written");

    return { ok: true, state, mode, stages, article, image: acquired.image, proof };
  } catch (error) {
    return fail(error.stage ?? "pipeline", error);
  }
}

export { STATES };
