/**
 * T-486 A9: doctor severities for resolution-kind readiness, by observable
 * facts only. An absent capability is a warning; a wrong state is an error.
 * Every fixture is a standalone temp directory (repository, bare repository,
 * clone or linked worktree of a temp repository), with a scratch HOME and
 * global git config.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { MERGE_DRIVER_CMD, MERGE_DRIVER_V5_CMD, MERGE_DRIVER_V5_NAME, teamSetup, type GitRead, gitRead } from "../../src/core/team-setup.js";
import { enableCheckpoints } from "../../src/core/checkpoint-enable.js";
import { mergeDriverCapabilities } from "../../src/cli/commands/merge-driver.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { handleTeamDoctor } from "../../src/cli/commands/team-doctor.js";
import { resolutionDigest } from "../../src/core/resolution-kind.js";
import {
  RESOLUTION_PROBE_PATH,
  checkResolutionKindReadiness,
  checkRulingLifecycleReadiness,
  type DoctorFinding,
  type ResolutionReadinessDeps,
} from "../../src/core/team-doctor.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
let globalConfig: string;
const ENV_KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "STORYBLOQ_VERSION", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-a9-home-"));
  globalConfig = join(scratchHome, "gitconfig");
  for (const k of ENV_KEYS) saved[k] = process.env[k];
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
  for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[k];
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function temp(prefix = "t486-a9-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function teamBoard(root: string): Promise<void> {
  await initProject(root, { name: "t486" });
  const path = join(root, ".story", "config.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf-8")), team: { enabled: true } }, null, 2) + "\n");
}

/** A team board set up by the current handlers in a fresh repository. */
async function ready(): Promise<string> {
  const root = temp();
  git(root, "init", "-q", "-b", "main");
  await teamBoard(root);
  await teamSetup(root);
  return root;
}

function setFence(root: string, fence: string | null): void {
  const path = join(root, ".story", "config.json");
  const c = JSON.parse(readFileSync(path, "utf-8"));
  if (fence === null) delete c.team.minCliVersion;
  else c.team.minCliVersion = fence;
  writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
}

const infoAttributes = (repo: string) => join(repo, git(repo, "rev-parse", "--git-path", "info/attributes"));
const editInfo = (repo: string, edit: (text: string) => string) => {
  const p = infoAttributes(repo);
  let text = "";
  try {
    text = readFileSync(p, "utf-8");
  } catch {
    text = "";
  }
  writeFileSync(p, edit(text));
};

const ctx = (root: string) => ({ root, cliVersion: null, isTeamMode: true, loadWarnings: [] });

async function doctor(root: string, deps: ResolutionReadinessDeps = {}): Promise<DoctorFinding[]> {
  return checkResolutionKindReadiness((await loadProject(root)).state, ctx(root), deps);
}
const rows = (findings: DoctorFinding[]) => findings.map((f) => [f.severity, f.code]);

const FENCE_WARNING = (v: string) =>
  `team.minCliVersion is ${v}; resolution-kind writes are refused on this board until someone runs storybloq team setup on a 1.16.0+ CLI and commits the config.`;

describe("A9 fence rows (F1, F2)", () => {
  it("F1: a low fence with no effective kind is a warning with the one-line upgrade message", async () => {
    const root = await ready();
    setFence(root, null);
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_fence"]]);
    expect(findings[0]!.message).toBe(FENCE_WARNING("unset"));
    setFence(root, "1.15.9");
    expect((await doctor(root))[0]!.message).toBe(FENCE_WARNING("1.15.9"));
  });

  it("F2: an effective kind under a low fence is an error naming the issue", async () => {
    const root = await ready();
    const created = JSON.parse(
      (await handleIssueCreate({ title: "a bug", severity: "medium", impact: "it breaks", components: [], relatedTickets: [], location: [] }, "json", root)).output,
    ).data as { id: string; displayId?: string };
    setFence(root, "1.15.0");
    const path = join(root, ".story", "issues", `${created.id}.json`);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({
      ...raw, status: "resolved", resolvedDate: "2026-09-01", resolution: "fixed it",
      resolutionKind: { kind: "fixed", closedOn: "2026-09-01", resolutionDigest: resolutionDigest("fixed it") },
    }, null, 2) + "\n");
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["error", "resolution_kind_unfenced"]]);
    expect(findings[0]!.message).toBe(
      `1 issue(s) (${created.displayId ?? created.id}) carry an effective resolution kind but team.minCliVersion is 1.15.0, so a pre-1.16.0 client may write this board; run storybloq team setup on a 1.16.0+ CLI and commit the config.`,
    );
  });
});

