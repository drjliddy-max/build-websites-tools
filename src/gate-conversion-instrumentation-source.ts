/*
 * gate:conversion-instrumentation-source: STATIC source-level gate that a
 * site ships a consent-independent conversion-event relay.
 *
 * Companion to the AI Instrumentation Contract gates. Where
 * gate:ai-instrumentation proves a site is FOUND (robots/llms/JSON-LD/GA4),
 * this gate proves a found visitor's ACTION can be measured. It enforces the
 * Conversion Instrumentation Contract added to MASTER_VISIBILITY_MATRIX
 * §17.3.1.2 on 2026-06-17.
 *
 * Why it exists
 * =============
 * Conversion clicks (call, appointment/booking, lead-form submit, checkout)
 * fired only through client-side window.gtag are silently dropped for every
 * visitor who has not accepted the cookie banner. On low-traffic sites that is
 * nearly all of them, so the customer dashboard showed zero conversions while
 * the wiring looked present. Found on liddy-podiatry-site 2026-06-17:
 * the board's conversionEvents was [] despite call_click / appointment_request
 * being wired, because they reached only gtag. The fix (proven on Liddy, live
 * in production) is a server-side GA4 Measurement Protocol relay at /api/track
 * that captures conversion clicks regardless of cookie state, with the client
 * dual-firing to it. This is the same consent-bypass pattern first shipped on
 * adaauditreport-web 2026-06-07.
 *
 * CORRECTED 2026-07-31 (v0.10.0). The original third invariant required the
 * client to "dual-fire" - to call gtag AND post to the relay. That enforced an
 * implementation SHAPE instead of an OUTCOME, and the shape was wrong: for a
 * consenting visitor the same click was delivered twice, under two different
 * client_ids (the _ga cookie vs the relay's own), so GA4 counted one click as
 * two events and two users. Worse, a site that fixed it would have FAILED this
 * gate. A fourth invariant is added because the relay could satisfy every old
 * check while sending events GA4 accepted (204) but attached to no session.
 * Audit trail: _audit-vault F-20260731-02, -03, -05.
 *
 * Four invariants this gate enforces at COMMIT TIME (no server required):
 *
 *   1. RELAY-ROUTE: exactly one /api/track route handler is present
 *      (src/app/api/track/route.ts or framework equivalent). Zero means no
 *      consent-independent relay. More than one means a Next.js routing
 *      conflict.
 *
 *   2. RELAY-SECRET: the relay route references GA4_API_SECRET, i.e. it
 *      forwards server-side via the GA4 Measurement Protocol with a server-
 *      only secret rather than depending on client gtag. A route that does
 *      not read the secret is not a consent-independent relay.
 *
 *   3. SINGLE-DELIVERY: some client/source file POSTs to /api/track (a relay
 *      nothing calls measures nothing) AND no such caller also fires a client
 *      gtag event. One click, one delivery, in every consent state. gtag stays
 *      legitimate for engagement-only telemetry that never reaches the relay.
 *
 *   4. SESSION-PARAMS: the relay sends session_id and engagement_time_msec.
 *      GA4 answers 204 with or without them, so only a static check catches
 *      this; without them conversions attach to no session and can never be
 *      attributed to a landing page, source, or campaign. Satisfied either by
 *      adopting build-websites-tools/conversion-relay or by carrying both
 *      params in the site's own relay implementation.
 *
 * Deliberately NOT enforced here: WHICH conversion events a site emits. Event
 * names are site-specific (call_click for a clinic, checkout_started for SaaS)
 * and the correct per-site set is enforced downstream by Site Monitor's
 * dogfood contract (DOGFOOD_COHORT_SITES) and the conversionEvents dashboard
 * reader. This gate verifies the plumbing; Site Monitor verifies the events.
 *
 * Framework-agnostic across Next.js App/Pages and apps/web monorepos.
 * Operator may declare exceptions via `conversionInstrumentation.source` in
 * gate.config.json (a `skip` reason for sites with no conversion funnel, or
 * per-check toggles), mirroring the aiInstrumentation block.
 */
import fs from "node:fs";
import path from "node:path";

export type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
};

export interface SourceScanResult {
  pass: boolean;
  checks: CheckResult[];
}

interface SiteRoot {
  /** Absolute path to the consumer site repo root (process.cwd()). */
  cwd: string;
}

const RELAY_PATH = "/api/track";

