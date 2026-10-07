/*
 * Tests for gate-build-determinism-source.
 *
 * Fixtures are named after the real sites and the real false positives from
 * the 2026-10-07 estate-wide font incident, because synthetic strings would
 * not have caught any of them:
 *
 *   - qirofit / jeffrystein / participation-effect: `import { Inter } from
 *     "next/font/google"`: the defect.
 *   - siteclinic / adaauditreport: TWO families in one import statement
 *     (`{ DM_Serif_Display, Geist }`), which a naive single-name pattern misses.
 *   - the migrated consumers: a COMMENT that names next/font/google three
 *     times explaining why it must never return. Flagging that comment would
 *     make the gate unusable on exactly the repos that fixed the problem.
 *   - liddy-podiatry-site: never used it. Must pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  evaluateSource,
  findRemoteFontImports,
  REMOTE_FONT_MODULES,
} from "../gate-build-determinism-source";

const temps: string[] = [];

function makeSite(files: Record<string, string>, config?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-determinism-"));
  temps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  fs.writeFileSync(
    path.join(dir, "gate.config.json"),
    JSON.stringify({ routes: ["/"], baseUrl: "http://127.0.0.1:3000", ...(config ?? {}) }),
  );
  return dir;
}

const check = (dir: string, name: string) => {
  const { checks } = evaluateSource({ cwd: dir });
  const found = checks.find((c) => c.name === name);
  assert.ok(found, `expected a check named ${name}`);
  return found;
};

afterEach(() => {
  while (temps.length) {
    const d = temps.pop();
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("the defect", () => {
  it("FAILS on a single-family import (qirofit/jeffrystein/participation-effect shape)", () => {
    const dir = makeSite({
      "src/app/layout.tsx": `import { Inter } from "next/font/google";
const inter = Inter({ subsets: ["latin"] });
export default function L({ children }) { return children; }`,
    });
    const c = check(dir, "noRemoteFontFetch");
    assert.equal(c.pass, false);
    assert.match(c.detail, /src\/app\/layout\.tsx:1/);
    assert.match(c.detail, /next\/font\/google/);
  });

  it("FAILS on two families in ONE import (siteclinic/adaauditreport shape)", () => {
    const dir = makeSite({
      "src/app/layout.tsx": `import { DM_Serif_Display, Geist } from "next/font/google";`,
    });
    assert.equal(check(dir, "noRemoteFontFetch").pass, false);
  });

  it("FAILS on the side-effect and require/dynamic forms", () => {
    for (const body of [
      `import "next/font/google";`,
      `const g = require("next/font/google");`,
      `const g = await import("next/font/google");`,
    ]) {
      const dir = makeSite({ "src/app/page.tsx": body });
      assert.equal(check(dir, "noRemoteFontFetch").pass, false, body);
    }
  });

  it("reports every offending file, not just the first", () => {
    const dir = makeSite({
      "src/app/layout.tsx": `import { Inter } from "next/font/google";`,
      "src/components/Hero.tsx": `import { Geist } from "next/font/google";`,
    });
    const { violations } = evaluateSource({ cwd: dir });
    assert.equal(violations.length, 2);
    assert.deepEqual(
      violations.map((v) => v.file).sort((a, b) => a.localeCompare(b)),
      ["src/app/layout.tsx", "src/components/Hero.tsx"],
    );
  });
});

describe("the false positives this gate must not produce", () => {
  it("PASSES when next/font/google appears only in a comment", () => {
    // Verbatim shape of the comment the migrated consumers now carry.
    const dir = makeSite({
      "src/app/layout.tsx": `import localFont from "next/font/local";

/*
 * Fonts are SELF-HOSTED: woff2 committed under src/app/fonts/ and resolved by
 * next/font/local. No network at build time and none at runtime.
 *
 * They were previously loaded with next/font/google, whose old comment here
 * claimed "no external CDN dependency". That was true at RUNTIME and false at
 * BUILD TIME: next/font/google fetches from Google to self-host the files.
 * Do not reintroduce next/font/google.
 */
const inter = localFont({ src: [{ path: "./fonts/a.woff2" }] });`,
    });
    const c = check(dir, "noRemoteFontFetch");
    assert.equal(c.pass, true, "a comment naming the module must not fail the gate");
  });

  it("PASSES on a single-line // comment mention", () => {
    const dir = makeSite({
      "src/app/layout.tsx": `// migrated away from next/font/google on 2026-10-07
import localFont from "next/font/local";`,
    });
    assert.equal(check(dir, "noRemoteFontFetch").pass, true);
  });

  it("PASSES on next/font/local, which is the remediation", () => {
    const dir = makeSite({
      "src/app/layout.tsx": `import localFont from "next/font/local";
const f = localFont({ src: [{ path: "./fonts/inter.woff2", weight: "100 900" }] });`,
    });
    assert.equal(check(dir, "noRemoteFontFetch").pass, true);
  });

  it("PASSES on a site that never used it (liddy-podiatry-site shape)", () => {
    const dir = makeSite({
      "src/app/layout.tsx": `export default function L({ children }) { return children; }`,
      "src/app/page.tsx": `export default function P() { return null; }`,
    });
    const r = evaluateSource({ cwd: dir });
    assert.equal(r.pass, true);
    assert.equal(r.violations.length, 0);
  });

  it("does not treat a RUNTIME fetch as a build dependency", () => {
    const dir = makeSite({
      "src/app/page.tsx": `export default async function P() {
  const r = await fetch("https://fonts.googleapis.com/css2?family=Inter");
  return <div>{r.status}</div>;
}`,
    });
    assert.equal(check(dir, "noRemoteFontFetch").pass, true);
  });

  it("ignores node_modules and dot-directories", () => {
    const dir = makeSite({
      "src/app/layout.tsx": `import localFont from "next/font/local";`,
      "src/node_modules/dep/index.js": `import { Inter } from "next/font/google";`,
      "src/.cache/x.js": `import { Inter } from "next/font/google";`,
    });
    assert.equal(check(dir, "noRemoteFontFetch").pass, true);
  });
});

describe("line attribution", () => {
  it("reports the import's own line, not the file start", () => {
    const src = `import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";`;
    const hits = findRemoteFontImports(src);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 3);
  });

  it("counts one hit per line even when several patterns could match", () => {
    const hits = findRemoteFontImports(`import { Inter } from "next/font/google";`);
    assert.equal(hits.length, 1);
  });
});

describe("scaffolding", () => {
  it("fails loudly when there is no source directory rather than passing vacuously", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-nosrc-"));
    temps.push(dir);
    fs.writeFileSync(path.join(dir, "gate.config.json"), JSON.stringify({ routes: ["/"] }));
    const r = evaluateSource({ cwd: dir });
    assert.equal(r.pass, false);
    assert.equal(r.checks[0].name, "sourceDirectory");
  });

  it("keeps next/font/local out of the remote list", () => {
    assert.ok(!REMOTE_FONT_MODULES.includes("next/font/local" as never));
    assert.ok(REMOTE_FONT_MODULES.includes("next/font/google"));
  });
});
