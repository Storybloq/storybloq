import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  SessionStateSchema,
  deriveWorkspaceId,
  type FullSessionState,
  type SessionState,
  type EventEntry,
} from "./session-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEASE_DURATION_MS = 45 * 60 * 1000; // 45 minutes
const SESSIONS_DIR = "sessions";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function sessionsRoot(root: string): string {
  return join(root, ".story", SESSIONS_DIR);
}

export function sessionDir(root: string, sessionId: string): string {
  return join(sessionsRoot(root), sessionId);
}

function statePath(dir: string): string {
  return join(dir, "state.json");
}

function eventsPath(dir: string): string {
  return join(dir, "events.log");
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/** Create a new session directory and write initial state.json. */
export interface SessionConfig {
  maxTicketsPerSession?: number;
  compactThreshold?: string;
  reviewBackends?: string[];
  mode?: "auto" | "review" | "plan" | "guided";
  handoverInterval?: number;
}

/** Create a new session directory and write initial state.json. */
export function createSession(
  root: string,
  recipe: string,
  workspaceId: string,
  configOverrides?: SessionConfig,
): FullSessionState {
  const id = randomUUID();
  const dir = sessionDir(root, id);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const state: FullSessionState = {
    schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    sessionId: id,
    recipe,
    state: "INIT",
    revision: 0,
    status: "active",
    mode: configOverrides?.mode ?? "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: {
      workspaceId,
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
    },
    contextPressure: {
      level: "low",
      guideCallCount: 0,
      ticketsCompleted: 0,
      compactionCount: 0,
      eventsLogBytes: 0,
    },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: {
      maxTicketsPerSession: configOverrides?.maxTicketsPerSession ?? 0,
      compactThreshold: configOverrides?.compactThreshold ?? "high",
      reviewBackends: configOverrides?.reviewBackends ?? ["codex", "agent"],
      handoverInterval: configOverrides?.handoverInterval ?? 5,
    },
  };

  writeSessionSync(dir, state);
  return state;
}

/** Read and validate session state from a session directory. Returns null on any error. */
export function readSession(dir: string): FullSessionState | null {
  const path = statePath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = SessionStateSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

/** Write session state atomically (write tmp, rename). Increments revision. Returns the written state. */
export function writeSessionSync(dir: string, state: FullSessionState): FullSessionState {
  const path = statePath(dir);
  const updated = { ...state, revision: state.revision + 1 };
  const content = JSON.stringify(updated, null, 2) + "\n";
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  return updated;
}

/** Append an event to events.log (best-effort, non-authoritative). */
export function appendEvent(dir: string, event: EventEntry): void {
  try {
    const path = eventsPath(dir);
    const line = JSON.stringify(event) + "\n";
    writeFileSync(path, line, { flag: "a", encoding: "utf-8" });
  } catch {
    // Best-effort — events.log is supplementary
  }
}

/** Read events.log with tolerant parsing — skips malformed lines. */
export function readEvents(dir: string): { events: EventEntry[]; malformedCount: number } {
  const path = eventsPath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { events: [], malformedCount: 0 };
  }

  const events: EventEntry[] = [];
  let malformedCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed === "object" && parsed !== null &&
        typeof parsed.rev === "number" &&
        typeof parsed.type === "string" &&
        typeof parsed.timestamp === "string" &&
        (!("data" in parsed) || (typeof parsed.data === "object" && parsed.data !== null))
      ) {
        events.push(parsed as EventEntry);
      } else {
        malformedCount++;
      }
    } catch {
      malformedCount++;
    }
  }
  return { events, malformedCount };
}

/** Delete a session directory. Used for cleanup on failed start. */
export function deleteSession(root: string, sessionId: string): void {
  const dir = sessionDir(root, sessionId);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Lease management
// ---------------------------------------------------------------------------

/** Refresh the lease on a session (called on every guide interaction). */
export function refreshLease(state: FullSessionState): FullSessionState {
  const now = new Date().toISOString();
  const newCallCount = state.guideCallCount + 1;
  return {
    ...state,
    lease: {
      ...state.lease,
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() + LEASE_DURATION_MS).toISOString(),
    },
    lastGuideCall: now,
    guideCallCount: newCallCount,
    contextPressure: {
      ...state.contextPressure,
      guideCallCount: newCallCount,
      ticketsCompleted: state.completedTickets?.length ?? 0,
    },
  };
}

