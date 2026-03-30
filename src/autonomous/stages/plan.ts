import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { assessRisk, requiredRounds, nextReviewer } from "../review-depth.js";

/** Read a file, return empty string on error. */
function readFileSafe(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

/** DJB2 hash for plan fingerprinting (ISS-035). Must match guide.ts simpleHash. */
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
        "When done, call `claudestory_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Write the plan as a markdown file — do NOT use Claude Code's plan mode.",
        "Do NOT ask the user for approval.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
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

    // Compute initial risk
    const risk = assessRisk(undefined, undefined);

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
          const updated = { ...ticket, status: "inprogress" as const, claimedBySession: ctx.state.sessionId };
          await writeTicketUnlocked(updated, ctx.root);
        });
      } catch {
        // Best-effort — don't block plan review if ticket update fails
      }
    }

    if (claimFailed) {
      return { action: "retry", instruction: `Cannot claim ticket ${ctx.state.ticket?.id} — it is not open or is already claimed by another session. Pick a different ticket.` };
    }

    // Stage field updates (persisted atomically with state transition by processAdvance)
    ctx.updateDraft({
      ticket: ctx.state.ticket ? { ...ctx.state.ticket, risk, lastPlanHash: planHash } : ctx.state.ticket,
    });

    // Produce PLAN_REVIEW instruction (advance with result for hybrid dispatch)
    const backends = ctx.state.config.reviewBackends;
    const existingPlanReviews = ctx.state.reviews.plan;
    const roundNum = existingPlanReviews.length + 1;
    const reviewer = nextReviewer(existingPlanReviews, backends);
    const minRounds = requiredRounds(risk);

    return {
      action: "advance",
      result: {
        instruction: [
          `# Plan Review — Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
          "",
          `Run a plan review using **${reviewer}**.`,
          "",
          reviewer === "codex"
            ? `Call \`review_plan\` MCP tool with the plan content.`
            : `Launch a code review agent to review the plan.`,
          "",
          "When done, call `claudestory_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_review_round", "verdict": "<approve|revise|request_changes|reject>", "findings": [...] } }`,
          '```',
        ].join("\n"),
        reminders: ["Report the exact verdict and findings from the reviewer."],
        transitionedFrom: "PLAN",
      },
    };
  }
}
