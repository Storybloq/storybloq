import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleBlockerList,
  handleBlockerAdd,
  handleBlockerClear,
} from "../../../src/cli/commands/blocker.js";
import { initProject } from "../../../src/core/init.js";
import { makeState, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

describe("handleBlockerList", () => {
  it("returns blockers when present", () => {
    const roadmap = makeRoadmap([makePhase({ id: "p1" })]);
    roadmap.blockers = [
      { name: "npm reserved", cleared: true, note: "Done" },
    ];
    const ctx = makeCtx({ state: makeState({ roadmap }) });
    const result = handleBlockerList(ctx);
    expect(result.output).toContain("npm reserved");
  });

  it("returns empty message when no blockers", () => {
    const ctx = makeCtx();
    const result = handleBlockerList(ctx);
    expect(result.output).toContain("No blockers");
  });

  it("returns valid JSON", () => {
    const ctx = makeCtx({ format: "json" });
    const result = handleBlockerList(ctx);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });
});

// --- Write Handler Tests ---

describe("handleBlockerAdd", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("adds a blocker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-add-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleBlockerAdd({ name: "npm reserved" }, "md", dir);
    expect(result.output).toContain("Added blocker: npm reserved");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.blockers).toHaveLength(1);
    expect(roadmap.blockers[0].name).toBe("npm reserved");
    expect(roadmap.blockers[0].cleared).toBe(false);
    expect(roadmap.blockers[0].createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(roadmap.blockers[0].clearedDate).toBeNull();
  });

  it("adds a blocker with note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-add-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleBlockerAdd({ name: "waiting", note: "For approval" }, "md", dir);
    expect(result.output).toContain("Added blocker: waiting");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.blockers[0].note).toBe("For approval");
  });

  it("rejects duplicate active blocker name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-add-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleBlockerAdd({ name: "blocker1" }, "md", dir);
    await expect(
      handleBlockerAdd({ name: "blocker1" }, "md", dir),
    ).rejects.toThrow("already exists");
  });

  it("allows reuse of cleared blocker name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-add-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleBlockerAdd({ name: "temp-block" }, "md", dir);
    await handleBlockerClear("temp-block", undefined, "md", dir);
    // Should succeed -- original is cleared
    const result = await handleBlockerAdd({ name: "temp-block" }, "md", dir);
    expect(result.output).toContain("Added blocker: temp-block");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.blockers).toHaveLength(2); // cleared + new active
  });

  it("returns valid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-add-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleBlockerAdd({ name: "test" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.name).toBe("test");
    expect(parsed.data.cleared).toBe(false);
  });
});

describe("handleBlockerClear", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("clears an active blocker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-clear-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleBlockerAdd({ name: "npm reserved" }, "md", dir);
    const result = await handleBlockerClear("npm reserved", undefined, "md", dir);
    expect(result.output).toContain("Cleared blocker: npm reserved");
    const raw = await readFile(join(dir, ".story", "roadmap.json"), "utf-8");
    const roadmap = JSON.parse(raw);
    expect(roadmap.blockers[0].cleared).toBe(true);
    expect(roadmap.blockers[0].clearedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns not_found for nonexistent blocker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-clear-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await expect(
      handleBlockerClear("nonexistent", undefined, "md", dir),
    ).rejects.toThrow("No active blocker");
  });

  it("returns not_found for already cleared blocker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-clear-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleBlockerAdd({ name: "done" }, "md", dir);
    await handleBlockerClear("done", undefined, "md", dir);
    await expect(
      handleBlockerClear("done", undefined, "md", dir),
    ).rejects.toThrow("No active blocker");
  });

  it("clears with note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocker-clear-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleBlockerAdd({ name: "waiting" }, "md", dir);
    const result = await handleBlockerClear("waiting", "Approved on 2026-03-20", "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.note).toBe("Approved on 2026-03-20");
    expect(parsed.data.cleared).toBe(true);
  });
});
