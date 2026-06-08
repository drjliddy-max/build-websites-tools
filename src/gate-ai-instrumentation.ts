/*
 * gate:ai-instrumentation: AI visibility readiness gate.
 *
 * Specified by MASTER_VISIBILITY_MATRIX §17.3.1.2 (AI Instrumentation
 * Contract). Verifies a deployed site exposes the 4 build-time-checkable
 * dimensions of the contract:
 *
 *   1. GA4 G-tag: Google Analytics 4 measurement ID + gtag bootstrap
 *      in homepage HTML.
 *   2. /llms.txt: declarative AI agent index, Markdown shape, 200 OK.
 *   3. /robots.txt with declared AI policy comment block (the canonical
 *      signal site-monitor's detectRobotsAiPolicy scans for; bare
 *      allow-all robots.txt fails the gate).
 *   4. JSON-LD on homepage including at minimum Organization or WebSite
 *      type, parse-clean (catches HTML-entity-encoded `+` defects the
 *      §3.1.3 layer 7 scanner-correctness rule was added to prevent).
 *
 * Crawler logging (Surface 2) is verified at RUNTIME against the
 * deployed /api/ai-log endpoint, NOT at build time. There's no static
 * artifact that proves the route handler is wired correctly. Runtime
 * verification lives in site-monitor's health checks.
 *
 * Reads `gate.config.json` from the consuming site's cwd. Same pattern
 * as gate-seo + gate-ada. Site-agnostic: zero site-specific assumptions
 * in this file.
 *
 * Site-zero exception support: an owned site may declare
 * `aiInstrumentation.skip` with a documented reason (static-stack
 * limitation, etc.). The gate logs the skip + reason but does NOT fail.
 * Skipped sites still appear in the per-site §19.4 scorecard with the
 * dimension marked "accepted exception".
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { ensureBaseUrlReady } from "./ensure-base-url";

export type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
};

const GA4_GTAG_PATTERN = /gtag\(\s*['"]config['"]\s*,\s*['"]G-[A-Z0-9]{6,}['"]/;
const GA4_LOADER_PATTERN =
  /googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]{6,}/;
// Matches the canonical declared-policy comment block opener in both
// shipped forms across the owned-property portfolio:
//   - "# AI policy for <site>: declared <date>"  (5 sites: jeffrystein,
//     adaauditreport, babymilestonejournal, daily-rise, liddy-podiatry)
//   - "# AI policy: declared <date>"             (siteclinic.io)
//   - "# AI policy for theparticipationeffect.com: declared <date>"
// Anchored to start-of-line so a literal "AI policy" mention in a sitemap
// URL or comment doesn't false-positive.
const ROBOTS_AI_POLICY_PATTERN = /^#\s*AI policy(?:\s|$)/im;
const REQUIRED_JSONLD_TYPES = ["Organization", "WebSite"] as const;

/**
 * Detect GA4 measurement ID presence in homepage HTML.
 *
 * Accepts either explicit `gtag('config', 'G-XXXXXXXX')` call (consent-
 * gated wrappers like GoogleAnalytics.tsx land here once consent fires)
 * OR a `gtag/js?id=G-XXXXXXXX` loader script reference (pre-consent
 * static include).
 *
 * Exported for unit tests.
 */
export function detectGA4(html: string): CheckResult {
  if (GA4_GTAG_PATTERN.test(html)) {
    return { name: "ga4", pass: true, detail: "gtag('config', 'G-…') present" };
  }
  if (GA4_LOADER_PATTERN.test(html)) {
    return {
      name: "ga4",
      pass: true,
      detail: "googletagmanager.com/gtag/js?id=G-… present",
    };
  }
  return {
    name: "ga4",
    pass: false,
    detail:
      "no GA4 measurement ID found; expected gtag('config', 'G-…') or gtag/js?id=G-…",
  };
}

/**
 * Detect whether llms.txt body is shaped like Markdown.
 * Spec per §17.3.1.2 #llms.txt contract: Markdown, with at minimum the
 * site name as a heading. We accept any line starting with `#`.
 *
 * Exported for unit tests.
 */
