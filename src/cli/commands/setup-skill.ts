import { mkdir, writeFile, readFile, readdir, copyFile, rm, rename, lstat } from "node:fs/promises";
import { existsSync, accessSync, readdirSync, realpathSync, constants as fsConstants } from "node:fs";
import { join, dirname, basename, delimiter as pathDelimiter, win32 as winPath, posix as posixPath } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertNoSelfOverlap, atomicWriteFollowingSymlink, resolveSymlinkTarget } from "../../core/symlink-write.js";
import { withSettingsWriteLock } from "../../core/settings-write-lock.js";
import { resolveBundledBridge, type BundledBridge } from "../../core/bridge-resolve.js";
import { cmdExpands, shellArg, winShellArgv } from "../../core/shell-arg.js";
import { readFileThreeValued } from "../../core/health/deps.js";
import { CLAUDE_JSON_MAX_BYTES } from "../../core/health/codex-bridge.js";
import { readJsonObject } from "../../core/health/types.js";
import {
  coverageCovers,
  coverageOverlaps,
  dedupeHookRows,
  hookRowKey,
  matcherCoverage,
  reconcileDuplicateHookRows,
  type GlobalCommandFor,
} from "../../core/hook-duplicates.js";

import {
  PRECOMPACT_SUBCOMMAND,
  SESSIONSTART_SUBCOMMAND,
  STOP_SUBCOMMAND,
  INTELSTART_SUBCOMMAND,
  INTELPROMPT_SUBCOMMAND,
  SESSION_INTEL_SESSIONSTART_MATCHER,
  INTELSTART_HOOK_TIMEOUT_SECONDS,
  INTELPROMPT_HOOK_TIMEOUT_SECONDS,
  PRESENCE_BIN_NAME,
  PRESENCE_SUBCOMMAND,
  PRESENCE_HOOK_TIMEOUT_SECONDS,
  PRESENCE_HOOK_TYPES,
  STORYBLOQ_LEGACY_BASENAMES,
  formatHookCommand,
  migrateLegacyHookVariants,
  parseHookCommand,
  sweepLegacyHooks,
  type HookEntry,
  type MatcherGroup,
} from "../../core/hook-migration.js";

// Re-exported for external callers and test imports that still reach for
// these symbols through setup-skill.
export {
  PRECOMPACT_SUBCOMMAND,
  SESSIONSTART_SUBCOMMAND,
  STOP_SUBCOMMAND,
  PRESENCE_BIN_NAME,
  PRESENCE_SUBCOMMAND,
  PRESENCE_HOOK_TIMEOUT_SECONDS,
  PRESENCE_HOOK_TYPES,
  STORYBLOQ_LEGACY_BASENAMES,
  formatHookCommand,
  migrateLegacyHookVariants,
  parseHookCommand,
  sweepLegacyHooks,
};
export type { HookEntry, MatcherGroup };

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

/**
 * ISS-1235: said once at the end of setup, and never measured. Where the pane
 * sits is the client renderer's call (ISS-1247: docked under the fullscreen
 * renderer, inline above the prompt on the main screen), and the client
 * places a plugin's own open only from 144 columns, which the person's first
 * prompt lifts (ISS-1251). `process.stdout.columns` here is the shell setup
 * ran in, not the window claude will run in, and the version-marker refresh
 * runs setup with stdout piped, so a measured verdict would be wrong as often
 * as right.
 */
export const MODS_WIDTH_NOTE =
  "The Storybloq board docks beside the transcript under Claude Code's fullscreen renderer (/tui fullscreen) and sits above the prompt otherwise; a session started narrower than 144 columns shows a one-line summary until your first prompt.";

/**
 * Resolves the directory containing bundled skill files.
 * Probes both layouts:
 *   - Bundled (npm): dist/cli.js → ../src/skill/
 *   - Source (dev):  src/cli/commands/setup-skill.ts → ../../../src/skill/
 */
export function resolveSkillSourceDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));

  // Bundled layout: thisDir = <pkg>/dist, skill at <pkg>/src/skill
  const bundledPath = join(thisDir, "..", "src", "skill");
  if (existsSync(join(bundledPath, "SKILL.md"))) return bundledPath;

  // Source layout: thisDir = <pkg>/src/cli/commands, skill at <pkg>/src/skill
  const sourcePath = join(thisDir, "..", "..", "skill");
  if (existsSync(join(sourcePath, "SKILL.md"))) return sourcePath;

  throw new Error(
    `Cannot find bundled skill files. Checked:\n  ${bundledPath}\n  ${sourcePath}`,
  );
}

/**
 * Test-only injection seam for the copyDirRecursive swap rollback. Production
 * callers never pass this; it exists so the rename-failure rollback path can be
 * exercised deterministically (a flaky read-only-dir test would not reliably
 * hit the inner swap).
 */
export interface CopyDirTestHooks {
  /** Invoked inside the try, immediately before the tmpDir -> targetDir swap rename. */
  beforeSwapRename?: () => void | Promise<void>;
}

/**
 * Recursively copies a directory tree from src to dest.
 * Copies to a temp dir first, then atomically swaps to avoid partial installs.
 * Uses withFileTypes to skip directories (cross-platform) and copyFile (binary-safe).
 *
 * Issue #12: if destDir is a symlinked directory (e.g. a stow/chezmoi-managed
 * ~/.claude/skills/story), the swap operates on the link's REAL target so the
 * symlink is preserved rather than replaced by a standalone directory. existsSync
 * follows symlinks and cannot detect one, so we lstat first.
 */
export async function copyDirRecursive(srcDir: string, destDir: string): Promise<string[]> {
  return runCopyDir(srcDir, destDir);
}

/** Test-only entry point that threads rollback hooks into the private swap. */
export async function __copyDirRecursiveForTest(
  srcDir: string,
  destDir: string,
  testHooks?: CopyDirTestHooks,
): Promise<string[]> {
  return runCopyDir(srcDir, destDir, testHooks);
}

