import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { requiredRounds, nextReviewer } from "../review-depth.js";

/**
 * PLAN_REVIEW stage — independent reviewer evaluates the plan.
 *
 * enter(): Instruction to run plan review with specified backend.
 * report(): Process verdict → advance (IMPLEMENT), retry (next round),
 *           or back (PLAN for revise/reject).
 */
export class PlanReviewStage implements WorkflowStage {
  readonly id = "PLAN_REVIEW";

  async enter(ctx: StageContext): Promise<StageResult> {
    const backends = ctx.state.config.reviewBackends;
    const existingReviews = ctx.state.reviews.plan;
    const roundNum = existingReviews.length + 1;
    const reviewer = nextReviewer(existingReviews, backends);
    const risk = ctx.state.ticket?.risk ?? "low";
    const minRounds = requiredRounds(risk as "low" | "medium" | "high");

    return {
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
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const verdict = report.verdict;
    if (!verdict || !["approve", "revise", "request_changes", "reject"].includes(verdict)) {
      return { action: "retry", instruction: 'Invalid verdict. Re-submit with verdict: "approve", "revise", "request_changes", or "reject".' };
    }

    // Record review round
    const planReviews = [...ctx.state.reviews.plan];
    const roundNum = planReviews.length + 1;
    const findings = report.findings ?? [];
    const backends = ctx.state.config.reviewBackends;
    const reviewerBackend = nextReviewer(planReviews, backends);
    planReviews.push({
      round: roundNum,
      reviewer: reviewerBackend,
      verdict,
      findingCount: findings.length,
      criticalCount: findings.filter((f) => f.severity === "critical").length,
      majorCount: findings.filter((f) => f.severity === "major").length,
      suggestionCount: findings.filter((f) => f.severity === "suggestion").length,
      codexSessionId: report.reviewerSessionId,
      timestamp: new Date().toISOString(),
    });

    const risk = ctx.state.ticket?.risk ?? "low";
    const minRounds = requiredRounds(risk as "low" | "medium" | "high");
    const hasCriticalOrMajor = findings.some(
      (f) => f.severity === "critical" || f.severity === "major",
    );

    // Guard contradictory approve + critical/major (ISS-035)
    if (verdict === "approve" && hasCriticalOrMajor) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict." };
    }

    // ISS-035: explicit verdict routing
    const isRevise = verdict === "revise" || verdict === "request_changes";
    const isReject = verdict === "reject";

    let nextAction: "PLAN" | "IMPLEMENT" | "PLAN_REVIEW";
    if (isReject || isRevise) {
      nextAction = "PLAN";
    } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
      nextAction = "IMPLEMENT";
    } else if (roundNum >= 5) {
      nextAction = "IMPLEMENT";
    } else {
      nextAction = "PLAN_REVIEW";
    }

    // reject: clear plan review history. revise: preserve history.
    const reviewsForWrite = isReject
      ? { ...ctx.state.reviews, plan: [] as typeof planReviews }
      : { ...ctx.state.reviews, plan: planReviews };

    ctx.writeState({
      reviews: nextAction === "PLAN" ? reviewsForWrite : { ...ctx.state.reviews, plan: planReviews },
    });

    ctx.appendEvent("plan_review", {
      round: roundNum,
      verdict,
      findingCount: findings.length,
    });

    // ISS-037: file deferred findings
    await ctx.fileDeferredFindings(findings, "plan");

    if (nextAction === "PLAN") {
      return {
        action: "back",
        target: "PLAN",
        reason: isRevise ? "revise" : "reject",
      };
    }

    if (nextAction === "IMPLEMENT") {
      // T-135: Plan mode exits after plan review approval
      if (ctx.state.mode === "plan") {
        ctx.writeState({
          status: "completed" as const,
          terminationReason: "normal" as const,
        });
        return {
          action: "goto",
          target: "SESSION_END",
          result: {
            instruction: [
              "# Plan Review Complete",
              "",
              `Plan for **${ctx.state.ticket?.id}** has been approved after ${roundNum} review round(s).`,
              "",
              "Session ending — plan mode is complete.",
            ].join("\n"),
            reminders: [],
            transitionedFrom: "PLAN_REVIEW",
          },
        } as StageAdvance;
      }
      return { action: "advance" };
    }

    // Stay in PLAN_REVIEW — next round
    const nextReviewerName = nextReviewer(planReviews, backends);
    return {
      action: "retry",
      instruction: [
        `# Plan Review — Round ${roundNum + 1}`,
        "",
        hasCriticalOrMajor
          ? `Round ${roundNum} found ${findings.filter((f) => f.severity === "critical" || f.severity === "major").length} critical/major finding(s). Address them, then re-review with **${nextReviewerName}**.`
          : `Round ${roundNum} complete. Run round ${roundNum + 1} with **${nextReviewerName}**.`,
        "",
        "Report verdict and findings as before.",
      ].join("\n"),
      reminders: ["Address findings before re-reviewing."],
    };
  }
}
