import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseSessionClaim } from "../../core/claims.js";
import type { ClaimEpoch } from "../claim-reconciliation.js";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { PARK_ACTION, parkCurrentTicket, parkHintLines } from "./park.js";
import { normalizeRiskLevel } from "../review-depth.js";
import { canAcquireTicketClaim } from "../candidate-authority.js";

/** Read a file, return empty string on error. */
function readFileSafe(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

/** DJB2 hash for plan fingerprinting (ISS-035): seed 5381, base-36; same algorithm as the deferral-fingerprint hash (djb2Hash) in stages/types.ts. */
function simpleHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

/**
 * PLAN stage -- Claude writes an implementation plan.
 *
 * enter(): Instruction to write a plan.
 * report(): Validate plan exists/changed, claim ticket, advance to PLAN_REVIEW.
 */
export class PlanStage implements WorkflowStage {
  readonly id = "PLAN";

  async enter(ctx: StageContext): Promise<StageResult> {
    const ticket = ctx.state.ticket;
    return {
      instruction: [
        `# Plan for ${ticket?.id ?? "unknown"}: ${ticket?.title ?? ""}`,
        "",
        `Write an implementation plan for this ticket. Save it to \`.story/sessions/${ctx.state.sessionId}/plan.md\`.`,
        "",
        "When done, call `storybloq_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
        '```',
        // ISS-904: a reject routes back here and clears reviews.plan, so this is
        // the only place a repeated reject loop is visible to the agent.
        ...parkHintLines(
          ctx.state.sessionId,
          ((ctx.state as Record<string, unknown>).planGateNonApprovals as number | undefined) ?? 0,
        ),
      ].join("\n"),
      reminders: [
        "Write the plan as a markdown file -- do NOT use client-native plan mode.",
        "Do NOT ask the user for approval.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    // ISS-904: park advances the queue past an item that is not workable AS
    // FILED. skip_ticket below ends the session instead; the two are different
    // outcomes and both are kept.
    if (_report.completedAction === PARK_ACTION) {
      return parkCurrentTicket(ctx, _report, "PLAN");
    }

    if (_report.completedAction === "skip_ticket") {
      const ticketId = ctx.state.ticket?.id ?? "unknown";
      const reason = _report.notes ?? "Ticket cannot be completed in this session.";

      if (ctx.state.ticket) {
        try {
          const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
          await withProjectLock(ctx.root, { strict: false }, async ({ state: ps }) => {
            const ticket = ps.ticketByID(ticketId);
            if (ticket) {
              // T-442: never delete a claim this session cannot prove is its own.
              const { released, ticket: next } = releaseSessionClaim(
                ticket,
                ctx.state.sessionId,
                (ctx.state as Record<string, unknown>).claimEpoch as ClaimEpoch | undefined,
              );
              if (released) await writeTicketUnlocked(next, ctx.root);
            }
          });
        } catch { /* best-effort */ }
      }

      ctx.updateDraft({ ticket: undefined, reviews: { plan: [], code: [] } });

      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: [
            `# Ticket Skipped: ${ticketId}`,
            "",
            `**Reason:** ${reason}`,
            "",
            "Write a handover documenting why this ticket was skipped and what the next session should know.",
            "",
            'Call `storybloq_autonomous_guide` with completedAction: "handover_written" and include the content in handoverContent.',
          ].join("\n"),
          reminders: [],
          transitionedFrom: "PLAN",
        },
      };
    }

    // Verify plan exists
    const planPath = join(ctx.dir, "plan.md");
    if (!existsSync(planPath)) {
      return { action: "retry", instruction: `Plan file not found at ${planPath}. Write your plan there and call me again.`, reminders: ["Save plan to .story/sessions/<id>/plan.md"] };
    }

    const planContent = readFileSafe(planPath);
    if (!planContent || planContent.trim().length === 0) {
      return { action: "retry", instruction: "Plan file is empty. Write your implementation plan and call me again." };
    }

    // Plan fingerprint -- detect unchanged plan after revise (ISS-035)
    const planHash = simpleHash(planContent);
    if (ctx.state.ticket?.lastPlanHash && ctx.state.ticket.lastPlanHash === planHash) {
      return { action: "retry", instruction: "Plan has not changed since the last review. Address the review findings, then revise the plan and call me again." };
    }

    // Preserve the ticket's plan-time risk seed. Legacy sessions without a
    // seed stay low; malformed persisted values fail closed to high.
    const storedRisk = ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");

    // Update ticket to inprogress in .story/ with session ownership (ISS-024/ISS-027)
    let claimFailed = false;
    // T-442: the epoch minted here is the ONLY proof of what this session
    // actually owns. Every later guide call reconciles the ledger against it.
    let mintedEpoch: ClaimEpoch | undefined;
    if (ctx.state.ticket) {
      try {
        const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
        await withProjectLock(ctx.root, { strict: false }, async ({ state: projectState }) => {
          const ticket = projectState.ticketByID(ctx.state.ticket!.id);
          if (!ticket) return;
          const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
          // ALREADY OURS: nothing to acquire and nothing to write. Checked
          // separately from the predicate below, which reports this case as
          // acquirable (it is) -- but re-writing the ticket here would be a
          // pointless ledger write, so this arm keeps its own early return.
          if (ticket.status === "inprogress" && ticketClaim === ctx.state.sessionId) return;
          const draftClaim = (ctx.state as Record<string, unknown>).pendingTicketClaim as { user: string; branch: string; since: string } | undefined;
          // T-450 step 7a: the acquisition rule is SHARED with candidate
          // takeover rather than restated there, so the two cannot drift.
          // Takeover asks the same question this stage asks -- may this session
          // hold this ticket -- and a takeover applying a stricter rule would
          // refuse recoveries the ordinary path would have allowed. The ISS-759
          // same-user-any-branch allowance lives inside the shared predicate.
          if (!canAcquireTicketClaim(ticket, ctx.state.sessionId, draftClaim)) {
            claimFailed = true; return;
          }
          const updated = { ...ticket, status: "inprogress" as const, claimedBySession: ctx.state.sessionId, ...(draftClaim ? { claim: draftClaim } : {}) };
          await writeTicketUnlocked(updated, ctx.root);
          // Recorded from the values actually written, not from the draft, so a
          // pre-existing same-user claim that was left in place is captured as
          // it stands on disk rather than as what we intended to write.
          mintedEpoch = {
            ticketId: updated.id,
            sessionId: ctx.state.sessionId,
            user: updated.claim ? updated.claim.user : null,
            branch: updated.claim ? updated.claim.branch : null,
            since: updated.claim ? updated.claim.since : null,
            establishedAt: new Date().toISOString(),
          };
        });
      } catch {
        // Best-effort -- don't block plan review if ticket update fails
      }
      // Persisted immediately rather than at the stage advance below. A crash in
      // between would otherwise leave a session that OWNS the ticket but carries
      // no epoch, and an epoch-less session is not reconciled at all -- exactly
      // the fail-open T-442 exists to close. The window is not zero: acquisition
      // is not yet a full five-step transaction (ISS-896).
      if (mintedEpoch) ctx.writeState({ claimEpoch: mintedEpoch } as Partial<typeof ctx.state>);
    }

    if (claimFailed) {
      const lostTicketId = ctx.state.ticket?.id ?? "unknown";
      // ISS-759: a failed claim means another session/user took the ticket
      // between PICK_TICKET and PLAN. Retrying PLAN can never succeed (the
      // plan file exists, the claim stays foreign), so it used to spin
      // forever. Clear the draft lock FIRST so the session no longer holds
      // the ticket, then send the walker back to PICK_TICKET. The goto target
      // is NOT free-form: assertTransition validates it against the state
      // machine, so PLAN's row in TRANSITIONS must list PICK_TICKET (ISS-767).
      ctx.updateDraft({ ticket: undefined, pendingTicketClaim: undefined, claimEpoch: undefined } as Partial<typeof ctx.state>);
      return {
        action: "goto",
        target: "PICK_TICKET",
        result: {
          instruction: [
            `# Claim Lost: ${lostTicketId}`,
            "",
            `Ticket ${lostTicketId} could not be claimed -- it is no longer open or was claimed by another session/user after it was picked.`,
            "The session is re-picking: choose a different ticket.",
            "",
            "When picked, call `storybloq_autonomous_guide` with:",
            '```json',
            `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
            '```',
          ].join("\n"),
          reminders: ["Do not re-pick the ticket whose claim was just lost."],
          transitionedFrom: "PLAN",
        },
      };
    }

    // Stage field updates (persisted atomically with state transition by processAdvance)
    ctx.updateDraft({
      ticket: ctx.state.ticket ? { ...ctx.state.ticket, risk, lastPlanHash: planHash } : ctx.state.ticket,
      // Only overwrite on a fresh mint. A re-entered PLAN (revise loop) short-
      // circuits the claim write when the ticket is already ours, and clobbering
      // the epoch with undefined there would disarm reconciliation for the rest
      // of the session.
      ...(mintedEpoch ? { claimEpoch: mintedEpoch } : {}),
    } as Partial<typeof ctx.state>);

    // T-139 pattern: advance WITHOUT a precomputed result, so the walker calls
    // the next stage's own enter(). This block used to build the PLAN_REVIEW
    // instruction itself, which processAdvance prefers over enter() -- three
    // things went wrong as a result. It had no lenses branch, so a
    // lenses-configured project got the plain agent instruction on round one;
    // it called nextReviewer without the codex-unavailable arguments, bypassing
    // ISS-098/ISS-110; and it never wrote currentReviewStartedAt. T-461 makes
    // it actively incorrect too: with reviewEffort off, PLAN_REVIEW is skipped
    // and this would hand a plan-review instruction to WRITE_TESTS or
    // IMPLEMENT. There is now one source for that text.
    return { action: "advance" };
  }
}
