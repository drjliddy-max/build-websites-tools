/*
 * Contract for the related-content / internal-linking selection helpers.
 *
 * These back the fleet-wide internal-linking activation (extract-before-
 * duplicate after liddy-podiatry-site + qirofit-web showed the identical
 * near-orphaned-blog gap). The helpers must be deterministic and pure so a
 * consumer's rendered related blocks are a stable function of the published
 * schedule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectRelatedPosts,
  relatedServices,
  featuredPosts,
  servicePageEducationLinks,
} from "../related-content.js";
import type {
  ScheduleEntryLike,
  RelatedContentConfig,
} from "../related-content.js";

// A small fixed corpus (newest-first, as listPublished returns).
const POSTS: ScheduleEntryLike[] = [
  { slug: "a1", title: "A one", cluster: "alpha" },
  { slug: "a2", title: "A two", cluster: "alpha" },
  { slug: "a3", title: "A three", cluster: "alpha" },
  { slug: "a4", title: "A four", cluster: "alpha" },
  { slug: "b1", title: "B one", cluster: "beta" },
  { slug: "b2", title: "B two", cluster: "beta" },
  { slug: "n1", title: "No cluster" },
];

const CONFIG: RelatedContentConfig = {
  clusterServices: {
    alpha: [
      { href: "/services", label: "Services" },
      { href: "/contact", label: "Contact" },
    ],
    beta: [{ href: "/forms/new-patient", label: "New patient" }],
  },
  defaultServices: [{ href: "/contact", label: "Contact" }],
  cornerstoneSlugs: ["b1", "a1"],
};

test("selectRelatedPosts: returns same-cluster siblings, current excluded", () => {
  const out = selectRelatedPosts("a2", POSTS, CONFIG);
  assert.ok(!out.some((p) => p.slug === "a2"), "current post excluded");
  // First fills from the same cluster (alpha) before anything else.
  assert.deepEqual(
    out.map((p) => p.slug),
    ["a1", "a3", "a4"],
    "same-cluster siblings, newest-first, capped at 3",
  );
});

test("selectRelatedPosts: enforces the relatedArticles limit", () => {
  const out = selectRelatedPosts("a1", POSTS, {
    ...CONFIG,
    limits: { relatedArticles: 2 },
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.slug), ["a2", "a3"]);
});

test("selectRelatedPosts: missing/empty cluster falls back across clusters", () => {
  // n1 has no cluster -> no same-cluster siblings -> fill from others in order.
  const out = selectRelatedPosts("n1", POSTS, CONFIG);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((p) => p.slug), ["a1", "a2", "a3"]);
  // fillAcrossClusters:false -> nothing to show for a clusterless post.
  const none = selectRelatedPosts("n1", POSTS, {
    ...CONFIG,
    fillAcrossClusters: false,
  });
  assert.deepEqual(none, []);
  // empty corpus -> []
  assert.deepEqual(selectRelatedPosts("a1", [], CONFIG), []);
});

test("selectRelatedPosts: small cluster fills across, or stays pure when disabled", () => {
  // beta has only b1,b2 -> current b1 leaves 1 sibling; fill brings alpha next.
  const filled = selectRelatedPosts("b1", POSTS, CONFIG);
  assert.equal(filled[0].slug, "b2", "same-cluster sibling ranked first");
  assert.equal(filled.length, 3, "then filled across clusters up to limit");
  const pure = selectRelatedPosts("b1", POSTS, {
    ...CONFIG,
    fillAcrossClusters: false,
  });
  assert.deepEqual(pure.map((p) => p.slug), ["b2"], "pure cluster only");
});

test("selectRelatedPosts: per-slug override wins outright", () => {
  const out = selectRelatedPosts("a1", POSTS, {
    ...CONFIG,
    overrides: { relatedPostsBySlug: { a1: ["b2", "a1", "n1"] } },
  });
  // a1 (self) filtered; order preserved from the override list.
  assert.deepEqual(out.map((p) => p.slug), ["b2", "n1"]);
});

test("relatedServices: cluster mapping, default fallback, per-slug override, cap", () => {
  assert.deepEqual(relatedServices("alpha", CONFIG), [
    { href: "/services", label: "Services" },
    { href: "/contact", label: "Contact" },
  ]);
  // unknown/absent cluster -> default set
  assert.deepEqual(relatedServices(undefined, CONFIG), [
    { href: "/contact", label: "Contact" },
  ]);
  // limit cap
  assert.equal(
    relatedServices("alpha", { ...CONFIG, limits: { relatedServices: 1 } }).length,
    1,
  );
  // per-slug override wins
  assert.deepEqual(
    relatedServices("alpha", {
      ...CONFIG,
      overrides: { servicesBySlug: { p: [{ href: "/x", label: "X" }] } },
    }, "p"),
    [{ href: "/x", label: "X" }],
  );
});

test("featuredPosts + servicePageEducationLinks: cornerstone-first, capped", () => {
  // featuredSlugs take priority over cornerstone
  const feat = featuredPosts(POSTS, { ...CONFIG, featuredSlugs: ["a4", "b2"] });
  assert.deepEqual(feat.map((p) => p.slug), ["a4", "b2", "a1"]);
  // service education: cornerstone (b1,a1) first, then fill, cap 6
  const edu = servicePageEducationLinks(POSTS, CONFIG);
  assert.equal(edu[0].slug, "b1");
  assert.equal(edu[1].slug, "a1");
  assert.ok(edu.length <= 6);
  // limit cap
  assert.equal(
    servicePageEducationLinks(POSTS, { ...CONFIG, limits: { serviceEducation: 2 } })
      .length,
    2,
  );
});

test("deterministic: identical inputs yield identical outputs", () => {
  const a = selectRelatedPosts("a2", POSTS, CONFIG);
  const b = selectRelatedPosts("a2", POSTS, CONFIG);
  assert.deepEqual(a, b);
  assert.deepEqual(
    featuredPosts(POSTS, CONFIG),
    featuredPosts(POSTS, CONFIG),
  );
});
