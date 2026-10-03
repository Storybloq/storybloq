/**
 * ISS-1107: the CLI reports a board write's git state and honours --commit.
 * Runs the real built binary (dist/cli.js) in a child process with a scratch
 * HOME and a minimal environment, so nothing reaches the developer's config.
 * A failed optional commit never changes the exit status.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupTempDirs, git, gitLines, headFiles, headSha, installHook, isolateGit, makeProjectRepo, porcelain, tempDir,
} from "../mcp/board-git-fixtures.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "cli.js");

let restoreGit: () => void;
let home: string;
beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`build first: ${CLI} is missing`);
});
beforeEach(() => {
  restoreGit = isolateGit();
  home = tempDir("home");
});
afterEach(() => { restoreGit(); cleanupTempDirs(); });

interface Run { status: number | null; stdout: string; stderr: string }

function cli(cwd: string, ...args: string[]): Run {
  const env: Record<string, string> = {
    HOME: home,
    STORYBLOQ_GLOBAL_DIR: join(home, "storybloq-global"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    CI: "1",
  };
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf-8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(run: Run): { data: Record<string, unknown> } {
  return JSON.parse(run.stdout) as { data: Record<string, unknown> };
}

const ISSUE = ["--title", "Board state", "--severity", "low", "--impact", "none"];
const short = (cwd: string) => git(cwd, "rev-parse", "--short", "HEAD").trim();

describe("board write git state on the CLI (ISS-1107)", () => {
  it("C1: create prints the Git line", async () => {
    const { root } = await makeProjectRepo();
    const run = cli(root, "issue", "create", ...ISSUE);
    expect(run.status).toBe(0);
    expect(gitLines(run.stdout)).toEqual(["Git: .story/issues/ISS-001.json untracked"]);
  });

  it("C2: update prints modified", async () => {
    const { root } = await makeProjectRepo();
    expect(cli(root, "issue", "create", ...ISSUE, "--commit").status).toBe(0);
    const run = cli(root, "issue", "update", "ISS-001", "--impact", "changed");
    expect(run.status).toBe(0);
    expect(gitLines(run.stdout)).toEqual(["Git: .story/issues/ISS-001.json modified"]);
  });

  it("C3: a multi-file operation lists each file", async () => {
    const { root } = await makeProjectRepo();
    expect(cli(root, "phase", "create", "--id", "p1", "--name", "P1", "--label", "P1", "--description", "d", "--after", "p0").status).toBe(0);
    expect(cli(root, "ticket", "create", "--title", "t", "--type", "task", "--phase", "p1").status).toBe(0);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "setup");
    const run = cli(root, "phase", "delete", "p1", "--reassign", "p0");
    expect(run.status).toBe(0);
    expect(gitLines(run.stdout)).toEqual([
      "Git: .story/tickets/T-001.json modified",
      "Git: .story/roadmap.json modified",
    ]);
  });

  it("C4: --format json carries data.git", async () => {
    const { root } = await makeProjectRepo();
    const run = cli(root, "issue", "create", ...ISSUE, "--format", "json");
    expect(run.status).toBe(0);
    const out = json(run);
    expect(out.data.git).toEqual([{ path: ".story/issues/ISS-001.json", state: "untracked" }]);
    expect(out.data.gitCommit).toBeUndefined();
    expect(run.stdout).not.toContain("Git: ");
  });

  it("C5: --commit commits exactly the written file", async () => {
    const { root } = await makeProjectRepo();
    writeFileSync(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    const run = cli(root, "issue", "create", ...ISSUE, "--commit");
    expect(run.status).toBe(0);
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("docs(story): ISS-001 created");
    expect(headFiles(root)).toEqual([".story/issues/ISS-001.json"]);
    expect(porcelain(root, "staged.txt")).toEqual(["A  staged.txt"]);
    expect(gitLines(run.stdout)).toEqual(["Git: .story/issues/ISS-001.json committed", `Git: committed ${short(root)}`]);
  });

  it("C5: a hard delete commits the removal with the id from HEAD", async () => {
    const { root } = await makeProjectRepo();
    expect(cli(root, "issue", "create", ...ISSUE, "--commit").status).toBe(0);
    const run = cli(root, "issue", "delete", "ISS-001", "--hard", "--commit");
    expect(run.status).toBe(0);
    expect(git(root, "log", "-1", "--format=%s").trim()).toBe("docs(story): ISS-001 deleted");
    expect(headFiles(root)).toEqual([".story/issues/ISS-001.json"]);
    expect(gitLines(run.stdout)).toEqual(["Git: .story/issues/ISS-001.json committed", `Git: committed ${short(root)}`]);
  });

  describe("C6: data.gitCommit, and the exit status stays 0", () => {
    it("success", async () => {
      const { root } = await makeProjectRepo();
      const run = cli(root, "issue", "create", ...ISSUE, "--commit", "--format", "json");
      expect(run.status).toBe(0);
      expect(json(run).data.gitCommit).toEqual([
        { repo: root, outcome: "committed", sha: short(root), paths: [".story/issues/ISS-001.json"] },
      ]);
      expect(json(run).data.git).toEqual([{ path: ".story/issues/ISS-001.json", state: "committed" }]);
    });

    it("a change already staged in the file", async () => {
      const { root } = await makeProjectRepo();
      expect(cli(root, "issue", "create", ...ISSUE, "--commit").status).toBe(0);
      const path = ".story/issues/ISS-001.json";
      writeFileSync(join(root, path), readFileSync(join(root, path), "utf-8").replace('"impact": "none"', '"impact": "by hand"'));
      git(root, "add", "--", path);
      const before = headSha(root);
      const run = cli(root, "issue", "update", "ISS-001", "--title", "Renamed", "--commit", "--format", "json");
      expect(run.status).toBe(0);
      expect(headSha(root)).toBe(before);
      expect(json(run).data.gitCommit).toEqual([
        { repo: root, outcome: "skipped", reason: `${path} already staged by another change`, paths: [path] },
      ]);
    });

    it("a failing hook", async () => {
      const { root } = await makeProjectRepo();
      installHook(root, "pre-commit", "echo 'hook says no' >&2\nexit 1");
      const run = cli(root, "issue", "create", ...ISSUE, "--commit", "--format", "json");
      expect(run.status).toBe(0);
      expect(json(run).data.gitCommit).toEqual([
        { repo: root, outcome: "skipped", reason: "commit failed: hook says no", paths: [".story/issues/ISS-001.json"] },
      ]);
    });

    it("a verification failure", async () => {
      const { root } = await makeProjectRepo();
      installHook(root, "pre-commit", "echo extra > extra.txt\ngit add extra.txt");
      const run = cli(root, "issue", "create", ...ISSUE, "--commit", "--format", "json");
      expect(run.status).toBe(0);
      expect(json(run).data.gitCommit).toEqual([{
        repo: root, outcome: "verification_failed", sha: short(root),
        reason: "HEAD changed .story/issues/ISS-001.json, extra.txt", paths: [".story/issues/ISS-001.json"],
      }]);
    });

    it("two repositories, one committed and one skipped", async () => {
      const { root } = await makeProjectRepo();
      expect(cli(root, "phase", "create", "--id", "p1", "--name", "P1", "--label", "P1", "--description", "d", "--after", "p0").status).toBe(0);
      expect(cli(root, "ticket", "create", "--title", "t", "--type", "task", "--phase", "p1").status).toBe(0);
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "setup");
      // The tickets directory is its own repository, with a hook that refuses.
      const tickets = join(root, ".story", "tickets");
      git(tickets, "init", "-q", "-b", "main");
      git(tickets, "add", "-A");
      git(tickets, "commit", "-q", "-m", "tickets");
      installHook(tickets, "pre-commit", "echo 'tickets refuse' >&2\nexit 1");
      mkdirSync(join(root, ".story", "notes"), { recursive: true });
      const run = cli(root, "phase", "delete", "p1", "--reassign", "p0", "--commit", "--format", "json");
      expect(run.status).toBe(0);
      expect(json(run).data.gitCommit).toEqual([
        { repo: tickets, outcome: "skipped", reason: "commit failed: tickets refuse", paths: ["T-001.json"] },
        { repo: root, outcome: "committed", sha: short(root), paths: [".story/roadmap.json"] },
      ]);
      expect(headFiles(root)).toEqual([".story/roadmap.json"]);
    });
  });
});
