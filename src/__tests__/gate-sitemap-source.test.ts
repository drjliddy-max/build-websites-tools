/*
 * Contract for the static sitemap-source gate.
 *
 * It must catch the construct that produced the siteclinic.io defect - one
 * build-time date stamped onto every route - WITHOUT flagging the supported
 * way to derive freshness, which is parsing stored content metadata.
 *
 * The false-positive tests matter more than the positive ones here: a gate
 * that fails `new Date(entry.published)` would push consumers to disable it,
 * and a disabled gate enforces nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scanSitemapSource,
  stripCommentsAndStrings,
  findSitemapSources,
  evaluateSitemapSource,
} from "../gate-sitemap-source";

const FILE = "src/app/sitemap.ts";

function codes(source: string): string[] {
  return scanSitemapSource(FILE, source).map((v) => v.code);
}

// ─── prohibited patterns ─────────────────────────────────────────────

test("flags the shared build-scoped date variable (the siteclinic.io defect)", () => {
  const source = `
    export default function sitemap() {
      const now = new Date();
      return [
        { url: "/", lastModified: now },
        { url: "/about", lastModified: now },
        { url: "/privacy", lastModified: now },
      ];
    }
  `;
  const violations = scanSitemapSource(FILE, source);
  assert.equal(violations.length, 1, "one root cause, reported once");
  const [violation] = violations;
  assert.equal(violation.code, "build-scoped-shared-date");
  assert.equal(violation.line, 3, "points at the declaration, not the uses");
  assert.equal(violation.match, "const now = new Date();");
  assert.match(violation.remediation, /3 lastModified assignment\(s\)/);
  assert.equal(violation.file, FILE);
});

test("flags a bare new Date() used inline per route", () => {
  const source = `
    export default function sitemap() {
      return ROUTES.map((p) => ({ url: p, lastModified: new Date() }));
    }
  `;
  const violations = scanSitemapSource(FILE, source);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "bare-new-date");
  assert.equal(violations[0].line, 3);
  assert.match(violations[0].remediation, /build\/process instant/);
});

test("flags new Date().toISOString()", () => {
  assert.deepEqual(
    codes(`const entries = [{ url: "/", lastModified: new Date().toISOString() }];`),
    ["bare-new-date"],
  );
});

test("flags Date.now() used as freshness", () => {
  assert.deepEqual(
    codes(`const entries = [{ url: "/", lastModified: Date.now() }];`),
    ["date-now"],
  );
});

test("flags a Date.now() variable shared across routes", () => {
  const violations = scanSitemapSource(
    FILE,
    `const stamp = Date.now();
     const entries = [{ url: "/", lastModified: stamp }, { url: "/a", lastModified: stamp }];`,
  );
  assert.equal(violations[0].code, "build-scoped-shared-date");
});

test("reports file, line, matched expression, and remediation for every violation", () => {
  const violations = scanSitemapSource(
    FILE,
    `const a = 1;\nconst t = new Date();\nexport const x = { lastModified: Date.now() };`,
  );
  for (const violation of violations) {
    assert.equal(violation.file, FILE);
    assert.ok(violation.line > 0);
    assert.ok(violation.match.length > 0);
    assert.ok(violation.remediation.length > 0);
  }
});

// ─── must NOT false-positive ─────────────────────────────────────────

test("ALLOWS new Date(content.updatedAt) - parsing stored content metadata", () => {
  const source = `
    export default function sitemap() {
      return posts.map((post) => ({
        url: post.slug,
        lastModified: new Date(post.updatedAt),
      }));
    }
  `;
  assert.deepEqual(scanSitemapSource(FILE, source), []);
});

test("ALLOWS new Date(entry.published ?? entry.target_date)", () => {
  assert.deepEqual(
    codes(`lastModified: new Date(entry.published ?? entry.target_date),`),
    [],
  );
});

test("ALLOWS a literal content date", () => {
  assert.deepEqual(codes(`lastModified: new Date("2026-06-07"),`), []);
});

test("ALLOWS a template-literal content date", () => {
  assert.deepEqual(codes("lastModified: new Date(`${day}T00:00:00.000Z`),"), []);
});

test("ALLOWS the shared helper", () => {
  const source = `
    import { defineSitemap, toNextSitemap } from "build-websites-tools/sitemap";
    export default function sitemap() {
      return toNextSitemap(defineSitemap({ baseUrl: BASE, routes: ROUTES }));
    }
  `;
  assert.deepEqual(scanSitemapSource(FILE, source), []);
});

test("a commented-out new Date() is not a violation", () => {
  const source = `
    // const now = new Date();  <- removed, see the lastmod standard
    /* legacy: lastModified: new Date() */
    const entries = [{ url: "/", lastModified: new Date("2026-06-07") }];
  `;
  assert.deepEqual(scanSitemapSource(FILE, source), []);
});

test("new Date() inside a string literal is not a violation", () => {
  const source = `const help = "do not use new Date() here"; const d = new Date("2026-06-07");`;
  assert.deepEqual(scanSitemapSource(FILE, source), []);
});

test("the per-line escape hatch exempts a genuine clock read", () => {
  const source = `
    // drop posts scheduled in the future
    const clock = new Date(); // bwt-allow-build-time-date
    const entries = posts
      .filter((p) => new Date(p.published) <= clock)
      .map((p) => ({ url: p.slug, lastModified: new Date(p.published) }));
  `;
  assert.deepEqual(scanSitemapSource(FILE, source), []);
});

// ─── comment/string stripper ─────────────────────────────────────────

test("stripCommentsAndStrings preserves line numbering exactly", () => {
  const source = `line1\n// line2 comment\n/* line3\nline4 */\nline5`;
  const stripped = stripCommentsAndStrings(source);
  assert.equal(stripped.split("\n").length, source.split("\n").length);
  assert.equal(stripped.split("\n")[0], "line1");
  assert.match(stripped.split("\n")[1], /^\s+$/);
});

test("stripCommentsAndStrings handles escaped quotes without running away", () => {
  const source = `const a = "he said \\"hi\\""; const d = new Date();`;
  assert.match(stripCommentsAndStrings(source), /new Date\(\)/);
});

// ─── filesystem integration ──────────────────────────────────────────

test("findSitemapSources + evaluateSitemapSource work against a real tree", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-sitemap-src-"));
  try {
    fs.mkdirSync(path.join(cwd, "src/app"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "src/app/sitemap.ts"),
      `const now = new Date();\nexport const e = [{ url: "/", lastModified: now }];\n`,
    );

    const sources = findSitemapSources({ cwd });
    assert.deepEqual(sources.map((s) => s.file), ["src/app/sitemap.ts"]);

    const result = evaluateSitemapSource({ cwd });
    assert.equal(result.pass, false);
    assert.equal(result.violations[0].code, "build-scoped-shared-date");
    assert.equal(result.violations[0].file, "src/app/sitemap.ts");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("a site with no dynamic sitemap source scans nothing and passes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bwt-sitemap-none-"));
  try {
    fs.mkdirSync(path.join(cwd, "public"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "public/sitemap.xml"), "<urlset/>");
    const result = evaluateSitemapSource({ cwd });
    assert.equal(result.pass, true);
    assert.deepEqual(result.files, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
