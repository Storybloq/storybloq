/**
 * ISS-1114: the contradictory change-request guard, shared by both review
 * stages.
 *
 * A verdict of `revise` or `request_changes` carrying zero findings is a
 * contradictory payload: it states that changes are required and supplies
 * nothing to act on. Before this guard both stages honored it, and the failure
 * was worse than a wasted round.
 *
 * On the PLAN side it is a FALSE LANDING. `plan-review.ts` runs the
 * findings-clean landing check BEFORE the revise branch, and with zero findings
 * `hasCriticalOrMajor` is false, so from `minRounds` onward an empty revise
 * routes the item to IMPLEMENT: implementation begins on the strength of a
 * review that asked for changes and named none. `minRounds` never exceeds 3
 * (`effortMinRounds` over `requiredRounds`), so this is reachable on round 2 or
 * 3 of an ordinary item.
 *
 * On the CODE side both failure modes exist: below the T-461 landing floor the
 * item routes to IMPLEMENT with nothing to implement, and at or above it the
 * forced-landing branch sends it to FINALIZE.
 *
 * Measured, not theorized: 36 empty change-requesting code rounds of 3,091 and
 * 48 of 3,317 on the plan side, across seven projects.
 *
 * SCOPE. The predicate is `findings.length === 0` and nothing else. A round with
 * zero criticals and zero majors but some minor or non-enum-severity finding is
 * a POLICY question (does a suggestion block?), not a payload defect, and it
 * belongs to T-487 after severity normalization. A length test cannot see that
 * population, which is how the boundary is kept mechanically rather than by
 * convention.
 */

/**
 * The repair instruction, adopted verbatim from the ISS-1114 correction round.
 *
 * It names all three legitimate exits, and the last sentence is load-bearing: a
 * guard that only demanded findings would teach reviewers to manufacture them,
 * converting a visible contradiction into an invisible one.
 */
export const EMPTY_CHANGE_REQUEST_INSTRUCTION =
  "Your verdict requests changes but supplies no actionable changes. " +
  "Return concrete findings, each with location, failing scenario, impact and requested correction; " +
  "if review completed and there are none, return approve. " +
  "If you could not complete the review, report the missing coverage, tool or schema error explicitly. " +
  "Do not invent findings to satisfy this check.";

/**
 * Repair attempts allowed per round before the item is parked.
 *
 * Two, not one: a single transient empty payload is common and self-corrects on
 * the retry. Reaching the cap means a reviewer returned an empty
 * change-request three times for ONE round with the instruction in hand, which
 * is a stuck reviewer rather than a flake.
 */
export const REPAIR_ATTEMPT_CAP = 2;

/** One recorded repair attempt. Mirrors the `reviewRepairAttempts` schema. */
export interface ReviewRepairAttempt {
  readonly workItemId: string;
  readonly kind: "ticket" | "issue";
  readonly stage: "code" | "plan";
  readonly round: number;
  readonly attempt: number;
  readonly verdict: string;
  readonly reviewer: string;
  readonly at: string;
  readonly attemptDurationMs: number;
  /** Absent means the empty-verdict repair. See the schema note. */
  readonly trigger?: string;
}

/** The identity a repair attempt is scoped to. */
export interface RepairAttemptKey {
  readonly workItemId: string;
  readonly kind: "ticket" | "issue";
  readonly stage: "code" | "plan";
  readonly round: number;
  /**
   * Absent matches the empty-verdict repair, INCLUDING every record written
   * before this field existed. Two repairs with different bounds must not spend
   * each other's budget.
   */
  readonly trigger?: string;
}

/**
 * Whether this payload is a change-request with nothing in it.
 *
 * `findings` is already severity-normalized by both callers, which does not
 * affect length, so the predicate is stable no matter which severity vocabulary
 * a reviewer used.
 */
export function isEmptyChangeRequest(
  verdict: string,
  findings: readonly unknown[],
): boolean {
  return (verdict === "revise" || verdict === "request_changes") && findings.length === 0;
}

/**
 * The round this attempt belongs to.
 *
 * NOT `reviews.<stage>.length + 1`. That number is derived from an array both
 * stages clear mid-run -- `reviews.plan` on every reject, `reviews.code` on a
 * plan redirect -- so it restarts at 1 in a new generation. Two attempts banked
 * before a reset would then be found by the first empty payload after it, and
 * that payload would park immediately instead of being repaired.
 *
 * The durable counters do not restart (the plan-side one counts across rejects
 * by design, ISS-904), so they are the correct identity. `+ 1` because this
 * guard runs BEFORE the round is counted: `completedRounds` alone names the
 * PREVIOUS round, and an escalation reported from it would name the wrong one.
 *
 * The no-counter fallback is 1, NOT the array length. `nextRoundCounter` and
 * `nextPlanRoundCounter` both initialize a missing or mismatched counter to
 * `completedRounds: 1`, so a session without a counter is about to be numbered
 * from 1 too. Falling back to the array length instead would collide with that:
 * a legacy session holding one historical review would bank attempts under
 * round 2, then a reject would set the counter to 1, making the next pending
 * round 2 as well -- and its first empty payload would park on the spot.
 */
