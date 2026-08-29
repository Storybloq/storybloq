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

/** Structural subset of ProjectState `arrangementCoversIssue` needs, symmetric to `TicketRefResolver`. */
export type IssueRefResolver = Pick<ProjectState, "resolveIssueRef">;

/**
 * ISS-1049: a work item is either a ticket or an issue. Every gate-enforcement
 * mechanism this plan generalizes (frozenGate resolution, the CODE_REVIEW
 * ceiling, the pre-commit-ack check) is keyed on one of these rather than on
 * a bare ticket id -- see gate-enforcement.ts's `resolveOrReadFrozenGateStatus`
 * and code-review-ceiling.ts's `decideCeiling` for the two production
 * derivations of this type from session state.
 */
export type WorkItemRef =
  | { readonly kind: "ticket"; readonly id: string }
  | { readonly kind: "issue"; readonly id: string };

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
 *   specifically. There is nothing a ticket freeze needs to prove about an
 *   issue bound. (ISS-1049: issue-fix enforcement is no longer out of scope
 *   project-wide -- see `arrangementCoversIssue`'s symmetric case and
 *   `arrangementCoversWorkItem`, the dispatching entry point for a caller
 *   that doesn't already know which kind of work item it holds.)
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

/**
 * ISS-1049: the issue-freeze twin of `arrangementCoversTicket`, structurally
 * mirrored (a ticket-pattern bound is "unmatched" here, never "unresolved" --
 * symmetric to that function's issue-bound case).
 */
export function arrangementCoversIssue(
  arrangement: Arrangement,
  canonicalIssueId: string,
  state: IssueRefResolver,
): "matched" | "unmatched" | "unresolved" {
  let sawUnresolvableIssueBound = false;
  for (const boundRef of arrangement.bounds) {
    const isIssueRef = ISSUE_ID_REGEX.test(boundRef) || ISSUE_CANONICAL_ID_REGEX.test(boundRef);
    const isTicketRef = TICKET_ID_REGEX.test(boundRef) || TICKET_CANONICAL_ID_REGEX.test(boundRef);
    if (isTicketRef && !isIssueRef) continue; // ticket bound -- unmatched for an issue freeze, never unresolved
    if (!isIssueRef) continue; // neither pattern -- schema should prevent this; ignored defensively, not fatal
    const resolved = state.resolveIssueRef(boundRef);
    if (resolved.kind === "found" && resolved.item.id === canonicalIssueId) return "matched";
    if (resolved.kind !== "found") sawUnresolvableIssueBound = true;
  }
  return sawUnresolvableIssueBound ? "unresolved" : "unmatched";
}

/**
 * ISS-1049: dispatches to the kind-specific coverage function by `item.kind`.
 * The one seam kept as a twin rather than unified -- ref-pattern coverage
 * matching is inherently kind-specific (a different resolver per kind), so a
 * single merged implementation would need the same kind-branch internally
 * anyway. This is the entry point for a caller that holds a `WorkItemRef`
 * without already knowing which kind it is.
 */
export function arrangementCoversWorkItem(
  arrangement: Arrangement,
  item: WorkItemRef,
  state: TicketRefResolver & IssueRefResolver,
): "matched" | "unmatched" | "unresolved" {
  return item.kind === "ticket"
    ? arrangementCoversTicket(arrangement, item.id, state)
    : arrangementCoversIssue(arrangement, item.id, state);
}

/**
 * ISS-1077: does `arrangement`'s `bounds` cover a NODE-QUALIFIED item?
 * `itemId` must already be the node item's own resolved `.id` (resolved by
 * the caller, e.g. C4's earmark handler after its own node resolution) --
 * canonical form on a team-mode node, display form otherwise (Amendment A4:
 * a non-team-mode node's ticket has no canonical form to normalize to at
 * all, so "canonical" was never an accurate name for this parameter; codex
 * round-2 finding, the comparison itself was always correct for either form,
 * only the naming/doc was stale). This function's job is deliberately
 * narrow: does the bounds list contain the exact qualified string
 * `node:itemId`, nothing more. It does
 * NOT re-verify that `nodeName` still resolves or that the item still
 * exists -- those are each an EARLIER (C1, arrangement-create time) or LATER
 * (C3's status read, or the caller's own node resolution before ever calling
 * this) step's job. A node that later disappears from config, or a node-side
 * item later deleted, does not make THIS function's answer ambiguous; it
 * makes one of those other steps' own resolution fail, which they already
 * handle with their own fail-closed logic.
 *
 * Deliberately NOT folded into `WorkItemRef`/`arrangementCoversWorkItem`:
 * every real production consumer of `WorkItemRef` (`gate-enforcement.ts`,
 * `code-review-ceiling.ts`) derives it from a session's OWN local ticket/issue
 * -- never a node-qualified one, per the Q3 ruling that a session never
 * enforces gates on another node's item. Widening `WorkItemRef` with an
 * optional `node` field would add a member no production path would ever
 * set, repeating the exact "unification the code doesn't support" mistake
 * run 6's own process already caught and reversed once on this same type
 * family. This is a deliberate parallel entry point for the one caller (the
 * earmark coverage seam) that actually has a node-qualified target to check.
 */
export function arrangementCoversNodeItem(
  arrangement: Arrangement,
  nodeName: string,
  itemId: string,
): boolean {
  return arrangement.bounds.includes(`${nodeName}:${itemId}`);
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
