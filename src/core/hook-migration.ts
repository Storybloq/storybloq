/**
 * Hook migration primitives shared by `storybloq setup-skill` and the
 * skill-version-marker auto-refresh path. Lives in `core/` so that
 * `core/skill-version-marker.ts` can import it without crossing into
 * `cli/commands/` (setup-skill calls these too).
 *
 * Two entry points:
 *   - migrateLegacyHookVariants: sweeps one hook type, replacing stale
 *     legacy-basename entries that are NOT equal to a freshly-formatted
 *     canonical command.
 *   - sweepLegacyHooks: batches migrateLegacyHookVariants across all
 *     three hook types for a single storybloq bin.
 *
 * Legacy-basename handling: ISS-589 extended the accepted basename set
 * to include `claudestory` (the pre-rename binary from the deprecated
 * @anthropologies/claudestory package). The migration removes any hook
 * entry whose executable basename matches a known storybloq-lineage
 * name AND whose argument tail matches a known subcommand, unless the
 * command string already equals the freshly-formatted canonical.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

function defaultSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

// ---------------------------------------------------------------------------
// Subcommand constants (ISS-032: hook-driven compaction)
// ---------------------------------------------------------------------------

export const PRECOMPACT_SUBCOMMAND = "session compact-prepare";
export const SESSIONSTART_SUBCOMMAND = "session resume-prompt";
export const STOP_SUBCOMMAND = "hook-status";

// ---------------------------------------------------------------------------
// Legacy-basename set (ISS-589)
// ---------------------------------------------------------------------------

/**
 * Executable basenames whose hook entries are considered ours for the
 * purpose of migration. Any stale entry whose basename is NOT in this
 * set is left alone (it belongs to another tool or the user).
 *
 * `claudestory` is the pre-rename binary name; it stays in this set
 * indefinitely so that the self-heal sweep can clean up orphaned hooks
 * from users who migrated from @anthropologies/claudestory.
 */
export const STORYBLOQ_LEGACY_BASENAMES: ReadonlySet<string> = new Set([
  "storybloq",
  "claudestory",
]);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface HookEntry {
  type: string;
  command?: string;
  [key: string]: unknown;
}

