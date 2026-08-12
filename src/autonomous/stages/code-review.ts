import { displayIdOf } from "../../core/resolver.js";
import { releaseSessionClaim } from "../../core/claims.js";
import type { ClaimEpoch } from "../claim-reconciliation.js";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { REVIEW_VERDICTS, REVIEW_VERDICTS_PROSE, normalizeSeverity } from "../session-types.js";
import { normalizeRiskLevel, requiredRounds, nextReviewer } from "../review-depth.js";
import { effectiveReviewEffort } from "../review-effort.js";
import { effectiveCodeReviewMaxRounds } from "../session-diagnostics.js";
import { clearCache } from "../lens-harness/cache.js";
import { accumulateVerificationCounters } from "../lens-harness/verification-log.js";
import { writeReviewVerdict, readReviewVerdict, buildTier1Verdict, classifyLensReviewPath, type ReviewVerdictArtifact } from "../review-verdict.js";
import {
  nativeCodexReportInstruction,
  nativeCodexReviewCommand,
  reviewBackendsForClient,
  shouldUseNativeCodexReview,
} from "./codex-native.js";

/**
 * CODE_REVIEW stage -- independent reviewer evaluates the implementation.
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

  /**
   * T-461: `reviewEffort: off` removes this stage from the walk. Pure, for the
   * same reason as PLAN_REVIEW. A review-mode session exists to produce a code
   * review, so it still runs, at light.
   */
  skip(ctx: StageContext): boolean {
    return effectiveReviewEffort(ctx.state, "CODE_REVIEW") === "off";
  }

  async enter(ctx: StageContext): Promise<StageResult> {
    const backends = reviewBackendsForClient(ctx.state.config);
    const codeReviews = ctx.state.reviews.code;
    const roundNum = codeReviews.length + 1;
    const reviewer = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const storedRisk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const rounds = requiredRounds(risk);
    const mergeBase = ctx.state.git.mergeBase;
    const isIssueFix = !!ctx.state.currentIssue;
    const issueHeader = isIssueFix
      ? `Issue Fix Code Review (${displayIdOf(ctx.state.currentIssue!)})`
      : "Code Review";

    const diffCommand = mergeBase
      ? `\`git diff ${mergeBase}\``
      : `\`git diff HEAD\` AND \`git ls-files --others --exclude-standard\``;
    const diffReminder = mergeBase
      ? `Run: git diff ${mergeBase} -- pass FULL output to reviewer.`
      : "Run: git diff HEAD + git ls-files --others --exclude-standard -- pass FULL output to reviewer.";

    if (!ctx.state.currentReviewStartedAt) {
      ctx.writeState({ currentReviewStartedAt: new Date().toISOString() });
    }

    // Lenses backend: multi-lens parallel review
    if (reviewer === "lenses") {
      return {
        instruction: [
          `# Multi-Lens ${issueHeader} -- Round ${roundNum} of ${rounds} minimum`,
          "",
          `Capture the diff with: ${diffCommand}`,
          "",
          "This round uses the **multi-lens review orchestrator** backed by @storybloq/lenses. It fans out to specialized review agents (Security, Error Handling, Clean Code, Concurrency, and more) in parallel, then merges findings programmatically into a single verdict. There is NO merger agent and NO judge agent.",
          "",
          "1. Capture the full diff and changed file list (`git diff --name-only`)",
          `2. Call \`storybloq_review_lenses_prepare\` with the diff, changedFiles, stage: CODE_REVIEW, ticketDescription, reviewRound: ${roundNum}, and sessionId: "${ctx.state.sessionId}"`,
          "3. Spawn all lens subagents in parallel, dispatching each returned prompt as-is (it already embeds the diff; do not append the diff again). Each lens returns a single JSON object ({status, findings, error, notes}). If a prompt comes back empty (promptTruncated), reduce the diff and re-run that lens rather than dispatching a blank prompt. For cached entries, do not spawn an agent; echo cachedFindings back in step 4 with cached: true.",
          `4. Call \`storybloq_review_lenses_synthesize\` with lensResults: [{lens, output}] (output = each lens's raw JSON), plus activeLenses and skippedLenses from prepare, the diff and changedFiles from step 1, the same reviewRound: ${roundNum}, the reviewId returned by prepare, and the sessionId "${ctx.state.sessionId}". It runs the merger pipeline programmatically (anchoring, dedup, blocking policy, coverage caps) and returns the reviewVerdict envelope plus filedIssues for pre-existing findings.`,
          "5. Call `storybloq_review_lenses_judge` with the reviewVerdict from step 4 (plus convergenceHistory on round 2+). It returns the final deterministic verdict: approve, revise, or reject, with recommendFixRound.",
          "6. Report the judge's verdict and the verdict findings, including the reviewId from prepare. Map finding severity \"blocking\" to \"critical\" when reporting.",
        ].join("\n"),
        reminders: [
          diffReminder,
          "Do NOT compress or summarize the diff.",
          "Lens subagents run in parallel with read-only tools (Read, Grep, Glob).",
          "Do NOT spawn a merger or judge agent: synthesize and judge are programmatic.",
          "Pre-existing issues in surrounding code are automatically classified and filed by the synthesize tool when you pass diff, changedFiles, and sessionId. Check filedIssues in the synthesize response.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

    if (shouldUseNativeCodexReview(reviewer, ctx.state.config)) {
      const command = nativeCodexReviewCommand("code", ctx.state.sessionId);
      return {
        instruction: [
          `# Native Codex ${issueHeader} - Round ${roundNum} of ${rounds} minimum`,
          "",
          `Capture baseline context with: ${diffCommand}`,
          "",
          "Run native Codex code review:",
          "```bash",
          command,
          "```",
          "",
          nativeCodexReportInstruction(ctx.state.sessionId),
        ].join("\n"),
        reminders: [
          diffReminder,
          "The helper writes the diff to .story/sessions/<id>/review/diff.patch and runs Codex with read-only sandboxing.",
          "If native Codex fails, fall back to the next configured reviewer if available; otherwise use agent review and include 'codex unavailable' in notes.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

    return {
      instruction: [
        `# ${issueHeader} -- Round ${roundNum} of ${rounds} minimum`,
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
        "If the reviewer flags pre-existing issues unrelated to your changes, file them as issues using storybloq_issue_create with severity and impact. Do not fix them in this ticket.",
        ...(reviewer === "codex" ? ["If codex is unavailable (usage limit, error, etc.), fall back to agent review and include 'codex unavailable' in your report notes."] : []),
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    if (report.completedAction === "skip_ticket") {
      const ticketId = ctx.state.ticket?.id ?? ctx.state.currentIssue?.id ?? "unknown";
      const ticketLabel = ctx.state.ticket?.displayId ?? ctx.state.ticket?.id ?? ctx.state.currentIssue?.displayId ?? ctx.state.currentIssue?.id ?? "unknown";
      const reason = report.notes ?? "Ticket cannot be completed in this session.";

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

      if (ctx.state.currentIssue) {
        try {
          const { handleIssueUpdate } = await import("../../cli/commands/issue.js");
          await handleIssueUpdate(ctx.state.currentIssue.id, { status: "open" }, "json", ctx.root);
        } catch { /* best-effort */ }
      }

      ctx.updateDraft({ ticket: undefined, currentIssue: null, reviews: { plan: [], code: [] } });
      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: [
            `# Ticket Skipped: ${ticketLabel}`,
            "",
            `**Reason:** ${reason}`,
            "",
            "Write a handover documenting why this ticket was skipped and what the next session should know.",
            "",
            'Call `storybloq_autonomous_guide` with completedAction: "handover_written" and include the content in handoverContent.',
          ].join("\n"),
          reminders: [],
          transitionedFrom: "CODE_REVIEW",
        },
      };
    }

    const verdict = report.verdict;
    if (!verdict || !(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
      return { action: "retry", instruction: `Invalid verdict. Re-submit with verdict: ${REVIEW_VERDICTS_PROSE}.` };
    }

    const codeReviews = [...ctx.state.reviews.code];
    const roundNum = codeReviews.length + 1;
    // ISS-726: canonicalize severity up front so the suggestion-exemption and
    // critical/major contradiction guard below (and the per-severity counts and
    // lens history) cannot be bypassed by a miscased value.
    const findings = (report.findings ?? []).map((f) => ({ ...f, severity: normalizeSeverity(f.severity) }));
    const backends = reviewBackendsForClient(ctx.state.config);
    const computedReviewer = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    // ISS-102: Use actual reviewer from report, infer from notes, or fall back to computed
    const reviewerBackend = report.reviewer
      ?? (computedReviewer === "codex" && report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes) ? "agent" : null)
      ?? computedReviewer;
    const unresolvedCriticalCount = findings.filter(
      (f) => f.severity === "critical" &&
        f.disposition !== "addressed" && f.disposition !== "deferred",
    ).length;
    codeReviews.push({
      round: roundNum,
      reviewer: reviewerBackend,
      verdict,
      findingCount: findings.length,
      criticalCount: findings.filter((f) => f.severity === "critical").length,
      unresolvedCriticalCount,
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

    const storedRisk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const minRounds = requiredRounds(risk);
    const maxReviewRounds = effectiveCodeReviewMaxRounds(risk, ctx.recipe.stages);
    // ISS-073: Only count unresolved findings (open/contested) as contradictory with approve
    const hasCriticalOrMajor = findings.some(
      (f) => (f.severity === "critical" || f.severity === "major") &&
        f.disposition !== "addressed" && f.disposition !== "deferred",
    );
    const hasUnresolvedCritical = unresolvedCriticalCount > 0;
    const criticalCount = findings.filter((f) => f.severity === "critical").length;
    const majorCount = findings.filter((f) => f.severity === "major").length;
    const minorCount = findings.filter((f) => f.severity === "minor").length;
    const suggestionCount = findings.filter((f) => f.severity === "suggestion").length;

    // Check for PLAN redirect
    const planRedirect = findings.some((f) => f.recommendedNextState === "PLAN");

    // Guard contradictory approve payloads (ISS-035)
    if (verdict === "approve" && hasCriticalOrMajor) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict." };
    }
    if (verdict === "approve" && planRedirect) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but findings recommend replanning. Re-run the review or correct the verdict." };
    }

    const isChangeRequest = verdict === "revise" || verdict === "request_changes";
    const forcedLanding = maxReviewRounds > 0 && isChangeRequest &&
      !hasUnresolvedCritical && roundNum >= maxReviewRounds && !planRedirect;

    let nextAction: "PLAN" | "IMPLEMENT" | "FINALIZE" | "CODE_REVIEW";
    if (planRedirect && verdict !== "approve") {
      nextAction = "PLAN";
    } else if (verdict === "reject" || (isChangeRequest && hasUnresolvedCritical)) {
      nextAction = "IMPLEMENT";
    } else if (forcedLanding) {
      nextAction = "FINALIZE";
    } else if (isChangeRequest) {
      nextAction = "IMPLEMENT";
    } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
      nextAction = "FINALIZE";
    } else if (roundNum >= 5) {
      nextAction = "FINALIZE";
    } else {
      nextAction = "CODE_REVIEW";
    }

    // T-263: Build and write review verdict artifact
    const target = ctx.state.ticket?.id ?? ctx.state.currentIssue?.id ?? "unknown";
    const startedAt = ctx.state.currentReviewStartedAt;
    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    const summary = report.notes || `Code review ${verdict}: ${findings.length} finding(s) (${criticalCount} critical, ${majorCount} major)`;
    // ISS-720: for lens-backed reviews, record the path actually taken (whether
    // the verification gate ran) instead of trusting the configured backend tag.
    // reviewId/reviewerPath are lens-review observability, so both are recorded
    // only when the backend is lenses.
    const lensReviewId = reviewerBackend === "lenses" ? report.reviewId : undefined;
    const reviewerPath = lensReviewId ? classifyLensReviewPath(ctx.dir, lensReviewId) : undefined;
    const artifact: ReviewVerdictArtifact = {
      target,
      stage: "code",
      round: roundNum,
      reviewer: reviewerBackend,
      verdict,
      findingsCount: findings.length,
      severityCounts: { critical: criticalCount, major: majorCount, minor: minorCount, suggestion: suggestionCount },
      unresolvedCriticalCount,
      startedAt: startedAt ?? new Date().toISOString(),
      durationMs,
      summary,
      findings,
      timestamp: new Date().toISOString(),
      ...(lensReviewId ? { reviewId: lensReviewId } : {}),
      ...(reviewerPath ? { reviewerPath } : {}),
    };
    const writeResult = writeReviewVerdict(ctx.dir, artifact);

    if (writeResult.status === "skipped") {
      return { action: "retry", instruction: "Review artifact write failed (lock contention or I/O error). Re-report your review verdict." };
    }

    let tier1Verdict = buildTier1Verdict(artifact);
    if (writeResult.status === "exists") {
      const recovered = readReviewVerdict(ctx.dir, writeResult.contentHash);
      if (!recovered) {
        return { action: "retry", instruction: "Review artifact recovery failed (content mismatch). Re-report your review verdict." };
      }
      tier1Verdict = buildTier1Verdict(recovered);
    }

    // T-208: Issue-fix context
    const isIssueFix = !!ctx.state.currentIssue;

    // CODE_REVIEW -> PLAN: full reset with verdict artifact
    if (nextAction === "PLAN") {
      clearCache(ctx.dir);
      ctx.writeState({
        reviews: { plan: [], code: [] },
        lensReviewHistory: [],
        ticket: ctx.state.ticket ? { ...ctx.state.ticket, realizedRisk: undefined } : ctx.state.ticket,
        lastReviewVerdict: tier1Verdict,
        currentReviewStartedAt: null,
        landingDecision: null,
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
    const landingDecision = forcedLanding
      ? {
          stage: "CODE_REVIEW",
          round: roundNum,
          maxReviewRounds,
          reason: "max_review_rounds_no_blocking",
          findingCounts: {
            critical: criticalCount,
            major: majorCount,
            minor: minorCount,
            suggestion: suggestionCount,
          },
          timestamp: new Date().toISOString(),
        }
      : null;
    const stateUpdate: Record<string, unknown> = {
      reviews: { ...ctx.state.reviews, code: codeReviews },
      lastReviewVerdict: tier1Verdict,
      currentReviewStartedAt: null,
    };
    if (landingDecision) stateUpdate.landingDecision = landingDecision;
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

    accumulateVerificationCounters({ sessionDir: ctx.dir, state: ctx.state, writeState: ctx.writeState.bind(ctx) });

    ctx.appendEvent("code_review", {
      round: roundNum,
      verdict,
      findingCount: findings.length,
    });

    if (landingDecision) {
      ctx.appendEvent("landing_decision", landingDecision);
    }

    const forcedDeferredFindings = forcedLanding
      ? findings
          .filter((f) =>
            (f.severity === "major" || f.severity === "minor") &&
            f.disposition !== "addressed" &&
            f.disposition !== "deferred"
          )
          .map((f) => ({ ...f, disposition: "deferred" }))
      : [];

    await ctx.fileDeferredFindings([...findings, ...forcedDeferredFindings], "code");

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
        ctx.finalizeSession({
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
              "Session ending -- review mode is complete. You can now proceed to commit.",
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
        `Capture diff with: ${mergeBase ? `\`git diff ${mergeBase}\`` : "`git diff HEAD` + `git ls-files --others --exclude-standard`"}. Pass FULL output -- do NOT compress or summarize.`,
      ].join("\n"),
      reminders: ["Pass FULL diff output to reviewer. Do NOT compress or summarize."],
    };
  }
}
