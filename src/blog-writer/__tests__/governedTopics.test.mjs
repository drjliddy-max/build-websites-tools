/**
 * Governed-source replenishment.
 *
 * bmj is the regression case, not the architecture: nothing here is
 * bmj-specific, and no test hardcodes a topic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractConcepts, conceptToTopic, loadGovernedCandidates, isBrandEcho,
  explainCandidate, CONCEPT_SHAPES,
} from "../governedTopics.js";
import { resolveTopic, TOPIC_PROVENANCE } from "../topicSupply.js";

const PAGE = `
export const metadata = { title: "Baby Milestone Journal App" };
<h1>Baby Milestone Journal App</h1>
<h2>What the app includes</h2>
- Reminder-driven milestone prompts
- Monthly photo nudges and timeline organization
"Private memory notes alongside milestone entries"
`;

const SITE = {
  siteId: "bmj", domain: "babymilestonejournal.com",
  topicSources: ["page.tsx"],
  contentContext: { prohibitedTerms: [], forbiddenTopics: ["ADA compliance"] },
};

test("a page title cannot outrank a feature phrase", () => {
  const concepts = extractConcepts(PAGE);
  const listItem = concepts.indexOf("Reminder-driven milestone prompts");
  const title = concepts.indexOf("Baby Milestone Journal App");
  assert.ok(listItem >= 0, "list item must be extracted");
  if (title >= 0) assert.ok(listItem < title, "list item must rank above the page title");
  assert.deepEqual(CONCEPT_SHAPES[0], "list-item");
});

test("brand echoes are dropped, not merely ranked lower", () => {
  assert.equal(isBrandEcho("baby milestone journal", SITE), true);
  assert.equal(isBrandEcho("reminder-driven milestone prompts", SITE), false);
  const candidates = loadGovernedCandidates(SITE, () => PAGE);
  assert.ok(!candidates.some((c) => c.keyword === "baby milestone journal"));
});

test("every candidate carries its governed source", () => {
  for (const candidate of loadGovernedCandidates(SITE, () => PAGE)) {
    assert.equal(candidate.topicSourceType, "governed-site-content");
    assert.equal(candidate.sourceRef, "page.tsx");
    assert.ok(candidate.sourceConcept.length > 0);
  }
});

test("a site with no declared topic sources yields nothing, it does not invent one", () => {
  assert.deepEqual(loadGovernedCandidates({ siteId: "x", domain: "x.com" }, () => PAGE), []);
});

test("boilerplate and navigation are not topics", () => {
  const concepts = extractConcepts(`
- Privacy policy
- https://example.com/blog
- support@example.com
## Canonical URLs
- Reminder-driven milestone prompts
`);
  assert.deepEqual(concepts, ["Reminder-driven milestone prompts"]);
});

test("conceptToTopic normalises without rewriting", () => {
  assert.equal(conceptToTopic("The Reminder-Driven Milestone Prompts"), "reminder-driven milestone prompts");
  assert.equal(conceptToTopic("What makes it useful"), "makes it useful");
});

// ── the shared pipeline, exercised end to end ─────────────────────────────

const HISTORY = { titles: ["Monthly photo nudges and timeline organization"], keywords: ["baby photo book"] };

test("unused primary topic wins over any governed candidate", () => {
  const topic = resolveTopic({
    site: SITE, primary: [{ keyword: "unused primary" }],
    secondary: loadGovernedCandidates(SITE, () => PAGE), history: HISTORY,
  });
  assert.equal(topic.provenance, TOPIC_PROVENANCE.PRIMARY);
});

test("exhausted pool falls through to a governed candidate with provenance", () => {
  const topic = resolveTopic({
    site: SITE, primary: [{ keyword: "baby photo book" }],
    secondary: loadGovernedCandidates(SITE, () => PAGE), history: HISTORY,
  });
  assert.equal(topic.provenance, TOPIC_PROVENANCE.REPLENISHED);
  assert.equal(topic.topicSourceType, "governed-site-content");
  assert.ok(topic.sourceRef, "accepted topic must name its source file");
  assert.ok(topic.sourceConcept, "accepted topic must name its source phrase");
});

test("a governed candidate duplicating a published title is rejected", () => {
  const topic = resolveTopic({
    site: SITE, primary: [{ keyword: "baby photo book" }],
    secondary: loadGovernedCandidates(SITE, () => PAGE), history: HISTORY,
  });
  assert.notEqual(topic.keyword, "monthly photo nudges and timeline organization");
  assert.ok(topic.rejectedCandidates.some((r) => /near-duplicate|already published/.test(r.reason)));
});

test("a cross-lane governed candidate is rejected", () => {
  const topic = resolveTopic({
    site: SITE, primary: [],
    secondary: [
      { keyword: "ADA compliance for websites", topicSourceType: "governed-site-content", sourceRef: "x", sourceConcept: "x" },
      { keyword: "reminder-driven milestone prompts", topicSourceType: "governed-site-content", sourceRef: "p", sourceConcept: "c" },
    ],
    history: { titles: [], keywords: [] },
  });
  assert.equal(topic.keyword, "reminder-driven milestone prompts");
  assert.match(topic.rejectedCandidates[0].reason, /forbidden topic/);
});

test("explainCandidate produces an auditable decision record", () => {
  const record = explainCandidate(
    { keyword: "reminder-driven milestone prompts", topicSourceType: "governed-site-content", sourceRef: "page.tsx", sourceConcept: "Reminder-driven milestone prompts" },
    { provenance: TOPIC_PROVENANCE.REPLENISHED },
  );
  for (const key of ["topic","topicSourceType","sourceRef","sourceConcept","normalizedTopic","duplicateVerdict","containmentVerdict","scopeVerdict","provenance"]) {
    assert.ok(key in record, `missing ${key}`);
  }
});
