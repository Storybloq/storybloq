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
import type { Finding } from "./session-types.js";
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

  // ── T-488 Run A: the identity and provenance spine ──────────────────────
  // All optional, all additive. An absent value means the record predates the
  // field, which is a different statement from a known-empty one, and every
  // reader below is written to keep those two apart.

  /** ISS-1032: the round's subject. A ticket OR an issue, never a `ticketId`. */
  readonly workItemId?: string;
  readonly kind?: "ticket" | "issue";
  /** Stable across every sink for one round, and across a crash mid-sink. */
  readonly reviewAttemptId?: string;
  /** Stable across every round of one attempt at one work item. */
  readonly itemAttemptId?: string;
  /** The backend's own run/thread id. See `deriveJoinAvailability` for scope. */
  readonly backendRunId?: string;
  readonly backendRunIdKind?: "codex-session" | "agent-dispatch" | "lens-review";
  /** Populated ONLY when a backend supplies one. Today none do (T-488 D5). */
  readonly backendTurnId?: string;
  /** Normalized enum BESIDE the free-text `reviewer`, never replacing it. */
  readonly backend?: "codex" | "agent" | "lenses" | "mixed" | "other";
  /** Which severity normalization produced these findings. Absent = unknown. */
  readonly normalizerVersion?: number;
  /**
   * Which generation of this attempt's rounds this is.
   *
   * INCLUDED in the content hash: round 1 of generation 2 is a different round
   * from round 1 of generation 1, and treating them as the same is the defect
   * that dropped nine rounds of westworld session 08a52602.
   */
  readonly generation?: number;
  /** Does the verdict agree with the findings it carries (ISS-1114's rule)? */
  readonly payloadConsistent?: boolean;
  readonly reviewerIdentity?: ArtifactProvenance;
  readonly implementer?: ArtifactProvenance;
  /**
   * The outcome of THIS attempt's artifact sink.
   *
   * Its real work is historical. An ABSENT value means the record predates the
   * field and the artifact's existence is unknown, which is the only honest
   * reading for pre-artifact-era rounds and for rounds whose artifacts were
   * dropped by the generation collision. A reader never infers that an artifact
   * exists for a round.
   */
  readonly artifactStatus?: "written" | "exists";
}

