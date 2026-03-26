import type { FullSessionState, PressureLevel } from "./session-types.js";

// ---------------------------------------------------------------------------
// Pressure thresholds
// ---------------------------------------------------------------------------

/**
 * Evaluate context pressure from session signals.
 * Pure function, no I/O.
 *
 * | Level    | Condition                              | Action           |
 * |----------|----------------------------------------|------------------|
 * | low      | <15 calls, 0 tickets, <50KB events     | Continue         |
 * | medium   | 15-30 OR 1 ticket OR >50KB             | Evaluate         |
 * | high     | 30-45 OR 2 tickets OR >200KB           | consider-compact |
 * | critical | >45 OR >=3 tickets OR >500KB           | compact-now      |
 */
export function evaluatePressure(state: FullSessionState): PressureLevel {
  const calls = state.contextPressure?.guideCallCount ?? state.guideCallCount ?? 0;
  const tickets = state.contextPressure?.ticketsCompleted ?? state.completedTickets?.length ?? 0;
  const eventsBytes = state.contextPressure?.eventsLogBytes ?? 0;

  if (calls > 45 || tickets >= 3 || eventsBytes > 500_000) return "critical";
  if (calls >= 30 || tickets >= 2 || eventsBytes > 200_000) return "high";
  if (calls >= 15 || tickets >= 1 || eventsBytes > 50_000) return "medium";
  return "low";
}
