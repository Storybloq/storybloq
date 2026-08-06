import { displayIdOf } from "../core/resolver.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
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
  type StashPopOutcome,
  type PersistedTicketDisposition,
  CANCELLATION_SHUTDOWN_ARTIFACT,
  OwnerGoneCandidateTakeoverSchema,
  type OwnerGoneCandidateTakeover,
  OwnerGoneCandidateCancelSchema,
  type OwnerGoneCandidateCancel,
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
import { reassertMcpServerIdentity, liveMcpServers } from "./mcp-registry.js";
import {
  authorizeCandidateTakeover,
  commitCandidateTakeoverLocked,
  commitCandidateCancelLocked,
  type CandidateHandshakeDeps,
  type CandidateHandshakeInput,
  type CandidateAuthorization,
  type CandidateOperation,
  type CandidateTicketWork,
  type CandidateCancelCommit,
} from "./candidate-recovery.js";
import type { IssueAuthorityView } from "./candidate-authority.js";
import type { Ticket } from "../models/ticket.js";
import { serverRegistryBinder } from "./mcp-binding.js";
import { releaseClaimIfOwned, provenOwnership, clearClaimOnComplete } from "../core/claims.js";
import { todayISO } from "../cli/helpers.js";
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
  spawnAliveSidecarFor,
  killSidecar,
  writeShutdownMarker,
  type SidecarShutdownOutcome,
  computeBinaryFingerprint,
  captureClaudeCodeSessionId,
  telemetryDirPath,
  probeRecordedMcpServer,
  type RecordedMcpServerLiveness,
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
import { writeResumeMarker, removeResumeMarker, type ResumeMarkerRemoval } from "./resume-marker.js";
import { refreshStatusForSession } from "./status-writer.js";
import { writeSessionAndRefresh, emitTelemetry, postStateWrite } from "./guide-effects.js";
import { withTelemLock } from "./telemetry-writer.js";
import { readCancellationTransition, type TicketDisposition } from "./cancellation-transition.js";
import type { CancellationAuthority } from "./session-types.js";
import type { CancellationTransition } from "./session-types.js";
import {
  applyCancellationTransition,
  authorizeTailRecovery,
  runCancellationTail,
  retryAdvice,
  transitionBelongsTo,
  validateRecoveryAuthority,
} from "./cancellation-core.js";
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
import { sanitizeDisplayPath, sanitizeDisplayText } from "../core/display-text.js";
import { escapeMarkdownDocumentStrict } from "../core/output-formatter.js";

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

/**
 * ISS-941 half 1: a session whose ON-DISK status has moved off "active" --
 * superseded by another session's start-path reclaim, or completed -- must
 * never be advanced by report, resume, or pre_compact. Before this gate, each
 * handler read the session once via its outer lookup and never re-checked
 * `status`, so a superseded zombie kept refreshing its lease and advancing
 * the pipeline right alongside its successor.
 *
 * The whole call is already inside the outer `withSessionLock` (see
 * `handleAutonomousGuide`), so this is a plain re-read, not a second lock
 * acquisition -- a nested `withSessionLock` on the same path from the same
 * process would be a reentrant `lockfile.lock()` and would stall against its
 * own retry/stale config. A failed or unparseable re-read is `"refused"`
 * exactly like a genuinely inactive one: falling back to the caller's
 * already-loaded state object would be the same fail-open this gate exists
 * to close, arrived at through an error path instead of a status value.
 */
type SessionActivityCheck =
  | { readonly kind: "active" }
  | { readonly kind: "refused"; readonly reason: string };

function checkSessionStillActive(dir: string): SessionActivityCheck {
  const onDisk = readSessionResilient(dir);
  if (!onDisk) {
    return {
      kind: "refused",
      reason:
        "this session's current record could not be re-read (missing or unreadable). " +
        "Refusing without positive confirmation it is still active. " +
        "Inspect `.story/sessions/` directly, or run `storybloq session list`.",
    };
  }
  if (onDisk.status === "active") return { kind: "active" };
  if (onDisk.status === "completed") {
    return {
      kind: "refused",
      reason: "this session has already ended (status: completed); it was not superseded by anything.",
    };
  }
  // status === "superseded"
  const who = onDisk.supersededBy
    ? `by session ${onDisk.supersededBy}`
    : "by a newer session on this workspace (no successor session id was recorded)";
  const cause =
    onDisk.terminationReason === "auto_superseded_finished_orphan"
      ? "auto-superseded because its targeted work was already verified complete and every recorded commit was already in HEAD"
      : `superseded ${who}`;
  return {
    kind: "refused",
    reason:
      `this session was ${cause}. This guide call was not applied; any uncommitted work in its ` +
      "working tree was intentionally left in place for inspection. Stop here and write a " +
      "handover from the owning task instead of retrying.",
  };
}

// ---------------------------------------------------------------------------
// Recovery mapping -- exported for test completeness checks (ISS-040)
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
  dir: string,
  state: FullSessionState,
): Promise<McpToolResult | null> {
  const result = await reconcileClaimForGuide(root, state);
  if (!result) return null;

  // ISS-965: this session's own authorized completion, not a foreign loss.
  // MUST be checked before the isClaimLost gate below. isClaimLost is false
  // for this status by design (the claim really is gone, but it is not a
  // loss to report), so placing this branch after that gate would make it
  // unreachable and let the session fall through into the pipeline with a
  // stale claim on an already-finished ticket -- the exact reachability the
  // round-4 gate found and this ordering exists to close.
  if (result.reconciliation?.status === "completed-consistent") {
    const ticketId = state.ticket?.displayId ?? state.ticket?.id ?? result.epoch?.ticketId ?? "unknown";
    return terminalizeCompletedSession(root, dir, state, ticketId);
  }

  if (!isClaimLost(result)) return null;

  const ticketId = state.ticket?.displayId ?? state.ticket?.id ?? result.epoch?.ticketId ?? "unknown";
  return guideError(new Error(
    `Claim lost on ${ticketId}: ${describeClaimLoss(result)}. ` +
    "This session can no longer prove it owns the ticket, so it will not advance or complete it " +
    "(claim lost -- merge-loser or takeover detection, T-442). " +
    `Write a handover, then cancel this session with { "sessionId": "${state.sessionId}", "action": "cancel" } ` +
    "and start a new session to pick different work.",
  ));
}

/**
 * ISS-965: this session's own completion left the ticket claim-stripped
 * (status "complete", both ownership keys gone) -- consistent, not a foreign
 * loss. Route to a clean terminal handover instead of letting the session
 * read that shape and either die on it (the field bug: four reproductions
 * across two clients) or continue into the pipeline holding a stale epoch
 * that still names a finished ticket (the ISS-981/ISS-982 reachability the
 * round-2 gate found when the earlier design let it proceed).
 *
 * Idempotent by construction for the common case: once this succeeds,
 * state.state is "HANDOVER", which is outside RECONCILED_STATES, so a later
 * report/resume never reaches claimPreflightBlock's completed-consistent
 * branch again for this session -- reconcileSessionReality short-circuits to
 * NOT_CHECKED first. The one window that does not cover is a crash between
 * this function's event append and its state rename, which leaves state.state
 * at its OLD (pre-terminal) value on disk. The next report/resume reconciles
 * the SAME shape (the ledger has not changed) and re-enters here; re-running
 * is safe because every field this function writes is idempotent to repeat --
 * the transition target and disposition marker are the same each time, and
 * the pending mutation is only ever driven to null.
 */
async function terminalizeCompletedSession(
  root: string,
  dir: string,
  state: FullSessionState,
  ticketId: string,
): Promise<McpToolResult> {
  const hadPendingMutation = state.pendingProjectMutation != null;

  // Validated goto, same idiom runPipelineStage uses for its own HANDOVER
  // transitions (guide.ts processAdvance). Throws if state-machine.ts's table
  // does not list this edge -- a real bug, not a caller error, so it is not
  // caught here.
  assertTransition(state.state as WorkflowState, "HANDOVER");

  const observedAt = new Date().toISOString();
  const nextState: FullSessionState = {
    ...state,
    state: "HANDOVER",
    previousState: state.state,
    terminalDisposition: { kind: "completion-observed", ticketId, observedAt },
    // ISS-965: never replay a pending mutation past a session's own completed
    // ticket. Terminalization is the last write this session's claim can
    // legitimately authorize; recoverPendingMutation is never reached on this
    // path (claimPreflightBlock returns before it runs), so the discard has
    // to happen here or the marker would linger unresolved.
    pendingProjectMutation: null,
  };

  // ISS-965 D5: ONE composite event carries the whole transition, coupled to
  // the atomic state write by writeSessionWithEvent (event append, then
  // rename; rolled back together if the rename throws). Two separate calls
  // would coupled only one event to the write and leave the other best-effort
  // and uncoupled, overstating what is actually atomic here.
  //
  // rev is the PROSPECTIVE POST-write revision (state.revision + 1), matching
  // writeSessionWithEvent's other caller (trySupersedeFinishedOrphan): the
  // event append happens before writeSessionSync's internal +1 bump, so the
  // event must record the revision the state will actually carry once
  // persisted, not the revision it carried before this write.
  const written = writeSessionWithEvent(dir, nextState, {
    rev: state.revision + 1,
    type: "claim_terminalized",
    timestamp: observedAt,
    data: { from: state.state, to: "HANDOVER", ticketId, discardedPendingMutation: hadPendingMutation },
  });

  try { refreshStatusForSession(root, dir, written, "guide"); } catch { /* best-effort */ }

  // ISS-965 F5 (byte-review fixup): route through guideResult like every other
  // instruction in this file (including the sibling claim-lost error two lines
  // above claimPreflightBlock), instead of returning a bare content block. The
  // bare form carried no session footer and never named the sessionId, while
  // itself instructing the agent to "Call me with completedAction:
  // handover_written" -- exactly the id an agent needs and exactly the moment
  // (end of a long, compaction-prone session) it is least likely to still hold.
  return guideResult(written, "HANDOVER", {
    instruction: renderTerminalHandoverInstruction(written),
    reminders: [],
  });
}

