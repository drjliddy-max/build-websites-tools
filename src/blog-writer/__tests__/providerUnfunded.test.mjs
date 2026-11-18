/**
 * Provider funding and reachability outcomes.
 *
 * Owner decision 2026-11-16: no additional Anthropic API credit, no auto-reload,
 * no replacement usage-billed API. When the existing credit is exhausted the
 * hosted channel must stop SAFELY and SAY SO: one call, no repair retries, an
 * explicit PROVIDER_UNFUNDED outcome in the route and the failure, and never the
 * provider's error text (it can echo the request).
 *
 * Before this change an exhausted balance surfaced as the generic
 * "Hosted model returned 400." inside "All 4 provider(s) failed ... hosted:rejected",
 * indistinguishable from a bad request or a validation failure. Likewise a runner
 * with no Ollama surfaced as "local:rejected" with reason "fetch failed".
 *
 * Shapes: Anthropic documents HTTP 402 `billing_error`; an exhausted prepaid
 * balance has also been returned as HTTP 400 `invalid_request_error` whose
 * message begins "Your credit balance is too low". Both are covered.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createHostedProvider,
  createLocalProvider,
  generateWithProviderRouting,
  GenerationError,
  PROVIDER_UNFUNDED,
  LOCAL_MODEL_UNREACHABLE,
} from "../generator.js";

const KEY_ENV = "TEST_UNFUNDED_PROVIDER_KEY";
// Prompt-building inputs only; the providers under test never return a draft.
const CONSTRAINTS = { titleMin: 30, titleMax: 65, metaMin: 120, metaMax: 160, bodyMinWords: 500, bodyMaxWords: 2000, minH2Count: 3 };
const SECRET_ECHO = "ECHOED-REQUEST-FRAGMENT-must-never-surface";

function hosted({ status, body }) {
  const calls = [];
  const provider = createHostedProvider({
    model: "claude-sonnet-5",
    endpoint: "https://api.invalid/v1/messages",
    apiKeyEnv: KEY_ENV,
    fetchImpl: async () => {
      calls.push(1);
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  });
  return { provider, calls };
}

const CREDIT_400 = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: `Your credit balance is too low to access the Anthropic API. ${SECRET_ECHO}`,
  },
};
const BILLING_402 = { type: "error", error: { type: "billing_error", message: SECRET_ECHO } };
const OTHER_400 = { type: "error", error: { type: "invalid_request_error", message: `max_tokens: bad ${SECRET_ECHO}` } };

test.beforeEach(() => { process.env[KEY_ENV] = "test-value-not-a-real-credential"; });
test.afterEach(() => { delete process.env[KEY_ENV]; });

for (const [name, status, body] of [
  ["HTTP 400 credit-balance message", 400, CREDIT_400],
  ["HTTP 402 billing_error", 402, BILLING_402],
]) {
  test(`hosted ${name} is classified PROVIDER_UNFUNDED without echoing the body`, async () => {
    const { provider } = hosted({ status, body });
    await assert.rejects(provider.complete("prompt"), (error) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.detail?.code, PROVIDER_UNFUNDED);
      assert.match(error.message, /^PROVIDER_UNFUNDED/);
      assert.ok(!error.message.includes(SECRET_ECHO), "provider error text must not surface");
      assert.ok(!JSON.stringify(error.detail).includes(SECRET_ECHO));
      return true;
    });
  });
}

test("a non-billing 400 keeps the existing status-only message and is not called unfunded", async () => {
  const { provider } = hosted({ status: 400, body: OTHER_400 });
  await assert.rejects(provider.complete("prompt"), (error) => {
    assert.equal(error.message, "Hosted model returned 400.");
    assert.notEqual(error.detail?.code, PROVIDER_UNFUNDED);
    return true;
  });
});

test("an unparseable error body still fails status-only, never unfunded by guess", async () => {
  const provider = createHostedProvider({
    model: "m", endpoint: "https://api.invalid", apiKeyEnv: KEY_ENV,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => { throw new Error("not json"); } }),
  });
  await assert.rejects(provider.complete("p"), /^Error: Hosted model returned 400\.$|Hosted model returned 400\./);
});

test("routing records hosted:unfunded, makes exactly ONE hosted call, and the run fails PROVIDER_UNFUNDED", async () => {
  const { provider, calls } = hosted({ status: 400, body: CREDIT_400 });
  const local = createLocalProvider({
    model: "qwen3:14b",
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  await assert.rejects(
    generateWithProviderRouting({
      providers: [local, provider],
      site: { siteId: "s", name: "S", laneKey: "s", contentContext: {} },
      keyword: "k",
      occurrence: "2026-11-19",
      constraints: CONSTRAINTS,
      validate: () => ({ ok: true, issues: [] }),
      maxAttempts: 3,
    }),
    (error) => {
      assert.equal(error.detail?.code, PROVIDER_UNFUNDED);
      assert.match(error.message, /^PROVIDER_UNFUNDED/);
      const outcomes = error.detail.route.map((r) => `${r.providerId}:${r.outcome}`);
      assert.deepEqual(outcomes, ["local:unreachable", "hosted:unfunded"]);
      assert.ok(!JSON.stringify(error.detail).includes(SECRET_ECHO));
      return true;
    },
  );
  assert.equal(calls.length, 1, "an unfunded provider must not be retried by the repair loop");
});

test("an unreachable local model is LOCAL_MODEL_UNREACHABLE, distinct from a rejected draft", async () => {
  const local = createLocalProvider({ model: "qwen3:14b", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(local.complete("p"), (error) => {
    assert.equal(error.detail?.code, LOCAL_MODEL_UNREACHABLE);
    return true;
  });
});

test("a local abort (timeout) is NOT reclassified as unreachable", async () => {
  const local = createLocalProvider({
    model: "qwen3:14b",
    fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
  });
  await assert.rejects(local.complete("p"), (error) => {
    assert.notEqual(error.detail?.code, LOCAL_MODEL_UNREACHABLE);
    return true;
  });
});

test("a run whose last failure is NOT funding keeps the generic failure (no false UNFUNDED)", async () => {
  const { provider } = hosted({ status: 400, body: OTHER_400 });
  await assert.rejects(
    generateWithProviderRouting({
      providers: [provider],
      site: { siteId: "s", name: "S", laneKey: "s", contentContext: {} },
      keyword: "k",
      occurrence: "2026-11-19",
      constraints: CONSTRAINTS,
      validate: () => ({ ok: true, issues: [] }),
    }),
    (error) => {
      assert.notEqual(error.detail?.code, PROVIDER_UNFUNDED);
      assert.match(error.message, /^All 1 provider\(s\) failed/);
      assert.deepEqual(error.detail.route.map((r) => r.outcome), ["rejected"]);
      return true;
    },
  );
});

test("BLOG_WRITER_LOCAL_MODEL_ENDPOINT moves the local endpoint (container runner reaching the host's Ollama)", async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ response: "{}" }) }; };
  process.env.BLOG_WRITER_LOCAL_MODEL_ENDPOINT = "http://host.docker.internal:11434";
  try {
    await createLocalProvider({ model: "qwen3:14b", fetchImpl }).complete("p");
    // An explicit endpoint still wins over the environment.
    await createLocalProvider({ model: "qwen3:14b", endpoint: "http://127.0.0.9:1", fetchImpl }).complete("p");
  } finally {
    delete process.env.BLOG_WRITER_LOCAL_MODEL_ENDPOINT;
  }
  await createLocalProvider({ model: "qwen3:14b", fetchImpl }).complete("p");
  assert.deepEqual(seen, [
    "http://host.docker.internal:11434/api/generate",
    "http://127.0.0.9:1/api/generate",
    "http://127.0.0.1:11434/api/generate",
  ]);
});

test("the local endpoint must be local: loopback, the container host gateway, or a private range, over http", async () => {
  const { isLocalModelEndpoint, LOCAL_ENDPOINT_NOT_LOCAL } = await import("../generator.js");
  for (const ok of ["http://127.0.0.1:11434", "http://127.0.0.9:1", "http://localhost:11434", "http://[::1]:11434",
    "http://host.docker.internal:11435", "http://host.lima.internal:11435", "http://192.168.5.2:11435",
    "http://10.1.2.3:11434", "http://172.20.0.1:11434"]) {
    assert.equal(isLocalModelEndpoint(ok), true, ok);
  }
  for (const bad of ["https://api.example.com", "http://api.example.com:11434", "http://8.8.8.8:11434",
    "http://172.32.0.1:11434", "http://192.169.0.1:11434", "https://127.0.0.1:11434", "ftp://127.0.0.1",
    "http://127.0.0.1.example.com", "http://host.docker.internal.evil.com", "not a url", ""]) {
    assert.equal(isLocalModelEndpoint(bad), false, bad);
  }
  const seen = [];
  process.env.BLOG_WRITER_LOCAL_MODEL_ENDPOINT = "https://models.example.com";
  try {
    const p = createLocalProvider({ model: "qwen3:14b", fetchImpl: async (u) => { seen.push(u); return { ok: true, json: async () => ({}) }; } });
    await assert.rejects(p.complete("p"), (error) => {
      assert.equal(error.detail?.code, LOCAL_ENDPOINT_NOT_LOCAL);
      assert.ok(!error.message.includes("models.example.com"), "the configured host is not echoed");
      return true;
    });
  } finally {
    delete process.env.BLOG_WRITER_LOCAL_MODEL_ENDPOINT;
  }
  assert.deepEqual(seen, [], "nothing is sent to a non-local endpoint");
});
