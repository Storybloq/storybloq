/**
 * ISS-1432: `storybloq land` through the real built binary (dist/cli.js) in a
 * child process with a scratch HOME and a minimal environment. gitleaks is
 * the fixture's fake script, first on PATH.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempDirs, git, isolateGit } from "../mcp/board-git-fixtures.js";
import { commit, fixture, landingsOf, listFiles, refsAndCount, remoteTip, type Fx } from "../core/land-fixtures.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");

let restoreGit: () => void;
beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`build first: ${CLI} is missing`);
});
beforeEach(() => { restoreGit = isolateGit(); });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

interface Run { status: number | null; stdout: string; stderr: string }

function cli(fx: Fx, cwd: string, args: string[], extraEnv: Record<string, string> = {}): Run {
  const env: Record<string, string> = {
    HOME: fx.home,
    STORYBLOQ_GLOBAL_DIR: join(fx.home, "storybloq-global"),
    PATH: fx.env.PATH!,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    CI: "1",
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [CLI, "land", ...args], { cwd, env, encoding: "utf-8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

type Data = Record<string, unknown> & {
  status: string; sha: string; repo: string | null; boardRoot: string | null; remote: string; remoteUrl: string | null;
  branch: string; priorTip: string | null; steps: { step: string; number: number; outcome: string; detail?: string }[];
  held?: { step: string; number: number; reason: string; outcomeUnknown: boolean };
  receipt: { status: string; item?: string; reason?: string; error?: string; entry?: Record<string, unknown> };
  git?: { path: string; state: string }[]; gitCommit?: unknown; gitUnavailable?: { reason: string };
};

function data(run: Run): Data {
  return (JSON.parse(run.stdout) as { data: Data }).data;
}

function expectTyped(d: Data): void {
  expect(["landed", "held"]).toContain(d.status);
  expect(typeof d.sha).toBe("string");
  expect(typeof d.remote).toBe("string");
  expect(typeof d.branch).toBe("string");
  expect(d.repo === null || typeof d.repo === "string").toBe(true);
  expect(d.boardRoot === null || typeof d.boardRoot === "string").toBe(true);
  expect(d.remoteUrl === null || typeof d.remoteUrl === "string").toBe(true);
  expect(d.priorTip === null || typeof d.priorTip === "string").toBe(true);
  for (const s of d.steps) {
    expect(typeof s.step).toBe("string");
    expect(typeof s.number).toBe("number");
    expect(["passed", "skipped", "held"]).toContain(s.outcome);
  }
  if (d.status === "held") {
    expect(typeof d.held?.reason).toBe("string");
    expect(typeof d.held?.outcomeUnknown).toBe("boolean");
  } else {
    expect(d.held).toBeUndefined();
  }
  expect(["not-requested", "not-attempted", "written", "failed"]).toContain(d.receipt.status);
}

/** Runs the same scenario in text and JSON, each on a fresh fixture. */
async function both(setup: (fx: Fx) => string[] | Promise<string[]>): Promise<{ text: Run; json: Run; fxText: Fx; fxJson: Fx }> {
  const fxText = await fixture();
  const text = cli(fxText, fxText.repo, await setup(fxText));
  const fxJson = await fixture();
  const json = cli(fxJson, fxJson.repo, [...(await setup(fxJson)), "--format", "json"]);
  return { text, json, fxText, fxJson };
}

