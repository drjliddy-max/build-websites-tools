/*
 * Package-contract and installed-artifact tests.
 *
 * WHY THIS EXISTS
 *
 * Review found the published package diverged from its own documentation: the
 * README described a JSON Schema that did NOT ship, while test entries and
 * fixtures DID. These tests make package contents a tested contract.
 *
 * WHY THE TARBALL IS EXTRACTED RATHER THAN `npm install`ed
 *
 * The first version of this test ran `npm install <tarball>` inside the test.
 * This package's runtime dependencies include playwright, so that pulled
 * browser binaries over the network on every CI run - the hosted `test` job hit
 * a 15-minute timeout and was cancelled, which is why the reviewed head had no
 * green check. Extracting the tarball and supplying third-party dependencies
 * locally produces the same module graph npm would, without the download.
 *
 * The contract being proved is that THIS PACKAGE's own code and schema come
 * only from the tarball. A guard asserts that every module path belonging to
 * this package resolves inside the temporary root, so the test can never
 * silently fall back to the development checkout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  realpathSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, "..", "..");

/**
 * `npm pack --dry-run` is spawned once and memoized. Calling it per-test
 * spawned npm four times and contributed to the CI timeout.
 */
let PACKED: string[] | null = null;
function packedFiles(): string[] {
  if (PACKED) return PACKED;
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  PACKED = (JSON.parse(out)[0].files as Array<{ path: string }>).map((f) => f.path);
  return PACKED;
}

const REQUIRED_ENTRIES = [
  "package.json",
  "README.md",
  "LICENSE",
  "bin/gate-snapshot.mjs",
  "bin/_run.mjs",
  "src/snapshot.ts",
  "src/gate-snapshot.ts",
  "src/snapshot-validate.ts",
  "schema/build-snapshot-v1.schema.json",
];

const FORBIDDEN_PATTERNS: Array<[string, RegExp]> = [
  ["unit tests", /__tests__/],
  ["test fixtures", /fixtures?\//],
  ["any .test. file", /\.test\./],
  ["planning documents", /ROLLOUT/i],
  ["docs directory", /^docs\//],
  ["tsconfig", /tsconfig/],
  ["lockfile", /package-lock\.json$/],
  ["graphify output", /^graphify-out\//],
  ["fallow cache", /^\.fallow/],
  ["snapshot artifacts", /^\.build-websites-tools\//],
  ["agent instructions", /^(AGENTS|CLAUDE)\.md$/],
];

test("package: every required public entry ships", () => {
  const files = packedFiles();
  for (const req of REQUIRED_ENTRIES) {
    assert.ok(files.includes(req), `missing required package entry: ${req}`);
  }
});

test("package: no tests, fixtures, or internal documents ship", () => {
  const files = packedFiles();
  for (const [label, re] of FORBIDDEN_PATTERNS) {
    const hits = files.filter((f) => re.test(f));
    assert.deepEqual(hits, [], `${label} must not ship, found: ${hits.join(", ")}`);
  }
});

test("package: every declared bin target is present in the tarball", () => {
  const files = packedFiles();
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  for (const [name, target] of Object.entries(pkg.bin)) {
    assert.ok(files.includes(target), `bin "${name}" points at ${target}, which does not ship`);
  }
});

test("package: the schema resolves the same way the code resolves it", () => {
  const require = createRequire(path.join(PKG_ROOT, "src", "gate-snapshot.ts"));
  const schema = require("../schema/build-snapshot-v1.schema.json");
  assert.equal(String(schema.$id).endsWith("build-snapshot-v1.schema.json"), true);
});

/* ------------------------------------------------------------------ */
/* Installed-artifact contract                                         */
/* ------------------------------------------------------------------ */

type Installed = { root: string; pkgDir: string; consumer: string };

let INSTALLED: Installed | null = null;

/** Pack, extract, and stand up a consumer repo. Built once, reused. */
function installPackage(): Installed {
  if (INSTALLED) return INSTALLED;
  // realpath: on macOS os.tmpdir() is /var -> /private/var, and an
  // uncanonicalized root makes every containment assertion a false negative.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "gs-installed-")));

  const packJson = execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const tarball = path.join(root, JSON.parse(packJson)[0].filename as string);
  assert.ok(existsSync(tarball), "npm pack produced no tarball");

  const pkgDir = path.join(root, "node_modules", "build-websites-tools");
  mkdirSync(pkgDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", pkgDir, "--strip-components=1"], { stdio: "ignore" });

  // Third-party dependencies, exactly as npm would provide them - but copied
  // from the local store instead of downloaded, so no browser binaries are
  // fetched during the test.
  cpSync(path.join(PKG_ROOT, "node_modules"), path.join(root, "node_modules"), {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (src) => !src.includes("node_modules/build-websites-tools"),
  });

  const consumer = path.join(root, "consumer");
  mkdirSync(consumer, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: consumer, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: consumer, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: consumer, stdio: "ignore" });
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "consumer-site", version: "1.0.0", private: true, scripts: { "gate:seo": "x" } }),
  );
  writeFileSync(
    path.join(consumer, "gate.config.json"),
    JSON.stringify({ routes: ["/"], baseUrl: "https://consumer.example.com" }),
  );
  writeFileSync(path.join(consumer, "README.md"), "x");
  execFileSync("git", ["add", "-A"], { cwd: consumer, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: consumer, stdio: "ignore" });

  INSTALLED = { root, pkgDir, consumer };
  return INSTALLED;
}

function fragmentFor(gate: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fragmentSchemaVersion: 1,
    gate,
    version: "0.0.0",
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:00:01.000Z",
    outcome: "pass",
    provenance: {},
    checks: [{ name: "canonical", pass: true, detail: "ok" }],
    ...over,
  });
}

