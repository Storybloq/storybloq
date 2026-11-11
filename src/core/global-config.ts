/**
 * The machine-wide Storybloq state directory and the global kill switches read
 * from its config.json. Moved out of the retired T-424 limit ledger (T-534)
 * unchanged.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readBoundedFile } from "./bounded-read.js";
import { claudeConfigDir } from "./claude-config-dir.js";

/**
 * Established global state dir: STORYBLOQ_GLOBAL_DIR (tests + E2E sims), else ~/.claude/storybloq.
 *
 * ISS-1492: deliberately does NOT follow CLAUDE_CONFIG_DIR, unlike updateCacheDir() below. What lives
 * here is durable (the global config.json kill switches, the T-534 retirement marker and limit ledger,
 * the ISS-1493 ownership cache), so moving it with CLAUDE_CONFIG_DIR would silently strand an existing
 * user's state. It stays at this resolution until a migrated move.
 */
export function storybloqGlobalDir(): string {
  return process.env.STORYBLOQ_GLOBAL_DIR || join(homedir(), ".claude", "storybloq");
}

/**
 * ISS-1492: where the update-check cache lives. STORYBLOQ_GLOBAL_DIR when set and non-empty, else
 * <Claude config dir>/storybloq, which is CLAUDE_CONFIG_DIR/storybloq when that is set and non-empty and
 * ~/.claude/storybloq otherwise (the old path, so existing users keep their cache). Unlike
 * storybloqGlobalDir() it follows Claude's config dir, as the hook reconcile in the same housekeeping
 * does: the cache is recomputable (one registry request), so following the config dir loses nothing.
 */
export function updateCacheDir(): string {
  return process.env.STORYBLOQ_GLOBAL_DIR || join(claudeConfigDir(), "storybloq");
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
