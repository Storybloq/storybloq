/**
 * T-255 Lens gate — verification procedure with 7 reason codes.
 *
 * `verifyLensFinding(finding, ctx)` runs the 7-step verification procedure
 * on every `evidence[i]` entry in a lens finding, using the immutable
 * review snapshot produced by T-254 as the source of truth.
 *
 * Return-value semantics:
 * - `VerifyPass` when every evidence item verifies against the
 *   (sha256-verified) snapshot file.
 * - `VerifyFail` when a per-evidence check fires one of the seven reason
 *   codes in `VerifyReasonCode`.
 *
 * Throws `SnapshotIntegrityError` when:
 * - T-254 reader throws (manifest missing/invalid/identity/denormalized/
 *   digest mismatch) → code `manifest_load_failed`.
 * - Payload bytes do not match the manifest sha256 → code
 *   `snapshot_tampered`.
 * - Payload is a symlink at use time (per-file lstat) → code
 *   `payload_symlink`.
 * - Payload realpath escapes canonical snapshot root → code
 *   `payload_escapes_snapshot`.
 *
 * Integrity errors are thrown, not returned, because they indicate the
 * T-254 snapshot contract has been violated and the gate cannot make a
 * verdict when its inputs are untrusted. Callers catch them separately
 * from `VerifyFail` to escalate the review round rather than fail a
 * single finding.
 *
 * The function is "pure" only in the no-mutation sense: it reads
 * filesystem state but never writes. Given the same finding + on-disk
 * snapshot bytes, the result is deterministic.
 */

import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import type { LensFinding, EvidenceItem } from "./types.js";
import {
  readReviewSnapshotManifestWithBytes,
  _assertValidManifestPath,
  _assertNoSymlinkAncestors,
  type ReviewSnapshotManifestFileEntry,
} from "./review-snapshot.js";

// ── Constants ───────────────────────────────────────────────────────

/** ±10 line recovery window for line-drift tolerance. */
export const VERIFY_RECOVERY_WINDOW = 10;

// ── Types ───────────────────────────────────────────────────────────

export type VerifyReasonCode =
  | "invalid_path"
  | "file_not_snapshotted"
  | "snapshot_corrupt"
  | "line_out_of_range"
  | "quote_mismatch"
  | "ambiguous_match"
  | "no_evidence";

export interface VerifiedEvidence {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly matchedStartLine: number;
  readonly matchedEndLine: number;
}

export interface VerifyPass {
  readonly pass: true;
  readonly verifiedEvidence: readonly VerifiedEvidence[];
}

export interface VerifyFailDetails {
  readonly file?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly hits?: number;
  readonly message: string;
}

export interface VerifyFail {
  readonly pass: false;
  readonly reasonCode: VerifyReasonCode;
  /** -1 for finding-level failures (no_evidence). */
  readonly failedEvidenceIndex: number;
  readonly details: VerifyFailDetails;
}

export type VerifyResult = VerifyPass | VerifyFail;

export interface SnapshotContext {
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly reviewId: string;
  /**
   * When provided, `verifyLensFinding` sha256-hashes the manifest.json
   * bytes that came out of the parse-only reader call and escalates to
   * `SnapshotIntegrityError("manifest_load_failed")` on mismatch. The
   * hash is computed against the exact bytes the reader parsed, not a
   * second read of the file, so the parse and the digest check are
   * bound to the same byte buffer (no TOCTOU window).
   */
  readonly expectedManifestSha256?: string;
}

export type SnapshotIntegrityCode =
  | "manifest_load_failed"
  | "snapshot_tampered"
  | "payload_symlink"
  | "payload_escapes_snapshot";

/**
 * Thrown when the snapshot contract from T-254 is violated. Distinct from
 * `VerifyFail` so callers can escalate the review round instead of failing
 * a single finding.
 */
export class SnapshotIntegrityError extends Error {
  public readonly code: SnapshotIntegrityCode;
  public readonly file?: string;

  constructor(code: SnapshotIntegrityCode, message: string, file?: string) {
    super(message);
    this.name = "SnapshotIntegrityError";
    this.code = code;
    this.file = file;
    Object.setPrototypeOf(this, SnapshotIntegrityError.prototype);
  }
}

// ── Public helpers ──────────────────────────────────────────────────

