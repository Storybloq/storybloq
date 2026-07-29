import { releaseClaimIfOwned } from "../../core/claims.js";
import { parseClaimEpoch } from "../claim-preflight.js";
import type { StageAdvance, StageContext } from "./types.js";
import type { FullSessionState, GuideReportInput } from "../session-types.js";

/**
 * ISS-904: first-class plan-gate park.
 *
 * A plan gate that keeps rejecting because the FILING is defective rather than
 * the plan had no representation in the state machine. `skip_ticket` exists at
 * PLAN and PLAN_REVIEW, but it routes to HANDOVER and never touches
 * `skippedTargets`, so it ends the whole session instead of advancing the queue
 * past one unworkable item. The remaining escapes were an approve verdict the
 * reviewer never gave, or the admin CLI -- and once an operator released the
 * claim by hand to unstick the queue, the ISS-784 claim-loss guard and the
 * cancel gate formed a closed cycle (see `permitsCancelDespiteSoftGate`).
 *
 * A park is the pipeline performing that release ITSELF, so the release is
 * explained rather than unattributable:
 *
 *   1. release the claim through `releaseSessionClaim`, which proves ownership
 *      against the epoch before touching either ownership field (T-442)
 *   2. record the reason on the ticket as durable passthrough metadata
 *   3. add the item to `skippedTargets`, which BOTH the targeted queue
 *      (`getRemainingTargets`) and standard candidate building already consult
 *   4. clear the draft ticket and the epoch
 *
 * Step 4 is what keeps the ISS-784 guard correct rather than weakened.
 * `reconcileSessionReality` returns NOT_CHECKED when `state.ticket` is absent
 * (claim-preflight.ts:153), so a park the pipeline performed does not trip the
 * guard -- while a park performed by hand, which leaves the draft ticket in
 * place, still trips it exactly as it does today.
 */

/** The control action that parks the current item. */
export const PARK_ACTION = "park_item";

/** Stages from which an item can be declared unworkable as filed. */
export type ParkOrigin = "PLAN" | "PLAN_REVIEW";

/**
 * The only states that handle `park_item`. Enforced centrally in
 * `runPipelineStage`, because most stages do not reject an unrecognised action
 * -- IMPLEMENT treats anything other than `no_implementation_needed` as
 * "implementation done" -- so an unguarded park one stage too late would
 * silently advance the pipeline rather than park anything.
 */
export const PARK_STAGES: ReadonlySet<string> = new Set<ParkOrigin>(["PLAN", "PLAN_REVIEW"]);

/**
 * Completed plan-review rounds after which repeated non-approval is treated as
 * diagnostic of the FILING rather than of the plan.
 *
 * Three consecutive parks in one campaign (T-440, T-443, T-444) were each
 * preceded by more rounds than this, and in each the reviewer was correct and
 * the plan could not be fixed, because a plan cannot be written around a
 * contradiction in its own acceptance criteria. Two rounds is normal review;
 * the third is where the hypothesis is worth surfacing.
 */
export const PARK_HINT_AFTER_ROUNDS = 3;

/**
 * Lines appended to a plan-gate instruction once rejection has repeated enough
 * to be diagnostic. Empty before the threshold, so ordinary review is unchanged.
 *
 * This is the discoverability half of the fix: an escape nothing ever mentions
 * is not an escape, which is why three campaign parks were recorded by hand
 * even though `skip_ticket` already existed at both plan stages.
 */
export function parkHintLines(sessionId: string, roundsSoFar: number): readonly string[] {
  if (roundsSoFar < PARK_HINT_AFTER_ROUNDS) return [];
  return [
    "",
    "---",
    "",
    `**${roundsSoFar} review rounds without approval.** Past this point the defect is often in the FILING rather than the plan: an acceptance criterion that contradicts a stated constraint, a cited \`file:line\` that does not hold, or a scope item that cannot be sound in isolation from the others. A plan cannot be written around a contradiction, and an approve verdict must never be faked to escape one.`,
    "",
    "If that is what is happening here, PARK the item instead of re-planning. It returns to `open` with your reason recorded on it, this session advances to the next item, and the rest of the queue is preserved:",
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "${PARK_ACTION}", "notes": "<the contradiction, specifically>" } }`,
    "```",
    "",
    "Park only for a defect in the item itself. Ordinary review findings are addressed and re-reviewed as usual.",
  ];
}

export interface ParkRecord {
  readonly reason: string;
  readonly stage: ParkOrigin;
  readonly sessionId: string;
  readonly parkedAt: string;
}

