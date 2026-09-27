/**
 * T-523/T-524: the shared single-file catalog mechanism.
 *
 * A catalog is one tracked JSON file under `.story/` holding `{ version: 1,
 * <key>: Entry[] }`, loaded bounded, written atomically under the project
 * lock. The capability inventory and the glossary are two instantiations of
 * exactly this, which is why the mechanism lives here rather than twice.
 *
 * The load path is deliberately ONE function. Its three steps (validate the
 * directory, classify the leaf, read within a bound) each exist because a
 * different wrong answer was reachable without them, and keeping them in one
 * body is what stops a caller reassembling two of the three in a new order.
 */

import { join, relative, sep, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lstatSync, existsSync, realpathSync } from "node:fs";
import type { z } from "zod";
import { readdirSafe, verifyContainment, verifyDirIdentity, type DirIdentity } from "./readdir-safe.js";
import { readBoundedFileDetailed, type BoundedReader } from "./bounded-read.js";
import { sanitizeDisplayPath, sanitizeDisplayText, MAX_PROSE_LENGTH } from "./display-text.js";
import { withProjectLock, withConflictResolutionLock, atomicWrite } from "./project-loader.js";
import { ProjectLoaderError } from "./errors.js";
import { openConflictRefusal } from "./catalog-conflicts.js";

/**
 * The read bound and the WRITE bound are the same number, following
 * `ruling-loader.ts` (:124 reads with the bound, :334 refuses a serialized
 * record over it). The reason recorded there applies unchanged: without the
 * write-side check a caller can create a record that the read path will
 * afterwards refuse, which is a write-only record -- data that exists on disk
 * and can never be loaded again.
 */
export const CATALOG_MAX_BYTES = 2_000_000;

/**
 * A catalog that exists but cannot be trusted. Never thrown for a catalog that
 * is simply absent: absence is a legitimate state with its own representation
 * (the schema-shaped empty document with `present: false`), and conflating the
 * two is what would let a broken project look like a new one.
 *
 * The message is printed, so it is sanitized here, once, whatever built it.
 * Some reasons interpolate a filesystem path (a symlink's real path, the
 * shared `.story/` helpers' own reasons) and others a caller's value (a
 * refused write quotes the schema's message, which names the entry point);
 * any of them can carry control, line-separator or bidi characters. A path
 * this module names itself is passed through `sanitizeDisplayPath` first, so
 * the operator gets the reversible form; this is the backstop for the rest.
 *
 * Such a path is therefore sanitized twice, and that is harmless only because
 * this pass is a no-op on the path form: the path form emits no member of the
 * class it replaces. It is also why this pass has NO length cap. The path form
 * spends up to six characters per raw character on a path of up to 4096, so a
 * cap here would cut a legal encoding, and a cut encoding no longer decodes.
 * Each value interpolated here is bounded where it comes from, and every call
 * site was enumerated to check it: a fixed reason, an OS path or errno, a
 * schema-derived key, a path already through `sanitizeDisplayPath` (raw input
 * capped at 4096), or a string through `capEcho`. `capEcho` is what bounds the
 * two that would otherwise be unbounded -- a zod message echoing the caller's
 * own value, and an Error message thrown by a caller's `toJSON`.
 */
export class CatalogLoadError extends Error {
  readonly file: string;
  constructor(file: string, message: string) {
    super(`${file}: ${sanitizeDisplayText(message, Number.POSITIVE_INFINITY)}`);
    this.name = "CatalogLoadError";
    this.file = file;
  }
}

/**
 * Caps one echoed string at the prose bound. Every value interpolated into a
 * CatalogLoadError message must be bounded by something -- the constructor's
 * own sanitizing pass is deliberately uncapped (see there) -- and this is the
 * cap for the values whose only other bound is "whatever the caller passed".
 * Cutting the tail costs nothing: the caller already holds the value, and the
 * marker says how much was cut.
 */
