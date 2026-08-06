/*
 * gate-snapshot Phase 1 - fragment emission.
 *
 * WHY THIS EXISTS
 *
 * Every gate in this package measures a large number of technical facts per
 * build and then discards all of it at process exit. Only the exit code
 * survives, so no site accumulates a technical baseline. That is not a
 * discipline failure; it is a missing write call. This module is that call.
 *
 * SECURITY CONTRACT (rewritten after the PR #5 blocking review)
 *
 * The first implementation used one environment variable, GATE_SNAPSHOT_DIR,
 * as BOTH the opt-in switch and the caller-chosen destination. Any non-blank
 * value was treated as a directory, so an absolute path or a traversal wrote
 * outside the repository - an arbitrary filesystem write reachable from a
 * public CLI. Fixed by separating the two concerns:
 *
 *   AUTHORIZATION  GATE_SNAPSHOT_ENABLED=1   (exact string "1", nothing else)
 *   DESTINATION    fixed, repository-relative, never caller-supplied:
 *                  <git-toplevel>/.build-websites-tools/gate-snapshot/
 *
 * There is no path override. GATE_SNAPSHOT_DIR is now recognized only to be
 * REJECTED: its presence is invalid deprecated configuration and its value is
 * never interpreted as a path.
 *
 * Confinement is proven at the final mutation boundary, not merely in the CLI:
 * the repository root is canonicalized with realpath, the destination is
 * derived from it, and containment is checked with path.relative rather than a
 * string prefix (which "/repo-evil" would defeat against "/repo"). Symlinked
 * roots, symlinked parents and symlinked destinations are rejected.
 *
 * DESIGN: WHY A process.on("exit") RECORDER AND NOT A CALL AT EACH EXIT
 *
 * Gates terminate through many paths - gate-ada alone calls process.exit() from
 * three places, and several gates set process.exitCode and fall through. Since
 * process.exit() does NOT run pending finally blocks, a finalizer in try/finally
 * would miss exactly the failures worth recording. One process.on("exit")
 * handler fires on all of them and reads the real exit code.
 *
 * HARD INVARIANTS (each has a test)
 *
 *  1. Inert unless GATE_SNAPSHOT_ENABLED is exactly "1".
 *  2. Emission can never fail a build.
 *  3. No write can land outside the fixed repository artifact directory.
 *  4. No secret VALUES are serialized; redaction is key-aware AND shape-aware.
 *  5. Fragment writes are idempotent per gate.
 */

import {
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  realpathSync,
  lstatSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

export type CheckRecord = {
  name: string;
  pass: boolean;
  detail: string;
};

export type FragmentOutcome = "pass" | "fail" | "error";

export const FRAGMENT_SCHEMA_VERSION = 1;

export type Fragment = {
  fragmentSchemaVersion?: number;
  gate: string;
  version: string;
  startedAt: string;
  finishedAt: string;
  outcome: FragmentOutcome;
  provenance: Record<string, unknown>;
  checks: CheckRecord[];
  routes?: Record<string, unknown>;
};

/** Authorization. Exact value "1" and nothing else. */
export const SNAPSHOT_ENABLED_ENV = "GATE_SNAPSHOT_ENABLED";
/** Deprecated. Recognized only so its presence can be rejected. */
export const DEPRECATED_DIR_ENV = "GATE_SNAPSHOT_DIR";

/** Fixed, repository-relative artifact directory. Never caller-supplied. */
export const ARTIFACT_DIR_SEGMENTS = [".build-websites-tools", "gate-snapshot"] as const;

export const KNOWN_GATES = [
  "gate-ada",
  "gate-seo",
  "gate-ai-instrumentation",
  "gate-ai-instrumentation-source",
  "gate-conversion-instrumentation-source",
  "gate-sitemap-source",
  "gate-dashboard-parity",
] as const;

export type KnownGate = (typeof KNOWN_GATES)[number];

export function isSafeGateName(gate: unknown): gate is KnownGate {
  if (typeof gate !== "string") return false;
  if (!/^[a-z0-9-]+$/.test(gate)) return false;
  if (gate.includes("..") || gate.includes("/") || gate.includes("\\")) return false;
  return (KNOWN_GATES as readonly string[]).includes(gate);
}

/* ------------------------------------------------------------------ */
/* Authorization                                                       */
/* ------------------------------------------------------------------ */

export type AuthDecision =
  | { armed: true }
  | { armed: false; reason: string; invalidConfig: boolean };

/**
 * Decide whether snapshot emission is authorized.
 *
 * Exactly one accepted value: "1". "true", "yes", "on" and friends are
 * deliberately NOT accepted - one documented value removes the whole "which
 * spellings count" class, and a typo failing closed is safer than a typo
 * arming a filesystem writer.
 *
 * `invalidConfig` separates "not asked for" (inert, exit 0) from "asked for
 * incorrectly" (the CLI must exit nonzero).
 */
export function authorize(env: NodeJS.ProcessEnv = process.env): AuthDecision {
  if (Object.prototype.hasOwnProperty.call(env, DEPRECATED_DIR_ENV)) {
    return {
      armed: false,
      invalidConfig: true,
      reason: `${DEPRECATED_DIR_ENV} is no longer supported and its value is never interpreted as a path. Snapshots go to a fixed repository-relative directory. Unset it and set ${SNAPSHOT_ENABLED_ENV}=1.`,
    };
  }
  const raw = env[SNAPSHOT_ENABLED_ENV];
  if (raw === undefined) {
    return { armed: false, invalidConfig: false, reason: "not enabled" };
  }
  if (raw === "1") return { armed: true };
  return {
    armed: false,
    invalidConfig: false,
    reason: `${SNAPSHOT_ENABLED_ENV} must be exactly "1" to enable snapshots; emission stays off`,
  };
}

export function isArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return authorize(env).armed;
}

