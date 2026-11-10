/**
 * ISS-1432: `storybloq land <sha>` core. Each row drives the real `land()`
 * against real git on temp repositories, through a recording runner that is
 * the push-attempt oracle. Some rows inject one subprocess result.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { cleanupTempDirs, git, headSha, installHook, isolateGit } from "../mcp/board-git-fixtures.js";
import { formatLandText } from "../../src/core/land.js";
import { PENDING_JOURNAL_MESSAGE } from "../../src/core/project-loader.js";
import {
  CLOCK, HOME_PREFIX, bytes, commit, exitResult, fixture, gitleaksCalls, landingsOf, listFiles, lsRemotes, network,
  otherClone, pushFixture, pushRecordClass, pushes, refsAndCount, remoteTip, runLand, sha256, sub, subArgs,
  writePendingJournal, type Call, type Fx, type LandRun,
} from "./land-fixtures.js";

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

const short = (sha: string) => sha.slice(0, 12);

function expectNoLandings(fx: Fx): void {
  expect(landingsOf(fx.ticket.path)).toBeUndefined();
  expect(landingsOf(fx.issue.path)).toBeUndefined();
}

/** The assertions every HELD row makes (round 3 ruling 5). */
function expectHeld(fx: Fx, run: LandRun, number: number, reason: string, opts: { item?: boolean; unknown?: boolean } = {}): void {
  expect(run.result.status).toBe("held");
  expect(run.result.held?.number).toBe(number);
  expect(run.result.held?.reason).toBe(reason);
  expect(run.exit).toBe(1);
  expect(run.result.receipt.status).toBe(opts.item ? "not-attempted" : "not-requested");
  expectNoLandings(fx);
  expect(pushes(run.calls).length).toBe(number < 5 ? 0 : 1);
  if (number >= 5) expect(run.result.held?.outcomeUnknown).toBe(opts.unknown ?? false);
  if (number === 6) expect(lsRemotes(run.calls).length).toBe(2);
}

function expectLanded(fx: Fx, run: LandRun, sha: string): void {
  expect(remoteTip(fx)).toBe(sha);
  expect(run.result.status).toBe("landed");
  expect(run.exit).toBe(0);
}

/** One added line in a new file x.txt, landed without an item. */
async function landLine(fx: Fx, line: string, extra: Parameters<typeof runLand>[1] = {}): Promise<{ run: LandRun; sha: string }> {
  const sha = commit(fx, { "x.txt": `${line}\n` });
  return { run: await runLand(fx, extra), sha };
}

