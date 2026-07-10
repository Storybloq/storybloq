import type { FullSessionState, PressureLevel } from "./session-types.js";

// ---------------------------------------------------------------------------
// Pressure thresholds — tier-based using config.compactThreshold (ISS-034)
// ---------------------------------------------------------------------------

interface Limits { calls: number; tickets: number; bytes: number; }

/**
 * Threshold presets keyed by compactThreshold config value.
 * "high" = default (moderate) — compact when pressure reaches "high".
 * "critical" = conservative — only compact at critical pressure.
 * "medium" = aggressive — compact earlier.
 *
 * Default tier ("high") thresholds:
 * | Level    | Condition                              | Action                    |
 * |----------|----------------------------------------|---------------------------|
 * | low      | <30 calls, <3 tickets, <150KB events   | Continue                  |
 * | medium   | 30+ calls OR 3+ tickets OR >150KB      | Continue                  |
 * | high     | 60+ calls OR 5+ tickets OR >800KB      | Rotate at next COMPLETE   |
 * | critical | >90 calls OR 8+ tickets OR >1.5MB      | Rotate at next COMPLETE   |
 *
 * The Action column is enforced by pressureMeetsThreshold() below: the COMPLETE
 * stage rotates the session (routes to HANDOVER instead of PICK_TICKET) once the
 * evaluated level reaches the configured compactThreshold. Before ISS-034
 * enforcement the level was computed and displayed but never acted upon.
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
  // ISS-084: Always compute from source arrays (not cached counter) to avoid
  // stale values during chained goto transitions (e.g., FINALIZE -> COMPLETE)
  const tickets = (state.completedTickets?.length ?? 0) + (state.resolvedIssues?.length ?? 0);
  const eventsBytes = state.contextPressure?.eventsLogBytes ?? 0;

  const tier = state.config?.compactThreshold ?? "high";
  const t = THRESHOLDS[tier] ?? THRESHOLDS["high"]!;

  if (calls > t.critical.calls || tickets >= t.critical.tickets || eventsBytes > t.critical.bytes) return "critical";
  if (calls >= t.high.calls || tickets >= t.high.tickets || eventsBytes > t.high.bytes) return "high";
  if (calls >= t.medium.calls || tickets >= t.medium.tickets || eventsBytes > t.medium.bytes) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Pressure enforcement (ISS-034)
// ---------------------------------------------------------------------------

/** Ordinal ranking of pressure levels: low (0) -> critical (3). */
export const PRESSURE_ORDER: Record<PressureLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Rank of a configured compactThreshold. The valid tier values are the
 * THRESHOLDS keys ("medium" | "high" | "critical"); anything else -- including
 * an unset value or the legacy/undocumented "low" -- falls back to "high", so
 * the comparison stays consistent with evaluatePressure()'s own
 * `THRESHOLDS[tier] ?? THRESHOLDS["high"]` fallback.
 */
const COMPACT_THRESHOLD_RANK: Record<string, number> = {
  medium: PRESSURE_ORDER.medium,
  high: PRESSURE_ORDER.high,
  critical: PRESSURE_ORDER.critical,
};

/**
 * Whether the evaluated pressure level has reached (>=) the configured
 * compactThreshold, i.e. the session should rotate at the next clean boundary.
 * Pure comparison -- the caller decides what to do when it returns true.
 */
export function pressureMeetsThreshold(level: PressureLevel, compactThreshold: string | undefined): boolean {
  const thresholdRank = COMPACT_THRESHOLD_RANK[compactThreshold ?? ""] ?? PRESSURE_ORDER.high;
  return PRESSURE_ORDER[level] >= thresholdRank;
}
