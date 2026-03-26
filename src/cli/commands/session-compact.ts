/**
 * CLI handlers for hook-driven compaction (ISS-032).
 *
 * - session-compact-prepare: PreCompact hook entry — prepares session for compaction
 * - session-resume-prompt: SessionStart hook entry — outputs resume instruction after compaction
 * - session-clear-compact: Admin escape hatch — clears stale compact markers
 */
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import {
  findActiveSessionFull,
  findResumableSession,
  findSessionById,
  prepareForCompact,
  writeSessionSync,
  withSessionLock,
  appendEvent,
  refreshLease,
  type ActiveSessionInfo,
} from "../../autonomous/session.js";
import { WORKFLOW_STATES } from "../../autonomous/session-types.js";
import { loadProject } from "../../core/project-loader.js";

// ---------------------------------------------------------------------------
// session-compact-prepare (PreCompact hook)
// ---------------------------------------------------------------------------

/**
 * PreCompact hook entry point. Prepares an active session for compaction.
 * - Discovers .story/ root from cwd
 * - Under withSessionLock (5s timeout): prepareForCompact + snapshot
 * - Silent on success / no session / no .story/
 * - Emits stderr on real failures
 * - Always exits 0 (hook must not block compaction)
 */
export async function handleSessionCompactPrepare(): Promise<void> {
  const root = discoverProjectRoot();
  if (!root) return; // No .story/ — silent no-op

  try {
    await withSessionLock(root, async () => {
      const active = findActiveSessionFull(root);
      if (!active) return; // No active session — silent no-op

      // prepareForCompact FIRST (fast state.json write — ensures compactPending persisted)
      try {
        prepareForCompact(active.dir, refreshLease(active.state));
      } catch (err) {
        process.stderr.write(`[claudestory] compact-prepare: ${err instanceof Error ? err.message : String(err)}\n`);
        return;
      }

      // THEN snapshot (slower, can fail — compactPending is already set)
      try {
        const loadResult = await loadProject(root);
        const { saveSnapshot } = await import("../../core/snapshot.js");
        await saveSnapshot(root, loadResult);
      } catch {
        // Snapshot failure is recoverable — compactPending is set, resume will work
      }
    });
  } catch (err) {
    // Lock acquisition or other failure — emit stderr, exit 0
    process.stderr.write(`[claudestory] compact-prepare failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ---------------------------------------------------------------------------
// session-resume-prompt (SessionStart hook)
// ---------------------------------------------------------------------------

/**
 * SessionStart hook entry point. Outputs resume instruction for compacted sessions.
 * - Resolves project root + workspace from cwd
 * - Finds resumable session (compactPending + active + workspace match)
 * - Fresh: outputs normal resume instruction
 * - Fresh + resumeBlocked: outputs blocked-resume instruction
 * - Stale (>1hr): outputs stale recovery message
 * - No match: silent (no output)
 */
export async function handleSessionResumePrompt(): Promise<void> {
  const root = discoverProjectRoot();
  if (!root) return; // No .story/ — silent

  const match = findResumableSession(root);
  if (!match) return; // No resumable session — silent

  const { info, stale } = match;
  const sessionId = info.state.sessionId;

  // Stale check first — stale sessions get stale message regardless of resumeBlocked
  if (stale) {
    // Stale session — output recovery message (not silence)
    process.stdout.write(
      `Stale compacted session ${sessionId} found (never resumed).\n` +
      `Run "claudestory session clear-compact ${sessionId}" to recover, ` +
      `or call claudestory_autonomous_guide with:\n` +
      `{"sessionId": "${sessionId}", "action": "resume"}\n`,
    );
    return;
  }

  if (info.state.resumeBlocked) {
    // Blocked resume — output recovery instructions
    process.stdout.write(
      `Autonomous session ${sessionId} has a blocked resume (git validation failed).\n` +
      `Run "claudestory session clear-compact ${sessionId}" to recover, ` +
      `or check git status and call claudestory_autonomous_guide with:\n` +
      `{"sessionId": "${sessionId}", "action": "resume"}\n`,
    );
    return;
  }

  // Fresh session — output normal resume instruction
  process.stdout.write(
    `Continue the autonomous coding session. Call \`claudestory_autonomous_guide\` with:\n` +
    `{"sessionId": "${sessionId}", "action": "resume"}\n`,
  );
}

// ---------------------------------------------------------------------------
// session-clear-compact (admin escape hatch)
// ---------------------------------------------------------------------------

/**
 * Admin command to clear stale compact markers.
 * - Valid preCompactState: clears resumeBlocked, refreshes compactPreparedAt (keeps compactPending).
 *   User must call resume for actual state restoration (HEAD validation runs there).
 * - Invalid preCompactState: ends session (SESSION_END + admin_recovery).
 */
export async function handleSessionClearCompact(root: string, sessionId?: string): Promise<string> {
  return withSessionLock(root, async () => {
    let info: ActiveSessionInfo | null = null;

    if (sessionId) {
      info = findSessionById(root, sessionId);
      if (!info) throw new Error(`Session ${sessionId} not found`);
    } else {
      // Scan for any compactPending session (findResumableSession has no lease filter)
      const match = findResumableSession(root);
      if (match) {
        info = match.info;
      }
      if (!info) throw new Error("No compactPending session found. Specify the session ID manually.");
    }

    if (!info.state.compactPending) {
      throw new Error(`Session ${info.state.sessionId} is not in compact-pending state`);
    }

    const preCompactState = info.state.preCompactState;
    const isValidState = preCompactState && WORKFLOW_STATES.includes(preCompactState as typeof WORKFLOW_STATES[number]);

    if (isValidState) {
      // Valid: clear resumeBlocked, refresh timestamp (keeps compactPending for discovery)
      writeSessionSync(info.dir, {
        ...info.state,
        resumeBlocked: false,
        compactPreparedAt: new Date().toISOString(),
      });
      return `Compact markers cleared for session ${info.state.sessionId}. Resume with:\n` +
        `claudestory_autonomous_guide {"sessionId": "${info.state.sessionId}", "action": "resume"}`;
    }

    // Invalid: end session
    const written = writeSessionSync(info.dir, {
      ...info.state,
      state: "SESSION_END",
      previousState: info.state.state,
      status: "completed" as const,
      terminationReason: "admin_recovery",
      compactPending: false,
      compactPreparedAt: null,
      resumeBlocked: false,
    });

    appendEvent(info.dir, {
      rev: written.revision,
      type: "admin_recovery",
      timestamp: new Date().toISOString(),
      data: {
        reason: "invalid_preCompactState",
        preCompactState: preCompactState ?? null,
        ticketId: info.state.ticket?.id ?? null,
      },
    });

    return `Session ${info.state.sessionId} ended (unrecoverable — invalid preCompactState: ${preCompactState ?? "null"}). Run "start" for a new session.`;
  });
}
