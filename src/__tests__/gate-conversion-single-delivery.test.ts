/*
 * Contract for the v0.10.0 correction of gate:conversion-instrumentation-source.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * The v0.9.0 gate enforced the dual-fire *shape* ("some client file POSTs to
 * /api/track" while the client also calls gtag) rather than the *outcome*
 * ("exactly one attributable conversion delivery per click, in every consent
 * state"). Encoding shape froze a defect into the standard: for a consenting
 * visitor the click was delivered twice, under two different client_ids
 * (_ga vs the relay's own first-party cookie), so GA4 counted one click as two
 * events and two users. A site that fixed it would have FAILED its own
 * prebuild, because zero dual-fire callers tripped the relayInvoked invariant.
 *
 * Audit trail: _audit-vault findings F-20260731-02 (double count),
 * F-20260731-03 (sessionless MP events), F-20260731-05 (this gate mandating
 * the defect). Pattern: Pattern-Instrumented-But-Report-Never-Validated.
 *
 * These tests were written BEFORE the fix and verified RED against the v0.9.0
 * gate - see the commit body for captured output. Per
 * feedback_a_check_must_be_load_bearing: an assertion that cannot fail on the
 * defect proves nothing, so each one here is run against the defect first.
 *
 * The corrected contract, asserted below:
 *
 *   1. RELAY-ROUTE   exactly one /api/track handler                (unchanged)
 *   2. RELAY-SECRET  the route forwards via GA4_API_SECRET         (unchanged)
 *   3. SINGLE-DELIVERY  the relay is invoked, AND no caller also fires a
 *      client gtag event for that click. One click, one delivery.
 *   4. SESSION-PARAMS   the relay payload carries session_id and
 *      engagement_time_msec, without which GA4 accepts the event (204) but
 *      attaches it to no session - so conversions can never be attributed to a
 *      landing page, source, or campaign.
 *
 * Run via: npm test (in build-websites-tools).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateSource } from "../gate-conversion-instrumentation-source";

/** Create a temp site root with the given { relativePath: contents } files. */
function makeSite(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conv-single-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function checkNamed(root: string, name: string) {
  const result = evaluateSource({ cwd: root });
  const check = result.checks.find((c) => c.name === name);
  assert.ok(check, `expected a check named "${name}"; got: ${result.checks.map((c) => c.name).join(", ")}`);
  return check!;
}

// ─── Fixtures ────────────────────────────────────────────────────────

/** A relay route that forwards server-side but sends no session params. */
const ROUTE_NO_SESSION_PARAMS = `
import { NextResponse } from "next/server";
export async function POST(request) {
  const apiSecret = process.env.GA4_API_SECRET;
  if (!apiSecret) return NextResponse.json({}, { status: 503 });
  const body = { client_id: "abc", events: [{ name: "buy_click", params: {} }] };
  await fetch("https://www.google-analytics.com/mp/collect", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return NextResponse.json({ ok: true });
}
`;

/** A relay route carrying the session params GA4 needs for attribution. */
const ROUTE_WITH_SESSION_PARAMS = `
import { NextResponse } from "next/server";
export async function POST(request) {
  const apiSecret = process.env.GA4_API_SECRET;
  if (!apiSecret) return NextResponse.json({}, { status: 503 });
  const body = {
    client_id: "abc",
    events: [{
      name: "buy_click",
      params: { session_id: "1712345678", engagement_time_msec: 100 },
    }],
  };
  await fetch("https://www.google-analytics.com/mp/collect", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return NextResponse.json({ ok: true });
}
`;

/**
 * TODAY'S SHIPPED SHAPE across 7 repos: the click fires client gtag AND posts
 * to the relay, with no consent check between them. This is the defect.
 */
const CLIENT_DUAL_FIRE = `
"use client";
export function trackEvent(name, params) {
  window.gtag?.("event", name, params);
  void fetch("/api/track", {
    method: "POST",
    body: JSON.stringify({ name, params }),
    keepalive: true,
  });
}
`;

/** The corrected shape: server-only delivery, no client gtag event. */
const CLIENT_SINGLE_DELIVERY = `
"use client";
export function trackEvent(name, params) {
  void fetch("/api/track", {
    method: "POST",
    body: JSON.stringify({ name, params }),
    keepalive: true,
  });
}
`;

// ─── SINGLE-DELIVERY ─────────────────────────────────────────────────

test("singleDelivery FAILS on the shipped dual-fire shape (the F-20260731-02 defect)", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": CLIENT_DUAL_FIRE,
  });
  const check = checkNamed(root, "singleDelivery");
  assert.equal(
    check.pass,
    false,
    "a caller that fires gtag AND posts to /api/track delivers one click twice, under two client_ids",
  );
  assert.match(check.detail, /TrackedLink/, "the failure must name the offending file");
});