export function pendingRoundOrdinal(matchingCompletedRounds: number | null): number {
  return matchingCompletedRounds == null ? 1 : matchingCompletedRounds + 1;
}

/** Attempts already recorded for exactly this item, stage and round. */
export function countRepairAttempts(
  attempts: readonly ReviewRepairAttempt[] | undefined,
  key: RepairAttemptKey,
): number {
  if (!attempts) return 0;
  return attempts.filter((a) =>
    a.workItemId === key.workItemId &&
    a.kind === key.kind &&
    a.stage === key.stage &&
    a.round === key.round &&
    (a.trigger ?? undefined) === (key.trigger ?? undefined),
  ).length;
}

/**
 * Elapsed milliseconds for this attempt, clamped and finite.
 *
 * Mirrors the verdict artifact's own calculation rather than inventing a second
 * convention. The defensiveness is not decorative: an absent
 * `currentReviewStartedAt`, a corrupted stored timestamp or a backward wall
 * clock would otherwise produce NaN or a negative number, both of which the
 * `nonnegative int` schema rejects -- so the guard would fail to persist the
 * very record it exists to write, and the attempt would vanish instead of
 * counting toward the cap.
 */
export function attemptDurationMs(baseIso: string | null | undefined, nowMs: number): number {
  const baseMs = baseIso ? new Date(baseIso).getTime() : NaN;
  if (!Number.isFinite(baseMs)) return 0;
  return Math.max(0, Math.round(nowMs - baseMs));
}

/**
 * Build the attempt record, chaining from the previous attempt for this round.
 *
 * The chain is what makes `attemptDurationMs` a per-attempt interval instead of
 * a cumulative one: attempt 1 measures from the round's start, attempt 2 from
 * attempt 1, and so on.
 */
export function buildRepairAttempt(args: {
  readonly key: RepairAttemptKey;
  readonly existing: readonly ReviewRepairAttempt[] | undefined;
  readonly verdict: string;
  readonly reviewer: string;
  readonly reviewStartedAt: string | null | undefined;
  readonly nowMs: number;
}): ReviewRepairAttempt {
  // Scoped by trigger for the same reason `countRepairAttempts` is: two repairs
  // with different bounds share this array, and unscoped numbering would make
  // an empty-verdict attempt 1 read as a provenance attempt 2, chaining the
  // duration from the wrong predecessor and mis-numbering both.
  const priorForRound = (args.existing ?? []).filter((a) =>
    a.workItemId === args.key.workItemId &&
    a.kind === args.key.kind &&
    a.stage === args.key.stage &&
    a.round === args.key.round &&
    (a.trigger ?? undefined) === (args.key.trigger ?? undefined),
  );
  const previous = priorForRound.length > 0 ? priorForRound[priorForRound.length - 1] : null;
  const base = previous ? previous.at : args.reviewStartedAt;
  return {
    workItemId: args.key.workItemId,
    kind: args.key.kind,
    stage: args.key.stage,
    round: args.key.round,
    attempt: priorForRound.length + 1,
    verdict: args.verdict,
    reviewer: args.reviewer,
    at: new Date(args.nowMs).toISOString(),
    attemptDurationMs: attemptDurationMs(base, args.nowMs),
    ...(args.key.trigger === undefined ? {} : { trigger: args.key.trigger }),
  };
}

/**
 * The park reason.
 *
 * It has to carry the distinction the record itself cannot make. A payload with
 * no findings is consistent with two different situations -- a reviewer that had
 * nothing to say and should have returned approve, and a review that never
 * completed -- and nothing in the verdict separates them. Asserting either one
 * would be a guess written into the ledger, so the reason states the ambiguity
 * and names what was actually observed: the backend, the attempt count, and the
 * fact that nothing was implemented on the strength of it.
 */
export function emptyVerdictParkReason(args: {
  readonly stageLabel: "Code" | "Plan";
  readonly round: number;
  readonly label: string;
  readonly reviewer: string;
  readonly attempts: number;
}): string {
  return `${args.stageLabel} review round ${args.round} for ${args.label} ended with an incomplete verdict ` +
    `from ${args.reviewer}: it requested changes and supplied no findings, and the repair instruction was ` +
    `sent ${args.attempts} time(s) without producing any. A payload with no findings cannot distinguish a ` +
    `reviewer that had nothing to say and should have returned approve from a review that did not complete, ` +
    `so neither can be assumed. Nothing was implemented and no round landed on this verdict.`;
}
