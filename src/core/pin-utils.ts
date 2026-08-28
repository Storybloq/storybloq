import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs";
import { createHash } from "node:crypto";

/**
 * 1 MiB -- generous relative to any real plan.md (T-473's own ran ~35KB),
 * finite so a corrupted/hostile file can't hang a synchronous read.
 * Distinct from `readFileSafe`'s intentional no-bound for the drift-baseline
 * heuristic (autonomous/stages/plan-review.ts) -- that is a different,
 * lower-stakes purpose; this module backs a security-relevant pin.
 */
export const PLAN_ACK_MAX_BYTES = 1_048_576;

export type BoundedFileReadResult =
  | { status: "ok"; bytes: Buffer }
  | { status: "missing" | "unreadable" | "empty"; reason: string };

/**
 * Read a regular file's raw bytes, bounded and TOCTOU-closed: one `openSync`
 * with `O_NOFOLLOW` fixes the inode, then `fstatSync`/`readFileSync` both
 * operate on that SAME descriptor -- nothing between open and read can swap
 * what is being read out from under the check. Distinguishes "does not
 * exist" from every other failure, unlike `core/limit-config.ts`'s
 * `readBoundedFile` (which collapses every failure into a single `null`,
 * correct for that reader's warn-and-skip callers but wrong for a
 * permission-decision reader that must never conflate "absent" with
 * "unreadable").
 */
export function readBoundedRegularFile(path: string, maxBytes: number): BoundedFileReadResult {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "missing", reason: "file not found" };
    if (code === "ELOOP") return { status: "unreadable", reason: "path is a symlink, refused" };
    return { status: "unreadable", reason: String(err) };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { status: "unreadable", reason: "not a regular file" };
    if (stat.size > maxBytes) return { status: "unreadable", reason: `exceeds ${maxBytes} bytes` };
    const bytes = readFileSync(fd);
    if (bytes.length === 0) return { status: "empty", reason: "file is empty" };
    return { status: "ok", bytes };
  } finally {
    closeSync(fd);
  }
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