/** Provenance as it lands on the record, structurally identical to `Provenance`. */
export interface ArtifactProvenance {
  readonly model?: string;
  readonly tier?: string;
  readonly effort?: string;
  readonly source: "explicit-pin" | "session-default" | "unknown";
  readonly evidence: "observed" | "configured" | "none";
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

/**
 * T-488 D10b: why the artifact sink failed.
 *
 * There is no "telemetry disabled" state to distinguish. `telemetryDirPath` is
 * unconditional, nothing gates this writer off, and `withTelemLock` returns
 * `undefined` only when a filesystem call throws. So every `skipped` is a
 * FAILURE, and a disabled-versus-failed split would let a broken telemetry
 * directory be recorded as "the operator turned it off" -- inventing intent
 * from a fault, which is the exact error this ticket exists to prevent.
 *
 * `lock-unavailable` covers the whole lock-acquisition path, which INCLUDES
 * creating the directory the lock lives in: `withTelemLock` returns undefined
 * for a failed `mkdirSync` as well as a failed `lockSync`, and neither is
 * distinguishable from the other at this seam.
 */
export type VerdictSkipReason = "lock-unavailable" | "io-error";

export type WriteVerdictResult =
  | { readonly status: "written"; readonly contentHash: string }
  | {
      readonly status: "exists";
      readonly contentHash: string;
      /**
       * The artifact already at that path, so a caller can check WHOSE it is.
       *
       * A content-hash match alone is not grounds to adopt an artifact: attempt
       * ids are deliberately excluded from the hash, so two distinct executions
       * with identical findings hash identically. Null when the file could not
       * be parsed.
       */
      readonly existing: ReviewVerdictArtifact | null;
    }
  | { readonly status: "skipped"; readonly reason: VerdictSkipReason };

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

/**
 * T-488 D10: hash membership is decided EXHAUSTIVELY at compile time.
 *
 * The previous exclusion-list destructure could not catch a new field that
 * silently defaulted to *included*, which is exactly the case the acceptance
 * criterion promises to catch. A hand-built "fully populated" fixture is no
 * better: every field here is optional, so adding one and forgetting the
 * fixture leaves the assertion green.
 *
 * `satisfies Record<keyof T, HashDecision>` makes that impossible instead of
 * unlikely. Adding an optional property to either type without classifying it
 * FAILS COMPILATION -- no fixture to update, nothing for an author to remember.
 *
 * The rule (Gate 0): identity is WHAT THE ROUND WAS; excluded is how it was
 * produced and what it cost.
 */
type HashDecision = "included" | "excluded";

const ARTIFACT_HASH_DECISIONS = {
  // ── identity: what the round was ──
  target: "included",
  stage: "included",
  round: "included",
  reviewer: "included",
  verdict: "included",
  findingsCount: "included",
  severityCounts: "included",
  unresolvedCriticalCount: "included",
  startedAt: "included",
  summary: "included",
  findings: "included",
  workItemId: "included",
  kind: "included",
  backend: "included",
  payloadConsistent: "included",
  // Round 1 of generation 2 is a DIFFERENT ROUND from round 1 of generation 1.
  // Excluding it would make two same-numbered rounds from different generations
  // with identical findings hash identically -- the very collision the
  // generation namespace exists to prevent.
  generation: "included",

  // ── production metadata: how it was produced, what it cost ──
  timestamp: "excluded",
  durationMs: "excluded",
  reviewId: "excluded",
  reviewerPath: "excluded",
  effort: "excluded",
  reviewAttemptId: "excluded",
  itemAttemptId: "excluded",
  backendRunId: "excluded",
  backendRunIdKind: "excluded",
  backendTurnId: "excluded",
  reviewerIdentity: "excluded",
  implementer: "excluded",
  artifactStatus: "excluded",
  // Excluded because the findings are themselves INCLUDED, and their `severity`
  // values already differ when the normalizer differs. The version number adds
  // nothing to identity that the findings do not already carry.
  normalizerVersion: "excluded",
  // INCLUDED, and deliberately so: this is WHAT THE ROUND WAS, the same
  // category as target/stage/round/generation above it, not how the round was
  // produced or what it cost. Two rounds over different trees are different
  // rounds and must not share a hash. The KIND is included for the same
  // reason: the same hex string means two different things under the two
  // kinds, so a round that content-hashed a dirty diff is not the round that
  // named a commit tree with a coincidentally equal value.
} satisfies Record<keyof ReviewVerdictArtifact, HashDecision>;

/**
 * Every finding field is INCLUDED, and the runtime hashes the finding object
 * whole, so the map and the behavior agree today with no filtering step.
 *
 * That is deliberate rather than an omission. Findings arrive carrying fields
 * outside the `Finding` type (`lens`, most notably), and they are already in
 * every existing artifact's hash -- filtering findings down to the classified
 * keys would change the hash of every lens-backed artifact ever written. So the
 * map's job here is the compile-time one: an author who adds a finding field
 * must CLASSIFY it, and anyone who classifies one `excluded` has to build the
 * filtering step and own the hash break that comes with it.
 */
const FINDING_HASH_DECISIONS = {
  id: "included",
  severity: "included",
  category: "included",
  description: "included",
  disposition: "included",
  recommendedNextState: "included",
  rawSeverity: "included",
  // ISS-1115 D4. All four are INCLUDED, for the same reason `disposition`
  // beside them is: they are content the reviewer reported about the finding,
  // which is WHAT THE ROUND WAS. The excluded side of this map is how a round
  // was produced and what it cost, and none of these is that. A round that
  // reported a finding as `reintroduced` is a different round from one that
  // reported the same finding as `new`, and the hash should say so.
  dispositionReason: "included",
  origin: "included",
  originClass: "included",
  sinceRound: "included",
} satisfies Record<keyof Finding, HashDecision>;

/** Derived from the maps above, so there is exactly one source of truth. */
const EXCLUDED_ARTIFACT_KEYS: ReadonlySet<string> = new Set(
  Object.entries(ARTIFACT_HASH_DECISIONS)
    .filter(([, decision]) => decision === "excluded")
    .map(([key]) => key),
);

/** Exported so the hash test asserts against the maps, not a copy of them. */
export const HASH_DECISIONS = {
  artifact: ARTIFACT_HASH_DECISIONS as Readonly<Record<string, HashDecision>>,
  finding: FINDING_HASH_DECISIONS as Readonly<Record<string, HashDecision>>,
} as const;

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
  //
  // T-488: `_contentHash` is excluded structurally rather than by map entry --
  // it is the hash's own output and not a member of the artifact type at all.
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(artifact as unknown as Record<string, unknown>)) {
    if (key === "_contentHash") continue;
    if (EXCLUDED_ARTIFACT_KEYS.has(key)) continue;
    rest[key] = value;
  }
  const canonical = canonicalize(rest);
  return createHash("sha256").update(JSON.stringify(canonical), "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

/**
 * T-488 D3: the generation is a SUFFIX, and that is load-bearing.
 *
 * External readers glob `*-code-r*.json` (the observatory scripts, and the
 * fleet analysis this ticket was filed from). `T-001-code-r2-g1.json` matches
 * that glob; `T-001-code-g1-r2.json` does NOT -- an infix would silently hide
 * every later generation from every existing reader, which is a fix that
 * conceals its own result.
 *
 * Generation 0 keeps the original unsuffixed form byte-for-byte, so no existing
 * path changes.
 */
export function verdictFilename(
  target: string,
  stage: string,
  round: number,
  generation = 0,
): string {
  const safeTarget = target.replace(/\//g, "-");
  const suffix = generation >= 1 ? `-g${generation}` : "";
  return `${safeTarget}-${stage.toLowerCase()}-r${round}${suffix}.json`;
}

/**
 * The inverse, centralized so no reader parses these names by hand.
 *
 * Understands both forms; an unsuffixed name is generation 0. Returns null for
 * anything that is not a verdict artifact name. `target` may itself contain
 * hyphens (`T-001`), so the round/generation tail is matched from the END.
 */
export function parseVerdictFilename(
  filename: string,
): { target: string; stage: string; round: number; generation: number } | null {
  const match = /^(.+)-([a-z]+)-r(\d+)(?:-g(\d+))?\.json$/.exec(filename);
  const [, target, stage, round, generation] = match ?? [];
  if (target === undefined || stage === undefined || round === undefined) return null;
  return {
    target,
    stage,
    round: Number(round),
    generation: generation === undefined ? 0 : Number(generation),
  };
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
    const filename = verdictFilename(
      artifact.target,
      artifact.stage,
      artifact.round,
      artifact.generation ?? 0,
    );
    const filePath = join(reviewsDir, filename);

    const result = withTelemLock(sessionDir, () => {
      if (existsSync(filePath)) {
        try {
          const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
          const { _contentHash: existingHash, ...existing } = parsed;
          // T-488: the existing artifact travels back with the verdict so the
          // caller can ask WHOSE it is. A hash match is not ownership.
          return {
            status: "exists" as const,
            contentHash: typeof existingHash === "string" ? existingHash : contentHash,
            existing: existing as unknown as ReviewVerdictArtifact,
          };
        } catch { /* fall through */ }
        return { status: "exists" as const, contentHash, existing: null };
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

    // T-488 D10b: `withTelemLock` yields undefined only when the lock could not
    // be taken -- which includes failing to CREATE the directory the lock lives
    // in. Both are the same observation from here and neither is a disabled
    // telemetry sink, because no such state exists.
    return result ?? { status: "skipped" as const, reason: "lock-unavailable" as const };
  } catch {
    return { status: "skipped" as const, reason: "io-error" as const };
  }
}

/**
 * Does an artifact already on disk belong to the attempt about to write it?
 *
 * Exported because it is the ONLY sanctioned answer to "is this exists-result
 * mine?" A content-hash match is not: attempt ids are excluded from the hash,
 * so two distinct executions with identical findings hash identically.
 *
 * An artifact with NO attempt identity is legacy. It is never claimed and never
 * adopted -- absence is not a match, and treating it as one is how a legacy
 * round silently acquires this attempt's provenance.
 */
export function artifactBelongsToAttempt(
  existing: ReviewVerdictArtifact | null,
  identity: { readonly reviewAttemptId?: string; readonly itemAttemptId?: string },
): boolean {
  if (!existing) return false;
  if (!identity.reviewAttemptId) return false;
  if (existing.reviewAttemptId !== identity.reviewAttemptId) return false;
  // An itemAttemptId on one side and not the other is a mismatch, not a
  // partial match: the pair is the identity, and half of it identifies nothing.
  return (existing.itemAttemptId ?? null) === (identity.itemAttemptId ?? null);
}

// ---------------------------------------------------------------------------
// Read verdict artifact (for crash recovery)
// ---------------------------------------------------------------------------

export function readReviewVerdict(
  sessionDir: string,
  expectedHash: string,
  /**
   * T-488 D3: attempt identity, matched FIRST when supplied.
   *
   * Without it this reader selects on `_contentHash` alone, and distinct
   * attempts can deliberately share a hash -- so it could hand back another
   * attempt's artifact and, with it, another attempt's provenance. That went
   * from theoretical to reachable the moment the generation namespace made it
   * possible for both artifacts to be written successfully.
   *
   * The hash-only path is preserved for callers with no attempt identity, which
   * is every legacy record.
   */
  identity?: { readonly reviewAttemptId?: string; readonly itemAttemptId?: string },
): ReviewVerdictArtifact | null {
  try {
    const reviewsDir = join(telemetryDirPath(sessionDir), "reviews");
    const files = readdirSync(reviewsDir);
    const all: { artifact: ReviewVerdictArtifact; storedHash: unknown }[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(reviewsDir, file), "utf-8");
        const parsed = JSON.parse(raw);
        const { _contentHash: storedHash, ...artifact } = parsed;
        all.push({ artifact: artifact as ReviewVerdictArtifact, storedHash });
      } catch { /* skip malformed files */ }
    }

    if (identity?.reviewAttemptId) {
      // Identity is matched across EVERY artifact, not only across the ones
      // that already agree with `expectedHash`. Filtering by hash first made
      // the duplicate refusal below unreachable in the exact case it exists
      // for: two artifacts claiming one attempt id whose CONTENTS disagree
      // have different hashes, so at most one survived the filter and the
      // reader handed it back as though nothing were wrong.
      const owned = all.filter((a) => artifactBelongsToAttempt(a.artifact, identity));
      // Exactly one, or none. Two artifacts claiming one attempt id is a
      // corruption we refuse to arbitrate: returning "the first" would pick a
      // provenance at random, which is worse than admitting we cannot tell.
      if (owned.length !== 1) return null;
      const only = owned[0]!;
      // The attempt's own artifact still has to BE the one that was asked for,
      // and still has to match its own bytes.
      if (only.storedHash !== expectedHash) return null;
      if (computeContentHash(only.artifact) !== expectedHash) return null;
      return only.artifact;
    }

    // No identity to match on: legacy behavior, first hash match wins. Multiple
    // hits here are indistinguishable BY CONSTRUCTION -- the caller supplied
    // nothing that could tell them apart -- so this is the honest ceiling of
    // what a hash-only lookup can promise, not a shortcut past it.
    for (const candidate of all) {
      if (candidate.storedHash !== expectedHash) continue;
      if (computeContentHash(candidate.artifact) !== expectedHash) continue;
      return candidate.artifact;
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
