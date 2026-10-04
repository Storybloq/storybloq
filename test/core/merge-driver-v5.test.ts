/**
 * T-486 U1-3: protocol 5 and registration-aware readiness.
 *
 * Readiness asks git three things and fails closed on each: the `merge`
 * attribute it resolves for the path, the command `git config --get` returns
 * for that driver (git's own scope precedence, no flag), and that the command
 * is exactly what setup generates. Setup selects v5 in each clone's local
 * attributes block (A1), checkpoints accept v4 or v5 (A8), and the fence is
 * raised through every capability minimum (2a). Every fixture is built here
 * by the current handlers or by git, never from frozen bytes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import {
  MERGE_DRIVER_CMD,
  MERGE_DRIVER_V4_CMD,
  MERGE_DRIVER_V4_NAME,
  MERGE_DRIVER_V5_CMD,
  MERGE_DRIVER_V5_NAME,
  MERGE_DRIVER_CONTRACTS,
  UNSUPPORTED_REGISTRATION_MESSAGE,
  effectiveMergeDriver,
  mergeDriverRegistration,
  raiseTeamFence,
  resolutionWritesReadiness,
  rulingLifecycleReadiness,
  teamSetup,
} from "../../src/core/team-setup.js";
import { RESOLUTION_KIND_MIN_CLI_VERSION, RULING_LIFECYCLE_MIN_CLI_VERSION, TEAM_FENCE_MINIMUMS, meetsVersionMinimum } from "../../src/core/team-capabilities.js";
import { checkpointMergeProblems, enableCheckpoints, type CheckpointEnableDeps } from "../../src/core/checkpoint-enable.js";
import { checkCheckpointMergeAttributes, checkResolutionKindReadiness, checkRulingLifecycleReadiness } from "../../src/core/team-doctor.js";
import { mergeDriverCapabilities } from "../../src/cli/commands/merge-driver.js";
import { handleRulingCreate } from "../../src/cli/commands/ruling.js";
import { handleTeamDoctor } from "../../src/cli/commands/team-doctor.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
let globalConfig: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u13-home-"));
  globalConfig = join(scratchHome, "gitconfig");
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "STORYBLOQ_VERSION"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.STORYBLOQ_VERSION = "1.16.0";
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
  rmSync(globalConfig, { force: true });
  process.env.STORYBLOQ_VERSION = "1.16.0";
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A team project in a fresh git repository, at `repo/nested` when given. */
async function teamProject(opts: { nested?: string; fence?: string } = {}): Promise<{ repo: string; root: string }> {
  const repo = temp("t486-u13-");
  git(repo, "init", "-q");
  const root = opts.nested ? join(repo, opts.nested) : repo;
  mkdirSync(root, { recursive: true });
  await initProject(root, { name: "t486" });
  const path = join(root, ".story", "config.json");
  const config = JSON.parse(readFileSync(path, "utf-8"));
  config.team = { enabled: true, ...(opts.fence ? { minCliVersion: opts.fence } : {}) };
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return { repo, root };
}

const infoAttributes = (repo: string): string => join(repo, git(repo, "rev-parse", "--git-path", "info/attributes"));

