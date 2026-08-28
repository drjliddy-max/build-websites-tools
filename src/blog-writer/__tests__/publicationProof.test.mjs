// PUBLICATION_CONTRACT_V1.
//
// Fixtures are SHAPED on the real 2026-08-27/28 estate defects but pin MECHANISMS, not
// estate facts. No test asserts how many articles a site has, which taxonomy it uses, or
// a specific hero filename - those are evidence, not protocol, and encoding them would
// make the contract fail the next time the corpus legitimately changes.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluatePublication, evaluateHero,
  CLASSIFICATION, OUTCOME, MEDIA_STATE, CONTRACT_VERSION,
} from "../publicationProof.js";

/** A publication where every dimension is observed and correct. */
const healthy = (over = {}) => ({
  artifactCommitted: true, metadataValid: true, routeStatus: 200,
  expectedSlug: "an-article", renderedSlug: "an-article",
  expectedTitle: "An Article", renderedTitle: "An Article | Site",
  occurrenceKey: "lane:2026-01-01:1", artifactOccurrenceKey: "lane:2026-01-01:1",
  indexContainsArticle: true, discoverySurfaceReachable: true,
  mediaRequired: true, mediaPersisted: true,
  intendedHeroUrl: "/photos/an-article-1.jpg", renderedHeroUrl: "/photos/an-article-1.jpg",
  heroFetchStatus: 200, isFallbackHero: false,
  renderedBodyLength: 4200, sitemapContainsArticle: true,
  ...over,
});

test("A: a correct publication is PUBLISHED and proof-complete", () => {
  const r = evaluatePublication(healthy());
  assert.equal(r.classification, CLASSIFICATION.PUBLISHED);
  assert.equal(r.published, true);
  assert.equal(r.proofComplete, true);
  assert.equal(r.contract, CONTRACT_VERSION);
  assert.deepEqual(r.failedDimensions, []);
});

test("B: a quote-contaminated rendered hero is BROKEN_MEDIA, never PUBLISHED", () => {
  // siteclinic / bmj: the FILE served 200; the markup pointed at /%22...%22.
  const r = evaluatePublication(healthy({ renderedHeroUrl: '"/photos/an-article-1.jpg"' }));
  assert.equal(r.classification, CLASSIFICATION.PUBLISHED_BROKEN_MEDIA);
  assert.equal(r.published, false);
  assert.equal(r.dimensions.HERO_MEDIA_VALID.detail, MEDIA_STATE.BAD_PATH);
});

test("B2: a healthy hero FILE cannot rescue contaminated markup", () => {
  const r = evaluatePublication(healthy({ renderedHeroUrl: '"/p/x.jpg"', mediaPersisted: true, heroFetchStatus: 200 }));
  assert.equal(r.published, false, "persistence must not substitute for what the page references");
});

test("C: no hero in rendered markup is MISSING_MEDIA", () => {
  // liddy: renderer read a key the publisher does not emit.
  const r = evaluatePublication(healthy({ renderedHeroUrl: null }));
  assert.equal(r.classification, CLASSIFICATION.MISSING_MEDIA);
  assert.equal(r.dimensions.HERO_MEDIA_VALID.detail, MEDIA_STATE.MISSING);
});

test("D: route 200 but absent from the canonical index is NOT_INDEXED", () => {
  // ada: the article rendered fine and no index listed it.
  const r = evaluatePublication(healthy({ indexContainsArticle: false }));
  assert.equal(r.classification, CLASSIFICATION.NOT_INDEXED);
  assert.equal(r.published, false);
});

test("E: indexed but the surface is unreachable from navigation is NOT_DISCOVERABLE", () => {
  // jeffrystein: /blog listed the article; nothing linked to /blog.
  const r = evaluatePublication(healthy({ indexContainsArticle: true, discoverySurfaceReachable: false }));
  assert.equal(r.classification, CLASSIFICATION.NOT_DISCOVERABLE);
});

test("E2: INDEXED and DISCOVERABLE are independent, not one check", () => {
  const notIndexed = evaluatePublication(healthy({ indexContainsArticle: false, discoverySurfaceReachable: true }));
  const notDiscoverable = evaluatePublication(healthy({ indexContainsArticle: true, discoverySurfaceReachable: false }));
  assert.notEqual(notIndexed.classification, notDiscoverable.classification);
});