export function isMarkdownShaped(body: string): boolean {
  return body.split("\n").some((line) => /^#\s+\S/.test(line.trim()));
}

/**
 * Detect declared AI policy comment block in robots.txt body.
 * Spec per §17.3.1.2 #robots.txt AI policy: a comment block declaring
 * the AI policy decision date and per-bot stance. Pattern matches
 * `# AI policy for <domain>` as the canonical signal. Same shape
 * shipped by siteclinic-web, jeffrystein-web, adaauditreport-web,
 * babymilestonejournal-web, daily-rise, liddy-podiatry-site,
 * participation-effect-site as of 2026-06-04.
 *
 * Exported for unit tests.
 */
export function hasRobotsAiPolicy(body: string): boolean {
  return ROBOTS_AI_POLICY_PATTERN.test(body);
}

/**
 * Extract JSON-LD @type values from homepage HTML. Mirrors the
 * site-monitor scanner-correctness rule §3.1.3 layer 7: the +/&#x2B;
 * HTML-entity edge case must round-trip through entity decoding before
 * JSON parsing. JSDOM handles entity decoding on textContent, so we
 * lean on it rather than re-implementing.
 *
 * Exported for unit tests.
 */
export function extractJsonLdTypes(html: string): string[] {
  const dom = new JSDOM(html);
  const scripts = dom.window.document.querySelectorAll(
    'script[type="application/ld+json"]',
  );
  const types = new Set<string>();
  for (const script of scripts) {
    const text = script.textContent?.trim() ?? "";
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      collectTypes(parsed, types);
    } catch {
      // Malformed JSON-LD: caller sees missing types + reports defect.
    }
  }
  return [...types];
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out);
    return;
  }
  if (typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  const t = rec["@type"];
  if (typeof t === "string") out.add(t);
  else if (Array.isArray(t)) {
    for (const v of t) if (typeof v === "string") out.add(v);
  }
  if (Array.isArray(rec["@graph"])) {
    for (const g of rec["@graph"] as unknown[]) collectTypes(g, out);
  }
}

/**
 * Evaluate JSON-LD presence + required-type coverage.
 * Exported for unit tests.
 */
export function evaluateJsonLd(html: string): CheckResult {
  const types = extractJsonLdTypes(html);
  if (types.length === 0) {
    return {
      name: "jsonLd",
      pass: false,
      detail:
        "no parse-clean JSON-LD on homepage; expected at minimum Organization or WebSite",
    };
  }
  const hasRequired = REQUIRED_JSONLD_TYPES.some((t) => types.includes(t));
  if (!hasRequired) {
    return {
      name: "jsonLd",
      pass: false,
      detail: `JSON-LD types found [${types.join(", ")}] but neither Organization nor WebSite; at least one is required by §17.3.1.2`,
    };
  }
  return {
    name: "jsonLd",
    pass: true,
    detail: `JSON-LD types [${types.join(", ")}]`,
  };
}

async function fetchText(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: string }> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { redirect: "follow" });
  const body = await res.text();
  return { status: res.status, body };
}

async function evaluateLlmsTxt(baseUrl: string): Promise<CheckResult> {
  let result: { status: number; body: string };
  try {
    result = await fetchText(baseUrl, "/llms.txt");
  } catch (err) {
    return {
      name: "llmsTxt",
      pass: false,
      detail: `network error fetching /llms.txt: ${(err as Error).message}`,
    };
  }
  if (result.status !== 200) {
    return {
      name: "llmsTxt",
      pass: false,
      detail: `/llms.txt returned HTTP ${result.status}; expected 200`,
    };
  }
  if (!isMarkdownShaped(result.body)) {
    return {
      name: "llmsTxt",
      pass: false,
      detail: "/llms.txt returned 200 but body has no Markdown heading (no line starting with '# ')",
    };
  }
  return { name: "llmsTxt", pass: true, detail: "/llms.txt 200 + Markdown shape" };
}