/** Instruction text for a session routed to ISS-965 terminal handover. */
function renderTerminalHandoverInstruction(state: FullSessionState): string {
  const ticketId = state.terminalDisposition?.ticketId
    ?? state.ticket?.displayId ?? state.ticket?.id ?? "unknown";
  const doneIds = new Set<string>([
    ...(state.completedTickets ?? []).map((t) => t.id),
    ...(state.resolvedIssues ?? []),
    ...(state.ticket ? [state.ticket.id] : []),
  ]);
  const remaining = (state.targetWork ?? [])
    .filter((id) => !doneIds.has(id))
    .map((id) => state.targetWorkDisplayIds?.[id] ?? id);

  return [
    `# ${ticketId} Complete -- Session Ending (ISS-965)`,
    "",
    `Ticket ${ticketId} is complete in the ledger and this session's claim on it has been released. ` +
      "Treat it as finished: do not re-check its status or write to it again.",
    "",
    remaining.length > 0
      ? `Remaining targeted work for the next session: ${remaining.join(", ")}.`
      : "No targeted work remains.",
    "",
    "Write a session handover summarizing what was accomplished" +
      (remaining.length > 0 ? ", including the remaining targeted work above so the next session can pick it up" : "") +
      ".",
    "",
    'Call me with completedAction: "handover_written" and include the content in handoverContent.',
  ].join("\n");
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

  // T-442 / ISS-913: a replay prepared while this session still believed it
  // held the claim must prove that BEFORE writing, inside the SAME lock as the
  // write -- an `expectedCurrent` status match is not ownership: the merge
  // driver can reach `{claimedBySession: us, claim.user: rival}`, which still
  // passes a status-only check. Absent epoch (a session that never gained the
  // ability to prove ownership) keeps today's ungated behavior so pre-T-442
  // crash recovery is not regressed. A PRESENT-but-malformed epoch is
  // different: that session DID acquire a claim, so it is routed to conflict
  // rather than folded into the legacy passthrough (claim-preflight.ts's
  // parseClaimEpoch rejects absent, malformed, and partial epochs alike, and
  // this is the one caller that must still tell "never had one" apart from
  // "had one and it is corrupt").
  const rawEpoch = (state as Record<string, unknown>).claimEpoch;
  const epochPresent = rawEpoch !== undefined && rawEpoch !== null;
  const epoch = epochPresent ? parseClaimEpoch(rawEpoch) : null;
  const epochMalformed = epochPresent && epoch === null;

  let conflict = false;
  try {
    const { withProjectLock, writeTicketUnlocked } = await import("../core/project-loader.js");
    await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
      const ticket = projectState.ticketByID(targetId);
      if (!ticket) return;

      const recordConflict = () => {
        conflict = true;
        appendEvent(dir, {
          rev: state.revision,
          type: "mutation_conflict",
          timestamp: new Date().toISOString(),
          data: { targetId, expected: expectedCurrent, actual: ticket.status, transitionId: m.transitionId },
        });
        writeSessionAndRefresh(root, dir, { ...state, pendingProjectMutation: null } as FullSessionState, "if-active");
      };

      if (epochMalformed) {
        recordConflict();
        return;
      }

      // Gated for any valid (non-legacy) epoch only; a null epoch means no
      // proof exists to check, so it passes through exactly as before.
      const proven = epoch ? provenOwnership(ticket, epoch) : true;

      if (ticket.status === targetValue) {
        // Gated for EVERY target, completion included. Nothing is written on
        // this branch, but clearing the marker also releases this session to
        // apply `postMutation` as though ITS OWN write is what produced the
        // match -- a status equal to the target is not proof of that, and a
        // foreign completion (or a foreign write to any other status) can
        // satisfy it just as well. Fail closed rather than let a foreign
        // completion masquerade as this session's own success (Codex
        // review-code round 1: completion status is not self-certifying).
        // The one case this forecloses -- THIS session's own prior completion
        // succeeded and a crash struck before the marker was cleared -- is
        // already handled upstream of here for report/resume:
        // claimPreflightBlock's "completed-consistent" branch recognizes
        // exactly that shape (epoch had a claim, ledger now has neither key,
        // status complete) and terminalizes cleanly before recovery ever
        // runs. Only start/pre_compact/cancel reach this branch ungated by
        // that check, and none of them depend on postMutation to make
        // progress the way report/resume do.
        if (!proven) { recordConflict(); return; }
        // Project write already succeeded -- clear marker
      } else if (expectedCurrent && ticket.status === expectedCurrent) {
        if (!proven) { recordConflict(); return; }

        if (epoch && targetValue === "complete") {
          // ISS-913 (merged ISS-983): route a completion replay through the
          // SAME guard the ordinary update path uses, rather than writing the
          // status directly. That delivers the epoch proof already gated
          // above AND the claim-key stripping a direct write skips -- without
          // it, a replayed completion lands with status "complete" while
          // still carrying a live claim, the "contradictory" shape
          // candidate-authority.ts's finalizeTicketShape rejects.
          const candidate: Ticket = { ...ticket, status: "complete" as const, completedDate: todayISO() };
          const completion = clearClaimOnComplete(candidate, { completingUser: epoch.user, activeEpochs: [epoch] });
          if (completion.rejected) {
            recordConflict();
            return;
          }
          await writeTicketUnlocked(completion.ticket, root);
        } else {
          // Replay the write
          const updated = { ...ticket, status: targetValue as typeof ticket.status };
          if (m.claimedBySession) {
            (updated as Record<string, unknown>).claimedBySession = m.claimedBySession;
          }
          await writeTicketUnlocked(updated, root);
        }
      } else {
        // Ticket in unexpected state -- conflict: clear marker, do NOT apply postMutation
        recordConflict();
      }
    });
  } catch {
    // Lock/IO failure -- leave marker for next attempt
    return state;
  }

  // Conflict detected -- marker cleared, no postMutation applied
  if (conflict) {
    // Re-read the state we just wrote (with cleared marker).
    // ISS-556: this is called from handleAutonomousGuide -- the exact function
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
// Workspace mutex -- in-process serialization
// ---------------------------------------------------------------------------

const workspaceLocks = new Map<string, Promise<void>>();

/**
 * Entry point for the autonomous guide MCP tool.
 * Serializes calls per workspace (in-process) and per filesystem (cross-process).
 *
 * Lock ordering note: The session lock (.story/sessions/.lock) is acquired first,
 * then loadProject/handleHandoverCreate may acquire the project lock (.story/.lock).
 * This ordering is consistent -- no code path acquires them in reverse order.
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
  // T-450 step 8. MUTUAL EXCLUSION FIRST, before every per-field check.
  //
  // Placed here rather than alongside the two field blocks below because each
  // of those refuses its field on the wrong action, and the two fields demand
  // DIFFERENT actions: on `cancel` the takeover block would fire first, on
  // `resume` the cancel block would, and a caller who sent both would be told
  // about an action mismatch instead of about the contradiction they actually
  // sent. This can only trigger when `ownerGoneCandidateCancel` is present,
  // which is a field no shipped caller can have been sending, so no existing
  // input's message moves.
  if (args.ownerGoneCandidateCancel !== undefined && args.ownerGoneCandidateTakeover !== undefined) {
    return guideError(new Error(
      "ownerGoneCandidateTakeover and ownerGoneCandidateCancel are mutually exclusive: one adopts a session " +
      "and the other ends it. Send exactly one, for the operation the human actually confirmed.",
    ));
  }
  if (args.takeover && args.action !== "resume") {
    return guideError(new Error(`takeover is only valid with action "resume". Got action "${args.action}".`));
  }
  // T-450 step 7b.1. All three checks run BEFORE any mutation, and the field is
  // never silently ignored: a confirmation object accepted and discarded is the
  // worst outcome available here, because the caller has already told a human
  // the takeover was authorized on the picture they confirmed.
  if (args.ownerGoneCandidateTakeover !== undefined) {
    if (args.action !== "resume") {
      return guideError(new Error(
        `ownerGoneCandidateTakeover is only valid with action "resume". Got action "${args.action}".`,
      ));
    }
    if (args.takeover !== true) {
      return guideError(new Error(
        "ownerGoneCandidateTakeover requires takeover: true. The confirmed picture is the evidence FOR a takeover, not a takeover by itself.",
      ));
    }
    const parsed = OwnerGoneCandidateTakeoverSchema.safeParse(args.ownerGoneCandidateTakeover);
    if (!parsed.success) {
      return guideError(new Error(
        `ownerGoneCandidateTakeover is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      ));
    }
  }
  // T-450 step 8.1, the cancel door's boundary. Same discipline as 7b's: every
  // check runs BEFORE any mutation and the field is never silently ignored,
  // because a confirmation object accepted and discarded means a human was
  // told a cancellation was authorized on a picture nothing ever checked.
  if (args.ownerGoneCandidateCancel !== undefined) {
    if (args.action !== "cancel") {
      return guideError(new Error(
        `ownerGoneCandidateCancel is only valid with action "cancel". Got action "${args.action}".`,
      ));
    }
    const parsed = OwnerGoneCandidateCancelSchema.safeParse(args.ownerGoneCandidateCancel);
    if (!parsed.success) {
      return guideError(new Error(
        `ownerGoneCandidateCancel is malformed: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      ));
    }
    // THE SESSION-ID REQUIREMENT, and it is a substitution guard rather than a
    // tidiness rule. `handleCancel` auto-selects an active session when
    // `sessionId` is absent, and this object names a revision and a fingerprint
    // but NO session. The commit's input id would then be derived from whatever
    // was auto-selected, so the handshake's session check would compare two
    // values that came from the same wrong session and agree. A human who
    // confirmed an owner-gone picture for session A could end session B, and
    // nothing downstream could tell. Refused here, before any selection happens.
    if (!args.sessionId) {
      return guideError(new Error(
        "ownerGoneCandidateCancel requires an explicit sessionId. The confirmed picture names a revision and " +
        "a fingerprint but not a session, so allowing the active-session fallback here would let a " +
        "confirmation made about one session end a different one.",
      ));
    }
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
// T-250 -- auto-supersede verifiably-finished orphan sessions
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
// start -- INIT + LOAD_CONTEXT → PICK_TICKET
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

    // ISS-913 (Codex review-code round 2): recoverPendingMutation's
    // "already applied" branch now fails closed when ownership cannot be
    // proven, which is correct for a foreign or contradictory match but wrong
    // for THIS session's own completion -- clearClaimOnComplete strips both
    // ownership keys on success, so a crash between that write and the
    // marker clear leaves exactly the shape provenOwnership cannot tell
    // apart from a foreign one. report/resume already recognize that shape
    // via claimPreflightBlock's "completed-consistent" branch and
    // terminalize BEFORE recovery ever runs (ISS-965); start reaches
    // recovery directly (the ISS-899 ordering above), so it needs the same
    // narrow recognition here -- NOT the full claimPreflightBlock, which
    // would also start refusing claim-LOST sessions here, a separate
    // decision with its own breakage analysis (the existing comment above
    // this block already declines that for the identified-foreign case).
    const reconciled = await reconcileClaimForGuide(root, existing.state);
    if (reconciled?.reconciliation?.status === "completed-consistent") {
      const ticketId = existing.state.ticket?.displayId ?? existing.state.ticket?.id
        ?? reconciled.epoch?.ticketId ?? "unknown";
      return terminalizeCompletedSession(root, existing.dir, existing.state, ticketId);
    }

    await recoverPendingMutation(existing.dir, existing.state, root);
    // Re-read after recovery -- session may have been ended by postMutation
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
          "explicit owner-gone-candidate confirmation flow.",
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
      // T-250: finished-orphan auto-supersede -- silently reclaim the slot if
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
      // Fall through with undefined ctx -- trySupersedeFinishedOrphan will
      // load on demand per session, matching pre-ISS-383 behavior.
    }
  }
  // ISS-941: keyed on directory, not sessionId. Duplicate sessionIds across
  // distinct directories are a recognized state in this codebase (ISS-914's
  // collision handling) -- keying on id would let one directory's successful
  // finished-orphan supersede also skip a DIFFERENT directory sharing that
  // id in the death-proof pass below, silently leaving it active while start
  // proceeded anyway. This is a live-but-narrow fix: today's shipped code
  // already has this gap for the duplicate-id case, not merely this draft.
  const autoSupersededDirs = new Set<string>();
  for (const stale of staleSessions) {
    const result = await trySupersedeFinishedOrphan(stale, root, staleOrphanCtx);
    if (result) autoSupersededDirs.add(stale.dir);
  }

  // ISS-941 half 2: the generic fallback no longer supersedes on lease
  // expiry alone -- an expired lease is not proof the owning process is
  // dead. Two passes over the remaining stale directories: pass A probes
  // every one and writes nothing; pass B either refuses `start` entirely
  // (any entry is not provably dead) or supersedes every probed entry (all
  // are provably dead). All-or-nothing rather than order-dependent: either
  // every probed directory is provably dead and all get reclaimed, or start
  // refuses with zero writes and names every blocker in one message.
  //
  // A failed re-read is its OWN case and is ALWAYS a blocker -- silently
  // `continue`ing past it like a successful "not active" read would let a
  // session vanish from consideration while start proceeds regardless,
  // reopening the exact double-driver bug this gate exists to close, through
  // an error path instead of a status value.
  type ProbedStale =
    | { readonly dir: string; readonly sessionId: string; readonly kind: "rereadFailed" }
    | { readonly dir: string; readonly sessionId: string; readonly kind: "checked"; readonly current: FullSessionState; readonly liveness: RecordedMcpServerLiveness };

  const probed: ProbedStale[] = [];
  for (const stale of staleSessions) {
    if (autoSupersededDirs.has(stale.dir)) continue;
    // ISS-556: MCP-facing stale-session cleanup. A single peer session with
    // historical lensReviewHistory disposition corruption must not block
    // supersede -- use resilient read.
    const current = readSessionResilient(stale.dir);
    if (current && current.status !== "active") continue; // already handled or raced away
    if (!current) {
      // findStaleSessions already skips unreadable dirs (session.ts:875-876,
      // `readSessionResilient` then `if (!session) continue`), so a PERSISTENTLY unreadable directory
      // never reaches staleSessions in the first place -- this rereadFailed
      // case can only arise from a transient change between that read and
      // this one, and the resulting refusal clears on the next start attempt.
      probed.push({ dir: stale.dir, sessionId: stale.state.sessionId, kind: "rereadFailed" });
      continue;
    }
    probed.push({ dir: stale.dir, sessionId: current.sessionId, kind: "checked", current, liveness: probeRecordedMcpServer(current.mcpServerPid) });
  }

  const blockers = probed.filter((p) => p.kind === "rereadFailed" || p.liveness !== "dead");
  if (blockers.length > 0) {
    return guideError(new Error(
      "Cannot start: the following stale session(s) have an expired lease but cannot be proven dead:\n" +
      blockers.map((b) => {
        const evidence = b.kind === "rereadFailed"
          ? "current record could not be re-read; treating as unresolved"
          : b.liveness === "alive"
            ? `last-serving MCP process (pid ${b.current.mcpServerPid}) is still alive`
            // "unknown" collapses two different operator situations: no pid
            // was ever recorded, versus a pid was recorded but the probe
            // itself could not resolve alive/dead. Distinguish them here
            // (from the pid already on hand) rather than leaving one vague
            // sentence to cover both.
            : !b.current.mcpServerPid
              ? "no MCP server pid was recorded for this session"
              : `liveness probe for its recorded pid (${b.current.mcpServerPid}) returned an inconclusive result`;
        // ISS-941 (Codex code-review round 1 on this fix): "storybloq
        // session stop <id>" resolves sessionDir(root, id) -- a direct
        // basename lookup. When a directory's own basename does not match its
        // recorded sessionId (a duplicate-id sibling directory, ISS-914's
        // collision shape, is exactly this case), that command would silently
        // resolve to a DIFFERENT directory -- possibly one already handled --
        // and never reach the actual blocker. Only recommend it when the
        // basename and the recorded id agree; otherwise point at the real path.
        //
        // dirBase is a raw filesystem basename, not trusted input -- a
        // directory can be named with control/bidi characters or
        // Markdown-shaped text. The RAW value is used only for the identity
        // check below; every rendered occurrence goes through the same
        // sanitize-then-escape convention session-guard.ts uses: a LABEL
        // (naming the item) is lossy via sanitizeDisplayText, an ADDRESS
        // (something to go open) is reversible via sanitizeDisplayPath.
        const dirBase = basename(b.dir);
        const dirLabel = escapeMarkdownDocumentStrict(sanitizeDisplayText(dirBase));
        const dirAddress = escapeMarkdownDocumentStrict(sanitizeDisplayPath(join(".story/sessions", dirBase)));
        const remedy = dirBase === b.sessionId
          ? `if it is genuinely gone: run "storybloq session stop ${b.sessionId}"`
          : `its directory name ("${dirLabel}") does not match its recorded session id, so "storybloq session stop ${b.sessionId}" would not resolve to it -- inspect ${dirAddress} directly, or run "storybloq session list"`;
        return `- ${b.sessionId} (${dirLabel}): ${evidence}. If that task is still running, continue from its owning client -- its next guide call will refresh the lease. Otherwise, ${remedy}.`;
      }).join("\n") +
      "\nRefusing to silently reclaim this workspace slot.",
    ));
  }

  // blockers is empty, so every probed entry is kind:"checked" with liveness:"dead".
  for (const p of probed) {
    if (p.kind !== "checked") continue; // unreachable given the guard above; keeps the compiler honest
    writeSessionAndRefresh(root, p.dir, { ...p.current, status: "superseded" as const } as FullSessionState, "always");
    writeShutdownMarker(p.dir);
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
  } catch { /* best-effort -- use defaults */ }

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

  // Create session -- wrapped in try/finally for cleanup on failure
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

    // Check for staged changes (review mode skips -- dirty tree allowed)
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
        // Skip .story/ files -- managed by storybloq, always safe to have dirty
        if (filePath.startsWith(".story/")) continue;
        const hashResult = await gitBlobHash(root, filePath);
        dirtyTracked[filePath] = { blobHash: hashResult.ok ? hashResult.data : "" };
      }
    }

    // T-125: Dirty-file handling -- stash or block based on recipe config
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
        // "block" (default) -- existing behavior
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
    // Skip baseline capture for plan mode -- it exits at PLAN_REVIEW and never reaches TEST/WRITE_TESTS
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
        // Parse combined stdout+stderr -- test runners (Jest, Vitest, Mocha) print to stderr on failure
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

        // T-139: WRITE_TESTS requires parseable baseline -- fail fast if not available
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
      // T-450 step 7b.4: routed through the generation resolver even though a
      // session being CREATED has no generation and this resolves `legacy`,
      // byte-identically to before. Routing it anyway is the point: the two
      // spawn sites cannot drift apart. The generation is passed in rather than
      // read from state because this state is not durable yet.
      const spawn = spawnAliveSidecarFor(dir, undefined);
      sidecarPid = spawn.kind === "spawned" ? spawn.pid : null;
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
        // guided -- enters at PLAN like auto, but maxTickets=1 already set
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
          `# ${modeLabels[mode]} -- ${ticketResolution.displayId}: ${ticket.title}`,
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
          `# ${modeLabels[mode]} -- ${ticketResolution.displayId}: ${ticket.title}`,
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
            "This is guided mode -- single ticket, full pipeline.",
          ]
        : [
            `This is ${mode} mode -- session ends after ${mode === "review" ? "code review approval" : "plan review approval"}.`,
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
        `${i + 1}. **${displayTicket(c.ticket)}: ${c.ticket.title}** (${c.ticket.type}, phase: ${c.ticket.phase ?? "unphased"})${c.unblockImpact.wouldUnblock.length > 0 ? ` -- unblocks ${c.unblockImpact.wouldUnblock.map((t) => displayTicket(t)).join(", ")}` : ""}`,
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
        "Do NOT stop or summarize between tickets -- call autonomous_guide IMMEDIATELY.",
        "You are in autonomous mode -- continue working until done.",
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
// Pipeline walker (T-128) -- dispatches to registered WorkflowStage
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

/** Process a StageAdvance result -- handles advance/retry/back/goto. */
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
        // Hybrid dispatch: next pipeline stage not yet extracted -- write transition.
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
        // Pipeline exhausted -- check postComplete or route to HANDOVER
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
          // PostComplete stage not yet extracted -- delegate to legacy
          assertTransition(currentStage.id as WorkflowState, post.id as WorkflowState);
          ctx.writeState({ state: post.id, previousState: currentStage.id });
          return guideResult(ctx.state, post.id, {
            instruction: `Transitioned to ${post.id}. Report back to continue.`,
            reminders: [],
          });
        }
        // post.kind === "exhausted" -- no postComplete, route to HANDOVER
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
        // Target not registered -- write transition. Use advance.result if provided,
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
// report -- advance state machine
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

  const activityCheck = checkSessionStillActive(info.dir);
  if (activityCheck.kind === "refused") {
    return guideError(new Error(
      `Cannot report progress for session ${args.sessionId}: ${activityCheck.reason}`,
    ));
  }

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
  const reportBlock = await claimPreflightBlock(root, info.dir, state);
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

