import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";

describe("init bootstrap — MCP degraded mode flow", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("initProject creates valid .story/ with empty phases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "init-bootstrap-"));
    tmpDirs.push(dir);

    const result = await initProject(dir, {
      name: "test-project",
      type: "npm",
      language: "typescript",
      phases: [],
    });

    expect(result.root).toBe(dir);
    expect(result.created).toContain(".story/config.json");
    expect(result.created).toContain(".story/roadmap.json");

    const s = await stat(join(dir, ".story"));
    expect(s.isDirectory()).toBe(true);
  });

  it("loadProject succeeds after initProject with empty phases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "init-bootstrap-"));
    tmpDirs.push(dir);

    await initProject(dir, {
      name: "loadable",
      type: "generic",
      language: "unknown",
      phases: [],
    });

    const { state } = await loadProject(dir);
    expect(state.config.project).toBe("loadable");
    expect(state.roadmap.phases).toEqual([]);
    expect(state.tickets).toEqual([]);
    expect(state.issues).toEqual([]);
  });

  it("initProject throws conflict when .story/ already exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "init-bootstrap-"));
    tmpDirs.push(dir);

    await initProject(dir, { name: "first", phases: [] });
    await expect(
      initProject(dir, { name: "second", phases: [] }),
    ).rejects.toThrow(".story/ already exists");
  });

  it("config reflects type and language from init options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "init-bootstrap-"));
    tmpDirs.push(dir);

    await initProject(dir, {
      name: "typed-project",
      type: "cargo",
      language: "rust",
      phases: [],
    });

    const { state } = await loadProject(dir);
    expect(state.config.type).toBe("cargo");
    expect(state.config.language).toBe("rust");
  });

  it("status tool returns 0 phases without crashing after empty init", async () => {
    const dir = await mkdtemp(join(tmpdir(), "init-bootstrap-"));
    tmpDirs.push(dir);

    await initProject(dir, { name: "empty", phases: [] });

    // Simulate what claudestory_status would do
    const { handleStatus } = await import("../../src/cli/commands/status.js");
    const { state, warnings } = await loadProject(dir);
    const ctx = {
      state,
      warnings,
      root: dir,
      handoversDir: join(dir, ".story", "handovers"),
      format: "md" as const,
    };
    const result = handleStatus(ctx);
    expect(result.output).toBeDefined();
    // Should not throw
  });
});
