import { displayIdOf } from "../../core/resolver.js";
import { releaseSessionClaim } from "../../core/claims.js";
import { clearSameSessionEarmark } from "../../core/earmarks.js";
import type { ClaimEpoch } from "../claim-reconciliation.js";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import { buildLensHistoryUpdate } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { REVIEW_VERDICTS, REVIEW_VERDICTS_PROSE } from "../session-types.js";
import { normalizeRiskLevel, requiredRounds, nextReviewer } from "../review-depth.js";
import { effectiveReviewEffort, effortDisclosureLine, effortMinRounds } from "../review-effort.js";
import { codeReviewLandingFloor, dialCodeReviewMaxRounds } from "../session-diagnostics.js";
import { clearCache } from "../lens-harness/cache.js";
import { accumulateVerificationCounters } from "../lens-harness/verification-log.js";
import { buildTier1Verdict, classifyLensReviewPath, type ReviewVerdictArtifact } from "../review-verdict.js";
import {
  eventIdentity,
  identityFields,
  normalizeFindings,
  prepareReviewRound,
  upsertReviewRecord,
  writeRoundArtifact,
  type ItemAttempt,
  type ReviewRoundIdentity,
  type ReviewSubject,
} from "../review-identity.js";
import {
  currentStorybloqClient,
  nativeCodexReportInstruction,
  nativeCodexReviewCommand,
  reviewBackendsForStage,
  reviewDepthLine,
  shouldUseNativeCodexReview,
} from "./codex-native.js";
import { decideCeiling, outstandingCeilingFindings, codeReviewHardCeiling } from "./code-review-ceiling.js";
import {
  EMPTY_CHANGE_REQUEST_INSTRUCTION,
  REPAIR_ATTEMPT_CAP,
  isEmptyChangeRequest,
  pendingRoundOrdinal,
  countRepairAttempts,
  buildRepairAttempt,
  emptyVerdictParkReason,
} from "./review-repair.js";
import { parkCurrentTicket, parkCurrentIssue } from "./park.js";
import type { FullSessionState } from "../session-types.js";
import type { WorkItemRef } from "../../core/arrangement-bounds.js";

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
  const label = ctx.state.ticket
    ? (ctx.state.ticket.displayId ?? ctx.state.ticket.id)
    : ctx.state.currentIssue
      ? displayIdOf(ctx.state.currentIssue)
      : "the current item";

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
    // WRITTEN, not staged, and the reason is durability rather than anything
    // about `retry`. The whole point of recording these is that a failure part
    // way through leaves a record knowing which findings are this escalation's,
    // and only a write that has already happened can do that.
    //
    // T-488 correction: this comment used to add "a draft is discarded when
    // this returns `retry`", which is false. `processAdvance`'s retry branch
    // writes `stuckRetryCount` on the same context, and any write on that
    // context flushes a staged draft. The claim is struck rather than repaired
    // because the durability reason above never depended on it.
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

  // Dispatch by which work item is actually current. `pending` is the
  // escalation's own record and does not change which park target is used --
  // both parkCurrentTicket and parkCurrentIssue independently verify against
  // the CURRENT session/ledger state, and a resume must dispatch on the same
  // item resumeCeilingEscalation just matched the record against.
  const advance = ctx.state.ticket
    ? await parkCurrentTicket(
        ctx,
        { notes: reason } as GuideReportInput,
        "CODE_REVIEW",
        { reason, target: "HANDOVER" },
      )
    : await parkCurrentIssue(
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
      workItemId: pending?.workItemId ?? ctx.state.ticket?.id ?? ctx.state.currentIssue?.id,
      kind: pending?.kind ?? (ctx.state.ticket ? "ticket" : "issue"),
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
  // EXACT match on BOTH id and kind, and no current item is a non-match
  // rather than a pass.
  //
  // ISS-1032: an escalation can now belong to a ticket OR an issue. Guarding
  // on "both ids exist AND differ" let the record through whenever the
  // session held a DIFFERENT-KIND item or held nothing: filing could then
  // complete, but the matching park function returns `retry` with no item of
  // its own kind to park, so every later CODE_REVIEW report resumed the same
  // escalation and the current item could never progress. A same-id
  // different-kind pairing is not a match either -- kind and id together are
  // the identity, same invariant as the round counter's.
  //
  // The record is KEPT rather than deleted. Its findings were durably queued
  // into `pendingDeferrals` BEFORE the escalation record was created -- that is
  // what the ordering below buys -- so the ordinary drain can still file them.
  // Deleting would discard the one explanation of why that earlier item
  // stopped, which is what the session report renders. Failing closed would
  // deadlock the current item over a record belonging to an item that is no
  // longer here.
  const currentItem: WorkItemRef | null = ctx.state.ticket
    ? { kind: "ticket", id: ctx.state.ticket.id }
    : ctx.state.currentIssue
      ? { kind: "issue", id: ctx.state.currentIssue.id }
      : null;
  if (!currentItem || currentItem.kind !== pending.kind || currentItem.id !== pending.workItemId) return null;
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

    let codeReviews = [...ctx.state.reviews.code];
    // T-488: the ARRAY-derived ordinal, which is the right round number for a
    // new round and the wrong one for a replay. A replay takes its round from
    // the durable envelope instead, so a crash between sinks cannot renumber a
    // round that was already accepted. `roundNum` below is the resolved one.
    const arrayRound = codeReviews.length + 1;
    // T-461: see plan-review.ts -- the level belongs to the round, not to
    // whatever the session happens to be pinned to when someone reads it back.
    const roundEffort = effectiveReviewEffort(ctx.state, "CODE_REVIEW");
    // ISS-726: canonicalize severity up front so the suggestion-exemption and
    // critical/major contradiction guard below (and the per-severity counts and
    // lens history) cannot be bypassed by a miscased value.
    // T-488: the same pass records what the reviewer actually reported, because
    // most of that vocabulary survives normalization untouched and a reader
    // otherwise cannot tell a normalized `high` from a raw one.
    const findings = normalizeFindings(report.findings ?? []);
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
    // T-488: the state record is built and UPSERTED after the artifact sink
    // runs, not pushed here. Two reasons, and both are contract rather than
    // taste. The artifact is the only sink that can detect a generation
    // collision, so nothing else may record a generation it has not verified.
    // And a blind push double-counts a replayed round, which the ceiling fires
    // on -- so a duplicate would not be cosmetic, it could park an item early.

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

    // ISS-1114: the MIRROR of the guard above. `approve` with blocking findings
    // has been caught since ISS-035; a change-request with NO findings was not,
    // and it is the more expensive half. It reaches the ladder below as an
    // ordinary revise, so it either routes to IMPLEMENT with nothing to
    // implement or, at or above the landing floor, lands at FINALIZE on the
    // strength of a review that asked for changes and named none.
    //
    // Placed HERE, beside the other contradiction guards and BEFORE
    // `isChangeRequest`, for three reasons that are all consequences of
    // position rather than of extra code: the round is not counted (it lives in
    // a local array persisted at the single `writeState` far below), no verdict
    // artifact is written, no `code_review` event is emitted -- and the T-461
    // landing-floor region and the whole `nextAction` ladder stay byte-identical
    // on this path, because nothing below is reached at all.
    const emptyChangeRequest = isEmptyChangeRequest(verdict, findings);
    // No work item means no identity to scope an attempt to. `decideCeiling`
    // treats this same state as reachable and fails safe by declining to park,
    // and this guard matches it: keying an attempt on `undefined` would either
    // fail schema validation (silently dropping the record the guard exists to
    // write) or collide across items. Falling through leaves today's behavior
    // exactly as it is.
    const repairItem: WorkItemRef | null = ctx.state.ticket
      ? { kind: "ticket", id: ctx.state.ticket.id }
      : ctx.state.currentIssue
        ? { kind: "issue", id: ctx.state.currentIssue.id }
        : null;
    if (emptyChangeRequest && repairItem) {
      const counter = ctx.state.codeReviewRoundCounter;
      const matching = counter && counter.workItemId === repairItem.id && counter.kind === repairItem.kind
        ? counter.completedRounds
        : null;
      const repairKey = {
        workItemId: repairItem.id,
        kind: repairItem.kind,
        stage: "code" as const,
        round: pendingRoundOrdinal(matching),
      };
      const alreadySpent = countRepairAttempts(ctx.state.reviewRepairAttempts, repairKey);

      if (alreadySpent >= REPAIR_ATTEMPT_CAP) {
        // The reviewer has now returned an empty change-request three times for
        // ONE round with the instruction in hand. Park, reusing the ceiling
        // escalation rather than adding a second escalation path: the record is
        // written first and `escalateCeiling` is entered second, so a stop
        // between them resumes through `resumeCeilingEscalation` at the top of
        // `report` instead of reprocessing this payload as another round.
        // Nothing needs queueing -- `findings` is empty by definition, so the
        // queue call returns [] and the drain check is vacuously satisfied.
        const label = ctx.state.ticket
          ? (ctx.state.ticket.displayId ?? ctx.state.ticket.id)
          : displayIdOf(ctx.state.currentIssue!);
        const escalationDisplayId = repairItem.kind === "ticket"
          ? ctx.state.ticket?.displayId
          : displayIdOf(ctx.state.currentIssue!);
        ctx.writeState({
          pendingCeilingEscalation: {
            workItemId: repairItem.id,
            kind: repairItem.kind,
            ...(escalationDisplayId ? { displayId: escalationDisplayId } : {}),
            round: repairKey.round,
            // The ceiling and cap ACTUALLY in effect, from the same sources the
            // round-ceiling park reads. The trigger says what fired; it does not
            // license writing a sentinel into a field that means something else.
            ceiling: codeReviewHardCeiling(ctx.state, ctx.recipe.stages, risk),
            maxReviewRounds,
            trigger: "empty-verdict" as const,
            repairAttempts: alreadySpent,
            reason: emptyVerdictParkReason({
              stageLabel: "Code",
              round: repairKey.round,
              label,
              reviewer: reviewerBackend,
              attempts: alreadySpent,
            }),
            // Zero by definition of the trigger, not by assumption: the
            // predicate that got us here is `findings.length === 0`.
            unresolvedCritical: 0,
            unresolvedMajor: 0,
            decidedAt: new Date().toISOString(),
            findings: [],
            fingerprints: [],
            completed: false,
          },
        } as Partial<FullSessionState>);
        return await escalateCeiling(ctx);
      }

      // `writeState`, never `updateDraft`. The consequence this guards against
      // is right and unchanged -- a lost attempt record leaves the cap
      // permanently unreachable -- but the mechanism it used to name was not.
      //
      // T-488 correction: this said "a draft is DISCARDED when a stage returns
      // `retry`". It is not. `processAdvance`'s retry branch writes
      // `stuckRetryCount` on the same context (guide.ts), and every one of its
      // branches writes before returning, so a staged draft is flushed on the
      // retry path too. The real reason to write here is that staging would
      // make a correctness-critical record depend on a downstream write this
      // stage does not control, and `processAdvance` has two exits that write
      // nothing at all: the auto-advance depth limit, and a pipeline exhausted
      // with no HANDOVER stage registered. Both return `guideError` before any
      // write, and either would drop a staged attempt record.
      ctx.writeState({
        reviewRepairAttempts: [
          ...(ctx.state.reviewRepairAttempts ?? []),
          buildRepairAttempt({
            key: repairKey,
            existing: ctx.state.reviewRepairAttempts,
            verdict,
            reviewer: reviewerBackend,
            reviewStartedAt: ctx.state.currentReviewStartedAt,
            nowMs: Date.now(),
          }),
        ],
      } as Partial<FullSessionState>);
      return { action: "retry", instruction: EMPTY_CHANGE_REQUEST_INSTRUCTION };
    }

    // ── T-488: the round's identity, made durable before any sink ──────────
    //
    // Placed HERE, after every payload guard and before the routing ladder.
    // After the guards because a refused payload must leave no envelope behind
    // to be replayed. Before the ladder because a replay has to route on the
    // round number it was ACCEPTED at, not on a fresh array-derived one.
    //
    // `target` and `summary` are hoisted from the artifact block below for the
    // same reason: the fingerprint that decides replay-or-new has to pin the
    // exact payload, and `summary` comes from free-text notes.
    const target = ctx.state.ticket?.id ?? ctx.state.currentIssue?.id ?? "unknown";
    const summary = report.notes || `Code review ${verdict}: ${findings.length} finding(s) (${criticalCount} critical, ${majorCount} major)`;
    // No work item means no subject: the identity fields are written NEITHER
    // way rather than filled with a placeholder, which is the same rule the
    // ISS-1114 repair guard applies one screen up.
    const reviewSubject: ReviewSubject | null = ctx.state.ticket
      ? { workItemId: ctx.state.ticket.id, kind: "ticket" }
      : ctx.state.currentIssue
        ? { workItemId: ctx.state.currentIssue.id, kind: "issue" }
        : null;
    const prepared = prepareReviewRound(ctx, {
      stage: "code",
      subject: reviewSubject,
      target,
      verdict,
      reviewer: reviewerBackend,
      summary,
      findings: findings as unknown as readonly Record<string, unknown>[],
      arrayRound,
      report,
      effort: roundEffort,
      nowIso: new Date().toISOString(),
    });
    const roundNum = prepared.round;

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
    const startedAt = ctx.state.currentReviewStartedAt;
    const startedMs = startedAt ? new Date(startedAt).getTime() : NaN;
    const durationMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    // ISS-720: for lens-backed reviews, record the path actually taken (whether
    // the verification gate ran) instead of trusting the configured backend tag.
    // reviewId/reviewerPath are lens-review observability, so both are recorded
    // only when the backend is lenses.
    const lensReviewId = reviewerBackend === "lenses" ? report.reviewId : undefined;
    const reviewerPath = lensReviewId ? classifyLensReviewPath(ctx.dir, lensReviewId) : undefined;
    // T-488: rebuilt per generation, because a collision changes the identity
    // block and the artifact has to carry the generation it is actually
    // written at -- `generation` is in the content hash.
    const buildCodeArtifact = (identity: ReviewRoundIdentity): ReviewVerdictArtifact => ({
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
      ...identityFields(identity),
    });
    const artifactResult = writeRoundArtifact(ctx, {
      identity: prepared.identity,
      envelope: prepared.envelope,
      attempt: (ctx.state.itemAttempt ?? null) as ItemAttempt | null,
      buildArtifact: buildCodeArtifact,
    });
    if (artifactResult.kind === "retry") {
      // No round is recorded against a generation the artifact sink could not
      // verify. That is the whole reason the artifact goes first.
      return { action: "retry", instruction: artifactResult.instruction };
    }
    const identity = artifactResult.identity;
    const tier1Verdict = buildTier1Verdict(artifactResult.artifact);

    // T-488: built here, after the sink that can still change the generation,
    // and UPSERTED by `reviewAttemptId` so a replay cannot double-count.
    const roundRecord = {
      round: roundNum,
      reviewer: reviewerBackend,
      verdict,
      findingCount: findings.length,
      criticalCount,
      unresolvedCriticalCount,
      majorCount,
      suggestionCount,
      codexSessionId: report.reviewerSessionId,
      effort: roundEffort,
      timestamp: new Date().toISOString(),
      ...identityFields(identity),
      artifactStatus: artifactResult.artifactStatus,
    };
    codeReviews = upsertReviewRecord(codeReviews, roundRecord);

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
      const redirectAttempt = (ctx.state.itemAttempt ?? null) as ItemAttempt | null;
      ctx.writeState({
        // The counter advances HERE too. It is the only durable record of a
        // completed round, and this branch clears the array `roundNum` is
        // derived from -- so without this line a reviewer that keeps
        // recommending PLAN would loop forever at a count that never moved,
        // which is the same unbounded shape the ceiling exists to close.
        ...(ceilingDecision.counter ? { codeReviewRoundCounter: ceilingDecision.counter } : {}),
        // T-488 D9: APPENDED BEFORE THE CLEAR, so what the clear destroys is
        // preserved rather than mourned in a comment. The clear itself is
        // unchanged -- it is right for a replan, and this is what makes it also
        // survivable for a session that ends instead of replanning.
        reviewGenerationHistory: [
          ...(ctx.state.reviewGenerationHistory ?? []),
          {
            ...(identity.itemAttemptId ? { itemAttemptId: identity.itemAttemptId } : {}),
            generation: identity.generation,
            ...(ctx.state.ticket?.realizedRisk ? { realizedRisk: ctx.state.ticket.realizedRisk } : {}),
            lensReviewHistory: ctx.state.lensReviewHistory ?? [],
            endedAt: new Date().toISOString(),
            reason: "plan-redirect",
          },
        ],
        // T-488 D3: the redirect is what OPENS a new generation. Round numbers
        // restart from here, so without this the next generation's r1 would
        // reproduce this generation's r1 filename, `writeReviewVerdict` would
        // answer `exists`, and the round would be silently dropped -- the
        // observed westworld `08a52602` shape, where nine rounds vanished and
        // the twelve survivors read as one continuous run.
        //
        // This increment serves RETENTION, not collision avoidance. The
        // artifact sink's collision guard would resolve the numbering on its
        // own, and does exactly that at the plan stage's `reject`, which clears
        // `reviews.plan` the same way and carries no increment. What only this
        // site can supply is the boundary at the moment `reviewGenerationHistory`
        // appends it, above. Stated because the asymmetry is deliberate and the
        // next reader will otherwise read the plan side as a missing case.
        ...(redirectAttempt
          ? { itemAttempt: { ...redirectAttempt, generation: identity.generation + 1 } }
          : {}),
        // The envelope's round is complete for every sink that can report
        // success. Events are best-effort by contract, so "attempted" is the
        // most that can be waited for; it is attempted immediately below.
        pendingReviewAttempt: null,
        // The redirecting round reaches the artifact and the event but NOT the
        // state array, because this clear is what a replan means and it takes
        // the whole array with it. That is a known and deliberate limit of the
        // state arrays rather than of this round: they undercount by
        // construction on every redirect, exactly as `reviews.plan` does on
        // every plan reject, which is why the ARTIFACT is the primary record
        // and the arrays are a convenience. Preserving the records themselves
        // across the boundary is T-492/T-432 work, not this ticket's.
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
        // T-488 D11: 422 review events across 130 local sessions carried ZERO
        // item id, so nothing downstream could say which item a round belonged
        // to. `appendEvent` stays best-effort and may duplicate on a replay;
        // readers deduplicate by `reviewAttemptId`, which is why it is here.
        ...eventIdentity(identity),
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
      // T-488: the state record has now landed, so the envelope has done its
      // job. Cleared in the SAME write as the record, and the alternative is
      // worse rather than merely tidier.
      //
      // Holding it past this write would shrink one window and open a strictly
      // more damaging one. The payload fingerprint covers the verdict, summary
      // and findings, so a genuine SECOND round that repeats them -- a reviewer
      // returning the same answer because nothing changed -- becomes
      // indistinguishable from a replay of the first, and the upsert then
      // REPLACES round 1 instead of appending round 2. A round that really ran
      // would disappear from the count the ceiling fires on.
      //
      // What the window costs by comparison is bounded: a crash between this
      // write and the transition leaves a durably recorded, fully joinable
      // round, and the resumed session runs one more review than it needed to.
      // No identity is lost and no record is fabricated. Pinned both ways in
      // `review-attempt-durability.test.ts`.
      //
      // Staging the clear with `ctx.updateDraft` so it commits atomically with
      // the transition was considered and rejected. It IS achievable -- every
      // branch of `processAdvance` calls `writeState` on this same context
      // before returning, the retry branch included (it writes
      // `stuckRetryCount`), and any such write flushes the draft. That is
      // exactly the problem: it makes a correctness-critical clear depend on a
      // downstream write that exists for an unrelated reason and that this code
      // does not control. `processAdvance` already has two exits that write
      // nothing (the auto-advance depth limit and a pipeline exhausted with no
      // HANDOVER stage), and either would persist a landed record beside a live
      // envelope. The next genuine round with a matching fingerprint would then
      // replay into the recorded round and REPLACE it. That failure is silent
      // and corrupts the count the ceiling fires on; the one this ordering
      // accepts is visible and costs a review round. When two failure modes are
      // indistinguishable at the decision point, over-record the work.
      pendingReviewAttempt: null,
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

      // The counter's item is authoritative: it is the exact WorkItemRef
      // decideCeiling derived and fired on, guaranteed non-null here because
      // shouldPark can only be true when decideCeiling found a work item.
      const escalationItem: WorkItemRef = ceilingDecision.counter
        ? { kind: ceilingDecision.counter.kind, id: ceilingDecision.counter.workItemId }
        : ctx.state.ticket
          ? { kind: "ticket", id: ctx.state.ticket.id }
          : { kind: "issue", id: ctx.state.currentIssue!.id };
      // Captured NOW, while the item is still on the state. The park clears it
      // before the transition, so the report has nowhere else to read it from.
      const escalationDisplayId = escalationItem.kind === "ticket"
        ? ctx.state.ticket?.displayId
        : displayIdOf(ctx.state.currentIssue!);
      stateUpdate.pendingCeilingEscalation = {
        workItemId: escalationItem.id,
        kind: escalationItem.kind,
        ...(escalationDisplayId ? { displayId: escalationDisplayId } : {}),
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

    // EMITTED AFTER THE WRITE, and the third option here was examined rather
    // than missed. A crash in this gap loses the event permanently: the record
    // is durable, the envelope went out with it, and no replay can repair it.
    // Moving this emit ABOVE the write would close that window without
    // reopening the fingerprint collision the envelope ordering guards (a crash
    // before the write leaves the envelope live, so the replay reuses the same
    // `reviewAttemptId`, re-emits, and readers deduplicate on it).
    //
    // What decides against it is the `rev` stamp. `appendEvent` records
    // `rev: this._state.revision`, and `writeState` is what advances that
    // revision -- so emitting first would stamp the revision BEFORE the one
    // containing this round's record, and `rev` would stop naming the state a
    // reader can look the round up in. That correlation does real work: it is
    // how a landing_decision at events.log rev 380 overturned a claim about
    // T-056 this session. Events are best-effort by contract and the artifact
    // is the primary record, so losing an event costs less than breaking the
    // stamp that makes the surviving ones locatable.
    ctx.appendEvent("code_review", {
      round: roundNum,
      verdict,
      findingCount: findings.length,
      effort: roundEffort,
      // T-488 D11: see the redirect emit above for why the ids are here.
      ...eventIdentity(identity),
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
