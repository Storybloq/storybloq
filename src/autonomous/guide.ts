import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  deriveWorkspaceId,
  WORKFLOW_STATES,
  type GuideInput,
  type GuideOutput,
  type FullSessionState,
  type SessionSummary,
  type WorkflowState,
} from "./session-types.js";
import {
  createSession,
  deleteSession,
  writeSessionSync,
  appendEvent,
  refreshLease,
  isLeaseExpired,
  findActiveSessionFull,
  findStaleSessions,
  findSessionById,
  sessionDir,
  withSessionLock,
  type SessionConfig,
  prepareForCompact,
  findResumableSession,
} from "./session.js";
import { assertTransition } from "./state-machine.js";
import { evaluatePressure } from "./context-pressure.js";
import { assessRisk, requiredRounds, nextReviewer } from "./review-depth.js";
import { gitHead, gitStatus, gitMergeBase, gitDiffStat, gitDiffNames, gitDiffCachedNames, gitBlobHash, gitStash, gitStashPop, gitIsAncestor } from "./git-inspector.js";
import { resolveRecipe } from "./recipes/loader.js";
import { getStage, findNextStage, findFirstPostComplete, findNextPostComplete, type NextStageResult } from "./stages/registry.js";
import { StageContext, isStageAdvance, type StageAdvance, type StageResult } from "./stages/types.js";
import "./stages/index.js"; // Register all extracted stages

import { loadProject } from "../core/project-loader.js";
import { buildLessonDigest } from "../core/lessons.js";
import { loadLatestSnapshot } from "../core/snapshot.js";
import { buildRecap } from "../core/snapshot.js";
import { nextTickets } from "../core/queries.js";
import { recommend, type RecommendOptions } from "../core/recommend.js";
import { checkVersionMismatch, getInstalledVersion, getRunningVersion } from "./version-check.js";
import { writeResumeMarker, removeResumeMarker } from "./resume-marker.js";
import { formatCompactReport } from "../core/session-report-formatter.js";
import { isTargetedMode, getRemainingTargets, buildTargetedCandidatesText, buildTargetedPickInstruction, buildTargetedStuckHandover } from "./target-work.js";
import {
  handleHandoverLatest,
  handleHandoverCreate,
} from "../cli/commands/handover.js";
import type { CommandContext } from "../cli/types.js";

// ---------------------------------------------------------------------------
// Recovery mapping — exported for test completeness checks (ISS-040)
// ---------------------------------------------------------------------------

