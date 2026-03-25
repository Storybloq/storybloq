import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { STORY_GITIGNORE_ENTRIES } from "../../core/init.js";
import {
  deriveClaudeStatus,
  deriveWorkspaceId,
  CURRENT_STATUS_SCHEMA_VERSION,
  type SessionState,
  type StatusPayload,
} from "../../autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Stdin reading — silent version (no throws, no validation)
// ---------------------------------------------------------------------------

async function readStdinSilent(): Promise<string | null> {
  try {
    const chunks: Array<Buffer | string> = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer | string);
    }
    return Buffer.concat(
      chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
    ).toString("utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Atomic write (sync) — silent, never throws
// ---------------------------------------------------------------------------

function atomicWriteSync(targetPath: string, content: string): boolean {
  const tmp = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, targetPath);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup errors */
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Status payloads
// ---------------------------------------------------------------------------

function inactivePayload(): StatusPayload {
  return { schemaVersion: CURRENT_STATUS_SCHEMA_VERSION, sessionActive: false, source: "hook" };
}

function activePayload(session: SessionState): StatusPayload {
  return {
    schemaVersion: CURRENT_STATUS_SCHEMA_VERSION,
    sessionActive: true,
    sessionId: session.sessionId,
    state: session.state,
    ticket: session.ticket?.id ?? null,
    ticketTitle: session.ticket?.title ?? null,
    risk: session.ticket?.risk ?? null,
    claudeStatus: deriveClaudeStatus(session.state, session.waitingForRetry),
    observedAt: new Date().toISOString(),
    lastGuideCall: session.lastGuideCall ?? null,
    completedThisSession: session.completedTickets?.map((t) => t.id) ?? [],
    contextPressure: session.contextPressure?.level ?? "unknown",
    branch: session.git?.branch ?? null,
    source: "hook",
  };
}

// ---------------------------------------------------------------------------
// Session scanning
// ---------------------------------------------------------------------------

function findActiveSession(root: string): SessionState | null {
  const sessionsDir = join(root, ".story", "sessions");

  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let workspaceId: string;
  try {
    workspaceId = deriveWorkspaceId(root);
  } catch {
    return null;
  }

  const now = Date.now();
  let best: SessionState | null = null;
  let bestGuideCall = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const statePath = join(sessionsDir, entry.name, "state.json");
    let raw: string;
    try {
      raw = readFileSync(statePath, "utf-8");
    } catch {
      continue;
    }

    let session: SessionState;
    try {
      session = JSON.parse(raw) as SessionState;
    } catch {
      continue;
    }

    // Must have a valid sessionId
    if (!session.sessionId || typeof session.sessionId !== "string") continue;

    // Workspace must match (missing workspaceId treated as compatible for forward-compat)
    if (session.lease?.workspaceId && session.lease.workspaceId !== workspaceId) continue;

    // Lease must not be stale
    if (!session.lease?.expiresAt) continue;
    const expires = new Date(session.lease.expiresAt).getTime();
    if (Number.isNaN(expires) || expires <= now) continue;

    // Pick most recent lastGuideCall, tie-break by sessionId
    const guideCall = session.lastGuideCall
      ? new Date(session.lastGuideCall).getTime()
      : 0;
    const guideCallValid = Number.isNaN(guideCall) ? 0 : guideCall;

    if (
      !best ||
      guideCallValid > bestGuideCall ||
      (guideCallValid === bestGuideCall && session.sessionId > best.sessionId)
    ) {
      best = session;
      bestGuideCall = guideCallValid;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Gitignore — ensure ephemeral entries are gitignored
// ---------------------------------------------------------------------------

function ensureGitignore(root: string): void {
  const gitignorePath = join(root, ".story", ".gitignore");

  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist — will create
  }

  const lines = existing.split("\n").map((l) => l.trim());
  const missing = STORY_GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return;

  let content = existing;
  if (content.length > 0 && !content.endsWith("\n")) content += "\n";
  content += missing.join("\n") + "\n";
  try {
    writeFileSync(gitignorePath, content, "utf-8");
  } catch {
    // Best-effort — don't block status writing
  }
}

// ---------------------------------------------------------------------------
// Write status.json
// ---------------------------------------------------------------------------

function writeStatus(root: string, payload: StatusPayload): void {
  ensureGitignore(root);
  const statusPath = join(root, ".story", "status.json");
  const content = JSON.stringify(payload, null, 2) + "\n";
  atomicWriteSync(statusPath, content);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Stop hook handler — writes .story/status.json with current session state.
 *
 * Fast, standalone. Does NOT load ProjectState. Target <50ms (excluding Node startup).
 * Never exits non-zero. Never throws.
 */
export async function handleHookStatus(): Promise<void> {
  try {
    // TTY — manual invocation (no pipe). Scan for active session same as piped path.
    if (process.stdin.isTTY) {
      const root = discoverProjectRoot();
      if (root) {
        const session = findActiveSession(root);
        const payload = session ? activePayload(session) : inactivePayload();
        writeStatus(root, payload);
      }
      process.exit(0);
    }

    // Read stdin (null = error reading, empty = no data)
    const raw = await readStdinSilent();
    if (raw === null || raw === "") {
      // Can't determine project — preserve last good status
      process.exit(0);
    }

    // Parse
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Unparsable — preserve last good status
      process.exit(0);
    }

    // Guard: stop_hook_active
    if (input!.stop_hook_active === true) {
      process.exit(0);
    }

    // Must have cwd
    const cwd = input!.cwd;
    if (typeof cwd !== "string" || !cwd) {
      process.exit(0);
    }

    // Discover project root
    const root = discoverProjectRoot(cwd);
    if (!root) {
      process.exit(0);
    }

    // Scan for active session
    const session = findActiveSession(root);
    const payload = session ? activePayload(session) : inactivePayload();
    writeStatus(root, payload);
  } catch {
    // Catch-all — never crash
  }

  process.exit(0);
}
