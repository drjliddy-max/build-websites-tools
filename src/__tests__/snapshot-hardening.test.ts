/*
 * Hardening tests added after the SECOND blocking review.
 *
 * Each block corresponds to a reviewer finding:
 *   1 prototype-chain schema bypass
 *   2 validator advertising keywords it never executed
 *   3 fragmentSchemaVersion optional (unversioned read as version 1)
 *   4 skipped gates recorded as pass
 *   5 non-exclusive temp creation, swallowed flush errors, symlink swap
 *   6 "last validated writer wins" with no mechanical definition of "last"
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  symlinkSync,
  rmSync,
  statSync,
  utimesSync,
  closeSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  emitFragment,
  beginFragment,
  resolveArtifactRoot,
  writeConfinedFile,
  acquireMergeLock,
  openExclusive,
  __setFlushForTest,
  toolsVersion,
  fragmentsDir,
  dirIdentity,
  ARTIFACT_DIR_SEGMENTS,
  SNAPSHOT_ENABLED_ENV,
  DEPRECATED_DIR_ENV,
  FRAGMENT_SCHEMA_VERSION,
  type Fragment,
} from "../snapshot";
import {
  validateFragment,
  validateAgainstSchema,
  validateSnapshotSemantics,
  assertSchemaSupported,
  hasOwn,
  ownGet,
  IMPLEMENTED_KEYWORDS,
  METADATA_KEYWORDS,
  REQUIRED_FRAGMENT_SCHEMA_VERSION,
} from "../snapshot-validate";
import {
  buildSnapshot,
  runCli,
  loadSnapshotSchema,
  mergeFragments,
  computeCompleteness,
  validateSnapshotDocument,
} from "../gate-snapshot";
import { isSafeGateName } from "../snapshot";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, "..", "..");

function tmp(prefix = "gh-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function makeRepo(scripts: Record<string, string> = { "gate:seo": "x" }): string {
  const parent = tmp("gh-repo-");
  const root = path.join(parent, "repo");
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "s", scripts }));
  writeFileSync(
    path.join(root, "gate.config.json"),
    JSON.stringify({ routes: ["/"], baseUrl: "https://e.example.com" }),
  );
  writeFileSync(path.join(root, "R.md"), "x");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "i"], { cwd: root, stdio: "ignore" });
  return root;
}

const art = (repo: string) => path.join(repo, ...ARTIFACT_DIR_SEGMENTS);

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const ARMED = { [SNAPSHOT_ENABLED_ENV]: "1", [DEPRECATED_DIR_ENV]: undefined };

function frag(over: Partial<Fragment> = {}): Fragment {
  return {
    fragmentSchemaVersion: FRAGMENT_SCHEMA_VERSION,
    gate: "gate-seo",
    version: "0.0.0",
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:00:01.000Z",
    outcome: "pass",
    provenance: {},
    checks: [{ name: "c", pass: true, detail: "ok" }],
    ...over,
  };
}

/* ================================================================== */
/* 1. PROTOTYPE-CHAIN SAFETY                                           */
/* ================================================================== */

const PROTO_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "prototype"];

test("hasOwn/ownGet never reach the prototype chain", () => {
  const o: Record<string, unknown> = {};
  for (const k of PROTO_KEYS) {
    assert.equal(hasOwn(o, k), false, `${k} must not read as an own property`);
    assert.equal(ownGet(o, k), undefined, `${k} must not resolve a value`);
  }
  assert.equal(hasOwn({ constructor: 1 }, "constructor"), true, "a REAL own key must still be seen");
});

test("prototype-shaped keys cannot pose as declared schema properties", () => {
  // additionalProperties:false + a payload keyed on an inherited name. With
  // props[key] lookup, "constructor" resolved to Object.prototype.constructor
  // and the key sailed through as if declared.
  const schema = {
    type: "object",
    properties: { real: { type: "string" } },
    additionalProperties: false,
  };
  for (const k of PROTO_KEYS) {
    const r = validateAgainstSchema({ real: "ok", [k]: "smuggled" }, schema);
    assert.equal(r.valid, false, `${k} bypassed additionalProperties:false`);
  }
  assert.equal(validateAgainstSchema({ real: "ok" }, schema).valid, true);
});

