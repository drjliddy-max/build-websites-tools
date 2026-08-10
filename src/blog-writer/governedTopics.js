/**
 * Governed-source topic replenishment.
 *
 * When a lane's configured keyword pool is exhausted, the next topic must still
 * come from something the estate governs. bmj reached that state with four
 * configured keywords and four published: the pipeline correctly refused to
 * repeat, and then had nothing to offer.
 *
 * The wrong fixes are a hand-added CSV row (undocumented human policy) and a
 * free-form model invention (ungrounded). The right source is the site's own
 * governed copy: its service and landing pages already state, in the operator's
 * words, what the product does. A blog topic derived from a shipped service
 * page is traceable to something a human wrote and reviewed.
 *
 * Every candidate carries its source file and the exact source phrase, so an
 * accepted topic can be explained rather than merely asserted.
 */

/** Phrases too generic to be a topic regardless of where they appear. */
const BOILERPLATE = [
  /^(home|blog|contact|privacy|terms|accessibility|about)$/i,
  /^(what|why|how|when|where)$/i,
  /privacy policy|terms of service|accessibility statement/i,
  /^canonical urls?$/i,
  /app store|google play/i,
  /^[a-z0-9.-]+@[a-z0-9.-]+$/i,
  /^https?:/i,
];

/** Extractable concept text from a governed page source. */
/**
 * Concept shapes, most topical first.
 *
 * A page TITLE names the page; a list item or sub-heading names a thing the
 * page is about. bmj's first accepted candidate was a title fragment
 * ("baby milestone journal app reminder-driven memory journal"), which would
 * have produced an article duplicating the service page it came from. Shape is
 * a better signal of topicality here than brand-token ratio, which that string
 * passed.
 */
export const CONCEPT_SHAPES = ["list-item", "sub-heading", "quoted-copy", "title"];

export function extractConcepts(source, { minWords = 3, maxWords = 12 } = {}) {
  const found = new Map();

  const push = (raw, shape = "quoted-copy") => {
    const text = raw
      .replace(/<[^>]*>/g, " ")
      .replace(/[{}$`]/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/[\u2014\u2013]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-*#\s]+/, "")
      .replace(/[.:,;]+$/, "");
    if (!text) return;
    const words = text.split(/\s+/);
    if (words.length < minWords || words.length > maxWords) return;
    if (BOILERPLATE.some((pattern) => pattern.test(text))) return;
    if (!/[a-z]/.test(text)) return;
    const rank = CONCEPT_SHAPES.indexOf(shape);
    const existing = found.get(text);
    if (existing === undefined || rank < existing) found.set(text, rank);
  };

  // Headings in markup, markdown headings, list items, and quoted UI copy:
  // the four shapes governed page sources actually use in this estate.
  for (const match of source.matchAll(/<h1[^>]*>([^<]{8,120})<\/h1>/gi)) push(match[1], "title");
  for (const match of source.matchAll(/<h[2-4][^>]*>([^<]{8,120})<\/h[2-4]>/gi)) push(match[1], "sub-heading");
  for (const match of source.matchAll(/^#{2,4}\s+(.{8,120})$/gm)) push(match[1], "sub-heading");
  for (const match of source.matchAll(/^[-*]\s+(.{8,120})$/gm)) push(match[1], "list-item");
  for (const match of source.matchAll(/(?:title|metadata|description)\s*[:=]\s*"([^"]{14,120})"/gi)) push(match[1], "title");
  for (const match of source.matchAll(/"([A-Z][^"]{14,120})"/g)) push(match[1], "quoted-copy");

  // Most topical shape first, so a page title cannot outrank a feature phrase.
  return [...found.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([text]) => text);
}

/**
 * Turn a governed concept into a topic candidate.
 *
 * Deliberately conservative: the concept is lowercased and stripped of leading
 * filler, not rewritten. A candidate that reads oddly should be REJECTED by the
 * downstream checks rather than smoothed over here, because smoothing is where
 * invention creeps in.
 */
export function conceptToTopic(concept) {
  return concept
    .toLowerCase()
    .replace(/^(the|a|an|our|your|what|why|how)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Load governed candidates for a site.
 *
 * `read(path)` returns governed source content; `site.topicSources` lists the
 * paths the operator has designated as topic-bearing. A site with no declared
 * topic sources yields nothing, which is correct: replenishment must not invent
 * a source that was never governed.
 */
/**
 * Is this candidate just the site's own name?
 *
 * Service pages repeat their product name in headings and titles. Those strings
 * extract cleanly and are useless as blog subjects: "baby milestone journal app"
 * on babymilestonejournal.com is navigational, not topical, and an article
 * about it would duplicate the service page it came from. Brand-dominated
 * candidates are dropped, not merely ranked lower.
 */
export function isBrandEcho(topic, site) {
  const brandTokens = new Set(
    String(site?.domain ?? "")
      .replace(/\.[a-z]+$/i, "")
      .replace(/[^a-z]/gi, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
  // A bare hostname like "babymilestonejournal" is one token; split it against
  // the candidate's own words so "baby milestone journal" is recognised.
  const joined = [...brandTokens].join("");
  const words = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return false;
  const inBrand = words.filter((w) => joined.includes(w)).length;
  return inBrand / words.length >= 0.6;
}

export function loadGovernedCandidates(site, read) {
  const sources = site?.topicSources ?? [];
  const candidates = [];
  const seen = new Set();

  for (const path of sources) {
    const source = read(path);
    if (!source) continue;
    for (const concept of extractConcepts(source)) {
      const topic = conceptToTopic(concept);
      if (!topic || seen.has(topic)) continue;
      if (isBrandEcho(topic, site)) continue;
      seen.add(topic);
      candidates.push({
        keyword: topic,
        supporting: [],
        topicSourceType: "governed-site-content",
        sourceRef: path,
        sourceConcept: concept,
      });
    }
  }
  return candidates;
}

/**
 * Explain a replenishment decision.
 *
 * The point of provenance is that a human can audit why this topic and not
 * another, months later, without re-running anything.
 */
export function explainCandidate(candidate, verdict) {
  return {
    topic: candidate.keyword,
    topicSourceType: candidate.topicSourceType ?? "configured-keyword",
    sourceRef: candidate.sourceRef ?? null,
    sourceConcept: candidate.sourceConcept ?? null,
    normalizedTopic: conceptToTopic(candidate.keyword),
    duplicateVerdict: verdict.duplicate ?? "none",
    containmentVerdict: verdict.containment ?? "none",
    scopeVerdict: verdict.scope ?? "in-scope",
    provenance: verdict.provenance,
  };
}
