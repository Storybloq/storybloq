import { describe, it, expect, beforeEach } from "vitest";
import {
  applyArrayValueSpec,
  takeArrayOptionError,
  resetArrayOptionError,
  type ArrayBehaviorSpec,
} from "../../src/cli/array-options.js";
import { CliValidationError } from "../../src/cli/helpers.js";

// The four combinations actually used by registrations (ISS-886). Keeping them
// named here means a test failure names the registration family it breaks.
const NEWLY_SPLIT: ArrayBehaviorSpec = {
  comma: "split",
  empty: "drop",
  trim: "segments",
  emptyAfterSplit: "reject",
};
const LEGACY_SPLIT: ArrayBehaviorSpec = {
  comma: "split",
  empty: "drop",
  trim: "always",
  emptyAfterSplit: "drop",
};
const DISPATCH: ArrayBehaviorSpec = {
  comma: "split",
  empty: "preserve",
  trim: "segments",
  emptyAfterSplit: "drop",
};
const LITERAL_DROP: ArrayBehaviorSpec = { comma: "literal", empty: "drop", trim: "never" };
const LITERAL_KEEP: ArrayBehaviorSpec = { comma: "literal", empty: "preserve", trim: "never" };

const apply = (values: unknown, spec: ArrayBehaviorSpec, flag = "flag") =>
  applyArrayValueSpec(values, flag, spec);

beforeEach(() => {
  // Clear any error stashed by a previous test's throw.
  resetArrayOptionError();
});

describe("applyArrayValueSpec: absence contract", () => {
  it("maps undefined to undefined so an omitted flag never clears a field", () => {
    expect(apply(undefined, NEWLY_SPLIT)).toBeUndefined();
    expect(apply(undefined, LITERAL_KEEP)).toBeUndefined();
  });

  it("maps a present empty array to an empty array", () => {
    expect(apply([], NEWLY_SPLIT)).toEqual([]);
  });
});

describe("applyArrayValueSpec: comma policy", () => {
  it("splits comma expressions under split", () => {
    expect(apply(["a,b,c"], NEWLY_SPLIT)).toEqual(["a", "b", "c"]);
    expect(apply(["a,b", "c"], NEWLY_SPLIT)).toEqual(["a", "b", "c"]);
  });

  it("tolerates leading, trailing, and repeated separators", () => {
    expect(apply([",b"], NEWLY_SPLIT)).toEqual(["b"]);
    expect(apply(["a,"], NEWLY_SPLIT)).toEqual(["a"]);
    expect(apply(["a,,b"], NEWLY_SPLIT)).toEqual(["a", "b"]);
  });

  it("leaves commas alone under literal, including in paths and free text", () => {
    expect(apply(["reports/a,b.json"], LITERAL_KEEP)).toEqual(["reports/a,b.json"]);
    expect(apply(["src/a,b.ts:10"], LITERAL_DROP)).toEqual(["src/a,b.ts:10"]);
    expect(apply(["engine:calls A, then B"], LITERAL_KEEP)).toEqual(["engine:calls A, then B"]);
  });
});

describe("applyArrayValueSpec: trim policy", () => {
  it("segments leaves a value with no comma untouched", () => {
    // The invariant that makes this safe to land: non-comma input is byte-for-byte
    // what it was before ISS-886.
    expect(apply([" a "], NEWLY_SPLIT)).toEqual([" a "]);
  });

  it("segments still trims parts produced by a split", () => {
    expect(apply(["a , b"], NEWLY_SPLIT)).toEqual(["a", "b"]);
  });

  it("always trims every value, matching depends-on and cross-node behavior", () => {
    expect(apply([" a "], LEGACY_SPLIT)).toEqual(["a"]);
    expect(apply([" a , b "], LEGACY_SPLIT)).toEqual(["a", "b"]);
  });

  it("never leaves whitespace intact", () => {
    expect(apply([" a "], LITERAL_KEEP)).toEqual([" a "]);
  });
});

describe("applyArrayValueSpec: empty policy", () => {
  it("drop discards blank and whitespace-only values", () => {
    expect(apply(["a", "", "  "], NEWLY_SPLIT)).toEqual(["a"]);
    expect(apply(["  "], LITERAL_DROP)).toEqual([]);
  });

  it("preserve keeps them so downstream validation still sees them", () => {
    // --source-ref, --link, and bus --file all rely on this: dropping a blank
    // would turn a loud downstream failure into a silent no-op.
    expect(apply(["  "], LITERAL_KEEP)).toEqual(["  "]);
    expect(apply([""], DISPATCH)).toEqual([""]);
  });
});

