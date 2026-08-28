/**
 * T-474 (D2): `gitParentOf`/`gitTreeOf`/`gitWriteTree` back the pre-commit-ack
 * gate's tree-object-id pin -- content-addressed by git itself, so it is
 * immune to diff-formatting concerns entirely (a rename, a mode change, or a
 * binary file all still produce the SAME tree id for the same final content,
 * unlike a diff-hash design which would need separate handling for each).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitParentOf, gitTreeOf, gitWriteTree, gitObjectFormat } from "../../src/autonomous/git-inspector.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

describe("gitParentOf / gitTreeOf / gitWriteTree (T-474 D2)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gate-ack-git-"));
    git(root, ["init", "-q", "."]);
    git(root, ["config", "user.email", "test@test.com"]);
    git(root, ["config", "user.name", "Test"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("gitObjectFormat reports sha1 for an ordinary repository", async () => {
    const result = await gitObjectFormat(root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe("sha1");
  });

  it("gitParentOf fails with a named reason for a root commit (no parent)", async () => {
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "root commit"]);
    const rootSha = git(root, ["rev-parse", "HEAD"]);

    const result = await gitParentOf(root, rootSha);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  it("gitParentOf resolves the direct parent of a non-root commit", async () => {
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "first"]);
    const firstSha = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "a.txt"), "two\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "second"]);
    const secondSha = git(root, ["rev-parse", "HEAD"]);

    const result = await gitParentOf(root, secondSha);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(firstSha);
  });

  it("gitTreeOf's committed tree matches the pre-commit gitWriteTree pin for an ordinary staged change", async () => {
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "init"]);

    writeFileSync(join(root, "b.txt"), "two\n");
    git(root, ["add", "-A"]);
    const preCommitTree = await gitWriteTree(root);
    expect(preCommitTree.ok).toBe(true);

    git(root, ["commit", "-qm", "add b"]);
    const commitSha = git(root, ["rev-parse", "HEAD"]);
    const postCommitTree = await gitTreeOf(root, commitSha);
    expect(postCommitTree.ok).toBe(true);
    if (preCommitTree.ok && postCommitTree.ok) {
      expect(postCommitTree.data).toBe(preCommitTree.data);
    }
  });

  it("tree id is immune to a rename -- pre-commit and post-commit trees still match", async () => {
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "init"]);

    execFileSync("git", ["mv", "a.txt", "renamed.txt"], { cwd: root });
    const preCommitTree = await gitWriteTree(root);
    git(root, ["commit", "-qm", "rename"]);
    const commitSha = git(root, ["rev-parse", "HEAD"]);
    const postCommitTree = await gitTreeOf(root, commitSha);
    if (preCommitTree.ok && postCommitTree.ok) {
      expect(postCommitTree.data).toBe(preCommitTree.data);
    } else {
      throw new Error("expected both tree computations to succeed");
    }
  });

  it("tree id is immune to a mode change -- pre-commit and post-commit trees still match", async () => {
    const filePath = join(root, "script.sh");
    writeFileSync(filePath, "#!/bin/sh\necho hi\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "init"]);

    chmodSync(filePath, 0o755);
    git(root, ["add", "-A"]);
    const preCommitTree = await gitWriteTree(root);
    git(root, ["commit", "-qm", "make executable"]);
    const commitSha = git(root, ["rev-parse", "HEAD"]);
    const postCommitTree = await gitTreeOf(root, commitSha);
    if (preCommitTree.ok && postCommitTree.ok) {
      expect(postCommitTree.data).toBe(preCommitTree.data);
    } else {
      throw new Error("expected both tree computations to succeed");
    }
  });

  it("tree id is immune to a binary file -- pre-commit and post-commit trees still match", async () => {
    writeFileSync(join(root, "seed.txt"), "seed\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "init"]);

    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 255, 254, 253, 0, 0, 10]));
    git(root, ["add", "-A"]);
    const preCommitTree = await gitWriteTree(root);
    git(root, ["commit", "-qm", "add binary"]);
    const commitSha = git(root, ["rev-parse", "HEAD"]);
    const postCommitTree = await gitTreeOf(root, commitSha);
    if (preCommitTree.ok && postCommitTree.ok) {
      expect(postCommitTree.data).toBe(preCommitTree.data);
    } else {
      throw new Error("expected both tree computations to succeed");
    }
  });

  it("gitParentOf refuses an actual two-parent merge commit, never a first-parent pin (AM3)", async () => {
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "init"]);
    const mainBranch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);

    git(root, ["checkout", "-qb", "side"]);
    writeFileSync(join(root, "b.txt"), "side\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "side commit"]);

    git(root, ["checkout", "-q", mainBranch]);
    writeFileSync(join(root, "c.txt"), "main\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "main commit"]);

    git(root, ["merge", "-q", "--no-ff", "-m", "merge side into main", "side"]);
    const mergeSha = git(root, ["rev-parse", "HEAD"]);
    const parents = git(root, ["rev-list", "--parents", "-n", "1", mergeSha]).split(/\s+/);
    expect(parents.length).toBe(3); // commit + 2 parents

    const parentResult = await gitParentOf(root, mergeSha);
    expect(parentResult.ok).toBe(false);
    if (!parentResult.ok) {
      expect(parentResult.message).toContain("merge commits are not supported");
      expect(parentResult.message).toContain("2 parents");
    }

    const treeResult = await gitTreeOf(root, mergeSha);
    expect(treeResult.ok).toBe(false);
    if (!treeResult.ok) expect(treeResult.message).toContain("merge commits are not supported");
  });

  it("gitTreeOf explicitly refuses a sha256 object-format repository (v1 constraint)", async () => {
    const sha256Root = mkdtempSync(join(tmpdir(), "gate-ack-git-sha256-"));
    try {
      git(sha256Root, ["init", "-q", "--object-format=sha256", "."]);
      git(sha256Root, ["config", "user.email", "test@test.com"]);
      git(sha256Root, ["config", "user.name", "Test"]);
      writeFileSync(join(sha256Root, "a.txt"), "one\n");
      git(sha256Root, ["add", "-A"]);
      git(sha256Root, ["commit", "-qm", "init"]);
      const commitSha = git(sha256Root, ["rev-parse", "HEAD"]);

      const format = await gitObjectFormat(sha256Root);
      expect(format.ok).toBe(true);
      if (format.ok) expect(format.data).toBe("sha256");

      const treeResult = await gitTreeOf(sha256Root, commitSha);
      expect(treeResult.ok).toBe(false);
      if (!treeResult.ok) expect(treeResult.message).toContain("only supports SHA-1");
    } finally {
      rmSync(sha256Root, { recursive: true, force: true });
    }
  });
});