/* ------------------------------------------------------------------ */
/* Repository resolution + confinement                                 */
/* ------------------------------------------------------------------ */

export type RootResolution =
  | { ok: true; repoRoot: string; artifactRoot: string }
  | { ok: false; reason: string };

function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Bounded: this runs inside a build step. git can stall on an index lock,
      // a slow network filesystem, or a credential prompt, and a hang would
      // stall the build - which this module promises never to do.
      timeout: 5000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Containment proof.
 *
 * Uses path.relative, NOT a string prefix: "/repo-evil".startsWith("/repo") is
 * true, so a prefix comparison is not a containment proof.
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (rel === "..") return false;
  return !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Canonicalize the nearest existing ancestor so symlinks cannot hide an escape. */
export function canonicalizeNearestExisting(target: string): string {
  let current = target;
  const trailing: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(current)) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        real = current;
      }
      return trailing.length > 0 ? path.join(real, ...trailing.reverse()) : real;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    trailing.push(path.basename(current));
    current = parent;
  }
  return target;
}

/**
 * Resolve the fixed artifact root from the canonical git top level.
 *
 * Fails closed when: not a git repository, git unavailable or slow, the
 * toplevel cannot be canonicalized, or any component of the artifact path is a
 * symlink that leaves the repository.
 */
export function resolveArtifactRoot(cwd: string = process.cwd()): RootResolution {
  const top = gitToplevel(cwd);
  if (!top) {
    return {
      ok: false,
      reason:
        "not inside a git repository (or git was unavailable): snapshots are written to a repository-relative directory, so there is nowhere safe to write",
    };
  }

  let repoRoot: string;
  try {
    repoRoot = realpathSync(top);
  } catch (err) {
    return {
      ok: false,
      reason: `could not canonicalize repository root: ${(err as Error).message}`,
    };
  }

  const artifactRoot = path.join(repoRoot, ...ARTIFACT_DIR_SEGMENTS);

  // Reject a symlinked artifact root outright, even when it currently points
  // inside: the target can be repointed between check and use.
  if (existsSync(artifactRoot)) {
    try {
      if (lstatSync(artifactRoot).isSymbolicLink()) {
        return { ok: false, reason: "artifact directory is a symlink; refusing to write" };
      }
    } catch {
      /* fall through; the write boundary re-checks */
    }
  }

  const canonical = canonicalizeNearestExisting(artifactRoot);
  if (!isInside(repoRoot, canonical)) {
    return {
      ok: false,
      reason: `artifact directory resolves outside the repository (${canonical}); refusing to write`,
    };
  }

  return { ok: true, repoRoot, artifactRoot: canonical };
}

export function fragmentsDir(artifactRoot: string): string {
  return path.join(artifactRoot, "fragments");
}

export type WriteResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The single mutation boundary. Every write in this feature goes through here,
 * so a lower-level writer cannot bypass confinement.
 *
 * The temp file is created in the SAME directory as the target, so the rename
 * is a same-filesystem atomic replacement rather than a cross-device copy.
 */
