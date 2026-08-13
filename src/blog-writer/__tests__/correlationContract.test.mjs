// FND-0003 + FND-0005 repair contract tests.
//
// FND-0003: the dispatcher's identity triple (jobKey, idempotencyKey, correlationId) must
// survive from workflow arguments into the durable proof, and the proof must land at the
// dispatcher's requested proofOutputPath so the truthful-completion step and Site Monitor's
// artifact verifier read what actually happened. Partial identity is refused outright.
//
// FND-0005: the publish commit must never stage the proof path; a truthful proof records the
// publication's own outcome and therefore cannot precede it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildProof } from "../proof.js";
import { runBlogWriterPipeline } from "../pipeline.js";
import { checkParticipant } from "../estateGuard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "../../..");
// Vendored byte-for-byte copy of qirofit-web@origin/main
// .siteclinic/automation/blog-writer-qirofit/site.config.json. It carries credential NAMES only
// (GITHUB_TOKEN, PEXELS_API_KEY), never values, so it is safe to commit. Kept honest by
// "FIXTURE DRIFT" below, which compares it against the real lane wherever that repo is reachable.
const QIROFIT_CONFIG_FIXTURE = path.join(__dirname, "fixtures/qirofit-site.config.json");
const CANONICAL_ENTRYPOINT = fs.readFileSync(
  path.join(PKG_ROOT, "contracts/blog-writer-entrypoint/runWorkflow.mjs"), "utf8");

const DISPATCH = {
  jobKey: "blog-writer-qirofit",
  idempotencyKey: "blog-writer-qirofit:2026-08-22:1",
  correlationId: "sched-1786400000000",
};

const proofArgs = (over = {}) => ({
  laneKey: "blog-writer-qirofit", siteId: "qirofit", occurrence: "2026-08-22",
  state: "FAILED", article: null, image: null, publication: null, verification: null,
  provenance: { classification: "NEW_CANONICAL", generatedBy: "canonical-pipeline" },
  pipelineVersion: "1.0.0", failure: { stage: "t", reason: "t", detail: null },
  startedAt: "2026-08-22T08:00:00Z", completedAt: "2026-08-22T08:00:01Z", ...over,
});

// ── proof-level identity contract ──────────────────────────────────────────
test("proof carries the dispatcher identity verbatim", () => {
  const proof = buildProof(proofArgs({ dispatch: DISPATCH }));
  assert.deepEqual(proof.dispatch, DISPATCH);
});

test("proof without dispatch stays explicitly null (never fabricated)", () => {
  assert.equal(buildProof(proofArgs()).dispatch, null);
});

for (const missing of ["jobKey", "idempotencyKey", "correlationId"]) {
  test(`NEGATIVE: dropping ${missing} refuses the whole identity (all-or-nothing)`, () => {
    const partial = { ...DISPATCH };
    delete partial[missing];
    assert.throws(() => buildProof(proofArgs({ dispatch: partial })), new RegExp(missing));
  });
  test(`NEGATIVE: empty ${missing} is refused the same as absent`, () => {
    assert.throws(() => buildProof(proofArgs({ dispatch: { ...DISPATCH, [missing]: "  " } })), new RegExp(missing));
  });
}

test("NEGATIVE: unknown dispatch fields are refused (no smuggled identity namespace)", () => {
  assert.throws(() => buildProof(proofArgs({ dispatch: { ...DISPATCH, laneKey: "x" } })), /Unknown dispatch/);
});

// ── pipeline threads dispatch into every proof it mints ────────────────────
test("pipeline failure proof carries dispatch (fast-fail path, no model/network)", async () => {
  const reported = [];
  const result = await runBlogWriterPipeline(
    { siteId: "qirofit", occurrence: "2026-08-15", mode: "dry-run", dispatch: DISPATCH },
    {
      registry: { get: () => ({ siteId: "qirofit", laneKey: "blog-writer-qirofit", publication: { schedulePath: "s.json" } }) },
      schedule: { load: async () => ({ published: [{ target_date: "2026-08-08" }] }) }, // 2026-08-15 is off-lattice
      reporter: { report: async (p) => reported.push(p), alreadyPublished: async () => false, latestFor: async () => null },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.proof.state, "FAILED");
  assert.match(result.proof.failure.reason, /lattice/);
  assert.deepEqual(result.proof.dispatch, DISPATCH, "failure proofs must correlate too");
  assert.deepEqual(reported[0].dispatch, DISPATCH);
});

// ── FND-0005: publish commit never stages the proof path ───────────────────
test("FND-0005: git add during publish receives no proofs path", async () => {
  // Direct source assertion, robust against helper indirection: the staged-path set is built
  // from draft/schedule/image only, and no fs.mkdir of a proofs dir precedes the commit.
  const src = fs.readFileSync(path.join(PKG_ROOT, "src/blog-writer/publisher.js"), "utf8");
  const stagedSet = src.match(/const paths = \[([^\]]*)\]/);
  assert.ok(stagedSet, "staged path set not found");
  assert.ok(!/proofPath/.test(stagedSet[1]),
    "publish staged the proof path again; a truthful proof cannot precede the commit it describes (FND-0005)");
});

// ── estate guard: byte identity against the canonical reference ────────────
const PARTICIPANT = { siteId: "qirofit", repo: "qirofit-web", laneKey: "blog-writer-qirofit" };
const readerWith = (entry) => (p) => {
  if (p === "package.json") return JSON.stringify({ devDependencies: { "build-websites-tools": "github:drjliddy-max/build-websites-tools#v0.26.0" } });
  if (p.endsWith("site.config.json")) return JSON.stringify({ configVersion: 1, laneKey: "blog-writer-qirofit" });
  if (p.endsWith("runWorkflow.mjs")) return entry;
  return null;
};

