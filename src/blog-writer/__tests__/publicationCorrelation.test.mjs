// OBJ-d23f3769adcc PE-1 + PE-2: a scheduled publication is provable only when the GitHub run is
// correlated with the Site Monitor job record that dispatched it. Site Monitor finds the run by
// the dispatch triple echoed into the proof, so the triple must (a) name this lane and this slot
// (PE-1, pipeline binding), (b) reach the proof at all (PE-2, the consumer workflow must take and
// forward it), and (c) keep one machine shape both sides can check (PE-1, schema).
//
// Regression cases from the assignment: missing job record, manual vs scheduled, failed
// execution, wrong schedule slot, incomplete publication evidence. Those observable here are
// below; the Site Monitor side (missing row, provenance) lives in site-monitor.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildProof } from "../proof.js";
import { runBlogWriterPipeline } from "../pipeline.js";
import { checkParticipant, checkPublishWorkflow } from "../estateGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "../../..");
const SCHEMA = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "contracts/publication-proof-v2.schema.json"), "utf8"));

const LANE = "blog-writer-qirofit";
const OCCURRENCE = "2026-08-22"; // on the lattice anchored at 2026-08-08
const DISPATCH = { jobKey: LANE, idempotencyKey: `${LANE}:${OCCURRENCE}:1`, correlationId: "sched-1786400000000" };

// Minimal deps: enough to pass registration and the occurrence lattice, then stop at the
// idempotency stage (no model, no network). What matters is whether correlate-dispatch ran/refused.
const deps = (reported = []) => ({
  registry: { get: () => ({ siteId: "qirofit", laneKey: LANE, publication: { schedulePath: "s.json" } }) },
  schedule: { load: async () => ({ published: [{ target_date: "2026-08-08" }] }) },
  reporter: {
    report: async (p) => reported.push(p),
    alreadyPublished: async () => { throw new Error("stop after binding"); },
    latestFor: async () => null,
  },
});

const run = (dispatch, mode = "publish", occurrence = OCCURRENCE, reported = []) =>
  runBlogWriterPipeline({ siteId: "qirofit", occurrence, mode, dispatch }, deps(reported));

// ── PE-1: dispatch binding ──────────────────────────────────────────────────
test("matching dispatch passes the binding stage", async () => {
  const result = await run(DISPATCH);
  const stage = result.stages.find((s) => s.stage === "correlate-dispatch");
  assert.ok(stage?.ok, JSON.stringify(result.stages));
  assert.notEqual(result.proof.failure?.stage, "correlate-dispatch");
});

test("NEGATIVE wrong slot: a key for another occurrence is refused before anything publishes", async () => {
  const reported = [];
  const result = await run({ ...DISPATCH, idempotencyKey: `${LANE}:2026-08-08:1` }, "publish", OCCURRENCE, reported);
  assert.equal(result.ok, false);
  assert.equal(result.proof.state, "FAILED");
  assert.equal(result.proof.failure.stage, "correlate-dispatch");
  assert.match(result.proof.failure.reason, /wrong lane or wrong slot/);
  assert.equal(reported[0].dispatch.idempotencyKey, `${LANE}:2026-08-08:1`, "the refused identity is still recorded");
});

test("NEGATIVE wrong lane: a jobKey naming another lane is refused", async () => {
  const result = await run({ ...DISPATCH, jobKey: "blog-writer-ada" });
  assert.equal(result.proof.failure.stage, "correlate-dispatch");
  assert.match(result.proof.failure.reason, /does not name this lane/);
});

test("NEGATIVE: a manual retry key (attempt 2) is not this occurrence's key", async () => {
  const result = await run({ ...DISPATCH, idempotencyKey: `${LANE}:${OCCURRENCE}:2` });
  assert.equal(result.proof.failure.stage, "correlate-dispatch");
});

test("binding applies in dry-run too: a mis-addressed dispatch is wrong whatever the mode", async () => {
  const result = await run({ ...DISPATCH, jobKey: "blog-writer-ada" }, "dry-run");
  assert.equal(result.proof.failure.stage, "correlate-dispatch");
});

