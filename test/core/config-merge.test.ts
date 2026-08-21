import { describe, it, expect } from "vitest";
import {
  deepMergeConfig,
  findDuplicateKeyPath,
  assertNoDuplicateKeys,
  isPlainObject,
  ConfigMergeError,
} from "../../src/core/config-merge.js";

/**
 * THE SHARED MERGE TABLE (T-469, ISS-1026).
 *
 * Every case here has a byte-identical twin in the Mac app's
 * `OrderedJSONDeepMergeTests.swift`. Two implementations of one contract stay
 * honest only if the same table is run against both, so a case added on one
 * side is not done until it exists on the other.
 *
 * The pairs are written as (destination, patch, expected) so the expectation is
 * the WHOLE resulting tree, not a spot check. A merge bug usually shows up as
 * something that should not have moved, and only a whole-tree assertion catches
 * that.
 */
const TABLE: ReadonlyArray<{
  name: string;
  dst: Record<string, unknown>;
  patch: Record<string, unknown>;
  expected: Record<string, unknown>;
}> = [
  {
    name: "a nested set preserves siblings at every depth",
    dst: {
      stages: {
        PLAN_REVIEW: { backends: ["codex"] },
        CODE_REVIEW: { backends: ["lenses"], maxReviewRounds: 6 },
      },
      lensConfig: { lenses: ["security"], maxLenses: 2 },
      branchStrategy: "per-ticket",
    },
    patch: { stages: { CODE_REVIEW: { maxReviewRounds: 8 } } },
    expected: {
      stages: {
        PLAN_REVIEW: { backends: ["codex"] },
        CODE_REVIEW: { backends: ["lenses"], maxReviewRounds: 8 },
      },
      lensConfig: { lenses: ["security"], maxLenses: 2 },
      branchStrategy: "per-ticket",
    },
  },
  {
    name: "null deletes at depth and leaves the empty ancestor in place",
    dst: { stages: { CODE_REVIEW: { maxReviewRounds: 6 } } },
    patch: { stages: { CODE_REVIEW: { maxReviewRounds: null } } },
    expected: { stages: { CODE_REVIEW: {} } },
  },
  {
    name: "null on an absent key is a no-op, not an insertion",
    dst: { a: 1 },
    patch: { b: null, c: { d: null } },
    expected: { a: 1, c: {} },
  },
  {
    name: "null nested in a newly inserted subtree is simply absent",
    dst: {},
    patch: { stages: { CODE_REVIEW: { keep: 1, drop: null } } },
    expected: { stages: { CODE_REVIEW: { keep: 1 } } },
  },
  {
    name: "an absent destination is promoted to an object",
    dst: { other: true },
    patch: { stages: { CODE_REVIEW: { maxReviewRounds: 4 } } },
    expected: { other: true, stages: { CODE_REVIEW: { maxReviewRounds: 4 } } },
  },
  {
    name: "a scalar destination is replaced by the merged object, not merged into",
    dst: { stages: 7 },
    patch: { stages: { CODE_REVIEW: { maxReviewRounds: 4 } } },
    expected: { stages: { CODE_REVIEW: { maxReviewRounds: 4 } } },
  },
  {
    name: "an array destination is replaced by the merged object",
    dst: { stages: [1, 2, 3] },
    patch: { stages: { CODE_REVIEW: {} } },
    expected: { stages: { CODE_REVIEW: {} } },
  },
  {
    name: "an array REPLACES and never concatenates",
    dst: { lensConfig: { lenses: ["security", "concurrency", "clean-code"] } },
    patch: { lensConfig: { lenses: ["security"] } },
    expected: { lensConfig: { lenses: ["security"] } },
  },
  {
    name: "a null ELEMENT inside an array is data, not a deletion",
    dst: { a: [1, 2] },
    patch: { a: [1, null, 3] },
    expected: { a: [1, null, 3] },
  },
  {
    name: "an empty array replaces a populated one",
    dst: { lensConfig: { lenses: ["security"] } },
    patch: { lensConfig: { lenses: [] } },
    expected: { lensConfig: { lenses: [] } },
  },
  {
    name: "an object destination is replaced by a scalar",
    dst: { lensConfig: { lenses: ["security"] } },
    patch: { lensConfig: 3 },
    expected: { lensConfig: 3 },
  },
  {
    name: "an empty patch is a no-op",
    dst: { a: 1, b: { c: 2 } },
    patch: {},
    expected: { a: 1, b: { c: 2 } },
  },
  {
    name: "an explicit empty object never clears an object destination",
    dst: { stages: { CODE_REVIEW: { maxReviewRounds: 6 } } },
    patch: { stages: {} },
    expected: { stages: { CODE_REVIEW: { maxReviewRounds: 6 } } },
  },
  {
    name: "an explicit empty object creates one on a non-object destination",
    dst: { stages: 5 },
    patch: { stages: {} },
    expected: { stages: {} },
  },
  {
    name: "false and 0 are values, not deletions",
    dst: { a: true, b: 9 },
    patch: { a: false, b: 0 },
    expected: { a: false, b: 0 },
  },
  {
    name: "deleting the last leaf leaves every empty ancestor standing",
    dst: { a: { b: { c: { d: 1 } } } },
    patch: { a: { b: { c: { d: null } } } },
    expected: { a: { b: { c: {} } } },
  },
];

