/**
 * ISS-1499 slice B, commit 3: `storybloq handover continue` (plan section 5,
 * acceptance B3 except its reader and create steps, which land with those
 * commits). Each numbered rule in order, every refusal writing nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { initProject } from "../../../src/core/init.js";
import { isolateEnv, runCli, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";

// A passthrough of node:fs whose lstat or unlink fails with EACCES for one
// chosen path, so "cannot be inspected" and "cannot be removed" are tested
// as any user, including root.
const denied = vi.hoisted(() => ({ lstat: null as string | null, unlink: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const eacces = (op: string, p: string) => Object.assign(new Error(`EACCES: permission denied, ${op} '${p}'`), { code: "EACCES" });
  const lstatSync = ((p: unknown, ...rest: unknown[]) => {
    if (denied.lstat !== null && String(p) === denied.lstat) throw eacces("lstat", denied.lstat);
    return (real.lstatSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.lstatSync;
  const unlinkSync = ((p: unknown) => {
    if (denied.unlink !== null && String(p) === denied.unlink) throw eacces("unlink", denied.unlink);
    return real.unlinkSync(p as string);
  }) as typeof real.unlinkSync;
  const m = { ...real, lstatSync, unlinkSync };
  return { ...m, default: m };
});

const { memoFileName, resolveLineMemo, serializeLineMemo, PICKUP_PROMPT } = await import("../../../src/core/handover-line-memo.js");
const { TailReader } = await import("../../../src/core/handover-selection.js");

const TASK = "task-a.1";
const OTHER = "task-b.2";

let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); });
afterEach(() => {
  denied.lstat = null;
  denied.unlink = null;
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

const linked = (attrs: string): string => `# Handover\n\nwork\n\n<!-- storybloq-lineage v1${attrs ? " " + attrs : ""} -->\n`;
const plain = "# Handover\n\nwork\n";

interface Proj { root: string; hdir: string; mdir: string }
async function project(seed: (hdir: string) => void): Promise<Proj> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "continue" });
  const hdir = join(root, ".story", "handovers");
  seed(hdir);
  return { root, hdir, mdir: join(root, ".story", "telemetry", "handover-lines") };
}
const put = (hdir: string, name: string, body: string): void => writeFileSync(join(hdir, name), body);

interface Run { exit: number; md: string; json: { data?: unknown; error?: { code: string; message: string } } }
async function cont(root: string, args: readonly string[]): Promise<Run> {
  const md = await runCli(root, ["handover", "continue", ...args]);
  const js = await runCli(root, ["handover", "continue", ...args, "--format", "json"]);
  expect(js.exitCode ?? 0).toBe(md.exitCode ?? 0);
  return { exit: md.exitCode ?? 0, md: md.stdout, json: JSON.parse(js.stdout) };
}
/** One run only, for rules whose first run changes state. */
async function contJson(root: string, args: readonly string[]): Promise<Run> {
  const js = await runCli(root, ["handover", "continue", ...args, "--format", "json"]);
  return { exit: js.exitCode ?? 0, md: "", json: JSON.parse(js.stdout) };
}

const memoPath = (p: Proj, task = TASK): string => join(p.mdir, memoFileName(task));
function seedMemo(p: Proj, tip: string | null, task = TASK): void {
  mkdirSync(p.mdir, { recursive: true });
  writeFileSync(memoPath(p, task), serializeLineMemo({ v: 1, task, tip, writing: null }));
}
const memoTip = (p: Proj, task = TASK): string | null => (JSON.parse(readFileSync(memoPath(p, task), "utf8")) as { tip: string | null }).tip;
function resolved(p: Proj, task = TASK): unknown {
  const names = readdirSync(p.hdir).filter((n) => n.endsWith(".md")).sort().reverse();
  return resolveLineMemo(p.root, task, new TailReader(p.hdir, names));
}
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

/** A tip with an older unlinked ancestor: U (default head) <- L1 <- L2. */
const chain = (h: string): void => {
  put(h, "2026-11-10-01-u.md", plain);
  put(h, "2026-11-11-01-l1.md", linked('continues="2026-11-10-01-u.md" role="worker" by="w@x.y"'));
  put(h, "2026-11-12-01-l2.md", linked('continues="2026-11-11-01-l1.md" role="worker" by="w@x.y"'));
};

