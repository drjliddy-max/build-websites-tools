/*
 * gate:build-determinism-source: STATIC source-level gate that a production
 * build does not depend on a third-party network fetch succeeding.
 *
 * Why it exists
 * =============
 * A build that reaches out to someone else's server at build time is not a
 * build, it is a bet. It passes on a developer laptop, fails intermittently
 * in CI, and the failure never names the real cause.
 *
 * Proven on this estate on 2026-10-07. `next/font/google` fetches font files
 * from Google AT BUILD TIME in order to self-host them. Two consumers failed
 * within one hour on different font families:
 *
 *   qirofit-web    production dpl_5Smn5xkkduxN6QizVksBx5DaQtaA  560 font errors
 *   qirofit-web    preview    dpl_Gvzf2EnL6CqFToc42hdeuHahmgU9  280 font errors
 *   siteclinic-web GitHub Actions run 37699607539               geist_*.module.css
 *
 * Measured blast radius: SIX of nine consumers imported it, so two thirds of
 * the estate's production builds depended on that fetch. Four had not failed
 * yet; they were unfailed exposed instances, not robust ones.
 *
 * The cause is not a provider outage. Three hypotheses were tested and
 * rejected: a build-websites-tools version bump (the first failure predates
 * it), Next.js drift through the `^16.2.6` caret range (lockfiles pinned
 * 16.2.7 on both sides and local builds passed on 16.2.7), and a Google Fonts
 * outage (the endpoint returned 200 and real font URLs throughout). What
 * survives: identical code, identical lockfile, passes from a residential IP,
 * fails intermittently from cloud builders on TWO independent providers.
 * Consistent with rate limiting of shared datacenter IP ranges. Full record:
 * build-websites-tools#51.
 *
 * The remediation is self-hosting: commit the woff2 and use `next/font/local`.
 * This gate exists so the next site cannot quietly reintroduce the dependency,
 * because nothing else would notice until a build failed.
 *
 * Two symptoms, one cause: the same defect surfaced once as a gate reporting
 * `homepage returned HTTP 500` (the dev server it probed had failed to
 * compile) and once as every gate passing and the real compile failing after
 * them. Neither named the font. A source-level gate is the only place this is
 * visible before it costs a build.
 *
 * What it checks
 * ==============
 *   NO-REMOTE-FONT-FETCH: no source file imports a font module that resolves
 *   over the network at build time. Today that is `next/font/google`.
 *   `next/font/local` is the supported alternative and is explicitly fine.
 *
 * Deliberately NOT flagged, each a real false positive this gate had to avoid:
 *   - A mention inside a COMMENT. The migrated consumers all carry a comment
 *     explaining why next/font/google must not come back, naming it three
 *     times. Comments are blanked before matching (strings are preserved, so
 *     the module specifier itself still matches).
 *   - A runtime fetch. Only build-time module resolution is in scope; a
 *     component fetching an API at request time is not a build dependency.
 *   - `next/font/local`, which is the fix, not the defect.
 *
 * Operator may declare an exception via `buildDeterminism` in gate.config.json
 * (a `skip` reason, or per-check toggles), mirroring the other source gates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripCommentsAndStrings } from "./gate-sitemap-source";

export type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
};

export interface BuildDeterminismResult {
  pass: boolean;
  checks: CheckResult[];
  violations: Violation[];
}

export interface Violation {
  file: string;
  line: number;
  specifier: string;
}

export interface BuildDeterminismConfig {
  skip?: string;
  checks?: Record<string, boolean>;
}

const SOURCE_DIR_CANDIDATES = ["src", "app", "apps/web/src", "apps/web/app"] as const;
const GATE_CONFIG_CANDIDATES = [
  "gate.config.json",
  "apps/web/gate.config.json",
] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/*
 * Font modules that resolve over the network during the build. Keyed by exact
 * module specifier, because that is what appears in an import. `next/font/local`
 * is deliberately absent: it reads files from the repository.
 */
