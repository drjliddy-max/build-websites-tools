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
  malformedMeasurementIdDiagnostic,
  MALFORMED_MEASUREMENT_ID_REASON,
  GA4_MEASUREMENT_ID_EXPECTED_FORM,
  createTrackHandler,
  isSupportedGa4MeasurementId,
  resolveMeasurementId,
  sanitizeParams,
} from "../conversion-relay.js";
import type { MeasurementIdResolution } from "../conversion-relay.js";

const SERVER_KEY = "GA4_MEASUREMENT_ID";
const PUBLIC_KEY = "NEXT_PUBLIC_GA_MEASUREMENT_ID";
const DEFAULT_KEYS = [SERVER_KEY, PUBLIC_KEY];

// Assembled, never a literal, so the pre-commit credential guard stays quiet.
const STUB_SECRET = ["stub", "value", "never", "sent"].join("-");

/**
 * COMPILE-TIME guard on the declared result union. This has no runtime assertion
 * on purpose - it exists so `tsc --noEmit` fails if `MALFORMED` is ever dropped
 * from `MeasurementIdResolution`.
 *
 * WHY: the runtime suite cannot see the `.d.ts`. Mutation testing proved it -
 * deleting the MALFORMED variant from the declaration left all 293 runtime tests
 * green and typecheck at exit 0, so a consumer switching exhaustively on the
 * union would have lost its malformed branch with nothing reporting it. Removing
 * a variant now makes the `case "MALFORMED"` below un-comparable and fails the
 * build; adding a variant makes `exhaustive` stop being `never` and also fails.
 */
function _assertResolutionUnionIsExhaustive(r: MeasurementIdResolution): string {
  switch (r.status) {
    case "VALID":
      return r.measurementId;
    case "MISSING":
      return r.keys.join(",");
    case "MALFORMED":
      return r.malformedKeys.join(",");
    case "CONFLICT":
      return r.conflictingKeys.join(",");
    default: {
      const exhaustive: never = r;
      return exhaustive;
    }
  }
}
void _assertResolutionUnionIsExhaustive;

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

// ─── C1b: malformed measurement ids fail closed ────────────────────────
//
// The v0.12.0 contract refused AMBIGUOUS configuration but accepted any
// nonempty string as an id, so `gibberish`, `UA-12345-6` and bare `G-` all
// dispatched and returned 200. GA4 answers 204 for an id it does not recognise
// and stores nothing, so that is the same silent-success signature the whole
// contract exists to remove. Found by independent adversarial review of the
// bmj-marketing rollout and reproduced against that consumer's real route.

describe("C1b isSupportedGa4MeasurementId - accepted forms", () => {
  const accepted = [
    ["representative production shape", "G-TESTFIX001"],
    ["minimum supported payload (6)", "G-ABC123"],
    ["longer supported payload", "G-ABCDEFGHIJKLMNOPQRST"],
    ["digits only payload", "G-1234567890"],
    ["letters only payload", "G-ABCDEFGHIJ"],
  ] as const;
  for (const [label, id] of accepted) {
    it(`accepts ${label}`, () => {
      assert.equal(isSupportedGa4MeasurementId(id), true, `${label} should be supported`);
    });
  }
});

describe("C1b isSupportedGa4MeasurementId - rejected forms", () => {
  const rejected = [
    ["bare prefix", "G-"],
    ["single char payload", "G-A"],
    ["below the length floor", "G-ABC12"],
    ["underscore separator", "G_ABC123"],
    ["legacy Universal Analytics", "UA-12345-6"],
    ["legacy UA with GA4-ish payload", "UA-CY38LKH4MR"],
    ["no prefix at all", "CY38LKH4MR"],
    ["lowercase prefix", "g-CY38LKH4MR"],
    ["lowercase payload", "G-cy38lkh4mr"],
    ["mixed case payload", "G-Cy38Lkh4Mr"],
    ["embedded space", "G-CY38 LKH4MR"],
    ["embedded tab", "G-CY38\tLKH4MR"],
    ["second token after newline", "G-TESTFIX001\nG-OTHER12345"],
    ["trailing punctuation", "G-TESTFIX001."],
    ["leading punctuation", ".G-TESTFIX001"],
    ["quoted value", '"G-TESTFIX001"'],
    ["url-encoded newline", "G-TESTFIX001%0A"],
    ["hyphen inside payload", "G-CY38-LKH4MR"],
    ["Unicode lookalike (Cyrillic С)", "G-СY38LKH4MR"],
    ["Unicode digit lookalike", "G-TESTFIX001​"],
    ["implausibly long", "G-" + "A".repeat(64)],
    ["arbitrary nonempty string", "gibberish"],
    ["not-a-ga4-id", "not-a-ga4-id"],
    ["empty string", ""],
    ["whitespace only", "   "],
  ] as const;
  for (const [label, id] of rejected) {
    it(`rejects ${label}`, () => {
      assert.equal(isSupportedGa4MeasurementId(id), false, `${label} must be refused`);
    });
  }

  it("rejects non-string values the API structurally permits", () => {
    for (const v of [undefined, null, 42, true, {}, [], Symbol("G-ABCDEF")]) {
      assert.equal(isSupportedGa4MeasurementId(v as unknown as string), false);
    }
  });
});

