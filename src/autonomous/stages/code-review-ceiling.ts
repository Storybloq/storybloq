import { dialCodeReviewMaxRounds } from "../session-diagnostics.js";
import { normalizeSeverity, type FullSessionState } from "../session-types.js";
import type { WorkItemRef } from "../../core/arrangement-bounds.js";

/** Mirrors the local alias in `session-diagnostics.ts`, which does not export it. */
type StageConfigMap = Readonly<Record<string, Readonly<Record<string, unknown>>>> | null | undefined;

/**
 * THE HARD CEILING (T-470).
 *
 * `maxReviewRounds` does not do what its name suggests. `forcedLanding` is
 * gated on `!hasUnresolvedCritical`, so the cap forces landing only when
 * nothing blocking is outstanding; a review that keeps producing unresolved
 * criticals routes CODE_REVIEW -> IMPLEMENT -> CODE_REVIEW with NO upper bound
 * at all. That is the reported sixty-round case, and no value of the existing
 * cap bounds it, because the cap is not on the path that loops.
 *
 * The ceiling is the bound that has no exemption. Reaching it ends the session
 * with the outstanding findings filed as issues, rather than spending the rest
 * of the budget re-reviewing something that is not converging.
 */

/**
 * Rounds allowed BEYOND the cap before the ceiling fires.
 *
 * Matches the existing `maxReviewRounds + 3` band in `session-diagnostics.ts`,
 * so the number a reader already sees described as "past the cap" is the same
 * number that acts. The grace exists because the cap is a landing TARGET, and
 * an item legitimately mid-fix when it is reached deserves a few rounds to
 * finish rather than being cut off at the boundary.
 */
export const CODE_REVIEW_HARD_CEILING_GRACE = 3;

/**
 * The round at which a non-converging item is parked, or 0 for "no ceiling".
 *
 * `cap === 0` disables the ceiling too. A project that explicitly turned the
 * cap off did so deliberately, and quietly reimposing a bound three rounds
 * later would make "unlimited" mean something other than unlimited.
 *
 * Derived from the CAP rather than the landing floor: the floor carries the
 * light-effort grace round, which is an exception to LANDING, and compounding
 * the two graces would put the ceiling a round further out at light effort for
 * no stated reason.
 */
export function codeReviewHardCeiling(
  state: Parameters<typeof dialCodeReviewMaxRounds>[0],
  stages: StageConfigMap,
  risk: string | null | undefined,
): number {
  const cap = dialCodeReviewMaxRounds(state, stages, risk);
  if (cap <= 0) return 0;
  return cap + CODE_REVIEW_HARD_CEILING_GRACE;
}

export interface RoundCounter {
  readonly workItemId: string;
  readonly kind: "ticket" | "issue";
  readonly completedRounds: number;
}

/**
 * The counter AFTER recording the round currently being reported.
 *
 * Includes the current round on purpose. Comparing the STORED count would fire
 * the ceiling one round late, because the round in hand is not persisted until
 * after the routing decision is made.
 *
 * Resets to 1 when the work item differs -- by id OR by kind -- so a newly
 * selected item can never inherit a poisoned count from the one before it,
 * including across a park and re-pick, a claim-loss re-pick, recovery, and a
 * ticket-to-issue (or issue-to-ticket) switch.
 */
export function nextRoundCounter(
  previous: RoundCounter | null | undefined,
  item: WorkItemRef,
): RoundCounter {
  if (!previous || previous.workItemId !== item.id || previous.kind !== item.kind) {
    return { workItemId: item.id, kind: item.kind, completedRounds: 1 };
  }
  return { workItemId: item.id, kind: item.kind, completedRounds: previous.completedRounds + 1 };
}

/**
 * Completed rounds recorded for `item`, or 0.
 *
 * The id+kind check is the whole point: a counter belonging to another work
 * item -- by id or by kind -- is not a smaller count, it is NO count, and
 * treating it as one would carry a previous item's rounds into this one's
 * ceiling.
 */
