/*
 * gate-snapshot Phase 1 test suite.
 *
 * The invariants under test are the ones that decide whether this feature is
 * safe to ship to nine live consumer sites, and whether the artifact it
 * produces can be trusted as evidence:
 *
 *   1. inert without GATE_SNAPSHOT_DIR
 *   2. emission can never fail a build
 *   3. a partial run is never rendered as a pass
 *   4. cross-mode / cross-environment comparisons are refused
 *   5. no secret values are serialized
 *   6. a gate name cannot escape the fragments directory
 *   7. a malformed fragment cannot produce a falsely complete snapshot
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  emitFragment,
  isSafeGateName,
  redactSecrets,
  sanitizeValue,
  snapshotDir,
  fragmentsDir,
  KNOWN_GATES,
  SNAPSHOT_DIR_ENV,
  type Fragment,
} from "../snapshot";

import {
  mergeFragments,
  summarize,
  computeConfigHash,
  computeSnapshotId,
  expectedGatesFromScripts,
  classifyEnvironment,
  assertComparable,
  detectScopeDrift,
  buildSnapshot,
  SCHEMA_VERSION,
} from "../gate-snapshot";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "snapshot");

/** Use a real temp dir per test so nothing leaks between cases. */
function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "gate-snapshot-"));
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

const FRAGMENT: Fragment = {
  gate: "gate-seo",
  version: "0.0.0-test",
  startedAt: "2026-08-04T00:00:00.000Z",
  finishedAt: "2026-08-04T00:00:01.000Z",
  outcome: "pass",
  provenance: { baseUrl: "https://example.com", routeCount: 2 },
  checks: [{ name: "canonical", pass: true, detail: "ok" }],
};

/* ------------------------------------------------------------------ */
/* 1. Activation                                                       */
/* ------------------------------------------------------------------ */

test("inert: writes nothing when GATE_SNAPSHOT_DIR is unset", () => {
  const dir = tmp();
  withEnv(SNAPSHOT_DIR_ENV, undefined, () => {
    emitFragment(FRAGMENT);
  });
  assert.equal(existsSync(path.join(dir, "fragments")), false);
  assert.equal(snapshotDir(), null);
});

test("inert: an empty or whitespace-only env value does not arm emission", () => {
  withEnv(SNAPSHOT_DIR_ENV, "   ", () => {
    assert.equal(snapshotDir(), null);
  });
});

test("armed: writes exactly one fragment for the gate", () => {
  const dir = tmp();
  withEnv(SNAPSHOT_DIR_ENV, dir, () => emitFragment(FRAGMENT));
  const file = path.join(fragmentsDir(dir), "gate-seo.json");
  assert.ok(existsSync(file));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.gate, "gate-seo");
  assert.equal(parsed.outcome, "pass");
});

/* ------------------------------------------------------------------ */
/* 2. Failure isolation - emission must never break a build            */
/* ------------------------------------------------------------------ */

test("failure isolation: an unwritable snapshot dir does not throw", () => {
  const dir = tmp();
  const locked = path.join(dir, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o444); // read-only
  try {
    withEnv(SNAPSHOT_DIR_ENV, path.join(locked, "nested"), () => {
      // The assertion IS that this does not throw.
      emitFragment(FRAGMENT);
    });
  } finally {
    chmodSync(locked, 0o755);
  }
});

test("failure isolation: a value that cannot serialize does not throw", () => {
  const dir = tmp();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  withEnv(SNAPSHOT_DIR_ENV, dir, () => {
    emitFragment({ ...FRAGMENT, provenance: circular });
  });
  // Either it wrote a sanitized document or it warned; neither may throw.
});

test("failure isolation: a real gate run with an unwritable dir keeps its own exit status", () => {
  // The strongest form of invariant 2: drive the actual bin, not the module.
  const dir = tmp();
  const locked = path.join(dir, "ro");
  mkdirSync(locked);
  chmodSync(locked, 0o444);
  const bin = path.join(HERE, "..", "..", "bin", "gate-sitemap-source.mjs");
  let status = -1;
  try {
    execFileSync(process.execPath, [bin], {
      cwd: path.join(HERE, "..", ".."),
      env: { ...process.env, [SNAPSHOT_DIR_ENV]: path.join(locked, "nope") },
      stdio: "pipe",
    });
    status = 0;
  } catch (err) {
    status = (err as { status?: number }).status ?? -1;
  } finally {
    chmodSync(locked, 0o755);
  }
  // This package has no sitemap source, so the gate passes (exit 0). The point
  // is that a broken snapshot dir did not turn that into a non-zero exit.
  assert.equal(status, 0, "snapshot emission must not alter the gate's exit status");
});