/** Check if a session's lease has expired. */
export function isLeaseExpired(state: SessionState | FullSessionState): boolean {
  if (!state.lease?.expiresAt) return true;
  const expires = new Date(state.lease.expiresAt).getTime();
  return Number.isNaN(expires) || expires <= Date.now();
}

// ---------------------------------------------------------------------------
// Session discovery (shared between hook-status and guide)
// ---------------------------------------------------------------------------

export interface ActiveSessionInfo {
  readonly state: FullSessionState;
  readonly dir: string;
}

/**
 * Find the active session for a workspace. Returns the best match by lastGuideCall.
 * Used by both hook-status (for status.json) and guide (for session management).
 */
export function findActiveSessionFull(root: string): ActiveSessionInfo | null {
  const sessDir = sessionsRoot(root);

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId(root);
  } catch {
    return null;
  }

  let best: ActiveSessionInfo | null = null;
  let bestGuideCall = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(sessDir, entry.name);
    const session = readSession(dir);
    if (!session) continue;
    if (session.status !== "active") continue;

    // Workspace must match (missing = compatible for forward-compat)
    if (session.lease?.workspaceId && session.lease.workspaceId !== workspaceId) continue;

    // Lease must not be stale
    if (isLeaseExpired(session)) continue;

    // Pick most recent lastGuideCall, tie-break by sessionId
    const guideCall = session.lastGuideCall
      ? new Date(session.lastGuideCall).getTime()
      : 0;
    const guideCallValid = Number.isNaN(guideCall) ? 0 : guideCall;

    if (
      !best ||
      guideCallValid > bestGuideCall ||
      (guideCallValid === bestGuideCall && session.sessionId > best.state.sessionId)
    ) {
      best = { state: session, dir };
      bestGuideCall = guideCallValid;
    }
  }

  return best;
}

/**
 * Find active session returning the minimal SessionState shape.
 * Used by hook-status.ts for backward compatibility.
 */
export function findActiveSessionMinimal(root: string): SessionState | null {
  const result = findActiveSessionFull(root);
  return result?.state ?? null;
}

/**
 * Find stale (expired lease) active sessions for a workspace. Used by start to supersede them.
 */
export function findStaleSessions(root: string): ActiveSessionInfo[] {
  const sessDir = sessionsRoot(root);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessDir, { withFileTypes: true });
  } catch {
    return [];
  }

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId(root);
  } catch {
    return [];
  }

  const results: ActiveSessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessDir, entry.name);
    const session = readSession(dir);
    if (!session) continue;
    if (session.status !== "active") continue;
    if (session.lease?.workspaceId && session.lease.workspaceId !== workspaceId) continue;
    if (isLeaseExpired(session)) {
      results.push({ state: session, dir });
    }
  }
  return results;
}

/**
 * Find a specific session by ID.
 */
export function findSessionById(root: string, sessionId: string): ActiveSessionInfo | null {
  const dir = sessionDir(root, sessionId);
  if (!existsSync(dir)) return null;
  const state = readSession(dir);
  if (!state) return null;
  return { state, dir };
}

// ---------------------------------------------------------------------------
// Compact preparation (ISS-032: hook-driven compaction)
// ---------------------------------------------------------------------------

export interface CompactPrepareResult {
  sessionId: string;
  preCompactState: string;
  resumeFromRevision: number;
}

/**
 * Prepare a session for compaction. Used by BOTH the CLI hook (session-compact-prepare)
 * and the guide's handlePreCompact action. Sets state=COMPACT with compactPending marker.
 *
 * Guards: SESSION_END → throw, FINALIZE → throw, stale COMPACT → throw.
 * Idempotent: if already pending (compactPending + COMPACT), refreshes timestamp only.
 */
