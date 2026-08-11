/**
 * Estate-wide blog-writer architecture guard.
 *
 * The guard this replaces lived in `site-monitor/scripts/guards/` and scanned
 * `site-monitor/src/` for function-name patterns like `runAdaBlogWriter`. It
 * could not see the seven consumer repositories, which is the only place the
 * divergence it claimed to prevent ever existed. It passed for months while
 * seven byte-distinct orchestrators ran in production.
 *
 * A cross-repository invariant cannot be enforced by a scanner that sees one
 * repository. This one takes a manifest of participants and inspects each
 * repository's governed source directly.
 *
 * WHAT IT ENFORCES
 *
 * A registered site must pin an approved canonical release, carry a site
 * config, and route through the canonical package. It must NOT carry its own
 * cadence authority, generator, proof writer, or publication orchestrator,
 * because those are exactly the seven-way forks this programme removed.
 */

/** Signatures of orchestration that must not exist in a consumer entrypoint. */
export const FORBIDDEN_SIGNATURES = [
  { code: "local-cadence-authority", pattern: /SCHEDULER_WEEKDAYS|buildScheduledDates\s*\(|PUBLICATION_INTERVAL_DAYS\s*=/, why: "cadence is canonical" },
  { code: "local-generator", pattern: /\bbuildPrompt\s*\(|api\/generate|anthropic\.com\/v1\/messages['"]?\s*,?\s*\{/, why: "generation is canonical" },
  { code: "local-proof-writer", pattern: /proofVersion\s*:/, why: "the proof schema is canonical" },
  { code: "local-publication-orchestrator", pattern: /stageAndCommit\s*\(|queue\.splice\s*\(|\bgit\(\s*\[\s*["']commit/, why: "publication is canonical" },
  { code: "local-queue-policy", pattern: /selectQueuedPost\s*\(|filter\(\s*\(?\w+\)?\s*=>\s*\w+\.target_date\s*===/, why: "queue policy is canonical" },
  { code: "local-validation", pattern: /validate[A-Z]\w*Draft\s*\(/, why: "validation is canonical" },
];

export const REQUIRED_SIGNATURES = [
  { code: "canonical-import", pattern: /from\s+["']build-websites-tools\/blog-writer["']/, why: "must route through the canonical package" },
  { code: "canonical-invocation", pattern: /runBlogWriterPipeline\s*\(/, why: "must invoke the canonical pipeline" },
];

/**
 * Check one participant.
 *
 * `read(path)` returns file contents from the repository's GOVERNED source
 * (origin/main), not a working tree. A guard that trusts a local working tree
 * can be satisfied by uncommitted edits.
 */
export function checkParticipant(participant, read, { approvedPins, canonicalEntrypoint = null }) {
  const failures = [];
  const laneDir = `.siteclinic/automation/${participant.laneKey}`;

  // ── pin ──────────────────────────────────────────────────────────────────
  const pkgRaw = read("package.json");
  if (!pkgRaw) {
    failures.push({ code: "no-package-json", message: "package.json unreadable" });
  } else {
    const pkg = JSON.parse(pkgRaw);
    const spec =
      pkg.devDependencies?.["build-websites-tools"] ??
      pkg.dependencies?.["build-websites-tools"] ??
      null;
    if (!spec) {
      failures.push({ code: "missing-canonical-dependency", message: "build-websites-tools is not a dependency" });
    } else {
      const pin = spec.split("#").pop();
      if (!approvedPins.includes(pin)) {
        failures.push({
          code: "unapproved-pin",
          message: `pinned to ${pin}; approved: ${approvedPins.join(", ")}`,
        });
      }
    }
  }

  // ── site config ──────────────────────────────────────────────────────────
  const configRaw = read(`${laneDir}/site.config.json`);
  if (!configRaw) {
    failures.push({ code: "missing-site-config", message: `${laneDir}/site.config.json is absent` });
  } else {
    const config = JSON.parse(configRaw);
    if (config.configVersion !== 1) {
      failures.push({ code: "invalid-config-version", message: `configVersion ${config.configVersion} is not supported` });
    }
    if (config.laneKey !== participant.laneKey) {
      failures.push({ code: "config-lane-mismatch", message: `config declares ${config.laneKey}` });
    }
  }

  // ── entrypoint ───────────────────────────────────────────────────────────
  const entry = read(`${laneDir}/runWorkflow.mjs`);
  if (!entry) {
    failures.push({ code: "missing-entrypoint", message: `${laneDir}/runWorkflow.mjs is absent` });
    return { siteId: participant.siteId, ok: failures.length === 0, failures };
  }
  // BYTE IDENTITY against the canonical reference (added with the FND-0003 repair). The
  // 2026-08-09 audit found seven byte-distinct orchestrators that had all passed a
  // signature-style guard for months; signatures prove presence of shapes, identity proves
  // absence of divergence. Comparison is exact: an entrypoint is data stamped from the
  // canonical reference, so any local difference, even a comment, is drift to surface.
  if (canonicalEntrypoint !== null && entry !== canonicalEntrypoint) {
    failures.push({
      code: "entrypoint-drift",
      message: "runWorkflow.mjs differs from the canonical reference (contracts/blog-writer-entrypoint/runWorkflow.mjs); restamp it, do not hand-edit",
    });
  }

  // Comments describe what was removed; they must not count as the thing itself.
  const code = entry
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  for (const rule of REQUIRED_SIGNATURES) {
    if (!rule.pattern.test(code)) {
      failures.push({ code: `missing-${rule.code}`, message: rule.why });
    }
  }
  for (const rule of FORBIDDEN_SIGNATURES) {
    if (rule.pattern.test(code)) {
      failures.push({ code: rule.code, message: `${rule.why}; found local implementation` });
    }
  }

  return { siteId: participant.siteId, ok: failures.length === 0, failures };
}

/** Run the guard across every participant in the manifest. */
export function checkEstate({ manifest, readerFor, canonicalEntrypoint = null }) {
  const results = manifest.participants.map((participant) =>
    checkParticipant(participant, readerFor(participant), { approvedPins: manifest.approvedPins, canonicalEntrypoint }),
  );
  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    participants: results.length,
    canonicalConsumers: results.filter((r) => r.ok).length,
    results,
    summary: failed.length === 0
      ? `${results.length}/${results.length} participants canonical`
      : `${failed.length}/${results.length} participants FAILED: ${failed.map((f) => f.siteId).join(", ")}`,
  };
}