function seed(consumer: string, files: Record<string, string>): string {
  const art = path.join(consumer, ".build-websites-tools", "gate-snapshot");
  const frags = path.join(art, "fragments");
  mkdirSync(frags, { recursive: true });
  for (const f of readdirSync(frags)) {
    execFileSync("rm", ["-f", path.join(frags, f)]);
  }
  execFileSync("rm", ["-f", path.join(art, "snapshot.json")]);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(frags, name), body);
  return art;
}

function runInstalled(inst: Installed, env: Record<string, string | undefined>) {
  try {
    const stdout = execFileSync(process.execPath, [path.join(inst.pkgDir, "bin", "gate-snapshot.mjs")], {
      cwd: inst.consumer,
      env: { ...process.env, GATE_SNAPSHOT_DIR: undefined, ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status ?? -1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

test("installed: package's own modules resolve ONLY inside the temporary root", { timeout: 120_000 }, () => {
  const inst = installPackage();
  const req = createRequire(path.join(inst.pkgDir, "package.json"));
  const schemaPath = req.resolve("./schema/build-snapshot-v1.schema.json");
  assert.ok(
    schemaPath.startsWith(inst.root),
    `schema resolved outside the install root: ${schemaPath}`,
  );
  assert.ok(!schemaPath.startsWith(PKG_ROOT), "schema resolved back to the development checkout");
  for (const f of ["src/snapshot.ts", "src/gate-snapshot.ts", "src/snapshot-validate.ts", "bin/gate-snapshot.mjs"]) {
    const p = path.join(inst.pkgDir, f);
    assert.ok(existsSync(p), `${f} missing from the installed package`);
    assert.ok(p.startsWith(inst.root));
  }
});

test("installed: no tests or fixtures reached the installed package", { timeout: 120_000 }, () => {
  const inst = installPackage();
  const walk = (d: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, acc);
      else acc.push(path.relative(inst.pkgDir, full));
    }
    return acc;
  };
  assert.deepEqual(
    walk(inst.pkgDir).filter((f) => /__tests__|\.test\.|fixtures?\//.test(f)),
    [],
  );
});

test("installed: binary produces a snapshot that validates against the INSTALLED schema", { timeout: 120_000 }, () => {
  const inst = installPackage();
  const art = seed(inst.consumer, { "gate-seo.json": fragmentFor("gate-seo") });
  const r = runInstalled(inst, { GATE_SNAPSHOT_ENABLED: "1" });
  assert.equal(r.code, 0, r.stderr);

  const produced = JSON.parse(readFileSync(path.join(art, "snapshot.json"), "utf8"));
  assert.equal(produced.completeness.status, "complete");
  assert.equal(produced.completeness.reason, null);

  // Validate using the INSTALLED validator against the INSTALLED schema.
  const req = createRequire(path.join(inst.pkgDir, "package.json"));
  const schema = req("./schema/build-snapshot-v1.schema.json");
  const validatorPath = path.join(inst.pkgDir, "src", "snapshot-validate.ts");
  assert.ok(validatorPath.startsWith(inst.root));

  const script = `
    import { validateAgainstSchema, validateSnapshotSemantics } from ${JSON.stringify(validatorPath)};
    import { readFileSync } from "node:fs";
    const doc = JSON.parse(readFileSync(${JSON.stringify(path.join(art, "snapshot.json"))}, "utf8"));
    const schema = JSON.parse(readFileSync(${JSON.stringify(path.join(inst.pkgDir, "schema", "build-snapshot-v1.schema.json"))}, "utf8"));
    const s = validateAgainstSchema(doc, schema);
    const m = validateSnapshotSemantics(doc);
    console.log(JSON.stringify({ structural: s.valid, semantic: m.valid, errors: [...(s.errors ?? []), ...(m.errors ?? [])] }));
  `;
  const scriptPath = path.join(inst.root, "validate.mjs");
  writeFileSync(scriptPath, script);
  const out = execFileSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: inst.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  const verdict = JSON.parse(out.trim().split("\n").pop() as string);
  assert.equal(verdict.structural, true, JSON.stringify(verdict.errors));
  assert.equal(verdict.semantic, true, JSON.stringify(verdict.errors));
  assert.ok(String(schema.$id).length > 0);
});

test("installed: a fragment missing fragmentSchemaVersion is malformed, not evidence", { timeout: 120_000 }, () => {
  const inst = installPackage();
  const noVersion = JSON.parse(fragmentFor("gate-seo"));
  delete noVersion.fragmentSchemaVersion;
  const art = seed(inst.consumer, { "gate-seo.json": JSON.stringify(noVersion) });
  const r = runInstalled(inst, { GATE_SNAPSHOT_ENABLED: "1" });
  assert.equal(r.code, 0);
  const doc = JSON.parse(readFileSync(path.join(art, "snapshot.json"), "utf8"));
  assert.notEqual(doc.completeness.status, "complete");
  assert.deepEqual(doc.completeness.malformed, ["gate-seo"]);
});

test("installed: a skipped gate never reads as pass and blocks complete", { timeout: 120_000 }, () => {
  const inst = installPackage();
  const art = seed(inst.consumer, {
    "gate-seo.json": fragmentFor("gate-seo", { outcome: "skipped", provenance: { skipped: true, skipReason: "declared" } }),
  });
  const r = runInstalled(inst, { GATE_SNAPSHOT_ENABLED: "1" });
  assert.equal(r.code, 0);
  const doc = JSON.parse(readFileSync(path.join(art, "snapshot.json"), "utf8"));
  assert.equal(doc.gates["gate-seo"].outcome, "skipped");
  assert.notEqual(doc.gates["gate-seo"].outcome, "pass");
  assert.notEqual(doc.completeness.status, "complete");
  assert.deepEqual(doc.completeness.skipped, ["gate-seo"]);
});

test("installed: prototype-shaped fragment keys cannot forge evidence", { timeout: 120_000 }, () => {
  const inst = installPackage();
  const art = seed(inst.consumer, {
    "gate-seo.json": JSON.stringify({
      ...JSON.parse(fragmentFor("gate-seo")),
      constructor: { evil: true },
      __proto__: { polluted: true },
      toString: "not-a-function",
    }),
  });
  const r = runInstalled(inst, { GATE_SNAPSHOT_ENABLED: "1" });
  assert.equal(r.code, 0, r.stderr);
  const raw = readFileSync(path.join(art, "snapshot.json"), "utf8");
  assert.ok(!raw.includes("polluted"), "prototype payload reached the artifact");
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "global prototype was polluted");
});

test("installed: inert without authorization, and nonzero on armed misconfiguration", { timeout: 120_000 }, () => {
  const inst = installPackage();
  seed(inst.consumer, { "gate-seo.json": fragmentFor("gate-seo") });

  const inert = runInstalled(inst, { GATE_SNAPSHOT_ENABLED: undefined });
  assert.equal(inert.code, 0);
  assert.equal(inert.stdout.trim(), "");

  const misconfigured = runInstalled(inst, { GATE_SNAPSHOT_ENABLED: "1", GATE_SNAPSHOT_DIR: "/tmp/anything" });
  assert.equal(misconfigured.code, 1);
  assert.match(misconfigured.stderr, /GATE_SNAPSHOT_DIR/);
});
