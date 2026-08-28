/**
 * PUBLICATION_CONTRACT_V1 - what "PUBLISHED" is allowed to mean.
 *
 * WHY THIS EXISTS. Until now a publication was terminal-successful when the article
 * route polled to HTTP 200 and the intended image URL polled to 200. Both are real
 * checks and both are insufficient, because they measure the WRONG SIDE of rendering:
 * they ask whether an artefact exists at a path, never whether the page a reader
 * receives actually references it.
 *
 * Every user-facing defect found in this estate on 2026-08-27/28 passed that proof:
 *
 *   siteclinic, bmj   the hero FILE served 200 at /photos/x.jpg while the rendered
 *                     markup carried src="&quot;/photos/x.jpg&quot;", resolving to
 *                     /%22...%22. The proof checked the file. Readers got the 404.
 *   liddy             the renderer read a key the publisher does not emit, so no hero
 *                     was referenced at all - and the image URL still returned 200.
 *   ada               article route 200, absent from the canonical index.
 *   jeffrystein       indexed at /blog, and /blog unreachable from primary navigation.
 *
 * So this module evaluates DIMENSIONS, each answerable from observable evidence, and
 * refuses to collapse them into a single 200. It is deliberately pure: it consumes
 * evidence someone else gathered and returns a verdict. It fetches nothing, renders
 * nothing, and knows about no specific site.
 *
 * FAIL CLOSED. A required dimension that could not be measured is UNKNOWN, and UNKNOWN
 * is never PUBLISHED. Absence of evidence is not evidence of publication - that
 * conversion is the exact failure this contract exists to prevent.
 */

export const CONTRACT_VERSION = "PUBLICATION_CONTRACT_V1";

/** The dimensions a publication is judged on. */
export const DIMENSIONS = Object.freeze([
  "ARTICLE_ARTIFACT_VALID",
  "ARTICLE_METADATA_VALID",
  "ARTICLE_ROUTE_VALID",
  "ARTICLE_IDENTITY_VALID",
  "ARTICLE_INDEXED",
  "ARTICLE_DISCOVERABLE",
  "MEDIA_REQUIRED",
  "MEDIA_PERSISTED",
  "HERO_MEDIA_VALID",
  "RENDER_VALID",
  "SITEMAP_VALID",
]);

/** Per-dimension outcome. NOT_APPLICABLE is a legitimate pass; UNKNOWN never is. */
export const OUTCOME = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  UNKNOWN: "UNKNOWN",
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

/** Media sub-states, kept distinct because they need different repairs. */
export const MEDIA_STATE = Object.freeze({
  NOT_REQUIRED: "MEDIA_NOT_REQUIRED",
  VALID: "MEDIA_REQUIRED_AND_VALID",
  MISSING: "MEDIA_REQUIRED_MISSING",
  WRONG_IDENTITY: "MEDIA_WRONG_IDENTITY",
  BAD_PATH: "MEDIA_BAD_PATH",
  UNRESOLVED: "MEDIA_UNRESOLVED",
});

/** Terminal classifications an operator or observer can act on. */
export const CLASSIFICATION = Object.freeze({
  PUBLISHED: "PUBLISHED",
  PUBLICATION_FAILED: "PUBLICATION_FAILED",
  PUBLISHED_BROKEN_MEDIA: "PUBLISHED_BROKEN_MEDIA",
  MISSING_MEDIA: "MISSING_MEDIA",
  NOT_INDEXED: "NOT_INDEXED",
  NOT_DISCOVERABLE: "NOT_DISCOVERABLE",
  RENDER_INVALID: "RENDER_INVALID",
  ARTICLE_IDENTITY_INVALID: "ARTICLE_IDENTITY_INVALID",
  PROOF_INCOMPLETE: "PROOF_INCOMPLETE",
  GENERATION_FAILED: "GENERATION_FAILED",
  UNKNOWN: "UNKNOWN",
});

