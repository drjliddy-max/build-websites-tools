/*
 * gate-snapshot: merge per-gate fragments into one build snapshot.
 *
 * This is NOT a gate. It never fails a build and always exits 0. It reads the
 * fragments written by the gates during this build, adds build identity, and
 * writes a single machine-readable document.
 *
 * WHY IT IS SEPARATE FROM THE GATES
 *
 * Every gate runs as an isolated child process (bin/_run.mjs spawns tsx), so
 * no gate can see another gate's results. Fragments are the only way to
 * aggregate. This binary is the merge step.
 *
 * WHY IT MUST BE INVOKED IN AN ALWAYS-RUN STEP
 *
 * `gate:all` chains with `&&` so a failing gate stops the chain - which is
 * correct, a failed gate must stop a deploy. But it also means a merger placed
 * at the end of that chain never runs on exactly the builds whose state is most
 * worth recording. Consumers should invoke `gate:snapshot` in a step that runs
 * regardless of the chain's exit status (CI `if: always()`, or a separate
 * command). The merger is built for that: a gate with no fragment is recorded
 * as `not_run`, never as absent-meaning-fine and never as a pass.
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  snapshotDir,
  fragmentsDir,
  isSafeGateName,
  sanitizeValue,
  KNOWN_GATES,
  type Fragment,
} from "./snapshot";

export const SCHEMA_VERSION = 1;

export type GateOutcome = "pass" | "fail" | "error" | "not_run";

export type Environment =
  | "production"
  | "preview"
  | "development"
  | "local"
  | "unknown";

/**
 * Classify the build environment.
 *
 * Vercel is authoritative when present. Otherwise a CI marker without a Vercel
 * env is "development" (some other CI), and no CI marker at all is "local".
 * We never guess "production" from a URL: a developer pointing GATE_BASE_URL at
 * the live site from a laptop is still a local measurement, and mislabelling it
 * would let a laptop run masquerade as production evidence.
 */
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

