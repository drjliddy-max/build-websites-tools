/**
 * Publication state, durable proof, and monitor reporting.
 *
 * Replaces the in-process `Map` that stood in for Site Monitor reporting. A
 * status that vanishes when the process exits cannot answer "did this publish?"
 * after the fact, which is the only question that matters.
 *
 * "Function returned" is never a state. Every transition below names a real
 * downstream artefact.
 */

import { createHash } from "node:crypto";

/** Explicit publication state machine. Order is significant. */
export const STATES = [
  "NOT_STARTED",
  "READY",
  "GENERATED",
  "VALIDATED",
  "PUBLISHED",
  "VERIFIED",
  "COMPLETE",
  "FAILED",
];

const ORDER = new Map(STATES.map((state, index) => [state, index]));

/** Legal forward transitions. FAILED is reachable from anywhere. */
const ALLOWED = {
  NOT_STARTED: ["READY", "FAILED"],
  READY: ["GENERATED", "FAILED"],
  GENERATED: ["VALIDATED", "FAILED"],
  VALIDATED: ["PUBLISHED", "FAILED"],
  PUBLISHED: ["VERIFIED", "FAILED"],
  VERIFIED: ["COMPLETE", "FAILED"],
  COMPLETE: [],
  FAILED: [],
};

export class StateTransitionError extends Error {
  constructor(from, to) {
    super(`Illegal publication state transition: ${from} -> ${to}`);
    this.name = "StateTransitionError";
  }
}

export function assertTransition(from, to) {
  if (!ORDER.has(from) || !ORDER.has(to)) {
    throw new StateTransitionError(from, to);
  }
  if (!ALLOWED[from].includes(to)) {
    throw new StateTransitionError(from, to);
  }
  return to;
}

/** Stable idempotency key for one lane-occurrence. */
export function idempotencyKey({ laneKey, occurrence, attempt = 1 }) {
  return `${laneKey}:${occurrence}:${attempt}`;
}

/**
 * Build the durable proof record.
 *
 * `provenance` is deliberately explicit and never inferred. An article written
 * by hand and published before the canonical pipeline existed must never carry
 * `generatedBy: "canonical-pipeline"`. The whole value of this record is that
 * it distinguishes what actually happened from what we wish had happened.
 */
export function buildProof({
  laneKey,
  siteId,
  occurrence,
  state,
  article,
  image,
  publication,
  verification,
  provenance,
  pipelineVersion,
  failure = null,
  startedAt,
  completedAt,
}) {
  if (!ORDER.has(state)) {
    throw new Error(`Unknown publication state: ${state}`);
  }
  if (!provenance || !["NEW_CANONICAL", "HISTORICAL_PRE_CANONICAL"].includes(provenance.classification)) {
    throw new Error("Proof requires provenance.classification of NEW_CANONICAL or HISTORICAL_PRE_CANONICAL");
  }

  const proof = {
    proofVersion: 2,
    pipeline: "canonical-blog-writer",
    pipelineVersion,
    laneKey,
    siteId,
    occurrence,
    idempotencyKey: idempotencyKey({ laneKey, occurrence }),
    state,
    provenance: {
      classification: provenance.classification,
      generatedBy: provenance.generatedBy ?? null,
      generationProvider: provenance.generationProvider ?? null,
      generationModel: provenance.generationModel ?? null,
      imageProvider: provenance.imageProvider ?? null,
      note: provenance.note ?? null,
    },
    article: article
      ? {
          title: article.title,
          slug: article.slug,
          metaDescription: article.metaDescription,
          wordCount: article.body ? article.body.trim().split(/\s+/).length : null,
          keyword: article.keyword ?? null,
          bodySha256: article.body ? createHash("sha256").update(article.body).digest("hex") : null,
        }
      : null,
    image: image
      ? {
          url: image.url,
          alt: image.alt,
          provider: image.provider,
          photographer: image.photographer ?? null,
          licence: image.licence ?? null,
          byteLength: image.byteLength ?? null,
          contentType: image.contentType ?? null,
        }
      : null,
    publication: publication ?? null,
    verification: verification ?? null,
    failure,
    startedAt,
    completedAt,
  };
  return proof;
}

/**
 * Durable reporter.
 *
 * `sink` persists; the default is a filesystem sink because that survives a
 * process restart and is inspectable without a database. Site Monitor consumes
 * the same records. An in-memory sink is available for tests ONLY and says so.
 */
export function createDurableReporter({ sink }) {
  if (!sink || typeof sink.write !== "function" || typeof sink.read !== "function") {
    throw new Error("A reporter sink needs write() and read().");
  }
  return {
    async report(proof) {
      const record = { ...proof, reportedAt: new Date().toISOString() };
      await sink.write(record);
      return record;
    },
    async latestFor(laneKey, occurrence) {
      return sink.read({ laneKey, occurrence });
    },
    /**
     * Has this exact lane-occurrence already reached a terminal published
     * state? This is the idempotency question, answered from durable state
     * rather than from anything held in memory.
     */
    async alreadyPublished(laneKey, occurrence) {
      const existing = await sink.read({ laneKey, occurrence });
      if (!existing) return false;
      return ["PUBLISHED", "VERIFIED", "COMPLETE"].includes(existing.state);
    },
  };
}

/** Filesystem sink, one JSON file per lane-occurrence. */
export function createFileSink({ dir, fs, path }) {
  const fileFor = ({ laneKey, occurrence }) =>
    path.join(dir, `${laneKey}_${occurrence}.json`);
  return {
    id: "file",
    async write(record) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(fileFor(record), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    },
    async read(key) {
      try {
        return JSON.parse(await fs.readFile(fileFor(key), "utf8"));
      } catch {
        return null;
      }
    },
  };
}

/** Test-only sink. Named so it cannot be mistaken for durable storage. */
export function createInMemoryTestSink() {
  const records = new Map();
  const keyOf = ({ laneKey, occurrence }) => `${laneKey}_${occurrence}`;
  return {
    id: "in-memory-test-only",
    durable: false,
    async write(record) {
      records.set(keyOf(record), record);
    },
    async read(key) {
      return records.get(keyOf(key)) ?? null;
    },
    all: () => [...records.values()],
  };
}