/** What a pre-U1 `team setup` leaves: the v4 local block, and no v5 registration. */
function downgradeToPreU1Setup(repo: string): void {
  const path = infoAttributes(repo);
  writeFileSync(path, readFileSync(path, "utf-8").replaceAll(`merge=${MERGE_DRIVER_V5_NAME}`, `merge=${MERGE_DRIVER_V4_NAME}`));
  git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
  git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.name`);
}

const ISSUE = ".story/issues/i-1.json";
const V5_ONLY = [MERGE_DRIVER_V5_NAME];

describe("registration: attribute, command and exact contract (R1-R5, R7)", () => {
  it("the contract table names exactly the three generated commands", () => {
    expect([...MERGE_DRIVER_CONTRACTS.entries()]).toEqual([
      ["storybloq-json", { command: "storybloq merge-driver %O %A %B %P", protocol: null }],
      ["storybloq-json-v4", { command: "storybloq merge-driver --protocol 4 %O %A %B %P", protocol: 4 }],
      ["storybloq-json-v5", { command: "storybloq merge-driver --protocol 5 %O %A %B %P", protocol: 5 }],
    ]);
  });

  it("setup leaves the v5 registration ready", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    expect(mergeDriverRegistration(repo, ISSUE, V5_ONLY)).toEqual({ ok: true, name: MERGE_DRIVER_V5_NAME, protocol: 5 });
  });

  it("R1: an attribute naming an unregistered driver is refused as unregistered", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    const r = mergeDriverRegistration(repo, ISSUE, V5_ONLY);
    expect(r).toMatchObject({ ok: false, reason: "unregistered" });
    expect(!r.ok && r.message).toMatch(/not registered; run storybloq team setup/);
  });

  it.each([
    ["another program", "cat %A"],
    ["the v4 command under the v5 name", MERGE_DRIVER_V4_CMD],
    ["an extra argument", `${MERGE_DRIVER_V5_CMD} --verbose`],
    ["a shell wrapper", `sh -c '${MERGE_DRIVER_V5_CMD}'`],
    ["npx", `npx ${MERGE_DRIVER_V5_CMD}`],
  ])("R2: %s under the v5 name is an unsupported registration", async (_label, command) => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    git(repo, "config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, command);
    const r = mergeDriverRegistration(repo, ISSUE, V5_ONLY);
    expect(r).toMatchObject({ ok: false, reason: "unsupported" });
    expect(!r.ok && r.message).toContain(UNSUPPORTED_REGISTRATION_MESSAGE);
  });

  it("surrounding whitespace is trimmed before the comparison", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    git(repo, "config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, `  ${MERGE_DRIVER_V5_CMD}  `);
    expect(mergeDriverRegistration(repo, ISSUE, V5_ONLY).ok).toBe(true);
  });

  it("R3: a global registration counts (no scope flag)", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    writeFileSync(globalConfig, `[merge "${MERGE_DRIVER_V5_NAME}"]\n\tdriver = ${MERGE_DRIVER_V5_CMD}\n`);
    expect(mergeDriverRegistration(repo, ISSUE, V5_ONLY).ok).toBe(true);
  });

  it("R4: a worktree-config override of the command is what git runs, and is refused", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(repo, "config", "--worktree", `merge.${MERGE_DRIVER_V5_NAME}.driver`, "cat %A");
    expect(mergeDriverRegistration(repo, ISSUE, V5_ONLY)).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("R5: info/attributes selecting v4 outranks a tracked v5 rule", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    writeFileSync(join(root, ".story", ".gitattributes"), `issues/*.json merge=${MERGE_DRIVER_V5_NAME}\n`);
    writeFileSync(infoAttributes(repo), `.story/issues/*.json merge=${MERGE_DRIVER_V4_NAME}\n`);
    expect(effectiveMergeDriver(repo, ISSUE)).toBe(MERGE_DRIVER_V4_NAME);
    expect(mergeDriverRegistration(repo, ISSUE, V5_ONLY)).toMatchObject({ ok: false, reason: "attribute" });
    // The same clone is still a supported structural registration for everything but kind writes.
    expect(mergeDriverRegistration(repo, ISSUE)).toEqual({ ok: true, name: MERGE_DRIVER_V4_NAME, protocol: 4 });
  });

  it("R7: a quoted absolute path is refused with the setup message, and setup replaces it", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    git(repo, "config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, `"/usr/local/bin/storybloq" merge-driver --protocol 5 %O %A %B %P`);
    const r = mergeDriverRegistration(repo, ISSUE, V5_ONLY);
    expect(!r.ok && r.message).toBe(`${UNSUPPORTED_REGISTRATION_MESSAGE} (merge.${MERGE_DRIVER_V5_NAME}.driver)`);
    await teamSetup(root);
    expect(mergeDriverRegistration(repo, ISSUE, V5_ONLY).ok).toBe(true);
  });

  it("outside a repository nothing is ready", async () => {
    const bare = temp("t486-u13-nogit-");
    expect(mergeDriverRegistration(bare, ISSUE)).toMatchObject({ ok: false, reason: "attribute" });
  });
});

describe("A1 / R6: setup migrates the clone's local block to v5", () => {
  it("from a real pre-U1 setup: v5 is what git resolves, kind writes are ready, and a rerun changes nothing", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    downgradeToPreU1Setup(repo);
    expect(effectiveMergeDriver(repo, ISSUE)).toBe(MERGE_DRIVER_V4_NAME);
    expect(resolutionWritesReadiness(repo, "1.16.0", ISSUE).driver.ok).toBe(false);

    await teamSetup(root);
    for (const p of [ISSUE, ".story/tickets/t-1.json", ".story/config.json", ".story/rulings/r-1.json"]) {
      expect(effectiveMergeDriver(repo, p), p).toBe(MERGE_DRIVER_V5_NAME);
    }
    const ready = resolutionWritesReadiness(repo, JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")).team.minCliVersion, ISSUE);
    expect(ready).toEqual({ fenceOk: true, driver: { ok: true, name: MERGE_DRIVER_V5_NAME, protocol: 5 } });

    const snapshot = () => [
      readFileSync(infoAttributes(repo), "utf-8"),
      readFileSync(join(repo, ".git", "config"), "utf-8"),
      readFileSync(join(root, ".story", "config.json"), "utf-8"),
      readFileSync(join(root, ".story", ".gitattributes"), "utf-8"),
    ];
    const before = snapshot();
    await teamSetup(root);
    expect(snapshot()).toEqual(before);
  });

  it("a nested ledger is migrated in the git dir that serves it", async () => {
    const { repo, root } = await teamProject({ nested: "app" });
    await teamSetup(root);
    downgradeToPreU1Setup(repo);
    await teamSetup(root);
    expect(effectiveMergeDriver(repo, "app/.story/issues/i-1.json")).toBe(MERGE_DRIVER_V5_NAME);
    expect(resolutionWritesReadiness(repo, "1.16.0", "app/.story/issues/i-1.json").driver.ok).toBe(true);
  });

  it("the tracked managed block stays storybloq-json", async () => {
    const { root } = await teamProject();
    await teamSetup(root);
    const tracked = readFileSync(join(root, ".story", ".gitattributes"), "utf-8");
    expect(tracked).toContain("issues/*.json merge=storybloq-json\n");
    expect(tracked).not.toContain("storybloq-json-v");
  });
});

describe("A2: ruling writes accept every supported registration and refuse the rest (RL1-RL5)", () => {
  const BASE = { attribution: "owner-direct", date: "2026-10-04", scopeTags: ["t486"], clientTaskId: "t486-u13" };

  async function readyProject(): Promise<{ repo: string; root: string }> {
    const p = await teamProject({ fence: "1.16.0" });
    await teamSetup(p.root);
    return p;
  }

  it("RL1: the legacy storybloq-json registration (tracked block, no local override)", async () => {
    const { repo, root } = await readyProject();
    writeFileSync(infoAttributes(repo), "");
    expect(effectiveMergeDriver(repo, ".story/rulings/r-1.json")).toBe("storybloq-json");
    await expect(handleRulingCreate({ ...BASE, text: "RL1" }, "json", root)).resolves.toBeDefined();
  });

  it("RL2: the v4 registration", async () => {
    const { repo, root } = await readyProject();
    downgradeToPreU1Setup(repo);
    expect(effectiveMergeDriver(repo, ".story/rulings/r-1.json")).toBe(MERGE_DRIVER_V4_NAME);
    await expect(handleRulingCreate({ ...BASE, text: "RL2" }, "json", root)).resolves.toBeDefined();
  });

  it("RL3: the v5 registration", async () => {
    const { root } = await readyProject();
    await expect(handleRulingCreate({ ...BASE, text: "RL3" }, "json", root)).resolves.toBeDefined();
  });

  it("RL4: refused when the selected driver is unregistered", async () => {
    const { repo, root } = await readyProject();
    git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    await expect(handleRulingCreate({ ...BASE, text: "RL4" }, "json", root)).rejects.toThrow(/storybloq-json-v5 merge driver is not registered/);
    expect(checkRulingLifecycleReadinessCodes(await stateOf(root), root)).toEqual([]);
  });

  it("RL5: refused when a foreign command is registered under a supported name", async () => {
    const { repo, root } = await readyProject();
    git(repo, "config", "--local", "merge.storybloq-json.driver", "cat %A");
    writeFileSync(infoAttributes(repo), "");
    await expect(handleRulingCreate({ ...BASE, text: "RL5" }, "json", root)).rejects.toThrow(/unsupported merge driver registration; run storybloq team setup/);
    expect(rulingLifecycleReadiness(join(root, ".story"), "1.16.0").registration).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("doctor names a broken registration once rulings exist", async () => {
    const { repo, root } = await readyProject();
    await handleRulingCreate({ ...BASE, text: "R" }, "json", root);
    git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    expect(checkRulingLifecycleReadinessCodes(await stateOf(root), root)).toEqual(["ruling_merge_driver_registration"]);
  });

  async function stateOf(root: string) {
    return (await loadProject(root)).state;
  }
  function checkRulingLifecycleReadinessCodes(state: Awaited<ReturnType<typeof stateOf>>, root: string): string[] {
    return checkRulingLifecycleReadiness(state, { root, cliVersion: null, isTeamMode: true, loadWarnings: [] }).map((f) => f.code);
  }
});

describe("A8: checkpoints accept v4 or v5, registered exactly (CK1-CK4)", () => {
  function recording(answer: (protocol: number) => unknown = (p) => mergeDriverCapabilities(p)): CheckpointEnableDeps & { asked: number[] } {
    const asked: number[] = [];
    return { asked, capabilities: async (_root, protocol) => { asked.push(protocol); return answer(protocol); } };
  }
  const ctx = (root: string) => ({ root, cliVersion: null, isTeamMode: true, loadWarnings: [] });

  it("CK1: a v5 clone is probed with protocol 5, a legacy v4 clone with 4, a mixed clone with both", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    let deps = recording();
    expect(await checkpointMergeProblems(root, repo, deps)).toEqual([]);
    expect(deps.asked).toEqual([5]);

    downgradeToPreU1Setup(repo);
    deps = recording();
    expect(await checkpointMergeProblems(root, repo, deps)).toEqual([]);
    expect(deps.asked).toEqual([4]);

    await teamSetup(root);
    writeFileSync(infoAttributes(repo), readFileSync(infoAttributes(repo), "utf-8") + `.story/tickets/*.json merge=${MERGE_DRIVER_V4_NAME}\n`);
    deps = recording();
    expect(await checkpointMergeProblems(root, repo, deps)).toEqual([]);
    expect([...deps.asked].sort()).toEqual([4, 5]);
  });

  it("CK2 (A8-1): a worktree override of the checkpoint command is refused by enable and named by doctor", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    await enableCheckpoints(root, recording());
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(repo, "config", "--worktree", `merge.${MERGE_DRIVER_V5_NAME}.driver`, "cat %A");
    expect(await checkpointMergeProblems(root, repo, recording())).toEqual([
      `git runs "cat %A" for the ${MERGE_DRIVER_V5_NAME} merge driver here, overriding this clone's registration (expected "${MERGE_DRIVER_V5_CMD}")`,
    ]);
    const findings = checkCheckpointMergeAttributes((await loadProject(root)).state, ctx(root));
    expect(findings.map((f) => f.code)).toEqual(["checkpoint_merge_driver"]);
    expect(findings[0]!.message).toContain("overriding this clone's registration");
  });

  it("CK2 (A8-1): the local registration is still required when only a global one matches", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    writeFileSync(globalConfig, `[merge "${MERGE_DRIVER_V5_NAME}"]\n\tdriver = ${MERGE_DRIVER_V5_CMD}\n`);
    expect(await checkpointMergeProblems(root, repo, recording())).toEqual([`the ${MERGE_DRIVER_V5_NAME} merge driver is not registered in this clone`]);
  });

  it.each([
    ["the wrong protocol", (_p: number) => mergeDriverCapabilities(4)],
    ["checkpoints not true", (p: number) => ({ ...mergeDriverCapabilities(p), checkpoints: "yes" })],
    ["an old schema ceiling", (p: number) => ({ ...mergeDriverCapabilities(p), maxSchemaVersion: 3 })],
    ["no answer", (_p: number) => null],
  ])("CK3: a capabilities answer with %s is refused, naming the protocol asked", async (_label, answer) => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    const problems = await checkpointMergeProblems(root, repo, recording(answer));
    expect(problems).toEqual([expect.stringContaining("`merge-driver --protocol 5 --capabilities` with owner checkpoints")]);
  });

  it("CK4: an old setup rewriting the same clone to v4 stays checkpoint-safe while kind writes refuse", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    await enableCheckpoints(root, recording());
    // A pre-U1 `team setup` on this clone rewrites its block to v4 and does not touch v5's config.
    const path = infoAttributes(repo);
    writeFileSync(path, readFileSync(path, "utf-8").replaceAll(`merge=${MERGE_DRIVER_V5_NAME}`, `merge=${MERGE_DRIVER_V4_NAME}`));
    expect(await checkpointMergeProblems(root, repo, recording())).toEqual([]);
    const state = (await loadProject(root)).state;
    expect(checkCheckpointMergeAttributes(state, ctx(root))).toEqual([]);
    expect(checkResolutionKindReadiness(state, ctx(root)).map((f) => f.code)).toEqual(["resolution_kind_merge_driver"]);
    expect(resolutionWritesReadiness(repo, state.config.team?.minCliVersion, ISSUE).driver).toMatchObject({ ok: false, reason: "attribute" });
  });
});

describe("2a: the fence rises through every capability minimum (F4) and doctor names each gap (F5)", () => {
  async function fenceAfter(version: string, start: string | null, minimums: readonly string[]): Promise<{ fence: unknown; outcomes: [string, string][] }> {
    process.env.STORYBLOQ_VERSION = version;
    const { root } = await teamProject(start ? { fence: start } : {});
    const outcomes = await raiseTeamFence(root, minimums);
    return { fence: JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")).team.minCliVersion, outcomes: [...outcomes.entries()] };
  }

  it("F4: a low fence rises to each minimum this CLI passes and no further", async () => {
    expect(await fenceAfter("1.16.5", "1.4.4", ["1.16.0", "1.17.0"])).toEqual({ fence: "1.16.0", outcomes: [["1.16.0", "raised"], ["1.17.0", "deferred"]] });
    expect(await fenceAfter("1.17.2", "1.4.4", ["1.16.0", "1.17.0"])).toEqual({ fence: "1.17.0", outcomes: [["1.16.0", "raised"], ["1.17.0", "raised"]] });
    expect(await fenceAfter("1.15.9", "1.4.4", ["1.16.0", "1.17.0"])).toEqual({ fence: "1.4.4", outcomes: [["1.16.0", "deferred"], ["1.17.0", "deferred"]] });
    expect(await fenceAfter("1.17.2", "1.17.0", ["1.16.0", "1.17.0"])).toEqual({ fence: "1.17.0", outcomes: [["1.16.0", "already"], ["1.17.0", "already"]] });
  });

  it("F4: a CLI below the board's fence is refused by the lock before it raises anything", async () => {
    process.env.STORYBLOQ_VERSION = "1.17.2";
    const { root } = await teamProject({ fence: "1.18.0" });
    const configPath = join(root, ".story", "config.json");
    const before = readFileSync(configPath, "utf-8");
    await expect(raiseTeamFence(root, ["1.16.0", "1.17.0"])).rejects.toMatchObject({ code: "version_mismatch" });
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("F4: an absent fence takes this CLI's version when it passes the minimums", async () => {
    expect(await fenceAfter("1.16.5", null, ["1.16.0", "1.17.0"])).toEqual({ fence: "1.16.5", outcomes: [["1.16.0", "raised"], ["1.17.0", "deferred"]] });
    expect(await fenceAfter("1.15.0", null, ["1.16.0"])).toEqual({ fence: undefined, outcomes: [["1.16.0", "deferred"]] });
  });

  it("setup reports both fences", async () => {
    const { root } = await teamProject({ fence: "1.4.4" });
    expect(await teamSetup(root)).toMatchObject({ rulingFence: "raised", resolutionKindFence: "raised" });
  });

  it("F4: capabilities sharing one minimum (the production list) each report the raise", async () => {
    expect(TEAM_FENCE_MINIMUMS).toEqual([RULING_LIFECYCLE_MIN_CLI_VERSION, RESOLUTION_KIND_MIN_CLI_VERSION]);
    expect(await fenceAfter("1.16.0", "1.4.4", ["1.16.0", "1.16.0"])).toEqual({ fence: "1.16.0", outcomes: [["1.16.0", "raised"]] });
    const { root } = await teamProject({ fence: "1.4.4" });
    process.env.STORYBLOQ_VERSION = RESOLUTION_KIND_MIN_CLI_VERSION;
    const outcomes = await raiseTeamFence(root);
    expect(outcomes.get(RULING_LIFECYCLE_MIN_CLI_VERSION)).toBe("raised");
    expect(outcomes.get(RESOLUTION_KIND_MIN_CLI_VERSION)).toBe("raised");
  });

  it("F6: a worktree-scoped driver override fails setup, naming its origin and the removal; setup succeeds once it is removed", async () => {
    const { repo, root } = await teamProject({ fence: "1.4.4" });
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(repo, "config", "--worktree", `merge.${MERGE_DRIVER_V5_NAME}.driver`, "custom-merge %O %A %B");
    const configPath = join(root, ".story", "config.json");
    const before = readFileSync(configPath, "utf-8");
    const failed = teamSetup(root);
    await expect(failed).rejects.toThrow(`merge.${MERGE_DRIVER_V5_NAME}.driver = "custom-merge %O %A %B" from worktree config (file:`);
    await expect(failed).rejects.toThrow("config.worktree) overrides the registration setup wrote");
    await expect(failed).rejects.toThrow(`remove it with: git config --worktree --unset-all merge.${MERGE_DRIVER_V5_NAME}.driver`);
    // The local registration was written; only the fence stays where it was.
    expect(git(repo, "config", "--local", "--get", `merge.${MERGE_DRIVER_V5_NAME}.driver`)).toBe(MERGE_DRIVER_V5_CMD);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    git(repo, "config", "--worktree", "--unset-all", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    expect(await teamSetup(root)).toMatchObject({ rulingFence: "raised", resolutionKindFence: "raised" });
  });

  it("every capability minimum is at most this package's version (Q2a)", () => {
    const version = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")).version as string;
    expect(TEAM_FENCE_MINIMUMS).toContain(RESOLUTION_KIND_MIN_CLI_VERSION);
    for (const minimum of TEAM_FENCE_MINIMUMS) expect(meetsVersionMinimum(version, minimum), minimum).toBe(true);
  });

  it("F5: doctor errors on a low fence and on a missing v5 registration, and is silent when ready", async () => {
    const ctx = (root: string) => ({ root, cliVersion: null, isTeamMode: true, loadWarnings: [] });
    const { repo, root } = await teamProject({ fence: "1.4.4" });
    await teamSetup(root);
    expect(checkResolutionKindReadiness((await loadProject(root)).state, ctx(root))).toEqual([]);

    git(repo, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    const path = join(root, ".story", "config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), team: { enabled: true, minCliVersion: "1.15.9" } }, null, 2) + "\n");
    const findings = checkResolutionKindReadiness((await loadProject(root)).state, ctx(root));
    expect(findings.map((f) => [f.code, f.severity])).toEqual([["resolution_kind_fence", "error"], ["resolution_kind_merge_driver", "error"]]);
    expect(findings.every((f) => f.message.includes("storybloq team setup"))).toBe(true);
    expect((await handleTeamDoctor(root, { ci: true, format: "json" })).exitCode).not.toBe(0);
  });

  it("F5: a non-team project has no resolution-kind readiness to report", async () => {
    const root = temp("t486-u13-solo-");
    await initProject(root, { name: "solo" });
    expect(checkResolutionKindReadiness((await loadProject(root)).state, { root, cliVersion: null, isTeamMode: false, loadWarnings: [] })).toEqual([]);
  });
});

describe("the legacy command stays registered", () => {
  it("setup registers storybloq-json, v4 and v5, each with its generated command", async () => {
    const { repo, root } = await teamProject();
    await teamSetup(root);
    expect(git(repo, "config", "--local", "--get", "merge.storybloq-json.driver")).toBe(MERGE_DRIVER_CMD);
    expect(git(repo, "config", "--local", "--get", `merge.${MERGE_DRIVER_V4_NAME}.driver`)).toBe(MERGE_DRIVER_V4_CMD);
    expect(git(repo, "config", "--local", "--get", `merge.${MERGE_DRIVER_V5_NAME}.driver`)).toBe(MERGE_DRIVER_V5_CMD);
    expect(existsSync(infoAttributes(repo))).toBe(true);
  });
});
