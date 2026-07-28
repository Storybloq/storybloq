import type { Argv } from "yargs";
import { CliValidationError } from "./helpers.js";

/**
 * How a comma inside a single parsed value is treated.
 *
 * "split"   - the value is split on commas. For lists of atomic values (ids,
 *             slugs, tags) where a comma can never be part of one legitimate value.
 * "literal" - the value is left whole. For payloads where a comma is legal:
 *             file paths, free text, JSON.
 */
export type CommaPolicy = "split" | "literal";

/**
 * What happens to a value that is empty or whitespace-only.
 *
 * "drop"     - discard it (the long-standing behavior for options that were
 *              filtered before being handed to a command handler).
 * "preserve" - keep it, so downstream validation still sees it and can reject it.
 *              Required wherever a malformed value is currently a LOUD failure:
 *              dropping it silently would turn an error into a no-op.
 */
export type EmptyPolicy = "drop" | "preserve";

/**
 * What happens when the caller supplied a comma expression that yields no values
 * at all (`--flag ,` or `--flag ,,`).
 *
 * "reject" - fail with invalid_input. Correct for options that are newly
 *            comma-enabled here: `--blocked-by ,` errors loudly today, so
 *            dropping to an empty list would silently CLEAR the field instead.
 * "drop"   - resolve to no values. Correct only for the registrations that
 *            already split commas before this change, where delimiter-only input
 *            already clears the field.
 */
export type EmptyAfterSplitPolicy = "reject" | "drop";

/**
 * Which values get trimmed.
 *
 * "always"   - every element, comma or not. Matches registrations that already
 *              trim unconditionally today (--depends-on, --cross-node-blocked-by).
 * "segments" - only parts produced by splitting an element that actually
 *              contained a comma. A value with no comma passes through untouched,
 *              so newly comma-enabled options change behavior for comma input only.
 * "never"    - byte-for-byte.
 */
export type TrimPolicy = "always" | "segments" | "never";

interface ArrayBehaviorSpecBase {
  empty: EmptyPolicy;
  trim: TrimPolicy;
  /**
   * Remedy sentence appended when the flag is present but resolves to no values
   * (a bare `--flag`). Setting this rejects that input. Only set it where a
   * dedicated clear flag exists, otherwise a bare flag may be the only way to
   * clear the field and rejecting it removes a capability.
   *
   * Never set this on a positional: yargs fires coerce with [] for an ABSENT
   * variadic positional, so absent and bare are indistinguishable there.
   */
  requireValue?: string;
}

/**
 * Discriminated on `comma` so that a "split" spec CANNOT compile without
 * declaring emptyAfterSplit. An omitted policy there would silently pick neither
 * reject nor legacy-drop, and no AST gate can catch that.
 *
 * This is the behavior half, kept separate so the discriminant survives on the
 * low-level entry point too: a Pick or Omit over a union collapses it and would
 * quietly restore the hole this union exists to close.
 */
export type ArrayBehaviorSpec =
  | (ArrayBehaviorSpecBase & { comma: "split"; emptyAfterSplit: EmptyAfterSplitPolicy })
  | (ArrayBehaviorSpecBase & { comma: "literal"; emptyAfterSplit?: never });

/** Behavior plus the registration-only fields. Distributes over the union. */
export type ArrayValueSpec = ArrayBehaviorSpec & { describe: string };

/**
 * yargs wraps anything thrown from a coerce callback in its own YError, which
 * discards the original class and its `code`; only the message survives. Verified
 * against yargs 17: `err.constructor.name === "YError"` and
 * `err instanceof CliValidationError === false` inside `.fail`.
 *
 * So the original is stashed here on the way out and recovered by the CLI failure
 * handler, keyed on the message so a stale entry from an earlier parse can never
 * be mistaken for the current one. This is deliberately narrow: it recovers the
 * code for array-option failures ONLY, leaving every other `.fail` path
 * (including plain Errors thrown from `.check()`) exactly as it was.
 */
let pendingError: CliValidationError | null = null;

function raise(error: CliValidationError): never {
  pendingError = error;
  throw error;
}

/** Recovers the CliValidationError behind a YError whose message matches. */
export function takeArrayOptionError(message: string): CliValidationError | null {
  const pending = pendingError;
  pendingError = null;
  return pending !== null && pending.message === message ? pending : null;
}

/**
 * Drops any stashed error without consuming it.
 *
 * The slot is module scoped, not parse scoped. The CLI parses once per process,
 * so in production only one parse can ever populate it, and `.fail` consumes it
 * immediately. But a coerce failure on a parser built WITHOUT the root `.fail`
 * handler (a test, or a future embedded parse) leaves the slot set, and the next
 * parse could then match a same-message YError against it. Clearing on both
 * sides of the root parse bounds that window to a single parse.
 *
 * If in-process parses ever become concurrent, this must become parse-scoped
 * state (AsyncLocalStorage) rather than a single slot.
 */
