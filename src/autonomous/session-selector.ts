/**
 * T-251: Tri-state session selector + shared containment guard.
 *
 * Every CLI entry point (show, positional repair, delete) and every bulk
 * directory enumerator routes through this module. Two hard invariants:
 *   1. No handler reconstructs the path from a raw ID. The resolver validates
 *      the selector and returns a canonicalized path.
 *   2. No readdirSync caller on .story/sessions/ operates on a directory
 *      without first calling isContainedSessionDir.
 */
import { readdirSync, realpathSync, type Dirent } from "node:fs";
import { basename, join, sep } from "node:path";
import { CURRENT_SESSION_SCHEMA_VERSION } from "./session-types.js";
import { sanitizeDisplayText } from "../core/display-text.js";
import { safeJson, MAX_DISPLAY_SERIALIZED_LENGTH } from "../core/safe-json.js";
import { readSessionStrict, sessionsRoot, type NonVersionFailure } from "./session.js";
import type { FullSessionState } from "./session-types.js";

export const SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionResolution =
  | { kind: "not_found"; selector: string }
  | { kind: "ambiguous"; selector: string; matches: string[] }
  | { kind: "invalid"; selector: string; reason: string }
  | {
      kind: "resolved";
      sessionId: string;
      dir: string;
      state: FullSessionState | null;
      corrupt: boolean;
      /**
       * WHY it is corrupt, when it is (ISS-897).
       *
       * Optional so a caller constructing this by hand still typechecks. On
       * `reason: "schema"` it carries the zod field paths, which is the whole
       * point: "corrupt or unreadable" without naming the field is what N-097
       * called the worst DX moment in the product.
       *
       * NARROWED BY REASON, not merely by kind (ISS-897).
       *
       * `Extract<..., { kind: "unreadable" }>` looked like a narrowing and was
       * not: `reason` is a union INSIDE that one object type, so the wider
       * `unsupported-version` stayed representable here -- the exact value the
       * `incompatible` variant exists to keep out of `corrupt`, which is the
       * flag every deletion and repair branch in this codebase reads. `missing`
       * maps only to `not_found`, `version-skew` and `unsupported-version` only
       * to `incompatible`, and the compiler now enforces all three.
       */
      corruptFailure?: NonVersionFailure;
    }
  /**
   * This build did not INTERPRET the session, which is not the same as
   * finding it wrong (ISS-897).
   *
   * Its own variant, not `resolved` with `corrupt: true`, because `corrupt` is
   * the flag every caller branches on and every corrupt branch in this codebase
   * offers `session delete` or `session repair`. A version skew needs the
   * opposite advice, and a caller that reads the boolean without inspecting the
   * optional detail beneath it would destroy a recoverable session. Making it a
   * separate `kind` means the compiler asks each caller what to do rather than
   * letting one default silently to the destructive branch.
   */
  | ({
      kind: "incompatible";
      sessionId: string;
      dir: string;
      readerVersion: number;
    } & IncompatibleCause);

/**
 * WHY this build cannot read the session -- both non-destructive (ISS-897).
 *
 * `newer` is the original case: a writer ahead of this reader, where upgrading
 * is the whole remedy. `unsupported` is any other PRESENT `schemaVersion` this
 * build does not know -- a lower number, a string, null. It reaches the same
 * `incompatible` family deliberately, because `corrupt` is the flag every
 * destructive branch reads and neither of these establishes damage.
 *
 * The raw value is carried rather than a number, because an unsupported version
 * need not be one; rendering it goes through `describeIncompatible` so no call
 * site has to decide how to phrase either case.
 */
export type IncompatibleCause =
  | { cause: "newer"; writerVersion: number }
  | { cause: "unsupported"; rawVersion: unknown };

/**
 * The version facts alone, with no remedy attached (ISS-897).
 *
 * `describeIncompatible` ends in an instruction -- "do NOT delete it" -- which
 * is right everywhere it stops an action and wrong underneath one that already
 * happened. The delete confirmation needs the same facts and a different ending.
 */
export function incompatibleVersionDetail(info: IncompatibleCause & { readerVersion: number }): string {
  return info.cause === "newer"
    ? `session schema v${info.writerVersion}; this build reads v${info.readerVersion}`
    : `${sanitizeDisplayText(safeJson(info.rawVersion, MAX_DISPLAY_SERIALIZED_LENGTH))}; this build reads v${info.readerVersion}`;
}