describe("land: happy path, writes and environment (ISS-1432)", () => {
  it("L1: one commit on T with a ticket receipt", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "hello\n" });
    const run = await runLand(fx, { item: fx.ticket.display });
    expect(remoteTip(fx)).toBe(sha);
    const landings = landingsOf(fx.ticket.path) as Record<string, unknown>[];
    expect(landings).toHaveLength(1);
    expect(landings[0]).toEqual({
      sha, remote: "origin", remoteUrl: fx.origin, branch: "main", priorTip: fx.T, landedAt: CLOCK.toISOString(),
      steps: [
        { step: "preflight", outcome: "passed" }, { step: "fast-forward", outcome: "passed" }, { step: "trailers", outcome: "passed" },
        { step: "hygiene", outcome: "passed" }, { step: "secrets", outcome: "passed" }, { step: "push", outcome: "passed" },
        { step: "verify", outcome: "passed" },
      ],
    });
    expect(run.result.status).toBe("landed");
    expect(run.exit).toBe(0);
    expect(run.result.receipt.status).toBe("written");
    expect(run.result.priorTip).toBe(fx.T);
    expect(run.result.repo).toBe(fx.repo);
  });

  it("L1b: lands HEAD~1 when HEAD is two ahead", async () => {
    const fx = await fixture();
    const first = commit(fx, { "b.txt": "1\n" });
    commit(fx, { "c.txt": "2\n" });
    const run = await runLand(fx, { sha: "HEAD~1" });
    expect(remoteTip(fx)).toBe(first);
    expect(run.result.sha).toBe(first);
    expect(run.exit).toBe(0);
  });

  it("I1: an issue receipt lands on the issue file only", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "hello\n" });
    const ticketBefore = bytes(fx.ticket.path);
    const run = await runLand(fx, { item: fx.issue.display });
    expect(landingsOf(fx.issue.path)).toHaveLength(1);
    expect(bytes(fx.ticket.path)).toBe(ticketBefore);
    expect(run.result.receipt.status).toBe("written");
  });

  it("I2: a second landing appends, the first unchanged", async () => {
    const fx = await fixture();
    const prior = { sha: "0".repeat(40), remote: "origin" };
    const json = JSON.parse(readFileSync(fx.issue.path, "utf-8")) as Record<string, unknown>;
    writeFileSync(fx.issue.path, JSON.stringify({ ...json, landings: [prior] }, null, 2));
    commit(fx, { "b.txt": "hello\n" });
    await runLand(fx, { item: fx.issue.display });
    const landings = landingsOf(fx.issue.path) as unknown[];
    expect(landings).toHaveLength(2);
    expect(landings[0]).toEqual(prior);
  });

  it("W1: board == repo; only the receipt file changes", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "hello\n" });
    writeFileSync(join(fx.repo, "untracked.txt"), "keep me\n");
    const index = sha256(join(fx.repo, ".git", "index"));
    const status = git(fx.repo, "status", "--porcelain=v1", "-uall");
    const refs = refsAndCount(fx.repo);
    const story = listFiles(join(fx.repo, ".story"));
    const run = await runLand(fx, { item: fx.ticket.display });
    expect(run.exit).toBe(0);
    expect(sha256(join(fx.repo, ".git", "index"))).toBe(index);
    const after = git(fx.repo, "status", "--porcelain=v1", "-uall").split("\n").filter(Boolean);
    const delta = after.filter((l) => !status.split("\n").includes(l));
    expect(delta).toEqual([` M ${relative(fx.repo, fx.ticket.path)}`]);
    expect(readFileSync(join(fx.repo, "untracked.txt"), "utf-8")).toBe("keep me\n");
    expect(refsAndCount(fx.repo)).toBe(refs);
    expect(listFiles(join(fx.repo, ".story"))).toEqual(story);
  });

  it("W2: board outside the repo; the landed repo is untouched", async () => {
    const fx = await fixture({ board: "separate" });
    commit(fx, { "b.txt": "hello\n" });
    const index = sha256(join(fx.repo, ".git", "index"));
    const status = git(fx.repo, "status", "--porcelain=v1", "-uall");
    const refs = refsAndCount(fx.repo);
    const run = await runLand(fx, { item: fx.ticket.display });
    expect(run.exit).toBe(0);
    expect(landingsOf(fx.ticket.path)).toHaveLength(1);
    expect(sha256(join(fx.repo, ".git", "index"))).toBe(index);
    expect(git(fx.repo, "status", "--porcelain=v1", "-uall")).toBe(status);
    expect(refsAndCount(fx.repo)).toBe(refs);
  });

  it("P1: exactly one push with the pinned URL and the lease", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "hello\n" });
    const run = await runLand(fx);
    const p = pushes(run.calls);
    expect(p).toHaveLength(1);
    expect(subArgs(p[0]!)).toEqual([
      "push", "--porcelain", "--no-verify", "--no-follow-tags", "--recurse-submodules=no",
      `--force-with-lease=refs/heads/main:${fx.T}`, fx.origin, `${sha}:refs/heads/main`,
    ]);
    for (const c of run.calls) {
      expect(c.args).not.toContain("--force");
      expect(c.args).not.toContain("-f");
    }
    for (const c of network(run.calls)) {
      expect(subArgs(c)).not.toContain("origin");
      if (sub(c) === "push") expect(subArgs(c).some((a) => a.startsWith("+"))).toBe(false);
    }
  });

  it("E1: GIT_DIR and GIT_OBJECT_DIRECTORY in the parent env select nothing", async () => {
    const fx = await fixture();
    const second = join(fx.base, "second");
    mkdirSync(second);
    git(second, "init", "-q", "-b", "main");
    writeFileSync(join(second, "s.txt"), "s\n");
    git(second, "add", "-A");
    git(second, "commit", "-q", "-m", "s");
    const before = refsAndCount(second);
    const sha = commit(fx, { "b.txt": "hello\n" });
    const run = await runLand(fx, {
      repo: fx.repo,
      baseEnv: { ...fx.env, GIT_DIR: join(second, ".git"), GIT_OBJECT_DIRECTORY: join(second, ".git", "objects") },
    });
    expectLanded(fx, run, sha);
    expect(run.result.repo).toBe(fx.repo);
    expect(refsAndCount(second)).toBe(before);
  });

  it("E2: every call runs under the sanitised env", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "hello\n" });
    const run = await runLand(fx, {
      baseEnv: { ...fx.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes", GIT_DIR: "/nowhere", GIT_EXTRA: "x", GIT_CONFIG_GLOBAL: "/nowhere", SECRET: "s" },
    });
    expect(run.exit).toBe(0);
    expect(run.calls.length).toBeGreaterThan(10);
    for (const c of run.calls) {
      expect(c.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
      expect(c.env.GIT_NO_LAZY_FETCH).toBe("1");
      expect(c.env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(c.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(Object.keys(c.env).filter((k) => k.startsWith("GIT_")).sort()).toEqual(
        ["GIT_CONFIG_NOSYSTEM", "GIT_NO_LAZY_FETCH", "GIT_NO_REPLACE_OBJECTS", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT"],
      );
      expect(c.env.SECRET).toBeUndefined();
    }
  });

  it("E3: a poisoned global config outside HOME cannot redirect the push", async () => {
    const fx = await fixture();
    const decoy = join(fx.base, "decoy.git");
    git(fx.base, "clone", "-q", "--bare", fx.origin, decoy);
    const decoyBefore = refsAndCount(decoy);
    const poison = join(fx.base, "poison");
    mkdirSync(join(poison, "git"), { recursive: true });
    const cfg = `[url "${decoy}"]\n\tinsteadOf = ${fx.origin}\n\tpushInsteadOf = ${fx.origin}\n`;
    writeFileSync(join(poison, "gitconfig"), cfg);
    writeFileSync(join(poison, "git", "config"), cfg);
    const sha = commit(fx, { "b.txt": "hello\n" });
    const run = await runLand(fx, { baseEnv: { ...fx.env, GIT_CONFIG_GLOBAL: join(poison, "gitconfig"), XDG_CONFIG_HOME: poison } });
    expectLanded(fx, run, sha);
    expect(refsAndCount(decoy)).toBe(decoyBefore);
  });
});

describe("land: step 0 preflight (ISS-1432)", () => {
  it("H0a: a linked worktree is refused", async () => {
    const fx = await fixture();
    const wt = join(fx.base, "wt");
    git(fx.repo, "worktree", "add", "-q", "-b", "wt", wt);
    const run = await runLand(fx, { repo: wt });
    expectHeld(fx, run, 0, "linked worktree: land from the main checkout or a standalone clone");
  });

  it("H0g1: a replace ref that disguises the parent is refused at preflight", async () => {
    const fx = await fixture();
    const tree = git(fx.repo, "rev-parse", `${fx.T}^{tree}`).trim();
    const unrelated = git(fx.repo, "commit-tree", tree, "-m", "unrelated").trim();
    writeFileSync(join(fx.repo, "b.txt"), "b\n");
    git(fx.repo, "add", "-A");
    const tree2 = git(fx.repo, "write-tree").trim();
    const sha = git(fx.repo, "commit-tree", tree2, "-p", unrelated, "-m", "on unrelated").trim();
    git(fx.repo, "replace", unrelated, fx.T);
    const run = await runLand(fx, { sha });
    expectHeld(fx, run, 0, "replacement refs or grafts present");
    expect(network(run.calls)).toHaveLength(0);
  });

  it("H0g2: a replacement with a clean message is refused at preflight", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" }, "dirty\n\nClaude-Session: abc\n");
    const tree = git(fx.repo, "rev-parse", `${sha}^{tree}`).trim();
    const clean = git(fx.repo, "commit-tree", tree, "-p", fx.T, "-m", "clean").trim();
    git(fx.repo, "replace", sha, clean);
    const run = await runLand(fx, { sha });
    expectHeld(fx, run, 0, "replacement refs or grafts present");
  });

  it("H0g3: a replacement blob hiding a home path is refused at preflight", async () => {
    const fx = await fixture();
    commit(fx, { "x.txt": `${HOME_PREFIX}someone/x\n` });
    const dirty = git(fx.repo, "rev-parse", "HEAD:x.txt").trim();
    const clean = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: fx.repo, input: "clean\n", encoding: "utf-8" }).trim();
    git(fx.repo, "replace", dirty, clean);
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "replacement refs or grafts present");
  });

  it("H0g4: an info/grafts file is refused", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    mkdirSync(join(fx.repo, ".git", "info"), { recursive: true });
    writeFileSync(join(fx.repo, ".git", "info", "grafts"), `${sha}\n`);
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "replacement refs or grafts present");
  });

  it.each([
    ["extensions.partialclone", "origin"],
    ["remote.origin.promisor", "true"],
  ])("H0z: %s is refused before any network call", async (key, value) => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    git(fx.repo, "config", key, value);
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "partial clone: land from a full clone");
    expect(network(run.calls)).toHaveLength(0);
  });

  it("H0n: an invalid branch name is refused before any network call", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { branch: "a..b" });
    expectHeld(fx, run, 0, "invalid branch name a..b");
    expect(network(run.calls)).toHaveLength(0);
  });

  it("H0x: an invalid custom pattern is HELD 0", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    let message = "";
    try { new RegExp("("); } catch (err) { message = (err as Error).message; }
    const run = await runLand(fx, { hygienePatterns: ["bad=("] });
    expectHeld(fx, run, 0, `invalid pattern bad: ${message}`);
  });

  it("H0e: an empty custom pattern or an empty regex is HELD 0 by name", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    expectHeld(fx, await runLand(fx, { trailerPatterns: ["x", ""] }), 0, "invalid pattern trailer-pattern 2: empty");
    expectHeld(fx, await runLand(fx, { hygienePatterns: [""] }), 0, "invalid pattern hygiene-pattern 1: empty");
    expectHeld(fx, await runLand(fx, { hygienePatterns: ["n="] }), 0, "invalid pattern n: empty regex");
  });

  it("H0p: a push URL different from the fetch URL is refused", async () => {
    const fx = await fixture();
    const decoy = join(fx.base, "decoy.git");
    git(fx.base, "clone", "-q", "--bare", fx.origin, decoy);
    git(fx.repo, "config", "remote.origin.pushurl", decoy);
    const decoyBefore = refsAndCount(decoy);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "push URL differs from fetch URL");
    expect(remoteTip(fx)).toBe(fx.T);
    expect(refsAndCount(decoy)).toBe(decoyBefore);
  });

  it("H0m: two push URLs are refused", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "--add", "remote.origin.pushurl", fx.origin);
    git(fx.repo, "config", "--add", "remote.origin.pushurl", fx.origin);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "remote origin has 2 push URLs");
  });

  it("H0i: a pushInsteadOf rewrite of the pinned URL is refused", async () => {
    const fx = await fixture();
    const decoy = join(fx.base, "decoy.git");
    git(fx.base, "clone", "-q", "--bare", fx.origin, decoy);
    git(fx.repo, "config", "remote.origin.pushurl", fx.origin);
    git(fx.repo, "config", `url.${decoy}.pushInsteadOf`, fx.origin);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, `url rewrite configured for ${fx.origin}`);
  });

  it("H0i2: an empty pushInsteadOf prefix matches every destination and is refused before any network call", async () => {
    const fx = await fixture();
    const decoy = join(fx.base, "decoy.git");
    git(fx.base, "clone", "-q", "--bare", fx.origin, decoy);
    git(fx.repo, "config", "remote.origin.pushurl", fx.origin);
    git(fx.repo, "config", `url.${decoy}.pushInsteadOf`, "");
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, `url rewrite configured for ${fx.origin}`);
    expect(network(run.calls)).toHaveLength(0);
  });

  it("H0i3: a rewrite whose URL subsection contains a space is parsed whole and refused", async () => {
    const fx = await fixture();
    const decoy = join(fx.base, "decoy dir.git");
    git(fx.base, "clone", "-q", "--bare", fx.origin, decoy);
    git(fx.repo, "config", "remote.origin.pushurl", fx.origin);
    git(fx.repo, "config", `url.${decoy}.pushInsteadOf`, fx.origin);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, `url rewrite configured for ${fx.origin}`);
    expect(network(run.calls)).toHaveLength(0);
  });

  it("H0s: a destination path with a trailing space is kept exactly; its sibling is untouched", async () => {
    const fx = await fixture();
    const spaced = `${fx.origin} `;
    git(fx.base, "clone", "-q", "--bare", fx.origin, spaced);
    git(fx.repo, "config", "remote.origin.url", spaced);
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expect(run.result.status).toBe("landed");
    expect(run.result.remoteUrl).toBe(spaced);
    expect(git(spaced, "rev-parse", "refs/heads/main").trim()).toBe(sha);
    expect(remoteTip(fx)).toBe(fx.T);
  });

  it("H0nl: a remote URL with an embedded newline is refused by name", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.url", `${fx.origin}\nx`);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "remote origin URL contains a newline or NUL");
    expect(network(run.calls)).toHaveLength(0);
  });

  it.each([
    ["H0k1", "https://user:SENTINEL-c4f1e9@127.0.0.1:9/x.git"],
    ["H0k2", "https://SENTINEL-c4f1e9@127.0.0.1:9/x.git"],
    ["H0k3", "ssh://user:SENTINEL-c4f1e9@127.0.0.1:9/x.git"],
  ])("%s: a credential-bearing remote URL is refused without echoing it", async (_row, url) => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.url", url);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display });
    expectHeld(fx, run, 0, "remote origin URL carries credentials; use a credential helper", { item: true });
    expect(network(run.calls)).toHaveLength(0);
    expect(JSON.stringify(run.result)).not.toContain("SENTINEL");
    expect(formatLandText(run.result)).not.toContain("SENTINEL");
    for (const f of listFiles(join(fx.board, ".story"))) {
      expect(readFileSync(join(fx.board, ".story", f), "utf-8")).not.toContain("SENTINEL");
    }
  });

  it("H0k4: a plain user@host ssh URL is not refused as a credential", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.url", "ssh://git@127.0.0.1:9/x.git");
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, {
      intercept: (req) => (req.args.includes("ls-remote") ? exitResult(128, "", "fatal: unreachable") : undefined),
    });
    expect(run.result.status).toBe("held");
    expect(run.result.held?.number).toBe(1);
    expect(run.result.held?.reason).not.toContain("credentials");
  });

  it.each([
    ["H0h1", "url"],
    ["H0h2", "pushurl"],
  ])("%s: a transport-helper %s is refused by name without echoing it", async (_row, key) => {
    const fx = await fixture();
    git(fx.repo, "config", `remote.origin.${key}`, "https::https://user:SENTINEL-c4f1e9@127.0.0.1:9/x.git");
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display });
    expectHeld(fx, run, 0, "remote origin URL uses a transport helper", { item: true });
    expect(network(run.calls)).toHaveLength(0);
    expect(JSON.stringify(run.result)).not.toContain("SENTINEL");
    expect(formatLandText(run.result)).not.toContain("SENTINEL");
    for (const f of listFiles(join(fx.board, ".story"))) {
      expect(readFileSync(join(fx.board, ".story", f), "utf-8")).not.toContain("SENTINEL");
    }
  });

  it("H0pn: a push URL with a trailing newline is refused before any comparison; no repository moves", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.pushurl", `${fx.origin}\n`);
    commit(fx, { "b.txt": "b\n" });
    const originBefore = refsAndCount(fx.origin);
    const repoRefsBefore = git(fx.repo, "for-each-ref");
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "remote origin URL contains a newline or NUL");
    expect(network(run.calls)).toHaveLength(0);
    expect(refsAndCount(fx.origin)).toBe(originBefore);
    expect(git(fx.repo, "for-each-ref")).toBe(repoRefsBefore);
  });

  it("H0pe: an empty push URL value is refused, not dropped", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.pushurl", "");
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "remote origin has an empty URL");
    expect(network(run.calls)).toHaveLength(0);
  });

  it("H0r: a missing remote is refused with remoteUrl null", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { remote: "nosuch" });
    expectHeld(fx, run, 0, "remote nosuch not found");
    expect(run.result.remoteUrl).toBeNull();
  });

  it("H0d1: a URL that is also a remote name is refused", async () => {
    const fx = await fixture();
    const backup = join(fx.repo, "backup");
    git(fx.base, "clone", "-q", "--bare", fx.origin, backup);
    const decoy = join(fx.base, "decoy.git");
    git(fx.base, "clone", "-q", "--bare", fx.origin, decoy);
    git(fx.repo, "remote", "add", "backup", decoy);
    git(fx.repo, "config", "remote.backup.pushurl", decoy);
    git(fx.repo, "config", "remote.origin.url", "backup");
    const before = [refsAndCount(backup), refsAndCount(decoy)];
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { sha });
    expectHeld(fx, run, 0, "destination backup collides with remote name");
    expect([refsAndCount(backup), refsAndCount(decoy)]).toEqual(before);
    expect(remoteTip(fx)).toBe(fx.T);
  });

  it("H0d2: a relative origin path is pinned as an absolute realpath", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.url", "../origin.git");
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display });
    expectLanded(fx, run, sha);
    expect(run.result.remoteUrl).toBe(fx.origin);
    expect((landingsOf(fx.ticket.path) as Record<string, unknown>[])[0]!.remoteUrl).toBe(fx.origin);
    expect(subArgs(pushes(run.calls)[0]!)).toContain(fx.origin);
    expect(formatLandText(run.result).split("\n")[0]).toContain(` origin ${fx.origin} `);
  });

  it("H0d3: a relative origin path that does not exist is refused", async () => {
    const fx = await fixture();
    git(fx.repo, "config", "remote.origin.url", "../nope.git");
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 0, "destination ../nope.git not found");
  });

  it("R6a: a pending journal holds at preflight and is never recovered", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const journal = writePendingJournal(fx.board, fx.issue.path);
    const snap = () => [bytes(journal), bytes(fx.issue.path)];
    const before = snap();
    const seen: string[][] = [];
    const run = await runLand(fx, {
      item: fx.ticket.display,
      intercept: () => { seen.push(snap()); return undefined; },
      hooks: { afterPreflight: () => { seen.push(snap()); } },
    });
    expectHeld(fx, run, 0, PENDING_JOURNAL_MESSAGE, { item: true });
    expect(network(run.calls)).toHaveLength(0);
    for (const s of seen) expect(s).toEqual(before);
    expect(snap()).toEqual(before);
  });

  it("H0c: a sha that does not resolve is refused", async () => {
    const fx = await fixture();
    const run = await runLand(fx, { sha: "deadbeef" });
    expectHeld(fx, run, 0, "deadbeef does not resolve to a commit");
  });

  it.each([
    ["T-99", "item T-99 not found"],
    ["ISS-99", "item ISS-99 not found"],
    ["N-1", "item must be a ticket or an issue"],
  ])("H0b/H0j/H0k: --item %s", async (item, reason) => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item });
    expectHeld(fx, run, 0, reason, { item: true });
    expect(network(run.calls)).toHaveLength(0);
  });
});

