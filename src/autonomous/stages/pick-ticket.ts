import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { isDeleted } from "../../core/project-state.js";
import { isTargetedMode, getRemainingTargets, buildTargetedCandidatesText, buildTargetedPickInstruction, buildTargetedStuckHandover } from "../target-work.js";
import {
  detectBranchAffinity, checkAffinityMismatch, buildAffinityAnnotation,
  buildMismatchHandoverInstruction, buildMismatchOfferInstruction,
  applyBranchStrategy, performNewBranchFromMain, MAX_MISMATCH_CONTROL_FAILURES,
  type BranchAffinity, type BranchTarget, type PendingMismatch,
} from "../branch-affinity.js";
import { canClaim, buildClaim } from "../../core/claims.js";
import { gitUserEmail, gitHead } from "../git-inspector.js";
import { displayIdOf } from "../../core/resolver.js";
import { storybloqClientProfile } from "../client-profile.js";
import { reviewRiskForTicket } from "../review-depth.js";
import type { Ticket } from "../../models/ticket.js";
import type { Issue } from "../../models/issue.js";

/**
 * T-328: revalidating a pending target has three outcomes, not two. Folding a
 * transient read failure into "rejected" would clear the episode and reset its
 * failure budget, so repeated ledger-read failures could only ever be stopped
 * by the generic retry counter.
 */
type RevalidationResult<T> =
  | { kind: "ok"; item: T }
  | { kind: "rejected"; advance: StageAdvance }
  | { kind: "transient"; message: string };

/**
 * PICK_TICKET stage -- Claude selects the next ticket to work on.
 *
 * enter(): Candidate list + pick instruction (from handleStart or CompleteStage).
 * report(): Validate ticket exists and is open, advance to PLAN.
 *
 * T-188: When targetWork is non-empty, candidates are constrained to remaining targets.
 */
/**
 * Resolve the finalization baseline for an item about to be picked (ISS-922).
 *
 * Must be a FRESH head, never the cached expectedHead: that field records the
 * last OBSERVED head and has no updater for ordinary active-session drift, so
 * HEAD can move between COMPLETE and the next pick while branch strategy
 * "current", "main" already on main, and "per-ticket" already on its branch
 * all refresh nothing. A stale baseline makes a pre-existing commit read as
 * this item's work.
 *
 * Fails closed rather than falling back: a cached value is exactly what cannot
 * establish the baseline. That costs no supported configuration, because
 * session start already refuses a project without git.
 */
async function resolveItemBaseHead(ctx: StageContext): Promise<string | null> {
  const head = await gitHead(ctx.root);
  return head?.ok ? head.data.hash : null;
}

const GIT_UNAVAILABLE_AT_PICK =
  "Cannot resolve HEAD, so the item was NOT picked: without it there is no baseline to detect this item's commit against, and finalization would later refuse work that exists. Restore git access (check `git status` in the project root), then report the pick again.";

export class PickTicketStage implements WorkflowStage {
  readonly id = "PICK_TICKET";

