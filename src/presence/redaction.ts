/**
 * ISS-1022: what a presence record is allowed to say about a tool call.
 *
 * This is an ALLOWLIST, not a filter. A fixed table maps a tool name to the one
 * `tool_input` key that holds a path; every other tool records its name and
 * nothing else. No prompts, no other `tool_input` keys, no tool output, no
 * command strings ever reach a presence record, so a new tool (or a new field
 * on an existing one) cannot leak by default.
 *
 * The recorded path is additionally PROVEN to be inside the project before it
 * is written, and is stored project-relative.
 */

import * as fs from "node:fs";
import { isAbsolute, resolve, dirname, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { MAX_TARGET_BYTES } from "./types.js";

/**
 * Tool name -> the single `tool_input` key holding a filesystem path.
 *
 * Deliberately excludes Bash (`command` is a shell string), Grep/Glob
 * (`pattern` can carry user content), WebFetch (`url`) and every MCP tool.
 */
export const PATH_INPUT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
});

/** Above this length the value is not a path we are going to record; refuse before doing filesystem work. */
const MAX_RAW_PATH_LENGTH = 4096;

/**
 * Resolves the allowlisted path input for `toolName`, proven contained in
 * `root`, as a project-relative path. Null whenever containment cannot be
 * proven, which includes every non-allowlisted tool.
 */
export function redactedTarget(
  root: string,
  cwd: string,
  toolName: string,
  toolInput: unknown,
): string | null {
  const key = PATH_INPUT_KEYS[toolName];
  if (!key) return null;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return null;
  const raw = (toolInput as Record<string, unknown>)[key];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_PATH_LENGTH) return null;
  if (raw.includes("\0")) return null;
  return containedRelativePath(root, cwd, raw);
}

/**
 * The containment proof.
 *
 * A `Write` target usually does NOT exist yet, so realpath of the file itself
 * would reject every new file. Instead the NEAREST EXISTING ANCESTOR is
 * canonicalized -- which is what resolves any symlink in the chain, including a
 * symlinked project root -- and the still-nonexistent suffix is appended only
 * after the canonical ancestor is proven to be the root or inside it.
 */
export function containedRelativePath(root: string, cwd: string, value: string): string | null {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    return null;
  }

  // `resolve` eliminates every `..` and `.` segment, so the absolute form
  // below has no traversal left to smuggle past the prefix check.
  const absolute = isAbsolute(value) ? resolve(value) : resolve(cwd, value);

  const suffix: string[] = [];
  let ancestor = absolute;
  for (;;) {
    let exists = true;
    try {
      fs.lstatSync(ancestor);
    } catch {
      exists = false;
    }
    if (exists) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) return null; // walked to the filesystem root and found nothing
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    ancestor = parent;
    if (suffix.length > 64) return null; // absurd depth of nonexistent components
  }

  let canonicalAncestor: string;
  try {
    canonicalAncestor = fs.realpathSync(ancestor);
  } catch {
    return null;
  }
  // `relative`, not a `root + sep` prefix test: a project AT a filesystem root
  // ("/" on POSIX, "C:\\" on Windows) already ends in a separator, so
  // concatenating one produces "//" and every legitimate descendant fails.
  const ancestorRel = relative(canonicalRoot, canonicalAncestor);
  if (ancestorRel === ".." || ancestorRel.startsWith(".." + sep) || isAbsolute(ancestorRel)) {
    return null;
  }
  // The existing ancestor must be a directory whenever there is a suffix to
  // append; a file with children below it is not a path we can vouch for.
  if (suffix.length > 0) {
    try {
      if (!fs.statSync(canonicalAncestor).isDirectory()) return null;
    } catch {
      return null;
    }
  }
  if (suffix.some((part) => part === "" || part === "." || part === "..")) return null;

  const full = suffix.length > 0 ? resolve(canonicalAncestor, ...suffix) : canonicalAncestor;
  const rel = relative(canonicalRoot, full);
  if (rel === "") return ".";
  // Only an actual parent SEGMENT is an escape. `rel.startsWith("..")` also
  // rejects legitimate in-project names like `..cache/x` and `..notes`.
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  // Normalized to forward slashes: this value is a DISPLAY string for the app,
  // not a path to reopen, and a mixed-separator result (trimmed paths joined
  // with "/", untrimmed ones with "\\") would render inconsistently on Windows.
  return capPathForDisplay(rel.split(sep).join("/"));
}

/**
 * Caps a project-relative path at MAX_TARGET_BYTES by dropping LEADING
 * components, never by cutting mid-string: a truncated path is a path that
 * points somewhere else, while a head-trimmed one marked with a leading
 * ".../" is visibly partial. Null when even the basename does not fit.
 */
export function capPathForDisplay(rel: string): string | null {
  if (Buffer.byteLength(rel, "utf-8") <= MAX_TARGET_BYTES) return rel;
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    const candidate = ".../" + parts.slice(i).join("/");
    if (Buffer.byteLength(candidate, "utf-8") <= MAX_TARGET_BYTES) return candidate;
  }
  return null;
}

/**
 * Caps an arbitrary label at `maxBytes`, cutting on a character boundary. Null
 * when the result would be empty.
 *
 * `StringDecoder` is the cut, rather than hand-walking continuation bytes:
 * hand-walking has to decide whether the last byte begins an incomplete
 * sequence, and getting that backwards discards a COMPLETE final character
 * whenever the cap lands exactly on a character boundary (`capString("ex", 2)`
 * with a two-byte first character returned the empty string). The decoder emits
 * only whole characters and retains any partial sequence internally, which is
 * the property wanted here.
 */
export function capString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.includes("\0")) return null;
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  const out = new StringDecoder("utf8").write(Buffer.from(value, "utf-8").subarray(0, maxBytes));
  return out.length > 0 ? out : null;
}
