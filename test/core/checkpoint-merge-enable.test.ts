/**
 * T-537 S4: the schema fence and the merge driver. A checkpoint-enabled team
 * ledger merges only through `storybloq-json-v4`, which a pre-checkpoint CLI
 * cannot run; every clone that has not rerun `team setup` sees the tracked
 * `-merge` and conflicts instead of merging. `checkpoint enable` stamps any
 * project, and a team project only after proving its own clone is ready.
 * RED at 09e7dade: none of these exports exist there.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";
import { loadProject } from "../../src/core/project-loader.js";
import {
  CHECKPOINT_BLOCK_BEGIN,
  CHECKPOINT_BLOCK_END,
  MERGE_DRIVER_V4_CMD,
  MERGE_DRIVER_V4_NAME,
  effectiveMergeDriver,
  hasCheckpointGitattributes,
  rulingLifecycleReadiness,
  teamSetup,
  writeCheckpointGitattributes,
  writeGitattributes,
} from "../../src/core/team-setup.js";
import { checkpointMergeProblems, enableCheckpoints, type CheckpointEnableDeps } from "../../src/core/checkpoint-enable.js";
import { checkCheckpointMergeAttributes } from "../../src/core/team-doctor.js";
import {
  MERGE_DRIVER_PROTOCOL,
  handleMergeDriver,
  ledgerRootOf,
  mergeDriverCapabilities,
  protocolRefusal,
} from "../../src/cli/commands/merge-driver.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t537-s4-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A project at `root/sub` (or `root`), optionally in a git repository at `root`, optionally team-enabled. */
async function project(opts: { git: boolean; team: boolean; nested?: string }): Promise<{ repo: string; root: string }> {
  const repo = temp("t537-s4-");
  if (opts.git) git(repo, "init", "-q");
  const root = opts.nested ? join(repo, opts.nested) : repo;
  mkdirSync(root, { recursive: true });
  await initProject(root, { name: "t537" });
  if (opts.team) {
    const path = join(root, ".story", "config.json");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    config.team = { enabled: true };
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  }
  return { repo, root };
}

const config = (root: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8"));
const READY: CheckpointEnableDeps = { capabilities: async () => mergeDriverCapabilities() };
const OLD_BINARY: CheckpointEnableDeps = { capabilities: async () => null };

describe("merge-driver protocol 4", () => {
  it("reports its capabilities", () => {
    expect(mergeDriverCapabilities()).toEqual({ protocol: MERGE_DRIVER_PROTOCOL, maxSchemaVersion: CHECKPOINT_SCHEMA_VERSION, checkpoints: true });
  });

  it("finds the ledger from %P, nested or not", () => {
    expect(ledgerRootOf(".story/tickets/t-1.json", "/r")).toBe("/r/.story");
    expect(ledgerRootOf("app/.story/tickets/t-1.json", "/r")).toBe("/r/app/.story");
    expect(ledgerRootOf("src/x.json", "/r")).toBeNull();
  });

  it("merges a ledger it supports and refuses one it does not, an unreadable one, or another protocol", async () => {
    const { root } = await project({ git: false, team: false });
    expect(protocolRefusal(4, ".story/tickets/t-1.json", root)).toBeNull();
    expect(protocolRefusal(5, ".story/tickets/t-1.json", root)).toMatch(/protocol 5 is not supported/);
    const path = join(root, ".story", "config.json");
    const c = config(root);
    writeFileSync(path, JSON.stringify({ ...c, schemaVersion: 5 }));
    expect(protocolRefusal(4, ".story/tickets/t-1.json", root)).toMatch(/schemaVersion 5.*supports up to 4/);
    writeFileSync(path, "<<<<<<< ours\n");
    expect(protocolRefusal(4, ".story/tickets/t-1.json", root)).toMatch(/cannot read the ledger config/);
  });

  it("reads %P on forward slashes only, so a backslash stays part of a directory name", async () => {
    expect(ledgerRootOf("app\\name/.story/tickets/t-1.json", "/r")).toBe("/r/app\\name/.story");
    const repo = temp("t537-s4-");
    const literal = join(repo, "app\\name");
    const split = join(repo, "app", "name");
    for (const dir of [literal, split]) {
      mkdirSync(dir, { recursive: true });
      await initProject(dir, { name: "t537" });
    }
    // The ledger a backslash-splitting reader would find instead is one this build refuses.
    writeFileSync(join(split, ".story", "config.json"), JSON.stringify({ ...config(split), schemaVersion: 99 }));
    expect(protocolRefusal(4, "app/name/.story/tickets/t-1.json", repo)).toMatch(/schemaVersion 99/);
    expect(protocolRefusal(4, "app\\name/.story/tickets/t-1.json", repo)).toBeNull();
  });

  it("a refused v4 run exits 2 and leaves ours untouched", async () => {
    const { root } = await project({ git: false, team: false });
    const path = join(root, ".story", "config.json");
    writeFileSync(path, JSON.stringify({ ...config(root), schemaVersion: 5 }));
    const side = (name: string, title: string) => {
      const p = join(root, name);
      writeFileSync(p, JSON.stringify({ id: "T-001", title }));
      return p;
    };
    const ours = side("ours.json", "ours");
    const before = readFileSync(ours, "utf-8");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(handleMergeDriver(side("base.json", "base"), ours, side("theirs.json", "theirs"), ".story/tickets/T-001.json", 4)).toBe(2);
    } finally {
      process.chdir(cwd);
    }
    expect(readFileSync(ours, "utf-8")).toBe(before);
  });
});

