/**
 * C-v4.1 3.3 (M6): the one canonical JSON form, for equality, fingerprints and
 * receipt identity.
 *
 * Keys are sorted at every depth and the output has no whitespace. The walk
 * reads keys with `Object.keys` and writes the output string directly; it
 * never assigns into a plain object, so an own `__proto__` key survives
 * (ISS-1475 is the writer that loses it).
 *
 * It refuses anything JSON cannot round-trip: non-finite numbers, `undefined`
 * (as a value or inside an array), and objects that are not plain (a Date, a
 * Map, a class instance), as well as functions, symbols, bigints and cycles.
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set<object>(), "$");
}

function refuse(path: string, what: string): never {
  throw new Error(`canonicalJson: ${what} at ${path} cannot round-trip through JSON`);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, stack: Set<object>, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) refuse(path, String(value));
      return JSON.stringify(value);
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
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) parts.push(write(obj[i], stack, `${path}[${i}]`));
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(obj)) refuse(path, "a non-plain object");
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) parts.push(`${JSON.stringify(key)}:${write(record[key], stack, `${path}.${key}`)}`);
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}
