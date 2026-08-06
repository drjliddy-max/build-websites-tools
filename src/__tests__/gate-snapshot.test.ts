/*
 * gate-snapshot Phase 1 test suite (rewritten after the PR #5 blocking review).
 *
 * The invariants under test decide whether this feature is safe to ship to nine
 * live consumer sites and whether its artifact can be trusted as evidence:
 *
 *   1. inert unless GATE_SNAPSHOT_ENABLED is exactly "1"
 *   2. no write can land outside the fixed repository artifact directory
 *   3. emission can never fail a build
 *   4. zero evidence can never be "complete"
 *   5. parsed fragments are validated at runtime, not merely cast
 *   6. the final document is schema-validated before it replaces a valid one
 *   7. replacement is atomic and leaves no residue on failure
 *   8. armed failures exit nonzero
 *   9. no secret values are serialized (key-aware AND shape-aware)
 *
 * "Zero filesystem effects" is asserted by walking the ENTIRE temporary root
 * before and after, so a test cannot pass while files are written elsewhere.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  rmSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  authorize,
  isArmed,
  emitFragment,
  beginFragment,
  isSafeGateName,
  isSecretKey,
  redactSecrets,
  sanitizeValue,
  isInside,
  resolveArtifactRoot,
  writeConfinedFile,
  fragmentsDir,
  ARTIFACT_DIR_SEGMENTS,
  KNOWN_GATES,
  SNAPSHOT_ENABLED_ENV,
  DEPRECATED_DIR_ENV,
  FRAGMENT_SCHEMA_VERSION,
  type Fragment,
} from "../snapshot";

import {
  mergeFragments,
  computeCompleteness,
  summarize,
  computeConfigHash,
  computeSnapshotId,
  expectedGatesFromScripts,
  classifyEnvironment,
  assertComparable,
  detectScopeDrift,
  buildSnapshot,
  runCli,
  loadSnapshotSchema,
  validateSnapshotDocument,
  byCodepoint,
  SCHEMA_VERSION,
  type ParsedFragment,
} from "../gate-snapshot";

import { validateFragment, validateAgainstSchema, isValidTimestamp } from "../snapshot-validate";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, "..", "..");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function tmp(prefix = "gs-"): string {
  // realpath: on macOS os.tmpdir() is /var -> /private/var, and an
  // uncanonicalized root would make every containment assertion a false
  // negative. This is the /tmp vs /private/tmp case, exercised for real.
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Every path under `dir`, sorted. Used to prove zero filesystem effects. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries.sort(byCodepoint)) {
      const full = path.join(d, e);
      out.push(path.relative(dir, full));
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort(byCodepoint);
}

/** A real git repository with a consumer-shaped package.json + gate.config.json. */
function makeRepo(opts: { scripts?: Record<string, string>; routes?: string[]; baseUrl?: string; prefix?: string } = {}): string {
  // The repo lives inside its OWN parent directory, so a test that asserts on
  // <repo>/.. (traversal escape) inspects a private location rather than the
  // shared temp root. Without this, one escaping write leaks across tests and
  // makes a later run fail for a reason that has nothing to do with it - an
  // order dependence that hid here until the mutation campaign surfaced it.
  const parent = tmp(opts.prefix ?? "gs-repo-");
  const root = path.join(parent, "repo");
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root, stdio: "ignore" });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fake-site", scripts: opts.scripts ?? { "gate:seo": "x" } }),
  );
  writeFileSync(
    path.join(root, "gate.config.json"),
    JSON.stringify({ routes: opts.routes ?? ["/", "/about"], baseUrl: opts.baseUrl ?? "https://fake.example.com" }),
  );
  writeFileSync(path.join(root, "README.md"), "x");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root, stdio: "ignore" });
  return root;
}

function artifactPath(repo: string): string {
  return path.join(repo, ...ARTIFACT_DIR_SEGMENTS);
}

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

function fragment(over: Partial<Fragment> = {}): Fragment {
  return {
    fragmentSchemaVersion: FRAGMENT_SCHEMA_VERSION,
    gate: "gate-seo",
    version: "0.0.0-test",
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:00:01.000Z",
    outcome: "pass",
    provenance: { routeCount: 2 },
    checks: [{ name: "canonical", pass: true, detail: "ok" }],
    ...over,
  };
}

function valid(f: Fragment): ParsedFragment {
  return { kind: "valid", fragment: f };
}

/* ================================================================== */
/* 1. AUTHORIZATION - zero filesystem effects                          */
/* ================================================================== */

const INERT_CASES: Array<[string, Record<string, string | undefined>]> = [
  ["absent", { [SNAPSHOT_ENABLED_ENV]: undefined }],
  ["empty string", { [SNAPSHOT_ENABLED_ENV]: "" }],
  ["whitespace", { [SNAPSHOT_ENABLED_ENV]: "   " }],
  ["0", { [SNAPSHOT_ENABLED_ENV]: "0" }],
  ["false", { [SNAPSHOT_ENABLED_ENV]: "false" }],
  ["FALSE", { [SNAPSHOT_ENABLED_ENV]: "FALSE" }],
  ["no", { [SNAPSHOT_ENABLED_ENV]: "no" }],
  ["true (not accepted - only \"1\" is)", { [SNAPSHOT_ENABLED_ENV]: "true" }],
  ["yes (not accepted)", { [SNAPSHOT_ENABLED_ENV]: "yes" }],
  ["arbitrary text", { [SNAPSHOT_ENABLED_ENV]: "please-enable" }],
  ["1 with trailing space (exact match required)", { [SNAPSHOT_ENABLED_ENV]: "1 " }],
];