export function writeConfinedFile(
  artifactRoot: string,
  repoRoot: string,
  relativePath: string,
  contents: string,
): WriteResult {
  if (path.isAbsolute(relativePath)) {
    return { ok: false, reason: "absolute paths are never accepted" };
  }
  const target = path.join(artifactRoot, relativePath);
  if (!isInside(artifactRoot, target) || !isInside(repoRoot, target)) {
    return { ok: false, reason: `refusing to write outside the artifact directory: ${relativePath}` };
  }

  const dir = path.dirname(target);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not create artifact directory: ${(err as Error).message}` };
  }

  // Re-canonicalize AFTER mkdir: a symlink planted between resolution and
  // creation is only visible once the directory exists.
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (err) {
    return { ok: false, reason: `could not canonicalize target directory: ${(err as Error).message}` };
  }
  if (!isInside(repoRoot, realDir)) {
    return { ok: false, reason: `target directory escapes the repository after resolution: ${realDir}` };
  }

  const finalTarget = path.join(realDir, path.basename(target));
  if (existsSync(finalTarget)) {
    try {
      const st = lstatSync(finalTarget);
      if (st.isSymbolicLink()) {
        return { ok: false, reason: "destination is a symlink; refusing to write" };
      }
      // A directory destination is deliberately NOT rejected here. Letting it
      // reach renameSync means the failure path - and therefore the temporary
      // file cleanup - is exercised by a real failure rather than short
      // circuited. The symlink check above is the security-relevant one.
    } catch {
      /* fall through */
    }
  }

  const tmp = path.join(
    realDir,
    `.${path.basename(finalTarget)}.tmp-${process.pid}-${Math.abs(Date.now())}`,
  );
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o644 });
    try {
      const fd = openSync(tmp, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* fsync best-effort; the rename is still atomic within the filesystem */
    }
    renameSync(tmp, finalTarget);
    return { ok: true, path: finalTarget };
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, reason: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

/**
 * Value shapes that must never reach a snapshot.
 *
 * Shape-based because a caller can invent a field name we did not anticipate,
 * but a Google API key, a Stripe key and a JWT have recognizable shapes. GA4
 * measurement ids are included deliberately: not strictly secret, but they
 * identify a customer's analytics property, and the env var NAME already proves
 * configuration presence.
 *
 * The previous `ga4-api-secret` rule used a lookahead for the word "secret"
 * elsewhere in the string. Review showed it was both under- and over-inclusive:
 * `{ apiSecret: "<20 opaque chars>" }` was NOT redacted, while an unrelated long
 * token WAS redacted whenever "secret" appeared later. It is replaced by the
 * key-aware rule below.
 */
const SECRET_SHAPES: Array<{ label: string; re: RegExp }> = [
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{10,}/ },
  { label: "stripe-key", re: /\b[sprk]k_(live|test)_[0-9A-Za-z]{6,}/ },
  { label: "bearer-token", re: /\bBearer\s+[0-9A-Za-z._~+/-]{8,}/i },
  { label: "ga4-measurement-id", re: /\bG-[A-Z0-9]{6,}\b/ },
  { label: "jwt", re: /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{4,}/ },
  { label: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { label: "postgres-url", re: /\bpostgres(ql)?:\/\/\S+/i },
  { label: "authorization-header", re: /\bauthorization\s*[:=]\s*\S+/i },
  { label: "cookie-header", re: /\bcookie\s*[:=]\s*\S+/i },
];

/**
 * Property names whose VALUE is credential-like regardless of shape. This is
 * the fix for the key-blind gap: a 20-character opaque string under `apiSecret`
 * has no distinguishing shape, only a distinguishing key.
 */
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|credential|api[_-]?key|apikey|private[_-]?key|session[_-]?id|client[_-]?secret)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function redactSecrets(input: string): string {
  let out = input;
  for (const { label, re } of SECRET_SHAPES) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    out = out.replace(global, `[REDACTED:${label}]`);
  }
  return out;
}

/**
 * Recursively sanitize a value.
 *
 * `key` is threaded through so a credential-like property name redacts its
 * value even when the value has no recognizable shape.
 *
 * Non-finite numbers are dropped and named rather than serialized: JSON
 * .stringify turns NaN/Infinity into null, and a null reads as a measured
 * absence. Losing the field is honest; misreporting it is not.
 */
export function sanitizeValue(value: unknown, depth = 0, key?: string): unknown {
  if (depth > 12) return "[REDACTED:max-depth]";

  if (key !== undefined && isSecretKey(key)) {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return value; // a boolean carries no secret
    return "[REDACTED:credential-like-key]";
  }

  if (value === null) return null;

  const t = typeof value;
  if (t === "string") return redactSecrets(value as string);
  if (t === "boolean") return value;
  if (t === "number") {
    return Number.isFinite(value as number) ? value : "[DROPPED:non-finite-number]";
  }
  if (t === "bigint") return (value as bigint).toString();
  if (t === "undefined" || t === "function" || t === "symbol") return undefined;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1)).filter((v) => v !== undefined);
  }

  if (t === "object") {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error) return redactSecrets(value.message);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const clean = sanitizeValue(v, depth + 1, k);
      if (clean !== undefined) out[redactSecrets(k)] = clean;
    }
    return out;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Emission                                                            */
/* ------------------------------------------------------------------ */

export function toolsVersion(): string {
  try {
    // createRequire, never new URL().pathname: pathname is percent-encoded and
    // Windows-shaped, so a path containing a space or a drive letter silently
    // resolves to the wrong file.
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Write one fragment. Never throws, never alters exit status. */
export function emitFragment(fragment: Fragment, cwd: string = process.cwd()): void {
  try {
    const auth = authorize();
    if (!auth.armed) {
      if (auth.invalidConfig) {
        // Loud, but never fatal: a gate must not fail a build over a snapshot
        // misconfiguration.
        process.stderr.write(`gate-snapshot  ${auth.reason}\n`);
      }
      return;
    }

    if (!isSafeGateName(fragment.gate)) {
      process.stderr.write(
        `gate-snapshot  refusing to write fragment for unrecognized gate name ${JSON.stringify(fragment.gate)}\n`,
      );
      return;
    }

    const resolved = resolveArtifactRoot(cwd);
    if (!resolved.ok) {
      process.stderr.write(`gate-snapshot  ${resolved.reason}\n`);
      return;
    }

    const safe = sanitizeValue({
      fragmentSchemaVersion: FRAGMENT_SCHEMA_VERSION,
      ...fragment,
      version: fragment.version || toolsVersion(),
    }) as Record<string, unknown>;

    const result = writeConfinedFile(
      resolved.artifactRoot,
      resolved.repoRoot,
      path.join("fragments", `${fragment.gate}.json`),
      `${JSON.stringify(safe, null, 2)}\n`,
    );
    if (!result.ok) {
      process.stderr.write(
        `gate-snapshot  fragment emission failed (build unaffected): ${result.reason}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `gate-snapshot  fragment emission failed (build unaffected): ${(err as Error).message}\n`,
    );
  }
}

