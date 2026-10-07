/*
 * gate:indexability-source: STATIC source-level gate that every route a site
 * actually ships is deliberately classified as indexable-and-sitemapped, or
 * noindexed-and-off-sitemap, and never anything in between.
 *
 * Why it exists
 * =============
 * gate:seo already asserts "no meta robots noindex" and "no X-Robots-Tag:
 * noindex". But it only ever looks at routes the site DECLARES: the `routes`
 * array in gate.config.json, plus routes it finds in the generated sitemap. A
 * route that exists in the app directory and is declared in neither place is
 * invisible to it. gate:seo cannot fail on a page it never visits.
 *
 * That blind spot shipped a real defect. On daily-rise.com (found 2026-10-07
 * via Search Console: 18 "Crawled - currently not indexed", 1 "Indexed,
 * though blocked by robots.txt") the root layout set `index: true, follow:
 * true` as the GLOBAL default and only four routes overrode it. Six app and
 * auth routes (/settings, /day-1, /another-moment, /share, /auth/login,
 * /auth/callback) silently inherited "indexable". The site's own
 * gate.config.json already listed all eleven in allowedOffSitemapRoutes, so
 * the declared intent and the served HTML disagreed for months. gate:seo
 * passed the entire time, before AND after the repair.
 *
 * The same sweep found the mirror-image defect on
 * theparticipationeffect.com: /chapter-one is a real "Read Chapter One Free"
 * lead-capture page, HTTP 200 and `index, follow`, absent from the sitemap.
 * Indexable but unsitemapped is under-indexing; off-sitemap but indexable is
 * crawl waste. Both are the same missing invariant, in opposite directions.
 *
 * The contract, per static route the site ships:
 *
 *   1. CLASSIFIED: the route appears in gate.config.json's `routes` (public,
 *      sitemapped) or in `allowedOffSitemapRoutes` (deliberately excluded).
 *      A route in neither is unclassified: nobody has decided what it is,
 *      which is how /chapter-one went unsitemapped.
 *
 *   2. PUBLIC-ROUTES-INDEXABLE: a route in `routes` must NOT declare noindex.
 *      A sitemapped page carrying noindex is a page the site is advertising
 *      and simultaneously hiding.
 *
 *   3. OFF-SITEMAP-NOINDEXED: a route in `allowedOffSitemapRoutes` MUST
 *      resolve to noindex, whether from its own metadata or an ancestor
 *      layout's. This is the daily-rise defect.
 *
 *   4. NO-DISALLOW-PLUS-NOINDEX: a rendering route must not be both
 *      robots.txt-Disallowed and relying on noindex. robots.txt governs
 *      CRAWLING, not INDEXING. A Disallow prevents the crawler from ever
 *      reading the noindex, so the URL gets indexed from inbound links with
 *      no directive applied. That is precisely the "Indexed, though blocked
 *      by robots.txt" row. A Disallow plus a noindex is strictly worse than
 *      a noindex alone. robots.txt is for non-HTML paths (/api/); noindex is
 *      for anything that renders.
 *
 * False positives this gate deliberately avoids
 * =============================================
 * Each of these produced a wrong finding during the 2026-10-07 sweep that
 * built this gate, so each is guarded:
 *
 *   - Config entries for routes that DO NOT EXIST. adaauditreport-web lists
 *     "/verify" in allowedOffSitemapRoutes, but src/app/verify holds only a
 *     [leadId] child, so the bare route 404s. Flagging it was wrong. Only
 *     routes with a real page file are evaluated.
 *   - DECLARED-BUT-ABSENT routes are not errors. siteclinic-web declares 34
 *     routes against 18 in source; the surplus are content URLs. The gate
 *     checks source -> config, never config -> source.
 *   - Dynamic segments ([slug], [...all]) are content-driven and skipped.
 *   - Route groups ((marketing)) add no path segment and must not become one.
 *
 * Operator may declare exceptions via `indexability` in gate.config.json:
 * a `skip` reason for the whole gate, or `allowUnclassified` / per-check
 * toggles, mirroring the aiInstrumentation and conversionInstrumentation
 * blocks.
 *
 * Framework-agnostic across Next.js App Router layouts and apps/web
 * monorepos. Source-only: no server, no build, runs at commit time.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CheckResult = {
  name: string;
  pass: boolean;
  detail: string;
};

export interface IndexabilityScanResult {
  pass: boolean;
  checks: CheckResult[];
  /** Every static route discovered, with how it was classified. */
  routes: RouteVerdict[];
}

export interface RouteVerdict {
  route: string;
  indexable: boolean;
  /** Which file supplied the noindex, when one did. */
  noindexVia?: string;
  classification: "public" | "off-sitemap" | "unclassified";
}

export interface IndexabilityConfig {
  skip?: string;
  checks?: Record<string, boolean>;
  /** Routes exempted from the CLASSIFIED requirement, with intent recorded. */
  allowUnclassified?: string[];
}

