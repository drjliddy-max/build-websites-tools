/*
 * gate:ai-instrumentation-source — STATIC source-level prevention gate.
 *
 * Companion to gate:ai-instrumentation (live HTTP probe). This gate
 * runs against the consumer site's SOURCE CODE, not the deployed
 * surface — catches the matrix §17.3.1.2 refactor regression class
 * BEFORE the build attempts to deploy.
 *
 * Specified by MASTER_VISIBILITY_MATRIX §17.3.1.2 + the 2026-06-05
 * "matrix surface refactor regression class" operator directive
 * (feedback_matrix_surface_refactor_regression_class.md). 3 prior
 * incidents in 4 days made the case that live-probe-only enforcement
 * was insufficient:
 *
 *   - liddy-podiatry-site 2026-06-04: public/robots.txt + route
 *     handler coexisted → 500 in production → deploy ERROR for 4
 *     days → live AI crawlers fetched stale pre-AI-policy build.
 *
 *   - participation-effect-site cutover 2026-06-05: static→Next.js
 *     migration replaced robots.txt with MetadataRoute.Robots which
 *     cannot emit the declared-policy comment block → bare allow-all
 *     in production until restored.
 *
 *   - siteclinic-web + babymilestonejournal-web 2026-06-05: route
 *     handler being replaced by public/robots.txt mid-refactor.
 *     Migration preserved AI policy by coincidence — but no
 *     automated guarantee.
 *
 * Three invariants this gate enforces at COMMIT TIME (no server
 * required):
 *
 *   1. ROBOTS  — exactly one robots.txt serving mechanism present
 *      (public/robots.txt OR src/app/robots.txt/route.ts OR
 *      src/app/robots.ts MetadataRoute), and the chosen mechanism
 *      contains the matrix-required declared-policy comment block.
 *      MetadataRoute.Robots is REJECTED because it cannot emit
 *      comments — the canonical signal site-monitor's
 *      detectRobotsAiPolicy scans for.
 *
 *   2. LLMS    — exactly one /llms.txt serving mechanism present
 *      (public/llms.txt OR src/app/llms.txt/route.ts), and the
 *      chosen mechanism has a Markdown heading.
 *
 *   3. JSONLD  — homepage source contains application/ld+json with
 *      at minimum Organization or WebSite @type. Spec §17.3.1.2
 *      #JSON-LD baseline.
 *
 * The gate is framework-agnostic — works for Next.js (App + Pages),
 * pure static HTML, Vite, Astro. Detects whichever pattern is
 * present. Operator may declare exceptions via the same
 * `aiInstrumentation` block in gate.config.json that gate-ai-
 * instrumentation reads.
 */
import fs from "node:fs";
import path from "node:path";

const REQUIRED_JSONLD_TYPES = ["Organization", "WebSite"] as const;