function capEcho(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_PROSE_LENGTH) return text;
  return `${chars.slice(0, MAX_PROSE_LENGTH).join("")}... (${chars.length - MAX_PROSE_LENGTH} more characters)`;
}

/**
 * The schema message a refused write quotes. It can echo the caller's own
 * value (a duplicate entry point is named in full) and the schema sets no
 * field maximum, so it is capped at the echo.
 */
function echoedIssue(error: z.ZodError): string {
  return capEcho(error.issues[0]?.message ?? "invalid");
}

export interface CatalogLoadResult<TDoc> {
  /** Always schema-shaped, even when the file is absent. */
  readonly doc: TDoc;
  /** False when the file does not exist. Callers render "no inventory yet" from this. */
  readonly present: boolean;
}

export interface CatalogDefinition<TDoc> {
  /** Base name under `.story/`, e.g. `capabilities.json`. */
  readonly file: string;
  /** The document property holding the entry array, e.g. `capabilities`. */
  readonly key: string;
  /**
   * Input is deliberately unconstrained. A `ZodObject`'s INPUT type is its
   * pre-default, pre-transform shape, which is not `TDoc`, so pinning both
   * sides would make every real schema fail to assign. Only the OUTPUT matters
   * here: the load path hands `safeParse` a `JSON.parse` result and the write
   * path hands it a document, and both are unknown as far as this module is
   * concerned.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly schema: z.ZodType<TDoc, z.ZodTypeDef, any>;
  /** The schema-shaped empty document, returned when the file is absent. */
  readonly empty: () => TDoc;
}

