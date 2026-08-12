import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { telemetryDirPath } from "./liveness.js";
import { withTelemLock } from "./telemetry-writer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeverityCounts {
  readonly critical: number;
  readonly major: number;
  readonly minor: number;
  readonly suggestion: number;
}

export interface ReviewVerdictArtifact {
  readonly target: string;
  readonly stage: string;
  readonly round: number;
  readonly reviewer: string;
  readonly verdict: string;
  readonly findingsCount: number;
  readonly severityCounts: SeverityCounts;
  readonly unresolvedCriticalCount?: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly summary: string;
  readonly findings: readonly unknown[];
  readonly timestamp: string;
  // ISS-720: the lens review id this round used (the join key into
  // verification-telemetry.jsonl) and the path actually taken, so analytics can
  // tell a real lens-verified round from one where the lens pipeline was
  // skipped/bypassed. Optional and additive: only set for lenses reviews.
  readonly reviewId?: string;
  readonly reviewerPath?: "lenses-verified" | "lenses-unverified";
  // T-461: the effort level this round ran at. Additive and optional, so a
  // pre-dial artifact still parses and still hashes identically.
  readonly effort?: string;
}

export interface Tier1ReviewVerdict {
  readonly stage: string;
  readonly round: number;
  readonly verdict: string;
  readonly findingCount: number;
  readonly criticalCount: number;
  readonly unresolvedCriticalCount?: number;
  readonly majorCount: number;
  readonly suggestionCount: number;
  readonly durationMs: number;
  readonly summary: string;
  /** T-461: carried onto Tier1 so `lastReviewVerdict` discloses the level too. */
  readonly effort?: string;
}

export type WriteVerdictResult =
  | { readonly status: "written"; readonly contentHash: string }
  | { readonly status: "exists"; readonly contentHash: string }
  | { readonly status: "skipped" };

// ---------------------------------------------------------------------------
// Canonical content hash
// ---------------------------------------------------------------------------

function canonicalize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