test("F: a fallback image rendering instead of the intended hero fails the proof", () => {
  const r = evaluatePublication(healthy({ isFallbackHero: true, renderedHeroUrl: "/og-default.jpg" }));
  assert.equal(r.published, false);
  assert.equal(r.dimensions.HERO_MEDIA_VALID.detail, MEDIA_STATE.WRONG_IDENTITY);
});

test("G: a 200 route rendering the WRONG article is ARTICLE_IDENTITY_INVALID", () => {
  const r = evaluatePublication(healthy({ renderedSlug: "some-other-article" }));
  assert.equal(r.classification, CLASSIFICATION.ARTICLE_IDENTITY_INVALID);
});

test("G2: an artifact belonging to a different occurrence fails identity", () => {
  const r = evaluatePublication(healthy({ artifactOccurrenceKey: "lane:2025-12-01:1" }));
  assert.equal(r.classification, CLASSIFICATION.ARTICLE_IDENTITY_INVALID);
});

test("H: an unmeasured REQUIRED dimension is PROOF_INCOMPLETE, never PUBLISHED", () => {
  for (const missing of ["indexContainsArticle", "discoverySurfaceReachable", "renderedBodyLength", "routeStatus"]) {
    const e = healthy(); delete e[missing];
    const r = evaluatePublication(e);
    assert.equal(r.published, false, `${missing} unmeasured must not be PUBLISHED`);
    assert.equal(r.classification, CLASSIFICATION.PROOF_INCOMPLETE, `${missing} should be PROOF_INCOMPLETE`);
    assert.ok(r.unknownDimensions.length > 0);
  }
});

test("H2: a MEASURED failure outranks an unmeasured dimension", () => {
  const e = healthy({ indexContainsArticle: false }); delete e.sitemapContainsArticle;
  const r = evaluatePublication(e);
  assert.equal(r.classification, CLASSIFICATION.NOT_INDEXED, "do not hide a real defect behind PROOF_INCOMPLETE");
});

test("I: a dimension declared NOT_APPLICABLE does not fail the publication", () => {
  const e = healthy(); delete e.discoverySurfaceReachable; delete e.sitemapContainsArticle;
  const r = evaluatePublication(e, { ARTICLE_DISCOVERABLE: false, SITEMAP_VALID: false });
  assert.equal(r.classification, CLASSIFICATION.PUBLISHED, "applicability must not be punished as absence");
  assert.equal(r.dimensions.ARTICLE_DISCOVERABLE.outcome, OUTCOME.NOT_APPLICABLE);
});

test("I2: media not required makes hero NOT_APPLICABLE rather than missing", () => {
  const e = healthy({ mediaRequired: false }); delete e.renderedHeroUrl; delete e.heroFetchStatus; delete e.mediaPersisted;
  const r = evaluatePublication(e);
  assert.equal(r.dimensions.HERO_MEDIA_VALID.outcome, OUTCOME.NOT_APPLICABLE);
  assert.equal(r.classification, CLASSIFICATION.PUBLISHED);
});

test("BOOK: proven generation failure is GENERATION_FAILED, not UNKNOWN", () => {
  const r = evaluatePublication({ generationFailed: true });
  assert.equal(r.classification, CLASSIFICATION.GENERATION_FAILED);
  assert.equal(r.published, false);
});

test("an optimizer-wrapped hero still matches the intended identity", () => {
  const h = evaluateHero({
    required: true,
    intendedHeroUrl: "/photos/x-1.jpg",
    renderedHeroUrl: "/_next/image?url=%2Fphotos%2Fx-1.jpg&w=3840&q=75",
    heroFetchStatus: 200, isFallback: false,
  });
  assert.equal(h.outcome, OUTCOME.PASS, "next/image wrapping is not wrong identity");
});

test("HTTP 200 alone is NOT sufficient for PUBLISHED", () => {
  const r = evaluatePublication({ routeStatus: 200 });
  assert.equal(r.published, false, "a 200 with nothing else observed must never be terminal success");
});
