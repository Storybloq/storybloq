import type { FullSessionState, PressureLevel } from "./session-types.js";

// ---------------------------------------------------------------------------
// Pressure thresholds -- tier-based using config.compactThreshold (ISS-034)
// ---------------------------------------------------------------------------

interface Limits { calls: number; tickets: number; bytes: number; }

/**
 * Threshold presets keyed by compactThreshold config value. The setting has
 * two coordinated effects: it selects the signal limits below and the minimum
 * pressure rank accepted by pressureMeetsThreshold().
 * "high" = default (moderate); rotate when pressure reaches "high".
 * "critical" = conservative; use higher limits and rotate only at critical.
 * "medium" = aggressive; use lower limits and rotate at medium.
 *
 * Default tier ("high") thresholds:
 * | Level    | Condition                              | Action                    |
 * |----------|----------------------------------------|---------------------------|
 * | low      | <30 calls, <3 tickets, <150KB events   | Continue                  |
 * | medium   | 30+ calls OR 3+ tickets OR >150KB      | Continue                  |
 * | high     | 60+ calls OR 5+ tickets OR >800KB      | Rotate at next COMPLETE   |
 * | critical | >90 calls OR 8+ tickets OR >1.5MB      | Rotate at next COMPLETE   |
 */
const THRESHOLDS: Record<string, { critical: Limits; high: Limits; medium: Limits }> = {
  critical: {
    critical: { calls: 120, tickets: 10, bytes: 2_000_000 },
    high:     { calls: 80,  tickets: 7,  bytes: 1_000_000 },
    medium:   { calls: 40,  tickets: 4,  bytes: 200_000 },
  },
  high: {
    critical: { calls: 90,  tickets: 8,  bytes: 1_500_000 },
    high:     { calls: 60,  tickets: 5,  bytes: 800_000 },
    medium:   { calls: 30,  tickets: 3,  bytes: 150_000 },
  },
  medium: {
    critical: { calls: 60, tickets: 5, bytes: 1_000_000 },
    high:     { calls: 40, tickets: 3, bytes: 500_000 },
    medium:   { calls: 20, tickets: 2, bytes: 100_000 },
  },
};

/**
 * Evaluate context pressure from session signals.
 * Uses config.compactThreshold to select threshold tier.
 * Pure function, no I/O.
 */
export function evaluatePressure(state: FullSessionState): PressureLevel {
  const calls = state.contextPressure?.guideCallCount ?? state.guideCallCount ?? 0;
  // ISS-084: Compute work from source arrays, then subtract the last successful
  // compaction baseline. Session completion history remains cumulative while
  // pressure measures only work performed in the current context window.
  const totalWork = (state.completedTickets?.length ?? 0) + (state.resolvedIssues?.length ?? 0);
  const workBaseline = state.contextPressure?.workItemsAtLastCompaction ?? 0;
  const tickets = Math.max(0, totalWork - workBaseline);
  const totalEventsBytes = state.contextPressure?.eventsLogBytes ?? 0;
  const eventsBaseline = state.contextPressure?.eventsLogBytesAtLastCompaction ?? 0;
  const eventsBytes = Math.max(0, totalEventsBytes - eventsBaseline);

  const tier = state.config?.compactThreshold ?? "high";
  const t = THRESHOLDS[tier] ?? THRESHOLDS["high"]!;

  if (calls > t.critical.calls || tickets >= t.critical.tickets || eventsBytes > t.critical.bytes) return "critical";
  if (calls >= t.high.calls || tickets >= t.high.tickets || eventsBytes > t.high.bytes) return "high";
  if (calls >= t.medium.calls || tickets >= t.medium.tickets || eventsBytes > t.medium.bytes) return "medium";
  return "low";
}

const PRESSURE_ORDER: Readonly<Record<PressureLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const COMPACT_THRESHOLD_RANK: Readonly<Record<string, number>> = {
  medium: PRESSURE_ORDER.medium,
  high: PRESSURE_ORDER.high,
  critical: PRESSURE_ORDER.critical,
};

/** Unknown and legacy threshold values preserve the existing high fallback. */
export function pressureMeetsThreshold(
  level: PressureLevel,
  compactThreshold: string | null | undefined,
): boolean {
  const threshold = COMPACT_THRESHOLD_RANK[compactThreshold ?? ""] ?? PRESSURE_ORDER.high;
  return PRESSURE_ORDER[level] >= threshold;
}

/** Reset pressure only after COMPACT recovery has successfully resumed. */
export function pressureAfterCompaction(
  state: FullSessionState,
): FullSessionState["contextPressure"] {
  const totalWork = (state.completedTickets?.length ?? 0) + (state.resolvedIssues?.length ?? 0);
  return {
    ...state.contextPressure,
    level: "low",
    guideCallCount: 0,
    compactionCount: (state.contextPressure?.compactionCount ?? 0) + 1,
    workItemsAtLastCompaction: totalWork,
    eventsLogBytesAtLastCompaction: state.contextPressure?.eventsLogBytes ?? 0,
  };
}
