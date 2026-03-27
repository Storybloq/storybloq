import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { assessRisk, requiredRounds, nextReviewer } from "../review-depth.js";
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

    // Update ticket with realized risk
    ctx.writeState({
      ticket: ctx.state.ticket ? { ...ctx.state.ticket, realizedRisk } : ctx.state.ticket,
    });

    ctx.appendEvent("implementation_done", { realizedRisk });

    // Build the next stage's instruction (CODE_REVIEW or TEST)
    // During hybrid dispatch, the next stage may not be registered yet,
    // so we produce the instruction here via advance+result.
    const backends = ctx.state.config.reviewBackends;
    const codeReviews = ctx.state.reviews.code;
    const reviewer = nextReviewer(codeReviews, backends);
    const rounds = requiredRounds(realizedRisk as "low" | "medium" | "high");

    const diffCommand = mergeBase
      ? `\`git diff ${mergeBase}\``
      : `\`git diff HEAD\` AND \`git ls-files --others --exclude-standard\``;
    const diffReminder = mergeBase
      ? `Run: git diff ${mergeBase} — pass FULL output to reviewer.`
      : "Run: git diff HEAD + git ls-files --others --exclude-standard — pass FULL output to reviewer.";

    return {
      action: "advance",
      result: {
        instruction: [
          `# Code Review — Round 1 of ${rounds} minimum`,
          "",
          `Realized risk: **${realizedRisk}**${realizedRisk !== ctx.state.ticket?.risk ? ` (was ${ctx.state.ticket?.risk})` : ""}.`,
          "",
          `Capture the diff with: ${diffCommand}`,
          "",
          "**IMPORTANT:** Pass the FULL unified diff output to the reviewer. Do NOT summarize, compress, or truncate the diff.",
          "",
          `Run a code review using **${reviewer}**.`,
          "When done, report verdict and findings.",
        ].join("\n"),
        reminders: [diffReminder, "Do NOT compress or summarize the diff."],
        transitionedFrom: "IMPLEMENT",
      },
    };
  }
}
