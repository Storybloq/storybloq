import { mkdir, writeFile, readFile, readdir, copyFile, rm, rename, unlink } from "node:fs/promises";
import { existsSync, accessSync, readdirSync, constants as fsConstants } from "node:fs";
import { join, dirname, delimiter as pathDelimiter } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PRECOMPACT_SUBCOMMAND,
  SESSIONSTART_SUBCOMMAND,
  STOP_SUBCOMMAND,
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
 * Recursively copies a directory tree from src to dest.
 * Copies to a temp dir first, then atomically swaps to avoid partial installs.
 * Uses withFileTypes to skip directories (cross-platform) and copyFile (binary-safe).
 */
export async function copyDirRecursive(srcDir: string, destDir: string): Promise<string[]> {
  const tmpDir = destDir + ".tmp";
  const bakDir = destDir + ".bak";
  // Recover from a previous crash: if destDir is gone but bakDir exists, restore it
  if (!existsSync(destDir) && existsSync(bakDir)) {
    await rename(bakDir, destDir);
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
  if (existsSync(destDir)) {
    await rename(destDir, bakDir);
  }
  try {
    await rename(tmpDir, destDir);
  } catch (err) {
    // Restore backup if rename fails
    if (existsSync(bakDir)) await rename(bakDir, destDir).catch(() => {});
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

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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
): Promise<"registered" | "exists" | "skipped"> {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");

  // Read existing settings
  let raw = "{}";
  if (existsSync(path)) {
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      process.stderr.write(`Could not read ${path} — skipping hook registration.\n`);
      return "skipped";
    }
  }

  // Parse
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
      process.stderr.write(`${path} is not a JSON object — skipping hook registration.\n`);
      return "skipped";
    }
  } catch {
    process.stderr.write(`${path} contains invalid JSON — skipping hook registration.\n`);
    process.stderr.write("  Fix the file manually or delete it to reset.\n");
    return "skipped";
  }

  // Type guard: hooks must be object
  if ("hooks" in settings) {
    if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
      process.stderr.write(`${path} has unexpected hooks format — skipping hook registration.\n`);
      return "skipped";
    }
  } else {
    settings.hooks = {};
  }

  const hooks = settings.hooks as Record<string, unknown>;

  // Type guard: hook type must be array
  if (hookType in hooks) {
    if (!Array.isArray(hooks[hookType])) {
      process.stderr.write(`${path} has unexpected hooks.${hookType} format — skipping hook registration.\n`);
      return "skipped";
    }
  } else {
    hooks[hookType] = [];
  }

  const hookArray = hooks[hookType] as unknown[];

  // Idempotency: scan for existing command (defensive — skip malformed entries)
  const hookCommand = hookEntry.command;
  if (hookCommand) {
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      for (const entry of g.hooks) {
        if (isHookWithCommand(entry, hookCommand)) return "exists";
      }
    }
  }

  // Find existing matcher group with valid hooks array, or create one
  const targetMatcher = matcher ?? "";
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

  // Atomic write: temp file + rename
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await rename(tmpPath, path);
  } catch (err: unknown) {
    // Clean up temp file on failure
    try { await unlink(tmpPath); } catch { /* ignore */ }
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
 * Removes a hook command from settings.json. Used for migration (ISS-032).
 */
export async function removeHook(
  hookType: string,
  command: string,
  settingsPath?: string,
): Promise<"removed" | "not_found" | "skipped"> {
  const path = settingsPath ?? join(homedir(), ".claude", "settings.json");

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

  // Atomic write
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await rename(tmpPath, path);
  } catch {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    return "skipped";
  }

  return "removed";
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export interface SetupSkillOptions {
  skipHooks?: boolean;
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

/**
 * Installs the /story skill globally for Claude Code.
 *
 * 1. Writes SKILL.md + support files (setup-flow.md, autonomous-mode.md, reference.md) to ~/.claude/skills/story/
 * 2. Attempts to register MCP server via `claude mcp add`
 * 3. Optionally registers PreCompact hook in ~/.claude/settings.json
 * 4. Prints success message
 *
 * Idempotent — safe to re-run (overwrites with latest).
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

  const supportFiles = ["setup-flow.md", "autonomous-mode.md", "reference.md"];
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
  try {
    const { writeSkillMarker } = await import("../../core/skill-version-marker.js");
    const pkgJson = JSON.parse(
      await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8")
    ) as { version?: string };
    if (pkgJson.version) writeSkillMarker(pkgJson.version);
  } catch {
    // Marker write is best-effort; skill still works without it.
  }

  log(`${existed ? "Updated" : "Installed"} /story skill at ${skillDir}/`);
  log(`  ${writtenFiles.join(" + ")} written`);
  if (missingFiles.length > 0) {
    process.stderr.write(`Warning: support file(s) not found in source: ${missingFiles.join(", ")}\n`);
    process.stderr.write("  This may indicate a corrupt installation. Try: npm install -g @storybloq/storybloq@latest\n");
  }

  // Attempt MCP registration — requires both `storybloq` and `claude` in PATH.
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
        log("MCP registration skipped — `claude` CLI not found in PATH.");
        log("  To register manually: claude mcp add storybloq -s user -- storybloq --mcp");
      } else {
        log("");
        log(`MCP registration failed: ${message.split("\n")[0]}`);
        log("  To register manually: claude mcp add storybloq -s user -- storybloq --mcp");
      }
    }
  } else {
    log("");
    log("MCP registration skipped — `storybloq` not found in PATH.");
    log("Install globally first, then register MCP:");
    log("  npm install -g @storybloq/storybloq@latest");
    log("  claude mcp add storybloq -s user -- storybloq --mcp");
  }

  // Hook registration (ISS-032: hook-driven compaction; ISS-560: absolute bin path)
  // Gate on `resolveStorybloqBin()` — Claude Code hooks run under a shell
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

    const precompactResult = await registerPreCompactHook(undefined, resolvedBin);
    switch (precompactResult) {
      case "registered":
        log("  PreCompact hook registered — session compact preparation before context compaction");
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
        log("  SessionStart hook registered — resume prompt after compaction");
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
        log("  Stop hook registered — status.json updated after every Claude response");
        break;
      case "exists":
        log("  Stop hook already configured");
        break;
      case "skipped":
        break;
    }
  } else if (skipHooks) {
    log("  Hook registration skipped (--skip-hooks)");
  } else {
    log("");
    log("Hook registration skipped — `storybloq` binary not found.");
    log("Install globally first, then re-run setup-skill:");
    log("  npm install -g @storybloq/storybloq@latest");
    log("  storybloq setup-skill");
  }

  log("");
  if (mcpRegistered) {
    log("Done! Restart Claude Code, then type /story in any project.");
  } else {
    log("Skill installed. After registering MCP, restart Claude Code and type /story.");
  }
}

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

function codexHooksPath(): string {
  return join(codexHome(), "hooks.json");
}

function codexConfigPath(): string {
  return join(codexHome(), "config.toml");
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

  const tmpPath = `${configPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(tmpPath, next, "utf-8");
    await rename(tmpPath, configPath);
  } catch (err: unknown) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
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

  const tmpPath = `${configPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(tmpPath, next, "utf-8");
    await rename(tmpPath, configPath);
  } catch (err: unknown) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to write Codex config.toml: ${message}\n`);
    return "skipped";
  }

  return "updated";
}

export async function migrateCodexHookVariants(
  hookType: "SessionStart" | "Stop",
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
    removedCount += before - g.hooks.length;
  }

  if (removedCount === 0) return 0;

  const tmpPath = `${hooksPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await rename(tmpPath, hooksPath);
  } catch {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    return 0;
  }

  return removedCount;
}

export async function registerCodexHook(
  hookType: "SessionStart" | "Stop",
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
  if (hookCommand) {
    for (const group of hookArray) {
      if (typeof group !== "object" || group === null) continue;
      const g = group as MatcherGroup;
      if (!Array.isArray(g.hooks)) continue;
      for (const entry of g.hooks) {
        if (isHookWithCommand(entry, hookCommand)) return "exists";
      }
    }
  }

  const targetMatcher = matcher ?? "";
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

  const tmpPath = `${hooksPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await rename(tmpPath, hooksPath);
  } catch (err: unknown) {
    try { await unlink(tmpPath); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Failed to write Codex hooks.json: ${message}\n`);
    return "skipped";
  }

  return "registered";
}

async function handleSetupCodex(options: SetupSkillOptions = {}): Promise<void> {
  const { skipHooks = false } = options;

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

  const skillDir = join(homedir(), ".agents", "skills", "story");
  const existed = existsSync(join(skillDir, "SKILL.md"));
  const writtenFiles = await copyDirRecursive(srcSkillDir, skillDir);
  log(`${existed ? "Updated" : "Installed"} $story skill at ${skillDir}/`);
  log(`  ${writtenFiles.join(" + ")} written`);

  const compatSkillDir = join(codexHome(), "skills", "story");
  if (existsSync(join(compatSkillDir, "SKILL.md"))) {
    const compatFiles = await copyDirRecursive(srcSkillDir, compatSkillDir);
    log(`  Refreshed existing Codex skill copy at ${compatSkillDir}/ (${compatFiles.length} files)`);
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
      log("  If hooks do not run, add [features] codex_hooks = true to ~/.codex/config.toml.");
    }
  } catch {
    // codex not in PATH
  }

  if (cliInPath && codexInPath) {
    let mcpReadyForConfig = false;
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
    const sessionStartCmd = formatCodexSessionStartCommand(resolvedBin);
    const stopCmd = formatHookCommand(resolvedBin, STOP_SUBCOMMAND);
    const migratedStart = await migrateCodexHookVariants(
      "SessionStart",
      [SESSIONSTART_SUBCOMMAND, `${SESSIONSTART_SUBCOMMAND} --codex-hook-json`],
      sessionStartCmd,
    );
    if (migratedStart > 0) log(`  Migrated ${migratedStart} stale Codex SessionStart hook entr${migratedStart === 1 ? "y" : "ies"}`);
    const migratedStop = await migrateCodexHookVariants("Stop", [STOP_SUBCOMMAND], stopCmd);
    if (migratedStop > 0) log(`  Migrated ${migratedStop} stale Codex Stop hook entr${migratedStop === 1 ? "y" : "ies"}`);

    const sessionStartResult = await registerCodexHook(
      "SessionStart",
      { type: "command", command: sessionStartCmd, statusMessage: "Loading Storybloq session" },
      undefined,
      "startup|resume|clear",
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
