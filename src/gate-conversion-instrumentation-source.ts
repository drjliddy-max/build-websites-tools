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
 * Three invariants this gate enforces at COMMIT TIME (no server required):
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
 *   3. RELAY-INVOKED: some client/source file other than the route POSTs to
 *      /api/track (the dual-fire). A relay nothing calls measures nothing.
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

const SCAN_ROOTS = ["src", "app", "apps/web/src", "apps/web/app"];
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

// ─── Aggregate ───────────────────────────────────────────────────────

export function evaluateSource({ cwd }: SiteRoot): SourceScanResult {
  const routes = findRelayRoutes({ cwd });
  const routeFiles = routes.map((r) => r.file);
  const checks: CheckResult[] = [
    evaluateRelayRoute(routes),
    evaluateRelaySecret(routes),
    evaluateRelayInvoked(findRelayInvocations({ cwd }, routeFiles)),
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

// ─── Config + CLI ────────────────────────────────────────────────────

interface SourceGateConfig {
  skip?: { reason: string };
  checks?: {
    relayRoute?: boolean;
    relaySecret?: boolean;
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
    const flag = skipChecks[c.name as keyof typeof skipChecks];
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
