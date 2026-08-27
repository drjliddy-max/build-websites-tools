// BLOG_ARTICLE_PUBLICATION_CONTRACT v1 - the canonical article-data contract.
//
// Every case below is pinned to REAL production state from 2026-08-27, not to a
// synthetic happy path. The four "the defect" cases fail against the five divergent
// consumer parsers that shipped before v0.28.4; that is the point of pinning them
// here, in the shared implementation, where they can only be broken once.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArticleFrontmatter,
  resolveHeroImage,
  validateArticleAttributes,
  CANONICAL_HERO_KEY,
} from "../article.js";

// Verbatim head of
// siteclinic-web/.siteclinic/automation/blog-writer-siteclinic/drafts/
//   website-operations-monitoring-building-a-weekly-rhythm.md @ 36f5940
const REAL_DRAFT = `---
title: "Website Operations Monitoring: Building a Weekly Rhythm"
slug: "website-operations-monitoring-building-a-weekly-rhythm"
description: "Website operations monitoring only works as a routine."
target_date: "2026-08-27"
keywords: ["website operations monitoring"]
image_url: "/photos/website-operations-monitoring-building-a-weekly-rhythm-5424636.jpg"
image_alt: "Crop anonymous male designer in casual wear sitting at table"
image_provider: "pexels"
image_credit: "Amina Filkins"
---

Most small business owners think of website operations monitoring as a tool.`;

test("THE DEFECT: surrounding YAML quotes are stripped from every value", () => {
  const { attributes } = parseArticleFrontmatter(REAL_DRAFT);
  // Pre-v0.28.4 siteclinic/bmj/liddy parsers returned the quoted form here, which
  // rendered as src="&quot;/photos/...&quot;" -> /%22/photos/...%22 -> 404.
  assert.equal(
    attributes.image_url,
    "/photos/website-operations-monitoring-building-a-weekly-rhythm-5424636.jpg",
  );
  assert.equal(attributes.title, "Website Operations Monitoring: Building a Weekly Rhythm");
  assert.ok(!attributes.image_url.includes('"'), "no quote may survive into a URL");
});

test("a colon inside a quoted title does not truncate the value", () => {
  const { attributes } = parseArticleFrontmatter(REAL_DRAFT);
  assert.ok(attributes.title.includes(":"), "title keeps its colon");
});

test("body is returned separately and intact", () => {
  const { body } = parseArticleFrontmatter(REAL_DRAFT);
  assert.ok(body.startsWith("Most small business owners"));
  assert.ok(!body.includes("image_url"));
});

test("THE DEFECT: the canonical hero key is image_url, never image", () => {
  // liddy-podiatry-site's renderer read attributes.image and got undefined,
  // so it rendered no hero at all while the photo sat deployed and serving 200.
  assert.equal(CANONICAL_HERO_KEY, "image_url");
  const { attributes } = parseArticleFrontmatter(REAL_DRAFT);
  const hero = resolveHeroImage(attributes);
  assert.equal(hero.url, "/photos/website-operations-monitoring-building-a-weekly-rhythm-5424636.jpg");
  assert.equal(hero.provider, "pexels");
  assert.equal(hero.credit, "Amina Filkins");
});

test("a contaminated hero URL THROWS rather than resolving", () => {
  // This is the state siteclinic.io and babymilestonejournal.com actually shipped.
  assert.throws(
    () => resolveHeroImage({ image_url: '"/photos/x.jpg"' }),
    /quote-contaminated/,
    "a contaminated URL must fail loudly, not render a broken image in production",
  );
});

test("an unmatched quote is NOT silently half-repaired", () => {
  assert.throws(() => resolveHeroImage({ image_url: '"/photos/x.jpg' }), /quote-contaminated/);
});

test("a missing hero returns null and is NEVER replaced by a default", () => {
  assert.equal(resolveHeroImage({}), null);
  assert.equal(resolveHeroImage({ image_url: "   " }), null);
});

test("validation fails closed when policy requires a hero and none is declared", () => {
  const v = validateArticleAttributes(
    { title: "t", slug: "s", description: "d" },
    { imageRequired: true },
  );
  assert.equal(v.ok, false);
  assert.deepEqual(v.issues.map((i) => i.code), ["hero-missing"]);
});

test("validation passes on the real draft under the estate's required-image policy", () => {
  const { attributes } = parseArticleFrontmatter(REAL_DRAFT);
  const v = validateArticleAttributes(attributes, { imageRequired: true });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.equal(v.hero.provider, "pexels");
});

test("contamination is reported as an issue, not swallowed, during validation", () => {
  const v = validateArticleAttributes(
    { title: "t", slug: "s", description: "d", image_url: '"/photos/x.jpg"' },
    { imageRequired: true },
  );
  assert.equal(v.ok, false);
  assert.deepEqual(v.issues.map((i) => i.code), ["hero-contaminated"]);
});

test("front matter absent: no attributes invented, body preserved", () => {
  const r = parseArticleFrontmatter("# Just a heading\n\nBody.");
  assert.deepEqual(r.attributes, {});
  assert.ok(r.body.startsWith("# Just a heading"));
});
