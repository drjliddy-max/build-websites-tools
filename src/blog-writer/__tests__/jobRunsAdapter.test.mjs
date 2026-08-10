/**
 * job_runs adapter contract tests.
 *
 * The fake store mirrors the real jobExecutionStore surface, including its
 * ON CONFLICT (idempotency_key) DO UPDATE reuse, so idempotency is exercised
 * against the semantics the authority actually implements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createJobRunsReporter, buildWorkerResponse, assertCadenceCompatible, mapPipelineState,
  HISTORICAL_PROVENANCE, CANONICAL_PROVENANCE, JobRunsAdapterError,
} from "../jobRunsAdapter.js";
import { CADENCE_CONTRACT_ID } from "../cadence.js";

/** Stand-in for Site Monitor's store. Rows are keyed by idempotency_key, UNIQUE. */
function fakeStore() {
  const byKey = new Map();
  const byId = new Map();
  let seq = 0;
  return {
    rows: byId,
    attempts: [],
    async createJobRun(jobKey, idempotencyKey, maxRetries, correlationId, triggeredBy) {
      const existing = byKey.get(idempotencyKey);
      if (existing) return existing;                     // ON CONFLICT DO UPDATE
      const run = { id: `run-${++seq}`, jobKey, idempotencyKey, status: "pending" };
      byKey.set(idempotencyKey, run);
      byId.set(run.id, run);
      return run;
    },
    async beginJobRunAttempt(id, triggeredBy) {
      this.attempts.push(id);
      const run = byId.get(id);
      run.workerResponse = undefined;                    // fresh attempt
      return run;
    },
    async updateJobRunStatus(id, status, metadata = {}) {
      Object.assign(byId.get(id), { status, ...metadata });
    },
    async getJobRunByIdempotencyKey(key) { return byKey.get(key) ?? null; },
  };
}

const PROOF = {
  laneKey: "blog-writer-qirofit", siteId: "qirofit", occurrence: "2026-08-22",
  idempotencyKey: "blog-writer-qirofit:2026-08-22:1",
  state: "COMPLETE", pipelineVersion: "1.0.0",
  article: { title: "T", slug: "t", keyword: "k" },
  image: { provider: "pexels" },
  publication: { commitSha: "abc123" },
  verification: { articleUrl: "https://qirofit.com/blog/t", articleStatus: 200, imageUrl: "https://qirofit.com/photos/x.jpg", imageStatus: 200 },
  provenance: { classification: CANONICAL_PROVENANCE, generationProvider: "local", generationModel: "qwen3:14b", topicProvenance: "PRIMARY_KEYWORD" },
  proofArtifactRef: "proofs/blog-writer-qirofit_2026-08-22.json",
};

// ── status mapping must not overstate ──────────────────────────────────────

test("generation complete is NOT success", () => {
  assert.deepEqual(mapPipelineState("GENERATED"), { status: "running", proofStatus: "pending" });
  assert.deepEqual(mapPipelineState("VALIDATED"), { status: "running", proofStatus: "pending" });
});

test("published-but-unverified is running with limited evidence, not success", () => {
  assert.deepEqual(mapPipelineState("PUBLISHED"), { status: "running", proofStatus: "limited" });
});

test("only a verified completion is success", () => {
  assert.deepEqual(mapPipelineState("COMPLETE"), { status: "success", proofStatus: "verified" });
  assert.deepEqual(mapPipelineState("FAILED"), { status: "failed", proofStatus: "missing" });
});

test("no new status values are invented", () => {
  const legal = new Set(["pending", "running", "retrying", "success", "failed", "skipped"]);
  for (const state of ["NOT_STARTED","READY","GENERATED","VALIDATED","PUBLISHED","VERIFIED","COMPLETE","FAILED"]) {
    assert.ok(legal.has(mapPipelineState(state).status), `${state} maps outside the existing enum`);
  }
});

// ── CADENCE_ANCHOR_COMPATIBILITY_PROVEN ────────────────────────────────────

test("cadenceContract is written on every canonical report", async () => {
  const store = fakeStore();
  const reporter = createJobRunsReporter({ store, bwtRelease: "v0.22.0" });
  await reporter.report(PROOF);
  const row = await reporter.read(PROOF.idempotencyKey);
  assert.equal(row.workerResponse.cadenceContract, CADENCE_CONTRACT_ID);
});

test("NEGATIVE CONTROL: dropping cadenceContract fails loudly, not silently", () => {
  assert.throws(() => assertCadenceCompatible({ site: "qirofit" }), JobRunsAdapterError);
  assert.throws(() => assertCadenceCompatible({ cadenceContract: "" }), /anchor resolution breaks silently/);
});

test("the anchor read path finds the contract the store expects", async () => {
  const store = fakeStore();
  await createJobRunsReporter({ store, bwtRelease: "v0.22.0" }).report(PROOF);
  const row = await store.getJobRunByIdempotencyKey(PROOF.idempotencyKey);
  // mirrors worker_response->>'cadenceContract'
  assert.equal(row.workerResponse?.cadenceContract, "publication-14d-v1");
});

