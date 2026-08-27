import { readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseSessionClaim } from "../../core/claims.js";
import type { ClaimEpoch } from "../claim-reconciliation.js";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
import type { GuideReportInput, FullSessionState } from "../session-types.js";
import { PARK_ACTION, parkCurrentTicket, parkHintLines } from "./park.js";
import { REVIEW_VERDICTS, REVIEW_VERDICTS_PROSE, normalizeSeverity } from "../session-types.js";
import { normalizeRiskLevel, requiredRounds, nextReviewer } from "../review-depth.js";
import { effectiveReviewEffort, effortDisclosureLine, effortMinRounds } from "../review-effort.js";
import { accumulateVerificationCounters } from "../lens-harness/verification-log.js";
import { writeReviewVerdict, readReviewVerdict, buildTier1Verdict, classifyLensReviewPath, type ReviewVerdictArtifact } from "../review-verdict.js";
import { decidePlanCeiling } from "./plan-review-ceiling.js";
import { outstandingCeilingFindings } from "./code-review-ceiling.js";
import {
  buildRound1Baseline,
  hashPlanContent,
  foldIntroducedFraction,
  driftTriggered,
  firstDriftTriggerRound,
  DRIFT_FRACTION_THRESHOLD,
  DRIFT_CONSECUTIVE_ROUNDS,
  type DriftFinding,
  type DriftRoundEntry,
} from "./plan-review-drift.js";
import {
  currentStorybloqClient,
  nativeCodexReportInstruction,
  nativeCodexReviewCommand,
  reviewBackendsForStage,
  reviewDepthLine,
  shouldUseNativeCodexReview,
} from "./codex-native.js";