describe("team setup registers v4 for this clone", () => {
  it("configures the v4 driver and a root-qualified override git honours over .gitattributes", async () => {
    const { repo, root } = await project({ git: true, team: true });
    await teamSetup(root);
    expect(git(repo, "config", "--local", "--get", `merge.${MERGE_DRIVER_V4_NAME}.driver`)).toBe(MERGE_DRIVER_V4_CMD);
    const local = readFileSync(join(repo, git(repo, "rev-parse", "--git-path", "info/attributes")), "utf-8");
    expect(local).toContain(`.story/tickets/*.json merge=${MERGE_DRIVER_V4_NAME}`);
    expect(effectiveMergeDriver(repo, ".story/tickets/t-1.json")).toBe(MERGE_DRIVER_V4_NAME);
    expect(effectiveMergeDriver(repo, ".story/config.json")).toBe(MERGE_DRIVER_V4_NAME);
    // The tracked block does not outrank the clone's own override.
    writeCheckpointGitattributes(join(root, ".story"));
    expect(effectiveMergeDriver(repo, ".story/issues/i-1.json")).toBe(MERGE_DRIVER_V4_NAME);
    // Readiness checks accept the v4 name.
    expect(rulingLifecycleReadiness(join(root, ".story"), "1.16.0").attributeOk).toBe(true);
  });

  it("qualifies a nested ledger from the repository root", async () => {
    const { repo, root } = await project({ git: true, team: true, nested: "app" });
    await teamSetup(root);
    const local = readFileSync(join(repo, git(repo, "rev-parse", "--git-path", "info/attributes")), "utf-8");
    expect(local).toContain(`app/.story/tickets/*.json merge=${MERGE_DRIVER_V4_NAME}`);
    expect(effectiveMergeDriver(repo, "app/.story/tickets/t-1.json")).toBe(MERGE_DRIVER_V4_NAME);
    expect(effectiveMergeDriver(repo, "other/.story/tickets/t-1.json")).not.toBe(MERGE_DRIVER_V4_NAME);
  });

  it("matches a nested ledger whose path has spaces or glob characters literally, and nothing else", async () => {
    const repo = temp("t537-s4-");
    git(repo, "init", "-q");
    // "[app]" read as a glob would match "a/" or "p/" instead; "my app" would split the line.
    const apps = ["my app", "[app]", "x*y", "#tag"];
    for (const app of apps) {
      const root = join(repo, app);
      mkdirSync(root, { recursive: true });
      await initProject(root, { name: "t537" });
      writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ ...config(root), team: { enabled: true } }, null, 2) + "\n");
      await teamSetup(root);
    }
    for (const app of apps) {
      for (const p of [".story/tickets/t-1.json", ".story/issues/i-1.json", ".story/config.json"]) {
        expect(effectiveMergeDriver(repo, `${app}/${p}`), `${app}/${p}`).toBe(MERGE_DRIVER_V4_NAME);
      }
      expect(await checkpointMergeProblems(join(repo, app), repo, READY), app).toEqual([]);
    }
    for (const other of ["a", "p", "xzy", "my"]) {
      expect(effectiveMergeDriver(repo, `${other}/.story/tickets/t-1.json`), other).not.toBe(MERGE_DRIVER_V4_NAME);
    }
    // Setting one up again keeps the others' blocks whole.
    await teamSetup(join(repo, "[app]"));
    expect(effectiveMergeDriver(repo, "my app/.story/tickets/t-1.json")).toBe(MERGE_DRIVER_V4_NAME);
    const local = readFileSync(join(repo, git(repo, "rev-parse", "--git-path", "info/attributes")), "utf-8");
    expect(local.split("\\[app\\]/.story/tickets/*.json merge=").length - 1).toBe(1);
  });

  it("keeps a ledger directory with a line break in its name inside one block, however often setup runs", async () => {
    const repo = temp("t537-s4-");
    git(repo, "init", "-q");
    const root = join(repo, "line\nbreak");
    mkdirSync(root, { recursive: true });
    await initProject(root, { name: "t537" });
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ ...config(root), team: { enabled: true } }, null, 2) + "\n");
    await teamSetup(root);
    await teamSetup(root);
    const local = readFileSync(join(repo, git(repo, "rev-parse", "--git-path", "info/attributes")), "utf-8");
    // An unquoted name would split its block marker, leaving the rest of the
    // name as a pattern line of its own and the block unfindable next time.
    const stray = local.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#") && !l.includes(` merge=${MERGE_DRIVER_V4_NAME}`));
    expect(stray, local).toEqual([]);
    expect(local.split("# storybloq-checkpoint-local-begin").length - 1, local).toBe(1);
  });

  it("writes the override once, however often setup runs", async () => {
    const { repo, root } = await project({ git: true, team: true });
    await teamSetup(root);
    await teamSetup(root);
    const local = readFileSync(join(repo, git(repo, "rev-parse", "--git-path", "info/attributes")), "utf-8");
    expect(local.split(`.story/tickets/*.json merge=${MERGE_DRIVER_V4_NAME}`).length - 1).toBe(1);
  });

  it("refuses a ledger this build cannot read before touching anything", async () => {
    const { repo, root } = await project({ git: true, team: true });
    const infoAttributes = join(repo, git(repo, "rev-parse", "--git-path", "info/attributes"));
    const cases: [string, unknown, RegExp][] = [
      ["a newer schemaVersion", { ...config(root), schemaVersion: 5 }, /schemaVersion 5/],
      ["a schemaVersion string", { ...config(root), schemaVersion: "5" }, /not a valid config[\s\S]*schemaVersion/],
      ["a schemaVersion array", { ...config(root), schemaVersion: [5] }, /not a valid config[\s\S]*schemaVersion/],
      ["a config that is an array", [config(root)], /not a valid config/],
    ];
    for (const [name, bad, why] of cases) {
      writeFileSync(join(root, ".story", "config.json"), JSON.stringify(bad));
      await expect(teamSetup(root), name).rejects.toThrow(why);
      expect(() => git(repo, "config", "--local", "--get", `merge.${MERGE_DRIVER_V4_NAME}.driver`), name).toThrow();
      expect(() => git(repo, "config", "--local", "--get", "merge.storybloq-json.driver"), name).toThrow();
      expect(existsSync(join(root, ".story", ".gitattributes")), name).toBe(false);
      expect(existsSync(infoAttributes), name).toBe(false);
    }
  });

  it("keeps each nested ledger's override: setting up a second keeps the first", async () => {
    const repo = temp("t537-s4-");
    git(repo, "init", "-q");
    for (const app of ["app-a", "app-b"]) {
      const root = join(repo, app);
      mkdirSync(root, { recursive: true });
      await initProject(root, { name: app });
      writeFileSync(join(root, ".story", "config.json"), JSON.stringify({ ...config(root), team: { enabled: true } }, null, 2) + "\n");
      await teamSetup(root);
    }
    for (const app of ["app-a", "app-b"]) {
      expect(effectiveMergeDriver(repo, `${app}/.story/tickets/t-1.json`), app).toBe(MERGE_DRIVER_V4_NAME);
      expect(await checkpointMergeProblems(join(repo, app), repo, READY), app).toEqual([]);
    }
    // Setting up the first again keeps the second.
    await teamSetup(join(repo, "app-a"));
    expect(effectiveMergeDriver(repo, "app-b/.story/tickets/t-1.json")).toBe(MERGE_DRIVER_V4_NAME);
  });

  it("repairs an override a later conflicting rule defeats", async () => {
    const { repo, root } = await project({ git: true, team: true });
    await teamSetup(root);
    const infoAttributes = join(repo, git(repo, "rev-parse", "--git-path", "info/attributes"));
    writeFileSync(infoAttributes, readFileSync(infoAttributes, "utf-8") + ".story/tickets/*.json merge=storybloq-json\n");
    expect(effectiveMergeDriver(repo, ".story/tickets/t-1.json")).toBe("storybloq-json");
    expect(await checkpointMergeProblems(root, repo, READY)).toEqual([`git merges .story/tickets/t-checkpointprobe.json with storybloq-json, not ${MERGE_DRIVER_V4_NAME}`]);
    await teamSetup(root);
    expect(effectiveMergeDriver(repo, ".story/tickets/t-1.json")).toBe(MERGE_DRIVER_V4_NAME);
    expect(await checkpointMergeProblems(root, repo, READY)).toEqual([]);
  });
});