export interface Catalog<TDoc> {
  readonly file: string;
  readonly key: string;
  /**
   * T-528: `read` defaults to the shipped bounded reader; the decisions
   * projection passes a recording reader to keep the bytes it parsed.
   */
  load: (root: string, read?: BoundedReader) => CatalogLoadResult<TDoc>;
  /** Public entry: acquires the project lock for ordinary callers. */
  mutate: (root: string, fn: (doc: TDoc) => TDoc) => Promise<TDoc>;
  /**
   * Repair entry: acquires the CONFLICT-RESOLUTION lock, the one that opens a
   * state still carrying conflicts.
   */
  mutateForRepair: (root: string, fn: (doc: TDoc) => TDoc) => Promise<TDoc>;
  /**
   * For a caller that ALREADY holds the lock, following the
   * `writeTicketUnlocked` family. `handleResolve` holds one lock for the whole
   * command, so a catalog write reached from inside it must not acquire again:
   * the project lock has no re-entrancy check, so a nested acquisition queues
   * on the outer hold, spins to DEFAULT_DEADLINE_MS and throws an io_error
   * naming a lock path, which is indistinguishable from real contention.
   */
  writeUnlocked: (root: string, doc: TDoc) => Promise<void>;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * LEXICAL containment for two ALREADY-RESOLVED absolute paths. Purely a string
 * relation: it resolves nothing, which is the entire reason it exists.
 *
 * `verifyContainment` cannot do this job. readdir-safe.ts:118 JOINS its two
 * arguments and realpaths BOTH of them again, so calling it here would
 * reintroduce exactly the second, independent resolution that the check is
 * meant to eliminate. The post-read check has to inspect the path the reader
 * ALREADY resolved, so it needs a predicate over two absolute paths, never a
 * resolver.
 *
 * `relative` rather than a string prefix, and segment-aware on the result: a
 * prefix test accepts `/p/.story-backup/x` for `/p/.story`, a different
 * directory that merely starts the same way, while a bare `startsWith("..")`
 * on the relative path would reject a legitimate child literally named
 * `..foo`. Both directions are wrong answers about a path component, so the
 * component boundary is the thing to compare.
 */
function isWithinDir(dir: string, child: string): boolean {
  const rel = relative(dir, child);
  if (rel.length === 0 || isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

function storyDirOf(root: string): string {
  return join(root, ".story");
}

/**
 * Every key reachable from our own schema definition, collected once. This is
 * the ALLOWLIST the diagnostic below filters against, and it is derived from
 * the schema rather than hand-written on purpose: a hand-written list drifts
 * the moment a field is added, and a drifted list starts redacting legitimate
 * field names, which is a diagnostic that degrades silently.
 *
 * An allowlist, never a denylist. A denylist would be a guess about what
 * somebody else's file contains.
 */
function collectSchemaKeys(node: unknown, out: Set<string>, depth: number): Set<string> {
  if (depth > 12 || node === null || typeof node !== "object") return out;
  const shape = (node as { shape?: unknown }).shape;
  const resolvedShape = typeof shape === "function" ? (shape as () => unknown)() : shape;
  if (resolvedShape !== null && typeof resolvedShape === "object") {
    for (const [key, child] of Object.entries(resolvedShape as Record<string, unknown>)) {
      out.add(key);
      collectSchemaKeys(child, out, depth + 1);
    }
  }
  const inner = (node as { _def?: Record<string, unknown> })._def;
  if (inner !== undefined) {
    // ZodArray.type, ZodOptional/Nullable/Default.innerType, ZodEffects.schema,
    // ZodRecord.valueType. Unknown wrappers simply contribute nothing, which
    // fails toward redaction rather than toward disclosure.
    for (const key of ["type", "innerType", "schema", "valueType", "left", "right"]) {
      if (inner[key] !== undefined) collectSchemaKeys(inner[key], out, depth + 1);
    }
    if (Array.isArray(inner.options)) for (const opt of inner.options) collectSchemaKeys(opt, out, depth + 1);
  }
  return out;
}

/**
 * The failing location, with every segment that did not come from our own
 * source code replaced. A numeric array index is kept as itself.
 *
 * RESIDUAL, stated because it is a deliberate trade and not an oversight: a
 * kept numeric index still tells a reader how many elements the array had
 * before the failing one. For an outside file reached through the race in
 * ISS-1275 that is a real, one-integer channel. It is the price of a
 * diagnostic that users hit constantly while hand-editing their own catalog,
 * where the field location IS the diagnostic, and it is far narrower than the
 * Zod message it replaces.
 */
function safeIssueLocation(path: ReadonlyArray<string | number>, allowed: Set<string>): string {
  if (path.length === 0) return "the document root";
  return path.map((seg) => (typeof seg === "number" ? String(seg) : allowed.has(seg) ? seg : "<redacted>")).join(".");
}

export function defineCatalog<TDoc>(def: CatalogDefinition<TDoc>): Catalog<TDoc> {
  /** Computed on first use: building it is a schema walk, not a per-load cost. */
  let schemaKeys: Set<string> | null = null;
  const allowedKeys = (): Set<string> => (schemaKeys ??= collectSchemaKeys(def.schema, new Set<string>(), 0));

  /**
   * Three steps, in this order, and the order is the whole point.
   *
   * 1. VALIDATE THE DIRECTORY. `readdirSafe` is the shipped directory
   *    validation policy and it already separates the three cases this needs:
   *    ENOENT is a legitimately absent `.story/` (warning null, dirents null),
   *    a SYMLINK is refused outright, and a non-directory is refused. Doing
   *    this first is what makes step 2 sound: an ENOENT from lstat-ing the
   *    full path does not by itself prove the LEAF is missing, because a
   *    dangling PARENT symlink produces the same errno, and a broken project
   *    would then read as an empty catalog.
   * 2. CLASSIFY THE LEAF with `lstat`, not `realpath` and not `existsSync`.
   *    Both of those resolve the target, so a DANGLING SYMLINK and a genuinely
   *    missing file are indistinguishable through either: each gives ENOENT
   *    and false respectively for both states. `lstat` succeeds on a dangling
   *    symlink, which is the only way to tell them apart. Once the leaf is
   *    known to exist, a later `absent` from the reader is an ERROR rather
   *    than an absence, and that is what closes the dangling-leaf hole.
   * 3. CHECK CONTAINMENT, THEN READ. Containment runs BEFORE the read, which
   *    is the shipped pattern (ruling-loader.ts:115, arrangement-loader.ts:70,
   *    gate-ack-loader.ts:140 all call it ahead of their own read). Running it
   *    after the read would let the reader consume an OUTSIDE target while the
   *    later check inspects a replacement pointing inside, accepting bytes
   *    whose source was never checked.
   *
   * The residual race is stated rather than claimed away: between the
   * containment check and the open, the path can be swapped. `O_NOFOLLOW` in
   * `readBoundedFileDetailed` closes a swap to a SYMLINK, and the
   * `verifyDirIdentity` re-check below closes a swap of the DIRECTORY, but a
   * swap of a regular file for another regular file inside a still-valid
   * directory is not detectable through Node's public fs API. It requires
   * local write access to `.story/`, which is the same threat model
   * `readdir-safe` documents for itself.
   */
  function load(root: string, readFile: BoundedReader = readBoundedFileDetailed): CatalogLoadResult<TDoc> {
    const dir = storyDirOf(root);
    const path = join(dir, def.file);

    const scan = readdirSafe(dir);
    if (scan.warning !== null) {
      throw new CatalogLoadError(def.file, `.story/ ${scan.warning}`);
    }
    if (scan.dirents === null) {
      // `.story/` does not exist at all: the project has no catalog yet.
      return { doc: def.empty(), present: false };
    }
    const dirIdentity: DirIdentity | null = scan.dirIdentity;

    let leaf: ReturnType<typeof lstatSync>;
    try {
      leaf = lstatSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Codex finding 1. The rule, in its general form, because the specific
        // form is what produced the bug: ANY EXIT THAT REPORTS A CONCLUSION
        // ABOUT THE DIRECTORY'S CONTENTS MUST FIRST CONFIRM THE DIRECTORY IS
        // STILL THE ONE THAT WAS VALIDATED. Absence is a conclusion about
        // contents. `verifyDirIdentity` was written as a POST-READ re-check,
        // and this path has no read, so it slipped out from under the rule by
        // satisfying its letter: remove or swap `.story/` between `readdirSafe`
        // and this `lstat` and the loader reported a clean empty catalog for a
        // directory it had never validated.
        if (dirIdentity !== null) {
          const drift = verifyDirIdentity(dir, dirIdentity);
          if (drift !== null) throw new CatalogLoadError(def.file, `.story/ ${drift}`);
        }
        return { doc: def.empty(), present: false };
      }
      // ENOTDIR and everything else are errors: a path component that is not a
      // directory is a broken project, not a missing file.
      throw new CatalogLoadError(def.file, `could not be classified (${code ?? "unknown error"})`);
    }
    // The leaf exists. If it is a symlink whose target does not resolve, say so
    // HERE rather than letting it fall through: `verifyContainment` would also
    // refuse it, but through its ENOENT catch, reporting "could not resolve" as
    // though the catalog were missing. Diagnosing it in the classification step
    // is what keeps the containment check answering only the question it is
    // named for.
    if (leaf.isSymbolicLink() && !existsSync(path)) {
      throw new CatalogLoadError(def.file, "is a symlink whose target could not be resolved");
    }

    const containment = verifyContainment(dir, def.file);
    if (containment !== null) {
      throw new CatalogLoadError(def.file, containment);
    }

    const read = readFile(path, CATALOG_MAX_BYTES);
    if (read.kind === "absent") {
      // The leaf existed at step 2, so this is a dangling symlink or a file
      // that vanished mid-load. Either way it is an error, never an absence.
      throw new CatalogLoadError(def.file, "exists but its target could not be resolved");
    }
    if (read.kind === "indeterminate") {
      throw new CatalogLoadError(def.file, read.reason);
    }

    /**
     * Codex finding 2, PARTIAL mitigation and labelled as such.
     *
     * `verifyContainment` and `readBoundedFileDetailed` resolve the pathname
     * INDEPENDENTLY, so the check above validated one resolution and the
     * reader performed another. Checking the path the reader actually
     * resolved, before the bytes are used, removes the simple form of that
     * gap. It does not remove all of it:
     *
     *   O_NOFOLLOW protects only the final component of the pathname passed to
     *   open. Ancestor replacement after realpath can redirect open while the
     *   returned target retains the earlier inside pathname. The lexical check
     *   does not detect this. Directory identity checks detect persistent
     *   changes to the checked directory, but not a swap restored before
     *   revalidation. This residual race is tracked in ISS-1275 across the
     *   affected loaders and is not closed here.
     *
     * Closing it properly needs openat-style traversal that refuses a symlink
     * at every component. Node exposes no openat, so it implies a native
     * dependency, and that is a cost decision rather than a code change.
     *
     * The same shape is shipped at ruling-loader.ts:115, arrangement-loader.ts:70
     * and gate-ack-loader.ts:140. That is a reason to fix the four together,
     * never a reason to treat this one as free: the catalog is an additional
     * reachable read path with its own callers and its own diagnostics.
     */
    const realDir = realpathOrNull(dir);
    if (realDir === null || !isWithinDir(realDir, read.target)) {
      // The message names the PATH and nothing else. Not one byte of the file
      // appears here: routing outside content into a diagnostic is the exfil
      // this check exists to stop, and a parse error would do exactly that,
      // which is why this runs before `JSON.parse` rather than after it.
      //
      // The wording says what actually happened. `readBoundedFileDetailed`
      // opened the target and read its bytes a few lines above -- this branch
      // cannot run before the read, because the read is what resolves the
      // pathname being judged -- so "it was not read" would be a false account
      // of a security-relevant event. The bytes were read and then discarded
      // without being parsed, printed, or returned.
      throw new CatalogLoadError(def.file, `resolved to ${sanitizeDisplayPath(read.target)}, which is outside .story/; its bytes were discarded unparsed`);
    }

    if (dirIdentity !== null) {
      const drift = verifyDirIdentity(dir, dirIdentity);
      if (drift !== null) throw new CatalogLoadError(def.file, `.story/ ${drift}`);
    }

    /**
     * Owner ruling r-8bjvtgh0hphetpw0: a zero-byte or whitespace-only file is
     * a CatalogLoadError and its bytes are preserved. A truncated file is
     * indistinguishable from an empty one, so treating it as empty would let
     * the next mutation overwrite damaged data. Absence is the only state that
     * loads as empty.
     */
    if (read.text.trim().length === 0) {
      throw new CatalogLoadError(def.file, "is empty or whitespace-only, which is indistinguishable from truncation");
    }

    /**
     * THE INVALID-JSON DIAGNOSTIC CARRIES NO CONTENT. Fixed string: no parser
     * message, no fragment of the input, no `cause`, no offset with an
     * excerpt. `SyntaxError` from `JSON.parse` quotes the offending input, so
     * the ordinary, helpful spelling of this catch is itself the disclosure
     * channel.
     *
     * The reason this is worth the lost diagnostic: the checks above protect
     * the cases they CATCH, and the ancestor race documented there is by
     * construction a case they do not. Removing the channel is the only
     * mitigation that also reaches the windows that stay open.
     *
     * What this does NOT do: it does not prevent disclosure of outside catalog
     * content that parses SUCCESSFULLY. A file elsewhere on disk that happens
     * to be a valid catalog is still returned to the caller through that race.
     * That path is open and is part of what ISS-1275 puts to the owner.
     */
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      throw new CatalogLoadError(def.file, "is not valid JSON");
    }

    const result = def.schema.safeParse(parsed);
    if (!result.success) {
      /**
       * The same channel as the invalid-JSON diagnostic above, and closed the
       * same way, but NOT with the same answer. Zod's message is input-bearing
       * -- `invalid_enum_value` renders as "Expected 'current' | 'review',
       * received 'X'", where X is lifted straight out of the parsed document
       * -- so the message never appears here.
       *
       * A fixed string was rejected for this branch though, because the trade
       * is not the one item 5 makes. Malformed JSON is already almost fully
       * described by "not valid JSON". A schema failure is well-formed JSON
       * with a wrong field, the case a user hits constantly while editing
       * their own catalog by hand, and there the LOCATION is the diagnostic.
       * So the location survives, filtered to segments that came from our own
       * schema, and the issue CODE survives because it is a closed set defined
       * by Zod rather than anything read out of the file.
       */
      const issue = result.error.issues[0];
      const where = issue === undefined ? "the document root" : safeIssueLocation(issue.path, allowedKeys());
      const why = issue === undefined ? "invalid" : issue.code;
      throw new CatalogLoadError(def.file, `does not match the catalog schema at ${where} (${why})`);
    }
    return { doc: result.data, present: true };
  }

  /**
   * Codex finding 3. Every check here is the same question asked once: CAN THE
   * BYTES I AM ABOUT TO WRITE BE LOADED BACK? A write-only record -- data on
   * disk that `load` will afterwards refuse -- is the failure this whole
   * module is arranged to prevent, and a byte-length check alone does not
   * prevent it.
   *
   * Three distinct ways it got through before.
   *
   * 1. `writeUnlocked` is public and is reached by callers that already hold
   *    the lock, so it cannot rely on `transact` having validated first. A
   *    document with an empty `entryPoints` array or a malformed checkpoint
   *    sha is type-correct, serializes fine, and is then rejected by `load`.
   * 2. Even a validated document is not enough, because validation happens on
   *    the OBJECT and the file receives its SERIALIZATION. `.passthrough()`
   *    preserves unknown keys, including a top-level `toJSON`, and
   *    `JSON.stringify` calls it: a schema-valid document serializes to
   *    whatever `toJSON` returns. Reproduced against the installed Zod
   *    version: a catalog carrying `toJSON() { return { version: 2 } }` parses
   *    clean and writes the four bytes `{"version":2}`, which no longer loads.
   * 3. A round trip that only asks "do these bytes still load?" answers a
   *    weaker question than the one that matters. A `toJSON` returning a
   *    different but schema-VALID catalog passes it, so the substituted
   *    document is written while the caller is handed the document it asked
   *    to write. The bytes are therefore also compared against the document,
   *    through a projection that reproduces what `JSON.stringify` drops and
   *    nothing that it substitutes.
   *
   * So the bytes themselves are parsed, re-validated, and compared against the
   * document, and nothing is written unless all three succeed. The order
   * matters: every refusal happens before `atomicWrite`, so the previous file
   * is always intact.
   */
/**
 * What `JSON.stringify` would make of a value, modelled WITHOUT asking any
 * `toJSON`. Used to compare the bytes against the document they came from.
 *
 * `stringify` differs from the data it is given in three ways that matter
 * here. It DROPS what JSON cannot hold (an undefined, a function or a symbol
 * value: absent in an object, `null` in an array, and an array hole reads as
 * that same absent value). It NORMALISES the numbers JSON has no syntax for
 * (`-0` writes as `0`, a non-finite writes as `null`). And it SUBSTITUTES
 * whatever a `toJSON` returns. Drops and normalisations are harmless -- the
 * re-validation below decides whether the remainder still loads -- but a
 * substitution puts a document on disk that the caller never wrote. This
 * projection reproduces the first two and nothing else, so comparing it
 * against the parsed bytes isolates the substitution.
 *
 * Every object is memoised, so a value reachable by two paths projects to one
 * counterpart both times instead of being handed back unprojected on the
 * second visit. The memo is written BEFORE the children are walked, which is
 * also what stops a cycle from recursing forever here; `stringify` is what
 * rejects a cycle, and this projection is built before it gets the chance.
 */
function jsonHolds(value: unknown): boolean {
  return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

function jsonProjection(value: unknown, memo: WeakMap<object, unknown>): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (memo.has(value)) return memo.get(value);
  if (Array.isArray(value)) {
    // Length read ONCE, as `stringify` reads it: an indexed getter that
    // installs the next index would otherwise extend the array under a loop
    // re-reading `value.length`, and the walk would never end.
    const length = value.length;
    const out: unknown[] = new Array(length);
    memo.set(value, out);
    // Indexed, not mapped: `map` preserves a hole, where `stringify` writes null.
    for (let i = 0; i < length; i += 1) {
      const item = value[i];
      out[i] = jsonHolds(item) ? jsonProjection(item, memo) : null;
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  memo.set(value, out);
  for (const [key, nested] of Object.entries(value)) {
    if (!jsonHolds(nested)) continue;
    out[key] = jsonProjection(nested, memo);
  }
  return out;
}

  async function writeUnlocked(root: string, doc: TDoc): Promise<void> {
    const validated = def.schema.safeParse(doc);
    if (!validated.success) {
      throw new CatalogLoadError(
        def.file,
        `refusing to write a document the read path would reject: ${echoedIssue(validated.error)}; nothing was written`,
      );
    }

    /**
     * Projected BEFORE serialization, because `stringify` is what RUNS any
     * `toJSON` the document carries. One that mutates the document on its way
     * to returning a substitute would otherwise be compared against the state
     * it had already changed, and would compare equal to it. This snapshot is
     * a detached copy, so nothing a `toJSON` does afterwards can reach it.
     *
     * It sits inside the same `try` as the serialization it precedes, because
     * it reads the document the same way `stringify` would: an enumerable
     * getter that throws is a failure to serialize whichever of the two
     * reaches it first, and it gets the same bounded, capped error either way.
     */
    let expected: unknown;
    let serialized: string;
    try {
      expected = jsonProjection(validated.data, new WeakMap());
      serialized = JSON.stringify(validated.data, null, 2) + "\n";
    } catch (err) {
      // A throwing toJSON, or a cycle a passthrough key introduced. A thrown
      // message is the caller's own text, bounded by nothing, so it is capped.
      throw new CatalogLoadError(def.file, `could not be serialized (${capEcho(err instanceof Error ? err.message : String(err))}); nothing was written`);
    }

    if (Buffer.byteLength(serialized, "utf-8") > CATALOG_MAX_BYTES) {
      throw new CatalogLoadError(def.file, `serialized document exceeds ${CATALOG_MAX_BYTES} bytes; nothing was written`);
    }

    // The exact bytes, not the object they came from.
    let roundTripped: unknown;
    try {
      roundTripped = JSON.parse(serialized);
    } catch (err) {
      // Unreachable: the bytes being parsed are the ones JSON.stringify produced
      // a few lines above, so this catch has no input a test can supply. It is
      // kept as a backstop, and capped like every other echo for uniformity;
      // the cap here is therefore disclosed as untested rather than proven.
      throw new CatalogLoadError(def.file, `serialized to text that is not valid JSON (${capEcho(err instanceof Error ? err.message : String(err))}); nothing was written`);
    }
    const reloadable = def.schema.safeParse(roundTripped);
    if (!reloadable.success) {
      throw new CatalogLoadError(
        def.file,
        `serialized to bytes the read path would reject: ${echoedIssue(reloadable.error)}; nothing was written`,
      );
    }

    /**
     * Loadable is not the same as faithful. `toJSON` can return a DIFFERENT
     * document that is itself schema-valid: the check above passes it, the
     * bytes land on disk, and `transact` hands the caller the document it
     * asked to write, which is not the one now stored. That is a silent
     * substitution of persisted data, so the bytes are compared against the
     * document as well as validated. The comparison is against `roundTripped`,
     * the raw parse, not `reloadable.data`: a schema that transforms a value
     * would otherwise have to be idempotent for a faithful write to pass. Its
     * other side is `expected`, the projection taken above, before any
     * `toJSON` ran.
     */
    if (!isDeepStrictEqual(roundTripped, expected)) {
      throw new CatalogLoadError(def.file, `serialized to bytes that are not this document (a toJSON substituted it); nothing was written`);
    }

    await atomicWrite(join(storyDirOf(root), def.file), serialized);
  }

  /**
   * One transaction body, parameterised by which lock it takes. The ordinary
   * path refuses to open a state carrying conflicts; the repair path is the
   * variant that accepts one, which is the entire difference between a
   * mutation and a resolution.
   *
   * T-529: "a state carrying conflicts" includes THIS file's own
   * `_conflicts`. The project lock's check sees only the ledger entities, so
   * before T-529 an ordinary write (an add, an update, a defer, a stamp) went
   * through a conflicted catalog and could change an entry a record
   * describes. While any record is open the ordinary path refuses, naming the
   * entries and the command that shows them; the repair path is the only
   * writer until the file is clear.
   */
  async function transact(
    root: string,
    fn: (doc: TDoc) => TDoc,
    acquire: (root: string, handler: () => Promise<void>) => Promise<void>,
    repair: boolean,
  ): Promise<TDoc> {
    let next!: TDoc;
    await acquire(root, async () => {
      // Loaded INSIDE the lock: a document read before acquisition can be
      // invalidated by a concurrent write before the lock is actually held.
      const current = load(root);
      if (!repair) {
        const refusal = openConflictRefusal(def.file, current.doc as { readonly _conflicts?: unknown });
        if (refusal !== null) throw new ProjectLoaderError("conflict", refusal);
      }
      // Parsed here so the value this function RETURNS is the canonical,
      // defaults-applied document. `writeUnlocked` validates again, including
      // the serialized bytes, and that second pass is the one that matters;
      // this one must not run after the write, because a throw there would
      // report failure for a write that already succeeded.
      const validated = def.schema.safeParse(fn(current.doc));
      if (!validated.success) {
        throw new CatalogLoadError(def.file, `refusing to write an invalid document: ${echoedIssue(validated.error)}`);
      }
      next = validated.data;
      await writeUnlocked(root, next);
    });
    return next;
  }

  return {
    file: def.file,
    key: def.key,
    load,
    mutate: (root, fn) =>
      transact(root, fn, (r, handler) => withProjectLock(r, { strict: true }, async () => { await handler(); }), false),
    mutateForRepair: (root, fn) =>
      transact(root, fn, (r, handler) => withConflictResolutionLock(r, async () => { await handler(); }), true),
    writeUnlocked,
  };
}

/**
 * Title-word stop list, shared by every catalog's `match`. Fixed and small on
 * purpose: it exists to stop a title like "Add the check to the list" matching
 * every entry through "add" and "list", not to do linguistics. No stemming, so
 * "rulings" does not match "ruling" -- a miss here is recoverable by reading
 * the inventory, a false match sends a session to the wrong entry and is not.
 *
 * It lives beside the catalog mechanism rather than beside one catalog's
 * matcher so the capability inventory and the glossary tokenise identically: a
 * term that matched one and not the other would be a difference nobody could
 * see in either file.
 */
export const TITLE_STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "not",
  "add", "adds", "new", "use", "uses", "using", "make", "makes", "when", "then",
  "all", "any", "out", "its", "has", "have", "are", "was", "were", "but", "can",
  "should", "must", "will", "does", "did", "get", "gets", "set", "sets", "via",
]);

/** Whole words of length 3 or more, lower-cased, stop words removed. */
export function titleWords(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || TITLE_STOP_WORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}