/**
 * What the locked section actually achieved. The distinction is load-bearing:
 * only `parked` proves the pipeline performed the release itself, which is the
 * sole condition under which clearing the draft ticket is honest rather than a
 * way of silencing the ISS-784 guard.
 *
 * - `parked-released`  claim epoch-proven, released, record written
 * - `parked-unclaimed` ticket was still open and unclaimed; record written, no
 *                      release happened and the status was left alone
 * - `not-ours`         claim moved, ticket vanished, or it left `inprogress`;
 *                      NOTHING was written
 * - `write-failed`     the ledger state is unknown; the session keeps everything
 */
type ParkOutcome = "parked-released" | "parked-unclaimed" | "not-ours" | "write-failed";

/**
 * Both id forms are recorded. `targetWork` may carry display ids (`T-440`) while
 * `ticket.id` is canonical (`t-...`), and `getRemainingTargets` filters by string
 * equality, so recording only one form would leave the queue re-offering the
 * parked item forever -- the exact failure T-328 introduced `skippedTargets` to
 * prevent. `pick-ticket.ts` already checks both forms for issues.
 */
function withBothIdForms(existing: readonly string[], ids: readonly (string | undefined)[]): string[] {
  const next = [...existing];
  for (const id of ids) {
    if (id && !next.includes(id)) next.push(id);
  }
  return next;
}

/**
 * Parks the session's current ticket and routes back to PICK_TICKET.
 *
 * Returns a `retry` when the report carries no reason: a park whose reason is
 * unreadable afterwards fails the acceptance this exists to satisfy, and an
 * unexplained park is indistinguishable from the hand-release that produced the
 * deadlock in the first place.
 */
