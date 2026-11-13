import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolveDefaultBranch } from "../../src/core/default-branch.js";
import { cleanupTempDirs, isolateGit, tempDir } from "../mcp/board-git-fixtures.js";

/** The shipped default-branch rule as one helper (receipt add now; the commit 4 snapshot later). */

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" });
function repo(branch = "trunk"): string {
  const root = tempDir("defbranch");
  git(root, "init", "-q", "-b", branch);
  return root;
}

describe("resolveDefaultBranch", () => {
  it("is the remote's symbolic HEAD target when there is one", () => {
    const root = repo();
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
    git(root, "config", "init.defaultBranch", "other");
    expect(resolveDefaultBranch(root)).toBe("release");
  });

  it("falls back to init.defaultBranch", () => {
    const root = repo();
    git(root, "config", "init.defaultBranch", "develop");
    expect(resolveDefaultBranch(root)).toBe("develop");
  });

  it("is null when neither resolves, never a guessed main", () => {
    expect(resolveDefaultBranch(repo("main"))).toBeNull();
  });
});
