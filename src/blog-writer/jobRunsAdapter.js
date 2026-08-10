/**
 * Authoritative run reporting, via Site Monitor's existing `job_runs`.
 *
 * The file sink is forensic evidence. It is not the completion authority, and
 * treating it as one is why a canonical run could not be answered for from Site
 * Monitor after the writing process exited.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * No new table, no second run identity, no new uniqueness mechanism, and no
 * eleven-state schema. `job_runs` already keys on
 * `idempotency_key VARCHAR(500) NOT NULL UNIQUE` with
 * `ON CONFLICT (idempotency_key) DO UPDATE`, which is exactly the reuse
 * semantics a repeated governed occurrence needs, and the canonical pipeline
 * already emits a key in that form. The authority was already correct; only the
 * wiring was missing.
 *
 * THE MODEL IS COARSE ON PURPOSE
 *
 *   status              coarse, terminal-aware execution state
 *   proof_status        evidence quality
 *   worker_response     detailed structured provenance
 *   proof_artifact_ref  durable proof pointer
 *
 * Canonical pipeline stages belong in `worker_response`, not in new status
 * values. "generated" is not "success": success means published and verified.
 *
 * CADENCE COMPATIBILITY IS LOAD-BEARING
 *
 * `blogPublicationAnchorStore` reads `worker_response->>'cadenceContract'`.
 * Every write here preserves it. Dropping it silently breaks anchor resolution
 * for the whole estate, so it is asserted rather than assumed.
 */

import { CADENCE_CONTRACT_ID } from "./cadence.js";

export const HISTORICAL_PROVENANCE = "HISTORICAL_PRE_CANONICAL";
export const CANONICAL_PROVENANCE = "NEW_CANONICAL";

export class JobRunsAdapterError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "JobRunsAdapterError";
    this.detail = detail;
  }
}

/**
 * Map a canonical pipeline outcome onto the existing coarse status model.
 *
 * Non-terminal stages stay `running`. Only a verified publication is `success`.
 * Overstating here would make Site Monitor report work as done that never
 * published.
 */
export function mapPipelineState(state) {
  switch (state) {
    case "FAILED":
      return { status: "failed", proofStatus: "missing" };
    case "COMPLETE":
      return { status: "success", proofStatus: "verified" };
    case "VERIFIED":
      return { status: "running", proofStatus: "pending" };
    case "PUBLISHED":
      // Published but not yet live-verified: real work happened, evidence is
      // incomplete. "limited" is the existing enum for exactly that.
      return { status: "running", proofStatus: "limited" };
    case "NOT_STARTED":
    case "READY":
    case "GENERATED":
    case "VALIDATED":
      return { status: "running", proofStatus: "pending" };
    default:
      throw new JobRunsAdapterError(`Unmapped pipeline state: ${state}`);
  }
}

/**
 * Build the `worker_response` payload.
 *
 * `cadenceContract` is placed first and asserted below; every other field is
 * canonical provenance that the coarse table columns cannot express.
 */
export function buildWorkerResponse({ proof, bwtRelease }) {
  if (!proof?.siteId || !proof?.occurrence) {
    throw new JobRunsAdapterError("worker_response requires siteId and occurrence.");
  }
  const payload = {
    cadenceContract: CADENCE_CONTRACT_ID,
    site: proof.siteId,
    laneKey: proof.laneKey,
    occurrence: proof.occurrence,
    bwtRelease: bwtRelease ?? null,
    pipelineVersion: proof.pipelineVersion ?? null,
    pipelineState: proof.state ?? null,
    provenance: proof.provenance?.classification ?? null,
    topic: proof.article?.keyword ?? null,
    topicProvenance: proof.provenance?.topicProvenance ?? null,
    topicSourceRef: proof.provenance?.topicSourceRef ?? null,
    generationProvider: proof.provenance?.generationProvider ?? null,
    generationModel: proof.provenance?.generationModel ?? null,
    generationRoute: proof.provenance?.generationRoute ?? null,
    imageProvider: proof.image?.provider ?? null,
    articleTitle: proof.article?.title ?? null,
    articleSlug: proof.article?.slug ?? null,
    publicationCommit: proof.publication?.commitSha ?? null,
    articleUrl: proof.verification?.articleUrl ?? null,
    articleStatus: proof.verification?.articleStatus ?? null,
    imageUrl: proof.verification?.imageUrl ?? null,
    imageStatus: proof.verification?.imageStatus ?? null,
    failureStage: proof.failure?.stage ?? null,
    failureReason: proof.failure?.reason ?? null,
  };
  assertCadenceCompatible(payload);
  return payload;
}

