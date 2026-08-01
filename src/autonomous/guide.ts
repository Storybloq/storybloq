import { displayIdOf } from "../core/resolver.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  deriveWorkspaceId,
  WORKFLOW_STATES,
  type GuideInput,
  type GuideOutput,
  type FullSessionState,
  type SessionSummary,
  type ContextAdvice,
  type WorkflowState,
  type SessionState,
} from "./session-types.js";
import {
  reconcileSessionReality,
  isClaimLost,
  describeClaimLoss,
  parseClaimEpoch,
  readTicketClaimState,
  type ClaimPreflightResult,
} from "./claim-preflight.js";
import { reconcileClaim } from "./claim-reconciliation.js";
import { reassertMcpServerIdentity } from "./mcp-registry.js";
import { serverRegistryBinder } from "./mcp-binding.js";
import { releaseClaimIfOwned } from "../core/claims.js";
import {
  createSession,
  deleteSession,
  writeSessionWithEvent,
  appendEvent,
  refreshLease,
  isLeaseExpired,
  findActiveSessionFull,
  findStaleSessions,
  findSessionById,
  findSessionByIdDetailed,
  describeSessionLookupFailure,
  sessionDir,
  withSessionLock,
  type SessionConfig,
  prepareForCompact,
  wasCompactionObserved,
  CLEARED_LIMIT_FIELDS,
  findResumableSession,
  readEvents,
  readSession,
  readSessionResilient,
  type ActiveSessionInfo,
} from "./session.js";
import { isFinishedOrphan, isOrphanCandidate, type OrphanCheckContext } from "./orphan-detector.js";
import { assertTransition } from "./state-machine.js";
import { evaluatePressure, pressureAfterCompaction } from "./context-pressure.js";
import { reviewRiskForTicket } from "./review-depth.js";
import {
  spawnAliveSidecar,
  killSidecar,
  writeShutdownMarker,
  computeBinaryFingerprint,
  captureClaudeCodeSessionId,
  telemetryDirPath,
} from "./liveness.js";
import { parseBranchStrategy, parseBranchStrategyOrDefault } from "./branch-strategy.js";
import { gitHead, gitHeadHash, gitStatus, gitMergeBase, gitDiffStat, gitDiffNames, gitDiffCachedNames, gitBlobHash, gitStash, gitStashPop, gitIsAncestor } from "./git-inspector.js";
import { resolveRecipe } from "./recipes/loader.js";
import { getStage, findNextStage, findFirstPostComplete, findNextPostComplete, type NextStageResult } from "./stages/registry.js";
import { StageContext, isStageAdvance, type StageAdvance, type StageResult } from "./stages/types.js";
import { PARK_ACTION, PARK_STAGES } from "./stages/park.js";
import "./stages/index.js"; // Register all extracted stages
import { writeCheckpoint } from "./telemetry-writer.js";

import { loadProject } from "../core/project-loader.js";
import { buildLessonDigest } from "../core/lessons.js";
import { loadLatestSnapshot } from "../core/snapshot.js";
import { buildRecap } from "../core/snapshot.js";
import { nextTickets } from "../core/queries.js";
import { recommend, type RecommendOptions } from "../core/recommend.js";
import { checkVersionMismatch, getInstalledVersion, getRunningVersion } from "./version-check.js";
import { writeResumeMarker, removeResumeMarker } from "./resume-marker.js";
import { refreshStatusForSession } from "./status-writer.js";
import { writeSessionAndRefresh, emitTelemetry, postStateWrite } from "./guide-effects.js";
import { auditOf, type TicketDisposition } from "./cancellation-transition.js";
import { formatCompactReport } from "../core/session-report-formatter.js";
import { isTargetedMode, getRemainingTargets, buildTargetedCandidatesText, buildTargetedPickInstruction, buildTargetedStuckHandover } from "./target-work.js";
import { buildAutoStartEventData, buildTieredStartEventData } from "./event-data.js";
import { resolveWorkId } from "./id-resolution.js";
import { checkAutonomousConflicts } from "./conflicts-guard.js";
import { detectBranchAffinity, buildAffinityAnnotation } from "./branch-affinity.js";
import {
  isSameOwnerTask,
  legacyClaudeSessionIdForOwner,
  ownerTaskForCurrentClient,
} from "./client-profile.js";
import { resolveSessionOwnership, unidentifiedCallerRemedy } from "./session-ownership.js";
import {
  handleHandoverLatest,
  handleHandoverCreate,
} from "../cli/commands/handover.js";
import type { CommandContext } from "../cli/types.js";

/**
 * ISS-899: whether this caller is refused, and WHY, which the call sites need
 * because the two reasons have different remedies. Precedence itself lives in
 * resolveSessionOwnership and is not restated here or anywhere else.
 */
interface OwnershipRefusal {
  readonly reason: string;
  readonly kind: "foreign" | "unidentified-caller";
}

function liveOwnershipConflict(
  state: FullSessionState,
  clientTaskId?: string,
  enforceAfterExpiry = false,
  // The expiry that decides ISS-899 cell (a) must be read from the state as the
  // CALLER found it. pre_compact refreshes the lease before it gets here, which
  // would make an expired session look live and sweep it into the ruled cell.
  leaseWasExpired: boolean = isLeaseExpired(state),
): OwnershipRefusal | null {
  const expired = isLeaseExpired(state);
  if (!enforceAfterExpiry && expired) return null;

  const ownership = resolveSessionOwnership(state, ownerTaskForCurrentClient(clientTaskId));

  if (ownership.kind === "foreign") {
    return { reason: `session is owned by ${ownership.ownerDescription}`, kind: "foreign" };
  }

  // ISS-899 cell (a). Narrow on BOTH axes, and both are load-bearing:
  //
  // - `via === "ownerTask"` only. The owner ruling covers sessions bearing an
  //   ownerTask. An ownerless session carrying a legacy claudeCodeSessionId met
  //   by an identityless caller is a separate cell nobody has ruled on, and it
  //   keeps failing open here exactly as it does today.
  // - Live lease only, checked SEPARATELY from the early return above. That
  //   return is skipped when enforceAfterExpiry is set (pre_compact does set
  //   it), which is correct for keeping foreign-owner checks alive past expiry
  //   but must not widen this cell: an expired session met by an identityless
  //   caller is accepted today and stays accepted.
  if (ownership.kind === "unidentified-caller" && ownership.via === "ownerTask" && !leaseWasExpired) {
    return {
      reason: `session is owned by ${ownership.ownerDescription}, and this task has no client task id to check against`,
      kind: "unidentified-caller",
    };
  }

  return null;
}

function adoptExpiredLease(
  root: string,
  dir: string,
  state: FullSessionState,
  clientTaskId: string | undefined,
  action: "report" | "pre_compact",
): { state: FullSessionState; adopted: boolean } {
  // ISS-899: deliberately NOT routed through resolveSessionOwnership. This asks
  // a different question -- "may this caller adopt an EXPIRED lease?" -- and it
  // checks ownerTask ALONE on purpose. Switching it to the shared verdict would
  // fold legacy-id sameness into the skip condition, so a legacy-same-owner
  // caller would stop adopting; that is an expired-lease behaviour change, and
  // expired leases are outside this issue's ruling. The claudeCodeSessionId read
  // below is event telemetry, not an ownership decision.
  const callerTask = ownerTaskForCurrentClient(clientTaskId);
  const actionCanAdopt = state.status === "active" &&
    state.state !== "COMPACT" &&
    state.state !== "SESSION_END" &&
    !(action === "pre_compact" && state.state === "FINALIZE");
  if (
    !actionCanAdopt ||
    !callerTask ||
    !isLeaseExpired(state) ||
    isSameOwnerTask(state.ownerTask, callerTask)
  ) {
    return { state, adopted: false };
  }

  const previousOwnerTask = state.ownerTask ?? (state.claudeCodeSessionId
    ? { client: "claude", id: state.claudeCodeSessionId }
    : null);
  const written = writeSessionAndRefresh(root, dir, refreshLease({
    ...state,
    ownerTask: callerTask,
    claudeCodeSessionId: legacyClaudeSessionIdForOwner(callerTask, state.claudeCodeSessionId),
  } as FullSessionState), "always");
  appendEvent(dir, {
    rev: written.revision,
    type: "owner_task_rebound",
    timestamp: new Date().toISOString(),
    data: {
      reason: "expired_lease",
      action,
      previousOwnerTask,
      ownerTask: callerTask,
    },
  });
  return { state: written, adopted: true };
}

// ---------------------------------------------------------------------------
// Recovery mapping — exported for test completeness checks (ISS-040)
// ---------------------------------------------------------------------------

