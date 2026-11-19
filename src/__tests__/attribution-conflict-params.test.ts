/*
 * Regression: a bare `source` event param surfaced in siteclinic.io's GA4 as a
 * bogus "health_scan_results / (not set)" traffic source (audit 2026-11-03).
 * Locks (1) the build-time gate, (2) the relay's drop + disclosure behaviour.
 * The exact defective call from siteclinic-web HealthScanForm.tsx is replayed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAttributionConflictParams,
} from "../gate-conversion-instrumentation-source";
import { droppedParams, createTrackHandler } from "../conversion-relay.js";

const DEFECT = `
  trackEvent("visibility_pilot_click", {
    source: "health_scan_results",
    destination: "/pricing",
  });
`;
const FIXED = `
  trackEvent("visibility_pilot_click", {
    cta_source: "health_scan_results",
    destination: "/pricing",
  });
`;

test("gate FAILS on the exact siteclinic.io defect", () => {
  const r = evaluateAttributionConflictParams([{ rel: "src/components/HealthScanForm.tsx", body: DEFECT }]);
  assert.equal(r.pass, false);
  assert.match(r.detail, /HealthScanForm\.tsx \(source\)/);
});

test("gate PASSES the corrected call, prefixed names, and a comment-only mention", () => {
  assert.equal(evaluateAttributionConflictParams([{ rel: "a.tsx", body: FIXED }]).pass, true);
  assert.equal(evaluateAttributionConflictParams([{ rel: "b.tsx", body: `// trackEvent("x", { source: "y" })\n` }]).pass, true);
  assert.equal(evaluateAttributionConflictParams([{ rel: "c.tsx", body: `trackEvent("x", { resource: 1, sourceUrl: "u" })` }]).pass, true);
});

test("gate catches quoted keys and the track() spelling", () => {
  assert.equal(evaluateAttributionConflictParams([{ rel: "d.ts", body: `track("a", { "medium": "email" })` }]).pass, false);
});

test("droppedParams discloses exactly the dropped names", () => {
  assert.deepEqual(droppedParams({ source: "x", tier: "pro", campaign: "c" }).sort(), ["campaign", "source"]);
  assert.deepEqual(droppedParams({ tier: "pro" }), []);
  assert.deepEqual(droppedParams(null), []);
});

test("relay response discloses dropped params instead of dropping silently", async () => {
  const h = createTrackHandler({ allowedEvents: ["visibility_pilot_click"], fallbackCookieName: "t_cid" });
  const prevId = process.env.GA4_MEASUREMENT_ID, prevSecret = process.env.GA4_API_SECRET, realFetch = globalThis.fetch;
  process.env.GA4_MEASUREMENT_ID = "G-TEST123456";
  process.env.GA4_API_SECRET = "s";
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    const res = await h(new Request("http://x/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "visibility_pilot_click", params: { source: "a", destination: "/p" } }) }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-analytics-dropped-params"), "source");
    assert.deepEqual((await res.json()).droppedParams, ["source"]);
  } finally {
    globalThis.fetch = realFetch;
    if (prevId === undefined) delete process.env.GA4_MEASUREMENT_ID; else process.env.GA4_MEASUREMENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.GA4_API_SECRET; else process.env.GA4_API_SECRET = prevSecret;
  }
});

test("gate ignores another library's member call (analytics.track) but still flags bare track()", () => {
  assert.equal(evaluateAttributionConflictParams([{ rel: "d.tsx", body: `analytics.track("a", { source: "x" })` }]).pass, true);
  assert.equal(evaluateAttributionConflictParams([{ rel: "e.tsx", body: `track("a", { source: "x" })` }]).pass, false);
});
