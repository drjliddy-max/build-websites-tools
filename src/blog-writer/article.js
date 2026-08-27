/**
 * Canonical article-data contract for the Blog Writer estate (BLOG_ARTICLE_PUBLICATION_CONTRACT v1).
 *
 * WHY THIS EXISTS. Until v0.28.4 every consumer site carried its own copy of a
 * six-line front-matter parser. Five copies existed across seven sites and they
 * disagreed on two things that decide whether a reader sees an image:
 *
 *   1. Quote handling. `publisher.serializeDraft` writes canonical YAML -
 *      `image_url: "/photos/x.jpg"`. A parser that does not strip the surrounding
 *      quotes yields the six-character-longer value `"/photos/x.jpg"`, which a
 *      renderer escapes into `src="&quot;/photos/x.jpg&quot;"` and a browser
 *      resolves to `/%22/photos/x.jpg%22` - a 404 beside a perfectly good file.
 *      Observed in production 2026-08-27 on siteclinic.io and
 *      babymilestonejournal.com; the images themselves were present and served 200.
 *   2. The hero key. The publisher emits `image_url`. A renderer reading
 *      `attributes.image` gets undefined and silently renders no hero at all.
 *      Observed the same day on liddypodiatryandprevention.com.
 *
 * Both failures were silent: the article published, the URL returned 200, and the
 * proof passed. So this module does not merely parse - it REFUSES a hero URL that
 * still carries quote contamination, turning a silent production defect into a
 * build-time error. Presentation stays with the site: `markdownToHtml` is
 * deliberately NOT here. This module owns article DATA only.
 */

/** The canonical hero key. The publisher emits this; nothing else is authoritative. */
export const CANONICAL_HERO_KEY = "image_url";

/** Keys the publisher may emit for hero media, in the order a reader should trust. */
export const HERO_KEYS = Object.freeze({
  url: CANONICAL_HERO_KEY,
  alt: "image_alt",
  provider: "image_provider",
  credit: "image_credit",
});

/** Characters that must never survive front-matter parsing into a URL. */
const QUOTE_CONTAMINATION = /["']/;

function stripSurroundingQuotes(raw) {
  const value = raw.trim();
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  // Only strip a MATCHED pair. An unmatched quote is contamination we must not
  // hide: `"/photos/x.jpg` should reach validation and fail loudly, not be
  // silently half-repaired into something that looks plausible.
  if ((first === '"' || first === "'") && last === first) return value.slice(1, -1);
  return value;
}

/**
 * Parse Blog Writer front matter into { attributes, body }.
 *
 * Deliberately a strict subset of YAML: the publisher writes a fixed shape, so a
 * full YAML dependency would buy nothing and widen the trusted surface.
 */
export function parseArticleFrontmatter(source) {
  const normalized = String(source ?? "").replaceAll(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { attributes: {}, body: normalized.trim() };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { attributes: {}, body: normalized.trim() };
  }
  const attributes = {};
  for (const line of normalized.slice(4, endIndex).split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    attributes[key] = stripSurroundingQuotes(line.slice(separator + 1));
  }
  return { attributes, body: normalized.slice(endIndex + 5).trim() };
}

/**
 * Resolve the hero image declared by an article's front matter.
 *
 * Returns null when no hero was declared. It NEVER substitutes a default: a
 * site-level placeholder standing in for a missing hero is precisely how a media
 * failure hides from acceptance, so the decision to fall back (if a site wants one)
 * belongs to the site, visibly, and not to this contract.
 *
 * Throws on a contaminated URL rather than returning it.
 */
export function resolveHeroImage(attributes = {}) {
  const raw = attributes[HERO_KEYS.url];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const url = raw.trim();
  if (QUOTE_CONTAMINATION.test(url)) {
    throw new Error(
      `Hero image URL is quote-contaminated: ${JSON.stringify(url)}. ` +
        `The front matter was parsed by something that did not strip YAML quotes. ` +
        `Use parseArticleFrontmatter from build-websites-tools/blog-writer/article.`,
    );
  }
  return {
    url,
    alt: attributes[HERO_KEYS.alt] ?? "",
    provider: attributes[HERO_KEYS.provider] ?? null,
    credit: attributes[HERO_KEYS.credit] ?? null,
  };
}

/**
 * Validate article attributes against the contract.
 * `imageRequired` mirrors the site's own `imagePolicy.required`; all seven estate
 * sites declare true, but the flag stays explicit so the caller passes its policy
 * rather than this module assuming one.
 */
export function validateArticleAttributes(attributes = {}, { imageRequired = false } = {}) {
  const issues = [];
  for (const field of ["title", "slug", "description"]) {
    if (typeof attributes[field] !== "string" || attributes[field].trim() === "") {
      issues.push({ code: "missing-field", field, message: `Article front matter is missing ${field}.` });
    }
  }
  let hero = null;
  try {
    hero = resolveHeroImage(attributes);
  } catch (error) {
    issues.push({ code: "hero-contaminated", field: CANONICAL_HERO_KEY, message: error.message });
  }
  if (imageRequired && !hero && !issues.some((i) => i.code === "hero-contaminated")) {
    issues.push({
      code: "hero-missing",
      field: CANONICAL_HERO_KEY,
      message: `Hero image is required by policy but ${CANONICAL_HERO_KEY} is absent.`,
    });
  }
  return { ok: issues.length === 0, issues, hero };
}