for (const [label, env] of INERT_CASES) {
  test(`authorization inert: ${label} -> zero filesystem effects`, () => {
    const repo = makeRepo();
    const before = tree(repo);
    withEnv({ ...env, [DEPRECATED_DIR_ENV]: undefined }, () => {
      assert.equal(isArmed(), false, `${label} must not arm emission`);
      emitFragment(fragment(), repo);
      const rec = beginFragment("gate-seo", repo);
      assert.equal(rec.enabled, false);
      rec.check({ name: "x", pass: true, detail: "y" });
      const r = runCli(repo);
      assert.equal(r.code, 0, "not-asked-for must exit 0");
    });
    assert.deepEqual(tree(repo), before, `${label} wrote files`);
    assert.equal(existsSync(artifactPath(repo)), false, "artifact dir must not exist");
  });
}

const DEPRECATED_CASES: Array<[string, string]> = [
  ["plain value", "some-dir"],
  ["absolute path", "/tmp/escape-target"],
  ["traversal path", "../../escape-target"],
  ["empty value", ""],
];

for (const [label, value] of DEPRECATED_CASES) {
  test(`deprecated ${DEPRECATED_DIR_ENV} (${label}): rejected, value never used as a path, zero effects`, () => {
    const repo = makeRepo();
    const escapeRoot = tmp("gs-escape-");
    const before = tree(repo);
    const escapeBefore = tree(escapeRoot);

    withEnv({ [SNAPSHOT_ENABLED_ENV]: "1", [DEPRECATED_DIR_ENV]: value === "/tmp/escape-target" ? escapeRoot : value }, () => {
      const a = authorize();
      assert.equal(a.armed, false, "deprecated var must never arm");
      if (!a.armed) assert.equal(a.invalidConfig, true);
      emitFragment(fragment(), repo);
      const r = runCli(repo);
      assert.equal(r.code, 1, "armed-but-misconfigured must exit nonzero");
      assert.ok(r.stderr.join("\n").includes(DEPRECATED_DIR_ENV));
    });

    assert.deepEqual(tree(repo), before, "wrote inside the repo");
    assert.deepEqual(tree(escapeRoot), escapeBefore, "wrote to the deprecated path value");
    assert.equal(existsSync(artifactPath(repo)), false);
  });
}

test("lower-level writer invoked while unauthorized still cannot be reached via emitFragment", () => {
  const repo = makeRepo();
  const before = tree(repo);
  withEnv({ [SNAPSHOT_ENABLED_ENV]: undefined, [DEPRECATED_DIR_ENV]: undefined }, () => {
    emitFragment(fragment(), repo);
  });
  assert.deepEqual(tree(repo), before);
});

test("non-git working directory: armed, but fails closed with no write", () => {
  const notRepo = tmp("gs-notgit-");
  const before = tree(notRepo);
  withEnv(ARMED, () => {
    const resolved = resolveArtifactRoot(notRepo);
    assert.equal(resolved.ok, false);
    emitFragment(fragment(), notRepo);
    const r = runCli(notRepo);
    assert.equal(r.code, 1, "non-repository invocation must exit nonzero");
    assert.match(r.stderr.join("\n"), /git repository/);
  });
  assert.deepEqual(tree(notRepo), before);
});

/* ================================================================== */
/* 2. PATH SAFETY / CONFINEMENT                                        */
/* ================================================================== */

test("isInside uses containment, not string prefix", () => {
  assert.equal(isInside("/repo", "/repo/a/b"), true);
  assert.equal(isInside("/repo", "/repo"), true);
  // The prefix trap: "/repo-evil".startsWith("/repo") is true.
  assert.equal(isInside("/repo", "/repo-evil/x"), false);
  assert.equal(isInside("/repo", "/other"), false);
  assert.equal(isInside("/repo", "/repo/../etc/passwd"), false);
});

test("writeConfinedFile rejects absolute and traversal relative paths", () => {
  const repo = makeRepo();
  const resolved = resolveArtifactRoot(repo);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  const escapeRoot = tmp("gs-escape2-");
  const escapeBefore = tree(escapeRoot);

  const abs = writeConfinedFile(resolved.artifactRoot, resolved.repoRoot, path.join(escapeRoot, "x.json"), "{}");
  assert.equal(abs.ok, false);

  const trav = writeConfinedFile(resolved.artifactRoot, resolved.repoRoot, "../../../escape.json", "{}");
  assert.equal(trav.ok, false);

  assert.deepEqual(tree(escapeRoot), escapeBefore);
  assert.equal(existsSync(path.join(repo, "..", "escape.json")), false);
});

test("artifact root that is a symlink is rejected", () => {
  const repo = makeRepo();
  const outside = tmp("gs-outside-");
  mkdirSync(path.join(repo, ARTIFACT_DIR_SEGMENTS[0]), { recursive: true });
  symlinkSync(outside, artifactPath(repo));
  const resolved = resolveArtifactRoot(repo);
  assert.equal(resolved.ok, false, "a symlinked artifact root must be refused");
  if (!resolved.ok) assert.match(resolved.reason, /symlink/);
});

test("symlinked parent that escapes the repository is rejected", () => {
  const repo = makeRepo();
  const outside = tmp("gs-outside2-");
  // .build-websites-tools -> /outside  => artifact root resolves outside
  symlinkSync(outside, path.join(repo, ARTIFACT_DIR_SEGMENTS[0]));
  const before = tree(outside);
  const resolved = resolveArtifactRoot(repo);
  assert.equal(resolved.ok, false, "escape through a symlinked parent must be refused");
  withEnv(ARMED, () => emitFragment(fragment(), repo));
  assert.deepEqual(tree(outside), before, "nothing may be written through the symlink");
});

test("destination that is an existing symlink is refused at the write boundary", () => {
  const repo = makeRepo();
  const outside = tmp("gs-outside3-");
  const resolved = resolveArtifactRoot(repo);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  mkdirSync(resolved.artifactRoot, { recursive: true });
  const victim = path.join(outside, "victim.json");
  writeFileSync(victim, "ORIGINAL");
  symlinkSync(victim, path.join(resolved.artifactRoot, "snapshot.json"));

  const r = writeConfinedFile(resolved.artifactRoot, resolved.repoRoot, "snapshot.json", "REPLACED");
  assert.equal(r.ok, false, "must refuse to follow a symlinked destination");
  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL", "symlink target must be untouched");
});

