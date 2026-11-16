/**
 * ISS-1499 slice B: the session memo, which line this session is on (plan
 * section 4). One file per identity at
 * `.story/telemetry/handover-lines/<sha256 of the id>.json`, read only
 * through `readBoundedNoFollow`, written only by `writeLineMemo` and removed
 * only by `removeLineMemo`. Nothing here throws, and no path is built from
 * memo content before `decodeLineMemo` accepted it.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isFilenameAdmitted } from "./handover-brief.js";
import { isLineageFileValue } from "./handover-lineage.js";
import type { TailReader } from "./handover-selection.js";
import {
  atomicWriteInDir,
  ensureTelemetrySubdir,
  readBoundedNoFollow,
  removeRegularFile,
  telemetrySubdirIfPresent,
  telemetrySubdirState,
} from "../presence/io.js";

export const LINE_MEMO_SUBDIR = "handover-lines";
export const LINE_MEMO_MAX_BYTES = 2048;
export const HASH_CHUNK_BYTES = 65_536;

export interface MemoWriting { readonly file: string; readonly sha256: string }
export interface LineMemo {
  readonly v: 1;
  readonly task: string;
  readonly tip: string | null;
  readonly writing: MemoWriting | null;
}

export type MemoResolution =
  | { readonly kind: "none" }
  | { readonly kind: "active"; readonly tip: string }
  | { readonly kind: "stale"; readonly tip: string; readonly reason: "missing" | "unreadable" };

/** Test seam: runs after the hash's `fstatSync`, before the first read. */
export const memoSeams: { afterHashFstat: ((path: string) => void) | null } = { afterHashFstat: null };

const DIGEST = /^[0-9a-f]{64}$/;
const O_NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const O_NONBLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

/** A string that passes slice A's FILE value rule and the brief's admission. */
export function isMemoFile(value: unknown): value is string {
  return typeof value === "string" && isLineageFileValue(value) && isFilenameAdmitted(value);
}

/** The memo's file name for one identity. */
export function memoFileName(taskId: string): string {
  return `${createHash("sha256").update(taskId).digest("hex")}.json`;
}

function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

/** Pure; never throws. Anything but exactly the memo shape for `taskId` is null (no memo). */
export function decodeLineMemo(text: string, taskId: string): LineMemo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!hasExactKeys(o, ["v", "task", "tip", "writing"])) return null;
  if (o.v !== 1 || o.task !== taskId) return null;
  if (o.tip !== null && !isMemoFile(o.tip)) return null;
  let writing: MemoWriting | null = null;
  if (o.writing !== null) {
    const w = o.writing;
    if (typeof w !== "object" || Array.isArray(w) || !hasExactKeys(w as object, ["file", "sha256"])) return null;
    const { file, sha256 } = w as Record<string, unknown>;
    if (!isMemoFile(file) || typeof sha256 !== "string" || !DIGEST.test(sha256)) return null;
    writing = { file, sha256 };
  }
  return { v: 1, task: taskId, tip: o.tip as string | null, writing };
}

/**
 * The one streaming digest: `size` bytes taken through `readAt` in chunks of
 * 65,536 into SHA-256. Null on a short read. Shared by the file and bytes
 * forms so the intent digest and its verification never differ by method.
 */
function streamDigest(size: number, readAt: (buf: Buffer, len: number, pos: number) => number): string | null {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(Math.min(HASH_CHUNK_BYTES, Math.max(size, 1)));
  let pos = 0;
  while (pos < size) {
    const len = Math.min(buf.length, size - pos);
    const n = readAt(buf, len, pos);
    if (n <= 0) return null;
    hash.update(buf.subarray(0, n));
    pos += n;
  }
  return hash.digest("hex");
}

/** The digest of bytes about to be written. */
export function digestBytes(bytes: Buffer): string {
  return streamDigest(bytes.length, (buf, len, pos) => bytes.copy(buf, 0, pos, pos + len)) as string;
}

/**
 * The whole-file digest of one handover, exactly its `fstat` size, no cap.
 * Refuses a symlink and anything not regular. Null on any failure.
 */
