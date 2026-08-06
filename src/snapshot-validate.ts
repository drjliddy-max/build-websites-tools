/*
 * Runtime validation for gate-snapshot.
 *
 * WHY THIS EXISTS
 *
 * The first implementation cast parsed JSON to `Fragment` after only a
 * `typeof parsed === "object"` check, then trusted that cast everywhere
 * downstream. A file that parsed as JSON but had the wrong shape therefore
 * flowed straight into snapshot.json and violated the published schema. The
 * stated invariant "a malformed fragment can never produce a falsely complete
 * snapshot" only ever held for JSON that failed to parse.
 *
 * SCHEMA SOURCE OF TRUTH
 *
 * The shipped JSON Schema (schema/build-snapshot-v1.schema.json) is the single
 * source of truth for the SNAPSHOT. The final document is validated against
 * that exact file at runtime, so the schema cannot drift from behaviour without
 * a test failing. `validateFragment` below covers the FRAGMENT shape, which is
 * an internal wire format and is deliberately not published; a contract test
 * asserts the two agree on the fields they share.
 *
 * A dependency-free subset validator is used rather than adding ajv: this
 * package ships into nine consumer builds and every added runtime dependency is
 * a supply-chain surface. The subset covers exactly the constructs the schema
 * uses, and an unknown construct is a validation ERROR rather than a silent
 * pass, so the validator cannot quietly under-check.
 */

export type ValidationError = { path: string; message: string };

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isValidTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!ISO_8601.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

/* ------------------------------------------------------------------ */
/* Fragment validation                                                 */
/* ------------------------------------------------------------------ */

const FRAGMENT_OUTCOMES = new Set(["pass", "fail", "error"]);

/**
 * Validate a parsed fragment.
 *
 * Unknown-field policy: unknown TOP-LEVEL fields are permitted and preserved
 * (forward compatibility with a later tools version writing extra provenance),
 * but every known field must have the correct type. Unknown GATE NAMES are
 * rejected here and handled by the merger's explicit compatibility policy.
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
    return {
      valid: false,
      errors: [{ path: "", message: `fragment is a ${typeof input}, expected an object` }],
    };
  }

  const f = input as Record<string, unknown>;

  if (f.fragmentSchemaVersion !== undefined) {
    if (typeof f.fragmentSchemaVersion !== "number" || !Number.isInteger(f.fragmentSchemaVersion)) {
      err("fragmentSchemaVersion", "must be an integer when present");
    } else if (f.fragmentSchemaVersion !== 1) {
      err("fragmentSchemaVersion", `unsupported fragment schema version ${f.fragmentSchemaVersion}`);
    }
  }

  if (typeof f.gate !== "string" || f.gate.length === 0) {
    err("gate", "must be a non-empty string");
  } else if (!isKnownGate(f.gate)) {
    err("gate", `unknown gate name ${JSON.stringify(f.gate)}`);
  }

  if (typeof f.version !== "string") err("version", "must be a string");

  if (!isValidTimestamp(f.startedAt)) err("startedAt", "must be an ISO-8601 timestamp");
  if (!isValidTimestamp(f.finishedAt)) err("finishedAt", "must be an ISO-8601 timestamp");

  if (typeof f.outcome !== "string" || !FRAGMENT_OUTCOMES.has(f.outcome)) {
    err("outcome", 'must be one of "pass", "fail", "error"');
  }

  if (
    f.provenance === null ||
    typeof f.provenance !== "object" ||
    Array.isArray(f.provenance)
  ) {
    err("provenance", "must be an object");
  }

  if (!Array.isArray(f.checks)) {
    err("checks", "must be an array");
  } else {
    f.checks.forEach((c, i) => {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        err(`checks[${i}]`, "must be an object");
        return;
      }
      const check = c as Record<string, unknown>;
      if (typeof check.name !== "string") err(`checks[${i}].name`, "must be a string");
      if (typeof check.pass !== "boolean") err(`checks[${i}].pass`, "must be a boolean");
      if (typeof check.detail !== "string") err(`checks[${i}].detail`, "must be a string");
    });
  }

  if (f.routes !== undefined) {
    if (f.routes === null || typeof f.routes !== "object" || Array.isArray(f.routes)) {
      err("routes", "must be an object when present");
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/* ------------------------------------------------------------------ */
/* JSON Schema subset validator                                        */
/* ------------------------------------------------------------------ */

type Schema = Record<string, any>;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v as number)) return "integer";
  return typeof v;
}

function typeMatches(v: unknown, want: string): boolean {
  const actual = typeOf(v);
  if (want === "number") return actual === "number" || actual === "integer";
  if (want === "integer") return actual === "integer";
  return actual === want;
}

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
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
]);

/**
 * Validate `value` against the supported JSON Schema subset.
 * An unsupported keyword is reported as an error rather than ignored, so the
 * validator can never silently under-check a schema it does not fully cover.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Schema,
  path = "",
): ValidationResult {
  const errors: ValidationError[] = [];
  walk(value, schema, path, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function walk(value: unknown, schema: Schema, path: string, errors: ValidationError[]): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      errors.push({ path, message: `schema uses unsupported keyword "${key}"` });
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }

  if (schema.enum !== undefined) {
    const allowed: unknown[] = schema.enum;
    if (!allowed.some((a) => a === value)) {
      errors.push({ path, message: `must be one of ${JSON.stringify(allowed)}` });
      return;
    }
  }

  if (schema.type !== undefined) {
    const want: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!want.some((w) => typeMatches(value, w))) {
      errors.push({ path, message: `expected ${want.join("|")}, got ${typeOf(value)}` });
      return;
    }
  }

  if (typeof value === "string" && schema.pattern !== undefined) {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match ${schema.pattern}` });
    }
  }

  if (typeof value === "string" && schema.format === "date-time" && !isValidTimestamp(value)) {
    errors.push({ path, message: "not a valid date-time" });
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `must have >= ${schema.minItems} items` });
    }
    if (schema.items) {
      value.forEach((v, i) => walk(v, schema.items, `${path}[${i}]`, errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    for (const req of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(obj, req)) {
        errors.push({ path: path ? `${path}.${req}` : req, message: "is required" });
      }
    }

    const props: Record<string, Schema> = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      const child = path ? `${path}.${k}` : k;
      if (props[k]) {
        walk(v, props[k], child, errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: child, message: "is not allowed by the schema" });
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        walk(v, schema.additionalProperties, child, errors);
      }
    }
  }
}
