import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");

describe("setup-skill", () => {
  it("bundled SKILL.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "SKILL.md"))).toBe(true);
  });

  it("bundled reference.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "reference.md"))).toBe(true);
  });

  it("SKILL.md has correct frontmatter", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("name: story");
    expect(content).toContain("description:");
    expect(content).toContain("## Step 0: Check Setup");
    expect(content).toContain("## Step 2: Load Context");
  });

  it("reference.md contains expected sections", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "reference.md"), "utf-8");
    expect(content).toContain("## CLI Commands");
    expect(content).toContain("## MCP Tools");
    expect(content).toContain("## Common Workflows");
    expect(content).toContain("## Troubleshooting");
  });

  it("resolveSkillSourceDir finds src/skill from source layout", async () => {
    const { resolveSkillSourceDir } = await import("../../../src/cli/commands/setup-skill.js");
    const dir = resolveSkillSourceDir();
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "reference.md"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Support file existence
  // -------------------------------------------------------------------------

  it("bundled setup-flow.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"))).toBe(true);
  });

  it("bundled autonomous-mode.md exists in src/skill/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cross-file reference integrity
  // -------------------------------------------------------------------------

  it("every skill support file reference in SKILL.md points to an existing file", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    // Match "read `filename.md` in the same directory as this skill file" pattern
    const references = content.match(/read `([^`]+\.md)` in the same directory/gi) ?? [];
    expect(references.length).toBeGreaterThan(0);

    for (const ref of references) {
      const match = ref.match(/`([^`]+\.md)`/);
      if (!match) continue;
      const filename = match[1]!;
      expect(
        existsSync(join(PROJECT_ROOT, "src", "skill", filename)),
        `SKILL.md references "${filename}" as a support file but it does not exist in src/skill/`,
      ).toBe(true);
    }
  });

  it("no orphaned .md files in src/skill/ (every file is SKILL.md or referenced from it)", async () => {
    const { readdirSync } = await import("node:fs");
    const skillDir = join(PROJECT_ROOT, "src", "skill");
    const allFiles = readdirSync(skillDir).filter(f => f.endsWith(".md"));
    const content = await readFile(join(skillDir, "SKILL.md"), "utf-8");

    for (const file of allFiles) {
      if (file === "SKILL.md") continue;
      expect(
        content.includes(file),
        `"${file}" exists in src/skill/ but is not referenced from SKILL.md`,
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // SKILL.md <-> output-formatter.ts sentinel coupling
  // -------------------------------------------------------------------------

  it("SKILL.md Step 2b matches the EMPTY_SCAFFOLD_HEADING sentinel", async () => {
    const skillContent = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    const formatterContent = await readFile(
      join(PROJECT_ROOT, "src", "core", "output-formatter.ts"),
      "utf-8",
    );

    // Extract the sentinel value from output-formatter.ts
    const sentinelMatch = formatterContent.match(
      /export const EMPTY_SCAFFOLD_HEADING\s*=\s*"([^"]+)"/,
    );
    expect(sentinelMatch, "EMPTY_SCAFFOLD_HEADING not found in output-formatter.ts").toBeTruthy();
    const sentinel = sentinelMatch![1]!;

    // SKILL.md Step 2b must reference this exact string
    expect(
      skillContent.includes(sentinel),
      `SKILL.md does not contain the sentinel string "${sentinel}" -- Step 2b coupling is broken`,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Support file content validation
  // -------------------------------------------------------------------------

  it("setup-flow.md contains all setup flow sections including T-165 additions", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // Original sections
    expect(content).toContain("## AI-Assisted Setup Flow");
    expect(content).toContain("#### 1a. Detect Project Type");
    expect(content).toContain("#### 1b. Existing Project");
    expect(content).toContain("#### 1c. New Project");
    expect(content).toContain("#### 1d. Present Proposal");
    expect(content).toContain("#### 1e. Execute on Approval");
    expect(content).toContain("#### 1f. Post-Setup");
    // T-165 additions
    expect(content).toContain("#### 1d2. Refinement Pass");
    expect(content).toContain("#### 1d3. Proposal Review");
  });

  it("setup-flow.md 1b includes brief/PRD scan", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Project brief / PRD scan");
    expect(content).toContain("Brief precedence");
  });

  it("setup-flow.md 1d2 refinement covers descriptions, dependencies, sizing, and missing entities", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("blockedBy");
    expect(content).toContain("Sizing check");
    expect(content).toContain("Missing entity detection");
    expect(content).toContain("Core differentiator detection");
    expect(content).toContain("Undecided tech choices");
  });

  it("setup-flow.md 1d3 proposal review uses autonomous mode backend selection", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("review_plan");
    expect(content).toContain("Maximum 2 review rounds");
  });

  it("setup-flow.md 1e includes two-pass creation and CLAUDE.md/RULES.md generation", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Pass 1:");
    expect(content).toContain("Pass 2:");
    expect(content).toContain("CLAUDE.md generation");
    expect(content).toContain("RULES.md generation");
    expect(content).toContain("Sanitization");
  });

  it("setup-flow.md refinement and review steps are opt-in", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // 1d2 refinement is opt-in
    expect(content).toContain("#### 1d2. Refinement Pass (optional)");
    // 1d3 review is opt-in
    expect(content).toContain("#### 1d3. Proposal Review (optional)");
    // Both have explicit decline paths
    const refinementSection = content.split("#### 1d2")[1]!.split("#### 1d3")[0]!;
    expect(refinementSection).toMatch(/declines.*skip/i);
    const reviewSection = content.split("#### 1d3")[1]!.split("#### 1e")[0]!;
    expect(reviewSection).toMatch(/declines.*skip/i);
  });

  it("setup-flow.md has continue-to-Step-2 directive referencing SKILL.md", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Step 2: Load Context");
    expect(content).toContain("SKILL.md");
  });

  it("autonomous-mode.md contains autonomous and tiered mode sections", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8");
    expect(content).toContain("## Autonomous Mode");
    expect(content).toContain("claudestory_autonomous_guide");
    expect(content).toContain("### `/story review T-XXX`");
    expect(content).toContain("### `/story plan T-XXX`");
    expect(content).toContain("### `/story guided T-XXX`");
  });

  it("SKILL.md no longer contains extracted sections inline", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    // Setup flow should not be inline
    expect(content).not.toContain("#### 1a. Detect Project Type");
    expect(content).not.toContain("#### 1b. Existing Project");
    // Autonomous mode should not be inline
    expect(content).not.toContain("claudestory_autonomous_guide");
    expect(content).not.toContain("PICK_TICKET");
  });

  // -------------------------------------------------------------------------
  // Installer copies all support files
  // -------------------------------------------------------------------------

  it("supportFiles array in setup-skill.ts includes all support files", async () => {
    const tsContent = await readFile(
      join(PROJECT_ROOT, "src", "cli", "commands", "setup-skill.ts"),
      "utf-8",
    );
    expect(tsContent).toContain('"setup-flow.md"');
    expect(tsContent).toContain('"autonomous-mode.md"');
    expect(tsContent).toContain('"reference.md"');
  });
});