  async enter(ctx: StageContext): Promise<StageResult> {
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return {
        action: "retry",
        instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption, then call autonomous_guide with action "report" again.`,
      } as StageAdvance;
    }

    // T-188: Targeted mode -- constrain candidates to remaining targets
    if (isTargetedMode(ctx.state)) {
      const remaining = getRemainingTargets(ctx.state);
      if (remaining.length === 0) {
        return { action: "goto", target: "COMPLETE" };
      }

      // Use firstReady as the stuck indicator -- handles all cases:
      // external blockers, mutual-blocking cycles, missing tickets, resolved issues
      const { text: candidatesText, firstReady } = buildTargetedCandidatesText(remaining, projectState);
      if (!firstReady) {
        return {
          action: "goto",
          target: "HANDOVER",
          result: {
            instruction: buildTargetedStuckHandover(candidatesText, ctx.state.sessionId),
            reminders: [],
            transitionedFrom: "PICK_TICKET",
          },
        } as StageResult;
      }

      const precomputed = { text: candidatesText, firstReady };
      const targetedInstruction = buildTargetedPickInstruction(remaining, projectState, ctx.state.sessionId, precomputed);
      return {
        instruction: [
          "# Pick a Target Item",
          "",
          `${remaining.length} of ${ctx.state.targetWork.length} target(s) remaining.`,
          "",
          targetedInstruction,
        ].join("\n"),
        reminders: [
          "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick a target item.",
          "Do NOT ask the user for confirmation.",
          "You are in targeted auto mode -- pick ONLY from the listed items.",
        ],
      };
    }

    // Standard auto mode -- browse full roadmap
    const { nextTickets } = await import("../../core/queries.js");
    // T-328: a skipped item must not come straight back on the next pass.
    const skipped = new Set(ctx.state.skippedTargets ?? []);
    const candidates = nextTickets(projectState, 5, skipped);

    let candidatesText = "";
    if (candidates.kind === "found") {
      candidatesText = candidates.candidates.map((c: { ticket: { id: string; title: string; type: string } & Record<string, unknown> }, i: number) =>
        `${i + 1}. **${(c.ticket.displayId as string | undefined) ?? c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
      ).join("\n");
    }

    // T-328: Branch affinity annotation
    const affinity = detectBranchAffinity(ctx.state.git?.branch ?? null);
    const { warningText } = buildAffinityAnnotation(affinity);
    if (warningText) {
      candidatesText = warningText + "\n\n" + candidatesText;
    }

    // ISS-084: Surface ALL open issues (severity affects display order, not work-remaining check)
    const allOpenIssues = projectState.activeIssues.filter(
      i => i.status === "open" && !skipped.has(i.id) && !(i.displayId && skipped.has(i.displayId)),
    );
    const highIssues = allOpenIssues.filter(i => i.severity === "critical" || i.severity === "high");
    const otherIssues = allOpenIssues.filter(i => i.severity !== "critical" && i.severity !== "high");
    let issuesText = "";
    if (highIssues.length > 0) {
      issuesText = "\n\n## Open Issues (high+ severity)\n\n" + highIssues.map(
        (i, idx) => `${idx + 1}. **${(i as Record<string, unknown>).displayId as string | undefined ?? i.id}: ${i.title}** (${i.severity})`,
      ).join("\n");
    }
    if (otherIssues.length > 0) {
      issuesText += "\n\n## Open Issues (medium/low)\n\n" + otherIssues.map(
        (i, idx) => `${idx + 1}. **${(i as Record<string, unknown>).displayId as string | undefined ?? i.id}: ${i.title}** (${i.severity})`,
      ).join("\n");
    }

    const topCandidate = candidates.kind === "found" ? candidates.candidates[0] : null;
    const hasIssues = allOpenIssues.length > 0;

    // ISS-075: If nothing left to do, route to COMPLETE (which handles HANDOVER/postComplete)
    if (!topCandidate && candidates.kind !== "found" && !hasIssues) {
      return { action: "goto", target: "COMPLETE" };
    }

    return {
      instruction: [
        "# Pick a Ticket or Issue",
        "",
        "## Ticket Candidates",
        "",
        candidatesText || "No ticket candidates found.",
        issuesText,
        "",
        topCandidate
          ? `Pick **${(topCandidate.ticket as Record<string, unknown>).displayId as string | undefined ?? topCandidate.ticket.id}** (highest priority) or an open issue by calling \`storybloq_autonomous_guide\` now:`
          : hasIssues
            ? `Pick an issue to fix by calling \`storybloq_autonomous_guide\` now:`
            : "Pick a ticket by calling `storybloq_autonomous_guide` now:",
        '```json',
        topCandidate
          ? `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
          : `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
        '```',
        ...(hasIssues ? [
          "",
          "Or to fix an issue:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_picked", "issueId": "${(highIssues[0] ?? allOpenIssues[0]).id}" } }`,
          '```',
        ] : []),
      ].join("\n"),
      reminders: [
        "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick a ticket or issue.",
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    // T-328: pending control actions dispatch FIRST, so an open mismatch
    // episode can always be closed. If they ran after the ordinary pick path an
    // episode could become a trap: the only way out would be the generic retry
    // exhaustion, which is not a decision anyone made.
    const control = await this.handlePendingMismatchAction(ctx, report);
    if (control) return control;

    // T-153: Accept issueId for issue-fix flow
    const issueId = report.issueId;
    if (issueId) {
      return this.handleIssuePick(ctx, issueId);
    }

    const ticketId = report.ticketId;
    if (!ticketId) {
      return { action: "retry", instruction: "report.ticketId or report.issueId is required." };
    }

    // T-188: Targeted mode -- if no targets remain, complete BEFORE any resolution
    const exhausted = this.targetsExhausted(ctx);
    if (exhausted) return exhausted;

    // Validate ticket
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption.` };
    }

    // ISS-759: Resolve the reported id (canonical id, displayId, or previousDisplayId)
    const resolvedRef = projectState.resolveTicketRef(ticketId);
    if (resolvedRef.kind === "ambiguous") {
      return { action: "retry", instruction: `Ticket ref ${ticketId} is ambiguous -- it matches ${resolvedRef.matches.map(m => m.id).join(", ")}. Pick one by its canonical id.` };
    }
    if (resolvedRef.kind === "missing") {
      return { action: "retry", instruction: `Ticket ${ticketId} not found. Pick a valid ticket.` };
    }
    const ticket = resolvedRef.item;
    const ticketLabel = displayIdOf(ticket);

    // ISS-756: tombstoned items resolve (gc/conflicts tooling needs that) but
    // must never be workable.
    if (isDeleted(ticket)) {
      return { action: "retry", instruction: `Ticket ${ticketLabel} is deleted (tombstoned). Pick a different ticket.` };
    }

    // T-188: Enforce target membership with the resolved canonical id (targetWork is canonical per ISS-654)
    const targetReject = this.enforceTargetMembership(ctx, ticket.id, ticketLabel);
    if (targetReject) return targetReject;

    if (projectState.isBlocked(ticket)) {
      return { action: "retry", instruction: `Ticket ${ticketLabel} is blocked. Pick an unblocked ticket.` };
    }
    // ISS-027: Reject non-open tickets unless claimed by this session
    if (ticket.status !== "open") {
      const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
      if (!(ticket.status === "inprogress" && ticketClaim === ctx.state.sessionId)) {
        return { action: "retry", instruction: `Ticket ${ticketLabel} is ${ticket.status} -- pick an open ticket.` };
      }
    }

    // T-375: Claim check -- reject tickets claimed by others
    const email = await gitUserEmail(ctx.root);
    if (ticket.claim) {
      if (!email) {
        return { action: "retry", instruction: `Ticket ${ticketLabel} is claimed by ${ticket.claim.user}. Configure git user.email to verify identity, or pick a different ticket.` };
      }
      const claimResult = canClaim(ticket, email, ctx.state.git?.branch ?? "unknown");
      if (!claimResult.allowed) {
        return { action: "retry", instruction: `Ticket ${ticketLabel} is claimed by ${claimResult.claimedBy} on branch ${ticket.claim.branch}. Pick a different ticket.` };
      }
    }

    // T-328: affinity runs AFTER the eligibility gates above. It opens a
    // persisted episode and offers a branch-creating escape, so an ineligible
    // pick must not be able to start one.
    const mismatch = this.checkMismatch(ctx, {
      canonicalId: ticket.id,
      displayId: ticket.displayId,
      title: ticket.title,
      kind: "ticket",
      allIds: [ticket.id, ticket.displayId, ...(ticket.previousDisplayIds ?? [])]
        .filter((v): v is string => Boolean(v)),
      label: ticketLabel,
    });
    if (mismatch) return mismatch;

    // T-328: branch strategy is the last thing that touches git.
    const applied = await this.applyStrategy(ctx, {
      canonicalId: ticket.id,
      displayId: ticket.displayId,
      title: ticket.title,
      kind: "ticket",
    });
    if (applied) return applied;

    // ISS-922: establish this item's finalization baseline from a FRESH head,
    // after branch strategy (the last thing that moves the repository).
    const ticketBaseHead = await resolveItemBaseHead(ctx);
    if (!ticketBaseHead) return { action: "retry", instruction: GIT_UNAVAILABLE_AT_PICK };

    // Clean up stale plan from previous ticket (ISS-029)
    const planPath = join(ctx.dir, "plan.md");
    try { if (existsSync(planPath)) unlinkSync(planPath); } catch { /* best-effort */ }

    // T-375: Build claim using final branch (after per-ticket branch creation)
    const finalBranch = ctx.state.git?.branch ?? "unknown";
    const claimObj = email ? buildClaim(email, finalBranch, new Date().toISOString()) : undefined;

    // Stage field updates (persisted atomically with state transition by processAdvance)
    ctx.updateDraft({
      ticket: {
        id: ticket.id,
        displayId: ticket.displayId,
        title: ticket.title,
        risk: reviewRiskForTicket(ticket),
        claimed: true,
      },
      reviews: { plan: [], code: [] },
      git: { ...ctx.state.git, itemBaseHead: ticketBaseHead },
      // ISS-904: per-ticket, so a fresh pick never inherits the previous item's
      // plan-gate history and mis-trigger the park hint on round one.
      planGateNonApprovals: 0,
      finalizeCheckpoint: null,
      landingDecision: null,
      ticketStartedAt: new Date().toISOString(),
      ...(claimObj ? { pendingTicketClaim: claimObj } : {}),
    });

    // Produce PLAN instruction (advance with result for hybrid dispatch)
    return {
      action: "advance",
      result: {
        instruction: [
          `# Plan for ${ticketLabel}: ${ticket.title}`,
          "",
          ticket.description ? `## Ticket Description\n\n${ticket.description}` : "",
          "",
          `Write an implementation plan for this ticket. Save it to \`.story/sessions/${ctx.state.sessionId}/plan.md\`.`,
          "",
          "When done, call `storybloq_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          '```',
        ].join("\n"),
        reminders: [
          "Write the plan as a markdown file -- do NOT use client-native plan mode.",
          "Do NOT ask the user for approval.",
        ],
        transitionedFrom: "PICK_TICKET",
      },
    };
  }

  // T-153: Handle issue pick -- validate and route to ISSUE_FIX
  private async handleIssuePick(ctx: StageContext, issueId: string): Promise<StageAdvance> {
    // T-188: Targeted mode -- if no targets remain, complete BEFORE any resolution
    const exhausted = this.targetsExhausted(ctx);
    if (exhausted) return exhausted;

    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption.` };
    }

    // ISS-759: Resolve the reported id (canonical id, displayId, or previousDisplayId)
    const resolvedRef = projectState.resolveIssueRef(issueId);
    if (resolvedRef.kind === "ambiguous") {
      return { action: "retry", instruction: `Issue ref ${issueId} is ambiguous -- it matches ${resolvedRef.matches.map(m => m.id).join(", ")}. Pick one by its canonical id.` };
    }
    if (resolvedRef.kind === "missing") {
      return { action: "retry", instruction: `Issue ${issueId} not found. Pick a valid issue or ticket.` };
    }
    const issue = resolvedRef.item;
    const issueLabel = displayIdOf(issue);

    // ISS-756: see the ticket path -- tombstoned items are unworkable.
    if (isDeleted(issue)) {
      return { action: "retry", instruction: `Issue ${issueLabel} is deleted (tombstoned). Pick a different issue.` };
    }

    // T-188: Enforce target membership with the resolved canonical id (targetWork is canonical per ISS-654)
    const targetReject = this.enforceTargetMembership(ctx, issue.id, issueLabel);
    if (targetReject) return targetReject;

    // T-188: Targeted mode allows inprogress issues (resume from prior session)
    const targeted = isTargetedMode(ctx.state);
    if (issue.status !== "open" && !(targeted && issue.status === "inprogress")) {
      return { action: "retry", instruction: `Issue ${issueLabel} is ${issue.status}. Pick an open issue.` };
    }

    // T-328: same order as the ticket path -- eligibility, then affinity, then
    // the strategy that actually moves the repository.
    const mismatch = this.checkMismatch(ctx, {
      canonicalId: issue.id,
      displayId: issue.displayId,
      title: issue.title,
      kind: "issue",
      allIds: [issue.id, issue.displayId, ...(issue.previousDisplayIds ?? [])]
        .filter((v): v is string => Boolean(v)),
      label: issueLabel,
    });
    if (mismatch) return mismatch;

    const applied = await this.applyStrategy(ctx, {
      canonicalId: issue.id,
      displayId: issue.displayId,
      title: issue.title,
      kind: "issue",
    });
    if (applied) return applied;

    // ISS-922: establish the finalization baseline from a FRESH head. This sits
    // ahead of the ledger mutation below, so failing closed picks nothing AND
    // leaves the issue's status untouched.
    const issueBaseHead = await resolveItemBaseHead(ctx);
    if (!issueBaseHead) return { action: "retry", instruction: GIT_UNAVAILABLE_AT_PICK };

    // ISS-090: Mark issue as inprogress with pendingProjectMutation for crash recovery
    // ISS-112: Include expectedCurrent for 3-way recovery check (matches ticket_update pattern)
    // ISS-759: Use the resolved canonical issue.id -- crash-recovery replay matches on target
    const transitionId = `issue-pick-${issue.id}-${Date.now()}`;
    ctx.writeState({
      pendingProjectMutation: { type: "issue_update", target: issue.id, field: "status", value: "inprogress", expectedCurrent: issue.status, transitionId },
    });
    try {
      const { handleIssueUpdate } = await import("../../cli/commands/issue.js");
      await handleIssueUpdate(issue.id, { status: "inprogress" }, "json", ctx.root);
    } catch { /* best-effort -- don't block on status update */ }
    ctx.writeState({ pendingProjectMutation: null });

    ctx.updateDraft({
      currentIssue: { id: issue.id, displayId: issue.displayId, title: issue.title, severity: issue.severity },
      ticket: undefined,
      reviews: { plan: [], code: [] },
      git: { ...ctx.state.git, itemBaseHead: issueBaseHead },
      finalizeCheckpoint: null,
      landingDecision: null,
    });

    return { action: "goto", target: "ISSUE_FIX" };
  }

  // -------------------------------------------------------------------------
  // T-328: branch-mismatch episodes
  // -------------------------------------------------------------------------

  /**
   * The affinity gate. Returns null when the pick is fine.
   *
   * The first unresolved mismatch in an episode offers escapes; while an
   * episode is already open, any further unresolved mismatch is terminal
   * regardless of which item or branch produced it. Keying on the (item,
   * branch) pair instead would let a caller alternate ids or rename the branch
   * and collect a fresh offer forever.
   */
  private checkMismatch(
    ctx: StageContext,
    target: BranchTarget & { allIds: string[]; label: string },
  ): StageAdvance | null {
    const strategy = ctx.state.resolvedBranchStrategy;
    // Targeted mode constrains picks already; "main" and "per-ticket" have
    // decided the branch, so there is nothing for affinity to arbitrate. Any
    // episode still open is stale here too, for the same reason as below.
    if (isTargetedMode(ctx.state) || strategy === "per-ticket" || strategy === "main") {
      if (ctx.state.pendingMismatch) ctx.writeState({ pendingMismatch: null });
      return null;
    }

    const affinity = detectBranchAffinity(ctx.state.git?.branch ?? null);
    const mismatch = checkAffinityMismatch(affinity, target.allIds, target.label);
    if (!mismatch.blocked) {
      // An open episode resolved by simply picking a matching item. Clearing it
      // here matters: a stale record would make the NEXT unrelated mismatch
      // terminal instead of offering, and would leave control actions pointing
      // at an item this session already moved past.
      if (ctx.state.pendingMismatch) ctx.writeState({ pendingMismatch: null });
      return null;
    }

    const open = ctx.state.pendingMismatch ?? null;
    if (open) return this.endEpisode(ctx, affinity, target.label);

    ctx.writeState({
      pendingMismatch: {
        targetId: target.canonicalId,
        targetKind: target.kind,
        branch: affinity.branch ?? "",
        controlFailures: 0,
        attempt: null,
      },
    });
    return {
      action: "retry",
      instruction: buildMismatchOfferInstruction(affinity, target.label, ctx.state.sessionId),
    };
  }

  /** Terminal route: unchanged from the pre-T-328 behavior. */
  private endEpisode(ctx: StageContext, affinity: BranchAffinity, label: string): StageAdvance {
    ctx.writeState({ pendingMismatch: null });
    return {
      action: "goto",
      target: "HANDOVER",
      result: {
        instruction: buildMismatchHandoverInstruction(
          affinity,
          label,
          ctx.state.sessionId,
          storybloqClientProfile().storyCommand,
        ),
        reminders: [],
        transitionedFrom: "PICK_TICKET",
      },
    };
  }

  /**
   * Handle `new_branch_from_main`, `skip_ticket`, and `end_session` while an
   * episode is open. Returns null when the report is not one of those, so the
   * ordinary pick path runs untouched.
   */
  private async handlePendingMismatchAction(
    ctx: StageContext,
    report: GuideReportInput,
  ): Promise<StageAdvance | null> {
    const action = report.completedAction;
    if (action !== "new_branch_from_main" && action !== "skip_ticket" && action !== "end_session") {
      return null;
    }

    const open = ctx.state.pendingMismatch ?? null;
    if (!open) {
      return {
        action: "retry",
        instruction: `"${action}" is only valid while a branch mismatch is pending. Report a ticket or issue pick instead.`,
      };
    }

    const identity = this.validatePendingIdentity(open, report);
    if (identity) return this.controlFailure(ctx, open, identity);

    if (action === "end_session") {
      const affinity = detectBranchAffinity(open.branch);
      return this.endEpisode(ctx, affinity, open.targetId);
    }

    if (action === "skip_ticket") {
      const skipped = [...(ctx.state.skippedTargets ?? [])];
      if (!skipped.includes(open.targetId)) skipped.push(open.targetId);
      ctx.writeState({ skippedTargets: skipped, pendingMismatch: null });
      return { action: "goto", target: "PICK_TICKET" };
    }

    return this.handleNewBranchFromMain(ctx, open);
  }

  /**
   * A report may carry no id, or the id matching the pending target. Anything
   * else is rejected rather than ignored: silently accepting a mismatched id
   * would let a confused caller believe it had skipped or rebranched something
   * it had not.
   */
  private validatePendingIdentity(open: PendingMismatch, report: GuideReportInput): string | null {
    const { ticketId, issueId } = report;
    if (ticketId && issueId) return "Sending both ticketId and issueId is ambiguous. Send at most one, and it must match the pending item.";
    const supplied = ticketId ?? issueId;
    if (!supplied) return null;
    const suppliedKind = ticketId ? "ticket" : "issue";
    if (suppliedKind !== open.targetKind) {
      return `The pending mismatch is for a ${open.targetKind} (${open.targetId}); a ${suppliedKind}Id was sent instead.`;
    }
    if (supplied !== open.targetId) {
      return `The pending mismatch is for ${open.targetId}, not ${supplied}.`;
    }
    return null;
  }

  /**
   * Count a recoverable failure against the episode's own bound.
   *
   * Every retry also increments the generic stuckRetryCount, whose threshold of
   * 5 bypasses the cancel gate. Left unbounded, repeated control failures would
   * end the episode through that generic path rather than through this one.
   */
  private controlFailure(ctx: StageContext, open: PendingMismatch, message: string): StageAdvance {
    const failures = (open.controlFailures ?? 0) + 1;
    if (failures >= MAX_MISMATCH_CONTROL_FAILURES) {
      const affinity = detectBranchAffinity(open.branch);
      ctx.writeState({ pendingMismatch: null });
      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: [
            buildMismatchHandoverInstruction(
              affinity,
              open.targetId,
              ctx.state.sessionId,
              storybloqClientProfile().storyCommand,
            ),
            "",
            `Resolving the mismatch failed ${failures} times. Last failure: ${message}`,
          ].join("\n"),
          reminders: [],
          transitionedFrom: "PICK_TICKET",
        },
      };
    }
    ctx.writeState({ pendingMismatch: { ...open, controlFailures: failures } });
    return { action: "retry", instruction: message };
  }

  /**
   * Revalidate, then branch fresh from main and proceed with the pending pick.
   *
   * Revalidation is not optional: the offer can be a compaction old and the
   * ledger is shared, so the target may have been completed, blocked, deleted,
   * or claimed since. A stale pending record must never reach git.
   */
  private async handleNewBranchFromMain(ctx: StageContext, open: PendingMismatch): Promise<StageAdvance> {
    if (open.targetKind === "issue") {
      const revalidated = await this.revalidateIssue(ctx, open.targetId);
      if (revalidated.kind === "transient") {
        return this.controlFailure(ctx, open, revalidated.message);
      }
      if (revalidated.kind === "rejected") {
        ctx.writeState({ pendingMismatch: null });
        return revalidated.advance;
      }
      const branched = await this.branchFromMain(ctx, open, {
        canonicalId: revalidated.item.id,
        displayId: revalidated.item.displayId,
        title: revalidated.item.title,
        kind: "issue",
      });
      if (branched) return branched;
      return this.handleIssuePick(ctx, open.targetId);
    }

    const revalidated = await this.revalidateTicket(ctx, open.targetId);
    if (revalidated.kind === "transient") {
      return this.controlFailure(ctx, open, revalidated.message);
    }
    if (revalidated.kind === "rejected") {
      ctx.writeState({ pendingMismatch: null });
      return revalidated.advance;
    }
    const branched = await this.branchFromMain(ctx, open, {
      canonicalId: revalidated.item.id,
      displayId: revalidated.item.displayId,
      title: revalidated.item.title,
      kind: "ticket",
    });
    if (branched) return branched;
    return this.report(ctx, { completedAction: "ticket_picked", ticketId: open.targetId });
  }

  /** Returns a StageAdvance on failure, or null once the branch is in place. */
  private async branchFromMain(
    ctx: StageContext,
    open: PendingMismatch,
    target: BranchTarget,
  ): Promise<StageAdvance | null> {
    let recorded = open.attempt;
    const outcome = await performNewBranchFromMain(ctx.root, target, recorded, (attempt) => {
      recorded = attempt;
      // Write-ahead: on disk before git runs, so a crash in between leaves a
      // recoverable record rather than an orphan branch nobody can identify.
      ctx.writeState({ pendingMismatch: { ...open, attempt } });
    });

    if (!outcome.ok) {
      const carried: PendingMismatch = { ...open, attempt: outcome.attempt ?? recorded };
      // Both retryable and non-retryable outcomes go through the bounded
      // counter. A non-retryable conflict returned as a bare retry would repeat
      // forever until the generic stuckRetryCount bypass fired, which is
      // exactly the escape hatch this episode is supposed to make unnecessary.
      return this.controlFailure(ctx, carried, outcome.message);
    }

    ctx.writeState({
      pendingMismatch: null,
      git: {
        ...ctx.state.git,
        branch: outcome.refreshed.branch,
        expectedHead: outcome.refreshed.expectedHead,
        // ISS-922: a checkout relocates HEAD, so the finalization baseline follows it.
        itemBaseHead: outcome.refreshed.expectedHead,
        baseline: outcome.refreshed.baseline,
      },
    });
    return null;
  }

  private async revalidateTicket(
    ctx: StageContext,
    canonicalId: string,
  ): Promise<RevalidationResult<Ticket>> {
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      // Transient: the ledger could not be READ. That says nothing about the
      // target's eligibility, so the episode stays open and the failure counts
      // against its bound instead of resetting it.
      return { kind: "transient", message: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}.` };
    }
    const resolved = projectState.resolveTicketRef(canonicalId);
    if (resolved.kind !== "found") {
      return { kind: "rejected", advance: { action: "retry", instruction: `Ticket ${canonicalId} is no longer resolvable. Pick a different item.` } };
    }
    const ticket = resolved.item;
    const label = displayIdOf(ticket);
    if (isDeleted(ticket)) {
      return { kind: "rejected", advance: { action: "retry", instruction: `Ticket ${label} was deleted while the branch mismatch was pending. Pick a different item.` } };
    }
    const membership = this.enforceTargetMembership(ctx, ticket.id, label);
    if (membership) return { kind: "rejected", advance: membership };
    if (projectState.isBlocked(ticket)) {
      return { kind: "rejected", advance: { action: "retry", instruction: `Ticket ${label} became blocked while the branch mismatch was pending. Pick an unblocked item.` } };
    }
    if (ticket.status !== "open") {
      const claim = (ticket as Record<string, unknown>).claimedBySession;
      if (!(ticket.status === "inprogress" && claim === ctx.state.sessionId)) {
        return { kind: "rejected", advance: { action: "retry", instruction: `Ticket ${label} is now ${ticket.status}. Pick an open item.` } };
      }
    }
    const email = await gitUserEmail(ctx.root);
    if (ticket.claim) {
      const claimResult = canClaim(ticket, email ?? "", ctx.state.git?.branch ?? "unknown");
      if (!claimResult.allowed) {
        return { kind: "rejected", advance: { action: "retry", instruction: `Ticket ${label} was claimed by ${claimResult.claimedBy} while the branch mismatch was pending. Pick a different item.` } };
      }
    }
    return { kind: "ok", item: ticket };
  }

  private async revalidateIssue(
    ctx: StageContext,
    canonicalId: string,
  ): Promise<RevalidationResult<Issue>> {
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return { kind: "transient", message: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}.` };
    }
    const resolved = projectState.resolveIssueRef(canonicalId);
    if (resolved.kind !== "found") {
      return { kind: "rejected", advance: { action: "retry", instruction: `Issue ${canonicalId} is no longer resolvable. Pick a different item.` } };
    }
    const issue = resolved.item;
    const label = displayIdOf(issue);
    if (isDeleted(issue)) {
      return { kind: "rejected", advance: { action: "retry", instruction: `Issue ${label} was deleted while the branch mismatch was pending. Pick a different item.` } };
    }
    const membership = this.enforceTargetMembership(ctx, issue.id, label);
    if (membership) return { kind: "rejected", advance: membership };
    const targeted = isTargetedMode(ctx.state);
    if (issue.status !== "open" && !(targeted && issue.status === "inprogress")) {
      return { kind: "rejected", advance: { action: "retry", instruction: `Issue ${label} is now ${issue.status}. Pick an open item.` } };
    }
    return { kind: "ok", item: issue };
  }

  /** Apply the configured branch strategy. Returns a retry, or null on success. */
  private async applyStrategy(ctx: StageContext, target: BranchTarget): Promise<StageAdvance | null> {
    const outcome = await applyBranchStrategy(
      ctx.root,
      ctx.state.resolvedBranchStrategy ?? "current",
      ctx.state.git,
      target,
    );
    if (!outcome.ok) return { action: "retry", instruction: outcome.message };
    if (outcome.refreshed) {
      ctx.updateDraft({
        git: {
          ...ctx.state.git,
          branch: outcome.refreshed.branch,
          expectedHead: outcome.refreshed.expectedHead,
          // ISS-922: a checkout relocates HEAD, so the finalization baseline follows it.
          itemBaseHead: outcome.refreshed.expectedHead,
          baseline: outcome.refreshed.baseline,
        },
      });
    }
    return null;
  }

  // T-188 (split for ISS-759): remaining-empty check runs BEFORE resolution
  private targetsExhausted(ctx: StageContext): StageAdvance | null {
    if (!isTargetedMode(ctx.state)) return null;
    if (getRemainingTargets(ctx.state).length === 0) {
      return { action: "goto", target: "COMPLETE" };
    }
    return null;
  }

  // T-188 (split for ISS-759): membership check runs AFTER resolution, on the
  // resolved canonical id (targetWork is canonical per ISS-654)
  private enforceTargetMembership(ctx: StageContext, canonicalId: string, pickedLabel: string): StageAdvance | null {
    if (!isTargetedMode(ctx.state)) return null;
    const remaining = getRemainingTargets(ctx.state);
    if (!remaining.includes(canonicalId)) {
      return { action: "retry", instruction: `${pickedLabel} is not a remaining target. Pick from: ${remaining.join(", ")}.` };
    }
    return null;
  }
}
