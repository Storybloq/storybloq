/**
 * The deep-merge write contract for `.story/config.json` (T-469, ISS-1026).
 *
 * ONE algorithm with TWO implementations -- this one and
 * `OrderedJSON.deepMerging` in the Mac app -- pinned by the same test table on
 * both sides. Anything that changes here changes there.
 *
 * Why it exists: `recipeOverrides` holds NESTED settings (`stages.CODE_REVIEW`,
 * `lensConfig`) that the Mac app's settings panel edits one leaf at a time. A
 * shallow merge cannot express "leave this nested sibling alone", so writing
 * `stages` from a form that models three stage names DELETED `stages.PLAN_REVIEW`
 * and `stages.CODE_REVIEW` -- which are exactly the explicit knobs that outrank
 * the review-effort dial.
 */

/** A `__proto__`-style key in a patch is refused rather than skipped. */
export const FORBIDDEN_PATCH_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

export class ConfigMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigMergeError";
  }
}

/**
 * Nesting depth the duplicate scanner will descend before refusing to answer.
 *
 * `recipeOverrides.stages.CODE_REVIEW.backends` is depth 4. Nothing this
 * project writes approaches 256, so the cap costs no legitimate config, and
 * `JSON.parse` outlives the scanner here: V8 parses 50000-deep nesting happily
 * while a recursive scanner blows the stack, so a config that LOADS could crash
 * the check that runs after it.
 */
const MAX_SCAN_DEPTH = 256;

/**
 * A plain JSON object: not null, not an array. Arrays are deliberately NOT
 * plain, because the contract treats them as opaque scalars.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge `patch` into `dst`, returning a new object. `dst` is never mutated.
 *
 * The rules, in the order they are applied per key:
 *
 * 1. A forbidden key REFUSES the whole write. Not "skips": a delta containing
 *    `__proto__` is not a delta we authored, and silently dropping it would
 *    hide that.
 * 2. `null` DELETES the key. Absent key is a no-op. A null is never stored.
 * 3. A plain object RECURSES -- into `dst[key]` when that is also a plain
 *    object, otherwise into a fresh `{}`. Handling absent, scalar and array
 *    destinations the same way is what makes a null nested inside a
 *    newly-inserted subtree simply absent rather than stored.
 * 4. Anything else (arrays included) REPLACES atomically. Arrays are opaque:
 *    no element-wise merge, and a null ELEMENT is data, not a deletion.
 *    `lenses` and `reviewBackends` are sets a user edits as a whole, and an
 *    appending merge would make unchecking one impossible.
 *
 * Pruning is deliberately NOT done here: `null` removes only its named key and
 * empty ancestors are left in place, so deleting `stages.CODE_REVIEW.maxReviewRounds`
 * leaves `stages: { CODE_REVIEW: {} }`. The single exception lives at the call
 * site, where an empty `recipeOverrides` root is dropped, and that predates this
 * contract. One predictable rule beats a cascade a reader has to simulate.
 */
export function deepMergeConfig(
  dst: Record<string, unknown>,
  patch: Record<string, unknown>,
  path: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...dst };

  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_PATCH_KEYS.includes(key)) {
      const where = [...path, key].join(".");
      throw new ConfigMergeError(
        `Refusing to merge a delta containing "${where}". ` +
        `Keys named ${FORBIDDEN_PATCH_KEYS.join(", ")} are never written to config.json.`,
      );
    }

    const value = patch[key];

    if (value === null) {
      delete out[key];
      continue;
    }

    if (isPlainObject(value)) {
      const existing = out[key];
      const base = isPlainObject(existing) ? existing : {};
      out[key] = deepMergeConfig(base, value, [...path, key]);
      continue;
    }

    out[key] = value;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Duplicate-key detection
// ---------------------------------------------------------------------------

/**
 * Find the first duplicated object key, as a dotted path, or null.
 *
 * This has to be a SCAN of the source text rather than a check on the parsed
 * value, because `JSON.parse` has already collapsed duplicates by the time a
 * post-parse check could run: it keeps the LAST occurrence and the earlier ones
 * are simply gone.
 *
 * It matters because the Mac app's `OrderedJSON` does not collapse them, and
 * its accessors read the FIRST. So a config carrying duplicate keys means the
 * two readers disagree about what it says, and a merge would update one
 * occurrence while the other stayed authoritative for the other reader.
 * Rejecting such a config on WRITE (never on read) is the only answer that does
 * not silently pick a side.
 *
 * Malformed JSON is not this function's problem -- it returns null and lets the
 * real parser produce the error, so there is exactly one source of syntax
 * diagnostics.
 *
 * It DOES throw `ConfigMergeError` in the two cases where it cannot finish the
 * scan (see the budget and depth guards below). That is not a syntax
 * diagnostic; it is this function declining to report a file clean that it
 * never finished reading.
 */
