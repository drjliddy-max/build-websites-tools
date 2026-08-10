/**
 * Canonical provider and model policy.
 *
 * Model selection used to live in each consumer's entrypoint as a hardcoded
 * `phi4:14b` default. Five copies of a policy decision is the same defect class
 * as five copies of an orchestrator, and it produced a specific false
 * conclusion: several sessions concluded "the local model is not capable" for
 * liddy and jeffrystein while only three of NINETEEN installed models had ever
 * been tried, and the capable one was installed the whole time.
 *
 * MEASURED, NOT ASSUMED
 *
 * Order below is from a capability matrix run against the v0.19.0 contract with
 * unchanged validators, on the liddy lane (the strictest governance and the
 * longest published history, so the hardest prompt in the estate):
 *
 *   qwen3:14b              PASS  1 attempt   772 words   22s
 *   mistral-small3.2:24b   PASS  1 attempt   626 words   54s
 *   gemma3:27b             PASS  2 attempts  425 words  102s
 *   granite3.3:8b          FAIL  3 attempts               21s
 *   gpt-oss:20b            FAIL  empty response
 *
 * Bigger is not better: the 14B beat the 24B, the 27B and every larger model
 * tried, on quality AND latency. Ordering is by measured pass rate then
 * latency, not by parameter count.
 */

/** Default local model. Fastest first-attempt pass in the matrix. */
export const DEFAULT_LOCAL_MODEL = "qwen3:14b";

/**
 * Escalation order. Each entry gets a bounded attempt budget before the next is
 * tried, so one marginal model cannot consume the whole run.
 */
export const LOCAL_FALLBACK_ORDER = [
  "qwen3:14b",
  "mistral-small3.2:24b",
  "gemma3:27b",
];

/** Attempts per model before escalating. Bounded: no indefinite retry. */
export const MAX_ATTEMPTS_PER_MODEL = 3;

/**
 * Hosted providers, tried only after every local model has failed, per the
 * portfolio local-first mandate. A provider whose credential is absent is
 * skipped by the router and recorded, never treated as a failure.
 */
export const HOSTED_FALLBACK_ORDER = [
  { id: "hosted", model: "claude-sonnet-5", endpoint: "https://api.anthropic.com/v1/messages", apiKeyEnv: "ANTHROPIC_API_KEY" },
];

/**
 * Models proven unusable, with the reason. Kept so a future policy edit cannot
 * silently reintroduce one.
 */
export const EXCLUDED_MODELS = {
  "gpt-oss:20b": "returns an empty response to the structured article schema",
  "llama3.2:1b": "too small for the article contract",
  "qwen3-coder:30b": "code model, not prose",
  "qwen2.5-coder:1.5b": "code model, not prose",
  "devstral:24b": "code model, not prose",
  "devstral-small-2:latest": "code model, not prose",
  "nomic-embed-text:latest": "embedding model, cannot generate",
};

/**
 * Resolve the provider route for a site.
 *
 * A site may name a preferred local model in `generationPolicy.preferredModel`
 * as CONFIGURATION DATA when evidence justifies it. It may not supply its own
 * routing, retry policy, or provider implementation. Anything a site names is
 * tried first and then the canonical order continues, so a site preference can
 * only add a first choice, never remove the fallbacks that make the route safe.
 */
export function resolveModelRoute(site) {
  const preferred = site?.generationPolicy?.preferredModel;
  if (preferred && EXCLUDED_MODELS[preferred]) {
    throw new Error(
      `${site.siteId}: preferredModel "${preferred}" is excluded (${EXCLUDED_MODELS[preferred]}).`,
    );
  }
  const local = preferred
    ? [preferred, ...LOCAL_FALLBACK_ORDER.filter((m) => m !== preferred)]
    : [...LOCAL_FALLBACK_ORDER];
  return {
    local,
    hosted: [...HOSTED_FALLBACK_ORDER],
    maxAttemptsPerModel: MAX_ATTEMPTS_PER_MODEL,
    preferredFrom: preferred ? "site-configuration" : "canonical-default",
  };
}

/**
 * Build the ordered provider list for the pipeline.
 * `makeLocal` / `makeHosted` are injected so this module stays free of
 * transport concerns and is testable without a model server.
 */
export function buildProviderRoute(site, { makeLocal, makeHosted }) {
  const route = resolveModelRoute(site);
  return [
    ...route.local.map((model) => makeLocal({ model })),
    ...route.hosted.map((spec) => makeHosted(spec)),
  ];
}