describe("A9-1 work tree rows (G0, G1)", () => {
  it("G0: a plain directory with no .git anywhere is a warning only", async () => {
    const root = temp();
    await teamBoard(root);
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_fence"], ["warning", "resolution_kind_no_git"]]);
    expect(findings[1]!.message).toBe("This board is not in a git work tree, so resolution-kind writes are refused here; run storybloq team setup inside the clone.");
  });

  it("G1: a bare repository is an error", async () => {
    const root = temp();
    git(root, "init", "-q", "--bare");
    await teamBoard(root);
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_fence"], ["error", "resolution_kind_git"]]);
    expect(findings[1]!.message).toContain("without a work tree");
  });

  it("G1: a .git directory with HEAD removed is an error naming the repository", async () => {
    const root = await ready();
    unlinkSync(join(root, ".git", "HEAD"));
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["error", "resolution_kind_git"]]);
    expect(findings[0]!.message).toContain(`git rejects the repository at ${join(root, ".git")}`);
  });

  it("G1: a gitfile pointing at a missing gitdir is an error", async () => {
    const root = temp();
    await teamBoard(root);
    writeFileSync(join(root, ".git"), `gitdir: ${join(root, "missing-gitdir")}\n`);
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_fence"], ["error", "resolution_kind_git"]]);
    expect(findings[1]!.message).toContain(`git rejects the repository at ${join(root, ".git")}`);
  });

  it("G1: GIT_DIR naming a nonexistent path is an error naming the variable", async () => {
    const root = await ready();
    const findings = await doctor(root, { env: { ...process.env, GIT_DIR: join(root, "nowhere") } });
    expect(rows(findings)).toEqual([["error", "resolution_kind_git"]]);
    expect(findings[0]!.message).toContain("git rejects the repository named by GIT_DIR");
  });

  it("G1: a check-attr failure inside a work tree is an error, never absence", async () => {
    const root = await ready();
    const failing: GitRead = (args, cwd) => {
      if (args[0] === "check-attr") throw Object.assign(new Error("boom"), { status: 128, stderr: "fatal: boom" });
      return gitRead(args, cwd);
    };
    const findings = await doctor(root, { git: failing });
    expect(rows(findings)).toEqual([["error", "resolution_kind_git"]]);
    expect(findings[0]!.message).toBe(`git could not report how this clone merges ${RESOLUTION_PROBE_PATH}: fatal: boom.`);
  });
});