export const REMOTE_FONT_MODULES = ["next/font/google"] as const;

export function firstExisting(cwd: string, candidates: readonly string[]): string | null {
  for (const rel of candidates) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(abs);
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Find build-time imports of a network-resolved font module.
 *
 * Comments are blanked first and strings are KEPT: a comment naming the module
 * must not match, while the module specifier in the import must. That is why
 * `strings: false` is passed rather than the default.
 */
export function findRemoteFontImports(source: string): Array<{ line: number; specifier: string }> {
  const code = stripCommentsAndStrings(source, { strings: false });
  const hits: Array<{ line: number; specifier: string }> = [];
  for (const specifier of REMOTE_FONT_MODULES) {
    const quoted = specifier.replace(/\//g, "\\/");
    const patterns = [
      // import ... from "next/font/google"
      new RegExp(`\\bimport\\b[^;\\n]*?from\\s*["'\`]${quoted}["'\`]`, "g"),
      // import "next/font/google"  (side-effect form)
      new RegExp(`\\bimport\\s*["'\`]${quoted}["'\`]`, "g"),
      // require("next/font/google") and import("next/font/google")
      new RegExp(`\\b(?:require|import)\\s*\\(\\s*["'\`]${quoted}["'\`]`, "g"),
    ];
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        const line = code.slice(0, match.index ?? 0).split("\n").length;
        if (!hits.some((h) => h.line === line)) hits.push({ line, specifier });
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

export function evaluateSource({ cwd }: { cwd: string }): BuildDeterminismResult {
  const checks: CheckResult[] = [];
  const sourceDir = firstExisting(cwd, SOURCE_DIR_CANDIDATES);

  if (!sourceDir) {
    checks.push({
      name: "sourceDirectory",
      pass: false,
      detail: `no source directory found (looked for ${SOURCE_DIR_CANDIDATES.join(", ")})`,
    });
    return { pass: false, checks, violations: [] };
  }

  const violations: Violation[] = [];
  for (const file of listSourceFiles(sourceDir)) {
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!REMOTE_FONT_MODULES.some((m) => source.includes(m))) continue;
    for (const hit of findRemoteFontImports(source)) {
      violations.push({
        file: path.relative(cwd, file),
        line: hit.line,
        specifier: hit.specifier,
      });
    }
  }

  checks.push({
    name: "noRemoteFontFetch",
    pass: violations.length === 0,
    detail:
      violations.length === 0
        ? "no source file imports a font module that resolves over the network at build time"
        : `${violations.length} build-time remote font import(s): ${violations
            .map((v) => `${v.file}:${v.line} (${v.specifier})`)
            .join(", ")}`,
  });

  return { pass: checks.every((c) => c.pass), checks, violations };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const configPath = firstExisting(cwd, GATE_CONFIG_CANDIDATES);
  const config: BuildDeterminismConfig = configPath
    ? ((JSON.parse(fs.readFileSync(configPath, "utf8")).buildDeterminism ??
        {}) as BuildDeterminismConfig)
    : {};

  if (config.skip) {
    console.log(`gate:build-determinism-source  SKIP: ${config.skip}`);
    return;
  }

  console.log(`gate:build-determinism-source  cwd=${cwd}`);
  const { checks } = evaluateSource({ cwd });

  const toggles = config.checks ?? {};
  const filtered = checks.filter((c) => toggles[c.name] !== false);

  for (const check of filtered) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }

  const failed = filtered.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(
      `\ngate:build-determinism-source  FAIL: ${failed.length}/${filtered.length} invariant(s) violated`,
    );
    console.error(
      "A production build must not depend on a third-party fetch succeeding.",
    );
    console.error(
      "Replace next/font/google with next/font/local and commit the woff2 files. See build-websites-tools#51.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `\ngate:build-determinism-source  PASS: ${filtered.length}/${filtered.length} source invariant(s) verified`,
  );
}

const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
