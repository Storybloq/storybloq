import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { requiredRounds, nextReviewer } from "../review-depth.js";
import { clearCache } from "../review-lenses/cache.js";

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
    const reviewer = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const risk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk ?? "low";
    const rounds = requiredRounds(risk as "low" | "medium" | "high");
    const mergeBase = ctx.state.git.mergeBase;
    const isIssueFix = !!ctx.state.currentIssue;
    const issueHeader = isIssueFix
      ? `Issue Fix Code Review (${ctx.state.currentIssue!.id})`
      : "Code Review";

    const diffCommand = mergeBase
      ? `\`git diff ${mergeBase}\``
      : `\`git diff HEAD\` AND \`git ls-files --others --exclude-standard\``;
    const diffReminder = mergeBase
      ? `Run: git diff ${mergeBase} — pass FULL output to reviewer.`
      : "Run: git diff HEAD + git ls-files --others --exclude-standard — pass FULL output to reviewer.";

    // Lenses backend: multi-lens parallel review
    if (reviewer === "lenses") {
      return {
        instruction: [
          `# Multi-Lens ${issueHeader} — Round ${roundNum} of ${rounds} minimum`,
          "",
          `Capture the diff with: ${diffCommand}`,
          "",
          "This round uses the **multi-lens review orchestrator**. It fans out to specialized review agents (Clean Code, Security, Error Handling, and more) in parallel, then synthesizes findings into a single verdict.",
          "",
          "1. Capture the full diff and changed file list (`git diff --name-only`)",
          "2. Call `claudestory_review_lenses_prepare` with the diff, changedFiles, stage: CODE_REVIEW, and ticketDescription",
          "3. Spawn all lens subagents in parallel (each prompt is returned by the prepare tool)",
          "4. Collect results and call `claudestory_review_lenses_synthesize` with the lens results, plus the diff and changedFiles from step 1 and the sessionId (enables automatic origin classification and issue filing for pre-existing findings)",
          "5. Run the merger agent with the returned mergerPrompt, then call `claudestory_review_lenses_judge`",
          "6. Run the judge agent and report the final SynthesisResult verdict and findings",
          "",
          "When done, report verdict and findings.",
        ].join("\n"),
        reminders: [
          diffReminder,
          "Do NOT compress or summarize the diff.",
          "Lens subagents run in parallel with read-only tools (Read, Grep, Glob).",
          "Pre-existing issues in surrounding code are automatically classified and filed by the synthesize tool when you pass diff, changedFiles, and sessionId. Check filedIssues in the synthesize response.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

    return {
      instruction: [
        `# ${issueHeader} — Round ${roundNum} of ${rounds} minimum`,
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

    const codeReviews = [...ctx.state.reviews.code];
    const roundNum = codeReviews.length + 1;
    const findings = report.findings ?? [];
    const backends = ctx.state.config.reviewBackends;
    const computedReviewer = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    // ISS-102: Use actual reviewer from report, infer from notes, or fall back to computed
    const reviewerBackend = report.reviewer
      ?? (computedReviewer === "codex" && report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes) ? "agent" : null)
      ?? computedReviewer;
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

    // ISS-098: Detect codex unavailability from agent notes
    // ISS-110: Store timestamp instead of just boolean for TTL-based expiry
    if (report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes)) {
      ctx.writeState({ codexUnavailable: true, codexUnavailableSince: new Date().toISOString() });
    }

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

    // T-208: Issue-fix context
    const isIssueFix = !!ctx.state.currentIssue;

    // CODE_REVIEW → PLAN: full reset — both plan and code reviews cleared + lens cache + lens history
    // lensReviewHistory intentionally cleared: plan redirect means the approach changed fundamentally,
    // so previous findings are no longer relevant for the lessons feedback loop threshold calculation.
    // T-208: Issue fixes have no plan stage — redirect to ISSUE_FIX with same reset semantics.
    if (nextAction === "PLAN") {
      clearCache(ctx.dir);
      ctx.writeState({
        reviews: { plan: [], code: [] },
        lensReviewHistory: [],
        ticket: ctx.state.ticket ? { ...ctx.state.ticket, realizedRisk: undefined } : ctx.state.ticket,
      });

      ctx.appendEvent("code_review", {
        round: roundNum,
        verdict,
        findingCount: findings.length,
        redirectedTo: isIssueFix ? "ISSUE_FIX" : "PLAN",
      });

      await ctx.fileDeferredFindings(findings, "code");

      if (isIssueFix) {
        return { action: "goto", target: "ISSUE_FIX" };
      }
      return { action: "back", target: "PLAN", reason: "plan_redirect" };
    }

    // Normal transitions + T-181 lens history (single atomic write)
    const stateUpdate: Record<string, unknown> = {
      reviews: { ...ctx.state.reviews, code: codeReviews },
    };
    if (reviewerBackend === "lenses" && findings.length > 0) {
      const updated = buildLensHistoryUpdate(
        findings,
        ctx.state.lensReviewHistory ?? [],
        ctx.state.ticket?.id ?? "unknown",
        "CODE_REVIEW",
      );
      if (updated) stateUpdate.lensReviewHistory = updated;
    }
    ctx.writeState(stateUpdate);

    ctx.appendEvent("code_review", {
      round: roundNum,
      verdict,
      findingCount: findings.length,
    });

    await ctx.fileDeferredFindings(findings, "code");

    if (nextAction === "IMPLEMENT") {
      // T-208: Issue fixes route back to ISSUE_FIX instead of IMPLEMENT
      if (isIssueFix) {
        return { action: "goto", target: "ISSUE_FIX" };
      }
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
    const nextReviewerName = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
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
