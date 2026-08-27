/**
 * THE HARD CEILING for PLAN_REVIEW (ISS-598/ISS-1031).
 *
 * Fixed, not effort/dial-derived, and not exposed via recipeOverrides:
 * ISS-598's own evidence is that round count alone does not prevent the
 * harm a non-converging plan review can do (a real incident manufactured a
 * plaintext-secret-retaining subsystem by round 4, several rounds before any
 * round cap in the 8-12 range would have fired), so a tunable cap would
 * invite tuning the wrong axis. This ceiling is only the backstop; the
 * scope-drift signal (plan-review-drift.ts) is the earlier warning, shipped
 * as advisory telemetry rather than an automatic trigger for now.
 */
export const PLAN_REVIEW_HARD_CEILING_GRACE = 3;
export const DEFAULT_PLAN_REVIEW_MAX_ROUNDS = 5;

export function planReviewHardCeiling(): number {
  return DEFAULT_PLAN_REVIEW_MAX_ROUNDS + PLAN_REVIEW_HARD_CEILING_GRACE;
}

export interface PlanRoundCounter {
  readonly ticketId: string;
  readonly completedRounds: number;
}

/**
 * The counter AFTER recording the round currently being reported.
 *
 * Resets to 1 when the ticket differs, so a newly selected item can never
 * inherit a poisoned count from the one before it. Identical semantics to
 * `code-review-ceiling.ts`'s `nextRoundCounter`.
 */
export function nextPlanRoundCounter(
  previous: PlanRoundCounter | null | undefined,
  ticketId: string,
): PlanRoundCounter {
  if (!previous || previous.ticketId !== ticketId) return { ticketId, completedRounds: 1 };
  return { ticketId, completedRounds: previous.completedRounds + 1 };
}

export interface PlanCeilingDecision {
  readonly shouldPark: boolean;
  readonly ceiling: number;
  readonly counter: PlanRoundCounter | null;
}

/**
 * Whether this round trips the ceiling.
 *
 * `nextAction !== "IMPLEMENT"` means the ceiling can only ever convert a
 * would-be CONTINUATION -- an ordinary PLAN_REVIEW retry, OR a reject-routed
 * replan -- into a park. It cannot alter a genuine IMPLEMENT landing, which
 * (Gate-1 ratified ordering, plan-review.ts's routing) happens for an
 * `approve` verdict OR a revise verdict whose findings are clean of
 * unresolved critical/major once `roundNum >= minRounds`; unresolved
 * critical/major still never lands, at any round count, so this ceiling
 * never has to choose between parking and overriding a landing that a real
 * blocking finding should have prevented. Firing on the reject-routed PLAN
 * case too is deliberate: a reject/replan loop is otherwise invisible to any
 * counter derived from `reviews.plan.length` (that array is cleared on every
 * reject), which is exactly the ISS-904 blind spot this closes.
 *
 * No ISSUE_FIX exemption is needed, unlike `code-review-ceiling.ts`'s
 * `isIssueFix` guard: PLAN_REVIEW's row in the state machine's TRANSITIONS
 * table is never entered for issue fixes (ISSUE_FIX is reached directly from
 * PICK_TICKET). `!ticketId` below is the only guard required, and it is what
 * protects a no-ticket session from ever reaching `shouldPark: true`.
 */
export function decidePlanCeiling(args: {
  readonly ticketId: string | undefined;
  readonly priorCounter: PlanRoundCounter | null | undefined;
  readonly nextAction: "PLAN" | "IMPLEMENT" | "PLAN_REVIEW";
}): PlanCeilingDecision {
  const ceiling = planReviewHardCeiling();
  if (!args.ticketId) return { shouldPark: false, ceiling, counter: null };
  const counter = nextPlanRoundCounter(args.priorCounter, args.ticketId);
  const shouldPark = ceiling > 0 && args.nextAction !== "IMPLEMENT" && counter.completedRounds >= ceiling;
  return { shouldPark, ceiling, counter };
}