test("singleDelivery PASSES when the client delivers only through the relay", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "singleDelivery").pass, true);
});

test("singleDelivery still FAILS when nothing calls the relay at all", () => {
  // The v0.9.0 relayInvoked protection must survive the rewrite: a relay
  // nothing calls measures nothing. Correcting the double-count must not
  // reopen the original 2026-06-17 liddy-podiatry hole.
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SESSION_PARAMS,
    "src/components/Plain.tsx": `export const Plain = () => null;`,
  });
  assert.equal(checkNamed(root, "singleDelivery").pass, false);
});

test("singleDelivery ignores a gtag call in a file that does NOT reach the relay", () => {
  // Engagement-only telemetry (scroll depth, social clicks) legitimately stays
  // gtag-only. The invariant is about double-delivering ONE click, not about
  // banning gtag from the codebase.
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
    "src/components/ScrollDepth.tsx": `
      "use client";
      export function onScroll() { window.gtag?.("event", "scroll_depth", { pct: 50 }); }
    `,
  });
  assert.equal(checkNamed(root, "singleDelivery").pass, true);
});

// ─── SESSION-PARAMS ──────────────────────────────────────────────────

test("sessionParams FAILS when the relay omits session_id / engagement_time_msec (F-20260731-03)", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_NO_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  const check = checkNamed(root, "sessionParams");
  assert.equal(
    check.pass,
    false,
    "GA4 returns 204 for a sessionless event, so only a static check can catch this",
  );
});

test("sessionParams PASSES when the relay sends both params", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "sessionParams").pass, true);
});

test("sessionParams PASSES when the params live in a helper the route imports", () => {
  // The shared build-websites-tools/conversion-relay module supplies them, so a
  // consumer that adopts it must not be forced to inline the tokens.
  const root = makeSite({
    "src/app/api/track/route.ts": `
      import { buildPayload } from "./logic";
      export async function POST() {
        const apiSecret = process.env.GA4_API_SECRET;
        return new Response(JSON.stringify(buildPayload()));
      }
    `,
    "src/app/api/track/logic.ts": `
      export function buildPayload() {
        return { params: { session_id: "1", engagement_time_msec: 100 } };
      }
    `,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "sessionParams").pass, true);
});