// A file counts as a real dual-fire only if it references the relay path AND
// contains an HTTP-call token. Without the call-token requirement, a bare
// mention of "/api/track" in a COMMENT (e.g. a Button component documenting
// the relay) would falsely satisfy relayInvoked even though nothing calls the
// relay. Found 2026-06-17 wiring bmj-marketing. Covers fetch/sendBeacon/XHR/
// axios and generic `.post(` clients.
const RELAY_CALL_TOKEN =
  /\bfetch\s*\(|\bsendBeacon\b|\bXMLHttpRequest\b|\baxios\b|\.post\s*\(/;

// A client-side GA4 event send: gtag("event", ...), window.gtag?.("event", ...),
// gtag('event', ...). Only an "event" command counts - gtag("config"|"consent"|
// "js", ...) are setup calls and do not deliver a conversion, so banning them
// would block correct consent handling.
const GTAG_EVENT_TOKEN = /\bgtag\s*\??\.?\s*\(\s*["']event["']/;

// The two params GA4 needs to attach a Measurement Protocol event to a session.
const SESSION_PARAM_TOKENS = ["session_id", "engagement_time_msec"] as const;

// Adopting the shared relay satisfies SESSION-PARAMS without inlining the
// tokens, since the module supplies both.
const SHARED_RELAY_IMPORT = "build-websites-tools/conversion-relay";

// ─── Relay route detection ───────────────────────────────────────────

export interface RelayRouteSource {
  /** Path relative to the site root. */
  file: string;
  /** Raw file contents, used to verify the secret invariant. */
  body: string;
}

const RELAY_ROUTE_CANDIDATES = [
  "src/app/api/track/route.ts",
  "src/app/api/track/route.tsx",
  "app/api/track/route.ts",
  "app/api/track/route.tsx",
  "apps/web/app/api/track/route.ts",
  "apps/web/src/app/api/track/route.ts",
  "pages/api/track.ts",
  "pages/api/track.tsx",
  "src/pages/api/track.ts",
];

/** Scan for every /api/track route-serving mechanism. Exported for tests. */
export function findRelayRoutes({ cwd }: SiteRoot): RelayRouteSource[] {
  const found: RelayRouteSource[] = [];
  for (const file of RELAY_ROUTE_CANDIDATES) {
    const abs = path.join(cwd, file);
    if (fs.existsSync(abs)) {
      found.push({ file, body: fs.readFileSync(abs, "utf8") });
    }
  }
  return found;
}

/** Evaluate the relay-route presence invariant. Exported for tests. */
export function evaluateRelayRoute(sources: RelayRouteSource[]): CheckResult {
  if (sources.length === 0) {
    return {
      name: "relayRoute",
      pass: false,
      detail: `no ${RELAY_PATH} route found; expected one of: ${RELAY_ROUTE_CANDIDATES.slice(0, 3).join(", ")} or framework equivalent. A consent-independent server-side relay is required by matrix §17.3.1.2.`,
    };
  }
  if (sources.length > 1) {
    return {
      name: "relayRoute",
      pass: false,
      detail: `multiple ${RELAY_PATH} route mechanisms; pick ONE and delete the others. Found: ${sources.map((s) => s.file).join(", ")}`,
    };
  }
  return {
    name: "relayRoute",
    pass: true,
    detail: `${sources[0].file}: ${RELAY_PATH} relay present`,
  };
}

/** Evaluate the server-secret invariant. Exported for tests. */
export function evaluateRelaySecret(sources: RelayRouteSource[]): CheckResult {
  if (sources.length !== 1) {
    return {
      name: "relaySecret",
      pass: false,
      detail: "skipped: relay route not uniquely resolved (see relayRoute)",
    };
  }
  const src = sources[0];
  if (!/GA4_API_SECRET/.test(src.body)) {
    return {
      name: "relaySecret",
      pass: false,
      detail: `${src.file} does not reference GA4_API_SECRET; a consent-independent relay must forward server-side via the GA4 Measurement Protocol with a server-only secret, not depend on client gtag.`,
    };
  }
  return {
    name: "relaySecret",
    pass: true,
    detail: `${src.file}: forwards via GA4 Measurement Protocol (GA4_API_SECRET referenced)`,
  };
}

// ─── Dual-fire (relay invocation) detection ──────────────────────────

// Walk the whole consumer tree from cwd (skipping SCAN_SKIP_DIRS + dot-dirs +
// node_modules) rather than a fixed root list. A fixed ["src","app",...] list
// missed top-level lib/ and components/ dirs in app-router projects without a
// src/ dir. Found 2026-06-17 wiring daily-rise, whose dual-fire lives in
// apps/web/lib/client/bookAnalytics.ts and was invisible to the old scan.
const SCAN_ROOTS = ["."];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "__tests__",
  "coverage",
]);
// Cap the walk so a pathological tree cannot hang the gate.
const MAX_SCAN_FILES = 5000;

/** Recursively collect source files under the scan roots. Exported for tests. */
export function collectSourceFiles({ cwd }: SiteRoot): string[] {
  const out: string[] = [];
  const walk = (absDir: string): void => {
    if (out.length >= MAX_SCAN_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_SCAN_FILES) return;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        walk(abs);
      } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(abs);
      }
    }
  };
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(cwd, root);
    if (fs.existsSync(absRoot)) walk(absRoot);
  }
  return out;
}

