/**
 * ISS-1022: the presence hook handler.
 *
 * Runs synchronously on `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` and
 * `SessionEnd`. Two of those fire on EVERY tool call, so the steady-state cost
 * of this feature is two synchronous spawns per tool call. That is why it lives
 * behind its own slim bin (`storybloq-presence`) whose import graph is
 * `node:fs`, `node:path` and `core/project-root-shared.ts`: the shared
 * `dist/cli.js` bundle costs ~310ms per invocation before any hook logic runs,
 * almost all of it parsing 2.4MB of unrelated code.
 *
 * FAIL-SOFT POSTURE, borrowed from `handleBusToolHook`: one catch-all, empty
 * stdout, unconditional exit 0. A non-zero exit on `PreToolUse` BLOCKS the tool
 * call, so a non-zero exit must never be deliberate here.
 *
 * Work is ordered cheapest-first so a repo with no `.story/` pays almost
 * nothing: event check, session-id check, root discovery, opt-out, autonomous
 * probe, then the lock and the write.
 */

import { join } from "node:path";

import type { OwnerTask } from "../autonomous/client-profile.js";
import { resolveSessionOwnership } from "../autonomous/session-ownership.js";
import { discoverProjectRootShared } from "../core/project-root-shared.js";
import {
  LOCK_ACQUIRE_BUDGET_MS,
  acquireLock,
  atomicWriteInDir,
  ensurePresenceDir,
  presenceDirIfPresent,
  readBoundedFollowingLink,
  removeAllPresenceRecords,
  readBoundedNoFollow,
  releaseLock,
  sweepPresenceDir,
} from "./io.js";
import { applyPresenceEvent, isValidSessionId, parsePresenceRecord, serializePresence } from "./record.js";
import { capString, redactedTarget } from "./redaction.js";
import {
  MAX_ID_BYTES,
  MAX_RECORD_BYTES,
  MAX_TOOL_NAME_BYTES,
  isPresenceHookEvent,
  presenceFileBase,
  type PresenceHookEvent,
} from "./types.js";

const CONFIG_MAX_BYTES = 262_144;
const STATUS_MAX_BYTES = 256 * 1024;

/** What the handler did, for tests and for nothing else -- nothing is printed. */
export type PresenceOutcome =
  | "written"
  | "skipped-not-presence-event"
  | "skipped-invalid-session"
  | "skipped-no-project"
  | "skipped-disabled"
  | "skipped-no-directory"
  | "skipped-lock-busy"
  | "skipped-too-large"
  | "skipped-write-failed";

