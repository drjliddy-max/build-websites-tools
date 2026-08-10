/**
 * Estate guard negative controls.
 *
 * The guard this replaces scanned one repository for function-name patterns and
 * passed for months while seven byte-distinct orchestrators ran in production.
 * A guard that cannot fail on the thing it forbids is decoration, so every
 * forbidden signature below is proven to actually fail the gate.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { checkParticipant, checkEstate, FORBIDDEN_SIGNATURES } from "../estateGuard.js";

const PARTICIPANT = { siteId: "qirofit", laneKey: "blog-writer-qirofit", repo: "qirofit-web" };
const OPTIONS = { approvedPins: ["v0.16.0"] };
const LANE = ".siteclinic/automation/blog-writer-qirofit";

const GOOD_ENTRY = `
import { runBlogWriterPipeline, buildRegistry } from "build-websites-tools/blog-writer";
const site = JSON.parse(await fs.readFile("site.config.json", "utf8"));
const result = await runBlogWriterPipeline({ siteId: site.siteId, occurrence, mode }, deps);
process.exitCode = result.ok ? 0 : 1;
`;

function reader(files) {
  return (filePath) => files[filePath] ?? null;
}

function baseFiles(overrides = {}) {
  return {
    "package.json": JSON.stringify({ devDependencies: { "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.16.0" } }),
    [`${LANE}/site.config.json`]: JSON.stringify({ configVersion: 1, laneKey: "blog-writer-qirofit" }),
    [`${LANE}/runWorkflow.mjs`]: GOOD_ENTRY,
    ...overrides,
  };
}

test("PASS: a thin canonical entrypoint passes", () => {
  const result = checkParticipant(PARTICIPANT, reader(baseFiles()), OPTIONS);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

// ── required negative controls ─────────────────────────────────────────────

test("FAIL: canonical dependency removed", () => {
  const result = checkParticipant(
    PARTICIPANT,
    reader(baseFiles({ "package.json": JSON.stringify({ devDependencies: {} }) })),
    OPTIONS,
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === "missing-canonical-dependency"));
});

test("FAIL: an unapproved (stale) pin", () => {
  const result = checkParticipant(
    PARTICIPANT,
    reader(baseFiles({ "package.json": JSON.stringify({ devDependencies: { "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.11.3" } }) })),
    OPTIONS,
  );
  assert.ok(result.failures.some((f) => f.code === "unapproved-pin"));
});

test("FAIL: full runWorkflow orchestration restored", () => {
  const legacy = `
    const SCHEDULER_WEEKDAYS = new Set([2, 4]);
    function selectQueuedPost(schedule, targetDate) { return schedule.queue.filter((i) => i.target_date === targetDate)[0]; }
    async function stageAndCommit({ proof, paths }) { await git(["commit", "-m", "x"]); }
    const repoProof = { proofVersion: 1, jobKey };
  `;
  const result = checkParticipant(PARTICIPANT, reader(baseFiles({ [`${LANE}/runWorkflow.mjs`]: legacy })), OPTIONS);
  assert.equal(result.ok, false);
  for (const code of ["local-cadence-authority", "local-proof-writer", "local-publication-orchestrator", "missing-canonical-import"]) {
    assert.ok(result.failures.some((f) => f.code === code), `expected ${code}`);
  }
});

test("FAIL: a local scheduler added beside a canonical call", () => {
  const entry = `${GOOD_ENTRY}\nconst SCHEDULER_WEEKDAYS = new Set([2, 4]);\n`;
  const result = checkParticipant(PARTICIPANT, reader(baseFiles({ [`${LANE}/runWorkflow.mjs`]: entry })), OPTIONS);
  assert.ok(result.failures.some((f) => f.code === "local-cadence-authority"));
});

test("FAIL: a local generator added beside a canonical call", () => {
  const entry = `${GOOD_ENTRY}\nfunction buildPrompt({ site }) { return "write me an article"; }\n`;
  const result = checkParticipant(PARTICIPANT, reader(baseFiles({ [`${LANE}/runWorkflow.mjs`]: entry })), OPTIONS);
  assert.ok(result.failures.some((f) => f.code === "local-generator"));
});

test("FAIL: a local proof writer added beside a canonical call", () => {
  const entry = `${GOOD_ENTRY}\nawait writeJson(proofPath, { proofVersion: 1, slug });\n`;
  const result = checkParticipant(PARTICIPANT, reader(baseFiles({ [`${LANE}/runWorkflow.mjs`]: entry })), OPTIONS);
  assert.ok(result.failures.some((f) => f.code === "local-proof-writer"));
});

test("FAIL: local draft validation added beside a canonical call", () => {
  const entry = `${GOOD_ENTRY}\nconst governance = validateQirofitDraft({ content, scheduleEntry });\n`;
  const result = checkParticipant(PARTICIPANT, reader(baseFiles({ [`${LANE}/runWorkflow.mjs`]: entry })), OPTIONS);
  assert.ok(result.failures.some((f) => f.code === "local-validation"));
});

test("FAIL: site config absent", () => {
  const files = baseFiles();
  delete files[`${LANE}/site.config.json`];
  const result = checkParticipant(PARTICIPANT, reader(files), OPTIONS);
  assert.ok(result.failures.some((f) => f.code === "missing-site-config"));
});

test("FAIL: an unsupported config version", () => {
  const result = checkParticipant(
    PARTICIPANT,
    reader(baseFiles({ [`${LANE}/site.config.json`]: JSON.stringify({ configVersion: 99, laneKey: "blog-writer-qirofit" }) })),
    OPTIONS,
  );
  assert.ok(result.failures.some((f) => f.code === "invalid-config-version"));
});

// ── the guard must not be fooled by prose ──────────────────────────────────

test("comments describing removed orchestration do not count as orchestration", () => {
  const entry = `
/**
 * This file used to carry SCHEDULER_WEEKDAYS, stageAndCommit and proofVersion:.
 * All of it is canonical now.
 */
