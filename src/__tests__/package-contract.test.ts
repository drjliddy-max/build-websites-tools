/*
 * Package-contract tests.
 *
 * WHY THIS EXISTS
 *
 * Review found the published package diverged from its own documentation: the
 * README described a JSON Schema that did NOT ship, while 19 test entries and
 * 4 fixtures DID. A consumer therefore installed the tests and could not
 * resolve the schema the docs told them to validate against.
 *
 * These tests make the package contents a tested contract rather than a
 * side effect of the `files` field. The strongest one packs the tarball,
 * installs it into a temporary directory, and drives the real binary from the
 * installed copy - the only way to prove portability of the shipped artifact
 * rather than of the working tree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, "..", "..");

function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (JSON.parse(out)[0].files as Array<{ path: string }>).map((f) => f.path);
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
  ["internal rollout plans", /ROLLOUT/i],
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

test("package: the public JSON Schema ships (the README documents it)", () => {
  assert.ok(packedFiles().includes("schema/build-snapshot-v1.schema.json"));
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

test("package: the schema is resolvable the same way the code resolves it", () => {
  // gate-snapshot.ts loads the schema via createRequire("../schema/...").
  // If that relative path ever moves, this fails here rather than in a
  // consumer's build.
  const require = createRequire(path.join(PKG_ROOT, "src", "gate-snapshot.ts"));
  const schema = require("../schema/build-snapshot-v1.schema.json");
  assert.equal(schema.$id.endsWith("build-snapshot-v1.schema.json"), true);
});

/*
 * Installed-package test.
 *
 * Packs, installs into a throwaway directory, and runs the shipped binary from
 * the installed copy inside a real git repository. This is the only check that
 * proves the ARTIFACT works rather than the working tree.
 */
test("installed package: binary runs, schema resolves, output validates, no tests present", { timeout: 180_000 }, () => {
  const stage = mkdtempSync(path.join(tmpdir(), "gs-pack-"));

  const packJson = execFileSync("npm", ["pack", "--json", "--pack-destination", stage], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const tarball = path.join(stage, JSON.parse(packJson)[0].filename as string);
  assert.ok(existsSync(tarball), "npm pack produced no tarball");

  // A consumer-shaped git repo that installs the tarball.
  const consumer = path.join(stage, "consumer");
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

  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error", tarball], {
    cwd: consumer,
    stdio: "ignore",
    timeout: 150_000,
  });

  const installed = path.join(consumer, "node_modules", "build-websites-tools");
  assert.ok(existsSync(installed), "package did not install");

  // No tests or fixtures in the installed copy.
  const walk = (d: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, acc);
      else acc.push(path.relative(installed, full));
    }
    return acc;
  };
  const installedFiles = walk(installed);
  assert.deepEqual(
    installedFiles.filter((f) => /__tests__|\.test\.|fixtures?\//.test(f)),
    [],
    "tests or fixtures reached the installed package",
  );

  // The schema resolves from the INSTALLED package.
  const schemaPath = path.join(installed, "schema", "build-snapshot-v1.schema.json");
  assert.ok(existsSync(schemaPath), "schema is not resolvable from the installed package");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  // Seed a fragment, then run the INSTALLED binary.
  const artifactDir = path.join(consumer, ".build-websites-tools", "gate-snapshot", "fragments");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, "gate-seo.json"),
    JSON.stringify({
      fragmentSchemaVersion: 1,
      gate: "gate-seo",
      version: "0.0.0",
      startedAt: "2026-08-04T00:00:00.000Z",
      finishedAt: "2026-08-04T00:00:01.000Z",
      outcome: "pass",
      provenance: {},
      checks: [{ name: "canonical", pass: true, detail: "ok" }],
    }),
  );

  execFileSync(process.execPath, [path.join(installed, "bin", "gate-snapshot.mjs")], {
    cwd: consumer,
    env: { ...process.env, GATE_SNAPSHOT_ENABLED: "1", GATE_SNAPSHOT_DIR: undefined } as NodeJS.ProcessEnv,
    stdio: "pipe",
    timeout: 60_000,
  });

  const outPath = path.join(consumer, ".build-websites-tools", "gate-snapshot", "snapshot.json");
  assert.ok(existsSync(outPath), "installed binary produced no snapshot");
  const produced = JSON.parse(readFileSync(outPath, "utf8"));

  // Output validates against the schema shipped INSIDE the installed package.
  assert.equal(produced.schemaVersion, schema.properties.schemaVersion.const);
  assert.equal(produced.completeness.status, "complete");
  assert.equal(produced.completeness.reason, null);
  assert.match(produced.snapshotId, new RegExp(schema.properties.snapshotId.pattern));
});
