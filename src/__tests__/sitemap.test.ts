/*
 * Contract for the deterministic sitemap lastmod helpers.
 *
 * These back the portfolio-wide rule that lastmod is the last substantive
 * content change, never a build/deploy/process timestamp. The regression that
 * motivated them: siteclinic.io shipped 33 of 54 URLs carrying one identical
 * build instant, and Google stopped trusting the signal.
 *
 * Determinism is the point, so every test injects `now` rather than reading a
 * clock. A test that passes only "today" would be exactly the defect we police.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SITEMAP_DEFAULTS,
  isBuildShapedTimestamp,
  normalizeIsoDate,
  normalizeIsoDay,
  newestDate,
  contentDate,
  defineSitemap,
  toNextSitemap,
  validateSitemapEntries,
} from "../sitemap.js";
import type { RouteMeta, ParsedSitemapEntry } from "../sitemap.js";

const NOW = "2026-07-27T12:00:00.000Z";
const BASE = "https://example.com";

// ─── normalization ───────────────────────────────────────────────────

test("normalizeIsoDate accepts a calendar day and pins it to UTC midnight", () => {
  assert.equal(normalizeIsoDate("2026-07-02"), "2026-07-02T00:00:00.000Z");
});

test("normalizeIsoDate accepts Date and epoch inputs", () => {
  assert.equal(
    normalizeIsoDate(new Date("2026-07-02T00:00:00.000Z")),
    "2026-07-02T00:00:00.000Z",
  );
  assert.equal(
    normalizeIsoDate(Date.UTC(2026, 6, 2)),
    "2026-07-02T00:00:00.000Z",
  );
});

test("normalizeIsoDate REFUSES to default a missing value to now", () => {
  // The whole point of the module: absence is an error, never a silent clock read.
  assert.throws(() => normalizeIsoDate(undefined as never), /Refusing to default to the current time/);
  assert.throws(() => normalizeIsoDate(null as never), /Refusing to default to the current time/);
});

test("normalizeIsoDate rejects malformed input loudly", () => {
  assert.throws(() => normalizeIsoDate("not-a-date"), /not a parseable date/);
  assert.throws(() => normalizeIsoDate(""), /empty string/);
  assert.throws(() => normalizeIsoDate(new Date("nope")), /Invalid Date/);
});

test("normalizeIsoDay collapses a timestamp to its calendar day", () => {
  assert.equal(
    normalizeIsoDay("2026-07-23T08:15:38.802Z"),
    "2026-07-23T00:00:00.000Z",
  );
});

// ─── build-shape detection ───────────────────────────────────────────

test("isBuildShapedTimestamp separates content days from build instants", () => {
  assert.equal(isBuildShapedTimestamp("2026-07-02T00:00:00.000Z"), false);
  // the real siteclinic.io build stamp
  assert.equal(isBuildShapedTimestamp("2026-07-23T08:15:38.802Z"), true);
  assert.equal(isBuildShapedTimestamp("2026-07-23T00:00:00.500Z"), true);
  assert.equal(isBuildShapedTimestamp("2026-07-23T09:00:00.000Z"), true);
});

// ─── newest-child derivation ─────────────────────────────────────────

test("newestDate picks the newest child for a listing page", () => {
  assert.equal(
    newestDate(["2026-05-08", "2026-07-16", "2026-06-25"]),
    "2026-07-16T00:00:00.000Z",
  );
});

test("newestDate returns null for an empty set instead of inventing a date", () => {
  assert.equal(newestDate([]), null);
});

// ─── stored content metadata ─────────────────────────────────────────

test("contentDate reads stored content metadata in field order", () => {
  assert.equal(
    contentDate({ published: "2026-07-14", target_date: "2026-07-01" }),
    "2026-07-14T00:00:00.000Z",
  );
  // falls through empty/missing fields
  assert.equal(
    contentDate({ published: "", target_date: "2026-07-01" }),
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(contentDate({ unrelated: 1 }), null);
});

// ─── defineSitemap: static route metadata ────────────────────────────

test("defineSitemap emits deterministic, stably-ordered entries", () => {
  const routes: RouteMeta[] = [
    { path: "/pricing", lastModified: "2026-07-04", priority: 0.9 },
    { path: "/", lastModified: "2026-07-09", changeFrequency: "weekly", priority: 1 },
    { path: "/about", lastModified: "2026-05-12" },
  ];
  const first = defineSitemap({ baseUrl: BASE, routes });
  const second = defineSitemap({ baseUrl: BASE, routes });

  assert.deepEqual(first, second, "same input must produce identical output");
  assert.deepEqual(
    first.map((e) => e.url),
    [`${BASE}/`, `${BASE}/about`, `${BASE}/pricing`],
    "entries are sorted for byte-stable output",
  );
  assert.equal(first[0].lastModified, "2026-07-09T00:00:00.000Z");
  assert.equal(first[0].priority, 1);
  assert.equal(first[0].changeFrequency, "weekly");
});

test("defineSitemap derives a listing date from its newest child", () => {
  const entries = defineSitemap({
    baseUrl: BASE,
    routes: [
      { path: "/", lastModified: "2026-01-01" },
      { path: "/blog", children: ["2026-05-08", "2026-07-16", "2026-06-25"] },
    ],
  });
  const blog = entries.find((e) => e.url === `${BASE}/blog`);
  assert.equal(blog?.lastModified, "2026-07-16T00:00:00.000Z");
});

test("defineSitemap uses the conservative fallback when a route has no date", () => {
  const entries = defineSitemap({
    baseUrl: BASE,
    routes: [{ path: "/" }, { path: "/about", lastModified: "2026-06-01" }],
    fallbackLastModified: "2026-05-12",
  });
  assert.equal(
    entries.find((e) => e.url === `${BASE}/`)?.lastModified,
    "2026-05-12T00:00:00.000Z",
  );
});

test("defineSitemap fails loudly when a date is missing and no fallback is set", () => {
  assert.throws(
    () => defineSitemap({ baseUrl: BASE, routes: [{ path: "/" }] }),
    /Refusing to substitute the current time/,
  );
});

test("defineSitemap rejects a duplicate location", () => {
  assert.throws(
    () =>
      defineSitemap({
        baseUrl: BASE,
        routes: [
          { path: "/about", lastModified: "2026-06-01" },
          { path: "/about", lastModified: "2026-06-02" },
        ],
      }),
    /duplicate sitemap URL/,
  );
});

test("toNextSitemap hands Next.js real Date objects", () => {
  const [entry] = toNextSitemap(
    defineSitemap({ baseUrl: BASE, routes: [{ path: "/", lastModified: "2026-07-09" }] }),
  );
  assert.ok(entry.lastModified instanceof Date);
  assert.equal(entry.lastModified.toISOString(), "2026-07-09T00:00:00.000Z");
});

// ─── validation ──────────────────────────────────────────────────────

function entries(list: ParsedSitemapEntry[]): ParsedSitemapEntry[] {
  return list;
}

test("validateSitemapEntries passes a truthful sitemap", () => {
  const result = validateSitemapEntries(
    entries([
      { url: `${BASE}/`, lastModified: "2026-07-09T00:00:00.000Z" },
      { url: `${BASE}/about`, lastModified: "2026-05-12T00:00:00.000Z" },
      { url: `${BASE}/pricing`, lastModified: "2026-07-04T00:00:00.000Z" },
    ]),
    { now: NOW },
  );
  assert.equal(result.pass, true, JSON.stringify(result.issues));
});

test("validateSitemapEntries flags an absent lastmod", () => {
  const result = validateSitemapEntries(
    entries([{ url: `${BASE}/`, lastModified: null }]),
    { now: NOW },
  );
  assert.equal(result.pass, false);
  assert.equal(result.issues[0].code, "missing-lastmod");
  assert.ok(result.issues[0].urls[0].includes("/"));
});

test("validateSitemapEntries honours allowMissingLastmodRoutes", () => {
  const result = validateSitemapEntries(
    entries([{ url: `${BASE}/legacy`, lastModified: null }]),
    { now: NOW, allowMissingLastmodRoutes: ["/legacy"] },
  );
  assert.equal(result.pass, true);
});

test("validateSitemapEntries flags a malformed lastmod with the exact value", () => {
  const result = validateSitemapEntries(
    entries([{ url: `${BASE}/about`, lastModified: "last tuesday" }]),
    { now: NOW },
  );
  assert.equal(result.issues[0].code, "invalid-lastmod");
  assert.ok(result.issues[0].urls[0].includes("last tuesday"));
});

test("validateSitemapEntries flags a future lastmod beyond skew but tolerates small skew", () => {
  const beyond = validateSitemapEntries(
    entries([{ url: `${BASE}/about`, lastModified: "2026-08-01T00:00:00.000Z" }]),
    { now: NOW, maxFutureSkewMinutes: 10 },
  );
  assert.equal(beyond.issues[0].code, "future-lastmod");
  assert.ok(beyond.issues[0].urls[0].includes("ahead of now"));

  const withinSkew = validateSitemapEntries(
    entries([{ url: `${BASE}/about`, lastModified: "2026-07-27T12:05:00.000Z" }]),
    { now: NOW, maxFutureSkewMinutes: 10 },
  );
  assert.equal(withinSkew.pass, true, "clock skew inside tolerance must not fail a build");
});

test("validateSitemapEntries flags duplicate locations", () => {
  const result = validateSitemapEntries(
    entries([
      { url: `${BASE}/about`, lastModified: "2026-05-12" },
      { url: `${BASE}/about`, lastModified: "2026-05-12" },
    ]),
    { now: NOW },
  );
  assert.ok(result.issues.some((i) => i.code === "duplicate-loc"));
});

test("truthful identical calendar dates do NOT trip the build-time cluster check", () => {
  // A site really can ship 8 pages on one day. That is honest, and quiet.
  const list = Array.from({ length: 8 }, (_, i) => ({
    url: `${BASE}/page-${i}`,
    lastModified: "2026-06-07T00:00:00.000Z",
  }));
  const result = validateSitemapEntries(entries(list), { now: NOW });
  assert.equal(result.pass, true, JSON.stringify(result.issues));
});

test("a large truthful identical-date group reports the tunable cluster code, not build-time", () => {
  const list = Array.from({ length: 15 }, (_, i) => ({
    url: `${BASE}/page-${i}`,
    lastModified: "2026-06-07T00:00:00.000Z",
  }));
  const result = validateSitemapEntries(entries(list), { now: NOW });
  const issue = result.issues.find((i) => i.code === "suspicious-lastmod-cluster");
  assert.ok(issue, "a 15-wide identical-day group is worth surfacing");
  assert.ok(issue!.message.includes("raise the threshold"), "must offer the config escape hatch");
});

test("a shared build instant is caught as build-time-cluster", () => {
  // The exact siteclinic.io defect: one `new Date()` reused across routes.
  const list = Array.from({ length: 12 }, (_, i) => ({
    url: `${BASE}/page-${i}`,
    lastModified: "2026-07-23T08:15:38.802Z",
  }));
  const result = validateSitemapEntries(entries(list), { now: NOW });
  const issue = result.issues.find((i) => i.code === "build-time-cluster");
  assert.ok(issue, "12 routes sharing a sub-second instant is a build stamp");
  assert.ok(issue!.message.includes("not a content date"));
});

test("per-route new Date() in one build is caught as build-time-smear", () => {
  // Distinct timestamps, but all inside one build window.
  const list = Array.from({ length: 12 }, (_, i) => ({
    url: `${BASE}/page-${i}`,
    lastModified: `2026-07-23T08:15:${String(30 + i).padStart(2, "0")}.100Z`,
  }));
  const result = validateSitemapEntries(entries(list), { now: NOW });
  const issue = result.issues.find((i) => i.code === "build-time-smear");
  assert.ok(issue, "12 distinct instants spanning seconds is one build, not 12 edits");
  assert.ok(issue!.message.includes("one build"));
});

test("dynamicListingRoutes are exempt from cluster detection", () => {
  const list = [
    ...Array.from({ length: 12 }, (_, i) => ({
      url: `${BASE}/page-${i}`,
      lastModified: `2026-0${(i % 6) + 1}-0${(i % 8) + 1}T00:00:00.000Z`,
    })),
    { url: `${BASE}/blog`, lastModified: "2026-07-23T08:15:38.802Z" },
  ];
  const result = validateSitemapEntries(entries(list), {
    now: NOW,
    dynamicListingRoutes: ["/blog"],
  });
  assert.equal(result.pass, true, JSON.stringify(result.issues));
});

test("SITEMAP_DEFAULTS are the documented safe defaults", () => {
  assert.equal(SITEMAP_DEFAULTS.requireLastModified, true);
  assert.equal(SITEMAP_DEFAULTS.maxFutureSkewMinutes, 10);
  assert.equal(SITEMAP_DEFAULTS.maxIdenticalLastmodCluster, 10);
});
