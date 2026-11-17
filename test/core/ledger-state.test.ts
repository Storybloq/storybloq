/**
 * C-v4.1 commit 7, part B: the ledger-state line on real git. Every local state
 * of the plan's table, the remote relation judged from the FILE's sha, the
 * unknown reasons, rename endpoints, odd names, and the git-call budget
 * counted through the runner.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, headSha, isolateGit, makeProjectRepo, cleanupTempDirs, tempDir } from "../mcp/board-git-fixtures.js";

const seam = vi.hoisted(() => ({ calls: [] as string[][], fail: null as null | ((args: readonly string[]) => boolean) }));
vi.mock("../../src/core/git-facts/runner.js", async (orig) => {
  const m = await orig<typeof import("../../src/core/git-facts/runner.js")>();
  return {
    ...m,
    runGitFacts: (req: Parameters<typeof m.runGitFacts>[0]) => {
      seam.calls.push([...req.args]);
      // Codex gate rows: one git verb fails (a timeout, a spawn error) while the rest run for real.
      if (seam.fail?.(req.args)) return Promise.resolve({ kind: "failed" as const, reason: "timeout" as const, detail: "injected" });
      return m.runGitFacts(req);
    },
  };
});

import { ledgerState, ledgerStateLine, ledgerStates, type LedgerState } from "../../src/core/ledger-state.js";

// Real git per row; reads run several git calls each.
vi.setConfig({ testTimeout: 60_000 });

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
beforeEach(() => { seam.calls.length = 0; seam.fail = null; });
afterEach(() => cleanupTempDirs());

const write = (root: string, rel: string, body = `${rel}\n`): string => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
};
const commitAll = (root: string, msg: string): string => { git(root, "add", "-A"); git(root, "commit", "-q", "-m", msg); return headSha(root); };
const setOrigin = (root: string, sha: string): void => {
  git(root, "update-ref", "refs/remotes/origin/main", sha);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
};
const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

async function state(root: string, rel: string): Promise<LedgerState | null> {
  return ledgerState(root, join(root, rel));
}

describe("local state: the classification table on real git", () => {
  it("untracked, added, AM, AD, ignored", async () => {
    const { root } = await makeProjectRepo();
    setOrigin(root, headSha(root));
    write(root, ".story/notes/u.json");
    write(root, ".story/notes/a.json"); git(root, "add", ".story/notes/a.json");
    write(root, ".story/notes/am.json"); git(root, "add", ".story/notes/am.json"); write(root, ".story/notes/am.json", "changed\n");
    write(root, ".story/notes/ad.json"); git(root, "add", ".story/notes/ad.json"); rmSync(join(root, ".story/notes/ad.json"));
    write(root, ".story/snapshots/ignored.json");
    expect(await state(root, ".story/notes/u.json")).toEqual({ state: "untracked" });
    expect(await state(root, ".story/notes/a.json")).toEqual({ state: "added" });
    expect(await state(root, ".story/notes/am.json")).toEqual({ state: "added" });
    const ad = await state(root, ".story/notes/ad.json");
    expect(ad).toEqual({ state: "deleted", neverCommitted: true });
    expect(ledgerStateLine(ad)).toBe("Ledger: added, then deleted, never committed");
    expect(await state(root, ".story/snapshots/ignored.json")).toEqual({ state: "untracked" });
    expect(ledgerStateLine({ state: "added" })).toBe("Ledger: added, not committed");
    expect(ledgerStateLine({ state: "untracked" })).toBe("Ledger: untracked");
  });

  it("MM, M., .M, MD, RD keep the last committed sha; D. and .D read deleted with it", async () => {
    const { root } = await makeProjectRepo();
    for (const n of ["mm", "mi", "mw", "md", "rd", "di", "dw"]) write(root, `.story/notes/${n}.json`);
    const sha = commitAll(root, "base");
    setOrigin(root, sha);
    write(root, ".story/notes/mm.json", "1\n"); git(root, "add", ".story/notes/mm.json"); write(root, ".story/notes/mm.json", "2\n");
    write(root, ".story/notes/mi.json", "1\n"); git(root, "add", ".story/notes/mi.json");
    write(root, ".story/notes/mw.json", "1\n");
    write(root, ".story/notes/md.json", "1\n"); git(root, "add", ".story/notes/md.json"); rmSync(join(root, ".story/notes/md.json"));
    git(root, "mv", ".story/notes/rd.json", ".story/notes/rd2.json"); rmSync(join(root, ".story/notes/rd2.json"));
    git(root, "rm", "-q", ".story/notes/di.json");
    rmSync(join(root, ".story/notes/dw.json"));
    for (const n of ["mm", "mi", "mw"]) {
      const s = await state(root, `.story/notes/${n}.json`);
      expect(s).toMatchObject({ state: "modified", sha, remote: { ref: "origin/main", relation: "contains" } });
      expect(ledgerStateLine(s)).toBe(`Ledger: modified since ${sha}, on origin/main`);
    }
    expect(await state(root, ".story/notes/md.json")).toMatchObject({ state: "deleted", sha });
    const rd = await state(root, ".story/notes/rd2.json");
    expect(rd).toMatchObject({ state: "deleted", sha, from: ".story/notes/rd.json" });
    expect(ledgerStateLine(rd)).toBe(`Ledger: deleted (was renamed from .story/notes/rd.json), last at ${sha}, on origin/main`);
    for (const n of ["di", "dw"]) {
      const s = await state(root, `.story/notes/${n}.json`);
      expect(s).toMatchObject({ state: "deleted", sha });
      expect(ledgerStateLine(s)).toBe(`Ledger: deleted, last at ${sha}, on origin/main`);
    }
  });

  it("a real merge conflict reads conflicted, never committed", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/c.json", "base\n");
    const base = commitAll(root, "base");
    setOrigin(root, base);
    git(root, "checkout", "-q", "-b", "side");
    write(root, ".story/notes/c.json", "side\n"); commitAll(root, "side");
    git(root, "checkout", "-q", "main");
    write(root, ".story/notes/c.json", "main\n"); const mainSha = commitAll(root, "main");
    try { git(root, "merge", "-q", "side"); } catch { /* the conflict is the point */ }
    const s = await state(root, ".story/notes/c.json");
    expect(s).toMatchObject({ state: "conflicted", sha: mainSha });
    expect(ledgerStateLine(s)).toMatch(new RegExp(`^Ledger: conflicted, last at ${mainSha}, ahead of origin/main by 1$`));
    expect(ledgerStateLine({ state: "conflicted" })).toBe("Ledger: conflicted, never committed");
  });

  it("a staged rename reads the same whether the destination, the source or both are requested; the sha comes from the source", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/old.json", "x\n".repeat(20));
    const sha = commitAll(root, "base");
    setOrigin(root, sha);
    git(root, "mv", ".story/notes/old.json", ".story/notes/new.json");
    write(root, ".story/notes/after.json"); // a changed file after the rename pair
    const dst = join(root, ".story/notes/new.json");
    const src = join(root, ".story/notes/old.json");
    const after = join(root, ".story/notes/after.json");
    const both = await ledgerStates(root, [dst, src, after]);
    const dstOnly = await ledgerStates(root, [dst]);
    const srcOnly = await ledgerStates(root, [src]);
    expect(dstOnly.get(dst)).toEqual(both.get(dst));
    expect(srcOnly.get(src)).toEqual(both.get(src));
    expect(both.get(dst)).toMatchObject({ state: "renamed", from: ".story/notes/old.json", sha });
    expect(ledgerStateLine(both.get(dst)!)).toBe(`Ledger: renamed from .story/notes/old.json, last at ${sha}, on origin/main`);
    expect(both.get(src)).toMatchObject({ state: "deleted", to: ".story/notes/new.json", sha });
    expect(ledgerStateLine(both.get(src)!)).toBe(`Ledger: deleted (renamed to .story/notes/new.json), last at ${sha}, on origin/main`);
    expect(both.get(after)).toEqual({ state: "untracked" });
  });

  it("a rename plus a modification reads renamed, modified", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/r.json", "line\n".repeat(30));
    const sha = commitAll(root, "base");
    setOrigin(root, sha);
    git(root, "mv", ".story/notes/r.json", ".story/notes/r2.json");
    write(root, ".story/notes/r2.json", "line\n".repeat(30) + "more\n");
    const s = await state(root, ".story/notes/r2.json");
    expect(s).toMatchObject({ state: "renamed", modified: true, sha });
    expect(ledgerStateLine(s)).toBe(`Ledger: renamed from .story/notes/r.json, modified, last at ${sha}, on origin/main`);
  });

  it("names with a space and a newline", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/a b.json");
    write(root, ".story/notes/c\nd.json");
    const sha = commitAll(root, "odd");
    setOrigin(root, sha);
    write(root, ".story/notes/e f.json");
    expect(await state(root, ".story/notes/a b.json")).toMatchObject({ state: "committed", sha });
    expect(await state(root, ".story/notes/c\nd.json")).toMatchObject({ state: "committed", sha });
    expect(await state(root, ".story/notes/e f.json")).toEqual({ state: "untracked" });
  });
});

