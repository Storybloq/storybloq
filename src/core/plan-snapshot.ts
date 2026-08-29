import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicCreate } from "./project-loader.js";
import { ProjectLoaderError } from "./errors.js";
import { readBoundedRegularFile, sha256Bytes, PLAN_ACK_MAX_BYTES } from "./pin-utils.js";

/**
 * ISS-1050 full fix: a content-addressed snapshot of an approved plan.md,
 * taken at the moment PLAN_REVIEW decides to land at IMPLEMENT. Mirrors
 * gate-ack-loader.ts's conventions: bounded read via pin-utils.ts, atomic
 * write via project-loader.ts's atomicCreate.
 */
export interface PlanSnapshotRef {
  /** Filename only (never a path), relative to the session dir. Always matches SNAPSHOT_FILENAME_RE. */
  readonly filename: string;
  readonly sha256: string;
}

const SNAPSHOT_FILENAME_RE = /^plan-approved-([0-9a-f]{64})\.md$/;

export type PlanSnapshotWriteResult =
  | { status: "ok"; ref: PlanSnapshotRef }
  | { status: "unreadable"; reason: string };

export type PlanSnapshotReadResult =
  | { status: "ok"; text: string }
  | { status: "unreadable"; reason: string };

/**
 * Write `planBytes` as a content-addressed snapshot under `sessionDir`.
 * Idempotent by construction: the filename IS the hash, so a retried write of
 * identical content targets the same path. `atomicCreate` throws
 * `ProjectLoaderError("file_exists")` on a second write to that path -- since
 * content-addressing means same name implies same bytes (barring a SHA-256
 * collision, out of this threat model, matching every other pin in this
 * codebase), that specific failure is caught and treated as success without a
 * re-read: re-verifying every idempotent hit against what content-addressing
 * already guarantees is pure overhead on the common resubmission path.
 */
export async function writePlanSnapshot(
  sessionDir: string,
  planBytes: Buffer,
): Promise<PlanSnapshotWriteResult> {
  // The hash is computed from the raw BYTES, but `atomicCreate` only accepts
  // a string. `planBytes.toString("utf-8")` on an invalid UTF-8 sequence
  // silently substitutes U+FFFD replacement characters -- the bytes actually
  // written would then never hash back to `sha256`, permanently failing
  // every future read with no indication why. Round-tripped and checked
  // losslessly BEFORE the hash is even computed, so an invalid encoding
  // fails the write outright rather than producing an unreadable snapshot.
  const roundTripped = Buffer.from(planBytes.toString("utf-8"), "utf-8");
  if (!roundTripped.equals(planBytes)) {
    return { status: "unreadable", reason: "plan content is not valid UTF-8 and cannot be snapshotted losslessly" };
  }
  const sha256 = sha256Bytes(planBytes);
  const filename = `plan-approved-${sha256}.md`;
  const targetPath = join(sessionDir, filename);
  try {
    await mkdir(sessionDir, { recursive: true });
    await atomicCreate(targetPath, planBytes.toString("utf-8"));
  } catch (err) {
    if (err instanceof ProjectLoaderError && err.code === "file_exists") {
      return { status: "ok", ref: { filename, sha256 } };
    }
    return { status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  return { status: "ok", ref: { filename, sha256 } };
}

/**
 * Read a snapshot back. Validates `ref.filename` against
 * `SNAPSHOT_FILENAME_RE` and requires the regex's captured hash to equal
 * `ref.sha256` BEFORE any path is built -- a mismatched pair (possible only
 * via a hand-edited or corrupted state.json, since this module is the only
 * writer) is refused here rather than trusted. `join()` on a filename that
 * has already passed this regex cannot escape `sessionDir`: the pattern
 * admits no `/` or `..` in any form.
 */
export function readPlanSnapshot(sessionDir: string, ref: PlanSnapshotRef): PlanSnapshotReadResult {
  const match = SNAPSHOT_FILENAME_RE.exec(ref.filename);
  if (!match || match[1] !== ref.sha256) {
    return { status: "unreadable", reason: "snapshot reference is malformed (filename/hash mismatch)" };
  }
  const read = readBoundedRegularFile(join(sessionDir, ref.filename), PLAN_ACK_MAX_BYTES);
  if (read.status !== "ok") return { status: "unreadable", reason: read.reason };
  if (sha256Bytes(read.bytes) !== ref.sha256) {
    return { status: "unreadable", reason: "snapshot content does not match its recorded hash" };
  }
  return { status: "ok", text: read.bytes.toString("utf-8") };
}
