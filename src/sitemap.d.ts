// Type declarations for sitemap.js - deterministic sitemap lastmod helpers.
// See sitemap.js for behaviour and rationale.
//
// The locked rule: lastmod = the last substantive content change. Build time,
// deploy time, process start time, and framework execution time are not valid
// sources on their own.

/** Anything this module will accept as a date input. */
export type DateInput = Date | string | number;

export type ChangeFrequency =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

/** Typed metadata for one route in a site's sitemap. */
export interface RouteMeta {
  /** Path starting with "/". */
  path: string;
  /**
   * The route's last substantive content change. Required unless the route
   * supplies `children`, or `fallbackLastModified` is configured.
   */
  lastModified?: DateInput;
  /**
   * Child content dates for a listing page (e.g. /blog). The newest wins.
   * This is the one place where "recent" is legitimately true.
   */
  children?: DateInput[];
  changeFrequency?: ChangeFrequency;
  priority?: number;
}

/** A normalized, deterministic sitemap entry. `lastModified` is ISO-8601 UTC. */
export interface SitemapEntry {
  url: string;
  lastModified: string;
  changeFrequency?: ChangeFrequency;
  priority?: number;
}

/** Entry shape accepted by the validators (gate-parsed sitemaps may lack dates). */
export interface ParsedSitemapEntry {
  url: string;
  lastModified?: string | null;
  changeFrequency?: string | null;
  priority?: string | number | null;
}

export interface DefineSitemapOptions {
  /** Absolute origin, e.g. "https://example.com". */
  baseUrl: string;
  routes: RouteMeta[];
  /**
   * Stable, explicitly-declared date used when a route supplies none.
   * Conservative by design: under-reports freshness rather than lying.
   * Omit it and a missing date becomes a loud build failure.
   */
  fallbackLastModified?: DateInput;
  /** Sort entries by URL for byte-stable output. Default true. */
  sortEntries?: boolean;
}

export interface SitemapValidationIssue {
  code:
    | "duplicate-loc"
    | "missing-lastmod"
    | "invalid-lastmod"
    | "future-lastmod"
    | "build-time-cluster"
    | "build-time-smear"
    | "suspicious-lastmod-cluster";
  message: string;
  urls: string[];
}

export interface SitemapValidationOptions {
  /** Injected for determinism under test. Used only for future-date checks. */
  now?: DateInput;
  requireLastModified?: boolean;
  maxFutureSkewMinutes?: number;
  maxIdenticalLastmodCluster?: number;
  /** Route paths permitted to omit lastmod. */
  allowMissingLastmodRoutes?: string[];
  /** Listing routes whose date legitimately tracks their newest child. */
  dynamicListingRoutes?: string[];
}

export interface SitemapValidationResult {
  pass: boolean;
  issues: SitemapValidationIssue[];
}

export const SITEMAP_DEFAULTS: Required<
  Pick<
    SitemapValidationOptions,
    | "requireLastModified"
    | "maxFutureSkewMinutes"
    | "maxIdenticalLastmodCluster"
    | "allowMissingLastmodRoutes"
    | "dynamicListingRoutes"
  >
>;

/**
 * True when the timestamp carries a time-of-day or sub-second component,
 * i.e. it was produced by `new Date()` at an instant rather than declared as
 * a calendar content date.
 */
export function isBuildShapedTimestamp(iso: string): boolean;

/**
 * Normalize to deterministic ISO-8601 UTC. Throws on a missing or unparseable
 * value - it never substitutes the current time.
 */
export function normalizeIsoDate(input: DateInput, label?: string): string;

/** Normalize to UTC midnight of the calendar day. Use for content dates. */
export function normalizeIsoDay(input: DateInput, label?: string): string;

/** Newest of a set of dates, or null when the set is empty. */
export function newestDate(inputs: DateInput[], label?: string): string | null;

/**
 * Read a content date off a stored record, trying each field in order.
 * This is the supported freshness source: parsing stored content metadata.
 */
export function contentDate(
  record: Record<string, unknown>,
  fields?: string[],
  label?: string,
): string | null;

/** Build a deterministic, validated, stably-ordered sitemap entry list. */
export function defineSitemap(options: DefineSitemapOptions): SitemapEntry[];

/** Convert entries to the Next.js MetadataRoute.Sitemap shape. */
export function toNextSitemap(
  entries: SitemapEntry[],
): Array<Omit<SitemapEntry, "lastModified"> & { lastModified: Date }>;

/** Validate a parsed sitemap against the lastmod standard. */
export function validateSitemapEntries(
  entries: ParsedSitemapEntry[],
  options?: SitemapValidationOptions,
): SitemapValidationResult;
