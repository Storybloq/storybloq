import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/core/init.js";
import { runLocalProjectCommand } from "../../src/cli/local-profile.js";

describe("task-bound local CLI profile", () => {
  const dirs: string[] = [];
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "storybloq-local-cli-"));
    dirs.push(dir);
    return realpathSync(dir);
  }
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it("ignores another project's inherited override", async () => {
    const a = await fixture(), b = await fixture();
    await initProject(a, { name: "A" });
    await initProject(b, { name: "B" });
    process.env.STORYBLOQ_PROJECT_ROOT = a;
    process.env.CLAUDESTORY_PROJECT_ROOT = a;
    let actual: string | undefined;
    await runLocalProjectCommand(["recap", "--format", "json"], b, async (root) => { actual = root; });
    expect(actual).toBe(b);
  });

  it.each([
    ["status"], ["setup"], ["update"], ["init", "--force"],
    ["init", "--node", "other"], ["reference", "--mcp"],
    ["reference", "--board-mcp"], ["recap", "--node=other"],
    ["handover", "create"], ["init", "--name", "x", "unexpected"],
    ["constructor"], ["init", "--constructor"],
  ])("refuses unsupported routing or side effects: %j", async (...args) => {
    const root = await fixture();
    let dispatched = false;
    await expect(runLocalProjectCommand(args, root, async () => { dispatched = true; })).rejects.toThrow();
    expect(dispatched).toBe(false);
    expect(existsSync(join(root, ".story"))).toBe(false);
  });

  it("never overwrites an incomplete or dangling ledger", async () => {
    for (const kind of ["directory", "symlink"]) {
      const root = await fixture();
      if (kind === "directory") await mkdir(join(root, ".story"));
      else await symlink(join(root, "missing"), join(root, ".story"));
      let dispatched = false;
      await expect(runLocalProjectCommand(["init"], root, async () => { dispatched = true; })).rejects.toThrow("incomplete");
      expect(dispatched).toBe(false);
    }
  });

  it("admits one simultaneous scaffold with consistent canonical files", async () => {
    const root = await fixture();
    const results = await Promise.allSettled(["First", "Second"].map((name) =>
      runLocalProjectCommand(["init", "--name", name], root, async (bound) => {
        await initProject(bound, { name });
      }),
    ));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((x) => x.status === "rejected")).toHaveLength(1);
    const config = JSON.parse(await readFile(join(root, ".story/config.json"), "utf8"));
    const roadmap = JSON.parse(await readFile(join(root, ".story/roadmap.json"), "utf8"));
    expect(roadmap.title).toBe(config.project);
    expect(["First", "Second"]).toContain(config.project);
    expect(existsSync(join(root, ".storybloq-local-init.lock"))).toBe(false);
  });

  it("releases admission when the canonical initializer fails", async () => {
    const root = await fixture();
    await expect(runLocalProjectCommand(["init"], root, async () => { throw new Error("fixture failure"); })).rejects.toThrow("fixture failure");
    await runLocalProjectCommand(["init"], root, async (bound) => { await initProject(bound, { name: "Retry" }); });
    expect(JSON.parse(await readFile(join(root, ".story/config.json"), "utf8")).project).toBe("Retry");
  });
});
