/**
 * Transport-shape tests for the hosted provider.
 *
 * Incident 2026-08-27 (all seven Blog Writer lanes): every hosted attempt was
 * rejected with "Model returned an empty response." on an HTTP 200. Mechanism:
 * claude-sonnet-5 runs adaptive thinking when the request omits the `thinking`
 * parameter, so the response's FIRST content block is a `thinking` block and
 * the old extraction (`payload.content?.[0]?.text ?? ""`) read `undefined`
 * from it, degrading every valid response to the empty string.
 *
 * Every routing test fakes providers at the `complete()` level, so no test
 * observed the real response shape; the fake encoded the caller's assumption
 * (text-first content). These tests pin the REAL response shapes at the
 * transport boundary so a future model- or API-behavior change fails here,
 * not in production CI.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createHostedProvider, GenerationError } from "../generator.js";

const KEY_ENV = "TEST_HOSTED_PROVIDER_KEY";

function makeProvider(payload, { status = 200 } = {}) {
  const calls = [];
  const provider = createHostedProvider({
    model: "claude-sonnet-5",
    endpoint: "https://api.invalid/v1/messages",
    apiKeyEnv: KEY_ENV,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      };
    },
  });
  return { provider, calls };
}

test.beforeEach(() => {
  process.env[KEY_ENV] = "test-value-not-a-real-credential";
});

test.afterEach(() => {
  delete process.env[KEY_ENV];
});

test("extracts text when the response leads with a thinking block (sonnet-5 adaptive default)", async () => {
  const { provider } = makeProvider({
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: '{"title":"ok"}' },
    ],
    stop_reason: "end_turn",
  });
  assert.equal(await provider.complete("prompt"), '{"title":"ok"}');
});

test("still extracts text from a text-first response (pre-thinking shape)", async () => {
  const { provider } = makeProvider({
    content: [{ type: "text", text: "plain" }],
    stop_reason: "end_turn",
  });
  assert.equal(await provider.complete("prompt"), "plain");
});

test("joins multiple text blocks in order", async () => {
  const { provider } = makeProvider({
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text: "part one " },
      { type: "text", text: "part two" },
    ],
    stop_reason: "end_turn",
  });
  assert.equal(await provider.complete("prompt"), "part one part two");
});

test("a thinking-only response truncated at max_tokens names the truncation, not a generic empty", async () => {
  const { provider } = makeProvider({
    content: [{ type: "thinking", thinking: "" }],
    stop_reason: "max_tokens",
  });
  await assert.rejects(
    () => provider.complete("prompt"),
    (error) => error instanceof GenerationError && /max_tokens/.test(error.message),
  );
});

test("a refusal names the refusal, not a generic empty", async () => {
  const { provider } = makeProvider({
    content: [],
    stop_reason: "refusal",
  });
  await assert.rejects(
    () => provider.complete("prompt"),
    (error) => error instanceof GenerationError && /refus/i.test(error.message),
  );
});

test("a genuinely empty end_turn response returns the empty string for the caller's empty-response error", async () => {
  const { provider } = makeProvider({
    content: [],
    stop_reason: "end_turn",
  });
  assert.equal(await provider.complete("prompt"), "");
});

test("non-2xx still fails closed on status alone", async () => {
  const { provider } = makeProvider({ error: { type: "overloaded_error" } }, { status: 529 });
  await assert.rejects(
    () => provider.complete("prompt"),
    (error) => error instanceof GenerationError && /529/.test(error.message),
  );
});

test("the hosted request pins low effort - latency is a contract inside the CI job budget", async () => {
  const { provider, calls } = makeProvider({
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
  });
  await provider.complete("prompt");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.max_tokens, 16000);
});