const QUOTE_CONTAMINATION = /["']/;

/** A dimension is required unless applicability explicitly says otherwise. */
function applies(applicability, dimension) {
  return applicability?.[dimension] !== false;
}

function res(outcome, reason, detail) {
  return detail === undefined ? { outcome, reason } : { outcome, reason, detail };
}

/**
 * Evaluate rendered-markup hero evidence.
 *
 * The distinction that matters: `intendedHeroUrl` is what the publisher meant to ship,
 * `renderedHeroUrl` is what the page actually references. Comparing the two is the whole
 * point - checking only that the intended file exists is what let two sites ship a
 * broken hero beside a perfectly good image.
 */
export function evaluateHero({ required, intendedHeroUrl, renderedHeroUrl, heroFetchStatus, isFallback }) {
  if (!required) return { state: MEDIA_STATE.NOT_REQUIRED, outcome: OUTCOME.NOT_APPLICABLE };
  if (renderedHeroUrl === undefined) {
    return { state: MEDIA_STATE.UNRESOLVED, outcome: OUTCOME.UNKNOWN, reason: "rendered hero was not observed" };
  }
  if (renderedHeroUrl === null || renderedHeroUrl === "") {
    return { state: MEDIA_STATE.MISSING, outcome: OUTCOME.FAIL, reason: "rendered markup references no hero" };
  }
  if (QUOTE_CONTAMINATION.test(renderedHeroUrl)) {
    return { state: MEDIA_STATE.BAD_PATH, outcome: OUTCOME.FAIL, reason: `rendered hero path is quote-contaminated: ${renderedHeroUrl}` };
  }
  // A site-level placeholder standing in for the intended hero must never satisfy the
  // proof: that is how a media failure hides behind a page that looks fine.
  if (isFallback === true) {
    return { state: MEDIA_STATE.WRONG_IDENTITY, outcome: OUTCOME.FAIL, reason: "a fallback/default image rendered instead of the intended hero" };
  }
  // Compare DECODED forms on both sides. qirofit ships the hero through next/image as
  // /_next/image?url=%2Fphotos%2Fx.jpg, so comparing a decoded intended path against a
  // still-encoded rendered one reports wrong-identity for a perfectly correct hero.
  if (intendedHeroUrl && !decodeSafe(renderedHeroUrl).includes(stripQuery(intendedHeroUrl))) {
    return { state: MEDIA_STATE.WRONG_IDENTITY, outcome: OUTCOME.FAIL, reason: `rendered hero ${renderedHeroUrl} is not the intended ${intendedHeroUrl}` };
  }
  if (heroFetchStatus === undefined) {
    return { state: MEDIA_STATE.UNRESOLVED, outcome: OUTCOME.UNKNOWN, reason: "rendered hero was never fetched" };
  }
  if (heroFetchStatus !== 200) {
    return { state: MEDIA_STATE.UNRESOLVED, outcome: OUTCOME.FAIL, reason: `rendered hero returned HTTP ${heroFetchStatus}` };
  }
  return { state: MEDIA_STATE.VALID, outcome: OUTCOME.PASS };
}

/** Decode without throwing on a malformed escape sequence. */
function decodeSafe(url) {
  try { return decodeURIComponent(String(url)); } catch { return String(url); }
}

/** Strip an optimizer query so /_next/image?url=%2Fphotos%2Fx.jpg still matches /photos/x.jpg. */
function stripQuery(url) {
  return decodeSafe(url).split("?")[0];
}

/**
 * Evaluate one publication against the contract.
 *
 * `evidence` fields are deliberately tri-state: a value, `null` for observed-absent, and
 * `undefined` for not-observed. Only `undefined` yields UNKNOWN.
 */
export function evaluatePublication(evidence = {}, applicability = {}) {
  const d = {};
  const {
    artifactCommitted, metadataValid, routeStatus,
    expectedSlug, renderedSlug, expectedTitle, renderedTitle,
    occurrenceKey, artifactOccurrenceKey,
    indexContainsArticle, discoverySurfaceReachable,
    mediaRequired, mediaPersisted,
    intendedHeroUrl, renderedHeroUrl, heroFetchStatus, isFallbackHero,
    renderedBodyLength, sitemapContainsArticle,
    generationFailed,
  } = evidence;

  if (generationFailed === true) {
    // Proven upstream failure must never decay into UNKNOWN: an article that was never
    // generated is not an unmeasured article.
    return finalize(d, CLASSIFICATION.GENERATION_FAILED, "generation failed upstream; nothing was published to measure");
  }

  d.ARTICLE_ARTIFACT_VALID = artifactCommitted === undefined ? res(OUTCOME.UNKNOWN, "artifact not observed")
    : artifactCommitted ? res(OUTCOME.PASS, "artifact committed") : res(OUTCOME.FAIL, "no artifact committed");

  d.ARTICLE_METADATA_VALID = metadataValid === undefined ? res(OUTCOME.UNKNOWN, "metadata not observed")
    : metadataValid ? res(OUTCOME.PASS, "metadata valid") : res(OUTCOME.FAIL, "metadata invalid");

  d.ARTICLE_ROUTE_VALID = routeStatus === undefined ? res(OUTCOME.UNKNOWN, "route not fetched")
    : routeStatus === 200 ? res(OUTCOME.PASS, "route 200") : res(OUTCOME.FAIL, `route HTTP ${routeStatus}`);

  d.ARTICLE_IDENTITY_VALID = evaluateIdentity({ expectedSlug, renderedSlug, expectedTitle, renderedTitle, occurrenceKey, artifactOccurrenceKey });

  d.ARTICLE_INDEXED = !applies(applicability, "ARTICLE_INDEXED") ? res(OUTCOME.NOT_APPLICABLE, "site declares no canonical index")
    : indexContainsArticle === undefined ? res(OUTCOME.UNKNOWN, "index not inspected")
    : indexContainsArticle ? res(OUTCOME.PASS, "article present on the canonical index")
    : res(OUTCOME.FAIL, "article absent from the canonical index");

  d.ARTICLE_DISCOVERABLE = !applies(applicability, "ARTICLE_DISCOVERABLE") ? res(OUTCOME.NOT_APPLICABLE, "site declares no navigational discovery requirement")
    : discoverySurfaceReachable === undefined ? res(OUTCOME.UNKNOWN, "discovery surface not inspected")
    : discoverySurfaceReachable ? res(OUTCOME.PASS, "article surface reachable from intended navigation")
    : res(OUTCOME.FAIL, "article surface not reachable from intended navigation");

  const required = mediaRequired === true;
  d.MEDIA_REQUIRED = res(required ? OUTCOME.PASS : OUTCOME.NOT_APPLICABLE, required ? "site policy requires media" : "site policy does not require media");
  d.MEDIA_PERSISTED = !required ? res(OUTCOME.NOT_APPLICABLE, "media not required")
    : mediaPersisted === undefined ? res(OUTCOME.UNKNOWN, "media persistence not observed")
    : mediaPersisted ? res(OUTCOME.PASS, "media persisted") : res(OUTCOME.FAIL, "media not persisted");

  const hero = evaluateHero({ required, intendedHeroUrl, renderedHeroUrl, heroFetchStatus, isFallback: isFallbackHero });
  d.HERO_MEDIA_VALID = res(hero.outcome, hero.reason ?? hero.state, hero.state);

  d.RENDER_VALID = renderedBodyLength === undefined ? res(OUTCOME.UNKNOWN, "rendered body not observed")
    : renderedBodyLength > 0 ? res(OUTCOME.PASS, "rendered body present")
    : res(OUTCOME.FAIL, "rendered body empty");

  d.SITEMAP_VALID = !applies(applicability, "SITEMAP_VALID") ? res(OUTCOME.NOT_APPLICABLE, "site declares no sitemap requirement")
    : sitemapContainsArticle === undefined ? res(OUTCOME.UNKNOWN, "sitemap not inspected")
    : sitemapContainsArticle ? res(OUTCOME.PASS, "article in sitemap") : res(OUTCOME.FAIL, "article absent from sitemap");

  return finalize(d, classify(d, hero), null);
}

function evaluateIdentity({ expectedSlug, renderedSlug, expectedTitle, renderedTitle, occurrenceKey, artifactOccurrenceKey }) {
  if (renderedSlug === undefined && renderedTitle === undefined) {
    return res(OUTCOME.UNKNOWN, "no rendered identity observed");
  }
  if (expectedSlug && renderedSlug !== undefined && renderedSlug !== expectedSlug) {
    return res(OUTCOME.FAIL, `rendered slug ${renderedSlug} is not the intended ${expectedSlug}`);
  }
  if (expectedTitle && renderedTitle !== undefined && renderedTitle !== null && !String(renderedTitle).includes(expectedTitle)) {
    return res(OUTCOME.FAIL, "rendered title does not carry the intended article title");
  }
  if (occurrenceKey && artifactOccurrenceKey !== undefined && artifactOccurrenceKey !== occurrenceKey) {
    return res(OUTCOME.FAIL, `artifact belongs to occurrence ${artifactOccurrenceKey}, not ${occurrenceKey}`);
  }
  return res(OUTCOME.PASS, "rendered article is the intended article");
}

/** Order matters: the most specific actionable failure wins, so an operator is told what to fix. */
function classify(d, hero) {
  if (d.ARTICLE_ROUTE_VALID.outcome === OUTCOME.FAIL || d.ARTICLE_ARTIFACT_VALID.outcome === OUTCOME.FAIL) return CLASSIFICATION.PUBLICATION_FAILED;
  if (d.ARTICLE_IDENTITY_VALID.outcome === OUTCOME.FAIL) return CLASSIFICATION.ARTICLE_IDENTITY_INVALID;
  if (d.RENDER_VALID.outcome === OUTCOME.FAIL) return CLASSIFICATION.RENDER_INVALID;
  if (d.HERO_MEDIA_VALID.outcome === OUTCOME.FAIL) {
    return hero.state === MEDIA_STATE.MISSING ? CLASSIFICATION.MISSING_MEDIA : CLASSIFICATION.PUBLISHED_BROKEN_MEDIA;
  }
  if (d.ARTICLE_INDEXED.outcome === OUTCOME.FAIL) return CLASSIFICATION.NOT_INDEXED;
  if (d.ARTICLE_DISCOVERABLE.outcome === OUTCOME.FAIL) return CLASSIFICATION.NOT_DISCOVERABLE;
  if (d.MEDIA_PERSISTED.outcome === OUTCOME.FAIL || d.ARTICLE_METADATA_VALID.outcome === OUTCOME.FAIL || d.SITEMAP_VALID.outcome === OUTCOME.FAIL) return CLASSIFICATION.PUBLICATION_FAILED;
  // Only now may UNKNOWN decide: a measurable failure always outranks an unmeasured one.
  if (Object.values(d).some((x) => x.outcome === OUTCOME.UNKNOWN)) return CLASSIFICATION.PROOF_INCOMPLETE;
  return CLASSIFICATION.PUBLISHED;
}

function finalize(dimensions, classification, note) {
  const unknown = Object.entries(dimensions).filter(([, v]) => v.outcome === OUTCOME.UNKNOWN).map(([k]) => k);
  const failed = Object.entries(dimensions).filter(([, v]) => v.outcome === OUTCOME.FAIL).map(([k]) => k);
  return {
    contract: CONTRACT_VERSION,
    classification,
    published: classification === CLASSIFICATION.PUBLISHED,
    proofComplete: unknown.length === 0,
    dimensions,
    unknownDimensions: unknown,
    failedDimensions: failed,
    note: note ?? undefined,
  };
}
