/**
 * T-184: gitIsAncestor tests using real git repos.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { gitIsAncestor } from "../../src/autonomous/git-inspector.js";

let repo: string;

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repo, encoding: "utf-8" }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ancestor-test-"));
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

describe("gitIsAncestor", () => {
  it("returns true when ancestor is parent of descendant", async () => {
    const parent = git("rev-parse HEAD");
    execSync("echo 'change' >> file.txt", { cwd: repo });
    git("add .");
    git("commit -m 'child'");
    const child = git("rev-parse HEAD");

    const result = await gitIsAncestor(repo, parent, child);
    expect(result).toEqual({ ok: true, data: true });
  });

  it("returns false when commits are not ancestor-descendant", async () => {
    const commit1 = git("rev-parse HEAD");
    git("checkout -b other");
    execSync("echo 'other' >> file.txt", { cwd: repo });
    git("add .");
    git("commit -m 'other'");
    const commit2 = git("rev-parse HEAD");

    // commit2 is not an ancestor of commit1 (they diverge)
    const result = await gitIsAncestor(repo, commit2, commit1);
    expect(result).toEqual({ ok: true, data: false });
  });

  it("returns true when same commit (trivially ancestor of self)", async () => {
    const head = git("rev-parse HEAD");
    const result = await gitIsAncestor(repo, head, head);
    expect(result).toEqual({ ok: true, data: true });
  });

  it("rejects invalid ref format", async () => {
    const result = await gitIsAncestor(repo, "--option", "abc123");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("invalid ref");
  });

  it("returns error for non-existent repo", async () => {
    const result = await gitIsAncestor("/nonexistent/path", "abc123", "def456");
    expect(result.ok).toBe(false);
  });
});