async function runCopyDir(srcDir: string, destDir: string, testHooks?: CopyDirTestHooks): Promise<string[]> {
  let st = null;
  try {
    st = await lstat(destDir);
  } catch (e) {
    // ENOENT: destDir does not exist yet -> swap the literal path. Any other
    // error leaves symlink-ness unknown, so rethrow rather than risk clobbering.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  let targetDir = destDir;
  if (st?.isSymbolicLink()) {
    targetDir = await resolveSymlinkTarget(destDir);
    // Refuse to convert a symlink-to-an-existing-non-directory into a real dir.
    // A missing target (dangling dir symlink) is allowed -- the swap creates it.
    let resolvedStat = null;
    try {
      resolvedStat = await lstat(targetDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (resolvedStat && !resolvedStat.isDirectory()) {
      throw new Error(`refusing to replace non-directory symlink target: ${targetDir}`);
    }
  }

  await assertNoSelfOverlap(srcDir, destDir, targetDir);
  return copyDirSwap(srcDir, targetDir, testHooks);
}

async function copyDirSwap(srcDir: string, targetDir: string, testHooks?: CopyDirTestHooks): Promise<string[]> {
  const tmpDir = targetDir + ".tmp";
  const bakDir = targetDir + ".bak";
  // Recover from a previous crash: if targetDir is gone but bakDir exists, restore it
  if (!existsSync(targetDir) && existsSync(bakDir)) {
    await rename(bakDir, targetDir);
  }
  // Clean up any leftover temp/backup dirs
  if (existsSync(tmpDir)) await rm(tmpDir, { recursive: true, force: true });
  if (existsSync(bakDir)) await rm(bakDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true, recursive: true });
  const written: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // parentPath (Node 20.12+) or path (Node 20.1-20.11) contains the parent directory
    const parent = (entry as { parentPath?: string; path?: string }).parentPath
      ?? (entry as { path?: string }).path ?? srcDir;
    const relativePath = join(parent, entry.name).slice(srcDir.length + 1);
    const srcPath = join(srcDir, relativePath);
    const destPath = join(tmpDir, relativePath);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    written.push(relativePath);
  }
  // Safe swap: back up old, rename new in, clean up backup
  if (existsSync(targetDir)) {
    await rename(targetDir, bakDir);
  }
  try {
    if (testHooks?.beforeSwapRename) await testHooks.beforeSwapRename();
    await rename(tmpDir, targetDir);
  } catch (err) {
    // Restore backup if rename fails
    if (existsSync(bakDir)) await rename(bakDir, targetDir).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await rm(bakDir, { recursive: true, force: true }).catch(() => {});
  return written;
}

// ---------------------------------------------------------------------------
// Hook registration (ISS-032: hook-driven compaction)
// ---------------------------------------------------------------------------
//
// Subcommand constants, STORYBLOQ_LEGACY_BASENAMES, formatHookCommand,
// parseHookCommand, migrateLegacyHookVariants, and sweepLegacyHooks
// live in `../../core/hook-migration.ts` and are re-exported above.
//
// Kept here: registerHook and its three hook-type wrappers, removeHook,
// the legacy snapshot-command literal, and the binary resolver.

const LEGACY_PRECOMPACT_HOOK_COMMAND = "storybloq snapshot --quiet";

// ---------------------------------------------------------------------------
// Storybloq binary resolution (ISS-560)
// ---------------------------------------------------------------------------

/**
 * Resolves `storybloq` to an absolute filesystem path.
 *
 * Walks `process.env.PATH` first (respecting PATHEXT on Windows), then falls
 * back to a platform-scoped candidate list covering nvm/fnm/volta/asdf and
 * common npm global bin locations. Returns `null` if no executable is found.
 *
 * Hooks registered by setup-skill bake the returned path into the command
 * string so that mid-session `nvm use` / `fnm use` / `asdf shell` switches
 * do not strip the command from the active PATH.
 */
export function resolveStorybloqBin(): string | null {
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, "storybloq" + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  for (const candidate of candidatePaths()) {
    if (isExecutableFile(candidate)) return candidate;
  }

  return null;
}

/**
 * Resolves the `storybloq-presence` bin (ISS-1022).
 *
 * Looks beside the resolved `storybloq` bin first, because npm installs both
 * bins of the same package into the same directory, and that sibling is the
 * one guaranteed to be the SAME version as the CLI that is registering the
 * hook. Only then falls back to a PATH walk, which could otherwise pick up a
 * presence bin from a different install.
 */
export function resolvePresenceBin(storybloqBin?: string | null): string | null {
  const isWindows = process.platform === "win32";
  const exts = isWindows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];

  const sibling = storybloqBin ?? resolveStorybloqBin();
  if (sibling) {
    for (const ext of exts) {
      const candidate = join(dirname(sibling), PRESENCE_BIN_NAME + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, PRESENCE_BIN_NAME + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }

  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * ISS-1222: the global storybloq launcher, established two ways that must
 * agree. `npm root -g` names the global package root, so the launcher npm
 * exposes is `<prefix>/bin/storybloq` (`<prefix>/storybloq.cmd` on Windows);
 * the PATH walk is what `which storybloq` answers. The launcher is accepted
 * only when both resolve to the same real file. Under npx the PATH walk finds
 * the cache copy, the two disagree, and the answer is null: a process that
 * cannot prove which launcher is global never rewrites a hook row.
 */
export interface GlobalLauncherProbe {
  readonly run: (cmd: string, args: readonly string[], timeoutMs: number) => string | null;
  readonly pathWalk: () => string | null;
  readonly realpath: (path: string) => string | null;
  readonly isExecutable: (path: string) => boolean;
  readonly platform: string;
}

export const GLOBAL_LAUNCHER_PROBE_TIMEOUT_MS = 3000;

function runNpmRootG(cmd: string, args: readonly string[], timeoutMs: number): string | null {
  try {
    return execFileSync(cmd, [...args], { stdio: "pipe", timeout: timeoutMs, encoding: "utf-8", shell: process.platform === "win32" });
  } catch {
    return null;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function resolveGlobalStorybloqBin(probe: Partial<GlobalLauncherProbe> = {}): string | null {
  const platform = probe.platform ?? process.platform;
  const run = probe.run ?? runNpmRootG;
  const pathWalk = probe.pathWalk ?? resolveStorybloqBin;
  const realpath = probe.realpath ?? realpathOrNull;
  const isExecutable = probe.isExecutable ?? isExecutableFile;
  const out = run(platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], GLOBAL_LAUNCHER_PROBE_TIMEOUT_MS);
  if (out === null) return null;
  const root = out.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (root.length === 0) return null;
  const launcher = platform === "win32"
    ? winPath.join(winPath.dirname(root), "storybloq.cmd")
    : posixPath.join(posixPath.dirname(posixPath.dirname(root)), "bin", "storybloq");
  if (!isExecutable(launcher)) return null;
  const walked = pathWalk();
  if (walked === null) return null;
  const a = realpath(launcher);
  const b = realpath(walked);
  if (a === null || b === null) return null;
  // Windows realpaths keep whatever drive-letter case each caller used.
  const same = platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same) return null;
  return launcher;
}

/**
 * Test seam and per-process memo for the validated global launcher. The
 * probe spawns npm, so it runs at most once per process and only when a
 * caller actually meets a collision.
 */
export const globalLauncher: { override: GlobalCommandFor | null; memo: { value: string | null } | null } = { override: null, memo: null };

export function globalHookCommandFor(): GlobalCommandFor {
  return (rest) => {
    if (globalLauncher.override) return globalLauncher.override(rest);
    if (globalLauncher.memo === null) globalLauncher.memo = { value: resolveGlobalStorybloqBin() };
    const bin = globalLauncher.memo.value;
    return bin === null ? null : formatHookCommand(bin, rest);
  };
}

function candidatePaths(): string[] {
  const home = homedir();
  const list: string[] = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    for (const ext of [".cmd", ".exe", ".bat", ""]) {
      list.push(join(appData, "npm", "storybloq" + ext));
    }
    const fnmMultishells = join(localAppData, "fnm_multishells");
    try {
      for (const shell of readdirSync(fnmMultishells).sort().reverse()) {
        for (const ext of [".cmd", ".exe", ".bat", ""]) {
          list.push(join(fnmMultishells, shell, "storybloq" + ext));
        }
      }
    } catch { /* dir missing */ }
    return list;
  }

  list.push(
    join(home, ".local", "bin", "storybloq"),
    "/usr/local/bin/storybloq",
    "/opt/homebrew/bin/storybloq",
    join(home, ".npm-global", "bin", "storybloq"),
  );

  const nvmVersions = join(home, ".nvm", "versions", "node");
  try {
    for (const v of readdirSync(nvmVersions).sort().reverse()) {
      list.push(join(nvmVersions, v, "bin", "storybloq"));
    }
  } catch { /* dir missing */ }

  const fnmDirs = process.platform === "darwin"
    ? [join(home, "Library", "Application Support", "fnm", "node-versions")]
    : [
      join(home, ".local", "share", "fnm", "node-versions"),
      join(home, "Library", "Application Support", "fnm", "node-versions"),
    ];
  for (const fnmDir of fnmDirs) {
    try {
      for (const v of readdirSync(fnmDir).sort().reverse()) {
        list.push(join(fnmDir, v, "installation", "bin", "storybloq"));
      }
    } catch { /* dir missing */ }
  }

  list.push(
    join(home, ".volta", "bin", "storybloq"),
    join(home, ".asdf", "shims", "storybloq"),
  );
  return list;
}

/**
 * Check if a hook entry matches a given command.
 */
function isHookWithCommand(entry: unknown, command: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as HookEntry;
  return e.type === "command" && typeof e.command === "string" && e.command.trim() === command;
}

/**
 * Registers a hook in ~/.claude/settings.json (or custom path).
 *
 * - Idempotent: skips if already present
 * - Non-destructive: leaves file untouched on parse/type errors
 * - Atomic: writes to temp file, then renames
 */
async function registerHook(
  hookType: string,
  hookEntry: HookEntry,
  settingsPath?: string,
  matcher?: string,
  opts?: RegisterHookOptions,
): Promise<"registered" | "exists" | "skipped"> {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  return withSettingsWriteLock(path, "skipped", () => registerHookLocked(hookType, hookEntry, path, matcher, opts));
}

interface RegisterHookOptions {
  /**
   * T-424: scope the exists-check to the target matcher group. Needed when
   * the SAME command is deliberately registered under two matcher groups
   * (session resume-prompt under "compact" and "resume").
   */
  scopeIdempotencyToMatcher?: boolean;
  /** ISS-1222 test seam: the validated global launcher's command for a subcommand. */
  globalCommandFor?: GlobalCommandFor;
}

async function registerHookLocked(
  hookType: string,
  hookEntry: HookEntry,
  path: string,
  matcher?: string,
  opts?: RegisterHookOptions,
): Promise<"registered" | "exists" | "skipped"> {
  // Read existing settings
  let raw = "{}";
  if (existsSync(path)) {
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      process.stderr.write(`Could not read ${path} -- skipping hook registration.\n`);
      return "skipped";
    }
  }

  // Parse
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      process.stderr.write(`${path} is not a JSON object -- skipping hook registration.\n`);
      return "skipped";
    }
  } catch {
    process.stderr.write(`${path} contains invalid JSON -- skipping hook registration.\n`);
    process.stderr.write("  Fix the file manually or delete it to reset.\n");
    return "skipped";
  }

  // Type guard: hooks must be object
  if ("hooks" in settings) {
    if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
      process.stderr.write(`${path} has unexpected hooks format -- skipping hook registration.\n`);
      return "skipped";
    }
  } else {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown>;

  // Type guard: hook type must be array
  if (hookType in hooks) {
    if (!Array.isArray(hooks[hookType])) {
      process.stderr.write(`${path} has unexpected hooks.${hookType} format -- skipping hook registration.\n`);
      return "skipped";
    }
  } else {
    hooks[hookType] = [];
  }

  const hookArray = hooks[hookType] as unknown[];
  const targetMatcher = matcher ?? "";

  // Idempotency: scan for existing command (defensive -- skip malformed entries)
  const hookCommand = hookEntry.command;
  const key = hookCommand ? hookRowKey(hookCommand) : null;
  // ISS-1222: an owned command is identified by its semantic key (basename
  // plus subcommand) and by whether an existing row's matcher COVERS the
  // target's sources, never by the exact path. Rows of other tools (a null
  // key) keep the exact-string rule.
  let rewriteInPlace: HookEntry | null = null;
  let overlapsTarget = false;
  if (hookCommand && key === null) {
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      if (opts?.scopeIdempotencyToMatcher && (g.matcher ?? "") !== targetMatcher) continue;
      for (const entry of g.hooks) {
        if (isHookWithCommand(entry, hookCommand)) return "exists";
      }
    }
  } else if (hookCommand && key !== null) {
    const target = matcherCoverage(targetMatcher);
    const candidate = hookCommand.trim();
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      if (opts?.scopeIdempotencyToMatcher && (g.matcher ?? "") !== targetMatcher) continue;
      const cov = matcherCoverage(typeof g.matcher === "string" ? g.matcher : "");
      for (const entry of g.hooks) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as HookEntry;
        if (e.type !== "command" || typeof e.command !== "string") continue;
        const k = hookRowKey(e.command);
        if (k === null || k.key !== key.key) continue;
        // A legacy basename (claudestory) is a row for the migration sweep to
        // replace, not an installation of this hook: it never blocks the
        // canonical row, or a user would be left with no hook at all.
        if (k.binBasename !== key.binBasename) continue;
        if (coverageCovers(cov, target)) {
          if (e.command.trim() === candidate) return "exists";
          if (rewriteInPlace === null) rewriteInPlace = e;
        } else if (coverageOverlaps(cov, target)) {
          overlapsTarget = true;
        }
      }
    }
    if (rewriteInPlace !== null || overlapsTarget) {
      // Only the validated global launcher may replace or collapse rows; any
      // other binary (an npx copy, an old install) adds nothing beside them.
      const globalFor = opts?.globalCommandFor ?? globalHookCommandFor();
      if (globalFor(key.rest)?.trim() !== candidate) return "exists";
      if (rewriteInPlace !== null) rewriteInPlace.command = hookCommand;
    }
  }

  if (rewriteInPlace === null) {
    // Find existing matcher group with valid hooks array, or create one
    let appended = false;
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if ((g.matcher ?? "") === targetMatcher && Array.isArray(g.hooks)) {
        g.hooks.push(hookEntry);
        appended = true;
        break;
      }
    }

    if (!appended) {
      hookArray.push({ matcher: targetMatcher, hooks: [hookEntry] });
    }
  }
  if (key !== null && (rewriteInPlace !== null || overlapsTarget)) {
    // ISS-1222: the write above may have left same-key rows beside the global
    // one (two stale variants, a partial-overlap group); collapse this event
    // to exactly one row per collision before the file is written.
    dedupeHookRows({ hooks: { [hookType]: hookArray } }, opts?.globalCommandFor ?? globalHookCommandFor());
  }

  // Atomic write that follows a symlinked settings.json (issue #12)
  try {
    await atomicWriteFollowingSymlink(path, JSON.stringify(settings, null, 2) + "\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to write settings.json: ${message}\n`);
    return "skipped";
  }

  return "registered";
}

/**
 * Registers the PreCompact hook (session compact preparation).
 * ISS-032: changed from "snapshot --quiet" to "session-compact-prepare".
 * ISS-560: accepts explicit `binPath` so hooks survive nvm/fnm Node switches.
 */
export async function registerPreCompactHook(
  settingsPath?: string,
  binPath?: string,
): Promise<"registered" | "exists" | "skipped"> {
  const bin = binPath ?? resolveStorybloqBin() ?? "storybloq";
  const command = formatHookCommand(bin, PRECOMPACT_SUBCOMMAND);
  return registerHook("PreCompact", { type: "command", command }, settingsPath);
}

/**
 * Registers the SessionStart hook (resume prompt after compaction).
 * ISS-032: matcher "compact" matches source: "compact" in SessionStart hook input.
 */
export async function registerSessionStartHook(
  settingsPath?: string,
  binPath?: string,
): Promise<"registered" | "exists" | "skipped"> {
  const bin = binPath ?? resolveStorybloqBin() ?? "storybloq";
  const command = formatHookCommand(bin, SESSIONSTART_SUBCOMMAND);
  return registerHook("SessionStart", { type: "command", command }, settingsPath, "compact");
}

/**
 * Registers the Stop hook (status.json writer after every Claude response).
 */
export async function registerStopHook(
  settingsPath?: string,
  binPath?: string,
): Promise<"registered" | "exists" | "skipped"> {
  const bin = binPath ?? resolveStorybloqBin() ?? "storybloq";
  const command = formatHookCommand(bin, STOP_SUBCOMMAND);
  return registerHook("Stop", { type: "command", command, async: true }, settingsPath);
}

/**
 * Registers the five session-presence hooks (ISS-1022).
 *
 * All five are SYNCHRONOUS. `async: true` would hand ordering to whichever
 * process happened to finish first, and there is nothing in a hook payload a
 * record could use to reconstruct the true order afterwards -- so Claude Code's
 * own event sequencing is the only sound source, and running synchronously is
 * how it is inherited. Each carries an explicit 5s timeout because the client
 * default is 600s, which on a per-tool-call hook is a ten-minute stall rather
 * than a safety net.
 *
 * Every matcher is empty: presence must see every tool and every SessionStart
 * source, `fork` included.
 *
 * Returns a per-hook-type result map, or null when the presence bin cannot be
 * resolved (an older install, or a PATH the CLI cannot see) -- in which case
 * nothing is registered rather than a command that would fail on every event.
 */
