#!/usr/bin/env node
/**
 * THIN CANONICAL ENTRYPOINT.
 *
 * This file used to be a 10.6KB orchestrator: its own queue selection, cadence
 * reasoning, governance validation, schedule mutation, proof schema, git
 * sequence and error classification. Six sibling repositories each had their
 * own byte-distinct copy of the same responsibilities, and no two agreed.
 *
 * All of that now lives in `build-websites-tools/blog-writer`, pinned by
 * immutable tag. What remains here is invocation: identify the site, hand the
 * canonical pipeline its dependencies, map the result to an exit code.
 *
 * DO NOT reintroduce business rules below. Cadence, topic selection,
 * generation, validation, image acquisition, queue policy, publication, proof
 * writing, monitor reporting, retry policy and duplicate prevention are all
 * canonical. The estate guard fails the build if any of them reappear here.
 *
 * Site-specific facts belong in `site.config.json`, which is data.
 */
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildRegistry,
  createDefaultAdapter,
  createDurableReporter,
  createFileSink,
  buildProviderRoute,
  loadGovernedCandidates,
  createLocalProvider,
  createHostedProvider,
  createPexelsProvider,
  createRepoOwnedPublisher,
  runBlogWriterPipeline,
} from "build-websites-tools/blog-writer";

const execFile = promisify(execFileCallback);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(process.env.SITECLINIC_AUTOMATION_SITE_ROOT || path.join(HERE, "../../.."));

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

async function loadKeywordCsv(absolutePath) {
  const text = await fs.readFile(absolutePath, "utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = lines[0].split(",").map((cell) => cell.trim());
  const keywordIndex = header.indexOf("keyword");
  return lines.slice(1).map((line) => {
    const cells = [];
    let current = "";
    let quoted = false;
    for (const char of line) {
      if (char === '"') { quoted = !quoted; continue; }
      if (char === "," && !quoted) { cells.push(current); current = ""; continue; }
      current += char;
    }
    cells.push(current);
    return { keyword: (cells[keywordIndex] ?? "").trim() };
  }).filter((row) => row.keyword);
}

export async function main() {
  const args = parseArgs(process.argv);
  // Publish unless explicitly opted out. This mirrors the legacy contract
  // (pushChanges defaulted true, disabled with --pushChanges false) that the
  // production workflow relies on: it passes neither --mode nor --push, so a
  // dry-run default would have made every governed occurrence generate,
  // validate, acquire an image and publish NOTHING, silently.
  const mode = args.mode ?? (args.pushChanges === "false" || args.dryRun === "true" ? "dry-run" : "publish");
  const occurrence = args.targetDate ?? args.occurrence;
  if (!occurrence) {
    process.stderr.write("--targetDate is required\n");
    process.exitCode = 2;
    return;
  }

  // FND-0003: the dispatcher's identity triple travels INTO the canonical pipeline and out
  // through the durable proof. All-or-nothing is enforced canonically by buildProof; this
  // file only carries what it was given. proofOutputPath is the workflow's correlation
  // channel: the exact file the "Enforce truthful completion" step reads and the uploaded
  // artifact Site Monitor verifies.
  const dispatch = (args.jobKey || args.idempotencyKey || args.correlationId)
    ? {
        jobKey: args.jobKey ?? "",
        idempotencyKey: args.idempotencyKey ?? "",
        correlationId: args.correlationId ?? "",
      }
    : null;
  const proofOutputPath = args.proofOutputPath ?? null;

  const site = JSON.parse(await fs.readFile(path.join(HERE, "site.config.json"), "utf8"));
  const registry = buildRegistry([site]);

  const git = async (argv) => (await execFile("git", argv, { cwd: SITE_ROOT })).stdout;
  const runGate = async () => { await execFile("npm", ["run", "gate:seo"], { cwd: SITE_ROOT }); };

  // Provider and model policy is CANONICAL. This file used to hardcode
  // phi4:14b, which made model selection site-owned even though generation
  // orchestration was centralised, and produced a false "the local model is not
  // capable" conclusion while the capable model sat installed and untried.
  // A site may express a preference in site.config.json generationPolicy;
  // it may not express a route.
  const providers = buildProviderRoute(site, {
    makeLocal: ({ model }) => createLocalProvider({ model }),
    makeHosted: (spec) => createHostedProvider(spec),
  });

  const result = await runBlogWriterPipeline(
    { siteId: site.siteId, occurrence, mode, dispatch },
    {
      registry,
      providers,
      schedule: {
        load: async (registered) =>
          JSON.parse(await fs.readFile(path.join(SITE_ROOT, registered.publication.schedulePath), "utf8")),
      },
      keywords: {
        load: async (registered) => ({
          primary: await loadKeywordCsv(path.join(SITE_ROOT, registered.keywordSource.primary)),
          // Configured supporting keywords first, then candidates derived from
          // this site's own governed service pages. Both are canonical inputs;
          // neither is a site-local algorithm.
          secondary: [
            ...(await loadKeywordCsv(path.join(SITE_ROOT, registered.keywordSource.secondary))),
            ...loadGovernedCandidates(registered, (rel) => {
              try { return readFileSync(path.join(SITE_ROOT, rel), "utf8"); } catch { return null; }
            }),
          ],
        }),
      },
      imageProvider: createPexelsProvider(),
      reporter: createDurableReporter({
        sink: createFileSink({ dir: path.join(HERE, "proofs"), fs, path }),
      }),
      publisher: createRepoOwnedPublisher({
        git,
        fs,
        runGate,
        adapter: createDefaultAdapter(site),
      }),
      verifier: {
        check: async (url) => {
          const response = await fetch(url, { redirect: "follow" });
          return { status: response.status, contentType: response.headers.get("content-type") };
        },
      },
    },
  );

  process.stdout.write(`${JSON.stringify(result.proof ?? result, null, 2)}\n`);

  // FND-0003: every run, success or failure, leaves the proof at the dispatcher's requested
  // path so the workflow's truthful-completion step reads what actually happened and the
  // uploaded artifact carries the correlated identity. Absence of a proof is itself the
  // failure signal that step exists to catch, so nothing here swallows a write error.
  if (proofOutputPath && result.proof) {
    await fs.mkdir(path.dirname(proofOutputPath), { recursive: true });
    await fs.writeFile(proofOutputPath, `${JSON.stringify(result.proof, null, 2)}\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
