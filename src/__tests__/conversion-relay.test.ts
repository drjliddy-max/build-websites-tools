/*
 * Contract for conversion-relay.js - the shared server-side GA4 conversion
 * lane introduced in v0.10.0.
 *
 * Every assertion here exists because the nine hand-copied relays it replaces
 * got that exact thing wrong. Audit trail: _audit-vault F-20260731-02
 * (double delivery under split identity), -03 (sessionless events), -05 (the
 * gate that mandated the defect).
 *
 * Run via: npm test (in build-websites-tools).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMeasurementProtocolPayload,
  createTrackHandler,
  isAllowedEvent,
  parseCookies,
  readGaClientId,
  readGaSessionId,
  resolveIdentity,
  sanitizeParams,
} from "../conversion-relay.js";

const ENV = {
  GA4_MEASUREMENT_ID: "G-E9VHN7LTXB",
  GA4_API_SECRET: "test-secret-not-a-real-key",
};

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.com/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Capture the outgoing Measurement Protocol call. */
function recordingFetch(status = 204) {
  const calls: { url: string; body: any }[] = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(status === 204 ? null : "upstream detail", { status });
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

// ─── Cookie parsing ──────────────────────────────────────────────────

test("parseCookies handles values containing '=' and percent-encoding", () => {
  const out = parseCookies("a=1; b=x%3Dy; _ga=GA1.1.123.456");
  assert.equal(out.a, "1");
  assert.equal(out.b, "x=y");
  assert.equal(out._ga, "GA1.1.123.456");
});

test("readGaClientId strips the variable domain-component field", () => {
  // The count after GA1 varies with the domain, so the client id is everything
  // after the first two fields - not a fixed index.
  assert.equal(readGaClientId("_ga=GA1.1.1234567890.1698765432"), "1234567890.1698765432");
  assert.equal(readGaClientId("_ga=GA1.3.1234567890.1698765432"), "1234567890.1698765432");
});

test("readGaClientId returns null rather than guessing on absent or malformed input", () => {
  assert.equal(readGaClientId(""), null);
  assert.equal(readGaClientId("other=1"), null);
  assert.equal(readGaClientId("_ga=nonsense"), null);
  assert.equal(readGaClientId("_ga=GA1.1.abc.def"), null);
});

test("readGaSessionId parses both the GS1 and GS2 cookie formats", () => {
  const gs1 = "_ga_E9VHN7LTXB=GS1.1.1712345678.1.1.1712345700.0.0.0";
  const gs2 = "_ga_E9VHN7LTXB=GS2.1.s1712345678$o1$g1$t1712345700$j60$l0$h0";
  assert.equal(readGaSessionId(gs1, "G-E9VHN7LTXB"), "1712345678");
  assert.equal(readGaSessionId(gs2, "G-E9VHN7LTXB"), "1712345678");
});

test("readGaSessionId returns null for a different property's container", () => {
  const cookie = "_ga_E9VHN7LTXB=GS1.1.1712345678.1.1.0.0.0.0";
  assert.equal(readGaSessionId(cookie, "G-DIFFERENT1"), null);
});

// ─── Identity resolution ─────────────────────────────────────────────

test("resolveIdentity reuses the visitor's real GA identity when consented", () => {
  // This is the F-20260731-02 fix: server events must join the SAME identity
  // and session GA4 already holds, not fork a parallel one.
  const identity = resolveIdentity({
    cookieHeader: "_ga=GA1.1.1234567890.1698765432; _ga_E9VHN7LTXB=GS1.1.1712345678.1.1.0.0.0.0",
    measurementId: "G-E9VHN7LTXB",
    fallbackCookieName: "bwt_cid",
    generateId: () => "MINTED",
  });
  assert.equal(identity.clientId, "1234567890.1698765432");
  assert.equal(identity.sessionId, "1712345678");
  assert.equal(identity.consented, true);
  assert.equal(identity.mintedClientId, false);
});

test("resolveIdentity mints a first-party id when there is no GA cookie", () => {
  const identity = resolveIdentity({
    cookieHeader: "",
    measurementId: "G-E9VHN7LTXB",
    fallbackCookieName: "bwt_cid",
    generateId: () => "MINTED",
  });
  assert.equal(identity.clientId, "MINTED");
  assert.equal(identity.consented, false);
  assert.equal(identity.mintedClientId, true);
});

test("resolveIdentity reuses an existing first-party id and does not re-mint", () => {
  const identity = resolveIdentity({
    cookieHeader: "bwt_cid=STABLE",
    measurementId: "G-E9VHN7LTXB",
    fallbackCookieName: "bwt_cid",
    generateId: () => "MINTED",
  });
  assert.equal(identity.clientId, "STABLE");
  assert.equal(identity.mintedClientId, false, "re-minting would fragment the visitor across requests");
});

// ─── Payload shape ───────────────────────────────────────────────────

test("session_id and engagement_time_msec are EVENT params, not top level", () => {
  // The whole of F-20260731-03. GA4 ignores these at the top level and returns
  // 204 regardless, so putting them in the wrong place looks identical to
  // success while producing sessionless, unattributable events.
  const payload = buildMeasurementProtocolPayload({
    name: "book_buy_click",
    params: { label: "hero" },
    clientId: "cid",
    sessionId: "sid",
    consented: true,
  });
  assert.equal((payload as any).session_id, undefined);
  assert.equal((payload as any).engagement_time_msec, undefined);
  assert.equal(payload.events[0].params.session_id, "sid");
  assert.equal(payload.events[0].params.engagement_time_msec, 100);
  assert.equal(payload.events[0].params.label, "hero");
});

test("payload declares consent DENIED only for a non-consenting visitor", () => {
  const denied = buildMeasurementProtocolPayload({
    name: "e", clientId: "c", sessionId: "s", consented: false,
  });
  assert.deepEqual(denied.consent, { ad_user_data: "DENIED", ad_personalization: "DENIED" });

  const granted = buildMeasurementProtocolPayload({
    name: "e", clientId: "c", sessionId: "s", consented: true,
  });
  assert.equal(granted.consent, undefined);
});

test("buildMeasurementProtocolPayload refuses to build without an identity", () => {
  assert.throws(() => buildMeasurementProtocolPayload({ name: "e", clientId: "c" } as any), /sessionId/);
  assert.throws(() => buildMeasurementProtocolPayload({ name: "e", sessionId: "s" } as any), /clientId/);
});

test("sanitizeParams drops non-conforming keys and non-primitive values", () => {
  const out = sanitizeParams({
    ok: "yes", num: 1, bool: true,
    "1bad": "leading digit", "has-dash": "x",
    nested: { a: 1 }, arr: [1], nil: null,
  });
  assert.deepEqual(out, { ok: "yes", num: 1, bool: true });
});

test("sanitizeParams truncates long strings to 500 chars", () => {
  const out = sanitizeParams({ long: "x".repeat(900) });
  assert.equal((out.long as string).length, 500);
});

test("isAllowedEvent gates on the site's declared allowlist", () => {
  assert.equal(isAllowedEvent("buy", ["buy"]), true);
  assert.equal(isAllowedEvent("other", ["buy"]), false);
});

// ─── Handler ─────────────────────────────────────────────────────────

test("createTrackHandler requires a non-empty allowlist", () => {
  assert.throws(() => createTrackHandler({ allowedEvents: [] } as any), /allowedEvents/);
});

test("handler returns 503 with a named gap when config is missing", async () => {
  // UNKNOWN over false: a silent 200 would read as a working relay.
  const handler = createTrackHandler({ allowedEvents: ["buy"], getEnv: () => ({}) });
  const res = await handler(makeRequest({ name: "buy" }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /GA4_API_SECRET/);
});

test("handler rejects malformed bodies and non-allowlisted events", async () => {
  const handler = createTrackHandler({ allowedEvents: ["buy"], getEnv: () => ENV });
  assert.equal((await handler(makeRequest("not json"))).status, 400);
  assert.equal((await handler(makeRequest({}))).status, 400);
  assert.equal((await handler(makeRequest({ name: "not_allowed" }))).status, 400);
});

test("handler forwards one attributable event and sets no cookie for a consenting visitor", async () => {
  const { calls, impl } = recordingFetch();
  const handler = createTrackHandler({
    allowedEvents: ["buy"], getEnv: () => ENV, fetchImpl: impl, generateId: () => "MINTED",
  });
  const res = await handler(
    makeRequest({ name: "buy", params: { label: "hero" } }, {
      cookie: "_ga=GA1.1.111.222; _ga_E9VHN7LTXB=GS1.1.333.1.1.0.0.0.0",
      "x-forwarded-for": "203.0.113.9, 70.41.3.18",
    }),
  );

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1, "exactly one delivery per click");
  assert.equal(calls[0].body.client_id, "111.222", "must reuse the GA identity, not a second one");
  assert.equal(calls[0].body.events[0].params.session_id, "333");
  assert.equal(calls[0].body.user_ip_address, "203.0.113.9", "first XFF hop only");
  assert.equal(res.headers.get("set-cookie"), null, "nothing to persist; GA already has the identity");
});

test("handler persists the minted id and withholds the IP for a non-consenting visitor", async () => {
  const { calls, impl } = recordingFetch();
  const handler = createTrackHandler({
    allowedEvents: ["buy"], getEnv: () => ENV, fetchImpl: impl, generateId: () => "MINTED",
  });
  const res = await handler(
    makeRequest({ name: "buy" }, { "x-forwarded-for": "203.0.113.9" }),
  );

  assert.equal(res.status, 200);
  assert.equal(calls[0].body.client_id, "MINTED");
  assert.equal(calls[0].body.user_ip_address, undefined, "no IP without consent");
  assert.deepEqual(calls[0].body.consent, { ad_user_data: "DENIED", ad_personalization: "DENIED" });
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /bwt_cid=MINTED/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test("handler surfaces a non-204 upstream as 502 instead of reporting success", async () => {
  // 204 is the ONLY success signal from the Measurement Protocol; anything
  // else must not read as a delivered conversion.
  const { impl } = recordingFetch(400);
  const handler = createTrackHandler({
    allowedEvents: ["buy"], getEnv: () => ENV, fetchImpl: impl,
  });
  const res = await handler(makeRequest({ name: "buy" }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /returned 400/);
});

test("handler surfaces a network failure as 502", async () => {
  const handler = createTrackHandler({
    allowedEvents: ["buy"], getEnv: () => ENV,
    fetchImpl: (async () => { throw new Error("boom"); }) as unknown as typeof fetch,
  });
  const res = await handler(makeRequest({ name: "buy" }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /unreachable: boom/);
});
