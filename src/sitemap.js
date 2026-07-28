// Deterministic sitemap lastmod helpers for the build-websites-template fleet.
//
// WHY this exists: siteclinic.io shipped a sitemap where 33 of 54 URLs carried
// one identical timestamp - the moment of the last deploy - because sitemap.ts
// computed a single `new Date()` at build time and reused it for every entry.
// /privacy and /about claimed they had changed that morning; git said May and
// June. Twice-weekly blog-publish commits restamped the whole site as fresh.
//
// Google uses <lastmod> only while it is consistently and verifiably accurate,
// and discounts the signal site-wide once a sitemap over-reports freshness.
// That cost the property its only prioritization hint for the 35 URLs sitting
// in "Discovered - currently not indexed".
//
// THE LOCKED RULE, for every sitemap URL:
//
//     lastmod = the last substantive content change
//
// Build time, deploy time, process start time, framework execution time, and
// "current time for every route" are NOT valid sources on their own.
//
// Design: pure, deterministic, framework-agnostic, dependency-free. No
// Date.now() and no `new Date()` on the production path - output is a stable
// function of input, so two builds of unchanged content produce byte-identical
// sitemaps. A clock is accepted ONLY as an injected `now` for validation
// comparisons (is this date in the future?), never to manufacture a lastmod.
//
// This module is the single implementation of the rule. gate-seo imports the
// validators from here so the gate and the sites it polices cannot drift.

const MS_PER_MINUTE = 60_000;

// Defaults chosen to be safe for existing consumers: a site that already
// publishes honest dates passes without configuration. See README migration
// notes before tightening these in a consumer's gate.config.json.
export const SITEMAP_DEFAULTS = {
  requireLastModified: true,
  maxFutureSkewMinutes: 10,
  maxIdenticalLastmodCluster: 10,
  allowMissingLastmodRoutes: [],
  dynamicListingRoutes: [],
};

/*
 * A timestamp is "build-shaped" when it carries a time-of-day component with
 * sub-second precision - i.e. it was produced by `new Date()` at some instant
 * rather than declared as a content date.
 *
 * A content date is normally a calendar day: 2026-07-02T00:00:00.000Z. A build
 * stamp looks like 2026-07-23T08:15:38.802Z. This distinction is what lets the
 * cluster check stay quiet for a site that legitimately shipped forty pages on
 * one day, while still catching a site that stamps forty pages with one build
 * instant.
 */
export function isBuildShapedTimestamp(iso) {
  if (typeof iso !== "string") return false;
  const match = /T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(iso);
  if (!match) return false;
  const [, hh, mm, ss, ms] = match;
  const midnight = hh === "00" && mm === "00" && ss === "00";
  const hasSubSecond = typeof ms === "string" && Number(ms) !== 0;
  return !midnight || hasSubSecond;
}

function fail(message) {
  throw new Error(`build-websites-tools/sitemap: ${message}`);
}

function toDate(input, label) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      fail(`${label}: Date is Invalid Date`);
    }
    return input;
  }
  if (typeof input === "number") {
    const fromNumber = new Date(input);
    if (Number.isNaN(fromNumber.getTime())) {
      fail(`${label}: numeric timestamp ${input} is not a valid date`);
    }
    return fromNumber;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      fail(`${label}: empty string is not a date`);
    }
    // Bare calendar day -> UTC midnight, so a content date is timezone-stable
    // and never drifts a day depending on the build machine's zone.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    const parsed = new Date(dateOnly ? `${trimmed}T00:00:00.000Z` : trimmed);
    if (Number.isNaN(parsed.getTime())) {
      fail(`${label}: "${input}" is not a parseable date`);
    }
    return parsed;
  }
  return fail(
    `${label}: expected a Date, ISO string, or epoch number; received ${input === null ? "null" : typeof input}`,
  );
}

/**
 * Normalize any accepted date input to a deterministic ISO-8601 UTC string.
 *
 * Never returns "now". A missing value is an error, not a default - that is
 * the entire point of this module.
 */
