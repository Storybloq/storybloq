import type { Argv } from "yargs";
import {
  arrayOption,
  arrayPositional,
  applyArrayValueSpec,
  type ArrayBehaviorSpec,
  type ArrayValueSpec,
} from "../../../src/cli/array-options.js";

/**
 * Negative type fixture for ISS-886.
 *
 * The safety of the design rests on claims the runtime tests cannot make: that a
 * "split" registration CANNOT compile without declaring emptyAfterSplit, that a
 * "literal" one cannot declare it, and that a positional cannot declare
 * requireValue. Those are compile-time guarantees, so they need a compile-time
 * test.
 *
 * `array-options-types.test.ts` runs tsc over this file and requires ZERO errors.
 * Each `@ts-expect-error` below therefore asserts an error exists: if a future
 * refactor collapses the discriminated union, tsc reports the directive as unused
 * and the test fails. The positive cases carry no directive, so they fail if a
 * legitimate spec stops compiling.
 *
 * Negative cases are written as single statements because `@ts-expect-error`
 * suppresses errors on the FOLLOWING line only, and a spec error is reported at
 * the argument position rather than at the offending property. Every directive
 * message is unique and listed in EXPECTED_CASES in the test, so a deleted case
 * is named rather than merely reducing a count.
 */

declare const y: Argv<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Positive controls: every shape a registration legitimately uses must compile.
// ---------------------------------------------------------------------------

const splitSpec: ArrayValueSpec = {
  comma: "split",
  empty: "drop",
  trim: "segments",
  emptyAfterSplit: "reject",
  describe: "d",
};

const literalSpec: ArrayValueSpec = {
  comma: "literal",
  empty: "preserve",
  trim: "never",
  describe: "d",
};

const requireValueSpec: ArrayValueSpec = {
  ...splitSpec,
  requireValue: "Use --clear-tags to clear tags.",
};

arrayOption(y, "ok-split", splitSpec);
arrayOption(y, "ok-literal", literalSpec);
arrayOption(y, "ok-require", requireValueSpec);
arrayPositional(y, "ok-pos", { comma: "split", empty: "preserve", trim: "segments", emptyAfterSplit: "drop", describe: "d" });
arrayPositional(y, "ok-pos-literal", { comma: "literal", empty: "drop", trim: "never", describe: "d" });
applyArrayValueSpec(["a"], "ok", { comma: "split", empty: "drop", trim: "always", emptyAfterSplit: "drop" });

// ---------------------------------------------------------------------------
// A "split" spec must declare emptyAfterSplit. This is the hole the union
// exists to close: an omitted policy would silently pick neither reject nor
// legacy-drop, and no AST or runtime test can catch it.
// ---------------------------------------------------------------------------

// @ts-expect-error split without emptyAfterSplit must not compile on arrayOption
arrayOption(y, "bad", { comma: "split", empty: "drop", trim: "segments", describe: "d" });

// Same guarantee on the low-level entry point, which takes the behavior half
// only. A Pick or Omit over the union would collapse it and restore the hole.
// @ts-expect-error split without emptyAfterSplit must not compile on applyArrayValueSpec
applyArrayValueSpec(["a"], "bad", { comma: "split", empty: "drop", trim: "segments" });

// And on the positional wrapper, whose DistributiveOmit must preserve the
// discriminant rather than flattening the union.
// @ts-expect-error split without emptyAfterSplit must not compile on arrayPositional
arrayPositional(y, "bad", { comma: "split", empty: "preserve", trim: "segments", describe: "d" });

// ---------------------------------------------------------------------------
// A "literal" spec must NOT declare emptyAfterSplit: nothing is ever split, so
// accepting the field would let a registration read as if it had a policy that
// can never run.
// ---------------------------------------------------------------------------

// @ts-expect-error emptyAfterSplit is meaningless under comma: "literal"
arrayOption(y, "bad", { comma: "literal", empty: "drop", trim: "never", emptyAfterSplit: "reject", describe: "d" });

// ---------------------------------------------------------------------------
// requireValue is structurally unavailable on a positional: yargs fires coerce
// with [] for an ABSENT variadic positional, so absent and bare cannot be told
// apart and the check would reject the absent case too.
// ---------------------------------------------------------------------------

// @ts-expect-error requireValue cannot be declared on a positional
arrayPositional(y, "bad", { comma: "split", empty: "preserve", trim: "segments", emptyAfterSplit: "drop", describe: "d", requireValue: "Use --clear." });

// ---------------------------------------------------------------------------
// The policy axes are closed sets, not free strings, and every axis is required.
// ---------------------------------------------------------------------------

// @ts-expect-error emptyAfterSplit accepts only "reject" or "drop"
arrayOption(y, "bad", { comma: "split", empty: "drop", trim: "segments", emptyAfterSplit: "ignore", describe: "d" });

// @ts-expect-error trim accepts only "always", "segments", or "never"
arrayOption(y, "bad", { comma: "split", empty: "drop", trim: "maybe", emptyAfterSplit: "drop", describe: "d" });

// @ts-expect-error a registration spec must carry a describe
arrayOption(y, "bad", { comma: "literal", empty: "drop", trim: "never" });

// @ts-expect-error an omitted trim has no safe default, so it cannot be optional
const missingTrim: ArrayBehaviorSpec = { comma: "literal", empty: "drop" };
void missingTrim;