describe("A9 registration rows (M1 to M6)", () => {
  it("M3: a set-up clone has no resolution-kind finding", async () => {
    expect(await doctor(await ready())).toEqual([]);
  });

  it("M1: a local mismatch is an error naming scope, origin and the removal", async () => {
    const root = await ready();
    git(root, "config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, "cat %A");
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["error", "resolution_kind_merge_driver"]]);
    expect(findings[0]!.message).toBe(
      `merge.${MERGE_DRIVER_V5_NAME}.driver = "cat %A" from local config (file:.git/config) is not the command team setup generates; remove it (git config --local --unset-all merge.${MERGE_DRIVER_V5_NAME}.driver) and run storybloq team setup.`,
    );
  });

  it("M1: a global mismatch wins over no local value and is named global", async () => {
    const root = await ready();
    git(root, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    writeFileSync(globalConfig, `[merge "${MERGE_DRIVER_V5_NAME}"]\n\tdriver = cat %A\n`);
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["error", "resolution_kind_merge_driver"]]);
    expect(findings[0]!.message).toContain(`from global config (file:${globalConfig})`);
    expect(findings[0]!.message).toContain(`git config --global --unset-all merge.${MERGE_DRIVER_V5_NAME}.driver`);
  });

  it("M3: a global mismatch shadowed by the local registration git runs is ready (the last record wins)", async () => {
    const root = await ready();
    writeFileSync(globalConfig, `[merge "${MERGE_DRIVER_V5_NAME}"]\n\tdriver = cat %A\n`);
    expect(await doctor(root)).toEqual([]);
  });

  it("G1: a registration read that fails is an error, never absence", async () => {
    const root = await ready();
    const failing: GitRead = (args, cwd) => {
      if (args[0] === "config") throw Object.assign(new Error("boom"), { status: 128, stderr: "fatal: bad config" });
      return gitRead(args, cwd);
    };
    const findings = await doctor(root, { git: failing });
    expect(rows(findings)).toEqual([["error", "resolution_kind_git"]]);
    expect(findings[0]!.message).toBe(`git could not report how this clone merges ${RESOLUTION_PROBE_PATH}: fatal: bad config.`);
  });

  it("M1: a command-scope mismatch names the command line or environment", async () => {
    const root = await ready();
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `merge.${MERGE_DRIVER_V5_NAME}.driver`;
    process.env.GIT_CONFIG_VALUE_0 = "cat %A";
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["error", "resolution_kind_merge_driver"]]);
    expect(findings[0]!.message).toContain("from command config");
    expect(findings[0]!.message).toContain("remove it from the command line or GIT_CONFIG_* environment and run storybloq team setup.");
  });

  it("M2: an attribute naming a driver setup never generates is an error", async () => {
    const root = await ready();
    editInfo(root, (t) => t + ".story/issues/*.json merge=foreign-merge\n");
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["error", "resolution_kind_merge_driver"]]);
    expect(findings[0]!.message).toBe(`git merges ${RESOLUTION_PROBE_PATH} with foreign-merge, a driver team setup never generates; remove that attribute and run storybloq team setup.`);
  });

  it.each([["storybloq-json-v4"], ["storybloq-json"]])("M4: a clone selecting %s, registered as setup generates it, is a warning", async (name) => {
    const root = await ready();
    editInfo(root, (t) => t.replaceAll(`merge=${MERGE_DRIVER_V5_NAME}`, `merge=${name}`));
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_clone_setup"]]);
    expect(findings[0]!.message).toBe(`This clone merges issues with ${name}, not ${MERGE_DRIVER_V5_NAME}, so resolution-kind writes are refused here until storybloq team setup runs in this clone.`);
  });

  it("M5: the selected driver unregistered is a warning", async () => {
    const root = await ready();
    git(root, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_clone_setup"]]);
    expect(findings[0]!.message).toBe(`git would merge ${RESOLUTION_PROBE_PATH} with ${MERGE_DRIVER_V5_NAME}, which is not registered in this clone (issue merges fall back to text, and resolution-kind writes are refused) until storybloq team setup runs in this clone.`);
  });

  it.each([["unspecified", "!merge"], ["unset", "-merge"]])("M6 (A9-2): merge attribute %s is a warning naming it", async (value, attr) => {
    const root = await ready();
    editInfo(root, (t) => t + `.story/issues/*.json ${attr}\n`);
    const findings = await doctor(root);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_clone_setup"]]);
    expect(findings[0]!.message).toBe(`no supported storybloq merge driver is selected for ${RESOLUTION_PROBE_PATH} (merge attribute: ${value}), so resolution-kind writes are refused in this clone; run storybloq team setup.`);
  });
});