export type FragmentRecorder = {
  provenance(patch: Record<string, unknown>): void;
  check(check: CheckRecord): void;
  checks(checks: CheckRecord[]): void;
  route(routePath: string, facts: Record<string, unknown>): void;
  readonly enabled: boolean;
};

const NOOP_RECORDER: FragmentRecorder = {
  provenance() {},
  check() {},
  checks() {},
  route() {},
  enabled: false,
};

/**
 * Begin recording a fragment for `gate`, written on process exit regardless of
 * which exit path is taken. Callers that can distinguish an internal error from
 * a measured failure set provenance({ errored: true }), which surfaces as
 * outcome "error".
 */
export function beginFragment(gate: string, cwd: string = process.cwd()): FragmentRecorder {
  if (!isArmed()) return NOOP_RECORDER;
  if (!isSafeGateName(gate)) {
    process.stderr.write(
      `gate-snapshot  refusing to record unrecognized gate name ${JSON.stringify(gate)}\n`,
    );
    return NOOP_RECORDER;
  }

  const startedAt = new Date().toISOString();
  const provenance: Record<string, unknown> = {};
  const checks: CheckRecord[] = [];
  const routes: Record<string, unknown> = {};

  process.on("exit", (code) => {
    const errored = provenance.errored === true;
    emitFragment(
      {
        fragmentSchemaVersion: FRAGMENT_SCHEMA_VERSION,
        gate,
        version: toolsVersion(),
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: errored ? "error" : code === 0 ? "pass" : "fail",
        provenance,
        checks,
        ...(Object.keys(routes).length > 0 ? { routes } : {}),
      },
      cwd,
    );
  });

  return {
    enabled: true,
    provenance(patch) {
      Object.assign(provenance, patch);
    },
    check(c) {
      checks.push(c);
    },
    checks(list) {
      for (const c of list) checks.push(c);
    },
    route(routePath, facts) {
      routes[routePath] = facts;
    },
  };
}
