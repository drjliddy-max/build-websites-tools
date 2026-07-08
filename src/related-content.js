// Reusable related-content / internal-linking selection helpers for the
// build-websites-template site fleet.
//
// WHY this exists: two consumer sites (liddy-podiatry-site, qirofit-web) showed
// the identical builder-pattern gap - near-orphaned blog posts with no
// post->sibling, post->service, or service->post internal links. Rather than
// hand-implement the selection logic a third time, it lives here once
// (portfolio extract-before-duplicate rule).
//
// Design: pure, deterministic, framework-agnostic (no React, no DOM). Each
// consumer renders the returned data with its own components so visual design
// and copy tone stay site-owned. No Date.now()/Math.random() - output is a
// stable function of input, so it is fully unit-testable.
//
// Input is the standard blog-schedule shape: an array of published entries
// each with at least { slug, title, cluster? }. Order is preserved from the
// input (sites pass listPublished(...), which is newest-first).

const DEFAULT_LIMITS = {
  relatedArticles: 3,
  relatedServices: 2,
  featuredPosts: 3,
  serviceEducation: 6,
};

function limitFor(config, key) {
  const value = config && config.limits && config.limits[key];
  return typeof value === "number" && value >= 0 ? value : DEFAULT_LIMITS[key];
}

function clusterOf(entry) {
  return entry && typeof entry.cluster === "string" && entry.cluster
    ? entry.cluster
    : null;
}

// Pick up to `max` entries: the entries named in `prioritySlugs` first (in the
// given order, only if present in `list`), then the remaining entries in list
// order. De-duplicated by slug. Deterministic.
function pickByPriority(list, prioritySlugs, max) {
  if (max <= 0) return [];
  const bySlug = new Map(list.map((entry) => [entry.slug, entry]));
  const picks = [];
  const seen = new Set();
  for (const slug of prioritySlugs || []) {
    const entry = bySlug.get(slug);
    if (entry && !seen.has(entry.slug)) {
      seen.add(entry.slug);
      picks.push(entry);
      if (picks.length >= max) return picks;
    }
  }
  for (const entry of list) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    picks.push(entry);
    if (picks.length >= max) break;
  }
  return picks;
}

// Sibling posts in the same topic cluster, excluding the current post. Falls
// back to other published posts (deterministic order) when the cluster has
// fewer siblings than the limit, unless fillAcrossClusters is false. A per-slug
// override in config.overrides.relatedPostsBySlug wins outright.
export function selectRelatedPosts(currentSlug, published, config = {}) {
  const list = Array.isArray(published) ? published : [];
  const max = limitFor(config, "relatedArticles");
  if (max <= 0) return [];

  const override =
    config.overrides &&
    config.overrides.relatedPostsBySlug &&
    config.overrides.relatedPostsBySlug[currentSlug];
  if (override) {
    const bySlug = new Map(list.map((entry) => [entry.slug, entry]));
    const picks = [];
    const seen = new Set();
    for (const slug of override) {
      if (slug === currentSlug || seen.has(slug)) continue;
      const entry = bySlug.get(slug);
      if (entry) {
        seen.add(entry.slug);
        picks.push(entry);
        if (picks.length >= max) break;
      }
    }
    return picks;
  }

  const current = list.find((entry) => entry.slug === currentSlug) || null;
  const currentCluster = clusterOf(current);
  const others = list.filter((entry) => entry.slug !== currentSlug);
  const sameCluster = currentCluster
    ? others.filter((entry) => clusterOf(entry) === currentCluster)
    : [];

  const picks = [];
  const seen = new Set();
  const take = (arr) => {
    for (const entry of arr) {
      if (seen.has(entry.slug)) continue;
      seen.add(entry.slug);
      picks.push(entry);
      if (picks.length >= max) break;
    }
  };
  take(sameCluster);
  if (picks.length < max && config.fillAcrossClusters !== false) take(others);
  return picks;
}

// Local-intent service/page links for a post: per-slug override, else the
// cluster mapping, else the default set. De-duplicated by href, capped.
export function relatedServices(cluster, config = {}, currentSlug) {
  const max = limitFor(config, "relatedServices");
  if (max <= 0) return [];

  const bySlugOverride =
    currentSlug &&
    config.overrides &&
    config.overrides.servicesBySlug &&
    config.overrides.servicesBySlug[currentSlug];
  const mapped =
    cluster && config.clusterServices && config.clusterServices[cluster];
  const source = bySlugOverride || mapped || config.defaultServices || [];

  const out = [];
  const seen = new Set();
  for (const link of source) {
    if (!link || !link.href || seen.has(link.href)) continue;
    seen.add(link.href);
    out.push({ href: link.href, label: link.label });
    if (out.length >= max) break;
  }
  return out;
}

// Homepage featured education posts: explicit featuredSlugs first, else
// cornerstoneSlugs, else newest published - capped.
export function featuredPosts(published, config = {}) {
  const list = Array.isArray(published) ? published : [];
  const priority =
    config.featuredSlugs && config.featuredSlugs.length
      ? config.featuredSlugs
      : config.cornerstoneSlugs || [];
  return pickByPriority(list, priority, limitFor(config, "featuredPosts"));
}

// Service-page education links: cornerstone posts first, then fill - capped.
export function servicePageEducationLinks(published, config = {}) {
  const list = Array.isArray(published) ? published : [];
  return pickByPriority(
    list,
    config.cornerstoneSlugs || [],
    limitFor(config, "serviceEducation"),
  );
}