export function prepareForCompact(
  dir: string,
  state: FullSessionState,
  opts?: { expectedHead?: string },
): CompactPrepareResult {
  if (state.state === "SESSION_END") throw new Error("Session already ended");
  if (state.state === "FINALIZE") throw new Error("Cannot compact during FINALIZE — complete the commit first");

  // Idempotent: already pending → refresh timestamp + expectedHead
  if (state.compactPending && state.state === "COMPACT") {
    const updatedGit = opts?.expectedHead
      ? { ...state.git, expectedHead: opts.expectedHead }
      : state.git;
    writeSessionSync(dir, { ...state, compactPreparedAt: new Date().toISOString(), resumeBlocked: false, git: updatedGit });
    return {
      sessionId: state.sessionId,
      preCompactState: state.preCompactState ?? state.state,
      resumeFromRevision: state.resumeFromRevision ?? state.revision,
    };
  }

  // Stale manual COMPACT (state=COMPACT but compactPending=false)
  if (state.state === "COMPACT") {
    throw new Error("Session is in COMPACT state but not pending. Call resume or clear-compact.");
  }

  const resumeTarget = state.state === "HANDOVER" ? "PICK_TICKET" : state.state;

  const written = writeSessionSync(dir, {
    ...state,
    state: "COMPACT",
    previousState: state.state,
    preCompactState: resumeTarget,
    resumeFromRevision: state.revision,
    compactPending: true,
    compactPreparedAt: new Date().toISOString(),
    resumeBlocked: false,
    git: { ...state.git, expectedHead: opts?.expectedHead ?? state.git.expectedHead },
  });

  return {
    sessionId: written.sessionId,
    preCompactState: resumeTarget,
    resumeFromRevision: state.revision,  // pre-write value, matches what's stored in state.json
  };
}

/**
 * Find a resumable session (compactPending + active + workspace match).
 * Used by session-resume-prompt CLI (SessionStart hook).
 * Separate from findActiveSessionFull to preserve single-session invariant.
 * Read-only — no lock needed.
 */
export function findResumableSession(root: string): { info: ActiveSessionInfo; stale: boolean } | null {
  const sessDir = sessionsRoot(root);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId(root);
  } catch {
    return null;
  }

  const FRESHNESS_MS = 60 * 60 * 1000; // 1 hour
  let best: { info: ActiveSessionInfo; stale: boolean } | null = null;
  let bestPreparedAt = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessDir, entry.name);
    const session = readSession(dir);
    if (!session) continue;
    if (session.status !== "active") continue;
    if (!session.compactPending) continue;
    if (session.lease?.workspaceId && session.lease.workspaceId !== workspaceId) continue;
    // No lease expiry check — compactPreparedAt freshness handles staleness.
    // Lease expiry is for session management (findActiveSessionFull), not hook discovery.

    const preparedAt = session.compactPreparedAt
      ? new Date(session.compactPreparedAt).getTime()
      : 0;
    const preparedAtValid = Number.isNaN(preparedAt) ? 0 : preparedAt;
    const isStale = Date.now() - preparedAtValid > FRESHNESS_MS;

    if (preparedAtValid > bestPreparedAt) {
      best = { info: { state: session, dir }, stale: isStale };
      bestPreparedAt = preparedAtValid;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Session lock (filesystem-level, cross-process)
// ---------------------------------------------------------------------------

/**
 * Execute a function while holding the session filesystem lock.
 * Uses proper-lockfile on .story/sessions/.lock.
 */
export async function withSessionLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const sessDir = sessionsRoot(root);
  mkdirSync(sessDir, { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(sessDir, {
      retries: { retries: 3, minTimeout: 100, maxTimeout: 1000 },
      stale: 30000,
      lockfilePath: join(sessDir, ".lock"),
    });
    return await fn();
  } finally {
    if (release) {
      try { await release(); } catch { /* ignore */ }
    }
  }
}
