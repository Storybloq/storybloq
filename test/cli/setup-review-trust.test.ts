/**
 * ISS-1457: a setup reviewer runs only in a folder this user alone controls,
 * with no project configuration in reach, and codex only with a CODEX_HOME
 * nobody else could have planted. Real directories under the scratch root;
 * the uid seam stands in for another user.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, realpathSync, symlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { checkCodexHome, checkExecLocation, checkHome, trustSeams } from "../../src/core/setup-review-trust.js";
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
    expect(checkExecLocation(exec, store, { HOME: home })).toEqual({ ok: true });
  });

  it("an override outside home, under root's and sticky ancestors, is trusted", () => {
    const store = dir("override");
    const exec = dir("override", ".probe-x");
    expect(checkExecLocation(exec, store, { HOME: dir("home") })).toEqual({ ok: true });
  });

  it("an override under an ancestor writable by others is refused", () => {
    const open = dir("open");
    const store = dir("open", "store");
    chmodSync(open, 0o777);
    expect(checkExecLocation(dir("open", "store", "x"), store, { HOME: dir("home") })).toEqual({ ok: false, detail: expect.stringMatching(/review store: .*open is writable by other users/) });
  });

  it("an override under an ancestor another user owns is refused", () => {
    const theirs = dir("theirs");
    const store = dir("theirs", "store");
    trustSeams.stat = (p) => (p === theirs ? ({ ...real.stat(p), uid: 4242 } as Stats) : real.stat(p));
    expect(checkExecLocation(dir("theirs", "store", "x"), store, { HOME: dir("home") })).toEqual({ ok: false, detail: expect.stringMatching(/theirs is owned by another user/) });
  });

  it("a store folder another user owns, or one writable by others, is refused", () => {
    const store = dir("store");
    const exec = dir("store", "x");
    foreign(store);
    expect(checkExecLocation(exec, store, { HOME: dir("home") })).toMatchObject({ ok: false, detail: expect.stringMatching(/store is not owned by this user/) });
    Object.assign(trustSeams, real);
    chmodSync(exec, 0o777);
    expect(checkExecLocation(exec, store, { HOME: dir("home") })).toMatchObject({ ok: false, detail: expect.stringMatching(/x is writable by other users/) });
  });

  it("a link at or below the anchor is refused", () => {
    const store = dir("store");
    const elsewhere = dir("store", "elsewhere");
    symlinkSync(elsewhere, join(store, "link"));
    expect(checkExecLocation(join(store, "link"), store, { HOME: dir("home") })).toMatchObject({ ok: false, detail: expect.stringMatching(/goes through a link/) });
  });

  it("a root-owned link above the anchor, as /tmp on macOS, is allowed", () => {
    const store = dir("store");
    const viaTmp = store.replace(/^\/private\/tmp\//, "/tmp/");
    if (viaTmp === store || lstatSync("/tmp").uid !== 0) return;
    expect(checkExecLocation(join(viaTmp), viaTmp, { HOME: dir("home") })).toEqual({ ok: true });
  });

  it.each([".git", ".codex"])("a folder on the way down holding %s is refused, so codex finds no project config", (entry) => {
    const store = dir("store");
    dir("store", "a", entry);
    expect(checkExecLocation(dir("store", "a", "b"), store, { HOME: dir("home") })).toMatchObject({ ok: false, detail: expect.stringMatching(new RegExp(`holds \\${entry}`)) });
  });

  it("home's own .codex is not a project config source", () => {
    const home = dir("home");
    dir("home", ".codex");
    const store = dir("home", "state", "setup-review");
    expect(checkExecLocation(dir("home", "state", "setup-review", "x"), store, { HOME: home })).toEqual({ ok: true });
  });

  it("a path that resolves outside the store is refused", () => {
    const store = dir("store");
    expect(checkExecLocation(dir("other"), store, { HOME: dir("home") })).toMatchObject({ ok: false, detail: expect.stringMatching(/outside the review store/) });
  });
});

describe("which CODEX_HOME codex may start with", () => {
  it("one inside the project is refused", () => {
    const project = dir("project");
    expect(checkCodexHome({ HOME: dir("home"), CODEX_HOME: dir("project", ".codex") }, project)).toMatchObject({ code: "untrusted-codex-home", detail: expect.stringMatching(/inside the project/) });
  });

  it("home inside the project puts the default CODEX_HOME there too, and it is refused", () => {
    const project = dir("project");
    expect(checkCodexHome({ HOME: project }, project)).toMatchObject({ code: "untrusted-codex-home" });
  });

  it("one inside TMPDIR is refused", () => {
    const tmp = dir("tmp");
    expect(checkCodexHome({ HOME: dir("home"), TMPDIR: tmp, CODEX_HOME: dir("tmp", "codex") }, dir("project"))).toMatchObject({ detail: expect.stringMatching(/inside TMPDIR/) });
  });

  it("one another user owns, or under an ancestor writable by others, is refused", () => {
    const codexHome = dir("ch");
    foreign(codexHome);
    expect(checkCodexHome({ HOME: dir("home"), CODEX_HOME: codexHome }, dir("project"))).toMatchObject({ code: "untrusted-codex-home" });
    Object.assign(trustSeams, real);
    const open = dir("open");
    chmodSync(open, 0o777);
    expect(checkCodexHome({ HOME: dir("home"), CODEX_HOME: dir("open", "ch") }, dir("project"))).toMatchObject({ detail: expect.stringMatching(/open is writable by other users/) });
  });

  it("the default under a private home, existing or not yet made, is trusted", () => {
    const home = dir("home");
    expect(checkCodexHome({ HOME: home }, dir("project"))).toBeNull();
    dir("home", ".codex");
    expect(checkCodexHome({ HOME: home }, dir("project"))).toBeNull();
  });
});