export async function registerPresenceHooks(
  settingsPath?: string,
  binPath?: string | null,
): Promise<Record<string, "registered" | "exists" | "skipped"> | null> {
  // An explicitly-passed null means the CALLER already tried to resolve and
  // failed. Falling back to a second resolution attempt there would register a
  // bin the caller deliberately rejected; only an omitted argument resolves.
  const bin = binPath === undefined ? resolvePresenceBin() : binPath;
  if (!bin) return null;
  const command = formatHookCommand(bin, PRESENCE_SUBCOMMAND);
  const results: Record<string, "registered" | "exists" | "skipped"> = {};
  for (const hookType of PRESENCE_HOOK_TYPES) {
    results[hookType] = await registerHook(
      hookType,
      { type: "command", command, timeout: PRESENCE_HOOK_TIMEOUT_SECONDS },
      settingsPath,
    );
  }
  return results;
}

/** Removes every presence hook registration (ISS-1022 opt-out / uninstall). */
export async function removePresenceHooks(
  settingsPath?: string,
  binPath?: string | null,
): Promise<void> {
  const bin = binPath === undefined ? resolvePresenceBin() : binPath;
  if (!bin) return;
  const command = formatHookCommand(bin, PRESENCE_SUBCOMMAND);
  for (const hookType of PRESENCE_HOOK_TYPES) {
    await removeHook(hookType, command, settingsPath);
  }
}

// ---------------------------------------------------------------------------
// Matcher coverage
// ---------------------------------------------------------------------------

/** Does a SessionStart matcher (a source regex) already cover `source`? Empty matcher matches everything. */
function matcherCoversSource(matcher: string | undefined, source: string): boolean {
  const m = matcher ?? "";
  if (m === "") return true;
  try {
    return new RegExp(`^(?:${m})$`).test(source);
  } catch {
    // A matcher we cannot compile cannot be PROVEN to cover `source`. Treat it
    // as non-covering so a valid hook is still installed -- a `|`-split
    // fallback would read `resume|[` as covering `resume` and suppress
    // installation of a working hook. A redundant entry is harmless; a
    // silently-missing one is not.
    return false;
  }
}

// ---------------------------------------------------------------------------
// T-499: session-intel hooks (SessionStart intel-start + UserPromptSubmit intel-prompt)
// ---------------------------------------------------------------------------

const SESSION_INTEL_SESSIONSTART_SOURCES: readonly string[] = ["startup", "resume", "clear", "compact"];

/**
 * Counts the intel-start entries across ALL SessionStart groups and whether
 * any of them sits in a group whose matcher covers EVERY intel source. The
 * settled state is exactly one entry in a full-coverage group: anything else
 * (a partial matcher, several groups that only collectively cover the
 * sources, a canonical group plus a stray entry, or duplicates within one
 * group) would fire the hook twice for some source, and is normalized.
 */
async function intelStartEntries(command: string, path: string): Promise<{ total: number; inFullCoverageGroup: number }> {
  const none = { total: 0, inFullCoverageGroup: 0 };
  if (!existsSync(path)) return none;
  try {
    const settings = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    const hooks = settings?.hooks as Record<string, unknown> | undefined;
    const hookArray = hooks && Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as unknown[]) : [];
    let total = 0;
    let inFullCoverageGroup = 0;
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      const full = SESSION_INTEL_SESSIONSTART_SOURCES.every((src) => matcherCoversSource(g.matcher, src));
      for (const entry of g.hooks) {
        if (!isHookWithCommand(entry, command)) continue;
        total += 1;
        if (full) inFullCoverageGroup += 1;
      }
    }
    return { total, inFullCoverageGroup };
  } catch {
    // Unreadable settings: registerHook applies its own guards.
    return none;
  }
}

/** SessionStart `intel-start`, every source, synchronous, 5 s. */
export async function registerSessionIntelStartHook(
  settingsPath?: string,
  binPath?: string,
): Promise<"registered" | "exists" | "skipped"> {
  const bin = binPath ?? resolveStorybloqBin() ?? "storybloq";
  const command = formatHookCommand(bin, INTELSTART_SUBCOMMAND);
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  const found = await intelStartEntries(command, path);
  if (found.total === 1 && found.inFullCoverageGroup === 1) return "exists";
  // Normalize: every other arrangement of OUR command (a partial matcher,
  // groups that only collectively cover the sources, a canonical group plus
  // a stray entry, duplicates) fires the hook twice for some source. Strip
  // every entry of our command, then install the one canonical group; other
  // hooks stay where they are.
  if (found.total > 0) {
    const stripped = await removeHook("SessionStart", command, settingsPath);
    if (stripped === "skipped") return "skipped";
  }
  return registerHook(
    "SessionStart",
    { type: "command", command, timeout: INTELSTART_HOOK_TIMEOUT_SECONDS },
    settingsPath,
    SESSION_INTEL_SESSIONSTART_MATCHER,
    { scopeIdempotencyToMatcher: true },
  );
}

/** UserPromptSubmit `intel-prompt`, empty matcher, synchronous, 10 s. */
export async function registerSessionIntelPromptHook(
  settingsPath?: string,
  binPath?: string,
): Promise<"registered" | "exists" | "skipped"> {
  const bin = binPath ?? resolveStorybloqBin() ?? "storybloq";
  const command = formatHookCommand(bin, INTELPROMPT_SUBCOMMAND);
  return registerHook(
    "UserPromptSubmit",
    { type: "command", command, timeout: INTELPROMPT_HOOK_TIMEOUT_SECONDS },
    settingsPath,
  );
}

/**
 * Idempotent reconcile of the session-intel hooks against the global kill
 * switch, in the T-424 shape: un-gated (the count-gated legacy sweep can never
 * install an absent hook type), called from setup-skill, the skill
 * auto-refresh and housekeeping.
 *
 * Enabled  -> ensure both hooks registered.
 * Disabled -> ensure both removed (every other SessionStart group untouched).
 */
export async function ensureSessionIntelHooksRegistered(
  settingsPath?: string,
  binPath?: string,
): Promise<{ changed: boolean; action: "installed" | "removed" | "unchanged" }> {
  const bin = binPath ?? resolveStorybloqBin();
  if (!bin) return { changed: false, action: "unchanged" };

  const { isSessionIntelGloballyDisabled } = await import("../../core/global-config.js");
  if (isSessionIntelGloballyDisabled()) {
    const r1 = await removeHook("SessionStart", formatHookCommand(bin, INTELSTART_SUBCOMMAND), settingsPath);
    const r2 = await removeHook("UserPromptSubmit", formatHookCommand(bin, INTELPROMPT_SUBCOMMAND), settingsPath);
    const changed = r1 === "removed" || r2 === "removed";
    return { changed, action: changed ? "removed" : "unchanged" };
  }

  const r1 = await registerSessionIntelStartHook(settingsPath, bin);
  const r2 = await registerSessionIntelPromptHook(settingsPath, bin);
  const changed = r1 === "registered" || r2 === "registered";
  return { changed, action: changed ? "installed" : "unchanged" };
}

export const CLAUDE_BUS_SESSION_START_MATCHER = "startup|resume|clear|compact";

/**
 * Upgrades the existing Claude hook entries for guarded Bus delivery.
 * The Stop command becomes synchronous and SessionStart runs for every source.
 * Project-local hook policy still decides whether either path emits Bus output.
 */
export async function enableClaudeBusHooks(
  settingsPath?: string,
  binPath?: string,
): Promise<{ changed: boolean; skipped: boolean }> {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  const bin = binPath ?? resolveStorybloqBin();
  if (!bin) return { changed: false, skipped: true };

  const sessionCommand = formatHookCommand(bin, SESSIONSTART_SUBCOMMAND);
  const stopCommand = formatHookCommand(bin, STOP_SUBCOMMAND);
  const sessionRegistered = await registerSessionStartHook(path, bin);
  const stopRegistered = await registerStopHook(path, bin);
  if (sessionRegistered === "skipped" || stopRegistered === "skipped") {
    return { changed: false, skipped: true };
  }
  return withSettingsWriteLock(path, { changed: false, skipped: true }, () =>
    upgradeClaudeBusHookRows(path, sessionCommand, stopCommand));
}

/** The locked half of `enableClaudeBusHooks`: rewrites the rows the registrars just ensured. */
async function upgradeClaudeBusHookRows(
  path: string,
  sessionCommand: string,
  stopCommand: string,
): Promise<{ changed: boolean; skipped: boolean }> {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return { changed: false, skipped: true };
  }
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
    return { changed: false, skipped: true };
  }
  const hooks = settings.hooks as Record<string, unknown>;
  if (!Array.isArray(hooks.SessionStart) || !Array.isArray(hooks.Stop)) {
    return { changed: false, skipped: true };
  }

  let changed = false;
  // ISS-1222: locate our rows by semantic command, not exact path, so a row
  // registered through another launcher path is still the one normalised.
  const sessionKey = hookRowKey(sessionCommand)?.key ?? null;
  const stopKey = hookRowKey(stopCommand)?.key ?? null;
  const isOwnedRow = (entry: unknown, exact: string, key: string | null): boolean => {
    if (isHookWithCommand(entry, exact)) return true;
    if (key === null || typeof entry !== "object" || entry === null) return false;
    const e = entry as HookEntry;
    if (e.type !== "command" || typeof e.command !== "string") return false;
    return hookRowKey(e.command)?.key === key;
  };
  const sessionGroups = hooks.SessionStart as unknown[];
  // ISS-1222 (post-hoc Codex finding): the normalisation below keeps ONE
  // owned row per event and matches rows by semantic key, so a stale
  // launcher row beside the global one must be collapsed to the validated
  // global command FIRST. With no validated launcher the collision is left
  // exactly as it is and the normalisation is skipped, rather than promoting
  // whichever row the scan met last.
  const collisions = dedupeHookRows({ hooks: { SessionStart: sessionGroups } }, globalHookCommandFor());
  if (collisions.unresolved.length > 0) return { changed: false, skipped: true };
  if (collisions.changed) changed = true;
  let sessionEntry: HookEntry | null = null;
  let sessionMatches = 0;
  let canonicalSessionMatches = 0;
  for (let i = sessionGroups.length - 1; i >= 0; i--) {
    const group = sessionGroups[i];
    if (typeof group !== "object" || group === null) continue;
    const matcherGroup = group as MatcherGroup;
    if (!Array.isArray(matcherGroup.hooks)) continue;
    const retained: unknown[] = [];
    for (const entry of matcherGroup.hooks) {
      if (isOwnedRow(entry, sessionCommand, sessionKey)) {
        sessionMatches += 1;
        if ((matcherGroup.matcher ?? "") === CLAUDE_BUS_SESSION_START_MATCHER) {
          canonicalSessionMatches += 1;
        }
        if (!sessionEntry) sessionEntry = entry as HookEntry;
        changed = changed || (matcherGroup.matcher ?? "") !== CLAUDE_BUS_SESSION_START_MATCHER;
      } else {
        retained.push(entry);
      }
    }
    matcherGroup.hooks = retained;
    if (retained.length === 0) sessionGroups.splice(i, 1);
  }
  if (!sessionEntry) return { changed: false, skipped: true };
  const sessionWasCanonical = sessionMatches === 1 && canonicalSessionMatches === 1;
  if (sessionMatches > 1) changed = true;
  let targetGroup = sessionGroups.find((group) =>
    typeof group === "object" && group !== null &&
    ((group as MatcherGroup).matcher ?? "") === CLAUDE_BUS_SESSION_START_MATCHER &&
    Array.isArray((group as MatcherGroup).hooks),
  ) as MatcherGroup | undefined;
  if (!targetGroup) {
    targetGroup = { matcher: CLAUDE_BUS_SESSION_START_MATCHER, hooks: [] };
    sessionGroups.push(targetGroup);
    if (!sessionWasCanonical) changed = true;
  }
  targetGroup.hooks!.push(sessionEntry);

  for (const group of hooks.Stop as unknown[]) {
    if (typeof group !== "object" || group === null) continue;
    const matcherGroup = group as MatcherGroup;
    if (!Array.isArray(matcherGroup.hooks)) continue;
    for (const entry of matcherGroup.hooks) {
      if (!isOwnedRow(entry, stopCommand, stopKey)) continue;
      const hook = entry as HookEntry;
      if ("async" in hook) {
        delete hook.async;
        changed = true;
      }
    }
  }

  if (!changed) return { changed: false, skipped: false };
  try {
    await atomicWriteFollowingSymlink(path, JSON.stringify(settings, null, 2) + "\n");
    return { changed: true, skipped: false };
  } catch {
    return { changed: false, skipped: true };
  }
}