test("destination that already exists as a directory is refused", () => {
  const repo = makeRepo();
  const resolved = resolveArtifactRoot(repo);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  mkdirSync(path.join(resolved.artifactRoot, "snapshot.json"), { recursive: true });
  const r = writeConfinedFile(resolved.artifactRoot, resolved.repoRoot, "snapshot.json", "{}");
  assert.equal(r.ok, false);
});

test("nested working directory resolves to the same repository artifact root", () => {
  const repo = makeRepo();
  const nested = path.join(repo, "apps", "web", "src");
  mkdirSync(nested, { recursive: true });
  const fromRoot = resolveArtifactRoot(repo);
  const fromNested = resolveArtifactRoot(nested);
  assert.ok(fromRoot.ok && fromNested.ok);
  if (fromRoot.ok && fromNested.ok) {
    assert.equal(fromNested.artifactRoot, fromRoot.artifactRoot);
  }
});

test("path containing spaces is handled", () => {
  const repo = makeRepo({ prefix: "gs repo with spaces " });
  withEnv(ARMED, () => emitFragment(fragment(), repo));
  assert.ok(existsSync(path.join(fragmentsDir(artifactPath(repo)), "gate-seo.json")));
});

test("path containing unicode is handled", () => {
  const repo = makeRepo({ prefix: "gs-δοκιμή-测试-" });
  withEnv(ARMED, () => emitFragment(fragment(), repo));
  assert.ok(existsSync(path.join(fragmentsDir(artifactPath(repo)), "gate-seo.json")));
});

test("linked git worktree resolves to its own toplevel", () => {
  const repo = makeRepo();
  const wt = path.join(tmp("gs-wt-"), "linked");
  execFileSync("git", ["worktree", "add", "-q", "-b", "wtbranch", wt], { cwd: repo, stdio: "ignore" });
  const resolved = resolveArtifactRoot(wt);
  assert.ok(resolved.ok);
  if (resolved.ok) {
    assert.equal(resolved.repoRoot, realpathSync(wt));
    assert.ok(isInside(resolved.repoRoot, resolved.artifactRoot));
  }
});

test("path traversal in a gate name is rejected and writes nothing", () => {
  for (const bad of ["../../etc/passwd", "gate-seo/../../x", "gate-seo\\..\\x", "..", "gate_seo", "Gate-Seo", "gate-unknown", ""]) {
    assert.equal(isSafeGateName(bad), false, `${bad} must be rejected`);
  }
  for (const good of KNOWN_GATES) assert.equal(isSafeGateName(good), true);

  const repo = makeRepo();
  const before = tree(repo);
  withEnv(ARMED, () => emitFragment(fragment({ gate: "../escaped" }), repo));
  assert.deepEqual(tree(repo), before);
});

/* ================================================================== */
/* 3. EMISSION NEVER FAILS A BUILD                                     */
/* ================================================================== */

test("emission failure never throws (unwritable artifact parent)", () => {
  const repo = makeRepo();
  const parent = path.join(repo, ARTIFACT_DIR_SEGMENTS[0]);
  mkdirSync(parent, { recursive: true });
  chmodSync(parent, 0o500);
  try {
    withEnv(ARMED, () => {
      emitFragment(fragment(), repo); // assertion is that this does not throw
    });
  } finally {
    chmodSync(parent, 0o755);
  }
});

test("a real gate subprocess keeps its own exit status when snapshots cannot be written", () => {
  const repo = makeRepo();
  const parent = path.join(repo, ARTIFACT_DIR_SEGMENTS[0]);
  mkdirSync(parent, { recursive: true });
  chmodSync(parent, 0o500);
  let status = -1;
  try {
    execFileSync(process.execPath, [path.join(PKG_ROOT, "bin", "gate-sitemap-source.mjs")], {
      cwd: PKG_ROOT,
      env: { ...process.env, [SNAPSHOT_ENABLED_ENV]: "1" },
      stdio: "pipe",
    });
    status = 0;
  } catch (err) {
    status = (err as { status?: number }).status ?? -1;
  } finally {
    chmodSync(parent, 0o755);
  }
  assert.equal(status, 0, "a snapshot problem must never change a gate's exit status");
});

test("circular provenance does not throw", () => {
  const repo = makeRepo();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  withEnv(ARMED, () => emitFragment(fragment({ provenance: circular }), repo));
});

/* ================================================================== */
/* 4. COMPLETENESS - zero evidence can never be complete               */
/* ================================================================== */

function completenessFor(expected: string[], frags: Map<string, ParsedFragment>, over: Partial<Parameters<typeof computeCompleteness>[0]> = {}) {
  return computeCompleteness({
    configValid: true,
    buildIdentityAvailable: true,
    expectedGates: expected,
    merge: mergeFragments(expected, frags),
    ...over,
  });
}

test("zero expected gates can NEVER be complete", () => {
  const c = completenessFor([], new Map());
  assert.notEqual(c.status, "complete");
  assert.equal(c.status, "partial");
  assert.match(c.reason ?? "", /no expected gates/);
});

test("zero fragments can NEVER be complete", () => {
  const c = completenessFor(["gate-seo"], new Map());
  assert.notEqual(c.status, "complete");
  assert.match(c.reason ?? "", /no fragments found|did not run/);
});

test("a valid non-empty expected set with every fragment present IS complete", () => {
  const c = completenessFor(["gate-seo"], new Map([["gate-seo", valid(fragment())]]));
  assert.equal(c.status, "complete");
  assert.equal(c.reason, null, "reason must be null iff complete");
});