describe("deepMergeConfig -- the shared contract table", () => {
  for (const row of TABLE) {
    it(row.name, () => {
      expect(deepMergeConfig(row.dst, row.patch)).toEqual(row.expected);
    });
  }

  it("never mutates the destination", () => {
    const dst = { stages: { CODE_REVIEW: { maxReviewRounds: 6 } } };
    const frozenCopy = structuredClone(dst);
    deepMergeConfig(dst, { stages: { CODE_REVIEW: { maxReviewRounds: 9 } } });
    expect(dst).toEqual(frozenCopy);
  });

  // Refusing rather than skipping is the point: a delta carrying one of these
  // is not a delta we authored, and dropping it quietly would hide that.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    it(`refuses the whole write for a top-level ${key}`, () => {
      // Written through JSON.parse because a bare object literal with a
      // `__proto__` key sets the prototype instead of creating a key, so the
      // literal form would silently test nothing.
      const patch = JSON.parse(`{"${key}": {"polluted": true}}`) as Record<string, unknown>;
      expect(() => deepMergeConfig({}, patch)).toThrow(ConfigMergeError);
    });

    it(`refuses the whole write for a nested ${key}`, () => {
      const patch = JSON.parse(`{"stages": {"${key}": {"polluted": true}}}`) as Record<string, unknown>;
      expect(() => deepMergeConfig({}, patch)).toThrow(/stages\./);
    });
  }

  it("does not pollute Object.prototype even in the refusal path", () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(() => deepMergeConfig({}, patch)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("isPlainObject", () => {
  it("treats arrays as NOT plain, which is what makes them opaque", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject({})).toBe(true);
  });
});