export interface MatcherGroup {
  matcher?: string;
  hooks?: unknown[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Hook command formatting and parsing
// ---------------------------------------------------------------------------

/**
 * Formats a hook command string as `<quotedBin> <subcommand>`.
 *
 * POSIX: single-quote-wraps binPath when it contains a space, tab, or
 * shell metachar, escaping inner `'` as `'\''`; returns as-is otherwise
 * for readability.
 *
 * Windows: always double-quote-wraps binPath and escapes embedded `"`
 * as `""`. Inside cmd.exe double quotes, `&|<>()^!` are not interpreted
 * as operators, so unconditional quoting covers every metachar without
 * a separate detection heuristic.
 */
export function formatHookCommand(binPath: string, subcommand: string): string {
  if (process.platform === "win32") {
    const escaped = binPath.replace(/"/g, '""');
    return `"${escaped}" ${subcommand}`;
  }
  const posixUnsafe = /[\s$`"'\\|&;<>()*?[\]{}~#!]/;
  if (!posixUnsafe.test(binPath)) {
    return `${binPath} ${subcommand}`;
  }
  const escaped = binPath.replace(/'/g, "'\\''");
  return `'${escaped}' ${subcommand}`;
}

/**
 * Parses the executable token from a hook command string.
 *
 * Returns the basename (without `.exe`/`.cmd`/`.bat` on Windows) and
 * the remaining argument text after the token, or `null` if parsing
 * fails. Shell-metachar tokens are rejected so the migration never
 * touches a command line that could be a wrapper script or inline
 * shell.
 */
export function parseHookCommand(command: string): { binBasename: string; rest: string } | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  let token: string;
  let rest: string;
  if (trimmed.startsWith("'")) {
    // POSIX single-quoted with optional '\'' escape sequence (matching
    // formatHookCommand's output for bin paths containing an apostrophe).
    // Walk the string, accumulating unescaped chars; a bare "'" closes
    // the token unless it is the start of the three-char escape `'\''`
    // which represents a literal single quote.
    let i = 1;
    let buf = "";
    while (i < trimmed.length) {
      const c = trimmed[i]!;
      if (c === "'") {
        if (trimmed.slice(i, i + 4) === "'\\''") {
          buf += "'";
          i += 4;
          continue;
        }
        // Unescaped closing quote.
        token = buf;
        rest = trimmed.slice(i + 1);
        if (/[|&;<>`$()]/.test(token)) return null;
        let baseEnd = basename(token);
        if (process.platform === "win32") {
          baseEnd = baseEnd.replace(/\.(exe|cmd|bat|com)$/i, "");
        }
        return { binBasename: baseEnd, rest: rest.trim() };
      }
      buf += c;
      i += 1;
    }
    return null; // unterminated quote
  } else if (trimmed.startsWith('"')) {
    // Windows / double-quoted: formatHookCommand escapes embedded `"` as
    // `""` on Windows; match that reverse here.
    let i = 1;
    let buf = "";
    while (i < trimmed.length) {
      const c = trimmed[i]!;
      if (c === '"') {
        if (trimmed[i + 1] === '"') {
          buf += '"';
          i += 2;
          continue;
        }
        token = buf;
        rest = trimmed.slice(i + 1);
        if (/[|&;<>`$()]/.test(token)) return null;
        let baseEnd = basename(token);
        if (process.platform === "win32") {
          baseEnd = baseEnd.replace(/\.(exe|cmd|bat|com)$/i, "");
        }
        return { binBasename: baseEnd, rest: rest.trim() };
      }
      buf += c;
      i += 1;
    }
    return null;
  } else {
    const space = trimmed.search(/\s/);
    if (space < 0) { token = trimmed; rest = ""; }
    else { token = trimmed.slice(0, space); rest = trimmed.slice(space); }
  }
  if (/[|&;<>`$()]/.test(token)) return null;
  let base = basename(token);
  if (process.platform === "win32") {
    base = base.replace(/\.(exe|cmd|bat|com)$/i, "");
  }
  return { binBasename: base, rest: rest.trim() };
}

// ---------------------------------------------------------------------------
// Migration primitives
// ---------------------------------------------------------------------------

/**
 * Removes hook entries whose executable basename is in
 * STORYBLOQ_LEGACY_BASENAMES and whose argument tail matches
 * `subcommand` exactly, unless they equal the freshly-generated
 * `newCommand` (exact matches stay for idempotency).
 *
 * Leaves unrelated user hooks alone: other tools, extra flags,
 * wrappers with shell metachars, unparseable strings.
 *
 * Safe on missing files, malformed JSON, wrong types: returns 0
 * without mutation in those cases.
 */
export async function migrateLegacyHookVariants(
  hookType: string,
  subcommand: string,
  newCommand: string,
  settingsPath?: string,
): Promise<number> {
  const path = settingsPath ?? defaultSettingsPath();
  if (!existsSync(path)) return 0;

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return 0;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return 0;
  } catch {
    return 0;
  }

  if (!("hooks" in settings) || typeof settings.hooks !== "object" || settings.hooks === null) return 0;
  const hooks = settings.hooks as Record<string, unknown>;
  if (!(hookType in hooks) || !Array.isArray(hooks[hookType])) return 0;

  const hookArray = hooks[hookType] as unknown[];
  let removedCount = 0;

  for (const group of hookArray) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (!Array.isArray(g.hooks)) continue;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((entry) => {
      if (typeof entry !== "object" || entry === null) return true;
      const e = entry as HookEntry;
      if (e.type !== "command" || typeof e.command !== "string") return true;
      const cmd = e.command.trim();
      if (cmd === newCommand.trim()) return true;
      const parsed = parseHookCommand(cmd);
      if (parsed === null) return true;
      if (!STORYBLOQ_LEGACY_BASENAMES.has(parsed.binBasename)) return true;
      if (parsed.rest !== subcommand) return true;
      return false;
    });
    removedCount += before - g.hooks.length;
  }

  if (removedCount === 0) return 0;

  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await rename(tmpPath, path);
  } catch {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    return 0;
  }

  return removedCount;
}