/* ------------------------------------------------------------------ */
/* 3. Path traversal + gate-name safety                                */
/* ------------------------------------------------------------------ */

test("path traversal: traversal and unknown gate names are rejected", () => {
  for (const bad of [
    "../../etc/passwd",
    "gate-seo/../../x",
    "gate-seo\\..\\x",
    "..",
    "gate_seo",
    "Gate-Seo",
    "gate-not-a-real-gate",
    "",
  ]) {
    assert.equal(isSafeGateName(bad), false, `${bad} must be rejected`);
  }
  for (const good of KNOWN_GATES) {
    assert.equal(isSafeGateName(good), true, `${good} must be accepted`);
  }
});

test("path traversal: a traversal gate name writes nothing", () => {
  const dir = tmp();
  withEnv(SNAPSHOT_DIR_ENV, dir, () => {
    emitFragment({ ...FRAGMENT, gate: "../escaped" });
  });
  assert.equal(existsSync(path.join(dir, "fragments", "..", "escaped.json")), false);
  assert.equal(existsSync(path.join(dir, "fragments")), false);
});

/* ------------------------------------------------------------------ */
/* 4. Secrets                                                          */
/* ------------------------------------------------------------------ */

test("secrets: recognised credential shapes are redacted", () => {
  const cases: Array<[string, string]> = [
    ["AIzaSyA1234567890abcdefghijklmnop", "google-api-key"],
    ["sk_live_abcdef123456", "stripe-key"],
    ["Bearer abcdef.ghijkl-1234", "bearer-token"],
    ["G-ABC123XYZ", "ga4-measurement-id"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd", "jwt"],
    ["postgres://user:pw@host:5432/db", "postgres-url"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key-block"],
    ["https://user:secretpw@example.com/x", "url-credentials"],
    ["authorization: Token abc123", "authorization-header"],
    ["cookie: session=abc123", "cookie-header"],
  ];
  for (const [raw, label] of cases) {
    const out = redactSecrets(raw);
    assert.ok(out.includes("[REDACTED:"), `${label} was not redacted: ${out}`);
    assert.ok(!out.includes("secretpw"), "a credential value survived redaction");
  }
});

test("secrets: the real GA4 measurement id gate-ai-instrumentation embeds is redacted", () => {
  // gate-ai-instrumentation writes a consent-gated exception detail containing
  // a live G-XXXXXX id. Shape-based redaction catches it even though no field
  // is named "secret" - which is exactly the case a denylist would miss.
  const detail =
    "consent-gated declared exception (measurementId=G-9K2LM4TQ7P); script injects post-consent";
  const out = redactSecrets(detail);
  assert.ok(!out.includes("G-9K2LM4TQ7P"));
  assert.ok(out.includes("[REDACTED:ga4-measurement-id]"));
});

test("secrets: redaction survives nesting, arrays and object keys", () => {
  const clean = sanitizeValue({
    nested: { deep: ["sk_live_abcdef123456", { k: "G-ZZZ999" }] },
    "authorization: Bearer abc12345": "v",
  }) as Record<string, unknown>;
  const serialized = JSON.stringify(clean);
  assert.ok(!serialized.includes("sk_live_abcdef123456"));
  assert.ok(!serialized.includes("G-ZZZ999"));
});

test("secrets: non-finite numbers are dropped, not serialized as null", () => {
  // JSON.stringify turns NaN/Infinity into null, and a null reads as a measured
  // absence. Losing the field is honest; misreporting it is not.
  const out = sanitizeValue({ a: NaN, b: Infinity, c: -Infinity, d: 0, e: false }) as Record<
    string,
    unknown
  >;
  assert.equal(out.a, "[DROPPED:non-finite-number]");
  assert.equal(out.b, "[DROPPED:non-finite-number]");
  assert.equal(out.c, "[DROPPED:non-finite-number]");
  assert.equal(out.d, 0, "a real 0 must be preserved");
  assert.equal(out.e, false, "a real false must be preserved");
});

test("secrets: the emitted fragment file contains no secret shapes", () => {
  const dir = tmp();
  withEnv(SNAPSHOT_DIR_ENV, dir, () =>
    emitFragment({
      ...FRAGMENT,
      provenance: { key: "AIzaSyA1234567890abcdefghijklmnop", id: "G-ABC123XYZ" },
    }),
  );
  const body = readFileSync(path.join(fragmentsDir(dir), "gate-seo.json"), "utf8");
  assert.ok(!/AIzaSy/.test(body));
  assert.ok(!/G-ABC123XYZ/.test(body));
});

/* ------------------------------------------------------------------ */
/* 5. Idempotency                                                      */
/* ------------------------------------------------------------------ */

test("idempotency: re-emitting a gate overwrites rather than duplicating", () => {
  const dir = tmp();
  withEnv(SNAPSHOT_DIR_ENV, dir, () => {
    emitFragment(FRAGMENT);
    emitFragment({ ...FRAGMENT, outcome: "fail" });
  });
  const files = readdirSync(fragmentsDir(dir));
  assert.equal(files.length, 1, "composed reruns must not append fragments");
  const parsed = JSON.parse(readFileSync(path.join(fragmentsDir(dir), "gate-seo.json"), "utf8"));
  assert.equal(parsed.outcome, "fail", "the later write must win");
});

test("idempotency: snapshotId is stable across merges of identical input", () => {
  const gates = { "gate-seo": { outcome: "pass" as const, checks: FRAGMENT.checks } };
  const args = {
    domain: "example.com",
    commitSha: "abc",
    buildId: null,
    environment: "production",
    gateConfigHash: "sha256:x",
    gates,
  };
  assert.equal(computeSnapshotId(args), computeSnapshotId({ ...args }));
});

test("idempotency: snapshotId changes when a gate outcome changes", () => {
  const base = {
    domain: "example.com",
    commitSha: "abc",
    buildId: null,
    environment: "production",
    gateConfigHash: "sha256:x",
  };
  const a = computeSnapshotId({ ...base, gates: { "gate-seo": { outcome: "pass" } } });
  const b = computeSnapshotId({ ...base, gates: { "gate-seo": { outcome: "fail" } } });
  assert.notEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* 6. Partial execution - the核 invariant: missing is never pass       */
/* ------------------------------------------------------------------ */

test("partial: a gate with no fragment is not_run, never pass", () => {
  const merged = mergeFragments(["gate-seo", "gate-ada"], new Map([["gate-seo", FRAGMENT]]));
  assert.equal(merged.gates["gate-ada"].outcome, "not_run");
  assert.deepEqual(merged.gatesNotRun, ["gate-ada"]);
  assert.notEqual(merged.gates["gate-ada"].outcome, "pass");
  assert.ok(merged.gates["gate-ada"].reason);
});

test("partial: a not_run gate contributes no passing checks to the summary", () => {
  const merged = mergeFragments(["gate-seo", "gate-ada"], new Map([["gate-seo", FRAGMENT]]));
  const s = summarize(merged.gates);
  assert.equal(s.checksTotal, 1);
  assert.equal(s.checksPassed, 1);
});

test("partial: a malformed fragment is error+malformed, never silently dropped", () => {
  const merged = mergeFragments(
    ["gate-seo"],
    new Map([["gate-seo", { malformed: true as const, reason: "fragment is not valid JSON" }]]),
  );
  assert.equal(merged.gates["gate-seo"].outcome, "error");
  assert.equal(merged.gates["gate-seo"].malformed, true);
  assert.deepEqual(merged.malformed, ["gate-seo"]);
});

test("partial: a fragment from an undeclared gate is still recorded", () => {
  const merged = mergeFragments([], new Map([["gate-seo", FRAGMENT]]));
  assert.equal(merged.gates["gate-seo"].outcome, "pass");
  assert.ok(merged.gatesRun.includes("gate-seo"));
});

/* ------------------------------------------------------------------ */
/* 7. Comparability                                                    */
/* ------------------------------------------------------------------ */

function snap(overrides: {
  env?: string;
  mode?: string | null;
  schema?: number;
  hash?: string;
  routes?: number;
}) {
  return {
    schemaVersion: overrides.schema ?? SCHEMA_VERSION,
    build: { environment: overrides.env ?? "production" },
    summary: { comparability: { adaScanMode: overrides.mode ?? "browser" } },
    site: { gateConfigHash: overrides.hash ?? "sha256:a", routeCount: overrides.routes ?? 10 },
  };
}

test("comparability: differing ada scanMode is NOT_COMPARABLE", () => {
  const v = assertComparable(snap({ mode: "browser" }), snap({ mode: "html-snapshot" }));
  assert.equal(v.comparable, false);
  if (!v.comparable) {
    assert.equal(v.code, "NOT_COMPARABLE");
    assert.match(v.reason, /color-contrast/);
  }
});

test("comparability: differing environment is NOT_COMPARABLE", () => {
  const v = assertComparable(snap({ env: "local" }), snap({ env: "production" }));
  assert.equal(v.comparable, false);
  if (!v.comparable) assert.match(v.reason, /not production evidence/);
});

test("comparability: differing schema version is NOT_COMPARABLE", () => {
  const v = assertComparable(snap({ schema: 1 }), snap({ schema: 2 }));
  assert.equal(v.comparable, false);
});

test("comparability: same mode and environment is comparable", () => {
  assert.equal(assertComparable(snap({}), snap({})).comparable, true);
});

test("comparability: a changed config hash is reported as scope drift", () => {
  const d = detectScopeDrift(snap({ hash: "sha256:a", routes: 10 }), snap({ hash: "sha256:b", routes: 12 }));
  assert.equal(d.drifted, true);
  assert.match(d.reason ?? "", /scope reasons/);
});

/* ------------------------------------------------------------------ */
/* 8. Config hash + environment classification                         */
/* ------------------------------------------------------------------ */

test("config hash: stable across runs, order-independent for routes", () => {
  const a = computeConfigHash({ routes: ["/a", "/b"], expectedGates: ["gate-seo"] });
  const b = computeConfigHash({ routes: ["/b", "/a"], expectedGates: ["gate-seo"] });
  assert.equal(a, b, "route order must not change scope identity");
});

test("config hash: changes when the route inventory changes", () => {
  const a = computeConfigHash({ routes: ["/a"], expectedGates: [] });
  const b = computeConfigHash({ routes: ["/a", "/b"], expectedGates: [] });
  assert.notEqual(a, b);
});

test("environment: vercel and CI markers classify correctly, never guessing production", () => {
  assert.equal(classifyEnvironment({ VERCEL_ENV: "production" } as NodeJS.ProcessEnv), "production");
  assert.equal(classifyEnvironment({ VERCEL_ENV: "preview" } as NodeJS.ProcessEnv), "preview");
  assert.equal(classifyEnvironment({ CI: "true" } as NodeJS.ProcessEnv), "development");
  assert.equal(classifyEnvironment({} as NodeJS.ProcessEnv), "local");
  // A laptop pointed at the live site is still local.
  assert.equal(
    classifyEnvironment({ GATE_BASE_URL: "https://live.example.com" } as NodeJS.ProcessEnv),
    "local",
  );
});

test("expected gates are derived from the site's own gate: scripts", () => {
  const got = expectedGatesFromScripts({
    "gate:ada": "x",
    "gate:seo": "x",
    "gate:all": "x",
    "gate:snapshot": "x",
    build: "x",
  });
  assert.deepEqual(got, ["gate-ada", "gate-seo"]);
});

/* ------------------------------------------------------------------ */
/* 9. Real fixture round trip                                          */
/* ------------------------------------------------------------------ */

test("real fixture: a snapshot captured from bwt-sample-site parses and is well formed", () => {
  const raw = readFileSync(path.join(FIXTURES, "real-bwt-sample-site.snapshot.json"), "utf8");
  const s = JSON.parse(raw);

  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.match(s.snapshotId, /^sha256:[0-9a-f]{64}$/);
  assert.match(s.site.gateConfigHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(s.site.repo, "bwt-sample-site");

  // Captured from a laptop, so it must be classified local - not production.
  assert.equal(s.build.environment, "local");
  assert.ok(s.build.commitSha, "a real run resolves a commit sha");

  // Only the three source gates were run, so the record must be partial and
  // must name the four that were not.
  assert.equal(s.completeness.status, "partial");
  assert.deepEqual(s.completeness.gatesNotRun.sort(), [
    "gate-ada",
    "gate-ai-instrumentation",
    "gate-dashboard-parity",
    "gate-seo",
  ]);
  for (const g of s.completeness.gatesNotRun) {
    assert.equal(s.gates[g].outcome, "not_run");
    assert.notEqual(s.gates[g].outcome, "pass");
  }
  assert.ok(s.completeness.reason);
});

test("real fixture: contains no secret shapes and no absolute filesystem paths", () => {
  const raw = readFileSync(path.join(FIXTURES, "real-bwt-sample-site.snapshot.json"), "utf8");
  for (const re of [
    /AIza[0-9A-Za-z_-]{10,}/,
    /\bG-[A-Z0-9]{6,}\b/,
    /sk_(live|test)_/,
    /postgres(ql)?:\/\//i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\/Users\/[a-z]+/i,
  ]) {
    assert.ok(!re.test(raw), `real snapshot leaked ${re}`);
  }
});

test("real fixture: a real fragment carries its gate identity and outcome", () => {
  const f = JSON.parse(
    readFileSync(path.join(FIXTURES, "real-gate-sitemap-source.fragment.json"), "utf8"),
  );
  assert.equal(f.gate, "gate-sitemap-source");
  assert.equal(f.outcome, "pass");
  assert.ok(Array.isArray(f.checks));
  assert.ok(f.startedAt && f.finishedAt);
});

/* ------------------------------------------------------------------ */
/* 10. End-to-end build against a synthetic consumer                   */
/* ------------------------------------------------------------------ */

test("end to end: buildSnapshot produces a complete record when every gate ran", () => {
  const dir = tmp();
  const cwd = tmp();
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fake-site", scripts: { "gate:seo": "x" } }),
  );
  writeFileSync(
    path.join(cwd, "gate.config.json"),
    JSON.stringify({ routes: ["/", "/about"], baseUrl: "https://fake.example.com" }),
  );
  mkdirSync(fragmentsDir(dir), { recursive: true });
  writeFileSync(path.join(fragmentsDir(dir), "gate-seo.json"), JSON.stringify(FRAGMENT));

  const s = buildSnapshot(cwd, dir) as Record<string, any>;
  assert.equal(s.completeness.status, "complete");
  assert.deepEqual(s.completeness.gatesNotRun, []);
  assert.equal(s.site.domain, "fake.example.com");
  assert.equal(s.site.routeCount, 2);
  assert.equal(s.gates["gate-seo"].outcome, "pass");
});

test("end to end: a malformed fragment cannot produce a complete snapshot", () => {
  const dir = tmp();
  const cwd = tmp();
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fake-site", scripts: { "gate:seo": "x" } }),
  );
  writeFileSync(path.join(cwd, "gate.config.json"), JSON.stringify({ routes: ["/"] }));
  mkdirSync(fragmentsDir(dir), { recursive: true });
  writeFileSync(path.join(fragmentsDir(dir), "gate-seo.json"), "{ this is not json");

  const s = buildSnapshot(cwd, dir) as Record<string, any>;
  assert.equal(s.completeness.status, "partial");
  assert.equal(s.gates["gate-seo"].outcome, "error");
  assert.equal(s.gates["gate-seo"].malformed, true);
  assert.match(s.completeness.reason, /malformed/);
});

test("end to end: no fragments at all yields partial with a stated reason", () => {
  const dir = tmp();
  const cwd = tmp();
  writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "fake-site", scripts: { "gate:seo": "x" } }),
  );
  writeFileSync(path.join(cwd, "gate.config.json"), JSON.stringify({ routes: [] }));
  const s = buildSnapshot(cwd, dir) as Record<string, any>;
  assert.equal(s.completeness.status, "partial");
  assert.match(s.completeness.reason, /no fragments found/);
});
