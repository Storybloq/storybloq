import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { assessRisk } from "../review-depth.js";
import { gitDiffStat, gitDiffNames } from "../git-inspector.js";

/**
 * IMPLEMENT stage — Claude writes code to implement the approved plan.
 *
 * enter(): Instruction to implement the plan.
 * report(): Compute realized risk from actual diff, advance to next stage
 *           (CODE_REVIEW or TEST if enabled).
 */
export class ImplementStage implements WorkflowStage {
  readonly id = "IMPLEMENT";

  async enter(ctx: StageContext): Promise<StageResult> {
    const ticket = ctx.state.ticket;
    const planPath = `.story/sessions/${ctx.state.sessionId}/plan.md`;
    return {
      instruction: [
        `# Implement — ${ticket?.id ?? "unknown"}: ${ticket?.title ?? ""}`,
        "",
        `Implement the approved plan at \`${planPath}\`.`,
        "",
        "When done, call `claudestory_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "implementation_done" } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Follow the plan exactly. Do NOT deviate without re-planning.",
        "Do NOT ask the user for confirmation.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    // Risk recomputation from actual diff
    let realizedRisk = ctx.state.ticket?.risk ?? "low";
    const mergeBase = ctx.state.git.mergeBase;
    if (mergeBase) {
      const diffResult = await gitDiffStat(ctx.root, mergeBase);
      const namesResult = await gitDiffNames(ctx.root, mergeBase);
      if (diffResult.ok) {
        realizedRisk = assessRisk(diffResult.data, namesResult.ok ? namesResult.data : undefined);
      }
    }

    // Stage field updates (persisted atomically with state transition by processAdvance)
    ctx.updateDraft({
      ticket: ctx.state.ticket ? { ...ctx.state.ticket, realizedRisk } : ctx.state.ticket,
    });

    // T-139: Return plain advance — let the next stage's enter() provide its own instruction.
    // Previously hardcoded CODE_REVIEW instruction here, but this breaks when
    // TEST or WRITE_TESTS is inserted between IMPLEMENT and CODE_REVIEW.
    return { action: "advance" };
  }
}