async function evaluateRobotsAiPolicy(baseUrl: string): Promise<CheckResult> {
  let result: { status: number; body: string };
  try {
    result = await fetchText(baseUrl, "/robots.txt");
  } catch (err) {
    return {
      name: "robotsAiPolicy",
      pass: false,
      detail: `network error fetching /robots.txt: ${(err as Error).message}`,
    };
  }
  if (result.status !== 200) {
    return {
      name: "robotsAiPolicy",
      pass: false,
      detail: `/robots.txt returned HTTP ${result.status}; expected 200`,
    };
  }
  if (!hasRobotsAiPolicy(result.body)) {
    return {
      name: "robotsAiPolicy",
      pass: false,
      detail:
        "/robots.txt missing declared AI policy comment block; expected '# AI policy for …' header per §17.3.1.2",
    };
  }
  return {
    name: "robotsAiPolicy",
    pass: true,
    detail: "declared AI policy comment block present",
  };
}

async function evaluateHomepage(
  baseUrl: string,
): Promise<{ ga4: CheckResult; jsonLd: CheckResult }> {
  let html: string;
  try {
    const res = await fetch(baseUrl, { redirect: "follow" });
    if (res.status !== 200) {
      const detail = `homepage returned HTTP ${res.status}; expected 200`;
      return {
        ga4: { name: "ga4", pass: false, detail },
        jsonLd: { name: "jsonLd", pass: false, detail },
      };
    }
    html = await res.text();
  } catch (err) {
    const detail = `network error fetching homepage: ${(err as Error).message}`;
    return {
      ga4: { name: "ga4", pass: false, detail },
      jsonLd: { name: "jsonLd", pass: false, detail },
    };
  }
  return {
    ga4: detectGA4(html),
    jsonLd: evaluateJsonLd(html),
  };
}

/**
 * The full gate evaluation, exported as a pure function so unit tests can
 * exercise it without spawning the CLI. The CLI thin-wraps this with
 * console output + exit code.
 *
 * Returns aggregate pass/fail + per-dimension results so callers can
 * structure their own reporting (e.g., site-monitor's customer dashboard
 * §17.3.1.2 5-field block).
 */