/**
 * The LEDGER readers the candidate handshake decides on, lifted so the two
 * places that need them cannot drift (T-450 step 7b.3).
 *
 * THREE-WAY, deliberately: `undefined` means the read FAILED, `null` means it
 * positively resolved to nothing. Collapsing a loader fault into absence is the
 * fail-open the whole authority layer exists to remove -- it would tell the
 * matrix "there is no ticket" when the truth is "we could not look".
 */
function guideLedgerReaders(root: string): {
  loadTicket: (ticketId: string) => Promise<Ticket | null | undefined>;
  loadIssue: (issueId: string) => Promise<IssueAuthorityView | null | undefined>;
} {
  return {
    loadTicket: async (ticketId) => {
      try {
        const { state: projectState } = await loadProject(root, { strict: false });
        return projectState.ticketByID(ticketId) ?? null;
      } catch {
        return undefined;
      }
    },
    loadIssue: async (issueId) => {
      try {
        const { state: projectState } = await loadProject(root, { strict: false });
        const issue = projectState.issues.find((i) => i.id === issueId);
        return issue ? { id: issue.id, status: issue.status } : null;
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The handshake's dependencies, wired to PRODUCTION sources.
 *
 * Every state-shaped dep is a PROVIDER over a fresh `readSession(sessionDir)`,
 * never the `info.state` snapshot the resume path already holds. The snapshot
 * was read before this call decided anything; the handshake's whole job is to
 * decide against what is on disk NOW, under the held lock, and a dep that
 * cannot re-read makes the recheck theatre.
 */
function candidateHandshakeDeps(root: string, sessionDir: string): CandidateHandshakeDeps {
  const readers = guideLedgerReaders(root);
  return {
    readState: () => (readSession(sessionDir) ?? {}) as FullSessionState,
    readLifecycle: () => {
      const fresh = readSession(sessionDir);
      // An unreadable state is not a live one. Naming it terminal here would
      // overclaim; the handshake's own state-unreadable arm is reached through
      // `readSessionState` returning null, and this pair keeps that the only
      // place the question is answered.
      return { state: fresh?.state ?? "UNKNOWN", status: fresh?.status ?? "unknown" };
    },
    readSuccessors: () => liveMcpServers(root),
    loadTicket: readers.loadTicket,
    loadIssue: readers.loadIssue,
    readSessionState: () => readSession(sessionDir),
  };
}

/**
 * One sentence per refusal, naming its OWN condition.
 *
 * OPERATION-AWARE since T-450 step 8, and that is a correctness property rather
 * than a matter of tone. Every arm here used to be written for takeover, and the
 * `re-confirm` arm instructs the caller to retry with a NAMED FIELD. Handed to a
 * cancel caller unchanged it would tell them to send `ownerGoneCandidateTakeover`
 * -- following that instruction would attempt to ADOPT a session the human had
 * confirmed they wanted ENDED. A wrong remedy is worse than a vague one.
 *
 * The takeover wording is preserved byte for byte; step 8 added a caller, it did
 * not move a message.
 */
function describeCandidateAuthorizationRefusal(
  sessionId: string,
  authorization: CandidateAuthorization,
  operation: CandidateOperation = "takeover",
): string {
  const takeover = operation === "takeover";
  const noun = takeover ? "takeover" : "cancellation";
  const Noun = takeover ? "Takeover" : "Cancellation";
  const field = takeover ? "ownerGoneCandidateTakeover" : "ownerGoneCandidateCancel";
  switch (authorization.kind) {
    case "re-confirm":
      // Fresh evidence goes BACK, so the client re-presents the current picture
      // rather than starting over blind.
      return (
        `The picture changed before this ${noun} of ${sessionId} was authorized (${authorization.reason}). ` +
        `${authorization.detail}\n` +
        `Re-confirm against the current evidence, then retry with ` +
        `${field}: { sessionRevision: <the session's current revision>, ` +
        `evidenceFingerprint: "${authorization.fresh.fingerprint}" }.`
      );
    case "ineligible":
      return `Session ${sessionId} is not an owner-gone candidate (${authorization.verdict}). ${authorization.detail}`;
    case "refused":
      // `caller-is-owner` gets its own sentence rather than the generic one,
      // because the handshake's own detail says "the ordinary resume applies",
      // which is the TAKEOVER remedy. An owner ending their own session wants
      // an ordinary cancel, and telling them to resume would send them to the
      // opposite operation.
      if (!takeover && authorization.reason === "caller-is-owner") {
        return (
          `Cancellation of session ${sessionId} refused: this caller IS the recorded owner, so owner-gone ` +
          `recovery does not apply. Retry as an ordinary cancellation, with ` +
          `{ "sessionId": "${sessionId}", "action": "cancel" } and no ${field}.`
        );
      }
      return authorization.authority
        ? `${Noun} of session ${sessionId} refused: ${authorization.detail} ` +
          `(posture: ${authorization.authority.posture}).`
        : `${Noun} of session ${sessionId} refused: ${authorization.detail}`;
    case "authorized":
      // DELIBERATELY THE PRE-EXISTING WORDING, not a clearer sentence.
      //
      // This arm is reachable: the commit's `invariant-violated` stage carries
      // an authorized object into this renderer. Before step 8 it fell to the
      // `default` and produced exactly the string below, so rewording it would
      // change a shipped takeover message -- the one thing making this helper
      // operation-aware was required NOT to do. It is broken out from
      // `default` only so the `never` check below covers genuinely new arms.
      return `${Noun} of session ${sessionId} was not authorized.`;
    default: {
      // EXHAUSTIVE. A new `CandidateAuthorization` arm fails to compile here
      // instead of silently collecting the generic sentence, which is the
      // whole point: a refusal an operator cannot act on is a dead end.
      const never: never = authorization;
      return `${Noun} of session ${sessionId} was not authorized (${JSON.stringify(never)}).`;
    }
  }
}

/** Exported for test: the `authorized` arm is reachable through the commit's
 * `invariant-violated` stage, and its wording is a shipped takeover message
 * that step 8 was required to leave unchanged. Contriving a programming-error
 * commit result to reach it would pin the path rather than the string. */
export const __refusalRenderingTesting = {
  describe: describeCandidateAuthorizationRefusal,
};

/**
 * One sentence per cancel-commit refusal STAGE, exhaustive over the union.
 *
 * The stage name alone is an internal label; on its own it tells an operator
 * nothing about what to do next. Each arm says what the stage means and
 * whether a retry is worth anything.
 */
function describeCancelRefusalStage(stage: Extract<CandidateCancelCommit, { kind: "refused" }>["stage"]): string {
  switch (stage) {
    case "state-unreadable":
      return "the session state could not be read under the lock";
    case "validation":
      return "re-validation under the lock did not authorize this cancellation";
    case "invariant-violated":
      return "an internal invariant was violated, which is a programming error rather than a policy refusal";
    case "intent":
      return "the durable cancellation intent could not be established or trusted";
    case "ticket-txn":
      return "the ticket transaction did not complete, so no cancellation was published";
    case "transition":
      return "the transition write refused or failed; the durable intent is unchanged and retry remains available";
    case "tail-gate":
      return "the publication landed but its completion gate refused, so the tail was not run";
    case "resume-validation":
      return "the interrupted cycle could not be validated for resumption, so finishing it here would not be safe";
    default: {
      const never: never = stage;
      return `an unrecognized stage (${String(never)})`;
    }
  }
}

/**
 * TAKE OVER a live, non-COMPACT session whose recorded owner is confirmed gone
 * (T-450 step 7b.3).
 *
 * WHAT THIS DOES NOT DO, and each omission is a decision:
 *
 *  - It does NOT call `stage.enter`. `CompleteStage.enter` writes state
 *    unconditionally and `FinalizeStage.enter` runs git and can fast-forward
 *    into `handleCommit`, so entering the stage would break the commit's
 *    one-atomic-write promise and could COMMIT on the new owner's behalf.
 *    Suppressing `processAdvance` would not suppress any of that. What comes
 *    back is a PURELY RENDERED directive: where the session is, what it is on,
 *    that ownership moved, and the instruction to make the next ordinary guide
 *    call.
 *  - It does NOT reset context pressure, clear `compactPending`, touch
 *    `preCompactState`, or remove the resume marker. Those are the COMPACT
 *    body's work, and applying them to a mid-IMPLEMENT session corrupts it --
 *    which is exactly why this is a separate handler.
 *  - It refreshes the OWNERSHIP FENCE and the activity stamp and nothing else.
 *    The lease and `lastGuideCall` are re-stamped inside the commit's one
 *    atomic write, because publishing a live owner under a dead owner's
 *    decaying fence is what makes the takeover immediately adoptable by the
 *    weaker expired-lease gate. `contextPressure.guideCallCount` is NOT
 *    advanced: a takeover is an ownership change, not a step of the work.
 */
async function handleCandidateTakeoverResume(
  root: string,
  args: GuideInput,
  info: ActiveSessionInfo,
  confirmed: OwnerGoneCandidateTakeover,
): Promise<McpToolResult> {
  const sessionId = args.sessionId!;
  const callerTask = ownerTaskForCurrentClient(args.clientTaskId);
  if (!callerTask) {
    // THE SAME SENTENCE the other takeover door gives, so the two say one thing.
    return guideError(new Error(
      `Recovering session ${sessionId} requires a valid clientTaskId so ownership can be rebound.`,
    ));
  }

  const input: CandidateHandshakeInput = {
    sessionId: info.state.sessionId,
    clientTaskId: args.clientTaskId,
    confirmedSessionRevision: confirmed.sessionRevision,
    confirmedFingerprint: confirmed.evidenceFingerprint,
  };
  const handshake = candidateHandshakeDeps(root, info.dir);

  // PRE-CHECK before the commit, for a concrete reason: the commit's first act
  // is `stageHeartbeatGeneration`, which spawns a child and blocks on its
  // readiness. Running that before the handshake is even plausible would
  // spawn-and-kill a process on every refused takeover. The pre-check's verdict
  // is never relied on -- the commit's own in-lock re-validation is the
  // authority, and it re-reads everything.
  const precheck = await authorizeCandidateTakeover(info.dir, input, handshake);
  //
  // `caller-is-owner` IS NOT A SHORT CIRCUIT, and this is the one exception
  // that makes the pre-check safe to have at all. It is the exact signature of
  // a CRASH RETRY: a prior attempt wrote the postimage -- which made this
  // caller the owner -- and died before closing its intent. The commit's step 2
  // exists precisely to verify and close that, and it checks for an
  // already-durable postimage BEFORE re-validating. Refusing here would put the
  // pre-check in front of that rescue and strand every crashed takeover, with
  // the sentence "you are already the owner" and no way to finish.
  //
  // Nothing is lost by falling through: if there is no durable postimage, the
  // commit's own re-validation reaches the same refusal, from state it read
  // under the lock.
  if (precheck.kind !== "authorized" && !(precheck.kind === "refused" && precheck.reason === "caller-is-owner")) {
    return guideError(new Error(describeCandidateAuthorizationRefusal(sessionId, precheck)));
  }

  // Captured BEFORE the commit: after it, state names the NEW owner.
  const priorOwnerTask = info.state.ownerTask ?? null;

  const commit = await commitCandidateTakeoverLocked(
    root,
    info.dir,
    { input, callerTask },
    { handshake },
  );

  if (commit.kind === "refused") {
    // A durable intent written before a later-stage refusal is the intent
    // protocol working, not a session mutation. Nothing here writes state.json.
    const fresh = commit.authorization
      ? `\n${describeCandidateAuthorizationRefusal(sessionId, commit.authorization)}`
      : "";
    return guideError(new Error(
      `Takeover of session ${sessionId} did not commit (${commit.stage}). ${commit.detail}${fresh}`,
    ));
  }

  // AUDIT, honest on both paths. Two event types rather than one keyed event,
  // because a resumed commit genuinely cannot supply what a fresh one can, and
  // null-filling the difference invites a false reading.
  //
  // `rev` on both is the revision at which the event is APPENDED, which is what
  // `rev` means everywhere else.
  try {
    appendEvent(info.dir, commit.resumed
      ? {
          rev: commit.state.revision,
          type: "candidate_takeover_resumed",
          timestamp: new Date().toISOString(),
          data: {
            // NO priorOwnerTask: state already names the new owner, and NO
            // committedRevision claim: on this path `commit.state` is the
            // CURRENT state, possibly many revisions after the original write.
            cycleNonce: commit.postimage.cycleNonce,
            intentTransitionId: commit.postimage.intentTransitionId,
            intentClosed: commit.close.ok,
          },
        }
      : {
          rev: commit.state.revision,
          type: "candidate_takeover",
          timestamp: new Date().toISOString(),
          data: {
            takeoverKind: "owner_gone_candidate_takeover",
            priorOwnerTask,
            newOwnerTask: callerTask,
            heartbeatGeneration: commit.state.heartbeatGeneration ?? null,
            cycleNonce: commit.postimage.cycleNonce,
            intentTransitionId: commit.postimage.intentTransitionId,
            committedRevision: commit.state.revision,
            intentClosed: commit.close.ok,
          },
        });
  } catch { /* events.log is supplementary */ }

  const state = commit.state;
  const item = state.ticket
    ? `ticket ${(state.ticket as Record<string, unknown>).displayId as string | undefined ?? state.ticket.id}: ${state.ticket.title}`
    : state.currentIssue
      ? `issue ${state.currentIssue.id}`
      : "no item";

  return guideResult(state, state.state, {
    instruction: [
      `# Ownership of session ${sessionId} is now yours`,
      "",
      `The recorded owner was confirmed gone and the takeover committed${commit.resumed ? " (verified an earlier attempt that had already landed; nothing was rewritten)" : ""}.`,
      "",
      `- State: ${state.state}`,
      `- Working on: ${item}`,
      // On a RESUMED commit the earlier attempt already wrote this caller as
      // owner, so `priorOwnerTask` IS the caller -- rendering it would tell the
      // operator they took the session over from themselves. The audit event
      // omits the field on that path for the same reason; the directive must
      // not contradict it.
      commit.resumed
        ? "- Previous owner: not recoverable here (the takeover had already landed before this call)"
        : `- Previous owner: ${priorOwnerTask ? `${priorOwnerTask.client}:${priorOwnerTask.id}` : "none recorded"}`,
      "",
      "The session was NOT advanced, re-entered or otherwise touched beyond the ownership write.",
      `Continue it with an ordinary call: action "report" for the work ${state.state} owes.`,
    ].join("\n"),
    reminders: [
      "You are now the owner. Nothing about the work changed -- only who is driving it.",
      "The takeover established a fresh ownership lease; your next ordinary guide call renews it as usual.",
    ],
  });
}

/** What the ticket side of a cancellation may HONESTLY be said to have done. */
function describeCancelTicketWork(work: CandidateTicketWork): string {
  switch (work.kind) {
    case "release":
      return `- Ticket: claim released (${work.preimage.ticketId}).`;
    case "none":
      return work.why === "no-ticket"
        ? "- Ticket: none was held, so nothing was owed."
        : `- Ticket: the claim was not held by this session, so nothing was owed (${work.detail}).`;
    case "blocked":
      // The distinction this whole three-arm type exists for. "Nothing was
      // owed" is a POSITIVE finding; this is the absence of a finding, and
      // reporting the second as the first would quietly assert that a ticket
      // was checked and found unowned when in fact it could not be read.
      return `- Ticket: LEFT ALONE because it could not be determined what was owed (${work.why}: ${work.detail}).`;
  }
}

/**
 * END a session whose recorded owner is confirmed gone (T-450 step 8.3).
 *
 * The second door onto the step-6b authority layer. 7b's door ADOPTS such a
 * session; this one terminates it, for the case where there is nothing worth
 * continuing and the only alternatives were the dead owning task and the admin
 * CLI.
 *
 * NO PRE-CHECK, and the divergence from 7b's shape is what the bytes support
 * rather than a simplification. 7b runs one for exactly one reason: its commit's
 * first act stages a heartbeat generation, which spawns a child and blocks on
 * readiness, so committing before the handshake is plausible would
 * spawn-and-kill a process on every refusal. The cancel commit stages nothing
 * and spawns nothing, so that rationale is simply absent.
 *
 * It would also be ACTIVELY WRONG here. The handshake returns
 * `re-confirm / revision-moved` whenever the session revision has moved off the
 * confirmed one, and a cancellation whose write 1 landed sits at
 * `confirmedSessionRevision + 1` BY CONSTRUCTION -- so a pre-check would refuse
 * every crash retry. The commit is resume-first and returns from its
 * transition-record branch BEFORE its own internal handshake call, which is
 * precisely why the retry works: it is validated by the phase-specific resume
 * validators instead, under the lock. Putting a gate in front of that would
 * convert a refusal that is correct in context into a permanent stranding.
 */
async function handleCandidateCancel(
  root: string,
  args: GuideInput,
  info: ActiveSessionInfo,
  confirmed: OwnerGoneCandidateCancel,
): Promise<McpToolResult> {
  const sessionId = args.sessionId!;
  const callerTask = ownerTaskForCurrentClient(args.clientTaskId);
  if (!callerTask) {
    // The same SHAPE as the other candidate door's refusal, differing only in
    // what the identity is needed FOR: takeover rebinds ownership, a
    // cancellation is attributed to the task that ended the session.
    return guideError(new Error(
      `Recovering session ${sessionId} requires a valid clientTaskId so the cancellation can be attributed.`,
    ));
  }

  const input: CandidateHandshakeInput = {
    sessionId: info.state.sessionId,
    clientTaskId: args.clientTaskId,
    confirmedSessionRevision: confirmed.sessionRevision,
    confirmedFingerprint: confirmed.evidenceFingerprint,
  };
  const handshake = candidateHandshakeDeps(root, info.dir);

  // The Locked form: `handleAutonomousGuide` already holds the session lock, and
  // the WithSessionLock variant would self-deadlock.
  const commit = await commitCandidateCancelLocked(
    root,
    info.dir,
    { input, callerTask },
    { handshake },
  );

  if (commit.kind === "refused") {
    const fresh = commit.authorization
      ? `\n${describeCandidateAuthorizationRefusal(sessionId, commit.authorization, "cancel")}`
      : "";
    return guideError(new Error(
      `Cancellation of session ${sessionId} did not commit at stage "${commit.stage}": ` +
      `${describeCancelRefusalStage(commit.stage)}. ${commit.detail}${fresh}`,
    ));
  }

  if (commit.kind === "already-complete") {
    // A fact, not an error: the cycle this caller is holding had already been
    // finished, and saying so is the honest answer to a retry.
    return guideResult(info.state, info.state.state, {
      instruction: [
        `# Session ${sessionId} was already ended`,
        "",
        `The owner-gone cancellation for this session had already completed. ${commit.detail}`,
        "",
        // No cancellation WORK repeated, which is the guarantee. But the retry
        // still closes the durable intent, so claiming nothing was written
        // would be false -- and a close that FAILED is a live recovery concern
        // the operator needs told about, not swallowed by a success sentence.
        // "VERIFIED", not "closed on this retry". On this path the cycle was
        // already complete when the call arrived, so the close is a no-op that
        // confirms an existing closed intent rather than an action this call
        // performed. Claiming the retry closed it would credit this call with
        // work it did not do -- the same rendered-prose truthfulness problem as
        // the resumed sentences above.
        commit.close.ok
          ? "No cancellation work was repeated, and the durable intent was verified already closed."
          : `No cancellation work was repeated, and the durable intent could NOT be verified closed: ${commit.close.reason}. The cycle remains retryable.`,
      ].join("\n"),
      reminders: ["A completed cancellation is idempotent: retrying it verifies, it does not repeat."],
    });
  }

  // AUDIT, honest on both paths, and two event types for the same reason 7b has
  // two: a resumed publication cannot supply what a fresh one can, and
  // null-filling the difference invites a false reading.
  try {
    appendEvent(info.dir, commit.resumed
      ? {
          rev: commit.state.revision,
          type: "candidate_cancel_resumed",
          timestamp: new Date().toISOString(),
          data: {
            tailCompleted: commit.tail.completed,
            tailUnmet: commit.tail.unmet,
            intentClosed: commit.close.ok,
          },
        }
      : {
          rev: commit.state.revision,
          type: "candidate_cancel_published",
          timestamp: new Date().toISOString(),
          data: {
            cancelKind: "owner_gone_candidate_cancellation",
            endedByTask: callerTask,
            ticketWork: commit.ticketWork.kind,
            tailCompleted: commit.tail.completed,
            tailUnmet: commit.tail.unmet,
            intentClosed: commit.close.ok,
          },
        });
  } catch { /* events.log is supplementary */ }

  const state = commit.state;
  return guideResult(state, state.state, {
    instruction: [
      `# Session ${sessionId} has been ended`,
      "",
      // `resumed` covers BOTH resume branches, and they differ in what they
      // did: the `published` branch finishes a cycle whose terminal write had
      // already landed, while the `stash_pending` branch publishes it now. So
      // the wording is phase-neutral and makes no "nothing was rewritten"
      // claim, which would be false on the second branch and not quite true on
      // the first either, where the tail and the intent close still write.
      `The recorded owner was confirmed gone and the cancellation committed${commit.resumed ? " (this call finished an earlier attempt's durable cancellation cycle rather than starting a new one)" : ""}.`,
      "",
      `- State: ${state.state}`,
      // The tail is the post-publication step list, not a stash outcome. What
      // it can honestly report is whether every step completed and, when not,
      // WHICH ones did not -- an unmet step is a real loose end an operator may
      // need to finish by hand, so naming them beats a bare "incomplete".
      commit.tail.completed
        ? "- Shutdown steps: all completed."
        : `- Shutdown steps: INCOMPLETE, unmet: ${commit.tail.unmet.join(", ") || "unspecified"}.`,
      // WHAT MAY BE SAID depends on which arm this is, and the type enforces it
      // rather than leaving the renderer to guess. A fresh publication carries
      // the ticket finding; a resumed one genuinely does not have it, and
      // inventing one would be the false reading the two audit types avoid.
      commit.resumed
        // PHASE-NEUTRAL, for the same reason the sentence above is: `resumed`
        // spans both resume branches, and on the `stash_pending` one the
        // publication had NOT landed before this call -- this call performs it.
        // What is true on both is that the finding belonged to the earlier,
        // crashed authorization and is not reconstructible here.
        ? "- Ticket: the original authorization finding is unavailable, because this call resumed an earlier durable cancellation cycle rather than authorizing a new one."
        : describeCancelTicketWork(commit.ticketWork),
      "",
      "This session is terminal. It was not advanced or re-entered.",
    ].join("\n"),
    reminders: [
      "The session is ended. Start a new one for further work; this one cannot be resumed.",
    ],
  });
}

async function handleResume(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) return guideError(new Error("sessionId is required for resume"));

  // ISS-902: a resume against a newer-schema session must say "restart the client",
  // not "not found" -- this is the exact path that stranded the T-328 session.
  const resumeLookup = findSessionByIdDetailed(root, args.sessionId);
  if (resumeLookup.kind !== "found") {
    return guideError(new Error(describeSessionLookupFailure(args.sessionId, resumeLookup)));
  }
  let info = resumeLookup.info;

  const activityCheck = checkSessionStillActive(info.dir);
  if (activityCheck.kind === "refused") {
    return guideError(new Error(
      `Cannot resume session ${args.sessionId}: ${activityCheck.reason}`,
    ));
  }

  // -------------------------------------------------------------------------
  // T-450 step 7b.2: the owner-gone candidate takeover of a LIVE, non-COMPACT
  // session. The ONE door out of the COMPACT-only rule below, and it is a
  // separate handler rather than a widening of the body that follows: the
  // COMPACT body applies preCompactState recovery, clears compactPending,
  // resets pressure and removes the resume marker, and applying any of that to
  // a mid-IMPLEMENT session corrupts it.
  // -------------------------------------------------------------------------
  const candidateRequest = args.ownerGoneCandidateTakeover;
  if (candidateRequest && String(info.state.state) === "COMPACT") {
    // NOT silently ignored. Falling through would let `takeover: true` drive
    // the ordinary COMPACT path while the confirmation object -- which the
    // caller has already shown a human -- is accepted and discarded.
    return guideError(new Error(
      `Session ${args.sessionId} is in COMPACT state, where takeover: true is already the confirmed-owner-gone path. ` +
      "Retry without ownerGoneCandidateTakeover; the candidate handshake is for LIVE non-COMPACT sessions.",
    ));
  }
  if (candidateRequest && args.takeover === true && !isLeaseExpired(info.state)) {
    // THE LIVE-LEASE CONJUNCT IS THE SCOPE BOUNDARY, and only that.
    //
    // It is NOT what keeps a published takeover from being adoptable -- the
    // commit re-stamps the fence in its own atomic write, so a takeover
    // authorized here lands with a full lease however long the handshake took.
    // What the conjunct does is hold this door to the case the ticket is
    // about, a LIVE non-COMPACT lease. An EXPIRED lease is a different
    // question with a different existing answer: `adoptExpiredLease` already
    // rebinds ownership and refreshes the lease for any identified caller on
    // `report` or `pre_compact`, deliberately bypassing foreign-owner
    // precedence, so putting the five-step handshake in front of it would be
    // ceremony over a gate that reaches the same place without it.
    //
    // An expired-lease non-COMPACT session with a dead owner still has no
    // non-destructive adoption path, because both of those doors require
    // something to report. That hole is PRE-EXISTING (it holds on
    // main today; this step neither creates nor widens it) and is the
    // complement of this ticket's subject, "live non-COMPACT leases". Filed as
    // ISS-964 with the mechanism and the scope boundary in both directions.
    return handleCandidateTakeoverResume(root, args, info, candidateRequest);
  }

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
      "explicit owner-gone-candidate confirmation flow.",
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
  const resumeBlock = await claimPreflightBlock(root, info.dir, info.state);
  if (resumeBlock) return resumeBlock;

  // ISS-024: recover any pending mutation before processing
  const recoveredState = await recoverPendingMutation(info.dir, info.state, root);
  if (recoveredState !== info.state) {
    const reread = findSessionById(root, args.sessionId);
    if (reread) Object.assign(info, reread);
  }

  // ISS-037: drain pending deferrals from before compact
  // Must capture return value -- subsequent writes spread info.state as base
  info = { ...info, state: await drainPendingDeferrals(root, info.dir, info.state) };

  // Revalidate after pending-mutation recovery in case it repaired state.
  if (info.state.state !== "COMPACT") {
    return guideError(new Error(
      `Session ${args.sessionId} is not in COMPACT state (current: ${info.state.state}). Use action: "report" to continue.`,
    ));
  }

  // Check compactPending -- stale COMPACT sessions get a clear message
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
    // Keep compactPending -- session must remain discoverable
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
    // T-450 step 7b.4: a TAKEN-OVER session carries a generation, and its
    // replacement sidecar belongs in that generation's directory -- spawning
    // into legacy would attach the new owner's heartbeat to the displaced
    // owner's telemetry. On an unusable generation this spawns NOTHING rather
    // than falling back, for the same reason.
    const spawn = spawnAliveSidecarFor(info.dir, info.state.heartbeatGeneration);
    resumeSidecarPid = spawn.kind === "spawned" ? spawn.pid : null;
  } catch { /* best-effort */ }

  try {

  if (expectedHead && headResult.data.hash !== expectedHead && !ownCommitDrift) {
    // External drift or gitIsAncestor error -- existing recovery
    let mapping = RECOVERY_MAPPING[resumeState] ?? { state: "PICK_TICKET", resetPlan: false, resetCode: false };

    // T-208: Issue-aware drift override -- prevent CODE_REVIEW from drifting to PLAN when currentIssue is set
    if (info.state.currentIssue && resumeState === "CODE_REVIEW") {
      mapping = { state: "ISSUE_FIX", resetPlan: false, resetCode: true };
    }

    // ISS-965 F2 (byte-review fixup): RECOVERY_MAPPING.HANDOVER -> SESSION_END
    // was dead code before terminal routing existed (preCompactState could
    // never BE "HANDOVER" -- both compact-prep writers rewrote it to
    // PICK_TICKET). session.ts's resolveCompactResumeTarget now preserves it
    // for a terminalized session, which makes this reachable: a terminalized
    // session that drifts to a non-descendant commit during its park would
    // otherwise land in SESSION_END with no status change, no handover, no
    // shutdown marker, and no registered stage to receive its next report --
    // a permanent dead end, since findActiveSessionFull still counts it as
    // active. The drift itself is irrelevant here: the ticket is already
    // complete and the session is only ending, so it must still land at
    // HANDOVER to write its handover. Discriminate on the marker, exactly as
    // Change 5 does -- never on resumeState alone, so an ordinary (non-
    // terminalized) HANDOVER resume is untouched should some other path ever
    // make it reachable.
    if (info.state.terminalDisposition?.kind === "completion-observed" && resumeState === "HANDOVER") {
      mapping = { state: "HANDOVER", resetPlan: false, resetCode: false };
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
      finalizedItem: null,
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

    // ISS-965 F2 (Codex round on the fixup): landing driftWritten.state at
    // "HANDOVER" is not enough on its own -- falling through to the generic
    // "Recovered to state: HANDOVER. Continue from here." fallback below
    // leaves the session technically reportable but never actually tells the
    // agent to write a handover, which is the one thing left to do. Return
    // the SAME terminal instruction the non-drift path gives (the ticket is
    // complete either way; the drift is irrelevant to what the agent needs to
    // do next), so a real agent -- not just a manually-issued follow-up call
    // in a test -- has the protocol needed to advance.
    if (mapping.state === "HANDOVER" && driftWritten.terminalDisposition?.kind === "completion-observed") {
      return guideResult(driftWritten, "HANDOVER", {
        instruction: [
          `# ${resumeHeading} -- HEAD Mismatch`,
          "",
          driftPreamble,
          renderTerminalHandoverInstruction(driftWritten),
        ].join("\n"),
        reminders: [],
      });
    }

    // Fallback for unmapped states
    return guideResult(driftWritten, mapping.state, {
      instruction: `# ${resumeHeading} -- HEAD Mismatch\n\n${driftPreamble}Recovered to state: **${mapping.state}**. Continue from here.`,
      reminders: [],
    });
  }

  // Branch A: HEAD matches -- normal resume (or own-commit drift from T-184)
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
        "You are in autonomous mode -- continue working.",
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
  //
  // T-450 step 7b: SCOPED TO THE COMPACT PATH by construction. An owner-gone
  // candidate takeover returns from the split near the top of `handleResume`
  // and never arrives here, which is the point: `CompleteStage.enter` writes
  // state unconditionally and `FinalizeStage.enter` runs git and can
  // fast-forward into `handleCommit`, so reaching this line on a live
  // mid-IMPLEMENT session would break the takeover's one-atomic-write promise
  // and could commit on the new owner's behalf. The early return is the
  // guarantee; do not relax it into a flag checked here.
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

  // Stage not registered -- fall back to generic instruction
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

  const activityCheck = checkSessionStillActive(info.dir);
  if (activityCheck.kind === "refused") {
    return guideError(new Error(
      `Cannot prepare session ${args.sessionId} for compaction: ${activityCheck.reason}`,
    ));
  }

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
    "# Cancel Refused -- this session is mid-pipeline and healthy",
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

async function handleCancel(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) {
    // Cancel without session ID -- check for any active session
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

  // -------------------------------------------------------------------------
  // T-450 step 8.2: the owner-gone candidate CANCELLATION.
  //
  // ROUTED ON FIELD PRESENCE ALONE. Two earlier drafts added conjuncts here --
  // a foreign live-ownership conflict, and a terminal-session refusal -- and
  // BOTH silently dropped the confirmed field in cases they had not thought of:
  //
  //   * `liveOwnershipConflict` returns null outright on an EXPIRED lease, so
  //     gating on it sent an expired-lease foreign session down the ordinary
  //     cancel path while the caller believed a confirmed owner-gone
  //     cancellation had run.
  //   * a terminal refusal here would have stranded the crash retry FOREVER.
  //     Write 4 bundles SESSION_END, `status: completed` and the published
  //     transition into ONE write, so a crash before the tail leaves a terminal
  //     session carrying a published candidate transition, which is exactly
  //     what the commit's published-resume branch exists to finish.
  //
  // Both were the same error: a gate in front of a RESUME-FIRST commit. A gate
  // cannot see the durable records that make a retry legitimate, so it converts
  // a refusal that is correct in context into a permanent stranding. Every
  // question about whether this caller may proceed is answered by the commit,
  // under the lock, from state it reads itself.
  //
  // The boundary above has already guaranteed an explicit sessionId, so no
  // auto-selected session can reach here.
  if (args.ownerGoneCandidateCancel !== undefined) {
    return handleCandidateCancel(root, args, info, args.ownerGoneCandidateCancel);
  }

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

  // THE RECOVERY DISPATCHER (T-450 step 6a). Placed here deliberately: after
  // lookup and authority validation, and before ANY state write, so a refusal
  // below costs no revision.
  //
  // A cancel that crashed between write 1 and write 4 leaves the session NOT in
  // SESSION_END, so a re-issued cancel reaches the ordinary path, which would
  // run a FRESH cancellation: re-derive the disposition and attempt a SECOND
  // pop. Both are wrong. The second pop can apply a stash that is no longer
  // there, or an unrelated one that has since taken its ref. The re-derived
  // disposition is quieter and worse: the ticket release precedes every
  // transition write, so by re-entry the ticket is already open and re-deriving
  // would record `unchanged`, asserting that nothing happened to a ticket this
  // session in fact released.
  const isTerminal = info.state.state === "SESSION_END" || info.state.status === "completed";
  const priorRead = readCancellationTransition(
    (info.state as Record<string, unknown>).cancellationTransition,
  );

  // FAIL CLOSED on a corrupt record. A malformed transition is still a record:
  // something started a cancellation here and we cannot tell what it decided.
  // Minting a fresh one would destroy the only evidence of it, and could
  // release a ticket or pop a stash the first attempt already handled.
  if (!isTerminal && priorRead.kind === "malformed") {
    return guideError(new Error(
      `Cannot cancel session ${args.sessionId}: its cancellationTransition record is unreadable ` +
      `(${priorRead.detail}). A cancellation was already started for this session and its record ` +
      `cannot be trusted, so starting a fresh one could repeat work the first attempt already did. ` +
      `Inspect .story/sessions/${args.sessionId}/state.json before retrying.`,
    ));
  }

  // THE SAME IDENTITY GATE the terminal branch applies. Without it the two
  // recovery paths disagree: a record naming another session would be REFUSED
  // on a terminal session and silently RESUMED on a live one, adopting that
  // record's transitionId, disposition and stash outcome as this session's own.
  // Fail closed for the same reason a malformed record does: the record is
  // evidence of something, we cannot tell what, and minting a fresh transition
  // over it would destroy it.
  if (!isTerminal && priorRead.kind === "valid") {
    const belongs = transitionBelongsTo(info.state, priorRead.transition);
    if (!belongs.ok) {
      return guideError(new Error(
        `Cannot cancel session ${args.sessionId}: the cancellationTransition record in its directory ` +
        `does not belong to it (${belongs.detail}). Starting a fresh cancellation would overwrite ` +
        `that record. Inspect .story/sessions/${args.sessionId}/state.json before retrying.`,
      ));
    }

    const authorized = validateRecoveryAuthority(
      priorRead.transition.authority,
      ownerTaskForCurrentClient(args.clientTaskId)?.id,
    );
    if (!authorized.ok) {
      return guideError(new Error(
        `Cannot cancel session ${args.sessionId}: ${authorized.detail}.`,
      ));
    }

    // THE RE-ENTRY SHAPE CHECK, per phase. A null outcome means only write 1
    // ran, so the session sits exactly at tSR; a concrete outcome adds write 3.
    // A session that has moved past the expected revision was written by
    // something AFTER the crash, and resuming over that would publish a
    // terminalRevision the published equation rejects, leaving a record 6b's
    // locked validator refuses forever.
    if (priorRead.transition.phase === "stash_pending") {
      const t = priorRead.transition;
      const expected = t.stash.outcome === null
        ? t.transitionStartedRevision
        : t.transitionStartedRevision + 1;
      if (info.state.revision !== expected) {
        return guideError(new Error(
          `Cannot cancel session ${args.sessionId}: its cancellationTransition record expects the ` +
          `session at revision ${expected} (transitionStartedRevision ${t.transitionStartedRevision}, ` +
          `outcome ${t.stash.outcome === null ? "undecided" : "recorded"}), but the session is at ` +
          `revision ${info.state.revision}. Something wrote the session after the interrupted ` +
          `cancellation, so resuming is not safe. Inspect ` +
          `.story/sessions/${args.sessionId}/state.json before retrying.`,
        ));
      }
    }
  }

  // CONTRADICTORY EVIDENCE, refused rather than normalized. Write 4 sets
  // SESSION_END, `status: completed` and the published record in ONE write, so
  // no crash can produce a published transition on a live session. Resuming one
  // would drive it back through `stash_pending` and republish it with a fresh
  // `endedAt` and `terminalRevision`, overwriting the termination time and
  // revision the first publication recorded. The terminal path already refuses
  // the mirror image of this; the two paths must not disagree.
  if (!isTerminal && priorRead.kind === "valid" && priorRead.transition.phase !== "stash_pending") {
    return guideError(new Error(
      `Cannot cancel session ${args.sessionId}: its cancellationTransition is recorded as ` +
      `${priorRead.transition.phase} while the session is still live, which cannot happen through ` +
      `the cancellation protocol (publication and termination are one write). Resuming it would ` +
      `overwrite the termination time it already carries. Inspect ` +
      `.story/sessions/${args.sessionId}/state.json before retrying.`,
    ));
  }

  // Resume the interrupted transition under its ORIGINAL id. A fresh id would
  // orphan the first attempt's evidence, which is keyed by that id.
  const resume = !isTerminal && priorRead.kind === "valid" && priorRead.transition.phase === "stash_pending"
    ? priorRead.transition
    : undefined;

  // ISS-052 + ISS-066: Allow cancel from any state. Already-ended sessions are
  // rejected, EXCEPT the one narrowly authorized case where the session is
  // terminal only because publication landed and the tail did not.
  if (isTerminal) {
    const authorized = authorizeTailRecovery(
      info.dir, info.state, priorRead,
      ownerTaskForCurrentClient(args.clientTaskId)?.id,
    );
    if (authorized.kind === "refuse") return guideError(new Error(authorized.message));

    const t = authorized.transition;
    // NO STATE WRITE, and therefore no status refresh. `buildInactivePayload()`
    // (status-payload.ts:89-95) carries no sessionId, so a refresh here would
    // blank status.json with no way to tell whose session it had described,
    // making a DIFFERENT session that became active in the meantime vanish from
    // status while still running. The state is already terminal and already
    // published; there is nothing about it left to record.
    const tail = runCancellationTail(root, { dir: info.dir, state: info.state }, {
      published: t,
      // Every one of these comes from the RECORD. The session itself no longer
      // knows them: its `state` is SESSION_END rather than the state the
      // cancellation interrupted, and its revision has moved past the one the
      // audit event has to carry.
      disposition: t.disposition,
      stashPopFailed: t.stash.outcome === "failed",
      previousState: info.state.previousState ?? "unknown",
      terminalRevision: t.terminalRevision,
      mode: "recovery",
    });

    // SAY WHAT HAPPENED, not what was attempted. The tail is six best-effort
    // effects; claiming completion without consulting its verdict would be the
    // same class of untruth the completion marker exists to prevent, moved into
    // the operator-facing text.
    const preamble = `Session ${args.sessionId} was already cancelled, but its shutdown had not finished. `;
    const scope = " No ticket, stash or session state was changed.";
    return {
      content: [{
        type: "text",
        text: tail.completed
          ? `${preamble}Completed the remaining shutdown for transition ${t.transitionId} `
            + `(ended ${t.endedAt}).${scope}`
          : `${preamble}Advanced it, but it is still NOT complete: ${tail.unmet.join("; ")}. `
            + `${retryAdvice(info.dir, t.transitionId)}${scope}`,
      }],
    };
  }

  // T-178: Soft gate -- reject context-motivated cancel in active auto sessions
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
  // ISS-965 F3 (byte-review fixup): "completed-consistent" makes isClaimLost
  // false BY DESIGN (it is not a loss), which means claimLost alone can no
  // longer stand for "nothing unusual here" -- it now also covers a session
  // whose OWN ticket has already completed out from under it (pre-
  // terminalization: claimPreflightBlock has not yet run for this stage, or
  // this is a state outside RECONCILED_STATES where it never will). Refusing
  // to cancel that session with "no claim-loss condition was detected, continue
  // the pipeline" is wrong -- there is no pipeline left to continue, the ticket
  // is done. Stand the soft gate down for this shape specifically, same as a
  // genuine loss, WITHOUT touching cancelClaimPosture: mayWriteTicket below is
  // computed independently and stays "lost" for this posture (D4/Ruling-3),
  // so standing the gate down here only lets the session END; it grants no
  // additional ledger-write permission.
  const consistentCompletion = preflight?.reconciliation?.status === "completed-consistent";
  const posture = await cancelClaimPosture(root, info.state);
  const mayWriteTicket = posture === "held" || posture === "no-epoch";
  // `!resume`: the soft gate exists to stop a cancel from STARTING, and this
  // cancellation already started. Refusing here would strand a session that is
  // durably mid-transition, with no route to finish it.
  if (!resume && isAutoMode && hasTicketsRemaining && isWorkingState && !isStuck && !claimLost && !consistentCompletion) {
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
  if (resume) {
    // No ticket work is repeated. The first attempt already ran it, and its
    // result is what the transition record carries.
  } else if (mayWriteTicket) {
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
  const draftTicketId = (mayWriteTicket && !resume) ? cancelInfo.state.ticket?.id : undefined;
  if (resume) {
    // FROM THE RECORD, never re-derived. This is the disposition the first
    // attempt actually acted on.
    disposition = resume.disposition;
  } else if (!mayWriteTicket) {
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

  const { written, stashPopFailed, tail } = await applyCancellationTransition(
    root,
    { dir: cancelInfo.dir, state: cancelInfo.state },
    disposition,
    resume,
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

  const stashNote = stashPopFailed ? " Auto-stash pop failed -- run `git stash pop` manually." : "";
  // F1 (pen byte-review of 1091b226): the resumed path must not assert a
  // completion it never checked -- the same honesty rule the terminal branch
  // already follows. Scoped to RESUME: the fresh-cancel reply predates the
  // protocol and its tail truth is carried by the completion marker and the
  // artifacts, which recovery reads; changing its text is not this fixup.
  const tailNote = resume && !tail.completed
    ? ` Shutdown is NOT yet complete: ${tail.unmet.join("; ")}. ${retryAdvice(cancelInfo.dir, resume.transitionId)}`
    : "";
  return {
    content: [{ type: "text", text: `Session ${args.sessionId} cancelled. ${written.completedTickets.length} ticket(s) and ${(written.resolvedIssues ?? []).length} issue(s) were completed.${stashNote}${tailNote}${reportSection}` }],
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
