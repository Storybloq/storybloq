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
  rulingLifecycleReadiness,
  effectiveMergeDriver,
} from "../../src/core/team-setup.js";
import { STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";
import { RULING_LIFECYCLE_MIN_CLI_VERSION } from "../../src/core/team-capabilities.js";

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
      // T-522: a CLI that meets the ruling fence raises it; the other fields stand.
      expect(config.team.minCliVersion).toBe(RULING_LIFECYCLE_MIN_CLI_VERSION);
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

describe("T-522 commit 3: team setup enables 1.16 rulings", () => {
  const saved = process.env.STORYBLOQ_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORYBLOQ_VERSION;
    else process.env.STORYBLOQ_VERSION = saved;
  });

  it("writes the rulings merge attribute line", async () => {
    const root = createTempGitRepo();
    const storyDir = createStoryDir(root);
    await writeGitattributes(storyDir);
    const content = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
    expect(content).toContain("rulings/*.json merge=storybloq-json");
  });

  it("raises minCliVersion to 1.16.0 when the running CLI is at least 1.16.0, and reports it", async () => {
    process.env.STORYBLOQ_VERSION = "1.16.0";
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({ team: { enabled: true, minCliVersion: "1.4.4" } }));
    const result = await teamSetup(root);
    expect(result.rulingFence).toBe("raised");
    const config = JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
    expect(config.team.minCliVersion).toBe("1.16.0");
  });

  it("keeps a fence already at or above 1.16.0", async () => {
    process.env.STORYBLOQ_VERSION = "1.17.2";
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({ team: { enabled: true, minCliVersion: "1.16.5" } }));
    const result = await teamSetup(root);
    expect(result.rulingFence).toBe("already");
    expect(JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")).team.minCliVersion).toBe("1.16.5");
  });

  it("DEFERS the raise when the running CLI is older than 1.16.0: a fence this CLI cannot pass is never written", async () => {
    process.env.STORYBLOQ_VERSION = "1.15.9";
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({ team: { enabled: true, minCliVersion: "1.4.4" } }));
    const result = await teamSetup(root);
    expect(result.rulingFence).toBe("deferred");
    expect(JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")).team.minCliVersion).toBe("1.4.4");
  });
});

