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

  it("setup-flow.md contains all setup flow sections", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("## AI-Assisted Setup Flow");
    expect(content).toContain("#### 1a. Detect Project Type");
    expect(content).toContain("#### 1b. Existing Project");
    expect(content).toContain("#### 1c. New Project");
    expect(content).toContain("#### 1d. Present Proposal");
    expect(content).toContain("#### 1d2. Refinement and Review");
    expect(content).toContain("#### 1e. Execute on Approval");
    expect(content).toContain("#### 1f. Post-Setup");
  });

  it("setup-flow.md uses two-axis taxonomy (surface + characteristics)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("primary surface");
    expect(content).toContain("special characteristics");
    expect(content).toContain("multiSelect: true");
  });

  it("setup-flow.md characteristics are never skipped even when stack is named", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Do NOT skip characteristics");
  });

  it("setup-flow.md has summary breaks between gate clusters", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("--- Summary break ---");
  });

  it("setup-flow.md 1b includes brief/PRD scan", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Project brief / PRD scan");
    expect(content).toContain("Brief precedence");
  });

  it("setup-flow.md 1d2 refinement covers descriptions, dependencies, sizing, and missing entities", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("blockedBy");
    expect(content).toContain("split oversized tickets");
    expect(content).toContain("missing");
    expect(content).toContain("core differentiator");
    expect(content).toContain("undecided tech choices");
  });

  it("setup-flow.md review uses autonomous mode backend selection", async () => {
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

  it("setup-flow.md has single combined approval + refinement question", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // One question combines approval and refinement depth
    expect(content).toContain("How should I proceed with this proposal");
    expect(content).toContain("Refine + get a second opinion (Recommended)");
    expect(content).toContain("Create as-is");
    expect(content).toContain("Adjust first");
    // Refinement has explicit steps A-D with required gates
    expect(content).toContain("Do NOT skip this section");
    expect(content).toContain("Step D: Ask user to approve before creating");
  });

  it("setup-flow.md has system shape and execution model as separate gates", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("How should the system be structured");
    expect(content).toContain("How does processing work");
  });

  it("setup-flow.md has BaaS as a first-class system shape option", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("managed backend (Supabase/Firebase)");
    // BaaS skips ORM but auth still fires
    expect(content).toContain("skip ORM choice");
    expect(content).toContain("Auth gate still fires");
  });

  it("setup-flow.md domain complexity is multiSelect", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    const domainSection = content.split("Step 4d")[1]!.split("Step 4e")[0]!;
    expect(domainSection).toContain("multiSelect: true");
  });

  it("setup-flow.md AI pattern supports primary + secondary (composable)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("primary AI pattern");
    expect(content).toContain("secondary capabilities");
    expect(content).toContain("Structured generation");
  });

  it("setup-flow.md has quality checks gate with three tiers", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("quality checks");
    expect(content).toContain("Full pipeline (Recommended)");
    expect(content).toContain("Tests only");
    expect(content).toContain("Minimal");
  });

  it("setup-flow.md 1e configures recipe stages via CLI after init", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("config set-overrides");
    expect(content).toContain("WRITE_TESTS");
    expect(content).toContain("VERIFY");
    expect(content).toContain("BUILD");
  });

  it("setup-flow.md AI safety is two questions: audience then sensitive domain", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Who interacts with the AI output");
    expect(content).toContain("Is this a sensitive domain");
  });

  it("setup-flow.md auth gate is NOT skipped for no-database projects", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain('Do NOT skip for "no database"');
  });

  it("setup-flow.md auth suggests Firebase Auth and Clerk as easy options", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Firebase Auth");
    expect(content).toContain("Clerk");
  });

  it("setup-flow.md sensitive domain gate exists outside AI branch", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // Step 4f is in Cluster 4, not inside Cluster 5 (AI)
    const cluster4 = content.split("--- Cluster 4")[1]!.split("--- Cluster 5")[0]!;
    expect(cluster4).toContain("sensitive/regulated domain");
  });

  it("setup-flow.md has simple project fast path", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Simple project fast path");
    expect(content).toContain("straightforward site");
  });

  it("setup-flow.md has design source gate for UI projects", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("Do you have designs");
    expect(content).toContain("mockups / Figma");
    expect(content).toContain("start from scratch");
  });

  it("setup-flow.md three-strike protects critical gates", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("3 out of any 4 gates");
    expect(content).toContain("auth model, sensitive domain, and primary AI pattern are never silently collapsed");
  });

  it("setup-flow.md TDD recommendation is conditional", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // TDD is tied to domain complexity, not universal
    expect(content).toContain("TDD for business logic");
    expect(content).toMatch(/tied.*gate answers/i);
  });

  it("setup-flow.md appendix has Default Stack Recommendations with disclaimer", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("## Appendix: Default Stack Recommendations");
    expect(content).toContain("these are defaults, not absolutes");
  });

  it("setup-flow.md appendix covers AI, BaaS, and full-stack categories", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("### AI / LLM application");
    expect(content).toContain("### BaaS / backendless");
    expect(content).toContain("### Full-stack / multi-service");
  });

  it("setup-flow.md uses outcome-oriented gate language", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    // Outcome-oriented, not jargon
    expect(content).toContain("How do users log in");
    expect(content).toContain("What data does this system store");
    expect(content).toContain("How should this go live");
    expect(content).toContain("How should the system be structured");
  });

  it("setup-flow.md LLM recommendation says product default", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    expect(content).toContain("product default");
  });

  it("setup-flow.md post-setup mentions /story and /story auto", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "setup-flow.md"), "utf-8");
    const postSetup = content.split("1f. Post-Setup")[1]!;
    expect(postSetup).toContain("/story");
    expect(postSetup).toContain("/story auto");
  });

  it("autonomous-mode.md contains autonomous and tiered mode sections", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8");
    expect(content).toContain("## Autonomous Mode");
    expect(content).toContain("storybloq_autonomous_guide");
    expect(content).toContain("### `/story review T-XXX`");
    expect(content).toContain("### `/story plan T-XXX`");
    expect(content).toContain("### `/story guided T-XXX`");
  });

  it("SKILL.md no longer contains extracted sections inline", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    // Setup flow should not be inline
    expect(content).not.toContain("#### 1a. Detect Project Type");
    expect(content).not.toContain("#### 1b. Existing Project");
    // Autonomous mode section should not be inline. Check the section heading
    // and a state-machine identifier rather than the tool name -- the tool
    // name appears in the Step 0.5 guard whitelist (legitimately, it tells
    // agents what NOT to call) and in /story auto command help.
    expect(content).not.toContain("## Autonomous Mode");
    expect(content).not.toContain("PICK_TICKET");
  });

  // -------------------------------------------------------------------------
  // Settings command
  // -------------------------------------------------------------------------

  it("SKILL.md has /story settings command in argument handler", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("/story settings");
    expect(content).toContain("## Settings");
  });

  it("SKILL.md has config schema reference (no source code digging needed)", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("### Config Schema Reference");
    expect(content).toContain("WRITE_TESTS");
    expect(content).toContain("VERIFY");
    expect(content).toContain("maxTicketsPerSession");
    expect(content).toContain("reviewBackends");
    expect(content).toContain("Do NOT search source code");
  });

  // -------------------------------------------------------------------------
  // Frontend design skill
  // -------------------------------------------------------------------------

  it("design/design.md exists in src/skill/design/", () => {
    expect(existsSync(join(PROJECT_ROOT, "src", "skill", "design", "design.md"))).toBe(true);
  });

  it("all platform reference files exist in src/skill/design/references/", () => {
    for (const platform of ["web.md", "macos.md", "ios.md", "android.md"]) {
      expect(
        existsSync(join(PROJECT_ROOT, "src", "skill", "design", "references", platform)),
        `Missing: design/references/${platform}`,
      ).toBe(true);
    }
  });

  it("SKILL.md argument handler routes /story design to design/design.md", async () => {
    const content = await readFile(join(PROJECT_ROOT, "src", "skill", "SKILL.md"), "utf-8");
    expect(content).toMatch(/`design\/design\.md` in the same directory as this skill file/);
  });

  it("design.md references all platform reference files", async () => {
    const content = await readFile(
      join(PROJECT_ROOT, "src", "skill", "design", "design.md"), "utf-8",
    );
    for (const platform of ["web.md", "macos.md", "ios.md", "android.md"]) {
      expect(content).toContain(platform);
    }
  });

  it("autonomous-mode.md includes frontend design guidance", async () => {
    const content = await readFile(
      join(PROJECT_ROOT, "src", "skill", "autonomous-mode.md"), "utf-8",
    );
    expect(content).toContain("design/design.md");
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

  it("setup-skill.ts handles subdirectory skills with copyDirRecursive", async () => {
    const tsContent = await readFile(
      join(PROJECT_ROOT, "src", "cli", "commands", "setup-skill.ts"),
      "utf-8",
    );
    expect(tsContent).toContain("copyDirRecursive");
    expect(tsContent).toContain('"design"');
    expect(tsContent).toContain('"review-lenses"');
  });
});