test("singleDelivery does NOT fire on a gtag call that only appears in a comment", () => {
  // Found 2026-07-31 migrating participation-effect-site: the corrected
  // TrackedLink.tsx explains in a comment that it "used to also call
  // window.gtag('event', ...)", and the gate failed on its own remediation
  // note. Documenting the prohibited pattern must not itself be a violation -
  // the same rule gate-sitemap-source already applies via
  // stripCommentsAndStrings. A gate that punishes the explanation of a fix
  // teaches people to delete the explanation.
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": `
"use client";
export function trackEvent(name, params) {
  // This used to also call window.gtag("event", ...) here, which delivered the
  // same click twice. Conversions are now server-side only.
  void fetch("/api/track", { method: "POST", body: JSON.stringify({ name }), keepalive: true });
}
    `,
  });
  assert.equal(checkNamed(root, "singleDelivery").pass, true);
});

test("singleDelivery still fires on a real gtag call in a file that also has comments about it", () => {
  // The complement: blanking comments must not blank the actual code.
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": `
"use client";
export function trackEvent(name, params) {
  // We deliberately dual-fire here for now.
  window.gtag?.("event", name, params);
  void fetch("/api/track", { method: "POST", body: JSON.stringify({ name }), keepalive: true });
}
    `,
  });
  assert.equal(checkNamed(root, "singleDelivery").pass, false);
});

// ─── Adopting the shared relay ───────────────────────────────────────

/**
 * The migration target from the v0.10.0 README. The secret is read inside
 * build-websites-tools/conversion-relay, so the consumer's route never names
 * GA4_API_SECRET itself.
 */
const ROUTE_ADOPTS_SHARED_RELAY = `
import { createTrackHandler } from "build-websites-tools/conversion-relay";
import { ALLOWED_EVENTS } from "./logic";

export const dynamic = "force-dynamic";
export const POST = createTrackHandler({
  allowedEvents: [...ALLOWED_EVENTS],
  fallbackCookieName: "participation_cid",
});
`;

test("adopting the shared relay satisfies relaySecret without inlining GA4_API_SECRET", () => {
  // Regression: found 2026-07-31 running the v0.10.0 gate against the real
  // participation-effect-site after migrating it. Every fixture up to that
  // point inlined the secret, so the fixture suite was green while the
  // documented migration path failed on a real repo. The secret moved INTO the
  // shared module; a route that delegates to it is not "depending on client
  // gtag", which is the risk relaySecret exists to catch.
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_ADOPTS_SHARED_RELAY,
    "src/app/api/track/logic.ts": `export const ALLOWED_EVENTS = ["buy"] as const;`,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "relaySecret").pass, true);
  assert.equal(
    evaluateSource({ cwd: root }).pass,
    true,
    "the documented migration target must pass every invariant",
  );
});

test("relaySecret still FAILS a route that neither reads the secret nor adopts the shared relay", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": `export async function POST() { return new Response("{}"); }`,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "relaySecret").pass, false);
});

// ─── Aggregate ───────────────────────────────────────────────────────

test("evaluateSource FAILS overall on the exact shape shipped to 7 repos today", () => {
  // The whole point: this configuration currently PASSES prebuild on every
  // consumer pinned to v0.9.0, while double-counting every conversion and
  // attributing none of them to a session.
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_NO_SESSION_PARAMS,
    "src/components/TrackedLink.tsx": CLIENT_DUAL_FIRE,
  });
  assert.equal(evaluateSource({ cwd: root }).pass, false);
});

// ─── DELIVERY-SAFE PAYLOAD (v0.11.0) ─────────────────────────────────

/**
 * The shape that was live on all nine sites until 2026-08-01: a hand-rolled
 * relay attaching user_ip_address and forwarding the visitor's User-Agent.
 * GA4 answered 204 and silently discarded every event. See _audit-vault
 * F-20260801-01.
 */
const ROUTE_WITH_DISCARD_FIELDS = `
import { NextResponse } from "next/server";
export async function POST(request) {
  const apiSecret = process.env.GA4_API_SECRET;
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  const body = {
    client_id: "abc",
    user_ip_address: ip,
    events: [{ name: "buy", params: { session_id: "1", engagement_time_msec: 100 } }],
  };
  await fetch("https://www.google-analytics.com/mp/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": request.headers.get("user-agent") },
    body: JSON.stringify(body),
  });
  return NextResponse.json({ ok: true });
}
`;

const ROUTE_SHARED_RELAY_OPTED_INTO_IP = `
import { createTrackHandler } from "build-websites-tools/conversion-relay";
import { ALLOWED_EVENTS } from "./logic";
export const POST = createTrackHandler({
  allowedEvents: [...ALLOWED_EVENTS],
  forwardIpAddress: true,
});
`;

test("deliverySafePayload FAILS on a relay that sends user_ip_address (the F-20260801-01 defect)", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_DISCARD_FIELDS,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  const check = checkNamed(root, "deliverySafePayload");
  assert.equal(check.pass, false, "GA4 returns 204 and discards - only a static check can catch this");
  assert.match(check.detail, /user_ip_address/);
});

test("deliverySafePayload FAILS when the shared relay is opted into IP forwarding", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_SHARED_RELAY_OPTED_INTO_IP,
    "src/app/api/track/logic.ts": `export const ALLOWED_EVENTS = ["buy"] as const;`,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "deliverySafePayload").pass, false);
});

test("deliverySafePayload PASSES the corrected shared-relay adoption", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": ROUTE_ADOPTS_SHARED_RELAY,
    "src/app/api/track/logic.ts": `export const ALLOWED_EVENTS = ["buy"] as const;`,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "deliverySafePayload").pass, true);
});

test("deliverySafePayload ignores the fields when they appear only in a comment", () => {
  const root = makeSite({
    "src/app/api/track/route.ts": `
      // We deliberately do NOT send user_ip_address or forward User-Agent:
      // GA4 silently discards the event. See _audit-vault F-20260801-01.
      import { NextResponse } from "next/server";
      export async function POST() {
        const apiSecret = process.env.GA4_API_SECRET;
        const body = { client_id: "a", events: [{ name: "buy", params: { session_id: "1", engagement_time_msec: 1 } }] };
        await fetch("https://www.google-analytics.com/mp/collect", { method: "POST", body: JSON.stringify(body) });
        return NextResponse.json({ ok: true });
      }
    `,
    "src/components/TrackedLink.tsx": CLIENT_SINGLE_DELIVERY,
  });
  assert.equal(checkNamed(root, "deliverySafePayload").pass, true);
});