// Matches the canonical declared-policy comment block opener in any
// of the shipped forms across the owned-property portfolio.
//
// Matches `# AI policy …` whether preceded by:
//   - start-of-line (static public/robots.txt with actual newlines)
//   - whitespace, backtick, or escaped `\n` (route handler with
//     template-literal body)
//
// The leading character ensures we don't false-positive on a literal
// "AI policy" substring inside a URL or longer comment.
const ROBOTS_AI_POLICY_PATTERN =
  /(?:^|[\s\\\`])#\s*AI policy(?:\s|$)/im;

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

// ─── Robots.txt source detection ─────────────────────────────────────

export interface RobotsSource {
  /** Path relative to the site root. */
  file: string;
  /** Which serving mechanism this file uses. */
  kind: "static" | "route-handler" | "metadata-route";
  /** Raw file contents — used to verify matrix signal. */
  body: string;
}

/**
 * Scan the consumer site for ALL robots.txt-serving mechanisms.
 *
 * Returns every mechanism found so the gate can fail loudly on
 * conflict (multiple mechanisms = Next.js routing ambiguity =
 * production HTTP 500 risk per the liddy-podiatry incident).
 *
 * Exported for unit tests.
 */
export function findRobotsSources({ cwd }: SiteRoot): RobotsSource[] {
  const candidates: { file: string; kind: RobotsSource["kind"] }[] = [
    { file: "public/robots.txt", kind: "static" },
    { file: "site/robots.txt", kind: "static" },
    { file: "src/app/robots.txt/route.ts", kind: "route-handler" },
    { file: "src/app/robots.txt/route.tsx", kind: "route-handler" },
    { file: "app/robots.txt/route.ts", kind: "route-handler" },
    { file: "src/app/robots.ts", kind: "metadata-route" },
    { file: "src/app/robots.tsx", kind: "metadata-route" },
    { file: "app/robots.ts", kind: "metadata-route" },
    { file: "apps/web/app/robots.txt/route.ts", kind: "route-handler" },
    { file: "apps/web/public/robots.txt", kind: "static" },
  ];
  const found: RobotsSource[] = [];
  for (const candidate of candidates) {
    const abs = path.join(cwd, candidate.file);
    if (fs.existsSync(abs)) {
      found.push({
        file: candidate.file,
        kind: candidate.kind,
        body: fs.readFileSync(abs, "utf8"),
      });
    }
  }
  return found;
}

/**
 * Evaluate the matrix robots.txt invariant from a list of detected
 * sources. Exported for unit tests.
 */
export function evaluateRobots(sources: RobotsSource[]): CheckResult {
  if (sources.length === 0) {
    return {
      name: "robots",
      pass: false,
      detail:
        "no robots.txt source found — expected one of: public/robots.txt, site/robots.txt, src/app/robots.txt/route.ts, src/app/robots.ts, or apps/web/* equivalent",
    };
  }
  if (sources.length > 1) {
    return {
      name: "robots",
      pass: false,
      detail: `multiple robots.txt mechanisms — Next.js will return 500. Pick ONE and delete the others. Found: ${sources.map((s) => s.file).join(", ")}`,
    };
  }
  const [src] = sources;
  if (src.kind === "metadata-route") {
    return {
      name: "robots",
      pass: false,
      detail: `src/app/robots.ts (Next.js MetadataRoute) cannot emit the declared AI policy comment block that matrix §17.3.1.2 requires. Replace with src/app/robots.txt/route.ts (route handler) or public/robots.txt (static).`,
    };
  }
  if (!ROBOTS_AI_POLICY_PATTERN.test(src.body)) {
    return {
      name: "robots",
      pass: false,
      detail: `${src.file} missing declared AI policy comment block — expected '# AI policy …' header per matrix §17.3.1.2`,
    };
  }
  return {
    name: "robots",
    pass: true,
    detail: `${src.file} (${src.kind}) — declared AI policy present`,
  };
}

// ─── llms.txt source detection ───────────────────────────────────────

export interface LlmsSource {
  file: string;
  kind: "static" | "route-handler";
  body: string;
}

/** Exported for unit tests. */
export function findLlmsSources({ cwd }: SiteRoot): LlmsSource[] {
  const candidates: { file: string; kind: LlmsSource["kind"] }[] = [
    { file: "public/llms.txt", kind: "static" },
    { file: "site/llms.txt", kind: "static" },
    { file: "src/app/llms.txt/route.ts", kind: "route-handler" },
    { file: "src/app/llms.txt/route.tsx", kind: "route-handler" },
    { file: "app/llms.txt/route.ts", kind: "route-handler" },
    { file: "apps/web/public/llms.txt", kind: "static" },
    { file: "apps/web/app/llms.txt/route.ts", kind: "route-handler" },
  ];
  const found: LlmsSource[] = [];
  for (const candidate of candidates) {
    const abs = path.join(cwd, candidate.file);
    if (fs.existsSync(abs)) {
      found.push({
        file: candidate.file,
        kind: candidate.kind,
        body: fs.readFileSync(abs, "utf8"),
      });
    }
  }
  return found;
}

/** Exported for unit tests. */
export function evaluateLlms(sources: LlmsSource[]): CheckResult {
  if (sources.length === 0) {
    return {
      name: "llms",
      pass: false,
      detail:
        "no llms.txt source found — expected one of: public/llms.txt, site/llms.txt, src/app/llms.txt/route.ts, or apps/web/* equivalent",
    };
  }
  if (sources.length > 1) {
    return {
      name: "llms",
      pass: false,
      detail: `multiple llms.txt mechanisms. Pick ONE and delete the others. Found: ${sources.map((s) => s.file).join(", ")}`,
    };
  }
  const [src] = sources;
  // For route-handler files, look for a Markdown heading inside a
  // template-literal body. For static files, scan the file directly.
  // Both reduce to: any line starting with "# heading".
  // Heading may sit at start-of-line (static file) OR follow whitespace,
  // backtick, or escaped `\n` inside a template literal (route handler).
  if (!/(?:^|[\s\\\`])#\s+\S/.test(src.body)) {
    return {
      name: "llms",
      pass: false,
      detail: `${src.file} has no Markdown heading (expected '# heading' anywhere in the body)`,
    };
  }
  return {
    name: "llms",
    pass: true,
    detail: `${src.file} (${src.kind}) — Markdown heading present`,
  };
}

// ─── JSON-LD homepage source detection ──────────────────────────────

const HOMEPAGE_CANDIDATES = [
  "src/app/page.tsx",
  "src/app/page.jsx",
  "src/app/(marketing)/page.tsx",
  "app/page.tsx",
  "app/page.jsx",
  "pages/index.tsx",
  "pages/index.jsx",
  "pages/index.js",
  "site/index.html",
  "public/index.html",
  "apps/web/app/page.tsx",
];

/**
 * JSON-LD baseline (Organization or WebSite) can live in:
 *   - the homepage page.tsx itself
 *   - the app-router layout.tsx wrapping the homepage
 *   - a shared <JsonLd /> or <Schema /> component imported by either
 *
 * Scan all of these as a single corpus — if Organization or WebSite
 * appears anywhere in the homepage's surrounding source tree, the
 * matrix signal is present in production. This catches the actual
 * shipped pattern across the owned portfolio without false-positive
 * failing on sites that split JSON-LD across layout + page.
 */
const JSONLD_SCAN_FILES = [
  "src/app/layout.tsx",
  "src/app/layout.jsx",
  "src/app/(marketing)/layout.tsx",
  "src/components/JsonLd.tsx",
  "src/components/JsonLdScript.tsx",
  "src/components/Schema.tsx",
  "src/components/SchemaOrg.tsx",
  "src/lib/schema.ts",
  "src/lib/jsonLd.ts",
  "app/layout.tsx",
  "apps/web/app/layout.tsx",
];

/** Exported for unit tests. */
export function findHomepageSource({ cwd }: SiteRoot): { file: string; body: string } | null {
  for (const candidate of HOMEPAGE_CANDIDATES) {
    const abs = path.join(cwd, candidate);
    if (fs.existsSync(abs)) {
      return { file: candidate, body: fs.readFileSync(abs, "utf8") };
    }
  }
  return null;
}

/**
 * Best-effort static scan for JSON-LD @type literals on the homepage
 * source. Cannot fully execute Next.js templates, so we look for
 * literal "@type": "X" strings AND `@type` keys with array values.
 *
 * The signal we need: at minimum one of Organization or WebSite is
 * declared somewhere in the homepage source. Source-level check is
 * imperfect (could miss dynamically-built schema), but catches the
 * common regression: someone deletes the JSON-LD block during a
 * refactor.
 *
 * Exported for unit tests.
 */
export function detectHomepageJsonLdTypes(body: string): string[] {
  const found = new Set<string>();
  // Match "@type": "X" or "@type":"X" or '@type': 'X', single + double quotes.
  const re = /["']@type["']\s*:\s*["']([A-Za-z][A-Za-z0-9]*)["']/g;
  for (const match of body.matchAll(re)) {
    found.add(match[1]);
  }
  // Match "@type": ["X","Y"] arrays.
  const arrRe = /["']@type["']\s*:\s*\[([^\]]+)\]/g;
  for (const match of body.matchAll(arrRe)) {
    const inner = match[1];
    for (const m of inner.matchAll(/["']([A-Za-z][A-Za-z0-9]*)["']/g)) {
      found.add(m[1]);
    }
  }
  return [...found];
}

/** Exported for unit tests. */
export function evaluateHomepageJsonLd({ cwd }: SiteRoot): CheckResult {
  const homepage = findHomepageSource({ cwd });
  if (!homepage) {
    return {
      name: "jsonLdSource",
      pass: false,
      detail: `no homepage source found among: ${HOMEPAGE_CANDIDATES.join(", ")}`,
    };
  }

  // Gather the homepage body PLUS layout / shared schema components.
  // The matrix-required Organization/WebSite often lives in
  // layout.tsx (so it wraps every page) or in a shared <JsonLd />
  // component imported by the homepage. Scanning the corpus avoids
  // false-positive failure on sites that split JSON-LD across files.
  const corpus: { file: string; body: string }[] = [homepage];
  for (const rel of JSONLD_SCAN_FILES) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) {
      corpus.push({ file: rel, body: fs.readFileSync(abs, "utf8") });
    }
  }

  const typesPerFile = new Map<string, string[]>();
  const allTypes = new Set<string>();
  for (const c of corpus) {
    const t = detectHomepageJsonLdTypes(c.body);
    if (t.length > 0) {
      typesPerFile.set(c.file, t);
      for (const x of t) allTypes.add(x);
    }
  }

  if (allTypes.size === 0) {
    return {
      name: "jsonLdSource",
      pass: false,
      detail: `no JSON-LD @type literal found in homepage source corpus (${corpus.map((c) => c.file).join(", ")}). Matrix §17.3.1.2 requires Organization or WebSite.`,
    };
  }
  const hasRequired = REQUIRED_JSONLD_TYPES.some((t) => allTypes.has(t));
  if (!hasRequired) {
    const summary = [...typesPerFile.entries()]
      .map(([file, types]) => `${file}: [${types.join(", ")}]`)
      .join("; ");
    return {
      name: "jsonLdSource",
      pass: false,
      detail: `JSON-LD types found (${summary}) but neither Organization nor WebSite — at least one required by §17.3.1.2`,
    };
  }
  const summary = [...typesPerFile.entries()]
    .filter(([, types]) =>
      types.some((t) => REQUIRED_JSONLD_TYPES.includes(t as (typeof REQUIRED_JSONLD_TYPES)[number])),
    )
    .map(([file, types]) => `${file}: [${types.join(", ")}]`)
    .join("; ");
  return {
    name: "jsonLdSource",
    pass: true,
    detail: `Organization/WebSite present (${summary})`,
  };
}

// ─── Aggregate ───────────────────────────────────────────────────────

export function evaluateSource({ cwd }: SiteRoot): SourceScanResult {
  const checks: CheckResult[] = [
    evaluateRobots(findRobotsSources({ cwd })),
    evaluateLlms(findLlmsSources({ cwd })),
    evaluateHomepageJsonLd({ cwd }),
  ];
  return { pass: checks.every((c) => c.pass), checks };
}

// ─── Config + CLI ────────────────────────────────────────────────────

interface SourceGateConfig {
  skip?: { reason: string };
  checks?: {
    robots?: boolean;
    llms?: boolean;
    jsonLdSource?: boolean;
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
    const ai = parsed.aiInstrumentation as
      | Record<string, unknown>
      | undefined;
    if (!ai) return {};
    const src = ai.source as Record<string, unknown> | undefined;
    if (!src) return {};
    if (
      typeof src !== "object" ||
      src === null ||
      Array.isArray(src)
    ) {
      return {};
    }
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
      `gate:ai-instrumentation-source  SKIPPED — ${config.skip.reason}`,
    );
    return;
  }

  console.log(`gate:ai-instrumentation-source  cwd=${cwd}`);
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
      `\ngate:ai-instrumentation-source  FAIL — ${failed.length}/${filtered.length} invariant(s) violated`,
    );
    console.error(
      "Spec: MASTER_VISIBILITY_MATRIX §17.3.1.2 +",
      "feedback_matrix_surface_refactor_regression_class.md",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `\ngate:ai-instrumentation-source  PASS — ${filtered.length}/${filtered.length} source invariant(s) verified`,
  );
}

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url.endsWith(process.argv[1] ?? "");
if (isCli) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