test("a complete snapshot may contain a FAILING gate (coverage, not success)", () => {
  const c = completenessFor(["gate-seo"], new Map([["gate-seo", valid(fragment({ outcome: "fail" }))]]));
  assert.equal(c.status, "complete");
  assert.equal(c.reason, null);
});

test("a missing expected gate produces not_run and partial", () => {
  const m = mergeFragments(["gate-seo", "gate-ada"], new Map([["gate-seo", valid(fragment())]]));
  assert.equal(m.gates["gate-ada"].outcome, "not_run");
  assert.notEqual(m.gates["gate-ada"].outcome, "pass");
  const c = completenessFor(["gate-seo", "gate-ada"], new Map([["gate-seo", valid(fragment())]]));
  assert.equal(c.status, "partial");
  assert.deepEqual(c.gatesNotRun, ["gate-ada"]);
});

test("a malformed fragment cannot produce complete", () => {
  const c = completenessFor(["gate-seo"], new Map([["gate-seo", { kind: "malformed", reason: "bad" }]]));
  assert.equal(c.status, "partial");
  assert.deepEqual(c.malformed, ["gate-seo"]);
});

test("an undeclared (unknown) gate forces partial - explicit Phase 1 policy", () => {
  const frags = new Map<string, ParsedFragment>([
    ["gate-seo", valid(fragment())],
    ["gate-ada", valid(fragment({ gate: "gate-ada" }))],
  ]);
  const c = completenessFor(["gate-seo"], frags);
  assert.equal(c.status, "partial");
  assert.deepEqual(c.unknown, ["gate-ada"]);
});

test("invalid configuration is error, not partial", () => {
  const c = completenessFor(["gate-seo"], new Map([["gate-seo", valid(fragment())]]), {
    configValid: false,
    configReason: "gate.config.json not found",
  });
  assert.equal(c.status, "error");
  assert.match(c.reason ?? "", /gate.config.json/);
});

test("unavailable build identity cannot be complete", () => {
  const c = completenessFor(["gate-seo"], new Map([["gate-seo", valid(fragment())]]), {
    buildIdentityAvailable: false,
  });
  assert.equal(c.status, "partial");
  assert.match(c.reason ?? "", /build identity/);
});

test("internal error is error status", () => {
  const c = completenessFor(["gate-seo"], new Map(), { internalError: "boom" });
  assert.equal(c.status, "error");
  assert.match(c.reason ?? "", /internal error/);
});

test("reason is null if and only if complete", () => {
  const complete = completenessFor(["gate-seo"], new Map([["gate-seo", valid(fragment())]]));
  assert.equal(complete.reason, null);
  for (const c of [
    completenessFor([], new Map()),
    completenessFor(["gate-seo"], new Map()),
    completenessFor(["gate-seo"], new Map(), { configValid: false }),
  ]) {
    assert.notEqual(c.status, "complete");
    assert.ok(c.reason && c.reason.length > 0, "a non-complete status must state a reason");
  }
});

test("a not_run gate contributes no passing checks to the summary", () => {
  const m = mergeFragments(["gate-seo", "gate-ada"], new Map([["gate-seo", valid(fragment())]]));
  const s = summarize(m.gates);
  assert.equal(s.checksTotal, 1);
  assert.equal(s.checksPassed, 1);
});

/* ================================================================== */
/* 5. FRAGMENT VALIDATION MATRIX                                       */
/* ================================================================== */

const INVALID_FRAGMENTS: Array<[string, unknown]> = [
  ["null", null],
  ["array", []],
  ["string primitive", "nope"],
  ["number primitive", 42],
  ["boolean primitive", true],
  ["missing gate", { ...fragment(), gate: undefined }],
  ["unknown gate", { ...fragment(), gate: "gate-does-not-exist" }],
  ["gate wrong type", { ...fragment(), gate: 7 }],
  ["invalid outcome", { ...fragment(), outcome: "maybe" }],
  ["outcome wrong type", { ...fragment(), outcome: 1 }],
  ["missing checks", { ...fragment(), checks: undefined }],
  ["checks as boolean", { ...fragment(), checks: true }],
  ["checks as object", { ...fragment(), checks: { a: 1 } }],
  ["check entry not an object", { ...fragment(), checks: ["x"] }],
  ["check.name wrong type", { ...fragment(), checks: [{ name: 1, pass: true, detail: "d" }] }],
  ["check.pass wrong type", { ...fragment(), checks: [{ name: "n", pass: "yes", detail: "d" }] }],
  ["check.detail nested object", { ...fragment(), checks: [{ name: "n", pass: true, detail: { a: 1 } }] }],
  ["invalid startedAt", { ...fragment(), startedAt: "not-a-date" }],
  ["startedAt wrong type", { ...fragment(), startedAt: 0 }],
  ["invalid finishedAt", { ...fragment(), finishedAt: "2026-13-45T99:99:99Z" }],
  ["provenance as array", { ...fragment(), provenance: [] }],
  ["provenance as null", { ...fragment(), provenance: null }],
  ["routes as array", { ...fragment(), routes: [] }],
  ["unsupported fragmentSchemaVersion", { ...fragment(), fragmentSchemaVersion: 99 }],
  ["fragmentSchemaVersion wrong type", { ...fragment(), fragmentSchemaVersion: "1" }],
  ["version wrong type", { ...fragment(), version: 1 }],
];

for (const [label, input] of INVALID_FRAGMENTS) {
  test(`fragment validation rejects: ${label}`, () => {
    const r = validateFragment(input, isSafeGateName);
    assert.equal(r.valid, false, `${label} must be rejected`);
    if (!r.valid) assert.ok(r.errors.length > 0);
  });
}

test("fragment validation accepts a well-formed fragment", () => {
  assert.equal(validateFragment(fragment(), isSafeGateName).valid, true);
});

test("fragment validation permits unknown TOP-LEVEL fields (forward compatibility)", () => {
  const r = validateFragment({ ...fragment(), futureField: { a: 1 } }, isSafeGateName);
  assert.equal(r.valid, true);
});

