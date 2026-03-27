import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
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
import { gitHead, gitStatus, gitMergeBase, gitDiffStat, gitDiffNames, gitDiffCachedNames, gitBlobHash } from "./git-inspector.js";

import { loadProject } from "../core/project-loader.js";
import { loadLatestSnapshot } from "../core/snapshot.js";
import { buildRecap } from "../core/snapshot.js";
import { nextTickets } from "../core/queries.js";
import { recommend } from "../core/recommend.js";
import {
  handleHandoverLatest,
  handleHandoverCreate,
} from "../cli/commands/handover.js";
import type { CommandContext } from "../cli/types.js";

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
  if (m.type !== "ticket_update") return state; // only ticket_update supported in wave 3

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
          `- To abandon and start fresh: run "claudestory session clear-compact ${existing.state.sessionId}"`,
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
        `- To abandon: run "claudestory session clear-compact ${sid}"`,
      ));
    }
  }

  // Supersede any stale sessions (findActiveSessionFull filters these out, so scan separately)
  const staleSessions = findStaleSessions(root);
  for (const stale of staleSessions) {
    writeSessionSync(stale.dir, { ...stale.state, status: "superseded" as const });
  }

  const wsId = deriveWorkspaceId(root);

  // Read recipe + config overrides from project
  let recipe = "coding";
  let sessionConfig: SessionConfig = {};
  try {
    const { state: projectState } = await loadProject(root);
    const projectConfig = projectState.config as Record<string, unknown>;
    if (typeof projectConfig.recipe === "string") recipe = projectConfig.recipe;
    if (projectConfig.recipeOverrides && typeof projectConfig.recipeOverrides === "object") {
      const overrides = projectConfig.recipeOverrides as Record<string, unknown>;
      if (typeof overrides.maxTicketsPerSession === "number") sessionConfig.maxTicketsPerSession = overrides.maxTicketsPerSession;
      if (typeof overrides.compactThreshold === "string") sessionConfig.compactThreshold = overrides.compactThreshold;
      if (Array.isArray(overrides.reviewBackends)) sessionConfig.reviewBackends = overrides.reviewBackends as string[];
    }
  } catch { /* best-effort — use defaults */ }

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

    // Check for staged changes
    const stagedResult = await gitDiffCachedNames(root);
    if (stagedResult.ok && stagedResult.data.length > 0) {
      deleteSession(root, session.sessionId);
      return guideError(new Error(
        `Cannot start: ${stagedResult.data.length} staged file(s). Unstage with \`git restore --staged .\` or commit them first, then call start again.\n\nStaged: ${stagedResult.data.join(", ")}`,
      ));
    }

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
        const hashResult = await gitBlobHash(root, filePath);
        dirtyTracked[filePath] = { blobHash: hashResult.ok ? hashResult.data : "" };
      }
    }

    // If dirty tracked files exist, require workspace isolation
    if (Object.keys(dirtyTracked).length > 0) {
      deleteSession(root, session.sessionId);
      const dirtyFiles = Object.keys(dirtyTracked).join(", ");
      return guideError(new Error(
        `Cannot start: ${Object.keys(dirtyTracked).length} dirty tracked file(s): ${dirtyFiles}. ` +
        `Create a feature branch or stash changes first, then call start again.`,
      ));
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
      },
    };

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
      const recap = buildRecap(projectState, snapshotInfo);
      if (recap.changes) {
        recapText = "Changes since last snapshot available.";
      }
    } catch { /* best-effort */ }

    // Read project files
    const rulesText = readFileSafe(join(root, "RULES.md"));
    const strategiesText = readFileSafe(join(root, "WORK_STRATEGIES.md"));

    // Write context digest
    const digestParts = [
      handoverText ? `## Recent Handovers\n\n${handoverText}` : "",
      recapText ? `## Recap\n\n${recapText}` : "",
      rulesText ? `## Development Rules\n\n${rulesText}` : "",
      strategiesText ? `## Work Strategies\n\n${strategiesText}` : "",
    ].filter(Boolean);
    const digest = digestParts.join("\n\n---\n\n");
    try {
      writeFileSync(join(dir, "context-digest.md"), digest, "utf-8");
    } catch { /* best-effort */ }

    // Get ticket candidates
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

    // Also get recommendations
    const recResult = recommend(projectState, 5);
    let recsText = "";
    if (recResult.recommendations.length > 0) {
      const ticketRecs = recResult.recommendations.filter((r) => r.kind === "ticket");
      if (ticketRecs.length > 0) {
        recsText = "\n\n**Recommended:**\n" + ticketRecs.map((r) =>
          `- ${r.id}: ${r.title} (${r.reason})`,
        ).join("\n");
      }
    }

    // Update and write state
    updated = refreshLease(updated);
    const pressure = evaluatePressure(updated);
    updated = { ...updated, contextPressure: { ...updated.contextPressure, level: pressure } };
    const written = writeSessionSync(dir, updated);

    appendEvent(dir, {
      rev: written.revision,
      type: "start",
      timestamp: new Date().toISOString(),
      data: { recipe, branch: written.git.branch, head: written.git.initHead },
    });

    const topCandidate = nextResult.kind === "found" ? nextResult.candidates[0] : null;

    const instruction = [
      "# Autonomous Session Started",
      "",
      "You are now in autonomous mode. Work continuously until all tickets are done or the session limit is reached.",
      "Do NOT stop to summarize. Do NOT ask the user. Pick a ticket and start working immediately.",
      "",
      "## Ticket Candidates",
      "",
      candidatesText,
      recsText,
      "",
      topCandidate
        ? `Pick **${topCandidate.ticket.id}** (highest priority) by calling \`claudestory_autonomous_guide\` now:`
        : "Pick a ticket by calling `claudestory_autonomous_guide` now:",
      '```json',
      topCandidate
        ? `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
        : `{ "sessionId": "${updated.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
      '```',
    ].join("\n");

    return guideResult(updated, "PICK_TICKET", {
      instruction,
      reminders: [
        "Do NOT use Claude Code's plan mode — write plans as markdown files.",
        "Do NOT ask the user for confirmation or approval.",
        "Do NOT stop or summarize between tickets — call autonomous_guide IMMEDIATELY.",
        "You are in autonomous mode — continue working until done.",
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

  const currentState = state.state as WorkflowState;
  const report = args.report;

  // Fail-closed: reject reports on sessions with inconsistent compactPending (ISS-032)
  if (state.compactPending && currentState !== "COMPACT") {
    return guideError(new Error(
      `Session has pending compaction in inconsistent state (${currentState}). ` +
      `Call action: "resume" or run "claudestory session clear-compact ${args.sessionId}".`,
    ));
  }

  switch (currentState) {
    case "PICK_TICKET":
      return handleReportPickTicket(root, info.dir, state, report);
    case "PLAN":
      return handleReportPlan(root, info.dir, state, report);
    case "PLAN_REVIEW":
      return handleReportPlanReview(root, info.dir, state, report);
    case "IMPLEMENT":
      return handleReportImplement(root, info.dir, state, report);
    case "CODE_REVIEW":
      return handleReportCodeReview(root, info.dir, state, report);
    case "FINALIZE":
      return handleReportFinalize(root, info.dir, state, report);
    case "COMPLETE":
      return handleReportComplete(root, info.dir, state, report);
    case "HANDOVER":
      return handleReportHandover(root, info.dir, state, report);
    default:
      return guideError(new Error(`Cannot report at state ${currentState}`));
  }
}

// ---------------------------------------------------------------------------
// State report handlers
// ---------------------------------------------------------------------------

async function handleReportPickTicket(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  const ticketId = report.ticketId;
  if (!ticketId) return guideError(new Error("report.ticketId is required when picking a ticket"));

  // Load project to validate ticket
  const { state: projectState } = await loadProject(root);
  const ticket = projectState.ticketByID(ticketId);
  if (!ticket) return guideError(new Error(`Ticket ${ticketId} not found`));
  if (projectState.isBlocked(ticket)) return guideError(new Error(`Ticket ${ticketId} is blocked`));
  // ISS-027: Reject non-open tickets (already inprogress/complete) unless claimed by this session
  if (ticket.status !== "open") {
    const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
    if (!(ticket.status === "inprogress" && ticketClaim === state.sessionId)) {
      return guideError(new Error(`Ticket ${ticketId} is ${ticket.status} — pick an open ticket.`));
    }
  }

  // Clean up stale plan from previous ticket (ISS-029)
  const planPath = join(dir, "plan.md");
  try { if (existsSync(planPath)) unlinkSync(planPath); } catch { /* best-effort */ }

  const written = writeSessionSync(dir, {
    ...state,
    state: "PLAN",
    previousState: "PICK_TICKET",
    ticket: { id: ticket.id, title: ticket.title, claimed: true },
    reviews: { plan: [], code: [] },
    finalizeCheckpoint: null,
  });

  appendEvent(dir, {
    rev: written.revision,
    type: "ticket_picked",
    timestamp: new Date().toISOString(),
    data: { ticketId: ticket.id, title: ticket.title },
  });

  return guideResult(written, "PLAN", {
    instruction: [
      `# Plan for ${ticket.id}: ${ticket.title}`,
      "",
      ticket.description ? `## Ticket Description\n\n${ticket.description}` : "",
      "",
      `Write an implementation plan for this ticket. Save it to \`.story/sessions/${state.sessionId}/plan.md\`.`,
      "",
      "When done, call `claudestory_autonomous_guide` with:",
      '```json',
      `{ "sessionId": "${state.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
      '```',
    ].join("\n"),
    reminders: [
      "Write the plan as a markdown file — do NOT use Claude Code's plan mode.",
      "Do NOT ask the user for approval.",
    ],
    transitionedFrom: "PICK_TICKET",
  });
}

async function handleReportPlan(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  // Verify plan exists
  const planPath = join(dir, "plan.md");
  if (!existsSync(planPath)) {
    return guideResult(state, "PLAN", {
      instruction: `Plan file not found at ${planPath}. Write your plan there and call me again.`,
      reminders: ["Save plan to .story/sessions/<id>/plan.md"],
    });
  }

  const planContent = readFileSafe(planPath);
  if (!planContent || planContent.trim().length === 0) {
    return guideResult(state, "PLAN", {
      instruction: "Plan file is empty. Write your implementation plan and call me again.",
      reminders: [],
    });
  }

  // Plan fingerprint — detect unchanged plan after revise (ISS-035)
  const planHash = simpleHash(planContent);
  if (state.ticket?.lastPlanHash && state.ticket.lastPlanHash === planHash) {
    return guideResult(state, "PLAN", {
      instruction: "Plan has not changed since the last review. Address the review findings, then revise the plan and call me again.",
      reminders: [],
    });
  }

  // Compute initial risk
  const risk = assessRisk(undefined, undefined);

  // Update ticket to inprogress in .story/ with session ownership (ISS-024/ISS-027)
  let claimFailed = false;
  if (state.ticket) {
    try {
      const { withProjectLock, writeTicketUnlocked } = await import("../core/project-loader.js");
      await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
        const ticket = projectState.ticketByID(state.ticket!.id);
        if (!ticket) return;
        const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
        // Claim guard: only claim if open+unclaimed or already claimed by this session
        if (ticket.status === "inprogress" && ticketClaim === state.sessionId) return; // idempotent
        if (ticket.status !== "open") { claimFailed = true; return; } // can't claim non-open
        if (ticketClaim && ticketClaim !== state.sessionId) { claimFailed = true; return; } // claimed by another
        const updated = { ...ticket, status: "inprogress" as const, claimedBySession: state.sessionId };
        await writeTicketUnlocked(updated, root);
      });
    } catch {
      // Best-effort — don't block plan review if ticket update fails
    }
  }

  if (claimFailed) {
    return guideResult(state, "PLAN", {
      instruction: `Cannot claim ticket ${state.ticket?.id} — it is not open or is already claimed by another session. Pick a different ticket.`,
      reminders: [],
    });
  }

  const written = writeSessionSync(dir, {
    ...state,
    state: "PLAN_REVIEW",
    previousState: "PLAN",
    ticket: state.ticket ? { ...state.ticket, risk, lastPlanHash: planHash } : state.ticket,
  });
  appendEvent(dir, {
    rev: written.revision,
    type: "plan_written",
    timestamp: new Date().toISOString(),
    data: { planLength: planContent.length, risk },
  });

  // Derive round/reviewer from existing history (correct after revise loops: ISS-035)
  const backends = state.config.reviewBackends;
  const existingPlanReviews = state.reviews.plan;
  const roundNum = existingPlanReviews.length + 1;
  const reviewer = nextReviewer(existingPlanReviews, backends);
  const minRounds = requiredRounds(risk);

  return guideResult(written, "PLAN_REVIEW", {
    instruction: [
      `# Plan Review — Round ${roundNum} of ${Math.max(minRounds, roundNum)} minimum`,
      "",
      `Run a plan review using **${reviewer}**.`,
      "",
      reviewer === "codex"
        ? `Call \`review_plan\` MCP tool with the plan content.`
        : `Launch a code review agent to review the plan.`,
      "",
      "When done, call `claudestory_autonomous_guide` with:",
      '```json',
      `{ "sessionId": "${state.sessionId}", "action": "report", "report": { "completedAction": "plan_review_round", "verdict": "<approve|revise|request_changes|reject>", "findings": [...] } }`,
      '```',
    ].join("\n"),
    reminders: ["Report the exact verdict and findings from the reviewer."],
    transitionedFrom: "PLAN",
  });
}

async function handleReportPlanReview(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  const verdict = report.verdict;
  if (!verdict || !["approve", "revise", "request_changes", "reject"].includes(verdict)) {
    return guideResult(state, "PLAN_REVIEW", {
      instruction: 'Invalid verdict. Re-submit with verdict: "approve", "revise", "request_changes", or "reject".',
      reminders: [],
    });
  }

  // Record review round
  const planReviews = [...state.reviews.plan];
  const roundNum = planReviews.length + 1;
  const findings = report.findings ?? [];
  const backends = state.config.reviewBackends;
  // Derive backend name from alternation — planReviews is the prior history (current round not yet pushed)
  const reviewerBackend = nextReviewer(planReviews, backends);
  planReviews.push({
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

  const risk = state.ticket?.risk ?? "low";
  const minRounds = requiredRounds(risk as "low" | "medium" | "high");
  const hasCriticalOrMajor = findings.some(
    (f) => f.severity === "critical" || f.severity === "major",
  );

  // Guard contradictory approve + critical/major (ISS-035)
  if (verdict === "approve" && hasCriticalOrMajor) {
    return guideResult(state, "PLAN_REVIEW", {
      instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict.",
      reminders: [],
    });
  }

  // ISS-035: explicit verdict routing
  const isRevise = verdict === "revise" || verdict === "request_changes";
  const isReject = verdict === "reject";

  let nextState: WorkflowState;
  if (isReject || isRevise) {
    nextState = "PLAN";
  } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
    nextState = "IMPLEMENT";
  } else if (roundNum >= 5) {
    // Max rounds — document and advance
    nextState = "IMPLEMENT";
  } else {
    nextState = "PLAN_REVIEW";
  }

  // reject: clear plan review history (new plan starts at round 1).
  // revise: preserve history (revision continues the review thread).
  // BOTH: keep lastPlanHash so fingerprint guard rejects unchanged resubmissions.
  const reviewsForWrite = isReject
    ? { ...state.reviews, plan: [] as typeof planReviews }
    : { ...state.reviews, plan: planReviews };

  const written = writeSessionSync(dir, {
    ...state,
    state: nextState,
    previousState: "PLAN_REVIEW",
    reviews: nextState === "PLAN" ? reviewsForWrite : { ...state.reviews, plan: planReviews },
  });
  appendEvent(dir, {
    rev: written.revision,
    type: "plan_review",
    timestamp: new Date().toISOString(),
    data: { round: roundNum, verdict, findingCount: findings.length },
  });

  if (nextState === "PLAN") {
    return guideResult(written, "PLAN", {
      instruction: isRevise
        ? "Plan review requested revisions. Address the findings, revise your plan, then call me with completedAction: \"plan_written\"."
        : "Plan was rejected. Write a new plan from scratch, then call me with completedAction: \"plan_written\".",
      reminders: [],
      transitionedFrom: "PLAN_REVIEW",
    });
  }

  if (nextState === "IMPLEMENT") {
    return guideResult(written, "IMPLEMENT", {
      instruction: [
        "# Implement",
        "",
        "Plan review passed. Implement the plan now.",
        "",
        "When done, call `claudestory_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${state.sessionId}", "action": "report", "report": { "completedAction": "implementation_done" } }`,
        '```',
      ].join("\n"),
      reminders: ["Call autonomous_guide when implementation is complete."],
      transitionedFrom: "PLAN_REVIEW",
    });
  }

  // Stay in PLAN_REVIEW — next round
  const reviewer = nextReviewer(planReviews, backends);
  return guideResult(written, "PLAN_REVIEW", {
    instruction: [
      `# Plan Review — Round ${roundNum + 1}`,
      "",
      hasCriticalOrMajor
        ? `Round ${roundNum} found ${findings.filter((f) => f.severity === "critical" || f.severity === "major").length} critical/major finding(s). Address them, then re-review with **${reviewer}**.`
        : `Round ${roundNum} complete. Run round ${roundNum + 1} with **${reviewer}**.`,
      "",
      "Report verdict and findings as before.",
    ].join("\n"),
    reminders: ["Address findings before re-reviewing."],
  });
}

async function handleReportImplement(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  // Risk recomputation from actual diff
  let realizedRisk = state.ticket?.risk ?? "low";
  const mergeBase = state.git.mergeBase;
  if (mergeBase) {
    const diffResult = await gitDiffStat(root, mergeBase);
    const namesResult = await gitDiffNames(root, mergeBase);
    if (diffResult.ok) {
      realizedRisk = assessRisk(diffResult.data, namesResult.ok ? namesResult.data : undefined);
    }
  }

  const backends = state.config.reviewBackends;
  const codeReviews = state.reviews.code;
  const reviewer = nextReviewer(codeReviews, backends);
  const rounds = requiredRounds(realizedRisk as "low" | "medium" | "high");

  const written = writeSessionSync(dir, {
    ...state,
    state: "CODE_REVIEW",
    previousState: "IMPLEMENT",
    ticket: state.ticket ? { ...state.ticket, realizedRisk } : state.ticket,
  });
  appendEvent(dir, {
    rev: written.revision,
    type: "implementation_done",
    timestamp: new Date().toISOString(),
    data: { realizedRisk },
  });

  return guideResult(written, "CODE_REVIEW", {
    instruction: [
      `# Code Review — Round 1 of ${rounds} minimum`,
      "",
      `Realized risk: **${realizedRisk}**${realizedRisk !== state.ticket?.risk ? ` (was ${state.ticket?.risk})` : ""}.`,
      "",
      `Run a code review using **${reviewer}**. Capture the git diff and pass it to the reviewer.`,
      "",
      "When done, report verdict and findings.",
    ].join("\n"),
    reminders: ["Capture diff with `git diff` and pass to reviewer."],
    transitionedFrom: "IMPLEMENT",
  });
}

async function handleReportCodeReview(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  const verdict = report.verdict;
  if (!verdict || !["approve", "revise", "request_changes", "reject"].includes(verdict)) {
    return guideResult(state, "CODE_REVIEW", {
      instruction: 'Invalid verdict. Re-submit with verdict: "approve", "revise", "request_changes", or "reject".',
      reminders: [],
    });
  }

  const codeReviews = [...state.reviews.code];
  const roundNum = codeReviews.length + 1;
  const findings = report.findings ?? [];
  const backends = state.config.reviewBackends;
  // Derive backend name from alternation — codeReviews is the prior history (current round not yet pushed)
  const reviewerBackend = nextReviewer(codeReviews, backends);
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

  const risk = state.ticket?.realizedRisk ?? state.ticket?.risk ?? "low";
  const minRounds = requiredRounds(risk as "low" | "medium" | "high");
  const hasCriticalOrMajor = findings.some(
    (f) => f.severity === "critical" || f.severity === "major",
  );

  // Check for PLAN redirect
  const planRedirect = findings.some((f) => f.recommendedNextState === "PLAN");

  // Guard contradictory approve payloads (ISS-035)
  if (verdict === "approve" && hasCriticalOrMajor) {
    return guideResult(state, "CODE_REVIEW", {
      instruction: "Contradictory review payload: verdict is 'approve' but critical/major findings are present. Re-run the review or correct the verdict.",
      reminders: [],
    });
  }
  if (verdict === "approve" && planRedirect) {
    return guideResult(state, "CODE_REVIEW", {
      instruction: "Contradictory review payload: verdict is 'approve' but findings recommend replanning. Re-run the review or correct the verdict.",
      reminders: [],
    });
  }

  let nextState: WorkflowState;
  // planRedirect takes precedence for ANY non-approve verdict (ISS-035)
  if (planRedirect && verdict !== "approve") {
    nextState = "PLAN";
  } else if (verdict === "reject" || verdict === "revise" || verdict === "request_changes") {
    nextState = "IMPLEMENT";
  } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
    nextState = "FINALIZE";
  } else if (roundNum >= 5) {
    nextState = "FINALIZE";
  } else {
    nextState = "CODE_REVIEW";
  }

  // CODE_REVIEW → PLAN: full reset — both plan and code will be redone
  if (nextState === "PLAN") {
    const planResetWritten = writeSessionSync(dir, {
      ...state,
      state: "PLAN",
      previousState: "CODE_REVIEW",
      reviews: { plan: [], code: [] },
      ticket: state.ticket ? { ...state.ticket, realizedRisk: undefined } : state.ticket,
    });
    appendEvent(dir, {
      rev: planResetWritten.revision,
      type: "code_review",
      timestamp: new Date().toISOString(),
      data: { round: roundNum, verdict, findingCount: findings.length, redirectedTo: "PLAN" },
    });
    return guideResult(planResetWritten, "PLAN", {
      instruction: "Code review recommends rethinking the approach. Write a new plan and call me with completedAction: \"plan_written\".",
      reminders: [],
      transitionedFrom: "CODE_REVIEW",
    });
  }

  const written = writeSessionSync(dir, {
    ...state,
    state: nextState,
    previousState: "CODE_REVIEW",
    reviews: { ...state.reviews, code: codeReviews },
  });
  appendEvent(dir, {
    rev: written.revision,
    type: "code_review",
    timestamp: new Date().toISOString(),
    data: { round: roundNum, verdict, findingCount: findings.length },
  });

  if (nextState === "IMPLEMENT") {
    return guideResult(written, "IMPLEMENT", {
      instruction: "Code review requested changes. Fix the issues and call me with completedAction: \"implementation_done\".",
      reminders: ["Address all critical/major findings before re-submitting."],
      transitionedFrom: "CODE_REVIEW",
    });
  }

  if (nextState === "FINALIZE") {
    return guideResult(written, "FINALIZE", {
      instruction: [
        "# Finalize",
        "",
        "Code review passed. Time to commit.",
        "",
        state.ticket ? `1. Update ticket ${state.ticket.id} status to "complete" in .story/` : "",
        "2. Stage all changed files (code + .story/ changes)",
        "3. Call me with completedAction: \"files_staged\"",
      ].filter(Boolean).join("\n"),
      reminders: ["Stage both code changes and .story/ ticket update in the same commit."],
      transitionedFrom: "CODE_REVIEW",
    });
  }

  // Stay in CODE_REVIEW
  const reviewer = nextReviewer(codeReviews, backends);
  return guideResult(written, "CODE_REVIEW", {
    instruction: `Code review round ${roundNum} found issues. Fix them and re-review with **${reviewer}**.`,
    reminders: [],
  });
}