export function normalizeIsoDate(input, label = "lastModified") {
  if (input === undefined || input === null) {
    fail(
      `${label} is required. Refusing to default to the current time - a build-time date is not a content date. Supply the route's last substantive content change, or configure an explicit fallbackLastModified.`,
    );
  }
  return toDate(input, label).toISOString();
}

/** Normalize to UTC midnight of the calendar day. Use for content dates. */
export function normalizeIsoDay(input, label = "lastModified") {
  const date = toDate(input, label);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString();
}

/**
 * Newest of a set of dates - the correct lastmod for a listing page such as
 * /blog, whose content genuinely changes when a child is published.
 *
 * Returns null for an empty set so the caller can fall back explicitly rather
 * than silently inheriting the current time.
 */
export function newestDate(inputs, label = "newestDate") {
  if (!Array.isArray(inputs) || inputs.length === 0) return null;
  let newest = null;
  for (const [index, input] of inputs.entries()) {
    if (input === undefined || input === null) continue;
    const date = toDate(input, `${label}[${index}]`);
    if (newest === null || date.getTime() > newest.getTime()) {
      newest = date;
    }
  }
  return newest === null ? null : newest.toISOString();
}

/**
 * Read a content date off a stored record, trying each field in order.
 *
 * This is the SUPPORTED way to derive freshness: `new Date(entry.updatedAt)`
 * parses stored content metadata and is explicitly allowed by the source gate.
 * What is prohibited is `new Date()` with no argument.
 */
export function contentDate(record, fields = ["updatedAt", "published", "date", "target_date"], label = "contentDate") {
  if (record === null || typeof record !== "object") {
    fail(`${label}: expected a content record object`);
  }
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== "") {
      return normalizeIsoDate(value, `${label}.${field}`);
    }
  }
  return null;
}

function joinUrl(baseUrl, routePath) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    fail("baseUrl is required and must be an absolute http(s) URL");
  }
  if (typeof routePath !== "string" || !routePath.startsWith("/")) {
    fail(`route path must be a string starting with "/", received ${JSON.stringify(routePath)}`);
  }
  const base = baseUrl.replace(/\/+$/, "");
  return routePath === "/" ? `${base}/` : `${base}${routePath}`;
}

/**
 * Build a deterministic, validated, stably-ordered sitemap entry list.
 *
 * routes: Array<{ path, lastModified?, changeFrequency?, priority?, children? }>
 *   - `lastModified` is the route's last substantive content change.
 *   - `children` (array of date inputs) derives a listing page's date from its
 *     newest child, which is the one place "recent" is legitimately true.
 *
 * fallbackLastModified: a stable, explicitly-declared date used when a route
 *   supplies none. Conservative by design: it under-reports freshness rather
 *   than lying. Omit it and a missing date is a loud build failure.
 */
export function defineSitemap({
  baseUrl,
  routes,
  fallbackLastModified,
  sortEntries = true,
} = {}) {
  if (!Array.isArray(routes) || routes.length === 0) {
    fail("routes must be a non-empty array of route metadata objects");
  }

  const normalizedFallback =
    fallbackLastModified === undefined || fallbackLastModified === null
      ? null
      : normalizeIsoDate(fallbackLastModified, "fallbackLastModified");

  const seen = new Map();
  const entries = routes.map((route, index) => {
    if (route === null || typeof route !== "object") {
      fail(`routes[${index}] must be an object`);
    }
    const routePath = route.path;
    const label = `routes[${index}] (${routePath ?? "unknown path"}).lastModified`;

    let lastModified;
    if (Array.isArray(route.children) && route.children.length > 0) {
      lastModified = newestDate(route.children, `${label}.children`);
    }
    if (!lastModified && route.lastModified !== undefined && route.lastModified !== null) {
      lastModified = normalizeIsoDate(route.lastModified, label);
    }
    if (!lastModified) {
      if (normalizedFallback === null) {
        fail(
          `${label} is missing and no fallbackLastModified was configured. Refusing to substitute the current time.`,
        );
      }
      lastModified = normalizedFallback;
    }

    const url = joinUrl(baseUrl, routePath);
    if (seen.has(url)) {
      fail(
        `duplicate sitemap URL ${url} (routes[${seen.get(url)}] and routes[${index}]). Each location may appear once.`,
      );
    }
    seen.set(url, index);

    const entry = { url, lastModified };
    if (route.changeFrequency !== undefined) entry.changeFrequency = route.changeFrequency;
    if (route.priority !== undefined) entry.priority = route.priority;
    return entry;
  });

  return sortEntries
    ? entries.sort((a, b) => a.url.localeCompare(b.url, "en"))
    : entries;
}