/**
 * Find source files (other than the relay route itself) that reference the
 * relay path, i.e. the client dual-fire. Returns site-relative paths.
 * Exported for tests.
 */
export function findRelayInvocations(
  { cwd }: SiteRoot,
  routeFiles: string[],
): string[] {
  const routeAbs = new Set(routeFiles.map((f) => path.join(cwd, f)));
  const hits: string[] = [];
  for (const abs of collectSourceFiles({ cwd })) {
    if (routeAbs.has(abs)) continue;
    const rel = path.relative(cwd, abs);
    // Exclude the relay's own implementation directory (route.ts, logic.ts,
    // events.ts, ...). Those reference /api/track in comments and strings but
    // are not callers; counting them would let relayInvoked pass on a comment
    // alone, since logic.ts ships with every copy of this pattern. A genuine
    // dual-fire lives in client code OUTSIDE the relay dir.
    if (rel.split(path.sep).join("/").includes("api/track")) continue;
    let body: string;
    try {
      body = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // Require both the relay path AND an HTTP-call token so a comment-only
    // mention does not falsely count as a dual-fire (see RELAY_CALL_TOKEN).
    if (body.includes(RELAY_PATH) && RELAY_CALL_TOKEN.test(body)) {
      hits.push(rel);
    }
  }
  return hits;
}

/** Evaluate the dual-fire invariant. Exported for tests. */
export function evaluateRelayInvoked(invocations: string[]): CheckResult {
  if (invocations.length === 0) {
    return {
      name: "relayInvoked",
      pass: false,
      detail: `no client/source file POSTs to ${RELAY_PATH}; the relay exists but nothing dual-fires to it, so no conversion is captured. Wire the conversion click handler to fetch("${RELAY_PATH}", ...).`,
    };
  }
  return {
    name: "relayInvoked",
    pass: true,
    detail: `${RELAY_PATH} invoked from: ${invocations.slice(0, 3).join(", ")}${invocations.length > 3 ? `, +${invocations.length - 3} more` : ""}`,
  };
}

// ─── Single delivery (no double-count) ───────────────────────────────

/**
 * Of the files that call the relay, return those that ALSO fire a client gtag
 * event. Each one delivers a single click twice - once through gtag under the
 * _ga identity and once through the relay under its own - which is the
 * F-20260731-02 double-count. Returns site-relative paths. Exported for tests.
 */
export function findGtagDualFireFiles(
  { cwd }: SiteRoot,
  invocations: string[],
): string[] {
  const hits: string[] = [];
  for (const rel of invocations) {
    let body: string;
    try {
      body = fs.readFileSync(path.join(cwd, rel), "utf8");
    } catch {
      continue;
    }
    if (GTAG_EVENT_TOKEN.test(body)) hits.push(rel);
  }
  return hits;
}

/**
 * Evaluate the single-delivery invariant: the relay must be invoked, and no
 * invoker may also gtag-fire the same click. Exported for tests.
 */
export function evaluateSingleDelivery(
  invocations: string[],
  dualFireFiles: string[],
): CheckResult {
  if (invocations.length === 0) {
    return {
      name: "singleDelivery",
      pass: false,
      detail: `no client/source file POSTs to ${RELAY_PATH}; the relay exists but nothing calls it, so no conversion is captured. Wire the conversion click handler to fetch("${RELAY_PATH}", ...).`,
    };
  }
  if (dualFireFiles.length > 0) {
    return {
      name: "singleDelivery",
      pass: false,
      detail: `${dualFireFiles.join(", ")} fires a client gtag("event", ...) AND posts to ${RELAY_PATH}. For a consenting visitor that delivers one click twice, under two different client_ids, inflating both events and users. Deliver conversions server-side only: drop the gtag event call and let ${RELAY_PATH} report it (it resolves the visitor's _ga identity when present). gtag remains correct for engagement-only telemetry that never reaches the relay.`,
    };
  }
  return {
    name: "singleDelivery",
    pass: true,
    detail: `${RELAY_PATH} invoked from ${invocations.slice(0, 3).join(", ")}${invocations.length > 3 ? `, +${invocations.length - 3} more` : ""}; no caller double-fires via gtag`,
  };
}

// ─── Session params (attributable events) ────────────────────────────

/**
 * Collect the relay's implementation sources: the route itself plus any file
 * in its directory (logic.ts, events.ts, ...), since the payload builder is
 * conventionally split out of the route. Exported for tests.
 */
export function collectRelayImplementation(
  { cwd }: SiteRoot,
  routeFiles: string[],
): string[] {
  const bodies: string[] = [];
  for (const rel of routeFiles) {
    const dir = path.dirname(path.join(cwd, rel));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
      try {
        bodies.push(fs.readFileSync(path.join(dir, entry.name), "utf8"));
      } catch {
        /* unreadable file cannot satisfy the invariant; skip */
      }
    }
  }
  return bodies;
}

