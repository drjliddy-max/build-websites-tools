/*
 * gate-snapshot: merge per-gate fragments into one build snapshot.
 *
 * This is NOT a gate: it does not evaluate a site and it does not decide
 * whether a site is shippable. It DOES exit nonzero when it was asked to
 * produce evidence and could not, because an evidence tool that fails silently
 * is worse than no evidence tool.
 *
 * EXIT CONTRACT
 *
 *   0  not authorized (inert, documented default) or a snapshot was written
 *   1  armed, but the snapshot could not be produced or validated:
 *      invalid configuration, non-repository invocation, confinement failure,
 *      final schema validation failure, atomic write failure, internal error
 *
 * The previous implementation caught every failure and always exited 0, so an
 * armed build could silently produce nothing. Review flagged it; it is fixed.
 *
 * WHY IT IS SEPARATE FROM THE GATES
 *
 * Every gate runs as an isolated child process (bin/_run.mjs spawns tsx), so no
 * gate can see another's results. Fragments are the only aggregation channel.
 *
 * WHY IT MUST BE INVOKED IN AN ALWAYS-RUN STEP
 *
 * `gate:all` chains with `&&`, so a failing gate stops the chain - correct, but
 * it means a merger at the end never runs on exactly the builds whose state is
 * most worth recording. Consumers invoke `gate:snapshot` in a step that runs
 * regardless (CI `if: always()`). A gate with no fragment is recorded as
 * `not_run`, never as absent-meaning-fine and never as a pass.
 *
 * CONCURRENCY POLICY (Phase 1): last validated writer wins.
 * Each merger writes a uniquely-named temp file in the final directory and
 * atomically renames it over snapshot.json. Two concurrent mergers therefore
 * both succeed and the later rename wins; no reader can observe truncated or
 * mixed JSON, because a reader either sees the old inode or the new one. No
 * lock is taken: a lock adds a stale-lock failure mode to a tool whose entire
 * job is to not disturb the build.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  authorize,
  acquireMergeLock,
  resolveArtifactRoot,
  fragmentsDir,
  writeConfinedFile,
  isSafeGateName,
  sanitizeValue,
  toolsVersion,
  KNOWN_GATES,
  SNAPSHOT_ENABLED_ENV,
  type Fragment,
} from "./snapshot";
import {
  validateFragment,
  validateAgainstSchema,
  validateSnapshotSemantics,
  type ValidationError,
} from "./snapshot-validate";

export const SCHEMA_VERSION = 1;

/**
 * `skipped` is distinct from every other state. A gate that a site declared as
 * skipped exits 0 having measured nothing; recording that as `pass` asserts a
 * verification that never happened. `not_run` means no fragment existed at all.
 */
export type GateOutcome = "pass" | "fail" | "error" | "not_run" | "skipped";

export type Environment =
  | "production"
  | "preview"
  | "development"
  | "local"
  | "unknown";

/**
 * Byte-order comparator.
 *
 * NOT localeCompare. snapshotId and gateConfigHash are content addresses, so
 * their stability depends on the canonical JSON being byte-identical on every
 * machine. localeCompare sorts by the runtime's active locale and ICU data, so
 * a small-icu build or a different LANG can order the same list differently and
 * change the hash for an identical build - which would make an ingestion
 * endpoint treat a re-POST as a new snapshot instead of a no-op.
 */
