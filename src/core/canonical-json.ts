import { canonicalJson as busCanonicalJson } from "../bus/canonical.js";

/**
 * C-v4.1 3.3 (M6, as amended): the one canonical JSON form, for equality,
 * fingerprints and receipt identity.
 *
 * Serialisation is `bus/canonical.ts` (JCS through `canonicalize`), so there is
 * one canonicaliser. In front of it sits the strict receipt-input validator:
 * it refuses anything JSON cannot round-trip that the bus form would rewrite
 * instead of refusing, namely `undefined` inside an array, objects that are
 * not plain (a Date, a Map, a class instance), functions, symbols, bigints and
 * cycles. Non-finite numbers, `undefined` values and lone UTF-16 surrogates
 * are refused by both. An own `__proto__` key is kept (keys are read with
 * `Object.keys`; ISS-1475 is the writer that loses it).
 */
export function canonicalJson(value: unknown): string {
  validate(value, new Set<object>(), "$");
  try {
    return busCanonicalJson(value);
  } catch (err) {
    throw new Error(`canonicalJson: ${err instanceof Error ? err.message : String(err)}; the value cannot round-trip through JSON`);
  }
}

function refuse(path: string, what: string): never {
  throw new Error(`canonicalJson: ${what} at ${path} cannot round-trip through JSON`);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function validate(value: unknown, stack: Set<object>, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) refuse(path, String(value));
      return;
    case "undefined":
      return refuse(path, "undefined");
    case "object":
      break;
    default:
      return refuse(path, `a ${typeof value}`);
  }
  const obj = value as object;
  if (stack.has(obj)) refuse(path, "a cycle");
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) validate(obj[i], stack, `${path}[${i}]`);
      return;
    }
    if (!isPlainObject(obj)) refuse(path, "a non-plain object");
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) validate(record[key], stack, `${path}.${key}`);
  } finally {
    stack.delete(obj);
  }
}