export const RECOVERY_MAPPING: Readonly<Record<string, { state: string; resetPlan: boolean; resetCode: boolean }>> = {
  PICK_TICKET:    { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  COMPLETE:       { state: "PICK_TICKET", resetPlan: false, resetCode: false },
  HANDOVER:       { state: "PICK_TICKET", resetPlan: false, resetCode: false },
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

function buildGuideRecommendOptions(root: string): RecommendOptions {
  const opts: { latestHandoverContent?: string; previousOpenIssueCount?: number } = {};

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
        'Call `claudestory_autonomous_guide` with:',
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
    return writeSessionSync(dir, cleared);
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
        writeSessionSync(dir, { ...state, pendingProjectMutation: null });
      }
    });
  } catch {
    // Lock/IO failure — leave marker for next attempt
    return state;
  }

  // Conflict detected — marker cleared, no postMutation applied
  if (conflict) {
    // Re-read the state we just wrote (with cleared marker)
    const { readSession } = await import("./session.js");
    return readSession(dir) ?? state;
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

  return writeSessionSync(dir, cleared as FullSessionState);
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

/**
 * File issues for deferred findings. Called after review round is validated and written.
 * Adds to pendingDeferrals first (durable), then attempts to file, moves to filedDeferrals on success.
 */
async function fileDeferredFindings(
  root: string,
  dir: string,
  state: FullSessionState,
  findings: readonly { severity: string; category: string; description: string; disposition: string }[],
  reviewKind: "plan" | "code",
): Promise<FullSessionState> {
  const deferred = findings.filter(f => f.disposition === "deferred" && f.severity !== "suggestion");
  if (deferred.length === 0) return state;

  const pending = [...(state.pendingDeferrals ?? [])];
  for (const f of deferred) {
    const fp = simpleHash(`${state.ticket?.id ?? ""}:${reviewKind}:${f.severity}:${f.category}:${f.description}`);
    if ((state.filedDeferrals ?? []).some(d => d.fingerprint === fp)) continue;
    if (pending.some(d => d.fingerprint === fp)) continue;
    pending.push({ fingerprint: fp, severity: f.severity, category: f.category, description: f.description, reviewKind });
  }

  // Persist pending entries first (crash-safe: survives before drain attempt)
  const persisted = writeSessionSync(dir, { ...state, pendingDeferrals: pending } as FullSessionState);
  let updated = await drainPendingDeferrals(root, dir, persisted);
  return updated;
}

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
  return writeSessionSync(dir, updated as FullSessionState);
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
// start — INIT + LOAD_CONTEXT → PICK_TICKET
// ---------------------------------------------------------------------------

async function handleStart(root: string, args: GuideInput): Promise<McpToolResult> {
  // ISS-024: recover pending mutations on existing sessions before checking
  let existing = findActiveSessionFull(root);
  if (existing && !isLeaseExpired(existing.state)) {
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
      if (isStale) {
        return guideError(new Error(
          `Stale compacted session ${existing.state.sessionId} found (prepared ${Math.round((Date.now() - preparedAt) / 60000)} minutes ago, never resumed). ` +
          `SessionStart hook is no longer prompting for this session.\n` +
          `- To resume anyway: call action "resume" with sessionId "${existing.state.sessionId}"\n` +
          `- To abandon and start fresh: run "claudestory session stop ${existing.state.sessionId}"`,
        ));
      }
      return guideError(new Error(
        `Active session ${existing.state.sessionId} is awaiting compaction resume.\n` +
        `- To continue: call action "resume" with sessionId "${existing.state.sessionId}"\n` +
        `- To abandon: run "claudestory session clear-compact ${existing.state.sessionId}"`,
      ));
    }
    return guideError(new Error(
      `Active session ${existing.state.sessionId} already exists for this workspace. ` +
      `Use action: "resume" to continue or "cancel" to end it.`,
    ));
  }

  // ISS-032: Also check for compactPending sessions with expired leases
  // (findActiveSessionFull filters expired leases, so compacted sessions >45min old are invisible)
  if (!existing) {
    const resumable = findResumableSession(root);
    if (resumable) {
      const sid = resumable.info.state.sessionId;
      const preparedAt = resumable.info.state.compactPreparedAt ? new Date(resumable.info.state.compactPreparedAt).getTime() : 0;
      return guideError(new Error(
        `${resumable.stale ? "Stale c" : "C"}ompacted session ${sid} found (prepared ${Math.round((Date.now() - preparedAt) / 60000)} minutes ago, lease expired but not resumed).\n` +
        `- To resume: call action "resume" with sessionId "${sid}"\n` +
        `- To abandon: run "claudestory session stop ${sid}"`,
      ));
    }
  }

  // Supersede any stale sessions (findActiveSessionFull filters these out, so scan separately)
  const staleSessions = findStaleSessions(root);
  for (const stale of staleSessions) {
    writeSessionSync(stale.dir, { ...stale.state, status: "superseded" as const });
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
    const { TICKET_ID_REGEX, ISSUE_ID_REGEX } = await import("../models/types.js");
    const invalidIds: string[] = [];
    const alreadyDone: string[] = [];
    for (const id of rawTargetWork) {
      if (ISSUE_ID_REGEX.test(id)) {
        const issue = targetProjectState.issues.find(i => i.id === id);
        if (!issue) { invalidIds.push(id); continue; }
        if (issue.status === "resolved") { alreadyDone.push(id); continue; }
      } else if (TICKET_ID_REGEX.test(id)) {
        const ticket = targetProjectState.ticketByID(id);
        if (!ticket) { invalidIds.push(id); continue; }
        if (ticket.status === "complete") { alreadyDone.push(id); continue; }
      } else {
        invalidIds.push(id);
      }
    }
    if (invalidIds.length > 0) {
      return guideError(new Error(
        `Invalid target IDs: ${invalidIds.join(", ")}. Use T-XXX for tickets or ISS-XXX for issues.`,
      ));
    }
    validatedTargetWork = [...new Set(rawTargetWork.filter(id => !alreadyDone.includes(id)))];
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
      if (typeof overrides.handoverInterval === "number") sessionConfig.handoverInterval = overrides.handoverInterval;
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
    stages: sessionConfig.stageOverrides,
  });

  // T-183: Clean stale resume marker before creating a new session
  removeResumeMarker(root);

  // Create session — wrapped in try/finally for cleanup on failure
  const session = createSession(root, recipe, wsId, sessionConfig);
  const dir = sessionDir(root, session.sessionId);

  try {
    // Check git state
    const headResult = await gitHead(root);
    if (!headResult.ok) {
      deleteSession(root, session.sessionId);
      return guideError(new Error("This directory is not a git repository or git is not available. Autonomous mode requires git."));
    }

    // Check for staged changes (review mode skips — dirty tree allowed)
    if (mode !== "review") {
      const stagedResult = await gitDiffCachedNames(root);
      if (stagedResult.ok && stagedResult.data.length > 0) {
        deleteSession(root, session.sessionId);
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
        // Skip .story/ files — managed by claudestory, always safe to have dirty
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
        const stashMessage = `claudestory-auto-${session.sessionId}`;
        const stashResult = await gitStash(root, stashMessage);
        if (!stashResult.ok) {
          deleteSession(root, session.sessionId);
          return guideError(new Error(
            `Cannot auto-stash dirty files: ${stashResult.message}. ` +
            `Stash or commit changes manually, then call start again.`,
          ));
        }
        // Record stash ref in session for restore on completion/cancel
        autoStashRef = { ref: stashResult.data, stashedAt: new Date().toISOString() };
      } else {
        // "block" (default) — existing behavior
        deleteSession(root, session.sessionId);
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
        baseline: {
          porcelain: porcelainLines,
          dirtyTrackedFiles: dirtyTracked,
          untrackedPaths,
        },
        autoStash: autoStashRef,
      },
      // T-188: Targeted auto mode
      targetWork: validatedTargetWork,
      // T-128: Freeze resolved recipe for session lifetime (survives compact/resume)
      resolvedPipeline: resolvedRecipe.pipeline,
      resolvedPostComplete: resolvedRecipe.postComplete,
      resolvedRecipeId: resolvedRecipe.id,
      resolvedStages: resolvedRecipe.stages as Record<string, Record<string, unknown>>,
      resolvedDirtyFileHandling: resolvedRecipe.dirtyFileHandling,
      resolvedDefaults: {
        maxTicketsPerSession: resolvedRecipe.defaults.maxTicketsPerSession,
        compactThreshold: resolvedRecipe.defaults.compactThreshold,
        reviewBackends: [...resolvedRecipe.defaults.reviewBackends],
      },
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
        deleteSession(root, session.sessionId);
        return guideError(new Error(
          `WRITE_TESTS and TEST stages use different commands ("${effectiveWriteCmd}" vs "${effectiveTestCmd}"). ` +
          `They share a single test baseline, so commands must match. Use the same command for both or disable one.`,
        ));
      }
      if (!testCommand) {
        deleteSession(root, session.sessionId);
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
          deleteSession(root, session.sessionId);
          return guideError(new Error(
            "WRITE_TESTS stage is enabled but test baseline could not parse fail counts from test output. " +
            "Configure a test reporter that outputs pass/fail counts, or disable WRITE_TESTS.",
          ));
        }
      } catch {
        // Non-blocking for TEST-only. But WRITE_TESTS requires baseline.
        if (writeTestsEnabled) {
          deleteSession(root, session.sessionId);
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
        deleteSession(root, session.sessionId);
        return guideError(new Error("VERIFY stage is enabled but stages.VERIFY.startCommand is empty."));
      }
      if (readinessUrl) {
        try {
          const parsed = new URL(readinessUrl);
          if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
            deleteSession(root, session.sessionId);
            return guideError(new Error(`VERIFY stage readinessUrl must be localhost. Got: "${readinessUrl}".`));
          }
        } catch {
          deleteSession(root, session.sessionId);
          return guideError(new Error(`VERIFY stage readinessUrl is not a valid URL: "${readinessUrl}".`));
        }
      }
    }

    // Load context
    const { state: projectState, warnings } = await loadProject(root);
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
      const ticket = projectState.ticketByID(args.ticketId);
      if (!ticket) {
        deleteSession(root, session.sessionId);
        return guideError(new Error(`Ticket ${args.ticketId} not found.`));
      }

      // Validate ticket is workable (same checks as PICK_TICKET)
      if (mode !== "review") {
        // review mode allows any ticket status — user already has code
        if (ticket.status === "complete") {
          deleteSession(root, session.sessionId);
          return guideError(new Error(`Ticket ${args.ticketId} is already complete.`));
        }
        if (projectState.isBlocked(ticket)) {
          deleteSession(root, session.sessionId);
          return guideError(new Error(`Ticket ${args.ticketId} is blocked by: ${ticket.blockedBy.join(", ")}.`));
        }
      }

      // ISS-043: Check if ticket is claimed by another active session
      // Skip for review mode — user already has code, claim is irrelevant
      if (mode !== "review") {
        const claimId = (ticket as Record<string, unknown>).claimedBySession;
        if (claimId && typeof claimId === "string" && claimId !== session.sessionId) {
          const claimingSession = findSessionById(root, claimId);
          // Block only if claiming session exists, is active, and lease is not expired
          // TOCTOU: cooperative check — filesystem-based concurrency, sufficient for this use case
          if (claimingSession && claimingSession.state.status === "active" && !isLeaseExpired(claimingSession.state)) {
            deleteSession(root, session.sessionId);
            return guideError(new Error(
              `Ticket ${args.ticketId} is claimed by active session ${claimId}. ` +
              `Wait for it to finish or stop it with "claudestory session stop ${claimId}".`,
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
          title: ticket.title,
          risk: assessRisk(ticket).risk,
          claimed: true,
        },
      };

      updated = refreshLease(updated);
      const pressure = evaluatePressure(updated);
      updated = { ...updated, contextPressure: { ...updated.contextPressure, level: pressure } };
      const written = writeSessionSync(dir, updated);

      appendEvent(dir, {
        rev: written.revision,
        type: "start",
        timestamp: new Date().toISOString(),
        data: { recipe, branch: written.git.branch, head: written.git.initHead, mode, ticketId: args.ticketId },
      });

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
          `# ${modeLabels[mode]} — ${ticket.id}: ${ticket.title}`,
          "",
          `Reviewing code for ticket **${ticket.id}**. Capture the diff and run a code review.`,
          "",
          `Capture diff with: ${diffCommand}`,
          "",
          "**IMPORTANT:** Pass the FULL unified diff output to the reviewer. Do NOT summarize.",
          "",
          "When the code review is done, call `claudestory_autonomous_guide` with the verdict:",
          '```json',
          `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "code_review_round", "verdict": "<approve|revise|request_changes|reject>", "findings": [...] } }`,
          '```',
        ].join("\n");
      } else {
        instruction = [
          `# ${modeLabels[mode]} — ${ticket.id}: ${ticket.title}`,
          "",
          `Write an implementation plan for ticket **${ticket.id}**: ${ticket.title}`,
          ticket.description ? `\n**Description:**\n${ticket.description}` : "",
          "",
          `Write the plan as a markdown file at \`.story/sessions/${updated.sessionId}/plan.md\`.`,
          "Do NOT use Claude Code's plan mode.",
          "",
          "When done, call `claudestory_autonomous_guide`:",
          '```json',
          `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          '```',
        ].join("\n");
      }

      const reminders = mode === "guided"
        ? [
            "Do NOT use Claude Code's plan mode — write plans as markdown files.",
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
    const written = writeSessionSync(dir, updated);

    appendEvent(dir, {
      rev: written.revision,
      type: "start",
      timestamp: new Date().toISOString(),
      data: { recipe, branch: written.git.branch, head: written.git.initHead, mode: "auto", ...(validatedTargetWork.length > 0 ? { targetWork: validatedTargetWork } : {}) },
    });

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
        "Do NOT stop to summarize. Do NOT ask the user. Do NOT cancel for context management -- compaction is automatic.",
        "",
        targetedInstruction,
      ].join("\n");

      return guideResult(updated, "PICK_TICKET", {
        instruction,
        reminders: [
          "Do NOT use Claude Code's plan mode -- write plans as markdown files.",
          "Do NOT ask the user for confirmation or approval.",
          "Do NOT stop or summarize between items -- call autonomous_guide IMMEDIATELY.",
          "You are in targeted auto mode -- work ONLY on the listed items.",
          "NEVER cancel due to context size. Claude Story's hooks compact context automatically and preserve all session state.",
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
        `${i + 1}. **${c.ticket.id}: ${c.ticket.title}** (${c.ticket.type}, phase: ${c.ticket.phase ?? "unphased"})${c.unblockImpact.wouldUnblock.length > 0 ? ` — unblocks ${c.unblockImpact.wouldUnblock.map((t) => t.id).join(", ")}` : ""}`,
      ).join("\n");
    } else if (nextResult.kind === "all_complete") {
      candidatesText = "All tickets are complete. No work to do.";
    } else if (nextResult.kind === "all_blocked") {
      candidatesText = "All remaining tickets are blocked.";
    } else {
      candidatesText = "No tickets found.";
    }

    // T-153: Surface high/critical issues alongside ticket candidates
    const highIssues = projectState.issues.filter(
      i => i.status === "open" && (i.severity === "critical" || i.severity === "high"),
    );
    let issuesText = "";
    if (highIssues.length > 0) {
      issuesText = "\n\n## Open Issues (high+ severity)\n\n" + highIssues.map(
        (i, idx) => `${idx + 1}. **${i.id}: ${i.title}** (${i.severity})`,
      ).join("\n");
    }

    // Also get recommendations (with handover + snapshot context for ISS-018/019)
    const guideRecOptions = buildGuideRecommendOptions(root);
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
      "Do NOT stop to summarize. Do NOT ask the user. Do NOT cancel for context management — compaction is automatic. Pick a ticket or issue and start working immediately.",
      "",
      "## Ticket Candidates",
      "",
      candidatesText,
      issuesText,
      recsText,
      "",
      topCandidate
        ? `Pick **${topCandidate.ticket.id}** (highest priority) or an open issue by calling \`claudestory_autonomous_guide\` now:`
        : hasHighIssues
          ? "Pick an issue to fix by calling `claudestory_autonomous_guide` now:"
          : "Pick a ticket by calling `claudestory_autonomous_guide` now:",
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
        "Do NOT use Claude Code's plan mode — write plans as markdown files.",
        "Do NOT ask the user for confirmation or approval.",
        "Do NOT stop or summarize between tickets — call autonomous_guide IMMEDIATELY.",
        "You are in autonomous mode — continue working until done.",
        "NEVER cancel due to context size. Claude Story's hooks compact context automatically and preserve all session state.",
        ...(versionWarning ? [`**Warning:** ${versionWarning}`] : []),
      ],
      transitionedFrom: "INIT",
    });

  } catch (err) {
    // Cleanup on failure
    deleteSession(root, session.sessionId);
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
    defaults: state.resolvedDefaults ?? {
      maxTicketsPerSession: state.config.maxTicketsPerSession,
      compactThreshold: state.config.compactThreshold,
      reviewBackends: [...state.config.reviewBackends],
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
      const enterResult = "result" in advance && advance.result
        ? advance.result
        : await nextStage.enter(ctx);
      if (isStageAdvance(enterResult)) return processAdvance(ctx, nextStage, enterResult, depth + 1);
      return guideResult(ctx.state, nextStage.id, enterResult);
    }
    case "retry":
      return guideResult(ctx.state, currentStage.id, {
        instruction: advance.instruction,
        reminders: advance.reminders ? [...advance.reminders] : [],
      });
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

  const ctx = new StageContext(root, dir, state, recipe);
  const advance = await stage.report(ctx, report);
  return processAdvance(ctx, stage, advance);
}

