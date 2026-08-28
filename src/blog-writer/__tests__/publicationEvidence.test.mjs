// Slice B: declared surfaces -> evidence. Pins MECHANISM, not estate facts: no test
// asserts a site's article count, taxonomy, or a hero filename.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateEvidenceDeclaration, resolveEvidencePlan, extractRenderedHero,
  collectPublicationEvidence, EvidenceDeclarationError,
} from "../publicationEvidence.js";
import { evaluatePublication, CLASSIFICATION } from "../publicationProof.js";

const site = (over = {}) => ({
  siteId: "a-site", domain: "example.com", blogPath: "/blog",
  publicationEvidence: {
    contract: "PUBLICATION_CONTRACT_V1",
    indexSurface: { path: "/blog" },
    discoverySurface: { path: "/", mustLinkTo: "/blog" },
    sitemap: { path: "/sitemap.xml" },
    heroEvidence: { source: "rendered-markup", fallbackMarkers: ["/og-default.jpg"] },
    applicability: {},
    ...over,
  },
});

const fetcher = (pages) => async (url) => {
  if (!(url in pages)) throw new Error(`no route ${url}`);
  const p = pages[url];
  return { status: p.status ?? 200, text: async () => p.body ?? "" };
};

test("a missing declaration is refused, not defaulted", () => {
  assert.throws(() => validateEvidenceDeclaration({ siteId: "x" }), EvidenceDeclarationError);
});

test("an applicable dimension with no declared surface is refused", () => {
  const s = site({ indexSurface: undefined });
  assert.throws(() => validateEvidenceDeclaration(s), /ARTICLE_INDEXED is applicable but indexSurface/);
});

test("a NOT_APPLICABLE dimension that still declares a surface is refused as contradictory", () => {
  const s = site({ applicability: { SITEMAP_VALID: false } });
  assert.throws(() => validateEvidenceDeclaration(s), /NOT_APPLICABLE but sitemap/);
});

test("a structural dimension cannot be declared inapplicable", () => {
  const s = site({ applicability: { RENDER_VALID: false } });
  assert.throws(() => validateEvidenceDeclaration(s), /structural/);
});

test("hero extraction handles the three real shapes without flattening them", () => {
  const rel = extractRenderedHero('<img src="/photos/x-1.jpg">');
  const abs = extractRenderedHero('<img src="https://d.com/photos/x-1.jpg">');
  const nxt = extractRenderedHero('<img src="/_next/image?url=%2Fphotos%2Fx-1.jpg&amp;w=3840">');
  assert.equal(rel.url, "/photos/x-1.jpg");
  assert.equal(abs.url, "https://d.com/photos/x-1.jpg");
  assert.ok(nxt.url.includes("%2Fphotos%2Fx-1.jpg"), "optimizer wrapping is preserved, not normalized away");
});

test("observed-absent hero is null; not-observed is undefined", () => {
  assert.equal(extractRenderedHero("<p>no images</p>"), null);
  assert.equal(extractRenderedHero(undefined), undefined);
});

test("a declared fallback marker is reported as a fallback, not as the intended hero", () => {
  const h = extractRenderedHero('<img src="/photos/og-default.jpg">', { fallbackMarkers: ["og-default.jpg"] });
  assert.equal(h.isFallback, true);
});

test("collection produces evidence the contract accepts end to end", async () => {
  const plan = resolveEvidencePlan(site(), { slug: "an-article" });
  const ev = await collectPublicationEvidence(plan, {
    expectedTitle: "An Article",
    fetchImpl: fetcher({
      "https://example.com/blog/an-article": { body: '<title>An Article | S</title><img src="/photos/an-article-1.jpg">body text' },
      "https://example.com/blog": { body: '<a href="/blog/an-article">An Article</a>' },
      "https://example.com/": { body: '<a href="/blog">Blog</a>' },
      "https://example.com/sitemap.xml": { body: "<loc>https://example.com/blog/an-article</loc>" },
    }),
  });
  assert.equal(ev.indexContainsArticle, true);
  assert.equal(ev.discoverySurfaceReachable, true);
  assert.equal(ev.sitemapContainsArticle, true);
  const verdict = evaluatePublication(
    { ...ev, artifactCommitted: true, metadataValid: true, expectedSlug: "an-article", renderedSlug: "an-article",
      mediaRequired: true, mediaPersisted: true, intendedHeroUrl: "/photos/an-article-1.jpg", heroFetchStatus: 200 },
    plan.applicability,
  );
  assert.equal(verdict.classification, CLASSIFICATION.PUBLISHED);
});

test("A FETCH FAILURE IS UNKNOWN, NEVER ABSENT - the whole point of failing closed", async () => {
  const plan = resolveEvidencePlan(site(), { slug: "an-article" });
  const ev = await collectPublicationEvidence(plan, {
    fetchImpl: fetcher({ "https://example.com/blog/an-article": { body: "<title>T</title><img src=\"/photos/a-1.jpg\">x" } }),
  });
  assert.equal(ev.indexContainsArticle, undefined, "an unreachable index must not read as 'not indexed'");
  assert.equal(ev.discoverySurfaceReachable, undefined);
  const verdict = evaluatePublication({ ...ev, artifactCommitted: true, metadataValid: true, mediaRequired: false }, plan.applicability);
  assert.notEqual(verdict.classification, CLASSIFICATION.NOT_INDEXED, "do not accuse a site because we could not look");
  assert.equal(verdict.published, false);
});

test("a declared-inapplicable dimension is not collected and does not fail the verdict", async () => {
  const s = site({ sitemap: undefined, applicability: { SITEMAP_VALID: false } });
  const plan = resolveEvidencePlan(s, { slug: "an-article" });
  assert.equal(plan.sitemapUrl, null);
  const ev = await collectPublicationEvidence(plan, {
    fetchImpl: fetcher({
      "https://example.com/blog/an-article": { body: '<title>T</title><img src="/photos/a-1.jpg">x' },
      "https://example.com/blog": { body: '<a href="/blog/an-article">x</a>' },
      "https://example.com/": { body: '<a href="/blog">Blog</a>' },
    }),
  });
  assert.equal(ev.sitemapContainsArticle, undefined);
  const verdict = evaluatePublication(
    { ...ev, artifactCommitted: true, metadataValid: true, expectedSlug: "an-article", renderedSlug: "an-article",
      mediaRequired: true, mediaPersisted: true, intendedHeroUrl: "/photos/a-1.jpg", heroFetchStatus: 200 },
    plan.applicability,
  );
  assert.equal(verdict.classification, CLASSIFICATION.PUBLISHED, "declared inapplicability is a pass, not a gap");
});

test("the jeffrystein shape: indexed but nav does not link the surface", async () => {
  const plan = resolveEvidencePlan(site(), { slug: "an-article" });
  const ev = await collectPublicationEvidence(plan, {
    fetchImpl: fetcher({
      "https://example.com/blog/an-article": { body: '<title>T</title><img src="/photos/a-1.jpg">x' },
      "https://example.com/blog": { body: '<a href="/blog/an-article">x</a>' },
      "https://example.com/": { body: '<a href="/about">About</a>' },
      "https://example.com/sitemap.xml": { body: "<loc>/blog/an-article</loc>" },
    }),
  });
  assert.equal(ev.indexContainsArticle, true);
  assert.equal(ev.discoverySurfaceReachable, false, "observed-absent, not unknown");
});
