/**
 * Topic supply.
 *
 * A lane must not deadlock permanently because a two-row CSV ran out. That is
 * the state `bmj` and `jeffrystein` are in: two primary keywords each, both
 * already published, so `resolve-topic` fails and no occurrence can ever be
 * prepared again.
 *
 * The fix is a supply chain, not a hand-added row. Primary keywords are used
 * first and exactly once. When they are exhausted, candidates are derived from
 * the site's configured secondary sources, checked against everything already
 * published, and only then admitted.
 *
 * PROVENANCE IS RECORDED, NOT INFERRED
 *
 * Every resolved topic carries `PRIMARY_KEYWORD` or `REPLENISHED_TOPIC`. A
 * replenished topic is a legitimate article subject, but it is not the same
 * evidence as a keyword an operator researched and put in the CSV, and the
 * proof record must not blur the two.
 */

export class TopicSupplyError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "TopicSupplyError";
    this.detail = detail;
  }
}

export const TOPIC_PROVENANCE = Object.freeze({
  PRIMARY: "PRIMARY_KEYWORD",
  REPLENISHED: "REPLENISHED_TOPIC",
});

/** Tokens too common to carry meaning in a near-duplicate comparison. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "that", "the", "to", "what", "when",
  "why", "with", "you", "your",
]);

/**
 * Crude singularisation, deliberately not a full stemmer.
 *
 * Without it "baby sleep regression" and "sleep regression in babies" score 0.5
 * and read as distinct topics, when they are the same article. A real stemmer
 * would be more accurate and would also be a dependency and a new failure mode;
 * plural collapse covers the cases that actually occur in these keyword sets.
 */
function singularise(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token))
      .map(singularise),
  );
}

/**
 * Jaccard overlap between two topic strings.
 *
 * Exact-match deduplication is not enough: "baby sleep regression" and "sleep
 * regression in babies" are the same article and would cannibalize each other.
 */
export function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Fraction of `subject`'s tokens present in `text`.
 *
 * Asymmetric on purpose: used to ask "does this candidate cover that subject?",
 * which is the forbidden-topic question.
 */
export function containment(subject, text) {
  const ts = tokenize(subject);
  const tt = tokenize(text);
  if (ts.size === 0) return 0;
  let shared = 0;
  for (const token of ts) if (tt.has(token)) shared += 1;
  return shared / ts.size;
}

export const NEAR_DUPLICATE_THRESHOLD = 0.6;

/**
 * Is this candidate too close to something already published?
 * Returns the offending prior topic, or null.
 */
export function findNearDuplicate(candidate, history, threshold = NEAR_DUPLICATE_THRESHOLD) {
  for (const prior of history) {
    if (similarity(candidate, prior) >= threshold) {
      return prior;
    }
  }
  return null;
}

/**
 * Does the candidate belong to this site at all?
 *
 * Registrations already declare `forbiddenTopics` for cross-lane bleed (the
 * podiatry-versus-performance-rehab problem). A replenished topic must clear
 * that boundary before it is ever sent to a generator.
 */
export function isInScope(candidate, site) {
  const forbidden = site.contentContext?.forbiddenTopics ?? [];
  for (const topic of forbidden) {
    // CONTAINMENT, not Jaccard. A forbidden topic is usually short ("podiatry")
    // and the candidate is long, so symmetric overlap scores near zero on
    // exactly the cases that must be blocked. The question is whether the
    // candidate covers the forbidden subject, not whether they resemble
    // each other in length.
    if (containment(topic, candidate) >= 0.75) {
      return { ok: false, reason: `overlaps the forbidden topic "${topic}"` };
    }
  }
  const prohibited = site.contentContext?.prohibitedTerms ?? [];
  for (const term of prohibited) {
    if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(candidate)) {
      return { ok: false, reason: `contains the prohibited term "${term}"` };
    }
  }
  return { ok: true };
}

/**
 * Resolve the topic for one occurrence.
 *
 * @param primary    keyword rows from the site's primary CSV
 * @param secondary  configured replenishment candidates (supporting CSV rows,
 *                   topic clusters, or site-context derived subjects)
 * @param history    { titles, keywords } already published for this lane
 */
export function resolveTopic({ site, primary = [], secondary = [], history = { titles: [], keywords: [] } }) {
  const used = new Set(
    [...(history.keywords ?? [])].map((keyword) => String(keyword).trim().toLowerCase()),
  );
  const publishedSubjects = [...(history.titles ?? []), ...(history.keywords ?? [])];

  // ── primary pool first, one use each ─────────────────────────────────────
  for (const row of primary) {
    const keyword = typeof row === "string" ? row : row.keyword;
    if (!keyword || used.has(keyword.trim().toLowerCase())) continue;
    return {
      keyword,
      supporting: typeof row === "string" ? [] : row.supporting ?? [],
      provenance: TOPIC_PROVENANCE.PRIMARY,
      source: site.keywordSource?.primary ?? "primary",
    };
  }

  // ── replenishment ────────────────────────────────────────────────────────
  const rejected = [];
  for (const row of secondary) {
    const candidate = typeof row === "string" ? row : row.keyword;
    if (!candidate) continue;
    const normalized = candidate.trim().toLowerCase();

    if (used.has(normalized)) {
      rejected.push({ candidate, reason: "already published as a keyword" });
      continue;
    }
    const duplicate = findNearDuplicate(candidate, publishedSubjects);
    if (duplicate) {
      rejected.push({ candidate, reason: `near-duplicate of "${duplicate}"` });
      continue;
    }
    const scope = isInScope(candidate, site);
    if (!scope.ok) {
      rejected.push({ candidate, reason: scope.reason });
      continue;
    }
    return {
      keyword: candidate,
      supporting: typeof row === "string" ? [] : row.supporting ?? [],
      provenance: TOPIC_PROVENANCE.REPLENISHED,
      source: site.keywordSource?.secondary ?? "secondary",
      rejectedCandidates: rejected,
    };
  }

  throw new TopicSupplyError(
    `${site.siteId}: primary keywords exhausted and no replenishment candidate survived ` +
      `(${secondary.length} considered, ${rejected.length} rejected).`,
    { rejected, primaryCount: primary.length, secondaryCount: secondary.length },
  );
}