export function runPresenceHook(input: unknown, now = new Date()): PresenceOutcome {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "skipped-not-presence-event";
  const payload = input as Record<string, unknown>;

  const event = payload.hook_event_name;
  if (!isPresenceHookEvent(event)) return "skipped-not-presence-event";

  const sessionId = payload.session_id;
  if (!isValidSessionId(sessionId)) return "skipped-invalid-session";

  const cwd = payload.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return "skipped-no-project";
  const root = discoverProjectRootShared(cwd);
  if (!root) return "skipped-no-project";

  // Producer half of the opt-out. Existing records are cleaned up by
  // `removePresenceRecords` on the next non-hook setup path, not here: this
  // path runs per tool call, and a directory scan on every one of them is the
  // cost the opt-out exists to avoid. The consumer half is the Mac loader,
  // which suppresses presence when config disables it, so turning this off
  // never leaves rows animating from records written before the change.
  if (!isPresenceEnabled(root)) return "skipped-disabled";

  const suppressed = correlatesWithActiveAutonomousSession(root, sessionId);

  const dir = ensurePresenceDir(root);
  if (!dir) return "skipped-no-directory";

  // Not the raw id: `presenceFileBase` encodes the portability hazards the
  // client's id shape still admits (`:` is NTFS alternate-stream syntax,
  // `CON`/`AUX`/`COM1` are Windows devices). The `.lock` suffix additionally
  // keeps the lock directory in the Mac watcher's `.ignored` classification.
  const base = presenceFileBase(sessionId);
  const recordPath = join(dir, `${base}.json`);
  const lockPath = join(dir, `${base}.lock`);

  if (!acquireLock(lockPath, LOCK_ACQUIRE_BUDGET_MS)) {
    // A held lock costs at most the budget and then drops the update. The next
    // event repairs it; stalling a tool call would not be repairable.
    return "skipped-lock-busy";
  }

  try {
    const existingText = readBoundedNoFollow(recordPath, MAX_RECORD_BYTES);
    const previous = existingText === null ? null : parsePresenceRecord(existingText, sessionId);
    const nowIso = now.toISOString();

    const toolName = capString(payload.tool_name, MAX_TOOL_NAME_BYTES);
    const next = applyPresenceEvent(previous, {
      event,
      sessionId,
      nowIso,
      source: capString(payload.source, MAX_TOOL_NAME_BYTES),
      toolId: resolveToolId(payload, event, toolName, now),
      toolName,
      target: event === "PreToolUse" && toolName
        ? redactedTarget(root, cwd, toolName, payload.tool_input)
        : null,
      agentId: resolveAgentId(payload),
      suppressed,
    });

    const serialized = serializePresence(next);
    if (serialized === null) return "skipped-too-large";
    if (!atomicWriteInDir(dir, recordPath, serialized)) return "skipped-write-failed";
    return "written";
  } finally {
    releaseLock(lockPath);
    // Per-session cost, never per-tool-call.
    if (event === "SessionStart" || event === "SessionEnd") {
      try { sweepPresenceDir(dir, now.getTime()); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Opt-out
// ---------------------------------------------------------------------------

/**
 * `statusWriter.presence !== false`. Fails OPEN to enabled on every
 * uncertainty (absent, unreadable, malformed, non-boolean), matching
 * `isStopHookStatusWriteEnabled`: a broken config must never silently blind the
 * Mac app. Only an explicit `false` disables.
 *
 * Symlink policy follows `core/limit-config.ts`: `.story/config.json` is USER
 * input, so a legitimately symlinked config IS honoured -- the link is resolved
 * first and the RESOLVED path is opened no-follow, so honouring it does not
 * reopen a swap race.
 */
export function isPresenceEnabled(root: string): boolean {
  try {
    const body = readBoundedFollowingLink(join(root, ".story", "config.json"), CONFIG_MAX_BYTES);
    if (body === null) return true;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const raw = parsed?.statusWriter;
    if (!raw || typeof raw !== "object") return true;
    return (raw as Record<string, unknown>).presence !== false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Autonomous correlation
// ---------------------------------------------------------------------------

/**
 * Is this Claude session the one driving an ACTIVE autonomous session?
 *
 * `/story auto` runs inside Claude Code, so these hooks fire there too, and the
 * Sessions panel must not render both the autonomous view and a duplicate
 * interactive row for the same session.
 *
 * A bounded constant-cost read of `status.json`, never a scan of
 * `.story/sessions/` (whose cost grows with history and which is on a
 * per-tool-call path here). The result sets a REVERSIBLE `suppressed` flag
 * rather than a tombstone: `PreToolUse` for the first guide call can precede
 * the autonomous record existing, so a record may already be created and need
 * suppressing afterwards -- and when the user keeps working in the same Claude
 * session after `/story auto` finishes, with no new SessionStart, suppression
 * must clear and the session reappear.
 *
 * status.json is a GENERATED artifact, so the read REFUSES a symlink (the
 * deliberate asymmetry with config.json above).
 */
export function correlatesWithActiveAutonomousSession(root: string, sessionId: string): boolean {
  try {
    const body = readBoundedNoFollow(join(root, ".story", "status.json"), STATUS_MAX_BYTES);
    if (body === null) return false;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed?.sessionActive !== true) return false;
    // Routed through the ISS-899 resolver rather than comparing the two owner
    // fields here. That precedence (`ownerTask`, else `claudeCodeSessionId`)
    // was hand-rolled five times before and had already drifted; a sixth copy
    // in a per-tool-call hook is exactly how it would drift again, and the
    // architecture pin in test/autonomous/ownership-iss899.test.ts caught this
    // one on its first run. The resolver's closure is two dependency-free
    // files, so importing it costs the slim entry nothing.
    const legacyId: unknown = parsed.claudeCodeSessionId;
    const ownership = resolveSessionOwnership(
      {
        ownerTask: isOwnerTaskShape(parsed.ownerTask) ? parsed.ownerTask : null,
        claudeCodeSessionId: typeof legacyId === "string" ? legacyId : null,
      },
      { client: "claude", id: sessionId, boundAt: "" },
    );
    // `same` ONLY. `unowned` means the autonomous session records no owner at
    // all, which is not evidence that THIS session is the one driving it.
    return ownership.kind === "same";
  } catch {
    return false;
  }
}

function isOwnerTaskShape(value: unknown): value is OwnerTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (v.client === "claude" || v.client === "codex") && typeof v.id === "string" && v.id.length > 0;
}

// ---------------------------------------------------------------------------
// Record removal (opt-out cleanup)
// ---------------------------------------------------------------------------

/** Removes every presence record in a project. Used by the opt-out path and by `setup-skill`. */
export function removePresenceRecords(root: string): number {
  const dir = presenceDirIfPresent(root);
  if (!dir) return 0;
  return removeAllPresenceRecords(dir);
}

// ---------------------------------------------------------------------------
// Payload field extraction
// ---------------------------------------------------------------------------

/**
 * `tool_use_id` when the client supplies one. When it does not, PreToolUse
 * synthesizes an id and PostToolUse returns null so `applyPresenceEvent` falls
 * back to closing the oldest open call with the same tool name.
 */
function resolveToolId(
  payload: Record<string, unknown>,
  event: PresenceHookEvent,
  toolName: string | null,
  now: Date,
): string | null {
  const supplied = capString(payload.tool_use_id, MAX_ID_BYTES);
  if (supplied) return supplied;
  // Entropy, not just the clock: two parallel PreToolUse events for the same
  // tool inside one millisecond would otherwise share an id, and the second
  // would be discarded as an already-open duplicate.
  if (event === "PreToolUse" && toolName) {
    return `syn:${toolName}:${now.getTime()}:${Math.random().toString(36).slice(2, 10)}`;
  }
  return null;
}

function resolveAgentId(payload: Record<string, unknown>): string | null {
  return capString(payload.agent_id, MAX_ID_BYTES)
    ?? capString(payload.subagent_id, MAX_ID_BYTES)
    ?? capString(payload.agentId, MAX_ID_BYTES);
}