describe("remote relation, judged from the file's sha", () => {
  it("contains when origin is ahead of the file; contains on a merge-side commit", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/f.json");
    const fileSha = commitAll(root, "file");
    write(root, "later.txt"); const later = commitAll(root, "later");
    setOrigin(root, later);
    expect(await state(root, ".story/notes/f.json")).toMatchObject({ state: "committed", sha: fileSha, remote: { relation: "contains" } });

    git(root, "checkout", "-q", "-b", "side");
    write(root, ".story/notes/side.json"); const sideSha = commitAll(root, "side");
    git(root, "checkout", "-q", "main");
    write(root, "main.txt"); commitAll(root, "main");
    git(root, "merge", "-q", "--no-ff", "-m", "merge", "side");
    setOrigin(root, headSha(root));
    const s = await state(root, ".story/notes/side.json");
    expect(s).toMatchObject({ sha: sideSha, remote: { ref: "origin/main", relation: "contains" } });
    expect(ledgerStateLine(s)).toBe(`Ledger: committed at ${sideSha}, on origin/main`);
  });

  it("ahead by N, and a detached HEAD changes nothing", async () => {
    const { root } = await makeProjectRepo();
    setOrigin(root, headSha(root));
    write(root, "x.txt"); commitAll(root, "x");
    write(root, ".story/notes/f.json"); const fileSha = commitAll(root, "file");
    write(root, "y.txt"); commitAll(root, "y");
    const s = await state(root, ".story/notes/f.json");
    expect(s).toMatchObject({ sha: fileSha, remote: { relation: "ahead", ahead: 2 } });
    expect(ledgerStateLine(s)).toBe(`Ledger: committed at ${fileSha}, ahead of origin/main by 2`);
    // Detached at the file's own commit: the relation is judged from the file's sha, so it is unchanged.
    git(root, "checkout", "-q", "--detach", fileSha);
    expect(await state(root, ".story/notes/f.json")).toMatchObject({ sha: fileSha, remote: { relation: "ahead", ahead: 2 } });
  });

  it("diverged with both counts", async () => {
    const { root } = await makeProjectRepo();
    const base = headSha(root);
    write(root, ".story/notes/f.json"); const fileSha = commitAll(root, "file");
    const side = git(root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "side").trim();
    const side2 = git(root, "commit-tree", `${base}^{tree}`, "-p", side, "-m", "side2").trim();
    setOrigin(root, side2);
    const s = await state(root, ".story/notes/f.json");
    expect(s).toMatchObject({ sha: fileSha, remote: { relation: "diverged", ahead: 1, behind: 2 } });
    expect(ledgerStateLine(s)).toBe(`Ledger: committed at ${fileSha}, diverged from origin/main (ahead 1, behind 2)`);
  });

  it("unknown with a reason, never zero: no origin, a shallow clone; a known local sha survives", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/f.json"); const fileSha = commitAll(root, "file");
    const noOrigin = await state(root, ".story/notes/f.json");
    expect(noOrigin).toMatchObject({ state: "committed", sha: fileSha, remote: { relation: "unknown" } });
    expect(noOrigin!.remote!.reason).toMatch(/missing default|no origin\/main/);
    expect(ledgerStateLine(noOrigin)).toMatch(new RegExp(`^Ledger: committed at ${fileSha}, (default branch|origin/main) unknown \\((missing default|no origin/main)\\)$`));
    expect(ledgerStateLine(noOrigin)).not.toMatch(/\b0\b/);

    write(root, "y.txt"); commitAll(root, "y");
    setOrigin(root, headSha(root));
    const clone = tempDir("shallow");
    git(clone, "clone", "-q", "--depth", "1", `file://${root}`, "c");
    const c = join(clone, "c");
    const s = await state(c, ".story/notes/f.json");
    expect(s).toMatchObject({ state: "committed", remote: { relation: "unknown", reason: "shallow repository" } });
    expect(s!.sha).toMatch(HEX);
  });

  it("unborn HEAD: an added file has no sha and no remote", async () => {
    const { root } = await makeProjectRepo({ commit: false });
    git(root, "add", "-A");
    expect(await state(root, ".story/config.json")).toEqual({ state: "added" });
  });

  it("git unavailable reads null, never guessed", async () => {
    const dir = tempDir("plain");
    const abs = write(dir, ".story/notes/f.json");
    expect(await ledgerState(dir, abs)).toBeNull();
    expect(ledgerStateLine(null)).toBe("Ledger: unknown (git unavailable)");
  });
});

