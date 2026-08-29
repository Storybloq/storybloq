import type { Arrangement } from "../models/arrangement.js";

/**
 * T-478: one predicate shared by every authority-bearing consumer of an
 * arrangement's fields (gate enforcement, earmark coverage, gate-ack
 * creation) -- not a throwing assert, since each call site wants a different
 * control-flow shape (mark-and-continue-scanning vs. refuse-outright), and a
 * plain predicate lets each keep its own idiomatic shape while sharing the
 * one-line definition of what "conflicted" means.
 */
export function isArrangementConflicted(arrangement: Pick<Arrangement, "_conflicts">): boolean {
  return Array.isArray(arrangement._conflicts) && arrangement._conflicts.length > 0;
}
