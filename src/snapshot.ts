/*
 * gate-snapshot Phase 1 - fragment emission.
 *
 * WHY THIS EXISTS
 *
 * Every gate in this package measures a large number of technical facts per
 * build - HTTP status, canonical, meta robots, title, description, headings,
 * image alt, JSON-LD, sitemap membership, lastmod truthfulness, security
 * headers, axe violations - and then discards all of it at process exit. Only
 * the exit code survives.
 *
 * The consequence, observed across the Site Clinic fleet: no site accumulates
 * a technical baseline, so a "what did this look like before we changed it"
 * question can only be answered by whoever happened to capture it by hand.
 * Usually nobody did. That is not a discipline failure; it is a missing write
 * call. This module is that write call.
 *
 * DESIGN: WHY A process.on("exit") RECORDER AND NOT A CALL AT EACH EXIT
 *
 * The gates terminate through many different paths - gate-ada alone calls
 * process.exit() from three places, gate-seo from two, and several gates set
 * process.exitCode and fall through. process.exit() does NOT run pending
 * `finally` blocks, so a finalizer placed in a try/finally would silently miss
 * the most interesting cases (the failures).
 *
 * Registering a single process.on("exit") handler fires on every one of those
 * paths, including uncaught throws that reach the top-level catch. It also
 * gives us the real exit code, so `outcome` is derived from what actually
 * happened rather than from a flag we remembered to set. The handler is
 * synchronous-only by Node's contract, which is why the write is writeFileSync.
 *
 * The cost of this choice is that a gate integrates with ONE line at the top of
 * main() plus data-recording calls, and cannot forget an exit path.
 *
 * HARD INVARIANTS (each has a test)
 *
 *  1. Inert unless GATE_SNAPSHOT_DIR is set. No env var -> no handler, no
 *     writes, no behavior change for the nine consumers already on a pinned tag.
 *  2. Emission can never fail a build. Every filesystem and serialization path
 *     is wrapped; failures warn to stderr and return. A lost measurement must
 *     never turn into a failed deployment.
 *  3. The gate's exit status is never modified. This module reads the exit
 *     code; it does not write it.
 *  4. No secret VALUES are ever serialized. Environment variables may be
 *     recorded by NAME only, and an explicit sanitizer strips anything that
 *     looks like a credential regardless of how it got into the payload.
 *  5. Fragment writes are idempotent per gate. gate-dashboard-parity composes
 *     other gates as subprocesses, so a composed run must overwrite rather than
 *     duplicate.
 */

import { writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export type CheckRecord = {
  name: string;
  pass: boolean;
  detail: string;
};

export type FragmentOutcome = "pass" | "fail" | "error";

export type Fragment = {
  gate: string;
  version: string;
  startedAt: string;
  finishedAt: string;
  outcome: FragmentOutcome;
  provenance: Record<string, unknown>;
  checks: CheckRecord[];
  routes?: Record<string, unknown>;
};

/** Env var that arms the whole feature. Absent -> this module does nothing. */
export const SNAPSHOT_DIR_ENV = "GATE_SNAPSHOT_DIR";

/**
 * Gate names we will write a fragment for. A name outside this set is rejected
 * rather than normalized into some neighbouring path: the set is small, closed,
 * and known at author time, so an unknown name means a caller bug, not a new
 * gate we should silently accept into the filesystem.
 */
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

/**
 * Path-traversal guard. A gate name becomes a filename, so it must not be able
 * to escape the fragments directory. Belt and braces: allowlist membership AND
 * a character check, so adding a gate to KNOWN_GATES with a careless name still
 * cannot produce "../../etc/passwd".
 */
export function isSafeGateName(gate: string): gate is KnownGate {
  if (!/^[a-z0-9-]+$/.test(gate)) return false;
  if (gate.includes("..") || gate.includes("/") || gate.includes("\\")) return false;
  return (KNOWN_GATES as readonly string[]).includes(gate);
}

/**
 * Values that must never reach a snapshot even by accident.
 *
 * Rationale for shape-based redaction rather than field-name denial: a caller
 * can invent a field name we did not anticipate, but a Google API secret, a
 * Stripe key, a bearer token and a GA4 measurement ID all have recognizable
 * SHAPES. Redacting on shape catches the case the author did not think of,
 * which is exactly the case that leaks.
 *
 * GA4 measurement IDs (G-XXXX) are included deliberately. They are not strictly
 * secret, but they identify a customer's analytics property and there is no
 * reason a build snapshot needs one to prove configuration presence - the env
 * var NAME proves that.
 */
const SECRET_SHAPES: Array<{ label: string; re: RegExp }> = [
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{10,}/ },
  { label: "stripe-key", re: /\b[sprk]k_(live|test)_[0-9A-Za-z]{6,}/ },
  { label: "bearer-token", re: /\bBearer\s+[0-9A-Za-z._~+/-]{8,}/i },
  { label: "ga4-measurement-id", re: /\bG-[A-Z0-9]{6,}\b/ },
  { label: "ga4-api-secret", re: /\b[0-9A-Za-z_-]{20,}\.{0,1}[0-9A-Za-z_-]*\b(?=.*secret)/i },
  { label: "jwt", re: /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{4,}/ },
  { label: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  { label: "postgres-url", re: /\bpostgres(ql)?:\/\/\S+/i },
  { label: "authorization-header", re: /\bauthorization\s*[:=]\s*\S+/i },
  { label: "cookie-header", re: /\bcookie\s*[:=]\s*\S+/i },
];

/** Replace any secret-shaped substring with a labelled marker. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const { label, re } of SECRET_SHAPES) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    out = out.replace(global, `[REDACTED:${label}]`);
  }
  return out;
}

/**
 * Recursively sanitize a value for serialization.
 *
 * Beyond redaction this enforces JSON-safety, because a value that
 * JSON.stringify turns into `null` is worse than a dropped field: it looks like
 * a measured absence. Non-finite numbers (NaN, Infinity) serialize to null, so
 * they are dropped and named instead. Same reasoning as the conversion-relay
 * scalar guard: lose the parameter, never misreport it.
 */
export function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[REDACTED:max-depth]";
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
      const clean = sanitizeValue(v, depth + 1);
      if (clean !== undefined) out[redactSecrets(k)] = clean;
    }
    return out;
  }
  return undefined;
}

