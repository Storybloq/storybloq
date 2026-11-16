/**
 * C-v4.1 commit 4, plan section 4.2 and 4.4: the git facts snapshot.
 *
 * Every row builds a real repository in a temp folder. The snapshot is read
 * through takeGitSnapshot; per-commit state and ancestry come from its index,
 * never from a per-query git call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { takeGitSnapshot, type GitSnapshot } from "../../src/core/git-facts/snapshot.js";
import { git as fixtureGit } from "../helpers/git-fixture.js";

function git(cwd: string, args: string[]): string {
  return fixtureGit(cwd, args);
}

let n = 0;
function commit(cwd: string, subject: string, path = `f${n}.txt`): string {
  n += 1;
  writeFileSync(join(cwd, path), `content ${n}\n`);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", subject]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function ok(s: GitSnapshot): Extract<GitSnapshot, { status: "ok" }> {
  if (s.status !== "ok") throw new Error(`snapshot not ok: ${s.reason}`);
  return s;
}

describe("git facts snapshot (C-v4.1 commit 4, section 4.2 and 4.4)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gitfacts-"));
    git(root, ["init", "-q", "-b", "main", "--object-format=sha1"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classes a commit released, landed, built or none by reachability", async () => {
    const released = commit(root, "T-001 first");
    git(root, ["tag", "-a", "v1.0.0", "-m", "release"]);
    const landed = commit(root, "T-002 second");
    git(root, ["checkout", "-q", "-b", "feature"]);
    const built = commit(root, "T-003 on a branch");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["checkout", "-q", "-b", "gone"]);
    const orphan = commit(root, "T-004 then deleted");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["branch", "-q", "-D", "gone"]);

    const s = ok(await takeGitSnapshot(root, { defaultBranch: "main" }));
    expect(s.stateOf(released)).toBe("released");
    expect(s.stateOf(landed)).toBe("landed");
    expect(s.stateOf(built)).toBe("built");
    expect(s.stateOf(orphan)).toBe("none");
  });

  it("classes a commit reachable only from a detached HEAD as built", async () => {
    commit(root, "base");
    git(root, ["checkout", "-q", "--detach"]);
    const detached = commit(root, "T-010 detached work");
    const s = ok(await takeGitSnapshot(root, { defaultBranch: "main" }));
    expect(s.stateOf(detached)).toBe("built");
  });

  it("keeps merges in the graph, so a side-branch commit merged into main is landed", async () => {
    commit(root, "base");
    git(root, ["checkout", "-q", "-b", "side"]);
    const side = commit(root, "T-020 side work");
    git(root, ["checkout", "-q", "main"]);
    commit(root, "main moves");
    git(root, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    git(root, ["branch", "-q", "-D", "side"]);
    const s = ok(await takeGitSnapshot(root, { defaultBranch: "main" }));
    expect(s.stateOf(side)).toBe("landed");
  });

  it("peels a tag of a tag recursively to its commit", async () => {
    const c = commit(root, "T-030 tagged twice");
    git(root, ["tag", "-a", "inner", "-m", "inner"]);
    const innerObj = git(root, ["rev-parse", "inner"]);
    git(root, ["tag", "-a", "v2.0.0", "-m", "outer", innerObj]);
    git(root, ["tag", "-d", "inner"]);
    // v2.0.0 points at a tag object, so "released" needs a recursive peel;
    // a single-level peel lands on the inner tag and the commit stays landed.
    const s = ok(await takeGitSnapshot(root, { defaultBranch: "main" }));
    expect(s.stateOf(c)).toBe("released");
    expect(s.tags.find((t) => t.ref === "refs/tags/v2.0.0")?.kind).toBe("commit");
  });

  it("records a tag on a tree or blob as non-commit and skips it, never breaking the scan", async () => {
    const c = commit(root, "T-040 base");
    const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
    git(root, ["tag", "-a", "v9.9.9", "-m", "a tree", tree]);
    const blob = git(root, ["rev-parse", `HEAD:f${n - 1}.txt`]);
    git(root, ["tag", "v9.9.8", blob]);
    const s = ok(await takeGitSnapshot(root, { defaultBranch: "main" }));
    expect(s.tags.find((t) => t.ref === "refs/tags/v9.9.9")?.kind).toBe("non-commit");
    expect(s.tags.find((t) => t.ref === "refs/tags/v9.9.8")?.kind).toBe("non-commit");
    expect(s.stateOf(c)).toBe("landed");
  });

  it("is unknown with a reason for a missing default branch", async () => {
    commit(root, "base");
    const s = await takeGitSnapshot(root, { defaultBranch: "trunk" });
    expect(s).toMatchObject({ status: "unknown", reason: "missing default" });
  });

  it("is unknown for a shallow clone", async () => {
    commit(root, "a");
    commit(root, "b");
    const clone = await mkdtemp(join(tmpdir(), "gitfacts-shallow-"));
    try {
      git(clone, ["clone", "-q", "--depth=1", `file://${root}`, "c"]);
      const s = await takeGitSnapshot(join(clone, "c"), { defaultBranch: "main" });
      expect(s).toMatchObject({ status: "unknown", reason: "shallow repository" });
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  describe("maxGraphCommits", () => {
    it("0 means do not scan", async () => {
      commit(root, "a");
      const s = await takeGitSnapshot(root, { defaultBranch: "main", maxGraphCommits: 0 });
      expect(s).toMatchObject({ status: "unknown", reason: "scan disabled" });
    });

    it("over the limit is unknown and keeps no partial index", async () => {
      for (let i = 0; i < 4; i += 1) commit(root, `c${i}`);
      const s = await takeGitSnapshot(root, { defaultBranch: "main", maxGraphCommits: 3 });
      expect(s).toMatchObject({ status: "unknown", reason: "graph over limit" });
      expect("stateOf" in s).toBe(false);
    });

    it("exactly at the limit is ok", async () => {
      for (let i = 0; i < 3; i += 1) commit(root, `c${i}`);
      ok(await takeGitSnapshot(root, { defaultBranch: "main", maxGraphCommits: 3 }));
    });
  });

  it("over maxRefs is unknown", async () => {
    commit(root, "a");
    for (let i = 0; i < 3; i += 1) git(root, ["branch", `b${i}`]);
    const s = await takeGitSnapshot(root, { defaultBranch: "main", maxRefs: 3 });
    expect(s).toMatchObject({ status: "unknown", reason: "refs over limit" });
  });

  it("collects the code-touching set, leaving .story-only commits out", async () => {
    const code = commit(root, "T-050 code");
    mkdirSync(join(root, ".story"), { recursive: true });
    const ledger = commit(root, "T-050 ledger only", ".story/x.json");
    const s = ok(await takeGitSnapshot(root, { defaultBranch: "main" }));
    expect(s.touchesCode(code)).toBe(true);
    expect(s.touchesCode(ledger)).toBe(false);
  });

  it("answers isAncestor exactly as git merge-base --is-ancestor on random pairs", async () => {
    const shas: string[] = [commit(root, "root")];
    let seed = 7;
    const rand = (k: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    for (let i = 0; i < 30; i += 1) {
      const from = shas[rand(shas.length)]!;
      git(root, ["checkout", "-q", "-B", `w${i % 4}`, from]);
      if (i % 5 === 4 && shas.length > 2) {
        const other = shas[rand(shas.length)]!;
        try {
          git(root, ["merge", "-q", "--no-ff", "-m", `m${i}`, other]);
          shas.push(git(root, ["rev-parse", "HEAD"]));
          continue;
        } catch {
          git(root, ["merge", "--abort"]);
        }
      }
      shas.push(commit(root, `c${i}`));
    }
    git(root, ["checkout", "-q", "-B", "main", shas[shas.length - 1]!]);
    const s = ok(await takeGitSnapshot(root, { defaultBranch: "main" }));
    // Commits left behind by a branch reset are outside the captured graph; compare within it.
    const inGraph = shas.filter((x) => s.graph.num.has(x));
    expect(inGraph.length).toBeGreaterThan(10);
    for (let k = 0; k < 60; k += 1) {
      const a = inGraph[rand(inGraph.length)]!;
      const b = inGraph[rand(inGraph.length)]!;
      let expected: boolean;
      try { git(root, ["merge-base", "--is-ancestor", a, b]); expected = true; } catch { expected = false; }
      expect(s.isAncestor(a, b), `${a} -> ${b}`).toBe(expected);
    }
  }, 120_000);
});