describe("storybloq land on the CLI (ISS-1432)", () => {
  it("X1: landed, exit 0", async () => {
    const { text, json, fxJson } = await both((fx) => [commit(fx, { "b.txt": "b\n" })]);
    expect(text.status).toBe(0);
    expect(text.stdout).toMatch(/^land: repo /);
    expect(text.stdout).toMatch(/LANDED [0-9a-f]{40}/);
    expect(json.status).toBe(0);
    const d = data(json);
    expectTyped(d);
    expect(d.status).toBe("landed");
    expect(d.receipt.status).toBe("not-requested");
    expect(remoteTip(fxJson)).toBe(d.sha);
  });

  it("X1: preflight HELD with --item, exit 1, receipt not-attempted", async () => {
    const { text, json } = await both((fx) => [commit(fx, { "b.txt": "b\n" }), "--item", fx.ticket.display, "--branch", "a..b"]);
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("HELD 0 preflight: invalid branch name a..b");
    expect(json.status).toBe(1);
    const d = data(json);
    expectTyped(d);
    expect(d.held).toEqual({ step: "preflight", number: 0, reason: "invalid branch name a..b", outcomeUnknown: false });
    expect(d.receipt).toEqual({ status: "not-attempted", item: expect.any(String), reason: "held at step 0 preflight" });
  });

  it("X7: a pattern with a comma reaches land whole (arrayOption, comma literal)", async () => {
    // Split on the comma, x{1 and 3}y would each be refused as invalid patterns at step 0.
    const { text, json } = await both((fx) => [commit(fx, { "b.txt": "xxy\n" }), "--hygiene-pattern", "q=x{1,3}y"]);
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("HELD 3 hygiene: b.txt:1 q");
    const d = data(json);
    expectTyped(d);
    expect(d.held).toEqual({ step: "hygiene", number: 3, reason: "b.txt:1 q", outcomeUnknown: false });
  });

  it("X8: an empty pattern is kept and refused by name, not dropped", async () => {
    const t = await both((fx) => [commit(fx, { "b.txt": "b\n" }), "--trailer-pattern", ""]);
    expect(t.text.status).toBe(1);
    expect(t.text.stdout).toContain("HELD 0 preflight: invalid pattern trailer-pattern 1: empty");
    expect(data(t.json).held).toEqual({ step: "preflight", number: 0, reason: "invalid pattern trailer-pattern 1: empty", outcomeUnknown: false });
    const h = await both((fx) => [commit(fx, { "b.txt": "b\n" }), "--hygiene-pattern", "a=AAA", "--hygiene-pattern", ""]);
    expect(h.text.status).toBe(1);
    expect(data(h.json).held).toEqual({ step: "preflight", number: 0, reason: "invalid pattern hygiene-pattern 2: empty", outcomeUnknown: false });
  });

  it("X1: post-push HELD with --item, exit 1, receipt not-attempted", async () => {
    const deny = (fx: Fx) => {
      const hook = join(fx.origin, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\necho denied >&2\nexit 1\n");
      spawnSync("chmod", ["755", hook]);
      return [commit(fx, { "b.txt": "b\n" }), "--item", fx.ticket.display];
    };
    const { text, json, fxJson } = await both(deny);
    expect(text.status).toBe(1);
    expect(text.stdout).toMatch(/HELD 5 push: rejected .*denied/);
    expect(json.status).toBe(1);
    const d = data(json);
    expectTyped(d);
    expect(d.held?.number).toBe(5);
    expect(d.receipt.status).toBe("not-attempted");
    expect(landingsOf(fxJson.ticket.path)).toBeUndefined();
  });

  it("X1: skipped scan, exit 0", async () => {
    const { text, json } = await both((fx) => [commit(fx, { "b.txt": "b\n" }), "--no-secrets-scan"]);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain("4 secrets skipped: --no-secrets-scan");
    const d = data(json);
    expectTyped(d);
    expect(d.steps.find((s) => s.step === "secrets")?.outcome).toBe("skipped");
  });

  it("X1: partial receipt failure, exit 3", async () => {
    const poison = (fx: Fx) => {
      const raw = JSON.parse(readFileSync(fx.ticket.path, "utf-8")) as Record<string, unknown>;
      writeFileSync(fx.ticket.path, JSON.stringify({ ...raw, landings: "x" }, null, 2));
      return [commit(fx, { "b.txt": "b\n" }), "--item", fx.ticket.display];
    };
    const { text, json } = await both(poison);
    expect(text.status).toBe(3);
    expect(text.stdout).toMatch(/LANDED [0-9a-f]{40} \(receipt not written: existing landings is not an array\)/);
    expect(json.status).toBe(3);
    const d = data(json);
    expectTyped(d);
    expect(d.status).toBe("landed");
    expect(d.receipt).toEqual({ status: "failed", item: expect.any(String), error: "existing landings is not an array" });
  });

  it("X1: unresolved remote, exit 1", async () => {
    const { text, json } = await both((fx) => [commit(fx, { "b.txt": "b\n" }), "--remote", "nosuch"]);
    expect(text.status).toBe(1);
    expect(text.stdout).toContain("remote nosuch unresolved");
    const d = data(json);
    expectTyped(d);
    expect(d.remoteUrl).toBeNull();
    expect(d.held?.reason).toBe("remote nosuch not found");
  });

  it("X4: GIT_DIR in the CLI env steers neither land nor the report", async () => {
    const fx = await fixture();
    const second = join(fx.base, "second");
    mkdirSync(second);
    git(second, "init", "-q", "-b", "main");
    writeFileSync(join(second, "s.txt"), "s\n");
    git(second, "add", "-A");
    git(second, "commit", "-q", "-m", "s");
    const before = refsAndCount(second);
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = cli(fx, fx.repo, [sha, "--item", fx.ticket.display], {
      GIT_DIR: join(second, ".git"),
      GIT_OBJECT_DIRECTORY: join(second, ".git", "objects"),
    });
    expect(run.status).toBe(0);
    expect(remoteTip(fx)).toBe(sha);
    const rel = relative(fx.repo, fx.ticket.path);
    expect(run.stdout.split("\n")).toContain(`Git: ${rel} modified`);
    expect(refsAndCount(second)).toBe(before);
  });

  it("X5: the receipt-success JSON envelope", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = cli(fx, fx.repo, [sha, "--item", fx.ticket.display, "--format", "json"]);
    expect(run.status).toBe(0);
    const d = data(run);
    expectTyped(d);
    expect(d.receipt.status).toBe("written");
    expect(Array.isArray(d.git)).toBe(true);
    expect(d.git!.length).toBeGreaterThan(0);
    for (const e of d.git!) {
      expect(typeof e.path).toBe("string");
      expect(typeof e.state).toBe("string");
    }
    expect("gitCommit" in d).toBe(false);
    expect("gitUnavailable" in d).toBe(false);
  });

  it("X6: a board outside any git repository reports gitUnavailable", async () => {
    const fx = await fixture({ board: "separate" });
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = cli(fx, fx.board, [sha, "--repo", fx.repo, "--item", fx.ticket.display, "--format", "json"]);
    expect(run.status).toBe(0);
    const d = data(run);
    expect(d.status).toBe("landed");
    expect(d.receipt.status).toBe("written");
    expect(typeof d.gitUnavailable).toBe("object");
    expect(typeof d.gitUnavailable?.reason).toBe("string");
    expect(remoteTip(fx)).toBe(sha);
  });

  it("X9: an unreadable board in the current folder does not stop land without --item, and is HELD 0 with it", async () => {
    const fx = await fixture();
    const cwd = join(fx.base, "elsewhere");
    mkdirSync(join(cwd, ".story"), { recursive: true });
    chmodSync(join(cwd, ".story"), 0o000);
    try {
      const sha = commit(fx, { "b.txt": "b\n" });
      const held = cli(fx, cwd, [sha, "--repo", fx.repo, "--item", fx.ticket.display, "--format", "json"]);
      expect(held.status, held.stdout + held.stderr).toBe(1);
      const h = data(held);
      expectTyped(h);
      expect(h.held?.step).toBe("preflight");
      expect(h.held?.number).toBe(0);
      expect(h.held?.reason).toMatch(/^board could not be discovered: /);
      expect(remoteTip(fx)).toBe(fx.T);
      const landed = cli(fx, cwd, [sha, "--repo", fx.repo, "--format", "json"]);
      expect(landed.status, landed.stdout + landed.stderr).toBe(0);
      const d = data(landed);
      expectTyped(d);
      expect(d.status).toBe("landed");
      expect(remoteTip(fx)).toBe(sha);
    } finally {
      chmodSync(join(cwd, ".story"), 0o755);
    }
  });

  it("X10: a credential in the remote URL is HELD 0 and appears in no output and no board file", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.url", "https://user:SENTINEL-c4f1e9@127.0.0.1:9/x.git");
    const sha = commit(fx, { "b.txt": "b\n" });
    for (const extra of [[], ["--format", "json"]]) {
      const run = cli(fx, fx.repo, [sha, "--item", fx.ticket.display, ...extra]);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("remote origin URL carries credentials; use a credential helper");
      expect(run.stdout + run.stderr).not.toContain("SENTINEL");
    }
    for (const f of listFiles(join(fx.board, ".story"))) {
      expect(readFileSync(join(fx.board, ".story", f), "utf-8")).not.toContain("SENTINEL");
    }
  });
});
