#!/usr/bin/env node
/**
 * Estate-wide blog-writer architecture gate.
 *
 * Reads each participant's GOVERNED source (origin/main) via git, not a working
 * tree, because uncommitted edits must not be able to satisfy a governance gate.
 *
 *   node bin/gate-blog-canonical.mjs --root /path/to/Projects [--ref origin/main]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkEstate } from "../src/blog-writer/estateGuard.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const root = args.root ?? process.cwd();
const ref = args.ref ?? "origin/main";
const manifestPath = args.manifest
  ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../contracts/blog-writer-participants.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const readerFor = (participant) => (filePath) => {
  try {
    return execFileSync("git", ["-C", path.join(root, participant.repo), "show", `${ref}:${filePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};

const report = checkEstate({ manifest, readerFor });
for (const result of report.results) {
  if (result.ok) {
    process.stdout.write(`  PASS  ${result.siteId}\n`);
  } else {
    process.stdout.write(`  FAIL  ${result.siteId}\n`);
    for (const failure of result.failures) {
      process.stdout.write(`          ${failure.code}: ${failure.message}\n`);
    }
  }
}
process.stdout.write(`\n${report.summary}\n`);
if (!report.ok) process.exitCode = 1;