/** Resolve this package's version without importing package.json as a module. */
function toolsVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function snapshotDir(): string | null {
  const dir = process.env[SNAPSHOT_DIR_ENV];
  if (!dir || dir.trim().length === 0) return null;
  return dir.trim();
}

export function fragmentsDir(root: string): string {
  return path.join(root, "fragments");
}

/**
 * Write one fragment. Never throws, never alters exit status.
 *
 * The write is atomic-where-practical: serialize to a temp file in the same
 * directory, then rename. A crash mid-write therefore leaves either the old
 * fragment or the new one, never a truncated document the merger would have to
 * treat as malformed.
 */
export function emitFragment(fragment: Fragment): void {
  try {
    const root = snapshotDir();
    if (!root) return; // inert without the env var - invariant 1

    if (!isSafeGateName(fragment.gate)) {
      process.stderr.write(
        `gate-snapshot  refusing to write fragment for unrecognized gate name ${JSON.stringify(fragment.gate)}\n`,
      );
      return;
    }

    const dir = fragmentsDir(root);
    mkdirSync(dir, { recursive: true });

    const safe = sanitizeValue({
      ...fragment,
      version: fragment.version || toolsVersion(),
    }) as Record<string, unknown>;

    const target = path.join(dir, `${fragment.gate}.json`);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
    try {
      renameSync(tmp, target); // idempotent per gate - invariant 5
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw err;
    }
  } catch (err) {
    // invariant 2: warn, never throw, never touch the exit code
    process.stderr.write(
      `gate-snapshot  fragment emission failed (build unaffected): ${(err as Error).message}\n`,
    );
  }
}

export type FragmentRecorder = {
  /** Merge keys into the fragment's provenance. */
  provenance(patch: Record<string, unknown>): void;
  /** Append one check result. */
  check(check: CheckRecord): void;
  /** Append many check results. */
  checks(checks: CheckRecord[]): void;
  /** Phase 2 hook - typed per-route facts. Unused in Phase 1. */
  route(routePath: string, facts: Record<string, unknown>): void;
  /** True when emission is armed. Lets callers skip expensive collection. */
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
 * Begin recording a fragment for `gate`, and arrange for it to be written on
 * process exit regardless of which exit path is taken.
 *
 * Returns a no-op recorder when GATE_SNAPSHOT_DIR is unset, so callers need no
 * conditional and the disabled path costs one property read.
 *
 * `outcome` is derived from the real exit code at exit time:
 *   0        -> pass
 *   non-zero -> fail
 * A gate that threw reaches its top-level catch and exits non-zero, so it lands
 * in `fail`. Callers that can distinguish an internal error from a legitimate
 * gate failure may set provenance({ errored: true }); the merger surfaces that
 * as outcome "error".
 */
export function beginFragment(gate: string): FragmentRecorder {
  if (!snapshotDir()) return NOOP_RECORDER;
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
    emitFragment({
      gate,
      version: toolsVersion(),
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome: errored ? "error" : code === 0 ? "pass" : "fail",
      provenance,
      checks,
      ...(Object.keys(routes).length > 0 ? { routes } : {}),
    });
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
