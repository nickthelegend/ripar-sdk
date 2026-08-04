import type { InputSchema } from "./types.js";

/**
 * A JSON Schema subset, implemented rather than depended on.
 *
 * The schema in `endpoint.input` is already published to discovery, so callers
 * build requests from it. Checking the body against that same schema *before*
 * the payment middleware is what makes a malformed call free: the caller gets a
 * 400 naming the field, and nothing was settled for a request that could never
 * have produced an answer.
 *
 * Only the keywords an endpoint author actually writes are supported. An
 * unsupported keyword is ignored rather than treated as a failure — a schema
 * this validator does not fully understand must never invent a 400.
 */
export type ValidationFailure = {
  /** Dotted path to the offending value, e.g. "opts.depth" or "items[0]". */
  field: string;
  message: string;
};

export function validateInput(schema: InputSchema | undefined, body: unknown): ValidationFailure | null {
  if (!schema) return null;
  return check(body, schema as Record<string, unknown>, "");
}

function check(value: unknown, schema: Record<string, unknown>, path: string): ValidationFailure | null {
  const label = path || "body";

  if (schema.type != null) {
    const want = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!want.some((t) => matchesType(value, t))) {
      return {
        field: label,
        message: `${label} must be ${want.join(" or ")}, got ${describe(value)}.`,
      };
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((v) => deepEqual(v, value))) {
    return { field: label, message: `${label} must be one of ${schema.enum.map(json).join(", ")}.` };
  }

  if ("const" in schema && !deepEqual(schema.const, value)) {
    return { field: label, message: `${label} must be ${json(schema.const)}.` };
  }

  if (typeof value === "string") {
    const f = checkString(value, schema, label);
    if (f) return f;
  }

  if (typeof value === "number") {
    const f = checkNumber(value, schema, label);
    if (f) return f;
  }

  if (Array.isArray(value)) {
    const f = checkArray(value, schema, path, label);
    if (f) return f;
  }

  if (isPlainObject(value)) {
    const f = checkObject(value, schema, path);
    if (f) return f;
  }

  return null;
}

function checkString(value: string, schema: Record<string, unknown>, label: string): ValidationFailure | null {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    return { field: label, message: `${label} must be at least ${schema.minLength} characters.` };
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return { field: label, message: `${label} must be at most ${schema.maxLength} characters.` };
  }
  if (typeof schema.pattern === "string") {
    // A malformed pattern is the endpoint author's bug, not the caller's — do
    // not turn it into a 400 that no request could ever satisfy.
    let re: RegExp | null = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      re = null;
    }
    if (re && !re.test(value)) {
      return { field: label, message: `${label} must match ${schema.pattern}.` };
    }
  }
  return null;
}

function checkNumber(value: number, schema: Record<string, unknown>, label: string): ValidationFailure | null {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    return { field: label, message: `${label} must be at least ${schema.minimum}.` };
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    return { field: label, message: `${label} must be at most ${schema.maximum}.` };
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    return { field: label, message: `${label} must be greater than ${schema.exclusiveMinimum}.` };
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    return { field: label, message: `${label} must be less than ${schema.exclusiveMaximum}.` };
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const q = value / schema.multipleOf;
    if (Math.abs(q - Math.round(q)) > 1e-9) {
      return { field: label, message: `${label} must be a multiple of ${schema.multipleOf}.` };
    }
  }
  return null;
}

function checkArray(
  value: unknown[],
  schema: Record<string, unknown>,
  path: string,
  label: string
): ValidationFailure | null {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    return { field: label, message: `${label} must have at least ${schema.minItems} items.` };
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    return { field: label, message: `${label} must have at most ${schema.maxItems} items.` };
  }
  if (isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const f = check(value[i], schema.items as Record<string, unknown>, `${path || "body"}[${i}]`);
      if (f) return f;
    }
  }
  return null;
}

function checkObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string
): ValidationFailure | null {
  const props = isPlainObject(schema.properties) ? (schema.properties as Record<string, unknown>) : {};

  if (Array.isArray(schema.required)) {
    for (const key of schema.required as string[]) {
      if (value[key] === undefined) {
        const field = join(path, key);
        return { field, message: `${field} is required.` };
      }
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(props));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        const field = join(path, key);
        return { field, message: `${field} is not a recognised field.` };
      }
    }
  }

  for (const [key, sub] of Object.entries(props)) {
    if (value[key] === undefined || !isPlainObject(sub)) continue;
    const f = check(value[key], sub as Record<string, unknown>, join(path, key));
    if (f) return f;
  }

  return null;
}

function matchesType(value: unknown, type: string) {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword: not our place to reject
  }
}

function describe(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function join(path: string, key: string) {
  return path ? `${path}.${key}` : key;
}

function json(v: unknown) {
  return typeof v === "string" ? `"${v}"` : String(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}