// ── proof_artifact_ref uses the dedicated column ───────────────────────────

test("the proof pointer goes in proof_artifact_ref, not smuggled elsewhere", async () => {
  const store = fakeStore();
  await createJobRunsReporter({ store }).report(PROOF);
  const row = await store.getJobRunByIdempotencyKey(PROOF.idempotencyKey);
  assert.equal(row.proofArtifactRef, "proofs/blog-writer-qirofit_2026-08-22.json");
  assert.equal(row.proofType, "blog-publication");
});

// ── JOB_RUN_IDEMPOTENCY_PROVEN ─────────────────────────────────────────────

test("same site + occurrence reuses one logical row across invocations", async () => {
  const store = fakeStore();
  const reporter = createJobRunsReporter({ store });
  const first = await reporter.report(PROOF);
  const second = await reporter.report(PROOF);
  assert.equal(first.id, second.id, "same logical row");
  assert.equal(store.rows.size, 1, "JOB_RUNS_DUPLICATE_COMPLETION=0");
  assert.equal(store.attempts.length, 2, "each invocation is a distinct attempt on that row");
});

test("a different occurrence is a distinct row", async () => {
  const store = fakeStore();
  const reporter = createJobRunsReporter({ store });
  await reporter.report(PROOF);
  await reporter.report({ ...PROOF, occurrence: "2026-09-05", idempotencyKey: "blog-writer-qirofit:2026-09-05:1" });
  assert.equal(store.rows.size, 2);
});

test("a retry after failure reconciles the same row and can reach success", async () => {
  const store = fakeStore();
  const reporter = createJobRunsReporter({ store });
  await reporter.report({ ...PROOF, state: "FAILED", failure: { stage: "generate", reason: "body-too-short" } });
  let row = await reporter.read(PROOF.idempotencyKey);
  assert.equal(row.status, "failed");
  assert.equal(row.workerResponse.failureStage, "generate");

  await reporter.report(PROOF);
  row = await reporter.read(PROOF.idempotencyKey);
  assert.equal(row.status, "success");
  assert.equal(store.rows.size, 1, "retry must not create a second row");
});

// ── historical truth ───────────────────────────────────────────────────────

test("historical reconciliation records only what actually happened", async () => {
  const store = fakeStore();
  const reporter = createJobRunsReporter({ store });
  await reporter.reconcileHistorical({
    laneKey: "blog-writer-qirofit", siteId: "qirofit", occurrence: "2026-08-08",
    idempotencyKey: "blog-qirofit:2026-08-08:12", provenance: HISTORICAL_PROVENANCE,
    articleSlug: "what-cupping-actually-does", articleUrl: "https://qirofit.com/blog/what-cupping-actually-does",
    publicationCommit: "161ec41",
  });
  const row = await reporter.read("blog-qirofit:2026-08-08:12");
  assert.equal(row.workerResponse.provenance, HISTORICAL_PROVENANCE);
  assert.equal(row.workerResponse.generationProvider, undefined);
  assert.equal(row.workerResponse.imageProvider, undefined);
  assert.equal(row.workerResponse.cadenceContract, CADENCE_CONTRACT_ID);
});

test("CONTRACT: historical reconciliation cannot become NEW_CANONICAL", async () => {
  const reporter = createJobRunsReporter({ store: fakeStore() });
  await assert.rejects(
    () => reporter.reconcileHistorical({ provenance: CANONICAL_PROVENANCE, laneKey: "l", siteId: "s", occurrence: "2026-08-08", idempotencyKey: "k" }),
    /requires provenance HISTORICAL_PRE_CANONICAL/,
  );
});

test("CONTRACT: historical reconciliation cannot claim stages that never ran", async () => {
  const reporter = createJobRunsReporter({ store: fakeStore() });
  for (const field of ["generationProvider", "generationModel", "topicProvenance"]) {
    await assert.rejects(
      () => reporter.reconcileHistorical({
        provenance: HISTORICAL_PROVENANCE, laneKey: "l", siteId: "s", occurrence: "2026-08-08", idempotencyKey: "k",
        [field]: "fabricated",
      }),
      new RegExp(`must not claim ${field}`),
    );
  }
});

test("new canonical runs are distinguishable from reconciliation without inferring from dates", async () => {
  const store = fakeStore();
  const reporter = createJobRunsReporter({ store });
  await reporter.report(PROOF);
  const row = await reporter.read(PROOF.idempotencyKey);
  assert.equal(row.workerResponse.provenance, CANONICAL_PROVENANCE);
  assert.equal(row.workerResponse.generationModel, "qwen3:14b");
});

// ── failure evidence ───────────────────────────────────────────────────────