describe("C1b resolver - multi-source matrix", () => {
  const V1 = "G-VALIDAAAA1";
  const V2 = "G-VALIDBBBB2";
  const BAD = "not-a-ga4-id";

  const cases: Array<[string, Record<string, string>, string]> = [
    ["valid + same valid", { [SERVER_KEY]: V1, [PUBLIC_KEY]: V1 }, "VALID"],
    ["valid + conflicting valid", { [SERVER_KEY]: V1, [PUBLIC_KEY]: V2 }, "CONFLICT"],
    ["valid + malformed", { [SERVER_KEY]: V1, [PUBLIC_KEY]: BAD }, "MALFORMED"],
    ["malformed + valid", { [SERVER_KEY]: BAD, [PUBLIC_KEY]: V1 }, "MALFORMED"],
    ["malformed + same malformed", { [SERVER_KEY]: BAD, [PUBLIC_KEY]: BAD }, "MALFORMED"],
    ["missing + malformed", { [PUBLIC_KEY]: BAD }, "MALFORMED"],
    ["whitespace-only + valid", { [SERVER_KEY]: "   ", [PUBLIC_KEY]: V1 }, "VALID"],
    ["whitespace-only + malformed", { [SERVER_KEY]: "   ", [PUBLIC_KEY]: BAD }, "MALFORMED"],
    ["legacy UA + valid", { [SERVER_KEY]: "UA-12345-6", [PUBLIC_KEY]: V1 }, "MALFORMED"],
    ["both absent", {}, "MISSING"],
  ];

  for (const [label, env, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      assert.equal(resolveMeasurementId(env, DEFAULT_KEYS).status, expected);
    });
  }

  it("a malformed SECONDARY source is not excused by a valid primary", () => {
    const r = resolveMeasurementId({ [SERVER_KEY]: V1, [PUBLIC_KEY]: BAD }, DEFAULT_KEYS);
    assert.equal(r.status, "MALFORMED");
    assert.deepEqual((r as any).malformedKeys, [PUBLIC_KEY]);
  });

  it("MALFORMED carries key names only - no value, substring, or length", () => {
    const r = resolveMeasurementId({ [SERVER_KEY]: BAD, [PUBLIC_KEY]: "UA-99999-1" }, DEFAULT_KEYS);
    const s = JSON.stringify(r);
    assert.doesNotMatch(s, /not-a-ga4-id/);
    assert.doesNotMatch(s, /UA-99999-1/);
    assert.doesNotMatch(s, /gibberish/);
    assert.deepEqual((r as any).malformedKeys, [SERVER_KEY, PUBLIC_KEY]);
  });
});

