// docs-contract - the README is checked against the package, not trusted.
//
// WHY THIS EXISTS
// ===============
// A 2026-08-09 audit found the README simultaneously claiming "these five
// gates", "The six gates", "the same five gates" and "core four" while seven
// gate executables shipped, and telling every new consumer to install
// `#v0.11.1` when the current release was two versions ahead. Neither error
// could break a build, so nothing caught them - a consumer copying the README
// silently got a package predating the fail-closed GA4 contract.
//
// Documentation that no test reads is documentation that drifts. These two
// facts are the ones that mislead a consumer into a wrong action, so they are
// the ones bound to source.
//
// SCOPE, deliberately narrow: this parses two explicitly delimited regions,
// never free prose. Version history ("Migration: v0.10.x to v0.11.1") and
// per-gate descriptions are exempt on purpose - they are about the past, and a
// test that forbade mentioning an old version would be actively wrong.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

/** Extract the text between two HTML-comment markers, failing loudly if absent. */
function region(name: string): string {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  assert.ok(
    from !== -1 && to !== -1 && to > from,
    `README is missing the ${name} region. It is machine-checked - if you moved it, ` +
      `move the markers with it rather than deleting them.`,
  );
  return readme.slice(from + start.length, to);
}

describe("docs contract: gate inventory", () => {
  it("the README gate table lists exactly the executables package.json ships", () => {
    const documented = new Set(
      [...region("GATE-INVENTORY").matchAll(/^\|\s*`(gate-[a-z-]+)`\s*\|/gm)].map((m) => m[1]),
    );
    const shipped = new Set(Object.keys(pkg.bin ?? {}));

    const undocumented = [...shipped].filter((g) => !documented.has(g)).sort();
    const phantom = [...documented].filter((g) => !shipped.has(g)).sort();

    assert.deepEqual(
      undocumented,
      [],
      `gate executable(s) ship but are absent from the README gate table: ${undocumented.join(", ")}. ` +
        `Add a row - a gate nobody documented is a gate nobody adopts.`,
    );
    assert.deepEqual(
      phantom,
      [],
      `README documents gate(s) that do not exist in package.json "bin": ${phantom.join(", ")}. ` +
        `Remove the row or ship the gate.`,
    );
    assert.equal(documented.size, shipped.size, "gate count drifted between docs and package");
  });

  it("the gate table marks exactly one meta-gate", () => {
    const metas = [...region("GATE-INVENTORY").matchAll(/^\|\s*`(gate-[a-z-]+)`\s*\|\s*\*\*meta\*\*/gm)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      metas,
      ["gate-dashboard-parity"],
      "gate-dashboard-parity is the only composing gate; if that changed, the composition " +
        "tree in the README and this expectation both need updating.",
    );
  });
});

describe("docs contract: release pin", () => {
  it("every install example pins the version package.json declares", () => {
    const pins = [
      ...region("RELEASE-PIN").matchAll(/build-websites-tools#v(\d+\.\d+\.\d+)/g),
    ].map((m) => m[1]);

    assert.ok(
      pins.length >= 2,
      "expected the shell and package.json install examples inside RELEASE-PIN; " +
        `found ${pins.length}`,
    );
    for (const pin of pins) {
      assert.equal(
        pin,
        pkg.version,
        `README tells consumers to install v${pin} but package.json declares ${pkg.version}. ` +
          `Bumping the version means updating the install examples in the same commit.`,
      );
    }
  });

  it("install examples use an immutable tag pin, never a local path", () => {
    const text = region("RELEASE-PIN");
    assert.doesNotMatch(
      text,
      /file:\.\.?\//,
      "consumers must install from a tagged GitHub ref. A file: link re-creates the " +
        "vendored-drift class this package exists to remove, and makes a consumer's " +
        "behaviour depend on an uncommitted local checkout.",
    );
    assert.match(text, /github:drjliddy-max\/build-websites-tools#v/);
  });
});