async function handleReportFinalize(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  const action = report.completedAction;
  const checkpoint = state.finalizeCheckpoint;

  // --- Checkpoint: stage ---
  if (action === "files_staged" && (!checkpoint || checkpoint === "staged" || checkpoint === "staged_override")) {
    const stagedResult = await gitDiffCachedNames(root);
    if (!stagedResult.ok || stagedResult.data.length === 0) {
      return guideResult(state, "FINALIZE", {
        instruction: "No files are staged. Stage your changes and call me again with completedAction: \"files_staged\".",
        reminders: [],
      });
    }

    // ISS-025: Overlap detection — block staging of pre-existing untracked files
    const baselineUntracked = state.git.baseline?.untrackedPaths ?? [];
    let overlapOverridden = false;
    if (baselineUntracked.length > 0) {
      const overlap = stagedResult.data.filter((f: string) => baselineUntracked.includes(f));
      if (overlap.length > 0) {
        if (report.overrideOverlap) {
          overlapOverridden = true; // persisted in finalizeCheckpoint below
        } else {
          return guideResult(state, "FINALIZE", {
            instruction: `Pre-existing untracked files are staged: ${overlap.join(", ")}. Unstage them with \`git restore --staged ${overlap.join(" ")}\`, or report with overrideOverlap: true to proceed.`,
            reminders: [],
          });
        }
      }
    }

    // Persist override flag in finalizeCheckpoint so precommit_passed re-check honors it
    const written = writeSessionSync(dir, {
      ...state,
      finalizeCheckpoint: overlapOverridden ? "staged_override" : "staged",
    });

    return guideResult(written, "FINALIZE", {
      instruction: [
        "Files staged. Now run pre-commit checks.",
        "",
        "Run any pre-commit hooks or linting, then call me with completedAction: \"precommit_passed\".",
        "If pre-commit fails, fix the issues, re-stage, and call me with completedAction: \"files_staged\" again.",
      ].join("\n"),
      reminders: ["Verify staged set is intact after pre-commit hooks."],
    });
  }

  // --- Checkpoint: precommit ---
  if (action === "precommit_passed") {
    if (!checkpoint || checkpoint === null) {
      return guideResult(state, "FINALIZE", {
        instruction: "You must stage files first. Call me with completedAction: \"files_staged\" after staging.",
        reminders: [],
      });
    }
    if (checkpoint === "committed") {
      return guideResult(state, "FINALIZE", {
        instruction: "Commit was already recorded.",
        reminders: [],
      });
    }

    // Verify staged set is still intact after hooks
    const stagedResult = await gitDiffCachedNames(root);
    if (!stagedResult.ok || stagedResult.data.length === 0) {
      // Hooks cleared the staging — downgrade back to stage checkpoint
      const written = writeSessionSync(dir, { ...state, finalizeCheckpoint: null });
      return guideResult(written, "FINALIZE", {
        instruction: "Pre-commit hooks appear to have cleared the staging area. Re-stage your changes and call me with completedAction: \"files_staged\".",
        reminders: [],
      });
    }

    // ISS-025: Re-check overlap after hooks (skip if user previously overrode)
    if (checkpoint !== "staged_override") {
      const baselineUntracked2 = state.git.baseline?.untrackedPaths ?? [];
      if (baselineUntracked2.length > 0) {
        const overlap = stagedResult.data.filter((f: string) => baselineUntracked2.includes(f));
        if (overlap.length > 0) {
          const written2 = writeSessionSync(dir, { ...state, finalizeCheckpoint: null });
          return guideResult(written2, "FINALIZE", {
            instruction: `Pre-commit hooks staged pre-existing untracked files: ${overlap.join(", ")}. Unstage them and re-stage, then call with completedAction: "files_staged".`,
            reminders: [],
          });
        }
      }
    }

    const written = writeSessionSync(dir, { ...state, finalizeCheckpoint: "precommit_passed" });

    return guideResult(written, "FINALIZE", {
      instruction: [
        "Pre-commit passed. Now commit.",
        "",
        state.ticket
          ? `Commit with message: "feat: <description> (${state.ticket.id})"`
          : "Commit with a descriptive message.",
        "",
        'Call me with completedAction: "commit_done" and include the commitHash.',
      ].join("\n"),
      reminders: [],
    });
  }

  // --- Checkpoint: commit ---
  if (action === "commit_done") {
    if (!checkpoint || checkpoint === null) {
      return guideResult(state, "FINALIZE", {
        instruction: "You must stage files first. Call me with completedAction: \"files_staged\" after staging.",
        reminders: [],
      });
    }
    if (checkpoint === "staged" || checkpoint === "staged_override") {
      return guideResult(state, "FINALIZE", {
        instruction: "You must pass pre-commit checks first. Call me with completedAction: \"precommit_passed\".",
        reminders: [],
      });
    }
    if (checkpoint === "committed") {
      // Already committed — skip to COMPLETE (don't re-enter FINALIZE loop: ISS-031)
      const alreadyCommitted = writeSessionSync(dir, {
        ...state,
        state: "COMPLETE",
        previousState: "FINALIZE",
      });
      return handleReportComplete(root, dir, refreshLease(alreadyCommitted), { completedAction: "commit_done" });
    }
    const commitHash = report.commitHash;
    if (!commitHash) {
      return guideResult(state, "FINALIZE", {
        instruction: "Missing commitHash in report. Call me again with the commit hash.",
        reminders: [],
      });
    }

    // Validate commitHash matches actual HEAD and is a new commit (ISS-033)
    const headResult = await gitHead(root);
    const previousHead = state.git.expectedHead ?? state.git.initHead;
    if (!headResult.ok || headResult.data.hash !== commitHash) {
      return guideResult(state, "FINALIZE", {
        instruction: `Commit hash mismatch: reported ${commitHash} but HEAD is ${headResult.ok ? headResult.data.hash : "unknown"}. Verify the commit succeeded and report the correct hash.`,
        reminders: [],
      });
    }
    if (previousHead && commitHash === previousHead) {
      return guideResult(state, "FINALIZE", {
        instruction: `No new commit detected: HEAD (${commitHash}) has not changed. Create a commit first, then report the new hash.`,
        reminders: [],
      });
    }

    const completedTicket = state.ticket
      ? { id: state.ticket.id, title: state.ticket.title, commitHash, risk: state.ticket.risk }
      : undefined;

    const updated: FullSessionState = {
      ...state,
      state: "COMPLETE",
      previousState: "FINALIZE",
      finalizeCheckpoint: "committed",
      completedTickets: completedTicket
        ? [...state.completedTickets, completedTicket]
        : state.completedTickets,
      ticket: undefined,
      git: {
        ...state.git,
        mergeBase: commitHash,
        expectedHead: commitHash,
      },
    };

    const written = writeSessionSync(dir, updated);
    appendEvent(dir, {
      rev: written.revision,
      type: "commit",
      timestamp: new Date().toISOString(),
      data: { commitHash, ticketId: completedTicket?.id },
    });

    // Pass the written state (with correct revision) to avoid collision
    return handleReportComplete(root, dir, refreshLease(written), { completedAction: "commit_done" });
  }

  return guideResult(state, "FINALIZE", {
    instruction: "Unexpected action at FINALIZE. Stage files and call with completedAction: \"files_staged\", or commit and call with completedAction: \"commit_done\".",
    reminders: [],
  });
}