describe("T-522 commit 3 (byte-review round 2): the fence is SemVer-aware and the attribute check is git-accurate", () => {
  const saved = process.env.STORYBLOQ_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORYBLOQ_VERSION;
    else process.env.STORYBLOQ_VERSION = saved;
  });

  it("a prerelease of 1.16.0 cannot raise the fence: 1.16.0-rc.1 defers", async () => {
    process.env.STORYBLOQ_VERSION = "1.16.0-rc.1";
    const root = createTempGitRepo();
    writeConfig(root, baseConfig({ team: { enabled: true, minCliVersion: "1.4.4" } }));
    const result = await teamSetup(root);
    expect(result.rulingFence).toBe("deferred");
    expect(JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")).team.minCliVersion).toBe("1.4.4");
  });

  it("readiness: a prerelease fence of the minimum's core is below it; a prerelease of a later core is above it", () => {
    const storyDir = createStoryDir(createTempGitRepo());
    expect(rulingLifecycleReadiness(storyDir, "1.16.0-rc").fenceOk).toBe(false);
    expect(rulingLifecycleReadiness(storyDir, "1.16.0-rc.1").fenceOk).toBe(false);
    expect(rulingLifecycleReadiness(storyDir, "1.16.0").fenceOk).toBe(true);
    expect(rulingLifecycleReadiness(storyDir, "1.16.1-rc.1").fenceOk).toBe(true);
    expect(rulingLifecycleReadiness(storyDir, "1.15.9").fenceOk).toBe(false);
    expect(rulingLifecycleReadiness(storyDir, "garbage").fenceOk).toBe(false);
    expect(rulingLifecycleReadiness(storyDir, undefined).fenceOk).toBe(false);
  });

  it("attribute: git's own answer for the actual ruling path; comments, unrelated patterns and every kind of later override are honoured", () => {
    const root = createTempGitRepo();
    const storyDir = createStoryDir(root);
    const attrs = join(storyDir, ".gitattributes");
    const ok = (content: string, id = "r-0000000000000000"): boolean => {
      writeFileSync(attrs, content);
      return rulingLifecycleReadiness(storyDir, "1.16.0", id).attributeOk;
    };
    const managed = "# storybloq-merge-begin\nrulings/*.json merge=storybloq-json\n# storybloq-merge-end\n";
    expect(ok(managed)).toBe(true);
    expect(ok("# rulings/*.json merge=storybloq-json\n")).toBe(false);
    expect(ok("old-rulings/*.json merge=storybloq-json\n")).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok("/rulings/*.json merge=storybloq-json\n")).toBe(true);
    expect(ok("*.json merge=storybloq-json\n")).toBe(true);
    // Overrides placed after the managed block (setup preserves custom content there) win, as in git.
    expect(ok(managed + "rulings/*.json merge=text\n")).toBe(false);
    expect(ok(managed + "rulings/*.json -merge\n")).toBe(false);
    expect(ok(managed + "*.json merge=text\n")).toBe(false);
    expect(ok(managed + "**/*.json merge=text\n")).toBe(false);
    expect(ok(managed + "rulings/** -merge\n")).toBe(false);
    expect(ok(managed + "rulings/r-[0-9a-f]*.json merge=text\n")).toBe(false);
    // A per-file override is caught for THAT file and only that file: the check runs on the real path.
    expect(ok(managed + "rulings/r-a*.json merge=text\n", "r-abcdefabcdefabcd")).toBe(false);
    expect(ok(managed + "rulings/r-a*.json merge=text\n", "r-0000000000000000")).toBe(true);
    expect(ok(managed + "*.txt merge=text\n")).toBe(true);
    expect(ok(managed + "tickets/*.json merge=text\n")).toBe(true);
    expect(ok("rulings/*.json merge=text\n" + managed)).toBe(true);
    // Outside a git repository nothing can merge structurally: not ready.
    const bare = mkdtempSync(join(tmpdir(), "no-git-"));
    mkdirSync(join(bare, ".story"), { recursive: true });
    writeFileSync(join(bare, ".story", ".gitattributes"), managed);
    expect(rulingLifecycleReadiness(join(bare, ".story"), "1.16.0").attributeOk).toBe(false);
    expect(effectiveMergeDriver(bare, ".story/rulings/r-0000000000000000.json")).toBeNull();
  });

  it("the file setup itself writes is active", async () => {
    const root = createTempGitRepo();
    const storyDir = createStoryDir(root);
    await writeGitattributes(storyDir);
    // T-486 A2: the attribute counts only beside the registration setup also writes.
    expect(rulingLifecycleReadiness(storyDir, "1.16.0")).toMatchObject({ fenceOk: true, attributeOk: true, registration: { ok: false, reason: "unregistered" } });
    await installMergeDriver(root);
    expect(rulingLifecycleReadiness(storyDir, "1.16.0")).toEqual({ fenceOk: true, attributeOk: true, registration: { ok: true, name: MERGE_DRIVER_NAME, protocol: null } });
  });
});

describe("T-529: team setup routes both catalogs to the structural driver", () => {
  const PRE_T529_BLOCK =
    "# storybloq-merge-begin\ntickets/*.json merge=storybloq-json\nconfig.json merge=storybloq-json\n# storybloq-merge-end\n";

  it("writes the capabilities.json and glossary.json lines, and a rerun is byte-identical", async () => {
    const storyDir = createStoryDir(createTempGitRepo());
    await writeGitattributes(storyDir);
    const first = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
    expect(first).toContain("capabilities.json merge=storybloq-json");
    expect(first).toContain("glossary.json merge=storybloq-json");
    await writeGitattributes(storyDir);
    expect(readFileSync(join(storyDir, ".gitattributes"), "utf-8")).toBe(first);
  });

  it("git itself resolves both catalogs to the driver only after setup: a pre-T-529 block leaves them as text", async () => {
    const setup = await import("../../src/core/team-setup.js");
    const storyDir = createStoryDir(createTempGitRepo());
    writeFileSync(join(storyDir, ".gitattributes"), PRE_T529_BLOCK, "utf-8");
    expect(setup.catalogsWithoutMergeDriver(storyDir)).toEqual(["capabilities.json", "glossary.json"]);
    await writeGitattributes(storyDir);
    expect(setup.catalogsWithoutMergeDriver(storyDir)).toEqual([]);
    expect(effectiveMergeDriver(join(storyDir, ".."), ".story/glossary.json")).toBe(MERGE_DRIVER_NAME);
  });
});
