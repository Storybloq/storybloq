import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  MERGE_DRIVER_VERSION,
  MERGE_DRIVER_NAME,
  installMergeDriver,
  writeGitattributes,
  updateConfigVersion,
  teamSetup,
  checkMergeDriverSetup,
} from "../../src/core/team-setup.js";
import { STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "team-setup-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

function createStoryDir(root: string): string {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
  return storyDir;
}

function writeConfig(root: string, config: Record<string, unknown>): void {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
  for (const dir of ["tickets", "issues", "handovers", "notes", "lessons"]) {
    mkdirSync(join(storyDir, dir), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
  writeFileSync(
    join(storyDir, "roadmap.json"),
    JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [{ id: "p0", label: "PHASE 0", name: "Setup", description: "Setup." }],
      blockers: [],
    }, null, 2) + "\n",
    "utf-8",
  );
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    project: "test",
    type: "npm",
    language: "ts",
    features: {
      tickets: true,
      issues: true,
      handovers: true,
      roadmap: true,
      reviews: true,
    },
    ...overrides,
  };
}

describe("T-388: team-setup", () => {
  describe("MERGE_DRIVER_VERSION", () => {
    it("is 1", () => {
      expect(MERGE_DRIVER_VERSION).toBe(1);
    });

    it("MERGE_DRIVER_NAME is storybloq-json", () => {
      expect(MERGE_DRIVER_NAME).toBe("storybloq-json");
    });
  });

  describe("installMergeDriver", () => {
    it("sets git config correctly", async () => {
      const root = createTempGitRepo();
      await installMergeDriver(root);
      const driver = execFileSync("git", ["config", "--local", "--get", "merge.storybloq-json.driver"], { cwd: root, encoding: "utf-8" }).trim();
      expect(driver).toBe("storybloq merge-driver %O %A %B %P");
      const name = execFileSync("git", ["config", "--local", "--get", "merge.storybloq-json.name"], { cwd: root, encoding: "utf-8" }).trim();
      expect(name).toBe("Storybloq JSON three-way merge");
    });
  });

  describe("writeGitattributes", () => {
    it("creates managed block with correct patterns", async () => {
      const root = createTempGitRepo();
      const storyDir = createStoryDir(root);
      await writeGitattributes(storyDir);
      const content = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
      expect(content).toContain("# storybloq-merge-begin");
      expect(content).toContain("# storybloq-merge-end");
      expect(content).toContain("tickets/*.json merge=storybloq-json");
      expect(content).toContain("issues/*.json merge=storybloq-json");
      expect(content).toContain("notes/*.json merge=storybloq-json");
      expect(content).toContain("lessons/*.json merge=storybloq-json");
      expect(content).toContain("arrangements/*.json merge=storybloq-json");
      expect(content).toContain("config.json merge=storybloq-json");
      expect(content).toContain("roadmap.json merge=storybloq-json");
    });

    it("preserves custom content outside managed block", async () => {
      const root = createTempGitRepo();
      const storyDir = createStoryDir(root);
      writeFileSync(join(storyDir, ".gitattributes"), "custom/*.md linguist-generated\n", "utf-8");
      await writeGitattributes(storyDir);
      const content = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
      expect(content).toContain("custom/*.md linguist-generated");
      expect(content).toContain("# storybloq-merge-begin");
    });

    it("is idempotent", async () => {
      const root = createTempGitRepo();
      const storyDir = createStoryDir(root);
      await writeGitattributes(storyDir);
      const first = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
      await writeGitattributes(storyDir);
      const second = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
      expect(second).toBe(first);
    });
  });

  describe("updateConfigVersion", () => {
    it("sets team.mergeDriverVersion", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await updateConfigVersion(root);
      const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
      expect(config.team).toBeDefined();
      expect(config.team.mergeDriverVersion).toBe(MERGE_DRIVER_VERSION);
    });

    it("preserves existing config fields", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig({
        team: { idAllocator: "git-refs", minCliVersion: "1.0.0" },
        customField: "preserved",
      }));
      await updateConfigVersion(root);
      const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
      expect(config.team.idAllocator).toBe("git-refs");
      expect(config.team.minCliVersion).toBe("1.0.0");
      expect(config.team.mergeDriverVersion).toBe(MERGE_DRIVER_VERSION);
      expect(config.customField).toBe("preserved");
    });

    it("ISS-793: rejects a schema-invalid config instead of rewriting it", async () => {
      const root = createTempGitRepo();
      // Bypass baseConfig on purpose: omit features entirely so ConfigSchema fails.
      writeConfig(root, { version: 2, project: "test", type: "npm", language: "ts" });
      await expect(updateConfigVersion(root)).rejects.toThrow(/validation/i);
    });

    it("ISS-793: writes atomically with no temp residue and stamps mergeDriverVersion", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await updateConfigVersion(root);
      const storyDir = join(root, ".story");
      const leftovers = readdirSync(storyDir).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
      const config = JSON.parse(readFileSync(join(storyDir, "config.json"), "utf-8"));
      expect(config.team.mergeDriverVersion).toBe(MERGE_DRIVER_VERSION);
    });
  });

  describe("teamSetup", () => {
    it("orchestrates all steps", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      const result = await teamSetup(root);
      expect(result.driverInstalled).toBe(true);
      expect(result.gitattributesWritten).toBe(true);
      expect(result.versionUpdated).toBe(true);
    });

    it("fails if not in a git repo", async () => {
      const dir = mkdtempSync(join(tmpdir(), "no-git-"));
      writeConfig(dir, baseConfig());
      await expect(teamSetup(dir)).rejects.toThrow();
    });

    it("fails if no .story/ dir", async () => {
      const root = createTempGitRepo();
      await expect(teamSetup(root)).rejects.toThrow();
    });
  });

  describe("checkMergeDriverSetup", () => {
    it("returns ok when fully set up", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig());
      await teamSetup(root);
      const check = await checkMergeDriverSetup(root);
      expect(check.ok).toBe(true);
      expect(check.issues).toHaveLength(0);
    });

    it("detects missing git config", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig({ team: { mergeDriverVersion: 1 } }));
      createStoryDir(root);
      const check = await checkMergeDriverSetup(root);
      expect(check.ok).toBe(false);
      expect(check.issues.length).toBeGreaterThan(0);
    });

    it("detects missing .gitattributes", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig({ team: { mergeDriverVersion: 1 } }));
      execFileSync("git", ["config", "--local", "merge.storybloq-json.driver", "storybloq merge-driver %O %A %B %P"], { cwd: root });
      const check = await checkMergeDriverSetup(root);
      expect(check.ok).toBe(false);
      expect(check.issues.some((i) => i.includes("gitattributes"))).toBe(true);
    });

    it("detects version mismatch", async () => {
      const root = createTempGitRepo();
      writeConfig(root, baseConfig({ team: { mergeDriverVersion: 999 } }));
      await writeGitattributes(join(root, ".story"));
      execFileSync("git", ["config", "--local", "merge.storybloq-json.driver", "storybloq merge-driver %O %A %B %P"], { cwd: root });
      const check = await checkMergeDriverSetup(root);
      expect(check.ok).toBe(false);
      expect(check.issues.some((i) => i.includes("version"))).toBe(true);
    });
  });
});

// ISS-754: standalone `team setup` must also ensure the ephemeral gitignore
// (teamSetup is the shared implementation for both `team init` and `team setup`).
describe("ISS-754: teamSetup ensures .story/.gitignore", () => {
  it("creates the gitignore with every ephemeral entry", async () => {
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({ project: "t" }));
    const result = await teamSetup(root);
    expect(result.gitignoreEnsured).toBe(true);
    const content = readFileSync(join(root, ".story", ".gitignore"), "utf-8");
    for (const entry of STORY_GITIGNORE_ENTRIES) {
      expect(content).toContain(entry);
    }
  });
});
