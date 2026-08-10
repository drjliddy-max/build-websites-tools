/**
 * Canonical model policy.
 *
 * The order under test is measured, not assumed: see modelPolicy.js for the
 * capability matrix it derives from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCAL_MODEL, LOCAL_FALLBACK_ORDER, MAX_ATTEMPTS_PER_MODEL,
  HOSTED_FALLBACK_ORDER, EXCLUDED_MODELS, resolveModelRoute, buildProviderRoute,
} from "../modelPolicy.js";

const SITE = { siteId: "liddy" };

test("the default is the measured best, not the largest model", () => {
  assert.equal(DEFAULT_LOCAL_MODEL, "qwen3:14b");
  assert.equal(LOCAL_FALLBACK_ORDER[0], DEFAULT_LOCAL_MODEL);
  // the 14B outranks the 24B and 27B that also passed
  assert.ok(LOCAL_FALLBACK_ORDER.indexOf("qwen3:14b") < LOCAL_FALLBACK_ORDER.indexOf("mistral-small3.2:24b"));
  assert.ok(LOCAL_FALLBACK_ORDER.indexOf("mistral-small3.2:24b") < LOCAL_FALLBACK_ORDER.indexOf("gemma3:27b"));
});

test("models that failed the matrix are not in the route", () => {
  for (const failed of ["granite3.3:8b", "gpt-oss:20b", "phi4:14b"]) {
    assert.ok(!LOCAL_FALLBACK_ORDER.includes(failed), `${failed} must not be routed`);
  }
});

test("retry is bounded per model, so one marginal model cannot consume the run", () => {
  assert.equal(MAX_ATTEMPTS_PER_MODEL, 3);
  assert.equal(resolveModelRoute(SITE).maxAttemptsPerModel, 3);
});

test("local is exhausted before hosted, per the local-first mandate", () => {
  const route = resolveModelRoute(SITE);
  assert.deepEqual(route.local, LOCAL_FALLBACK_ORDER);
  assert.equal(route.hosted[0].apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(route.hosted.length, HOSTED_FALLBACK_ORDER.length);
});

test("a site preference is additive: it cannot remove the safety fallbacks", () => {
  const route = resolveModelRoute({ siteId: "x", generationPolicy: { preferredModel: "gemma3:27b" } });
  assert.equal(route.local[0], "gemma3:27b");
  assert.equal(route.preferredFrom, "site-configuration");
  for (const model of LOCAL_FALLBACK_ORDER) {
    assert.ok(route.local.includes(model), `${model} must still be reachable`);
  }
  assert.equal(new Set(route.local).size, route.local.length, "no duplicates");
});

test("a site cannot prefer an excluded model", () => {
  assert.throws(
    () => resolveModelRoute({ siteId: "x", generationPolicy: { preferredModel: "gpt-oss:20b" } }),
    /excluded \(returns an empty response/,
  );
});

test("exclusions carry a stated reason so they cannot be silently reintroduced", () => {
  for (const [model, reason] of Object.entries(EXCLUDED_MODELS)) {
    assert.ok(typeof reason === "string" && reason.length > 10, `${model} needs a real reason`);
  }
});

test("buildProviderRoute produces local-then-hosted providers in order", () => {
  const providers = buildProviderRoute(SITE, {
    makeLocal: ({ model }) => ({ id: "local", model }),
    makeHosted: (spec) => ({ id: "hosted", model: spec.model }),
  });
  assert.deepEqual(providers.map((p) => `${p.id}:${p.model}`), [
    "local:qwen3:14b",
    "local:mistral-small3.2:24b",
    "local:gemma3:27b",
    "hosted:claude-sonnet-5",
  ]);
});
