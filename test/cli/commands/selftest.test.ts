import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSelftest } from "../../../src/cli/commands/selftest.js";
import { initProject } from "../../../src/core/init.js";

describe("handleSelftest", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it("all 18 checks pass on a clean project (md)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleSelftest(dir, "md");
    expect(result.output).toContain("18/18 passed");
    expect(result.output).not.toContain("[ ]");
  });

  it("all 18 checks pass on a clean project (json)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleSelftest(dir, "json");
    const parsed = JSON.parse(result.output);
    expect(parsed.data.passed).toBe(18);
    expect(parsed.data.failed).toBe(0);
    expect(parsed.data.total).toBe(18);
    expect(parsed.data.results).toHaveLength(18);
    expect(parsed.data.cleanupErrors).toHaveLength(0);
  });

  it("cleans up entities even when failAfter triggers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });

    // Should throw due to failAfter, but cleanup should remove created entities
    await expect(handleSelftest(dir, "md", 3)).rejects.toThrow("failAfter");

    // Verify no leftover entities
    const ticketFiles = await readdir(join(dir, ".story", "tickets")).catch(() => []);
    const issueFiles = await readdir(join(dir, ".story", "issues")).catch(() => []);
    const noteFiles = await readdir(join(dir, ".story", "notes")).catch(() => []);
    expect(ticketFiles).toHaveLength(0);
    expect(issueFiles).toHaveLength(0);
    expect(noteFiles).toHaveLength(0);
  });

  it("no leftover entities after successful run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-"));
    tmpDirs.push(dir);
    await initProject(dir, { name: "test" });
    await handleSelftest(dir, "md");

    const ticketFiles = await readdir(join(dir, ".story", "tickets")).catch(() => []);
    const issueFiles = await readdir(join(dir, ".story", "issues")).catch(() => []);
    const noteFiles = await readdir(join(dir, ".story", "notes")).catch(() => []);
    expect(ticketFiles).toHaveLength(0);
    expect(issueFiles).toHaveLength(0);
    expect(noteFiles).toHaveLength(0);
  });
});
