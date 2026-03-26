import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
  // Check for existing active session
  const existing = findActiveSessionFull(root);
  if (existing && !isLeaseExpired(existing.state)) {
    return guideError(new Error(
      `Active session ${existing.state.sessionId} already exists for this workspace. ` +
      `Use action: "resume" to continue or "cancel" to end it.`,
    ));
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
  const currentState = state.state as WorkflowState;
  const report = args.report;

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

  const written = writeSessionSync(dir, {
    ...state,
    state: "PLAN",
    previousState: "PICK_TICKET",
    ticket: { id: ticket.id, title: ticket.title, claimed: true },
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

  // Compute initial risk
  const risk = assessRisk(undefined, undefined);

  // Update ticket to inprogress in .story/ (first durable work product)
  if (state.ticket) {
    try {
      const { withProjectLock, writeTicketUnlocked } = await import("../core/project-loader.js");
      await withProjectLock(root, { strict: false }, async ({ state: projectState }) => {
        const ticket = projectState.ticketByID(state.ticket!.id);
        if (ticket && ticket.status !== "inprogress") {
          const updated = { ...ticket, status: "inprogress" as const };
          await writeTicketUnlocked(updated, root);
        }
      });
    } catch {
      // Best-effort — don't block plan review if ticket update fails
    }
  }

  const written = writeSessionSync(dir, {
    ...state,
    state: "PLAN_REVIEW",
    previousState: "PLAN",
    ticket: state.ticket ? { ...state.ticket, risk } : state.ticket,
  });
  appendEvent(dir, {
    rev: written.revision,
    type: "plan_written",
    timestamp: new Date().toISOString(),
    data: { planLength: planContent.length, risk },
  });

  const backends = state.config.reviewBackends;
  const reviewer = nextReviewer([], backends);
  const rounds = requiredRounds(risk);

  return guideResult(written, "PLAN_REVIEW", {
    instruction: [
      `# Plan Review — Round 1 of ${rounds} minimum`,
      "",
      `Run a plan review using **${reviewer}**.`,
      "",
      reviewer === "codex"
        ? `Call \`review_plan\` MCP tool with the plan content.`
        : `Launch a code review agent to review the plan.`,
      "",
      "When done, call `claudestory_autonomous_guide` with:",
      '```json',
      `{ "sessionId": "${state.sessionId}", "action": "report", "report": { "completedAction": "plan_review_round", "verdict": "<approve|revise|reject>", "findings": [...] } }`,
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

  let nextState: WorkflowState;
  if (verdict === "reject") {
    nextState = "PLAN";
  } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
    nextState = "IMPLEMENT";
  } else if (roundNum >= 5) {
    // Max rounds — document and advance
    nextState = "IMPLEMENT";
  } else {
    nextState = "PLAN_REVIEW";
  }

  const written = writeSessionSync(dir, {
    ...state,
    state: nextState,
    previousState: "PLAN_REVIEW",
    reviews: { ...state.reviews, plan: planReviews },
  });
  appendEvent(dir, {
    rev: written.revision,
    type: "plan_review",
    timestamp: new Date().toISOString(),
    data: { round: roundNum, verdict, findingCount: findings.length },
  });

  if (nextState === "PLAN") {
    return guideResult(written, "PLAN", {
      instruction: "Plan was rejected. Revise and rewrite the plan, then call me with completedAction: \"plan_written\".",
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

  let nextState: WorkflowState;
  if (verdict === "reject" && planRedirect) {
    nextState = "PLAN";
  } else if (verdict === "reject") {
    nextState = "IMPLEMENT";
  } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
    nextState = "FINALIZE";
  } else if (roundNum >= 5) {
    nextState = "FINALIZE";
  } else {
    nextState = "CODE_REVIEW";
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

  if (nextState === "PLAN") {
    return guideResult(written, "PLAN", {
      instruction: "Code review recommends rethinking the approach. Revise the plan and call me with completedAction: \"plan_written\".",
      reminders: [],
      transitionedFrom: "CODE_REVIEW",
    });
  }

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
  if (action === "files_staged" && (!checkpoint || checkpoint === "staged")) {
    const stagedResult = await gitDiffCachedNames(root);
    if (!stagedResult.ok || stagedResult.data.length === 0) {
      return guideResult(state, "FINALIZE", {
        instruction: "No files are staged. Stage your changes and call me again with completedAction: \"files_staged\".",
        reminders: [],
      });
    }

    const written = writeSessionSync(dir, { ...state, finalizeCheckpoint: "staged" });

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
    if (checkpoint === "staged") {
      return guideResult(state, "FINALIZE", {
        instruction: "You must pass pre-commit checks first. Call me with completedAction: \"precommit_passed\".",
        reminders: [],
      });
    }
    if (checkpoint === "committed") {
      return guideResult(state, "FINALIZE", {
        instruction: "Commit was already recorded. Proceeding to completion.",
        reminders: [],
      });
    }
    const commitHash = report.commitHash;
    if (!commitHash) {
      return guideResult(state, "FINALIZE", {
        instruction: "Missing commitHash in report. Call me again with the commit hash.",
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
    // Context pressure critical — compact and continue (don't end session)
    nextState = "HANDOVER";
    advice = "compact-now";
    // HANDOVER handler will route to COMPACT instead of SESSION_END when advice is compact-now
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

  // Decide: compact and continue, or end session
  // Use stored pressure level (already evaluated in handleReportComplete)
  const pressureLevel = state.contextPressure?.level ?? "low";
  const maxTickets = state.config.maxTicketsPerSession;
  const capReached = maxTickets > 0 && state.completedTickets.length >= maxTickets;

  let hasMoreTickets = false;
  try {
    const { state: ps } = await loadProject(root);
    hasMoreTickets = nextTickets(ps, 1).kind === "found";
  } catch {
    // loadProject failure — default to ending session (safe fallback)
  }

  if (pressureLevel === "critical" && hasMoreTickets && !capReached) {
    // Compact and continue — stay in HANDOVER, tell Claude to call pre_compact
    // (pre_compact will transition to COMPACT and flush state)
    return guideResult(state, "HANDOVER", {
      instruction: [
        "# Context Compaction Needed",
        "",
        `${state.completedTickets.length} ticket(s) completed so far. Handover written. Context is large — time to compact and continue.`,
        "",
        "Call `claudestory_autonomous_guide` with `action: \"pre_compact\"` now:",
        '```json',
        `{ "sessionId": "${state.sessionId}", "action": "pre_compact" }`,
        '```',
        "",
        "After pre_compact responds, run `/compact`, then call with `action: \"resume\"` to continue working on more tickets.",
      ].join("\n"),
      reminders: [
        "Do NOT stop. This is a context compaction, not a session end.",
        "Call pre_compact → /compact → resume to continue autonomous work.",
      ],
      contextAdvice: "compact-now",
    });
  }

  // End session
  const written = writeSessionSync(dir, {
    ...state,
    state: "SESSION_END",
    previousState: "HANDOVER",
    status: "completed",
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

  // Guard: only resume from COMPACT state
  if (info.state.state !== "COMPACT") {
    return guideError(new Error(
      `Session ${args.sessionId} is not in COMPACT state (current: ${info.state.state}). Use action: "report" to continue.`,
    ));
  }

  // Validate preCompactState is a known workflow state
  const resumeState = info.state.preCompactState;
  if (!resumeState || !WORKFLOW_STATES.includes(resumeState as typeof WORKFLOW_STATES[number])) {
    return guideError(new Error(
      `Session ${args.sessionId} has invalid preCompactState: ${resumeState}. Cannot resume safely.`,
    ));
  }

  const written = writeSessionSync(info.dir, {
    ...refreshLease(info.state),
    state: resumeState,
    preCompactState: null,
    resumeFromRevision: null,
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

  // Guard: cannot compact a terminated or already-compacting session
  if (info.state.state === "SESSION_END") {
    return guideError(new Error(`Session ${args.sessionId} is already ended and cannot be compacted.`));
  }
  if (info.state.state === "COMPACT") {
    return guideError(new Error(`Session ${args.sessionId} is already in COMPACT state. Call action: "resume" to continue.`));
  }

  const headResult = await gitHead(root);

  // Determine resume target: if compacting from HANDOVER (compact-continue flow),
  // resume at PICK_TICKET (handover already written, go straight to next ticket).
  // Otherwise resume at the current state.
  const resumeTarget = info.state.state === "HANDOVER" ? "PICK_TICKET" : info.state.state;

  const written = writeSessionSync(info.dir, {
    ...refreshLease(info.state),
    state: "COMPACT",
    previousState: info.state.state,
    preCompactState: resumeTarget,
    resumeFromRevision: info.state.revision,
    git: {
      ...info.state.git,
      expectedHead: headResult.ok ? headResult.data.hash : info.state.git.expectedHead,
    },
  });

  // Save snapshot (uses withProjectLock internally via saveSnapshot)
  try {
    const loadResult = await loadProject(root);
    const { saveSnapshot } = await import("../core/snapshot.js");
    await saveSnapshot(root, loadResult);
  } catch { /* best-effort */ }

  return guideResult(written, "COMPACT", {
    instruction: [
      "# Ready for Compact",
      "",
      "State flushed. Run `/compact` now.",
      "",
      "After compact, call `claudestory_autonomous_guide` with:",
      '```json',
      `{ "sessionId": "${written.sessionId}", "action": "resume" }`,
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

  const written = writeSessionSync(info.dir, {
    ...info.state,
    state: "SESSION_END",
    previousState: info.state.state,
    status: "completed",
  });

  appendEvent(info.dir, {
    rev: written.revision,
    type: "cancelled",
    timestamp: new Date().toISOString(),
    data: { previousState: info.state.state },
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