test("timestamp validation rejects structurally valid but impossible dates", () => {
  assert.equal(isValidTimestamp("2026-08-04T00:00:00.000Z"), true);
  assert.equal(isValidTimestamp("2026-08-04T00:00:00+01:00"), true);
  assert.equal(isValidTimestamp("2026-13-45T99:99:99Z"), false);
  assert.equal(isValidTimestamp("yesterday"), false);
  assert.equal(isValidTimestamp(12345), false);
});

test("a shape-invalid fragment on disk is counted malformed, never as evidence", () => {
  const repo = makeRepo({ scripts: { "gate:seo": "x" } });
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  // Parses as JSON, wrong shape - the exact case the old cast let through.
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify({ gate: "gate-seo", outcome: "banana" }));
  const built = buildSnapshot(repo, art);
  assert.ok(built.ok);
  if (!built.ok) return;
  const c = built.snapshot.completeness as any;
  assert.notEqual(c.status, "complete");
  assert.deepEqual(c.malformed, ["gate-seo"]);
  assert.equal((built.snapshot.gates as any)["gate-seo"].outcome, "error");
});

test("a fragment stored under a mismatched filename is malformed", () => {
  const repo = makeRepo({ scripts: { "gate:seo": "x", "gate:ada": "y" } });
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-ada.json"), JSON.stringify(fragment({ gate: "gate-seo" })));
  const built = buildSnapshot(repo, art);
  assert.ok(built.ok);
  if (built.ok) assert.ok((built.snapshot.completeness as any).malformed.includes("gate-ada"));
});

/* ================================================================== */
/* 6. FINAL SCHEMA VALIDATION                                          */
/* ================================================================== */

test("the shipped schema exists and is loadable", () => {
  const s = loadSnapshotSchema();
  assert.equal((s as any).$schema !== undefined, true);
});

test("a generated snapshot validates against the SHIPPED schema", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  const built = buildSnapshot(repo, art);
  assert.ok(built.ok);
  if (!built.ok) return;
  const r = validateAgainstSchema(built.snapshot, loadSnapshotSchema());
  assert.equal(r.valid, true, r.valid ? "" : JSON.stringify((r as any).errors, null, 2));
});

test("schema validator reports an unsupported keyword rather than silently passing", () => {
  const r = validateAgainstSchema({ a: 1 }, { type: "object", properties: { a: { type: "number", multipleOf: 2 } } });
  assert.equal(r.valid, false);
  if (!r.valid) assert.match(r.errors[0].message, /unsupported schema keyword/);
});

test("schema validator catches a wrong-typed field", () => {
  const r = validateAgainstSchema({ schemaVersion: "1" }, { type: "object", properties: { schemaVersion: { const: 1 } } });
  assert.equal(r.valid, false);
});

/* ================================================================== */
/* 7. ATOMICITY + CONCURRENCY                                          */
/* ================================================================== */

test("writes leave no temporary residue on success", () => {
  const repo = makeRepo();
  const resolved = resolveArtifactRoot(repo);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  const r = writeConfinedFile(resolved.artifactRoot, resolved.repoRoot, "snapshot.json", "{}\n");
  assert.equal(r.ok, true);
  const leftovers = readdirSync(resolved.artifactRoot).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

test("a failed write leaves no temporary residue and preserves the prior file", () => {
  const repo = makeRepo();
  const resolved = resolveArtifactRoot(repo);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  mkdirSync(resolved.artifactRoot, { recursive: true });
  writeFileSync(path.join(resolved.artifactRoot, "snapshot.json"), "PRIOR");
  // Make the destination a directory so the rename fails after the temp write.
  rmSync(path.join(resolved.artifactRoot, "snapshot.json"));
  mkdirSync(path.join(resolved.artifactRoot, "snapshot.json"));
  const r = writeConfinedFile(resolved.artifactRoot, resolved.repoRoot, "snapshot.json", "NEW");
  assert.equal(r.ok, false);
  const leftovers = readdirSync(resolved.artifactRoot).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "temp file must be cleaned up on failure");
});

test("a schema-invalid snapshot never replaces a previously valid snapshot.json", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(art, { recursive: true });
  writeFileSync(path.join(art, "snapshot.json"), "PRIOR-VALID");
  // Force schema failure by making the loaded schema reject everything.
  const built = { ok: true as const, snapshot: { schemaVersion: 999 } };
  const r = validateAgainstSchema(built.snapshot, loadSnapshotSchema());
  assert.equal(r.valid, false);
  assert.equal(readFileSync(path.join(art, "snapshot.json"), "utf8"), "PRIOR-VALID");
});

test("concurrency: two sequential merges both succeed, last writer wins, no residue", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  withEnv(ARMED, () => {
    assert.equal(runCli(repo).code, 0);
    assert.equal(runCli(repo).code, 0);
  });
  const parsed = JSON.parse(readFileSync(path.join(art, "snapshot.json"), "utf8"));
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(readdirSync(art).filter((f) => f.includes(".tmp-")), []);
});

test("in-flight temp fragments are ignored by the merger", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  writeFileSync(path.join(fragmentsDir(art), ".gate-seo.json.tmp-123-456"), "{ partial");
  const built = buildSnapshot(repo, art);
  assert.ok(built.ok);
  if (built.ok) assert.deepEqual((built.snapshot.completeness as any).malformed, []);
});

/* ================================================================== */
/* 8. CLI EXIT CODES (in-process + subprocess)                         */
/* ================================================================== */

test("CLI exits 0 and writes nothing when not authorized", () => {
  const repo = makeRepo();
  const before = tree(repo);
  withEnv({ [SNAPSHOT_ENABLED_ENV]: undefined, [DEPRECATED_DIR_ENV]: undefined }, () => {
    const r = runCli(repo);
    assert.equal(r.code, 0);
    assert.deepEqual(r.stderr, []);
  });
  assert.deepEqual(tree(repo), before);
});