export async function evaluateAiInstrumentation(
  baseUrl: string,
): Promise<{
  pass: boolean;
  checks: CheckResult[];
}> {
  const homepage = await evaluateHomepage(baseUrl);
  const llmsTxt = await evaluateLlmsTxt(baseUrl);
  const robotsAiPolicy = await evaluateRobotsAiPolicy(baseUrl);

  const checks: CheckResult[] = [
    homepage.ga4,
    llmsTxt,
    robotsAiPolicy,
    homepage.jsonLd,
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

interface AiInstrumentationConfig {
  skip?: { reason: string };
  checks?: {
    ga4?: boolean;
    llmsTxt?: boolean;
    robotsAiPolicy?: boolean;
    jsonLd?: boolean;
  };
  /**
   * Declared exception for consent-gated GA4 deployments where the
   * gtag script is only injected after a user consent action, so the
   * SSR homepage HTML has no detectable GA4 marker. The operator
   * declares the deployment as consent-gated; the gate logs the
   * declared exception + does not fail the GA4 check.
   *
   * Required field: `measurementId`. The G-XXXXXXX ID the consent
   * gate injects. Surfaces in the §19 scorecard so the dashboard
   * shows "GA4 consent-gated (measurementId)" rather than "missing".
   */
  ga4?: {
    consentGated?: { measurementId: string };
  };
}

function loadAiInstrumentationConfig(): AiInstrumentationConfig {
  // load-config.ts strict-validates the known fields and strips the
  // rest; re-read gate.config.json directly so our extension field
  // survives.
  try {
    const raw = fs.readFileSync(
      path.join(process.cwd(), "gate.config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ai = parsed.aiInstrumentation;
    if (typeof ai === "object" && ai !== null && !Array.isArray(ai)) {
      return ai as AiInstrumentationConfig;
    }
  } catch {
    // Fall through to empty config.
  }
  return {};
}

/**
 * Minimal config reader specific to this gate: we only need baseUrl
 * (for the HTTP probe) + the aiInstrumentation extension block. We
 * deliberately do NOT use loadGateConfig() because its broader
 * marketing-site validation (required routes, contact page, etc.)
 * belongs to gate-seo, not the AI Instrumentation Contract.
 *
 * §17.3.1.2 is orthogonal to whether the site has a /contact page;
 * coupling them would block the AI gate on unrelated drift.
 */
function loadMinimalConfig(): {
  baseUrl: string;
  launchCommand?: string;
  startupTimeoutMs?: number;
  aiInstrumentation: AiInstrumentationConfig;
} {
  const configPath = path.join(process.cwd(), "gate.config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`✗ gate.config.json not found at ${configPath}`);
    process.exit(1);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error(`✗ ${configPath} is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  const envOverride = process.env.GATE_BASE_URL;
  const configBaseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl : "";
  const baseUrl = envOverride || configBaseUrl;
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
    console.error(
      `✗ baseUrl required for AI instrumentation probe; set GATE_BASE_URL env var or gate.config.json baseUrl`,
    );
    process.exit(1);
  }
  const ai = parsed.aiInstrumentation;
  const aiInstrumentation =
    typeof ai === "object" && ai !== null && !Array.isArray(ai)
      ? (ai as AiInstrumentationConfig)
      : {};
  return {
    baseUrl,
    launchCommand: typeof parsed.launchCommand === "string" ? parsed.launchCommand : undefined,
    startupTimeoutMs:
      typeof parsed.startupTimeoutMs === "number" ? parsed.startupTimeoutMs : undefined,
    aiInstrumentation,
  };
}

async function main(): Promise<void> {
  const {
    baseUrl,
    launchCommand,
    startupTimeoutMs,
    aiInstrumentation: aiConfig,
  } = loadMinimalConfig();

  if (aiConfig.skip) {
    console.log(
      `gate:ai-instrumentation  SKIPPED: ${aiConfig.skip.reason}`,
    );
    console.log(
      "(declared exception per §17.3.1.2; still surfaces in §19 scorecard as accepted exception)",
    );
    return;
  }

  let cleanup: (() => Promise<void>) | undefined;
  try {
    cleanup = await ensureBaseUrlReady({
      routes: [],
      baseUrl,
      launchCommand,
      startupTimeoutMs,
    });
    console.log(`gate:ai-instrumentation  baseUrl=${baseUrl}`);
    const result = await evaluateAiInstrumentation(baseUrl);

    const skipChecks = aiConfig.checks ?? {};
    // Apply declared consent-gated GA4 exception: if the operator
    // declares it, replace the failed ga4 check with a passing one
    // labeled "consent-gated". This surfaces honestly in the §19
    // scorecard rather than the gate failing on a deployment that
    // is intentionally consent-gated.
    const consentGated = aiConfig.ga4?.consentGated;
    const reconciled = result.checks.map((c) => {
      if (
        c.name === "ga4" &&
        !c.pass &&
        consentGated &&
        /^G-[A-Z0-9]{6,}$/.test(consentGated.measurementId)
      ) {
        return {
          name: "ga4",
          pass: true,
          detail: `consent-gated declared exception (measurementId=${consentGated.measurementId}); script injects post-consent`,
        };
      }
      return c;
    });
    const filtered = reconciled.filter((c) => {
      const flag = skipChecks[c.name as keyof typeof skipChecks];
      return flag !== false;
    });

    for (const check of filtered) {
      console.log(`  ${check.pass ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    }

    const failed = filtered.filter((c) => !c.pass);
    if (failed.length > 0) {
      console.error(
        `\ngate:ai-instrumentation  FAIL: ${failed.length}/${filtered.length} dimension(s) failed`,
      );
      console.error(
        "Spec: MASTER_VISIBILITY_MATRIX §17.3.1.2 AI Instrumentation Contract",
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `\ngate:ai-instrumentation  PASS: ${filtered.length}/${filtered.length} dimension(s) verified`,
    );
  } catch (err) {
    console.error(`\ngate:ai-instrumentation  ERROR: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await cleanup?.();
  }
}

// Skip CLI launch when imported by a test runner.
// import.meta.url and process.argv[1] differ only when this module is the
// entry point; when imported, process.argv[1] is the test runner.
const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