describe("land: step 1 fast-forward (ISS-1432)", () => {
  it("H1: the remote moved past T and the clone fetched it", async () => {
    const fx = await fixture();
    const other = otherClone(fx);
    writeFileSync(join(other, "o.txt"), "o\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "other");
    git(other, "push", "-q", "origin", "main");
    const X = headSha(other);
    git(fx.repo, "fetch", "-q", "origin");
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display });
    expectHeld(fx, run, 1, `${sha} is not exactly one commit on top of ${fx.origin} main (${X}); parents: ${fx.T}`, { item: true });
    expect(remoteTip(fx)).toBe(X);
  });

  it("H1b: an unknown tip asks for a fetch", async () => {
    const fx = await fixture();
    const other = otherClone(fx);
    writeFileSync(join(other, "o.txt"), "o\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "other");
    git(other, "push", "-q", "origin", "main");
    const X = headSha(other);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 1, `${fx.origin} main is at ${X}, which this clone lacks; fetch first`);
  });

  it("H1c: sha == T is already on the remote", async () => {
    const fx = await fixture();
    const run = await runLand(fx, { sha: fx.T });
    expectHeld(fx, run, 1, `already on ${fx.origin} main`);
  });

  it("H1d: two commits ahead", async () => {
    const fx = await fixture();
    const first = commit(fx, { "b.txt": "1\n" });
    const sha = commit(fx, { "c.txt": "2\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 1, `${sha} is not exactly one commit on top of ${fx.origin} main (${fx.T}); parents: ${first}`);
  });

  it("H1e: a merge commit", async () => {
    const fx = await fixture();
    git(fx.repo, "checkout", "-q", "-b", "side");
    const side = commit(fx, { "s.txt": "s\n" });
    git(fx.repo, "checkout", "-q", "main");
    const mainOne = commit(fx, { "m.txt": "m\n" });
    git(fx.repo, "merge", "-q", "--no-ff", "--no-edit", "side");
    const sha = headSha(fx.repo);
    const run = await runLand(fx);
    expectHeld(fx, run, 1, `${sha} is not exactly one commit on top of ${fx.origin} main (${fx.T}); parents: ${mainOne} ${side}`);
  });

  it("H1f: a branch missing on the remote", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { branch: "nosuch" });
    expectHeld(fx, run, 1, `branch nosuch does not exist at ${fx.origin}`);
  });

  it("H1o: several ls-remote lines are refused", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, {
      intercept: (req) => (req.args.includes("ls-remote") ? exitResult(0, `${fx.T}\trefs/heads/main\n${sha}\trefs/heads/main\n`) : undefined),
    });
    expectHeld(fx, run, 1, "unexpected ls-remote output");
    expect(run.result.held?.outcomeUnknown).toBe(false);
  });
});