// ---------------------------------------------------------------------------
// report — advance state machine
// ---------------------------------------------------------------------------

async function handleReport(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) return guideError(new Error("sessionId is required for report action"));
  if (!args.report) return guideError(new Error("report field is required for report action"));

  const info = findSessionById(root, args.sessionId);
  if (!info) return guideError(new Error(`Session ${args.sessionId} not found`));

  let state = refreshLease(info.state);

  // ISS-024: recover any pending mutation before processing
  state = await recoverPendingMutation(info.dir, state, root);

  // ISS-037: retry pending deferrals from previous calls
  state = await drainPendingDeferrals(root, info.dir, state);

  const currentState = state.state as WorkflowState;
  const report = args.report;

  // Fail-closed: reject reports on sessions with inconsistent compactPending (ISS-032)
  if (state.compactPending && currentState !== "COMPACT") {
    return guideError(new Error(
      `Session has pending compaction in inconsistent state (${currentState}). ` +
      `Call action: "resume" or run "claudestory session stop ${args.sessionId}".`,
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

  let info = findSessionById(root, args.sessionId);
  if (!info) return guideError(new Error(`Session ${args.sessionId} not found`));

  // ISS-024: recover any pending mutation before processing
  const recoveredState = await recoverPendingMutation(info.dir, info.state, root);
  if (recoveredState !== info.state) {
    const reread = findSessionById(root, args.sessionId);
    if (reread) Object.assign(info, reread);
  }

  // ISS-037: drain pending deferrals from before compact
  // Must capture return value — subsequent writes spread info.state as base
  info = { ...info, state: await drainPendingDeferrals(root, info.dir, info.state) };

  // Guard: only resume from COMPACT state
  if (info.state.state !== "COMPACT") {
    return guideError(new Error(
      `Session ${args.sessionId} is not in COMPACT state (current: ${info.state.state}). Use action: "report" to continue.`,
    ));
  }

  // Check compactPending — stale COMPACT sessions get a clear message
  if (!info.state.compactPending) {
    return guideError(new Error(
      `Session ${args.sessionId} is in COMPACT state but compactPending is false (stale compact). ` +
      `Run "claudestory session clear-compact ${args.sessionId}" to recover.`,
    ));
  }

  // Validate preCompactState is a known workflow state
  const resumeState = info.state.preCompactState;
  if (!resumeState || !WORKFLOW_STATES.includes(resumeState as typeof WORKFLOW_STATES[number])) {
    return guideError(new Error(
      `Session ${args.sessionId} has invalid preCompactState: ${resumeState}. ` +
      `Run "claudestory session stop ${args.sessionId}" to terminate.`,
    ));
  }

  // ISS-032: 3-branch HEAD validation
  const headResult = await gitHead(root);
  const expectedHead = info.state.git.expectedHead;

  // Branch C: Cannot validate HEAD (git unavailable)
  // Note: missing expectedHead with working git → skip validation (Branch A, backward compat)
  if (!headResult.ok) {
    // Keep compactPending — session must remain discoverable
    const blockedState = writeSessionSync(info.dir, {
      ...refreshLease(info.state),
      resumeBlocked: true,
    });
    appendEvent(info.dir, {
      rev: blockedState.revision,
      type: "resume_blocked",
      timestamp: new Date().toISOString(),
      data: { reason: "cannot_validate_head", expectedHead: expectedHead ?? null, gitAvailable: headResult.ok },
    });
    return guideError(new Error(
      `Cannot validate git state for session ${args.sessionId}. ` +
      `Check git status and try "resume" again, or run "claudestory session stop ${args.sessionId}" to end the session.`,
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

    const driftWritten = writeSessionSync(info.dir, {
      ...refreshLease(info.state),
      state: mapping.state,
      previousState: "COMPACT",
      preCompactState: null,
      resumeFromRevision: null,
      compactPending: false,
      compactPreparedAt: null,
      resumeBlocked: false,
      finalizeCheckpoint: null,
      reviews: recoveryReviews,
      ticket: recoveryTicket,
      guideCallCount: 0,
      contextPressure: { ...info.state.contextPressure, guideCallCount: 0, compactionCount: (info.state.contextPressure?.compactionCount ?? 0) + 1 },
      git: { ...info.state.git, expectedHead: headResult.data.hash, mergeBase: headResult.data.hash },
    });

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
      },
    });
    removeResumeMarker(root);

    // State-specific actionable instructions after drift recovery
    const driftPreamble = `**HEAD changed during compaction** (expected ${expectedHead.slice(0, 8)}, got ${headResult.data.hash.slice(0, 8)}). Review state invalidated.\n\n`;

    if (mapping.state === "PICK_TICKET") {
      // T-188: Targeted mode -- show only remaining targets (with stuck check)
      if (isTargetedMode(driftWritten)) {
        const dispatched = await dispatchTargetedResume(root, driftWritten, info.dir, [
          `# Resumed After Compact -- HEAD Mismatch (Targeted Mode)`,
          "",
          driftPreamble + "Pick the next target item.",
        ]);
        return dispatched;
      }

      // Standard auto mode -- load candidates
      let candidatesText = "No ticket candidates available.";
      let topCandidate: { ticket: { id: string; title: string } } | null = null;
      try {
        const { state: ps } = await loadProject(root);
        const result = nextTickets(ps, 5);
        if (result.kind === "found") {
          topCandidate = result.candidates[0] ?? null;
          candidatesText = result.candidates.map((c, i) =>
            `${i + 1}. **${c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
          ).join("\n");
        }
      } catch { /* use default */ }

      return guideResult(driftWritten, "PICK_TICKET", {
        instruction: [
          `# Resumed After Compact — HEAD Mismatch`,
          "",
          driftPreamble + "Pick the next ticket.",
          candidatesText,
          "",
          topCandidate
            ? `Pick **${topCandidate.ticket.id}** by calling \`claudestory_autonomous_guide\` now:`
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
      const ticketInfo = driftWritten.ticket ? `for ${driftWritten.ticket.id}: ${driftWritten.ticket.title}` : "";
      return guideResult(driftWritten, "PLAN", {
        instruction: [
          `# Resumed After Compact — HEAD Mismatch`,
          "",
          `${driftPreamble}Write a new implementation plan ${ticketInfo}. Save to \`.story/sessions/${driftWritten.sessionId}/plan.md\`.`,
          "",
          `When done, call \`claudestory_autonomous_guide\` with:`,
          '```json',
          `{ "sessionId": "${driftWritten.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          '```',
        ].join("\n"),
        reminders: ["Previous plan/reviews invalidated by drift. Write a fresh plan."],
      });
    }

    if (mapping.state === "IMPLEMENT") {
      const ticketInfo = driftWritten.ticket ? `for ${driftWritten.ticket.id}: ${driftWritten.ticket.title}` : "";
      return guideResult(driftWritten, "IMPLEMENT", {
        instruction: [
          `# Resumed After Compact — HEAD Mismatch`,
          "",
          `${driftPreamble}Re-implement ${ticketInfo}. Previous commit state was invalidated.`,
          "",
          `When done, call \`claudestory_autonomous_guide\` with:`,
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
            "# Resumed After Compact — HEAD Mismatch",
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
      instruction: `# Resumed After Compact — HEAD Mismatch\n\n${driftPreamble}Recovered to state: **${mapping.state}**. Continue from here.`,
      reminders: [],
    });
  }

  // Branch A: HEAD matches — normal resume (or own-commit drift from T-184)
  // ISS-036c: reset guideCallCount after compact to prevent false critical pressure
  const resumePressure = {
    ...info.state.contextPressure,
    guideCallCount: 0,
    compactionCount: (info.state.contextPressure?.compactionCount ?? 0) + 1,
  };
  const written = writeSessionSync(info.dir, {
    ...refreshLease(info.state),
    state: resumeState,
    preCompactState: null,
    resumeFromRevision: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    guideCallCount: 0,
    contextPressure: { ...resumePressure, level: evaluatePressure({ ...info.state, guideCallCount: 0, contextPressure: resumePressure } as FullSessionState) },
    // T-184: Update expectedHead on own-commit drift (mergeBase stays at branch-off point)
    ...(ownCommitDrift ? { git: { ...info.state.git, expectedHead: headResult.data.hash } } : {}),
  });
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
    },
  });
  removeResumeMarker(root);

  // If resuming at PICK_TICKET, load candidates and give directive instructions
  if (resumeState === "PICK_TICKET") {
    // T-188: Targeted mode -- show only remaining targets (with stuck check)
    if (isTargetedMode(written)) {
      const dispatched = await dispatchTargetedResume(root, written, info.dir, [
        "# Resumed After Compact -- Continue Targeted Session",
        "",
        `${written.completedTickets.length} ticket(s) and ${(written.resolvedIssues ?? []).length} issue(s) done so far. Context compacted. Pick the next target item immediately.`,
      ]);
      return dispatched;
    }

    // Standard auto mode
    let candidatesText = "No ticket candidates available.";
    let topCandidate: { ticket: { id: string; title: string } } | null = null;
    try {
      const { state: ps } = await loadProject(root);
      const result = nextTickets(ps, 5);
      if (result.kind === "found") {
        topCandidate = result.candidates[0] ?? null;
        candidatesText = result.candidates.map((c, i) =>
          `${i + 1}. **${c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
        ).join("\n");
      }
    } catch { /* use default text */ }

    return guideResult(written, "PICK_TICKET", {
      instruction: [
        "# Resumed After Compact — Continue Working",
        "",
        `${written.completedTickets.length} ticket(s) and ${(written.resolvedIssues ?? []).length} issue(s) done so far. Context compacted. Pick the next ticket or issue immediately.`,
        "",
        candidatesText,
        "",
        topCandidate
          ? `Pick **${topCandidate.ticket.id}** by calling \`claudestory_autonomous_guide\` now:`
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
        "Context compacted successfully — all session state preserved. Continue working.",
      ],
    });
  }

  const resumeMode = written.mode ?? "auto";
  const modeContext = resumeMode === "auto"
    ? "You are in autonomous mode — continue working."
    : resumeMode === "review"
      ? "You are in review mode — session ends after code review approval."
      : resumeMode === "plan"
        ? "You are in plan mode — session ends after plan review approval."
        : "You are in guided mode — single ticket, full pipeline.";

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
        "# Resumed After Compact",
        "",
        `Session restored at state: **${resumeState}**.`,
        written.ticket ? `Working on: **${written.ticket.id}: ${written.ticket.title}**` : "",
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
      "# Resumed After Compact",
      "",
      `Session restored at state: **${resumeState}**.`,
      written.ticket ? `Working on: **${written.ticket.id}: ${written.ticket.title}**` : "No ticket in progress.",
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
}

// ---------------------------------------------------------------------------
// pre_compact
// ---------------------------------------------------------------------------

async function handlePreCompact(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) return guideError(new Error("sessionId is required for pre_compact"));

  const info = findSessionById(root, args.sessionId);
  if (!info) return guideError(new Error(`Session ${args.sessionId} not found`));

  // ISS-032: delegate to shared helper
  const headResult = await gitHead(root);

  let result;
  try {
    result = prepareForCompact(info.dir, refreshLease(info.state), {
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
    ticket: info.state.ticket,
    completedTickets: info.state.completedTickets,
    resolvedIssues: info.state.resolvedIssues,
    preCompactState: result.preCompactState,
  });

  // Read back actual written state (revision and timestamps must match disk)
  const reread = findSessionById(root, args.sessionId);
  const written = reread?.state ?? info.state;

  return guideResult(written, "COMPACT", {
    instruction: [
      "# Ready for Compact",
      "",
      "State flushed. Context compaction will happen automatically via hooks.",
      "If you need to compact manually, run `/compact` now.",
      "",
      "After compact, call `claudestory_autonomous_guide` with:",
      '```json',
      `{ "sessionId": "${result.sessionId}", "action": "resume" }`,
      '```',
    ].join("\n"),
    reminders: [],
  });
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

async function handleCancel(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) {
    // Cancel without session ID — check for any active session
    const active = findActiveSessionFull(root);
    if (!active) return guideError(new Error("No active session to cancel"));
    args = { ...args, sessionId: active.state.sessionId };
  }

  const info = findSessionById(root, args.sessionId!);
  if (!info) return guideError(new Error(`Session ${args.sessionId} not found`));

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

  if (isAutoMode && hasTicketsRemaining && isWorkingState) {
    return {
      content: [{
        type: "text",
        text: [
          "# Cancel Rejected — Session Still Active",
          "",
          `You have completed ${info.state.completedTickets.length} ticket(s) and ${(info.state.resolvedIssues ?? []).length} issue(s) with more work remaining.`,
          "Do NOT cancel an autonomous session due to context size.",
          "If you need to manage context, Claude Code handles compaction automatically.",
          "",
          "Continue working by calling `claudestory_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${info.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
          '```',
          "",
          "To force-cancel (admin only), run: `claudestory session stop`",
        ].join("\n"),
      }],
    };
  }

  // ISS-024: recover any pending mutation before cancel
  await recoverPendingMutation(info.dir, info.state, root);
  // Re-read state after recovery
  const cancelInfo = findSessionById(root, args.sessionId!) ?? info;

  // ISS-027: Release ticket claim if session owns it
  let ticketReleased = false;
  let ticketConflict = false;
  const ticketId = cancelInfo.state.ticket?.id;
  if (ticketId) {
    try {
      const { withProjectLock, writeTicketUnlocked } = await import("../core/project-loader.js");
      await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
        const ticket = projectState.ticketByID(ticketId);
        if (ticket && ticket.status === "inprogress") {
          const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
          if (!ticketClaim || ticketClaim === cancelInfo.state.sessionId) {
            await writeTicketUnlocked({ ...ticket, status: "open" as const, claimedBySession: null }, root);
            ticketReleased = true;
          } else {
            ticketConflict = true;
          }
        }
      });
    } catch {
      // Best-effort — session ends regardless, ticket may remain inprogress
    }
  }

  // T-125: Restore auto-stashed changes on cancel
  let stashPopFailed = false;
  const autoStash = cancelInfo.state.git.autoStash;
  if (autoStash) {
    const popResult = await gitStashPop(root, autoStash.ref);
    if (!popResult.ok) stashPopFailed = true;
  }

  const written = writeSessionSync(cancelInfo.dir, {
    ...cancelInfo.state,
    state: "SESSION_END",
    previousState: cancelInfo.state.state,
    status: "completed",
    terminationReason: "cancelled",
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    ticket: undefined,
  });

  appendEvent(cancelInfo.dir, {
    rev: written.revision,
    type: "cancelled",
    timestamp: new Date().toISOString(),
    data: {
      previousState: cancelInfo.state.state,
      ticketId: ticketId ?? null,
      ticketReleased,
      ticketConflict,
      stashPopFailed,
    },
  });

  // T-183: Clean resume marker
  removeResumeMarker(root);

  // T-185: Build compact session report
  let reportSection = "";
  try {
    const { state: projectState } = await loadProject(root);
    const nextResult = nextTickets(projectState, 5);
    const openIssues = projectState.issues.filter(i => i.status === "open" || i.status === "inprogress").slice(0, 5);
    const remainingWork = {
      tickets: nextResult.kind === "found"
        ? nextResult.candidates.map(c => ({ id: c.ticket.id, title: c.ticket.title }))
        : [],
      issues: openIssues.map(i => ({ id: i.id, title: i.title, severity: i.severity })),
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
  dir: string,
  state: FullSessionState,
  to: WorkflowState,
): FullSessionState {
  const from = state.state as WorkflowState;
  if (from !== to) {
    assertTransition(from, to);
  }
  const updated = { ...state, state: to, previousState: from };
  return writeSessionSync(dir, updated);
}

function guideResult(
  state: FullSessionState,
  currentState: WorkflowState | string,
  opts: {
    instruction: string;
    reminders?: readonly string[];
    transitionedFrom?: string;
  },
): McpToolResult {
  const summary: SessionSummary = {
    ticket: state.ticket ? `${state.ticket.id}: ${state.ticket.title}` : "none",
    risk: state.ticket?.risk ?? "unknown",
    completed: [...state.completedTickets.map((t) => t.id), ...(state.resolvedIssues ?? [])],
    currentStep: currentState,
    contextPressure: state.contextPressure?.level ?? "low",
    branch: state.git?.branch ?? null,
  };

  // T-178: Inject global anti-cancel reminder for auto mode
  const allReminders = [...(opts.reminders ?? [])];
  if ((state.mode === "auto" || !state.mode) && currentState !== "SESSION_END") {
    allReminders.push(
      "NEVER cancel this session due to context size. Compaction is automatic — Claude Story preserves all session state across compactions via hooks.",
    );
  }

  const output: GuideOutput = {
    sessionId: state.sessionId,
    state: currentState,
    transitionedFrom: opts.transitionedFrom,
    instruction: opts.instruction,
    reminders: allReminders,
    contextAdvice: "ok",
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
    summary.branch ? `**Branch:** ${summary.branch}` : "",
    output.reminders.length > 0 ? `\n**Reminders:**\n${output.reminders.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean);

  return { content: [{ type: "text", text: parts.join("\n") }] };
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

/** DJB2 hash — sufficient for plan change detection (ISS-035). */
function simpleHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}
