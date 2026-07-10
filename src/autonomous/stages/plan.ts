import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { normalizeRiskLevel, requiredRounds, nextReviewer } from "../review-depth.js";
import {
  currentStorybloqClient,
  nativeCodexReportInstruction,
  nativeCodexReviewCommand,
  reviewBackendsForClient,
  shouldUseNativeCodexReview,
} from "./codex-native.js";

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
 * PLAN stage — Claude writes an implementation plan.
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
      ].join("\n"),
      reminders: [
        "Write the plan as a markdown file -- do NOT use client-native plan mode.",
        "Do NOT ask the user for approval.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    if (_report.completedAction === "skip_ticket") {
      const ticketId = ctx.state.ticket?.id ?? "unknown";
      const reason = _report.notes ?? "Ticket cannot be completed in this session.";

      if (ctx.state.ticket) {
        try {
          const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
          await withProjectLock(ctx.root, { strict: false }, async ({ state: ps }) => {
            const ticket = ps.ticketByID(ticketId);
            if (ticket && (ticket as Record<string, unknown>).claimedBySession === ctx.state.sessionId) {
              // ISS-759/ISS-652: delete the claim keys rather than writing
              // explicit nulls, so a released ticket carries no residual state.
              const { claimedBySession: _cb, claim: _cl, ...rest } = ticket as Record<string, unknown>;
              await writeTicketUnlocked({ ...rest, status: "open" as const } as typeof ticket, ctx.root);
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

    // Plan fingerprint — detect unchanged plan after revise (ISS-035)
    const planHash = simpleHash(planContent);
    if (ctx.state.ticket?.lastPlanHash && ctx.state.ticket.lastPlanHash === planHash) {
      return { action: "retry", instruction: "Plan has not changed since the last review. Address the review findings, then revise the plan and call me again." };
    }

    // Initial (plan-time) risk. There is no diff yet, so it cannot be measured
    // from change size — carry the ticket's risk seed (author-assigned at
    // creation, defaulted to "low" at PICK). This drives the PLAN_REVIEW minimum
    // round count via requiredRounds(). The realized, diff-measured risk is
    // computed later in IMPLEMENT and stored as ticket.realizedRisk.
    const risk = normalizeRiskLevel(ctx.state.ticket?.risk);

    // Update ticket to inprogress in .story/ with session ownership (ISS-024/ISS-027)
    let claimFailed = false;
    if (ctx.state.ticket) {
      try {
        const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
        await withProjectLock(ctx.root, { strict: false }, async ({ state: projectState }) => {
          const ticket = projectState.ticketByID(ctx.state.ticket!.id);
          if (!ticket) return;
          const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
          if (ticket.status === "inprogress" && ticketClaim === ctx.state.sessionId) return;
          if (ticket.status !== "open") { claimFailed = true; return; }
          if (ticketClaim && ticketClaim !== ctx.state.sessionId) { claimFailed = true; return; }
          const draftClaim = (ctx.state as Record<string, unknown>).pendingTicketClaim as { user: string; branch: string; since: string } | undefined;
          if (ticket.claim && draftClaim) {
            // ISS-759: same-user claims are re-claimable on ANY branch. A
            // per-ticket-branch session legitimately holds a claim from a
            // previous branch of the same user (e.g. a prior story/T-xxx
            // attempt), and the canClaim same-branch requirement made PLAN
            // spin on retry. Only a FOREIGN user's claim blocks the recheck;
            // freshness handling for foreign claims stays where it is today
            // (PICK_TICKET), unchanged by this gate.
            if (ticket.claim.user !== draftClaim.user) { claimFailed = true; return; }
          } else if (ticket.claim && !draftClaim) {
            claimFailed = true; return;
          }
          const updated = { ...ticket, status: "inprogress" as const, claimedBySession: ctx.state.sessionId, ...(draftClaim ? { claim: draftClaim } : {}) };
          await writeTicketUnlocked(updated, ctx.root);
        });
      } catch {
        // Best-effort — don't block plan review if ticket update fails
      }
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
      ctx.updateDraft({ ticket: undefined, pendingTicketClaim: undefined } as Partial<typeof ctx.state>);
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
    });

    // Produce PLAN_REVIEW instruction (advance with result for hybrid dispatch)
    const backends = reviewBackendsForClient(ctx.state.config);
    const existingPlanReviews = ctx.state.reviews.plan;
    const roundNum = existingPlanReviews.length + 1;
    const reviewer = nextReviewer(existingPlanReviews, backends);
    const minRounds = requiredRounds(risk);

    const nativeCodex = shouldUseNativeCodexReview(reviewer, ctx.state.config);
    const bridgeCodex = currentStorybloqClient() === "claude" && reviewer === "codex";
    return {
      action: "advance",
      result: {
        instruction: nativeCodex
          ? [
            `# Native Codex Plan Review - Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
            "",
            "Run native Codex plan review:",
            "```bash",
            nativeCodexReviewCommand("plan", ctx.state.sessionId),
            "```",
            "",
            nativeCodexReportInstruction(ctx.state.sessionId),
          ].join("\n")
          : [
            `# Plan Review — Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
            "",
            `Run a plan review using **${reviewer}**.`,
            "",
            bridgeCodex
              ? `Call \`review_plan\` MCP tool with the plan content.`
              : `Launch a code review agent to review the plan.`,
            "",
            "When done, call `storybloq_autonomous_guide` with:",
            '```json',
            `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_review_round", "verdict": "<approve|revise|reject>", "findings": [...] } }`,
            '```',
          ].join("\n"),
        reminders: nativeCodex
          ? [
            "The helper uses `codex exec --output-schema` and read-only sandboxing.",
            "If native Codex fails, fall back to the next configured reviewer if available; otherwise use agent review and include 'codex unavailable' in notes.",
          ]
          : ["Report the exact verdict and findings from the reviewer."],
        transitionedFrom: "PLAN",
      },
    };
  }
}