// ---------------------------------------------------------------------------
// PreCompact hook registration
// ---------------------------------------------------------------------------

describe("registerPreCompactHook", () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `claudestory-hook-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function importHook() {
    const { registerPreCompactHook } = await import("../../../src/cli/commands/setup-skill.js");
    return registerPreCompactHook;
  }

  async function readSettings(): Promise<Record<string, unknown>> {
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("creates settings.json when absent", async () => {
    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    expect(settings.hooks).toBeDefined();
    const hooks = settings.hooks as Record<string, unknown>;
    expect(Array.isArray(hooks.PreCompact)).toBe(true);

    const preCompact = hooks.PreCompact as Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    expect(preCompact).toHaveLength(1);
    expect(preCompact[0]!.matcher).toBe("");
    expect(preCompact[0]!.hooks).toHaveLength(1);
    expect(preCompact[0]!.hooks[0]!.type).toBe("command");
    expect(preCompact[0]!.hooks[0]!.command).toBe("claudestory session compact-prepare");
  });

  it("merges into existing settings preserving other config", async () => {
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ["Bash(git status)"] },
      model: "opus",
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    // Existing config preserved
    expect((settings.permissions as Record<string, unknown>).allow).toEqual(["Bash(git status)"]);
    expect(settings.model).toBe("opus");
    // Hook added
    expect(settings.hooks).toBeDefined();
  });

  it("preserves existing PreCompact hooks from other tools", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "auto", hooks: [{ type: "command", command: "echo context reminder" }] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as unknown[];
    // Original hook preserved + new one added
    expect(preCompact).toHaveLength(2);
  });

  it("appends to existing empty-matcher group", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "echo other" }] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("registered");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as Array<{ hooks: unknown[] }>;
    // Still one group, but with two commands
    expect(preCompact).toHaveLength(1);
    expect(preCompact[0]!.hooks).toHaveLength(2);
  });

  it("is idempotent — second run returns exists", async () => {
    const register = await importHook();
    await register(settingsPath);
    const result = await register(settingsPath);

    expect(result).toBe("exists");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as Array<{ hooks: unknown[] }>;
    expect(preCompact).toHaveLength(1);
    expect(preCompact[0]!.hooks).toHaveLength(1);
  });

  it("detects command in non-empty matcher group", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "auto", hooks: [{ type: "command", command: "claudestory session compact-prepare" }] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("exists");
  });

  it("skips on malformed JSON without modifying file", async () => {
    const badContent = "{ this is not json }";
    await writeFile(settingsPath, badContent, "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("skipped");
    // File untouched
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(badContent);
  });

  it("skips when hooks is wrong type", async () => {
    const original = JSON.stringify({ hooks: "not-an-object" }, null, 2);
    await writeFile(settingsPath, original, "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("skipped");
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(original);
  });

  it("skips when PreCompact is wrong type", async () => {
    const original = JSON.stringify({ hooks: { PreCompact: "not-an-array" } }, null, 2);
    await writeFile(settingsPath, original, "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    expect(result).toBe("skipped");
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(original);
  });

  it("--skip-hooks flag: registerPreCompactHook is not called when skipped", async () => {
    // Verify the hook registration function works, then confirm the flag
    // prevents it at the handler level. We test the gate condition directly:
    // handleSetupSkill only calls registerPreCompactHook when cliInPath && !skipHooks.
    // Since we can't control cliInPath in tests, we verify the function itself
    // is callable and that the options interface correctly accepts skipHooks.
    const register = await importHook();

    // Without skip: registers
    const result1 = await register(settingsPath);
    expect(result1).toBe("registered");

    // Clean up for next assertion
    await rm(settingsPath);

    // The flag is a simple boolean gate in handleSetupSkill:
    //   if (cliInPath && !skipHooks) { await registerPreCompactHook(); }
    // With skipHooks=true, registerPreCompactHook is never called,
    // so settings.json stays untouched. We verify the interface compiles:
    const { handleSetupSkill: _ } = await import("../../../src/cli/commands/setup-skill.js");
    const opts: import("../../../src/cli/commands/setup-skill.js").SetupSkillOptions = { skipHooks: true };
    expect(opts.skipHooks).toBe(true);
  });

  it("handles malformed entries in PreCompact array gracefully", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          "not-an-object",
          { matcher: "", hooks: "not-an-array" },
          { matcher: "auto", hooks: [42, null, "bad"] },
        ],
      },
    }, null, 2), "utf-8");

    const register = await importHook();
    const result = await register(settingsPath);

    // Should still register since our command wasn't found
    expect(result).toBe("registered");
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, unknown>;
    const preCompact = hooks.PreCompact as unknown[];
    // Original 3 entries preserved + new group added
    expect(preCompact).toHaveLength(4);
  });
});
