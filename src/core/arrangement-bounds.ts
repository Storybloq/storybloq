import { TICKET_ID_REGEX, TICKET_CANONICAL_ID_REGEX, ISSUE_ID_REGEX, ISSUE_CANONICAL_ID_REGEX } from "../models/types.js";
import type { Arrangement } from "../models/arrangement.js";
import type { ProjectState } from "./project-state.js";

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
