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
 * | Level    | Condition                              | Action           |
 * |----------|----------------------------------------|------------------|
 * | low      | <30 calls, <3 tickets, <150KB events   | Continue         |
 * | medium   | 30+ calls OR 3+ tickets OR >150KB      | Evaluate         |
 * | high     | 60+ calls OR 5+ tickets OR >800KB      | (logged only)    |
 * | critical | >90 calls OR 8+ tickets OR >1.5MB      | (logged only)    |
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
  const tickets = state.contextPressure?.ticketsCompleted ?? state.completedTickets?.length ?? 0;
  const eventsBytes = state.contextPressure?.eventsLogBytes ?? 0;

  const tier = state.config?.compactThreshold ?? "high";
  const t = THRESHOLDS[tier] ?? THRESHOLDS["high"]!;

  if (calls > t.critical.calls || tickets >= t.critical.tickets || eventsBytes > t.critical.bytes) return "critical";
  if (calls >= t.high.calls || tickets >= t.high.tickets || eventsBytes > t.high.bytes) return "high";
  if (calls >= t.medium.calls || tickets >= t.medium.tickets || eventsBytes > t.medium.bytes) return "medium";
  return "low";
}
