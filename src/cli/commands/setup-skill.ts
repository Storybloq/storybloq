import { mkdir, writeFile, readFile, rm, rename, unlink } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// PreCompact hook registration
// ---------------------------------------------------------------------------

const HOOK_COMMAND = "claudestory snapshot --quiet";

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
 * Check if a hook entry matches our canonical command.
 */
function isOurHook(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as HookEntry;
  return e.type === "command" && typeof e.command === "string" && e.command.trim() === HOOK_COMMAND;
}

/**
 * Registers a PreCompact hook in ~/.claude/settings.json (or custom path).
 *
 * - Idempotent: skips if already present
 * - Non-destructive: leaves file untouched on parse/type errors
 * - Atomic: writes to temp file, then renames
 *
 * Exported for testing — callers can override settingsPath.
 */
export async function registerPreCompactHook(settingsPath?: string): Promise<"registered" | "exists" | "skipped"> {
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

  // Type guard: PreCompact must be array
  if ("PreCompact" in hooks) {
    if (!Array.isArray(hooks.PreCompact)) {
      process.stderr.write(`${path} has unexpected hooks.PreCompact format — skipping hook registration.\n`);
      return "skipped";
    }
  } else {
    hooks.PreCompact = [];
  }

  const preCompact = hooks.PreCompact as unknown[];

  // Idempotency: scan for existing command (defensive — skip malformed entries)
  for (const group of preCompact) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (!Array.isArray(g.hooks)) continue;
    for (const entry of g.hooks) {
      if (isOurHook(entry)) return "exists";
    }
  }

  // Find existing empty-matcher group with valid hooks array, or create one
  const ourEntry: HookEntry = { type: "command", command: HOOK_COMMAND };

  let appended = false;
  for (const group of preCompact) {
    if (typeof group !== "object" || group === null) continue;
    const g = group as MatcherGroup;
    if (g.matcher === "" && Array.isArray(g.hooks)) {
      g.hooks.push(ourEntry);
      appended = true;
      break;
    }
  }

  if (!appended) {
    preCompact.push({ matcher: "", hooks: [ourEntry] });
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export interface SetupSkillOptions {
  skipHooks?: boolean;
}

/**
 * Installs the /story skill globally for Claude Code.
 *
 * 1. Writes SKILL.md and reference.md to ~/.claude/skills/story/
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

  let referenceWritten = false;
  const refSrcPath = join(srcSkillDir, "reference.md");
  if (existsSync(refSrcPath)) {
    const refContent = await readFile(refSrcPath, "utf-8");
    await writeFile(join(skillDir, "reference.md"), refContent, "utf-8");
    referenceWritten = true;
  }

  log(`${existed ? "Updated" : "Installed"} /story skill at ${skillDir}/`);
  if (referenceWritten) {
    log("  SKILL.md + reference.md written");
  } else {
    log("  SKILL.md written (reference.md not found — generate with `claudestory reference --format md`)");
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

  // PreCompact hook registration
  if (cliInPath && !skipHooks) {
    const result = await registerPreCompactHook();
    switch (result) {
      case "registered":
        log("  PreCompact hook registered — snapshots auto-taken before context compaction");
        break;
      case "exists":
        log("  PreCompact hook already configured");
        break;
      case "skipped":
        // Error already logged by registerPreCompactHook
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
