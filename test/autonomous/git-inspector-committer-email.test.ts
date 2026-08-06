/**
 * ISS-982 (R4-F1): `gitCommitterEmail` reads a SPECIFIC COMMIT's committer
 * identity, distinct from `gitUserEmail`'s live, ambient `user.email` config.
 *
 * The first proposed implementation used `git log -1 --format=%ce -- <hash>`,
 * placing `<hash>` after `--`, which makes git treat it as a PATH FILTER
 * rather than a revision -- every real hash would silently return empty
 * output. This test requests a NON-HEAD commit's committer email against a
 * real repository with at least two commits and asserts it matches that
 * commit's actual, known committer, so a HEAD-only check could not pass by
 * coincidence of working-tree state.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitCommitterEmail } from "../../src/autonomous/git-inspector.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

describe("gitCommitterEmail (ISS-982/R4-F1)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "committer-email-"));
    git(root, ["init", "-q", "."]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the committer email of a specific NON-HEAD commit, not just HEAD's", async () => {
    git(root, ["config", "user.email", "first@example.com"]);
    git(root, ["config", "user.name", "First"]);
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "first commit"]);
    const firstHash = git(root, ["rev-parse", "HEAD"]);

    git(root, ["config", "user.email", "second@example.com"]);
    git(root, ["config", "user.name", "Second"]);
    writeFileSync(join(root, "b.txt"), "two\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "second commit"]);
    const secondHash = git(root, ["rev-parse", "HEAD"]);

    expect(firstHash).not.toBe(secondHash);

    // The commit under test is NOT HEAD -- this is what the `--` bug would
    // have gotten wrong (it returns empty output for every real hash).
    const firstResult = await gitCommitterEmail(root, firstHash);
    expect(firstResult.ok).toBe(true);
    if (firstResult.ok) expect(firstResult.data).toBe("first@example.com");

    const secondResult = await gitCommitterEmail(root, secondHash);
    expect(secondResult.ok).toBe(true);
    if (secondResult.ok) expect(secondResult.data).toBe("second@example.com");
  });

  it("returns a git error for a hash that does not exist in the repository", async () => {
    const result = await gitCommitterEmail(root, "a".repeat(40));
    expect(result.ok).toBe(false);
  });

  it("returns a git error for an invalid ref format (option-injection guard)", async () => {
    const result = await gitCommitterEmail(root, "--upload-pack=touch /tmp/pwned");
    expect(result.ok).toBe(false);
  });
});
