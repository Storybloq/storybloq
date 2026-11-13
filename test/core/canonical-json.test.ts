import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/core/canonical-json.js";
import { canonicalJson as busCanonicalJson } from "../../src/bus/canonical.js";

/**
 * C-v4.1 3.3 (M6): one canonical form for equality, fingerprints and receipt
 * identity. Keys sorted at every depth, no whitespace, and nothing JSON cannot
 * round-trip.
 */
describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [3, { d: true, c: null }], c: "x" })).toBe('{"a":[3,{"c":null,"d":true}],"b":1,"c":"x"}');
  });

  it("gives the same string for the same content in any key order", () => {
    expect(canonicalJson({ x: { q: 1, p: 2 }, y: [1] })).toBe(canonicalJson({ y: [1], x: { p: 2, q: 1 } }));
  });

  it("keeps an own __proto__ key and round-trips it through JSON.parse", () => {
    const parsed = JSON.parse('{"z":1,"__proto__":{"polluted":true},"a":2}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    const text = canonicalJson(parsed);
    expect(text).toBe('{"__proto__":{"polluted":true},"a":2,"z":1}');
    const back = JSON.parse(text) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(back, "__proto__")).toBe(true);
    expect(canonicalJson(back)).toBe(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("escapes strings exactly as JSON.stringify does", () => {
    const s = 'quote " back \\ line\n tab\t u2028   nul \u0000 é';
    expect(canonicalJson({ s })).toBe(`{"s":${JSON.stringify(s)}}`);
  });

  it("writes numbers, booleans and null as JSON does", () => {
    expect(canonicalJson([0, -0, 1.5, 1e21, true, false, null])).toBe(JSON.stringify([0, -0, 1.5, 1e21, true, false, null]));
  });

  it.each([
    ["NaN", { n: Number.NaN }],
    ["Infinity", [Number.POSITIVE_INFINITY]],
    ["-Infinity", { n: Number.NEGATIVE_INFINITY }],
    ["undefined in an array", [1, undefined]],
    ["undefined as a value", { u: undefined }],
    ["a Date", { d: new Date(0) }],
    ["a Map", { m: new Map() }],
    ["a class instance", { c: new (class Box { v = 1; })() }],
    ["a function", { f: () => 1 }],
    ["a bigint", { b: 1n }],
    ["a symbol", { s: Symbol("s") }],
  ])("refuses %s, which JSON cannot round-trip", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(/canonicalJson/);
  });

  it("accepts a null-prototype object as plain", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 2;
    o.a = 1;
    expect(canonicalJson(o)).toBe('{"a":1,"b":2}');
  });

  it("refuses a cycle", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/canonicalJson/);
  });

  describe("one canonicaliser (amendment to 3.3): serialisation is bus/canonical.ts behind the strict receipt validator", () => {
    it.each([
      ["a lone high surrogate in a value", { s: "a\ud800b" }],
      ["a lone low surrogate in a value", ["\udc00"]],
      ["a lone surrogate in a key", { ["k\ud800"]: 1 }],
    ])("refuses %s, exactly where the bus canonicaliser refuses", (_label, value) => {
      expect(() => busCanonicalJson(value)).toThrow();
      expect(() => canonicalJson(value)).toThrow(/canonicalJson/);
    });

    it("writes the same text as bus/canonical.ts, own __proto__ key and surrogate pairs included", () => {
      const parsed = JSON.parse('{"z":[1,-0,1e21,"\\ud83d\\ude00"],"__proto__":{"b":true,"a":null},"a":"q\\u2028"}') as unknown;
      expect(canonicalJson(parsed)).toBe(busCanonicalJson(parsed));
      expect(canonicalJson(parsed)).toContain('"__proto__":{"a":null,"b":true}');
    });
  });
});