const APP_DIR_CANDIDATES = ["src/app", "app", "apps/web/app"] as const;
const GATE_CONFIG_CANDIDATES = [
  "gate.config.json",
  "apps/web/gate.config.json",
] as const;
const ROBOTS_SOURCE_CANDIDATES = [
  "src/app/robots.txt/route.ts",
  "app/robots.txt/route.ts",
  "apps/web/app/robots.txt/route.ts",
  "src/app/robots.ts",
  "app/robots.ts",
  "apps/web/app/robots.ts",
  "public/robots.txt",
  "apps/web/public/robots.txt",
] as const;

const PAGE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js"] as const;
const LAYOUT_FILES = ["layout.tsx", "layout.ts", "layout.jsx", "layout.js"] as const;

/*
 * A noindex declaration, in any of the forms the portfolio actually uses:
 *   robots: { index: false }           Next.js Metadata object
 *   robots: "noindex, follow"          string form
 *   <meta name="robots" content="noindex">   hand-written tag
 * Whitespace- and order-tolerant; `index:false` and a multiline block both match.
 */
const NOINDEX_METADATA = /robots\s*:\s*\{[^}]*?\bindex\s*:\s*false/s;
const NOINDEX_STRING = /robots\s*:\s*["'][^"']*\bnoindex\b/i;
const NOINDEX_META_TAG = /content\s*=\s*["'][^"']*\bnoindex\b/i;

export function firstExisting(cwd: string, candidates: readonly string[]): string | null {
  for (const rel of candidates) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

export function declaresNoindex(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const source = fs.readFileSync(file, "utf8");
  return (
    NOINDEX_METADATA.test(source) ||
    NOINDEX_STRING.test(source) ||
    NOINDEX_META_TAG.test(source)
  );
}

/**
 * Enumerate the static routes a Next.js App Router site ships.
 *
 * A directory contributes a route only when it holds a page file. Route
 * groups `(name)` contribute no path segment. Dynamic segments are excluded
 * by the caller, not here, so callers can still see them if they want.
 */
export function listStaticRoutes(appDir: string): string[] {
  const routes: string[] = [];
  const walk = (dir: string, routePath: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const childDir = path.join(dir, entry.name);
      const isRouteGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
      const childRoute = isRouteGroup ? routePath : `${routePath}/${entry.name}`;
      if (PAGE_FILES.some((f) => fs.existsSync(path.join(childDir, f)))) {
        routes.push(childRoute === "" ? "/" : childRoute);
      }
      walk(childDir, childRoute);
    }
  };
  // The app dir itself may hold the root page.
  if (PAGE_FILES.some((f) => fs.existsSync(path.join(appDir, f)))) routes.push("/");
  walk(appDir, "");
  return [...new Set(routes)].sort();
}

/**
 * Resolve whether a route ends up noindexed, honouring Next.js metadata
 * inheritance: the route's own page/layout first, then each ancestor layout.
 * Only LAYOUTS inherit downward; an ancestor's page.tsx governs only itself.
 */
export function resolveNoindex(
  appDir: string,
  route: string,
): { noindex: boolean; via?: string } {
  const segments = route.replace(/^\/+/, "").split("/").filter(Boolean);
  for (let depth = segments.length; depth >= 0; depth--) {
    const dir = path.join(appDir, ...segments.slice(0, depth));
    const isExactRoute = depth === segments.length;
    const candidates = isExactRoute ? [...PAGE_FILES, ...LAYOUT_FILES] : [...LAYOUT_FILES];
    for (const file of candidates) {
      const abs = path.join(dir, file);
      if (declaresNoindex(abs)) {
        return { noindex: true, via: path.relative(appDir, abs) };
      }
    }
  }
  return { noindex: false };
}

/** Disallowed path prefixes declared in the site's robots source. */
export function readDisallowedPaths(robotsFile: string | null): string[] {
  if (!robotsFile || !fs.existsSync(robotsFile)) return [];
  const source = fs.readFileSync(robotsFile, "utf8");
  const found = new Set<string>();
  // Literal robots.txt lines.
  for (const m of source.matchAll(/^\s*Disallow:\s*(\S+)\s*$/gim)) {
    if (m[1] && m[1] !== "/") found.add(m[1]);
  }
  // A JS/TS array of paths, e.g. DISALLOWED_PATHS = ["/api/", "/auth/"].
  // Only read arrays whose variable name mentions disallow, so an unrelated
  // array of strings in the same file cannot leak in.
  for (const m of source.matchAll(
    /(?:disallow\w*)\s*(?::[^=]*)?=\s*\[([^\]]*)\]/gi,
  )) {
    for (const s of m[1].matchAll(/["'](\/[^"']*)["']/g)) {
      if (s[1] !== "/") found.add(s[1]);
    }
  }
  return [...found];
}

const isDynamic = (route: string): boolean => route.includes("[");

export function evaluateSource({ cwd }: { cwd: string }): IndexabilityScanResult {
  const checks: CheckResult[] = [];
  const appDir = firstExisting(cwd, APP_DIR_CANDIDATES);
  const configPath = firstExisting(cwd, GATE_CONFIG_CANDIDATES);

  if (!appDir) {
    checks.push({
      name: "appDirectory",
      pass: false,
      detail: `no app directory found (looked for ${APP_DIR_CANDIDATES.join(", ")})`,
    });
    return { pass: false, checks, routes: [] };
  }
  if (!configPath) {
    checks.push({
      name: "gateConfig",
      pass: false,
      detail: `no gate.config.json found (looked for ${GATE_CONFIG_CANDIDATES.join(", ")})`,
    });
    return { pass: false, checks, routes: [] };
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    routes?: string[];
    allowedOffSitemapRoutes?: string[];
    indexability?: IndexabilityConfig;
  };
  const declaredPublic = new Set(config.routes ?? []);
  const declaredOff = new Set(config.allowedOffSitemapRoutes ?? []);
  const allowUnclassified = new Set(config.indexability?.allowUnclassified ?? []);

  const robotsFile = firstExisting(cwd, ROBOTS_SOURCE_CANDIDATES);
  const disallowed = readDisallowedPaths(robotsFile);

  const all = listStaticRoutes(appDir).filter((r) => !isDynamic(r));
  const verdicts: RouteVerdict[] = [];

  const unclassified: string[] = [];
  const publicButNoindexed: string[] = [];
  const offButIndexable: string[] = [];
  const disallowPlusNoindex: string[] = [];

  for (const route of all) {
    const { noindex, via } = resolveNoindex(appDir, route);
    const classification: RouteVerdict["classification"] = declaredPublic.has(route)
      ? "public"
      : declaredOff.has(route)
        ? "off-sitemap"
        : "unclassified";
    verdicts.push({ route, indexable: !noindex, noindexVia: via, classification });

    if (classification === "public" && noindex) {
      publicButNoindexed.push(`${route} (noindex via ${via})`);
    } else if (classification === "off-sitemap" && !noindex) {
      offButIndexable.push(route);
    } else if (classification === "unclassified" && !allowUnclassified.has(route)) {
      unclassified.push(route);
    }

    // A rendering route whose noindex can never be read, because crawling is
    // blocked. Prefix match: Disallow: /auth/ covers /auth/login.
    if (
      noindex &&
      disallowed.some((d) => route === d.replace(/\/$/, "") || route.startsWith(d))
    ) {
      disallowPlusNoindex.push(route);
    }
  }

  checks.push({
    name: "classified",
    pass: unclassified.length === 0,
    detail:
      unclassified.length === 0
        ? `all ${all.length} static route(s) declared in gate.config.json`
        : `${unclassified.length} route(s) in neither routes nor allowedOffSitemapRoutes: ${unclassified.join(", ")}`,
  });
  checks.push({
    name: "publicRoutesIndexable",
    pass: publicButNoindexed.length === 0,
    detail:
      publicButNoindexed.length === 0
        ? `${declaredPublic.size} declared public route(s) carry no noindex`
        : `sitemapped route(s) declaring noindex: ${publicButNoindexed.join(", ")}`,
  });
  checks.push({
    name: "offSitemapNoindexed",
    pass: offButIndexable.length === 0,
    detail:
      offButIndexable.length === 0
        ? `${declaredOff.size} off-sitemap route(s) resolve to noindex`
        : `off-sitemap route(s) still indexable: ${offButIndexable.join(", ")}`,
  });
  checks.push({
    name: "noDisallowPlusNoindex",
    pass: disallowPlusNoindex.length === 0,
    detail:
      disallowPlusNoindex.length === 0
        ? disallowed.length === 0
          ? "no Disallow rules declared"
          : `no rendering route relies on noindex under a Disallow (${disallowed.join(", ")})`
        : `route(s) both Disallowed and noindexed; the Disallow prevents the noindex being read: ${disallowPlusNoindex.join(", ")}`,
  });

  return { pass: checks.every((c) => c.pass), checks, routes: verdicts };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const configPath = firstExisting(cwd, GATE_CONFIG_CANDIDATES);
  const config: IndexabilityConfig = configPath
    ? ((JSON.parse(fs.readFileSync(configPath, "utf8")).indexability ??
        {}) as IndexabilityConfig)
    : {};

  if (config.skip) {
    console.log(`gate:indexability-source  SKIP: ${config.skip}`);
    return;
  }

  console.log(`gate:indexability-source  cwd=${cwd}`);
  const { checks } = evaluateSource({ cwd });

  const toggles = config.checks ?? {};
  const filtered = checks.filter((c) => toggles[c.name] !== false);

  for (const check of filtered) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }

  const failed = filtered.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(
      `\ngate:indexability-source  FAIL: ${failed.length}/${filtered.length} invariant(s) violated`,
    );
    console.error(
      "Every route must be either indexable-and-sitemapped or noindexed-and-off-sitemap.",
    );
    console.error(
      "Declare the route in gate.config.json `routes`, or in `allowedOffSitemapRoutes` with a noindex.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `\ngate:indexability-source  PASS: ${filtered.length}/${filtered.length} source invariant(s) verified`,
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