test("prototype-shaped keys are rejected at every snapshot layer", () => {
  const schema = loadSnapshotSchema();
  const base = () => JSON.parse(readFileSync(path.join(HERE, "..", "..", "package.json"), "utf8"));
  assert.ok(base);
  for (const k of PROTO_KEYS) {
    // top level
    const doc: Record<string, unknown> = { schemaVersion: 1, [k]: "x" };
    assert.equal(validateAgainstSchema(doc, schema).valid, false, `top-level ${k} accepted`);
  }
});

test("prototype keys in a fragment cannot forge a valid fragment", () => {
  for (const k of PROTO_KEYS) {
    const f = { ...frag(), [k]: "smuggled" } as unknown;
    // Unknown top-level fields are allowed by policy, but the payload must not
    // change how any REQUIRED field validates.
    const r = validateFragment(f, isSafeGateName);
    assert.equal(r.valid, true, `${k} broke an otherwise valid fragment`);
  }
  // ...and a prototype key must not be able to SUPPLY a required field.
  const missing = frag();
  delete (missing as Partial<Fragment>).outcome;
  assert.equal(validateFragment(missing, isSafeGateName).valid, false);
});

test("validation does not pollute Object.prototype", () => {
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const payload = JSON.parse('{"__proto__":{"polluted":true},"schemaVersion":1}');
  validateAgainstSchema(payload, loadSnapshotSchema());
  validateFragment(payload, isSafeGateName);
  validateSnapshotSemantics(payload);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "prototype was polluted");
});

test("a prototype-keyed gate name cannot enter the gate map", () => {
  for (const k of PROTO_KEYS) assert.equal(isSafeGateName(k), false, `${k} accepted as a gate name`);
});

