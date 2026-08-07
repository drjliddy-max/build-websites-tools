/*
 * gate:sitemap-source: STATIC prevention gate for the lastmod standard.
 *
 * Companion to the runtime lastmod checks in gate:seo. Those read the served
 * sitemap.xml and catch a site that is ALREADY lying. This one reads the
 * sitemap's SOURCE and catches the construct that produces the lie, before a
 * build ever runs - no server required.
 *
 * THE LOCKED RULE, for every sitemap URL:
 *
 *     lastmod = the last substantive content change
 *
 * The originating incident (siteclinic.io, 2026-07-27): src/app/sitemap.ts
 * computed `const now = new Date()` once and reused it for every non-blog
 * entry. Next re-evaluates the sitemap on every build, so 33 of 54 URLs
 * carried one identical timestamp - the last deploy. /privacy and /about
 * claimed they changed that morning; git said May and June. Twice-weekly
 * blog-publish commits restamped the entire site as fresh, and Google
 * discounted lastmod site-wide.
 *
 * What this gate PROHIBITS in sitemap sources:
 *   - `new Date()` with no argument (build/process instant)
 *   - `Date.now()` used as sitemap freshness
 *   - one build-scoped date variable assigned to every route
 *
 * What it explicitly ALLOWS, because these read stored content metadata:
 *   - `new Date(entry.updatedAt)` / `new Date(post.published)`
 *   - `new Date("2026-06-07")` and other literal content dates
 *   - anything from build-websites-tools/sitemap
 *
 * Deliberately conservative about false positives: a bare `new Date()` is
 * flagged only inside files that actually build a sitemap, and a line carrying
 * the documented escape-hatch comment is honoured.
 */
import fs from "node:fs";
import path from "node:path";
import { beginFragment } from "./snapshot";

export type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
};

export interface SourceViolation {
  file: string;
  line: number;
  /** The offending source text, trimmed. */
  match: string;
  code: "bare-new-date" | "date-now" | "build-scoped-shared-date";
  remediation: string;
}

export interface SitemapSourceScan {
  pass: boolean;
  /** Files that were actually scanned. */
  files: string[];
  violations: SourceViolation[];
}

/**
 * Opt-out marker. A line carrying this comment is exempt.
 *
 * Intended for the rare legitimate clock read inside a sitemap module - e.g.
 * comparing a stored date against now to drop unpublished future posts. It is
 * a per-line acknowledgement, not a file-wide switch, so it cannot quietly
 * re-open the whole defect class.
 */
const ALLOW_MARKER = "bwt-allow-build-time-date";

const SITEMAP_SOURCE_CANDIDATES = [
  "src/app/sitemap.ts",
  "src/app/sitemap.tsx",
  "src/app/sitemap.js",
  "src/app/sitemap.mjs",
  "app/sitemap.ts",
  "app/sitemap.tsx",
  "app/sitemap.js",
  "apps/web/app/sitemap.ts",
  "apps/web/src/app/sitemap.ts",
  "src/app/sitemap.xml/route.ts",
  "src/app/sitemap.xml/route.tsx",
  "app/sitemap.xml/route.ts",
  "pages/sitemap.xml.tsx",
  "pages/sitemap.xml.ts",
  "src/pages/sitemap.xml.tsx",
  "scripts/generate-sitemap.mjs",
  "scripts/generate-sitemap.js",
  "scripts/generate-sitemap.ts",
  "scripts/build-sitemap.mjs",
  "scripts/build-sitemap.js",
  "scripts/build-sitemap.ts",
];

export interface SiteRoot {
  cwd: string;
}

export interface SitemapSourceFile {
  file: string;
  body: string;
}

/** Locate every sitemap-building source file in the consumer site. */
export function findSitemapSources({ cwd }: SiteRoot): SitemapSourceFile[] {
  const found: SitemapSourceFile[] = [];
  for (const candidate of SITEMAP_SOURCE_CANDIDATES) {
    const abs = path.join(cwd, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      found.push({ file: candidate, body: fs.readFileSync(abs, "utf8") });
    }
  }
  return found;
}