describe("A9 clones that never ran setup", () => {
  async function committedClone(prepare?: (root: string) => Promise<void>): Promise<{ origin: string; clone: string }> {
    const origin = await ready();
    if (prepare) await prepare(origin);
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "set up");
    const parent = temp();
    const clone = join(parent, "clone");
    git(parent, "clone", "-q", origin, clone);
    return { origin, clone };
  }

  it("a fresh clone of a set-up board is warning-only and doctor --ci exits 0", async () => {
    const { clone } = await committedClone();
    expect(rows(await doctor(clone))).toEqual([["warning", "resolution_kind_clone_setup"]]);
    expect((await handleTeamDoctor(clone, { ci: true, format: "json" })).exitCode).toBe(0);
  });

  it("a fresh clone inheriting a matching GLOBAL registration is M4, and a global mismatch is M1", async () => {
    const { clone } = await committedClone();
    writeFileSync(globalConfig, `[merge "storybloq-json"]\n\tdriver = ${MERGE_DRIVER_CMD}\n`);
    const findings = await doctor(clone);
    expect(rows(findings)).toEqual([["warning", "resolution_kind_clone_setup"]]);
    expect(findings[0]!.message).toContain("merges issues with storybloq-json, not storybloq-json-v5");
    writeFileSync(globalConfig, `[merge "storybloq-json"]\n\tdriver = cat %A\n`);
    const wrong = await doctor(clone);
    expect(rows(wrong)).toEqual([["error", "resolution_kind_merge_driver"]]);
    expect(wrong[0]!.message).toContain("from global config");
    expect((await handleTeamDoctor(clone, { ci: true, format: "json" })).exitCode).toBe(1);
  });

  it("a linked worktree inherits the set-up clone (M3), and a worktree-scoped mismatch is M1 naming worktree", async () => {
    const { origin } = await committedClone();
    const wt = join(temp(), "wt");
    git(origin, "worktree", "add", "-q", wt);
    expect(await doctor(wt)).toEqual([]);
    git(origin, "config", "extensions.worktreeConfig", "true");
    git(wt, "config", "--worktree", `merge.${MERGE_DRIVER_V5_NAME}.driver`, "cat %A");
    const findings = await doctor(wt);
    expect(rows(findings)).toEqual([["error", "resolution_kind_merge_driver"]]);
    expect(findings[0]!.message).toContain("from worktree config");
    expect(findings[0]!.message).toContain(`git config --worktree --unset-all merge.${MERGE_DRIVER_V5_NAME}.driver`);
    expect(rows(await doctor(origin))).toEqual([]);
  });

  it("checkpoint control: a fresh clone of a checkpoint-enabled board still errors on checkpoint merges", async () => {
    const { clone } = await committedClone(async (root) => {
      await enableCheckpoints(root, { capabilities: async (_r, protocol) => mergeDriverCapabilities(protocol) });
    });
    const out = await handleTeamDoctor(clone, { ci: true, format: "json" });
    expect(out.exitCode).toBe(1);
    const codes = (JSON.parse(out.output).data.findings as DoctorFinding[]).filter((f) => f.severity === "error").map((f) => f.code);
    expect(codes).toEqual(["checkpoint_merge_driver"]);
  });
});

describe("A9 ruling registration follows the same rows", () => {
  async function rulingCodes(root: string): Promise<[string, string][]> {
    const state = (await loadProject(root)).state;
    mkdirSync(join(root, ".story", "rulings"), { recursive: true });
    writeFileSync(join(root, ".story", "rulings", "r-0000000000000001.json"), "{}");
    try {
      return checkRulingLifecycleReadiness(state, ctx(root)).map((f) => [f.severity, f.code]);
    } finally {
      rmSync(join(root, ".story", "rulings", "r-0000000000000001.json"));
    }
  }

  it("a matching v5, v4 or legacy registration is ready", async () => {
    const root = await ready();
    expect(await rulingCodes(root)).toEqual([]);
    for (const name of ["storybloq-json-v4", "storybloq-json"]) {
      editInfo(root, (t) => t.replaceAll(/merge=storybloq-json(-v[45])?\b/g, `merge=${name}`));
      expect(await rulingCodes(root), name).toEqual([]);
    }
  });

  it("an absent registration is a warning and a mismatch is an error", async () => {
    const root = await ready();
    git(root, "config", "--local", "--unset", `merge.${MERGE_DRIVER_V5_NAME}.driver`);
    expect(await rulingCodes(root)).toEqual([["warning", "ruling_merge_driver_registration"]]);
    git(root, "config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, "cat %A");
    expect(await rulingCodes(root)).toEqual([["error", "ruling_merge_driver_registration"]]);
    git(root, "config", "--local", `merge.${MERGE_DRIVER_V5_NAME}.driver`, MERGE_DRIVER_V5_CMD);
    expect(await rulingCodes(root)).toEqual([]);
  });
});