function gitOrNull(args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Build identity from explicitly-named environment variables only.
 *
 * We never iterate or serialize process.env: an allowlist of six names cannot
 * leak a credential, whereas a filtered dump eventually will.
 * A field we cannot establish is null. Nothing here is inferred or invented -
 * a fabricated commit SHA would make the whole artifact untrustworthy.
 */
export function resolveBuildIdentity(env: NodeJS.ProcessEnv = process.env) {
  const commitSha = env.VERCEL_GIT_COMMIT_SHA ?? gitOrNull(["rev-parse", "HEAD"]);
  const branch =
    env.VERCEL_GIT_COMMIT_REF ?? gitOrNull(["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    commitSha: commitSha ?? null,
    branch: branch ?? null,
    buildId: env.VERCEL_DEPLOYMENT_ID ?? null,
    environment: classifyEnvironment(env),
    ci: env.CI === "true" || env.CI === "1",
  };
}

/**
 * Hash the measurement SCOPE, not the measurement.
 *
 * Included: route inventory, expected gates, and the config keys that change
 * what gets measured. Excluded: timestamps, absolute paths, and the package
 * version - none of those alter scope, and including them would make the hash
 * change on every run, which would destroy its only job (telling a reader
 * whether two snapshots measured the same thing).
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
    routes: [...input.routes].sort((a, b) => a.localeCompare(b)),
    expectedGates: [...input.expectedGates].sort((a, b) => a.localeCompare(b)),
    productionSeo: input.productionSeo ?? null,
    sitemap: input.sitemap ?? null,
    aiInstrumentation: input.aiInstrumentation ?? null,
    allowedOffSitemapRoutes: [...(input.allowedOffSitemapRoutes ?? [])].sort((a, b) =>
      a.localeCompare(b),
    ),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Determine which gates this site is expected to run, from its own package.json
 * scripts. A site that never wired gate:ada should not be reported as having
 * skipped it - the gate is simply not part of that site's contract.
 */
export function expectedGatesFromScripts(scripts: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(scripts)) {
    if (!key.startsWith("gate:")) continue;
    const name = key.slice("gate:".length);
    if (name === "all" || name === "snapshot") continue;
    const candidate = `gate-${name}`;
    if (isSafeGateName(candidate)) out.add(candidate);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
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

export type MergeResult = {
  gates: Record<string, MergedGate>;
  gatesRun: string[];
  gatesNotRun: string[];
  malformed: string[];
};

/**
 * Merge fragments against the expected gate list.
 *
 * A fragment that will not parse is recorded as `error` + `malformed`, never
 * dropped. Silently ignoring it would let a corrupted write produce a snapshot
 * that looks complete.
 */
export function mergeFragments(
  expectedGates: string[],
  fragments: Map<string, Fragment | { malformed: true; reason: string }>,
): MergeResult {
  const gates: Record<string, MergedGate> = {};
  const gatesRun: string[] = [];
  const gatesNotRun: string[] = [];
  const malformed: string[] = [];

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
    if ("malformed" in frag) {
      gates[gate] = { outcome: "error", malformed: true, reason: frag.reason };
      malformed.push(gate);
      gatesRun.push(gate);
      continue;
    }
    gates[gate] = {
      outcome: frag.outcome,
      startedAt: frag.startedAt,
      finishedAt: frag.finishedAt,
      provenance: frag.provenance,
      checks: frag.checks,
    };
    gatesRun.push(gate);
  }

  // A fragment from a gate the site did not declare still gets recorded, so an
  // unexpected run is visible rather than dropped.
  for (const [gate, frag] of fragments) {
    if (gates[gate]) continue;
    if ("malformed" in frag) {
      gates[gate] = { outcome: "error", malformed: true, reason: frag.reason };
      malformed.push(gate);
    } else {
      gates[gate] = {
        outcome: frag.outcome,
        startedAt: frag.startedAt,
        finishedAt: frag.finishedAt,
        provenance: frag.provenance,
        checks: frag.checks,
      };
    }
    gatesRun.push(gate);
  }

  return { gates, gatesRun: gatesRun.sort(), gatesNotRun: gatesNotRun.sort(), malformed };
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
  const ada = gates["gate-ada"];
  const adaProv = (ada?.provenance ?? {}) as Record<string, unknown>;
  return {
    checksTotal,
    checksPassed,
    checksFailed,
    axeViolationsBlocking: (adaProv.violationsBlocking as number) ?? null,
    axeViolationsMinor: (adaProv.violationsMinor as number) ?? null,
    comparability: {
      adaScanMode: (adaProv.scanMode as string) ?? null,
      colorContrastEvaluated: (adaProv.colorContrastEvaluated as boolean) ?? null,
      note:
        "Axe counts are comparable ONLY against snapshots with the same adaScanMode and environment. html-snapshot mode does not evaluate color-contrast.",
    },
  };
}

/**
 * Content-addressed snapshot identity.
 *
 * Deliberately EXCLUDES capturedAt: two merges of the same build must produce
 * the same id so an ingestion endpoint can treat a re-POST as a no-op. Identity
 * is "which build, measured how, with what result", not "when did we merge".
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
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({
        gate: k,
        outcome: parts.gates[k].outcome,
        checks: (parts.gates[k].checks ?? []).map((c) => [c.name, c.pass]),
      })),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export type ComparabilityVerdict =
  | { comparable: true }
  | { comparable: false; reason: string; code: "NOT_COMPARABLE" };

/**
 * Refuse comparisons that would misreport measurement loss as a change.
 * Phase 1 ships the judgement, not a full diff engine.
 */
export function assertComparable(
  a: { schemaVersion: number; build: { environment: string }; summary: { comparability: { adaScanMode: string | null } }; site: { gateConfigHash: string } },
  b: typeof a,
): ComparabilityVerdict {
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

/** Scope drift is reported separately: comparable, but measuring different things. */
export function detectScopeDrift(
  a: { site: { gateConfigHash: string; routeCount: number } },
  b: typeof a,
): { drifted: boolean; reason?: string } {
  if (a.site.gateConfigHash !== b.site.gateConfigHash) {
    return {
      drifted: true,
      reason: `gate configuration changed (routeCount ${a.site.routeCount} -> ${b.site.routeCount}); totals moved for scope reasons, not necessarily quality`,
    };
  }
  return { drifted: false };
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function buildSnapshot(cwd: string, root: string) {
  const pkg = (readJson(path.join(cwd, "package.json")) ?? {}) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  const gateConfig = (readJson(path.join(cwd, "gate.config.json")) ?? {}) as {
    routes?: string[];
    baseUrl?: string;
    productionSeo?: unknown;
    sitemap?: unknown;
    aiInstrumentation?: unknown;
    allowedOffSitemapRoutes?: string[];
  };

  const expectedGates = expectedGatesFromScripts(pkg.scripts ?? {});
  const routes = gateConfig.routes ?? [];

  const fragments = new Map<string, Fragment | { malformed: true; reason: string }>();
  const fragDir = fragmentsDir(root);
  if (existsSync(fragDir)) {
    for (const entry of readdirSync(fragDir)) {
      if (!entry.endsWith(".json")) continue;
      const gate = entry.slice(0, -".json".length);
      if (!isSafeGateName(gate)) continue;
      const parsed = readJson(path.join(fragDir, entry));
      if (parsed === null || typeof parsed !== "object") {
        fragments.set(gate, { malformed: true, reason: "fragment is not valid JSON" });
        continue;
      }
      fragments.set(gate, parsed as Fragment);
    }
  }

  const merged = mergeFragments(expectedGates, fragments);
  const identity = resolveBuildIdentity();
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
    domain = gateConfig.baseUrl ? new URL(gateConfig.baseUrl).hostname : null;
  } catch {
    domain = null;
  }

  const noFragments = fragments.size === 0;
  const status =
    merged.gatesNotRun.length === 0 && merged.malformed.length === 0
      ? "complete"
      : "partial";

  const reasonParts: string[] = [];
  if (noFragments) reasonParts.push("no fragments found: gates did not run, or GATE_SNAPSHOT_DIR was not set while they ran");
  if (merged.gatesNotRun.length > 0) reasonParts.push(`gate chain did not reach: ${merged.gatesNotRun.join(", ")}`);
  if (merged.malformed.length > 0) reasonParts.push(`malformed fragment(s): ${merged.malformed.join(", ")}`);

  const snapshot = {
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
      baseUrl: gateConfig.baseUrl ?? null,
      toolsVersion:
        ((readJson(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "package.json")) as { version?: string } | null)?.version) ?? "unknown",
      ci: identity.ci,
    },
    completeness: {
      status,
      gatesExpected: expectedGates,
      gatesRun: merged.gatesRun,
      gatesNotRun: merged.gatesNotRun,
      malformed: merged.malformed,
      reason: reasonParts.length > 0 ? reasonParts.join("; ") : null,
    },
    gates: merged.gates,
    summary: summarize(merged.gates),
  };

  snapshot.snapshotId = computeSnapshotId({
    domain,
    commitSha: identity.commitSha,
    buildId: identity.buildId,
    environment: identity.environment,
    gateConfigHash,
    gates: merged.gates,
  });

  return sanitizeValue(snapshot) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const root = snapshotDir();
  if (!root) {
    // Inert without the env var. Silent on success per repo doctrine.
    return;
  }
  try {
    const cwd = process.cwd();
    const snapshot = buildSnapshot(cwd, root);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "snapshot.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
    const completeness = (snapshot.completeness as { status: string }).status;
    if (completeness !== "complete") {
      // Loud only when the record is incomplete - a partial snapshot that looks
      // complete is the failure mode worth shouting about.
      const reason = (snapshot.completeness as { reason: string | null }).reason;
      process.stderr.write(`gate:snapshot  PARTIAL - ${reason}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `gate:snapshot  could not write snapshot (build unaffected): ${(err as Error).message}\n`,
    );
  }
}

const invokedDirectly =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  await main();
  // Always 0. This binary observes; it never judges.
  process.exit(0);
}

export { KNOWN_GATES };