/**
 * Sweeps all three hook types (PreCompact, SessionStart, Stop) for
 * legacy-basename entries that should be replaced by the current
 * canonical commands. Returns the total migrations performed across
 * all three.
 *
 * Called from both setup-skill (explicit `storybloq setup-skill`) and
 * from the skill-version-marker self-heal path on every stale-marker
 * refresh. Idempotent: a second invocation on already-clean settings
 * returns 0 without writing.
 */
export interface LegacyHookCounts {
  PreCompact: number;
  SessionStart: number;
  Stop: number;
}

/**
 * Non-mutating equivalent of sweepLegacyHooks: returns per-hook-type
 * counts of legacy entries the sweep WOULD remove, without touching
 * settings.json.
 *
 * Used by the self-heal path to decide:
 *   (a) whether any migration work is needed at all (sum > 0),
 *   (b) WHICH hook types need canonical registration (per-type > 0).
 *
 * Only registering hook types that had legacy entries preserves the
 * user's intent when they have removed or disabled some hook types.
 */
export async function countLegacyHooks(
  binPath: string,
  settingsPath?: string,
): Promise<LegacyHookCounts> {
  const zero: LegacyHookCounts = { PreCompact: 0, SessionStart: 0, Stop: 0 };
  const path = settingsPath ?? defaultSettingsPath();
  if (!existsSync(path)) return zero;

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return zero;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return zero;
  } catch {
    return zero;
  }

  if (!("hooks" in settings) || typeof settings.hooks !== "object" || settings.hooks === null) return zero;
  const hooks = settings.hooks as Record<string, unknown>;

  const pairs: Array<[keyof LegacyHookCounts, string]> = [
    ["PreCompact", PRECOMPACT_SUBCOMMAND],
    ["SessionStart", SESSIONSTART_SUBCOMMAND],
    ["Stop", STOP_SUBCOMMAND],
  ];

  const counts: LegacyHookCounts = { PreCompact: 0, SessionStart: 0, Stop: 0 };
  for (const [hookType, subcommand] of pairs) {
    if (!(hookType in hooks) || !Array.isArray(hooks[hookType])) continue;
    const newCommand = formatHookCommand(binPath, subcommand).trim();
    const hookArray = hooks[hookType] as unknown[];
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      for (const entry of g.hooks) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as HookEntry;
        if (e.type !== "command" || typeof e.command !== "string") continue;
        const cmd = e.command.trim();
        if (cmd === newCommand) continue;
        const parsed = parseHookCommand(cmd);
        if (parsed === null) continue;
        if (!STORYBLOQ_LEGACY_BASENAMES.has(parsed.binBasename)) continue;
        if (parsed.rest !== subcommand) continue;
        counts[hookType] += 1;
      }
    }
  }
  return counts;
}

export async function sweepLegacyHooks(
  binPath: string,
  settingsPath?: string,
): Promise<number> {
  const path = settingsPath ?? defaultSettingsPath();
  const precompact = formatHookCommand(binPath, PRECOMPACT_SUBCOMMAND);
  const sessionStart = formatHookCommand(binPath, SESSIONSTART_SUBCOMMAND);
  const stop = formatHookCommand(binPath, STOP_SUBCOMMAND);

  let total = 0;
  const pairs: Array<[string, string, string]> = [
    ["PreCompact", PRECOMPACT_SUBCOMMAND, precompact],
    ["SessionStart", SESSIONSTART_SUBCOMMAND, sessionStart],
    ["Stop", STOP_SUBCOMMAND, stop],
  ];
  for (const [hookType, subcommand, newCommand] of pairs) {
    try {
      total += await migrateLegacyHookVariants(hookType, subcommand, newCommand, path);
    } catch {
      // One hook type being malformed should not abort the rest of the sweep.
    }
  }
  return total;
}