export const RECOVERY_MAPPING: Readonly<Record<string, { state: string; resetPlan: boolean; resetCode: boolean }>> = {
  PICK_TICKET:    { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  COMPLETE:       { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  HANDOVER:       { state: "SESSION_END", resetPlan: false, resetCode: false },
  PLAN:           { state: "PLAN",        resetPlan: true,  resetCode: false },
  IMPLEMENT:      { state: "PLAN",        resetPlan: true,  resetCode: false },
  WRITE_TESTS:    { state: "PLAN",        resetPlan: true,  resetCode: false },
  BUILD:          { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  VERIFY:         { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  PLAN_REVIEW:    { state: "PLAN",        resetPlan: true,  resetCode: true  },
  TEST:           { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  CODE_REVIEW:    { state: "PLAN",        resetPlan: true,  resetCode: true  },
  FINALIZE:       { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
  LESSON_CAPTURE: { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  ISSUE_FIX:      { state: "ISSUE_FIX",   resetPlan: false, resetCode: false },  // T-208: self-recover to avoid dangling currentIssue
  ISSUE_SWEEP:    { state: "PICK_TICKET", resetPlan: false, resetCode: false },
};

// ---------------------------------------------------------------------------
// Recommend options builder (ISS-018, ISS-019)
// ---------------------------------------------------------------------------

async function buildGuideRecommendOptions(root: string): Promise<RecommendOptions> {
  const opts: { latestHandoverContent?: string; previousOpenIssueCount?: number; currentUser?: string } = {};

  try {
    const handoversDir = join(root, ".story", "handovers");
    const files = readdirSync(handoversDir, "utf-8").filter((f: string) => f.endsWith(".md")).sort();
    if (files.length > 0) {
      opts.latestHandoverContent = readFileSync(join(handoversDir, files[files.length - 1]), "utf-8");
    }
  } catch { /* no handovers */ }

  try {
    const snapshotsDir = join(root, ".story", "snapshots");
    const snapFiles = readdirSync(snapshotsDir, "utf-8").filter((f: string) => f.endsWith(".json")).sort();
    if (snapFiles.length > 0) {
      const raw = readFileSync(join(snapshotsDir, snapFiles[snapFiles.length - 1]), "utf-8");
      const snap = JSON.parse(raw) as { issues?: Array<{ status?: string }> };
      if (snap.issues) {
        opts.previousOpenIssueCount = snap.issues.filter((i) => i.status !== "resolved").length;
      }
    }
  } catch { /* no snapshots */ }

  try {
    const { gitUserEmail } = await import("./git-inspector.js");
    const email = await gitUserEmail(root);
    if (email) opts.currentUser = email;
  } catch { /* git not available */ }

  return opts;
}

// ---------------------------------------------------------------------------
// T-188: Shared helper for targeted resume paths (DRY across drift + clean)
// ---------------------------------------------------------------------------

async function buildTargetedResumeResult(
  root: string,
  state: FullSessionState,
  dir: string,
): Promise<{ instruction: string; stuck: boolean; allDone: boolean; candidatesText: string }> {
  const remaining = getRemainingTargets(state);

  // All targets completed -- not stuck, just done
  if (remaining.length === 0) {
    return { instruction: "", stuck: false, allDone: true, candidatesText: "" };
  }

  try {
    const { state: ps } = await loadProject(root);
    const { text: candidatesText, firstReady } = buildTargetedCandidatesText(remaining, ps);
    if (!firstReady) {
      return { instruction: "", stuck: true, allDone: false, candidatesText };
    }
    const precomputed = { text: candidatesText, firstReady };
    return {
      instruction: buildTargetedPickInstruction(remaining, ps, state.sessionId, precomputed),
      stuck: false,
      allDone: false,
      candidatesText,
    };
  } catch (err) {
    // Log the error for debuggability instead of swallowing silently
    try {
      appendEvent(dir, {
        rev: state.revision,
        type: "resume_load_error",
        timestamp: new Date().toISOString(),
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch { /* best-effort */ }
    // Fail-safe: end session rather than sending agent to PICK_TICKET blind
    const fallback = remaining.join(", ") + " (project state unavailable)";
    return { instruction: "", stuck: true, allDone: false, candidatesText: fallback };
  }
}

/**
 * Shared dispatch for targeted resume paths (DRY across drift + clean).
 * Checks stuck, routes to HANDOVER or PICK_TICKET with appropriate instruction.
 */
async function dispatchTargetedResume(
  root: string,
  state: FullSessionState,
  dir: string,
  headerLines: string[],
): Promise<McpToolResult> {
  const resumeResult = await buildTargetedResumeResult(root, state, dir);
  if (resumeResult.allDone) {
    return guideResult(state, "HANDOVER", {
      instruction: [
        `# Targeted Session Complete -- All ${state.targetWork.length} target(s) done`,
        "",
        "Write a session handover summarizing what was accomplished, decisions made, and what's next.",
        "",
        'Call `storybloq_autonomous_guide` with:',
        "```json",
        `{ "sessionId": "${state.sessionId}", "action": "report", "report": { "completedAction": "handover_written", "handoverContent": "..." } }`,
        "```",
      ].join("\n"),
      reminders: [],
    });
  }
  if (resumeResult.stuck) {
    return guideResult(state, "HANDOVER", {
      instruction: buildTargetedStuckHandover(resumeResult.candidatesText, state.sessionId),
      reminders: [],
    });
  }
  return guideResult(state, "PICK_TICKET", {
    instruction: [...headerLines, "", resumeResult.instruction].join("\n"),
    reminders: [
      "Do NOT stop or summarize. Pick the next target IMMEDIATELY.",
      "Do NOT ask the user for confirmation.",
      "You are in targeted auto mode -- pick ONLY from the listed items.",
    ],
  });
}

// ---------------------------------------------------------------------------
// Pending mutation recovery (ISS-024)
// ---------------------------------------------------------------------------

/**
 * T-442 claim preflight. Runs BEFORE recoverPendingMutation at the entry points
 * that can advance a session, because recovery replays a mutation prepared while
 * the session still believed it held the claim; replaying first would let a
 * session that has already lost the ticket write to it one more time.
 *
 * Only `report` and `resume` are gated. `pre_compact` and `cancel` must always
 * succeed -- refusing to cancel a session that lost its claim would strand it --
 * and their safety comes from releaseClaimIfOwned refusing to strip a claim the
 * session cannot prove is its own.
 */
async function reconcileClaimForGuide(
  root: string,
  state: FullSessionState,
): Promise<ClaimPreflightResult | null> {
  try {
    return await reconcileSessionReality(state as unknown as SessionState, {
      loadTicket: async (ticketId) => {
        const { state: projectState } = await loadProject(root, { strict: false });
        return projectState.ticketByID(ticketId) ?? null;
      },
    });
  } catch {
    // A loader failure is not evidence of a lost claim. Reconciliation already
    // fails closed on an unreadable TICKET; an unreadable PROJECT is a different
    // fault and must not masquerade as a claim conflict.
    return null;
  }
}

async function claimPreflightBlock(
  root: string,
  state: FullSessionState,
): Promise<McpToolResult | null> {
  const result = await reconcileClaimForGuide(root, state);
  if (!result || !isClaimLost(result)) return null;

  const ticketId = state.ticket?.displayId ?? state.ticket?.id ?? result.epoch?.ticketId ?? "unknown";
  return guideError(new Error(
    `Claim lost on ${ticketId}: ${describeClaimLoss(result)}. ` +
    "This session can no longer prove it owns the ticket, so it will not advance or complete it (ISS-784). " +
    `Write a handover, then cancel this session with { "sessionId": "${state.sessionId}", "action": "cancel" } ` +
    "and start a new session to pick different work.",
  ));
}

/**
 * ISS-904: has this session lost the claim it recorded? Used by cancel for two
 * separate decisions, and it is worth being explicit that they pull opposite
 * ways.
 *
 * 1. It stands the T-178 soft gate DOWN. That gate refuses cancel for any
 *    healthy auto-mode session with work remaining; a claim-lost session is not
 *    healthy, and `claimPreflightBlock` tells it in as many words to "write a
 *    handover, then cancel". The gate then refused that cancel and pointed back
 *    at `report`, which is the claim-loss guard again -- a closed cycle whose
 *    only exit was the admin CLI, dropping the rest of a targeted queue. The
 *    intent was already recorded at the preflight, which leaves `cancel`
 *    deliberately ungated because "refusing to cancel a session that lost its
 *    claim would strand it"; the gate simply never learned about claim loss.
 *
 * 2. It makes cancel's own ledger writes MORE restrictive, not less. Letting a
 *    claim-lost session through the gate would otherwise hand it two writes it
 *    has no right to: replaying a pending ticket mutation, and a claim release
 *    gated on the `claimedBySession` stamp with no epoch proof. Both are
 *    suppressed below, so the widened cancel path cannot become an ISS-784
 *    bypass. Ending the session must never mean writing on the way out.
 */
type CancelClaimPosture =
  /** No epoch key at all: a pre-T-442 session. The legacy release applies. */
  | "no-epoch"
  /** Epoch present and still reconciles as ours. Epoch-proven release applies. */
  | "held"
  /**
   * Ownership is not provable: suppresses every ledger write. NOTE this alone
   * does NOT stand the soft cancel gate down -- that decision is state-aware and
   * uses the pipeline's own reconciliation, because from FINALIZE onward a
   * session's authorized completion looks identical to a foreign one.
   */
  | "lost"
  /**
   * Cannot be determined: a present-but-malformed epoch, an unreadable project,
   * or a session that has moved off the ticket its epoch names. Suppresses every
   * ledger write, but does NOT stand the gate down -- an indeterminate reading
   * is not evidence that a healthy session should be allowed to abandon its
   * remaining work.
   */
  | "indeterminate";

/**
 * ISS-904: what may cancel do to the ledger for this session?
 *
 * Deliberately NOT `reconcileSessionReality`: that short-circuits to NOT_CHECKED
 * outside RECONCILED_STATES, and cancel is reachable from HANDOVER, COMPACT,
 * FINALIZE and COMPLETE -- exactly the states where a stale epoch would
 * otherwise read as "fine" and let cancel write to a ticket it no longer owns.
 * The state allowlist exists to stop the PIPELINE stalling at its own finish
 * line; it has no bearing on whether cancel may write.
 *
 * Absent and malformed are kept apart for the same reason claim-preflight.ts
 * keeps them apart: an absent epoch means a session that never gained the
 * ability to prove ownership, while a present-but-corrupt one belongs to a
 * session that DID acquire a claim. Collapsing them would route a corrupt epoch
 * into the legacy stamp-only release, which in a split claim strips the winner.
 */
async function cancelClaimPosture(
  root: string,
  state: FullSessionState,
): Promise<CancelClaimPosture> {
  const raw = (state as Record<string, unknown>).claimEpoch;
  if (raw === undefined || raw === null) return "no-epoch";

  const epoch = parseClaimEpoch(raw);
  if (!epoch) return "indeterminate";

  // FINALIZE clears the draft ticket but leaves the epoch behind, so at COMPLETE
  // the epoch names a ticket the session has legitimately finished with. Reading
  // that as claim loss would stand the soft gate down for a perfectly healthy
  // session and let it discard the rest of a targeted queue. Same guard as
  // reconcileSessionReality (claim-preflight.ts:153), and it is load-bearing here.
  if (!state.ticket || state.ticket.id !== epoch.ticketId) return "indeterminate";

  let ticket;
  try {
    const { state: projectState } = await loadProject(root, { strict: false });
    ticket = projectState.ticketByID(epoch.ticketId);
  } catch {
    return "indeterminate";
  }

  return reconcileClaim({
    epoch,
    ticket: readTicketClaimState(ticket),
    claimStalenessHours: 24,
    now: Date.now(),
  }).status === "held" ? "held" : "lost";
}

/**
 * Recover from a pending project mutation (crash between project write and session clear).
 * Called at the top of all entry points: handleReport, handleResume, handleCancel, handleStart.
 * Idempotent: checks actual ticket state before applying.
 */
async function recoverPendingMutation(
  dir: string,
  state: FullSessionState,
  root: string,
): Promise<FullSessionState> {
  const mutation = state.pendingProjectMutation;
  if (!mutation || typeof mutation !== "object") return state;
  const m = mutation as Record<string, unknown>;
  // ISS-090 + ISS-112: issue_update recovery with 3-way check (matches ticket_update pattern)
  if (m.type === "issue_update") {
    const targetId = m.target as string;
    const targetValue = m.value as string;
    const expectedCurrent = m.expectedCurrent as string | undefined;
    try {
      const { loadProject } = await import("../core/project-loader.js");
      const { state: projectState } = await loadProject(root);
      const issue = projectState.issues.find(i => i.id === targetId);
      if (issue) {
        if (issue.status === targetValue) {
          // Already applied -- clear marker
        } else if (expectedCurrent && issue.status === expectedCurrent) {
          // Safe to replay
          const { handleIssueUpdate } = await import("../cli/commands/issue.js");
          await handleIssueUpdate(targetId, { status: targetValue }, "json", root);
        } else {
          // Conflict: issue in unexpected state (e.g., manually resolved) -- do not revert
          appendEvent(dir, {
            rev: state.revision,
            type: "mutation_conflict",
            timestamp: new Date().toISOString(),
            data: { targetId, expected: expectedCurrent, actual: issue.status, transitionId: m.transitionId },
          });
        }
      }
    } catch { /* best-effort -- leave marker cleared regardless */ }
    const cleared = { ...state, pendingProjectMutation: null };
    return writeSessionAndRefresh(root, dir, cleared, "if-active");
  }

  if (m.type !== "ticket_update") return state;

  const targetId = m.target as string;
  const targetValue = m.value as string;
  const expectedCurrent = m.expectedCurrent as string | undefined;
  const postMutation = m.postMutation as Record<string, unknown> | undefined;

  let conflict = false;
  try {
    const { withProjectLock, writeTicketUnlocked } = await import("../core/project-loader.js");
    await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
      const ticket = projectState.ticketByID(targetId);
      if (!ticket) return;

      if (ticket.status === targetValue) {
        // Project write already succeeded — clear marker
      } else if (expectedCurrent && ticket.status === expectedCurrent) {
        // Replay the write
        const updated = { ...ticket, status: targetValue as typeof ticket.status };
        if (m.claimedBySession) {
          (updated as Record<string, unknown>).claimedBySession = m.claimedBySession;
        }
        await writeTicketUnlocked(updated, root);
      } else {
        // Ticket in unexpected state — conflict: clear marker, do NOT apply postMutation
        conflict = true;
        appendEvent(dir, {
          rev: state.revision,
          type: "mutation_conflict",
          timestamp: new Date().toISOString(),
          data: { targetId, expected: expectedCurrent, actual: ticket.status, transitionId: m.transitionId },
        });
        writeSessionAndRefresh(root, dir, { ...state, pendingProjectMutation: null } as FullSessionState, "if-active");
      }
    });
  } catch {
    // Lock/IO failure — leave marker for next attempt
    return state;
  }

  // Conflict detected — marker cleared, no postMutation applied
  if (conflict) {
    // Re-read the state we just wrote (with cleared marker).
    // ISS-556: this is called from handleAutonomousGuide — the exact function
    // whose incident motivated this fix. Use resilient read so historical
    // lensReviewHistory disposition corruption does not wedge the handler.
    const { readSessionResilient } = await import("./session.js");
    return readSessionResilient(dir) ?? state;
  }

  // Apply postMutation if present and session not already in target state
  const cleared: Record<string, unknown> = { ...state, pendingProjectMutation: null };
  if (postMutation) {
    const nextState = postMutation.nextSessionState as string | undefined;
    if (nextState && state.state !== nextState) {
      cleared.state = nextState;
      cleared.previousState = state.state;
      cleared.terminationReason = (postMutation.terminationReason as string) ?? null;
      if (postMutation.clearTicket) {
        cleared.ticket = undefined;
      }
    }
  }

  return writeSessionAndRefresh(root, dir, cleared as FullSessionState, "if-active");
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Deferred finding filing (ISS-037)
// ---------------------------------------------------------------------------

const SEVERITY_MAP: Record<string, string> = {
  critical: "critical",
  major: "high",
  minor: "medium",
};

// ISS-725: the deferred-finding filing logic that used to live here as a
// module-level fileDeferredFindings() was dead code (zero callers). The live
// path is StageContext.fileDeferredFindings (stages/types.ts), invoked from the
// code-review and plan-review stages, which then calls drainPendingDeferrals
// below. Only the still-live drain half remains.

/**
 * Attempt to file all pending deferrals. Called on handleReport, handleResume, handleReportHandover, session stop.
 */
async function drainPendingDeferrals(
  root: string,
  dir: string,
  state: FullSessionState,
): Promise<FullSessionState> {
  const pending = [...(state.pendingDeferrals ?? [])];
  if (pending.length === 0) return state;

  const filed = [...(state.filedDeferrals ?? [])];
  const remaining: typeof pending = [];

  for (const entry of pending) {
    try {
      const { handleIssueCreate } = await import("../cli/commands/issue.js");
      const severity = SEVERITY_MAP[entry.severity] ?? "medium";
      const title = `[${entry.category}] ${entry.description.slice(0, 80)}`;
      const result = await handleIssueCreate(
        { title, severity, impact: entry.description, components: ["autonomous"], relatedTickets: [], location: [] },
        "json",
        root,
      );
      // Extract issue ID from JSON output
      let issueId: string | undefined;
      try {
        const parsed = JSON.parse(result.output ?? "");
        issueId = parsed?.data?.id;
      } catch {
        // Fallback: regex match
        const match = result.output?.match(/ISS-\d+/);
        issueId = match?.[0];
      }
      if (issueId) {
        filed.push({ fingerprint: entry.fingerprint, issueId });
      } else {
        remaining.push(entry);
      }
    } catch {
      remaining.push(entry);
    }
  }

  const updated = { ...state, filedDeferrals: filed, pendingDeferrals: remaining };
  return writeSessionAndRefresh(root, dir, updated as FullSessionState, "if-active");
}

// ---------------------------------------------------------------------------
// MCP result type (matches tools.ts)
// ---------------------------------------------------------------------------

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Workspace mutex — in-process serialization
// ---------------------------------------------------------------------------

const workspaceLocks = new Map<string, Promise<void>>();

/**
 * Entry point for the autonomous guide MCP tool.
 * Serializes calls per workspace (in-process) and per filesystem (cross-process).
 *
 * Lock ordering note: The session lock (.story/sessions/.lock) is acquired first,
 * then loadProject/handleHandoverCreate may acquire the project lock (.story/.lock).
 * This ordering is consistent — no code path acquires them in reverse order.
 * The plan's "NEVER nest locks" rule is relaxed here for V1 pragmatism. The phased
 * commit protocol (pendingProjectMutation) will be implemented when the guide matures.
 */
export async function handleAutonomousGuide(
  root: string,
  args: GuideInput,
): Promise<McpToolResult> {
  // Ruling C-2 item 1: RE-ASSERT this server's registry identity from the
  // request-scoped `clientTaskId`. This seam is not an optimization, it is the
  // only path a Codex identity can arrive by: `setup-skill` injects just
  // STORYBLOQ_CLIENT=codex into the server env, so a Codex server registers
  // identity-null at startup and would stay unattributable forever otherwise,
  // making every session it owns resolve to `undetermined`. It also REPAIRS an
  // entry that is gone or no longer carries the right identity, which is why it
  // costs one file read per guide call rather than a map lookup: our own memory
  // being right is no comfort to the process that has to read the file. It
  // writes only when the entry on disk does not already say what it should, so
  // it is identity repair rather than a full validation of the file.
  //
  // A verification failure is REPORTED to the binder, not swallowed. If the
  // entry cannot be proven present and correct, this process is registered in
  // name only: still stamping its pid onto the sessions it serves, on the
  // strength of an entry we could not corroborate. The binder demotes it and retries, exactly as it would for
  // a failed startup bind.
  //
  // A throw from the binder itself IS suppressed, and that asymmetry is the
  // point: a registry write is a side effect of serving, never a precondition
  // for it, so there is nothing left to try and the guide call proceeds.
  try {
    if (!reassertMcpServerIdentity(root, ownerTaskForCurrentClient(args.clientTaskId))) {
      serverRegistryBinder.registrationLost(root);
    }
  } catch {
    try { serverRegistryBinder.registrationLost(root); } catch { /* nothing left to try */ }
  }

  const wsId = deriveWorkspaceId(root);
  const prev = workspaceLocks.get(wsId) ?? Promise.resolve();

  const current = prev.then(async () => {
    return withSessionLock(root, () => handleGuideInner(root, args));
  });

  // Store promise chain (swallow errors to prevent blocking future calls)
  // Prune entry after completion to prevent memory leak on long-running servers
  workspaceLocks.set(wsId, current.then(() => {}, () => {}));

  try {
    return await current;
  } catch (err) {
    return guideError(err);
  } finally {
    // Prune if this was the last queued call
    const stored = workspaceLocks.get(wsId);
    if (stored) {
      stored.then(() => {
        if (workspaceLocks.get(wsId) === stored) {
          workspaceLocks.delete(wsId);
        }
      }, () => {
        if (workspaceLocks.get(wsId) === stored) {
          workspaceLocks.delete(wsId);
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Inner handler (under both locks)
// ---------------------------------------------------------------------------

async function handleGuideInner(root: string, args: GuideInput): Promise<McpToolResult> {
  // T-188: targetWork is only valid on start action
  if (args.targetWork?.length && args.action !== "start") {
    return guideError(new Error(`targetWork is only valid with action "start". Got action "${args.action}".`));
  }
  if (args.takeover && args.action !== "resume") {
    return guideError(new Error(`takeover is only valid with action "resume". Got action "${args.action}".`));
  }
  switch (args.action) {
    case "start":
      return handleStart(root, args);
    case "report":
      return handleReport(root, args);
    case "resume":
      return handleResume(root, args);
    case "pre_compact":
      return handlePreCompact(root, args);
    case "cancel":
      return handleCancel(root, args);
    default:
      return guideError(new Error(`Unknown action: ${args.action}`));
  }
}

// ---------------------------------------------------------------------------
// T-250 — auto-supersede verifiably-finished orphan sessions
// ---------------------------------------------------------------------------

/**
 * Check whether `info` looks like a finished orphan and, if so, mark it
 * `superseded` with the rich `auto_superseded_finished_orphan` reason. Emits
 * an audit event and a stderr diagnostic line. Returns the written state on
 * success, or null when the check fails or the write raced another caller.
 */
async function trySupersedeFinishedOrphan(
  info: ActiveSessionInfo,
  root: string,
  ctx?: OrphanCheckContext,
): Promise<FullSessionState | null> {
  const ok = await isFinishedOrphan(info.state, info.dir, root, ctx);
  if (!ok) return null;

  // ISS-382: explicit narrowing on lease.expiresAt. isOrphanCandidate (called
  // inside isFinishedOrphan) already guarantees a finite expiresAt here, but
  // re-validating locally keeps this site robust to upstream refactors.
  const expiresAtRaw = info.state.lease?.expiresAt;
  const expiresAtMs = expiresAtRaw ? new Date(expiresAtRaw).getTime() : NaN;
  if (!Number.isFinite(expiresAtMs)) return null;
  const leaseExpiredMinutesAgo = Math.round((Date.now() - expiresAtMs) / 60000);

  // Atomic audit+state write: appends the auto_superseded event with the
  // prospective post-write revision, then writeSessionSync increments to
  // that revision. If the state write throws, events.log is rolled back
  // to pre-append size so the pair is all-or-nothing.
  let written: FullSessionState;
  try {
    written = writeSessionWithEvent(
      info.dir,
      {
        ...info.state,
        status: "superseded" as const,
        terminationReason: "auto_superseded_finished_orphan" as const,
      },
      {
        rev: info.state.revision + 1,
        type: "auto_superseded",
        timestamp: new Date().toISOString(),
        data: {
          reason: "finished_orphan",
          targetWork: [...info.state.targetWork],
          leaseExpiredMinutesAgo,
        },
      },
    );
    // T-260: Cross-process finalization (marker only, no PID kill)
    writeShutdownMarker(info.dir);
  } catch {
    return null;
  }

  process.stderr.write(
    "[T-250] auto-superseded finished-orphan session " +
      info.state.sessionId +
      " targets=" +
      info.state.targetWork.join(",") +
      " leaseExpiredMinutesAgo=" +
      leaseExpiredMinutesAgo +
      "\n",
  );

  return written;
}

// ---------------------------------------------------------------------------
// start — INIT + LOAD_CONTEXT → PICK_TICKET
// ---------------------------------------------------------------------------

async function handleStart(root: string, args: GuideInput): Promise<McpToolResult> {
  // ISS-024: recover pending mutations on existing sessions before checking
  let existing = findActiveSessionFull(root);
  if (existing && !isLeaseExpired(existing.state)) {
    // ISS-899 cell (a): refuse BEFORE recovery, not after. recoverPendingMutation
    // replays another task's pending session and project writes, so a refusal
    // that fires later has already let an unidentifiable caller mutate state.
    //
    // ONLY the newly ruled cell is hoisted here. The identified-foreign
    // sequence deliberately keeps recovery first: those callers complete or
    // clear the pending mutation today, and moving their refusal earlier would
    // delete writes they currently make. That is a separate decision with its
    // own breakage analysis, not this one.
    const preRecoveryConflict = liveOwnershipConflict(existing.state, args.clientTaskId);
    if (preRecoveryConflict?.kind === "unidentified-caller") {
      return guideError(new Error(
        `Cannot start: ${preRecoveryConflict.reason}.\n` +
        unidentifiedCallerRemedy(existing.state.sessionId),
      ));
    }
    await recoverPendingMutation(existing.dir, existing.state, root);
    // Re-read after recovery — session may have been ended by postMutation
    existing = findActiveSessionFull(root);
  }
  if (existing && !isLeaseExpired(existing.state)) {
    // ISS-032: compactPending sessions always block with specific recovery instructions
    if (existing.state.compactPending) {
      const preparedAt = existing.state.compactPreparedAt ? new Date(existing.state.compactPreparedAt).getTime() : 0;
      const staleThreshold = 60 * 60 * 1000; // 1 hour
      const isStale = Date.now() - preparedAt > staleThreshold;
      const ownershipConflict = liveOwnershipConflict(existing.state, args.clientTaskId);
      const callerTask = ownerTaskForCurrentClient(args.clientTaskId);
      const taskArg = callerTask ? `, "clientTaskId": "${callerTask.id}"` : "";
      if (ownershipConflict) {
        return guideError(new Error(
          `Compacted session ${existing.state.sessionId} is owned by another live task. ` +
          "Open or message its owner first. Recovery from another task requires the " +
          "explicit owner-gone confirmation flow.",
        ));
      }
      if (isStale) {
        return guideError(new Error(
          `Stale compacted session ${existing.state.sessionId} found (prepared ${Math.round((Date.now() - preparedAt) / 60000)} minutes ago, never resumed). ` +
          `SessionStart hook is no longer prompting for this session.\n` +
          `- To resume anyway: {"sessionId":"${existing.state.sessionId}","action":"resume"${taskArg}}\n` +
          `- To abandon and start fresh: run "storybloq session stop ${existing.state.sessionId}"`,
        ));
      }
      return guideError(new Error(
        `Active session ${existing.state.sessionId} is awaiting compaction resume.\n` +
        `- To continue: {"sessionId":"${existing.state.sessionId}","action":"resume"${taskArg}}\n` +
        `- To abandon: run "storybloq session stop ${existing.state.sessionId}"`,
      ));
    }
    return guideError(new Error(
      `Active session ${existing.state.sessionId} already exists for this workspace. ` +
      `Continue from its owning client task. Action "resume" is only valid after the session enters COMPACT; ` +
      `use "cancel" only when the running task should be ended.`,
    ));
  }

  // ISS-032: Also check for compactPending sessions with expired leases
  // (findActiveSessionFull filters expired leases, so compacted sessions >45min old are invisible)
  if (!existing) {
    const resumable = findResumableSession(root);
    if (resumable) {
      // T-250: finished-orphan auto-supersede — silently reclaim the slot if
      // every targeted work item is verifiably complete on disk and every
      // recorded commit is already in HEAD.
      const superseded = await trySupersedeFinishedOrphan(resumable.info, root);
      if (!superseded) {
        const sid = resumable.info.state.sessionId;
        const preparedAt = resumable.info.state.compactPreparedAt ? new Date(resumable.info.state.compactPreparedAt).getTime() : 0;
        return guideError(new Error(
          `${resumable.stale ? "Stale c" : "C"}ompacted session ${sid} found (prepared ${Math.round((Date.now() - preparedAt) / 60000)} minutes ago, lease expired but not resumed).\n` +
          `- To resume: call action "resume" with sessionId "${sid}"\n` +
          `- To abandon: run "storybloq session stop ${sid}"`,
        ));
      }
    }
  }

  // Supersede any stale sessions (findActiveSessionFull filters these out, so scan separately)
  // T-250: two-pass loop. First pass runs the finished-orphan check and writes
  // the rich terminationReason. Second pass re-reads state via readSession to
  // avoid clobbering that reason with a pre-supersede snapshot when the
  // generic fallback runs on entries the orphan pass left alone.
  // ISS-383: hoist loadProject + git rev-parse out of the per-session loop.
  // The cheap isOrphanCandidate precheck filters out sessions that can't
  // possibly be finished orphans (wrong mode, no targetWork, lease still
  // fresh) so we only pay the load cost when at least one candidate exists.
  const staleSessions = findStaleSessions(root);
  let staleOrphanCtx: OrphanCheckContext | undefined;
  if (staleSessions.some((s) => isOrphanCandidate(s.state))) {
    try {
      const { state: projectState } = await loadProject(root);
      const headResult = await gitHeadHash(root);
      if (headResult.ok) {
        staleOrphanCtx = { projectState, headSha: headResult.data };
      }
    } catch {
      // Fall through with undefined ctx — trySupersedeFinishedOrphan will
      // load on demand per session, matching pre-ISS-383 behavior.
    }
  }
  const autoSupersededIds = new Set<string>();
  for (const stale of staleSessions) {
    const result = await trySupersedeFinishedOrphan(stale, root, staleOrphanCtx);
    if (result) autoSupersededIds.add(stale.state.sessionId);
  }
  for (const stale of staleSessions) {
    if (autoSupersededIds.has(stale.state.sessionId)) continue;
    // ISS-556: MCP-facing stale-session cleanup. A single peer session with
    // historical lensReviewHistory disposition corruption must not block
    // supersede — use resilient read.
    const current = readSessionResilient(stale.dir);
    if (!current || current.status !== "active") continue;
    writeSessionAndRefresh(root, stale.dir, { ...current, status: "superseded" as const } as FullSessionState, "always");
    writeShutdownMarker(stale.dir);
  }

  // ISS-076: Version mismatch advisory
  const versionWarning = checkVersionMismatch(getRunningVersion(), getInstalledVersion());

  const wsId = deriveWorkspaceId(root);

  // Determine session mode
  const mode = args.mode ?? "auto";

  // Non-auto modes require ticketId
  if (mode !== "auto" && !args.ticketId) {
    return guideError(new Error(
      `Mode "${mode}" requires a ticketId. Call with: { "action": "start", "mode": "${mode}", "ticketId": "T-XXX" }`,
    ));
  }

  // T-188: Targeted mode validation (before session creation)
  const rawTargetWork = args.targetWork ?? [];
  let validatedTargetWork: string[] = [];
  let validatedTargetWorkDisplayIds: Record<string, string> = {};
  let skippedTargets: string[] = [];
  let targetProjectState: Awaited<ReturnType<typeof loadProject>>["state"] | undefined;
  if (rawTargetWork.length > 0) {
    if (mode !== "auto") {
      return guideError(new Error(
        `Targeted mode requires auto mode. Cannot combine targetWork with mode "${mode}".`,
      ));
    }
    // Validate all IDs exist
    try {
      ({ state: targetProjectState } = await loadProject(root));
    } catch (err) {
      return guideError(new Error(`Cannot validate targetWork: ${err instanceof Error ? err.message : "project load failed"}`));
    }
    const invalidIds: string[] = [];
    const alreadyDone: string[] = [];
    const resolvedCanonical: string[] = [];
    const displayIdMap: Record<string, string> = {};
    for (const id of rawTargetWork) {
      const resolution = resolveWorkId(id, targetProjectState);
      const canonicalId = resolution.canonicalId;

      const issueResult = targetProjectState.resolveIssueRef(canonicalId);
      if (issueResult.kind === "found") {
        if (issueResult.item.status === "resolved") { alreadyDone.push(canonicalId); continue; }
        resolvedCanonical.push(canonicalId);
        if (resolution.displayId !== canonicalId) displayIdMap[canonicalId] = resolution.displayId;
        continue;
      }

      const ticketResult = targetProjectState.resolveTicketRef(canonicalId);
      if (ticketResult.kind === "found") {
        if (ticketResult.item.status === "complete") { alreadyDone.push(canonicalId); continue; }
        resolvedCanonical.push(canonicalId);
        if (resolution.displayId !== canonicalId) displayIdMap[canonicalId] = resolution.displayId;
        continue;
      }

      invalidIds.push(id);
    }
    if (invalidIds.length > 0) {
      return guideError(new Error(
        `Invalid target IDs: ${invalidIds.join(", ")}. Use T-XXX for tickets or ISS-XXX for issues.`,
      ));
    }
    validatedTargetWork = [...new Set(resolvedCanonical.filter(id => !alreadyDone.includes(id)))];
    validatedTargetWorkDisplayIds = Object.fromEntries(
      Object.entries(displayIdMap).filter(([k]) => validatedTargetWork.includes(k)),
    );
    skippedTargets = alreadyDone;
    if (validatedTargetWork.length === 0) {
      const doneMsg = alreadyDone.length > 0
        ? ` (already done: ${alreadyDone.join(", ")})`
        : "";
      return guideError(new Error(`All target items are already complete${doneMsg}. Nothing to do.`));
    }
  }

  // Read recipe + config overrides from project (reuse targetProjectState if available from T-188 validation)
  let recipe = "coding";
  let sessionConfig: SessionConfig = { mode };
  try {
    const configState = targetProjectState ?? (await loadProject(root)).state;
    const projectConfig = configState.config as Record<string, unknown>;
    if (typeof projectConfig.recipe === "string") recipe = projectConfig.recipe;
    if (projectConfig.recipeOverrides && typeof projectConfig.recipeOverrides === "object") {
      const overrides = projectConfig.recipeOverrides as Record<string, unknown>;
      if (typeof overrides.maxTicketsPerSession === "number") sessionConfig.maxTicketsPerSession = overrides.maxTicketsPerSession;
      if (typeof overrides.compactThreshold === "string") sessionConfig.compactThreshold = overrides.compactThreshold;
      if (Array.isArray(overrides.reviewBackends)) sessionConfig.reviewBackends = overrides.reviewBackends as string[];
      if (Array.isArray(overrides.codexReviewBackends)) sessionConfig.codexReviewBackends = overrides.codexReviewBackends as string[];
      if (typeof overrides.handoverInterval === "number") sessionConfig.handoverInterval = overrides.handoverInterval;
      // T-328: one parser instead of a hand-maintained value list, so a new
      // strategy cannot be accepted everywhere except here.
      const parsedStrategy = parseBranchStrategy(overrides.branchStrategy);
      if (parsedStrategy) sessionConfig.branchStrategy = parsedStrategy;
      if (overrides.stages && typeof overrides.stages === "object") {
        sessionConfig.stageOverrides = overrides.stages as Record<string, Record<string, unknown>>;
      }
    }
  } catch { /* best-effort — use defaults */ }

  // Guided mode: force single ticket
  if (mode === "guided") {
    sessionConfig.maxTicketsPerSession = 1;
  }

  // T-188: Targeted mode: cap = target count (safety net; remaining-count is authoritative)
  if (validatedTargetWork.length > 0) {
    sessionConfig.maxTicketsPerSession = validatedTargetWork.length;
  }

  // Resolve recipe into frozen pipeline configuration
  const resolvedRecipe = resolveRecipe(recipe, {
    maxTicketsPerSession: sessionConfig.maxTicketsPerSession,
    compactThreshold: sessionConfig.compactThreshold,
    reviewBackends: sessionConfig.reviewBackends,
    codexReviewBackends: sessionConfig.codexReviewBackends,
    stages: sessionConfig.stageOverrides,
    branchStrategy: sessionConfig.branchStrategy,
  });

  // T-183: Clean stale resume marker before creating a new session
  removeResumeMarker(root);

  // Create session — wrapped in try/finally for cleanup on failure
  const session = createSession(root, recipe, wsId, sessionConfig);
  const dir = sessionDir(root, session.sessionId);
  const ownerTask = ownerTaskForCurrentClient(args.clientTaskId, session.startedAt);
  let sidecarPid: number | undefined;

  // ISS-412: Cleanup helper for early-exit error paths.
  // Handles sidecar teardown when spawned, plus session directory removal.
  const abortSession = (): void => {
    if (sidecarPid !== undefined) {
      killSidecar(sidecarPid);
      writeShutdownMarker(dir);
    }
    deleteSession(root, session.sessionId);
  };

  try {
    // Check git state
    const headResult = await gitHead(root);
    if (!headResult.ok) {
      abortSession();
      return guideError(new Error("This directory is not a git repository or git is not available. Autonomous mode requires git."));
    }

    // Check for staged changes (review mode skips — dirty tree allowed)
    if (mode !== "review") {
      const stagedResult = await gitDiffCachedNames(root);
      if (stagedResult.ok && stagedResult.data.length > 0) {
        abortSession();
        return guideError(new Error(
          `Cannot start: ${stagedResult.data.length} staged file(s). Unstage with \`git restore --staged .\` or commit them first, then call start again.\n\nStaged: ${stagedResult.data.join(", ")}`,
        ));
      }
    }

    // T-125: Track auto-stash if dirty files are stashed
    let autoStashRef: { ref: string; stashedAt: string } | null = null;

    // Capture git baseline
    const statusResult = await gitStatus(root);
    // Try common default branch names for merge-base
    let mergeBaseResult = await gitMergeBase(root, "main");
    if (!mergeBaseResult.ok) mergeBaseResult = await gitMergeBase(root, "master");

    // Parse dirty tracked files from porcelain output and get blob hashes
    const porcelainLines = statusResult.ok ? statusResult.data : [];
    const dirtyTracked: Record<string, { blobHash: string }> = {};
    const untrackedPaths: string[] = [];
    for (const line of porcelainLines) {
      if (line.startsWith("??")) {
        untrackedPaths.push(line.slice(3).trim());
      } else if (line.length > 3) {
        // Tracked file with modifications (M, A, D, R, C, etc.)
        const filePath = line.slice(3).trim();
        // Skip .story/ files — managed by storybloq, always safe to have dirty
        if (filePath.startsWith(".story/")) continue;
        const hashResult = await gitBlobHash(root, filePath);
        dirtyTracked[filePath] = { blobHash: hashResult.ok ? hashResult.data : "" };
      }
    }

    // T-125: Dirty-file handling — stash or block based on recipe config
    // Review mode: dirty tree allowed (user has code ready for review)
    if (Object.keys(dirtyTracked).length > 0 && mode !== "review") {
      const dirtyFileHandling = resolvedRecipe.dirtyFileHandling ?? "block";
      if (dirtyFileHandling === "stash") {
        const stashMessage = `storybloq-auto-${session.sessionId}`;
        const stashResult = await gitStash(root, stashMessage);
        if (!stashResult.ok) {
          abortSession();
          return guideError(new Error(
            `Cannot auto-stash dirty files: ${stashResult.message}. ` +
            `Stash or commit changes manually, then call start again.`,
          ));
        }
        // Record stash ref in session for restore on completion/cancel
        autoStashRef = { ref: stashResult.data, stashedAt: new Date().toISOString() };
      } else {
        // "block" (default) — existing behavior
        abortSession();
        const dirtyFiles = Object.keys(dirtyTracked).join(", ");
        return guideError(new Error(
          `Cannot start: ${Object.keys(dirtyTracked).length} dirty tracked file(s): ${dirtyFiles}. ` +
          `Create a feature branch or stash changes first, then call start again.`,
        ));
      }
    }

    let updated: FullSessionState = {
      ...session,
      state: "PICK_TICKET",
      previousState: "INIT",
      git: {
        branch: headResult.data.branch,
        initHead: headResult.data.hash,
        mergeBase: mergeBaseResult.ok ? mergeBaseResult.data : null,
        expectedHead: headResult.data.hash,
        // ISS-922: the finalization baseline starts where the session starts.
        itemBaseHead: headResult.data.hash,
        baseline: {
          porcelain: porcelainLines,
          dirtyTrackedFiles: dirtyTracked,
          untrackedPaths,
        },
        autoStash: autoStashRef,
      },
      // T-188: Targeted auto mode
      targetWork: validatedTargetWork,
      targetWorkDisplayIds: validatedTargetWorkDisplayIds,
      // T-128: Freeze resolved recipe for session lifetime (survives compact/resume)
      resolvedPipeline: resolvedRecipe.pipeline,
      resolvedPostComplete: resolvedRecipe.postComplete,
      resolvedRecipeId: resolvedRecipe.id,
      resolvedStages: resolvedRecipe.stages as Record<string, Record<string, unknown>>,
      resolvedDirtyFileHandling: resolvedRecipe.dirtyFileHandling,
      resolvedBranchStrategy: resolvedRecipe.branchStrategy,
      resolvedDefaults: {
        maxTicketsPerSession: resolvedRecipe.defaults.maxTicketsPerSession,
        compactThreshold: resolvedRecipe.defaults.compactThreshold,
        reviewBackends: [...resolvedRecipe.defaults.reviewBackends],
        codexReviewBackends: resolvedRecipe.defaults.codexReviewBackends
          ? [...resolvedRecipe.defaults.codexReviewBackends]
          : undefined,
      },
      ownerTask,
    };

    // T-124/T-139: Capture test baseline if TEST or WRITE_TESTS stage is enabled
    const testConfig = resolvedRecipe.stages?.TEST as Record<string, unknown> | undefined;
    const writeTestsConfig = resolvedRecipe.stages?.WRITE_TESTS as Record<string, unknown> | undefined;
    const testEnabled = testConfig?.enabled && resolvedRecipe.pipeline.includes("TEST");
    const writeTestsEnabled = writeTestsConfig?.enabled && resolvedRecipe.pipeline.includes("WRITE_TESTS");
    // Skip baseline capture for plan mode — it exits at PLAN_REVIEW and never reaches TEST/WRITE_TESTS
    if ((testEnabled || writeTestsEnabled) && mode !== "plan") {
      // T-139: Use WRITE_TESTS command when it's the requesting stage, else TEST command
      const writeTestsCommand = writeTestsConfig?.command as string | undefined;
      const testStageCommand = testConfig?.command as string | undefined;
      const testCommand = writeTestsEnabled
        ? (writeTestsCommand ?? testStageCommand)
        : testStageCommand;

      // Guard: if both stages enabled with different effective commands, baseline is ambiguous
      const effectiveWriteCmd = writeTestsCommand ?? testStageCommand ?? "npm test";
      const effectiveTestCmd = testStageCommand ?? "npm test";
      if (testEnabled && writeTestsEnabled && effectiveWriteCmd !== effectiveTestCmd) {
        abortSession();
        return guideError(new Error(
          `WRITE_TESTS and TEST stages use different commands ("${effectiveWriteCmd}" vs "${effectiveTestCmd}"). ` +
          `They share a single test baseline, so commands must match. Use the same command for both or disable one.`,
        ));
      }
      if (!testCommand) {
        abortSession();
        return guideError(new Error("TEST/WRITE_TESTS stage is enabled but no test command is configured. Set stages.TEST.command or stages.WRITE_TESTS.command in config.json recipeOverrides or the recipe file."));
      }
      // Capture baseline
      try {
        const { exec: execCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(execCb);
        const result = await execAsync(testCommand, { cwd: root, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }).catch((err: { code?: number; stdout?: string; stderr?: string }) => ({
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
          exitCode: err.code ?? 1,
        }));
        const exitCode = "exitCode" in result ? (result.exitCode as number) : 0;
        // Parse combined stdout+stderr — test runners (Jest, Vitest, Mocha) print to stderr on failure
        const rawOut = "stdout" in result ? String(result.stdout) : "";
        const rawErr = "stderr" in result ? String((result as Record<string, unknown>).stderr) : "";
        const combined = rawOut + "\n" + rawErr;
        const passMatch = combined.match(/(\d+)\s*pass/i);
        const failMatch = combined.match(/(\d+)\s*fail/i);
        const passCount = passMatch ? parseInt(passMatch[1]!, 10) : -1;
        // When all tests pass, vitest omits the fail line entirely. Treat missing fail count as 0
        // when exit code is 0 and passes were detected (runner succeeded, just no failures to report).
        const failCount = failMatch ? parseInt(failMatch[1]!, 10) : (exitCode === 0 && passCount > 0 ? 0 : -1);
        const output = combined.slice(-500);
        updated = { ...updated, testBaseline: { exitCode, passCount, failCount, summary: output } };

        // T-139: WRITE_TESTS requires parseable baseline — fail fast if not available
        if (writeTestsEnabled && failCount < 0) {
          abortSession();
          return guideError(new Error(
            "WRITE_TESTS stage is enabled but test baseline could not parse fail counts from test output. " +
            "Configure a test reporter that outputs pass/fail counts, or disable WRITE_TESTS.",
          ));
        }
      } catch {
        // Non-blocking for TEST-only. But WRITE_TESTS requires baseline.
        if (writeTestsEnabled) {
          abortSession();
          return guideError(new Error(
            "WRITE_TESTS stage is enabled but test baseline capture failed. Ensure the test command runs successfully.",
          ));
        }
      }
    }

    // T-131: INIT validation for VERIFY stage
    const verifyConfig = resolvedRecipe.stages?.VERIFY as Record<string, unknown> | undefined;
    if (verifyConfig?.enabled && resolvedRecipe.pipeline.includes("VERIFY")) {
      const startCmd = (verifyConfig.startCommand as string | undefined) ?? "npm run dev";
      const readinessUrl = verifyConfig.readinessUrl as string | undefined;
      if (!startCmd.trim()) {
        abortSession();
        return guideError(new Error("VERIFY stage is enabled but stages.VERIFY.startCommand is empty."));
      }
      if (readinessUrl) {
        try {
          const parsed = new URL(readinessUrl);
          if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
            abortSession();
            return guideError(new Error(`VERIFY stage readinessUrl must be localhost. Got: "${readinessUrl}".`));
          }
        } catch {
          abortSession();
          return guideError(new Error(`VERIFY stage readinessUrl is not a valid URL: "${readinessUrl}".`));
        }
      }
    }

    // T-260: Liveness infrastructure
    const fp = computeBinaryFingerprint();
    const ccSessionId = ownerTask
      ? legacyClaudeSessionIdForOwner(ownerTask, null)
      : captureClaudeCodeSessionId();
    try {
      sidecarPid = spawnAliveSidecar(telemetryDirPath(dir));
    } catch { /* best-effort */ }
    updated = {
      ...updated,
      binaryFingerprint: fp,
      claudeCodeSessionId: ccSessionId,
      sidecarPid: sidecarPid ?? null,
    };

    // Load context
    const { state: projectState, warnings } = await loadProject(root);

    const conflictsError = checkAutonomousConflicts(projectState);
    if (conflictsError) {
      abortSession();
      return guideError(new Error(conflictsError));
    }

    const handoversDir = join(root, ".story", "handovers");
    const ctx: CommandContext = { state: projectState, warnings, root, handoversDir, format: "md" };

    // Get handovers
    let handoverText = "";
    try {
      const handoverResult = await handleHandoverLatest(ctx, 3);
      handoverText = handoverResult.output;
    } catch { /* best-effort */ }

    // Get recap
    let recapText = "";
    try {
      const snapshotInfo = await loadLatestSnapshot(root);
      const recap = await buildRecap(projectState, snapshotInfo, root);
      if (recap.changes) {
        recapText = "Changes since last snapshot available.";
      }
    } catch { /* best-effort */ }

    // Read project files
    const rulesText = readFileSafe(join(root, "RULES.md"));
    // T-134: Lessons are the product feature for process knowledge.
    // Project-specific files (like WORK_STRATEGIES.md) are handled by CLAUDE.md.
    const lessonDigest = buildLessonDigest(projectState.lessons);

    // Write context digest
    const digestParts = [
      handoverText ? `## Recent Handovers\n\n${handoverText}` : "",
      recapText ? `## Recap\n\n${recapText}` : "",
      rulesText ? `## Development Rules\n\n${rulesText}` : "",
      lessonDigest ? lessonDigest.replace(/^# /m, "## ") : "",
    ].filter(Boolean);
    const digest = digestParts.join("\n\n---\n\n");
    try {
      writeFileSync(join(dir, "context-digest.md"), digest, "utf-8");
    } catch { /* best-effort */ }

    // --- Tiered mode: non-auto modes skip PICK_TICKET and enter at specific stage ---
    if (mode !== "auto" && args.ticketId) {
      const ticketResolution = resolveWorkId(args.ticketId!, projectState);
      const ticket = projectState.ticketByID(ticketResolution.canonicalId);
      if (!ticket) {
        abortSession();
        return guideError(new Error(`Ticket ${args.ticketId} not found.`));
      }

      // Validate ticket is workable (same checks as PICK_TICKET)
      if (mode !== "review") {
        if (ticket.status === "complete") {
          abortSession();
          return guideError(new Error(`Ticket ${ticketResolution.displayId} is already complete.`));
        }
        if (projectState.isBlocked(ticket)) {
          abortSession();
          return guideError(new Error(`Ticket ${ticketResolution.displayId} is blocked by: ${ticket.blockedBy.join(", ")}.`));
        }
      }

      // ISS-043: Check if ticket is claimed by another active session
      if (mode !== "review") {
        const claimId = (ticket as Record<string, unknown>).claimedBySession;
        if (claimId && typeof claimId === "string" && claimId !== session.sessionId) {
          const claimingSession = findSessionById(root, claimId);
          if (claimingSession && claimingSession.state.status === "active" && !isLeaseExpired(claimingSession.state)) {
            abortSession();
            return guideError(new Error(
              `Ticket ${ticketResolution.displayId} is claimed by active session ${claimId}. ` +
              `Wait for it to finish or stop it with "storybloq session stop ${claimId}".`,
            ));
          }
        }
      }

      // Determine entry state based on mode
      let entryState: string;
      if (mode === "review") {
        entryState = "CODE_REVIEW";
      } else if (mode === "plan") {
        entryState = "PLAN";
      } else {
        // guided — enters at PLAN like auto, but maxTickets=1 already set
        entryState = "PLAN";
      }

      // Set ticket and transition to entry state
      updated = {
        ...updated,
        state: entryState,
        previousState: "INIT",
        ticket: {
          id: ticket.id,
          displayId: ticketResolution.displayId,
          title: ticket.title,
          risk: reviewRiskForTicket(ticket),
          claimed: true,
        },
      };

      updated = refreshLease(updated);
      const pressure = evaluatePressure(updated);
      updated = { ...updated, contextPressure: { ...updated.contextPressure, level: pressure } };
      const written = writeSessionAndRefresh(root, dir, updated, "never");

      appendEvent(dir, {
        rev: written.revision,
        type: "start",
        timestamp: new Date().toISOString(),
        data: buildTieredStartEventData({
          recipe,
          branch: written.git.branch,
          head: written.git.initHead,
          mode: mode!,
          canonicalTicketId: ticketResolution.canonicalId,
          displayId: ticketResolution.displayId,
        }),
      });
      emitTelemetry(dir, "session_start", "guide", { recipe, branch: written.git.branch, mode, ticketId: ticketResolution.canonicalId });

      const modeLabels: Record<string, string> = {
        review: "Review Mode",
        plan: "Plan Mode",
        guided: "Guided Mode",
      };

      // Build mode-specific instruction
      let instruction: string;
      if (mode === "review") {
        const mergeBase = updated.git.mergeBase;
        const diffCommand = mergeBase
          ? `\`git diff ${mergeBase}\``
          : `\`git diff HEAD\` AND \`git ls-files --others --exclude-standard\``;
        instruction = [
          `# ${modeLabels[mode]} — ${ticketResolution.displayId}: ${ticket.title}`,
          "",
          `Reviewing code for ticket **${ticketResolution.displayId}**. Capture the diff and run a code review.`,
          "",
          `Capture diff with: ${diffCommand}`,
          "",
          "**IMPORTANT:** Pass the FULL unified diff output to the reviewer. Do NOT summarize.",
          "",
          "When the code review is done, call `storybloq_autonomous_guide` with the verdict:",
          '```json',
          `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "code_review_round", "verdict": "<approve|revise|request_changes|reject>", "findings": [...] } }`,
          '```',
        ].join("\n");
      } else {
        instruction = [
          `# ${modeLabels[mode]} — ${ticketResolution.displayId}: ${ticket.title}`,
          "",
          `Write an implementation plan for ticket **${ticketResolution.displayId}**: ${ticket.title}`,
          ticket.description ? `\n**Description:**\n${ticket.description}` : "",
          "",
          `Write the plan as a markdown file at \`.story/sessions/${updated.sessionId}/plan.md\`.`,
          "Do NOT use client-native plan mode.",
          "",
          "When done, call `storybloq_autonomous_guide`:",
          '```json',
          `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          '```',
        ].join("\n");
      }

      const reminders = mode === "guided"
        ? [
            "Do NOT use client-native plan mode -- write plans as markdown files.",
            "This is guided mode — single ticket, full pipeline.",
          ]
        : [
            `This is ${mode} mode — session ends after ${mode === "review" ? "code review approval" : "plan review approval"}.`,
          ];

      return guideResult(updated, entryState, {
        instruction,
        reminders,
        transitionedFrom: "INIT",
      });
    }

    // --- Auto mode: full autonomous flow ---

    // Update and write state (before building instruction -- need sessionId)
    updated = refreshLease(updated);
    const pressure = evaluatePressure(updated);
    updated = { ...updated, contextPressure: { ...updated.contextPressure, level: pressure } };
    const written = writeSessionAndRefresh(root, dir, updated, "if-active");

    appendEvent(dir, {
      rev: written.revision,
      type: "start",
      timestamp: new Date().toISOString(),
      data: buildAutoStartEventData({
        recipe,
        branch: written.git.branch,
        head: written.git.initHead,
        targetWork: [...(written.targetWork ?? [])],
        targetWorkDisplayIds: written.targetWorkDisplayIds as Record<string, string> | undefined,
      }),
    });
    emitTelemetry(dir, "session_start", "guide", { recipe, branch: written.git.branch, mode: "auto" });

    const maxTickets = updated.config.maxTicketsPerSession;
    const interval = updated.config.handoverInterval ?? 3;
    const checkpointDesc = interval > 0
      ? ` A checkpoint handover will be saved every ${interval} items.`
      : "";

    // T-188: Targeted mode builds a constrained candidate list
    if (validatedTargetWork.length > 0) {
      const targetedInstruction = buildTargetedPickInstruction(validatedTargetWork, projectState, updated.sessionId);

      const skippedNote = skippedTargets.length > 0
        ? `\n\n**Note:** Skipped ${skippedTargets.length} already-done item(s): ${skippedTargets.join(", ")}.`
        : "";

      const instruction = [
        "# Targeted Autonomous Session Started",
        "",
        `You are in targeted auto mode. Working on ${validatedTargetWork.length} specific item(s) in order, then ending the session.${checkpointDesc}${skippedNote}`,
        "Do NOT stop to summarize. Do NOT ask the user. Do NOT cancel for context management; Storybloq rotates at a clean boundary when pressure reaches the configured threshold.",
        "",
        targetedInstruction,
      ].join("\n");

      return guideResult(updated, "PICK_TICKET", {
        instruction,
        reminders: [
          "Do NOT use client-native plan mode -- write plans as markdown files.",
          "Do NOT ask the user for confirmation or approval.",
          "Do NOT stop or summarize between items -- call autonomous_guide IMMEDIATELY.",
          "You are in targeted auto mode -- work ONLY on the listed items.",
          "NEVER cancel due to context size. Storybloq's hooks compact context automatically and preserve all session state.",
          ...(versionWarning ? [`**Warning:** ${versionWarning}`] : []),
        ],
        transitionedFrom: "INIT",
      });
    }

    // Standard auto mode: browse full roadmap
    const nextResult = nextTickets(projectState, 5);
    let candidatesText = "";
    if (nextResult.kind === "found") {
      candidatesText = nextResult.candidates.map((c, i) =>
        `${i + 1}. **${displayTicket(c.ticket)}: ${c.ticket.title}** (${c.ticket.type}, phase: ${c.ticket.phase ?? "unphased"})${c.unblockImpact.wouldUnblock.length > 0 ? ` — unblocks ${c.unblockImpact.wouldUnblock.map((t) => displayTicket(t)).join(", ")}` : ""}`,
      ).join("\n");
    } else if (nextResult.kind === "all_complete") {
      candidatesText = "All tickets are complete. No work to do.";
    } else if (nextResult.kind === "all_blocked") {
      candidatesText = "All remaining tickets are blocked.";
    } else {
      candidatesText = "No tickets found.";
    }

    // T-328: Branch affinity annotation
    const startAffinity = detectBranchAffinity(updated.git?.branch ?? null);
    const { warningText: startWarning } = buildAffinityAnnotation(startAffinity);
    if (startWarning) {
      candidatesText = startWarning + "\n\n" + candidatesText;
    }

    // T-153: Surface high/critical issues alongside ticket candidates
    const highIssues = projectState.activeIssues.filter(
      i => i.status === "open" && (i.severity === "critical" || i.severity === "high"),
    );
    let issuesText = "";
    if (highIssues.length > 0) {
      issuesText = "\n\n## Open Issues (high+ severity)\n\n" + highIssues.map(
        (i, idx) => `${idx + 1}. **${displayIssue(i)}: ${i.title}** (${i.severity})`,
      ).join("\n");
    }

    // Also get recommendations (with handover + snapshot context for ISS-018/019)
    const guideRecOptions = await buildGuideRecommendOptions(root);
    const recResult = recommend(projectState, 5, guideRecOptions);
    let recsText = "";
    if (recResult.recommendations.length > 0) {
      // T-153: Include issues alongside tickets in recommendations (no more ticket-only filter)
      const actionableRecs = recResult.recommendations.filter((r) => r.kind === "ticket" || r.kind === "issue");
      if (actionableRecs.length > 0) {
        recsText = "\n\n**Recommended:**\n" + actionableRecs.map((r) =>
          `- ${r.id}: ${r.title} (${r.reason})`,
        ).join("\n");
      }
    }

    const topCandidate = nextResult.kind === "found" ? nextResult.candidates[0] : null;

    const sessionDesc = maxTickets > 0
      ? `Work continuously until all tickets are done or you reach ${maxTickets} tickets.`
      : "Work continuously until all tickets are done.";

    const hasHighIssues = highIssues.length > 0;
    const instruction = [
      "# Autonomous Session Started",
      "",
      `You are now in autonomous mode. ${sessionDesc}${checkpointDesc}`,
      "Do NOT stop to summarize. Do NOT ask the user. Do NOT cancel for context management; Storybloq rotates at a clean boundary when pressure reaches the configured threshold. Pick a ticket or issue and start working immediately.",
      "",
      "## Ticket Candidates",
      "",
      candidatesText,
      issuesText,
      recsText,
      "",
      topCandidate
        ? `Pick **${displayTicket(topCandidate.ticket)}** (highest priority) or an open issue by calling \`storybloq_autonomous_guide\` now:`
        : hasHighIssues
          ? "Pick an issue to fix by calling `storybloq_autonomous_guide` now:"
          : "Pick a ticket by calling `storybloq_autonomous_guide` now:",
      '```json',
      topCandidate
        ? `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
        : `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
      '```',
      ...(hasHighIssues ? [
        "",
        "Or to fix an issue:",
        '```json',
        `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "issue_picked", "issueId": "${highIssues[0].id}" } }`,
        '```',
      ] : []),
    ].join("\n");

    return guideResult(updated, "PICK_TICKET", {
      instruction,
      reminders: [
        "Do NOT use client-native plan mode -- write plans as markdown files.",
        "Do NOT ask the user for confirmation or approval.",
        "Do NOT stop or summarize between tickets — call autonomous_guide IMMEDIATELY.",
        "You are in autonomous mode — continue working until done.",
        "NEVER cancel due to context size. Storybloq's hooks compact context automatically and preserve all session state.",
        ...(versionWarning ? [`**Warning:** ${versionWarning}`] : []),
      ],
      transitionedFrom: "INIT",
    });

  } catch (err) {
    // Cleanup on failure
    abortSession();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pipeline walker (T-128) — dispatches to registered WorkflowStage
// ---------------------------------------------------------------------------

/** Reconstruct a ResolvedRecipe from persisted session state fields. */
function resolveRecipeFromState(state: FullSessionState): import("./stages/types.js").ResolvedRecipe {
  const DEFAULT_PIPELINE = ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"];
  return {
    id: state.resolvedRecipeId ?? state.recipe,
    pipeline: state.resolvedPipeline ?? DEFAULT_PIPELINE,
    postComplete: state.resolvedPostComplete ?? [],
    stages: state.resolvedStages ?? {},
    dirtyFileHandling: state.resolvedDirtyFileHandling ?? "block",
    branchStrategy: parseBranchStrategyOrDefault(state.resolvedBranchStrategy),
    defaults: state.resolvedDefaults ?? {
      maxTicketsPerSession: state.config.maxTicketsPerSession,
      compactThreshold: state.config.compactThreshold,
      reviewBackends: [...state.config.reviewBackends],
      codexReviewBackends: state.config.codexReviewBackends
        ? [...state.config.codexReviewBackends]
        : undefined,
    },
  };
}

const MAX_AUTO_ADVANCE_DEPTH = 10;

/** Process a StageAdvance result — handles advance/retry/back/goto. */
async function processAdvance(
  ctx: StageContext,
  currentStage: import("./stages/types.js").WorkflowStage,
  advance: StageAdvance,
  depth = 0,
): Promise<McpToolResult> {
  if (depth >= MAX_AUTO_ADVANCE_DEPTH) {
    return guideError(new Error(
      `Auto-advance depth limit (${MAX_AUTO_ADVANCE_DEPTH}) exceeded at stage ${currentStage.id}. Possible cycle in enter() auto-advances.`,
    ));
  }

  // Short-circuit: if the stage already transitioned to SESSION_END (terminal),
  // return the result directly without pipeline lookup (HandoverStage fix)
  if (ctx.state.state === "SESSION_END" && advance.action === "advance") {
    const terminalResult = ("result" in advance && advance.result)
      ? advance.result
      : { instruction: "Session ended.", reminders: [] as string[] };
    return guideResult(ctx.state, "SESSION_END", terminalResult);
  }

  // Reset stuck-retry counter on any non-retry action
  if (advance.action !== "retry" && (ctx.state as Record<string, unknown>).stuckRetryCount) {
    ctx.writeState({ stuckRetryCount: 0 });
  }

  switch (advance.action) {
    case "advance": {
      const pipeline = ctx.state.resolvedPipeline ?? ctx.recipe.pipeline;
      const next = findNextStage(pipeline, currentStage.id, ctx);

      if (next.kind === "unregistered") {
        // Hybrid dispatch: next pipeline stage not yet extracted — write transition.
        // Use advance.result if present (stage pre-computed the instruction),
        // otherwise fall back to generic "report back" for the switch to handle.
        assertTransition(currentStage.id as WorkflowState, next.id as WorkflowState);
        ctx.writeState({ state: next.id, previousState: currentStage.id });
        const resultForNext = ("result" in advance && advance.result)
          ? advance.result
          : { instruction: `Transitioned to ${next.id}. Report back to continue.`, reminders: [] as string[] };
        return guideResult(ctx.state, next.id, resultForNext);
      }

      if (next.kind === "exhausted") {
        // Pipeline exhausted — check postComplete or route to HANDOVER
        const postComplete = ctx.state.resolvedPostComplete ?? ctx.recipe.postComplete;
        // Use findNextPostComplete when current stage is in postComplete (avoids looping back to self)
        const isInPostComplete = postComplete.includes(currentStage.id);
        const post = isInPostComplete
          ? findNextPostComplete(postComplete, currentStage.id, ctx)
          : findFirstPostComplete(postComplete, ctx);
        if (post.kind === "found") {
          assertTransition(currentStage.id as WorkflowState, post.stage.id as WorkflowState);
          ctx.writeState({ state: post.stage.id, previousState: currentStage.id });
          const enterResult = "result" in advance && advance.result
            ? advance.result
            : await post.stage.enter(ctx);
          if (isStageAdvance(enterResult)) return processAdvance(ctx, post.stage, enterResult, depth + 1);
          return guideResult(ctx.state, post.stage.id, enterResult);
        }
        if (post.kind === "unregistered") {
          // PostComplete stage not yet extracted — delegate to legacy
          assertTransition(currentStage.id as WorkflowState, post.id as WorkflowState);
          ctx.writeState({ state: post.id, previousState: currentStage.id });
          return guideResult(ctx.state, post.id, {
            instruction: `Transitioned to ${post.id}. Report back to continue.`,
            reminders: [],
          });
        }
        // post.kind === "exhausted" — no postComplete, route to HANDOVER
        const handoverStage = getStage("HANDOVER");
        if (handoverStage) {
          assertTransition(currentStage.id as WorkflowState, "HANDOVER");
          ctx.writeState({ state: "HANDOVER", previousState: currentStage.id });
          const enterResult = await handoverStage.enter(ctx);
          if (isStageAdvance(enterResult)) return processAdvance(ctx, handoverStage, enterResult, depth + 1);
          return guideResult(ctx.state, "HANDOVER", enterResult);
        }
        return guideError(new Error(`Pipeline exhausted at ${currentStage.id} with no HANDOVER stage`));
      }

      // next.kind === "found"
      const nextStage = next.stage;
      assertTransition(currentStage.id as WorkflowState, nextStage.id as WorkflowState);
      ctx.writeState({ state: nextStage.id, previousState: currentStage.id });
      ctx.appendEvent("transition", { from: currentStage.id, to: nextStage.id });
      writeCheckpoint(ctx.dir, nextStage.id, ctx.state as unknown as Record<string, unknown>, ctx.state.revision);
      const enterResult = "result" in advance && advance.result
        ? advance.result
        : await nextStage.enter(ctx);
      if (isStageAdvance(enterResult)) return processAdvance(ctx, nextStage, enterResult, depth + 1);
      return guideResult(ctx.state, nextStage.id, enterResult);
    }
    case "retry": {
      const prevCount = (ctx.state as Record<string, unknown>).stuckRetryCount ?? 0;
      ctx.writeState({ stuckRetryCount: (prevCount as number) + 1 });
      return guideResult(ctx.state, currentStage.id, {
        instruction: advance.instruction,
        reminders: advance.reminders ? [...advance.reminders] : [],
      });
    }
    case "back":
    case "goto": {
      const target = advance.target;
      const targetStage = getStage(target);
      if (!targetStage) {
        // Target not registered — write transition. Use advance.result if provided,
        // otherwise delegate to legacy switch on next report.
        assertTransition(currentStage.id as WorkflowState, target as WorkflowState);
        ctx.writeState({ state: target, previousState: currentStage.id });
        const resultForTarget = ("result" in advance && advance.result)
          ? advance.result
          : { instruction: `Transitioned to ${target}. Report back to continue.`, reminders: [] as string[] };
        return guideResult(ctx.state, target, resultForTarget);
      }
      assertTransition(currentStage.id as WorkflowState, target as WorkflowState);
      ctx.writeState({ state: target, previousState: currentStage.id });
      ctx.appendEvent("transition", { from: currentStage.id, to: target, action: advance.action });
      writeCheckpoint(ctx.dir, target, ctx.state as unknown as Record<string, unknown>, ctx.state.revision);
      const enterResult = "result" in advance && advance.result
        ? advance.result
        : await targetStage.enter(ctx);
      if (isStageAdvance(enterResult)) return processAdvance(ctx, targetStage, enterResult, depth + 1);
      return guideResult(ctx.state, target, enterResult);
    }
  }
}

/** Run a registered pipeline stage's report() method and process the result. */
async function runPipelineStage(
  root: string,
  dir: string,
  state: FullSessionState,
  report: NonNullable<GuideInput["report"]>,
  recipe: import("./stages/types.js").ResolvedRecipe,
): Promise<McpToolResult> {
  const stage = getStage(state.state);
  if (!stage) {
    return guideError(new Error(
      `Stage "${state.state}" is not registered. ` +
      `The session state references a stage that does not exist in the registry. ` +
      `This is likely a bug or a session from a newer version.`,
    ));
  }

  // ISS-904: park_item is handled by PLAN and PLAN_REVIEW only, and most stages
  // do NOT reject an action they do not recognise -- IMPLEMENT, for one, treats
  // any action other than `no_implementation_needed` as "implementation done".
  // So an agent that learned the action from a plan-gate hint and tried it one
  // stage later would silently advance the pipeline instead of parking. Refuse
  // it centrally, and say where it IS valid.
  if (report.completedAction === PARK_ACTION && !PARK_STAGES.has(String(state.state))) {
    return guideError(new Error(
      `"${PARK_ACTION}" is only valid at ${[...PARK_STAGES].join(" and ")}; this session is in ${state.state}. ` +
      "Parking declares an item unworkable AS FILED, which is a conclusion the plan gate reaches. " +
      "If the item is unworkable for a reason found later, report this stage's own action and use `skip_ticket` " +
      "to end the session with a handover instead.",
    ));
  }

  const ctx = new StageContext(root, dir, state, recipe);
  const advance = await stage.report(ctx, report);
  const result = await processAdvance(ctx, stage, advance);
  try { refreshStatusForSession(root, dir, ctx.state, "guide"); } catch { /* best-effort */ }
  return result;
}

// ---------------------------------------------------------------------------
// report — advance state machine
// ---------------------------------------------------------------------------

async function handleReport(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) return guideError(new Error("sessionId is required for report action"));
  if (!args.report) return guideError(new Error("report field is required for report action"));

  // ISS-902: name the cause (missing / version skew / corrupt), never a bare "not found".
  const lookup = findSessionByIdDetailed(root, args.sessionId);
  if (lookup.kind !== "found") {
    return guideError(new Error(describeSessionLookupFailure(args.sessionId, lookup)));
  }
  const info = lookup.info;

  const ownershipConflict = liveOwnershipConflict(info.state, args.clientTaskId);
  if (ownershipConflict) {
    return guideError(new Error(
      `Cannot report progress for session ${args.sessionId}: ${ownershipConflict.reason}. ` +
      (ownershipConflict.kind === "unidentified-caller"
        ? `\n${unidentifiedCallerRemedy(args.sessionId)}`
        : "Continue from its owning task."),
    ));
  }

  const adoption = adoptExpiredLease(
    root,
    info.dir,
    info.state,
    args.clientTaskId,
    "report",
  );
  let state = adoption.adopted ? adoption.state : refreshLease(adoption.state);

  // T-442: reconcile before recovery, so a lost claim cannot be written to once more.
  const reportBlock = await claimPreflightBlock(root, state);
  if (reportBlock) return reportBlock;

  // ISS-024: recover any pending mutation before processing
  state = await recoverPendingMutation(info.dir, state, root);

  // ISS-037: retry pending deferrals from previous calls
  state = await drainPendingDeferrals(root, info.dir, state);

  const currentState = state.state as WorkflowState;
  const report = args.report;

  // ISS-377: COMPACT is a valid transient state but has no registered pipeline
  // stage, so runPipelineStage would throw "Stage COMPACT is not registered".
  // Split by compactPending to point callers at the correct recovery path.
  // Strict (not forgiving) so caller bugs surface instead of silent auto-route.
  if (currentState === "COMPACT" && !state.compactPending) {
    return guideError(new Error(
      `Session ${args.sessionId} is in COMPACT state but compactPending is false (stale compact). ` +
      `Your report was NOT applied. ` +
      `Run "storybloq session clear-compact ${args.sessionId}" to recover.`,
    ));
  }
  if (currentState === "COMPACT") {
    // ISS-719: report is a no-op in COMPACT (no registered stage). Make the
    // error self-correcting by embedding the exact resume call, and state
    // plainly that the report was dropped so no stale completedAction is
    // assumed applied. Do not auto-resume here: resume() is not a passive
    // restore (it does HEAD-drift recovery routing, lease re-arbitration, and
    // can refuse), so a blind auto-resume could apply the stale completedAction
    // to the wrong stage.
    return guideError(new Error([
      `Session ${args.sessionId} is in COMPACT state. Your report was NOT applied.`,
      `Resume first by calling \`storybloq_autonomous_guide\` with action: "resume":`,
      "```json",
      `{ "sessionId": "${args.sessionId}", "action": "resume" }`,
      "```",
      `After resume returns the current stage, re-report your completed step. ` +
      `If the session is stuck, run "storybloq session stop ${args.sessionId}".`,
    ].join("\n")));
  }

  try {
    const { state: reportProjectState } = await loadProject(root);
    const conflictsError = checkAutonomousConflicts(reportProjectState);
    if (conflictsError) {
      return guideError(new Error(conflictsError));
    }
  } catch {
    return guideError(new Error(
      "Cannot verify conflict-free project state. Ensure .story/ is intact and retry.",
    ));
  }

  // Fail-closed: reject reports on sessions with inconsistent compactPending (ISS-032)
  if (state.compactPending && currentState !== "COMPACT") {
    return guideError(new Error(
      `Session has pending compaction in inconsistent state (${currentState}). ` +
      `Call action: "resume" or run "storybloq session stop ${args.sessionId}".`,
    ));
  }

  // T-128: All stages dispatched via pipeline walker
  const recipe = resolveRecipeFromState(state);
  return runPipelineStage(root, info.dir, state, report, recipe);
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

async function handleResume(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) return guideError(new Error("sessionId is required for resume"));

  // ISS-902: a resume against a newer-schema session must say "restart the client",
  // not "not found" — this is the exact path that stranded the T-328 session.
  const resumeLookup = findSessionByIdDetailed(root, args.sessionId);
  if (resumeLookup.kind !== "found") {
    return guideError(new Error(describeSessionLookupFailure(args.sessionId, resumeLookup)));
  }
  let info = resumeLookup.info;

  // Recovery and takeover are valid only at the explicit COMPACT boundary.
  // Check before any mutation so a foreign caller cannot refresh the lease or
  // drain pending project writes on a live non-COMPACT session.
  if (info.state.state !== "COMPACT") {
    return guideError(new Error(
      `Session ${args.sessionId} is not in COMPACT state (current: ${info.state.state}). Use action: "report" to continue.`,
    ));
  }
  if (!info.state.compactPending) {
    return guideError(new Error(
      `Session ${args.sessionId} is in COMPACT state but compactPending is false (stale compact). ` +
      `Run "storybloq session clear-compact ${args.sessionId}" to recover.`,
    ));
  }

  // T-424: a usage-limit stop during FINALIZE must never replay finalization
  // through the generic resume path without the user first verifying what
  // landed (finalization is not proven idempotent; a blind replay risks
  // duplicate commits/pushes). Enforced BEFORE pending-mutation recovery
  // and deferral draining -- an ordinary FINALIZE limit resume must perform NO
  // resume-side mutation before rejecting -- and here in the guide (not just
  // at waker dispatch) so an interactive reopen cannot trip it either.
  // Keyed on interruptionKind === "limit": clearing that field is the explicit
  // "I verified git state" acknowledgment (clear-compact --force clears it but
  // deliberately keeps preCompactState=FINALIZE so resume re-enters at the
  // checkpoint -- a broad preCompactState gate would wedge that post-verify
  // resume). Cancelling a FINALIZE park keeps it limit-kind for the same reason
  // (see downgradeLimitParkToCompact), so this gate still fires for it.
  // After clear-compact --force, a clean-HEAD resume re-enters FINALIZE at its
  // recorded finalizeCheckpoint (already-landed commits are detected and
  // skipped); only external HEAD drift routes RECOVERY_MAPPING[FINALIZE] ->
  // IMPLEMENT with the code checkpoint reset. See T-425 for the replay-safe
  // staged recovery that will lift this gate.
  if (info.state.interruptionKind === "limit" && info.state.preCompactState === "FINALIZE") {
    return guideError(new Error(
      `Session ${args.sessionId} was stopped by a usage limit during FINALIZE. ` +
      "Auto-resume is disabled for finalization because replaying it can duplicate commits. " +
      "Manual recovery: verify what landed with `git log` (commit, push, ticket updates), " +
      `then run "storybloq session clear-compact ${args.sessionId} --force" and resume; ` +
      "the session re-enters FINALIZE at its recorded checkpoint (an already-landed commit " +
      "is detected and not repeated), so remove or amend duplicates first.",
    ));
  }

  const callerTask = ownerTaskForCurrentClient(args.clientTaskId);
  const leaseWasExpired = isLeaseExpired(info.state);
  // ISS-899: derived from the ONE shared resolver, never recomputed here. This
  // was the second of five independent copies of the precedence, and it is the
  // seam that actually gates the COMPACT auto-resume the skill guard advises.
  const ownership = resolveSessionOwnership(info.state, callerTask);
  const legacySameOwner = ownership.kind === "same" && ownership.via === "legacyId";
  const unownedLegacy = ownership.kind === "unowned";
  const knownForeignOwner = ownership.kind === "foreign";

  if (args.takeover && !callerTask) {
    return guideError(new Error(
      `Recovering session ${args.sessionId} requires a valid clientTaskId so ownership can be rebound.`,
    ));
  }
  // ISS-899 cell (a). Gated on a LIVE lease and on ownerTask ownership, matching
  // liveOwnershipConflict: an expired session met by an identityless caller is
  // accepted today and must stay accepted (T-446 U5 measures all eight shapes).
  if (
    ownership.kind === "unidentified-caller" &&
    ownership.via === "ownerTask" &&
    !leaseWasExpired
  ) {
    return guideError(new Error(
      `Session ${args.sessionId} is owned by ${ownership.ownerDescription}, and this task has no client task id to check against.\n` +
      unidentifiedCallerRemedy(args.sessionId),
    ));
  }
  if (
    knownForeignOwner &&
    !leaseWasExpired &&
    !args.takeover
  ) {
    return guideError(new Error(
      `Session ${args.sessionId} is owned by ${ownership.ownerDescription}. ` +
      "Open or message that task first. Recovery from another task requires the " +
      "explicit owner-gone confirmation flow.",
    ));
  }
  const shouldRebindOwner = !!callerTask && (
    leaseWasExpired || legacySameOwner || unownedLegacy || (knownForeignOwner && args.takeover === true)
  );
  const reboundOwnerTask = shouldRebindOwner ? callerTask : info.state.ownerTask;
  const reboundClaudeCodeSessionId = legacyClaudeSessionIdForOwner(
    reboundOwnerTask,
    info.state.claudeCodeSessionId,
  );
  const ownerTaskRebindReason = shouldRebindOwner
    ? leaseWasExpired
      ? "expired_lease"
      : unownedLegacy
        ? "legacy_unowned"
        : legacySameOwner
          ? "legacy_claude_match"
          : "explicit_takeover"
    : null;

  // T-442: reconcile before recovery, so a lost claim cannot be written to once more.
  const resumeBlock = await claimPreflightBlock(root, info.state);
  if (resumeBlock) return resumeBlock;

  // ISS-024: recover any pending mutation before processing
  const recoveredState = await recoverPendingMutation(info.dir, info.state, root);
  if (recoveredState !== info.state) {
    const reread = findSessionById(root, args.sessionId);
    if (reread) Object.assign(info, reread);
  }

  // ISS-037: drain pending deferrals from before compact
  // Must capture return value — subsequent writes spread info.state as base
  info = { ...info, state: await drainPendingDeferrals(root, info.dir, info.state) };

  // Revalidate after pending-mutation recovery in case it repaired state.
  if (info.state.state !== "COMPACT") {
    return guideError(new Error(
      `Session ${args.sessionId} is not in COMPACT state (current: ${info.state.state}). Use action: "report" to continue.`,
    ));
  }

  // Check compactPending — stale COMPACT sessions get a clear message
  if (!info.state.compactPending) {
    return guideError(new Error(
      `Session ${args.sessionId} is in COMPACT state but compactPending is false (stale compact). ` +
      `Run "storybloq session clear-compact ${args.sessionId}" to recover.`,
    ));
  }

  // Validate preCompactState is a known workflow state
  const resumeState = info.state.preCompactState;
  if (!resumeState || !WORKFLOW_STATES.includes(resumeState as typeof WORKFLOW_STATES[number])) {
    return guideError(new Error(
      `Session ${args.sessionId} has invalid preCompactState: ${resumeState}. ` +
      `Run "storybloq session stop ${args.sessionId}" to terminate.`,
    ));
  }

  const compactionObserved = wasCompactionObserved(info.state);
  const refreshedResumeState = refreshLease(info.state);
  const resumedGuideCallCount = compactionObserved ? 0 : refreshedResumeState.guideCallCount;
  const resumedContextPressure = compactionObserved
    ? pressureAfterCompaction(refreshedResumeState)
    : refreshedResumeState.contextPressure;
  const compactionNotice = compactionObserved
    ? ""
    : "Client compaction was not confirmed by SessionStart. Pressure counters were preserved, and the session will rotate through HANDOVER at the next clean COMPLETE boundary.";
  const resumeHeading = compactionObserved
    ? "Resumed After Client Compaction"
    : "Recovered From COMPACT State";

  // ISS-032: 3-branch HEAD validation
  const headResult = await gitHead(root);
  const expectedHead = info.state.git.expectedHead;

  // Branch C: Cannot validate HEAD (git unavailable)
  // Note: missing expectedHead with working git → skip validation (Branch A, backward compat)
  if (!headResult.ok) {
    // Keep compactPending — session must remain discoverable
    const blockedState = writeSessionAndRefresh(root, info.dir, {
      ...refreshedResumeState,
      resumeBlocked: true,
      ownerTask: reboundOwnerTask,
      claudeCodeSessionId: reboundClaudeCodeSessionId,
    } as FullSessionState, "always");
    appendEvent(info.dir, {
      rev: blockedState.revision,
      type: "resume_blocked",
      timestamp: new Date().toISOString(),
      data: { reason: "cannot_validate_head", expectedHead: expectedHead ?? null, gitAvailable: headResult.ok },
    });
    return guideError(new Error(
      `Cannot validate git state for session ${args.sessionId}. ` +
      `Check git status and try "resume" again, or run "storybloq session stop ${args.sessionId}" to end the session.`,
    ));
  }

  // Branch B: HEAD mismatch (drift during compaction)
  let ownCommitDrift = false;
  if (expectedHead && headResult.data.hash !== expectedHead) {
    // T-184: Check if drift is session's own commit (expectedHead is ancestor of actual)
    const ancestorCheck = await gitIsAncestor(root, expectedHead, headResult.data.hash);
    if (ancestorCheck.ok && ancestorCheck.data) {
      // Own commit -- fall through to Branch A with updated expectedHead
      ownCommitDrift = true;
    }
  }
  // T-260: Spawn new sidecar for resumed session (old sidecar died with previous process)
  let resumeSidecarPid: number | null = null;
  try {
    resumeSidecarPid = spawnAliveSidecar(telemetryDirPath(info.dir));
  } catch { /* best-effort */ }

  try {

  if (expectedHead && headResult.data.hash !== expectedHead && !ownCommitDrift) {
    // External drift or gitIsAncestor error -- existing recovery
    let mapping = RECOVERY_MAPPING[resumeState] ?? { state: "PICK_TICKET", resetPlan: false, resetCode: false };

    // T-208: Issue-aware drift override -- prevent CODE_REVIEW from drifting to PLAN when currentIssue is set
    if (info.state.currentIssue && resumeState === "CODE_REVIEW") {
      mapping = { state: "ISSUE_FIX", resetPlan: false, resetCode: true };
    }

    const recoveryReviews = {
      plan: mapping.resetPlan ? [] : info.state.reviews.plan,
      code: mapping.resetCode ? [] : info.state.reviews.code,
    };

    const recoveryTicket = info.state.ticket
      ? { ...info.state.ticket, realizedRisk: undefined, lastPlanHash: undefined }
      : undefined;

    const driftWritten = writeSessionAndRefresh(root, info.dir, {
      ...refreshedResumeState,
      state: mapping.state,
      previousState: "COMPACT",
      preCompactState: null,
      resumeFromRevision: null,
      compactPending: false,
      compactPreparedAt: null,
      compactObservedAt: null,
      resumeBlocked: false,
      ...CLEARED_LIMIT_FIELDS,
      finalizeCheckpoint: null,
      landingDecision: null,
      reviews: recoveryReviews,
      ticket: recoveryTicket,
      guideCallCount: resumedGuideCallCount,
      contextPressure: resumedContextPressure,
      // ISS-922: divergent drift invalidated this item's work and reviews, so
      // the finalization baseline resets with them.
      git: { ...info.state.git, expectedHead: headResult.data.hash, mergeBase: headResult.data.hash, itemBaseHead: headResult.data.hash },
      sidecarPid: resumeSidecarPid,
      ownerTask: reboundOwnerTask,
      claudeCodeSessionId: reboundClaudeCodeSessionId,
    } as FullSessionState, "always");

    appendEvent(info.dir, {
      rev: driftWritten.revision,
      type: "resume_conflict",
      timestamp: new Date().toISOString(),
      data: { drift: true, previousState: resumeState, recoveryState: mapping.state, expectedHead, actualHead: headResult.data.hash, ticketId: info.state.ticket?.id },
    });
    appendEvent(info.dir, {
      rev: driftWritten.revision,
      type: "resumed",
      timestamp: new Date().toISOString(),
      data: {
        preCompactState: resumeState,
        compactionCount: driftWritten.contextPressure?.compactionCount ?? 0,
        ticketId: info.state.ticket?.id ?? null,
        headMatch: false,
        recoveryState: mapping.state,
        compactionObserved,
        ownerTaskRebound: shouldRebindOwner,
        ownerTaskRebindReason,
      },
    });
    removeResumeMarker(root);

    // State-specific actionable instructions after drift recovery
    const driftPreamble = [
      `**HEAD changed while COMPACT was pending** (expected ${expectedHead.slice(0, 8)}, got ${headResult.data.hash.slice(0, 8)}). Review state invalidated.`,
      compactionNotice,
      "",
    ].filter(Boolean).join("\n\n");

    if (mapping.state === "PICK_TICKET") {
      // T-188: Targeted mode -- show only remaining targets (with stuck check)
      if (isTargetedMode(driftWritten)) {
        const dispatched = await dispatchTargetedResume(root, driftWritten, info.dir, [
          `# ${resumeHeading} -- HEAD Mismatch (Targeted Mode)`,
          "",
          driftPreamble + "Pick the next target item.",
        ]);
        return dispatched;
      }

      // Standard auto mode -- load candidates
      let candidatesText = "No ticket candidates available.";
      let topCandidate: { ticket: { id: string; title: string } & Record<string, unknown> } | null = null;
      try {
        const { state: ps } = await loadProject(root);
        const result = nextTickets(ps, 5);
        if (result.kind === "found") {
          topCandidate = result.candidates[0] ?? null;
          candidatesText = result.candidates.map((c, i) =>
            `${i + 1}. **${displayTicket(c.ticket)}: ${c.ticket.title}** (${c.ticket.type})`,
          ).join("\n");
        }
      } catch { /* use default */ }

      // T-328: Branch affinity annotation (skip in targeted mode)
      if (!isTargetedMode(driftWritten)) {
        const driftAffinity = detectBranchAffinity(driftWritten.git?.branch ?? null);
        const { warningText: driftWarning } = buildAffinityAnnotation(driftAffinity);
        if (driftWarning) {
          candidatesText = driftWarning + "\n\n" + candidatesText;
        }
      }

      return guideResult(driftWritten, "PICK_TICKET", {
        instruction: [
          `# ${resumeHeading} -- HEAD Mismatch`,
          "",
          driftPreamble + "Pick the next ticket.",
          candidatesText,
          "",
          topCandidate
            ? `Pick **${displayTicket(topCandidate.ticket)}** by calling \`storybloq_autonomous_guide\` now:`
            : "Pick a ticket now:",
          '```json',
          topCandidate
            ? `{ "sessionId": "${driftWritten.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
            : `{ "sessionId": "${driftWritten.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
          '```',
        ].join("\n"),
        reminders: ["Do NOT stop. Pick a ticket immediately."],
      });
    }

    if (mapping.state === "PLAN") {
      const ticketInfo = driftWritten.ticket ? `for ${displaySessionTicket(driftWritten.ticket)}: ${driftWritten.ticket.title}` : "";
      return guideResult(driftWritten, "PLAN", {
        instruction: [
          `# ${resumeHeading} -- HEAD Mismatch`,
          "",
          `${driftPreamble}Write a new implementation plan ${ticketInfo}. Save to \`.story/sessions/${driftWritten.sessionId}/plan.md\`.`,
          "",
          `When done, call \`storybloq_autonomous_guide\` with:`,
          '```json',
          `{ "sessionId": "${driftWritten.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          '```',
        ].join("\n"),
        reminders: ["Previous plan/reviews invalidated by drift. Write a fresh plan."],
      });
    }

    if (mapping.state === "IMPLEMENT") {
      const ticketInfo = driftWritten.ticket ? `for ${displaySessionTicket(driftWritten.ticket)}: ${driftWritten.ticket.title}` : "";
      return guideResult(driftWritten, "IMPLEMENT", {
        instruction: [
          `# ${resumeHeading} -- HEAD Mismatch`,
          "",
          `${driftPreamble}Re-implement ${ticketInfo}. Previous commit state was invalidated.`,
          "",
          `When done, call \`storybloq_autonomous_guide\` with:`,
          '```json',
          `{ "sessionId": "${driftWritten.sessionId}", "action": "report", "report": { "completedAction": "implementation_done" } }`,
          '```',
        ].join("\n"),
        reminders: ["Re-implement and verify before re-submitting for code review."],
      });
    }

    // T-208: ISSUE_FIX drift dispatch -- call stage.enter() for issue-specific instruction
    if (mapping.state === "ISSUE_FIX") {
      const issueFixStage = getStage("ISSUE_FIX");
      if (issueFixStage) {
        const recipe = resolveRecipeFromState(driftWritten);
        const ctx = new StageContext(root, info.dir, driftWritten, recipe);
        const enterResult = await issueFixStage.enter(ctx);
        if (isStageAdvance(enterResult)) {
          return processAdvance(ctx, issueFixStage, enterResult);
        }
        return guideResult(ctx.state, "ISSUE_FIX", {
          instruction: [
            `# ${resumeHeading} -- HEAD Mismatch`,
            "",
            `${driftPreamble}Recovered to **ISSUE_FIX**. Re-fix the issue and mark resolved.`,
            "",
            "---",
            "",
            enterResult.instruction,
          ].join("\n"),
          reminders: enterResult.reminders ?? [],
        });
      }
    }

    // Fallback for unmapped states
    return guideResult(driftWritten, mapping.state, {
      instruction: `# ${resumeHeading} -- HEAD Mismatch\n\n${driftPreamble}Recovered to state: **${mapping.state}**. Continue from here.`,
      reminders: [],
    });
  }

  // Branch A: HEAD matches — normal resume (or own-commit drift from T-184)
  // Reset pressure only when SessionStart confirmed that client compaction occurred.
  const written = writeSessionAndRefresh(root, info.dir, {
    ...refreshedResumeState,
    state: resumeState,
    preCompactState: null,
    resumeFromRevision: null,
    compactPending: false,
    compactPreparedAt: null,
    compactObservedAt: null,
    resumeBlocked: false,
    ...CLEARED_LIMIT_FIELDS,
    guideCallCount: resumedGuideCallCount,
    contextPressure: resumedContextPressure,
    // T-184: Update expectedHead on own-commit drift (mergeBase stays at branch-off point).
    // ISS-922: this records an OBSERVATION for drift detection. It must never
    // touch itemBaseHead -- promoting the finalization baseline onto an
    // unreported work commit is exactly what closed every exit from FINALIZE.
    ...(ownCommitDrift ? { git: { ...info.state.git, expectedHead: headResult.data.hash } } : {}),
    sidecarPid: resumeSidecarPid,
    ownerTask: reboundOwnerTask,
    claudeCodeSessionId: reboundClaudeCodeSessionId,
  } as FullSessionState, "always");
  appendEvent(info.dir, {
    rev: written.revision,
    type: "resumed",
    timestamp: new Date().toISOString(),
    data: {
      preCompactState: resumeState,
      compactionCount: written.contextPressure?.compactionCount ?? 0,
      ticketId: info.state.ticket?.id ?? null,
      headMatch: !ownCommitDrift,
      ownCommit: ownCommitDrift || undefined,
      compactionObserved,
      ownerTaskRebound: shouldRebindOwner,
      ownerTaskRebindReason,
    },
  });
  emitTelemetry(info.dir, "session_resumed", "guide", {
    preCompactState: resumeState,
    compactionCount: written.contextPressure?.compactionCount ?? 0,
    compactionObserved,
  });
  removeResumeMarker(root);

  // If resuming at PICK_TICKET, load candidates and give directive instructions
  if (resumeState === "PICK_TICKET") {
    // T-188: Targeted mode -- show only remaining targets (with stuck check)
    if (isTargetedMode(written)) {
        const dispatched = await dispatchTargetedResume(root, written, info.dir, [
          `# ${resumeHeading} -- Continue Targeted Session`,
          "",
          compactionNotice,
          "",
          `${written.completedTickets.length} ticket(s) and ${(written.resolvedIssues ?? []).length} issue(s) done so far. ${compactionObserved ? "Client compaction confirmed." : "Compaction remains unverified."} Pick the next target item immediately.`,
        ].filter(Boolean));
      return dispatched;
    }

    // Standard auto mode
    let candidatesText = "No ticket candidates available.";
    let topCandidate: { ticket: { id: string; title: string } & Record<string, unknown> } | null = null;
    try {
      const { state: ps } = await loadProject(root);
      const result = nextTickets(ps, 5);
      if (result.kind === "found") {
        topCandidate = result.candidates[0] ?? null;
        candidatesText = result.candidates.map((c, i) =>
          `${i + 1}. **${displayTicket(c.ticket)}: ${c.ticket.title}** (${c.ticket.type})`,
        ).join("\n");
      }
    } catch { /* use default text */ }

    // T-328: Branch affinity annotation (skip in targeted mode)
    if (!isTargetedMode(written)) {
      const cleanAffinity = detectBranchAffinity(written.git?.branch ?? null);
      const { warningText: cleanWarning } = buildAffinityAnnotation(cleanAffinity);
      if (cleanWarning) {
        candidatesText = cleanWarning + "\n\n" + candidatesText;
      }
    }

    return guideResult(written, "PICK_TICKET", {
      instruction: [
        `# ${resumeHeading} -- Continue Working`,
        "",
        compactionNotice,
        "",
        `${written.completedTickets.length} ticket(s) and ${(written.resolvedIssues ?? []).length} issue(s) done so far. ${compactionObserved ? "Client compaction confirmed." : "Compaction remains unverified."} Pick the next ticket or issue immediately.`,
        "",
        candidatesText,
        "",
        topCandidate
          ? `Pick **${displayTicket(topCandidate.ticket)}** by calling \`storybloq_autonomous_guide\` now:`
          : "Pick a ticket now:",
        '```json',
        topCandidate
          ? `{ "sessionId": "${written.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
          : `{ "sessionId": "${written.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Do NOT stop or summarize. Pick the next ticket IMMEDIATELY.",
        "Do NOT ask the user for confirmation.",
        "You are in autonomous mode — continue working.",
        compactionObserved
          ? "Client compaction confirmed; all session state was preserved. Continue working."
          : "Compaction was not confirmed; pressure counters remain unchanged.",
      ],
    });
  }

  const resumeMode = written.mode ?? "auto";
  const baseModeContext = resumeMode === "auto"
    ? "You are in autonomous mode; continue working."
    : resumeMode === "review"
      ? "You are in review mode; the session ends after code review approval."
      : resumeMode === "plan"
        ? "You are in plan mode; the session ends after plan review approval."
        : "You are in guided mode with a single ticket and the full pipeline.";
  const modeContext = [baseModeContext, compactionNotice].filter(Boolean).join("\n\n");

  // ISS-057: Call stage's enter() for stage-specific instruction instead of generic fallback
  const resumeStage = getStage(resumeState);
  if (resumeStage) {
    const recipe = resolveRecipeFromState(written);
    const ctx = new StageContext(root, info.dir, written, recipe);
    const enterResult = await resumeStage.enter(ctx);

    if (isStageAdvance(enterResult)) {
      // COMPLETE auto-advances, VERIFY may auto-skip
      return processAdvance(ctx, resumeStage, enterResult);
    }

    return guideResult(ctx.state, resumeState, {
      instruction: [
        `# ${resumeHeading}`,
        "",
        `Session restored at state: **${resumeState}**.`,
        written.ticket ? `Working on: **${displaySessionTicket(written.ticket)}: ${written.ticket.title}**` : "",
        "",
        modeContext,
        "",
        "---",
        "",
        enterResult.instruction,
      ].filter(Boolean).join("\n"),
      reminders: [
        ...(enterResult.reminders ?? []),
        ...(resumeMode === "auto"
          ? ["Do NOT use plan mode.", "Do NOT stop or summarize."]
          : [`This is ${resumeMode} mode.`]),
        "Call autonomous_guide after completing each step.",
      ],
    });
  }

  // Stage not registered — fall back to generic instruction
  return guideResult(written, resumeState, {
    instruction: [
      `# ${resumeHeading}`,
      "",
      `Session restored at state: **${resumeState}**.`,
      written.ticket ? `Working on: **${displaySessionTicket(written.ticket)}: ${written.ticket.title}**` : "No ticket in progress.",
      "",
      "Continue where you left off. Call me when you complete the current step.",
      "",
      modeContext,
    ].join("\n"),
    reminders: resumeMode === "auto"
      ? [
          "Do NOT use plan mode.",
          "Do NOT stop or summarize.",
          "Call autonomous_guide after completing each step.",
        ]
      : [
          `This is ${resumeMode} mode.`,
          "Call autonomous_guide after completing each step.",
        ],
  });

  } catch (err) {
    // T-260: Clean up sidecar if resume fails after spawn
    try { killSidecar(resumeSidecarPid); } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// pre_compact
// ---------------------------------------------------------------------------

async function handlePreCompact(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) return guideError(new Error("sessionId is required for pre_compact"));

  // ISS-902: name the cause (missing / version skew / corrupt), never a bare "not found".
  const preCompactLookup = findSessionByIdDetailed(root, args.sessionId);
  if (preCompactLookup.kind !== "found") {
    return guideError(new Error(describeSessionLookupFailure(args.sessionId, preCompactLookup)));
  }
  const info = preCompactLookup.info;

  const adoption = adoptExpiredLease(
    root,
    info.dir,
    info.state,
    args.clientTaskId,
    "pre_compact",
  );
  // ISS-899: capture expiry BEFORE the refresh below, so the cell (a) gate sees
  // the lease the caller actually found rather than the one we just renewed.
  const leaseWasExpired = isLeaseExpired(info.state);
  const state = adoption.adopted ? adoption.state : refreshLease(adoption.state);
  const ownershipConflict = liveOwnershipConflict(state, args.clientTaskId, true, leaseWasExpired);
  if (ownershipConflict) {
    return guideError(new Error(
      `Cannot prepare session ${args.sessionId} for compaction: ${ownershipConflict.reason}. ` +
      (ownershipConflict.kind === "unidentified-caller"
        ? `\n${unidentifiedCallerRemedy(args.sessionId)}`
        : "Continue from its owning task."),
    ));
  }

  // ISS-032: delegate to shared helper
  const headResult = await gitHead(root);

  let result;
  try {
    result = prepareForCompact(info.dir, state, {
      expectedHead: headResult.ok ? headResult.data.hash : undefined,
    });
  } catch (err) {
    return guideError(err);
  }

  // Save snapshot AFTER state write (compactPending persisted even if snapshot fails)
  try {
    const loadResult = await loadProject(root);
    const { saveSnapshot } = await import("../core/snapshot.js");
    await saveSnapshot(root, loadResult);
  } catch { /* best-effort */ }

  // T-183: Write resume marker for 100% compaction survival
  writeResumeMarker(root, result.sessionId, {
    ticket: state.ticket,
    completedTickets: state.completedTickets,
    resolvedIssues: state.resolvedIssues,
    preCompactState: result.preCompactState,
  });

  // Read back actual written state (revision and timestamps must match disk)
  const reread = findSessionById(root, args.sessionId);
  const written = reread?.state ?? state;

  return guideResult(written, "COMPACT", {
    instruction: [
      "# Ready for Compact",
      "",
      "Storybloq state is flushed, but client context has not been compacted.",
      "Run the client's user-level compaction command now. The post-compaction SessionStart hook records confirmation.",
      "",
      "Only after SessionStart runs, call `storybloq_autonomous_guide` with:",
      '```json',
      `{ "sessionId": "${result.sessionId}", "action": "resume" }`,
      '```',
    ].join("\n"),
    reminders: ["Do not call resume before client compaction completes."],
  });
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

/**
 * ISS-904 / N-097 operator 3: a refusal must name the condition that actually
 * refused THIS session.
 *
 * The previous text asserted context size regardless of state. That is
 * diagnosis-substitution: an operator whose session owner was gone was told not
 * to cancel over context and then pointed at the admin CLI. It also printed a
 * `ticket_picked` continuation that is wrong from every state except
 * PICK_TICKET, and reported tickets and issues separately even though the gate
 * itself counts them together against one cap.
 *
 * The admin CLI is deliberately absent here. For a healthy mid-pipeline session
 * continuing and parking cover the ground, and pointing at `session stop` is
 * exactly what made operators drop the remainder of a targeted queue.
 */
function buildCancelRefusal(state: FullSessionState): string {
  const workflowState = String(state.state);
  const totalDone = state.completedTickets.length + (state.resolvedIssues ?? []).length;
  const cap = state.config.maxTicketsPerSession;
  const targetCount = state.targetWork?.length ?? 0;

  const progress = targetCount > 0
    ? `${totalDone} of ${targetCount} target item(s) finished`
    : cap === 0
      ? `${totalDone} item(s) finished, no per-session cap`
      : `${totalDone} of ${cap} item(s) finished`;

  const alternatives: string[] = [];
  if (workflowState === "PLAN" || workflowState === "PLAN_REVIEW") {
    const label = state.ticket?.displayId ?? state.ticket?.id ?? "the current item";
    alternatives.push(
      `- **The plan gate keeps rejecting ${label}, and the defect is in the FILING rather than the plan.** Park it. The item returns to \`open\` with your reason recorded on it, this session advances to the next one, and no queue is lost:`,
      "  ```json",
      `  { "sessionId": "${state.sessionId}", "action": "report", "report": { "completedAction": "${PARK_ACTION}", "notes": "<the contradiction, specifically>" } }`,
      "  ```",
    );
  }
  if (workflowState === "PICK_TICKET") {
    alternatives.push(
      "- **Pick the next item** and continue:",
      "  ```json",
      `  { "sessionId": "${state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
      "  ```",
    );
  } else {
    alternatives.push(
      `- **Continue the pipeline from \`${workflowState}\`** by reporting that stage's completed action. Re-read the last instruction if you no longer have it; \`{ "sessionId": "${state.sessionId}", "action": "resume" }\` re-issues it.`,
    );
  }
  alternatives.push(
    "- **Genuinely nothing left to work.** Finish or park the current item; the session then reaches COMPLETE and ends through HANDOVER on its own. Ending it that way preserves the remaining queue, which cancelling does not.",
  );

  return [
    "# Cancel Refused — this session is mid-pipeline and healthy",
    "",
    `**Condition that refused it:** an auto-mode session in \`${workflowState}\` with work remaining (${progress}). ` +
      "It is not stuck, and no claim-loss condition was detected, so nothing that permits cancel applies.",
    "",
    "This is about session state, not context size. Client compaction preserves Storybloq state, and the guide rotates through HANDOVER at a clean boundary once pressure reaches the configured threshold, so context pressure is never by itself a reason to cancel.",
    "",
    "## Designed alternatives",
    "",
    ...alternatives,
  ].join("\n");
}

/**
 * The cancellation transition: stash restore, terminal publication, and the
 * cleanup that follows it. Shared so candidate cancellation runs THIS code
 * rather than a second spelling of it.
 *
 * SINGLE-ATTEMPT. This is not a retryable finalizer and there is no recovery
 * route that resumes it after publication -- `handleCancel` refuses a session
 * already in SESSION_END. Do not build a retry on top of it without a durable
 * protocol, because several effects here are not safely re-runnable:
 *   - `killSidecar` signals a RAW pid with no generation check, so a delayed
 *     retry can signal an unrelated process that inherited that pid;
 *   - `removeResumeMarker` deletes by PATH with no session identity, so a
 *     delayed retry can delete a NEWER session's marker;
 *   - `markEnded` overwrites its timestamp, and `appendEvent` appends, so a
 *     rerun rewrites the end time and duplicates the audit entry;
 *   - re-running the whole thing performs a second terminal write and bumps
 *     the revision.
 * The disposition is also volatile: it is computed by the caller BEFORE
 * publication, so a crash in between loses the fact that a release happened.
 *
 * ORDER, which is observable and load-bearing:
 *   1.  stash restore -- the ONLY effect here that precedes publication.
 *   2a. atomic terminal state write.
 *   2b. status refresh, a SEPARATE best-effort checkpoint inside
 *       `writeSessionAndRefresh`. It can be absent after a crash, and its
 *       failure must not stop anything below.
 *   3.  `killSidecar`, then `writeShutdownMarker`. After publication, or a
 *       failed cancel would kill a still-live session's sidecar.
 *   4.  `appendEvent`, which needs `written.revision`.
 *   5.  telemetry `session_cancelled`, then `markEnded`, which requires an
 *       already-persisted SESSION_END.
 *   6.  `removeResumeMarker`, last, so a failed cancel does not erase recovery
 *       guidance.
 * Every post-publication effect is independently best-effort: the failure of
 * one must not suppress a later one.
 *
 * The caller keeps the compact report and the response prose, which differ per
 * caller. Everything here is the transition itself.
 */
async function applyCancellationTransition(
  root: string,
  session: { readonly dir: string; readonly state: FullSessionState },
  disposition: TicketDisposition,
): Promise<{ readonly written: FullSessionState; readonly stashPopFailed: boolean }> {
  // T-125: Restore auto-stashed changes on cancel.
  let stashPopFailed = false;
  const autoStash = session.state.git.autoStash;
  if (autoStash) {
    const popResult = await gitStashPop(root, autoStash.ref);
    if (!popResult.ok) stashPopFailed = true;
  }

  const written = writeSessionAndRefresh(root, session.dir, {
    ...session.state,
    state: "SESSION_END",
    previousState: session.state.state,
    status: "completed",
    terminationReason: "cancelled",
    compactPending: false,
    compactPreparedAt: null,
    compactObservedAt: null,
    resumeBlocked: false,
    ticket: undefined,
  } as FullSessionState, "always");
  // T-260: Same-process finalization (after state write succeeds)
  try { killSidecar(session.state.sidecarPid); } catch { /* best-effort */ }
  try { writeShutdownMarker(session.dir); } catch { /* best-effort */ }

  const audit = auditOf(disposition);
  appendEvent(session.dir, {
    rev: written.revision,
    type: "cancelled",
    timestamp: new Date().toISOString(),
    data: {
      previousState: session.state.state,
      ...audit,
      stashPopFailed,
    },
  });
  postStateWrite(session.dir, {
    event: {
      type: "session_cancelled",
      layer: "guide",
      data: {
        previousState: session.state.state,
        reason: "cancelled",
        ...audit,
        stashPopFailed,
      },
    },
    ended: { reason: "cancelled" },
  });

  // T-183: Clean resume marker
  removeResumeMarker(root);

  return { written, stashPopFailed };
}

async function handleCancel(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) {
    // Cancel without session ID — check for any active session
    const active = findActiveSessionFull(root);
    if (!active) return guideError(new Error("No active session to cancel"));
    args = { ...args, sessionId: active.state.sessionId };
  }

  // ISS-902: name the cause (missing / version skew / corrupt), never a bare "not found".
  const cancelLookup = findSessionByIdDetailed(root, args.sessionId!);
  if (cancelLookup.kind !== "found") {
    return guideError(new Error(describeSessionLookupFailure(args.sessionId!, cancelLookup)));
  }
  const info = cancelLookup.info;

  const ownershipConflict = liveOwnershipConflict(info.state, args.clientTaskId);
  if (ownershipConflict) {
    // ISS-904: name the designed alternative for THIS session's state rather
    // than deferring to the admin CLI. The two cells differ and conflating them
    // is what sent an operator with a dead owner to `session stop`.
    const isCompact = String(info.state.state) === "COMPACT";
    // ISS-899: the ISS-904 prescription below is for IDENTIFIED callers only.
    // `takeover: true` is rejected without a clientTaskId (see handleResume),
    // so offering it to a caller refused for having no identity would hand them
    // an action that fails for the very reason they were blocked.
    if (ownershipConflict.kind === "unidentified-caller") {
      return guideError(new Error(
        `Cannot cancel session ${args.sessionId}: ${ownershipConflict.reason}.\n` +
        unidentifiedCallerRemedy(args.sessionId!),
      ));
    }
    return guideError(new Error(
      `Cannot cancel session ${args.sessionId}: ${ownershipConflict.reason}. ` +
      (isCompact
        ? "This session is COMPACT, so the designed recovery is to take it over from this task once you have confirmed the recorded owner task is gone: " +
          `{ "sessionId": "${args.sessionId}", "action": "resume", "takeover": true }.`
        : "The recorded owner holds a live, non-COMPACT lease, and a live lease is deliberately never taken over. " +
          "The owning task is the one that ends this session: open or message it."),
    ));
  }

  // ISS-052 + ISS-066: Allow cancel from any state. Already-ended sessions are rejected.
  if (info.state.state === "SESSION_END" || info.state.status === "completed") {
    return guideError(new Error("Session already ended."));
  }

  // T-178: Soft gate — reject context-motivated cancel in active auto sessions
  const isAutoMode = info.state.mode === "auto" || !info.state.mode;
  // ISS-084: Count both tickets and issues toward session cap
  const totalDone = info.state.completedTickets.length + (info.state.resolvedIssues?.length ?? 0);
  const hasTicketsRemaining = (info.state.config.maxTicketsPerSession === 0) ||
    (totalDone < info.state.config.maxTicketsPerSession);
  const isWorkingState = !["SESSION_END", "HANDOVER", "COMPACT"].includes(info.state.state);

  const isStuck = ((info.state as Record<string, unknown>).stuckRetryCount ?? 0) >= 5;
  // ISS-904: computed once and used TWICE -- to stand the soft gate down, and to
  // stop a session that has lost its claim from writing to the ledger on its way
  // out. Cheap: reconcileSessionReality short-circuits to NOT_CHECKED unless the
  // session is in a reconciled state AND carries an epoch.
  // ISS-904: two DIFFERENT questions, and they need different answers. Collapsing
  // them into one reading was wrong, in a way only the FINALIZE window exposes.
  //
  // "May cancel WRITE?" is state-independent: the ledger does not care which
  // stage the session is in, so `cancelClaimPosture` deliberately ignores the
  // pipeline allowlist and suppresses writes wherever ownership is not provable.
  //
  // "May cancel BYPASS the soft gate?" is state-aware, and must use the same
  // allowlist the pipeline does. From FINALIZE onward a session's own authorized
  // completion is observationally identical to a foreign one -- the ticket is
  // `complete` with its claim keys stripped either way, which reconciles as
  // "released". That is exactly why claim-preflight.ts excludes FINALIZE from
  // RECONCILED_STATES. Reading it as claim loss here would let a HEALTHY session
  // that just finished a ticket cancel and discard the rest of its queue,
  // including in the crash window where FINALIZE has completed the ledger ticket
  // but not yet cleared the session draft.
  const preflight = await reconcileClaimForGuide(root, info.state);
  const claimLost = preflight !== null && isClaimLost(preflight);
  const posture = await cancelClaimPosture(root, info.state);
  const mayWriteTicket = posture === "held" || posture === "no-epoch";
  if (isAutoMode && hasTicketsRemaining && isWorkingState && !isStuck && !claimLost) {
    return {
      content: [{
        type: "text",
        text: buildCancelRefusal(info.state),
      }],
    };
  }

  // ISS-024: recover any pending mutation before cancel.
  //
  // ISS-904: NOT when the claim is lost. Recovery replays a ticket mutation this
  // session prepared while it still believed it owned the ticket, and
  // reconciliation has just proved it does not. Replaying would write to a
  // ticket that now belongs to someone else -- the exact ISS-784 hazard, reached
  // through the cancel path instead of the report path. The marker is dropped
  // instead, so the session still ends cleanly and nothing foreign is touched.
  if (mayWriteTicket) {
    await recoverPendingMutation(info.dir, info.state, root);
  } else if (info.state.pendingProjectMutation) {
    writeSessionAndRefresh(
      root, info.dir,
      { ...info.state, pendingProjectMutation: null } as FullSessionState,
      "if-active",
    );
  }
  // Re-read state after recovery
  const cancelInfo = findSessionById(root, args.sessionId!) ?? info;

  // ISS-027: Release ticket claim if session owns it.
  //
  // ISS-904: skipped entirely on claim loss, and epoch-proven otherwise. The
  // legacy release below is gated on the `claimedBySession` stamp alone, so in
  // the split state `{ claimedBySession: us, claim.user: them }` it would strip
  // the OTHER party's winning claim. A session that cannot prove ownership
  // releases nothing; it just ends.
  let disposition: TicketDisposition;
  // The authority gate is deliberately expressed twice: once here, binding the
  // id to the authority to use it, and once as the `!mayWriteTicket` branch
  // below. The branch makes this ternary redundant TODAY, which is why a mutant
  // that drops it survives. It stays because the redundancy is the cheap half of
  // a security boundary: an unauthorized session should not be holding a
  // writable ticket id in scope at all, whatever the branches below are later
  // rearranged to do with it.
  const draftTicketId = mayWriteTicket ? cancelInfo.state.ticket?.id : undefined;
  if (!mayWriteTicket) {
    disposition = { kind: "not-authorized" };
  } else if (draftTicketId === undefined) {
    disposition = { kind: "no-ticket" };
  } else if (draftTicketId === "") {
    // `ticket.id` is `z.string()` with no `.min(1)`, so the empty string is
    // schema-valid and reaches here. No release can act on it, but the audit
    // still reports it VERBATIM: the payload mapping is nullish rather than
    // truthy, so "" stays "" instead of collapsing into the no-ticket null.
    disposition = { kind: "unchanged", ticketId: "", reason: "empty-id" };
  } else {
    const ticketId = draftTicketId;
    // `settled` reproduces what the two booleans did before this was extracted.
    // A throw BEFORE any arm is reached reports `failed`; a throw AFTER one was
    // reached leaves that arm standing, because the old code simply kept
    // whatever the booleans already held when the catch swallowed.
    let settled = false;
    disposition = { kind: "unchanged", ticketId, reason: "missing" };
    try {
      const { withProjectLock, writeTicketUnlocked } = await import("../core/project-loader.js");
      await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
        const ticket = projectState.ticketByID(ticketId);
        if (!ticket) {
          disposition = { kind: "unchanged", ticketId, reason: "missing" };
          settled = true;
          return;
        }
        if (ticket.status !== "inprogress") {
          disposition = { kind: "unchanged", ticketId, reason: "not-inprogress" };
          settled = true;
          return;
        }
        // ISS-904: when the session carries an epoch, prove ownership HERE,
        // inside the same lock as the write. The pre-cancel check above cannot
        // be sufficient on its own -- a claim can move between it and this
        // lock -- and `releaseClaimIfOwned` compares BOTH ownership fields
        // rather than the stamp alone.
        const epoch = parseClaimEpoch((cancelInfo.state as Record<string, unknown>).claimEpoch);
        if (epoch) {
          const outcome = releaseClaimIfOwned(ticket, epoch);
          if (outcome.released) {
            await writeTicketUnlocked(outcome.ticket, root);
            disposition = { kind: "released", ticketId };
          } else {
            disposition = { kind: "conflict", ticketId };
          }
          settled = true;
          return;
        }

        const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
        const ticketClaimBlock = (ticket as Record<string, unknown>).claim;
        // ISS-778: strict ownership for epochless legacy sessions, which have
        // no proof to check. Release only when this session owns the
        // claimedBySession stamp, or when the ticket carries no claim material
        // at all (a bare inprogress ticket this session flipped before any
        // claim existed, nothing foreign to destroy). The old
        // `!claimedBySession` escape hatch released FOREIGN CLI claims, which
        // write claim{user,branch,since} but never set claimedBySession.
        if (ticketClaim === cancelInfo.state.sessionId || (!ticketClaim && ticketClaimBlock == null)) {
          // ISS-759/ISS-652: delete the claim keys rather than writing
          // explicit nulls, so a released ticket carries no residual state.
          const { claimedBySession: _cb, claim: _cl, ...rest } = ticket as Record<string, unknown>;
          await writeTicketUnlocked({ ...rest, status: "open" as const } as typeof ticket, root);
          disposition = { kind: "released", ticketId };
        } else {
          disposition = { kind: "conflict", ticketId };
        }
        settled = true;
      });
    } catch {
      // Best-effort -- session ends regardless, ticket may remain inprogress.
      if (!settled) disposition = { kind: "failed", ticketId };
    }
  }

  const { written, stashPopFailed } = await applyCancellationTransition(
    root,
    { dir: cancelInfo.dir, state: cancelInfo.state },
    disposition,
  );

  // T-185: Build compact session report
  let reportSection = "";
  try {
    const { state: projectState } = await loadProject(root);
    const nextResult = nextTickets(projectState, 5);
    const openIssues = projectState.activeIssues.filter(i => i.status === "open" || i.status === "inprogress").slice(0, 5);
    const remainingWork = {
      tickets: nextResult.kind === "found"
        ? nextResult.candidates.map(c => ({ id: (c.ticket as Record<string, unknown>).displayId as string | undefined ?? c.ticket.id, title: c.ticket.title }))
        : [],
      issues: openIssues.map(i => ({ id: (i as Record<string, unknown>).displayId as string | undefined ?? i.id, title: i.title, severity: i.severity })),
    };
    reportSection = "\n\n" + formatCompactReport({ state: written, endedAt: new Date().toISOString(), remainingWork });
  } catch { /* best-effort */ }

  const stashNote = stashPopFailed ? " Auto-stash pop failed — run `git stash pop` manually." : "";
  return {
    content: [{ type: "text", text: `Session ${args.sessionId} cancelled. ${written.completedTickets.length} ticket(s) and ${(written.resolvedIssues ?? []).length} issue(s) were completed.${stashNote}${reportSection}` }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate transition + write state atomically. Returns the written state with updated revision. */
function transitionAndWrite(
  root: string,
  dir: string,
  state: FullSessionState,
  to: WorkflowState,
): FullSessionState {
  const from = state.state as WorkflowState;
  if (from !== to) {
    assertTransition(from, to);
  }
  const updated = { ...state, state: to, previousState: from };
  return writeSessionAndRefresh(root, dir, updated, "always");
}

function guideResult(
  state: FullSessionState,
  currentState: WorkflowState | string,
  opts: {
    instruction: string;
    reminders?: readonly string[];
    transitionedFrom?: string;
    contextAdvice?: ContextAdvice;
  },
): McpToolResult {
  const summary: SessionSummary = {
    ticket: state.ticket ? `${(state.ticket as Record<string, unknown>).displayId as string | undefined ?? state.ticket.id}: ${state.ticket.title}` : "none",
    risk: state.ticket?.risk ?? "unknown",
    completed: [
      ...state.completedTickets.map((t) => (t as Record<string, unknown>).displayId as string | undefined ?? t.id),
      ...(state.resolvedIssues ?? []).map((id) => state.resolvedIssueDisplayIds?.[id] ?? id),
    ],
    currentStep: currentState,
    contextPressure: state.contextPressure?.level ?? "low",
    branch: state.git?.branch ?? null,
  };

  // T-178: Inject global anti-cancel reminder for auto mode
  const allReminders = [...(opts.reminders ?? [])];
  if ((state.mode === "auto" || !state.mode) && currentState !== "SESSION_END") {
    allReminders.push(
      "NEVER cancel this session due to context size. Client compaction hooks preserve Storybloq state when compaction occurs; threshold pressure rotates through HANDOVER at a clean boundary.",
    );
  }

  const output: GuideOutput = {
    sessionId: state.sessionId,
    state: currentState,
    transitionedFrom: opts.transitionedFrom,
    instruction: opts.instruction,
    reminders: allReminders,
    contextAdvice: opts.contextAdvice ?? "ok",
    sessionSummary: summary,
  };

  // Format as markdown for Claude
  const parts = [
    output.instruction,
    "",
    "---",
    `**Session:** ${output.sessionId}`,
    `**State:** ${output.state}${output.transitionedFrom ? ` (from ${output.transitionedFrom})` : ""}`,
    `**Ticket:** ${summary.ticket}`,
    `**Risk:** ${summary.risk}`,
    `**Completed:** ${summary.completed.length > 0 ? summary.completed.join(", ") : "none"}`,
    `**Tickets done:** ${summary.completed.length}`,
    output.contextAdvice !== "ok" ? `**Context advice:** ${output.contextAdvice}` : "",
    summary.branch ? `**Branch:** ${summary.branch}` : "",
    state.verificationCounters
      ? `**Verification:** ${state.verificationCounters.proposed} proposed, ${state.verificationCounters.verified} verified, ${state.verificationCounters.rejected} rejected, ${state.verificationCounters.filed} filed`
      : "",
    output.reminders.length > 0 ? `\n**Reminders:**\n${output.reminders.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean);

  return { content: [{ type: "text", text: parts.join("\n") }] };
}

// Thin adapters over the shared displayIdOf projection (ISS-700). The autonomous
// session works with loosely-typed Records, so these coerce an untyped displayId
// to string|null before delegating, keeping the displayId-else-id rule in one place.
function displayTicket(ticket: { id: string } & Record<string, unknown>): string {
  return displayIdOf({ id: ticket.id, displayId: typeof ticket.displayId === "string" ? ticket.displayId : null });
}

function displayIssue(issue: { id: string } & Record<string, unknown>): string {
  return displayIdOf({ id: issue.id, displayId: typeof issue.displayId === "string" ? issue.displayId : null });
}

function displaySessionTicket(ticket: { id: string; displayId?: string }): string {
  return displayIdOf(ticket);
}

function guideError(err: unknown): McpToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `[autonomous_guide error] ${message}` }],
    isError: true,
  };
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
