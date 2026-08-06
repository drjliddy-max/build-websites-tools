/*
 * Runtime validation for gate-snapshot.
 *
 * WHY THIS EXISTS
 *
 * An earlier revision cast parsed JSON to `Fragment` after only a
 * `typeof === "object"` check, so a file that parsed but had the wrong shape
 * flowed into the final document. Review then found two further defects in the
 * first validator, both repaired here:
 *
 *   1. PROTOTYPE-CHAIN BYPASS. Schema and data lookups used `map[key]`, so an
 *      inherited name - `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 *      `__proto__` - resolved to an Object.prototype member and read as a
 *      DECLARED schema property. A payload keyed on those names could slip past
 *      `additionalProperties: false`. Every lookup at a trust boundary is now an
 *      explicit own-property check, and internal maps are null-prototype.
 *
 *   2. DISHONEST KEYWORD SUPPORT. `propertyNames` and `maxItems` were listed as
 *      supported but never executed, so a schema using them was silently
 *      under-checked - the worst failure mode for a validator, because it
 *      reports success it did not earn. Keywords are now a registry: each is
 *      either IMPLEMENTED (and executed), METADATA (ignored by explicit
 *      policy), or unknown - and unknown fails closed.
 *
 * SCHEMA SOURCE OF TRUTH
 *
 * The shipped schema/build-snapshot-v1.schema.json is the source of truth for
 * the SNAPSHOT document. `validateFragment` covers the FRAGMENT wire format,
 * which is internal and deliberately unpublished.
 *
 * Cross-field truth that JSON Schema cannot express (a complete snapshot must
 * have a null reason, summary counts must match the gate entries, and so on)
 * lives in `validateSnapshotSemantics` - a second, explicitly documented layer.
 *
 * A dependency-free validator is used rather than ajv because this package ships
 * into consumer builds and every runtime dependency is supply-chain surface.
 */

export type ValidationError = { path: string; message: string };

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

/** The only safe way to read a caller-controlled key. */
export function hasOwn(obj: unknown, key: string): boolean {
  return (
    obj !== null &&
    typeof obj === "object" &&
    Object.prototype.hasOwnProperty.call(obj, key)
  );
}

/** Read an own property or return undefined. Never reaches the prototype chain. */
export function ownGet(obj: unknown, key: string): unknown {
  return hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Own enumerable keys only. */
export function ownKeys(obj: unknown): string[] {
  if (obj === null || typeof obj !== "object") return [];
  return Object.keys(obj as Record<string, unknown>);
}

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!ISO_8601.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/* ------------------------------------------------------------------ */
/* Fragment validation                                                 */
/* ------------------------------------------------------------------ */

/** The one fragment wire version this build understands. */
export const REQUIRED_FRAGMENT_SCHEMA_VERSION = 1;

const FRAGMENT_OUTCOMES = new Set(["pass", "fail", "error", "skipped"]);

/**
 * Validate a parsed fragment.
 *
 * `fragmentSchemaVersion` is MANDATORY and must be exactly the integer 1.
 * Review found the previous "optional, checked only when present" rule let an
 * unversioned fragment be interpreted as version 1 - which silently converts a
 * future or malformed writer's output into evidence this build cannot actually
 * interpret. Absent, null, "1", 1.5, 0, 2, booleans and objects are all
 * rejected; a future version fails closed rather than being downgraded.
 *
 * Unknown TOP-LEVEL fields are permitted and preserved (a later tools version
 * may record extra provenance). Unknown GATE NAMES are rejected here; the
 * merger applies its own explicit unknown-gate policy.
 */
export function validateFragment(
  input: unknown,
  isKnownGate: (g: unknown) => boolean,
): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  if (input === null) {
    return { valid: false, errors: [{ path: "", message: "fragment is null" }] };
  }
  if (Array.isArray(input)) {
    return { valid: false, errors: [{ path: "", message: "fragment is an array, expected an object" }] };
  }
  if (typeof input !== "object") {
    return { valid: false, errors: [{ path: "", message: `fragment is a ${typeof input}, expected an object` }] };
  }

  // Version first: an unsupported version must not be evaluated further under
  // this build's assumptions.
  if (!hasOwn(input, "fragmentSchemaVersion")) {
    err("fragmentSchemaVersion", "is required and must be the integer 1");
  } else {
    const v = ownGet(input, "fragmentSchemaVersion");
    if (typeof v !== "number" || !Number.isInteger(v)) {
      err("fragmentSchemaVersion", `must be the integer 1, received ${JSON.stringify(v)}`);
    } else if (v !== REQUIRED_FRAGMENT_SCHEMA_VERSION) {
      err(
        "fragmentSchemaVersion",
        `unsupported fragment schema version ${v}; this build understands only ${REQUIRED_FRAGMENT_SCHEMA_VERSION}`,
      );
    }
  }

  const gate = ownGet(input, "gate");
  if (typeof gate !== "string" || gate.length === 0) {
    err("gate", "must be a non-empty string");
  } else if (!isKnownGate(gate)) {
    err("gate", `unknown gate name ${JSON.stringify(gate)}`);
  }

  if (typeof ownGet(input, "version") !== "string") err("version", "must be a string");
  if (!isValidTimestamp(ownGet(input, "startedAt"))) err("startedAt", "must be an ISO-8601 timestamp");
  if (!isValidTimestamp(ownGet(input, "finishedAt"))) err("finishedAt", "must be an ISO-8601 timestamp");

  const outcome = ownGet(input, "outcome");
  if (typeof outcome !== "string" || !FRAGMENT_OUTCOMES.has(outcome)) {
    err("outcome", 'must be one of "pass", "fail", "error", "skipped"');
  }

  const provenance = ownGet(input, "provenance");
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    err("provenance", "must be an object");
  }

  const checks = ownGet(input, "checks");
  if (!Array.isArray(checks)) {
    err("checks", "must be an array");
  } else {
    checks.forEach((c, i) => {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        err(`checks[${i}]`, "must be an object");
        return;
      }
      if (typeof ownGet(c, "name") !== "string") err(`checks[${i}].name`, "must be a string");
      if (typeof ownGet(c, "pass") !== "boolean") err(`checks[${i}].pass`, "must be a boolean");
      if (typeof ownGet(c, "detail") !== "string") err(`checks[${i}].detail`, "must be a string");
    });
  }

  if (hasOwn(input, "routes")) {
    const routes = ownGet(input, "routes");
    if (routes === null || typeof routes !== "object" || Array.isArray(routes)) {
      err("routes", "must be an object when present");
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/* ------------------------------------------------------------------ */
/* JSON Schema subset validator                                        */
/* ------------------------------------------------------------------ */

type Schema = Record<string, unknown>;

/**
 * Keywords this validator EXECUTES. Anything here is implemented below and
 * covered by a test that fails if the implementation is removed.
 */
export const IMPLEMENTED_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "pattern",
  "format",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "items",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
]);