/**
 * Blank out comments and string/template literal bodies so the pattern scan
 * reads code only.
 *
 * Replaces characters with spaces rather than deleting them, so line and
 * column numbers stay exact for diagnostics. A commented-out `new Date()` or
 * a doc string mentioning it is therefore not a violation - which matters,
 * because this very file's header describes the prohibited patterns.
 *
 * `options.strings: false` blanks comments ONLY, leaving string literals
 * intact. Added 2026-07-31 for gate-conversion-instrumentation-source, whose
 * pattern is `gtag("event", ...)` - the string literal IS the signal there, so
 * blanking it would make the check match nothing. String literals are still
 * traversed either way, because a `//` inside "https://example.com" must never
 * be mistaken for the start of a comment.
 */
export function stripCommentsAndStrings(
  source: string,
  options: { strings?: boolean } = {},
): string {
  const blankStrings = options.strings !== false;
  const out = source.split("");
  let index = 0;
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < n; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  while (index < n) {
    const two = source.slice(index, index + 2);

    if (two === "//") {
      let end = source.indexOf("\n", index);
      if (end === -1) end = n;
      blank(index, end);
      index = end;
      continue;
    }

    if (two === "/*") {
      let end = source.indexOf("*/", index + 2);
      end = end === -1 ? n : end + 2;
      blank(index, end);
      index = end;
      continue;
    }

    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      let i = index + 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === char) break;
        i += 1;
      }
      // Keep the quotes, blank the body. Always traverse the literal even when
      // not blanking it, so its contents cannot be read as code or comments.
      if (blankStrings) blank(index + 1, i);
      index = Math.min(i + 1, n);
      continue;
    }

    index += 1;
  }

  return out.join("");
}

const REMEDIATION_BARE_DATE =
  'replace with the route\'s last substantive content change - a literal date ("2026-07-02"), a value read from stored content metadata (new Date(entry.published)), or defineSitemap() from build-websites-tools/sitemap';
const REMEDIATION_DATE_NOW =
  "Date.now() is the build instant, not a content date; use the route's stored content date instead";
const REMEDIATION_SHARED =
  "one build-scoped date assigned to every route is the exact defect this standard exists to stop; give each route its own content date via defineSitemap() from build-websites-tools/sitemap";

/**
 * Scan one sitemap source file for prohibited build-time freshness patterns.
 *
 * Exported for unit tests.
 */
export function scanSitemapSource(file: string, body: string): SourceViolation[] {
  const code = stripCommentsAndStrings(body);
  const rawLines = body.split("\n");
  const codeLines = code.split("\n");
  const violations: SourceViolation[] = [];

  const lineAllows = (lineIndex: number) =>
    (rawLines[lineIndex] ?? "").includes(ALLOW_MARKER);

  // ── Pattern 3 (reported first, most specific): one build-scoped date
  // variable reused across routes. `const now = new Date()` … `lastModified: now`.
  const sharedVars = new Map<string, number>();
  const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Date\s*\(\s*\)/g;
  const assignNowRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Date\s*\.\s*now\s*\(\s*\)/g;
  for (const re of [assignRe, assignNowRe]) {
    for (const match of code.matchAll(re)) {
      const lineIndex = code.slice(0, match.index).split("\n").length - 1;
      if (lineAllows(lineIndex)) continue;
      sharedVars.set(match[1], lineIndex);
    }
  }

  const reportedLines = new Set<number>();
  for (const [name, declLine] of sharedVars.entries()) {
    const useRe = new RegExp(
      String.raw`lastModified\s*:\s*(?:new\s+Date\s*\(\s*)?\b${name}\b`,
      "g",
    );
    const uses = [...code.matchAll(useRe)];
    if (uses.length === 0) continue;
    violations.push({
      file,
      line: declLine + 1,
      match: (rawLines[declLine] ?? "").trim(),
      code: "build-scoped-shared-date",
      remediation: `\`${name}\` is a build-time instant reused by ${uses.length} lastModified assignment(s); ${REMEDIATION_SHARED}`,
    });
    reportedLines.add(declLine);
    for (const use of uses) {
      reportedLines.add(code.slice(0, use.index).split("\n").length - 1);
    }
  }

  // ── Pattern 1: bare `new Date()` with no argument.
  const bareRe = /new\s+Date\s*\(\s*\)/g;
  for (const match of code.matchAll(bareRe)) {
    const lineIndex = code.slice(0, match.index).split("\n").length - 1;
    if (lineAllows(lineIndex) || reportedLines.has(lineIndex)) continue;
    reportedLines.add(lineIndex);
    violations.push({
      file,
      line: lineIndex + 1,
      match: (rawLines[lineIndex] ?? "").trim(),
      code: "bare-new-date",
      remediation: `\`new Date()\` yields the build/process instant, not a content date; ${REMEDIATION_BARE_DATE}`,
    });
  }

  // ── Pattern 2: `Date.now()` as freshness.
  const nowRe = /\bDate\s*\.\s*now\s*\(\s*\)/g;
  for (const match of code.matchAll(nowRe)) {
    const lineIndex = code.slice(0, match.index).split("\n").length - 1;
    if (lineAllows(lineIndex) || reportedLines.has(lineIndex)) continue;
    reportedLines.add(lineIndex);
    violations.push({
      file,
      line: lineIndex + 1,
      match: (rawLines[lineIndex] ?? "").trim(),
      code: "date-now",
      remediation: REMEDIATION_DATE_NOW,
    });
  }

  return violations.sort((a, b) => a.line - b.line);
}