export function hashHandoverFile(handoversDir: string, file: string): string | null {
  const path = join(handoversDir, file);
  let fd: number | null = null;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    memoSeams.afterHashFstat?.(path);
    const handle = fd;
    return streamDigest(st.size, (buf, len, pos) => readSync(handle, buf, 0, len, pos));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Reads and decodes the caller's memo. Null when there is none. Never writes. */
export function readLineMemo(root: string, taskId: string | null): LineMemo | null {
  if (taskId === null) return null;
  const dir = telemetrySubdirIfPresent(root, LINE_MEMO_SUBDIR);
  if (dir === null) return null;
  const text = readBoundedNoFollow(join(dir, memoFileName(taskId)), LINE_MEMO_MAX_BYTES);
  if (text === null) return null;
  return decodeLineMemo(text, taskId);
}

/**
 * Which line the caller is on (plan section 4, steps 1 to 4). A memo that
 * decodes sets the observation, whatever it resolves to.
 */
export function resolveLineMemo(root: string, taskId: string | null, tails: TailReader): MemoResolution {
  const memo = readLineMemo(root, taskId);
  if (memo === null) return { kind: "none" };
  tails.observation.seen = true;
  let tip = memo.tip;
  if (memo.writing !== null && hashHandoverFile(tails.handoversDir, memo.writing.file) === memo.writing.sha256) {
    tip = memo.writing.file;
  }
  if (tip === null) return { kind: "none" };
  if (!tails.has(tip)) return { kind: "stale", tip, reason: "missing" };
  const st = tails.state(tip);
  if (st.state === "unknown") return { kind: "stale", tip, reason: "unreadable" };
  return { kind: "active", tip };
}

/** The memo's bytes: exactly the four keys, in the documented order. */
export function serializeLineMemo(memo: LineMemo): string {
  const writing = memo.writing === null ? null : { file: memo.writing.file, sha256: memo.writing.sha256 };
  return `${JSON.stringify({ v: 1, task: memo.task, tip: memo.tip, writing })}\n`;
}

/**
 * Writes the caller's memo through the validated telemetry chain. False on
 * any failure, including a folder that could not be made safely.
 */
export function writeLineMemo(root: string, memo: LineMemo): boolean {
  const dir = ensureTelemetrySubdir(root, LINE_MEMO_SUBDIR);
  if (dir === null) return false;
  return atomicWriteInDir(dir, join(dir, memoFileName(memo.task)), serializeLineMemo(memo));
}

/** The memo path for messages; never used to open anything. */
export function lineMemoDisplayPath(taskId: string): string {
  return join(".story", "telemetry", LINE_MEMO_SUBDIR, memoFileName(taskId));
}

export type RemoveMemoOutcome = "absent" | "removed" | "failed";

/**
 * Plan section 5, rule 4. `absent` only when the memo is positively known
 * not to exist; a folder that cannot be inspected, a memo that cannot be
 * inspected and anything but a regular file in the memo's place are
 * `failed`, never followed and never reported as gone.
 */
export function removeLineMemo(root: string, taskId: string): RemoveMemoOutcome {
  const folder = telemetrySubdirState(root, LINE_MEMO_SUBDIR);
  if (folder.state === "absent") return "absent";
  if (folder.state === "unsafe") return "failed";
  const path = join(folder.dir, memoFileName(taskId));
  try {
    lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "failed";
  }
  return removeRegularFile(folder.dir, path, null) ? "removed" : "failed";
}

/** Design section 6: the four-line pickup statement, given as advice. */
export const PICKUP_PROMPT =
  "State your pickup in four lines: what you continue, the next step, what waits on the owner, what changed since.";

/** What `handover continue` reports. Keys are never omitted; null where there is no value. */
export type ContinueResult =
  | {
      readonly action: "default";
      /** Whether a memo was removed, or none existed. */
      readonly memo: "absent" | "removed";
      /** The default line's head, or null when the default line has no handover. */
      readonly head: string | null;
    }
  | {
      readonly action: "continue";
      readonly tip: string;
      readonly role: string | null;
      readonly by: string | null;
      /** Handovers on the line, the tip included, walking to its end. */
      readonly length: number;
      readonly absorbedBy: readonly string[];
      readonly at: string | null;
      /**
       * `counted`: `commitsSince` is set; `not_in_clone`: `at` is a full
       * object id and git has no object by it; `unavailable`: anything git
       * could not settle (an abbreviation, a non-commit object, a failed
       * check or count); `none`: no `at` or no git.
       */
      readonly atState: "counted" | "not_in_clone" | "unavailable" | "none";
      readonly commitsSince: number | null;
      readonly pickup: string;
    };
