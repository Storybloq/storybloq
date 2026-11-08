/**
 * ISS-1457: a setup reviewer runs only in a folder this user alone controls,
 * with no project configuration in reach, and codex only with a CODEX_HOME
 * nobody else could have planted. Real directories under the scratch root;
 * the uid seam stands in for another user.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { checkCodexHome, checkExecLocation, checkHome, isWithin, repositoryBoundary, trustSeams } from "../../src/core/setup-review-trust.js";
import { makeScratchDir, removeScratchDirs } from "../helpers/setup-review-fakes.js";

const real = { ...trustSeams };
let root: string;

beforeEach(() => {
  root = realpathSync(makeScratchDir("sr-trust-"));
});

afterEach(() => {
  Object.assign(trustSeams, real);
  removeScratchDirs();
});

const dir = (...parts: string[]): string => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
};
/** Reports `path` as owned by another user, everything else as it is. */
const foreign = (path: string): void => {
  trustSeams.lstat = (p) => (p === path ? ({ ...real.lstat(p), uid: 4242, isSymbolicLink: () => false } as Stats) : real.lstat(p));
  trustSeams.stat = (p) => (p === path ? ({ ...real.stat(p), uid: 4242 } as Stats) : real.stat(p));
};

describe("the home directory as the trust anchor", () => {
  it("a private home under the sticky shared tmp is trusted, since the entry inside it is this user's", () => {
    expect(checkHome({ HOME: dir("home") })).toMatchObject({ ok: true, home: join(root, "home") });
  });

  it("a home writable by others is refused", () => {
    const home = dir("home");
    chmodSync(home, 0o777);
    expect(checkHome({ HOME: home })).toEqual({ ok: false, detail: expect.stringMatching(/home: .*home is writable by other users/) });
  });

  it("a home another user owns is refused", () => {
    const home = dir("home");
    foreign(home);
    expect(checkHome({ HOME: home })).toEqual({ ok: false, detail: expect.stringMatching(/is not owned by this user/) });
  });

  it("an ancestor writable by others without the sticky bit is refused", () => {
    const parent = dir("open");
    const home = dir("open", "home");
    chmodSync(parent, 0o777);
    expect(checkHome({ HOME: home })).toEqual({ ok: false, detail: expect.stringMatching(/open is writable by other users/) });
  });

  it("a sticky ancestor is refused when the entry inside it is not this user's", () => {
    const shared = dir("shared");
    const mine = dir("shared", "theirs");
    const home = dir("shared", "theirs", "home");
    chmodSync(shared, 0o1777);
    foreign(mine);
    expect(checkHome({ HOME: home })).toEqual({ ok: false, detail: expect.stringMatching(/theirs inside the shared .*shared is not this user's|theirs is owned by another user/) });
  });

  it("a sticky ancestor whose entry is root's, not this user's, is refused: the entry under a shared folder must be this user's", () => {
    const shared = dir("shared");
    const entry = dir("shared", "roots");
    const home = dir("shared", "roots", "home");
    chmodSync(shared, 0o1777);
    trustSeams.lstat = (p) => (p === entry ? ({ ...real.lstat(p), uid: 0, isSymbolicLink: () => false } as Stats) : real.lstat(p));
    trustSeams.stat = (p) => (p === entry ? ({ ...real.stat(p), uid: 0 } as Stats) : real.stat(p));
    expect(checkHome({ HOME: home })).toEqual({ ok: false, detail: expect.stringMatching(/roots inside the shared .*shared is not this user's/) });
  });

  it("a sticky ancestor whose entry is this user's is accepted", () => {
    const shared = dir("shared");
    const home = dir("shared", "home");
    chmodSync(shared, 0o1777);
    expect(checkHome({ HOME: home })).toMatchObject({ ok: true });
  });

  it("an ancestor another user owns is refused", () => {
    const parent = dir("theirs");
    const home = dir("theirs", "home");
    trustSeams.stat = (p) => (p === parent ? ({ ...real.stat(p), uid: 4242 } as Stats) : real.stat(p));
    expect(checkHome({ HOME: home })).toEqual({ ok: false, detail: expect.stringMatching(/theirs is owned by another user/) });
  });
});

describe("where a reviewer may run", () => {
  it("a store under home is trusted", () => {
    const home = dir("home");
    const store = dir("home", "Library", "storybloq", "setup-review");
    const exec = dir("home", "Library", "storybloq", "setup-review", ".probe-x");
    expect(checkExecLocation(exec, store, { HOME: home }, dir("project"))).toEqual({ ok: true });
  });

  it("an override outside home, under root's and sticky ancestors, is trusted", () => {
    const store = dir("override");
    const exec = dir("override", ".probe-x");
    expect(checkExecLocation(exec, store, { HOME: dir("home") }, dir("project"))).toEqual({ ok: true });
  });

  it("an override under an ancestor writable by others is refused", () => {
    const open = dir("open");
    const store = dir("open", "store");
    chmodSync(open, 0o777);
    expect(checkExecLocation(dir("open", "store", "x"), store, { HOME: dir("home") }, dir("project"))).toEqual({ ok: false, detail: expect.stringMatching(/review store: .*open is writable by other users/) });
  });

  it("an override under an ancestor another user owns is refused", () => {
    const theirs = dir("theirs");
    const store = dir("theirs", "store");
    trustSeams.stat = (p) => (p === theirs ? ({ ...real.stat(p), uid: 4242 } as Stats) : real.stat(p));
    expect(checkExecLocation(dir("theirs", "store", "x"), store, { HOME: dir("home") }, dir("project"))).toEqual({ ok: false, detail: expect.stringMatching(/theirs is owned by another user/) });
  });

  it("a store folder another user owns, or one writable by others, is refused", () => {
    const store = dir("store");
    const exec = dir("store", "x");
    foreign(store);
    expect(checkExecLocation(exec, store, { HOME: dir("home") }, dir("project"))).toMatchObject({ ok: false, detail: expect.stringMatching(/store is not owned by this user/) });
    Object.assign(trustSeams, real);
    chmodSync(exec, 0o777);
    expect(checkExecLocation(exec, store, { HOME: dir("home") }, dir("project"))).toMatchObject({ ok: false, detail: expect.stringMatching(/x is writable by other users/) });
  });

  it("a link at or below the anchor is refused", () => {
    const store = dir("store");
    const elsewhere = dir("store", "elsewhere");
    symlinkSync(elsewhere, join(store, "link"));
    expect(checkExecLocation(join(store, "link"), store, { HOME: dir("home") }, dir("project"))).toMatchObject({ ok: false, detail: expect.stringMatching(/goes through a link/) });
  });

  it("a root-owned link above the anchor, as /tmp on macOS, is allowed", () => {
    const store = dir("store");
    const viaTmp = store.replace(/^\/private\/tmp\//, "/tmp/");
    if (viaTmp === store || lstatSync("/tmp").uid !== 0) return;
    expect(checkExecLocation(join(viaTmp), viaTmp, { HOME: dir("home") }, dir("project"))).toEqual({ ok: true });
  });

  it.each([".git", ".codex"])("a folder on the way down holding %s is refused, so codex finds no project config", (entry) => {
    const store = dir("store");
    dir("store", "a", entry);
    expect(checkExecLocation(dir("store", "a", "b"), store, { HOME: dir("home") }, dir("project"))).toMatchObject({ ok: false, detail: expect.stringMatching(new RegExp(`holds \\${entry}`)) });
  });

  it("home's own .codex is not a project config source", () => {
    const home = dir("home");
    dir("home", ".codex");
    const store = dir("home", "state", "setup-review");
    expect(checkExecLocation(dir("home", "state", "setup-review", "x"), store, { HOME: home }, dir("project"))).toEqual({ ok: true });
  });

  it("a path that resolves outside the store is refused", () => {
    const store = dir("store");
    expect(checkExecLocation(dir("other"), store, { HOME: dir("home") }, dir("project"))).toMatchObject({ ok: false, detail: expect.stringMatching(/outside the review store/) });
  });
});

describe("which CODEX_HOME codex may start with", () => {
  it("one inside the project is refused", () => {
    const project = dir("project");
    expect(checkCodexHome({ HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: dir("project", ".codex") }, project)).toMatchObject({ ok: false, reason: { code: "untrusted-codex-home", detail: expect.stringMatching(/inside the project/) } });
  });

  it("home inside the project puts the default CODEX_HOME there too, and it is refused", () => {
    const project = dir("project");
    expect(checkCodexHome({ HOME: project, TMPDIR: dir("tmp") }, project)).toMatchObject({ ok: false, reason: { code: "untrusted-codex-home", detail: expect.stringMatching(/inside the project/) } });
  });

  it("one inside TMPDIR is refused", () => {
    const tmp = dir("tmp");
    expect(checkCodexHome({ HOME: dir("home"), TMPDIR: tmp, CODEX_HOME: dir("tmp", "codex") }, dir("project"))).toMatchObject({ ok: false, reason: { detail: expect.stringMatching(/inside the temporary folder/) } });
  });

  it("with no TMPDIR the system temporary folder is the temp root, never none", () => {
    // The scratch root is under the system temporary folder, so a home there is refused without TMPDIR.
    expect(checkCodexHome({ HOME: dir("home") }, dir("project"))).toMatchObject({ ok: false, reason: { code: "untrusted-codex-home", detail: expect.stringMatching(/inside the temporary folder/) } });
  });

  it("one another user owns, or under an ancestor writable by others, is refused", () => {
    const codexHome = dir("ch");
    foreign(codexHome);
    expect(checkCodexHome({ HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: codexHome }, dir("project"))).toMatchObject({ ok: false, reason: { code: "untrusted-codex-home", detail: expect.stringMatching(/not owned by this user/) } });
    Object.assign(trustSeams, real);
    const open = dir("open");
    chmodSync(open, 0o777);
    expect(checkCodexHome({ HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: dir("open", "ch") }, dir("project"))).toMatchObject({ ok: false, reason: { detail: expect.stringMatching(/open is writable by other users/) } });
  });

  it("the default under a private home, existing or not yet made, is trusted", () => {
    const home = dir("home");
    const env = { HOME: home, TMPDIR: dir("tmp") };
    expect(checkCodexHome(env, dir("project"))).toMatchObject({ ok: true });
    dir("home", ".codex");
    expect(checkCodexHome(env, dir("project"))).toMatchObject({ ok: true });
  });
});

describe("ISS-1457 round 1: containment, listing, the repository and CODEX_HOME links", () => {
  it("a descendant named ..credentials is inside; real parent traversal is outside", () => {
    expect(isWithin("/p/..credentials", "/p")).toBe(true);
    expect(isWithin("/p/..credentials/x", "/p")).toBe(true);
    expect(isWithin("/p/../q", "/p")).toBe(false);
    expect(isWithin("/q", "/p")).toBe(false);
    expect(isWithin("/", "/p")).toBe(false);
  });

  it.each(["EACCES", "EIO"])("a folder that cannot be listed (%s) is a refusal carrying the errno, never clean", (code) => {
    const home = dir("home");
    const store = dir("home", "state", "setup-review");
    const exec = dir("home", "state", "setup-review", "x");
    trustSeams.readdir = (p) => {
      if (p === store) throw Object.assign(new Error(code), { code });
      return real.readdir(p);
    };
    expect(checkExecLocation(exec, store, { HOME: home }, dir("project"))).toEqual({ ok: false, detail: expect.stringMatching(new RegExp(`cannot be listed \\(${code}\\)`)) });
  });

  it("the repository boundary is the top-most folder holding .git above the working folder, or the folder itself", () => {
    mkdirSync(dir("repo", ".git"), { recursive: true });
    mkdirSync(dir("repo", "inner", ".git"), { recursive: true });
    expect(repositoryBoundary(dir("repo", "inner", "sub"))).toBe(dir("repo"));
    expect(repositoryBoundary(dir("plain"))).toBe(dir("plain"));
  });

  it("from a repository subfolder, a CODEX_HOME elsewhere in the same repository is refused", () => {
    mkdirSync(dir("repo", ".git"), { recursive: true });
    const env = { HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: dir("repo", "other", ".codex") };
    expect(checkCodexHome(env, dir("repo", "sub"))).toMatchObject({ ok: false, reason: { code: "untrusted-codex-home", detail: expect.stringMatching(/inside the project/) } });
  });

  it("a store override inside the repository is refused, even from a subfolder", () => {
    mkdirSync(dir("repo", ".git"), { recursive: true });
    const store = dir("repo", "store");
    expect(checkExecLocation(dir("repo", "store", "x"), store, { HOME: dir("home") }, repositoryBoundary(dir("repo", "sub")))).toEqual({ ok: false, detail: expect.stringMatching(/inside the repository/) });
  });

  it("above a store anchor outside home, a folder holding .git is refused", () => {
    mkdirSync(dir("outer", ".git"), { recursive: true });
    const store = dir("outer", "store");
    expect(checkExecLocation(dir("outer", "store", "x"), store, { HOME: dir("home") }, dir("project"))).toEqual({ ok: false, detail: expect.stringMatching(/outer holds \.git/) });
  });

  it("a CODEX_HOME through a link inside the project is refused, so swapping the link after the check starts nothing", () => {
    const trusted = dir("home", "codex-real");
    symlinkSync(trusted, join(dir("project"), "ch"));
    const env = { HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: join(dir("project"), "ch") };
    expect(checkCodexHome(env, dir("project"))).toMatchObject({ ok: false, reason: { detail: expect.stringMatching(/is a link inside the repository/) } });
  });

  it("a CODEX_HOME through this user's link outside the project passes, and the child is given the canonical path", () => {
    const trusted = dir("home", "codex-real");
    symlinkSync(trusted, join(dir("home"), "ch-link"));
    const env = { HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: join(dir("home"), "ch-link") };
    expect(checkCodexHome(env, dir("project"))).toEqual({ ok: true, codexHome: trusted });
  });
  it("a CODEX_HOME component that cannot be inspected (EIO) is refused, even when the path resolves", () => {
    const trusted = dir("home", "codex-real");
    const env = { HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: trusted };
    expect(checkCodexHome(env, dir("project"))).toEqual({ ok: true, codexHome: trusted });
    trustSeams.lstat = (p) => {
      if (p === dir("home")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      return real.lstat(p);
    };
    expect(checkCodexHome(env, dir("project"))).toEqual({
      ok: false,
      reason: { backend: "codex", code: "untrusted-codex-home", detail: `CODEX_HOME ${trusted}: ${dir("home")} cannot be inspected (EIO)` },
    });
  });

  it("a CODEX_HOME not made yet passes, but a missing folder above it is refused", () => {
    const env = { HOME: dir("home"), TMPDIR: dir("tmp"), CODEX_HOME: join(dir("home"), "not-yet") };
    expect(checkCodexHome(env, dir("project"))).toEqual({ ok: true, codexHome: join(dir("home"), "not-yet") });
    const deeper = { ...env, CODEX_HOME: join(dir("home"), "gone", "codex") };
    expect(checkCodexHome(deeper, dir("project"))).toMatchObject({ ok: false, reason: { detail: `CODEX_HOME ${deeper.CODEX_HOME}: ${join(dir("home"), "gone")} cannot be inspected (ENOENT)` } });
  });
});