describe("land: step 2 trailers (ISS-1432)", () => {
  it.each([
    ["H2", "Claude-Session: abc"],
    ["H2a", "Co-Authored-By: Codex <c@x>"],
    ["H2b", "Co-Authored-By: Jane <j@x>"],
    ["H2u", "CO-AUTHORED-BY: X"],
    ["H2c", "co-authored-by: Claude"],
    ["H2d", "  Co-Authored-By :  Claude"],
  ])("%s: %s", async (_row, trailer) => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" }, `subject\n\n${trailer}\n`);
    const run = await runLand(fx, { item: fx.ticket.display });
    expectHeld(fx, run, 2, `${short(sha)} carries "${trailer}"`, { item: true });
  });

  it("H2e: a trailer on T does not hold a clean sha", async () => {
    const fx = await fixture();
    commit(fx, { "t.txt": "t\n" }, "subject\n\nClaude-Session: old\n");
    pushFixture(fx);
    const sha = commit(fx, { "b.txt": "b\n" }, "clean\n");
    const run = await runLand(fx);
    expectLanded(fx, run, sha);
    expect(run.calls.some((c) => sub(c) === "log" && c.args.includes("-1"))).toBe(true);
  });

  it("H2v: a supplied trailer pattern holds at step 2 with no push, and the defaults still apply beside it", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" }, "subject\n\nReviewed-On: internal\n");
    const run = await runLand(fx, { trailerPatterns: ["^Reviewed-On:"] });
    expectHeld(fx, run, 2, `${short(sha)} carries "Reviewed-On: internal"`);
    expect(pushes(run.calls)).toHaveLength(0);
    const fx2 = await fixture();
    const sha2 = commit(fx2, { "b.txt": "b\n" }, "subject\n\nClaude-Session: x\n");
    const run2 = await runLand(fx2, { trailerPatterns: ["^Reviewed-On:"] });
    expectHeld(fx2, run2, 2, `${short(sha2)} carries "Claude-Session: x"`);
    expect(pushes(run2.calls)).toHaveLength(0);
  });
});