export function computeContentHash(artifact: ReviewVerdictArtifact): string {
  // ISS-720: reviewId/reviewerPath are observability metadata (the second is
  // derived from telemetry, not authored review content), so they are excluded
  // from the dedupe hash alongside timestamp/_contentHash/durationMs. Round is
  // already part of the hash, so excluding reviewId keeps hashes stable across
  // this additive schema change without risking cross-round collisions.
  // T-461: `effort` joins them for the same reason and one more. It is
  // disclosure metadata, not authored review content -- two rounds whose
  // findings and verdict are identical are the same review whether one ran at
  // light -- and including it would change every hash the moment the dial
  // shipped, which is exactly the cross-version churn the exclusion list
  // exists to prevent.
  const {
    timestamp: _ts,
    _contentHash: _ch,
    durationMs: _dur,
    reviewId: _rid,
    reviewerPath: _rpath,
    effort: _effort,
    ...rest
  } = artifact as Record<string, unknown>;
  const canonical = canonicalize(rest);
  return createHash("sha256").update(JSON.stringify(canonical), "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

export function verdictFilename(target: string, stage: string, round: number): string {
  const safeTarget = target.replace(/\//g, "-");
  return `${safeTarget}-${stage.toLowerCase()}-r${round}.json`;
}

// ---------------------------------------------------------------------------
// Write verdict artifact (Tier 2)
// ---------------------------------------------------------------------------

export function writeReviewVerdict(
  sessionDir: string,
  artifact: ReviewVerdictArtifact,
): WriteVerdictResult {
  const contentHash = computeContentHash(artifact);

  try {
    const reviewsDir = join(telemetryDirPath(sessionDir), "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    const filename = verdictFilename(artifact.target, artifact.stage, artifact.round);
    const filePath = join(reviewsDir, filename);

    const result = withTelemLock(sessionDir, () => {
      if (existsSync(filePath)) {
        try {
          const existing = JSON.parse(readFileSync(filePath, "utf-8"));
          if (existing._contentHash && typeof existing._contentHash === "string") {
            return { status: "exists" as const, contentHash: existing._contentHash as string };
          }
        } catch { /* fall through */ }
        return { status: "exists" as const, contentHash };
      }

      const payload = { ...artifact, _contentHash: contentHash };
      const content = JSON.stringify(payload, null, 2) + "\n";
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, content, "utf-8");
      try {
        renameSync(tmp, filePath);
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* best-effort */ }
        throw err;
      }

      return { status: "written" as const, contentHash };
    });

    return result ?? { status: "skipped" as const };
  } catch {
    return { status: "skipped" as const };
  }
}

// ---------------------------------------------------------------------------
// Read verdict artifact (for crash recovery)
// ---------------------------------------------------------------------------

export function readReviewVerdict(
  sessionDir: string,
  expectedHash: string,
): ReviewVerdictArtifact | null {
  try {
    const reviewsDir = join(telemetryDirPath(sessionDir), "reviews");
    const files = readdirSync(reviewsDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(reviewsDir, file), "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed._contentHash === expectedHash) {
          const { _contentHash: _, ...artifact } = parsed;
          const recomputed = computeContentHash(artifact as ReviewVerdictArtifact);
          if (recomputed !== expectedHash) continue;
          return artifact as ReviewVerdictArtifact;
        }
      } catch { /* skip malformed files */ }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build Tier 1 verdict (lossy projection)
// ---------------------------------------------------------------------------

export function buildTier1Verdict(artifact: ReviewVerdictArtifact): Tier1ReviewVerdict {
  const unresolvedCriticalCount = artifact.unresolvedCriticalCount ?? deriveUnresolvedCriticalCount(artifact);
  return {
    stage: artifact.stage,
    round: artifact.round,
    verdict: artifact.verdict,
    findingCount: artifact.findingsCount,
    criticalCount: artifact.severityCounts.critical,
    unresolvedCriticalCount,
    majorCount: artifact.severityCounts.major,
    suggestionCount: artifact.severityCounts.suggestion,
    durationMs: artifact.durationMs,
    summary: artifact.summary,
    ...(artifact.effort === undefined ? {} : { effort: artifact.effort }),
  };
}

function deriveUnresolvedCriticalCount(artifact: ReviewVerdictArtifact): number {
  let unresolved = 0;
  let criticalFindings = 0;
  for (const finding of artifact.findings) {
    if (!finding || typeof finding !== "object") continue;
    const record = finding as Record<string, unknown>;
    if (String(record.severity).toLowerCase() !== "critical") continue;
    criticalFindings += 1;
    if (typeof record.disposition !== "string") {
      return artifact.severityCounts.critical;
    }
    const disposition = record.disposition.toLowerCase();
    if (disposition !== "addressed" && disposition !== "deferred") unresolved += 1;
  }
  return criticalFindings === artifact.severityCounts.critical
    ? unresolved
    : artifact.severityCounts.critical;
}

// ---------------------------------------------------------------------------
// ISS-720: classify the lens review path actually taken
// ---------------------------------------------------------------------------

/**
 * Read per-review verification telemetry and report whether the lens
 * verification pipeline actually verified findings for `reviewId`, so a
 * recorded `reviewer: "lenses"` tag can be distinguished from a round where the
 * lens path was skipped or degraded. The configured backend alone over-counts
 * "lens-reviewed"; this reflects the path taken. A round is "lenses-unverified"
 * when verification was skipped (no snapshot), the snapshot failed integrity
 * (legacy entries only -- a live integrity failure now throws before telemetry
 * is written), OR any finding bypassed verification with a runtime error
 * (verificationRuntimeErrors > 0): in that last case the gate ran but let some
 * findings through unverified, so the round was not fully verified.
 *
 * Returns undefined when no telemetry can be attributed to the review: no
 * reviewId supplied, the telemetry file is absent/unreadable, or no entry
 * matches (e.g. the lens synthesize step never ran for this id). The last
 * matching entry wins, mirroring accumulateVerificationCounters' line semantics
 * (drop the trailing partial/empty segment).
 */
export function classifyLensReviewPath(
  sessionDir: string,
  reviewId: string | undefined,
): "lenses-verified" | "lenses-unverified" | undefined {
  if (!reviewId) return undefined;
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, "verification-telemetry.jsonl"), "utf-8");
  } catch {
    return undefined;
  }
  const lines = raw === "" ? [] : raw.split("\n").slice(0, -1);
  let match: Record<string, unknown> | undefined;
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as Record<string, unknown>;
      if (e && e.reviewId === reviewId) match = e;
    } catch {
      // malformed line: skip
    }
  }
  if (!match) return undefined;
  // Number(undefined) is NaN and NaN > 0 is false, so legacy entries without
  // verificationRuntimeErrors are not falsely downgraded.
  // ISS-760: verificationDegraded means the gate RAN against a partial
  // snapshot (some reviewed paths could not be captured). It is distinct
  // from skipped in telemetry, but the round still classifies as
  // lenses-unverified -- before ISS-760 the same situation aborted the
  // snapshot entirely and landed here via verificationSkipped, so this
  // preserves the existing classification rather than flipping degraded
  // rounds to lenses-verified.
  if (
    match.snapshotIntegrityFailure === true ||
    match.verificationSkipped === true ||
    match.verificationDegraded === true ||
    Number(match.verificationRuntimeErrors) > 0
  ) {
    return "lenses-unverified";
  }
  return "lenses-verified";
}