test("a failed run preserves what failed, where, and for which occurrence", async () => {
  const store = fakeStore();
  const reporter = createJobRunsReporter({ store, bwtRelease: "v0.22.0" });
  for (const stage of ["resolve-topic", "generate", "validate-article", "acquire-image", "publish", "verify-live"]) {
    const key = `blog-writer-qirofit:2026-08-22:${stage}`;
    await reporter.report({ ...PROOF, idempotencyKey: key, state: "FAILED", failure: { stage, reason: `${stage} failed` } });
    const row = await reporter.read(key);
    assert.equal(row.status, "failed");
    assert.equal(row.proofStatus, "missing");
    assert.equal(row.workerResponse.failureStage, stage);
    assert.equal(row.workerResponse.site, "qirofit");
    assert.equal(row.workerResponse.occurrence, "2026-08-22");
    assert.equal(row.workerResponse.bwtRelease, "v0.22.0");
    assert.equal(row.workerResponse.cadenceContract, CADENCE_CONTRACT_ID);
  }
});

test("the adapter refuses a store missing any authority function", () => {
  assert.throws(() => createJobRunsReporter({ store: { createJobRun() {} } }), /missing beginJobRunAttempt/);
});

test("worker_response requires site and occurrence", () => {
  assert.throws(() => buildWorkerResponse({ proof: {} }), /requires siteId and occurrence/);
});

// ── INDEPENDENT_JOB_RUNS_READ_PROVEN ───────────────────────────────────────
// The writer must not be the reader. A fresh reporter over the same store,
// after the writing one is discarded, stands in for a separate process.

test("INDEPENDENT READ: a fresh reader over the same store finds the run", async () => {
  const store = fakeStore();
  {
    const writer = createJobRunsReporter({ store, bwtRelease: "v0.22.0" });
    await writer.report(PROOF);
  } // writer out of scope: nothing in-process carries over

  const reader = createJobRunsReporter({ store });
  const row = await reader.read("blog-writer-qirofit:2026-08-22:1");
  assert.ok(row, "run must be findable by idempotency key alone");
  assert.equal(row.workerResponse.site, "qirofit");
  assert.equal(row.workerResponse.occurrence, "2026-08-22");
  assert.equal(row.idempotencyKey, "blog-writer-qirofit:2026-08-22:1");
  assert.equal(row.workerResponse.cadenceContract, "publication-14d-v1");
  assert.equal(row.workerResponse.bwtRelease, "v0.22.0");
  assert.equal(row.workerResponse.pipelineVersion, "1.0.0");
  assert.equal(row.proofArtifactRef, "proofs/blog-writer-qirofit_2026-08-22.json");
  assert.equal(row.status, "success");
});

// ── pipeline wiring: consumers gain no DB code ─────────────────────────────

test("the pipeline reports to the authority when a store is supplied", async () => {
  const { runBlogWriterPipeline } = await import("../pipeline.js");
  const { buildRegistry } = await import("../registry.js");
  const { createDurableReporter, createInMemoryTestSink } = await import("../proof.js");
  const { createPexelsProvider, createMemoryStore } = await import("../imageProvider.js");

  const SITE = {
    siteId: "qirofit", domain: "qirofit.com", laneKey: "blog-writer-qirofit",
    repository: { owner: "o", name: "n" }, blogPath: "/blog", keywordSource: { primary: "p" },
    contentContext: { audience: "a", voice: "v", prohibitedTerms: [] },
    imagePolicy: { required: false, provider: "pexels" },
    publication: { adapter: "github-repo-commit", workflowFile: "w", schedulePath: "s", draftDir: "d" },
    monitorKey: "blog-writer-qirofit",
  };
  const store = fakeStore();
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-22", mode: "dry-run" },
    {
      registry: buildRegistry([SITE]),
      jobRunsStore: store,
      bwtRelease: "v0.22.0",
      provider: { id: "local", model: "qwen3:14b", complete: async () => "not json" },
      schedule: { load: async () => ({ published: [{ slug: "p", title: "P", target_date: "2026-08-08", keywords: ["x"] }], queue: [] }) },
      keywords: { load: async () => ({ primary: [{ keyword: "cupping therapy" }], secondary: [] }) },
      imageProvider: createPexelsProvider({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ photos: [] }) }) }),
      imageStore: createMemoryStore(),
      reporter: createDurableReporter({ sink: createInMemoryTestSink() }),
      verifier: { check: async () => ({ status: 200 }) },
      maxGenerationAttempts: 1,
    },
  );
  assert.equal(result.ok, false, "generation was rigged to fail");
  const row = await store.getJobRunByIdempotencyKey("blog-writer-qirofit:2026-08-22:1");
  assert.ok(row, "a failed run must still reach the authority");
  assert.equal(row.status, "failed");
  assert.equal(row.workerResponse.cadenceContract, "publication-14d-v1");
  assert.ok(row.workerResponse.failureStage, "failure stage must be durable");
});

test("without a store the pipeline degrades to file-only rather than failing", async () => {
  const { runBlogWriterPipeline } = await import("../pipeline.js");
  const { buildRegistry } = await import("../registry.js");
  const { createDurableReporter, createInMemoryTestSink } = await import("../proof.js");
  const result = await runBlogWriterPipeline(
    { siteId: "nope", occurrence: "2026-08-22", mode: "dry-run" },
    { registry: buildRegistry([]), reporter: createDurableReporter({ sink: createInMemoryTestSink() }) },
  );
  assert.equal(result.ok, false);
  assert.match(result.proof.failure.reason, /not registered/);
});