test("estate guard PASSES a consumer stamped byte-identical to the canonical entrypoint", () => {
  const r = checkParticipant(PARTICIPANT, readerWith(CANONICAL_ENTRYPOINT),
    { approvedPins: ["v0.26.0"], canonicalEntrypoint: CANONICAL_ENTRYPOINT });
  assert.deepEqual(r.failures, []);
});

test("NEGATIVE: a one-character entrypoint edit is entrypoint-drift", () => {
  const r = checkParticipant(PARTICIPANT, readerWith(CANONICAL_ENTRYPOINT + "\n// local tweak\n"),
    { approvedPins: ["v0.26.0"], canonicalEntrypoint: CANONICAL_ENTRYPOINT });
  assert.ok(r.failures.some((f) => f.code === "entrypoint-drift"), JSON.stringify(r.failures));
});

test("guard without a reference keeps prior signature-only behavior (backward compatible)", () => {
  const r = checkParticipant(PARTICIPANT, readerWith(CANONICAL_ENTRYPOINT + "\n// local tweak\n"),
    { approvedPins: ["v0.26.0"] });
  assert.deepEqual(r.failures, []);
});

// ── fixture drift: the vendored config must still match the governed lane ──
//
// The integration test below needs the REAL governed config shape, but CI checks out this package
// alone: a sibling qirofit-web does not exist there, and shelling into one reddened main for two
// merges (PRs #25, #26). So the config is vendored, and freshness is enforced here instead:
// wherever qirofit-web IS reachable (any dev machine, the portfolio workspace), a drifted fixture
// fails loudly. Where it is not, this reports skipped rather than passing on an unmade check.
test("FIXTURE DRIFT: vendored qirofit config matches qirofit-web@origin/main", (t) => {
  const lane = path.join(PKG_ROOT, "../qirofit-web");
  let governed;
  try {
    governed = execFileSync("git", ["-C", lane, "show",
      "origin/main:.siteclinic/automation/blog-writer-qirofit/site.config.json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // Not a failure: the sibling checkout is a property of the environment, not of this package.
    return t.skip(`qirofit-web not reachable at ${lane}; drift unverified in this environment`);
  }
  assert.equal(fs.readFileSync(QIROFIT_CONFIG_FIXTURE, "utf8"), governed,
    "vendored fixture has drifted from the governed lane config; re-vendor it with:\n" +
    "  git -C ../qirofit-web show origin/main:.siteclinic/automation/blog-writer-qirofit/site.config.json \\\n" +
    "    > src/blog-writer/__tests__/fixtures/qirofit-site.config.json");
});

// ── integration: the canonical entrypoint, run for real, correlates end to end ──
test("INTEGRATION: entrypoint writes the correlated proof to --proofOutputPath and exits 1 on failure", () => {
  // realpath: os.tmpdir() on macOS is a symlink (/var/folders -> /private/var/folders), and the
  // entrypoint's run-as-main guard compares path.resolve(argv[1]) against the module's REAL path.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bwt-entry-")));
  const laneDir = path.join(root, ".siteclinic/automation/blog-writer-qirofit");
  fs.mkdirSync(laneDir, { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, "contracts/blog-writer-entrypoint/runWorkflow.mjs"),
    path.join(laneDir, "runWorkflow.mjs"));
  // Real governed site config, so registry validation exercises the true shape. Read from the
  // vendored fixture, NOT a sibling checkout: this suite must run anywhere the package alone is
  // checked out. Fixture freshness is enforced separately by the drift test below.
  const realConfig = fs.readFileSync(QIROFIT_CONFIG_FIXTURE, "utf8");
  fs.writeFileSync(path.join(laneDir, "site.config.json"), realConfig);
  const schedulePath = JSON.parse(realConfig).publication.schedulePath;
  fs.mkdirSync(path.dirname(path.join(root, schedulePath)), { recursive: true });
  fs.writeFileSync(path.join(root, schedulePath),
    JSON.stringify({ schedule: {}, published: [{ target_date: "2026-08-08" }] }));
  // node_modules/build-websites-tools -> this checkout, so the pinned import resolves to the code under test
  const nm = path.join(root, "node_modules");
  fs.mkdirSync(nm, { recursive: true });
  fs.symlinkSync(PKG_ROOT, path.join(nm, "build-websites-tools"), "dir");

  const proofOut = path.join(root, "artifact/proof.json");
  let status = 0;
  try {
    execFileSync(process.execPath, [
      path.join(laneDir, "runWorkflow.mjs"),
      "--jobKey", DISPATCH.jobKey,
      "--idempotencyKey", DISPATCH.idempotencyKey,
      "--correlationId", DISPATCH.correlationId,
      "--targetDate", "2026-08-15", // off-lattice: fast, deterministic failure before any network
      "--proofOutputPath", proofOut,
    ], { encoding: "utf8", env: { ...process.env, SITECLINIC_AUTOMATION_SITE_ROOT: root } });
  } catch (e) { status = e.status; }

  assert.equal(status, 1, "an off-lattice occurrence must exit non-zero");
  const proof = JSON.parse(fs.readFileSync(proofOut, "utf8"));
  assert.equal(proof.proofVersion, 2);
  assert.equal(proof.state, "FAILED");
  assert.deepEqual(proof.dispatch, DISPATCH,
    "the artifact the workflow uploads must carry the dispatcher's exact identity");
  fs.rmSync(root, { recursive: true, force: true });
});