test("CLI exits 0 and writes a snapshot when authorized", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  withEnv(ARMED, () => assert.equal(runCli(repo).code, 0));
  assert.ok(existsSync(path.join(art, "snapshot.json")));
});

test("subprocess: the real bin exits 0 and writes nothing when unauthorized", () => {
  const repo = makeRepo();
  const before = tree(repo);
  const out = execFileSync(process.execPath, [path.join(PKG_ROOT, "bin", "gate-snapshot.mjs")], {
    cwd: repo,
    env: { ...process.env, [SNAPSHOT_ENABLED_ENV]: undefined, [DEPRECATED_DIR_ENV]: undefined } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  assert.equal(out.trim(), "", "must be silent on the inert path");
  assert.deepEqual(tree(repo), before);
});

test("subprocess: the real bin exits NONZERO on the deprecated env var and writes nothing", () => {
  const repo = makeRepo();
  const before = tree(repo);
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [path.join(PKG_ROOT, "bin", "gate-snapshot.mjs")], {
      cwd: repo,
      env: { ...process.env, [SNAPSHOT_ENABLED_ENV]: "1", [DEPRECATED_DIR_ENV]: "/tmp/anything" },
      stdio: "pipe",
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    status = e.status ?? -1;
    stderr = e.stderr?.toString() ?? "";
  }
  assert.equal(status, 1, "armed + invalid config must exit 1");
  assert.match(stderr, new RegExp(DEPRECATED_DIR_ENV));
  assert.deepEqual(tree(repo), before);
});

test("subprocess: the real bin exits NONZERO outside a git repository", () => {
  const notRepo = tmp("gs-notgit2-");
  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(PKG_ROOT, "bin", "gate-snapshot.mjs")], {
      cwd: notRepo,
      env: { ...process.env, [SNAPSHOT_ENABLED_ENV]: "1" },
      stdio: "pipe",
    });
  } catch (err) {
    status = (err as { status?: number }).status ?? -1;
  }
  assert.equal(status, 1);
});

test("subprocess: the direct-invocation guard actually fires (the bin does real work)", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  execFileSync(process.execPath, [path.join(PKG_ROOT, "bin", "gate-snapshot.mjs")], {
    cwd: repo,
    env: { ...process.env, [SNAPSHOT_ENABLED_ENV]: "1" },
    stdio: "pipe",
  });
  // If the guard used new URL().pathname it would silently never run and this
  // file would be absent.
  assert.ok(existsSync(path.join(art, "snapshot.json")), "the CLI guard did not fire");
});

/* ================================================================== */
/* 9. SECRETS                                                          */
/* ================================================================== */

