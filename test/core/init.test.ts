import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { ProjectLoaderError, CURRENT_SCHEMA_VERSION } from "../../src/core/errors.js";

let testRoot: string;

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true });
  }
});

describe("initProject", () => {
  it("creates .story/ with all subdirectories and files", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    const result = await initProject(testRoot, { name: "test-project" });

    expect(existsSync(join(testRoot, ".story", "config.json"))).toBe(true);
    expect(existsSync(join(testRoot, ".story", "roadmap.json"))).toBe(true);
    expect(existsSync(join(testRoot, ".story", "tickets"))).toBe(true);
    expect(existsSync(join(testRoot, ".story", "issues"))).toBe(true);
    expect(existsSync(join(testRoot, ".story", "handovers"))).toBe(true);
    expect(existsSync(join(testRoot, ".story", "notes"))).toBe(true);
    expect(result.created).toHaveLength(6);
    // /prime skill scaffolding removed — setup-skill replaces it
    expect(result.created).not.toContain(".claude/skills/prime/SKILL.md");
    expect(existsSync(join(testRoot, ".claude", "skills", "prime", "SKILL.md"))).toBe(false);
  });

  it("config has correct values", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await initProject(testRoot, { name: "my-project", type: "npm", language: "typescript" });

    const { state } = await loadProject(testRoot);
    expect(state.config.version).toBe(2);
    expect(state.config.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(state.config.project).toBe("my-project");
    expect(state.config.type).toBe("npm");
    expect(state.config.language).toBe("typescript");
    expect(state.config.features.tickets).toBe(true);
  });

  it("roadmap has default phase with project name as title", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await initProject(testRoot, { name: "test-project" });

    const { state } = await loadProject(testRoot);
    expect(state.roadmap.title).toBe("test-project");
    expect(state.roadmap.phases).toHaveLength(1);
    expect(state.roadmap.phases[0]!.id).toBe("p0");
  });

  it("roadmap date is today", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await initProject(testRoot, { name: "test" });

    const { state } = await loadProject(testRoot);
    const today = new Date().toISOString().slice(0, 10);
    expect(state.roadmap.date).toBe(today);
  });

  it("throws conflict if .story/ exists", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await mkdir(join(testRoot, ".story"), { recursive: true });

    await expect(
      initProject(testRoot, { name: "test" }),
    ).rejects.toThrow(ProjectLoaderError);

    try {
      await initProject(testRoot, { name: "test" });
    } catch (err) {
      expect((err as ProjectLoaderError).code).toBe("conflict");
    }
  });

  it("succeeds with force when .story/ exists", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await initProject(testRoot, { name: "original" });
    await initProject(testRoot, { name: "overwritten", force: true });

    const { state } = await loadProject(testRoot);
    expect(state.config.project).toBe("overwritten");
  });

  it("force preserves existing ticket files", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await initProject(testRoot, { name: "test" });

    // Write a ticket manually
    await writeFile(
      join(testRoot, ".story", "tickets", "T-001.json"),
      JSON.stringify({
        id: "T-001", title: "Existing", description: ".", type: "task",
        status: "open", phase: "p0", order: 10, createdDate: "2026-01-01",
        completedDate: null, blockedBy: [],
      }),
    );

    // Force reinit
    await initProject(testRoot, { name: "reinit", force: true });

    // Ticket should still exist
    const { state } = await loadProject(testRoot);
    expect(state.tickets).toHaveLength(1);
    expect(state.config.project).toBe("reinit");
  });

  it("result passes loadProject round-trip", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await initProject(testRoot, { name: "roundtrip" });

    const { state, warnings } = await loadProject(testRoot);
    expect(state.config.project).toBe("roundtrip");
    expect(warnings).toHaveLength(0);
  });

  it("uses default type and language when not specified", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "claudestory-init-"));
    await initProject(testRoot, { name: "test" });

    const { state } = await loadProject(testRoot);
    expect(state.config.type).toBe("generic");
    expect(state.config.language).toBe("unknown");
  });
});