/**
 * D4 read-only Claude base-hook inspector. Verifies ~/.claude/settings.json is
 * readable, well-formed, and already carries the base SessionStart (resume) and
 * Stop (hook-status) Storybloq hooks that `enableClaudeBusHooks` upgrades to
 * guarded live delivery. Never writes. Bus setup calls this in preflight so a
 * live Claude setup cannot mutate Bus state and then fail at hook enablement.
 */
export async function claudeBaseHooksPresent(
  settingsPath: string = join(homedir(), ".claude", "settings.json"),
): Promise<{ ok: boolean; reason?: string }> {
  if (!existsSync(settingsPath)) {
    return { ok: false, reason: `${settingsPath} does not exist` };
  }
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch {
    return { ok: false, reason: `${settingsPath} is not readable` };
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${settingsPath} is not valid JSON` };
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { ok: false, reason: `${settingsPath} is malformed` };
  }
  const hooks = (settings as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return { ok: false, reason: "Claude base hooks are not configured" };
  }
  const hookMap = hooks as Record<string, unknown>;
  const hasBaseHook = (hookType: string, subcommand: string): boolean => {
    const groups = hookMap[hookType];
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      for (const entry of g.hooks) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as HookEntry;
        if (e.type !== "command" || typeof e.command !== "string") continue;
        const parsed = parseHookCommand(e.command);
        if (parsed === null) continue;
        if (!STORYBLOQ_LEGACY_BASENAMES.has(parsed.binBasename)) continue;
        if (parsed.rest === subcommand) return true;
      }
    }
    return false;
  };
  const missing = [
    hasBaseHook("SessionStart", SESSIONSTART_SUBCOMMAND) ? null : "SessionStart",
    hasBaseHook("Stop", STOP_SUBCOMMAND) ? null : "Stop",
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    return { ok: false, reason: `missing base Claude hook(s): ${missing.join(", ")}` };
  }
  return { ok: true };
}

/**
 * Removes a hook command from settings.json. Used for migration (ISS-032).
 */
export async function removeHook(
  hookType: string,
  command: string,
  settingsPath?: string,
): Promise<"removed" | "not_found" | "skipped"> {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  return withSettingsWriteLock(path, "skipped", () => removeHookLocked(hookType, command, path));
}

async function removeHookLocked(
  hookType: string,
  command: string,
  path: string,
): Promise<"removed" | "not_found" | "skipped"> {

  let raw = "{}";
  if (existsSync(path)) {
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return "skipped";
    }
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return "skipped";
  } catch {
    return "skipped";
  }

  if (!("hooks" in settings) || typeof settings.hooks !== "object" || settings.hooks === null) return "not_found";
  const hooks = settings.hooks as Record<string, unknown>;
  if (!(hookType in hooks) || !Array.isArray(hooks[hookType])) return "not_found";

  const hookArray = hooks[hookType] as unknown[];
  let removed = false;

  for (const group of hookArray) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (!Array.isArray(g.hooks)) continue;
    const before = g.hooks.length;
    g.hooks = g.hooks.filter((entry) => !isHookWithCommand(entry, command));
    if (g.hooks.length < before) removed = true;
  }

  if (!removed) return "not_found";

  // Atomic write that follows a symlinked settings.json (issue #12)
  try {
    await atomicWriteFollowingSymlink(path, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    return "skipped";
  }

  return "removed";
}

// ---------------------------------------------------------------------------
// T-516: the function-hooks switch in settings.json
// ---------------------------------------------------------------------------

/**
 * The environment variable Claude Code reads to decide whether a plugin's
 * hooks modules (our Mods) load at all. Early access: the client loads them
 * when this is set in its process environment or when the rollout flag
 * `tengu_plugin_hooks_modules` is on, and that flag is off by default.
 * `~/.claude/settings.json`'s `env` block reaches that environment, measured
 * against 2.1.273, so it is the switch a plain install can write.
 */
export const FUNCTION_HOOKS_ENV_KEY = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS";

/** Reads and parses settings.json defensively, exactly as the hook writers do. */
async function readSettingsObject(
  path: string,
  what: string,
): Promise<Record<string, unknown> | null> {
  let raw = "{}";
  if (existsSync(path)) {
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      process.stderr.write(`Could not read ${path} -- skipping ${what}.\n`);
      return null;
    }
  }

  try {
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      process.stderr.write(`${path} is not a JSON object -- skipping ${what}.\n`);
      return null;
    }
    return settings;
  } catch {
    process.stderr.write(`${path} contains invalid JSON -- skipping ${what}.\n`);
    process.stderr.write("  Fix the file manually or delete it to reset.\n");
    return null;
  }
}

/**
 * Ensures `env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is "1" in settings.json, so
 * the ledger dashboard appears after a plain `storybloq setup --client all`
 * (T-516, owner ruling: it ships on in 1.15).
 *
 * A value that is already there was chosen by whoever put it there, so it is
 * left alone whatever it says, "0" and "" included: turning the dashboard off
 * has to survive the next upgrade. Same atomic, symlink-following write the
 * hook registrars use, and the same "touch nothing we cannot parse" rule.
 */
export async function enableFunctionHooksEnv(
  settingsPath?: string,
): Promise<"set" | "exists" | "skipped"> {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  return withSettingsWriteLock(path, "skipped", () => enableFunctionHooksEnvLocked(path));
}

async function enableFunctionHooksEnvLocked(
  path: string,
): Promise<"set" | "exists" | "skipped"> {
  const what = "the function-hooks switch";

  const settings = await readSettingsObject(path, what);
  if (settings === null) return "skipped";

  if ("env" in settings) {
    if (typeof settings.env !== "object" || settings.env === null || Array.isArray(settings.env)) {
      process.stderr.write(`${path} has unexpected env format -- skipping ${what}.\n`);
      return "skipped";
    }
  } else {
    settings.env = {};
  }

  const env = settings.env as Record<string, unknown>;

  // The user's own value wins over the default, so the file is not rewritten
  // at all when the key is present.
  if (FUNCTION_HOOKS_ENV_KEY in env) return "exists";

  env[FUNCTION_HOOKS_ENV_KEY] = "1";

  try {
    await atomicWriteFollowingSymlink(path, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    return "skipped";
  }

  return "set";
}

/**
 * The counterpart of `enableFunctionHooksEnv` for an uninstall or opt-out
 * path: removes the key only when it still reads exactly "1", the value the
 * installer writes. Anything else in there is the user's and stays.
 */
export async function removeFunctionHooksEnv(
  settingsPath?: string,
): Promise<"removed" | "not_found" | "skipped"> {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");
  return withSettingsWriteLock(path, "skipped", () => removeFunctionHooksEnvLocked(path));
}

async function removeFunctionHooksEnvLocked(
  path: string,
): Promise<"removed" | "not_found" | "skipped"> {

  if (!existsSync(path)) return "not_found";

  const settings = await readSettingsObject(path, "the function-hooks switch removal");
  if (settings === null) return "skipped";

  if (typeof settings.env !== "object" || settings.env === null || Array.isArray(settings.env)) {
    return "not_found";
  }

  const env = settings.env as Record<string, unknown>;
  if (env[FUNCTION_HOOKS_ENV_KEY] !== "1") return "not_found";

  delete env[FUNCTION_HOOKS_ENV_KEY];

  try {
    await atomicWriteFollowingSymlink(path, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    return "skipped";
  }

  return "removed";
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export interface SetupSkillOptions {
  skipHooks?: boolean;
  /**
   * ISS-834: skip handleSetupCodex's own skill-directory copy (both the
   * primary `~/.agents/skills/story/` write and the `~/.codex/skills/story/`
   * compat refresh). For a Codex install already managed by the
   * `storybloq` marketplace plugin (which ships its own skill copy via
   * `skills: "./skills/"` in its plugin.json), running the npm installer's
   * copy step too would create a duplicate, competing skill provider.
   * Has no effect on `handleSetupClaude` -- Claude Code's skill path is
   * unrelated to the Codex plugin and stays unchanged, per ISS-834's own
   * "Claude Code install path unchanged" instruction. Rejected as a usage
   * error when combined with `client: "claude"` (see `handleSetup`), since
   * there is no Claude-side copy step for it to skip.
   */
  skipSkill?: boolean;
}

export type SetupClient = "claude" | "codex" | "all";

export interface SetupOptions extends SetupSkillOptions {
  client?: SetupClient;
}

export function formatClaudeSessionStartCommand(binPath: string): string {
  return formatHookCommand(binPath, SESSIONSTART_SUBCOMMAND);
}

export function formatCodexSessionStartCommand(binPath: string): string {
  return formatHookCommand(binPath, `${SESSIONSTART_SUBCOMMAND} --codex-hook-json`);
}

export function formatCodexPreCompactCommand(binPath: string): string {
  return formatHookCommand(binPath, `${PRECOMPACT_SUBCOMMAND} --client codex`);
}

export function formatCodexStopCommand(binPath: string): string {
  return formatHookCommand(binPath, `${STOP_SUBCOMMAND} --client codex`);
}

export type CodexHookType = "PreCompact" | "SessionStart" | "Stop";

export interface CodexHookCounts {
  PreCompact: number;
  SessionStart: number;
  Stop: number;
}

const CODEX_HOOK_ACCEPTED_RESTS: Record<CodexHookType, readonly string[]> = {
  PreCompact: [PRECOMPACT_SUBCOMMAND, `${PRECOMPACT_SUBCOMMAND} --client codex`],
  SessionStart: [SESSIONSTART_SUBCOMMAND, `${SESSIONSTART_SUBCOMMAND} --codex-hook-json`],
  Stop: [STOP_SUBCOMMAND, `${STOP_SUBCOMMAND} --client codex`],
};

const ZERO_CODEX_HOOK_COUNTS: CodexHookCounts = {
  PreCompact: 0,
  SessionStart: 0,
  Stop: 0,
};

export const CODEX_SESSION_START_MATCHER = "startup|resume|clear|compact";
export const CODEX_PRECOMPACT_MATCHER = "manual|auto";

function pruneEmptyMatcherGroups(
  hookArray: unknown[],
  candidates: ReadonlySet<unknown>,
): number {
  let removed = 0;
  for (let i = hookArray.length - 1; i >= 0; i--) {
    const group = hookArray[i];
    if (!candidates.has(group)) continue;
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (Array.isArray(g.hooks) && g.hooks.length === 0) {
      hookArray.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}


// ---------------------------------------------------------------------------
// T-509: registering the bundled codex-claude-bridge with Claude Code.
// ---------------------------------------------------------------------------

/** The MCP server name the bundled bridge is registered under. */
export const BRIDGE_MCP_NAME = "codex-bridge";

export type BridgeExecResult =
  | { readonly kind: "ok" }
  | { readonly kind: "enoent" }
  | { readonly kind: "failed"; readonly status: number | null; readonly stderr: string };

/** Runs `file args...` with piped stdio; the only spawn seam of the registration. */
export type BridgeExec = (file: string, args: readonly string[]) => BridgeExecResult;

export type BridgeRegistration = "skipped" | "unusable" | "exists" | "foreign" | "registered" | "unverifiable" | "failed";

export interface RegisterBridgeOptions {
  readonly bundled: BundledBridge;
  /** `~/.claude.json`, the user-scope MCP registry. */
  readonly claudeJsonPath: string;
  readonly exec: BridgeExec;
  readonly log: (line: string) => void;
}

function defaultBridgeExec(file: string, args: readonly string[]): BridgeExecResult {
  // On win32 the npm-installed claude CLI is a .cmd shim, which needs a shell
  // (same rule as runNpmRootG). A shell re-splits the argv, so every argument
  // is quoted with the same formatter used for displayed commands.
  const win = process.platform === "win32";
  let argv: string[] = [...args];
  if (win) {
    const quoted = winShellArgv(args);
    if (quoted === null) {
      return { kind: "failed", status: null, stderr: "an argument contains '%', '!' or a double quote, which cmd.exe would rewrite; register by hand" };
    }
    argv = quoted;
  }
  try {
    execFileSync(file, argv, { stdio: "pipe", timeout: 10000, shell: win });
    return { kind: "ok" };
  } catch (err: unknown) {
    const e = err as { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown };
    if (e.code === "ENOENT") return { kind: "enoent" };
    const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf-8") : typeof e.stderr === "string" ? e.stderr : String(e.message ?? "");
    return { kind: "failed", status: typeof e.status === "number" ? e.status : null, stderr };
  }
}

/**
 * The recovery instruction. On win32 a path cmd.exe would expand gets no
 * pasteable command at all (quoting cannot protect it); the user edits the
 * user-scope JSON entry instead, which is exactly what `claude mcp add` writes.
 */
export function manualBridgeAdd(entry: string, claudeJsonPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32" && cmdExpands(entry)) {
    return `add to ${claudeJsonPath} under "mcpServers": ${JSON.stringify({ [BRIDGE_MCP_NAME]: { command: "node", args: [entry] } })} (the path contains %, ! or a double quote, which cmd.exe would rewrite, so no shell command is shown)`;
  }
  return `claude mcp add ${BRIDGE_MCP_NAME} -s user -- node ${shellArg(entry, platform)}`;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return a === b || real(a) === real(b);
}

type UserBridgeEntry =
  | { readonly kind: "absent" }
  | { readonly kind: "indeterminate"; readonly reason: string }
  | { readonly kind: "present"; readonly command: string; readonly args: readonly string[]; readonly hasCwd: boolean };

/**
 * Three-valued read of `mcpServers["codex-bridge"]` at user scope. Shares the
 * health check's bounded reader so both features agree on what is readable.
 */
function readUserBridgeEntry(claudeJsonPath: string): UserBridgeEntry {
  const doc = readJsonObject({ readFile: readFileThreeValued }, claudeJsonPath, CLAUDE_JSON_MAX_BYTES);
  if (doc.kind === "absent") return { kind: "absent" };
  if (doc.kind === "indeterminate") return { kind: "indeterminate", reason: doc.reason };
  const servers = doc.value["mcpServers"];
  if (servers === undefined || servers === null) return { kind: "absent" };
  if (typeof servers !== "object" || Array.isArray(servers)) return { kind: "indeterminate", reason: "mcpServers is not an object" };
  const entry = (servers as Record<string, unknown>)[BRIDGE_MCP_NAME];
  if (entry === undefined || entry === null) return { kind: "absent" };
  if (typeof entry !== "object" || Array.isArray(entry)) return { kind: "indeterminate", reason: `${BRIDGE_MCP_NAME} entry is not an object` };
  const e = entry as Record<string, unknown>;
  const command = typeof e["command"] === "string" ? e["command"] : "";
  const rawArgs = e["args"];
  const args = Array.isArray(rawArgs) ? rawArgs.map((a): string => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))) : [];
  return { kind: "present", command, args, hasCwd: e["cwd"] !== undefined };
}

/**
 * Registers the bundled bridge as `codex-bridge` at user scope, launched as
 * `node <entry>` with no cwd (the bridge's own cwd argument governs where a
 * review runs). An entry already present under that name is never modified:
 * a matching one is reported as existing, anything else as foreign with the
 * exact steps to replace it.
 */
export function registerBridgeMcp(opts: RegisterBridgeOptions): BridgeRegistration {
  const { bundled, claudeJsonPath, exec, log } = opts;
  if (bundled.kind === "absent") {
    log("Codex review bridge skipped: codex-claude-bridge did not install (optional dependency; see README)");
    return "skipped";
  }
  if (bundled.kind === "unusable") {
    log(`Codex review bridge skipped: codex-claude-bridge is installed but unusable (${bundled.reason}); reinstall with npm install -g @storybloq/storybloq@latest`);
    return "unusable";
  }
  const { entry, version } = bundled;

  const classify = (existing: Extract<UserBridgeEntry, { kind: "present" }>): "exists" | "foreign" => {
    const isNode = basename(existing.command) === "node" || basename(existing.command) === "node.exe";
    // A cwd on the entry breaks the no-cwd contract (the bridge's own cwd
    // argument must govern where a review runs), so it is foreign even when
    // the command matches.
    const matches = isNode && existing.args.length === 1 && samePath(existing.args[0]!, entry) && !existing.hasCwd;
    if (matches) {
      log(`  Codex review bridge already registered as ${BRIDGE_MCP_NAME}`);
      return "exists";
    }
    const why = existing.hasCwd && isNode ? "with a cwd, which the bundled registration must not have" : "with a different command";
    log(`  ${BRIDGE_MCP_NAME} is registered at user scope ${why} (${[existing.command, ...existing.args].map((a) => shellArg(a)).join(" ")}); left alone.`);
    log(`  To use the bundled bridge: claude mcp remove ${BRIDGE_MCP_NAME} -s user, then re-run storybloq setup-skill`);
    return "foreign";
  };

  const unverifiable = (reason: string): "unverifiable" => {
    log(`Codex review bridge not registered: ${claudeJsonPath} could not be read (${reason}), so an existing ${BRIDGE_MCP_NAME} entry cannot be ruled out.`);
    log(`  Register by hand: ${manualBridgeAdd(entry, claudeJsonPath)}`);
    return "unverifiable";
  };

  const existing = readUserBridgeEntry(claudeJsonPath);
  if (existing.kind === "present") return classify(existing);
  if (existing.kind === "indeterminate") return unverifiable(existing.reason);

  const result = exec("claude", ["mcp", "add", BRIDGE_MCP_NAME, "-s", "user", "--", "node", entry]);
  if (result.kind === "ok") {
    log(`  Codex review bridge registered as ${BRIDGE_MCP_NAME} (bundled ${version})`);
    return "registered";
  }
  if (result.kind === "enoent") {
    log("");
    log("Codex review bridge not registered -- `claude` CLI not found in PATH.");
    log(`  To register manually: ${manualBridgeAdd(entry, claudeJsonPath)}`);
    return "failed";
  }
  if (result.stderr.includes("already exists")) {
    const again = readUserBridgeEntry(claudeJsonPath);
    if (again.kind === "present") return classify(again);
    return unverifiable(again.kind === "indeterminate" ? again.reason : `claude reported an existing ${BRIDGE_MCP_NAME} entry that the file does not show`);
  }
  log("");
  log(`Codex review bridge registration failed: ${result.stderr.split("\n")[0] ?? ""}`);
  log(`  To register manually: ${manualBridgeAdd(entry, claudeJsonPath)}`);
  return "failed";
}

/**
 * Installs the /story skill globally for Claude Code.
 *
 * 1. Writes SKILL.md + support files (setup-flow.md, autonomous-mode.md, reference.md) to ~/.claude/skills/story/
 * 2. Attempts to register MCP server via `claude mcp add`
 * 3. Optionally registers PreCompact hook in ~/.claude/settings.json
 * 4. Prints success message
 *
 * Idempotent -- safe to re-run (overwrites with latest).
 */
async function handleSetupClaude(options: SetupSkillOptions = {}): Promise<void> {
  const { skipHooks = false } = options;
  const skillDir = join(homedir(), ".claude", "skills", "story");
  await mkdir(skillDir, { recursive: true });

  let srcSkillDir: string;
  try {
    srcSkillDir = resolveSkillSourceDir();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.stderr.write("This may indicate a corrupt installation. Try: npm install -g @storybloq/storybloq@latest\n");
    process.exitCode = 1;
    return;
  }

  // Clean up old /prime skill (migrated to /story)
  const oldPrimeDir = join(homedir(), ".claude", "skills", "prime");
  if (existsSync(oldPrimeDir)) {
    await rm(oldPrimeDir, { recursive: true, force: true });
    log("Removed old /prime skill (migrated to /story)");
  }

  const existed = existsSync(join(skillDir, "SKILL.md"));

  const skillContent = await readFile(join(srcSkillDir, "SKILL.md"), "utf-8");
  await writeFile(join(skillDir, "SKILL.md"), skillContent, "utf-8");

  const supportFiles = ["setup-flow.md", "settings.md", "autonomous-mode.md", "reference.md", "federation-setup.md", "orchestrator-mode.md", "duet-mode.md", "triage-mode.md", "bus-mode.md", "session-guard-fallback.md", "session-guard.md", "review-contract-template.md"];
  const writtenFiles = ["SKILL.md"];
  const missingFiles: string[] = [];
  for (const filename of supportFiles) {
    const srcPath = join(srcSkillDir, filename);
    if (existsSync(srcPath)) {
      const content = await readFile(srcPath, "utf-8");
      await writeFile(join(skillDir, filename), content, "utf-8");
      writtenFiles.push(filename);
    } else {
      missingFiles.push(filename);
    }
  }

  // Copy subdirectory-based skills (design, review-lenses)
  for (const subdir of ["design", "review-lenses"]) {
    const srcDir = join(srcSkillDir, subdir);
    if (existsSync(srcDir)) {
      const destDir = join(skillDir, subdir);
      try {
        const files = await copyDirRecursive(srcDir, destDir);
        for (const f of files) writtenFiles.push(`${subdir}/${f}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: ${subdir} skill copy failed: ${msg}\n`);
        missingFiles.push(`${subdir}/`);
      }
    }
  }

  // ISS-570 G3: write a version marker so subsequent CLI invocations can
  // detect when the skill dir is stale after a 'npm install -g ...' bump
  // and auto-refresh without making the user re-run setup-skill manually.
  // ISS-1302: with the bundle's fingerprint beside it, so the next command
  // does not rewrite the copy this setup just wrote.
  try {
    const { writeSkillMarker, skillSourceFingerprint } = await import("../../core/skill-version-marker.js");
    const pkgJson = JSON.parse(
      await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")
    ) as { version?: string };
    if (pkgJson.version) writeSkillMarker(pkgJson.version, "claude", skillSourceFingerprint(srcSkillDir));
  } catch {
    // Marker write is best-effort; skill still works without it.
  }

  log(`${existed ? "Updated" : "Installed"} /story skill at ${skillDir}/`);
  log(`  ${writtenFiles.join(" + ")} written`);
  if (missingFiles.length > 0) {
    process.stderr.write(`Warning: support file(s) not found in source: ${missingFiles.join(", ")}\n`);
    process.stderr.write("  This may indicate a corrupt installation. Try: npm install -g @storybloq/storybloq@latest\n");
  }

  // T-507 commit D: the Mods copy (Claude Code function hooks), with
  // hooks/install.ts generated to answer the absolute path of the global
  // binary. Non-fatal: the skill and hooks above do not depend on it, and
  // the version-marker refresh retries it on the next upgrade.
  try {
    const { installMods, MODS_DISPLAY_PATH } = await import("../../core/mods-install.js");
    const modsBin = resolveStorybloqBin();
    const mods = await installMods({ bin: modsBin });
    log(`Installed Mods (function hooks) at ${MODS_DISPLAY_PATH}`);
    log(`  ${mods.written.length} files written; storybloq resolved to ${modsBin ?? "the bare name (not found on PATH)"}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: Mods copy failed (non-fatal): ${msg}\n`);
  }

  // T-516: the copy above is inert until the client is allowed to load hooks
  // modules at all, which the settings `env` block is what switches on. Runs
  // whether or not the copy succeeded (a later upgrade refreshes the copy and
  // finds the switch already written) and is silent on every rerun.
  try {
    const settingsFile = join(homedir(), ".claude", "settings.json");
    const envState = await enableFunctionHooksEnv();
    if (envState === "set") {
      log(`  Set env.${FUNCTION_HOOKS_ENV_KEY}=1 in ${settingsFile} (draws the ledger dashboard)`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Warning: could not set ${FUNCTION_HOOKS_ENV_KEY} (non-fatal): ${msg}\n`);
  }

  // Attempt MCP registration -- requires both `storybloq` and `claude` in PATH.
  let mcpRegistered = false;
  let cliInPath = false;
  try {
    execFileSync("storybloq", ["--version"], { stdio: "pipe", timeout: 5000 });
    cliInPath = true;
  } catch {
    // storybloq not in PATH
  }

  if (cliInPath) {
    try {
      execFileSync("claude", ["mcp", "add", "storybloq", "-s", "user", "--", "storybloq", "--mcp"], {
        stdio: "pipe",
        timeout: 10000,
      });
      mcpRegistered = true;
      log("  MCP server registered globally");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isAlreadyRegistered = message.includes("already exists");
      const isNotFound = message.includes("ENOENT") || message.includes("not found");
      if (isAlreadyRegistered) {
        mcpRegistered = true;
        log("  MCP server already registered globally");
      } else if (isNotFound) {
        log("");
        log("MCP registration skipped -- `claude` CLI not found in PATH.");
        log("  To register manually: claude mcp add storybloq -s user -- storybloq --mcp");
      } else {
        log("");
        log(`MCP registration failed: ${message.split("\n")[0]}`);
        log("  To register manually: claude mcp add storybloq -s user -- storybloq --mcp");
      }
    }
  } else {
    log("");
    log("MCP registration skipped -- `storybloq` not found in PATH.");
    log("Install globally first, then register MCP:");
    log("  npm install -g @storybloq/storybloq@latest");
    log("  claude mcp add storybloq -s user -- storybloq --mcp");
  }

  // T-509: the bundled Codex review bridge, registered beside the storybloq server.
  registerBridgeMcp({
    bundled: resolveBundledBridge(),
    claudeJsonPath: join(homedir(), ".claude.json"),
    exec: defaultBridgeExec,
    log,
  });

  // Hook registration (ISS-032: hook-driven compaction; ISS-560: absolute bin path)
  // Gate on `resolveStorybloqBin()` -- Claude Code hooks run under a shell
  // whose PATH may differ from this process's at install time (nvm/fnm
  // switches mid-session). Baking the absolute path into the command string
  // removes that dependency.
  const resolvedBin = resolveStorybloqBin();

  if (!skipHooks && resolvedBin !== null) {
    // Migrate: remove legacy snapshot hook if present
    const legacyRemoved = await removeHook("PreCompact", LEGACY_PRECOMPACT_HOOK_COMMAND);
    if (legacyRemoved === "removed") {
      log("  Removed legacy PreCompact hook (snapshot --quiet)");
    }

    // Precompute new command strings so migration can preserve exact matches.
    const precompactCmd = formatHookCommand(resolvedBin, PRECOMPACT_SUBCOMMAND);
    const sessionStartCmd = formatClaudeSessionStartCommand(resolvedBin);
    const stopCmd = formatHookCommand(resolvedBin, STOP_SUBCOMMAND);

    const migratedPre = await migrateLegacyHookVariants("PreCompact", PRECOMPACT_SUBCOMMAND, precompactCmd);
    if (migratedPre > 0) log(`  Migrated ${migratedPre} stale PreCompact hook entr${migratedPre === 1 ? "y" : "ies"}`);
    const migratedStart = await migrateLegacyHookVariants("SessionStart", SESSIONSTART_SUBCOMMAND, sessionStartCmd);
    if (migratedStart > 0) log(`  Migrated ${migratedStart} stale SessionStart hook entr${migratedStart === 1 ? "y" : "ies"}`);
    const migratedStop = await migrateLegacyHookVariants("Stop", STOP_SUBCOMMAND, stopCmd);
    if (migratedStop > 0) log(`  Migrated ${migratedStop} stale Stop hook entr${migratedStop === 1 ? "y" : "ies"}`);
    // ISS-1222: the same hook through two launcher paths (an npx cache copy
    // beside the global install) runs twice. Collapse each collision to the
    // validated global launcher's row and say exactly what was removed.
    const duplicates = await reconcileDuplicateHookRows(join(homedir(), ".claude", "settings.json"), globalHookCommandFor());
    for (const r of duplicates.reconciled) {
      for (const d of r.dropped) {
        log(`  Removed duplicate ${r.hookType} hook row: ${d.command} (matcher "${d.matcher}"); kept ${r.kept.command} (matcher "${r.kept.matcher}")`);
      }
    }
    for (const u of duplicates.unresolved) {
      log(`  Duplicate ${u.hookType} hook rows left in place, the global storybloq launcher could not be established: ${u.rows.map((row) => row.command).join(", ")}`);
    }
    for (const p of duplicates.pruned) {
      log(`  Removed empty ${p.hookType} hook group (matcher "${p.matcher}")`);
    }
    if (duplicates.changed) {
      log("  Rewrote ~/.claude/settings.json to drop the duplicate rows or empty groups; the file is re-serialised as two-space JSON, so any hand formatting is normalised");
    }

    const precompactResult = await registerPreCompactHook(undefined, resolvedBin);
    switch (precompactResult) {
      case "registered":
        log("  PreCompact hook registered -- session compact preparation before context compaction");
        break;
      case "exists":
        log("  PreCompact hook already configured");
        break;
      case "skipped":
        break;
    }

    const sessionStartResult = await registerSessionStartHook(undefined, resolvedBin);
    switch (sessionStartResult) {
      case "registered":
        log("  SessionStart hook registered -- resume prompt after compaction");
        break;
      case "exists":
        log("  SessionStart hook already configured");
        break;
      case "skipped":
        break;
    }

    const stopResult = await registerStopHook(undefined, resolvedBin);
    switch (stopResult) {
      case "registered":
        log("  Stop hook registered -- status.json updated after every Claude response");
        break;
      case "exists":
        log("  Stop hook already configured");
        break;
      case "skipped":
        break;
    }

    // ISS-1022: session presence. Five synchronous hooks from the slim
    // `storybloq-presence` bin. Silently skipped on an install that predates
    // that bin -- registering a command that does not exist would fail on
    // every tool call.
    const presenceResults = await registerPresenceHooks(undefined, resolvePresenceBin(resolvedBin));
    if (presenceResults === null) {
      log("  Presence hooks skipped -- `storybloq-presence` binary not found (update the CLI)");
    } else {
      const registered = Object.values(presenceResults).filter((r) => r === "registered").length;
      if (registered > 0) {
        log(`  Presence hooks registered (${registered}/${PRESENCE_HOOK_TYPES.length}) -- live sessions appear in the Storybloq app`);
      } else {
        log("  Presence hooks already configured");
      }
    }

    // T-534: the usage-limit auto-resume is retired; setup removes its hooks,
    // waker and global artifacts instead of installing them.
    const { retireLimitAutoResumeBestEffort, sessionAttentionNotes } = await import("../limit-retirement-entry.js");
    const retirement = await retireLimitAutoResumeBestEffort(process.env.STORYBLOQ_VERSION ?? "0.0.0-dev", { report: "none" });
    if (retirement.kind === "retired") {
      log("  Usage-limit auto-resume retired - Claude Code continues at a usage limit on its own");
    } else if (retirement.kind === "incomplete") {
      for (const problem of retirement.problems) log(`  Usage-limit auto-resume retirement incomplete: ${problem}`);
    }
    for (const note of sessionAttentionNotes(retirement)) log(`  Usage-limit auto-resume retirement: ${note}`);

    // T-499: session-intel hooks (SessionStart capture + UserPromptSubmit sample).
    const intelHooks = await ensureSessionIntelHooksRegistered(undefined, resolvedBin);
    if (intelHooks.action === "installed") {
      log("  Session-intel hooks registered - context pressure reaches the agent before auto-compaction");
    } else if (intelHooks.action === "removed") {
      log("  Session-intel hooks removed - disabled globally");
    } else {
      log("  Session-intel hooks already configured (or disabled globally)");
    }
  } else if (skipHooks) {
    log("  Hook registration skipped (--skip-hooks)");
  } else {
    log("");
    log("Hook registration skipped -- `storybloq` binary not found.");
    log("Install globally first, then re-run setup-skill:");
    log("  npm install -g @storybloq/storybloq@latest");
    log("  storybloq setup-skill");
  }

  log("");
  if (mcpRegistered) {
    log("Done! Restart Claude Code, then type /story in any project.");
    log(MODS_WIDTH_NOTE);
  } else {
    log("Skill installed. After registering MCP, restart Claude Code and type /story.");
  }
}

// "Read-only" here means canonical tracked project state. Bus poll may repair
// and advance gitignored .story/bus runtime metadata while remaining advisory.
export const CODEX_READ_ONLY_APPROVAL_TOOLS = [
  "storybloq_status",
  "storybloq_phase_list",
  "storybloq_phase_current",
  "storybloq_phase_tickets",
  "storybloq_ticket_list",
  "storybloq_ticket_get",
  "storybloq_ticket_next",
  "storybloq_ticket_blocked",
  "storybloq_ticket_meta_get",
  "storybloq_issue_list",
  "storybloq_issue_get",
  "storybloq_issue_meta_get",
  "storybloq_note_list",
  "storybloq_note_get",
  "storybloq_lesson_list",
  "storybloq_lesson_get",
  "storybloq_lesson_digest",
  "storybloq_handover_list",
  "storybloq_handover_latest",
  "storybloq_handover_get",
  "storybloq_blocker_list",
  "storybloq_validate",
  "storybloq_recap",
  "storybloq_recommend",
  "storybloq_export",
  "storybloq_session_report",
  // T-446: read-only, runs on every invocation as part of Step 0.5. Without it
  // Codex prompts for approval before the guard on every single session.
  "storybloq_session_guard",
  "storybloq_bus_poll",
  "storybloq_bus_thread_get",
  "storybloq_node_list",
] as const;

function commandErrorText(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf-8") : e.stderr;
    const stdout = Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf-8") : e.stdout;
    return [stderr, stdout, e.message].filter(Boolean).join("\n");
  }
  return String(err);
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** ISS-1091 (F10): exported for the e2e acceptance probe's audited-path list. */
export function codexHooksPath(): string {
  return join(codexHome(), "hooks.json");
}

/**
 * ISS-1091 (F10): exported for the e2e acceptance probe's audited-path list.
 * Note this duplicates skill-version-marker.ts's own `codexConfigPath` -- both
 * compute the identical path independently; see
 * test/helpers/e2e-acceptance-probe.test.ts for the pinned-equal assertion
 * documenting that duplication.
 */
export function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
}

export async function ensureCodexHomeDir(home = codexHome()): Promise<"created" | "exists" | "skipped"> {
  const existed = existsSync(home);
  try {
    await mkdir(home, { recursive: true });
    return existed ? "exists" : "created";
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to create Codex home directory ${home}: ${message}\n`);
    return "skipped";
  }
}

function parseCodexVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function compareVersions(a: string, b: string): number {
  const av = a.split(".").map((part) => Number.parseInt(part, 10));
  const bv = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i++) {
    const ai = Number.isFinite(av[i]) ? av[i]! : 0;
    const bi = Number.isFinite(bv[i]) ? bv[i]! : 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

export async function ensureCodexToolApprovals(
  configPath = codexConfigPath(),
  tools: readonly string[] = CODEX_READ_ONLY_APPROVAL_TOOLS,
): Promise<"updated" | "exists" | "skipped"> {
  let raw = "";
  if (existsSync(configPath)) {
    try {
      raw = await readFile(configPath, "utf-8");
    } catch {
      process.stderr.write(`Could not read ${configPath} - skipping Codex MCP approval config.\n`);
      return "skipped";
    }
  }

  let next = raw;
  let changedExisting = false;
  const additions: string[] = [];
  for (const tool of tools) {
    const header = `[mcp_servers.storybloq.tools.${tool}]`;
    const block = findTomlTableBlock(next, header);
    if (block) {
      const existing = next.slice(block.start, block.end);
      const updated = ensureTomlApprovalMode(existing);
      if (updated !== existing) {
        next = next.slice(0, block.start) + updated + next.slice(block.end);
        changedExisting = true;
      }
      continue;
    }
    additions.push(`${header}\napproval_mode = "approve"\n`);
  }

  if (additions.length === 0 && !changedExisting) return "exists";

  if (additions.length > 0) {
    if (next.length > 0 && !next.endsWith("\n")) next += "\n";
    if (next.length > 0 && !next.endsWith("\n\n")) next += "\n";
    next += additions.join("\n");
  }

  // Atomic write that follows a symlinked config.toml (issue #12)
  try {
    await atomicWriteFollowingSymlink(configPath, next);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to write Codex config.toml: ${message}\n`);
    return "skipped";
  }

  return "updated";
}

function findTomlTableBlock(raw: string, header: string): { start: number; end: number } | null {
  const lines = raw.match(/[^\n]*(?:\n|$)/g) ?? [];
  let offset = 0;
  let start: number | null = null;

  for (const line of lines) {
    if (line.length === 0) continue;
    const trimmed = line.trim();
    const headerCandidate = (trimmed.split("#", 1)[0] ?? "").trim();
    const isHeader = headerCandidate.startsWith("[") && headerCandidate.endsWith("]");
    if (isHeader) {
      if (start !== null) return { start, end: offset };
      if (headerCandidate === header) start = offset;
    }
    offset += line.length;
  }

  return start === null ? null : { start, end: raw.length };
}

function ensureTomlApprovalMode(block: string): string {
  if (/^\s*approval_mode\s*=\s*"approve"\s*(?:#.*)?$/m.test(block)) return block;

  const approvalLine = /^(\s*)approval_mode\s*=.*?(\s*(?:#.*)?)$/m;
  const match = block.match(approvalLine);
  if (match) {
    const indent = match[1] ?? "";
    const comment = match[2] ?? "";
    return block.replace(approvalLine, `${indent}approval_mode = "approve"${comment}`);
  }

  const separator = block.endsWith("\n") ? "" : "\n";
  return `${block}${separator}approval_mode = "approve"\n`;
}

function ensureTomlStringValue(block: string, key: string, value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const desired = `${key} = "${escaped}"`;
  const exact = new RegExp(`^\\s*${key}\\s*=\\s*"${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*(?:#.*)?$`, "m");
  if (exact.test(block)) return block;

  const line = new RegExp(`^(\\s*)${key}\\s*=.*?(\\s*(?:#.*)?)$`, "m");
  const match = block.match(line);
  if (match) {
    const indent = match[1] ?? "";
    const comment = match[2] ?? "";
    return block.replace(line, `${indent}${desired}${comment}`);
  }

  const separator = block.endsWith("\n") ? "" : "\n";
  return `${block}${separator}${desired}\n`;
}

export async function ensureCodexClientEnv(
  configPath = codexConfigPath(),
): Promise<"updated" | "exists" | "skipped"> {
  let raw = "";
  if (existsSync(configPath)) {
    try {
      raw = await readFile(configPath, "utf-8");
    } catch {
      process.stderr.write(`Could not read ${configPath} - skipping Codex MCP env config.\n`);
      return "skipped";
    }
  }

  const header = "[mcp_servers.storybloq.env]";
  const block = findTomlTableBlock(raw, header);
  let next = raw;
  if (block) {
    const existing = next.slice(block.start, block.end);
    const updated = ensureTomlStringValue(existing, "STORYBLOQ_CLIENT", "codex");
    if (updated === existing) return "exists";
    next = next.slice(0, block.start) + updated + next.slice(block.end);
  } else {
    if (next.length > 0 && !next.endsWith("\n")) next += "\n";
    if (next.length > 0 && !next.endsWith("\n\n")) next += "\n";
    next += `${header}\nSTORYBLOQ_CLIENT = "codex"\n`;
  }

  // Atomic write that follows a symlinked config.toml (issue #12)
  try {
    await atomicWriteFollowingSymlink(configPath, next);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to write Codex config.toml: ${message}\n`);
    return "skipped";
  }

  return "updated";
}

export async function migrateCodexHookVariants(
  hookType: CodexHookType,
  acceptedRests: readonly string[],
  newCommand: string,
  hooksPath = codexHooksPath(),
): Promise<number> {
  if (!existsSync(hooksPath)) return 0;

  let raw: string;
  try {
    raw = await readFile(hooksPath, "utf-8");
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
  const emptiedByMigration = new Set<unknown>();
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
      return !acceptedRests.includes(parsed.rest);
    });
    const removed = before - g.hooks.length;
    removedCount += removed;
    if (removed > 0 && g.hooks.length === 0) emptiedByMigration.add(group);
  }

  if (removedCount === 0) return 0;
  pruneEmptyMatcherGroups(hookArray, emptiedByMigration);

  // Atomic write that follows a symlinked hooks.json (issue #12)
  try {
    await atomicWriteFollowingSymlink(hooksPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    return 0;
  }

  return removedCount;
}

export async function registerCodexHook(
  hookType: CodexHookType,
  hookEntry: HookEntry,
  hooksPath = codexHooksPath(),
  matcher?: string,
): Promise<"registered" | "exists" | "skipped"> {
  let raw = "{}";
  if (existsSync(hooksPath)) {
    try {
      raw = await readFile(hooksPath, "utf-8");
    } catch {
      process.stderr.write(`Could not read ${hooksPath} - skipping Codex hook registration.\n`);
      return "skipped";
    }
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      process.stderr.write(`${hooksPath} is not a JSON object - skipping Codex hook registration.\n`);
      return "skipped";
    }
  } catch {
    process.stderr.write(`${hooksPath} contains invalid JSON - skipping Codex hook registration.\n`);
    return "skipped";
  }

  if ("hooks" in settings) {
    if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
      process.stderr.write(`${hooksPath} has unexpected hooks format - skipping Codex hook registration.\n`);
      return "skipped";
    }
  } else {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown>;
  if (hookType in hooks) {
    if (!Array.isArray(hooks[hookType])) {
      process.stderr.write(`${hooksPath} has unexpected hooks.${hookType} format - skipping Codex hook registration.\n`);
      return "skipped";
    }
  } else {
    hooks[hookType] = [];
  }

  const hookArray = hooks[hookType] as unknown[];
  const hookCommand = hookEntry.command;
  const targetMatcher = matcher ?? "";
  if (hookCommand) {
    let foundInTargetMatcher = false;
    let removedFromWrongMatcher = false;
    const emptiedByMove = new Set<unknown>();
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      const groupMatcher = g.matcher ?? "";
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((entry) => {
        if (!isHookWithCommand(entry, hookCommand)) return true;
        if (groupMatcher === targetMatcher) {
          foundInTargetMatcher = true;
          return true;
        }
        return false;
      });
      if (before !== g.hooks.length) {
        // Same command under an older matcher. Re-add it below under the
        // current matcher so hook source coverage can be upgraded in place.
        removedFromWrongMatcher = true;
        if (g.hooks.length === 0) emptiedByMove.add(group);
      }
    }
    const prunedEmptyGroups = pruneEmptyMatcherGroups(hookArray, emptiedByMove);
    if (foundInTargetMatcher) {
      if (!removedFromWrongMatcher && prunedEmptyGroups === 0) return "exists";
      try {
        await atomicWriteFollowingSymlink(hooksPath, JSON.stringify(settings, null, 2) + "\n");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to write Codex hooks.json: ${message}\n`);
        return "skipped";
      }
      return "registered";
    }
  }

  let appended = false;
  for (const group of hookArray) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if ((g.matcher ?? "") === targetMatcher && Array.isArray(g.hooks)) {
      g.hooks.push(hookEntry);
      appended = true;
      break;
    }
  }
  if (!appended) {
    const group: MatcherGroup = { hooks: [hookEntry] };
    if (targetMatcher) group.matcher = targetMatcher;
    hookArray.push(group);
  }

  // Atomic write that follows a symlinked hooks.json (issue #12)
  try {
    await atomicWriteFollowingSymlink(hooksPath, JSON.stringify(settings, null, 2) + "\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to write Codex hooks.json: ${message}\n`);
    return "skipped";
  }

  return "registered";
}

export async function countCodexStorybloqHooks(
  hooksPath = codexHooksPath(),
): Promise<CodexHookCounts> {
  if (!existsSync(hooksPath)) return { ...ZERO_CODEX_HOOK_COUNTS };

  let raw: string;
  try {
    raw = await readFile(hooksPath, "utf-8");
  } catch {
    return { ...ZERO_CODEX_HOOK_COUNTS };
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      return { ...ZERO_CODEX_HOOK_COUNTS };
    }
  } catch {
    return { ...ZERO_CODEX_HOOK_COUNTS };
  }

  if (!("hooks" in settings) || typeof settings.hooks !== "object" || settings.hooks === null) {
    return { ...ZERO_CODEX_HOOK_COUNTS };
  }

  const hooks = settings.hooks as Record<string, unknown>;
  const counts: CodexHookCounts = { ...ZERO_CODEX_HOOK_COUNTS };

  for (const hookType of Object.keys(CODEX_HOOK_ACCEPTED_RESTS) as CodexHookType[]) {
    if (!(hookType in hooks) || !Array.isArray(hooks[hookType])) continue;
    const hookArray = hooks[hookType] as unknown[];
    const acceptedRests = CODEX_HOOK_ACCEPTED_RESTS[hookType];
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      for (const entry of g.hooks) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as HookEntry;
        if (e.type !== "command" || typeof e.command !== "string") continue;
        const parsed = parseHookCommand(e.command);
        if (parsed === null) continue;
        if (!STORYBLOQ_LEGACY_BASENAMES.has(parsed.binBasename)) continue;
        if (!acceptedRests.includes(parsed.rest)) continue;
        counts[hookType] += 1;
      }
    }
  }

  return counts;
}

export interface CodexHookRefreshResult {
  detected: number;
  changed: number;
  skipped: boolean;
}

export async function refreshExistingCodexHooks(
  binPath?: string,
  hooksPath = codexHooksPath(),
): Promise<CodexHookRefreshResult> {
  const bin = binPath ?? resolveStorybloqBin();
  if (bin === null) return { detected: 0, changed: 0, skipped: true };

  const counts = await countCodexStorybloqHooks(hooksPath);
  const detected = counts.PreCompact + counts.SessionStart + counts.Stop;
  if (detected === 0) return { detected, changed: 0, skipped: false };

  let changed = 0;
  let skipped = false;

  async function refreshType(
    hookType: CodexHookType,
    acceptedRests: readonly string[],
    command: string,
    hookEntry: HookEntry,
    matcher?: string,
  ): Promise<void> {
    const migrated = await migrateCodexHookVariants(hookType, acceptedRests, command, hooksPath);
    changed += migrated;
    const registered = await registerCodexHook(hookType, hookEntry, hooksPath, matcher);
    if (registered === "registered") changed += 1;
    if (registered === "skipped") skipped = true;
  }

  if (counts.PreCompact > 0) {
    const command = formatCodexPreCompactCommand(bin);
    await refreshType(
      "PreCompact",
      CODEX_HOOK_ACCEPTED_RESTS.PreCompact,
      command,
      { type: "command", command, statusMessage: "Preparing Storybloq session" },
      CODEX_PRECOMPACT_MATCHER,
    );
  }

  if (counts.SessionStart > 0) {
    const command = formatCodexSessionStartCommand(bin);
    await refreshType(
      "SessionStart",
      CODEX_HOOK_ACCEPTED_RESTS.SessionStart,
      command,
      { type: "command", command, statusMessage: "Loading Storybloq session" },
      CODEX_SESSION_START_MATCHER,
    );
  }

  if (counts.Stop > 0) {
    const command = formatCodexStopCommand(bin);
    await refreshType(
      "Stop",
      CODEX_HOOK_ACCEPTED_RESTS.Stop,
      command,
      { type: "command", command, statusMessage: "Updating Storybloq status" },
    );
  }

  return { detected, changed, skipped };
}

async function handleSetupCodex(options: SetupSkillOptions = {}): Promise<void> {
  const { skipHooks = false, skipSkill = false } = options;

  let compatRefreshSucceeded = false;
  // ISS-1302: the bundle the copies below are written from, for the markers.
  let markerSrcDir: string | null = null;
  if (!skipSkill) {
    let srcSkillDir: string;
    try {
      srcSkillDir = resolveSkillSourceDir();
      markerSrcDir = srcSkillDir;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.stderr.write("This may indicate a corrupt installation. Try: npm install -g @storybloq/storybloq@latest\n");
      process.exitCode = 1;
      return;
    }

    // Primary Codex skill artifact: leave unwrapped so a total failure propagates
    // to the top-level handler and sets a non-zero exit (parity with
    // handleSetupClaude's primary writes). The no-setup self-heal path has its own
    // non-fatal guard in autoRefreshSkillIfStale, so this does not affect it.
    const skillDir = join(homedir(), ".agents", "skills", "story");
    const existed = existsSync(join(skillDir, "SKILL.md"));
    const writtenFiles = await copyDirRecursive(srcSkillDir, skillDir);
    log(`${existed ? "Updated" : "Installed"} $story skill at ${skillDir}/`);
    log(`  ${writtenFiles.join(" + ")} written`);

    const compatSkillDir = join(codexHome(), "skills", "story");
    if (existsSync(join(compatSkillDir, "SKILL.md"))) {
      try {
        const compatFiles = await copyDirRecursive(srcSkillDir, compatSkillDir);
        compatRefreshSucceeded = true;
        log(`  Refreshed existing Codex skill copy at ${compatSkillDir}/ (${compatFiles.length} files)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Warning: Codex skill copy refresh failed: ${msg}\n`);
      }
    }
  } else {
    log("  Skill install skipped (--skip-skill)");
  }

  if (!skipSkill) {
    try {
      const { writeSkillMarker, skillSourceFingerprint } = await import("../../core/skill-version-marker.js");
      const pkgJson = JSON.parse(
        await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")
      ) as { version?: string };
      if (pkgJson.version) {
        // ISS-1302: the bundle fingerprint rides with every marker setup writes.
        const fingerprint = markerSrcDir === null ? null : skillSourceFingerprint(markerSrcDir);
        writeSkillMarker(pkgJson.version, "codex", fingerprint);
        if (compatRefreshSucceeded) writeSkillMarker(pkgJson.version, "codexCompat", fingerprint);
      }
    } catch {
      // Marker write is best-effort; skill still works without it.
    }
  }

  let cliInPath = false;
  try {
    execFileSync("storybloq", ["--version"], { stdio: "pipe", timeout: 5000 });
    cliInPath = true;
  } catch {
    // storybloq not in PATH
  }

  let codexInPath = false;
  try {
    const versionOutput = execFileSync("codex", ["--version"], { encoding: "utf-8", stdio: "pipe", timeout: 5000 });
    codexInPath = true;
    const version = parseCodexVersion(versionOutput);
    if (!version || compareVersions(version, "0.130.0") < 0) {
      log(`  Warning: Codex CLI ${version ?? "version unknown"} detected. Storybloq Codex hooks require Codex 0.130.0 or newer.`);
      log("  If hooks do not run, ensure [features] hooks = true in ~/.codex/config.toml.");
    }
  } catch {
    // codex not in PATH
  }

  if (cliInPath && codexInPath) {
    let mcpReadyForConfig = false;
    const codexHomeResult = await ensureCodexHomeDir();
    if (codexHomeResult === "skipped") {
      log("");
      log("Codex MCP registration failed: could not create Codex home directory.");
      log("  To register manually: codex mcp add storybloq --env STORYBLOQ_CLIENT=codex -- storybloq --mcp");
    } else {
      try {
        execFileSync("codex", ["mcp", "add", "storybloq", "--env", "STORYBLOQ_CLIENT=codex", "--", "storybloq", "--mcp"], {
          stdio: "pipe",
          timeout: 10000,
        });
        mcpReadyForConfig = true;
        log("  Codex MCP server registered globally");
      } catch (err: unknown) {
        const message = commandErrorText(err);
        const isAlreadyRegistered = /already exists|already configured|duplicate/i.test(message);
        if (isAlreadyRegistered) {
          mcpReadyForConfig = true;
          log("  Codex MCP server already registered globally");
        } else {
          log("");
          log(`Codex MCP registration failed: ${message.split("\n")[0]}`);
          log("  To register manually: codex mcp add storybloq --env STORYBLOQ_CLIENT=codex -- storybloq --mcp");
        }
      }
    }

    if (mcpReadyForConfig) {
      const envResult = await ensureCodexClientEnv();
      if (envResult === "updated") {
        log("  Codex Storybloq MCP client identity configured");
      }

      const approvalResult = await ensureCodexToolApprovals();
      if (approvalResult === "updated") {
        log("  Codex read-only Storybloq MCP tools configured for approval-free use");
      } else if (approvalResult === "exists") {
        log("  Codex read-only Storybloq MCP tool approvals already configured");
      }
    }
  } else {
    log("");
    if (!cliInPath) log("Codex MCP registration skipped - `storybloq` not found in PATH.");
    if (!codexInPath) log("Codex MCP registration skipped - `codex` CLI not found in PATH.");
    log("Install globally first, then register MCP:");
    if (!cliInPath) log("  npm install -g @storybloq/storybloq@latest");
    if (!codexInPath) log("  npm install -g @openai/codex");
    log("  codex mcp add storybloq --env STORYBLOQ_CLIENT=codex -- storybloq --mcp");
  }

  const resolvedBin = resolveStorybloqBin();
  if (!skipHooks && resolvedBin !== null) {
    const precompactCmd = formatCodexPreCompactCommand(resolvedBin);
    const sessionStartCmd = formatCodexSessionStartCommand(resolvedBin);
    const stopCmd = formatCodexStopCommand(resolvedBin);
    const migratedPre = await migrateCodexHookVariants(
      "PreCompact",
      [PRECOMPACT_SUBCOMMAND, `${PRECOMPACT_SUBCOMMAND} --client codex`],
      precompactCmd,
    );
    if (migratedPre > 0) log(`  Migrated ${migratedPre} stale Codex PreCompact hook entr${migratedPre === 1 ? "y" : "ies"}`);
    const migratedStart = await migrateCodexHookVariants(
      "SessionStart",
      [SESSIONSTART_SUBCOMMAND, `${SESSIONSTART_SUBCOMMAND} --codex-hook-json`],
      sessionStartCmd,
    );
    if (migratedStart > 0) log(`  Migrated ${migratedStart} stale Codex SessionStart hook entr${migratedStart === 1 ? "y" : "ies"}`);
    const migratedStop = await migrateCodexHookVariants("Stop", CODEX_HOOK_ACCEPTED_RESTS.Stop, stopCmd);
    if (migratedStop > 0) log(`  Migrated ${migratedStop} stale Codex Stop hook entr${migratedStop === 1 ? "y" : "ies"}`);

    const precompactResult = await registerCodexHook(
      "PreCompact",
      { type: "command", command: precompactCmd, statusMessage: "Preparing Storybloq session" },
      undefined,
      CODEX_PRECOMPACT_MATCHER,
    );
    if (precompactResult === "registered") log("  Codex PreCompact hook registered");
    if (precompactResult === "exists") log("  Codex PreCompact hook already configured");

    const sessionStartResult = await registerCodexHook(
      "SessionStart",
      { type: "command", command: sessionStartCmd, statusMessage: "Loading Storybloq session" },
      undefined,
      CODEX_SESSION_START_MATCHER,
    );
    if (sessionStartResult === "registered") log("  Codex SessionStart hook registered");
    if (sessionStartResult === "exists") log("  Codex SessionStart hook already configured");

    const stopResult = await registerCodexHook(
      "Stop",
      { type: "command", command: stopCmd, statusMessage: "Updating Storybloq status" },
    );
    if (stopResult === "registered") log("  Codex Stop hook registered - status.json refreshed after Codex turns");
    if (stopResult === "exists") log("  Codex Stop hook already configured");
  } else if (skipHooks) {
    log("  Codex hook registration skipped (--skip-hooks)");
  } else {
    log("");
    log("Codex hook registration skipped - `storybloq` binary not found.");
    log("Install globally first, then re-run setup:");
    log("  npm install -g @storybloq/storybloq@latest");
    log("  storybloq setup --client codex");
  }

  if (!skipHooks) {
    const counts = await countCodexStorybloqHooks();
    const installedTypes = (Object.entries(counts) as Array<[CodexHookType, number]>)
      .filter(([, count]) => count > 0)
      .map(([type]) => type);
    if (installedTypes.length === 3) {
      log("  Codex hooks installed (trust: unknown). Open /hooks in Codex to review and trust them.");
    } else if (installedTypes.length > 0) {
      log(`  Warning: Codex hooks are partially installed (${installedTypes.join(", ")}); trust is unknown. Re-run setup, then review /hooks.`);
    }
  }

  log("");
  log("Done! Restart Codex, then invoke $story in any project.");
}

export async function handleSetup(options: SetupOptions = {}): Promise<void> {
  const client = options.client ?? "all";
  if (!["claude", "codex", "all"].includes(client)) {
    process.stderr.write(`Invalid client "${client}". Expected claude, codex, or all.\n`);
    process.exitCode = 1;
    return;
  }

  // ISS-834: --skip-skill only has an effect on handleSetupCodex; silently
  // accepting it with --client claude would imply an effect it does not
  // have. Reject rather than no-op.
  if (client === "claude" && options.skipSkill) {
    process.stderr.write(
      '--skip-skill has no effect with --client claude; omit it or use --client codex/--client all.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (client === "claude" || client === "all") {
    await handleSetupClaude(options);
  }
  if (client === "all") log("");
  if (client === "codex" || client === "all") {
    await handleSetupCodex(options);
  }
}

export async function handleSetupSkill(options: SetupSkillOptions = {}): Promise<void> {
  await handleSetup({ ...options, client: "claude" });
}