/**
 * Keywords deliberately IGNORED because they carry no validation semantics.
 * This is an explicit policy, not an oversight.
 */
export const METADATA_KEYWORDS = new Set(["$schema", "$id", "title", "description", "$comment", "examples", "default"]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && Number.isInteger(v)) return "integer";
  return typeof v;
}

function typeMatches(v: unknown, want: string): boolean {
  const actual = typeOf(v);
  if (want === "number") return actual === "number" || actual === "integer";
  if (want === "integer") return actual === "integer";
  return actual === want;
}

/**
 * Reject a schema that uses a keyword this validator does not execute.
 *
 * Fails CLOSED at initialization: a validator that silently ignores a
 * constraint reports a success it did not earn, which is worse than refusing to
 * run at all.
 */
export function assertSchemaSupported(schema: unknown, path = ""): ValidationResult {
  const errors: ValidationError[] = [];

  const walkSchema = (s: unknown, p: string): void => {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return;
    for (const key of ownKeys(s)) {
      if (METADATA_KEYWORDS.has(key)) continue;
      if (!IMPLEMENTED_KEYWORDS.has(key)) {
        errors.push({ path: p ? `${p}.${key}` : key, message: `unsupported schema keyword "${key}"` });
        continue;
      }
      const child = ownGet(s, key);
      if (key === "properties" || key === "propertyNames") {
        if (key === "propertyNames") walkSchema(child, `${p}.propertyNames`);
        else for (const pk of ownKeys(child)) walkSchema(ownGet(child, pk), `${p}.properties.${pk}`);
      } else if (key === "items") {
        walkSchema(child, `${p}.items`);
      } else if (key === "additionalProperties" && typeof child === "object" && child !== null) {
        walkSchema(child, `${p}.additionalProperties`);
      }
    }
  };

  walkSchema(schema, path);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Validate `value` against the supported subset.
 * The schema is checked for supported keywords FIRST, so an unsupported
 * construct is an error rather than a silent pass.
 */
export function validateAgainstSchema(value: unknown, schema: Schema, path = ""): ValidationResult {
  const support = assertSchemaSupported(schema, path);
  if (!support.valid) return support;

  const errors: ValidationError[] = [];
  walk(value, schema, path, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function walk(value: unknown, schema: Schema, path: string, errors: ValidationError[]): void {
  if (hasOwn(schema, "const")) {
    if (value !== ownGet(schema, "const")) {
      errors.push({ path, message: `must equal ${JSON.stringify(ownGet(schema, "const"))}` });
      return;
    }
  }

  if (hasOwn(schema, "enum")) {
    const allowed = ownGet(schema, "enum");
    if (Array.isArray(allowed) && !allowed.some((a) => a === value)) {
      errors.push({ path, message: `must be one of ${JSON.stringify(allowed)}` });
      return;
    }
  }

  if (hasOwn(schema, "type")) {
    const t = ownGet(schema, "type");
    const want: string[] = Array.isArray(t) ? (t as string[]) : [t as string];
    if (!want.some((w) => typeMatches(value, w))) {
      errors.push({ path, message: `expected ${want.join("|")}, got ${typeOf(value)}` });
      return;
    }
  }

  if (typeof value === "string") {
    if (hasOwn(schema, "pattern") && !new RegExp(ownGet(schema, "pattern") as string).test(value)) {
      errors.push({ path, message: `does not match ${ownGet(schema, "pattern")}` });
    }
    if (hasOwn(schema, "format") && ownGet(schema, "format") === "date-time" && !isValidTimestamp(value)) {
      errors.push({ path, message: "not a valid date-time" });
    }
    if (hasOwn(schema, "minLength") && value.length < (ownGet(schema, "minLength") as number)) {
      errors.push({ path, message: `must be at least ${ownGet(schema, "minLength")} characters` });
    }
    if (hasOwn(schema, "maxLength") && value.length > (ownGet(schema, "maxLength") as number)) {
      errors.push({ path, message: `must be at most ${ownGet(schema, "maxLength")} characters` });
    }
  }

  if (typeof value === "number") {
    if (hasOwn(schema, "minimum") && value < (ownGet(schema, "minimum") as number)) {
      errors.push({ path, message: `must be >= ${ownGet(schema, "minimum")}` });
    }
    if (hasOwn(schema, "maximum") && value > (ownGet(schema, "maximum") as number)) {
      errors.push({ path, message: `must be <= ${ownGet(schema, "maximum")}` });
    }
  }

  if (Array.isArray(value)) {
    if (hasOwn(schema, "minItems") && value.length < (ownGet(schema, "minItems") as number)) {
      errors.push({ path, message: `must have >= ${ownGet(schema, "minItems")} items` });
    }
    // maxItems is now actually EXECUTED - it was advertised and ignored before.
    if (hasOwn(schema, "maxItems") && value.length > (ownGet(schema, "maxItems") as number)) {
      errors.push({ path, message: `must have <= ${ownGet(schema, "maxItems")} items` });
    }
    if (hasOwn(schema, "items")) {
      const items = ownGet(schema, "items") as Schema;
      value.forEach((v, i) => walk(v, items, `${path}[${i}]`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // Own keys only: an inherited name must never be treated as present data.
    const dataKeys = ownKeys(value);

    if (hasOwn(schema, "required")) {
      const req = ownGet(schema, "required");
      if (Array.isArray(req)) {
        for (const r of req as string[]) {
          if (!hasOwn(value, r)) {
            errors.push({ path: path ? `${path}.${r}` : r, message: "is required" });
          }
        }
      }
    }

    // propertyNames is now actually EXECUTED.
    if (hasOwn(schema, "propertyNames")) {
      const pn = ownGet(schema, "propertyNames") as Schema;
      for (const k of dataKeys) {
        const sub: ValidationError[] = [];
        walk(k, pn, path ? `${path}.<key:${k}>` : `<key:${k}>`, sub);
        errors.push(...sub);
      }
    }

    const hasProps = hasOwn(schema, "properties");
    const props = hasProps ? (ownGet(schema, "properties") as Schema) : undefined;
    const addl = hasOwn(schema, "additionalProperties") ? ownGet(schema, "additionalProperties") : undefined;

    for (const k of dataKeys) {
      const child = path ? `${path}.${k}` : k;
      const v = (value as Record<string, unknown>)[k];
      // hasOwn, NOT props[k]: "constructor" and friends must not resolve
      // through Object.prototype and masquerade as declared properties.
      if (props !== undefined && hasOwn(props, k)) {
        walk(v, ownGet(props, k) as Schema, child, errors);
      } else if (addl === false) {
        errors.push({ path: child, message: "is not allowed by the schema" });
      } else if (addl !== undefined && typeof addl === "object" && addl !== null) {
        walk(v, addl as Schema, child, errors);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Semantic validation (beyond JSON Schema)                            */
/* ------------------------------------------------------------------ */

/**
 * Cross-field invariants JSON Schema cannot express.
 *
 * The schema can say `status` is one of three strings; it cannot say that a
 * `complete` status REQUIRES a null reason, a non-empty expected set, and
 * summary counts that match the gate entries. Review found those relationships
 * were promised in schema descriptions but enforced nowhere. This is the layer
 * that enforces them.
 */
export function validateSnapshotSemantics(snapshot: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  const completeness = ownGet(snapshot, "completeness");
  const gates = ownGet(snapshot, "gates");
  const summary = ownGet(snapshot, "summary");
  const build = ownGet(snapshot, "build");

  if (!completeness || typeof completeness !== "object") {
    return { valid: false, errors: [{ path: "completeness", message: "missing" }] };
  }

  const status = ownGet(completeness, "status");
  const reason = ownGet(completeness, "reason");
  const expected = (ownGet(completeness, "gatesExpected") ?? []) as string[];
  const run = (ownGet(completeness, "gatesRun") ?? []) as string[];
  const notRun = (ownGet(completeness, "gatesNotRun") ?? []) as string[];
  const malformed = (ownGet(completeness, "malformed") ?? []) as string[];
  const unknown = (ownGet(completeness, "unknown") ?? []) as string[];
  const skipped = (ownGet(completeness, "skipped") ?? []) as string[];

  // reason is null iff complete
  if (status === "complete" && reason !== null) {
    err("completeness.reason", "must be null when status is complete");
  }
  if (status !== "complete" && (reason === null || reason === undefined || String(reason).length === 0)) {
    err("completeness.reason", "must state a non-empty reason when status is not complete");
  }

  if (status === "complete") {
    if (expected.length === 0) err("completeness.gatesExpected", "cannot be empty when status is complete");
    if (notRun.length > 0) err("completeness.gatesNotRun", "must be empty when status is complete");
    if (malformed.length > 0) err("completeness.malformed", "must be empty when status is complete");
    if (unknown.length > 0) err("completeness.unknown", "must be empty when status is complete");
    if (skipped.length > 0) err("completeness.skipped", "must be empty when status is complete");
    if (!ownGet(build, "commitSha")) err("build.commitSha", "build identity is required for a complete snapshot");

    // exactly one valid fragment per expected gate
    for (const g of expected) {
      if (!hasOwn(gates, g)) {
        err(`gates.${g}`, "expected gate has no entry in a complete snapshot");
        continue;
      }
      const outcome = ownGet(ownGet(gates, g), "outcome");
      if (outcome === "not_run" || outcome === "skipped") {
        err(`gates.${g}.outcome`, `a complete snapshot cannot contain outcome "${String(outcome)}"`);
      }
      if (ownGet(ownGet(gates, g), "malformed") === true) {
        err(`gates.${g}`, "a complete snapshot cannot contain a malformed fragment");
      }
    }
  }

  // set consistency
  for (const g of notRun) {
    if (!hasOwn(gates, g) || ownGet(ownGet(gates, g), "outcome") !== "not_run") {
      err(`completeness.gatesNotRun`, `${g} is listed as not_run but its gate entry disagrees`);
    }
  }
  for (const g of skipped) {
    if (!hasOwn(gates, g) || ownGet(ownGet(gates, g), "outcome") !== "skipped") {
      err(`completeness.skipped`, `${g} is listed as skipped but its gate entry disagrees`);
    }
  }
  for (const g of run) {
    if (notRun.includes(g)) err("completeness", `${g} appears in both gatesRun and gatesNotRun`);
  }

  // summary counts must match the actual gate entries
  if (summary && typeof summary === "object" && gates && typeof gates === "object") {
    let total = 0;
    let passed = 0;
    let failed = 0;
    for (const g of ownKeys(gates)) {
      const checks = ownGet(ownGet(gates, g), "checks");
      if (!Array.isArray(checks)) continue;
      for (const c of checks) {
        total += 1;
        if (ownGet(c, "pass") === true) passed += 1;
        else failed += 1;
      }
    }
    if (ownGet(summary, "checksTotal") !== total) {
      err("summary.checksTotal", `is ${String(ownGet(summary, "checksTotal"))} but the gate entries contain ${total}`);
    }
    if (ownGet(summary, "checksPassed") !== passed) {
      err("summary.checksPassed", `is ${String(ownGet(summary, "checksPassed"))} but the gate entries contain ${passed}`);
    }
    if (ownGet(summary, "checksFailed") !== failed) {
      err("summary.checksFailed", `is ${String(ownGet(summary, "checksFailed"))} but the gate entries contain ${failed}`);
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