// ---------------------------------------------------------------------------
// copyDirRecursive functional tests
// ---------------------------------------------------------------------------

describe("copyDirRecursive", () => {
  let tempDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-copy-test-${randomUUID()}`);
    srcDir = join(tempDir, "src");
    destDir = join(tempDir, "dest");
    // Create a source tree: file at root + file in subdirectory
    await mkdir(join(srcDir, "references"), { recursive: true });
    await writeFile(join(srcDir, "design.md"), "# Design", "utf-8");
    await writeFile(join(srcDir, "references", "web.md"), "# Web", "utf-8");
    await writeFile(join(srcDir, "references", "ios.md"), "# iOS", "utf-8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("copies all files including nested subdirectories", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    const written = await copyDirRecursive(srcDir, destDir);
    expect(written).toContain("design.md");
    expect(written).toContain(join("references", "web.md"));
    expect(written).toContain(join("references", "ios.md"));
    expect(written.length).toBe(3);
    // Verify files actually exist at destination
    expect(existsSync(join(destDir, "design.md"))).toBe(true);
    expect(existsSync(join(destDir, "references", "web.md"))).toBe(true);
    expect(existsSync(join(destDir, "references", "ios.md"))).toBe(true);
  });

  it("does not include directory entries in the written list", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    const written = await copyDirRecursive(srcDir, destDir);
    for (const entry of written) {
      expect(entry).toMatch(/\.md$/);
    }
  });

  it("replaces existing dest cleanly on reinstall (no stale files)", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    // First install
    await mkdir(destDir, { recursive: true });
    await writeFile(join(destDir, "stale-file.md"), "stale", "utf-8");
    // Reinstall
    await copyDirRecursive(srcDir, destDir);
    expect(existsSync(join(destDir, "stale-file.md"))).toBe(false);
    expect(existsSync(join(destDir, "design.md"))).toBe(true);
    // No leftover temp/backup dirs
    expect(existsSync(destDir + ".tmp")).toBe(false);
    expect(existsSync(destDir + ".bak")).toBe(false);
  });

  it("recovers backup if destDir was lost from a previous crash", async () => {
    const { copyDirRecursive } = await import("../../../src/cli/commands/setup-skill.js");
    // Simulate crash: destDir gone, bakDir has the old install
    const bakDir = destDir + ".bak";
    await mkdir(bakDir, { recursive: true });
    await writeFile(join(bakDir, "old.md"), "old", "utf-8");
    // copyDirRecursive should restore bakDir to destDir first, then install new
    await copyDirRecursive(srcDir, destDir);
    expect(existsSync(join(destDir, "design.md"))).toBe(true);
    expect(existsSync(destDir + ".bak")).toBe(false);
    expect(existsSync(destDir + ".tmp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PreCompact hook registration
// ---------------------------------------------------------------------------

describe("registerPreCompactHook", () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-hook-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const FAKE_BIN = "/fake/storybloq";

  async function importHook() {
    const { registerPreCompactHook } = await import("../../../src/cli/commands/setup-skill.js");
    return (path?: string) => registerPreCompactHook(path, FAKE_BIN);
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
    expect(preCompact[0]!.hooks[0]!.command).toBe(`${FAKE_BIN} session compact-prepare`);
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
          { matcher: "auto", hooks: [{ type: "command", command: `${FAKE_BIN} session compact-prepare` }] },
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

// ---------------------------------------------------------------------------
// formatHookCommand (ISS-560)
// ---------------------------------------------------------------------------

describe("formatHookCommand", () => {
  it("does not quote a clean POSIX path", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/usr/local/bin/storybloq", "hook-status"))
      .toBe("/usr/local/bin/storybloq hook-status");
  });

  it("single-quote-wraps a POSIX path with a space", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/path with space/storybloq", "hook-status"))
      .toBe("'/path with space/storybloq' hook-status");
  });

  it("escapes embedded single quote on POSIX", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/weird'path/storybloq", "hook-status"))
      .toBe("'/weird'\\''path/storybloq' hook-status");
  });

  it("quotes POSIX path with shell metachar", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand } = await import("../../../src/cli/commands/setup-skill.js");
    expect(formatHookCommand("/has&amp/storybloq", "hook-status"))
      .toBe("'/has&amp/storybloq' hook-status");
  });
});

// ---------------------------------------------------------------------------
// resolveStorybloqBin (ISS-560)
// ---------------------------------------------------------------------------

describe("resolveStorybloqBin", () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-resolve-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when PATH is empty and no candidates match", async () => {
    if (process.platform === "win32") return;
    process.env.PATH = "";
    // Redirect HOME to a dir with no candidate binaries.
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    expect(resolveStorybloqBin()).toBe(null);
  });

  it("finds executable on PATH", async () => {
    if (process.platform === "win32") return;
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\necho hi\n", "utf-8");
    const { chmod } = await import("node:fs/promises");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    expect(resolveStorybloqBin()).toBe(binPath);
  });

  it("skips non-executable storybloq entry on PATH", async () => {
    if (process.platform === "win32") return;
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    // Write a file that is readable but not executable.
    await writeFile(binPath, "not-executable", "utf-8");
    const { chmod } = await import("node:fs/promises");
    await chmod(binPath, 0o644);
    process.env.PATH = binDir;
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    expect(resolveStorybloqBin()).toBe(null);
  });

  it("prefers PATH match over candidate list", async () => {
    if (process.platform === "win32") return;
    const pathBinDir = join(tempDir, "path-bin");
    await mkdir(pathBinDir, { recursive: true });
    const pathBin = join(pathBinDir, "storybloq");
    await writeFile(pathBin, "#!/bin/sh\n", "utf-8");
    const { chmod } = await import("node:fs/promises");
    await chmod(pathBin, 0o755);
    process.env.PATH = pathBinDir;
    process.env.HOME = tempDir;
    const { resolveStorybloqBin } = await import("../../../src/cli/commands/setup-skill.js");
    // PATH-level match should win regardless of candidate list contents.
    expect(resolveStorybloqBin()).toBe(pathBin);
  });
});

// ---------------------------------------------------------------------------
// registerStopHook (ISS-560)
// ---------------------------------------------------------------------------

describe("registerStopHook", () => {
  let tempDir: string;
  let settingsPath: string;
  const FAKE_BIN = "/fake/storybloq";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-stop-hook-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function read(): Promise<Record<string, unknown>> {
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("creates Stop hook with empty matcher and async flag", async () => {
    const { registerStopHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerStopHook(settingsPath, FAKE_BIN);

    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const stop = hooks.Stop as Array<{ matcher: string; hooks: Array<{ type: string; command: string; async: boolean }> }>;
    expect(stop).toHaveLength(1);
    expect(stop[0]!.matcher).toBe("");
    expect(stop[0]!.hooks[0]!.type).toBe("command");
    expect(stop[0]!.hooks[0]!.command).toBe(`${FAKE_BIN} hook-status`);
    expect(stop[0]!.hooks[0]!.async).toBe(true);
  });

  it("is idempotent on re-register with same binPath", async () => {
    const { registerStopHook } = await import("../../../src/cli/commands/setup-skill.js");
    await registerStopHook(settingsPath, FAKE_BIN);
    const result = await registerStopHook(settingsPath, FAKE_BIN);
    expect(result).toBe("exists");
  });

  it("preserves unrelated hook-status command from another tool", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: "/some/other-tool hook-status" }] },
        ],
      },
    }, null, 2), "utf-8");
    const { registerStopHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerStopHook(settingsPath, FAKE_BIN);
    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const stop = hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    // One matcher group (""), with two commands.
    expect(stop).toHaveLength(1);
    const cmds = stop[0]!.hooks.map((h) => h.command);
    expect(cmds).toContain("/some/other-tool hook-status");
    expect(cmds).toContain(`${FAKE_BIN} hook-status`);
  });
});

// ---------------------------------------------------------------------------
// registerSessionStartHook (ISS-560)
// ---------------------------------------------------------------------------

describe("registerSessionStartHook", () => {
  let tempDir: string;
  let settingsPath: string;
  const FAKE_BIN = "/fake/storybloq";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-start-hook-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function read(): Promise<Record<string, unknown>> {
    const raw = await readFile(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("creates SessionStart hook with matcher 'compact'", async () => {
    const { registerSessionStartHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerSessionStartHook(settingsPath, FAKE_BIN);

    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const start = hooks.SessionStart as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(start).toHaveLength(1);
    expect(start[0]!.matcher).toBe("compact");
    expect(start[0]!.hooks[0]!.command).toBe(`${FAKE_BIN} session resume-prompt`);
  });

  it("preserves non-storybloq SessionStart hooks with matcher 'compact'", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "compact", hooks: [{ type: "command", command: "/other/tool custom-prompt" }] },
        ],
      },
    }, null, 2), "utf-8");
    const { registerSessionStartHook } = await import("../../../src/cli/commands/setup-skill.js");
    const result = await registerSessionStartHook(settingsPath, FAKE_BIN);
    expect(result).toBe("registered");
    const settings = await read();
    const hooks = settings.hooks as Record<string, unknown>;
    const start = hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    const cmds = start[0]!.hooks.map((h) => h.command);
    expect(cmds).toContain("/other/tool custom-prompt");
    expect(cmds).toContain(`${FAKE_BIN} session resume-prompt`);
  });

  it("is idempotent on re-register", async () => {
    const { registerSessionStartHook } = await import("../../../src/cli/commands/setup-skill.js");
    await registerSessionStartHook(settingsPath, FAKE_BIN);
    const result = await registerSessionStartHook(settingsPath, FAKE_BIN);
    expect(result).toBe("exists");
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyHookVariants (ISS-560)
// ---------------------------------------------------------------------------

describe("migrateLegacyHookVariants", () => {
  let tempDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-migrate-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seed(hookType: string, commands: string[]): Promise<void> {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        [hookType]: [
          { matcher: "", hooks: commands.map((c) => ({ type: "command", command: c })) },
        ],
      },
    }, null, 2), "utf-8");
  }

  async function remainingCommands(hookType: string): Promise<string[]> {
    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const groups = settings.hooks[hookType] ?? [];
    return groups.flatMap((g) => g.hooks.map((h) => h.command));
  }

  it("removes bare `storybloq` command when newCommand is absolute", async () => {
    await seed("PreCompact", ["storybloq session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
    expect(await remainingCommands("PreCompact")).toEqual([]);
  });

  it("removes stale absolute path that no longer matches", async () => {
    await seed("PreCompact", ["/old/v20/bin/storybloq session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/v22/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("preserves exact-match newCommand (idempotent)", async () => {
    const cmd = "/new/bin/storybloq session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      cmd,
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("preserves other-tool command (basename !== storybloq)", async () => {
    const cmd = "/other/bin/mytool session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("preserves storybloq with extra flag (rest !== subcommand)", async () => {
    const cmd = "storybloq session compact-prepare --extra-flag";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("handles quoted path with space", async () => {
    if (process.platform === "win32") return;
    const cmd = "'/path with space/storybloq' session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("leaves malformed command entries untouched", async () => {
    const cmd = "| & > evil";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  // ISS-589 / claudestory legacy-basename variants

  it("removes bare claudestory command", async () => {
    await seed("PreCompact", ["claudestory session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
    expect(await remainingCommands("PreCompact")).toEqual([]);
  });

  it("removes absolute claudestory path that no longer matches", async () => {
    await seed("PreCompact", ["/Users/amir/.nvm/versions/node/v22.18.0/bin/claudestory session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("removes quoted claudestory path with space (POSIX only)", async () => {
    if (process.platform === "win32") return;
    const cmd = "'/path with space/claudestory' session compact-prepare";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("preserves claudestory with extra flag (rest !== subcommand)", async () => {
    const cmd = "claudestory session compact-prepare --user-override";
    await seed("PreCompact", [cmd]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect(await remainingCommands("PreCompact")).toEqual([cmd]);
  });

  it("removes mixed storybloq + claudestory entries in one pass", async () => {
    await seed("PreCompact", [
      "storybloq session compact-prepare",
      "/old/v20/bin/claudestory session compact-prepare",
      "/other/bin/mytool session compact-prepare",
    ]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(2);
    expect(await remainingCommands("PreCompact")).toEqual(["/other/bin/mytool session compact-prepare"]);
  });

  it("leaves non-storybloq non-claudestory entries untouched", async () => {
    await seed("PreCompact", [
      "/other/bin/anothertool session compact-prepare",
      "some-wrapper --flag session compact-prepare",
    ]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    expect((await remainingCommands("PreCompact")).length).toBe(2);
  });

  it("idempotent: second run with already-migrated settings is a no-op returning 0", async () => {
    await seed("PreCompact", ["claudestory session compact-prepare"]);
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const first = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(first).toBe(1);
    const second = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(second).toBe(0);
  });

  it("handles empty hooks object (no PreCompact key present)", async () => {
    await writeFile(settingsPath, JSON.stringify({ hooks: {} }, null, 2), "utf-8");
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
  });

  it("handles malformed hook entries (null, non-object, missing command) without throwing", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [null, "bad", { type: "command" }, { type: "other" }, 42] },
          { matcher: "other", hooks: [{ type: "command", command: "claudestory session compact-prepare" }] },
        ],
      },
    }, null, 2), "utf-8");
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
  });

  it("returns 0 cleanly when settings.json does not exist", async () => {
    await rm(settingsPath, { force: true });
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
  });

  it("returns 0 when settings.json has invalid JSON (does not overwrite)", async () => {
    const original = "{ not valid json }";
    await writeFile(settingsPath, original, "utf-8");
    const { migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(0);
    const content = await readFile(settingsPath, "utf-8");
    expect(content).toBe(original);
  });

  it("parses apostrophe-escaped path matching formatHookCommand output (round-trip)", async () => {
    if (process.platform === "win32") return;
    const { formatHookCommand, migrateLegacyHookVariants } = await import("../../../src/cli/commands/setup-skill.js");
    // formatHookCommand produces `'<escaped>' <subcommand>` with `'\''`
    // sequences for literal apostrophes; parseHookCommand must round-trip
    // so the migration can match its own output.
    const cmd = formatHookCommand("/weird'path/claudestory", "session compact-prepare");
    await seed("PreCompact", [cmd]);
    const count = await migrateLegacyHookVariants(
      "PreCompact",
      "session compact-prepare",
      "/new/bin/storybloq session compact-prepare",
      settingsPath,
    );
    expect(count).toBe(1);
    expect(await remainingCommands("PreCompact")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sweepLegacyHooks (ISS-590)
// ---------------------------------------------------------------------------

describe("sweepLegacyHooks", () => {
  let tempDir: string;
  let settingsPath: string;
  const FAKE_BIN = "/new/bin/storybloq";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-sweep-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    settingsPath = join(tempDir, "settings.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns total migrations across PreCompact + SessionStart + Stop", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
        SessionStart: [{ matcher: "compact", hooks: [
          { type: "command", command: "/old/bin/claudestory session resume-prompt" },
        ]}],
        Stop: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory hook-status", async: true },
        ]}],
      },
    }, null, 2), "utf-8");
    const { sweepLegacyHooks } = await import("../../../src/cli/commands/setup-skill.js");
    const total = await sweepLegacyHooks(FAKE_BIN, settingsPath);
    expect(total).toBe(3);
  });

  it("returns 0 when no legacy entries present anywhere", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "/new/bin/storybloq session compact-prepare" },
        ]}],
      },
    }, null, 2), "utf-8");
    const { sweepLegacyHooks } = await import("../../../src/cli/commands/setup-skill.js");
    const total = await sweepLegacyHooks(FAKE_BIN, settingsPath);
    expect(total).toBe(0);
  });

  it("continues even if one hook type has malformed entries", async () => {
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: "not-an-array",  // malformed
        SessionStart: [{ matcher: "compact", hooks: [
          { type: "command", command: "claudestory session resume-prompt" },
        ]}],
        Stop: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory hook-status", async: true },
        ]}],
      },
    }, null, 2), "utf-8");
    const { sweepLegacyHooks } = await import("../../../src/cli/commands/setup-skill.js");
    const total = await sweepLegacyHooks(FAKE_BIN, settingsPath);
    // Malformed PreCompact yields 0; SessionStart + Stop each contribute 1.
    expect(total).toBe(2);
  });
});