describe("land: step 3 hygiene (ISS-1432)", () => {
  it("H3: a home path on an added line names file and line", async () => {
    const fx = await fixture();
    commit(fx, { "a.txt": `one\ntwo\n${HOME_PREFIX}someone/x\n` });
    const run = await runLand(fx, { item: fx.ticket.display });
    expectHeld(fx, run, 3, "a.txt:3 home path", { item: true });
  });

  it.each([
    ["H3b", "/ho" + "me/ci/x"],
    ["H3u", `https://example.com${HOME_PREFIX}bob/`],
    ["H3s", `${HOME_PREFIX}Jane Doe/file`],
    ["H3s2", `${HOME_PREFIX} Jane/file`],
    ["H3g", `++${HOME_PREFIX}x`],
    ["H3g2", `++ ${HOME_PREFIX}x`],
  ])("%s: home path variant", async (_row, line) => {
    const fx = await fixture();
    const { run } = await landLine(fx, line);
    expectHeld(fx, run, 3, "x.txt:1 home path");
  });

  it("H3d: a home path only on a removed line lands", async () => {
    const fx = await fixture();
    commit(fx, { "r.txt": `keep\n${HOME_PREFIX}old/x\n` });
    pushFixture(fx);
    const sha = commit(fx, { "r.txt": "keep\n" });
    const run = await runLand(fx);
    expectLanded(fx, run, sha);
    expect(run.calls.some((c) => sub(c) === "diff" && c.args.includes("--unified=0"))).toBe(true);
  });

  it("H3h: the line number counts across three hunks", async () => {
    const fx = await fixture();
    const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`);
    commit(fx, { "big.txt": `${lines.join("\n")}\n` });
    pushFixture(fx);
    lines[9] = "changed 10";
    lines[59] = "changed 60";
    lines[119] = `${HOME_PREFIX}x/120`;
    commit(fx, { "big.txt": `${lines.join("\n")}\n` });
    const run = await runLand(fx);
    expectHeld(fx, run, 3, "big.txt:120 home path");
  });

  it.each([["a \"q\".txt"], ["été.txt"]])("H3q1: quoted path %s is named unquoted", async (name) => {
    const fx = await fixture();
    commit(fx, { [name]: `${HOME_PREFIX}x\n` });
    const run = await runLand(fx);
    expectHeld(fx, run, 3, `${name}:1 home path`);
  });

  it("H3x: a textconv driver is not applied to the scanned diff", async () => {
    const fx = await fixture();
    mkdirSync(join(fx.repo, ".git", "info"), { recursive: true });
    writeFileSync(join(fx.repo, ".git", "info", "attributes"), "*.txt diff=hide\n");
    git(fx.repo, "config", "diff.hide.textconv", "true");
    const { run } = await landLine(fx, `${HOME_PREFIX}x`);
    expectHeld(fx, run, 3, "x.txt:1 home path");
  });

  it.each([["diff.noprefix"], ["diff.mnemonicPrefix"]])("H3np/H3mp: %s=true still parses", async (key) => {
    const fx = await fixture();
    git(fx.repo, "config", key, "true");
    const { run } = await landLine(fx, `${HOME_PREFIX}x`);
    expectHeld(fx, run, 3, "x.txt:1 home path");
  });

  const injectedDiff = (body: string) => (req: { args: readonly string[] }) =>
    req.args.includes("diff") && req.args.includes("--unified=0") ? exitResult(0, body) : undefined;

  it("H3ic: nondefault indicators are unrecognised", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { intercept: injectedDiff("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n>added\n") });
    expectHeld(fx, run, 3, "unrecognised diff output at line 6");
  });

  it("H3f: an unknown hunk line is unrecognised", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { intercept: injectedDiff("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n~x\n") });
    expectHeld(fx, run, 3, "unrecognised diff output at line 6");
  });

  it("H3f2: a +++ line without b/ is unrecognised", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { intercept: injectedDiff("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ c/x\n@@ -0,0 +1 @@\n+ok\n") });
    expectHeld(fx, run, 3, "unrecognised diff output at line 4");
  });

  it("H3o: a diff overflow holds", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, {
      intercept: (req) => (req.args.includes("--unified=0") ? { kind: "failed", reason: "overflow", detail: "output exceeded 10 MB" } : undefined),
    });
    expectHeld(fx, run, 3, "diff failed (overflow): output exceeded 10 MB");
  });

  it.each([["172." + "16.0.0"], ["172." + "31.255.255"], ["10." + "0.0.1."]])("H3c: %s is a private IPv4", async (ip) => {
    const fx = await fixture();
    const { run } = await landLine(fx, `host ${ip}`);
    expectHeld(fx, run, 3, "x.txt:1 private IPv4");
  });

  it("H3n: near misses land", async () => {
    const fx = await fixture();
    const near = ["10." + "999.999.999", "172." + "15.0.1", "172." + "32.0.1", "1." + "10.0.0.1", "10." + "0.0.1.5"];
    const sha = commit(fx, { "x.txt": `${near.join("\n")}\n` });
    const run = await runLand(fx);
    expectLanded(fx, run, sha);
    expect(run.calls.some((c) => sub(c) === "diff" && c.args.includes("--unified=0"))).toBe(true);
  });

  it.each([["/tmp/cc-socks/14066" + ".sock"], ["/run/x" + ".sock/sub"], ["/run/" + ".sock"], ["/run/a." + ".sock"]])("H3k: %s is a socket path", async (line) => {
    const fx = await fixture();
    const { run } = await landLine(fx, line);
    expectHeld(fx, run, 3, "x.txt:1 socket path");
  });

  it("H3q: socket near misses land", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "x.txt": "/run/a.socket\n/tmp/b.sock.bak\n" });
    const run = await runLand(fx);
    expectLanded(fx, run, sha);
    expect(run.calls.some((c) => sub(c) === "diff" && c.args.includes("--unified=0"))).toBe(true);
  });

  it("H3p2: custom patterns are named", async () => {
    const fx = await fixture();
    const b = await landLine(fx, "xxBBBxx", { hygienePatterns: ["a=AAA", "b=BBB"] });
    expectHeld(fx, b.run, 3, "x.txt:1 b");
    const fx2 = await fixture();
    const a = await landLine(fx2, "xxAAAxx", { hygienePatterns: ["a=AAA", "b=BBB"] });
    expectHeld(fx2, a.run, 3, "x.txt:1 a");
  });

  it("H3p3: a custom pattern never removes the defaults", async () => {
    const fx = await fixture();
    const { run } = await landLine(fx, `${HOME_PREFIX}x`, { hygienePatterns: ["a=AAA"] });
    expectHeld(fx, run, 3, "x.txt:1 home path");
  });

  const parseMessage = (text: string) => {
    try { JSON.parse(text); } catch (err) { return (err as Error).message; }
    return "";
  };

  it("H3e: invalid ticket JSON", async () => {
    const fx = await fixture();
    const rel = relative(fx.repo, fx.ticket.path);
    const good = readFileSync(fx.ticket.path);
    commit(fx, { [rel]: "{bad" });
    writeFileSync(fx.ticket.path, good);
    const run = await runLand(fx);
    expectHeld(fx, run, 3, `${rel} is not valid JSON: ${parseMessage("{bad")}`);
  });

  const invalid = "{ this is not json, but it is long enough to be detected as a rename by git similarity }\n";

  it("H3m: an invalid JSON file renamed inside .story is caught", async () => {
    const fx = await fixture();
    commit(fx, { ".story/notes/a.json": invalid });
    pushFixture(fx);
    commit(fx, { ".story/notes/a.json": null, ".story/notes/b.json": invalid });
    const run = await runLand(fx);
    expectHeld(fx, run, 3, `.story/notes/b.json is not valid JSON: ${parseMessage(invalid)}`);
  });

  it("H3r: an invalid JSON file renamed into .story is caught", async () => {
    const fx = await fixture();
    commit(fx, { "x.json": invalid });
    pushFixture(fx);
    commit(fx, { "x.json": null, ".story/notes/x.json": invalid });
    const run = await runLand(fx);
    expectHeld(fx, run, 3, `.story/notes/x.json is not valid JSON: ${parseMessage(invalid)}`);
  });

  it("H3t: a path with a tab is named exactly", async () => {
    const fx = await fixture();
    commit(fx, { ".story/tab\tname.json": "{bad" });
    const run = await runLand(fx);
    expectHeld(fx, run, 3, `.story/tab\tname.json is not valid JSON: ${parseMessage("{bad")}`);
  });

  it("H3l: an added symlink is not a regular file", async () => {
    const fx = await fixture();
    mkdirSync(join(fx.repo, ".story"), { recursive: true });
    symlinkSync("config.json", join(fx.repo, ".story", "link.json"));
    commit(fx, {});
    const run = await runLand(fx);
    expectHeld(fx, run, 3, ".story/link.json is not a regular file");
  });

  it("H3y1: a regular file replaced by a symlink", async () => {
    const fx = await fixture();
    commit(fx, { ".story/notes/n.json": "{}\n" });
    pushFixture(fx);
    unlinkSync(join(fx.repo, ".story", "notes", "n.json"));
    symlinkSync("../config.json", join(fx.repo, ".story", "notes", "n.json"));
    commit(fx, {});
    const run = await runLand(fx);
    expectHeld(fx, run, 3, ".story/notes/n.json is not a regular file");
  });

  it("H3y2: a symlink replaced by an invalid regular file", async () => {
    const fx = await fixture();
    mkdirSync(join(fx.repo, ".story", "notes"), { recursive: true });
    symlinkSync("../config.json", join(fx.repo, ".story", "notes", "s.json"));
    commit(fx, {});
    pushFixture(fx);
    unlinkSync(join(fx.repo, ".story", "notes", "s.json"));
    commit(fx, { ".story/notes/s.json": "{bad" });
    const run = await runLand(fx);
    expectHeld(fx, run, 3, `.story/notes/s.json is not valid JSON: ${parseMessage("{bad")}`);
  });
});

describe("land: step 4 secrets (ISS-1432)", () => {
  it("H4: gitleaks absent", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { gitleaksPath: join(fx.base, "missing", "gitleaks") });
    expectHeld(fx, run, 4, "gitleaks not found; install it or pass --no-secrets-scan");
  });

  it("H4p: gitleaks without a git subcommand", async () => {
    const fx = await fixture();
    writeFileSync(join(fx.fake, "nohelp"), "");
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 4, "gitleaks has no git subcommand");
  });

  it("H4b: gitleaks finds a secret", async () => {
    const fx = await fixture();
    writeFileSync(join(fx.fake, "scan-exit"), "1\n");
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 4, "secrets found (rules: generic-api-key)");
    const scan = gitleaksCalls(fx, run.calls).find((c) => c.args[1] !== "--help");
    expect(scan?.args).toEqual(["git", "--no-banner", "--redact", "--exit-code", "1", `--log-opts=${fx.T}..${sha}`, fx.repo]);
  });

  it("H4c: a gitleaks tool failure", async () => {
    const fx = await fixture();
    writeFileSync(join(fx.fake, "scan-exit"), "2\n");
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 4, "gitleaks failed: boom");
  });

  it("H4d: --no-secrets-scan skips a missing gitleaks", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { secretsScan: false, gitleaksPath: join(fx.base, "missing", "gitleaks") });
    expectLanded(fx, run, sha);
    expect(run.result.steps.find((s) => s.step === "secrets")?.outcome).toBe("skipped");
    expect(gitleaksCalls(fx, run.calls)).toHaveLength(0);
    expect(run.calls.some((c) => c.cmd.endsWith("gitleaks"))).toBe(false);
  });

  it.each([
    ["diff.x.textconv", "true"],
    ["diff.external", "true"],
  ])("H4t: %s is refused before the scan", async (key, value) => {
    const fx = await fixture();
    git(fx.repo, "config", key, value);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectHeld(fx, run, 4, "diff driver configured; gitleaks could scan converted text");
  });
});

describe("land: step 5 push (ISS-1432)", () => {
  const moved = (fx: Fx) => `${fx.origin} main moved since step 1`;

  it("H5a: origin advanced to a child of T", async () => {
    const fx = await fixture();
    const other = otherClone(fx);
    commit(fx, { "b.txt": "b\n" });
    let Y = "";
    const run = await runLand(fx, {
      item: fx.ticket.display,
      hooks: {
        beforePush: () => {
          writeFileSync(join(other, "y.txt"), "y\n");
          git(other, "add", "-A");
          git(other, "commit", "-q", "-m", "y");
          git(other, "push", "-q", "origin", "main");
          Y = headSha(other);
        },
      },
    });
    expectHeld(fx, run, 5, moved(fx), { item: true });
    expect(pushRecordClass(run.calls)).toBe("!");
    expect(remoteTip(fx)).toBe(Y);
  });

  it("H5b: origin already at sha reports up to date", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, {
      item: fx.ticket.display,
      hooks: { beforePush: () => { git(fx.repo, "push", "-q", fx.origin, `${sha}:refs/heads/main`); } },
    });
    expectHeld(fx, run, 5, `already on ${fx.origin} main when pushed`, { item: true });
    expect(pushRecordClass(run.calls)).toBe("=");
  });

  it("H5c: origin rewound to T~1", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const back = git(fx.repo, "rev-parse", `${fx.T}~1`).trim();
    const run = await runLand(fx, { hooks: { beforePush: () => { git(fx.repo, "push", "-q", "--force", fx.origin, `${back}:refs/heads/main`); } } });
    expectHeld(fx, run, 5, moved(fx));
    expect(remoteTip(fx)).toBe(back);
  });

  it("H5d: origin force-moved to an unrelated commit", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const tree = git(fx.repo, "rev-parse", `${fx.T}^{tree}`).trim();
    const unrelated = git(fx.repo, "commit-tree", tree, "-m", "unrelated").trim();
    const run = await runLand(fx, { hooks: { beforePush: () => { git(fx.repo, "push", "-q", "--force", fx.origin, `${unrelated}:refs/heads/main`); } } });
    expectHeld(fx, run, 5, moved(fx));
    expect(remoteTip(fx)).toBe(unrelated);
  });

  it("H5e: origin branch deleted", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    git(fx.origin, "config", "receive.denyDeleteCurrent", "ignore");
    const run = await runLand(fx, { hooks: { beforePush: () => { git(fx.repo, "push", "-q", fx.origin, ":refs/heads/main"); } } });
    expectHeld(fx, run, 5, moved(fx));
    expect(remoteTip(fx)).toBeNull();
  });

  it("H5: a pre-receive rejection is confirmed not pushed", async () => {
    const fx = await fixture();
    const hook = join(fx.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho denied >&2\nexit 1\n");
    execFileSync("chmod", ["755", hook]);
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display });
    expect(run.result.status).toBe("held");
    expect(run.result.held?.number).toBe(5);
    expect(run.result.held?.reason).toMatch(/^rejected .*: denied$/);
    expect(run.result.held?.outcomeUnknown).toBe(false);
    expect(run.exit).toBe(1);
    expect(run.result.receipt.status).toBe("not-attempted");
    expectNoLandings(fx);
    expect(pushes(run.calls)).toHaveLength(1);
    expect(pushRecordClass(run.calls)).toBe("!");
    expect(remoteTip(fx)).toBe(fx.T);
  });

  it("H5t: an annotated tag is never pushed", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    git(fx.repo, "tag", "-a", "v1", "-m", "v1");
    git(fx.repo, "config", "push.followTags", "true");
    const run = await runLand(fx);
    expectLanded(fx, run, sha);
    expect(git(fx.repo, "ls-remote", "--tags", fx.origin)).toBe("");
  });

  it("H5s: submodule commits are never pushed", async () => {
    const fx = await fixture();
    const decoy = join(fx.base, "decoy.git");
    git(fx.base, "init", "-q", "--bare", "-b", "main", decoy);
    const seed = join(fx.base, "seed");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "s.txt"), "s\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", decoy, "main");
    const decoyBefore = refsAndCount(decoy);
    git(fx.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "../decoy.git", "sub");
    const subDir = join(fx.repo, "sub");
    writeFileSync(join(subDir, "new.txt"), "new\n");
    git(subDir, "add", "-A");
    git(subDir, "commit", "-q", "-m", "unpushed");
    git(fx.repo, "add", "-A");
    git(fx.repo, "commit", "-q", "-m", "add sub");
    const sha = headSha(fx.repo);
    git(fx.repo, "config", "push.recurseSubmodules", "on-demand");
    const run = await runLand(fx);
    expectLanded(fx, run, sha);
    expect(refsAndCount(decoy)).toBe(decoyBefore);
  });

  it("H5h: a pre-push hook never runs", async () => {
    const fx = await fixture();
    installHook(fx.repo, "pre-push", ": > hooked.txt");
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    expectLanded(fx, run, sha);
    expect(existsSync(join(fx.repo, "hooked.txt"))).toBe(false);
  });

  it("H5l: exit 128 with no record after acceptance is outcome unknown", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    const { defaultRunner } = await import("../../src/core/land.js");
    let real: Awaited<ReturnType<typeof defaultRunner>> | undefined;
    const run = await runLand(fx, {
      item: fx.ticket.display,
      intercept: async (req) => {
        if (!req.args.includes("push")) return undefined;
        real = await defaultRunner(req);
        return exitResult(128, "", "fatal: the remote end hung up unexpectedly");
      },
    });
    expect(real?.kind === "exit" && real.code).toBe(0);
    expectHeld(fx, run, 5, `outcome unknown, check ${fx.origin} main by hand`, { item: true, unknown: true });
    expect(pushRecordClass(run.calls)).toBe("none");
    expect(remoteTip(fx)).toBe(sha);
  });

  it("H5x: a push spawn failure is confirmed not pushed", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, {
      intercept: (req) => (req.args.includes("push") ? { kind: "failed", reason: "spawn", detail: "ENOENT" } : undefined),
    });
    expectHeld(fx, run, 5, "git could not start: ENOENT", { unknown: false });
    expect(remoteTip(fx)).toBe(fx.T);
  });

  it("T5: a push timeout is outcome unknown", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, {
      item: fx.ticket.display,
      intercept: (req) => (req.args.includes("push") ? { kind: "failed", reason: "timeout", detail: "timed out after 30000 ms" } : undefined),
    });
    expectHeld(fx, run, 5, `outcome unknown, check ${fx.origin} main by hand`, { item: true, unknown: true });
  });
});

describe("land: step 6 verify (ISS-1432)", () => {
  const verifyCall = (calls: Call[]) => lsRemotes(calls)[1];
  const atVerify = (r: (fx: Fx) => ReturnType<typeof exitResult> | { kind: "failed"; reason: "timeout"; detail: string }) =>
    (fx: Fx) => (req: { args: readonly string[] }, calls: Call[]) =>
      req.args.includes("ls-remote") && lsRemotes(calls).length === 2 ? r(fx) : undefined;

  it("V1: verify reads T after the push", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display, intercept: atVerify((f) => exitResult(0, `${f.T}\trefs/heads/main\n`))(fx) });
    expectHeld(fx, run, 6, `push reported success but ${fx.origin} main is ${fx.T}`, { item: true, unknown: true });
    expect(subArgs(verifyCall(run.calls)!)).toEqual(["ls-remote", fx.origin, "refs/heads/main"]);
    expect(formatLandText(run.result)).not.toContain("LANDED");
  });

  it.each([
    ["V2", () => exitResult(2, "", "fatal: nope")],
    ["V3", () => exitResult(0, "garbage\n")],
    ["T6", () => ({ kind: "failed" as const, reason: "timeout" as const, detail: "timed out after 30000 ms" })],
  ])("%s: verify failure is outcome unknown", async (_row, make) => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display, intercept: atVerify(() => make())(fx) });
    expectHeld(fx, run, 6, `outcome unknown, check ${fx.origin} main by hand`, { item: true, unknown: true });
  });
});

describe("land: other timeouts (ISS-1432)", () => {
  const timeout = { kind: "failed" as const, reason: "timeout" as const, detail: "timed out" };

  it("T0: repository discovery times out", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { intercept: (req) => (req.args.includes("--show-toplevel") ? timeout : undefined) });
    expectHeld(fx, run, 0, "repository discovery timed out");
  });

  it("T1: the step-1 ls-remote times out", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { intercept: (req) => (req.args.includes("ls-remote") ? timeout : undefined) });
    expectHeld(fx, run, 1, "ls-remote timed out");
  });

  it("T4: the gitleaks scan times out", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { intercept: (req) => (req.cmd === fx.gitleaks && req.args[1] !== "--help" ? timeout : undefined) });
    expectHeld(fx, run, 4, "gitleaks timed out");
  });
});

describe("land: step 7 receipt (ISS-1432)", () => {
  it("R3: a non-array landings field fails the receipt with exit 3", async () => {
    const fx = await fixture();
    const json = JSON.parse(readFileSync(fx.ticket.path, "utf-8")) as Record<string, unknown>;
    writeFileSync(fx.ticket.path, JSON.stringify({ ...json, landings: "x" }, null, 2));
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display });
    expect(run.exit).toBe(3);
    expect(run.result.receipt).toEqual({ status: "failed", item: fx.ticket.display, error: "existing landings is not an array" });
    expect(run.result.status).toBe("landed");
    expect(remoteTip(fx)).toBe(sha);
  });

  it("R4: a throwing writer fails the receipt with exit 3", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display, writeReceipt: async () => { throw new Error("writer broke"); } });
    expect(run.exit).toBe(3);
    expect(run.result.receipt).toEqual({ status: "failed", item: fx.ticket.display, error: "writer broke" });
    expect(run.result.status).toBe("landed");
  });

  it.each([
    ["R7a", () => { throw new Error("clock broke"); }, "clock broke"],
    ["R7b", () => new Date(Number.NaN), "Invalid time value"],
  ])("%s: a failing clock after the landing fails only the receipt, exit 3", async (_row, clock, error) => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx, { item: fx.ticket.display, clock: clock as () => Date });
    expect(run.exit).toBe(3);
    expect(run.result.status).toBe("landed");
    expect(run.result.receipt).toEqual({ status: "failed", item: fx.ticket.display, error });
    expect(remoteTip(fx)).toBe(sha);
  });

  it("R5: a record rebound to another id after preflight is refused", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    let movedTo = "";
    const run = await runLand(fx, {
      item: fx.ticket.display,
      hooks: {
        afterVerify: () => {
          const json = JSON.parse(readFileSync(fx.ticket.path, "utf-8")) as Record<string, unknown>;
          const id = String(json.id);
          const last = id[id.length - 1]!;
          const newId = `${id.slice(0, -1)}${last === "a" ? "b" : "a"}`;
          movedTo = join(fx.ticket.path, "..", basename(fx.ticket.path).replace(id, newId));
          const displayId = (json.displayId as string | undefined) ?? id;
          writeFileSync(movedTo, JSON.stringify({ ...json, id: newId, displayId }, null, 2));
          rmSync(fx.ticket.path);
        },
      },
    });
    expect(run.exit).toBe(3);
    expect(run.result.receipt).toEqual({ status: "failed", item: fx.ticket.display, error: "item changed since preflight" });
    expect(landingsOf(fx.ticket.path)).toBeUndefined();
    expect(landingsOf(movedTo)).toBeUndefined();
  });

  it("R6b: a journal appearing after verify is refused, never recovered", async () => {
    const fx = await fixture();
    commit(fx, { "b.txt": "b\n" });
    let journal = "";
    let before: string[] = [];
    const run = await runLand(fx, {
      item: fx.ticket.display,
      hooks: {
        afterVerify: () => {
          journal = writePendingJournal(fx.board, fx.issue.path);
          before = [bytes(journal), bytes(fx.issue.path)];
        },
      },
    });
    expect(run.result.status).toBe("landed");
    expect(run.exit).toBe(3);
    expect(run.result.receipt).toEqual({ status: "failed", item: fx.ticket.display, error: PENDING_JOURNAL_MESSAGE });
    expect([bytes(journal), bytes(fx.issue.path)]).toEqual(before);
    expect(landingsOf(fx.ticket.path)).toBeUndefined();
  });
});

describe("land: text rendering (ISS-1432)", () => {
  it("renders the disclosure, the steps and the verdict", async () => {
    const fx = await fixture();
    const sha = commit(fx, { "b.txt": "b\n" });
    const run = await runLand(fx);
    const lines = formatLandText(run.result).split("\n");
    expect(lines[0]).toBe(`land: repo ${fx.repo} board ${fx.board} remote origin ${fx.origin} branch main sha ${sha}`);
    expect(lines).toContain("0 preflight passed");
    expect(lines[lines.length - 1]).toBe(`LANDED ${sha}`);
  });
});