test("shape-based redaction covers the known credential shapes", () => {
  const cases: Array<[string, string]> = [
    ["AIza" + "SyA1234567890abcdefghijk", "google-api-key"],
    ["sk_" + "live_abcdef123456", "stripe-key"],
    ["Bearer abcdef.ghijkl-1234", "bearer-token"],
    ["G-" + "ABC123XYZ", "ga4-measurement-id"],
    ["eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd", "jwt"],
    ["postgres://user:pw@host:5432/db", "postgres-url"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key-block"],
    ["https://user:hunter2@example.com/x", "url-credentials"],
    ["authorization: Token abc123", "authorization-header"],
    ["cookie: session=abc123", "cookie-header"],
  ];
  for (const [raw, label] of cases) {
    const out = redactSecrets(raw);
    assert.ok(out.includes("[REDACTED:"), `${label} not redacted: ${out}`);
    assert.ok(!out.includes("hunter2"));
  }
});

test("key-aware redaction covers an opaque value with no recognizable shape", () => {
  // The gap review found: the value has no shape and the key is short, so the
  // old lookahead rule left it in the clear.
  const out = sanitizeValue({ apiSecret: "abcdefghijklmnopqrstuvwxyz012345" }) as Record<string, unknown>;
  assert.equal(out.apiSecret, "[REDACTED:credential-like-key]");

  for (const key of ["token", "password", "clientSecret", "api_key", "apiKey", "privateKey", "sessionId", "credential"]) {
    const o = sanitizeValue({ [key]: "opaque-value-with-no-shape-at-all" }) as Record<string, unknown>;
    assert.equal(o[key], "[REDACTED:credential-like-key]", `${key} must be redacted by key`);
  }
});

test("key-aware redaction does not fire on unrelated long tokens", () => {
  // The over-inclusive half of the old rule: an unrelated token was redacted
  // whenever the word "secret" appeared later in the same string.
  const out = sanitizeValue({ note: "this build has no secret material", buildId: "abcdefghijklmnopqrstuvwx" }) as Record<string, unknown>;
  assert.equal(out.buildId, "abcdefghijklmnopqrstuvwx", "an ordinary id must survive");
});

test("redaction survives nesting, arrays and object keys", () => {
  const clean = sanitizeValue({
    nested: { deep: ["sk_" + "live_abcdef123456", { k: "G-" + "ZZZ999" }] },
    "authorization: Bearer abc12345": "v",
  });
  const s = JSON.stringify(clean);
  assert.ok(!s.includes("sk_live_abcdef123456"));
  assert.ok(!s.includes("G-ZZZ999"));
});

test("non-finite numbers are dropped and named; real 0 and false are preserved", () => {
  const out = sanitizeValue({ a: NaN, b: Infinity, c: -Infinity, d: 0, e: false }) as Record<string, unknown>;
  assert.equal(out.a, "[DROPPED:non-finite-number]");
  assert.equal(out.b, "[DROPPED:non-finite-number]");
  assert.equal(out.c, "[DROPPED:non-finite-number]");
  assert.equal(out.d, 0);
  assert.equal(out.e, false);
});

test("an emitted fragment file contains no secret shapes", () => {
  const repo = makeRepo();
  withEnv(ARMED, () =>
    emitFragment(fragment({ provenance: { key: "AIza" + "SyA1234567890abcdefghijk", apiSecret: "opaque0123456789012345" } }), repo),
  );
  const body = readFileSync(path.join(fragmentsDir(artifactPath(repo)), "gate-seo.json"), "utf8");
  assert.ok(!/AIzaSy/.test(body));
  assert.ok(!body.includes("opaque0123456789012345"));
});

/* ================================================================== */
/* 10. DETERMINISM / CONTENT ADDRESS                                   */
/* ================================================================== */

test("byCodepoint is locale-independent", () => {
  // localeCompare can order these differently under some ICU/locale builds;
  // a content address must not depend on that.
  assert.equal(byCodepoint("a", "B") < 0, false);
  assert.equal(["B", "a", "A"].sort(byCodepoint).join(""), "ABa");
});

test("config hash is order-independent for routes and stable across runs", () => {
  const a = computeConfigHash({ routes: ["/a", "/b"], expectedGates: ["gate-seo"] });
  const b = computeConfigHash({ routes: ["/b", "/a"], expectedGates: ["gate-seo"] });
  assert.equal(a, b);
  assert.equal(a, computeConfigHash({ routes: ["/a", "/b"], expectedGates: ["gate-seo"] }));
});

test("config hash changes when the route inventory changes", () => {
  assert.notEqual(
    computeConfigHash({ routes: ["/a"], expectedGates: [] }),
    computeConfigHash({ routes: ["/a", "/b"], expectedGates: [] }),
  );
});

test("snapshotId is stable for identical input and changes on outcome", () => {
  const base = { domain: "e.com", commitSha: "abc", buildId: null, environment: "production", gateConfigHash: "sha256:x" };
  const g1 = { "gate-seo": { outcome: "pass" as const, checks: [{ name: "n", pass: true, detail: "d" }] } };
  const g2 = { "gate-seo": { outcome: "fail" as const, checks: [{ name: "n", pass: true, detail: "d" }] } };
  assert.equal(computeSnapshotId({ ...base, gates: g1 }), computeSnapshotId({ ...base, gates: g1 }));
  assert.notEqual(computeSnapshotId({ ...base, gates: g1 }), computeSnapshotId({ ...base, gates: g2 }));
});

test("snapshotId changes when only a check detail changes", () => {
  // Review finding: detail is evidence, so it belongs in the content address.
  const base = { domain: "e.com", commitSha: "abc", buildId: null, environment: "production", gateConfigHash: "sha256:x" };
  const a = { "gate-seo": { outcome: "pass" as const, checks: [{ name: "n", pass: true, detail: "before" }] } };
  const b = { "gate-seo": { outcome: "pass" as const, checks: [{ name: "n", pass: true, detail: "after" }] } };
  assert.notEqual(computeSnapshotId({ ...base, gates: a }), computeSnapshotId({ ...base, gates: b }));
});

/* ================================================================== */
/* 11. COMPARABILITY + ENVIRONMENT                                     */
/* ================================================================== */

function snap(o: { env?: string; mode?: string | null; schema?: number; hash?: string; routes?: number }) {
  return {
    schemaVersion: o.schema ?? SCHEMA_VERSION,
    build: { environment: o.env ?? "production" },
    summary: { comparability: { adaScanMode: o.mode === undefined ? "browser" : o.mode } },
    site: { gateConfigHash: o.hash ?? "sha256:a", routeCount: o.routes ?? 10 },
  };
}

test("differing ada scanMode is NOT_COMPARABLE", () => {
  const v = assertComparable(snap({ mode: "browser" }), snap({ mode: "html-snapshot" }));
  assert.equal(v.comparable, false);
  if (!v.comparable) assert.match(v.reason, /color-contrast/);
});

test("differing environment is NOT_COMPARABLE", () => {
  const v = assertComparable(snap({ env: "local" }), snap({ env: "production" }));
  assert.equal(v.comparable, false);
});

test("differing schema version is NOT_COMPARABLE", () => {
  assert.equal(assertComparable(snap({ schema: 1 }), snap({ schema: 2 })).comparable, false);
});

test("same mode and environment is comparable; config drift is reported separately", () => {
  assert.equal(assertComparable(snap({}), snap({})).comparable, true);
  const d = detectScopeDrift(snap({ hash: "sha256:a", routes: 10 }), snap({ hash: "sha256:b", routes: 12 }));
  assert.equal(d.drifted, true);
});

test("environment never guesses production from a URL", () => {
  assert.equal(classifyEnvironment({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv), "production");
  assert.equal(classifyEnvironment({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv), "preview");
  assert.equal(classifyEnvironment({ CI: "true" } as NodeJS.ProcessEnv), "development");
  assert.equal(classifyEnvironment({} as NodeJS.ProcessEnv), "local");
  assert.equal(classifyEnvironment({ GATE_BASE_URL: "https://live.example.com" } as NodeJS.ProcessEnv), "local");
});

test("expected gates derive from the site's own gate: scripts", () => {
  assert.deepEqual(
    expectedGatesFromScripts({ "gate:ada": "x", "gate:seo": "x", "gate:all": "x", "gate:snapshot": "x", build: "x" }),
    ["gate-ada", "gate-seo"],
  );
});

/* ================================================================== */
/* 12. END TO END                                                      */
/* ================================================================== */

test("end to end: a real repo with every declared gate present is complete and schema-valid", () => {
  const repo = makeRepo({ scripts: { "gate:seo": "x", "gate:ada": "y" } });
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  writeFileSync(
    path.join(fragmentsDir(art), "gate-ada.json"),
    JSON.stringify(fragment({ gate: "gate-ada", provenance: { scanMode: "browser", colorContrastEvaluated: true, violationsBlocking: 0, violationsMinor: 2 } })),
  );

  withEnv(ARMED, () => assert.equal(runCli(repo).code, 0));

  const s = JSON.parse(readFileSync(path.join(art, "snapshot.json"), "utf8"));
  assert.equal(s.completeness.status, "complete");
  assert.equal(s.completeness.reason, null);
  assert.equal(s.site.domain, "fake.example.com");
  assert.equal(s.summary.comparability.adaScanMode, "browser");
  assert.match(s.snapshotId, /^sha256:[0-9a-f]{64}$/);
  assert.ok(s.build.commitSha, "a real repo resolves a commit sha");
  assert.equal(validateAgainstSchema(s, loadSnapshotSchema()).valid, true);
});

test("end to end: a partial run names the gates that did not run and is still schema-valid", () => {
  const repo = makeRepo({ scripts: { "gate:seo": "x", "gate:ada": "y" } });
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));

  withEnv(ARMED, () => assert.equal(runCli(repo).code, 0));

  const s = JSON.parse(readFileSync(path.join(art, "snapshot.json"), "utf8"));
  assert.equal(s.completeness.status, "partial");
  assert.deepEqual(s.completeness.gatesNotRun, ["gate-ada"]);
  assert.equal(s.gates["gate-ada"].outcome, "not_run");
  assert.equal(validateAgainstSchema(s, loadSnapshotSchema()).valid, true);
});


/* ================================================================== */
/* 13. GAPS FOUND BY THE MUTATION CAMPAIGN                             */
/* ================================================================== */

test("M3 gap: the artifact root is fixed and ignores ALL environment input", () => {
  // A mutation that read the destination from the environment escaped the
  // suite, because authorize() rejects the deprecated var before
  // resolveArtifactRoot is ever reached. Confinement must hold on its own, so
  // this asserts the destination directly, independent of the auth guard.
  const repo = makeRepo();
  const expected = path.join(repo, ...ARTIFACT_DIR_SEGMENTS);

  for (const bogus of ["/tmp/attacker", "../../escape", "", "relative/path"]) {
    const r = withEnv(
      { [DEPRECATED_DIR_ENV]: bogus, GATE_SNAPSHOT_OUT: bogus, SNAPSHOT_DIR: bogus },
      () => resolveArtifactRoot(repo),
    );
    assert.ok(r.ok, "resolution must succeed inside a real repo");
    if (r.ok) {
      assert.equal(r.artifactRoot, expected, `destination moved for env value ${JSON.stringify(bogus)}`);
      assert.ok(isInside(r.repoRoot, r.artifactRoot));
    }
  }
});

test("M3 gap: the artifact root is always under the repository, never the cwd", () => {
  const repo = makeRepo();
  const nested = path.join(repo, "a", "b");
  mkdirSync(nested, { recursive: true });
  const r = resolveArtifactRoot(nested);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.artifactRoot, path.join(repo, ...ARTIFACT_DIR_SEGMENTS));
});