describe("rule 1: exactly one of a file and --default", () => {
  it("neither, or both, is invalid_input and writes nothing", async () => {
    const p = await project(chain);
    for (const args of [["--as", TASK], ["2026-11-12-01-l2.md", "--default", "--as", TASK]]) {
      const r = await cont(p.root, args);
      expect(r.exit).toBe(1);
      expect(r.json.error?.code).toBe("invalid_input");
    }
    expect(existsSync(p.mdir)).toBe(false);
  });
});

describe("rule 2: identity", () => {
  it("an invalid --as is invalid_input, even with an identity in the environment", async () => {
    const p = await project(chain);
    process.env.CLAUDE_CODE_SESSION_ID = TASK;
    const r = await cont(p.root, ["2026-11-12-01-l2.md", "--as", "bad id!"]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("invalid_input");
    expect(existsSync(p.mdir)).toBe(false);
  });

  it("no identity resolved is no_identity, naming --as", async () => {
    const p = await project(chain);
    const r = await cont(p.root, ["2026-11-12-01-l2.md"]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("no_identity");
    expect(r.json.error?.message).toContain("--as");
    expect(existsSync(p.mdir)).toBe(false);
  });

  it("the environment's identity is used when --as is absent", async () => {
    const p = await project(chain);
    process.env.CLAUDE_CODE_SESSION_ID = TASK;
    const r = await contJson(p.root, ["2026-11-12-01-l2.md"]);
    expect(r.exit).toBe(0);
    expect(memoTip(p)).toBe("2026-11-12-01-l2.md");
  });
});

describe("rule 4: --default", () => {
  it("no memo folder: absent, the default head reported, nothing created", async () => {
    const p = await project(chain);
    const r = await cont(p.root, ["--default", "--as", TASK]);
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual({ action: "default", memo: "absent", head: "2026-11-10-01-u.md" });
    expect(r.md).toBe("No line memo was set; this session is on the default line. Default head: 2026-11-10-01-u.md.\n");
    expect(existsSync(p.mdir)).toBe(false);
  });

  it("a folder with no memo file: absent; the default line with no handover is said", async () => {
    const p = await project((h) => put(h, "2026-11-11-01-l.md", linked('role="pen"')));
    mkdirSync(p.mdir, { recursive: true });
    const r = await cont(p.root, ["--default", "--as", TASK]);
    expect(r.json.data).toEqual({ action: "default", memo: "absent", head: null });
    expect(r.md).toBe("No line memo was set; this session is on the default line. The default line has no handover yet.\n");
  });

  it("a memo: removed", async () => {
    const p = await project(chain);
    seedMemo(p, "2026-11-12-01-l2.md");
    const r = await contJson(p.root, ["--default", "--as", TASK]);
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual({ action: "default", memo: "removed", head: "2026-11-10-01-u.md" });
    expect(existsSync(memoPath(p))).toBe(false);
  });

  it("a directory in the memo's place: io_error naming the memo, the directory kept", async () => {
    const p = await project(chain);
    mkdirSync(memoPath(p), { recursive: true });
    const r = await cont(p.root, ["--default", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("io_error");
    expect(r.json.error?.message).toContain(memoFileName(TASK));
    expect(r.json.error?.message).toContain("still on its previous line");
    expect(statSync(memoPath(p)).isDirectory()).toBe(true);
  });

  it("an injected EACCES on the removal: io_error, and the memo is active afterwards", async () => {
    const p = await project(chain);
    seedMemo(p, "2026-11-12-01-l2.md");
    denied.unlink = memoPath(p);
    const r = await cont(p.root, ["--default", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("io_error");
    denied.unlink = null;
    expect(resolved(p)).toEqual({ kind: "active", tip: "2026-11-12-01-l2.md" });
  });

  it("an injected EACCES on lstat of the memo itself: io_error, never reported absent", async () => {
    const p = await project(chain);
    seedMemo(p, "2026-11-12-01-l2.md");
    denied.lstat = memoPath(p);
    const r = await cont(p.root, ["--default", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("io_error");
    denied.lstat = null;
    expect(resolved(p)).toEqual({ kind: "active", tip: "2026-11-12-01-l2.md" });
  });

  it("a symlinked handover-lines folder: io_error (unsafe), nothing removed through it", async () => {
    const p = await project(chain);
    const elsewhere = join(env.base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, memoFileName(TASK)), serializeLineMemo({ v: 1, task: TASK, tip: "2026-11-12-01-l2.md", writing: null }));
    mkdirSync(join(p.root, ".story", "telemetry"), { recursive: true });
    symlinkSync(elsewhere, p.mdir);
    const r = await cont(p.root, ["--default", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("io_error");
    expect(existsSync(join(elsewhere, memoFileName(TASK)))).toBe(true);
  });

  it("an injected EACCES on lstat of the folder: io_error, and the memo is active afterwards", async () => {
    const p = await project(chain);
    seedMemo(p, "2026-11-12-01-l2.md");
    denied.lstat = p.mdir;
    const r = await cont(p.root, ["--default", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("io_error");
    denied.lstat = null;
    expect(resolved(p)).toEqual({ kind: "active", tip: "2026-11-12-01-l2.md" });
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("a folder whose inspection fails by permission: io_error, and the memo is active afterwards", async () => {
    const p = await project(chain);
    seedMemo(p, "2026-11-12-01-l2.md");
    const tele = join(p.root, ".story", "telemetry");
    chmodSync(tele, 0o000);
    try {
      const r = await contJson(p.root, ["--default", "--as", TASK]);
      expect(r.exit).toBe(1);
      expect(r.json.error?.code).toBe("io_error");
    } finally {
      chmodSync(tele, 0o755);
    }
    expect(resolved(p)).toEqual({ kind: "active", tip: "2026-11-12-01-l2.md" });
  });
});

describe("rule 5: the target", () => {
  it("a value that is not a handover file name is invalid_input", async () => {
    const p = await project(chain);
    for (const bad of ["notes.txt", "../2026-11-12-01-l2.md"]) {
      const r = await contJson(p.root, [bad, "--as", TASK]);
      expect(r.json.error?.code, bad).toBe("invalid_input");
    }
    expect(existsSync(p.mdir)).toBe(false);
  });

  it("a name not in the folder is not_found, with or without --fork", async () => {
    const p = await project(chain);
    for (const extra of [[], ["--fork"]]) {
      const r = await contJson(p.root, ["2026-11-13-01-gone.md", "--as", TASK, ...extra]);
      expect(r.json.error?.code).toBe("not_found");
    }
    expect(existsSync(p.mdir)).toBe(false);
  });

  it("a directory and a symlink as target are invalid_input, and --fork never overrides it", async () => {
    const p = await project((h) => {
      chain(h);
      mkdirSync(join(h, "2026-11-13-01-dir.md"));
      symlinkSync("2026-11-12-01-l2.md", join(h, "2026-11-13-02-link.md"));
    });
    for (const target of ["2026-11-13-01-dir.md", "2026-11-13-02-link.md"]) {
      for (const extra of [[], ["--fork"]]) {
        const r = await contJson(p.root, [target, "--as", TASK, ...extra]);
        expect(r.json.error?.code, `${target} ${extra.join(" ")}`).toBe("invalid_input");
      }
    }
    expect(existsSync(p.mdir)).toBe(false);
  });
});

describe("rule 6: the default head", () => {
  it("naming the default head removes the memo, ahead of an incomplete scan and the tip check", async () => {
    const p = await project((h) => {
      put(h, "2026-11-10-01-u0.md", plain);
      put(h, "2026-11-10-02-u.md", plain);
      put(h, "2026-11-11-01-l1.md", linked('continues="2026-11-10-02-u.md"'));
      mkdirSync(join(h, "2026-11-09-01-dir.md"));
    });
    seedMemo(p, "2026-11-11-01-l1.md");
    const r = await contJson(p.root, ["2026-11-10-02-u.md", "--as", TASK]);
    expect(r.exit).toBe(0);
    expect(r.json.data).toEqual({ action: "default", memo: "removed", head: "2026-11-10-02-u.md" });
    expect(existsSync(memoPath(p))).toBe(false);
  });

  it("naming the default head with a memo that cannot be removed is io_error", async () => {
    const p = await project(chain);
    seedMemo(p, "2026-11-12-01-l2.md");
    denied.unlink = memoPath(p);
    const r = await contJson(p.root, ["2026-11-10-01-u.md", "--as", TASK]);
    expect(r.json.error?.code).toBe("io_error");
    denied.unlink = null;
    expect(memoTip(p)).toBe("2026-11-12-01-l2.md");
  });
});

describe("rule 7: an incomplete scan", () => {
  it("refuses scan_incomplete with the unread names and count; --fork overrides", async () => {
    const p = await project((h) => {
      chain(h);
      mkdirSync(join(h, "2026-11-13-01-dir.md"));
      mkdirSync(join(h, "2026-11-13-02-dir.md"));
    });
    const r = await cont(p.root, ["2026-11-12-01-l2.md", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("scan_incomplete");
    expect(r.json.error?.message).toContain("2 handover(s) could not be read");
    expect(r.json.error?.message).toContain("2026-11-13-02-dir.md, 2026-11-13-01-dir.md");
    expect(existsSync(p.mdir)).toBe(false);
    const f = await contJson(p.root, ["2026-11-12-01-l2.md", "--as", TASK, "--fork"]);
    expect(f.exit).toBe(0);
    expect(memoTip(p)).toBe("2026-11-12-01-l2.md");
  });

  it("lists at most ten unread names and says how many more", async () => {
    const p = await project((h) => {
      chain(h);
      for (let i = 10; i < 22; i++) mkdirSync(join(h, `2026-11-13-${i}-dir.md`));
    });
    const r = await contJson(p.root, ["2026-11-12-01-l2.md", "--as", TASK]);
    expect(r.json.error?.code).toBe("scan_incomplete");
    expect(r.json.error?.message).toContain("12 handover(s) could not be read");
    expect(r.json.error?.message).toContain("and 2 more");
    expect(r.json.error?.message).not.toContain("2026-11-13-11-dir.md");
  });
});

describe("rule 8: the tip check", () => {
  it("a linked non-tip lists its descendant open tips; --fork overrides", async () => {
    const p = await project((h) => {
      chain(h);
      put(h, "2026-11-13-01-l3.md", linked('continues="2026-11-11-01-l1.md" role="qa"'));
    });
    const r = await cont(p.root, ["2026-11-11-01-l1.md", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("not_a_tip");
    expect(r.json.error?.message).toContain("its open tips: 2026-11-13-01-l3.md, 2026-11-12-01-l2.md");
    expect(existsSync(p.mdir)).toBe(false);
    const f = await contJson(p.root, ["2026-11-11-01-l1.md", "--as", TASK, "--fork"]);
    expect(f.exit).toBe(0);
    expect(memoTip(p)).toBe("2026-11-11-01-l1.md");
  });

  it("the descendant tips are found through several generations, absorbed tips excluded", async () => {
    const p = await project((h) => {
      chain(h);
      put(h, "2026-11-13-01-l3.md", linked('continues="2026-11-12-01-l2.md"'));
      put(h, "2026-11-13-02-side.md", linked('continues="2026-11-12-01-l2.md"'));
      put(h, "2026-11-14-01-l4.md", linked('continues="2026-11-13-01-l3.md" absorbs="2026-11-13-02-side.md"'));
    });
    const r = await contJson(p.root, ["2026-11-11-01-l1.md", "--as", TASK]);
    expect(r.json.error?.code).toBe("not_a_tip");
    expect(r.json.error?.message).toContain("its open tips: 2026-11-14-01-l4.md.");
  });

  it("an unlinked handover that is not the default head needs --fork", async () => {
    const p = await project(chain);
    put(p.hdir, "2026-11-09-01-older.md", plain);
    const r = await contJson(p.root, ["2026-11-09-01-older.md", "--as", TASK]);
    expect(r.json.error?.code).toBe("not_a_tip");
    expect(existsSync(p.mdir)).toBe(false);
    const f = await contJson(p.root, ["2026-11-09-01-older.md", "--as", TASK, "--fork"]);
    expect(f.exit).toBe(0);
    expect(memoTip(p)).toBe("2026-11-09-01-older.md");
    expect(f.json.data).toMatchObject({ action: "continue", tip: "2026-11-09-01-older.md", role: null, by: null, length: 1 });
  });
});

describe("rules 9 and 10: the memo and the reply", () => {
  it("writes exactly the memo, and replies with the tip, role, by, length and the pickup advice", async () => {
    const p = await project(chain);
    const r = await contJson(p.root, ["2026-11-12-01-l2.md", "--as", TASK]);
    expect(r.exit).toBe(0);
    expect(readFileSync(memoPath(p), "utf8")).toBe(`{"v":1,"task":"${TASK}","tip":"2026-11-12-01-l2.md","writing":null}\n`);
    expect(r.json.data).toEqual({
      action: "continue", tip: "2026-11-12-01-l2.md", role: "worker", by: "w@x.y", length: 3,
      absorbedBy: [], at: null, atState: "none", commitsSince: null, pickup: PICKUP_PROMPT,
    });
    const md = await runCli(p.root, ["handover", "continue", "2026-11-12-01-l2.md", "--as", TASK]);
    expect(md.stdout).toBe(`Continuing 2026-11-12-01-l2.md (role worker, by w@x.y), a line of 3 handovers.\n\n${PICKUP_PROMPT}\n`);
  });

  it("an absorbed tip says what absorbed it", async () => {
    const p = await project((h) => {
      chain(h);
      put(h, "2026-11-13-01-side.md", linked('role="side"'));
      put(h, "2026-11-14-01-l3.md", linked('continues="2026-11-12-01-l2.md" absorbs="2026-11-13-01-side.md"'));
    });
    const r = await cont(p.root, ["2026-11-13-01-side.md", "--as", TASK]);
    expect(r.json.data).toMatchObject({ tip: "2026-11-13-01-side.md", length: 1, absorbedBy: ["2026-11-14-01-l3.md"] });
    expect(r.md).toContain("Absorbed by 2026-11-14-01-l3.md.");
  });

  it("at against HEAD: commits since in a clone with the commit, not in this clone without it", async () => {
    const p = await project(() => {});
    git(p.root, "init", "-q");
    git(p.root, "config", "user.email", "t@x.y");
    git(p.root, "config", "user.name", "T");
    git(p.root, "commit", "-q", "--allow-empty", "-m", "one");
    const at = git(p.root, "rev-parse", "--short", "HEAD");
    git(p.root, "commit", "-q", "--allow-empty", "-m", "two");
    git(p.root, "commit", "-q", "--allow-empty", "-m", "three");
    put(p.hdir, "2026-11-12-01-a.md", linked(`role="pen" at="${at}"`));
    put(p.hdir, "2026-11-12-02-b.md", linked('role="pen" at="abcdef1234"'));
    const a = await cont(p.root, ["2026-11-12-01-a.md", "--as", TASK]);
    expect(a.json.data).toMatchObject({ at, atState: "counted", commitsSince: 2 });
    expect(a.md).toContain(`Written at ${at}: 2 commits since.`);
    const b = await cont(p.root, ["2026-11-12-02-b.md", "--as", TASK]);
    expect(b.json.data).toMatchObject({ at: "abcdef1234", atState: "not_in_clone", commitsSince: null });
    expect(b.md).toContain("Written at abcdef1234: that commit is not in this clone.");
  });

  it("a commit that exists but cannot be counted against HEAD is unavailable, never not in this clone", async () => {
    const p = await project(() => {});
    git(p.root, "init", "-q");
    git(p.root, "config", "user.email", "t@x.y");
    git(p.root, "config", "user.name", "T");
    git(p.root, "commit", "-q", "--allow-empty", "-m", "one");
    const at = git(p.root, "rev-parse", "--short", "HEAD");
    // HEAD now names a branch with no commit: the commit resolves, the range does not.
    writeFileSync(join(p.root, ".git", "HEAD"), "ref: refs/heads/unborn\n");
    put(p.hdir, "2026-11-12-01-a.md", linked(`role="pen" at="${at}"`));
    const r = await cont(p.root, ["2026-11-12-01-a.md", "--as", TASK]);
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({ at, atState: "unavailable", commitsSince: null });
    expect(r.md).not.toContain("Written at");
    expect(r.md).not.toContain("not in this clone");
    expect(memoTip(p)).toBe("2026-11-12-01-a.md");
  });

  it("a commit object git cannot read is unavailable, never not in this clone", async () => {
    const p = await project(() => {});
    git(p.root, "init", "-q");
    git(p.root, "config", "user.email", "t@x.y");
    git(p.root, "config", "user.name", "T");
    git(p.root, "commit", "-q", "--allow-empty", "-m", "one");
    const full = git(p.root, "rev-parse", "HEAD");
    const at = full.slice(0, 10);
    // Corrupt the commit's loose object: the presence check fails with 128, not 1.
    const obj = join(p.root, ".git", "objects", full.slice(0, 2), full.slice(2));
    chmodSync(obj, 0o644);
    writeFileSync(obj, "garbage");
    put(p.hdir, "2026-11-12-01-a.md", linked(`role="pen" at="${at}"`));
    const r = await cont(p.root, ["2026-11-12-01-a.md", "--as", TASK]);
    expect(r.exit).toBe(0);
    expect(r.json.data).toMatchObject({ at, atState: "unavailable", commitsSince: null });
    expect(r.md).not.toContain("not in this clone");
  });

  it("outside git, an at is reported as nothing", async () => {
    const p = await project((h) => put(h, "2026-11-12-01-a.md", linked('role="pen" at="abcdef1234"')));
    const r = await cont(p.root, ["2026-11-12-01-a.md", "--as", TASK]);
    expect(r.json.data).toMatchObject({ at: "abcdef1234", atState: "none", commitsSince: null });
    expect(r.md).not.toContain("Written at");
  });

  it("continuing one identity leaves another identity's months-old memo byte for byte intact", async () => {
    const p = await project(chain);
    seedMemo(p, "2026-11-11-01-l1.md", OTHER);
    const old = new Date("2026-08-01T00:00:00Z");
    utimesSync(memoPath(p, OTHER), old, old);
    const before = { bytes: readFileSync(memoPath(p, OTHER)), mtimeMs: statSync(memoPath(p, OTHER)).mtimeMs };
    await contJson(p.root, ["2026-11-12-01-l2.md", "--as", TASK]);
    await contJson(p.root, ["--default", "--as", TASK]);
    expect({ bytes: readFileSync(memoPath(p, OTHER)), mtimeMs: statSync(memoPath(p, OTHER)).mtimeMs }).toEqual(before);
  });

  it("a memo folder that cannot be made is io_error", async () => {
    const p = await project(chain);
    mkdirSync(join(p.root, ".story", "telemetry"), { recursive: true });
    writeFileSync(p.mdir, "a file in the folder's place");
    const r = await contJson(p.root, ["2026-11-12-01-l2.md", "--as", TASK]);
    expect(r.exit).toBe(1);
    expect(r.json.error?.code).toBe("io_error");
    expect(readFileSync(p.mdir, "utf8")).toBe("a file in the folder's place");
  });
});

describe("a refusal leaves the caller's existing memo untouched", () => {
  const cases: readonly [string, (h: string) => void, readonly string[]][] = [
    ["invalid arguments", chain, ["2026-11-12-01-l2.md", "--default"]],
    ["an invalid name", chain, ["notes.txt"]],
    ["a directory target", (h) => { chain(h); mkdirSync(join(h, "2026-11-13-01-dir.md")); }, ["2026-11-13-01-dir.md"]],
    ["scan_incomplete", (h) => { chain(h); mkdirSync(join(h, "2026-11-13-01-dir.md")); }, ["2026-11-12-01-l2.md"]],
    ["not_a_tip", chain, ["2026-11-11-01-l1.md"]],
  ];
  for (const [label, seed, args] of cases) {
    it(label, async () => {
      const p = await project(seed);
      seedMemo(p, "2026-11-10-01-u.md");
      const past = new Date("2026-01-01T00:00:00Z");
      utimesSync(memoPath(p), past, past);
      const snap = () => ({ bytes: readFileSync(memoPath(p)), mtimeMs: statSync(memoPath(p)).mtimeMs, ino: statSync(memoPath(p)).ino });
      const before = snap();
      const r = await cont(p.root, [...args, "--as", TASK]);
      expect(r.exit).toBe(1);
      expect(snap()).toEqual(before);
    });
  }
});