/**
 * Narrow normalization used by both the snapshot file and evidence.code
 * at verification time. Applies the minimal variance absorption needed
 * for quote matching:
 * - CRLF and lone CR → LF.
 * - Per-line trim of trailing whitespace (`\t`, space, `\v`, `\f`, `\r`).
 *
 * Does NOT collapse interior whitespace, does NOT strip blank lines, and
 * does NOT normalize indentation. Tab-vs-space indent mismatches produce
 * `quote_mismatch` in the gate.
 */
export function normalizeForVerification(input: string): string {
  // Convert all line endings to LF first, then trim trailing whitespace
  // per-line. Using split/join keeps blank lines intact.
  const lfOnly = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lfOnly
    .split("\n")
    .map((line) => line.replace(/[ \t\v\f]+$/g, ""))
    .join("\n");
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Run the 7-step verification procedure on every evidence entry in
 * `finding` against the immutable snapshot identified by `ctx`.
 */
export function verifyLensFinding(
  finding: LensFinding,
  ctx: SnapshotContext,
): VerifyResult {
  // Step 0 — no_evidence gate.
  if (finding.evidence.length === 0) {
    return {
      pass: false,
      reasonCode: "no_evidence",
      failedEvidenceIndex: -1,
      details: { message: "finding has zero evidence entries" },
    };
  }

  // Step 0b — load + trust-bootstrap the manifest via the T-254 reader.
  // We use the parse-only `readReviewSnapshotManifestWithBytes` variant
  // because the digest-verified path in `readReviewSnapshotManifest`
  // walks every payload file, and any per-file fault there (symlink,
  // ENOENT, sha256 mismatch) would surface as "manifest_load_failed"
  // and swallow the specific per-evidence outcome the gate owes its
  // caller. Per-payload integrity is enforced inside the per-evidence
  // Step 2 loop instead.
  //
  // When `ctx.expectedManifestSha256` is provided we verify the manifest
  // digest against the SAME buffer the reader just parsed from — the
  // reader returns `manifestBytes` alongside the parsed object, so parse
  // and digest check are bound to one read and there is no TOCTOU window
  // where manifest.json could be swapped between the two.
  let manifest;
  let manifestBytes: Buffer;
  try {
    const loaded = readReviewSnapshotManifestWithBytes(
      ctx.projectRoot,
      ctx.sessionId,
      ctx.reviewId,
    );
    manifest = loaded.manifest;
    manifestBytes = loaded.manifestBytes;
  } catch (err) {
    throw new SnapshotIntegrityError(
      "manifest_load_failed",
      `review-snapshot reader refused manifest: ${(err as Error).message}`,
    );
  }

  if (ctx.expectedManifestSha256 !== undefined) {
    const actualSha = createHash("sha256").update(manifestBytes).digest("hex");
    if (actualSha !== ctx.expectedManifestSha256) {
      throw new SnapshotIntegrityError(
        "manifest_load_failed",
        `manifest digest mismatch: expected ${ctx.expectedManifestSha256}, got ${actualSha}`,
      );
    }
  }

  const snapshotDir = manifest.snapshotRoot;
  const byPath = new Map<string, ReviewSnapshotManifestFileEntry>();
  for (const entry of manifest.files) byPath.set(entry.path, entry);

  // Steps 1–7 outer loop — first failure short-circuits with
  // failedEvidenceIndex = i. Integrity outcomes throw.
  const verified: VerifiedEvidence[] = [];
  for (let i = 0; i < finding.evidence.length; i++) {
    const item = finding.evidence[i] as EvidenceItem;
    const outcome = verifyEvidenceItem(item, snapshotDir, byPath);
    if (outcome.kind === "integrity") {
      throw outcome.error;
    }
    if (outcome.kind === "fail") {
      return {
        pass: false,
        reasonCode: outcome.reasonCode,
        failedEvidenceIndex: i,
        details: outcome.details,
      };
    }
    verified.push(outcome.verified);
  }
  return { pass: true, verifiedEvidence: verified };
}

// ── Internal helpers (not exported from the barrel) ─────────────────

type EvidenceOutcome =
  | { kind: "pass"; verified: VerifiedEvidence }
  | { kind: "fail"; reasonCode: VerifyReasonCode; details: VerifyFailDetails }
  | { kind: "integrity"; error: SnapshotIntegrityError };

function failOutcome(
  reasonCode: VerifyReasonCode,
  details: VerifyFailDetails,
): EvidenceOutcome {
  return { kind: "fail", reasonCode, details };
}

function integrityOutcome(
  code: SnapshotIntegrityCode,
  message: string,
  file?: string,
): EvidenceOutcome {
  return {
    kind: "integrity",
    error: new SnapshotIntegrityError(code, message, file),
  };
}

/**
 * Verify a single evidence entry against the snapshot. Returns a tagged
 * union that the outer loop unwraps into the public `VerifyResult`. Any
 * `integrity` outcome escalates to a thrown `SnapshotIntegrityError` in
 * the outer loop.
 */
function verifyEvidenceItem(
  evidence: EvidenceItem,
  snapshotDir: string,
  byPath: ReadonlyMap<string, ReviewSnapshotManifestFileEntry>,
): EvidenceOutcome {
  // ── Step 1 — path canonicalization ─────────────────────────────
  // 1a. Lexical contract.
  try {
    _assertValidManifestPath(evidence.file, `evidence path`);
  } catch (err) {
    return failOutcome("invalid_path", {
      file: typeof evidence.file === "string" ? evidence.file : undefined,
      message: (err as Error).message,
    });
  }

  // ── Step 2 — manifest lookup + payload integrity verification ──
  const entry = byPath.get(evidence.file);
  if (!entry) {
    return failOutcome("file_not_snapshotted", {
      file: evidence.file,
      message: `evidence path not in snapshot manifest: ${evidence.file}`,
    });
  }

  // Resolve payload location under the snapshot directory.
  const resolved = resolve(snapshotDir, evidence.file);
  const snapshotDirWithSep = snapshotDir.endsWith(sep)
    ? snapshotDir
    : snapshotDir + sep;
  if (
    !resolved.startsWith(snapshotDirWithSep) &&
    resolved !== snapshotDir
  ) {
    return failOutcome("invalid_path", {
      file: evidence.file,
      message: `resolved path escapes snapshot root: ${resolved}`,
    });
  }

  // 1b. Destination-chain symlink guard (covers pre-leaf symlinks).
  try {
    _assertNoSymlinkAncestors(resolved, snapshotDir);
  } catch (err) {
    return integrityOutcome(
      "payload_symlink",
      `destination chain for ${evidence.file} contains a symlink: ${(err as Error).message}`,
      evidence.file,
    );
  }

  // Leaf lstat — catches symlink-at-use-time even if the walker didn't.
  let lst;
  try {
    lst = lstatSync(resolved);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return failOutcome("snapshot_corrupt", {
        file: evidence.file,
        message: `payload missing on disk: ${evidence.file}`,
      });
    }
    throw err;
  }
  if (lst.isSymbolicLink()) {
    return integrityOutcome(
      "payload_symlink",
      `payload is a symlink: ${resolved}`,
      evidence.file,
    );
  }
  if (!lst.isFile()) {
    return failOutcome("snapshot_corrupt", {
      file: evidence.file,
      message: `payload is not a regular file: ${evidence.file}`,
    });
  }

  // Realpath containment (unreachable on standard single-mount-namespace filesystems).
  const snapshotDirReal = realpathSync(snapshotDir);
  const snapshotDirRealWithSep = snapshotDirReal.endsWith(sep)
    ? snapshotDirReal
    : snapshotDirReal + sep;
  const realResolved = realpathSync(resolved);
  if (
    !realResolved.startsWith(snapshotDirRealWithSep) &&
    realResolved !== snapshotDirReal
  ) {
    return integrityOutcome(
      "payload_escapes_snapshot",
      `payload realpath ${realResolved} escapes snapshot root ${snapshotDirReal}`,
      evidence.file,
    );
  }

  // Payload integrity verification — byte length first, then sha256.
  // Post-write tampering (chmod-then-overwrite, same-length substitution,
  // atomic-rename swap) all hit here and escalate to an integrity error.
  const rawBytes = readFileSync(realResolved);
  if (rawBytes.length !== entry.bytes) {
    return integrityOutcome(
      "snapshot_tampered",
      `payload byte length ${rawBytes.length} does not match manifest ${entry.bytes} for ${entry.path}`,
      entry.path,
    );
  }
  const actualSha = createHash("sha256").update(rawBytes).digest("hex");
  if (actualSha !== entry.sha256) {
    return integrityOutcome(
      "snapshot_tampered",
      `payload sha256 does not match manifest for ${entry.path}`,
      entry.path,
    );
  }

  // ── Step 3 — strict range sanity ───────────────────────────────
  // 3a. Structurally invalid → immediate line_out_of_range.
  if (
    !Number.isInteger(evidence.startLine) ||
    !Number.isInteger(evidence.endLine) ||
    evidence.startLine < 1 ||
    evidence.endLine < evidence.startLine
  ) {
    return failOutcome("line_out_of_range", {
      file: evidence.file,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      message: "range is structurally invalid",
    });
  }

  // ── Step 4 — normalize file + quote ────────────────────────────
  const fileText = rawBytes.toString("utf-8");
  const normFile = normalizeForVerification(fileText);
  const normCode = normalizeForVerification(evidence.code);

  // Build the line-offset index on normFile.
  const lineStarts: number[] = [0];
  for (let i = 0; i < normFile.length; i++) {
    if (normFile.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  // lineStarts.length counts the phantom empty final line for \n-terminated files.
  const fileLineCount = lineStarts.length;

  // 3b. Stale range — startLine past EOF. Whole-file search fallback.
  const staleRange = evidence.startLine > fileLineCount;

  // Whitespace-only / empty quote guard (applied to the normalized quote
  // so blank-line matches cannot sneak through).
  const strippedQuote = normCode.replace(/[\s\n]/g, "");
  if (strippedQuote.length === 0) {
    return failOutcome("quote_mismatch", {
      file: evidence.file,
      message: "empty or whitespace-only evidence code",
    });
  }

  // ── Step 5 — search ────────────────────────────────────────────
  let searchStart: number;
  let searchEnd: number;
  if (!staleRange) {
    const windowStartLine = Math.max(1, evidence.startLine - VERIFY_RECOVERY_WINDOW);
    const windowEndLineUnclamped = evidence.endLine + VERIFY_RECOVERY_WINDOW;
    const windowEndLine = Math.min(fileLineCount, windowEndLineUnclamped);
    searchStart = lineStarts[windowStartLine - 1] ?? 0;
    searchEnd =
      windowEndLine >= fileLineCount
        ? normFile.length
        : (lineStarts[windowEndLine] ?? normFile.length);
  } else {
    searchStart = 0;
    searchEnd = normFile.length;
  }

  // cap=2 — we only need to distinguish 0, 1, and >=2 hits to decide
  // pass / ambiguous_match. Once two hits are collected the scan stops.
  const hits = findAllHitsBounded(normFile, normCode, searchStart, searchEnd, 2);

  // ── Step 6 — decide ────────────────────────────────────────────
  if (hits.length === 1) {
    const matched = mapOffsetToLineRange(
      hits[0] as number,
      normCode.length,
      lineStarts,
    );
    return {
      kind: "pass",
      verified: {
        file: evidence.file,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        matchedStartLine: matched.startLine,
        matchedEndLine: matched.endLine,
      },
    };
  }
  if (hits.length >= 2) {
    return failOutcome("ambiguous_match", {
      file: evidence.file,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      hits: hits.length,
      message: `quote matched ${hits.length} times in search window`,
    });
  }
  // hits.length === 0
  return failOutcome(staleRange ? "line_out_of_range" : "quote_mismatch", {
    file: evidence.file,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    message: staleRange
      ? `stale range (startLine ${evidence.startLine} > fileLineCount ${fileLineCount}) and quote not found in whole-file search`
      : `quote not found in ±${VERIFY_RECOVERY_WINDOW} line window around [${evidence.startLine}..${evidence.endLine}]`,
  });
}

/**
 * Non-overlapping indexOf scan bounded to `[lo, hi)`. Collects at most
 * `cap` hits and short-circuits as soon as that many have been found,
 * so callers that only care about `>= cap` do not walk the whole file.
 */
function findAllHitsBounded(
  haystack: string,
  needle: string,
  lo: number,
  hi: number,
  cap: number,
): number[] {
  if (needle.length === 0) return [];
  const out: number[] = [];
  let cursor = lo;
  while (out.length < cap && cursor + needle.length <= hi) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1 || idx + needle.length > hi) break;
    out.push(idx);
    cursor = idx + needle.length;
  }
  return out;
}

/**
 * Map a `[offset, offset+length)` range in `normFile` to a 1-based line
 * range using binary search on `lineStarts`.
 */
function mapOffsetToLineRange(
  offset: number,
  length: number,
  lineStarts: readonly number[],
): { startLine: number; endLine: number } {
  const lastOffset = offset + Math.max(0, length - 1);
  return {
    startLine: lineForOffset(offset, lineStarts),
    endLine: lineForOffset(lastOffset, lineStarts),
  };
}

function lineForOffset(offset: number, lineStarts: readonly number[]): number {
  // Binary search for the largest index i with lineStarts[i] <= offset.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((lineStarts[mid] as number) <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo + 1; // 1-based.
}