async function handleReportComplete(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  const pressure = evaluatePressure(state);
  const updated: FullSessionState = {
    ...state,
    state: "COMPLETE",
    contextPressure: { ...state.contextPressure, level: pressure },
    finalizeCheckpoint: null,
  };

  const ticketsDone = updated.completedTickets.length;
  const maxTickets = updated.config.maxTicketsPerSession;

  // Determine next action
  let nextState: WorkflowState;
  let advice: ContextAdvice = "ok";

  if (maxTickets > 0 && ticketsDone >= maxTickets) {
    // Hard ticket cap reached — end session
    nextState = "HANDOVER";
  } else if (pressure === "critical") {
    // ISS-032: critical pressure is advisory — hooks handle compaction
    advice = "compact-now";
    nextState = "PICK_TICKET";
  } else if (pressure === "high") {
    advice = "consider-compact";
    nextState = "PICK_TICKET";
  } else {
    nextState = "PICK_TICKET";
  }

  // Check if more tickets available
  const { state: projectState } = await loadProject(root);
  const nextResult = nextTickets(projectState, 1);
  if (nextResult.kind !== "found") {
    nextState = "HANDOVER";
  }

  const transitioned = writeSessionSync(dir, {
    ...updated,
    state: nextState,
    previousState: "COMPLETE",
  });

  if (nextState === "HANDOVER") {
    return guideResult(transitioned, "HANDOVER", {
      instruction: [
        `# Session Complete — ${ticketsDone} ticket(s) done`,
        "",
        "Write a session handover summarizing what was accomplished, decisions made, and what's next.",
        "",
        'Call me with completedAction: "handover_written" and include the content in handoverContent.',
      ].join("\n"),
      reminders: [],
      transitionedFrom: "COMPLETE",
      contextAdvice: advice,
    });
  }

  // Back to PICK_TICKET with fresh candidates
  const candidates = nextTickets(projectState, 5);
  let candidatesText = "";
  if (candidates.kind === "found") {
    candidatesText = candidates.candidates.map((c, i) =>
      `${i + 1}. **${c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
    ).join("\n");
  }

  const topCandidate = candidates.kind === "found" ? candidates.candidates[0] : null;

  return guideResult(transitioned, "PICK_TICKET", {
    instruction: [
      `# Ticket Complete — Continuing (${ticketsDone}/${maxTickets})`,
      "",
      "Do NOT stop. Do NOT ask the user. Continue immediately with the next ticket.",
      "",
      candidatesText,
      "",
      topCandidate
        ? `Pick **${topCandidate.ticket.id}** (highest priority) by calling \`claudestory_autonomous_guide\` now:`
        : "Pick a ticket by calling `claudestory_autonomous_guide` now:",
      '```json',
      topCandidate
        ? `{ "sessionId": "${transitioned.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
        : `{ "sessionId": "${transitioned.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
      '```',
    ].join("\n"),
    reminders: [
      "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick the next ticket.",
      "Do NOT ask the user for confirmation.",
      "You are in autonomous mode — continue working until all tickets are done or the session limit is reached.",
    ],
    transitionedFrom: "COMPLETE",
    contextAdvice: advice,
  });
}

