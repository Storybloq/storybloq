import { releaseSessionClaim } from "../../core/claims.js";
import type { ClaimEpoch } from "../claim-reconciliation.js";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { REVIEW_VERDICTS, REVIEW_VERDICTS_PROSE, normalizeSeverity } from "../session-types.js";
import { normalizeRiskLevel, requiredRounds, nextReviewer } from "../review-depth.js";
import { accumulateVerificationCounters } from "../lens-harness/verification-log.js";
import { writeReviewVerdict, readReviewVerdict, buildTier1Verdict, classifyLensReviewPath, type ReviewVerdictArtifact } from "../review-verdict.js";
import {
  currentStorybloqClient,
  nativeCodexReportInstruction,
  nativeCodexReviewCommand,
  reviewBackendsForClient,
  shouldUseNativeCodexReview,
} from "./codex-native.js";

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
    const backends = reviewBackendsForClient(ctx.state.config);
    const existingReviews = ctx.state.reviews.plan;
    const roundNum = existingReviews.length + 1;
    const reviewer = nextReviewer(existingReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const storedRisk = ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const minRounds = requiredRounds(risk);

    if (!ctx.state.currentReviewStartedAt) {
      ctx.writeState({ currentReviewStartedAt: new Date().toISOString() });
    }

    // Lenses backend: multi-lens parallel plan review
    if (reviewer === "lenses") {
      return {
        instruction: [
          `# Multi-Lens Plan Review — Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
          "",
          "This round uses the **multi-lens review orchestrator** backed by @storybloq/lenses for plan review. It fans out to specialized review agents (Security, Error Handling, Clean Code, Concurrency, and more) in parallel, then merges findings programmatically. There is NO merger agent and NO judge agent.",
          "",
          "1. Read the plan file",
          `2. Call \`storybloq_review_lenses_prepare\` with the plan text as diff, changedFiles: [], stage: PLAN_REVIEW, ticketDescription, and sessionId: "${ctx.state.sessionId}"`,
          "3. Spawn all lens subagents in parallel, dispatching each returned prompt as-is (it already embeds the plan text; do not append it again). Each lens returns a single JSON object ({status, findings, error, notes}). If a prompt comes back empty (promptTruncated), reduce the scope and re-run that lens rather than dispatching a blank prompt.",
          `4. Call \`storybloq_review_lenses_synthesize\` with lensResults: [{lens, output}] (output = each lens's raw JSON), plus activeLenses and skippedLenses from prepare, stage: PLAN_REVIEW, the reviewId returned by prepare, and the sessionId "${ctx.state.sessionId}". It returns the reviewVerdict envelope.`,
          "5. Call `storybloq_review_lenses_judge` with the reviewVerdict from step 4. It returns the final deterministic verdict: approve, revise, or reject, with recommendFixRound.",
          "6. Report the judge's verdict and the verdict findings, including the reviewId from prepare. Map finding severity \"blocking\" to \"critical\" when reporting.",
          "",
          "When done, call `storybloq_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_review_round", "verdict": "<approve|revise|reject>", "reviewId": "<reviewId from prepare>", "findings": [...] } }`,
          '```',
        ].join("\n"),
        reminders: [
          "Report the exact verdict and findings from the judge tool.",
          "Lens subagents run in parallel with read-only tools (Read, Grep, Glob).",
          "Do NOT spawn a merger or judge agent: synthesize and judge are programmatic.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

    if (shouldUseNativeCodexReview(reviewer, ctx.state.config)) {
      const command = nativeCodexReviewCommand("plan", ctx.state.sessionId);
      return {
        instruction: [
          `# Native Codex Plan Review - Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
          "",
          "Run native Codex plan review:",
          "```bash",
          command,
          "```",
          "",
          nativeCodexReportInstruction(ctx.state.sessionId),
        ].join("\n"),
        reminders: [
          "The helper uses `codex exec --output-schema` and read-only sandboxing.",
          "If native Codex fails, fall back to the next configured reviewer if available; otherwise use agent review and include 'codex unavailable' in notes.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }

    const bridgeCodex = currentStorybloqClient() === "claude" && reviewer === "codex";
    return {
      instruction: [
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
      reminders: [
        "Report the exact verdict and findings from the reviewer.",
        "IMPORTANT: After the review, file ANY pre-existing issues discovered using storybloq_issue_create with severity and impact. Do NOT skip this step.",
        ...(reviewer === "codex" ? ["If codex is unavailable (usage limit, error, etc.), fall back to agent review and include 'codex unavailable' in your report notes."] : []),
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    if (report.completedAction === "skip_ticket") {
      const ticketId = ctx.state.ticket?.id ?? "unknown";
      const reason = report.notes ?? "Ticket cannot be completed in this session.";

      // Release ticket claim so next session can pick it
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
          transitionedFrom: "PLAN_REVIEW",
        },
      };
    }

    const verdict = report.verdict;
    if (!verdict || !(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
      return { action: "retry", instruction: `Invalid verdict. Re-submit with verdict: ${REVIEW_VERDICTS_PROSE}.` };
    }

    // Record review round
    const planReviews = [...ctx.state.reviews.plan];
    const roundNum = planReviews.length + 1;
    // ISS-726: canonicalize severity up front so the critical/major
    // contradiction guard and per-severity counts cannot be bypassed by a
    // miscased value.
    const findings = (report.findings ?? []).map((f) => ({ ...f, severity: normalizeSeverity(f.severity) }));
    const backends = reviewBackendsForClient(ctx.state.config);
    const computedReviewer = nextReviewer(planReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    // ISS-102: Use actual reviewer from report, infer from notes, or fall back to computed
    const reviewerBackend = report.reviewer
      ?? (computedReviewer === "codex" && report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes) ? "agent" : null)
      ?? computedReviewer;
    const unresolvedCriticalCount = findings.filter(
      (f) => f.severity === "critical" &&
        f.disposition !== "addressed" && f.disposition !== "deferred",
    ).length;
    planReviews.push({
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

    const storedRisk = ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const minRounds = requiredRounds(risk);
    // ISS-073: Only count unresolved findings (open/contested) as contradictory with approve
    const hasCriticalOrMajor = findings.some(
      (f) => (f.severity === "critical" || f.severity === "major") &&
        f.disposition !== "addressed" && f.disposition !== "deferred",
    );

    // Guard contradictory approve + critical/major (ISS-035)
    if (verdict === "approve" && hasCriticalOrMajor) {
      return { action: "retry", instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict." };
    }

    // T-263: Build and write review verdict artifact
    const target = ctx.state.ticket?.id ?? "unknown";
    const criticalCount = findings.filter((f) => f.severity === "critical").length;
    const majorCount = findings.filter((f) => f.severity === "major").length;
    const minorCount = findings.filter((f) => f.severity === "minor").length;
    const suggestionCount = findings.filter((f) => f.severity === "suggestion").length;
    const startedAt = ctx.state.currentReviewStartedAt;
    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    const summary = report.notes || `Plan review ${verdict}: ${findings.length} finding(s) (${criticalCount} critical, ${majorCount} major)`;
    // ISS-720: for lens-backed reviews, record the path actually taken (whether
    // the verification gate ran) instead of trusting the configured backend tag.
    // reviewId/reviewerPath are lens-review observability, so both are recorded
    // only when the backend is lenses.
    const lensReviewId = reviewerBackend === "lenses" ? report.reviewId : undefined;
    const reviewerPath = lensReviewId ? classifyLensReviewPath(ctx.dir, lensReviewId) : undefined;
    const artifact: ReviewVerdictArtifact = {
      target,
      stage: "plan",
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

    // ISS-035: explicit verdict routing
    const isRevise = verdict === "revise" || verdict === "request_changes";
    const isReject = verdict === "reject";

    let nextAction: "PLAN" | "IMPLEMENT" | "PLAN_REVIEW";
    if (isReject) {
      nextAction = "PLAN";
    } else if (isRevise) {
      // ISS-048: Revise stays in PLAN_REVIEW -- agent already fixed inline, just re-review
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
      lastReviewVerdict: tier1Verdict,
      currentReviewStartedAt: null,
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

    accumulateVerificationCounters({ sessionDir: ctx.dir, state: ctx.state, writeState: ctx.writeState.bind(ctx) });

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
        ctx.finalizeSession({
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
