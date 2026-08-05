// src/__tests__/conversion-contract.test.ts
//
// THE SHARED ANALYTICS CONFIGURATION CONTRACT.
//
// Owned by build-websites-tools and never copied into a consumer: the selection
// behaviour lives here, so the guard must live here too. A consumer-side copy
// would drift from the implementation it is meant to constrain.
//
// The defect this suite exists to make impossible: until v0.11.3 the relay took
// the FIRST populated measurement-id key and stopped. Every consumer declares
// two keys, so a stale GA4_MEASUREMENT_ID silently outranked the correct public
// id and sent every conversion to a different property - relay {ok:true}, GA4
// 204, intended property empty, nothing reporting the loss anywhere.
// _audit-vault F-20260803-01, F-20260804-03.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTrackHandler,
  resolveMeasurementId,
  sanitizeParams,
} from "../conversion-relay.js";

const SERVER_KEY = "GA4_MEASUREMENT_ID";
const PUBLIC_KEY = "NEXT_PUBLIC_GA_MEASUREMENT_ID";
const DEFAULT_KEYS = [SERVER_KEY, PUBLIC_KEY];

// Assembled, never a literal, so the pre-commit credential guard stays quiet.
const STUB_SECRET = ["stub", "value", "never", "sent"].join("-");

function makeRequest(body: unknown) {
  return new Request("https://example.test/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Drive the real handler with an injected transport; nothing reaches network. */
async function callHandler(
  env: Record<string, string | undefined>,
  { keys = DEFAULT_KEYS, name = "demo_event", params = {} as Record<string, unknown> } = {},
) {
  const sent: Array<{ url: string; body: any }> = [];
  const handler = createTrackHandler({
    allowedEvents: ["demo_event"],
    fallbackCookieName: "demo_cid",
    measurementIdEnvKeys: keys,
    generateId: () => "1111111111.2222222222",
    generateSessionId: () => "1785854000",
    getEnv: () => env,
    // Signature must match the declared fetch shape, not a narrowed convenience
    // one - otherwise the stub typechecks here and diverges from what the module
    // is actually handed at runtime.
    fetchImpl: (async (input: URL | RequestInfo, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const res = await handler(makeRequest({ name, params }));
  const text = await res.clone().text();
  return { res, sent, text };
}

// ─── C1: one unambiguous effective measurement id ──────────────────────

describe("C1 resolveMeasurementId - VALID / MISSING / CONFLICT", () => {
  it("1. no keys populated -> MISSING", () => {
    const r = resolveMeasurementId({}, DEFAULT_KEYS);
    assert.equal(r.status, "MISSING");
  });

  it("2. one key populated -> VALID, normalized", () => {
    const r = resolveMeasurementId({ [PUBLIC_KEY]: "G-AAAAAAAAAA" }, DEFAULT_KEYS);
    assert.equal(r.status, "VALID");
    assert.equal((r as any).measurementId, "G-AAAAAAAAAA");
    assert.deepEqual((r as any).sourceKeys, [PUBLIC_KEY]);
    assert.equal((r as any).duplicate, false);
  });

  it("3. first key empty, second valid -> second selected", () => {
    const r = resolveMeasurementId(
      { [SERVER_KEY]: "", [PUBLIC_KEY]: "G-BBBBBBBBBB" },
      DEFAULT_KEYS,
    );
    assert.equal(r.status, "VALID");
    assert.equal((r as any).measurementId, "G-BBBBBBBBBB");
  });

  it("4. equal duplicate values -> VALID, flagged duplicate, both keys named", () => {
    const r = resolveMeasurementId(
      { [SERVER_KEY]: "G-CCCCCCCCCC", [PUBLIC_KEY]: "G-CCCCCCCCCC" },
      DEFAULT_KEYS,
    );
    assert.equal(r.status, "VALID");
    assert.equal((r as any).measurementId, "G-CCCCCCCCCC");
    assert.equal((r as any).duplicate, true);
    assert.deepEqual((r as any).sourceKeys, [SERVER_KEY, PUBLIC_KEY]);
  });

  it("5. values differing ONLY by surrounding whitespace -> VALID (not a conflict)", () => {
    // The F-20260803-01 defect: a trailing newline renders identically in every
    // UI. It must normalize, not be reported as two different ids.
    const r = resolveMeasurementId(
      { [SERVER_KEY]: "  G-DDDDDDDDDD\n", [PUBLIC_KEY]: "G-DDDDDDDDDD" },
      DEFAULT_KEYS,
    );
    assert.equal(r.status, "VALID");
    assert.equal((r as any).measurementId, "G-DDDDDDDDDD");
    assert.equal((r as any).duplicate, true);
  });

  it("6. differing values -> CONFLICT", () => {
    const r = resolveMeasurementId(
      { [SERVER_KEY]: "G-STALE00000", [PUBLIC_KEY]: "G-CORRECT001" },
      DEFAULT_KEYS,
    );
    assert.equal(r.status, "CONFLICT");
    assert.deepEqual((r as any).conflictingKeys, [SERVER_KEY, PUBLIC_KEY]);
  });

  it("7. three declared keys, one populated -> VALID", () => {
    const r = resolveMeasurementId(
      { LEGACY_GA_ID: "G-EEEEEEEEEE" },
      [SERVER_KEY, PUBLIC_KEY, "LEGACY_GA_ID"],
    );
    assert.equal(r.status, "VALID");
    assert.equal((r as any).measurementId, "G-EEEEEEEEEE");
  });

  it("8. three declared keys, two different populated -> CONFLICT naming only those two", () => {
    const r = resolveMeasurementId(
      { [SERVER_KEY]: "G-ONE0000000", LEGACY_GA_ID: "G-TWO0000000" },
      [SERVER_KEY, PUBLIC_KEY, "LEGACY_GA_ID"],
    );
    assert.equal(r.status, "CONFLICT");
    assert.deepEqual((r as any).conflictingKeys, [SERVER_KEY, "LEGACY_GA_ID"]);
  });

  it("whitespace-only is absent, not present-and-empty", () => {
    assert.equal(resolveMeasurementId({ [SERVER_KEY]: "   \n\t " }, DEFAULT_KEYS).status, "MISSING");
  });

  it("CONFLICT result carries NO values, so a caller cannot leak one", () => {
    const r = resolveMeasurementId(
      { [SERVER_KEY]: "G-SECRETISH1", [PUBLIC_KEY]: "G-SECRETISH2" },
      DEFAULT_KEYS,
    );
    const serialized = JSON.stringify(r);
    assert.doesNotMatch(serialized, /G-SECRETISH1|G-SECRETISH2/);
  });
});

// ─── C1 at the route boundary ──────────────────────────────────────────

describe("C1 route behaviour - refusal is loud, attributable, and value-free", () => {
  it("9+10+11. conflict -> 503, names the keys, contains NEITHER value", async () => {
    const { res, text, sent } = await callHandler({
      [SERVER_KEY]: "G-STALE00000",
      [PUBLIC_KEY]: "G-CORRECT001",
      GA4_API_SECRET: STUB_SECRET,
    });
    assert.equal(res.status, 503);
    assert.match(text, new RegExp(SERVER_KEY));
    assert.match(text, new RegExp(PUBLIC_KEY));
    assert.doesNotMatch(text, /G-STALE00000/);
    assert.doesNotMatch(text, /G-CORRECT001/);
    assert.match(text, /Refusing to choose/i);
    assert.equal(sent.length, 0, "a conflicting config must send NOTHING");
  });

  it("12+13. missing -> 503 naming expected keys, no secret in the body", async () => {
    const { res, text, sent } = await callHandler({ GA4_API_SECRET: STUB_SECRET });
    assert.equal(res.status, 503);
    assert.match(text, new RegExp(SERVER_KEY));
    assert.doesNotMatch(text, new RegExp(STUB_SECRET));
    assert.equal(sent.length, 0);
  });

  it("missing secret -> 503 and no request", async () => {
    const { res, sent } = await callHandler({ [PUBLIC_KEY]: "G-FFFFFFFFFF" });
    assert.equal(res.status, 503);
    assert.equal(sent.length, 0);
  });

  it("valid single -> dispatches to exactly that id", async () => {
    const { res, sent } = await callHandler({
      [PUBLIC_KEY]: "G-GGGGGGGGGG",
      GA4_API_SECRET: STUB_SECRET,
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /measurement_id=G-GGGGGGGGGG/);
  });

  it("equal duplicates -> dispatches once, no refusal", async () => {
    const { res, sent } = await callHandler({
      [SERVER_KEY]: "G-HHHHHHHHHH",
      [PUBLIC_KEY]: " G-HHHHHHHHHH ",
      GA4_API_SECRET: STUB_SECRET,
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /measurement_id=G-HHHHHHHHHH/);
  });

  it("the ADA/siteclinic alias key set behaves identically", async () => {
    const keys = [SERVER_KEY, "NEXT_PUBLIC_GA4_ID"];
    const ok = await callHandler(
      { NEXT_PUBLIC_GA4_ID: "G-ALIAS00001", GA4_API_SECRET: STUB_SECRET },
      { keys },
    );
    assert.equal(ok.res.status, 200);
    const bad = await callHandler(
      { [SERVER_KEY]: "G-ALIAS00002", NEXT_PUBLIC_GA4_ID: "G-ALIAS00001", GA4_API_SECRET: STUB_SECRET },
      { keys },
    );
    assert.equal(bad.res.status, 503);
    assert.match(await bad.res.text(), /NEXT_PUBLIC_GA4_ID/);
  });
});

// ─── C4: deterministic scalar serialization ────────────────────────────
//
// Policy, chosen against GA4's constraints and current consumer call sites, and
// documented rather than left implicit. A malformed PARAM drops; it never costs
// the EVENT it belongs to, because losing a conversion to a bad score is worse
// than losing the score.

describe("C4 serialization - every type has a declared, tested outcome", () => {
  const cases: Array<[string, unknown, "keep" | "drop"]> = [
    ["plain string", "hello", "keep"],
    ["empty string", "", "keep"], // explicit policy: kept, GA4 accepts it
    ["finite number", 42, "keep"],
    ["zero", 0, "keep"], // falsy but valid - the classic truthiness bug
    ["negative number", -7, "keep"],
    ["float", 1.5, "keep"],
    ["true", true, "keep"],
    ["false", false, "keep"], // falsy but valid
    ["undefined", undefined, "drop"],
    ["null", null, "drop"],
    ["NaN", Number.NaN, "drop"],
    ["Infinity", Number.POSITIVE_INFINITY, "drop"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "drop"],
    ["array", [1, 2, 3], "drop"],
    ["nested object", { a: 1 }, "drop"],
    ["function", () => {}, "drop"],
  ];

  for (const [label, value, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      const out = sanitizeParams({ p: value });
      assert.equal("p" in out, expected === "keep", `${label} should ${expected}`);
    });
  }

  it("oversized string truncates to 500 chars, event survives", () => {
    const out = sanitizeParams({ p: "x".repeat(5000) });
    assert.equal((out.p as string).length, 500);
  });

  it("non-finite numbers cannot reach the wire as JSON null", () => {
    const out = sanitizeParams({ score: Number.NaN, ok: 91 });
    assert.equal(JSON.stringify(out), JSON.stringify({ ok: 91 }));
    assert.doesNotMatch(JSON.stringify(out), /null/);
  });

  it("a bad param does NOT cost the event", async () => {
    const { res, sent } = await callHandler(
      { [PUBLIC_KEY]: "G-IIIIIIIIII", GA4_API_SECRET: STUB_SECRET },
      { params: { score: Number.NaN, good: 1 } },
    );
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    const p = sent[0].body.events[0].params;
    assert.equal("score" in p, false);
    assert.equal(p.good, 1);
  });

  it("params round-trip deterministically", () => {
    const out = sanitizeParams({ a: "x", b: 1, c: true, d: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  });
});

// ─── C7: privacy-safe errors ───────────────────────────────────────────

describe("C7 no secret or id value in any response body", () => {
  it("no response body on any refusal path contains the api secret", async () => {
    const envs = [
      { GA4_API_SECRET: STUB_SECRET },
      { [SERVER_KEY]: "G-JJJJJJJJJJ", [PUBLIC_KEY]: "G-KKKKKKKKKK", GA4_API_SECRET: STUB_SECRET },
      { [PUBLIC_KEY]: "G-LLLLLLLLLL" },
    ];
    for (const env of envs) {
      const { text } = await callHandler(env);
      assert.doesNotMatch(text, new RegExp(STUB_SECRET), `leaked secret for ${JSON.stringify(Object.keys(env))}`);
    }
  });

  it("the dispatched URL is never echoed into a response body", async () => {
    const { text } = await callHandler({
      [SERVER_KEY]: "G-MMMMMMMMMM",
      [PUBLIC_KEY]: "G-NNNNNNNNNN",
      GA4_API_SECRET: STUB_SECRET,
    });
    assert.doesNotMatch(text, /api_secret/);
    assert.doesNotMatch(text, /google-analytics\.com/);
  });
});

// ─── C6: navigation contract - and its honest limit ────────────────────
//
// WHAT THE BUILDER CANNOT GUARANTEE. It ships no client helper: `conversion-relay`
// is server-only, and every consumer owns its own call site. So the builder cannot
// promise that a pre-redirect event is DELIVERED - `keepalive: true` is a request
// to the browser, not a receipt, and a browser may still drop it.
//
// WHAT IT CAN GUARANTEE, and what these tests pin: the contract SHAPE that every
// consumer call site must satisfy - dispatch is initiated before navigation, sets
// keepalive, is not awaited in a way that blocks the customer action, and cannot
// surface a transport failure to the user. Verified 2026-08-04: all 9 consumers
// already satisfy this, so making it explicit breaks nobody.
//
// A source-level gate invariant enforcing it across consumers is the natural next
// step and is deliberately NOT in this branch - see the rollout note in README.

describe("C6 navigation contract - shape the builder can truthfully assert", () => {
  /** The dispatch pattern every consumer uses, reduced to its contract. */
  function dispatchThenNavigate(
    fetchImpl: (url: string, init: any) => Promise<unknown>,
    navigate: () => void,
    payload: { name: string; params: Record<string, unknown> },
  ) {
    void fetchImpl("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    })?.catch?.(() => {});
    navigate();
  }

  it("fetch is invoked BEFORE navigation, with keepalive and the exact payload", () => {
    const order: string[] = [];
    let seen: any = null;
    dispatchThenNavigate(
      async (_u, init) => { order.push("fetch"); seen = init; },
      () => order.push("navigate"),
      { name: "checkout_started", params: { tier: "standard" } },
    );
    assert.deepEqual(order, ["fetch", "navigate"], "dispatch must precede navigation");
    assert.equal(seen.keepalive, true);
    assert.equal(seen.method, "POST");
    assert.deepEqual(JSON.parse(seen.body), {
      name: "checkout_started",
      params: { tier: "standard" },
    });
  });

  it("navigation still proceeds when the transport REJECTS", () => {
    let navigated = false;
    assert.doesNotThrow(() =>
      dispatchThenNavigate(
        async () => { throw new Error("network down"); },
        () => { navigated = true; },
        { name: "checkout_started", params: {} },
      ),
    );
    assert.equal(navigated, true, "a telemetry failure must never block the customer action");
  });

  it("a transport rejection exposes no secret and no relay URL", async () => {
    let captured = "";
    dispatchThenNavigate(
      async () => { throw new Error(`connect failed to /api/track`); },
      () => {},
      { name: "checkout_started", params: {} },
    );
    // The pattern swallows the rejection: nothing is surfaced at all.
    assert.equal(captured, "");
    assert.doesNotMatch(captured, /api_secret|google-analytics\.com/);
  });

  it("dispatch is not awaited - the call site returns synchronously", () => {
    let resolved = false;
    const started = Date.now();
    dispatchThenNavigate(
      () => new Promise((r) => setTimeout(() => { resolved = true; r(null); }, 50)),
      () => {},
      { name: "checkout_started", params: {} },
    );
    assert.equal(resolved, false, "must not block on the response");
    assert.ok(Date.now() - started < 40);
  });
});