describe("a failed query proves no absence (Codex gate)", () => {
  it("ls-files fails: a clean tracked file reads null, never untracked; paths status classified keep their state", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/clean.json");
    write(root, ".story/notes/mod.json");
    const sha = commitAll(root, "base");
    setOrigin(root, sha);
    write(root, ".story/notes/mod.json", "changed\n");
    write(root, ".story/notes/new.json");
    const [clean, mod, fresh] = [".story/notes/clean.json", ".story/notes/mod.json", ".story/notes/new.json"].map((r) => join(root, r));
    seam.fail = (args) => args[0] === "ls-files";
    const got = await ledgerStates(root, [clean!, mod!, fresh!]);
    expect(seam.calls.some((a) => a[0] === "ls-files")).toBe(true);
    expect(got.get(clean!)).toBeNull();
    expect(ledgerStateLine(got.get(clean!)!)).not.toContain("untracked");
    expect(got.get(mod!)).toMatchObject({ state: "modified", sha });
    expect(got.get(fresh!)).toEqual({ state: "untracked" });
  });

  it("a failed log for a conflicted file with real history never prints never committed", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/c.json", "base\n");
    setOrigin(root, commitAll(root, "base"));
    git(root, "checkout", "-q", "-b", "side");
    write(root, ".story/notes/c.json", "side\n"); commitAll(root, "side");
    git(root, "checkout", "-q", "main");
    write(root, ".story/notes/c.json", "main\n"); commitAll(root, "main");
    try { git(root, "merge", "-q", "side"); } catch { /* the conflict is the point */ }
    seam.fail = (args) => args[0] === "log";
    const s = await state(root, ".story/notes/c.json");
    expect(s).toEqual({ state: "conflicted", lastCommitUnknown: true });
    expect(ledgerStateLine(s)).toBe("Ledger: conflicted, last commit unknown");
  });

  it("a failed log for a renamed file with real history never prints never committed", async () => {
    const { root } = await makeProjectRepo();
    write(root, ".story/notes/old.json", "x\n".repeat(20));
    setOrigin(root, commitAll(root, "base"));
    git(root, "mv", ".story/notes/old.json", ".story/notes/new.json");
    write(root, ".story/notes/new.json", "x\n".repeat(20) + "y\n");
    seam.fail = (args) => args[0] === "log";
    const dst = join(root, ".story/notes/new.json");
    const src = join(root, ".story/notes/old.json");
    const both = await ledgerStates(root, [dst, src]);
    expect(both.get(dst)).toMatchObject({ state: "renamed", from: ".story/notes/old.json", lastCommitUnknown: true });
    expect(both.get(dst)).not.toHaveProperty("sha");
    expect(ledgerStateLine(both.get(dst)!)).toBe("Ledger: renamed from .story/notes/old.json, modified, last commit unknown");
    expect(ledgerStateLine(both.get(src)!)).toBe("Ledger: deleted (renamed to .story/notes/new.json), last commit unknown");
    for (const v of both.values()) expect(ledgerStateLine(v)).not.toContain("never committed");
  });
});

