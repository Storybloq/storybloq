import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { STORY_GITIGNORE_ENTRIES } from "../../core/init.js";
import {
  type StatusPayload,
} from "../../autonomous/session-types.js";
import { buildActivePayload, buildInactivePayload } from "../../autonomous/status-payload.js";
import { findActiveSessionMinimal, sessionDir } from "../../autonomous/session.js";
import { readLastMcpCall, readAliveTimestamp } from "../../autonomous/liveness.js";
import { readSubprocessSummaries } from "../../autonomous/subprocess-registry.js";
import { writeStatusFile } from "../../autonomous/status-writer.js";
import { collectProbes, reduceHealthState } from "../../autonomous/health-model.js";

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
// Status payloads
// ---------------------------------------------------------------------------

function inactivePayload(): StatusPayload {
  return buildInactivePayload();
}

function activePayload(session: Parameters<typeof buildActivePayload>[0], root: string): StatusPayload {
  const sDir = sessionDir(root, session.sessionId);
  const lastMcpCall = readLastMcpCall(sDir);
  const aliveTs = readAliveTimestamp(sDir);
  const subprocesses = readSubprocessSummaries(sDir);
  const probes = collectProbes(sDir);
  const healthState = reduceHealthState(probes);
  return buildActivePayload(session, {
    lastMcpCall,
    alive: aliveTs !== null,
    runningSubprocesses: subprocesses.length > 0 ? subprocesses : null,
    healthState,
  });
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
  const withWriter = { ...payload, lastWrittenBy: "hook" as const };
  writeStatusFile(root, withWriter as StatusPayload);
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
        const session = findActiveSessionMinimal(root);
        const payload = session ? activePayload(session, root) : inactivePayload();
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
    const session = findActiveSessionMinimal(root);
    const payload = session ? activePayload(session, root) : inactivePayload();
    writeStatus(root, payload);
  } catch {
    // Catch-all — never crash
  }

  process.exit(0);
}
