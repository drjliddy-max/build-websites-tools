/*
 * Drift-prevention contract for gate:conversion-instrumentation-source.
 *
 * Locks the three plumbing invariants of the Conversion Instrumentation
 * Contract (MASTER_VISIBILITY_MATRIX §17.3.1.2, 2026-06-17), proven on
 * liddy-podiatry-site 2026-06-17:
 *
 *   1. RELAY-ROUTE: exactly one /api/track route handler.
 *   2. RELAY-SECRET: the route forwards via GA4_API_SECRET (server-side MP),
 *      not client gtag (which is consent-gated and drops most conversions).
 *   3. RELAY-INVOKED: some client file dual-fires to /api/track.
 *
 * Run via: npm test (in build-websites-tools).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectSourceFiles,
  evaluateRelayInvoked,
  evaluateRelayRoute,
  evaluateRelaySecret,
  evaluateSource,
  findRelayInvocations,
  findRelayRoutes,
} from "../gate-conversion-instrumentation-source";

/** Create a temp site root with the given { relativePath: contents } files. */
function makeSite(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conv-gate-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const ROUTE_WITH_SECRET = `
import { NextResponse } from "next/server";
export async function POST(request) {
  const apiSecret = process.env.GA4_API_SECRET;
  if (!apiSecret) return NextResponse.json({}, { status: 503 });
  return NextResponse.json({ ok: true });
}
`;

const ROUTE_WITHOUT_SECRET = `
import { NextResponse } from "next/server";
export async function POST() { return NextResponse.json({ ok: true }); }
`;

const DUAL_FIRE_COMPONENT = `
"use client";
export default function ActionTracking() {
  document.addEventListener("click", () => {
    fetch("/api/track", { method: "POST", keepalive: true, body: "{}" });
  });
  return null;
}
`;

test("relayRoute: passes with exactly one route, fails on zero, fails on conflict", () => {
  const ok = makeSite({ "src/app/api/track/route.ts": ROUTE_WITH_SECRET });
  assert.equal(evaluateRelayRoute(findRelayRoutes({ cwd: ok })).pass, true);

  const none = makeSite({ "src/app/page.tsx": "export default function P(){return null}" });
  assert.equal(evaluateRelayRoute(findRelayRoutes({ cwd: none })).pass, false);

  const conflict = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SECRET,
    "pages/api/track.ts": ROUTE_WITH_SECRET,
  });
  const conflictResult = evaluateRelayRoute(findRelayRoutes({ cwd: conflict }));
  assert.equal(conflictResult.pass, false);
  assert.ok(conflictResult.detail.includes("multiple"));
});

test("relaySecret: passes when route reads GA4_API_SECRET, fails otherwise", () => {
  const withSecret = makeSite({ "src/app/api/track/route.ts": ROUTE_WITH_SECRET });
  assert.equal(evaluateRelaySecret(findRelayRoutes({ cwd: withSecret })).pass, true);

  const withoutSecret = makeSite({ "src/app/api/track/route.ts": ROUTE_WITHOUT_SECRET });
  const r = evaluateRelaySecret(findRelayRoutes({ cwd: withoutSecret }));
  assert.equal(r.pass, false);
  assert.ok(r.detail.includes("GA4_API_SECRET"));
});

test("relayInvoked: finds a dual-fire and excludes the route file itself", () => {
  const site = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SECRET,
    "src/components/ActionTracking.tsx": DUAL_FIRE_COMPONENT,
  });
  const routes = findRelayRoutes({ cwd: site }).map((r) => r.file);
  const hits = findRelayInvocations({ cwd: site }, routes);
  assert.deepEqual(hits, ["src/components/ActionTracking.tsx"]);
  assert.equal(evaluateRelayInvoked(hits).pass, true);

  // Route alone (no client dual-fire) must fail: a relay nothing calls.
  const routeOnly = makeSite({ "src/app/api/track/route.ts": ROUTE_WITH_SECRET });
  const routeOnlyFiles = findRelayRoutes({ cwd: routeOnly }).map((r) => r.file);
  assert.equal(
    evaluateRelayInvoked(findRelayInvocations({ cwd: routeOnly }, routeOnlyFiles)).pass,
    false,
  );
});

test("relayInvoked: a helper INSIDE the relay dir that only mentions /api/track in a comment does NOT count", () => {
  // logic.ts ships with every copy of this pattern and references /api/track
  // in its header comment. If it counted, relayInvoked would pass on a comment
  // alone, with no real dual-fire. The gate must require an external caller.
  const site = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SECRET,
    "src/app/api/track/logic.ts": "// Pure helpers for /api/track\nexport const x = 1;",
  });
  const routes = findRelayRoutes({ cwd: site }).map((r) => r.file);
  const hits = findRelayInvocations({ cwd: site }, routes);
  assert.deepEqual(hits, [], "relay-dir helpers must be excluded");
  assert.equal(evaluateRelayInvoked(hits).pass, false);
});

test("collectSourceFiles skips node_modules / .next / dist", () => {
  const site = makeSite({
    "src/components/A.tsx": "export const a = 1;",
    "node_modules/pkg/index.js": "module.exports = 1;",
    ".next/server/x.js": "x",
    "dist/y.js": "y",
  });
  const files = collectSourceFiles({ cwd: site }).map((f) => path.basename(f));
  assert.ok(files.includes("A.tsx"));
  assert.ok(!files.includes("index.js"));
  assert.ok(!files.includes("y.js"));
});

test("evaluateSource: full Liddy-shaped fixture passes all three invariants", () => {
  const site = makeSite({
    "src/app/api/track/route.ts": ROUTE_WITH_SECRET,
    "src/components/ActionTracking.tsx": DUAL_FIRE_COMPONENT,
    "src/app/page.tsx": "export default function P(){return null}",
  });
  const result = evaluateSource({ cwd: site });
  assert.equal(result.pass, true, JSON.stringify(result.checks, null, 2));
  assert.deepEqual(
    result.checks.map((c) => c.name),
    ["relayRoute", "relaySecret", "relayInvoked"],
  );
});

test("evaluateSource: a site with no relay fails (the pre-fix Liddy state)", () => {
  const site = makeSite({
    "src/app/page.tsx": "export default function P(){return null}",
    "src/components/ActionTracking.tsx":
      'export default function T(){ window.gtag?.("event","call_click"); return null; }',
  });
  const result = evaluateSource({ cwd: site });
  assert.equal(result.pass, false);
  assert.equal(result.checks.find((c) => c.name === "relayRoute")?.pass, false);
});
