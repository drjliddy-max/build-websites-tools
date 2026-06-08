/*
 * Prevention guard for the no-long-dashes rule.
 *
 * Portfolio rule (feedback_no_long_dashes, 2026-06-06): em dashes (U+2014)
 * and en dashes (U+2013) are forbidden in source, bin entries, and docs.
 * They are AI-tells and damage the trust impression for outside readers
 * of this public repo.
 *
 * This test scans the same surfaces a coder browsing the repo would see.
 * Per feedback_drift_prevention_mandatory.md, every fix ships the guard
 * that prevents recurrence in the same commit.
 *
 * If a future change needs an em or en dash in a string literal that
 * models third-party content verbatim (the way site-monitor stores
 * entity-encoded HTML fixtures from efileforme.com), suppress the file
 * via an explicit allowlist entry below and document the reason inline.
 * Do not relax the rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SCAN_ROOTS = ["src", "bin"];
const DOC_FILES = ["README.md", "CHANGELOG.md", "AGENTS.md", "CLAUDE.md", "llms.txt"];

/**
 * Verbatim third-party content allowed to keep its em or en dash.
 * Empty by default. Add entries as `{ file, reason }` only when the
 * string must match external production content character-for-character.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [];

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (/\.(ts|tsx|mjs|js|jsx|md|txt)$/.test(entry.name)) {
      out.push(abs);
    }
  }
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (fs.existsSync(abs)) walk(abs, files);
  }
  for (const doc of DOC_FILES) {
    const abs = path.join(REPO_ROOT, doc);
    if (fs.existsSync(abs)) files.push(abs);
  }
  return files;
}

test("no em or en dashes in src, bin, or top-level docs", () => {
  const offenders: Array<{ file: string; line: number; text: string }> = [];
  for (const abs of collectFiles()) {
    const rel = path.relative(REPO_ROOT, abs);
    if (rel === path.relative(REPO_ROOT, fileURLToPath(import.meta.url))) {
      continue;
    }
    if (ALLOWLIST.some((entry) => entry.file === rel)) continue;
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    lines.forEach((text, idx) => {
      if (/—|–/.test(text)) {
        offenders.push({ file: rel, line: idx + 1, text: text.trim().slice(0, 120) });
      }
    });
  }

  if (offenders.length > 0) {
    const summary = offenders
      .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
      .join("\n");
    assert.fail(
      `Forbidden em/en dash characters found in ${offenders.length} location(s).\n` +
        `Replace U+2014 (em) and U+2013 (en) with commas, periods, parentheses, ` +
        `or sentence breaks. Rule source: feedback_no_long_dashes (2026-06-06).\n\n` +
        summary,
    );
  }
});
