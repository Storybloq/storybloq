import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { worktreeState } from "../../src/core/worktree-state.js";
import { cleanupTempDirs, isolateGit, tempDir } from "../mcp/board-git-fixtures.js";

/** C-v4.1 6.2 (moved forward to commit 3): the worktree state recorded at receipt append. */

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf-8" });
function repo(): string {
  const root = tempDir("wtstate");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "a\n");
  mkdirSync(join(root, ".story"));
  writeFileSync(join(root, ".story", "x.json"), "{}\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "c");
  return root;
}
const CLEAN = { staged: 0, unstaged: 0, untracked: 0, submodule: 0 };

describe("worktreeState", () => {
  it("a clean tree has every count zero", () => {
    expect(worktreeState(repo())).toEqual(CLEAN);
  });

  it("counts staged, unstaged and untracked paths", () => {
    const root = repo();
    writeFileSync(join(root, "a.txt"), "b\n");
    git(root, "add", "a.txt");
    writeFileSync(join(root, "a.txt"), "c\n");
    writeFileSync(join(root, "new file.txt"), "n\n");
    expect(worktreeState(root)).toEqual({ staged: 1, unstaged: 1, untracked: 1, submodule: 0 });
  });

  it("excludes paths under .story/", () => {
    const root = repo();
    writeFileSync(join(root, ".story", "x.json"), "{\"a\":1}\n");
    writeFileSync(join(root, ".story", "y.json"), "{}\n");
    expect(worktreeState(root)).toEqual(CLEAN);
  });

  it("user config cannot hide untracked files or submodule changes", () => {
    const root = repo();
    git(root, "config", "status.showUntrackedFiles", "no");
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "u.txt"), "u\n");
    expect(worktreeState(root)).toMatchObject({ untracked: 1 });
  });

  it("a submodule at its expected commit with modified or untracked content is dirty", () => {
    const sub = repo();
    const root = repo();
    git(root, "submodule", "add", "-q", sub, "sm");
    git(root, "commit", "-q", "-m", "sm");
    git(root, "config", "diff.ignoreSubmodules", "all");
    writeFileSync(join(root, "sm", "a.txt"), "changed\n");
    expect(worktreeState(root)).toMatchObject({ submodule: 1 });
    git(join(root, "sm"), "checkout", "-q", "--", "a.txt");
    writeFileSync(join(root, "sm", "u.txt"), "u\n");
    expect(worktreeState(root)).toMatchObject({ submodule: 1 });
  });

  it("any failure is unavailable", () => {
    expect(worktreeState(tempDir("wtnot"))).toBe("unavailable");
  });
});
