import type { DiffStats, ReviewRecord } from "./session-types.js";

// ---------------------------------------------------------------------------
// Sensitive paths — files that escalate risk by one level
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  /\bauth\b/i,
  /\bsecurity\b/i,
  /\bmigration/i,
  /\bconfig\b/i,
  /\bmiddleware\b/i,
  /\.env/i,
];

// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "medium" | "high";

/**
 * Assess risk from diff stats and optionally file paths.
 * <50 lines = low, 50-200 = medium, >200 = high.
 * Sensitive paths escalate one level.
 */
export function assessRisk(
  diffStats?: DiffStats,
  changedFiles?: readonly string[],
): RiskLevel {
  let level: RiskLevel = "low";

  if (diffStats) {
    const total = diffStats.totalLines;
    if (total > 200) level = "high";
    else if (total >= 50) level = "medium";
  }

  // Sensitive path escalation
  if (changedFiles && level !== "high") {
    const hasSensitive = changedFiles.some((f) =>
      SENSITIVE_PATTERNS.some((p) => p.test(f)),
    );
    if (hasSensitive) {
      level = level === "low" ? "medium" : "high";
    }
  }

  return level;
}

/**
 * Minimum review rounds required for a risk level.
 */
export function requiredRounds(risk: RiskLevel): number {
  switch (risk) {
    case "low": return 1;
    case "medium": return 2;
    case "high": return 3;
  }
}

/**
 * ISS-110: Check codex unavailability with a 10-minute TTL.
 * Returns true if codex was marked unavailable within the last 10 minutes.
 */
const CODEX_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isCodexUnavailable(
  codexUnavailableSince?: string,
): boolean {
  if (!codexUnavailableSince) return false;
  const since = new Date(codexUnavailableSince).getTime();
  if (Number.isNaN(since)) return false;
  return Date.now() - since < CODEX_CACHE_TTL_MS;
}

/**
 * Select the next reviewer backend, alternating for mixed-reviewer requirement.
 * ISS-098: When codexUnavailable is true, filter "codex" from backends to avoid
 * wasting ~30s per round discovering it's down.
 * ISS-110: Uses timestamp-based TTL instead of session-scoped boolean.
 */
export function nextReviewer(
  previousRounds: readonly ReviewRecord[],
  backends: readonly string[],
  codexUnavailable?: boolean,
  codexUnavailableSince?: string,
): string {
  const unavailable = codexUnavailableSince
    ? isCodexUnavailable(codexUnavailableSince)
    : !!codexUnavailable;
  const effective = unavailable
    ? backends.filter((b) => b !== "codex")
    : backends;
  if (effective.length === 0) return "agent";
  if (effective.length === 1) return effective[0]!;

  // Alternate: if last round used effective[0], use effective[1], and vice versa
  if (previousRounds.length === 0) return effective[0]!;
  const lastReviewer = previousRounds[previousRounds.length - 1]!.reviewer;
  const lastIndex = effective.indexOf(lastReviewer);
  if (lastIndex === -1) return effective[0]!;
  return effective[(lastIndex + 1) % effective.length]!;
}