test("backward compatible: null dispatch skips the binding stage (dry-runs, library callers)", async () => {
  const result = await run(null);
  assert.equal(result.stages.some((s) => s.stage === "correlate-dispatch"), false);
  assert.equal(result.proof.dispatch, null);
});

test("lattice still decides first: an off-lattice slot fails resolve-occurrence, not binding", async () => {
  const result = await run({ ...DISPATCH, idempotencyKey: `${LANE}:2026-08-15:1` }, "publish", "2026-08-15");
  assert.equal(result.proof.failure.stage, "resolve-occurrence");
});

// ── PE-1: schema ────────────────────────────────────────────────────────────
// Minimal validator for the keywords the schema uses (no dependency is added for one file).
function validate(schema, value, at = "$") {
  const errors = [];
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types && !types.includes(typeOf(value)) && !(types.includes("number") && typeof value === "number")) {
    return [`${at}: type ${typeOf(value)} not in ${types}`];
  }
  if ("const" in schema && value !== schema.const) errors.push(`${at}: expected const ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${value} not in enum`);
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern`);
  if (schema.minLength && typeof value === "string" && value.length < schema.minLength) errors.push(`${at}: minLength`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key}: required`);
    for (const [key, sub] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], sub, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`);
    }
  }
  return errors;
}

const proofArgs = (over = {}) => ({
  laneKey: LANE, siteId: "qirofit", occurrence: OCCURRENCE, state: "COMPLETE",
  article: { title: "t", slug: "s", metaDescription: "m", body: "one two three", keyword: "k" },
  image: { url: "/photos/x.jpg", alt: "a", provider: "pexels" },
  publication: { commitSha: "deadbeef", publishMode: "staged", stagedVia: "blog-writer/stage-deadbeef0000" },
  verification: { articleStatus: 200 },
  provenance: { classification: "NEW_CANONICAL", generatedBy: "canonical-pipeline" },
  pipelineVersion: "1.0.0", startedAt: "2026-08-22T08:00:00Z", completedAt: "2026-08-22T08:03:00Z",
  dispatch: DISPATCH, ...over,
});

test("schema accepts a COMPLETE correlated proof, a FAILED proof, and an uncorrelated dry-run proof", async () => {
  const failed = (await run({ ...DISPATCH, jobKey: "blog-writer-ada" })).proof;
  for (const proof of [buildProof(proofArgs()), failed, buildProof(proofArgs({ dispatch: null, state: "VALIDATED" }))]) {
    assert.deepEqual(validate(SCHEMA, proof), [], JSON.stringify(proof));
  }
});

test("schema required list is exactly the keys buildProof emits (code and schema cannot drift)", () => {
  assert.deepEqual([...SCHEMA.required].sort(), Object.keys(buildProof(proofArgs())).sort());
});

test("NEGATIVE schema: partial dispatch, wrong version, unknown field are rejected", () => {
  const proof = buildProof(proofArgs());
  assert.ok(validate(SCHEMA, { ...proof, dispatch: { jobKey: LANE } }).length > 0);
  assert.ok(validate(SCHEMA, { ...proof, proofVersion: 1 }).length > 0);
  assert.ok(validate(SCHEMA, { ...proof, publishedSha: "x" }).length > 0);
});

// ── PE-2: publish workflow guard ────────────────────────────────────────────
const WORKFLOW = `name: Publish
on:
  workflow_dispatch:
    inputs:
      jobKey:
        description: Site Monitor automation key
        required: true
        type: string
      idempotencyKey:
        required: true
        type: string
      correlationId:
        required: true
        type: string
      targetDate:
        required: true
        type: string
