import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("setup-skill", () => {
  it("bundled SKILL.md exists in src/skill/", () => {
    expect(existsSync(join("src", "skill", "SKILL.md"))).toBe(true);
  });

  it("bundled reference.md exists in src/skill/", () => {
    expect(existsSync(join("src", "skill", "reference.md"))).toBe(true);
  });

  it("SKILL.md has correct frontmatter", async () => {
    const content = await readFile(join("src", "skill", "SKILL.md"), "utf-8");
    expect(content).toContain("name: story");
    expect(content).toContain("description:");
    expect(content).toContain("## Step 0: Check Setup");
    expect(content).toContain("## Step 2: Load Context");
  });

  it("reference.md contains expected sections", async () => {
    const content = await readFile(join("src", "skill", "reference.md"), "utf-8");
    expect(content).toContain("## CLI Commands");
    expect(content).toContain("## MCP Tools");
    expect(content).toContain("## Common Workflows");
    expect(content).toContain("## Troubleshooting");
  });

  it("resolveSkillSourceDir finds src/skill from source layout", async () => {
    // Import the resolver — in test context, import.meta.url points to
    // test/cli/commands/setup-skill.test.ts but the function uses its own
    // import.meta.url (src/cli/commands/setup-skill.ts). Since we run from
    // the package root and src/skill/ exists, the source path should resolve.
    const { resolveSkillSourceDir } = await import("../../../src/cli/commands/setup-skill.js");
    const dir = resolveSkillSourceDir();
    expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "reference.md"))).toBe(true);
  });
});