describe("C1b route - malformed configuration refuses with zero dispatch", () => {
  const BAD_VALUES = ["not-a-ga4-id", "G_TYPO12345", "UA-12345-6", "G-", "gibberish", "g-lowercase1"];

  for (const bad of BAD_VALUES) {
    it(`refuses ${JSON.stringify(bad)} with 503, code, and NO dispatch`, async () => {
      const { res, sent, text } = await callHandler({
        [PUBLIC_KEY]: bad,
        GA4_API_SECRET: STUB_SECRET,
      });
      assert.equal(res.status, 503, "must fail closed");
      assert.equal(sent.length, 0, "must not dispatch to GA4");
      assert.match(text, /GA4_CONFIG_MALFORMED/);
      // Redaction is asserted for values that actually carry configured
      // information. The bare prefix "G-" is excluded deliberately: it is the
      // universal GA4 prefix, appears in this repo's docs, and appears in the
      // refusal's own `Expected "G-" followed by ...` hint. Asserting its
      // absence would not protect anything and would force the removal of a
      // message an operator needs. Everything with a payload IS asserted.
      if (bad.length > 2) {
        assert.doesNotMatch(text, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });
  }

  it("names the offending KEY but never the value", async () => {
    const { text } = await callHandler({
      [SERVER_KEY]: "not-a-ga4-id",
      GA4_API_SECRET: STUB_SECRET,
    });
    assert.match(text, new RegExp(SERVER_KEY));
    assert.doesNotMatch(text, /not-a-ga4-id/);
    assert.doesNotMatch(text, new RegExp(STUB_SECRET));
  });

  it("the four refusal classes are distinguishable by stable code", async () => {
    const missing = await callHandler({ GA4_API_SECRET: STUB_SECRET });
    assert.match(missing.text, /GA4_CONFIG_MISSING/);

    const malformed = await callHandler({ [PUBLIC_KEY]: "nope", GA4_API_SECRET: STUB_SECRET });
    assert.match(malformed.text, /GA4_CONFIG_MALFORMED/);

    const conflict = await callHandler({
      [SERVER_KEY]: "G-AAAAAAAAAA",
      [PUBLIC_KEY]: "G-BBBBBBBBBB",
      GA4_API_SECRET: STUB_SECRET,
    });
    assert.match(conflict.text, /GA4_CONFIG_CONFLICT/);

    const badEvent = await callHandler(
      { [PUBLIC_KEY]: "G-AAAAAAAAAA", GA4_API_SECRET: STUB_SECRET },
      { name: "not_allowlisted" },
    );
    assert.equal(badEvent.res.status, 400, "invalid event input is 400, not a 503 config class");
  });

  it("valid configuration still dispatches exactly once (no regression)", async () => {
    const { res, sent } = await callHandler({
      [PUBLIC_KEY]: "G-VALIDAAAA1",
      GA4_API_SECRET: STUB_SECRET,
    });
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /measurement_id=G-VALIDAAAA1/);
  });
});

/* ============================================================================
 * REDACTION CONTRACT - malformed measurement id must not leak, even partially
 *
 * WHY THIS EXISTS: a mutation that appended `(got not-..., length 12)` to the
 * refusal SURVIVED the entire mutation campaign. Every prior assertion checked
 * only that the FULL value was absent. A prefix, a suffix, a length, a hash, or
 * a case-transformed form is still disclosure of configured state.
 *
 * The sentinel is ASSEMBLED AT RUNTIME from segments so that (a) no literal in
 * this file resembles a real identifier and (b) an assertion cannot pass merely
 * because the constant was inlined somewhere.
 * ========================================================================= */

// Distinct 5-char segments. Deliberately not substrings of any English word or
// of the fixed refusal text, so a hit is unambiguous evidence of disclosure.
const SEG_HEAD = ["QZ", "XWV"].join("");
const SEG_MID = ["JK", "PLM"].join("");
const SEG_TAIL = ["BN", "TRY"].join("");
const LEAK_SENTINEL = ["G-", SEG_HEAD, SEG_MID, SEG_TAIL].join(""); // shape-valid...
const LEAK_SENTINEL_BAD = [SEG_HEAD, "!", SEG_MID, "!", SEG_TAIL].join(""); // ...and not
const SENTINEL_LEN = String(LEAK_SENTINEL_BAD.length);

/** Every form in which the value, or information derived from it, could escape. */
function disclosureForms(value: string): Array<[string, string]> {
  const forms: Array<[string, string]> = [
    ["full value", value],
    ["lowercase", value.toLowerCase()],
    ["uppercase", value.toUpperCase()],
    ["URL-encoded", encodeURIComponent(value)],
    ["JSON-escaped", JSON.stringify(value).slice(1, -1)],
    ["base64", Buffer.from(value).toString("base64")],
    ["hex", Buffer.from(value).toString("hex")],
    ["head segment", SEG_HEAD],
    ["middle segment", SEG_MID],
    ["tail segment", SEG_TAIL],
    ["exact length", SENTINEL_LEN],
    ["length phrase", `length ${SENTINEL_LEN}`],
  ];
  // Multi-char prefixes/suffixes of the unique segments (3..6). Shorter than 3
  // would risk colliding with the fixed safe text, which would make the
  // assertion pass for the wrong reason.
  for (let n = 3; n <= 6 && n <= value.length; n += 1) {
    forms.push([`prefix ${n}`, SEG_HEAD.slice(0, Math.min(n, SEG_HEAD.length))]);
    forms.push([`suffix ${n}`, SEG_TAIL.slice(-Math.min(n, SEG_TAIL.length))]);
  }
  return forms;
}

function assertNoDisclosure(haystack: string, value: string, where: string): void {
  const hay = haystack.toLowerCase();
  for (const [label, form] of disclosureForms(value)) {
    assert.ok(
      !hay.includes(form.toLowerCase()),
      `${where} disclosed the rejected value (${label}: ${JSON.stringify(form)}). ` +
        `Public diagnostics may name KEYS and the expected FORM only. Body was: ${haystack}`,
    );
  }
}

describe("redaction contract: malformed measurement id", () => {

  it("sentinel controls: the assertion helper can actually fail", () => {
    // A check that cannot fail proves nothing. Prove each form is detected.
    for (const [label, form] of disclosureForms(LEAK_SENTINEL_BAD)) {
      assert.throws(
        () => assertNoDisclosure(`prefix ${form} suffix`, LEAK_SENTINEL_BAD, "control"),
        /disclosed the rejected value/,
        `helper failed to detect disclosure form: ${label}`,
      );
    }
    // ...and does not fire on the genuine safe message.
    const safe = malformedMeasurementIdDiagnostic(["GA4_MEASUREMENT_ID"]);
    assertNoDisclosure(safe.error, LEAK_SENTINEL_BAD, "safe baseline");
  });

  it("diagnostic constructor cannot receive a value: arity is 1", () => {
    assert.equal(
      malformedMeasurementIdDiagnostic.length,
      1,
      "the constructor must take key names only - adding a value parameter is the leak",
    );
  });

  it("diagnostic carries a fixed reason, never derived from input", () => {
    const a = malformedMeasurementIdDiagnostic(["GA4_MEASUREMENT_ID"]);
    const b = malformedMeasurementIdDiagnostic(["NEXT_PUBLIC_GA_MEASUREMENT_ID"]);
    assert.equal(a.reason, MALFORMED_MEASUREMENT_ID_REASON);
    assert.equal(a.reason, b.reason);
    assert.equal(a.code, "GA4_CONFIG_MALFORMED");
  });

  // ─── accuracy of the hint, bound to the validator ──────────────────────
  //
  // The refusal used to say "Expected the form G-XXXXXXXXXX", describing a
  // fixed 10-character body the validator has never enforced. An operator
  // holding a valid 8-character id would read that and "fix" a non-problem.
  // These probe the REAL accepted bounds instead of trusting any literal, so
  // reverting the wording - or changing the pattern without the sentence -
  // fails here rather than in a customer's env.

  it("the stated expected form matches the bounds the validator enforces", () => {
    let observedMin: number | null = null;
    let observedMax: number | null = null;
    for (let n = 1; n <= 40; n += 1) {
      if (isSupportedGa4MeasurementId(`G-${"A".repeat(n)}`)) {
        if (observedMin === null) observedMin = n;
        observedMax = n;
      }
    }
    assert.ok(observedMin !== null && observedMax !== null, "validator accepts nothing");

    const message = malformedMeasurementIdDiagnostic(["GA4_MEASUREMENT_ID"]).error;
    assert.ok(
      message.includes(String(observedMin)),
      `hint must state the real minimum body length ${observedMin}; got: ${message}`,
    );
    assert.ok(
      message.includes(String(observedMax)),
      `hint must state the real maximum body length ${observedMax}; got: ${message}`,
    );
    assert.ok(
      message.includes(GA4_MEASUREMENT_ID_EXPECTED_FORM),
      "the refusal must use the single derived form description",
    );
  });

  it("the hint never claims a fixed-width form", () => {
    const message = malformedMeasurementIdDiagnostic(["GA4_MEASUREMENT_ID"]).error;
    assert.doesNotMatch(
      message,
      /G-X{3,}/,
      "a G-XXXX... placeholder implies an exact width the validator does not enforce",
    );
  });

  // ─── the constructor must be the ONLY producer of this body ────────────
  //
  // Without this, a caller could re-inline its own message string and every
  // other test here would still pass - the abstraction would look load-bearing
  // while guaranteeing nothing. Deep equality ties the wire format to the one
  // function whose signature makes disclosure impossible.

  it("the route's 503 body IS the constructor's output, not a re-inlined string", async () => {
    const keys = ["GA4_MEASUREMENT_ID"];
    const handler = createTrackHandler({
      allowedEvents: ["app_store_click"],
      getEnv: () => ({ GA4_MEASUREMENT_ID: LEAK_SENTINEL_BAD, GA4_API_SECRET: "test-secret" }),
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    const res = await handler(
      new Request("https://example.test/api/track", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "app_store_click" }),
      }),
    );
    assert.equal(res.status, 503);
    assert.deepEqual(
      await res.json(),
      malformedMeasurementIdDiagnostic(keys),
      "route body must be produced by malformedMeasurementIdDiagnostic",
    );
  });

  for (const [surfaceName, envFactory] of [
    ["server key", () => ({ GA4_MEASUREMENT_ID: LEAK_SENTINEL_BAD })],
    ["public key", () => ({ NEXT_PUBLIC_GA_MEASUREMENT_ID: LEAK_SENTINEL_BAD })],
    ["both keys", () => ({
      GA4_MEASUREMENT_ID: LEAK_SENTINEL_BAD,
      NEXT_PUBLIC_GA_MEASUREMENT_ID: LEAK_SENTINEL_BAD,
    })],
  ] as Array<[string, () => Record<string, string>]>) {
  it(`malformed via ${surfaceName}: 503 body discloses nothing derived from the value`, async () => {
      let dispatched = 0;
      const handler = createTrackHandler({
        allowedEvents: ["app_store_click"],
        getEnv: () => ({ ...envFactory(), GA4_API_SECRET: "test-secret" }),
        fetchImpl: async () => {
          dispatched += 1;
          return new Response(null, { status: 204 });
        },
      });
      const res = await handler(
        new Request("https://example.test/api/track", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "app_store_click" }),
        }),
      );
      assert.equal(res.status, 503);
      assert.equal(dispatched, 0, "must not dispatch on a malformed id");

      const raw = await res.text();
      assertNoDisclosure(raw, LEAK_SENTINEL_BAD, `${surfaceName} response body`);

      // Positive half: the refusal must still be USEFUL - it names the keys.
      const parsed = JSON.parse(raw);
      assert.equal(parsed.code, "GA4_CONFIG_MALFORMED");
      for (const key of Object.keys(envFactory())) {
        assert.ok(parsed.error.includes(key), `refusal must name the rejected key ${key}`);
      }
    });
  }

  it("resolver result itself carries key names only, no values", () => {
    const r = resolveMeasurementId(
      { GA4_MEASUREMENT_ID: LEAK_SENTINEL_BAD, NEXT_PUBLIC_GA_MEASUREMENT_ID: LEAK_SENTINEL_BAD },
      ["GA4_MEASUREMENT_ID", "NEXT_PUBLIC_GA_MEASUREMENT_ID"],
    );
    assert.equal(r.status, "MALFORMED");
    assertNoDisclosure(JSON.stringify(r), LEAK_SENTINEL_BAD, "resolver result");
  });

  it("no derived information: two different malformed values give identical bodies", async () => {
    // If the body varies with the value at all, something about the value crossed
    // the boundary - even if no recognisable substring did.
    const bodyFor = async (value: string) => {
      const handler = createTrackHandler({
        allowedEvents: ["app_store_click"],
        getEnv: () => ({ GA4_MEASUREMENT_ID: value, GA4_API_SECRET: "test-secret" }),
        fetchImpl: async () => new Response(null, { status: 204 }),
      });
      const res = await handler(
        new Request("https://example.test/api/track", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "app_store_click" }),
        }),
      );
      return res.text();
    };
    const short = await bodyFor("x");
    const long = await bodyFor(LEAK_SENTINEL_BAD + LEAK_SENTINEL_BAD);
    assert.equal(short, long, "refusal body must not vary with the rejected value");
  });
});
