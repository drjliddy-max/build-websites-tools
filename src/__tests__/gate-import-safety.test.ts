/**
 * Repository-wide invariant: importing a gate module must have no side effects.
 *
 * WHY THIS EXISTS
 * Every gate under src/gate-*.ts is both a CLI (spawned by bin/_run.mjs) and a
 * library (imported by tests for its exported policy helpers). Those two roles
 * conflict: a module that calls main() at top level runs the entire gate the
 * moment anything imports it, which means loading gate.config.json, launching a
 * dev server, scanning routes, and calling process.exit(). A test suite cannot
 * import such a module at all.
 *
 * That is not hypothetical. Before 2026-08-11, gate-ada.ts self-executed, and it
 * was the ONLY gate with no test file: writing one was impossible, so nobody did.
 * The defect hid the absence of its own tests. Adding the guard is what made
 * src/__tests__/gate-ada.test.ts possible.
 *
 * THE CANONICAL PATTERN
 * Guard the entry point so it fires only under direct execution:
 *
 *   const invokedDirectly =
 *     !!process.argv[1] &&
 *     path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
 *   if (invokedDirectly) { ... await main() ... }
 *
 * This is safe with bin/_run.mjs, which SPAWNS the .ts file as a subprocess
 * (argv[1] is the module's own path), so CLI behaviour is unchanged.
 *
 * A second, older idiom (`isCli`) is still present in four modules. It is
 * functionally similar but weaker on two edges; see docs/GATE_MODULE_CONTRACT.md.
 * This test enforces the OUTCOME (import is side-effect free), not the idiom, so
 * either spelling passes and the repo can converge without a flag day.
 *
 * HOW IT WORKS
 * Each module is imported in a child process via a real importer FILE, never
 * `node -e`. With `-e`, process.argv[1] is undefined, which the older `isCli`
 * idiom mis-reads as "invoked directly" and would self-execute. Using a real
 * importer file keeps argv[1] pointing at the importer, which is exactly the
 * shape a test-runner import has.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, it, before, after } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..");

/**
 * Modules known to violate the invariant, with a tracked owner.
 *
 * This is a RATCHET, not an amnesty. The final test asserts that every entry
 * still genuinely fails; fix a module and leave it listed here and the suite
 * goes red telling you to delete the line. An exception cannot silently become
 * permanent.
 *
 * gate-seo.ts: self-executes at top level (no guard of either idiom). Classified
 * 2026-08-11 as a separate pre-existing defect, deliberately NOT repaired in the
 * gate-ada lane that found it. It is the only gate with no unit-test file, which
 * is the same symptom gate-ada had. Repair = add the canonical guard, then remove
 * this entry.
 */
const KNOWN_SELF_EXECUTING = new Set(["gate-seo.ts"]);

let importerPath: string;
let tsxLoader: string;

before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-import-safety-"));
  importerPath = path.join(dir, "importer.mjs");
  fs.writeFileSync(
    importerPath,
    'await import(process.argv[2]);\nconsole.log("IMPORT_OK");\n',
    "utf8",
  );
  tsxLoader = createRequire(import.meta.url).resolve("tsx");
});

after(() => {
  fs.rmSync(path.dirname(importerPath), { recursive: true, force: true });
});

function importInChild(absModulePath: string) {
  return spawnSync(
    process.execPath,
    ["--import", tsxLoader, importerPath, absModulePath],
    { encoding: "utf8" },
  );
}

function gateModules(): string[] {
  return fs
    .readdirSync(srcDir)
    .filter((f) => f.startsWith("gate-") && f.endsWith(".ts"))
    .sort();
}

describe("gate modules are importable without side effects", () => {
  it("finds the gate modules to check", () => {
    const mods = gateModules();
    assert.ok(
      mods.length >= 6,
      `expected the gate module set, found ${mods.length}: ${mods.join(", ")}`,
    );
  });

  for (const mod of gateModules()) {
    const expectedSafe = !KNOWN_SELF_EXECUTING.has(mod);

    it(`${mod} ${expectedSafe ? "imports cleanly" : "is a tracked exception"}`, () => {
      const res = importInChild(path.join(srcDir, mod));

      if (!expectedSafe) {
        // Ratchet: a listed exception must STILL be broken. If it now passes,
        // the fix landed and this entry must be deleted.
        assert.notEqual(
          res.status,
          0,
          `${mod} is listed in KNOWN_SELF_EXECUTING but now imports cleanly. ` +
            `Delete it from that set so the invariant is enforced for it.`,
        );
        return;
      }

      assert.equal(
        res.status,
        0,
        `Importing ${mod} must be side-effect free, but the child exited ` +
          `${res.status}. A gate module that calls main() at top level runs the ` +
          `whole gate on import and cannot be unit-tested. Add the canonical ` +
          `guard (see docs/GATE_MODULE_CONTRACT.md).\n` +
          `stdout: ${res.stdout?.trim()}\nstderr: ${res.stderr?.trim()}`,
      );
      assert.match(
        res.stdout ?? "",
        /IMPORT_OK/,
        `${mod} import did not reach completion`,
      );
    });
  }
});