/**
 * Guard the one field another subsystem depends on.
 *
 * Called on every write rather than trusted, because the failure mode is silent:
 * a missing key does not error here, it makes anchors unresolvable later.
 */
export function assertCadenceCompatible(workerResponse) {
  const contract = workerResponse?.cadenceContract;
  if (typeof contract !== "string" || contract.length === 0) {
    throw new JobRunsAdapterError(
      "worker_response.cadenceContract is required: blogPublicationAnchorStore reads it " +
        "and anchor resolution breaks silently without it.",
    );
  }
  return contract;
}

/**
 * The canonical adapter.
 *
 * `store` is the injected Site Monitor `jobExecutionStore` surface, so this
 * package carries no database dependency and consumers carry no SQL. Consumers
 * supply site identity; they never write rows.
 */
export function createJobRunsReporter({ store, bwtRelease, triggeredBy = "canonical-blog-writer" }) {
  for (const fn of ["createJobRun", "beginJobRunAttempt", "updateJobRunStatus", "getJobRunByIdempotencyKey"]) {
    if (typeof store?.[fn] !== "function") {
      throw new JobRunsAdapterError(`Site Monitor store is missing ${fn}().`);
    }
  }

  /** Open or reuse the logical run for this occurrence. */
  async function begin(proof) {
    const run = await store.createJobRun(
      proof.laneKey,
      proof.idempotencyKey,
      0,
      proof.correlationId,
      triggeredBy,
      {},
    );
    // createJobRun's ON CONFLICT path reuses the row, so a repeat invocation
    // must start a fresh attempt rather than inherit the previous response.
    await store.beginJobRunAttempt(run.id, triggeredBy);
    return run;
  }

  /** Record the outcome of a canonical run against its logical row. */
  async function report(proof) {
    const run = await begin(proof);
    const { status, proofStatus } = mapPipelineState(proof.state);
    const workerResponse = buildWorkerResponse({ proof, bwtRelease });

    await store.updateJobRunStatus(run.id, status, {
      workerResponse,
      proofStatus,
      proofType: "blog-publication",
      proofArtifactRef: proof.proofArtifactRef ?? null,
      errorMessage: proof.failure?.reason ?? undefined,
    });
    return { id: run.id, idempotencyKey: proof.idempotencyKey, status, proofStatus };
  }

  /**
   * Reconcile a publication that happened BEFORE the canonical pipeline existed.
   *
   * Records only what is true: a publication occurred and is live. It must never
   * acquire canonical generator, provider, model or image provenance, because
   * those stages did not run. Enforced, not merely documented.
   */
  async function reconcileHistorical(record) {
    if (record.provenance !== HISTORICAL_PROVENANCE) {
      throw new JobRunsAdapterError(
        `Historical reconciliation requires provenance ${HISTORICAL_PROVENANCE}.`,
      );
    }
    for (const forbidden of ["generationProvider", "generationModel", "topicProvenance"]) {
      if (record[forbidden]) {
        throw new JobRunsAdapterError(
          `Historical reconciliation must not claim ${forbidden}: that stage never ran.`,
        );
      }
    }
    const run = await begin(record);
    const workerResponse = {
      cadenceContract: record.cadenceContract ?? CADENCE_CONTRACT_ID,
      site: record.siteId,
      laneKey: record.laneKey,
      occurrence: record.occurrence,
      provenance: HISTORICAL_PROVENANCE,
      articleSlug: record.articleSlug ?? null,
      articleUrl: record.articleUrl ?? null,
      publicationCommit: record.publicationCommit ?? null,
      note: "published before the canonical pipeline; execution stages not recorded",
    };
    assertCadenceCompatible(workerResponse);
    await store.updateJobRunStatus(run.id, "success", {
      workerResponse,
      proofStatus: "verified",
      proofType: "blog-publication-historical",
      proofArtifactRef: record.proofArtifactRef ?? null,
    });
    return { id: run.id, idempotencyKey: record.idempotencyKey, provenance: HISTORICAL_PROVENANCE };
  }

  /** Independent read, by the same key the authority uses. */
  async function read(idempotencyKey) {
    return store.getJobRunByIdempotencyKey(idempotencyKey);
  }

  return { begin, report, reconcileHistorical, read };
}
