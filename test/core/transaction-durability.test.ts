/**
 * ISS-1399: the CLI transaction's directory barriers, fences, cleanup and
 * commit marker.
 *
 * Two seams record one ordered log while a transaction (or a recovery) runs:
 * - node:fs/promises: open (with its exclusive or truncating flag), each file
 *   handle's writeFile, sync and close, rename and unlink;
 * - durable-dir.js: each directory sync.
 * Paths are logged relative to `.story`, the pid in a temp name as PID. A
 * `before` hook runs ahead of an operation (a throw is that operation
 * failing); an `after` hook runs once it returned or threw. The lock is
 * replaced the way project-lock.test.ts does it: a new lock file, so the
 * holder's ownership check fails from then on.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Hook = (event: string) => void | Promise<void>;
const seam = vi.hoisted(() => ({
  story: null as string | null,
  log: [] as string[],
  before: null as Hook | null,
  after: null as Hook | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { constants } = await import("node:fs");
  const { relative: rel } = await import("node:path");
  const name = (p: unknown): string | null => {
    if (seam.story === null) return null;
    const r = rel(seam.story, String(p));
    if (r.startsWith("..")) return null;
    return (r || ".").replace(`.${process.pid}.tmp`, ".PID.tmp");
  };
  async function around<T>(event: string | null, op: () => Promise<T>): Promise<T> {
    if (event === null) return op();
    seam.log.push(event);
    try {
      await seam.before?.(event);
      return await op();
    } finally {
      await seam.after?.(event);
    }
  }
  const open = (async (path: unknown, flags?: unknown, mode?: unknown) => {
    // Only numeric flags are the transaction's own opens; a directory sync
    // opens with "r" and is logged by the durable-dir seam instead.
    const n = typeof flags === "number" ? name(path) : null;
    const kind = (flags as number) & constants.O_EXCL ? "open:x" : "open:t";
    const handle = await around(n === null ? null : `${kind} ${n}`, () => (actual.open as (...a: unknown[]) => Promise<import("node:fs/promises").FileHandle>)(path, flags, mode));
    if (n === null) return handle;
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === "writeFile") return (data: string, enc?: unknown) => around(`write ${n}`, () => target.writeFile(data, enc as BufferEncoding));
        if (prop === "sync") return () => around(`fsync ${n}`, () => target.sync());
        if (prop === "close") return async () => {
          // The handle is always closed; a failure injected here comes after.
          seam.log.push(`close ${n}`);
          await target.close();
          await seam.before?.(`close ${n}`);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof actual.open;
  const rename = (async (from: unknown, to: unknown) => {
    const a = name(from);
    const b = name(to);
    return around(a === null ? null : `rename ${a}>${b}`, () => actual.rename(from as string, to as string));
  }) as typeof actual.rename;
  const unlink = (async (path: unknown) => {
    const n = name(path);
    return around(n === null ? null : `unlink ${n}`, () => actual.unlink(path as string));
  }) as typeof actual.unlink;
  return { ...actual, default: { ...actual, open, rename, unlink }, open, rename, unlink };
});

vi.mock("../../src/core/durable-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/durable-dir.js")>();
  const { relative: rel } = await import("node:path");
  return {
    ...actual,
    syncDir: async (path: string) => {
      if (seam.story === null) return actual.syncDir(path);
      const event = `sync ${rel(seam.story, path) || "."}`;
      seam.log.push(event);
      try {
        await seam.before?.(event);
        return await actual.syncDir(path);
      } finally {
        await seam.after?.(event);
      }
    },
  };
});

const { initProject } = await import("../../src/core/init.js");
const {
  loadProject,
  runTransactionUnlocked,
  withProjectLock,
  TransactionRecoveryPendingError,
  TransactionCommittedUnconfirmedError,
} = await import("../../src/core/project-loader.js");
const { runWithBoardWriteContext } = await import("../../src/core/board-write-recorder.js");

const roots: string[] = [];
afterEach(() => {
  seam.story = null;
  seam.log = [];
  seam.before = null;
  seam.after = null;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const OLD = '{"old":true}\n';
const NEW = '{"new":true}\n';
const NEW2 = '{"new":2}\n';
const SIDE = ".txn.json.marker.tmp";

interface Fixture {
  root: string;
  story: string;
  w: string;
  w2: string;
  d: string;
  journal: string;
  sidecar: string;
  lock: string;
  temp: (target: string) => string;
}

async function project(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "iss1399-txn-"));
  roots.push(root);
  await initProject(root, { name: "iss1399" });
  const story = join(root, ".story");
  mkdirSync(join(story, "notes"), { recursive: true });
  mkdirSync(join(story, "lessons"), { recursive: true });
  const f: Fixture = {
    root,
    story,
    w: join(story, "notes", "N-901.json"),
    w2: join(story, "notes", "N-902.json"),
    d: join(story, "lessons", "L-901.json"),
    journal: join(story, ".txn.json"),
    sidecar: join(story, SIDE),
    lock: join(story, ".lock"),
    temp: (target) => `${target}.${process.pid}.tmp`,
  };
  writeFileSync(f.w, OLD);
  writeFileSync(f.d, OLD);
  return f;
}

type Op = { op: "write"; target: string; content: string } | { op: "delete"; target: string };

function twoOps(f: Fixture): Op[] {
  return [
    { op: "write", target: f.w, content: NEW },
    { op: "delete", target: f.d },
  ];
}

function twoWrites(f: Fixture): Op[] {
  return [
    { op: "write", target: f.w, content: NEW },
    { op: "write", target: f.w2, content: NEW2 },
  ];
}

/** Runs one transaction under the project lock with the seams recording; returns what it threw. */
async function txn(f: Fixture, ops: Op[], inside?: () => void): Promise<unknown> {
  let caught: unknown = null;
  await withProjectLock(f.root, { strict: false }, async () => {
    inside?.();
    seam.story = f.story;
    try {
      await runTransactionUnlocked(f.root, ops);
    } catch (err) {
      caught = err;
    } finally {
      seam.story = null;
    }
  });
  return caught;
}

