/**
 * Slice B: turn a lane's DECLARED surfaces into evidence PUBLICATION_CONTRACT_V1 can judge.
 *
 * Division of labour, deliberately: the contract (publicationProof.js) decides what a
 * verdict means and knows no site; this module knows where a given site keeps its index,
 * its discovery surface and its hero, and knows nothing about verdicts. Neither renders
 * anything. No site's React lives in build-websites-tools.
 *
 * WHY DECLARATION RATHER THAN DETECTION. Guessing a site's index or navigation is how you
 * get a confident wrong answer: jeffrystein's /blog was populated and correct for weeks
 * while nothing linked to it, and any heuristic that treated "an index exists" as "readers
 * can reach it" would have reported health. A lane states its surfaces; if it states none,
 * the dimension is UNKNOWN, never assumed.
 *
 * APPLICABILITY IS NOT ABSENCE. `applicable: false` is a site saying a dimension does not
 * exist for its architecture. Silence is a site saying nothing. The first is a legitimate
 * pass; the second must fail closed. Conflating them is how a missing check becomes a
 * green check.
 */

export const EVIDENCE_CONTRACT = "PUBLICATION_EVIDENCE_V1";

export class EvidenceDeclarationError extends Error {
  constructor(siteId, message) {
    super(`[${siteId ?? "unknown-site"}] publicationEvidence: ${message}`);
    this.name = "EvidenceDeclarationError";
  }
}

/** Dimensions a lane may mark inapplicable. The rest are structural and always apply. */
const OPTIONAL_DIMENSIONS = new Set(["ARTICLE_INDEXED", "ARTICLE_DISCOVERABLE", "SITEMAP_VALID"]);

/**
 * Validate a lane's declaration. Fails closed and loudly: a malformed declaration must
 * never quietly degrade into "measure nothing and call it fine".
 */
export function validateEvidenceDeclaration(site) {
  const d = site?.publicationEvidence;
  const id = site?.siteId;
  if (!d) throw new EvidenceDeclarationError(id, "declaration is missing");
  if (d.contract !== "PUBLICATION_CONTRACT_V1") {
    throw new EvidenceDeclarationError(id, `unknown contract ${JSON.stringify(d.contract)}`);
  }
  for (const [key, dim] of [["indexSurface", "ARTICLE_INDEXED"], ["discoverySurface", "ARTICLE_DISCOVERABLE"], ["sitemap", "SITEMAP_VALID"]]) {
    const applicable = d.applicability?.[dim] !== false;
    if (applicable && !d[key]) {
      throw new EvidenceDeclarationError(id, `${dim} is applicable but ${key} is not declared`);
    }
    if (!applicable && d[key]) {
      throw new EvidenceDeclarationError(id, `${dim} is declared NOT_APPLICABLE but ${key} is still declared`);
    }
  }
  for (const dim of Object.keys(d.applicability ?? {})) {
    if (!OPTIONAL_DIMENSIONS.has(dim)) {
      throw new EvidenceDeclarationError(id, `${dim} is structural and cannot be declared inapplicable`);
    }
  }
  if (d.discoverySurface && !d.discoverySurface.mustLinkTo) {
    throw new EvidenceDeclarationError(id, "discoverySurface must declare mustLinkTo");
  }
  return d;
}

/** Resolve a declaration plus one article into the exact URLs to fetch. */
export function resolveEvidencePlan(site, article) {
  const d = validateEvidenceDeclaration(site);
  const base = `https://${site.domain}`;
  const slug = article.slug;
  const applicability = { ...(d.applicability ?? {}) };
  return {
    contract: d.contract,
    applicability,
    articleUrl: `${base}${site.blogPath}/${slug}`,
    indexUrl: d.indexSurface ? `${base}${d.indexSurface.path}` : null,
    discoveryUrl: d.discoverySurface ? `${base}${d.discoverySurface.path}` : null,
    discoveryMustLinkTo: d.discoverySurface?.mustLinkTo ?? null,
    sitemapUrl: d.sitemap ? `${base}${d.sitemap.path}` : null,
    expectedArticleHref: `${site.blogPath}/${slug}`,
    heroSource: d.heroEvidence?.source ?? "rendered-markup",
    fallbackHeroMarkers: d.heroEvidence?.fallbackMarkers ?? [],
  };
}

/**
 * Extract the hero a page actually references.
 *
 * Handles the three real shapes in this estate without flattening them: a root-relative
 * path, an absolute URL, and a next/image-wrapped path. Returns `null` for observed-absent
 * and `undefined` for not-observed, because the contract treats those very differently.
 */
export function extractRenderedHero(html, { fallbackMarkers = [] } = {}) {
  if (typeof html !== "string") return undefined;
  const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map((m) => m[1]);
  if (srcs.length === 0) return null;
  const candidate = srcs.find((s) => /photos|_next\/image/i.test(s));
  if (!candidate) return null;
  const decoded = candidate.replace(/&amp;/g, "&");
  const isFallback = fallbackMarkers.some((marker) => decoded.includes(marker));
  return { url: decoded, isFallback };
}

/**
 * Collect evidence for one publication. `fetchImpl` is injected so this is testable and so
 * BWT never depends on a particular HTTP client.
 *
 * Every field is tri-state on purpose: a value, `null` for observed-absent, `undefined`
 * for not-observed. A failed fetch yields `undefined`, which the contract turns into
 * UNKNOWN and therefore not-PUBLISHED. A fetch error must never read as a clean absence.
 */
export async function collectPublicationEvidence(plan, { fetchImpl, expectedTitle, occurrenceKey } = {}) {
  const get = async (url) => {
    if (!url) return undefined;
    try {
      const r = await fetchImpl(url);
      return { status: r.status, body: typeof r.text === "function" ? await r.text() : r.body };
    } catch {
      return undefined; // not-observed, never "absent"
    }
  };

  const article = await get(plan.articleUrl);
  const index = plan.indexUrl ? await get(plan.indexUrl) : undefined;
  const discovery = plan.discoveryUrl ? await get(plan.discoveryUrl) : undefined;
  const sitemap = plan.sitemapUrl ? await get(plan.sitemapUrl) : undefined;

  const hero = article?.body === undefined ? undefined
    : extractRenderedHero(article.body, { fallbackMarkers: plan.fallbackHeroMarkers });

  const contains = (res, needle) => res?.body === undefined ? undefined : res.body.includes(needle);

  return {
    routeStatus: article?.status,
    renderedBodyLength: article?.body === undefined ? undefined : article.body.length,
    renderedTitle: article?.body === undefined ? undefined : (article.body.match(/<title>([^<]*)/i)?.[1] ?? null),
    expectedTitle,
    occurrenceKey,
    renderedHeroUrl: hero === undefined ? undefined : hero === null ? null : hero.url,
    isFallbackHero: hero === undefined || hero === null ? undefined : hero.isFallback,
    indexContainsArticle: plan.applicability.ARTICLE_INDEXED === false ? undefined : contains(index, `href="${plan.expectedArticleHref}"`),
    discoverySurfaceReachable: plan.applicability.ARTICLE_DISCOVERABLE === false ? undefined : contains(discovery, `href="${plan.discoveryMustLinkTo}"`),
    sitemapContainsArticle: plan.applicability.SITEMAP_VALID === false ? undefined : contains(sitemap, plan.expectedArticleHref),
  };
}