/** Evaluate every sitemap source in the site. Exported for unit tests. */
export function evaluateSitemapSource({ cwd }: SiteRoot): SitemapSourceScan {
  const sources = findSitemapSources({ cwd });
  const violations = sources.flatMap((source) =>
    scanSitemapSource(source.file, source.body),
  );
  return {
    pass: violations.length === 0,
    files: sources.map((source) => source.file),
    violations,
  };
}

// ─── Config + CLI ────────────────────────────────────────────────────

interface SitemapGateConfig {
  enforce?: boolean;
}

export function loadSitemapConfig(cwd: string): SitemapGateConfig {
  const configPath = path.join(cwd, "gate.config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const sitemap = parsed.sitemap as Record<string, unknown> | undefined;
    if (!sitemap || typeof sitemap !== "object" || Array.isArray(sitemap)) return {};
    return sitemap as SitemapGateConfig;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const config = loadSitemapConfig(cwd);
  const enforce = config.enforce !== false;

  const fragment = beginFragment("gate-sitemap-source");
  const { files, violations } = evaluateSitemapSource({ cwd });

  // enforce=false makes this gate report-only, so it exits 0 while violations
  // exist. Recording `enforce` keeps a downstream reader from mistaking a
  // non-blocking pass for a clean sitemap source.
  fragment.provenance({
    enforce,
    sitemapSourceFiles: files,
    violationCount: violations.length,
    violations: violations.map((v) => ({
      file: v.file,
      line: v.line,
      code: v.code,
    })),
  });
  fragment.checks(
    files.length === 0
      ? [{ name: "sitemap-source", pass: true, detail: "no dynamic sitemap source found (static sitemap.xml validated at runtime by gate:seo)" }]
      : violations.length === 0
        ? [{ name: "sitemap-source", pass: true, detail: `${files.length} source(s) declare content dates` }]
        : violations.map((v) => ({
            name: `sitemap-source ${v.file}:${v.line}`,
            pass: false,
            detail: v.code,
          })),
  );

  if (files.length === 0) {
    // A site may serve a fully static public/sitemap.xml, which has no
    // build-time construct to police. gate:seo still validates the served
    // document, so this is a pass with a stated scope limit rather than a
    // silent success.
    console.log(
      "gate:sitemap-source  PASS: no dynamic sitemap source found (static sitemap.xml is validated at runtime by gate:seo)",
    );
    return;
  }

  if (violations.length === 0) {
    console.log(
      `gate:sitemap-source  PASS: ${files.length} sitemap source(s) declare content dates (${files.join(", ")})`,
    );
    return;
  }

  const marker = enforce ? "✗" : "!";
  console.error(
    `gate:sitemap-source  ${enforce ? "FAIL" : "WARN"}: ${violations.length} prohibited build-time date pattern(s)`,
  );
  for (const violation of violations) {
    console.error(`  ${marker} ${violation.file}:${violation.line}  [${violation.code}]`);
    console.error(`      ${violation.match}`);
    console.error(`      → ${violation.remediation}`);
  }
  console.error(
    "\n  Standard: lastmod = last substantive content change. Build time, deploy time,",
  );
  console.error(
    "  process start time, and framework execution time are not valid sources on their own.",
  );
  if (!enforce) {
    console.error(
      '\n  sitemap.enforce is false in gate.config.json - reported, not blocking.',
    );
    return;
  }
  process.exitCode = 1;
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