describe("the tracked -merge block", () => {
  it("sits after the managed block, and an unconfigured clone resolves -merge", async () => {
    const { repo, root } = await project({ git: true, team: true });
    const storyDir = join(root, ".story");
    await writeGitattributes(storyDir);
    writeCheckpointGitattributes(storyDir);
    const text = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
    expect(text.indexOf(CHECKPOINT_BLOCK_BEGIN)).toBeGreaterThan(text.indexOf("# storybloq-merge-end"));
    expect(git(repo, "check-attr", "merge", "--", ".story/tickets/t-1.json")).toBe(".story/tickets/t-1.json: merge: unset");
  });

  it("survives the managed-block rewrite an older team setup performs", async () => {
    const { root } = await project({ git: true, team: true });
    const storyDir = join(root, ".story");
    await writeGitattributes(storyDir);
    writeCheckpointGitattributes(storyDir);
    const once = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
    // The managed-block rewrite alone leaves the checkpoint block as it was.
    await writeGitattributes(storyDir);
    expect(readFileSync(join(storyDir, ".gitattributes"), "utf-8")).toBe(once);
    expect(hasCheckpointGitattributes(storyDir)).toBe(true);
    expect(once.split(CHECKPOINT_BLOCK_END).length - 1).toBe(1);
  });

  it("writing the block again changes nothing", async () => {
    const { root } = await project({ git: true, team: true });
    const storyDir = join(root, ".story");
    await writeGitattributes(storyDir);
    writeCheckpointGitattributes(storyDir);
    const once = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
    writeCheckpointGitattributes(storyDir);
    expect(readFileSync(join(storyDir, ".gitattributes"), "utf-8")).toBe(once);
  });

  it("a rule after the block defeats it until the block is written last again", async () => {
    const { repo, root } = await project({ git: true, team: true });
    const storyDir = join(root, ".story");
    await writeGitattributes(storyDir);
    writeCheckpointGitattributes(storyDir);
    const path = join(storyDir, ".gitattributes");
    writeFileSync(path, readFileSync(path, "utf-8") + "tickets/*.json merge=storybloq-json\n");
    expect(git(repo, "check-attr", "merge", "--", ".story/tickets/t-1.json")).toBe(".story/tickets/t-1.json: merge: storybloq-json");
    expect(hasCheckpointGitattributes(storyDir)).toBe(false);
    writeCheckpointGitattributes(storyDir);
    expect(hasCheckpointGitattributes(storyDir)).toBe(true);
    expect(git(repo, "check-attr", "merge", "--", ".story/tickets/t-1.json")).toBe(".story/tickets/t-1.json: merge: unset");
    expect(readFileSync(path, "utf-8").split(CHECKPOINT_BLOCK_BEGIN).length - 1).toBe(1);
  });

  it("team setup keeps an existing checkpoint block last", async () => {
    const { root } = await project({ git: true, team: true });
    const storyDir = join(root, ".story");
    // No managed block yet: setup appends one, which would land after the checkpoint block.
    writeCheckpointGitattributes(storyDir);
    await teamSetup(root);
    const text = readFileSync(join(storyDir, ".gitattributes"), "utf-8");
    expect(text.indexOf(CHECKPOINT_BLOCK_BEGIN)).toBeGreaterThan(text.indexOf("# storybloq-merge-end"));
    expect(hasCheckpointGitattributes(storyDir)).toBe(true);
  });
});