jobs:
  publish:
    steps:
      - name: Publish
        run: |
          node .siteclinic/automation/${LANE}/runWorkflow.mjs \\
            --jobKey "$JOB_KEY" \\
            --idempotencyKey "$IDEMPOTENCY_KEY" \\
            --correlationId "$CORRELATION_ID" \\
            --targetDate "$TARGET_DATE" \\
            --proofOutputPath "$PROOF_PATH"
          exit_code=$?
      - uses: actions/upload-artifact@v4
        with:
          name: ${LANE}-proof-\${{ github.run_id }}
      - name: Enforce truthful completion
        run: |
          if (proof.proofVersion !== 2 || proof.pipeline !== "canonical-blog-writer") { throw 1 }
          if (proof.state !== "COMPLETE") { throw 2 }
`;
const codes = (yaml) => checkPublishWorkflow(LANE, yaml).map((f) => f.code);

test("a governed-shape workflow passes", () => assert.deepEqual(codes(WORKFLOW), []));

const NEGATIVES = [
  ["an optional input yields uncorrelated runs", WORKFLOW.replace(/(correlationId:\n\s+)required: true/, "$1required: false"), "workflow-input-optional"],
  ["an undeclared input", WORKFLOW.replace(/      targetDate:\n        required: true\n        type: string\n/, ""), "workflow-input-missing"],
  ["an unforwarded flag", WORKFLOW.replace(/--correlationId "\$CORRELATION_ID" \\\n\s+/, ""), "workflow-flag-missing"],
  ["a self-schedule makes runs with no job record", WORKFLOW.replace("on:\n", "on:\n  schedule:\n    - cron: '13 8 * * 2'\n"), "workflow-self-scheduled"],
  ["a renamed artifact Site Monitor never finds", WORKFLOW.replace(`${LANE}-proof-`, `${LANE}-evidence-`), "workflow-proof-artifact"],
  ["a dropped completion check lets FAILED finish green", WORKFLOW.replace('proof.state !== "COMPLETE"', "false"), "workflow-completion-unenforced"],
  ["a commented-out completion check does not count", WORKFLOW.replace(/^(\s+)if \(proof\.state/m, "$1# if (proof.state"), "workflow-completion-unenforced"],
  ["a workflow that is not dispatched", WORKFLOW.replace("workflow_dispatch:", "push:"), "workflow-not-dispatched"],
];
for (const [name, yaml, code] of NEGATIVES) {
  test(`NEGATIVE workflow: ${name}`, () => assert.ok(codes(yaml).includes(code), JSON.stringify(codes(yaml))));
}

test("participant check: workflow inspection is opt-in, and a missing workflow fails when on", () => {
  const read = (p) => {
    if (p === "package.json") return JSON.stringify({ devDependencies: { "build-websites-tools": "github:x/y#v0.34.0" } });
    if (p.endsWith("site.config.json")) return JSON.stringify({ configVersion: 1, laneKey: LANE });
    if (p.endsWith("runWorkflow.mjs")) return 'import { runBlogWriterPipeline } from "build-websites-tools/blog-writer"; runBlogWriterPipeline();';
    return null;
  };
  const participant = { siteId: "qirofit", repo: "qirofit-web", laneKey: LANE };
  assert.deepEqual(checkParticipant(participant, read, { approvedPins: ["v0.34.0"] }).failures, []);
  const on = checkParticipant(participant, read, { approvedPins: ["v0.34.0"], checkWorkflow: true });
  assert.ok(on.failures.some((f) => f.code === "missing-publish-workflow"), JSON.stringify(on.failures));
});

// Governed truth: wherever the consumer checkouts are reachable, every real publish workflow
// passes (skipped, not passed, where they are not, as in this package's own CI).
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "contracts/blog-writer-participants.json"), "utf8"));
for (const participant of MANIFEST.participants) {
  test(`GOVERNED: ${participant.repo} publish workflow passes at origin/main`, (t) => {
    let yaml;
    try {
      yaml = execFileSync("git", ["-C", path.join(PKG_ROOT, "..", participant.repo), "show",
        `origin/main:.github/workflows/${participant.laneKey}-publish.yml`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return t.skip(`${participant.repo} not reachable from ${PKG_ROOT}`);
    }
    assert.deepEqual(checkPublishWorkflow(participant.laneKey, yaml), []);
  });
}
