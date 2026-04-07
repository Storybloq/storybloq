import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
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
    const reviewer = nextReviewer(existingReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const risk = ctx.state.ticket?.risk ?? "low";
    const minRounds = requiredRounds(risk as "low" | "medium" | "high");

    // Lenses backend: multi-lens parallel plan review
    if (reviewer === "lenses") {
      return {
        instruction: [
          `# Multi-Lens Plan Review — Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
          "",
          "This round uses the **multi-lens review orchestrator** for plan review. It fans out to specialized review agents (Clean Code, Security, Error Handling, and more) in parallel to evaluate the plan from multiple perspectives.",
          "",
          "1. Read the plan file",
          "2. Call `claudestory_review_lenses_prepare` with the plan text as diff, stage: PLAN_REVIEW, and ticketDescription",
          "3. Spawn all lens subagents in parallel (each prompt is returned by the prepare tool)",
          "4. Collect results and call `claudestory_review_lenses_synthesize` with the lens results",
          "5. Run the merger agent with the returned mergerPrompt, then call `claudestory_review_lenses_judge`",
          "6. Run the judge agent and report the final SynthesisResult verdict and findings",
          "",
          "When done, call `claudestory_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_review_round", "verdict": "<approve|revise|reject>", "findings": [...] } }`,
          '```',
        ].join("\n"),
        reminders: [
          "Report the exact verdict and findings from the synthesizer.",
          "Lens subagents run in parallel with read-only tools (Read, Grep, Glob).",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

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
      reminders: [
        "Report the exact verdict and findings from the reviewer.",
        "IMPORTANT: After the review, file ANY pre-existing issues discovered using claudestory_issue_create with severity and impact. Do NOT skip this step.",
        ...(reviewer === "codex" ? ["If codex is unavailable (usage limit, error, etc.), fall back to agent review and include 'codex unavailable' in your report notes."] : []),
      ],
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
    const computedReviewer = nextReviewer(planReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    // ISS-102: Use actual reviewer from report, infer from notes, or fall back to computed
    const reviewerBackend = report.reviewer
      ?? (computedReviewer === "codex" && report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes) ? "agent" : null)
      ?? computedReviewer;
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

    // ISS-098: Detect codex unavailability from agent notes
    // ISS-110: Store timestamp instead of just boolean for TTL-based expiry
    if (report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes)) {
      ctx.writeState({ codexUnavailable: true, codexUnavailableSince: new Date().toISOString() });
    }

    const risk = ctx.state.ticket?.risk ?? "low";
    const minRounds = requiredRounds(risk as "low" | "medium" | "high");
    // ISS-073: Only count unresolved findings (open/contested) as contradictory with approve
    const hasCriticalOrMajor = findings.some(
      (f) => (f.severity === "critical" || f.severity === "major") &&
        f.disposition !== "addressed" && f.disposition !== "deferred",
    );

    // Guard contradictory approve + critical/major (ISS-035)
    if (verdict === "approve" && hasCriticalOrMajor) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict." };
    }

    // ISS-035: explicit verdict routing
    const isRevise = verdict === "revise" || verdict === "request_changes";
    const isReject = verdict === "reject";

    let nextAction: "PLAN" | "IMPLEMENT" | "PLAN_REVIEW";
    if (isReject) {
      nextAction = "PLAN";
    } else if (isRevise) {
      // ISS-048: Revise stays in PLAN_REVIEW — agent already fixed inline, just re-review
      nextAction = "PLAN_REVIEW";
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

    // T-181: lens history merged into single atomic write
    const stateUpdate: Record<string, unknown> = {
      reviews: reviewsForWrite,
    };
    if (reviewerBackend === "lenses" && findings.length > 0) {
      const updated = buildLensHistoryUpdate(
        findings,
        ctx.state.lensReviewHistory ?? [],
        ctx.state.ticket?.id ?? "unknown",
        "PLAN_REVIEW",
      );
      if (updated) stateUpdate.lensReviewHistory = updated;
    }
    ctx.writeState(stateUpdate);

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
        reason: "reject",
      };
    }

    // ISS-048: Revise stays in PLAN_REVIEW — retry with findings summary
    if (isRevise) {
      const findingSummary = findings.length > 0
        ? findings.slice(0, 5).map((f) => `- [${f.severity}] ${f.description}`).join("\n")
        : "Address the reviewer's concerns.";
      return {
        action: "retry",
        instruction: [
          `# Plan Review — Round ${roundNum} requested changes`,
          "",
          "Update the plan to address these findings, then call me with completedAction: \"plan_review_round\" and the new review verdict.",
          "",
          findingSummary,
        ].join("\n"),
        reminders: ["Update the plan file, then re-review. Do NOT rewrite from scratch."],
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
    const nextReviewerName = nextReviewer(planReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
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
