import { displayIdOf } from "../../core/resolver.js";
import { releaseSessionClaim } from "../../core/claims.js";
import { clearSameSessionEarmark } from "../../core/earmarks.js";
import type { ClaimEpoch } from "../claim-reconciliation.js";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { REVIEW_VERDICTS, REVIEW_VERDICTS_PROSE, normalizeSeverity } from "../session-types.js";
import { normalizeRiskLevel, requiredRounds, nextReviewer } from "../review-depth.js";
import { effectiveReviewEffort, effortDisclosureLine, effortMinRounds } from "../review-effort.js";
import { codeReviewLandingFloor, dialCodeReviewMaxRounds } from "../session-diagnostics.js";
import { clearCache } from "../lens-harness/cache.js";
import { accumulateVerificationCounters } from "../lens-harness/verification-log.js";
import { writeReviewVerdict, readReviewVerdict, buildTier1Verdict, classifyLensReviewPath, type ReviewVerdictArtifact } from "../review-verdict.js";
import {
  currentStorybloqClient,
  nativeCodexReportInstruction,
  nativeCodexReviewCommand,
  reviewBackendsForStage,
  reviewDepthLine,
  shouldUseNativeCodexReview,
} from "./codex-native.js";
import { decideCeiling, outstandingCeilingFindings } from "./code-review-ceiling.js";
import { parkCurrentTicket } from "./park.js";
import type { FullSessionState } from "../session-types.js";

/**
 * Finish a ceiling escalation: file the outstanding findings, then park.
 *
 * Resumable, and it has to be. Persisting the round and filing the issues is
 * not atomic, so a failure part way through leaves the session in CODE_REVIEW
 * with `pendingCeilingEscalation` set. `resumeCeilingEscalation` re-enters
 * HERE on the next guide call rather than letting the same report be processed
 * as another completed round -- which would increment the counter again, write
 * another artifact and event, and retry the handover from a different round.
 *
 * Findings are filed through the SAME durable queue as deferrals
 * (`pendingDeferrals` -> `drainDeferrals`), which carries the fingerprint
 * dedup, the critical/high/medium severity map, and -- since T-470 -- a durable
 * dedupe key on issue creation, so a stop between creating an issue and
 * recording it cannot file the same finding twice.
 * What it does NOT do is go through `fileDeferredFindings`,
 * which filters on `disposition === "deferred"`: reaching that filter would
 * mean rewriting a critical's disposition to get past it, and laundering a
 * blocker into a deferral is exactly what this path must not do. The queue is
 * shared; the disposition is untouched.
 */