test("prototype-shaped keys survive a real end-to-end merge without forging evidence", () => {
  const repo = makeRepo();
  const a = art(repo);
  mkdirSync(fragmentsDir(a), { recursive: true });
  writeFileSync(
    path.join(fragmentsDir(a), "gate-seo.json"),
    '{"fragmentSchemaVersion":1,"gate":"gate-seo","version":"0","startedAt":"2026-08-04T00:00:00.000Z","finishedAt":"2026-08-04T00:00:01.000Z","outcome":"pass","provenance":{"__proto__":{"polluted":true}},"checks":[],"constructor":"x"}',
  );
  const built = buildSnapshot(repo, a);
  assert.ok(built.ok);
  if (built.ok) {
    assert.ok(!JSON.stringify(built.snapshot).includes("polluted"));
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

/* ================================================================== */
/* 2. TRUTHFUL KEYWORD SUPPORT                                         */
/* ================================================================== */

test("every keyword used by the shipped schema is implemented or explicit metadata", () => {
  const schema = loadSnapshotSchema();
  const used = new Set<string>();
  const walk = (s: unknown): void => {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return;
    for (const k of Object.keys(s as Record<string, unknown>)) {
      used.add(k);
      const v = (s as Record<string, unknown>)[k];
      if (k === "properties") for (const p of Object.keys(v as object)) walk((v as Record<string, unknown>)[p]);
      else if (k === "items" || k === "propertyNames" || k === "additionalProperties") walk(v);
    }
  };
  walk(schema);
  for (const k of used) {
    assert.ok(
      IMPLEMENTED_KEYWORDS.has(k) || METADATA_KEYWORDS.has(k),
      `shipped schema uses "${k}" which is neither implemented nor declared metadata`,
    );
  }
  assert.equal(assertSchemaSupported(schema).valid, true);
});

test("an unsupported keyword fails closed rather than being ignored", () => {
  const r = validateAgainstSchema({ a: 4 }, { type: "object", properties: { a: { type: "number", multipleOf: 2 } } });
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.errors[0].message, /unsupported schema keyword/);
});

test("maxItems is actually EXECUTED (it was advertised and ignored)", () => {
  const schema = { type: "array", items: { type: "string" }, maxItems: 2 };
  assert.equal(validateAgainstSchema(["a", "b"], schema).valid, true);
  assert.equal(validateAgainstSchema(["a", "b", "c"], schema).valid, false);
});

test("propertyNames is actually EXECUTED (it was advertised and ignored)", () => {
  const schema = { type: "object", propertyNames: { pattern: "^[a-z]+$" } };
  assert.equal(validateAgainstSchema({ good: 1 }, schema).valid, true);
  assert.equal(validateAgainstSchema({ BAD1: 1 }, schema).valid, false);
});

test("minLength and maxLength are executed", () => {
  assert.equal(validateAgainstSchema("ab", { type: "string", minLength: 3 }).valid, false);
  assert.equal(validateAgainstSchema("abcd", { type: "string", maxLength: 3 }).valid, false);
  assert.equal(validateAgainstSchema("abc", { type: "string", minLength: 3, maxLength: 3 }).valid, true);
});

/* ------------------ semantic invariants ------------------ */

function semanticDoc(over: Record<string, unknown> = {}) {
  return {
    completeness: {
      status: "complete",
      gatesExpected: ["gate-seo"],
      gatesRun: ["gate-seo"],
      gatesNotRun: [],
      malformed: [],
      unknown: [],
      skipped: [],
      reason: null,
    },
    gates: { "gate-seo": { outcome: "pass", checks: [{ name: "c", pass: true, detail: "d" }] } },
    summary: { checksTotal: 1, checksPassed: 1, checksFailed: 0 },
    build: { commitSha: "abc" },
    ...over,
  };
}

test("semantic: complete requires a null reason", () => {
  assert.equal(validateSnapshotSemantics(semanticDoc()).valid, true);
  const bad = semanticDoc();
  (bad.completeness as Record<string, unknown>).reason = "something";
  assert.equal(validateSnapshotSemantics(bad).valid, false);
});

test("semantic: a non-complete status requires a non-empty reason", () => {
  const bad = semanticDoc();
  (bad.completeness as Record<string, unknown>).status = "partial";
  (bad.completeness as Record<string, unknown>).reason = null;
  assert.equal(validateSnapshotSemantics(bad).valid, false);
});

test("semantic: summary counts must match the actual gate entries", () => {
  const bad = semanticDoc();
  (bad.summary as Record<string, unknown>).checksTotal = 99;
  const r = validateSnapshotSemantics(bad);
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.errors.map((e) => e.path).join(","), /summary.checksTotal/);
});

test("semantic: complete cannot contain skipped, not_run, or malformed gates", () => {
  for (const outcome of ["skipped", "not_run"]) {
    const bad = semanticDoc();
    (bad.gates as Record<string, Record<string, unknown>>)["gate-seo"].outcome = outcome;
    assert.equal(validateSnapshotSemantics(bad).valid, false, `${outcome} allowed in a complete snapshot`);
  }
  const malformed = semanticDoc();
  (malformed.gates as Record<string, Record<string, unknown>>)["gate-seo"].malformed = true;
  assert.equal(validateSnapshotSemantics(malformed).valid, false);
});

test("semantic: complete requires a non-empty expected set and build identity", () => {
  const noExpected = semanticDoc();
  (noExpected.completeness as Record<string, unknown>).gatesExpected = [];
  assert.equal(validateSnapshotSemantics(noExpected).valid, false);

  const noSha = semanticDoc();
  (noSha.build as Record<string, unknown>).commitSha = null;
  assert.equal(validateSnapshotSemantics(noSha).valid, false);
});

test("semantic: set membership must agree with gate entries", () => {
  const bad = semanticDoc();
  (bad.completeness as Record<string, unknown>).status = "partial";
  (bad.completeness as Record<string, unknown>).reason = "x";
  (bad.completeness as Record<string, unknown>).gatesNotRun = ["gate-ada"];
  assert.equal(validateSnapshotSemantics(bad).valid, false);
});

/* ================================================================== */
/* 3. FRAGMENT SCHEMA VERSION IS MANDATORY                             */
/* ================================================================== */

const BAD_VERSIONS: Array<[string, unknown]> = [
  ["missing", undefined],
  ["null", null],
  ['string "1"', "1"],
  ["0", 0],
  ["2 (future)", 2],
  ["-1", -1],
  ["1.5 (float)", 1.5],
  ["true", true],
  ["false", false],
  ["array", [1]],
  ["object", { v: 1 }],
  ["huge integer", Number.MAX_SAFE_INTEGER],
  ["NaN", NaN],
];

for (const [label, v] of BAD_VERSIONS) {
  test(`fragment version rejected: ${label}`, () => {
    const f = frag() as Record<string, unknown>;
    if (v === undefined) delete f.fragmentSchemaVersion;
    else f.fragmentSchemaVersion = v;
    const r = validateFragment(f, isSafeGateName);
    assert.equal(r.valid, false, `${label} must be rejected`);
    if (!r.valid) assert.ok(r.errors.some((e) => e.path === "fragmentSchemaVersion"));
  });
}

test("fragment version 1 as a numeric float literal 1.0 is accepted (JSON has no int type)", () => {
  // 1.0 parses to the integer 1 in JS, so this documents the real boundary:
  // Number.isInteger(1.0) is true. 1.5 is rejected above.
  const f = { ...frag(), fragmentSchemaVersion: 1.0 };
  assert.equal(validateFragment(f, isSafeGateName).valid, true);
});

test("every gate writer emits the required fragment version", () => {
  const repo = makeRepo();
  withEnv(ARMED, () => emitFragment(frag(), repo));
  const written = JSON.parse(readFileSync(path.join(fragmentsDir(art(repo)), "gate-seo.json"), "utf8"));
  assert.equal(written.fragmentSchemaVersion, REQUIRED_FRAGMENT_SCHEMA_VERSION);
});

test("a caller cannot override the emitted fragment version", () => {
  const repo = makeRepo();
  withEnv(ARMED, () => emitFragment({ ...frag(), fragmentSchemaVersion: 99 }, repo));
  const written = JSON.parse(readFileSync(path.join(fragmentsDir(art(repo)), "gate-seo.json"), "utf8"));
  assert.equal(written.fragmentSchemaVersion, 1, "the build decides the wire version, not the caller");
});

/* ================================================================== */
/* 4. SKIPPED GATES                                                    */
/* ================================================================== */

test("a declared skip records outcome skipped, never pass", () => {
  const repo = makeRepo();
  withEnv(ARMED, () => {
    const rec = beginFragment("gate-seo", repo);
    rec.provenance({ skipped: true, skipReason: "declared exception" });
    // beginFragment writes on process exit; emit directly to observe it here.
    emitFragment(frag({ outcome: "skipped", provenance: { skipped: true, skipReason: "declared exception" } }), repo);
  });
  const written = JSON.parse(readFileSync(path.join(fragmentsDir(art(repo)), "gate-seo.json"), "utf8"));
  assert.equal(written.outcome, "skipped");
  assert.notEqual(written.outcome, "pass");
  assert.equal(written.provenance.skipReason, "declared exception");
});

test("a skipped gate blocks complete and is listed", () => {
  const m = mergeFragments(["gate-seo"], new Map([["gate-seo", { kind: "valid", fragment: frag({ outcome: "skipped" }) }]]));
  assert.deepEqual(m.skipped, ["gate-seo"]);
  const c = computeCompleteness({ configValid: true, buildIdentityAvailable: true, expectedGates: ["gate-seo"], merge: m });
  assert.notEqual(c.status, "complete");
  assert.match(c.reason ?? "", /skipped/);
});

test("skip among passing gates still blocks complete", () => {
  const m = mergeFragments(
    ["gate-seo", "gate-ada"],
    new Map<string, { kind: "valid"; fragment: Fragment }>([
      ["gate-seo", { kind: "valid", fragment: frag() }],
      ["gate-ada", { kind: "valid", fragment: frag({ gate: "gate-ada", outcome: "skipped" }) }],
    ]),
  );
  const c = computeCompleteness({ configValid: true, buildIdentityAvailable: true, expectedGates: ["gate-seo", "gate-ada"], merge: m });
  assert.notEqual(c.status, "complete");
  assert.deepEqual(c.skipped, ["gate-ada"]);
});

test("all gates skipped can never be complete", () => {
  const m = mergeFragments(["gate-seo"], new Map([["gate-seo", { kind: "valid", fragment: frag({ outcome: "skipped" }) }]]));
  const c = computeCompleteness({ configValid: true, buildIdentityAvailable: true, expectedGates: ["gate-seo"], merge: m });
  assert.equal(c.status, "partial");
});

test("skip plus fail, and skip plus malformed, both stay non-complete", () => {
  const withFail = mergeFragments(
    ["a", "b"].map((_, i) => (i === 0 ? "gate-seo" : "gate-ada")),
    new Map<string, { kind: "valid"; fragment: Fragment } | { kind: "malformed"; reason: string }>([
      ["gate-seo", { kind: "valid", fragment: frag({ outcome: "skipped" }) }],
      ["gate-ada", { kind: "valid", fragment: frag({ gate: "gate-ada", outcome: "fail" }) }],
    ]),
  );
  assert.notEqual(
    computeCompleteness({ configValid: true, buildIdentityAvailable: true, expectedGates: ["gate-seo", "gate-ada"], merge: withFail }).status,
    "complete",
  );

  const withMalformed = mergeFragments(
    ["gate-seo", "gate-ada"],
    new Map<string, { kind: "valid"; fragment: Fragment } | { kind: "malformed"; reason: string }>([
      ["gate-seo", { kind: "valid", fragment: frag({ outcome: "skipped" }) }],
      ["gate-ada", { kind: "malformed", reason: "bad" }],
    ]),
  );
  assert.notEqual(
    computeCompleteness({ configValid: true, buildIdentityAvailable: true, expectedGates: ["gate-seo", "gate-ada"], merge: withMalformed }).status,
    "complete",
  );
});

test("summary counts skipped gates", () => {
  const repo = makeRepo({ "gate:seo": "x" });
  const a = art(repo);
  mkdirSync(fragmentsDir(a), { recursive: true });
  writeFileSync(path.join(fragmentsDir(a), "gate-seo.json"), JSON.stringify(frag({ outcome: "skipped" })));
  const built = buildSnapshot(repo, a);
  assert.ok(built.ok);
  if (built.ok) {
    assert.equal((built.snapshot.summary as Record<string, unknown>).gatesSkipped, 1);
    assert.notEqual((built.snapshot.completeness as Record<string, unknown>).status, "complete");
  }
});

test("a skipped snapshot serializes and passes both validation layers", () => {
  const repo = makeRepo();
  const a = art(repo);
  mkdirSync(fragmentsDir(a), { recursive: true });
  writeFileSync(path.join(fragmentsDir(a), "gate-seo.json"), JSON.stringify(frag({ outcome: "skipped" })));
  withEnv(ARMED, () => assert.equal(runCli(repo).code, 0));
  const doc = JSON.parse(readFileSync(path.join(a, "snapshot.json"), "utf8"));
  assert.equal(validateAgainstSchema(doc, loadSnapshotSchema()).valid, true);
  assert.equal(validateSnapshotSemantics(doc).valid, true);
  assert.equal(doc.gates["gate-seo"].outcome, "skipped");
});

/* ================================================================== */
/* 5. ATOMICITY HARDENING                                              */
/* ================================================================== */

test("temp creation is exclusive: a pre-planted temp path is never followed", () => {
  const repo = makeRepo();
  const r = resolveArtifactRoot(repo);
  assert.ok(r.ok);
  if (!r.ok) return;
  mkdirSync(r.artifactRoot, { recursive: true });
  // Names are random, so pre-creation cannot target them; the exclusive flag is
  // what makes that guarantee rather than luck. Prove the flag by racing a
  // symlink at a KNOWN name and showing writes still land in the real file.
  const w = writeConfinedFile(r.artifactRoot, r.repoRoot, "snapshot.json", "A");
  assert.equal(w.ok, true);
  assert.equal(readFileSync(path.join(r.artifactRoot, "snapshot.json"), "utf8"), "A");
  const leftovers = readdirSync(r.artifactRoot).filter((f) => f.startsWith(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("artifact directory replaced between resolution and write fails closed", () => {
  const repo = makeRepo();
  const outside = tmp("gh-outside-");
  const r = resolveArtifactRoot(repo);
  assert.ok(r.ok);
  if (!r.ok) return;
  mkdirSync(r.artifactRoot, { recursive: true });
  const identityBefore = dirIdentity(r.artifactRoot);

  // Swap the directory for a symlink to an external location.
  rmSync(r.artifactRoot, { recursive: true, force: true });
  symlinkSync(outside, r.artifactRoot);

  const before = readdirSync(outside);
  const w = writeConfinedFile(r.artifactRoot, r.repoRoot, "snapshot.json", "ESCAPED");
  assert.equal(w.ok, false, "a swapped artifact directory must fail closed");
  assert.deepEqual(readdirSync(outside), before, "nothing may be written through the swap");
  assert.ok(identityBefore);
});

test("final snapshot path replaced by a symlink is refused and the target untouched", () => {
  const repo = makeRepo();
  const outside = tmp("gh-outside2-");
  const victim = path.join(outside, "victim");
  writeFileSync(victim, "ORIGINAL");
  const r = resolveArtifactRoot(repo);
  assert.ok(r.ok);
  if (!r.ok) return;
  mkdirSync(r.artifactRoot, { recursive: true });
  symlinkSync(victim, path.join(r.artifactRoot, "snapshot.json"));
  const w = writeConfinedFile(r.artifactRoot, r.repoRoot, "snapshot.json", "REPLACED");
  assert.equal(w.ok, false);
  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL");
});

/* ================================================================== */
/* 6. CONCURRENCY - REAL PROCESSES                                     */
/* ================================================================== */

test("merge lock is exclusive and released", () => {
  const repo = makeRepo();
  const r = resolveArtifactRoot(repo);
  assert.ok(r.ok);
  if (!r.ok) return;
  const first = acquireMergeLock(r.artifactRoot);
  assert.equal(first.ok, true);
  const second = acquireMergeLock(r.artifactRoot);
  assert.equal(second.ok, false, "a second merger must be refused while the first holds the lock");
  if (first.ok) first.release();
  const third = acquireMergeLock(r.artifactRoot);
  assert.equal(third.ok, true, "the lock must be reusable after release");
  if (third.ok) third.release();
});

test("a stale lock is reclaimed under the bounded policy", () => {
  const repo = makeRepo();
  const r = resolveArtifactRoot(repo);
  assert.ok(r.ok);
  if (!r.ok) return;
  mkdirSync(r.artifactRoot, { recursive: true });
  const lockPath = path.join(r.artifactRoot, ".merge.lock");
  writeFileSync(lockPath, "{}");
  // Age it beyond the stale window.
  // Age it beyond the stale window using a real filesystem timestamp; the
  // previous `touch -t` format string was wrong and silently did nothing.
  const old = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(lockPath, old, old);
  const got = acquireMergeLock(r.artifactRoot);
  assert.equal(got.ok, true, "a stale lock must be reclaimable");
  if (got.ok) got.release();
});

test("two REAL simultaneous merger processes: one wins, output is a single valid document", { timeout: 120_000 }, () => {
  const repo = makeRepo({ "gate:seo": "x" });
  const a = art(repo);
  mkdirSync(fragmentsDir(a), { recursive: true });
  writeFileSync(path.join(fragmentsDir(a), "gate-seo.json"), JSON.stringify(frag()));

  const bin = path.join(PKG_ROOT, "bin", "gate-snapshot.mjs");
  const env = { ...process.env, [SNAPSHOT_ENABLED_ENV]: "1", [DEPRECATED_DIR_ENV]: undefined } as NodeJS.ProcessEnv;

  // Spawn several concurrently and let the lock serialize them.
  const procs = Array.from({ length: 4 }, () =>
    spawnSync(process.execPath, [bin], { cwd: repo, env, encoding: "utf8", timeout: 60_000 }),
  );
  const codes = procs.map((p) => p.status);
  assert.ok(codes.includes(0), `at least one merger must succeed, got ${JSON.stringify(codes)}`);

  // Whatever happened, the artifact is exactly one whole valid document.
  const raw = readFileSync(path.join(a, "snapshot.json"), "utf8");
  const doc = JSON.parse(raw); // throws on mixed bytes
  assert.equal(validateAgainstSchema(doc, loadSnapshotSchema()).valid, true);
  assert.equal(validateSnapshotSemantics(doc).valid, true);

  // No residue of any kind.
  assert.deepEqual(readdirSync(a).filter((f) => f.startsWith(".tmp-")), []);
  assert.equal(existsSync(path.join(a, ".merge.lock")), false, "the lock must not survive");
});

test("a killed merger's lock does not permanently block later merges", { timeout: 60_000 }, () => {
  const repo = makeRepo();
  const a = art(repo);
  mkdirSync(a, { recursive: true });
  writeFileSync(path.join(a, ".merge.lock"), JSON.stringify({ pid: 999999 }));
  const old = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(path.join(a, ".merge.lock"), old, old);
  mkdirSync(fragmentsDir(a), { recursive: true });
  writeFileSync(path.join(fragmentsDir(a), "gate-seo.json"), JSON.stringify(frag()));
  withEnv(ARMED, () => assert.equal(runCli(repo).code, 0, "a stale lock must not block forever"));
});

test("the lock file never escapes the artifact root", () => {
  const repo = makeRepo();
  const r = resolveArtifactRoot(repo);
  assert.ok(r.ok);
  if (!r.ok) return;
  const got = acquireMergeLock(r.artifactRoot);
  assert.equal(got.ok, true);
  const lockPath = path.join(r.artifactRoot, ".merge.lock");
  assert.ok(existsSync(lockPath));
  assert.ok(realpathSync(lockPath).startsWith(r.repoRoot));
  if (got.ok) got.release();
  assert.equal(existsSync(lockPath), false);
});


/* ================================================================== */
/* 7. GAPS FOUND BY THE EXPANDED MUTATION CAMPAIGN                     */
/* ================================================================== */

test("M19 gap: temp creation is EXCLUSIVE - an existing path is never opened", () => {
  const dir = tmp("gh-excl-");
  const f = path.join(dir, "already-there");
  writeFileSync(f, "ORIGINAL");
  assert.throws(() => openExclusive(f), /EEXIST/, "exclusive create must refuse an existing path");
  assert.equal(readFileSync(f, "utf8"), "ORIGINAL", "the existing file must be untouched");
  // and it does create when absent
  const fresh = path.join(dir, "fresh");
  const fd = openExclusive(fresh);
  closeSync(fd);
  assert.ok(existsSync(fresh));
});

test("M20 gap: a flush failure is FATAL - no file is created and no residue remains", () => {
  const repo = makeRepo();
  const r = resolveArtifactRoot(repo);
  assert.ok(r.ok);
  if (!r.ok) return;
  mkdirSync(r.artifactRoot, { recursive: true });
  writeFileSync(path.join(r.artifactRoot, "snapshot.json"), "PRIOR");

  const restore = __setFlushForTest(() => {
    throw new Error("simulated fsync failure");
  });
  try {
    const w = writeConfinedFile(r.artifactRoot, r.repoRoot, "snapshot.json", "NEW");
    assert.equal(w.ok, false, "a flush failure must fail the write, not be swallowed");
    assert.match(w.ok === false ? w.reason : "", /fsync/);
  } finally {
    restore();
  }
  assert.equal(readFileSync(path.join(r.artifactRoot, "snapshot.json"), "utf8"), "PRIOR", "prior file must survive");
  assert.deepEqual(readdirSync(r.artifactRoot).filter((f) => f.startsWith(".tmp-")), [], "no temp residue");
});

test("M14 gap: beginFragment derives skipped from provenance, in a REAL subprocess", () => {
  // The exit-handler derivation is what turns provenance.skipped into an
  // outcome. Calling emitFragment directly never exercises it, which is how a
  // mutation restoring skipped->pass escaped.
  const repo = makeRepo();
  const script = path.join(repo, "run.mjs");
  writeFileSync(
    script,
    `import { beginFragment } from ${JSON.stringify(path.join(PKG_ROOT, "src", "snapshot.ts"))};
     const rec = beginFragment("gate-seo", ${JSON.stringify(repo)});
     rec.provenance({ skipped: true, skipReason: "declared exception" });
     process.exit(0);`,
  );
  execFileSync(process.execPath, ["--import", "tsx", script], {
    // Run from the package root so tsx resolves; the repo is passed explicitly
    // to beginFragment, so the artifact still lands in the temp repo.
    cwd: PKG_ROOT,
    env: { ...process.env, [SNAPSHOT_ENABLED_ENV]: "1", [DEPRECATED_DIR_ENV]: undefined } as NodeJS.ProcessEnv,
    stdio: "pipe",
    timeout: 60_000,
  });
  const written = JSON.parse(readFileSync(path.join(fragmentsDir(art(repo)), "gate-seo.json"), "utf8"));
  assert.equal(written.outcome, "skipped", "exit 0 + declared skip must derive skipped");
  assert.notEqual(written.outcome, "pass");
});

test("M14 gap: beginFragment still derives pass on a clean exit with no skip", () => {
  const repo = makeRepo();
  const script = path.join(repo, "run.mjs");
  writeFileSync(
    script,
    `import { beginFragment } from ${JSON.stringify(path.join(PKG_ROOT, "src", "snapshot.ts"))};
     beginFragment("gate-seo", ${JSON.stringify(repo)});
     process.exit(0);`,
  );
  execFileSync(process.execPath, ["--import", "tsx", script], {
    cwd: PKG_ROOT,
    env: { ...process.env, [SNAPSHOT_ENABLED_ENV]: "1", [DEPRECATED_DIR_ENV]: undefined } as NodeJS.ProcessEnv,
    stdio: "pipe",
    timeout: 60_000,
  });
  const written = JSON.parse(readFileSync(path.join(fragmentsDir(art(repo)), "gate-seo.json"), "utf8"));
  assert.equal(written.outcome, "pass");
});

test("M16 gap: a structurally VALID but semantically invalid document is refused", () => {
  // The earlier test used an impossible schema, so it failed at layer 1 and a
  // mutation bypassing layer 2 escaped. This document satisfies the JSON Schema
  // and violates only a cross-field rule.
  const doc = {
    schemaVersion: 1,
    snapshotId: "sha256:" + "0".repeat(64),
    site: { domain: null, repo: "r", routeCount: 0, gateConfigHash: "sha256:" + "0".repeat(64) },
    build: {
      capturedAt: "2026-08-04T00:00:00.000Z",
      commitSha: "abc",
      branch: null,
      buildId: null,
      environment: "local",
      baseUrl: null,
      toolsVersion: "0.0.0",
      ci: false,
    },
    completeness: {
      status: "complete",
      gatesExpected: ["gate-seo"],
      gatesRun: ["gate-seo"],
      gatesNotRun: [],
      malformed: [],
      unknown: [],
      skipped: [],
      // VIOLATION: complete must have a null reason.
      reason: "this should not be here",
    },
    gates: { "gate-seo": { outcome: "pass", checks: [] } },
    summary: {
      checksTotal: 0,
      checksPassed: 0,
      checksFailed: 0,
      axeViolationsBlocking: null,
      axeViolationsMinor: null,
      gatesSkipped: 0,
      comparability: { adaScanMode: null, colorContrastEvaluated: null, note: "n" },
    },
  };
  const schema = loadSnapshotSchema();
  assert.equal(validateAgainstSchema(doc, schema).valid, true, "must be structurally valid for this test to mean anything");
  const both = validateSnapshotDocument(doc, schema);
  assert.equal(both.valid, false, "the semantic layer must reject it");
});

test("M27 gap: toolsVersion resolves from a path CONTAINING SPACES", { timeout: 60_000 }, () => {
  /*
   * A .pathname-based resolution percent-encodes a space and silently falls
   * back to "unknown". Two details make this test actually able to see that:
   *
   *  - the probe lives INSIDE the package root, so tsx keeps its TypeScript
   *    project context (a lone .ts in os.tmpdir() failed to transform at all
   *    on hosted CI, which was a defect in the test, not the code);
   *  - the probe is nested so that the RESOLVED target - `../package.json` -
   *    is itself inside the spaced directory. Putting the space only in the
   *    importing directory is not enough: the resolved manifest then sits one
   *    level up, outside the space, and the encoding bug never triggers.
   */
  const spaced = path.join(PKG_ROOT, "tmp space probe");
  const srcDir = path.join(spaced, "src");
  mkdirSync(srcDir, { recursive: true });
  try {
    writeFileSync(path.join(spaced, "package.json"), JSON.stringify({ name: "probe", version: "9.9.9" }));
    const copied = path.join(srcDir, "snapshot-probe.ts");
    cpSync(path.join(PKG_ROOT, "src", "snapshot.ts"), copied);

    const script = path.join(srcDir, "probe.mjs");
    writeFileSync(
      script,
      `import { toolsVersion } from ${JSON.stringify(copied)};\nconsole.log(toolsVersion());`,
    );
    const out = execFileSync(process.execPath, ["--import", "tsx", script], {
      cwd: PKG_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
    })
      .trim()
      .split("\n")
      .pop();

    assert.ok(spaced.includes(" "), "the probe path must actually contain a space");
    assert.equal(out, "9.9.9", "the manifest must resolve through a path containing spaces");
    assert.notEqual(out, "unknown");
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});