describe("applyArrayValueSpec: emptyAfterSplit", () => {
  it("rejects a separator-only value under reject", () => {
    expect(() => apply([","], NEWLY_SPLIT)).toThrow(CliValidationError);
    expect(() => apply([",,"], NEWLY_SPLIT)).toThrow(CliValidationError);
  });

  it("evaluates per value, so a valid sibling cannot mask a stray separator", () => {
    // Regression for the aggregate-evaluation bug: with the check applied across
    // the whole argv list, "a" kept the result non-empty and "," was silently
    // dropped, even though today it either fails loudly or is stored verbatim.
    expect(() => apply(["a", ","], NEWLY_SPLIT)).toThrow(CliValidationError);
    expect(() => apply([",", "b"], NEWLY_SPLIT)).toThrow(CliValidationError);
    expect(() => apply(["a", ",", "b"], NEWLY_SPLIT)).toThrow(CliValidationError);
  });

  it("names the offending value so multi-value input is diagnosable", () => {
    expect(() => apply(["T-001", ","], NEWLY_SPLIT, "blocked-by")).toThrow(
      /--blocked-by was given ",", which contains separators but no values/,
    );
  });

  it("does not fire for a blank value with no comma", () => {
    // Whitespace-only input already cleared these fields before ISS-886.
    expect(apply([" "], NEWLY_SPLIT)).toEqual([]);
  });

  it("drop preserves the pre-existing clearing behavior of legacy split options", () => {
    expect(apply([","], LEGACY_SPLIT)).toEqual([]);
    expect(apply([",,"], DISPATCH)).toEqual(["", "", ""]);
  });
});

describe("applyArrayValueSpec: requireValue", () => {
  const withRequire: ArrayBehaviorSpec = {
    ...NEWLY_SPLIT,
    requireValue: "Use --clear-tags to clear tags.",
  };

  it("rejects a bare flag and carries the registration-specific remedy", () => {
    expect(() => apply([], withRequire, "tags")).toThrow(
      "--tags requires at least one value. Use --clear-tags to clear tags.",
    );
  });

  it("accepts any non-empty result", () => {
    expect(apply(["a"], withRequire, "tags")).toEqual(["a"]);
  });

  it("is inert when unset, so options with no clear flag keep bare-flag clearing", () => {
    expect(apply([], NEWLY_SPLIT)).toEqual([]);
  });
});

describe("applyArrayValueSpec: non-string guard", () => {
  it("rejects rather than silently dropping", () => {
    // Under the previous type "array" registration, `--tags 2026` parsed as a
    // number and was silently discarded by tag normalization (ISS-886).
    expect(() => apply([2026], NEWLY_SPLIT, "tags")).toThrow(CliValidationError);
    expect(() => apply([2026], NEWLY_SPLIT, "tags")).toThrow(/non-string value/);
  });

  it("rejects a non-array value", () => {
    expect(() => apply("a,b", NEWLY_SPLIT)).toThrow(CliValidationError);
  });
});

describe("takeArrayOptionError", () => {
  it("recovers the original error by message", () => {
    // yargs wraps a coerce throw in YError, discarding the class and its code,
    // so the CLI failure handler recovers the code through this channel.
    expect(() => apply([","], NEWLY_SPLIT, "blocked-by")).toThrow();
    const recovered = takeArrayOptionError(
      '--blocked-by was given ",", which contains separators but no values.',
    );
    expect(recovered).toBeInstanceOf(CliValidationError);
    expect(recovered?.code).toBe("invalid_input");
  });

  it("returns null when the message does not match, so a stale error is never reused", () => {
    expect(() => apply([","], NEWLY_SPLIT, "blocked-by")).toThrow();
    expect(takeArrayOptionError("some unrelated yargs message")).toBeNull();
  });

  it("clears the slot after a read", () => {
    expect(() => apply([","], NEWLY_SPLIT, "tags")).toThrow();
    const message = '--tags was given ",", which contains separators but no values.';
    expect(takeArrayOptionError(message)).not.toBeNull();
    expect(takeArrayOptionError(message)).toBeNull();
  });
});

describe("resetArrayOptionError", () => {
  // The e2e suite cannot reach this: each CLI invocation is its own process with
  // exactly one root parse, so a cross-parse leak is only observable in-process.
  const MESSAGE = '--tags was given ",", which contains separators but no values.';

  it("drops a stashed error so a later parse cannot match it", () => {
    // The leak this prevents: a coerce failure on a parser built WITHOUT the root
    // .fail handler leaves the slot set, and a subsequent parse producing a
    // same-message YError would then recover an error from the earlier one.
    expect(() => apply([","], NEWLY_SPLIT, "tags")).toThrow();
    resetArrayOptionError();
    expect(takeArrayOptionError(MESSAGE)).toBeNull();
  });

  it("is safe to call with nothing stashed", () => {
    // Called unconditionally before every parse and again in a finally, so both
    // the empty and the already-consumed cases have to be no-ops.
    resetArrayOptionError();
    resetArrayOptionError();
    expect(takeArrayOptionError(MESSAGE)).toBeNull();
  });

  it("leaves a freshly stashed error recoverable, so the reset is not overreaching", () => {
    // Guards the opposite failure: a reset placed or scoped wrongly would make
    // every array-option error report as io_error instead of invalid_input.
    resetArrayOptionError();
    expect(() => apply([","], NEWLY_SPLIT, "tags")).toThrow();
    expect(takeArrayOptionError(MESSAGE)?.code).toBe("invalid_input");
  });
});
