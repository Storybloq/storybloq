import type { z } from "zod";
import { TICKET_ID_REGEX, TICKET_CANONICAL_ID_REGEX, ISSUE_ID_REGEX, ISSUE_CANONICAL_ID_REGEX } from "../models/types.js";
import type { Arrangement, ArrangementGateSchema } from "../models/arrangement.js";
import type { ProjectState } from "./project-state.js";

/**
 * Zod-inferred directly from the model rather than re-imported from
 * `gate-enforcement.ts` (which already imports `arrangementCoversTicket`
 * from THIS file) -- avoids a circular module dependency.
 */
export type ArrangementGate = z.infer<typeof ArrangementGateSchema>;

/** Structural subset of ProjectState this module needs -- a real ProjectState satisfies it, and a test double doesn't need to construct a full one. */
export type TicketRefResolver = Pick<ProjectState, "resolveTicketRef">;

/**
 * Does `arrangement`'s `bounds` cover `canonicalTicketId`?
 *
 * NOT a reuse of `session-guard.ts`'s `matchArrangements` -- that function
 * matches PARTY IDENTITIES for the "am I a party to this arrangement" guard
 * announcement; it never inspects `bounds` or resolves a ticket ref at all.
 * This is new code for a different question.
 *
 * `ArrangementBoundsSchema.bounds` is `z.array(z.union([TicketRefSchema,
 * IssueRefSchema]))` (arrangement.ts) -- an arrangement can legitimately
 * bound an ISSUE, not only a ticket. Ticket and issue ref patterns are
 * syntactically disjoint (`T-`/`t-` vs `ISS-`/`i-`, mirroring
 * `cli/commands/arrangement.ts`'s own `resolveBoundRef`), so each bound ref
 * is classified by pattern BEFORE choosing a resolver:
 *
 * - An issue-pattern bound is "unmatched" for a TICKET freeze, never
 *   "unresolved" -- it was existence-validated at arrangement write time,
 *   and a dangling issue bound adds no safety concern to ticket gating
 *   specifically (issue-fix sessions are out of scope for enforcement
 *   entirely in v1 -- see T-474's issue-fix descope argument). There is
 *   nothing a ticket freeze needs to prove about an issue bound.
 * - A ticket-pattern bound that fails to resolve (e.g. a deleted ticket) IS
 *   a real ambiguity and returns "unresolved" -- a freeze cannot rule out
 *   that the dangling ref would otherwise have matched.
 */
export function arrangementCoversTicket(
  arrangement: Arrangement,
  canonicalTicketId: string,
  state: TicketRefResolver,
): "matched" | "unmatched" | "unresolved" {
  let sawUnresolvableTicketBound = false;
  for (const boundRef of arrangement.bounds) {
    const isTicketRef = TICKET_ID_REGEX.test(boundRef) || TICKET_CANONICAL_ID_REGEX.test(boundRef);
    const isIssueRef = ISSUE_ID_REGEX.test(boundRef) || ISSUE_CANONICAL_ID_REGEX.test(boundRef);
    if (isIssueRef && !isTicketRef) continue; // issue bound -- unmatched for a ticket freeze, never unresolved
    if (!isTicketRef) continue; // neither pattern -- schema should prevent this; ignored defensively, not fatal
    const resolved = state.resolveTicketRef(boundRef);
    if (resolved.kind === "found" && resolved.item.id === canonicalTicketId) return "matched";
    if (resolved.kind !== "found") sawUnresolvableTicketBound = true;
  }
  return sawUnresolvableTicketBound ? "unresolved" : "unmatched";
}

const PLAN_ACK_GATE_NAME = "plan-ack";
const PRECOMMIT_ACK_GATE_NAME = "pre-commit-ack";

/**
 * ISS-1050 interim (full fix is separate follow-up scope): a `plan-ack` gate
 * configured with no paired `pre-commit-ack` gate on the same arrangement has
 * no end gate at commit time. `plan-ack` only proves plan.md matched a given
 * hash at review time; without `pre-commit-ack` re-validating at commit time,
 * a plan.md edit landing in the window between PLAN_REVIEW's approval and
 * ImplementStage's later read of it can ship in a commit no one acked.
 *
 * Takes just the `gates` array (not a full `Arrangement`) so every call site
 * can call it with data it already holds: `validate`/`status` load full
 * arrangements via `loadArrangementsSafe` and pass `arrangement.gates`;
 * `finalize.ts`/`plan-review.ts` pass `gateStatus.gates` straight off the
 * cached `FrozenGate`, which never carries a full `Arrangement`.
 */
export function arrangementGateRiskWarnings(gates: readonly ArrangementGate[]): string[] {
  const names = new Set(gates.map((g) => g.name));
  if (!names.has(PLAN_ACK_GATE_NAME) || names.has(PRECOMMIT_ACK_GATE_NAME)) return [];
  return [
    "Risk: this arrangement declares a plan-ack gate with no paired pre-commit-ack gate " +
      "(ISS-1050 interim). plan-ack's guarantee does not survive to commit time without the end " +
      "gate -- a plan.md edit made after PLAN_REVIEW approval and before implementation reads it " +
      "can ship in a commit nobody acked.",
  ];
}
