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
import { readSession, sessionsRoot } from "./session.js";
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
    };

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
 * is verified lexically — a not-yet-existing path cannot be a symlink).
 */
export function isContainedSessionDir(root: string, dir: string): boolean {
  const canonRoot = canonicalSessionsRoot(root);
  if (canonRoot === null) return false;
  const rootPrefix = canonRoot.endsWith(sep) ? canonRoot : canonRoot + sep;

  let canonDir: string;
  try {
    canonDir = realpathSync.native(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Not-yet-existing candidate: accept only if the lexical form is
      // sessionsRoot + basename(dir). Any non-trivial path cannot resolve.
      const lexical = join(sessionsRoot(root), basename(dir));
      return lexical === dir;
    }
    return false;
  }

  return canonDir === canonRoot || canonDir.startsWith(rootPrefix);
}

/**
 * Enumerate the direct child directory names under sessionsRoot(root).
 * Callers MUST pass each candidate through isContainedSessionDir before
 * touching it. This helper does NOT filter symlinks itself — it returns the
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

  const state = readSession(dir);
  if (state === null) {
    return { kind: "resolved", sessionId: canonicalId, dir, state: null, corrupt: true };
  }
  return { kind: "resolved", sessionId: canonicalId, dir, state, corrupt: false };
}