async function escalateCeiling(ctx: StageContext): Promise<StageAdvance> {
  const pending = ctx.state.pendingCeilingEscalation;
  const label = ctx.state.ticket?.displayId ?? ctx.state.ticket?.id ?? "the current item";

  // Read from the RECORD, not from the incoming report. The record was written
  // atomically with the decision, so first call and resume take the identical
  // path -- and a resume, which arrives with no findings of its own, still
  // files exactly what stopped the item rather than parking it having filed
  // nothing.
  const outstanding = pending?.findings ?? [];

  // Re-queued on a resume, idempotently: `queueFindingsAsIssues` skips anything
  // already queued or filed, so this costs nothing on the normal path and
  // rebuilds the queue if the write that created it was the one that was lost.
  const fingerprints = await ctx.queueFindingsAsIssues(outstanding, "code");
  if (pending && fingerprints.length > 0) {
    // WRITTEN, not staged. A draft is discarded when this returns `retry`,
    // and the whole point of recording these is that a failure part way
    // through leaves a record knowing which findings are this escalation's.
    const merged = Array.from(new Set([...(pending.fingerprints ?? []), ...fingerprints]));
    if (merged.length !== (pending.fingerprints ?? []).length) {
      ctx.writeState({
        pendingCeilingEscalation: { ...pending, fingerprints: merged },
      } as Partial<FullSessionState>);
    }
  }

  await ctx.drainDeferrals();

  // Gated on THIS escalation's findings, not on the whole queue.
  //
  // `drainDeferrals` reports success only when every pending entry filed, and
  // that queue is session-wide. One unrelated older deferral whose creation
  // keeps failing would otherwise hold the session in CODE_REVIEW forever --
  // re-reviewing nothing, having already filed every finding this ceiling
  // exists to file. Unrelated entries stay queued for the ordinary retry path.
  const filed = new Set((ctx.state.filedDeferrals ?? []).map((d) => d.fingerprint));
  const mine = ctx.state.pendingCeilingEscalation?.fingerprints ?? pending?.fingerprints ?? [];
  const drained = mine.every((fp) => filed.has(fp));
  if (!drained) {
    // Deliberately NOT a transition. The escalation record survives, so the
    // next call resumes here instead of reprocessing the round.
    return {
      action: "retry",
      instruction: [
        `# Filing the outstanding findings for ${label} did not complete`,
        "",
        "The round ceiling was reached and the session is ending, but some findings could not be written as issues yet.",
        "",
        "Re-report the same review. The round will NOT be counted again -- the escalation is already recorded and this only finishes the filing.",
      ].join("\n"),
    };
  }

  const round = pending?.round ?? 0;
  const ceiling = pending?.ceiling ?? 0;
  const reason = pending?.reason
    ?? `Code review reached its hard ceiling of ${ceiling} rounds without reaching a landable verdict.`;

  const advance = await parkCurrentTicket(
    ctx,
    { notes: reason } as GuideReportInput,
    "CODE_REVIEW",
    { reason, target: "HANDOVER" },
  );

  // Marked completed only once the filing AND the transition are both settled.
  // A park that returned `retry` (the write-failed branch) leaves the record
  // unfinished so the next call resumes rather than restarting.
  if (advance.action === "goto") {
    // Re-read rather than reusing `pending`: the fingerprints were written to
    // the draft above, and the captured copy predates them.
    const current = ctx.state.pendingCeilingEscalation ?? pending;
    // Marked done rather than deleted: the record is what the session report
    // renders, and a session that ended this way must say so.
    ctx.updateDraft({
      pendingCeilingEscalation: current ? { ...current, completed: true } : null,
    } as Partial<FullSessionState>);
    ctx.appendEvent("code_review_ceiling", {
      ticketId: pending?.ticketId ?? ctx.state.ticket?.id,
      round,
      ceiling,
      maxReviewRounds: pending?.maxReviewRounds,
      unresolvedCritical: pending?.unresolvedCritical,
      filedFindings: outstanding.length,
    });
  }
  return advance;
}

/**
 * Resume an escalation left unfinished by an earlier call.
 *
 * Returns null when there is nothing to resume, so the normal round path runs.
 * Called at the TOP of `report`, before anything reads the incoming payload as
 * a new round.
 */
