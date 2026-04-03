import { mkdir, writeFile, readFile, readdir, copyFile, rm, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const PRECOMPACT_HOOK_COMMAND = "claudestory session compact-prepare";
const LEGACY_PRECOMPACT_HOOK_COMMAND = "claudestory snapshot --quiet";
const SESSIONSTART_HOOK_COMMAND = "claudestory session resume-prompt";
const STOP_HOOK_COMMAND = "claudestory hook-status";

interface HookEntry {
  type: string;
  command?: string;
  [key: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks?: unknown[];
  [key: string]: unknown;
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
 */
export async function registerPreCompactHook(settingsPath?: string): Promise<"registered" | "exists" | "skipped"> {
  return registerHook("PreCompact", { type: "command", command: PRECOMPACT_HOOK_COMMAND }, settingsPath);
}

/**
 * Registers the SessionStart hook (resume prompt after compaction).
 * ISS-032: matcher "compact" matches source: "compact" in SessionStart hook input.
 */
export async function registerSessionStartHook(settingsPath?: string): Promise<"registered" | "exists" | "skipped"> {
  return registerHook("SessionStart", { type: "command", command: SESSIONSTART_HOOK_COMMAND }, settingsPath, "compact");
}

/**
 * Registers the Stop hook (status.json writer after every Claude response).
 */
export async function registerStopHook(settingsPath?: string): Promise<"registered" | "exists" | "skipped"> {
  return registerHook("Stop", { type: "command", command: STOP_HOOK_COMMAND, async: true }, settingsPath);
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
export async function handleSetupSkill(options: SetupSkillOptions = {}): Promise<void> {
  const { skipHooks = false } = options;
  const skillDir = join(homedir(), ".claude", "skills", "story");
  await mkdir(skillDir, { recursive: true });

  let srcSkillDir: string;
  try {
    srcSkillDir = resolveSkillSourceDir();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.stderr.write("This may indicate a corrupt installation. Try: npm install -g @anthropologies/claudestory\n");
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

  // Copy design/ subdirectory (frontend design skill)
  const designSrcDir = join(srcSkillDir, "design");
  if (existsSync(designSrcDir)) {
    const designDestDir = join(skillDir, "design");
    try {
      const designFiles = await copyDirRecursive(designSrcDir, designDestDir);
      for (const f of designFiles) writtenFiles.push(`design/${f}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Warning: design skill copy failed: ${msg}\n`);
      missingFiles.push("design/");
    }
  }

  log(`${existed ? "Updated" : "Installed"} /story skill at ${skillDir}/`);
  log(`  ${writtenFiles.join(" + ")} written`);
  if (missingFiles.length > 0) {
    process.stderr.write(`Warning: support file(s) not found in source: ${missingFiles.join(", ")}\n`);
    process.stderr.write("  This may indicate a corrupt installation. Try: npm install -g @anthropologies/claudestory\n");
  }

  // Attempt MCP registration — requires both `claudestory` and `claude` in PATH.
  let mcpRegistered = false;
  let cliInPath = false;
  try {
    execFileSync("claudestory", ["--version"], { stdio: "pipe", timeout: 5000 });
    cliInPath = true;
  } catch {
    // claudestory not in PATH
  }

  if (cliInPath) {
    try {
      execFileSync("claude", ["mcp", "add", "claudestory", "-s", "user", "--", "claudestory", "--mcp"], {
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
        log("  To register manually: claude mcp add claudestory -s user -- claudestory --mcp");
      } else {
        log("");
        log(`MCP registration failed: ${message.split("\n")[0]}`);
        log("  To register manually: claude mcp add claudestory -s user -- claudestory --mcp");
      }
    }
  } else {
    log("");
    log("MCP registration skipped — `claudestory` not found in PATH.");
    log("Install globally first, then register MCP:");
    log("  npm install -g @anthropologies/claudestory");
    log("  claude mcp add claudestory -s user -- claudestory --mcp");
  }

  // Hook registration (ISS-032: hook-driven compaction)
  if (cliInPath && !skipHooks) {
    // Migrate: remove legacy snapshot hook if present
    const legacyRemoved = await removeHook("PreCompact", LEGACY_PRECOMPACT_HOOK_COMMAND);
    if (legacyRemoved === "removed") {
      log("  Removed legacy PreCompact hook (snapshot --quiet)");
    }

    // PreCompact hook
    const precompactResult = await registerPreCompactHook();
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

    // SessionStart hook (compact matcher)
    const sessionStartResult = await registerSessionStartHook();
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

    // Stop hook
    const stopResult = await registerStopHook();
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
  } else if (!cliInPath) {
    // Hook registration skipped because CLI not in path — already logged above
  } else if (skipHooks) {
    log("  Hook registration skipped (--skip-hooks)");
  }

  log("");
  if (mcpRegistered) {
    log("Done! Restart Claude Code, then type /story in any project.");
  } else {
    log("Skill installed. After registering MCP, restart Claude Code and type /story.");
  }
}