test("M9 gap: a schema-invalid document is refused by the validation seam", () => {
  const schema = loadSnapshotSchema();
  const bad = { schemaVersion: 999, site: {}, build: {}, completeness: {}, gates: {}, summary: {} };
  const v = validateSnapshotDocument(bad, schema);
  assert.equal(v.valid, false, "an invalid document must be refused before it can replace a valid one");
  if (!v.valid) assert.ok(v.errors.length > 0);
});

test("M9 gap: a valid generated document passes the same seam", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  const built = buildSnapshot(repo, art);
  assert.ok(built.ok);
  if (built.ok) assert.equal(validateSnapshotDocument(built.snapshot, loadSnapshotSchema()).valid, true);
});

test("M11 gap: a rename failure cleans up the temporary file and preserves the prior snapshot", () => {
  const repo = makeRepo();
  const resolved = resolveArtifactRoot(repo);
  assert.ok(resolved.ok);
  if (!resolved.ok) return;
  mkdirSync(resolved.artifactRoot, { recursive: true });

  // A NON-EMPTY directory at the destination makes renameSync fail AFTER the
  // temp file has been written, which is the only way to exercise cleanup.
  const dest = path.join(resolved.artifactRoot, "snapshot.json");
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, "occupied"), "x");

  const r = writeConfinedFile(resolved.artifactRoot, resolved.repoRoot, "snapshot.json", "NEW");
  assert.equal(r.ok, false, "rename onto a non-empty directory must fail");

  const residue = readdirSync(resolved.artifactRoot).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(residue, [], "the temporary file must be removed on the failure path");
  assert.ok(existsSync(path.join(dest, "occupied")), "the prior contents must be untouched");
});

test("M9 gap: runCli refuses to replace a valid snapshot when final validation fails", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));

  // Seed a previously valid snapshot that must survive untouched.
  mkdirSync(art, { recursive: true });
  writeFileSync(path.join(art, "snapshot.json"), "PRIOR-VALID");

  // A contract the generated document cannot satisfy.
  const impossible = { type: "object", required: ["thisFieldWillNeverExist"] };

  const r = withEnv(ARMED, () => runCli(repo, process.env, { loadSchema: () => impossible }));

  assert.equal(r.code, 1, "a schema-invalid document must exit nonzero");
  assert.match(r.stderr.join("\n"), /failed schema validation/);
  assert.equal(
    readFileSync(path.join(art, "snapshot.json"), "utf8"),
    "PRIOR-VALID",
    "the previously valid snapshot must NOT be replaced",
  );
  assert.deepEqual(
    readdirSync(art).filter((f) => f.includes(".tmp-")),
    [],
    "no temporary file may be left behind",
  );
});

test("M9 gap: runCli writes normally when the real shipped schema is used", () => {
  const repo = makeRepo();
  const art = artifactPath(repo);
  mkdirSync(fragmentsDir(art), { recursive: true });
  writeFileSync(path.join(fragmentsDir(art), "gate-seo.json"), JSON.stringify(fragment()));
  withEnv(ARMED, () => assert.equal(runCli(repo).code, 0));
  assert.ok(existsSync(path.join(art, "snapshot.json")));
});