describe("findDuplicateKeyPath", () => {
  it("finds a duplicate at the root", () => {
    expect(findDuplicateKeyPath('{"a": 1, "a": 2}')).toBe("a");
  });

  it("finds a duplicate nested inside recipeOverrides", () => {
    const text = '{"recipeOverrides": {"stages": {"CODE_REVIEW": {"maxReviewRounds": 1, "maxReviewRounds": 2}}}}';
    expect(findDuplicateKeyPath(text)).toBe("recipeOverrides.stages.CODE_REVIEW.maxReviewRounds");
  });

  it("finds a duplicate inside an array element", () => {
    expect(findDuplicateKeyPath('{"a": [{"b": 1, "b": 2}]}')).toBe("a.[0].b");
  });

  it("does not confuse a repeated key in SIBLING objects for a duplicate", () => {
    expect(findDuplicateKeyPath('{"a": {"x": 1}, "b": {"x": 2}}')).toBeNull();
  });

  it("does not read a key-like substring inside a string value", () => {
    expect(findDuplicateKeyPath('{"a": "\\"a\\": 1, \\"a\\": 2"}')).toBeNull();
  });

  it("handles escaped quotes and backslashes in keys without losing its place", () => {
    expect(findDuplicateKeyPath('{"a\\\\": 1, "b": 2}')).toBeNull();
    // The path is the DECODED key, not the source spelling. Reporting `a\"b`
    // would be reporting a key that does not exist in either parser's view of
    // the file, and the message tells a user which key to go delete.
    expect(findDuplicateKeyPath('{"a\\"b": 1, "a\\"b": 2}')).toBe('a"b');
  });

  /**
   * ESCAPE EQUIVALENCE.
   *
   * These are the cases that decide whether the check is doing its job or
   * performing it. Duplicate detection exists because `JSON.parse` and the Mac
   * app's `OrderedJSON` resolve a duplicated key differently, and BOTH decode
   * escapes before comparing -- so `"a"` and `"a"` are one key to both of
   * them, and a config carrying that pair carries the exact ambiguity this
   * check refuses to merge into.
   *
   * A scanner comparing raw escape text would call every one of these clean and
   * wave the file straight through. It would still pass every byte-identical
   * duplicate test above, which is why those tests alone do not pin this.
   */
  it("sees a literal key and its \\u spelling as ONE key", () => {
    expect(findDuplicateKeyPath('{"a": 1, "\\u0061": 2}')).toBe("a");
  });

  it("sees an escaped and unescaped solidus as ONE key", () => {
    expect(findDuplicateKeyPath('{"/": 1, "\\/": 2}')).toBe("/");
  });

  it("sees two spellings of an astral character as ONE key", () => {
    expect(findDuplicateKeyPath('{"\\ud83d\\ude00": 1, "\u{1F600}": 2}')).toBe("\u{1F600}");
  });

  it("still separates keys that merely LOOK alike after decoding", () => {
    // The mirror of the cases above: decoding must not over-merge either.
    expect(findDuplicateKeyPath('{"a": 1, "\\u0041": 2}')).toBeNull(); // a vs A
  });

  it("reports the decoded path for a nested escaped duplicate", () => {
    expect(findDuplicateKeyPath('{"st\\u0061ges": {"x": 1, "x": 2}}')).toBe("stages.x");
  });

  it("returns null on clean input of every shape", () => {
    expect(findDuplicateKeyPath('{"a": [1, 2, {"b": null}], "c": true, "d": -1.5e3}')).toBeNull();
  });

  it("leaves malformed JSON to the real parser rather than guessing", () => {
    expect(findDuplicateKeyPath("{oops")).toBeNull();
  });

  /**
   * TERMINATION ON TRUNCATED INPUT.
   *
   * This scanner runs on caller-supplied text BEFORE the real parser gets to
   * report a syntax error, so "malformed" is not a rare case here -- it is
   * whatever a user typed into `--json`. An unterminated container used to make
   * the array and object loops call `scanValue` at end-of-input forever, which
   * hung the command outright on input as small as `--json '{"a": ['`.
   *
   * These assert null, but what they really assert is RETURNING: a regression
   * shows up as the test timing out, not as a wrong value.
   */
  for (const text of [
    "[",
    "[1",
    "[1,",
    "{",
    '{"a"',
    '{"a":',
    '{"a": [',
    '{"a": [1',
    '{"a": {"b": [',
    '{"a": [[[[',
    '{"a": "unterminated',
    '{"a": [{"b": 1}',
  ]) {
    it(`returns rather than spinning on truncated input ${JSON.stringify(text)}`, () => {
      expect(findDuplicateKeyPath(text)).toBeNull();
    });
  }

  it("still finds a duplicate that occurs BEFORE the truncation", () => {
    // Bailing out must not mean bailing out early: everything already scanned
    // is still evidence.
    expect(findDuplicateKeyPath('{"a": 1, "a": 2, "b": [')).toBe("a");
  });
});

describe("findDuplicateKeyPath refuses rather than guessing when it cannot finish", () => {
  /**
   * Deep nesting is not malformed -- `JSON.parse` handles 50000 levels without
   * complaint -- so a config carrying it LOADS, and then reaches a recursive
   * scanner that blows the stack. Before the depth guard this surfaced as a
   * `RangeError` escaping every `ConfigMergeError` catch on the write path, so
   * a valid-but-absurd config crashed the command instead of being refused by
   * it.
   */
  it("refuses input nested deeper than it will descend, rather than crashing", () => {
    const deep = `{"a":${"[".repeat(50_000)}${"]".repeat(50_000)}}`;
    expect(() => JSON.parse(deep)).not.toThrow(); // the real parser is fine with it
    expect(() => findDuplicateKeyPath(deep)).toThrow(ConfigMergeError);
    expect(() => findDuplicateKeyPath(deep)).toThrow(/nests deeper than/);
  });

  it("accepts nesting a real config could plausibly reach", () => {
    // The cap must not be so tight that it refuses ordinary structures.
    const nested = `{${'"a":{'.repeat(50)}"x":1${"}".repeat(50)}}`;
    expect(findDuplicateKeyPath(nested)).toBeNull();
  });

  // NOTE: the step budget has no test, deliberately. No input trips it while
  // the progress guards hold, and a test that reached it by nesting 300 deep
  // would be exercising the DEPTH cap while claiming to pin the budget. The
  // budget exists as an unconditional termination backstop; what pins it is the
  // mutation check recorded on it, not an assertion that cannot reach it.
});

describe("assertNoDuplicateKeys", () => {
  it("names the path and the file so the error is actionable", () => {
    expect(() => assertNoDuplicateKeys('{"a": {"b": 1, "b": 2}}', "config.json"))
      .toThrow(/config\.json contains a duplicate key at "a\.b"/);
  });

  it("passes clean text", () => {
    expect(() => assertNoDuplicateKeys('{"a": 1}', "config.json")).not.toThrow();
  });
});