async function handleReportHandover(
  root: string, dir: string, state: FullSessionState, report: NonNullable<GuideInput["report"]>,
): Promise<McpToolResult> {
  const content = report.handoverContent;
  if (!content) {
    return guideResult(state, "HANDOVER", {
      instruction: "Missing handoverContent. Write the handover and include it in the report.",
      reminders: [],
    });
  }

  // Create handover via existing handler (uses withProjectLock internally)
  let handoverFailed = false;
  try {
    await handleHandoverCreate(content, "auto-session", "md", root);
  } catch (err) {
    handoverFailed = true;
    // Fallback: write content directly to session dir
    try {
      const fallbackPath = join(dir, "handover-fallback.md");
      writeFileSync(fallbackPath, content, "utf-8");
    } catch { /* truly best-effort */ }
  }

  // ISS-032: handover always ends session. Compact-continue removed — hooks handle compaction.
  const written = writeSessionSync(dir, {
    ...state,
    state: "SESSION_END",
    previousState: "HANDOVER",
    status: "completed",
    terminationReason: "normal",
  });

  appendEvent(dir, {
    rev: written.revision,
    type: "session_end",
    timestamp: new Date().toISOString(),
    data: { ticketsCompleted: written.completedTickets.length, handoverFailed },
  });

  const ticketsDone = written.completedTickets.length;
  return guideResult(written, "SESSION_END", {
    instruction: [
      "# Session Complete",
      "",
      `${ticketsDone} ticket(s) completed.${handoverFailed ? " Handover creation failed — fallback saved to session directory." : " Handover written."} Session ended.`,
      "",
      written.completedTickets.map((t) => `- ${t.id}${t.title ? `: ${t.title}` : ""} (${t.commitHash ?? "no commit"})`).join("\n"),
    ].join("\n"),
    reminders: [],
    transitionedFrom: "HANDOVER",
  });
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

async function handleResume(root: string, args: GuideInput): Promise<McpToolResult> {
  if (!args.sessionId) return guideError(new Error("sessionId is required for resume"));

  const info = findSessionById(root, args.sessionId);
  if (!info) return guideError(new Error(`Session ${args.sessionId} not found`));

  // ISS-024: recover any pending mutation before processing
  const recoveredState = await recoverPendingMutation(info.dir, info.state, root);
  if (recoveredState !== info.state) {
    // Mutation was recovered — re-read to get consistent state
    const reread = findSessionById(root, args.sessionId);
    if (reread) Object.assign(info, reread);
  }

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
      `Run "claudestory session clear-compact ${args.sessionId}" to recover.`,
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
      `Check git status and try "resume" again, or run "claudestory session clear-compact ${args.sessionId}" to end the session.`,
    ));
  }

  // Branch B: HEAD mismatch (drift during compaction)
  if (expectedHead && headResult.data.hash !== expectedHead) {
    // State-specific recovery routing
    const recoveryMapping: Record<string, { state: string; resetPlan: boolean; resetCode: boolean }> = {
      PICK_TICKET:  { state: "PICK_TICKET", resetPlan: false, resetCode: false },
      COMPLETE:     { state: "PICK_TICKET", resetPlan: false, resetCode: false },
      HANDOVER:     { state: "PICK_TICKET", resetPlan: false, resetCode: false },
      PLAN:         { state: "PLAN",        resetPlan: true,  resetCode: false },
      IMPLEMENT:    { state: "PLAN",        resetPlan: true,  resetCode: false },
      PLAN_REVIEW:  { state: "PLAN",        resetPlan: true,  resetCode: true  },
      CODE_REVIEW:  { state: "PLAN",        resetPlan: true,  resetCode: true  },
      FINALIZE:     { state: "IMPLEMENT",   resetPlan: false, resetCode: true  },
    };
    const mapping = recoveryMapping[resumeState] ?? { state: "PICK_TICKET", resetPlan: false, resetCode: false };

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
      contextPressure: { ...info.state.contextPressure, compactionCount: (info.state.contextPressure?.compactionCount ?? 0) + 1 },
      git: { ...info.state.git, expectedHead: headResult.data.hash, mergeBase: headResult.data.hash },
    });

    appendEvent(info.dir, {
      rev: driftWritten.revision,
      type: "resume_conflict",
      timestamp: new Date().toISOString(),
      data: { drift: true, previousState: resumeState, recoveryState: mapping.state, expectedHead, actualHead: headResult.data.hash, ticketId: info.state.ticket?.id },
    });

    // State-specific actionable instructions after drift recovery
    const driftPreamble = `**HEAD changed during compaction** (expected ${expectedHead.slice(0, 8)}, got ${headResult.data.hash.slice(0, 8)}). Review state invalidated.\n\n`;

    if (mapping.state === "PICK_TICKET") {
      // Load candidates for PICK_TICKET
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

    // Fallback for unmapped states
    return guideResult(driftWritten, mapping.state, {
      instruction: `# Resumed After Compact — HEAD Mismatch\n\n${driftPreamble}Recovered to state: **${mapping.state}**. Continue from here.`,
      reminders: [],
    });
  }

  // Branch A: HEAD matches — normal resume
  const written = writeSessionSync(info.dir, {
    ...refreshLease(info.state),
    state: resumeState,
    preCompactState: null,
    resumeFromRevision: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    contextPressure: { ...info.state.contextPressure, compactionCount: (info.state.contextPressure?.compactionCount ?? 0) + 1 },
  });

  // If resuming at PICK_TICKET, load candidates and give directive instructions
  if (resumeState === "PICK_TICKET") {
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
        `${written.completedTickets.length} ticket(s) done so far. Context compacted. Pick the next ticket immediately.`,
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
      ],
    });
  }

  return guideResult(written, resumeState, {
    instruction: [
      "# Resumed After Compact",
      "",
      `Session restored at state: **${resumeState}**.`,
      written.ticket ? `Working on: **${written.ticket.id}: ${written.ticket.title}**` : "No ticket in progress.",
      "",
      "Continue where you left off. Call me when you complete the current step.",
    ].join("\n"),
    reminders: [
      "Do NOT use plan mode.",
      "Do NOT stop or summarize.",
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
    },
  });

  return {
    content: [{ type: "text", text: `Session ${args.sessionId} cancelled. ${written.completedTickets.length} ticket(s) were completed.` }],
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
    contextAdvice?: ContextAdvice;
  },
): McpToolResult {
  const summary: SessionSummary = {
    ticket: state.ticket ? `${state.ticket.id}: ${state.ticket.title}` : "none",
    risk: state.ticket?.risk ?? "unknown",
    completed: state.completedTickets.map((t) => t.id),
    currentStep: currentState,
    contextPressure: state.contextPressure?.level ?? "low",
    branch: state.git?.branch ?? null,
  };

  const output: GuideOutput = {
    sessionId: state.sessionId,
    state: currentState,
    transitionedFrom: opts.transitionedFrom,
    instruction: opts.instruction,
    reminders: opts.reminders ?? [],
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
    `**Pressure:** ${summary.contextPressure}`,
    summary.branch ? `**Branch:** ${summary.branch}` : "",
    output.contextAdvice !== "ok" ? `**Context:** ${output.contextAdvice}` : "",
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