export async function parkCurrentTicket(
  ctx: StageContext,
  report: GuideReportInput,
  from: ParkOrigin,
): Promise<StageAdvance> {
  const draft = ctx.state.ticket;
  const ticketId = draft?.id;
  const label = draft?.displayId ?? ticketId ?? "the current item";

  const reason = (report.notes ?? "").trim();
  if (!reason) {
    return {
      action: "retry",
      instruction: [
        `"${PARK_ACTION}" requires a reason in \`notes\`.`,
        "",
        `Re-report with notes saying why ${label} cannot be planned AS FILED -- name the contradiction (which acceptance criterion conflicts with which constraint, or which cited reference does not hold). That text is written onto the item and is what the next session reads instead of rediscovering the block.`,
        "",
        "```json",
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "${PARK_ACTION}", "notes": "<why this item is not workable as filed>" } }`,
        "```",
      ].join("\n"),
    };
  }

  if (!ticketId) {
    return {
      action: "retry",
      instruction: `Nothing to park: this session holds no current ticket. Report a pick instead.`,
    };
  }

  const parkedAt = new Date().toISOString();
  let outcome: ParkOutcome = "write-failed";

  try {
    const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
    await withProjectLock(ctx.root, { strict: false }, async ({ state: ps }) => {
      const current = ps.ticketByID(ticketId);
      if (!current) {
        // Nothing to write to. Reconciliation reads this same absence as
        // `target-unreadable`, so the session drops the item rather than
        // stamping a record onto a ticket that is not there.
        outcome = "not-ours";
        return;
      }

      const park: ParkRecord = {
        reason,
        stage: from,
        sessionId: ctx.state.sessionId,
        parkedAt,
      };

      // ISS-759 semantics: PRESENCE of either key, not truthiness.
      const claimed = "claimedBySession" in current || "claim" in current;

      if (!claimed && current.status === "open") {
        // The fresh-pick case, and it is the COMMON one at PLAN. PICK_TICKET
        // stages the claim in SESSION state only; the ledger claim and the
        // epoch are both written later, at PLAN's `plan_written`. So a park
        // straight after a pick meets an open, unclaimed ticket. There is no
        // claim to prove and nothing foreign to destroy, so record the reason
        // and leave the ticket exactly as it is.
        await writeTicketUnlocked({ ...current, park } as typeof current, ctx.root);
        outcome = "parked-unclaimed";
        return;
      }

      // Claim material exists, so releasing it requires PROOF. `parseClaimEpoch`
      // rejects absent, malformed, and partially-written epochs alike.
      const epoch = parseClaimEpoch((ctx.state as Record<string, unknown>).claimEpoch);
      if (!epoch) {
        // Deliberately NOT releaseSessionClaim's epochless fallback. That path
        // trusts `claimedBySession` alone, so in the reachable split state
        // `{ claimedBySession: us, claim.user: rival }` it would delete the
        // RIVAL's winning claim and reopen their ticket -- exactly the
        // destruction T-442 exists to prevent. Without an epoch we cannot tell
        // that state from genuine ownership, so we write nothing.
        outcome = "not-ours";
        return;
      }

      // Ownership proof is not lifecycle proof. `releaseClaimIfOwned` compares
      // the two claim fields and says nothing about status, so a ticket that
      // became `complete` after the guide preflight while keeping matching claim
      // fields would pass it -- and the release rewrites status to `open`, which
      // would silently REOPEN a completed ticket and stamp park metadata on it.
      // Parking is only meaningful for work still in flight.
      if (current.status !== "inprogress") {
        outcome = "not-ours";
        return;
      }

      // T-442: proves BOTH ownership fields against the epoch, inside this lock,
      // so a claim that moved after the guide preflight is caught here.
      const released = releaseClaimIfOwned(current, epoch);
      if (!released.released) {
        outcome = "not-ours";
        return;
      }

      // Additive passthrough metadata (TicketSchema is .passthrough()), written
      // only on a proven release, in the same write that returns the ticket to
      // `open`, so the record and the release cannot disagree.
      await writeTicketUnlocked({ ...released.ticket, park } as typeof current, ctx.root);
      outcome = "parked-released";
    });
  } catch {
    // `outcome` stays whatever the lock body last set. A throw BEFORE the
    // ownership verdict leaves it "write-failed", which fails closed below.
  }

  // Fail closed. The ledger state is unknown and this session may still own an
  // `inprogress` ticket; clearing the draft here would abandon a claim nothing
  // can later release, and would silence the ISS-784 guard on a park that never
  // happened. Everything is preserved so the next call re-reconciles.
  if (outcome === "write-failed") {
    return {
      action: "retry",
      instruction: [
        `# Park failed: ${label} was not written`,
        "",
        "The ledger write did not complete, so this session may still hold the claim and nothing has changed.",
        "",
        `Retry the same call. If it keeps failing, check \`.story/tickets/\` for a lock or a permissions problem -- the session is intentionally still on ${label} rather than advancing past an item whose state is unknown.`,
      ].join("\n"),
    };
  }

  const parked = outcome === "parked-released" || outcome === "parked-unclaimed";

  ctx.appendEvent("item_parked", { ticketId, stage: from, reason, outcome });

  // Staged, not written, so the whole park commits atomically with the
  // transition in processAdvance (same reasoning as the ISS-759 claim-lost
  // re-pick at plan.ts:188). The goto target is validated by assertTransition,
  // so PLAN_REVIEW's row in TRANSITIONS must list PICK_TICKET.
  ctx.updateDraft({
    ticket: undefined,
    pendingTicketClaim: undefined,
    claimEpoch: undefined,
    reviews: { plan: [], code: [] },
    planGateNonApprovals: 0,
    skippedTargets: withBothIdForms(ctx.state.skippedTargets ?? [], [ticketId, draft?.displayId]),
  } as Partial<FullSessionState>);

  // The not-ours branch mirrors the ISS-759 claim-lost re-pick at plan.ts:188:
  // the session drops an item it can no longer prove is its own and re-picks.
  // Nothing was written to the ticket, so the reason is reported here instead
  // of being recorded on it, and the agent is told so plainly rather than being
  // left to assume the park landed.
  const notes = outcome === "parked-released"
    ? `The claim was released, ${label} is back to \`open\`, and the reason above is recorded on the item.`
    : outcome === "parked-unclaimed"
    ? `${label} was never claimed in the ledger, so it stays \`open\` exactly as it was, and the reason above is recorded on it.`
    : [
        `**The reason above was NOT recorded on ${label}.** Its claim no longer belongs to this session (it moved, or the item is no longer readable), and writing to a ticket another session may be working is exactly what this path refuses to do.`,
        "",
        `${label} was left untouched. If the filing defect needs to persist, file it as an issue instead.`,
      ].join("\n");

  return {
    action: "goto",
    target: "PICK_TICKET",
    result: {
      instruction: [
        parked ? `# Parked: ${label}` : `# Dropped: ${label} (claim no longer ours)`,
        "",
        `**Reason:** ${reason}`,
        "",
        notes,
        "",
        `${label} will not be offered again in this session. Pick the next item.`,
      ].join("\n"),
      reminders: [
        "Do NOT re-pick the parked item.",
        "Do NOT stop or summarize -- pick the next item immediately.",
      ],
      transitionedFrom: from,
    },
  };
}
