import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../../src/core/init.js";
import { handleSnapshot } from "../../../src/cli/commands/snapshot.js";
import { formatSnapshotResult } from "../../../src/core/output-formatter.js";

describe("snapshot command", () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const d of tmpDirs) {
      await rm(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("creates snapshot and returns result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-cmd-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleSnapshot(dir, "md");
    expect(result.output).toContain("Snapshot saved:");
    expect(result.output).toContain("1 retained");
  });

  it("snapshot file actually exists on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-cmd-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    await handleSnapshot(dir, "md");
    const files = await readdir(join(dir, ".story", "snapshots"));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it("formats as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-cmd-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    const result = await handleSnapshot(dir, "json");
    const parsed = JSON.parse(result.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.filename).toMatch(/\.json$/);
    expect(parsed.data.retained).toBe(1);
    expect(parsed.data.pruned).toBe(0);
  });
});

describe("formatSnapshotResult", () => {
  it("MD shows filename and counts", () => {
    const md = formatSnapshotResult(
      { filename: "2026-03-20T00-00-00-000.json", retained: 5, pruned: 0 },
      "md",
    );
    expect(md).toContain("2026-03-20T00-00-00-000.json");
    expect(md).toContain("5 retained");
    expect(md).not.toContain("pruned");
  });

  it("MD shows pruned count when > 0", () => {
    const md = formatSnapshotResult(
      { filename: "test.json", retained: 20, pruned: 3 },
      "md",
    );
    expect(md).toContain("3 pruned");
  });

  it("JSON is valid", () => {
    const json = formatSnapshotResult(
      { filename: "test.json", retained: 1, pruned: 0 },
      "json",
    );
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