// const SCHEDULER_WEEKDAYS = new Set([2, 4]);
${GOOD_ENTRY}`;
  const result = checkParticipant(PARTICIPANT, reader(baseFiles({ [`${LANE}/runWorkflow.mjs`]: entry })), OPTIONS);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

// ── every forbidden signature must be reachable ────────────────────────────

test("every forbidden signature is load-bearing", () => {
  const samples = {
    "local-cadence-authority": "const SCHEDULER_WEEKDAYS = new Set([2,4]);",
    "local-generator": "function buildPrompt(x) {}",
    "local-proof-writer": "const p = { proofVersion: 1 };",
    "local-publication-orchestrator": "await stageAndCommit({ paths });",
    "local-queue-policy": "function selectQueuedPost(s, d) {}",
    "local-validation": "validateBookDraft({ content });",
  };
  for (const rule of FORBIDDEN_SIGNATURES) {
    const sample = samples[rule.code];
    assert.ok(sample, `no sample for ${rule.code}`);
    assert.ok(rule.pattern.test(sample), `${rule.code} does not match its own sample`);
  }
});

// ── estate roll-up ─────────────────────────────────────────────────────────

test("checkEstate reports per-site results and an accurate count", () => {
  const manifest = {
    approvedPins: ["v0.16.0"],
    participants: [PARTICIPANT, { siteId: "legacy", laneKey: "blog-writer-legacy", repo: "legacy-web" }],
  };
  const report = checkEstate({
    manifest,
    readerFor: (p) => (p.siteId === "qirofit" ? reader(baseFiles()) : () => null),
  });
  assert.equal(report.ok, false);
  assert.equal(report.participants, 2);
  assert.equal(report.canonicalConsumers, 1);
  assert.match(report.summary, /1\/2 participants FAILED: legacy/);
});
