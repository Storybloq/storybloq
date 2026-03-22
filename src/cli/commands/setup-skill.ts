import { mkdir, writeFile, readFile } from "node:fs/promises";
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
 * Installs the /story skill globally for Claude Code.
 *
 * 1. Writes SKILL.md and reference.md to ~/.claude/skills/story/
 * 2. Attempts to register MCP server via `claude mcp add`
 * 3. Prints success message
 *
 * Idempotent — safe to re-run (overwrites with latest).
 */
export async function handleSetupSkill(): Promise<void> {
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
  // If run via npx without global install, `claudestory` won't be in PATH and
  // registering MCP would create a broken config pointing to a missing binary.
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
      const isNotFound = message.includes("ENOENT") || message.includes("not found");
      log("");
      if (isNotFound) {
        log("MCP registration skipped — `claude` CLI not found in PATH.");
      } else {
        log(`MCP registration failed: ${message.split("\n")[0]}`);
      }
      log("  To register manually: claude mcp add claudestory -s user -- claudestory --mcp");
    }
  } else {
    log("");
    log("MCP registration skipped — `claudestory` not found in PATH.");
    log("Install globally first, then register MCP:");
    log("  npm install -g @anthropologies/claudestory");
    log("  claude mcp add claudestory -s user -- claudestory --mcp");
  }

  log("");
  if (mcpRegistered) {
    log("Done! Restart Claude Code, then type /story in any project.");
  } else {
    log("Skill installed. After registering MCP, restart Claude Code and type /story.");
  }
}
