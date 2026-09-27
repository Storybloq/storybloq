/**
 * The machine-wide Storybloq state directory and the global kill switches read
 * from its config.json. Moved out of the retired T-424 limit ledger (T-534)
 * unchanged.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readBoundedFile } from "./bounded-read.js";

/** Established global state dir (see core/update-check.ts). Env override is for tests + E2E sims. */
export function storybloqGlobalDir(): string {
  return process.env.STORYBLOQ_GLOBAL_DIR || join(homedir(), ".claude", "storybloq");
}

/**
 * T-502 global kill switch for `storybloq health`:
 * ~/.claude/storybloq/config.json { "healthCheck": { "enabled": false } }.
 * Absence = enabled. Project-level `healthCheck` in .story/config.json gates
 * the checks per project; this one silences the command machine-wide, which
 * is the only switch available when there is no `.story/` at all.
 */
export function isHealthCheckGloballyDisabled(): boolean {
  try {
    const raw = readBoundedFile(join(storybloqGlobalDir(), "config.json"));
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as { healthCheck?: { enabled?: unknown } };
    return parsed?.healthCheck?.enabled === false;
  } catch {
    return false;
  }
}

/**
 * T-499 global kill switch for the session-intel hooks (intel-start and the
 * UserPromptSubmit sample): ~/.claude/storybloq/config.json
 * { "sessionIntel": { "enabled": false } }. Absence = enabled. Project-level
 * `sessionIntel.enabled` in .story/config.json gates the handlers per project;
 * this one decides whether the hooks are registered at all.
 */
export function isSessionIntelGloballyDisabled(): boolean {
  try {
    const raw = readBoundedFile(join(storybloqGlobalDir(), "config.json"));
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as { sessionIntel?: { enabled?: unknown } };
    return parsed?.sessionIntel?.enabled === false;
  } catch {
    return false;
  }
}