/**
 * One sentence for both causes, so seven call sites cannot drift.
 *
 * TERMINAL and JSON sinks only, and that is a CONTRACT rather than an
 * accident. The value it interpolates is bounded and control-safe -- `safeJson`
 * then `sanitizeDisplayText` -- but it is NOT Markdown-escaped, so a
 * `schemaVersion` that is a string containing a link, an element, backticks, a
 * bare URL or an `@` mention would author structure in a rendered document.
 * Every current caller is `session list`/`show`/`repair`/`delete`,
 * `session watch` or `session health` (terminal text), or the `reason` field of
 * `session list --format json`, where JSON encoding contains it. None is an MCP
 * Markdown surface: `session_report` is the one that is, and it deliberately
 * does not call this -- it builds its own sentence and runs the value through
 * `escapeMarkdownDocumentStrict` itself.
 *
 * A NEW Markdown caller must do the same. Escaping unconditionally here is the
 * wrong fix: the terminal callers are the majority and strict escaping puts
 * visible `\[` and `&#58;` noise in front of an operator reading a plain
 * console, which is exactly why this codebase keeps the two passes separate.
 *
 * Neither claims the file is INTACT. The version is checked before the fields
 * are, so an unsupported version establishes only that this build did not
 * interpret it -- the file may be perfectly sound or may be truncated, and
 * nothing here has looked. What both claims share is that deletion is unsafe.
 */
export function describeIncompatible(info: IncompatibleCause & { readerVersion: number }): string {
  return info.cause === "newer"
    ? `written by a newer storybloq (session schema v${info.writerVersion}; this build reads v${info.readerVersion}). ` +
        "This build did not interpret the file, so nothing here establishes that it is damaged OR that it is sound. " +
        "Restart your AI client to reload the MCP server, or upgrade storybloq " +
        "(npm install -g @storybloq/storybloq@latest), then retry; do NOT delete it"
    : `carrying a \`schemaVersion\` this build does not support (${sanitizeDisplayText(safeJson(info.rawVersion, MAX_DISPLAY_SERIALIZED_LENGTH))}; this build reads ` +
        `v${info.readerVersion}). This build did not interpret the file, so nothing here establishes that it is damaged OR ` +
        "that it is sound. Inspect state.json directly, or use a storybloq that supports that schema, then retry; do NOT delete it";
}

function canonicalSessionsRoot(root: string): string | null {
  try {
    return realpathSync.native(sessionsRoot(root));
  } catch {
    return null;
  }
}

/**
 * Shared containment guard. Returns true iff `dir` lives inside the
 * canonical sessions root. Fails closed on any realpath error other than
 * ENOENT on the candidate itself (in which case the non-existent candidate
 * is verified lexically -- a not-yet-existing path cannot be a symlink).
 */
export function isContainedSessionDir(root: string, dir: string): boolean {
  return probeContainment(root, dir) === "contained";
}

/**
 * The same question, answered in three ways instead of two (ISS-897).
 *
 * `isContainedSessionDir` collapses `escaped` and `probe-failed` into one
 * `false`, and they are opposites. A proven escape is the guard doing its job:
 * drop the entry, say nothing, nothing was concealed. A probe that COULD NOT
 * LOOK -- EACCES on an ancestor, EIO, a path replaced mid-enumeration -- has
 * established nothing at all, and dropping it silently removes a directory that
 * may hold a live session from a listing that then reads as complete. That is
 * the concealment this issue exists to close, reached through the predicate
 * rather than through a reader.
 *
 * Callers that only gate an action keep the boolean, because for them
 * fail-closed is the whole requirement. Callers that ENUMERATE need the
 * distinction, so they can report what they could not check.
 */
export type ContainmentProbe = "contained" | "escaped" | "probe-failed";

export function probeContainment(root: string, dir: string): ContainmentProbe {
  const canonRoot = canonicalSessionsRoot(root);
  // The ROOT would not resolve. That is not this candidate escaping -- nothing
  // about this candidate was established either way.
  if (canonRoot === null) return "probe-failed";
  const rootPrefix = canonRoot.endsWith(sep) ? canonRoot : canonRoot + sep;

  let canonDir: string;
  try {
    canonDir = realpathSync.native(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Not-yet-existing candidate: accept only if the lexical form is
      // sessionsRoot + basename(dir). Any non-trivial path cannot resolve.
      // A lexical mismatch here IS a proven escape -- the name itself carries
      // the traversal, and no filesystem state is needed to see it.
      const lexical = join(sessionsRoot(root), basename(dir));
      return lexical === dir ? "contained" : "escaped";
    }
    return "probe-failed";
  }

  return canonDir === canonRoot || canonDir.startsWith(rootPrefix) ? "contained" : "escaped";
}

/**
 * Enumerate the direct child directory names under sessionsRoot(root).
 * Callers MUST pass each candidate through isContainedSessionDir before
 * touching it. This helper does NOT filter symlinks itself -- it returns the
 * raw set of directory-like entries so callers can decide whether to apply
 * containment + readSession checks.
 *
 * ENOENT (sessions dir not yet created) returns []. Any other readdir error
 * propagates so callers can fail closed.
 */
export function listSessionEntryNames(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsRoot(root), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".lock") continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    names.push(entry.name);
  }
  return names;
}