export function findDuplicateKeyPath(text: string): string | null {
  let i = 0;

  /**
   * A hard step budget, so termination is a property of the loop rather than of
   * a case analysis being exhaustive.
   *
   * Every branch below is supposed to advance `i`, and each loop separately
   * checks that it did. That reasoning was already wrong once: truncated input
   * like `{"a": [` made the array loop rescan end-of-input forever, and
   * `--json '{"a": ['` was enough to hang the command. The scanner runs on
   * whatever a caller typed, BEFORE the real parser gets to reject it.
   *
   * The budget matters beyond belt-and-braces because of HOW that failure
   * shows up: a synchronous infinite loop blocks the event loop, so a test
   * runner cannot time it out. Verified by mutation -- removing the guards
   * below does not turn the truncated-input tests red, it hangs the suite with
   * no output at all. A bug that stalls CI instead of failing it is worse than
   * one that fails, so the budget converts any future non-advancing path into
   * a refusal (see `unverifiable` below) rather than a stall.
   *
   * The bound is generous on purpose: well-formed input needs O(text.length)
   * steps, so nothing real can reach it and no legitimate config is ever
   * refused for being large.
   */
  let budget = text.length * 8 + 1024;

  /**
   * Both exhaustion paths REFUSE rather than returning null.
   *
   * Null means "checked, no duplicate", and neither of these has checked
   * anything -- one ran out of budget, the other ran out of stack. Returning
   * null would report a clean bill of health for a region never scanned, which
   * is the one answer this function must never invent: the whole point is to
   * refuse a merge into a file whose two readers disagree.
   *
   * They surface as `ConfigMergeError`, which callers already map to
   * `invalid_input`, so an unverifiable config produces the same clean refusal
   * as a duplicated one instead of a `RangeError` escaping to the top level.
   */
  const unverifiable = (why: string): never => {
    throw new ConfigMergeError(
      `Cannot check this JSON for duplicate keys: ${why}. ` +
      `Refusing the merge rather than reporting it clean unchecked.`,
    );
  };

  const spend = (): void => {
    if (budget-- <= 0) unverifiable("it takes more steps to scan than its length can justify");
  };

  const skipWhitespace = (): void => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };

  /**
   * Reads a JSON string token and returns its DECODED value.
   *
   * Decoding is the whole point, not a nicety. `{"a": 1, "\u0061": 2}` is two
   * different source spellings of ONE key: both parsers decode them to `a`, so
   * the file really does carry a duplicate, and a scanner that compared raw
   * escape text would report it clean and let the ambiguity straight through
   * the check built to stop it. Same for `"/"` versus `"\/"`, and for the two
   * spellings of an astral character.
   *
   * `JSON.parse` on the captured token does the decoding, so the identity used
   * here is by construction the identity the real parsers use.
   */
  const readString = (): string | null => {
    if (text[i] !== '"') return null;
    const start = i;
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        // Skip the escaped character without interpreting it: that is what
        // keeps a `\"` from being mistaken for the closing quote. Interpretation
        // happens once, below, on the whole token.
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return null; // malformed escape; the real parser reports it
        }
      }
      i++;
    }
    return null;
  };

  /** Returns a duplicate path, or null. Advances past one value. */
  const scanValue = (path: readonly string[], depth: number): string | null => {
    if (depth > MAX_SCAN_DEPTH) unverifiable(`it nests deeper than ${MAX_SCAN_DEPTH} levels`);
    skipWhitespace();
    if (i >= text.length) return null;
    const ch = text[i];

    if (ch === "{") {
      i++;
      const seen = new Set<string>();
      for (;;) {
        spend();
        skipWhitespace();
        // End of input inside an object is malformed. Bail rather than loop:
        // this function runs on caller-supplied text BEFORE the real parser
        // gets to report the syntax error, so spinning here would hang the
        // command on a typo.
        if (i >= text.length) return null;
        if (text[i] === "}") { i++; return null; }
        if (text[i] === ",") { i++; continue; }
        const before = i;
        const key = readString();
        if (key === null) return null;
        if (seen.has(key)) return [...path, key].join(".");
        seen.add(key);
        skipWhitespace();
        if (text[i] !== ":") return null;
        i++;
        const dup = scanValue([...path, key], depth + 1);
        if (dup !== null) return dup;
        // Termination guard. Every branch above should advance `i`, but this
        // makes that a property of the loop rather than of a case analysis
        // holding for every malformed shape anyone can write.
        if (i <= before) return null;
      }
    }

    if (ch === "[") {
      i++;
      let index = 0;
      for (;;) {
        spend();
        skipWhitespace();
        if (i >= text.length) return null;
        if (text[i] === "]") { i++; return null; }
        if (text[i] === ",") { i++; index++; continue; }
        const before = i;
        const dup = scanValue([...path, `[${index}]`], depth + 1);
        if (dup !== null) return dup;
        if (i <= before) return null;
      }
    }

    if (ch === '"') {
      readString();
      return null;
    }

    // Number, true, false, null: consume until a structural character.
    while (i < text.length) {
      const c = text[i] ?? "";
      if (",}] \t\n\r".includes(c)) break;
      i++;
    }
    return null;
  };

  return scanValue([], 0);
}

/**
 * Throw if `text` carries duplicate object keys, naming the path.
 *
 * Applied to the config being written and to the delta, on the write path only.
 * Reads are deliberately untouched: a project whose config already has a
 * duplicate must still OPEN, or the app could not show the user the file it is
 * refusing to save.
 */
export function assertNoDuplicateKeys(text: string, label: string): void {
  const dup = findDuplicateKeyPath(text);
  if (dup !== null) {
    throw new ConfigMergeError(
      `${label} contains a duplicate key at "${dup}". ` +
      `Duplicate keys read differently in the CLI and the Mac app, so this file cannot be safely merged. ` +
      `Remove the earlier occurrence and retry.`,
    );
  }
}