export async function resumeCeilingEscalation(ctx: StageContext): Promise<StageAdvance | null> {
  const pending = ctx.state.pendingCeilingEscalation;
  if (!pending || pending.completed) return null;
  // EXACT match, and an absent ticket is a non-match rather than a pass.
  //
  // An escalation is ticket-only. Guarding on "both ids exist AND differ" let
  // the record through whenever the session held an ISSUE or held nothing:
  // filing could then complete, but `parkCurrentTicket` returns `retry` with no
  // ticket to park, so every later CODE_REVIEW report resumed the same
  // escalation and the current item could never progress.
  //
  // The record is KEPT rather than deleted. Its findings were durably queued
  // into `pendingDeferrals` BEFORE the escalation record was created -- that is
  // what the ordering below buys -- so the ordinary drain can still file them.
  // Deleting would discard the one explanation of why that earlier item
  // stopped, which is what the session report renders. Failing closed would
  // deadlock the current item over a record belonging to an item that is no
  // longer here.
  if (ctx.state.ticket?.id !== pending.ticketId) return null;
  return await escalateCeiling(ctx);
}

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
    const backends = reviewBackendsForStage("CODE_REVIEW", ctx.state);
    const codeReviews = ctx.state.reviews.code;
    const roundNum = codeReviews.length + 1;
    const reviewer = nextReviewer(codeReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const storedRisk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const effort = effectiveReviewEffort(ctx.state, "CODE_REVIEW");
    const rounds = effortMinRounds(effort, risk);
    const disclosure = effortDisclosureLine(ctx.state, "CODE_REVIEW");
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
          `# Multi-Lens ${issueHeader} -- Round ${roundNum} of ${Math.max(rounds, roundNum)} minimum`,
          "",
          disclosure,
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
          `# Native Codex ${issueHeader} - Round ${roundNum} of ${Math.max(rounds, roundNum)} minimum`,
          "",
          disclosure,
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

    // T-461: mirrors plan-review.ts:103. PLAN_REVIEW has named its MCP tool
    // since the bridge shipped; CODE_REVIEW never did, so a Claude-client
    // session told to review with "codex" was left to guess which tool to call.
    const bridgeCodex = currentStorybloqClient() === "claude" && reviewer === "codex";
    return {
      instruction: [
        `# ${issueHeader} -- Round ${roundNum} of ${Math.max(rounds, roundNum)} minimum`,
        "",
        disclosure,
        "",
        `Capture the diff with: ${diffCommand}`,
        "",
        "**IMPORTANT:** Pass the FULL unified diff to the reviewer. For diffs over ~500 lines, use file-scoped chunks (`git diff <mergebase> -- <filepath>`) across separate calls (pass the same session_id). Do NOT summarize or truncate any individual chunk.",
        "",
        `Run a code review using **${reviewer}**.`,
        "",
        [
          bridgeCodex
            ? "Call `review_code` MCP tool with the diff."
            : "Launch a code review agent to review the diff.",
          reviewDepthLine(effort, "code", reviewer, ctx.state.config),
        ].filter(Boolean).join(" "),
        "",
        // Until now this branch ended at "When done, report verdict and
        // findings", the only instruction in either stage with no report
        // envelope: it named no session, no completedAction, and no verdict
        // vocabulary. The vocabularies deliberately differ between the two
        // stages -- code review has request_changes, plan review does not
        // (guide.ts REVIEW_VERDICTS) -- so this is not a copy of plan-review's.
        "When done, call `storybloq_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "code_review_round", "verdict": "<approve|revise|request_changes|reject>", "findings": [...] } }`,
        '```',
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
    // T-470: FIRST, before anything reads this payload as a new round. An
    // escalation left unfinished by an earlier call is resumed rather than
    // restarted -- otherwise resubmitting the same review would be counted as
    // another completed round, with another artifact, another event, and the
    // handover retried from a different number.
    const resumed = await resumeCeilingEscalation(ctx);
    if (resumed) return resumed;

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
              // Section 5: same-session earmark release, in the same locked
              // write. Independent of `released` -- the choke point can have
              // converted an earmark at pick time before any claim landed.
              const { cleared, item: nextWithEarmark } = clearSameSessionEarmark(next, ctx.state.sessionId);
              if (released || cleared) await writeTicketUnlocked(nextWithEarmark, ctx.root);
            }
          });
        } catch { /* best-effort */ }
      }

      if (ctx.state.currentIssue) {
        const issueId = ctx.state.currentIssue.id;
        try {
          // Section 5, issue half: issues carry no claimedBySession (AM-b),
          // so there is no claim to release here -- but a same-session
          // assigned earmark from the ISSUE_SWEEP/ISSUE_FIX choke point can
          // still be sitting on it. The status reset and the earmark clear
          // must land in the SAME write, or a failure between two separate
          // locked transactions can leave status and earmark inconsistent
          // (issue reopened with the earmark still assigned, or vice versa).
          const { handleIssueUpdate } = await import("../../cli/commands/issue.js");
          await handleIssueUpdate(issueId, { status: "open" }, "json", ctx.root, {
            clearEarmarkForSession: ctx.state.sessionId,
          });
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
    // T-461: see plan-review.ts -- the level belongs to the round, not to
    // whatever the session happens to be pinned to when someone reads it back.
    const roundEffort = effectiveReviewEffort(ctx.state, "CODE_REVIEW");
    // ISS-726: canonicalize severity up front so the suggestion-exemption and
    // critical/major contradiction guard below (and the per-severity counts and
    // lens history) cannot be bypassed by a miscased value.
    const findings = (report.findings ?? []).map((f) => ({ ...f, severity: normalizeSeverity(f.severity) }));
    const backends = reviewBackendsForStage("CODE_REVIEW", ctx.state);
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
      effort: roundEffort,
      timestamp: new Date().toISOString(),
    });

    // ISS-098: Detect codex unavailability from agent notes
    // ISS-110: Store timestamp instead of just boolean for TTL-based expiry
    if (report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes)) {
      ctx.writeState({ codexUnavailable: true, codexUnavailableSince: new Date().toISOString() });
    }

    const storedRisk = ctx.state.ticket?.realizedRisk ?? ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const minRounds = effortMinRounds(effectiveReviewEffort(ctx.state, "CODE_REVIEW"), risk);
    const maxReviewRounds = dialCodeReviewMaxRounds(ctx.state, ctx.recipe.stages, risk);
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
    // T-461: the light landing guard. At standard and thorough the floor IS the
    // cap, so this line is byte-identical to what it replaced; at light the cap
    // routes to IMPLEMENT and the grace round that follows is where landing may
    // happen. See codeReviewLandingFloor for why, and for why an explicit
    // project cap is exempt.
    const landingFloor = codeReviewLandingFloor(ctx.state, ctx.recipe.stages, risk);
    const forcedLanding = landingFloor > 0 && isChangeRequest &&
      !hasUnresolvedCritical && roundNum >= landingFloor && !planRedirect;

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
      effort: roundEffort,
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

    // T-470: the hard ceiling. Decided HERE, before the plan-redirect branch,
    // because that branch is an early return with its own writeState and would
    // otherwise leave with `reviews.code` cleared and the ceiling unevaluated.
    const ceilingDecision = decideCeiling({
      state: ctx.state,
      stages: ctx.recipe.stages,
      risk,
      nextAction,
      isIssueFix,
    });

    // CODE_REVIEW -> PLAN: full reset with verdict artifact.
    //
    // Gated on the ceiling, so a ceiling-triggering redirect falls through to
    // the normal round-persistence path below instead of leaving from here.
    // Two things depend on that. The round has to be PERSISTED like any other
    // -- counter, artifact, event and the escalation record written in one
    // update -- and this branch returns before all of it. And this branch
    // discards `lensReviewHistory` and `realizedRisk`, which is right for a
    // replan and wrong for a session that is about to end: the park clears the
    // review arrays itself (the item is being released), but the lens history
    // is what the handover has left to say WHY sixty rounds went nowhere.
    if (nextAction === "PLAN" && !ceilingDecision.shouldPark) {
      clearCache(ctx.dir);
      ctx.writeState({
        // The counter advances HERE too. It is the only durable record of a
        // completed round, and this branch clears the array `roundNum` is
        // derived from -- so without this line a reviewer that keeps
        // recommending PLAN would loop forever at a count that never moved,
        // which is the same unbounded shape the ceiling exists to close.
        ...(ceilingDecision.counter ? { codeReviewRoundCounter: ceilingDecision.counter } : {}),
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
        effort: roundEffort,
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
    // T-470: the ticket-keyed counter, persisted with the round it counts.
    if (ceilingDecision.counter) stateUpdate.codeReviewRoundCounter = ceilingDecision.counter;
    if (landingDecision) stateUpdate.landingDecision = landingDecision;
    if (ceilingDecision.shouldPark) {
      // Written in the SAME update as the round, so a failure between the two
      // cannot leave a round recorded with no decision attached -- which is
      // what would let the next report be processed as another round.
      // QUEUED FIRST, before the decision is written.
      //
      // The two writes are not atomic either way, so the question is only which
      // order fails safe. Decision-then-queue could leave a record whose
      // findings were never queued: if the ticket then changed, the resume
      // guard above correctly declines it, and a later ceiling would overwrite
      // the singleton record -- taking the only remaining copy of those
      // findings with it. Queue-then-decision fails the other way: the findings
      // are durable and the ordinary drain files them, and the lost decision
      // just means the next report is an ordinary round.
      const outstanding = outstandingCeilingFindings(findings);

      // The DEFERRED findings of this same round, queued here rather than
      // being left to the ordinary call further down.
      //
      // That call sits AFTER the decision write, and a resume enters
      // `escalateCeiling` at the top of `report` and parks without processing
      // the report at all -- so a stop in that window used to drop this round's
      // deferred findings entirely. They were safe only while the allow-list
      // was a deny-list and the escalation happened to carry them; making the
      // filter correct is what opened the window, so it is closed here. The
      // call below stays and no-ops on these: both paths skip anything already
      // queued or filed, and they compute the same fingerprint.
      await ctx.fileDeferredFindings(findings, "code");

      const escalationFingerprints = await ctx.queueFindingsAsIssues(outstanding, "code");

      stateUpdate.pendingCeilingEscalation = {
        ticketId: ctx.state.ticket?.id ?? "",
        // Captured NOW, while the ticket is still on the state. The park clears
        // it before the transition, so the report has nowhere else to read it.
        ...(ctx.state.ticket?.displayId ? { displayId: ctx.state.ticket.displayId } : {}),
        // The DURABLE count, not `roundNum`. `roundNum` is
        // `reviews.code.length + 1`, and that array is cleared by the
        // plan-redirect branch and by recovery -- so a ceiling reached on the
        // fifteenth round could be reported as "round 1 of a ceiling of 7",
        // which reads as a bug in the ceiling rather than as what stopped the
        // session.
        round: ceilingDecision.counter?.completedRounds ?? roundNum,
        ceiling: ceilingDecision.ceiling,
        maxReviewRounds,
        // Covers BOTH triggers. The ceiling fires on any round that would
        // continue rather than finalize, and a `reject` verdict continues with
        // zero blocking findings -- so "with blocking findings still
        // outstanding" would be written onto the ticket's park record, and read
        // back out of the ledger later, as a fact that was not true.
        reason: `Code review reached its hard ceiling of ${ceilingDecision.ceiling} rounds without reaching a landable verdict.`,
        unresolvedCritical: unresolvedCriticalCount,
        // The SAME rule as the criticals beside it, not the raw `majorCount`.
        // That count includes majors already addressed and majors explicitly
        // deferred, so a report headed "still outstanding" was naming findings
        // that were fixed or consciously set aside -- which is the opposite of
        // what a reader arriving at a stopped session needs from that number.
        unresolvedMajor: findings.filter(
          (f) => f.severity === "major" &&
            f.disposition !== "addressed" && f.disposition !== "deferred",
        ).length,
        decidedAt: new Date().toISOString(),
        // Written WITH the decision. The resumed call arrives with no findings
        // of its own, so without these it would park the item having filed none
        // of the blockers that stopped it.
        findings: outstanding,
        fingerprints: escalationFingerprints,
      };
      // A terminal report must never show a forced-landing decision AND a
      // ceiling escalation: they say opposite things about why the item
      // stopped. The common path does not otherwise clear this.
      stateUpdate.landingDecision = null;
    }
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
      effort: roundEffort,
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

    // T-470: the ceiling fires from the SAME site as every other transition,
    // after the round has been persisted exactly like any other round.
    if (ceilingDecision.shouldPark) {
      return await escalateCeiling(ctx);
    }

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
        // processAdvance returns a retry instruction verbatim without calling
        // enter(), so without these the level would be disclosed, and the depth
        // asked for, on the first round of the stage and on no round after it.
        [
          effortDisclosureLine(ctx.state, "CODE_REVIEW"),
          reviewDepthLine(
            effectiveReviewEffort(ctx.state, "CODE_REVIEW"),
            "code",
            nextReviewerName,
            ctx.state.config,
          ),
        ].filter(Boolean).join(" "),
        "",
        `Capture diff with: ${mergeBase ? `\`git diff ${mergeBase}\`` : "`git diff HEAD` + `git ls-files --others --exclude-standard`"}. Pass FULL output -- do NOT compress or summarize.`,
      ].join("\n"),
      reminders: ["Pass FULL diff output to reviewer. Do NOT compress or summarize."],
    };
  }
}