describe("checkpoint enable", () => {
  it("stamps a non-team project, and a second run changes nothing", async () => {
    const { root } = await project({ git: true, team: false });
    expect(await enableCheckpoints(root, OLD_BINARY)).toEqual({ status: "enabled", team: false });
    expect(config(root).schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    expect((config(root).checkpointEnable as { step: string }).step).toBe("complete");
    expect(existsSync(join(root, ".story", ".gitattributes"))).toBe(false);
    const before = readFileSync(join(root, ".story", "config.json"), "utf-8");
    expect(await enableCheckpoints(root, OLD_BINARY)).toEqual({ status: "already", team: false });
    expect(readFileSync(join(root, ".story", "config.json"), "utf-8")).toBe(before);
  });

  it("stamps a team project outside git without any merge setup", async () => {
    const { root } = await project({ git: false, team: true });
    expect(await enableCheckpoints(root, OLD_BINARY)).toEqual({ status: "enabled", team: false });
    expect(config(root).schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    expect((await loadProject(root)).state.config.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
  });

  it("refuses a team clone without setup, naming team setup, and writes nothing", async () => {
    const { root } = await project({ git: true, team: true });
    const before = readFileSync(join(root, ".story", "config.json"), "utf-8");
    await expect(enableCheckpoints(root, READY)).rejects.toThrow(/not registered[\s\S]*storybloq team setup[\s\S]*Nothing was written/);
    expect(readFileSync(join(root, ".story", "config.json"), "utf-8")).toBe(before);
    expect(existsSync(join(root, ".story", ".gitattributes"))).toBe(false);
  });

  it("refuses when the binary git would run predates protocol 4, even after setup", async () => {
    const { root } = await project({ git: true, team: true });
    await teamSetup(root);
    const before = readFileSync(join(root, ".story", "config.json"), "utf-8");
    await expect(enableCheckpoints(root, OLD_BINARY)).rejects.toThrow(/--protocol 4 --capabilities/);
    expect(readFileSync(join(root, ".story", "config.json"), "utf-8")).toBe(before);
  });

  it("enables a configured team clone: block first, then the stamp", async () => {
    const { repo, root } = await project({ git: true, team: true });
    await teamSetup(root);
    expect(await enableCheckpoints(root, READY)).toEqual({ status: "enabled", team: true });
    expect(readFileSync(join(root, ".story", ".gitattributes"), "utf-8")).toContain(CHECKPOINT_BLOCK_BEGIN);
    expect(config(root).schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    expect(effectiveMergeDriver(repo, ".story/tickets/t-1.json")).toBe(MERGE_DRIVER_V4_NAME);
  });

  it("re-decides when team mode is enabled while it runs: validation is never skipped", async () => {
    const { root } = await project({ git: true, team: false });
    const path = join(root, ".story", "config.json");
    let flipped: string | null = null;
    const deps: CheckpointEnableDeps = {
      ...READY,
      async afterDecision() {
        if (flipped !== null) return;
        writeFileSync(path, JSON.stringify({ ...config(root), team: { enabled: true } }, null, 2) + "\n");
        flipped = readFileSync(path, "utf-8");
      },
    };
    await expect(enableCheckpoints(root, deps)).rejects.toThrow(/not registered[\s\S]*Nothing was written/);
    expect(readFileSync(path, "utf-8")).toBe(flipped);
    expect(config(root).schemaVersion).not.toBe(CHECKPOINT_SCHEMA_VERSION);
    expect(existsSync(join(root, ".story", ".gitattributes"))).toBe(false);
  });

  it("finishes an interrupted enable, and restores a block removed after it", async () => {
    const { root } = await project({ git: true, team: true });
    await teamSetup(root);
    const path = join(root, ".story", "config.json");
    writeFileSync(path, JSON.stringify({ ...config(root), checkpointEnable: { step: "attributes", at: "2026-09-27T00:00:00.000Z" } }, null, 2) + "\n");
    expect(await enableCheckpoints(root, READY)).toEqual({ status: "enabled", team: true });
    expect(config(root).schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
    writeFileSync(join(root, ".story", ".gitattributes"), "");
    expect(await enableCheckpoints(root, READY)).toEqual({ status: "already", team: true });
    expect(readFileSync(join(root, ".story", ".gitattributes"), "utf-8")).toContain(CHECKPOINT_BLOCK_BEGIN);
  });
});

describe("checkpoint enable when git cannot answer", () => {
  /** A directory holding only a `git` that runs `body`, or no git at all. */
  function fakeGitDir(body: string | null): string {
    const bin = temp("t537-s4-bin-");
    if (body !== null) writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  }

  async function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const before = process.env.PATH;
    process.env.PATH = dir;
    try { return await fn(); } finally { process.env.PATH = before; }
  }

  it.each([
    ["git is not on PATH", null, /git is not on PATH/],
    ["git refuses the repository", `echo "fatal: detected dubious ownership in repository at '/x'" >&2; exit 128`, /git exited 128: fatal: detected dubious ownership/],
    ["git is killed", "kill -TERM $$", /git was stopped by SIGTERM/],
  ])("refuses a team ledger and writes nothing when %s", async (_label, body, why) => {
    const { root } = await project({ git: true, team: true });
    await teamSetup(root);
    const path = join(root, ".story", "config.json");
    const before = readFileSync(path, "utf-8");
    const attributes = readFileSync(join(root, ".story", ".gitattributes"), "utf-8");
    const bin = fakeGitDir(body);
    const err = await withPath(bin, () => enableCheckpoints(root, READY)).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toMatch(/team ledger and git could not tell whether it is in a repository/);
    expect(err?.message).toMatch(why);
    expect(err?.message).toMatch(/nothing was written/);
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(readFileSync(join(root, ".story", ".gitattributes"), "utf-8")).toBe(attributes);
  });

  it("stamps a team ledger without merge setup only when git itself says it is not in a repository", async () => {
    const { root } = await project({ git: false, team: true });
    const bin = fakeGitDir(`echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128`);
    expect(await withPath(bin, () => enableCheckpoints(root, OLD_BINARY))).toEqual({ status: "enabled", team: false });
    expect(existsSync(join(root, ".story", ".gitattributes"))).toBe(false);
  });
});

describe("team doctor", () => {
  const ctx = (root: string) => ({ root, cliVersion: null, isTeamMode: true, loadWarnings: [] });

  it("is silent before enable and on a configured, enabled clone", async () => {
    const { root } = await project({ git: true, team: true });
    await teamSetup(root);
    expect(checkCheckpointMergeAttributes((await loadProject(root)).state, ctx(root))).toEqual([]);
    await enableCheckpoints(root, READY);
    expect(checkCheckpointMergeAttributes((await loadProject(root)).state, ctx(root))).toEqual([]);
  });

  it("names an unconfigured clone and a lost block after enable", async () => {
    const { repo, root } = await project({ git: true, team: true });
    await teamSetup(root);
    await enableCheckpoints(root, READY);
    writeFileSync(join(repo, git(repo, "rev-parse", "--git-path", "info/attributes")), "");
    let findings = checkCheckpointMergeAttributes((await loadProject(root)).state, ctx(root));
    expect(findings.map((f) => f.code)).toEqual(["checkpoint_merge_driver"]);
    expect(findings[0]!.message).toContain(".story/tickets/t-checkpointprobe.json -> unset");
    writeFileSync(join(root, ".story", ".gitattributes"), "");
    findings = checkCheckpointMergeAttributes((await loadProject(root)).state, ctx(root));
    expect(findings.map((f) => f.code)).toEqual(["checkpoint_merge_driver", "checkpoint_gitattributes_missing"]);
  });
});
