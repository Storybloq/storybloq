/**
 * Session report handler — structured analysis of an autonomous session.
 * Decoupled from ProjectState: reads session files directly.
 * Works even if .story/ project state is corrupted.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readSession, readEvents, sessionDir } from "../../autonomous/session.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../autonomous/session-types.js";
import { gitLogRange } from "../../autonomous/git-inspector.js";
import { formatSessionReport } from "../../core/session-report-formatter.js";
import type { OutputFormat } from "../../models/types.js";
import type { CommandResult } from "../types.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleSessionReport(
  sessionId: string,
  root: string,
  format: OutputFormat = "md",
): Promise<CommandResult> {
  // 1. Validate sessionId format (path traversal prevention)
  if (!UUID_REGEX.test(sessionId)) {
    return {
      output: `Error: Invalid session ID format "${sessionId}". Must be a UUID.`,
      exitCode: 1,
      errorCode: "invalid_input",
      isError: true,
    };
  }

  // 2. Check session directory exists
  const dir = sessionDir(root, sessionId);
  if (!existsSync(dir)) {
    return {
      output: `Error: Session ${sessionId} not found.`,
      exitCode: 1,
      errorCode: "not_found",
      isError: true,
    };
  }

  // 3. Check schema version before full parse (catches future versions that parse successfully)
  const statePath = join(dir, "state.json");
  if (!existsSync(statePath)) {
    return {
      output: `Error: Session ${sessionId} corrupt — state.json missing.`,
      exitCode: 1,
      errorCode: "project_corrupt",
      isError: true,
    };
  }
  try {
    const rawJson = JSON.parse(readFileSync(statePath, "utf-8"));
    if (rawJson && typeof rawJson === "object" && "schemaVersion" in rawJson &&
        rawJson.schemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) {
      return {
        output: `Error: Session ${sessionId} — unsupported session schema version ${rawJson.schemaVersion}.`,
        exitCode: 1,
        errorCode: "version_mismatch",
        isError: true,
      };
    }
  } catch {
    return {
      output: `Error: Session ${sessionId} corrupt — invalid state.json (not valid JSON).`,
      exitCode: 1,
      errorCode: "project_corrupt",
      isError: true,
    };
  }

  // 4. Full session parse
  const state = readSession(dir);
  if (!state) {
    return {
      output: `Error: Session ${sessionId} corrupt — invalid state.json.`,
      exitCode: 1,
      errorCode: "project_corrupt",
      isError: true,
    };
  }

  // 5. Read events.log (tolerant)
  const events = readEvents(dir);

  // 6. Read plan.md (optional)
  let planContent: string | null = null;
  try {
    planContent = readFileSync(join(dir, "plan.md"), "utf-8");
  } catch { /* graceful — plan section shows "Not available" */ }

  // 7. Git log for session range (best-effort — requires both refs)
  let gitLog: string[] | null = null;
  const initHead = state.git.initHead ?? null;
  const lastCommit = state.completedTickets.length > 0
    ? state.completedTickets[state.completedTickets.length - 1]!.commitHash ?? null
    : state.git.expectedHead ?? null;
  if (initHead && lastCommit) {
    const result = await gitLogRange(root, initHead, lastCommit, 20);
    if (result.ok) {
      gitLog = result.data;
    }
  }

  // 8. Format report
  const output = formatSessionReport({ state, events, planContent, gitLog }, format);
  return { output };
}