/** Convert entries to the Next.js MetadataRoute.Sitemap shape (Date objects). */
export function toNextSitemap(entries) {
  return entries.map((entry) => ({
    ...entry,
    lastModified: new Date(entry.lastModified),
  }));
}

// ─── Validation utilities (shared with gate-seo) ─────────────────────

/**
 * Validate a parsed sitemap against the lastmod standard.
 *
 * `entries` is Array<{ url, lastModified?, changeFrequency?, priority? }> as
 * produced either by defineSitemap() or by the gate's XML parser.
 *
 * `now` is injected so this is deterministic under test. It is used ONLY to
 * decide whether a declared date lies in the future.
 *
 * Returns { pass, issues: Array<{ code, message, urls }> }.
 */
export function validateSitemapEntries(entries, options = {}) {
  const {
    now = new Date(),
    requireLastModified = SITEMAP_DEFAULTS.requireLastModified,
    maxFutureSkewMinutes = SITEMAP_DEFAULTS.maxFutureSkewMinutes,
    maxIdenticalLastmodCluster = SITEMAP_DEFAULTS.maxIdenticalLastmodCluster,
    allowMissingLastmodRoutes = SITEMAP_DEFAULTS.allowMissingLastmodRoutes,
    dynamicListingRoutes = SITEMAP_DEFAULTS.dynamicListingRoutes,
  } = options;

  const issues = [];
  const allowMissing = new Set(allowMissingLastmodRoutes);
  const listingRoutes = new Set(dynamicListingRoutes);
  const nowMs = toDate(now, "now").getTime();
  const skewMs = maxFutureSkewMinutes * MS_PER_MINUTE;

  const pathOf = (url) => {
    try {
      const { pathname } = new URL(url);
      return pathname.length > 1 ? pathname.replace(/\/+$/, "") : "/";
    } catch {
      return url;
    }
  };

  // 4. Duplicate sitemap locations
  const byUrl = new Map();
  for (const entry of entries) {
    byUrl.set(entry.url, (byUrl.get(entry.url) ?? 0) + 1);
  }
  const duplicates = [...byUrl.entries()].filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    issues.push({
      code: "duplicate-loc",
      message: `${duplicates.length} sitemap location(s) appear more than once. Each <loc> must be unique.`,
      urls: duplicates.map(([url, count]) => `${url} (x${count})`),
    });
  }

  const missing = [];
  const invalid = [];
  const future = [];
  const valid = [];

  for (const entry of entries) {
    const routePath = pathOf(entry.url);
    const raw = entry.lastModified;

    // 3. Missing lastmod where the standard requires it
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      if (requireLastModified && !allowMissing.has(routePath)) {
        missing.push(entry.url);
      }
      continue;
    }

    // 1. Invalid lastmod values
    const parsed = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(String(raw).trim())
        ? `${String(raw).trim()}T00:00:00.000Z`
        : String(raw).trim(),
    );
    if (Number.isNaN(parsed.getTime())) {
      invalid.push(`${entry.url} → lastmod=${JSON.stringify(raw)}`);
      continue;
    }

    // 2. Future lastmod beyond clock tolerance
    if (parsed.getTime() > nowMs + skewMs) {
      const aheadMin = Math.round((parsed.getTime() - nowMs) / MS_PER_MINUTE);
      future.push(
        `${entry.url} → lastmod=${String(raw)} (${aheadMin} min ahead of now, tolerance ${maxFutureSkewMinutes} min)`,
      );
      continue;
    }

    valid.push({ url: entry.url, routePath, iso: parsed.toISOString(), raw: String(raw).trim() });
  }

  if (missing.length > 0) {
    issues.push({
      code: "missing-lastmod",
      message: `${missing.length} sitemap URL(s) have no <lastmod>. The standard requires a content date on every URL; allowlist genuinely dateless routes via sitemap.allowMissingLastmodRoutes.`,
      urls: missing,
    });
  }
  if (invalid.length > 0) {
    issues.push({
      code: "invalid-lastmod",
      message: `${invalid.length} sitemap URL(s) have an unparseable <lastmod>. Use ISO-8601 (YYYY-MM-DD or a full timestamp).`,
      urls: invalid,
    });
  }
  if (future.length > 0) {
    issues.push({
      code: "future-lastmod",
      message: `${future.length} sitemap URL(s) declare a <lastmod> in the future. A page cannot have been modified after now.`,
      urls: future,
    });
  }

  // 5 + 6. Build-time stamp detection.
  //
  // Two distinct shapes, deliberately separated so the diagnostics tell the
  // operator which defect they have:
  //
  //   build-time-cluster  - N unrelated routes share ONE build-shaped instant.
  //                         This is `const now = new Date()` reused per route.
  //   build-time-smear    - N unrelated routes carry DIFFERENT but build-shaped
  //                         instants inside one narrow window. This is
  //                         `new Date()` re-evaluated per route in one build.
  //
  // Listing routes are excluded from both: their date legitimately tracks the
  // newest child and may coincide with a recent publish.
  const clusterCandidates = valid.filter(
    (item) => !listingRoutes.has(item.routePath),
  );

  const byTimestamp = new Map();
  for (const item of clusterCandidates) {
    if (!byTimestamp.has(item.iso)) byTimestamp.set(item.iso, []);
    byTimestamp.get(item.iso).push(item.url);
  }

  for (const [iso, urls] of byTimestamp.entries()) {
    if (urls.length <= maxIdenticalLastmodCluster) continue;
    // A shared calendar day is plausible (a site really can ship 40 pages on
    // one day). A shared sub-second instant is a build stamp, always.
    const buildShaped = isBuildShapedTimestamp(iso);
    issues.push({
      code: buildShaped ? "build-time-cluster" : "suspicious-lastmod-cluster",
      message: buildShaped
        ? `${urls.length} unrelated routes share the build-shaped timestamp ${iso}. This is a single build-time date applied to every route, not a content date. Give each route its own last-content-change date (see build-websites-tools/sitemap).`
        : `${urls.length} routes share the identical date ${iso}, above the configured maxIdenticalLastmodCluster of ${maxIdenticalLastmodCluster}. If these genuinely changed together, raise the threshold in gate.config.json; otherwise give each route its real content date.`,
      urls: urls.slice(0, 25),
    });
  }

  const buildShapedItems = clusterCandidates.filter((item) =>
    isBuildShapedTimestamp(item.iso),
  );
  if (buildShapedItems.length > maxIdenticalLastmodCluster) {
    const times = buildShapedItems
      .map((item) => new Date(item.iso).getTime())
      .sort((a, b) => a - b);
    const spreadMs = times[times.length - 1] - times[0];
    const distinct = new Set(buildShapedItems.map((item) => item.iso)).size;
    // Only report the smear when the timestamps are NOT all identical - the
    // identical case is already reported above as build-time-cluster.
    if (distinct > 1 && spreadMs <= 10 * MS_PER_MINUTE) {
      issues.push({
        code: "build-time-smear",
        message: `${buildShapedItems.length} unrelated routes carry ${distinct} distinct build-shaped timestamps spanning only ${Math.round(spreadMs / 1000)}s. That window is one build, not ${distinct} content changes. Replace per-route \`new Date()\` with declared content dates.`,
        urls: buildShapedItems.slice(0, 25).map((item) => `${item.url} → ${item.raw}`),
      });
    }
  }

  return { pass: issues.length === 0, issues };
}