/**
 * Filter raw entry names to only those that pass containment. A name that
 * resolves outside the sessions root via symlink is dropped before the
 * resolver counts ambiguity, exact-match, or not-found.
 */
function listContainedSessionNames(root: string): string[] {
  const raw = listSessionEntryNames(root);
  const sessRoot = sessionsRoot(root);
  return raw.filter((name) => isContainedSessionDir(root, join(sessRoot, name)));
}

/**
 * Validate `selector` and resolve it to a canonical session directory.
 */
export function resolveSessionSelector(
  root: string,
  selector: string,
): SessionResolution {
  if (typeof selector !== "string" || selector.length === 0) {
    return { kind: "invalid", selector, reason: "Selector must be a non-empty string." };
  }

  // Reject path separators, traversal, NULs, and leading dots outright.
  if (
    selector.includes("/") ||
    selector.includes("\\") ||
    selector.includes("..") ||
    selector.includes("\0") ||
    selector.startsWith(".")
  ) {
    return {
      kind: "invalid",
      selector,
      reason: `Invalid session selector "${selector}": contains path characters.`,
    };
  }

  // Only lowercase-hex + dash allowed in the selector body.
  if (!/^[0-9a-f-]+$/i.test(selector)) {
    return {
      kind: "invalid",
      selector,
      reason: `Invalid session selector "${selector}": non-hex characters.`,
    };
  }

  let containedNames: string[];
  try {
    containedNames = listContainedSessionNames(root);
  } catch (err) {
    return {
      kind: "invalid",
      selector,
      reason: `Sessions directory unreadable: ${(err as Error).message}`,
    };
  }

  let canonicalId: string;

  if (SESSION_ID_REGEX.test(selector)) {
    canonicalId = selector.toLowerCase();
  } else {
    const prefix = selector.toLowerCase();
    const matches = containedNames.filter((n) => n.toLowerCase().startsWith(prefix));
    if (matches.length === 0) {
      return { kind: "not_found", selector };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", selector, matches: matches.sort() };
    }
    const only = matches[0];
    if (!SESSION_ID_REGEX.test(only)) {
      return {
        kind: "invalid",
        selector,
        reason: `Matched directory "${only}" is not a valid session ID.`,
      };
    }
    canonicalId = only.toLowerCase();
  }

  const dir = join(sessionsRoot(root), canonicalId);

  if (!isContainedSessionDir(root, dir)) {
    return {
      kind: "invalid",
      selector,
      reason: `Session ${canonicalId} resolves outside the sessions root.`,
    };
  }

  // Verify the directory is actually present (and contained) before reading.
  if (!containedNames.some((n) => n.toLowerCase() === canonicalId)) {
    return { kind: "not_found", selector };
  }

  // STRICT on purpose: this is the admin/diagnostic path, so ISS-556's
  // lensReviewHistory recovery must NOT quietly work around what an operator
  // came here to see. `readSessionStrict` preserves the failure reason AND does
  // not apply that recovery -- two differences from `readSession`, not one, and
  // the second is the one that matters here.
  const result = readSessionStrict(dir);
  if (!result.ok) {
    // A directory that vanished BETWEEN the containment listing above and this
    // read is not corrupt, it is gone (ISS-897). Reporting it as corrupt sends
    // an operator to inspect and repair a state file that no longer has a
    // directory to live in -- and a session being deleted while `session list`
    // runs is an ordinary race, not damage.
    if (result.failure.kind === "missing") return { kind: "not_found", selector };
    if (result.failure.kind === "version-skew") {
      return {
        kind: "incompatible",
        sessionId: canonicalId,
        dir,
        cause: "newer",
        writerVersion: result.failure.writerVersion,
        readerVersion: result.failure.readerVersion,
      };
    }
    // The SAME family, not the corrupt fallback below. `corrupt: true` is what
    // every destructive branch in this codebase reads, and an unsupported
    // version establishes no damage at all -- the fence runs before the fields
    // are validated. Falling through here would have handed `session delete` and
    // `session repair` a session this build merely cannot interpret.
    if (result.failure.reason === "unsupported-version") {
      return {
        kind: "incompatible",
        sessionId: canonicalId,
        dir,
        cause: "unsupported",
        rawVersion: result.failure.rawVersion,
        readerVersion: CURRENT_SESSION_SCHEMA_VERSION,
      };
    }
    return {
      kind: "resolved",
      sessionId: canonicalId,
      dir,
      state: null,
      corrupt: true,
      // Restated so the narrowing survives the assignment: the early return
      // above eliminated `unsupported-version` from `result.failure.reason`,
      // but `result.failure` is one object type with a union-typed field, so
      // the object itself is still the wide shape.
      corruptFailure: { ...result.failure, reason: result.failure.reason },
    };
  }
  return { kind: "resolved", sessionId: canonicalId, dir, state: result.state, corrupt: false };
}
