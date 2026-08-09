/**
 * Deterministic article validation.
 *
 * The generator is never allowed to certify its own output. Everything a
 * publication must satisfy is checked here, by rules that do not call a model.
 *
 * WHY THIS IS SEPARATE FROM GENERATION
 *
 * The qirofit 2026-08-08 draft shipped a 167-character meta description and the
 * banned word "cure", and both were repaired by hand after the fact. That was
 * possible because nothing between authoring and the queue enforced the
 * constraints the publisher would later apply. Those two failures are pinned as
 * regression fixtures in the test suite.
 *
 * Every rule returns a structured issue. Nothing throws for a content problem, * the caller decides whether to repair or fail closed   but the pipeline treats
 * any issue as fatal before queue admission.
 */

export const TITLE_MIN = 20;
export const TITLE_MAX = 70;
export const META_MIN = 70;
export const META_MAX = 160;
export const BODY_MIN_WORDS = 400;
export const BODY_MAX_WORDS = 2500;
export const MIN_H2_COUNT = 3;

/** Residue that proves a template or a model placeholder survived to output. */
const PLACEHOLDER_PATTERNS = [
  /\blorem ipsum\b/i,
  /\[(?:insert|your|todo|tbd|placeholder)[^\]]*\]/i,
  /\{\{[^}]+\}\}/,
  /\bAs an AI (?:language )?model\b/i,
  /\bI(?:'m| am) (?:sorry|unable)\b/i,
  /\bTODO\b/,
  /\bXXX\b/,
];

/**
 * Claims no site in this estate may make. Site registrations add their own on
 * top; these are the floor, because "cure" slipping through a health lane is
 * exactly the failure that started this.
 */
const UNIVERSAL_PROHIBITED = [
  { term: "cure", pattern: /\bcures?\b/i, why: "implies a guaranteed medical outcome" },
  { term: "guaranteed", pattern: /\bguarantee[ds]?\b/i, why: "implies a promised result" },
  { term: "miracle", pattern: /\bmiracle\b/i, why: "unsupportable claim" },
  { term: "clinically proven", pattern: /\bclinically proven\b/i, why: "requires a cited trial" },
  { term: "FDA approved", pattern: /\bFDA[- ]approved\b/i, why: "regulated claim" },
];

