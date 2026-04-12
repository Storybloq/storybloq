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
  readonly startedAt: string;
  readonly durationMs: number;
  readonly summary: string;
  readonly findings: readonly unknown[];
  readonly timestamp: string;
}

export interface Tier1ReviewVerdict {
  readonly stage: string;
  readonly round: number;
  readonly verdict: string;
  readonly findingCount: number;
  readonly criticalCount: number;
  readonly majorCount: number;
  readonly suggestionCount: number;
  readonly durationMs: number;
  readonly summary: string;
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
  const { timestamp: _ts, _contentHash: _ch, durationMs: _dur, ...rest } = artifact as Record<string, unknown>;
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
  return {
    stage: artifact.stage,
    round: artifact.round,
    verdict: artifact.verdict,
    findingCount: artifact.findingsCount,
    criticalCount: artifact.severityCounts.critical,
    majorCount: artifact.severityCounts.major,
    suggestionCount: artifact.severityCounts.suggestion,
    durationMs: artifact.durationMs,
    summary: artifact.summary,
  };
}