describe("budget", () => {
  it("1 identity + 1 status + 1 ls-files + the ref resolution + 1 log per file + 1 count per distinct sha", async () => {
    const { root } = await makeProjectRepo();
    const base = headSha(root);
    write(root, ".story/notes/a.json"); commitAll(root, "a");
    write(root, ".story/notes/b.json"); write(root, ".story/notes/c.json"); commitAll(root, "b and c");
    const side = git(root, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "side").trim();
    setOrigin(root, side);
    seam.calls.length = 0;
    const paths = ["a", "b", "c"].map((n) => join(root, `.story/notes/${n}.json`));
    const out = await ledgerStates(root, paths);
    expect(out.get(paths[0]!)).toMatchObject({ remote: { relation: "diverged", ahead: 1, behind: 1 } });
    expect(out.get(paths[1]!)).toMatchObject({ remote: { relation: "diverged", ahead: 2, behind: 1 } });
    const verbs = seam.calls.map((a) => a[0]);
    // The fixed prefix, then per file one log and (for a sha not yet counted) one count.
    expect(verbs.slice(0, 5)).toEqual(["rev-parse", "status", "ls-files", "symbolic-ref", "rev-parse"]);
    expect(verbs.slice(5).filter((v) => v === "log")).toHaveLength(3);
    expect(verbs.slice(5).filter((v) => v === "rev-list")).toHaveLength(2);
    expect(verbs).toHaveLength(10);
    expect(seam.calls[1]!.slice(-2)).toEqual(["--", ".story/"]);
  });
});
