/**
 * T-257 Verification log -- rejection logging and telemetry accumulation.
 *
 * `appendRejection` writes a single JSONL line to `verification.log`.
 * `buildRejectionEntry` constructs the entry from a finding + VerifyFail.
 * `accumulateVerificationCounters` reads `verification-telemetry.jsonl`
 * and merges new entries into session state using a line-count checkpoint.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { LensFinding } from "./types.js";
import type { VerifyFail } from "./verification.js";
import { normalizeForVerification } from "./verification.js";

// ── Types ────────────────────────────────────────────────────────

export interface RejectionEntry {
  findingId: string;
  lens: string;
  stage: string;
  reasonCode: string;
  failedEvidenceIndex: number;
  claimed: {
    file: string;
    startLine: number;
    endLine: number;
    codeHash: string;
  } | null;
  actualExcerpt: string;
  actualHash: string;
}

// ── Rejection logging ────────────────────────────────────────────

export function appendRejection(
  sessionDir: string,
  entry: RejectionEntry,
): { ok: boolean } {
  try {
    appendFileSync(
      join(sessionDir, "verification.log"),
      JSON.stringify(entry) + "\n",
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function buildRejectionEntry(
  finding: LensFinding,
  result: VerifyFail,
  stage: string,
): RejectionEntry {
  const idx = result.failedEvidenceIndex;
  const evidenceItem =
    idx >= 0 && idx < finding.evidence.length
      ? finding.evidence[idx]
      : null;

  return {
    findingId: finding.issueKey ?? `${finding.lens}-f-unknown`,
    lens: finding.lens,
    stage,
    reasonCode: result.reasonCode,
    failedEvidenceIndex: idx,
    claimed: evidenceItem
      ? {
          file: evidenceItem.file,
          startLine: evidenceItem.startLine,
          endLine: evidenceItem.endLine,
          codeHash: createHash("sha256")
            .update(normalizeForVerification(evidenceItem.code))
            .digest("hex"),
        }
      : null,
    actualExcerpt: (result.actualExcerpt ?? "").slice(0, 500),
    actualHash: result.actualHash ?? "",
  };
}

// ── Telemetry accumulation ───────────────────────────────────────

export function accumulateVerificationCounters(ctx: {
  sessionDir: string;
  state: { verificationCounters?: {
    proposed: number;
    verified: number;
    rejected: number;
    filed: number;
    lastTelemetryLine: number;
  } };
  writeState: (updates: Record<string, unknown>) => unknown;
}): void {
  const telemetryPath = join(ctx.sessionDir, "verification-telemetry.jsonl");
  let raw: string;
  try {
    raw = readFileSync(telemetryPath, "utf-8");
  } catch {
    return;
  }

  // Split and drop the last segment: it's either "" (from trailing \n)
  // or a partial line from a concurrent append. Either way, exclude it.
  const lines = raw === "" ? [] : raw.split("\n").slice(0, -1);
  const prev = ctx.state.verificationCounters ?? {
    proposed: 0,
    verified: 0,
    rejected: 0,
    filed: 0,
    lastTelemetryLine: 0,
  };

  if (prev.lastTelemetryLine >= lines.length) return;

  let newProposed = 0;
  let newVerified = 0;
  let newRejected = 0;
  for (let i = prev.lastTelemetryLine; i < lines.length; i++) {
    try {
      const e = JSON.parse(lines[i]!);
      if (
        typeof e.proposed !== "number" ||
        typeof e.verified !== "number" ||
        typeof e.rejected !== "number"
      ) continue;
      newProposed += e.proposed;
      newVerified += e.verified;
      newRejected += e.rejected;
    } catch {
      // malformed line: skip, still advance checkpoint
    }
  }

  ctx.writeState({
    verificationCounters: {
      proposed: prev.proposed + newProposed,
      verified: prev.verified + newVerified,
      rejected: prev.rejected + newRejected,
      filed: prev.filed,
      lastTelemetryLine: lines.length,
    },
  });
}