/** Read a file, return empty string on error. Mirrors plan.ts's own helper. */
function readFileSafe(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

/**
 * Finish a plan-review ceiling park: file the outstanding findings, then park.
 *
 * ISS-598/ISS-1031, mirroring `code-review.ts`'s `escalateCeiling` /
 * `resumeCeilingEscalation` byte-for-byte. Resumable, and it has to be:
 * persisting the round and filing its findings is not atomic, so a failure
 * part way through leaves the session in PLAN_REVIEW with
 * `pendingPlanCeilingEscalation` set. `resumePlanCeilingEscalation` re-enters
 * HERE on the next guide call rather than letting the same report be
 * processed as another completed round.
 *
 * Unlike CODE_REVIEW's ceiling, this always parks to PICK_TICKET, never
 * HANDOVER (ISS-1031's distinct point): nothing is implemented yet at
 * PLAN_REVIEW, so the working tree is clean and the session can advance to
 * the next item instead of ending.
 */
async function escalatePlanCeiling(ctx: StageContext): Promise<StageAdvance> {
  const pending = ctx.state.pendingPlanCeilingEscalation;
  const label = ctx.state.ticket?.displayId ?? ctx.state.ticket?.id ?? "the current item";

  const outstanding = pending?.findings ?? [];

  const fingerprints = await ctx.queueFindingsAsIssues(outstanding, "plan");
  if (pending && fingerprints.length > 0) {
    const merged = Array.from(new Set([...(pending.fingerprints ?? []), ...fingerprints]));
    if (merged.length !== (pending.fingerprints ?? []).length) {
      ctx.writeState({
        pendingPlanCeilingEscalation: { ...pending, fingerprints: merged },
      } as Partial<FullSessionState>);
    }
  }

  await ctx.drainDeferrals();

  const filed = new Set((ctx.state.filedDeferrals ?? []).map((d) => d.fingerprint));
  const mine = ctx.state.pendingPlanCeilingEscalation?.fingerprints ?? pending?.fingerprints ?? [];
  const drained = mine.every((fp) => filed.has(fp));
  if (!drained) {
    return {
      action: "retry",
      instruction: [
        `# Filing the outstanding findings for ${label} did not complete`,
        "",
        "The plan-review ceiling was reached and this item is being parked, but some findings could not be written as issues yet.",
        "",
        "Re-report the same review. The round will NOT be counted again -- the escalation is already recorded and this only finishes the filing.",
      ].join("\n"),
    };
  }

  const round = pending?.round ?? 0;
  const ceiling = pending?.ceiling ?? 0;
  const reason = pending?.reason
    ?? `Plan review reached its hard ceiling of ${ceiling} rounds without an approvable plan.`;

  const advance = await parkCurrentTicket(
    ctx,
    { notes: reason } as GuideReportInput,
    "PLAN_REVIEW",
    { reason, target: "PICK_TICKET" },
  );

  // Marked completed only once the filing AND the transition are both
  // settled, via ctx.updateDraft (a staged draft mutation committed by
  // processAdvance together with the transition itself) rather than
  // ctx.writeState, which would commit prematurely before the transition.
  if (advance.action === "goto") {
    const current = ctx.state.pendingPlanCeilingEscalation ?? pending;
    ctx.updateDraft({
      pendingPlanCeilingEscalation: current ? { ...current, completed: true } : null,
    } as Partial<FullSessionState>);
    ctx.appendEvent("plan_review_ceiling", {
      ticketId: pending?.ticketId ?? ctx.state.ticket?.id,
      round,
      ceiling,
      trigger: pending?.trigger,
      unresolvedCritical: pending?.unresolvedCritical,
      driftWouldHaveFiredAtRound: pending?.driftWouldHaveFiredAtRound,
      filedFindings: outstanding.length,
    });
  }
  return advance;
}

/**
 * Resume an escalation left unfinished by an earlier call.
 *
 * Returns null when there is nothing to resume, so the normal round path
 * runs. Called at the TOP of `report`, before anything reads the incoming
 * payload as a new round.
 */
async function resumePlanCeilingEscalation(ctx: StageContext): Promise<StageAdvance | null> {
  const pending = ctx.state.pendingPlanCeilingEscalation;
  if (!pending || pending.completed) return null;
  if (ctx.state.ticket?.id !== pending.ticketId) return null;
  return await escalatePlanCeiling(ctx);
}

/**
 * PLAN_REVIEW stage -- independent reviewer evaluates the plan.
 *
 * enter(): Instruction to run plan review with specified backend.
 * report(): Process verdict -> advance (IMPLEMENT), retry (next round),
 *           or back (PLAN for revise/reject).
 *
 * ISS-598/ISS-1031, Gate-1 ratified: the landing check runs BEFORE
 * `isRevise`, so a "revise" verdict lands at IMPLEMENT once findings are
 * clean of unresolved critical/major AND `roundNum >= minRounds` -- there IS
 * a findings-tolerant landing path, just no MAJORS-tolerant one (unlike
 * CODE_REVIEW's `forcedLanding`, unresolved critical/major still never
 * lands, at any round count). Before this fix, `isRevise` claimed every
 * non-approve, non-reject verdict unconditionally ahead of that check, which
 * made the landing ternary's `roundNum >= 5` branch permanently DEAD CODE --
 * unreachable, because `isRevise` already consumed the verdict before it
 * could run -- so a genuinely converging review (clean findings, past
 * minRounds, but reviewed as "revise" rather than "approve") could never
 * land and a non-converging loop had no real ceiling either. Both halves of
 * that are fixed here: the reordering restores the clean-landing path, and a
 * separate, unconditionally-computed mechanism (plan-review-ceiling.ts)
 * bounds whatever continues past it -- it can only ever convert a would-be
 * CONTINUATION into a PARK, never alter a genuine landing. The clean-landing
 * path is what makes a FIXED ceiling tolerable at all: without it, a slow
 * but healthy review parks its findings at the ceiling instead of shipping.
 */
export class PlanReviewStage implements WorkflowStage {
  readonly id = "PLAN_REVIEW";

  /**
   * T-461: `reviewEffort: off` removes this stage from the walk. Pure, because
   * findNextStage may call it more than once per transition; the disclosure was
   * written at PICK_TICKET. A plan-mode session exists to produce a reviewed
   * plan, so it still runs, at light.
   */
  skip(ctx: StageContext): boolean {
    return effectiveReviewEffort(ctx.state, "PLAN_REVIEW") === "off";
  }

  async enter(ctx: StageContext): Promise<StageResult> {
    const backends = reviewBackendsForStage("PLAN_REVIEW", ctx.state);
    const existingReviews = ctx.state.reviews.plan;
    const roundNum = existingReviews.length + 1;
    const reviewer = nextReviewer(existingReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    const storedRisk = ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const effort = effectiveReviewEffort(ctx.state, "PLAN_REVIEW");
    const minRounds = effortMinRounds(effort, risk);
    const disclosure = effortDisclosureLine(ctx.state, "PLAN_REVIEW");

    if (!ctx.state.currentReviewStartedAt) {
      ctx.writeState({ currentReviewStartedAt: new Date().toISOString() });
    }

    // ISS-598: capture the round-1 plan-text vocabulary once per PLAN
    // generation, for the advisory scope-drift signal computed in report().
    // Gated on `existingReviews.length === 0` -- a ticket can legitimately
    // re-enter PLAN_REVIEW's round 1 more than once (CODE_REVIEW can redirect
    // a finding back to PLAN, which clears `reviews.plan` and rewrites
    // plan.md). A ticket already mid-PLAN_REVIEW when this ships
    // (existingReviews.length > 0) never gets a baseline -- drift telemetry
    // simply never appears for it; the round ceiling still bounds it.
    //
    // `ticketId` equality ALONE cannot tell "this round-1 entry resumed after
    // compaction, same plan.md" (must not touch the baseline) apart from "a
    // genuine re-plan for the same ticket" (must recapture) -- both leave
    // `reviews.plan` empty (codex round 2, state lifecycle). `planHash`, a
    // digest of the full plan.md text, is the actual generation identity:
    // unchanged content is the same generation and is skipped entirely, so a
    // resumed session re-entering round 1 cannot overwrite the baseline a
    // report() call already measured findings against.
    const ticket = ctx.state.ticket;
    if (existingReviews.length === 0 && ticket) {
      // Reads the whole file before buildRound1Baseline truncates it (codex
      // round 1, MINOR/perf). Deliberately not bounded to a byte prefix:
      // plan.md is self-authored KB-scale text, and a partial-byte read risks
      // splitting a multi-byte UTF-8 sequence mid-character -- a real
      // correctness cost for a gain against an input shape that doesn't occur.
      const planText = readFileSafe(join(ctx.dir, "plan.md"));
      const planHash = hashPlanContent(planText);
      const existingBaseline = ctx.state.planReviewBaseline;
      const sameGeneration = existingBaseline?.ticketId === ticket.id && existingBaseline?.planHash === planHash;
      if (!sameGeneration) {
        if (planText.trim().length > 0) {
          const { tokens, truncated } = buildRound1Baseline(planText);
          // A plan with no extractable identifier-shaped vocabulary is not
          // evidence of anything -- storing it as an empty-but-active baseline
          // would classify every later signal-bearing finding as "introduced"
          // with no real basis, manufacturing a maximum-strength drift hint
          // from two ordinary review rounds. The drift gate below already
          // treats a missing baseline as "disabled for this ticket", so a
          // NEW generation with no vocabulary explicitly clears any baseline
          // left over from a PRIOR generation (codex round 2: an unreadable
          // or zero-vocabulary re-plan must not leave a stale baseline from
          // before the re-plan active for this new one).
          if (tokens.length > 0) {
            ctx.writeState({ planReviewBaseline: { ticketId: ticket.id, planHash, tokens: [...tokens], truncated } });
          } else if (existingBaseline) {
            ctx.writeState({ planReviewBaseline: null });
          }
        } else if (existingBaseline) {
          ctx.writeState({ planReviewBaseline: null });
        }
      }
    }

    // Lenses backend: multi-lens parallel plan review
    if (reviewer === "lenses") {
      return {
        instruction: [
          `# Multi-Lens Plan Review -- Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
          "",
          disclosure,
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
          disclosure,
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
        `# Plan Review -- Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
        "",
        disclosure,
        "",
        `Run a plan review using **${reviewer}**.`,
        "",
        [
          bridgeCodex
            ? "Call `review_plan` MCP tool with the plan content."
            : "Launch a code review agent to review the plan.",
          reviewDepthLine(effort, "plan", reviewer, ctx.state.config),
        ].filter(Boolean).join(" "),
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
    // ISS-598/ISS-1031: FIRST, before anything reads this payload as a new
    // round. An escalation left unfinished by an earlier call is resumed
    // rather than restarted -- mirrors code-review.ts's placement exactly.
    const resumed = await resumePlanCeilingEscalation(ctx);
    if (resumed) return resumed;

    // ISS-904: the plan gate's escape when the FILING, not the plan, is the
    // defect. Unlike skip_ticket below it advances the queue instead of ending
    // the session, so a repeatedly-rejected item never needs a faked approve.
    if (report.completedAction === PARK_ACTION) {
      return parkCurrentTicket(ctx, report, "PLAN_REVIEW");
    }

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
    const backends = reviewBackendsForStage("PLAN_REVIEW", ctx.state);
    // T-461: recorded per ROUND, not read back from the session, because the
    // top-level pin is overwritten by the next pick and a ticket that ran at
    // light would afterwards read as whatever the next one ran at.
    const roundEffort = effectiveReviewEffort(ctx.state, "PLAN_REVIEW");
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
      effort: roundEffort,
      timestamp: new Date().toISOString(),
    });

    // ISS-098: Detect codex unavailability from agent notes
    // ISS-110: Store timestamp instead of just boolean for TTL-based expiry
    if (report.notes && /codex\b.*\b(unavail|limit|failed|down|error|usage)/i.test(report.notes)) {
      ctx.writeState({ codexUnavailable: true, codexUnavailableSince: new Date().toISOString() });
    }

    const storedRisk = ctx.state.ticket?.risk;
    const risk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const minRounds = effortMinRounds(effectiveReviewEffort(ctx.state, "PLAN_REVIEW"), risk);
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

    // ISS-598/ISS-1031, Gate-1 ratified ordering: the landing check runs
    // BEFORE isRevise, restoring the clean-landing path ISS-048's ordering
    // had made permanently dead code. Under the OLD ordering, `isRevise`
    // claimed every non-approve, non-reject verdict first, so a revise with
    // zero unresolved critical/major findings at or past `minRounds` could
    // never land -- the `roundNum >= 5` branch that used to sit inside the
    // landing check literally could not run. That is the SAME defect shape
    // this ticket exists to remove elsewhere (an unconditional path that
    // starves a real mechanism), so shipping it here too was wrong: this
    // ordering is what makes the fixed 8-round ceiling tolerable at all,
    // since a genuinely converging review (ISS-155-shaped: slow, but clean
    // and past minRounds) now lands instead of parking a healthy result.
    //
    // Unresolved critical/major still never lands, at any round count --
    // there is no majors-tolerant tier, only a findings-clean one.
    const isReject = verdict === "reject";
    const isRevise = verdict === "revise" || verdict === "request_changes";

    let nextAction: "PLAN" | "IMPLEMENT" | "PLAN_REVIEW";
    if (isReject) {
      nextAction = "PLAN";
    } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
      nextAction = "IMPLEMENT";
    } else if (isRevise) {
      nextAction = "PLAN_REVIEW";
    } else {
      // Unreachable given the 3 verdict values; kept for type totality.
      nextAction = "PLAN_REVIEW";
    }

    // ISS-598/ISS-1031: the ceiling is decided HERE, unconditionally, before
    // any early return -- mirrors code-review.ts's decideCeiling placement.
    // `nextAction !== "IMPLEMENT"` lets it fire on BOTH an ordinary
    // PLAN_REVIEW continuation AND a reject-routed PLAN continuation, closing
    // the ISS-904 blind spot where a reject/replan loop was invisible to any
    // `reviews.plan`-derived counter (that array is cleared on every reject).
    const ticketId = ctx.state.ticket?.id;
    const ceilingDecision = decidePlanCeiling({
      ticketId,
      priorCounter: ctx.state.planReviewRoundCounter,
      nextAction,
    });

    // ISS-598: advisory scope-drift signal (plan-review-drift.ts). Computed
    // only for a revise round that is not already landing; never itself
    // changes `nextAction`. Disabled entirely for a ticket with no baseline
    // (a session resumed mid-flight from before this shipped) or a truncated
    // one (never run the heuristic against known-incomplete data).
    let driftFraction: number | null = null;
    let driftHistoryForTicket: { ticketId: string; rounds: DriftRoundEntry[] } | null = null;
    let driftJustTriggered = false;
    if (isRevise && nextAction === "PLAN_REVIEW" && ticketId) {
      const baseline = ctx.state.planReviewBaseline;
      if (baseline && baseline.ticketId === ticketId && !baseline.truncated) {
        const driftFindings: DriftFinding[] = findings.map((f) => ({
          file: typeof (f as Record<string, unknown>).file === "string" ? (f as Record<string, unknown>).file as string : undefined,
          description: f.description,
        }));
        driftFraction = foldIntroducedFraction(driftFindings, new Set(baseline.tokens));
        const priorRounds = ctx.state.planReviewDriftHistory?.ticketId === ticketId
          ? ctx.state.planReviewDriftHistory.rounds
          : [];
        const rounds = driftFraction === null ? priorRounds : [...priorRounds, { round: roundNum, fraction: driftFraction }];
        driftHistoryForTicket = { ticketId, rounds };
        driftJustTriggered = driftFraction !== null && driftTriggered(rounds);
      }
    }

    // reject: clear plan review history. revise: preserve history.
    const reviewsForWrite = isReject
      ? { ...ctx.state.reviews, plan: [] as typeof planReviews }
      : { ...ctx.state.reviews, plan: planReviews };

    // T-181: lens history merged into single atomic write
    // ISS-904: count non-approving plan-gate rounds ACROSS rejects. A reject
    // empties `reviews.plan`, so `roundNum` restarts at 1 and a reject loop is
    // invisible to any counter derived from review history -- which is why three
    // campaign parks had to be recognised by a human rather than by the gate.
    const priorNonApprovals = ((ctx.state as Record<string, unknown>).planGateNonApprovals as number | undefined) ?? 0;
    const nonApprovals = nextAction === "IMPLEMENT" ? 0 : priorNonApprovals + 1;

    const stateUpdate: Record<string, unknown> = {
      reviews: reviewsForWrite,
      lastReviewVerdict: tier1Verdict,
      currentReviewStartedAt: null,
      planGateNonApprovals: nonApprovals,
    };
    if (ceilingDecision.counter) stateUpdate.planReviewRoundCounter = ceilingDecision.counter;
    if (driftHistoryForTicket) stateUpdate.planReviewDriftHistory = driftHistoryForTicket;
    if (isReject) {
      // A reject means the plan is rewritten from scratch; comparing the new
      // plan's findings against the OLD plan's vocabulary would manufacture
      // false drift signals on a plan converging normally post-rewrite.
      // `planReviewRoundCounter` above is the OPPOSITE: it does NOT reset on
      // reject, because it bounds total plan-gate effort for the ticket, not
      // one plan draft.
      stateUpdate.planReviewBaseline = null;
      stateUpdate.planReviewDriftHistory = null;
    }

    // ISS-598/ISS-1031: the round ceiling firing. Findings are filed BEFORE
    // `pendingPlanCeilingEscalation` is added to the state update, mirroring
    // code-review.ts's escalateCeiling/report() ordering -- a crash before the
    // state write must still leave both filing paths durably queued.
    if (ceilingDecision.shouldPark) {
      await ctx.fileDeferredFindings(findings, "plan");
      const outstanding = outstandingCeilingFindings(findings);
      const escalationFingerprints = await ctx.queueFindingsAsIssues(outstanding, "plan");
      const driftHistoryForFirstCheck = driftHistoryForTicket
        ?? (ctx.state.planReviewDriftHistory?.ticketId === ticketId ? ctx.state.planReviewDriftHistory : null);
      const firstDrift = driftHistoryForFirstCheck ? firstDriftTriggerRound(driftHistoryForFirstCheck.rounds) : null;
      stateUpdate.pendingPlanCeilingEscalation = {
        ticketId: ticketId ?? "",
        ...(ctx.state.ticket?.displayId ? { displayId: ctx.state.ticket.displayId } : {}),
        round: ceilingDecision.counter?.completedRounds ?? roundNum,
        ceiling: ceilingDecision.ceiling,
        trigger: "round-ceiling" as const,
        reason: `Plan review reached its hard ceiling of ${ceilingDecision.ceiling} rounds without an approvable plan.`,
        unresolvedCritical: unresolvedCriticalCount,
        unresolvedMajor: findings.filter(
          (f) => f.severity === "major" && f.disposition !== "addressed" && f.disposition !== "deferred",
        ).length,
        // Gate-1 ratification condition (b): even though drift itself never
        // routes to park while advisory, a ceiling park must not silently
        // hide a drift signal that was present the whole time.
        ...(firstDrift != null ? { driftWouldHaveFiredAtRound: firstDrift } : {}),
        decidedAt: new Date().toISOString(),
        findings: outstanding,
        fingerprints: escalationFingerprints,
      };
    }

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
      effort: roundEffort,
    });

    // Gate-1 ratification condition (b): full data for an offline
    // promote-to-automatic decision, regardless of whether this round's
    // trigger changed anything.
    if (driftFraction !== null) {
      ctx.appendEvent("plan_review_drift", {
        ticketId,
        round: roundNum,
        fraction: driftFraction,
        triggered: driftJustTriggered,
        policy: "advisory",
        action: driftJustTriggered ? "hint" : "recorded",
      });
    }

    // ISS-037: file deferred findings. Idempotent re-run for the escalating
    // path (already filed above); the only filing call on the non-escalating
    // path.
    await ctx.fileDeferredFindings(findings, "plan");

    // ISS-598/ISS-1031: the ceiling fires from the SAME site as every other
    // transition, after the round has been persisted exactly like any other
    // round.
    if (ceilingDecision.shouldPark) {
      return await escalatePlanCeiling(ctx);
    }

    if (nextAction === "PLAN") {
      return {
        action: "back",
        target: "PLAN",
        reason: "reject",
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
              `Plan for **${ctx.state.ticket?.id}** is ready to implement after ${roundNum} review round(s).`,
              "",
              "Session ending -- plan mode is complete.",
            ].join("\n"),
            reminders: [],
            transitionedFrom: "PLAN_REVIEW",
          },
        } as StageAdvance;
      }
      return { action: "advance" };
    }

    // nextAction === "PLAN_REVIEW": an ordinary continuation, always via
    // isRevise given the ternary above (approve/reject are fully handled,
    // and the general clean-landing check already claimed anything that
    // would land). Stay in PLAN_REVIEW -- next round.
    const findingSummary = findings.length > 0
      ? findings.slice(0, 5).map((f) => `- [${f.severity}] ${f.description}`).join("\n")
      : "Address the reviewer's concerns.";
    const driftHintLines: string[] = (() => {
      if (!driftJustTriggered || !driftHistoryForTicket) return [];
      const recent = driftHistoryForTicket.rounds.slice(-DRIFT_CONSECUTIVE_ROUNDS);
      const named = recent.map((r) => `round ${r.round}: ${r.fraction.toFixed(2)}`).join(", ");
      return [
        "",
        "---",
        "",
        `**Scope-drift signal (advisory).** The last ${DRIFT_CONSECUTIVE_ROUNDS} consecutive rounds each had a fold-introduced-finding fraction at or above ${DRIFT_FRACTION_THRESHOLD} (${named}) -- at least half of each round's findings were classified by this heuristic as citing subjects absent from the plan when review began. A real incident showed this exact pattern manufacturing unrequested, increasingly dangerous scope under review pressure. Consider whether the plan has drifted from the ticket's actual scope. If so, PARK this item now instead of continuing to revise:`,
        "```json",
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "${PARK_ACTION}", "notes": "<the drifted scope, specifically>" } }`,
        "```",
        "Or escalate to your operator before proceeding further.",
      ];
    })();
    const nextReviewerName = nextReviewer(planReviews, backends, ctx.state.codexUnavailable, ctx.state.codexUnavailableSince);
    return {
      action: "retry",
      instruction: [
        `# Plan Review -- Round ${roundNum} requested changes`,
        "",
        [
          effortDisclosureLine(ctx.state, "PLAN_REVIEW"),
          // planReviews already carries this round, so this names the
          // reviewer of the round the agent is being sent to run.
          reviewDepthLine(
            effectiveReviewEffort(ctx.state, "PLAN_REVIEW"),
            "plan",
            nextReviewerName,
            ctx.state.config,
          ),
        ].filter(Boolean).join(" "),
        "",
        "Update the plan to address these findings, then call me with completedAction: \"plan_review_round\" and the new review verdict.",
        "",
        findingSummary,
        ...driftHintLines,
        ...parkHintLines(ctx.state.sessionId, nonApprovals),
      ].join("\n"),
      reminders: ["Update the plan file, then re-review. Do NOT rewrite from scratch."],
    };
  }
}