export function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function classifyEnvironment(env: NodeJS.ProcessEnv): Environment {
  const vercel = env.VERCEL_ENV;
  if (vercel === "production") return "production";
  if (vercel === "preview") return "preview";
  if (vercel === "development") return "development";
  if (vercel) return "unknown";
  if (env.CI === "true" || env.CI === "1") return "development";
  if (env.CI === undefined) return "local";
  return "unknown";
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000, // bounded: a stalled git must not stall the build step
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Build identity from explicitly-named environment variables only.
 * process.env is never iterated: an allowlist cannot leak a credential, a
 * filtered dump eventually will. A field that cannot be established is null;
 * nothing is inferred or invented, because a fabricated commit SHA would make
 * the whole artifact untrustworthy.
 */
export function resolveBuildIdentity(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
) {
  const commitSha = env.VERCEL_GIT_COMMIT_SHA ?? gitOrNull(["rev-parse", "HEAD"], cwd);
  const branch =
    env.VERCEL_GIT_COMMIT_REF ?? gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return {
    commitSha: commitSha ?? null,
    branch: branch ?? null,
    buildId: env.VERCEL_DEPLOYMENT_ID ?? null,
    environment: classifyEnvironment(env),
    ci: env.CI === "true" || env.CI === "1",
  };
}

/**
 * Hash the measurement SCOPE, not the measurement. Excludes timestamps,
 * absolute paths and the package version: none alter scope, and including them
 * would change the hash every run, destroying its only job.
 */
export function computeConfigHash(input: {
  routes: string[];
  expectedGates: string[];
  productionSeo?: unknown;
  sitemap?: unknown;
  aiInstrumentation?: unknown;
  allowedOffSitemapRoutes?: string[];
}): string {
  const canonical = JSON.stringify({
    routes: [...input.routes].sort(byCodepoint),
    expectedGates: [...input.expectedGates].sort(byCodepoint),
    productionSeo: input.productionSeo ?? null,
    sitemap: input.sitemap ?? null,
    aiInstrumentation: input.aiInstrumentation ?? null,
    allowedOffSitemapRoutes: [...(input.allowedOffSitemapRoutes ?? [])].sort(byCodepoint),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function expectedGatesFromScripts(scripts: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(scripts)) {
    if (!key.startsWith("gate:")) continue;
    const name = key.slice("gate:".length);
    if (name === "all" || name === "snapshot") continue;
    const candidate = `gate-${name}`;
    if (isSafeGateName(candidate)) out.add(candidate);
  }
  return [...out].sort(byCodepoint);
}

export type MergedGate = {
  outcome: GateOutcome;
  startedAt?: string;
  finishedAt?: string;
  provenance?: Record<string, unknown>;
  checks?: Array<{ name: string; pass: boolean; detail: string }>;
  malformed?: true;
  reason?: string;
};

export type ParsedFragment =
  | { kind: "valid"; fragment: Fragment }
  | { kind: "malformed"; reason: string };

export type MergeResult = {
  gates: Record<string, MergedGate>;
  gatesRun: string[];
  gatesNotRun: string[];
  malformed: string[];
  unknown: string[];
  skipped: string[];
};

/**
 * Merge fragments against the expected gate list.
 *
 * Unknown-gate policy (explicit, Phase 1): a fragment whose gate is not in
 * KNOWN_GATES is recorded and forces `partial`. Phase 1 is NOT forward
 * compatible with gates it does not know, because silently accepting an
 * unrecognized gate would let a future or hostile writer inject evidence this
 * version cannot interpret.
 */
export function mergeFragments(
  expectedGates: string[],
  fragments: Map<string, ParsedFragment>,
): MergeResult {
  const gates: Record<string, MergedGate> = {};
  const gatesRun: string[] = [];
  const gatesNotRun: string[] = [];
  const malformed: string[] = [];
  const unknown: string[] = [];
  const skipped: string[] = [];

  for (const gate of expectedGates) {
    const frag = fragments.get(gate);
    if (!frag) {
      gates[gate] = {
        outcome: "not_run",
        reason: "no fragment written for this gate in this build",
      };
      gatesNotRun.push(gate);
      continue;
    }
    if (frag.kind === "malformed") {
      gates[gate] = { outcome: "error", malformed: true, reason: frag.reason };
      malformed.push(gate);
      gatesRun.push(gate);
      continue;
    }
    gates[gate] = {
      outcome: frag.fragment.outcome,
      startedAt: frag.fragment.startedAt,
      finishedAt: frag.fragment.finishedAt,
      provenance: frag.fragment.provenance,
      checks: frag.fragment.checks,
    };
    if (frag.fragment.outcome === "skipped") skipped.push(gate);
    gatesRun.push(gate);
  }

  for (const [gate, frag] of fragments) {
    if (gates[gate]) continue;
    unknown.push(gate);
    if (frag.kind === "malformed") {
      gates[gate] = { outcome: "error", malformed: true, reason: frag.reason };
      malformed.push(gate);
    } else {
      gates[gate] = {
        outcome: frag.fragment.outcome,
        startedAt: frag.fragment.startedAt,
        finishedAt: frag.fragment.finishedAt,
        provenance: frag.fragment.provenance,
        checks: frag.fragment.checks,
        reason: "fragment present for a gate this site does not declare",
      };
    }
    gatesRun.push(gate);
  }

  return {
    gates,
    gatesRun: gatesRun.sort(byCodepoint),
    gatesNotRun: gatesNotRun.sort(byCodepoint),
    malformed: malformed.sort(byCodepoint),
    unknown: unknown.sort(byCodepoint),
    skipped: skipped.sort(byCodepoint),
  };
}

export type Completeness = {
  status: "complete" | "partial" | "error";
  gatesExpected: string[];
  gatesRun: string[];
  gatesNotRun: string[];
  malformed: string[];
  unknown: string[];
  skipped: string[];
  reason: string | null;
};

/**
 * The completeness contract, stated mechanically.
 *
 * `complete` requires ALL of:
 *   - configuration valid (package.json + gate.config.json readable)
 *   - build identity available (a commit sha resolved)
 *   - the expected-gate set is NON-EMPTY
 *   - every expected gate has exactly one VALID fragment
 *   - no gate is not_run, no fragment malformed, no unknown gate
 *   - no internal merger error
 *
 * A gate outcome of `fail` is compatible with `complete`: completeness
 * describes EVIDENCE COVERAGE, not success. A site whose SEO gate failed still
 * produced complete evidence about that failure.
 *
 * The previous implementation returned `complete` for zero expected gates and
 * zero fragments, with a `reason` that contradicted the status. Both are fixed:
 * an empty expected set can never be complete, and `reason` is null if and only
 * if the status is `complete`.
 */
export function computeCompleteness(input: {
  configValid: boolean;
  configReason?: string;
  buildIdentityAvailable: boolean;
  expectedGates: string[];
  merge: MergeResult;
  internalError?: string;
}): Completeness {
  const base = {
    gatesExpected: input.expectedGates,
    gatesRun: input.merge.gatesRun,
    gatesNotRun: input.merge.gatesNotRun,
    malformed: input.merge.malformed,
    unknown: input.merge.unknown,
    skipped: input.merge.skipped,
  };

  if (input.internalError) {
    return { ...base, status: "error", reason: `internal error: ${input.internalError}` };
  }
  if (!input.configValid) {
    return {
      ...base,
      status: "error",
      reason: input.configReason ?? "consumer configuration is missing or invalid",
    };
  }

  const reasons: string[] = [];
  if (!input.buildIdentityAvailable) {
    reasons.push("build identity unavailable (no commit sha could be resolved)");
  }
  if (input.expectedGates.length === 0) {
    reasons.push(
      "no expected gates: this site declares no gate:* scripts, so there is no evidence set to be complete about",
    );
  }
  if (input.merge.gatesRun.length === 0) {
    reasons.push("no fragments found: gates did not run, or snapshots were not enabled while they ran");
  }
  if (input.merge.gatesNotRun.length > 0) {
    reasons.push(`gates did not run: ${input.merge.gatesNotRun.join(", ")}`);
  }
  if (input.merge.malformed.length > 0) {
    reasons.push(`malformed fragment(s): ${input.merge.malformed.join(", ")}`);
  }
  if (input.merge.unknown.length > 0) {
    reasons.push(`fragment(s) for undeclared gate(s): ${input.merge.unknown.join(", ")}`);
  }
  // A skipped gate measured nothing, so the evidence set has a hole even
  // though the gate exited 0. It can never be part of a complete snapshot.
  if (input.merge.skipped.length > 0) {
    reasons.push(`gate(s) skipped by configuration, so nothing was measured for them: ${input.merge.skipped.join(", ")}`);
  }

  if (reasons.length > 0) {
    return { ...base, status: "partial", reason: reasons.join("; ") };
  }
  // reason is null if and only if status is complete.
  return { ...base, status: "complete", reason: null };
}

export function summarize(gates: Record<string, MergedGate>) {
  let checksTotal = 0;
  let checksPassed = 0;
  let checksFailed = 0;
  for (const g of Object.values(gates)) {
    for (const c of g.checks ?? []) {
      checksTotal += 1;
      if (c.pass) checksPassed += 1;
      else checksFailed += 1;
    }
  }
  const adaProv = (gates["gate-ada"]?.provenance ?? {}) as Record<string, unknown>;
  const scanMode = typeof adaProv.scanMode === "string" ? adaProv.scanMode : null;
  const gatesSkipped = Object.values(gates).filter((g) => g.outcome === "skipped").length;
  return {
    checksTotal,
    checksPassed,
    checksFailed,
    gatesSkipped,
    axeViolationsBlocking:
      typeof adaProv.violationsBlocking === "number" ? adaProv.violationsBlocking : null,
    axeViolationsMinor:
      typeof adaProv.violationsMinor === "number" ? adaProv.violationsMinor : null,
    comparability: {
      adaScanMode: scanMode,
      colorContrastEvaluated:
        typeof adaProv.colorContrastEvaluated === "boolean"
          ? adaProv.colorContrastEvaluated
          : null,
      note: "Axe counts are comparable ONLY against snapshots with the same adaScanMode and environment. html-snapshot mode does not evaluate color-contrast.",
    },
  };
}

/**
 * Content-addressed snapshot identity.
 *
 * Excludes capturedAt so two merges of the same build are identical and an
 * ingestion endpoint can treat a re-POST as a no-op.
 *
 * INCLUDES each check's `detail`. Review noted the earlier version hashed only
 * [name, pass] while the schema described the address as covering check
 * results: two builds differing only in detail text collided, so a re-POST
 * would have kept the older detail and discarded the newer. Detail is evidence,
 * so it belongs in the address.
 */
export function computeSnapshotId(parts: {
  domain: string | null;
  commitSha: string | null;
  buildId: string | null;
  environment: string;
  gateConfigHash: string;
  gates: Record<string, MergedGate>;
}): string {
  const canonical = JSON.stringify({
    domain: parts.domain,
    commitSha: parts.commitSha,
    buildId: parts.buildId,
    environment: parts.environment,
    gateConfigHash: parts.gateConfigHash,
    gates: Object.keys(parts.gates)
      .sort(byCodepoint)
      .map((k) => ({
        gate: k,
        outcome: parts.gates[k].outcome,
        checks: (parts.gates[k].checks ?? []).map((c) => [c.name, c.pass, c.detail]),
      })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export type ComparabilityVerdict =
  | { comparable: true }
  | { comparable: false; reason: string; code: "NOT_COMPARABLE" };

type ComparableSnapshot = {
  schemaVersion: number;
  build: { environment: string };
  summary: { comparability: { adaScanMode: string | null } };
  site: { gateConfigHash: string; routeCount?: number };
};

export function assertComparable(a: ComparableSnapshot, b: ComparableSnapshot): ComparabilityVerdict {
  if (a.schemaVersion !== b.schemaVersion) {
    return {
      comparable: false,
      code: "NOT_COMPARABLE",
      reason: `schema version differs (${a.schemaVersion} vs ${b.schemaVersion})`,
    };
  }
  if (a.build.environment !== b.build.environment) {
    return {
      comparable: false,
      code: "NOT_COMPARABLE",
      reason: `environment differs (${a.build.environment} vs ${b.build.environment}); a local or preview measurement is not production evidence`,
    };
  }
  const am = a.summary.comparability.adaScanMode;
  const bm = b.summary.comparability.adaScanMode;
  if (am && bm && am !== bm) {
    return {
      comparable: false,
      code: "NOT_COMPARABLE",
      reason: `ada scanMode differs (${am} vs ${bm}); html-snapshot does not evaluate color-contrast, so violation counts are not like-for-like`,
    };
  }
  return { comparable: true };
}

export function detectScopeDrift(
  a: { site: { gateConfigHash: string; routeCount: number } },
  b: { site: { gateConfigHash: string; routeCount: number } },
): { drifted: boolean; reason?: string } {
  if (a.site.gateConfigHash !== b.site.gateConfigHash) {
    return {
      drifted: true,
      reason: `gate configuration changed (routeCount ${a.site.routeCount} -> ${b.site.routeCount}); totals moved for scope reasons, not necessarily quality`,
    };
  }
  return { drifted: false };
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Load the shipped schema. Uses createRequire, never new URL().pathname. */
export function loadSnapshotSchema(): Record<string, unknown> {
  const require = createRequire(import.meta.url);
  return require("../schema/build-snapshot-v1.schema.json") as Record<string, unknown>;
}

/**
 * Validate a final snapshot against the shipped schema.
 *
 * Extracted so the "a schema-invalid document must never replace a previously
 * valid snapshot.json" rule is directly testable. Inlining it left the rule
 * unprovable: a mutation that bypassed validation escaped the whole suite.
 */
export function validateSnapshotDocument(
  snapshot: unknown,
  schema: Record<string, unknown>,
): { valid: true } | { valid: false; errors: ValidationError[] } {
  // Layer 1: structural, against the shipped JSON Schema.
  const structural = validateAgainstSchema(snapshot, schema);
  if (!structural.valid) return structural;
  // Layer 2: cross-field truth JSON Schema cannot express (complete implies a
  // null reason, summary counts match the gate entries, skipped blocks
  // complete, and so on). Promised in schema prose, enforced only here.
  return validateSnapshotSemantics(snapshot);
}

export type BuildOutcome =
  | { ok: true; snapshot: Record<string, unknown> }
  | { ok: false; reason: string; errors?: ValidationError[] };

export function buildSnapshot(cwd: string, artifactRoot: string): BuildOutcome {
  let configValid = true;
  let configReason: string | undefined;

  const pkgRead = readJson(path.join(cwd, "package.json"));
  if (!pkgRead.ok) {
    configValid = false;
    configReason = `package.json missing or invalid: ${pkgRead.reason}`;
  }
  const pkg = (pkgRead.ok ? pkgRead.value : {}) as { name?: string; scripts?: Record<string, string> };

  const cfgPath = path.join(cwd, "gate.config.json");
  let gateConfig: Record<string, any> = {};
  if (existsSync(cfgPath)) {
    const cfgRead = readJson(cfgPath);
    if (!cfgRead.ok) {
      configValid = false;
      configReason = `gate.config.json invalid: ${cfgRead.reason}`;
    } else if (cfgRead.value === null || typeof cfgRead.value !== "object" || Array.isArray(cfgRead.value)) {
      configValid = false;
      configReason = "gate.config.json is not an object";
    } else {
      gateConfig = cfgRead.value as Record<string, any>;
    }
  } else {
    configValid = false;
    configReason = "gate.config.json not found: this does not look like a gated consumer site";
  }

  const scripts = pkg.scripts ?? {};
  const expectedGates = expectedGatesFromScripts(scripts);
  const routes: string[] = Array.isArray(gateConfig.routes) ? gateConfig.routes : [];

  // Read and VALIDATE fragments. A parse failure and a shape failure both land
  // in the same malformed path, so neither can be counted as gate evidence.
  const fragments = new Map<string, ParsedFragment>();
  const fragDir = fragmentsDir(artifactRoot);
  if (existsSync(fragDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(fragDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      if (entry.startsWith(".")) continue; // ignore in-flight temp files
      const gate = entry.slice(0, -".json".length);
      const parsed = readJson(path.join(fragDir, entry));
      if (!parsed.ok) {
        fragments.set(gate, { kind: "malformed", reason: `not valid JSON: ${parsed.reason}` });
        continue;
      }
      const check = validateFragment(parsed.value, isSafeGateName);
      if (!check.valid) {
        fragments.set(gate, {
          kind: "malformed",
          reason: `fragment failed validation: ${check.errors
            .map((e) => `${e.path || "<root>"} ${e.message}`)
            .join("; ")}`,
        });
        continue;
      }
      const fragment = parsed.value as Fragment;
      if (fragment.gate !== gate) {
        fragments.set(gate, {
          kind: "malformed",
          reason: `fragment declares gate ${JSON.stringify(fragment.gate)} but is stored as ${entry}`,
        });
        continue;
      }
      fragments.set(gate, { kind: "valid", fragment });
    }
  }

  const merge = mergeFragments(expectedGates, fragments);
  const identity = resolveBuildIdentity(process.env, cwd);
  const gateConfigHash = computeConfigHash({
    routes,
    expectedGates,
    productionSeo: gateConfig.productionSeo,
    sitemap: gateConfig.sitemap,
    aiInstrumentation: gateConfig.aiInstrumentation,
    allowedOffSitemapRoutes: gateConfig.allowedOffSitemapRoutes,
  });

  let domain: string | null = null;
  try {
    domain = typeof gateConfig.baseUrl === "string" ? new URL(gateConfig.baseUrl).hostname : null;
  } catch {
    domain = null;
  }

  const completeness = computeCompleteness({
    configValid,
    configReason,
    buildIdentityAvailable: identity.commitSha !== null,
    expectedGates,
    merge,
  });

  const snapshot: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: "",
    site: {
      domain,
      repo: pkg.name ?? path.basename(cwd),
      routeCount: routes.length,
      gateConfigHash,
    },
    build: {
      capturedAt: new Date().toISOString(),
      commitSha: identity.commitSha,
      branch: identity.branch,
      buildId: identity.buildId,
      environment: identity.environment,
      baseUrl: typeof gateConfig.baseUrl === "string" ? gateConfig.baseUrl : null,
      toolsVersion: toolsVersion(),
      ci: identity.ci,
    },
    completeness,
    gates: merge.gates,
    summary: summarize(merge.gates),
  };

  snapshot.snapshotId = computeSnapshotId({
    domain,
    commitSha: identity.commitSha,
    buildId: identity.buildId,
    environment: identity.environment,
    gateConfigHash,
    gates: merge.gates,
  });

  return { ok: true, snapshot: sanitizeValue(snapshot) as Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export type CliResult = { code: 0 | 1; stderr: string[] };

/**
 * `loadSchema` is injectable so a test can supply a contract the generated
 * document cannot satisfy, and prove that runCli REFUSES to replace a valid
 * snapshot.json when final validation fails. Without this seam that rule was
 * unprovable: buildSnapshot never produces an invalid document by design, so a
 * mutation that bypassed the check escaped the entire suite.
 *
 * This injects the CONTRACT, not the filesystem: every write still goes through
 * the real confinement boundary.
 */
export function runCli(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  opts: { loadSchema?: () => Record<string, unknown> } = {},
): CliResult {
  const stderr: string[] = [];
  const auth = authorize(env);

  if (!auth.armed) {
    if (auth.invalidConfig) {
      stderr.push(`gate:snapshot  ${auth.reason}`);
      return { code: 1, stderr }; // asked for incorrectly -> fail closed, loudly
    }
    return { code: 0, stderr }; // not asked for -> inert, silent, documented default
  }

  const resolved = resolveArtifactRoot(cwd);
  if (!resolved.ok) {
    stderr.push(`gate:snapshot  ${resolved.reason}`);
    return { code: 1, stderr };
  }

  const lock = acquireMergeLock(resolved.artifactRoot);
  if (!lock.ok) {
    // Serialized rather than "last validated writer wins": atomic rename
    // protects bytes but not ORDER, so a slower merger reading older fragments
    // could otherwise overwrite newer evidence.
    stderr.push(`gate:snapshot  ${lock.reason}`);
    return { code: 1, stderr };
  }

  try {
    return runMerge(cwd, resolved, opts, stderr);
  } finally {
    lock.release();
  }
}

function runMerge(
  cwd: string,
  resolved: { artifactRoot: string; repoRoot: string },
  opts: { loadSchema?: () => Record<string, unknown> },
  stderr: string[],
): CliResult {
  let built: BuildOutcome;
  try {
    built = buildSnapshot(cwd, resolved.artifactRoot);
  } catch (err) {
    stderr.push(`gate:snapshot  internal error: ${(err as Error).message}`);
    return { code: 1, stderr };
  }
  if (!built.ok) {
    stderr.push(`gate:snapshot  ${built.reason}`);
    return { code: 1, stderr };
  }

  // Validate the FINAL document against the shipped schema BEFORE replacing a
  // previously valid snapshot. A schema-invalid document must never overwrite a
  // valid one.
  let schema: Record<string, unknown>;
  try {
    schema = (opts.loadSchema ?? loadSnapshotSchema)();
  } catch (err) {
    stderr.push(`gate:snapshot  could not load the shipped schema: ${(err as Error).message}`);
    return { code: 1, stderr };
  }
  const validation = validateSnapshotDocument(built.snapshot, schema);
  if (!validation.valid) {
    stderr.push(
      `gate:snapshot  generated snapshot failed schema validation; the previous snapshot.json was left untouched:`,
    );
    for (const e of validation.errors.slice(0, 10)) {
      stderr.push(`  ${e.path || "<root>"}: ${e.message}`);
    }
    return { code: 1, stderr };
  }

  const write = writeConfinedFile(
    resolved.artifactRoot,
    resolved.repoRoot,
    "snapshot.json",
    `${JSON.stringify(built.snapshot, null, 2)}\n`,
  );
  if (!write.ok) {
    stderr.push(`gate:snapshot  could not write snapshot: ${write.reason}`);
    return { code: 1, stderr };
  }

  const completeness = built.snapshot.completeness as Completeness;
  if (completeness.status !== "complete") {
    // Loud, but not fatal: a partial record is still valid evidence, and the
    // reason it is partial is usually a gate failure the build already
    // reported. Only an inability to PRODUCE evidence is exit 1.
    stderr.push(`gate:snapshot  ${completeness.status.toUpperCase()} - ${completeness.reason}`);
  }
  return { code: 0, stderr };
}

const require_ = createRequire(import.meta.url);
const invokedDirectly = (() => {
  try {
    // fileURLToPath, NOT new URL().pathname: pathname is percent-encoded and
    // returns /C:/... on Windows, so the comparison silently never matched and
    // main() never ran - the worst failure for an evidence artifact.
    const { fileURLToPath } = require_("node:url") as typeof import("node:url");
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const result = runCli();
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exit(result.code);
}

export { KNOWN_GATES, SNAPSHOT_ENABLED_ENV };