/** Evaluate the session-params invariant. Exported for tests. */
export function evaluateSessionParams(bodies: string[]): CheckResult {
  const joined = bodies.join("\n");
  if (joined.includes(SHARED_RELAY_IMPORT)) {
    return {
      name: "sessionParams",
      pass: true,
      detail: `adopts ${SHARED_RELAY_IMPORT}, which supplies session_id and engagement_time_msec`,
    };
  }
  const missing = SESSION_PARAM_TOKENS.filter((t) => !joined.includes(t));
  if (missing.length > 0) {
    return {
      name: "sessionParams",
      pass: false,
      detail: `the ${RELAY_PATH} implementation never references ${missing.join(" or ")}. GA4 returns 204 for a Measurement Protocol event that omits these, but attaches it to no session, so the conversion can never be attributed to a landing page, source, or campaign. Send them as EVENT params (not top level), or adopt ${SHARED_RELAY_IMPORT}.`,
    };
  }
  return {
    name: "sessionParams",
    pass: true,
    detail: `relay payload carries ${SESSION_PARAM_TOKENS.join(" + ")}`,
  };
}

// ─── Aggregate ───────────────────────────────────────────────────────

export function evaluateSource({ cwd }: SiteRoot): SourceScanResult {
  const routes = findRelayRoutes({ cwd });
  const routeFiles = routes.map((r) => r.file);
  const invocations = findRelayInvocations({ cwd }, routeFiles);
  const checks: CheckResult[] = [
    evaluateRelayRoute(routes),
    evaluateRelaySecret(routes),
    evaluateSingleDelivery(invocations, findGtagDualFireFiles({ cwd }, invocations)),
    evaluateSessionParams(collectRelayImplementation({ cwd }, routeFiles)),
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

// ─── Config + CLI ────────────────────────────────────────────────────

interface SourceGateConfig {
  skip?: { reason: string };
  checks?: {
    relayRoute?: boolean;
    relaySecret?: boolean;
    singleDelivery?: boolean;
    sessionParams?: boolean;
    /** @deprecated v0.9.0 name for singleDelivery; still honoured so an
     *  existing gate.config.json opt-out does not silently start failing. */
    relayInvoked?: boolean;
  };
}

function loadSourceConfig(): SourceGateConfig {
  const configPath = path.join(process.cwd(), "gate.config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const conv = parsed.conversionInstrumentation as
      | Record<string, unknown>
      | undefined;
    if (!conv) return {};
    const src = conv.source as Record<string, unknown> | undefined;
    if (!src || typeof src !== "object" || Array.isArray(src)) return {};
    return src as SourceGateConfig;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const config = loadSourceConfig();

  if (config.skip) {
    console.log(
      `gate:conversion-instrumentation-source  SKIPPED: ${config.skip.reason}`,
    );
    return;
  }

  console.log(`gate:conversion-instrumentation-source  cwd=${cwd}`);
  const { checks } = evaluateSource({ cwd });

  const skipChecks = config.checks ?? {};
  const filtered = checks.filter((c) => {
    let flag = skipChecks[c.name as keyof typeof skipChecks];
    // Honour the pre-v0.10.0 name so a consumer that had opted out of the old
    // relayInvoked check does not start failing on the renamed successor.
    if (flag === undefined && c.name === "singleDelivery") {
      flag = skipChecks.relayInvoked;
    }
    return flag !== false;
  });

  for (const check of filtered) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }

  const failed = filtered.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(
      `\ngate:conversion-instrumentation-source  FAIL: ${failed.length}/${filtered.length} invariant(s) violated`,
    );
    console.error("Spec: MASTER_VISIBILITY_MATRIX §17.3.1.2 (Conversion Instrumentation Contract)");
    process.exitCode = 1;
    return;
  }
  console.log(
    `\ngate:conversion-instrumentation-source  PASS: ${filtered.length}/${filtered.length} source invariant(s) verified`,
  );
}

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isCli) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