export function roundsForWorkItem(
  counter: RoundCounter | null | undefined,
  item: WorkItemRef | null | undefined,
): number {
  if (!counter || !item || counter.workItemId !== item.id || counter.kind !== item.kind) return 0;
  return counter.completedRounds;
}

export interface CeilingDecision {
  readonly shouldPark: boolean;
  readonly ceiling: number;
  readonly counter: RoundCounter | null;
}

/**
 * Whether this round trips the ceiling.
 *
 * `nextAction !== "FINALIZE"` means the ceiling can only ever convert a
 * would-be CONTINUATION into a park. It provably cannot alter an `approve`, a
 * `forcedLanding`, or the `roundNum >= 5` landing, so nothing that was going
 * to finish stops finishing.
 *
 * ISS-1032: a work item's presence -- ticket OR issue -- is what gates the
 * ceiling, not a ticket specifically. `parkCurrentIssue` (park.ts) gives the
 * park path a real issue-shaped target, so the old ticket-only guard (the
 * park path had nowhere to route an issue) no longer applies.
 */
export function decideCeiling(args: {
  readonly state: FullSessionState;
  readonly stages: StageConfigMap;
  readonly risk: string | null | undefined;
  readonly nextAction: string;
}): CeilingDecision {
  const item: WorkItemRef | null = args.state.ticket
    ? { kind: "ticket", id: args.state.ticket.id }
    : args.state.currentIssue
      ? { kind: "issue", id: args.state.currentIssue.id }
      : null;
  const ceiling = codeReviewHardCeiling(args.state, args.stages, args.risk);
  if (!item) return { shouldPark: false, ceiling, counter: null };

  const counter = nextRoundCounter(args.state.codeReviewRoundCounter, item);
  const shouldPark = ceiling > 0 &&
    args.nextAction !== "FINALIZE" &&
    counter.completedRounds >= ceiling;

  return { shouldPark, ceiling, counter };
}

/** A review finding, in the only shape the ceiling needs from it. */
export interface CeilingFinding {
  readonly severity: string;
  readonly category: string;
  readonly description: string;
  readonly disposition?: string;
}

/**
 * The findings a ceiling stop has to file: the ones still open.
 *
 * ALLOW-LIST, not a deny-list. Every disposition other than `open` says
 * something specific about why the finding is not a live defect, and each of
 * them is a reason NOT to mint a ledger issue:
 *
 *  - `addressed` is fixed.
 *  - `contested` is a FALSE POSITIVE. The implementer said so explicitly, and
 *    `lesson-capture` reads it that way. Filing it would put a critical-severity
 *    issue in the ledger for something the session already decided was not real.
 *  - `deferred` is valid but out of scope, and `fileDeferredFindings` is the
 *    path that files it. Filing it here too would be a second claim on the same
 *    finding by a path that calls it a blocker.
 *  - a `suggestion` is not a defect at any disposition, which is the one
 *    exemption this shares with the deferral path.
 *
 * A missing disposition reads as open, because an unreviewed finding has not
 * been dismissed by anyone.
 *
 * DELIBERATELY NARROWER than the `unresolvedCritical` / `unresolvedMajor` counts
 * recorded beside it. Those mirror the engine's own routing rule
 * (`hasUnresolvedCritical`), which counts a contested critical as unresolved --
 * and it is exactly that rule which kept the session from landing, so it is the
 * honest answer to "why did this stop". What stops a session and what deserves
 * an issue are different questions, and this one must not answer the first.
 *
 * Shared by the site that RECORDS the escalation and the one that FILES it, so
 * the set persisted with the decision is by construction the set that gets
 * filed. A critical that survives this filter is filed AS a critical: laundering
 * a real blocker into a note is what this whole path exists to avoid.
 */
export function outstandingCeilingFindings(
  findings: readonly CeilingFinding[],
): { severity: string; category: string; description: string }[] {
  return findings
    .filter((f) => (f.disposition == null || f.disposition === "open")
      && normalizeSeverity(f.severity) !== "suggestion")
    .map((f) => ({ severity: f.severity, category: f.category, description: f.description }));
}
