/**
 * T-132: gitHeadHash and gitCommitDistance tests using real git repos.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { gitHeadHash, gitCommitDistance } from "../../src/autonomous/git-inspector.js";

let repo: string;

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: "utf-8" }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "git-head-dist-test-"));
  git("init");
  git("config user.email test@test.com");
  git("config user.name Test");
  execSync("touch file.txt", { cwd: repo });
  git("add .");
  git("commit -m 'initial'");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("gitHeadHash", () => {
  it("returns the current HEAD hash", async () => {
    const expected = git("rev-parse HEAD");
    const result = await gitHeadHash(repo);
    expect(result).toEqual({ ok: true, data: expected });
  });

  it("returns error for non-git directory", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "non-git-"));
    try {
      const result = await gitHeadHash(nonGit);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("gitCommitDistance", () => {
  it("returns count between two SHAs", async () => {
    const from = git("rev-parse HEAD");
    execSync("echo 'a' >> file.txt", { cwd: repo });
    git("add .");
    git("commit -m 'second'");
    execSync("echo 'b' >> file.txt", { cwd: repo });
    git("add .");
    git("commit -m 'third'");
    const to = git("rev-parse HEAD");

    const result = await gitCommitDistance(repo, from, to);
    expect(result).toEqual({ ok: true, data: 2 });
  });

  it("returns 0 for same SHA", async () => {
    const sha = git("rev-parse HEAD");
    const result = await gitCommitDistance(repo, sha, sha);
    expect(result).toEqual({ ok: true, data: 0 });
  });

  it("rejects invalid refs", async () => {
    const result = await gitCommitDistance(repo, "--option", "abc123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("invalid ref");
  });
});