export function resetArrayOptionError(): void {
  pendingError = null;
}

// Kept short: yargs truncates describe text to its column width, and a longer
// hint gets cut off mid-word in --help.
const COMMA_HINT: Record<CommaPolicy, string> = {
  split: "(space or comma separated)",
  literal: "(comma is literal)",
};

/**
 * Applies a value spec to a parsed yargs array.
 *
 * Absence contract, verified against yargs 17:
 * - For an OPTION, yargs does not invoke coerce at all when the flag is absent,
 *   so the value stays `undefined` and callers can still distinguish "not
 *   supplied" from "supplied empty". That is what keeps `note update --title x`
 *   with no `--tags` from clearing tags.
 * - For a variadic POSITIONAL, yargs invokes coerce with `[]` even when the
 *   positional is absent, so absence cannot be detected there. That is why
 *   requireValue is not available on positionals.
 */
export function applyArrayValueSpec(
  values: unknown,
  flag: string,
  spec: ArrayBehaviorSpec,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) {
    raise(new CliValidationError("invalid_input", `--${flag} expects a list of values.`));
  }

  const keepNonEmpty = (parts: string[]): string[] =>
    spec.empty === "drop" ? parts.filter((v) => v.trim() !== "") : parts;

  const result: string[] = [];
  for (const value of values) {
    // Unreachable while every array registration goes through the wrappers below,
    // which pin type "string". Kept so a future registration mistake fails loudly
    // instead of silently discarding data the way tag normalization does for
    // non-strings.
    if (typeof value !== "string") {
      raise(new CliValidationError(
        "invalid_input",
        `--${flag} received a non-string value. Repeat the flag for each value.`,
      ));
    }

    if (spec.comma === "split" && value.includes(",")) {
      const segments = value
        .split(",")
        .map((part) => (spec.trim === "never" ? part : part.trim()));
      const kept = keepNonEmpty(segments);
      // Evaluated PER supplied value, not across the whole argv list. Otherwise
      // `--blocked-by T-001 ,` would let the valid first value mask the stray
      // separator and drop it silently, when today that separator either reaches
      // the handler and fails loudly or is stored verbatim.
      if (kept.length === 0 && spec.emptyAfterSplit === "reject") {
        raise(new CliValidationError(
          "invalid_input",
          `--${flag} was given "${value}", which contains separators but no values.`,
        ));
      }
      result.push(...kept);
      continue;
    }

    result.push(...keepNonEmpty([spec.trim === "always" ? value.trim() : value]));
  }

  if (spec.requireValue !== undefined && result.length === 0) {
    raise(new CliValidationError(
      "invalid_input",
      `--${flag} requires at least one value. ${spec.requireValue}`,
    ));
  }

  return result;
}

function register<T>(y: Argv<T>, name: string, spec: ArrayValueSpec, positional: boolean): Argv<T> {
  const config = {
    type: "string" as const,
    array: true as const,
    describe: `${spec.describe} ${COMMA_HINT[spec.comma]}`,
  };
  const registered = positional
    ? (y.positional(name, config) as unknown as Argv<T>)
    : (y.option(name, config) as unknown as Argv<T>);
  return registered.coerce(
    name,
    (values: unknown) => applyArrayValueSpec(values, name, spec),
  ) as unknown as Argv<T>;
}

/**
 * Registers a yargs array OPTION together with its value spec. This and
 * `arrayPositional` are the only sanctioned ways to register an array value in
 * the CLI: because coercion is attached at registration, a registration cannot
 * exist without a policy. `test/cli/array-option-registration.test.ts` enforces
 * that with an AST pass that rejects raw array registrations elsewhere.
 */
export function arrayOption<T>(y: Argv<T>, name: string, spec: ArrayValueSpec): Argv<T> {
  return register(y, name, spec, false);
}

/**
 * Registers several array options at once, so a command builder chain stays flat
 * instead of nesting one `arrayOption` call per flag.
 */
export function arrayOptions<T>(y: Argv<T>, specs: Record<string, ArrayValueSpec>): Argv<T> {
  let out = y;
  for (const [name, spec] of Object.entries(specs)) {
    out = arrayOption(out, name, spec);
  }
  return out;
}

/**
 * Distributes over the union so each branch keeps its own discriminant. A plain
 * Omit would collapse ArrayValueSpec into one non-discriminated shape and lose
 * the compile-time requirement that a "split" spec declares emptyAfterSplit.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Registers a variadic yargs POSITIONAL together with its value spec.
 * requireValue is structurally unavailable here: yargs fires coerce with [] for
 * an ABSENT variadic positional, so absent and bare cannot be told apart.
 */
export function arrayPositional<T>(
  y: Argv<T>,
  name: string,
  spec: DistributiveOmit<ArrayValueSpec, "requireValue">,
): Argv<T> {
  return register(y, name, spec, true);
}
