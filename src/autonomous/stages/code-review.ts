import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { requiredRounds, nextReviewer } from "../review-depth.js";

/**
 * CODE_REVIEW stage — independent reviewer evaluates the implementation.
 *
 * enter(): Instruction to run code review with specified backend.
 * report(): Process verdict → advance (FINALIZE), retry (next round),
 *           back (IMPLEMENT for changes, PLAN for redirect).
 *
 * Multi-write: CODE_REVIEW → PLAN redirect resets both review histories.
 * StageContext handles state consistency across these writes.
 */
export class CodeReviewStage implements WorkflowStage {
  readonly id = "CODE_REVIEW";

  async enter(ctx: StageContext): Promise<StageResult> {
    const backends = ctx.state.config.reviewBackends;
    const codeReviews = ctx.state.reviews.code;
    const roundNum = codeReviews.length + 1;
    const reviewer = nextReviewer(codeReviews, backends);
    const risk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk ?? "low";
    const rounds = requiredRounds(risk as "low" | "medium" | "high");
    const mergeBase = ctx.state.git.mergeBase;

    const diffCommand = mergeBase
      ? `\`git diff ${mergeBase}\``
      : `\`git diff HEAD\` AND \`git ls-files --others --exclude-standard\``;
    const diffReminder = mergeBase
      ? `Run: git diff ${mergeBase} — pass FULL output to reviewer.`
      : "Run: git diff HEAD + git ls-files --others --exclude-standard — pass FULL output to reviewer.";

    return {
      instruction: [
        `# Code Review — Round ${roundNum} of ${rounds} minimum`,
        "",
        `Capture the diff with: ${diffCommand}`,
        "",
        "**IMPORTANT:** Pass the FULL unified diff to the reviewer. For diffs over ~500 lines, use file-scoped chunks (`git diff <mergebase> -- <filepath>`) across separate calls (pass the same session_id). Do NOT summarize or truncate any individual chunk.",
        "",
        `Run a code review using **${reviewer}**.`,
        "When done, report verdict and findings.",
      ].join("\n"),
      reminders: [
        diffReminder,
        "Do NOT compress or summarize the diff.",
        "If the reviewer flags pre-existing issues unrelated to your changes, file them as issues using claudestory_issue_create with severity and impact. Do not fix them in this ticket.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const verdict = report.verdict;
    if (!verdict || !["approve", "revise", "request_changes", "reject"].includes(verdict)) {
      return { action: "retry", instruction: 'Invalid verdict. Re-submit with verdict: "approve", "revise", "request_changes", or "reject".' };
    }

    const codeReviews = [...ctx.state.reviews.code];
    const roundNum = codeReviews.length + 1;
    const findings = report.findings ?? [];
    const backends = ctx.state.config.reviewBackends;
    const reviewerBackend = nextReviewer(codeReviews, backends);
    codeReviews.push({
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

    const risk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk ?? "low";
    const minRounds = requiredRounds(risk as "low" | "medium" | "high");
    // ISS-073: Only count unresolved findings (open/contested) as contradictory with approve
    const hasCriticalOrMajor = findings.some(
      (f) => (f.severity === "critical" || f.severity === "major") &&
        f.disposition !== "addressed" && f.disposition !== "deferred",
    );

    // Check for PLAN redirect
    const planRedirect = findings.some((f) => f.recommendedNextState === "PLAN");

    // Guard contradictory approve payloads (ISS-035)
    if (verdict === "approve" && hasCriticalOrMajor) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict." };
    }
    if (verdict === "approve" && planRedirect) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but findings recommend replanning. Re-run the review or correct the verdict." };
    }

    let nextAction: "PLAN" | "IMPLEMENT" | "FINALIZE" | "CODE_REVIEW";
    if (planRedirect && verdict !== "approve") {
      nextAction = "PLAN";
    } else if (verdict === "reject" || verdict === "revise" || verdict === "request_changes") {
      nextAction = "IMPLEMENT";
    } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
      nextAction = "FINALIZE";
    } else if (roundNum >= 5) {
      nextAction = "FINALIZE";
    } else {
      nextAction = "CODE_REVIEW";
    }

    // CODE_REVIEW → PLAN: full reset — both plan and code reviews cleared
    if (nextAction === "PLAN") {
      ctx.writeState({
        reviews: { plan: [], code: [] },
        ticket: ctx.state.ticket ? { ...ctx.state.ticket, realizedRisk: undefined } : ctx.state.ticket,
      });

      ctx.appendEvent("code_review", {
        round: roundNum,
        verdict,
        findingCount: findings.length,
        redirectedTo: "PLAN",
      });

      await ctx.fileDeferredFindings(findings, "code");

      return { action: "back", target: "PLAN", reason: "plan_redirect" };
    }

    // Normal transitions
    ctx.writeState({
      reviews: { ...ctx.state.reviews, code: codeReviews },
    });

    ctx.appendEvent("code_review", {
      round: roundNum,
      verdict,
      findingCount: findings.length,
    });

    await ctx.fileDeferredFindings(findings, "code");

    if (nextAction === "IMPLEMENT") {
      return { action: "back", target: "IMPLEMENT", reason: "request_changes" };
    }

    if (nextAction === "FINALIZE") {
      // T-135: Review mode exits after code review approval
      if (ctx.state.mode === "review") {
        ctx.writeState({
          status: "completed" as const,
          terminationReason: "normal" as const,
        });
        return {
          action: "goto",
          target: "SESSION_END",
          result: {
            instruction: [
              "# Code Review Complete",
              "",
              `Code for **${ctx.state.ticket?.id}** has been approved after ${roundNum} review round(s).`,
              "",
              "Session ending — review mode is complete. You can now proceed to commit.",
            ].join("\n"),
            reminders: [],
            transitionedFrom: "CODE_REVIEW",
          },
        } as StageAdvance;
      }
      return { action: "advance" };
    }

    // Stay in CODE_REVIEW
    const nextReviewerName = nextReviewer(codeReviews, backends);
    const mergeBase = ctx.state.git.mergeBase;
    return {
      action: "retry",
      instruction: [
        `Code review round ${roundNum} found issues. Fix them and re-review with **${nextReviewerName}**.`,
        "",
        `Capture diff with: ${mergeBase ? `\`git diff ${mergeBase}\`` : "`git diff HEAD` + `git ls-files --others --exclude-standard`"}. Pass FULL output — do NOT compress or summarize.`,
      ].join("\n"),
      reminders: ["Pass FULL diff output to reviewer. Do NOT compress or summarize."],
    };
  }
}