function issue(code, message, detail) {
  return detail === undefined ? { code, message } : { code, message, detail };
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function slugify(title) {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export { slugify };

/**
 * Validate a generated article against the universal contract plus the site's
 * registered constraints and its existing published history.
 *
 * @param article  structured generator output
 * @param site     validated registration
 * @param history  { slugs: string[], titles: string[] } already published
 */
export function validateArticle({ article, site, history = { slugs: [], titles: [] } }) {
  const issues = [];
  const ctx = site.contentContext;

  // ── shape ────────────────────────────────────────────────────────────────
  for (const field of ["title", "slug", "metaDescription", "body", "imageQuery"]) {
    if (typeof article?.[field] !== "string" || article[field].trim() === "") {
      issues.push(issue("missing-field", `Article is missing required field: ${field}.`, field));
    }
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Unsupported fields are a contract breach, not a curiosity: they mean the
  // generator and the consumer disagree about the schema.
  const ALLOWED = new Set([
    "title", "slug", "metaDescription", "body", "imageQuery",
    "keyword", "supportingKeywords", "generation",
  ]);
  for (const key of Object.keys(article)) {
    if (!ALLOWED.has(key)) {
      issues.push(issue("unsupported-field", `Article carries an unsupported field: ${key}.`, key));
    }
  }

  // ── title ────────────────────────────────────────────────────────────────
  const title = article.title.trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    issues.push(issue(
      "title-length",
      `Title must be ${TITLE_MIN}-${TITLE_MAX} characters; got ${title.length}.`,
      title.length,
    ));
  }
  if (/[.]$/.test(title)) {
    issues.push(issue("title-format", "Title must not end with a period."));
  }
  if (title !== article.title) {
    issues.push(issue("title-format", "Title must not have leading or trailing whitespace."));
  }

  // ── meta description ─────────────────────────────────────────────────────
  const meta = article.metaDescription.trim();
  if (meta.length < META_MIN || meta.length > META_MAX) {
    issues.push(issue(
      "meta-length",
      `Meta description must be ${META_MIN}-${META_MAX} characters; got ${meta.length}.`,
      meta.length,
    ));
  }

  // ── slug ─────────────────────────────────────────────────────────────────
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
    issues.push(issue("slug-format", `Slug must be lowercase kebab-case; got "${article.slug}".`));
  }
  if (history.slugs.includes(article.slug)) {
    issues.push(issue("duplicate-slug", `Slug "${article.slug}" is already published.`, article.slug));
  }
  const normalizedTitles = history.titles.map((t) => t.trim().toLowerCase());
  if (normalizedTitles.includes(title.toLowerCase())) {
    issues.push(issue("duplicate-title", `Title "${title}" is already published.`, title));
  }

  // ── body ─────────────────────────────────────────────────────────────────
  const body = article.body;
  const words = countWords(body);
  if (words < BODY_MIN_WORDS) {
    issues.push(issue("body-too-short", `Body must be at least ${BODY_MIN_WORDS} words; got ${words}.`, words));
  }
  if (words > BODY_MAX_WORDS) {
    issues.push(issue("body-too-long", `Body must be at most ${BODY_MAX_WORDS} words; got ${words}.`, words));
  }
  const h2s = [...body.matchAll(/^##\s+\S.*$/gm)];
  if (h2s.length < MIN_H2_COUNT) {
    issues.push(issue("structure", `Body needs at least ${MIN_H2_COUNT} H2 sections; found ${h2s.length}.`, h2s.length));
  }
  if (/^#\s/m.test(body)) {
    issues.push(issue("structure", "Body must not contain an H1; the title supplies it."));
  }
  // A body ending mid-sentence is the signature of a truncated generation.
  if (!/[.!?]["')\]]?\s*$/.test(body.trim())) {
    issues.push(issue("truncated-body", "Body does not end on a terminal punctuation mark."));
  }

  // ── placeholder residue ──────────────────────────────────────────────────
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(body) || pattern.test(title) || pattern.test(meta)) {
      issues.push(issue("placeholder-residue", `Output contains template or model residue: ${pattern}.`));
    }
  }

  // ── prohibited terms ─────────────────────────────────────────────────────
  const haystack = `${title}\n${meta}\n${body}`;
  for (const rule of UNIVERSAL_PROHIBITED) {
    if (rule.pattern.test(haystack)) {
      issues.push(issue(
        "prohibited-term",
        `Prohibited term "${rule.term}", ${rule.why}.`,
        rule.term,
      ));
    }
  }
  for (const term of ctx.prohibitedTerms) {
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(haystack)) {
      issues.push(issue("prohibited-term", `Prohibited term for ${site.siteId}: "${term}".`, term));
    }
  }

  // ── topic relevance ──────────────────────────────────────────────────────
  // The keyword must actually appear. A model that drifts off the assigned
  // topic produces a valid-looking article for the wrong query.
  if (article.keyword) {
    const stems = article.keyword
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3);
    const lowerHay = haystack.toLowerCase();
    const hits = stems.filter((stem) => lowerHay.includes(stem));
    if (stems.length > 0 && hits.length / stems.length < 0.5) {
      issues.push(issue(
        "topic-drift",
        `Article does not cover its assigned keyword "${article.keyword}" (${hits.length}/${stems.length} terms present).`,
        article.keyword,
      ));
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Image acceptance, kept beside article validation so both fail the same way. */
export function validateImage({ image, site, disallowedPaths }) {
  const issues = [];
  const policy = site.imagePolicy;

  if (!policy.required) {
    return { ok: true, issues };
  }
  if (!image || typeof image !== "object") {
    return { ok: false, issues: [issue("image-missing", "Image is required by policy but absent.")] };
  }
  for (const field of ["url", "alt", "provider"]) {
    if (typeof image[field] !== "string" || image[field].trim() === "") {
      issues.push(issue("image-missing-field", `Image is missing required field: ${field}.`, field));
    }
  }
  if (image.provider && image.provider !== policy.provider) {
    issues.push(issue(
      "image-provider-mismatch",
      `Image provider "${image.provider}" does not match the registered policy "${policy.provider}".`,
    ));
  }
  if (image.url && disallowedPaths?.has(image.url)) {
    issues.push(issue(
      "image-disallowed",
      `"${image.url}" is a branded social card, not an article photo.`,
      image.url,
    ));
  }
  if (image.alt && image.alt.trim().length < 15) {
    issues.push(issue("image-alt-too-short", "Image alt text must be at least 15 characters."));
  }
  if (image.width !== undefined && image.width < 1200) {
    issues.push(issue("image-too-small", `Image width ${image.width}px is below the 1200px minimum.`, image.width));
  }
  if (image.byteLength !== undefined && image.byteLength < 20_000) {
    issues.push(issue("image-too-small", `Image is ${image.byteLength}B, below the 20KB minimum.`, image.byteLength));
  }
  if (image.contentType !== undefined && !/^image\/(jpeg|png|webp)$/.test(image.contentType)) {
    issues.push(issue("image-bad-type", `Unsupported image content type: ${image.contentType}.`, image.contentType));
  }
  return { ok: issues.length === 0, issues };
}