/** A new holder takes the lock: a new lock file, so the old handle's check fails. */
function stealLock(f: Fixture): void {
  unlinkSync(f.lock);
  writeFileSync(f.lock, JSON.stringify({ pid: process.pid, token: "new-holder", acquiredAt: Date.now(), processSignature: null }), { mode: 0o600 });
}

/** The new holder goes away, so the next recovery can take the lock. */
function dropStolenLock(f: Fixture): void {
  rmSync(f.lock, { force: true });
}

async function recover(f: Fixture): Promise<void> {
  seam.story = f.story;
  try {
    await loadProject(f.root);
  } finally {
    seam.story = null;
  }
}

function eio(what: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EIO: injected ${what}`), { code: "EIO" });
}

/** Fails the first occurrence of `event` with `err`. */
function failOnce(event: string, err: Error): Hook {
  let done = false;
  return (e) => {
    if (!done && e === event) {
      done = true;
      throw err;
    }
  };
}

const after = (from: string): string[] => seam.log.slice(seam.log.indexOf(from) + 1);
const mutating = (events: string[]): string[] => events.filter((e) => /^(open:[xt]|rename|unlink|write) /.test(e));
const isFence = (err: unknown): boolean => err instanceof Error && /Lock ownership lost/.test(err.message);
const journalOf = (f: Fixture): { commitStarted: boolean } => JSON.parse(readFileSync(f.journal, "utf-8"));

describe("ISS-1399: the commit sequence", () => {
  it("1: journal, temps, marker, renames and removal each reach disk in order", async () => {
    const f = await project();
    expect(await txn(f, twoOps(f))).toBeNull();
    expect(seam.log.filter((e) => !e.startsWith("write ") && !e.startsWith("close "))).toEqual([
      "open:t .txn.json",
      "fsync .txn.json",
      "sync .",
      "open:x notes/N-901.json.PID.tmp",
      "fsync notes/N-901.json.PID.tmp",
      "sync notes",
      `unlink ${SIDE}`,
      `open:x ${SIDE}`,
      `fsync ${SIDE}`,
      `rename ${SIDE}>.txn.json`,
      "sync .",
      "rename notes/N-901.json.PID.tmp>notes/N-901.json",
      "unlink lessons/L-901.json",
      "sync notes",
      "sync lessons",
      "unlink .txn.json",
      "sync .",
    ]);
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    expect(existsSync(f.d)).toBe(false);
    expect(existsSync(f.journal) || existsSync(f.sidecar)).toBe(false);
  });
});

describe("ISS-1399: a lost lock stops the writer before each write", () => {
  it("2a: before the journal, a new holder's journal is untouched", async () => {
    const f = await project();
    const err = await txn(f, twoOps(f), () => {
      stealLock(f);
      writeFileSync(f.journal, "NEW-HOLDER");
    });
    expect(isFence(err)).toBe(true);
    expect(readFileSync(f.journal, "utf-8")).toBe("NEW-HOLDER");
    expect(mutating(seam.log)).toEqual([]);
  });

  it("2b: before temp staging, no temp is created and nothing is removed", async () => {
    const f = await project();
    seam.before = (e) => {
      if (e === "sync .") stealLock(f);
    };
    const err = await txn(f, twoOps(f));
    expect(isFence(err)).toBe(true);
    expect(mutating(after("sync ."))).toEqual([]);
    expect(journalOf(f).commitStarted).toBe(false);
  });

  it("2c: before the stale-sidecar removal, nothing is removed or created", async () => {
    const f = await project();
    seam.before = (e) => {
      if (e === "sync notes") stealLock(f);
    };
    const err = await txn(f, twoOps(f));
    expect(isFence(err)).toBe(true);
    expect(mutating(after("sync notes"))).toEqual([]);
    expect(existsSync(f.temp(f.w))).toBe(true);
  });

  it("2e: between the stale-sidecar removal and the sidecar open, no sidecar is opened and nothing is cleaned up", async () => {
    const f = await project();
    seam.after = (e) => {
      if (e === `unlink ${SIDE}`) stealLock(f);
    };
    const err = await txn(f, twoOps(f));
    expect(isFence(err)).toBe(true);
    expect(mutating(after(`unlink ${SIDE}`))).toEqual([]);
    expect(existsSync(f.temp(f.w))).toBe(true);
    expect(journalOf(f).commitStarted).toBe(false);
  });

  it("2d: before the sidecar rename, the journal still says commitStarted false", async () => {
    const f = await project();
    seam.before = (e) => {
      if (e === `fsync ${SIDE}`) stealLock(f);
    };
    const err = await txn(f, twoOps(f));
    expect(isFence(err)).toBe(true);
    expect(mutating(after(`fsync ${SIDE}`))).toEqual([]);
    expect(journalOf(f).commitStarted).toBe(false);
  });
});

describe("ISS-1399: cleanup before the marker", () => {
  it("3: a lock lost during cleanup stops it; what is left stays", async () => {
    const f = await project();
    seam.before = failOnce("sync notes", eio("temp-directory sync"));
    seam.after = (e) => {
      if (e === "unlink notes/N-901.json.PID.tmp") stealLock(f);
    };
    const err = await txn(f, twoWrites(f));
    expect(isFence(err)).toBe(true);
    expect(existsSync(f.temp(f.w))).toBe(false);
    expect(existsSync(f.temp(f.w2))).toBe(true);
    expect(existsSync(f.journal)).toBe(true);
  });

  it("4a: the temps are removed and their directory synced before the journal goes", async () => {
    const f = await project();
    seam.before = failOnce("open:x notes/N-902.json.PID.tmp", Object.assign(new Error("EACCES: injected"), { code: "EACCES" }));
    const err = await txn(f, twoWrites(f));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransactionRecoveryPendingError);
    expect(after("open:x notes/N-902.json.PID.tmp").filter((e) => !e.startsWith("close "))).toEqual([
      "unlink notes/N-901.json.PID.tmp",
      "sync notes",
      "unlink .txn.json",
      "sync .",
    ]);
    expect(existsSync(f.journal)).toBe(false);
    expect(readFileSync(f.w, "utf-8")).toBe(OLD);
  });

  it("4b: a failed cleanup barrier keeps the journal, and recovery finishes the cleanup", async () => {
    const f = await project();
    const failOpen = failOnce("open:x notes/N-902.json.PID.tmp", Object.assign(new Error("EACCES: injected"), { code: "EACCES" }));
    const failSync = failOnce("sync notes", eio("cleanup sync"));
    seam.before = async (e) => {
      failOpen(e);
      failSync(e);
    };
    const err = await txn(f, twoWrites(f));
    expect((err as Error).message).toMatch(/cleanup is pending/);
    expect(existsSync(f.journal)).toBe(true);
    seam.before = null;
    await recover(f);
    expect(existsSync(f.journal)).toBe(false);
    expect(existsSync(f.temp(f.w))).toBe(false);
    expect(readFileSync(f.w, "utf-8")).toBe(OLD);
  });

  it("5: a temp that cannot be removed keeps the journal, and recovery removes both", async () => {
    const f = await project();
    const failOpen = failOnce("open:x notes/N-902.json.PID.tmp", Object.assign(new Error("EACCES: injected"), { code: "EACCES" }));
    const failUnlink = failOnce("unlink notes/N-901.json.PID.tmp", Object.assign(new Error("EACCES: injected unlink"), { code: "EACCES" }));
    seam.before = (e) => {
      failOpen(e);
      failUnlink(e);
    };
    const err = await txn(f, twoWrites(f));
    expect((err as Error).message).toMatch(/cleanup is pending/);
    expect((err as Error).message).toContain(f.temp(f.w));
    expect(existsSync(f.temp(f.w))).toBe(true);
    expect(existsSync(f.journal)).toBe(true);
    seam.before = null;
    await recover(f);
    expect(existsSync(f.temp(f.w))).toBe(false);
    expect(existsSync(f.journal)).toBe(false);
  });

  it.each([
    ["16a", "write"],
    ["16b", "fsync"],
    ["16c", "close"],
  ])("%s: a temp whose %s fails is still removed, and nothing is left", async (_id, step) => {
    const f = await project();
    seam.before = failOnce(`${step} notes/N-901.json.PID.tmp`, eio(`temp ${step}`));
    const err = await txn(f, twoOps(f));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransactionRecoveryPendingError);
    expect(existsSync(f.temp(f.w))).toBe(false);
    expect(existsSync(f.journal)).toBe(false);
    expect(readFileSync(f.w, "utf-8")).toBe(OLD);
    expect(existsSync(f.d)).toBe(true);
  });

  it("16d: a temp name that already exists is neither written nor removed", async () => {
    const f = await project();
    writeFileSync(f.temp(f.w), "SOMEONE ELSE");
    const err = await txn(f, twoOps(f));
    expect(err).toBeInstanceOf(Error);
    expect(readFileSync(f.temp(f.w), "utf-8")).toBe("SOMEONE ELSE");
    expect(readFileSync(f.w, "utf-8")).toBe(OLD);
  });
});

describe("ISS-1399: the commit marker", () => {
  it("6a: a torn sidecar write tears only the sidecar; cleanup leaves nothing and a retry succeeds", async () => {
    const f = await project();
    seam.before = (e) => {
      if (e === `write ${SIDE}`) {
        writeFileSync(f.sidecar, '{\n  "entries": [');
        throw eio("torn marker write");
      }
    };
    const err = await txn(f, twoOps(f));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransactionRecoveryPendingError);
    for (const p of [f.sidecar, f.journal, f.temp(f.w)]) expect(existsSync(p)).toBe(false);
    expect(readFileSync(f.w, "utf-8")).toBe(OLD);
    seam.before = null;
    expect(await txn(f, twoOps(f))).toBeNull();
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    expect(existsSync(f.d)).toBe(false);
  });

  it("6b: a sidecar rename that fails is marker-unconfirmed; recovery rolls it back", async () => {
    const f = await project();
    seam.before = failOnce(`rename ${SIDE}>.txn.json`, eio("marker rename"));
    const err = await txn(f, twoOps(f));
    expect(err).toBeInstanceOf(TransactionRecoveryPendingError);
    expect((err as InstanceType<typeof TransactionRecoveryPendingError>).phase).toBe("marker-unconfirmed");
    expect((err as Error).message).toMatch(/may or may not have been applied/);
    expect(journalOf(f).commitStarted).toBe(false);
    seam.before = null;
    await recover(f);
    expect(readFileSync(f.w, "utf-8")).toBe(OLD);
    expect(readFileSync(f.d, "utf-8")).toBe(OLD);
    for (const p of [f.sidecar, f.journal, f.temp(f.w)]) expect(existsSync(p)).toBe(false);
  });

  it("6c: a sidecar rename that took effect and then failed is marker-unconfirmed; recovery finishes it", async () => {
    const f = await project();
    seam.before = (e) => {
      if (e === `rename ${SIDE}>.txn.json`) {
        seam.before = null;
        renameSync(f.sidecar, f.journal);
        throw eio("marker rename reported after it happened");
      }
    };
    const err = await txn(f, twoOps(f));
    expect(err).toBeInstanceOf(TransactionRecoveryPendingError);
    expect((err as InstanceType<typeof TransactionRecoveryPendingError>).phase).toBe("marker-unconfirmed");
    expect(journalOf(f).commitStarted).toBe(true);
    seam.log = [];
    await recover(f);
    // The marker's rename is made durable before any target changes.
    const firstTargetChange = seam.log.findIndex((e) => /^(rename|unlink) (notes|lessons)\//.test(e));
    expect(firstTargetChange).toBeGreaterThan(-1);
    expect(seam.log.slice(0, firstTargetChange)).toContain("sync .");
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    expect(existsSync(f.d)).toBe(false);
    for (const p of [f.sidecar, f.journal, f.temp(f.w)]) expect(existsSync(p)).toBe(false);
  });

  it("9: a sidecar left by a crashed run does not block the next transaction", async () => {
    const f = await project();
    writeFileSync(f.sidecar, "stale");
    expect(await txn(f, twoOps(f))).toBeNull();
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    expect(existsSync(f.sidecar)).toBe(false);
  });
});

describe("ISS-1399: after the marker", () => {
  it("7: a failed .story sync after the journal removal is applied-but-unconfirmed, never recovery pending", async () => {
    const f = await project();
    let removed = false;
    seam.before = (e) => {
      if (e === "unlink .txn.json") removed = true;
      else if (removed && e === "sync .") throw eio("post-removal sync");
    };
    let caught: unknown = null;
    const { context } = await runWithBoardWriteContext("test", false, async () => {
      caught = await txn(f, twoOps(f));
    });
    expect(caught).toBeInstanceOf(TransactionCommittedUnconfirmedError);
    expect(caught).not.toBeInstanceOf(TransactionRecoveryPendingError);
    expect((caught as Error).message).toMatch(/Transaction applied/);
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    expect(existsSync(f.d)).toBe(false);
    expect(existsSync(f.journal)).toBe(false);
    expect([...context.targets.entries()]).toEqual([[f.w, "write"], [f.d, "delete"]]);
  });

  it("8 and 10: a failed target-directory sync keeps the journal; recovery syncs every target's directory before removing it", async () => {
    const f = await project();
    seam.before = failOnce("sync lessons", eio("target-directory sync"));
    const err = await txn(f, twoOps(f));
    expect(err).toBeInstanceOf(TransactionRecoveryPendingError);
    expect((err as InstanceType<typeof TransactionRecoveryPendingError>).phase).toBe("committed");
    expect(existsSync(f.journal)).toBe(true);
    seam.before = null;
    seam.log = [];
    await recover(f);
    // The write's temp is gone and the delete finds ENOENT: nothing changes in
    // this run. The marker is synced first, and every target's directory is
    // still synced.
    expect(seam.log.filter((e) => /^(sync |unlink \.txn\.json$)/.test(e))).toEqual([
      "sync .",
      "sync notes",
      "sync lessons",
      "unlink .txn.json",
      "sync .",
    ]);
    expect(existsSync(f.journal)).toBe(false);
  });

  it("12: a lock lost right before the journal removal reports success and keeps the journal; the next recovery changes no target", async () => {
    const f = await project();
    // The journal removal's fence runs before its unlink, so the lock goes
    // right after the last barrier ahead of it.
    seam.after = (e) => {
      if (e === "sync lessons") stealLock(f);
    };
    expect(await txn(f, twoOps(f))).toBeNull();
    expect(existsSync(f.journal)).toBe(true);
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    dropStolenLock(f);
    seam.after = null;
    await recover(f);
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    expect(existsSync(f.d)).toBe(false);
    expect(existsSync(f.journal)).toBe(false);
  });
});

describe("ISS-1399: recovery", () => {
  function plantJournal(f: Fixture, commitStarted: boolean, entries: Array<{ op: "write" | "delete"; target: string; tempPath?: string }>): void {
    writeFileSync(f.journal, JSON.stringify({ entries, commitStarted }, null, 2));
  }

  it("11: a rollback removes the temps and syncs every temp's directory before removing the journal", async () => {
    const f = await project();
    const present = `${f.w}.4242.tmp`;
    const gone = `${f.d}.4242.tmp`;
    writeFileSync(present, NEW);
    plantJournal(f, false, [
      { op: "write", target: f.w, tempPath: present },
      { op: "write", target: f.d, tempPath: gone },
    ]);
    await recover(f);
    expect(seam.log.filter((e) => /^(sync |unlink )/.test(e))).toEqual([
      `unlink ${SIDE}`,
      "unlink notes/N-901.json.4242.tmp",
      "sync notes",
      "sync lessons",
      "unlink .txn.json",
      "sync .",
    ]);
    expect(existsSync(present)).toBe(false);
    expect(existsSync(f.journal)).toBe(false);
  });

  it("11b: a failed temp-directory sync in a rollback keeps the journal", async () => {
    const f = await project();
    const present = `${f.w}.4242.tmp`;
    writeFileSync(present, NEW);
    plantJournal(f, false, [{ op: "write", target: f.w, tempPath: present }]);
    seam.before = failOnce("sync notes", eio("rollback sync"));
    await expect(recover(f)).rejects.toThrow(/temp directories; journal preserved/);
    expect(existsSync(f.journal)).toBe(true);
  });

  it("14: a failed commit-marker barrier before a forward replay changes nothing and keeps the journal and temps", async () => {
    const f = await project();
    const present = `${f.w}.4242.tmp`;
    writeFileSync(present, NEW);
    plantJournal(f, true, [
      { op: "write", target: f.w, tempPath: present },
      { op: "delete", target: f.d },
    ]);
    seam.before = failOnce("sync .", eio("commit marker sync"));
    await expect(recover(f)).rejects.toThrow(/the commit marker; journal preserved/);
    expect(readFileSync(f.w, "utf-8")).toBe(OLD);
    expect(readFileSync(f.d, "utf-8")).toBe(OLD);
    expect(readFileSync(present, "utf-8")).toBe(NEW);
    expect(journalOf(f).commitStarted).toBe(true);
    seam.before = null;
    await recover(f);
    expect(readFileSync(f.w, "utf-8")).toBe(NEW);
    for (const p of [f.d, present, f.journal]) expect(existsSync(p)).toBe(false);
  });

  it("13: a sidecar beside a journal is removed by recovery; one with no journal is left for the next transaction", async () => {
    const f = await project();
    plantJournal(f, false, []);
    writeFileSync(f.sidecar, "half a marker");
    await recover(f);
    expect(existsSync(f.sidecar)).toBe(false);
    expect(existsSync(f.journal)).toBe(false);

    writeFileSync(f.sidecar, "half a marker");
    seam.log = [];
    await recover(f);
    expect(existsSync(f.sidecar)).toBe(true);
    expect(seam.log.filter((e) => e.startsWith("unlink "))).toEqual([]);
  });
});
