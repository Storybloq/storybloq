/**
 * ISS-1022: the presence properties that can only be observed by mocking
 * `node:fs` for the whole module.
 *
 * Three of them, grouped here because the mock is module-wide and would break
 * every other filesystem test in the suite:
 *
 *   1. `atomicWriteInDir`'s post-rename identity check, which needs the target
 *      directory swapped DURING the rename;
 *   2. `acquireLock`'s refusal on a persistent `lstat` failure, which is the
 *      branch that would otherwise spin with no sleep at all;
 *   3. the redaction allowlist's early refusals, where the claim is that no
 *      filesystem work happens -- provable only by asserting the calls are
 *      never made, not by timing them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  afterRename: null as (() => void) | null,
  lstatError: null as NodeJS.ErrnoException | null,
  calls: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R) => (...args: A): R => {
    state.calls.push(name);
    return fn(...args);
  };
  return {
    ...actual,
    default: actual,
    realpathSync: track("realpathSync", actual.realpathSync),
    statSync: track("statSync", actual.statSync),
    lstatSync: track("lstatSync", ((path: string) => {
      if (state.lstatError) throw state.lstatError;
      return actual.lstatSync(path);
    }) as typeof actual.lstatSync),
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      actual.renameSync(from, to);
      const hook = state.afterRename;
      state.afterRename = null;
      hook?.();
    },
  };
});

const { mkdirSync, mkdtempSync, rmSync, existsSync, renameSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const { atomicWriteInDir, directoryIdentity, acquireLock, LOCK_ACQUIRE_BUDGET_MS } = await import("../../src/presence/io.js");
const { redactedTarget } = await import("../../src/presence/redaction.js");

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "presence-mocked-"));
  dir = join(root, "presence");
  mkdirSync(dir);
  state.afterRename = null;
  state.lstatError = null;
  state.calls = [];
});

afterEach(() => {
  state.afterRename = null;
  state.lstatError = null;
  rmSync(root, { recursive: true, force: true });
});

describe("atomicWriteInDir post-rename check (ISS-1022)", () => {
  it("writes successfully when the directory is stable", () => {
    expect(atomicWriteInDir(dir, join(dir, "a.json"), "{}")).toBe(true);
    expect(existsSync(join(dir, "a.json"))).toBe(true);
  });

  /**
   * The replacement is created BEFORE the swap and renamed into place, rather
   * than the original being deleted and recreated: an inode can be reused, so
   * delete-and-recreate does not guarantee the two identities differ, and a
   * test that silently stopped distinguishing them would still pass.
   */
  it("reports failure when the directory is swapped during the rename", () => {
    const replacement = join(root, "replacement");
    mkdirSync(replacement);
    expect(directoryIdentity(replacement)!.ino).not.toBe(directoryIdentity(dir)!.ino);

    state.afterRename = () => {
      rmSync(dir, { recursive: true, force: true });
      renameSync(replacement, dir);
    };

    expect(atomicWriteInDir(dir, join(dir, "a.json"), "{}")).toBe(false);
    // The file is gone with the directory it landed in, which is exactly why
    // "it renamed without throwing" is not the same as "the write succeeded".
    expect(existsSync(join(dir, "a.json"))).toBe(false);
  });

  it("the hook is single-shot, so a later stable write still succeeds", () => {
    const replacement = join(root, "replacement");
    mkdirSync(replacement);
    state.afterRename = () => {
      rmSync(dir, { recursive: true, force: true });
      renameSync(replacement, dir);
    };
    expect(atomicWriteInDir(dir, join(dir, "a.json"), "{}")).toBe(false);
    expect(atomicWriteInDir(dir, join(dir, "b.json"), "{}")).toBe(true);
  });
});

describe("acquireLock under a persistent lstat failure (ISS-1022)", () => {
  /**
   * The branch with no sleep in it. Before the rewrite, a `lstat` that kept
   * throwing sent the loop straight back to `mkdir` with no deadline check and
   * no pause, spinning the CPU until the client killed the process at 5s. It
   * must now refuse at once: an EACCES on the lock's parent will not clear
   * inside 150ms, and a dropped presence update is repaired by the next event.
   */
  it("refuses immediately rather than spinning", () => {
    const lockPath = join(dir, "held.lock");
    mkdirSync(lockPath); // so mkdirSync reports EEXIST and the loop reaches lstat
    state.lstatError = Object.assign(new Error("EACCES"), { code: "EACCES" });

    const started = Date.now();
    expect(acquireLock(lockPath)).toBe(false);
    expect(Date.now() - started).toBeLessThan(LOCK_ACQUIRE_BUDGET_MS / 2);
  });
});

describe("redaction refuses before touching the filesystem (ISS-1022)", () => {
  /**
   * The claim is about ORDER, not speed: these values can never be recorded, so
   * they must be rejected before any canonicalization. A wall-clock assertion
   * cannot prove that -- a few dozen failed `lstat` calls finish in under a
   * millisecond on a local disk, and a correct implementation can still blow a
   * timing budget on a loaded CI worker. Asserting the calls were never made is
   * the only form of this test that means anything.
   */
  const FS_CALLS = ["realpathSync", "statSync", "lstatSync"];

  it("makes no filesystem call for a NUL byte or an overlength value", () => {
    state.calls = [];
    expect(redactedTarget(dir, dir, "Read", { file_path: join(dir, "a\0b.ts") })).toBeNull();
    expect(redactedTarget(dir, dir, "Read", { file_path: "/" + "a".repeat(9000) })).toBeNull();
    expect(state.calls.filter((c) => FS_CALLS.includes(c))).toEqual([]);
  });

  it("makes no filesystem call for a tool outside the allowlist", () => {
    state.calls = [];
    expect(redactedTarget(dir, dir, "Bash", { command: "rm -rf /", file_path: join(dir, "a.ts") })).toBeNull();
    expect(redactedTarget(dir, dir, "Read", { not_the_key: join(dir, "a.ts") })).toBeNull();
    expect(state.calls.filter((c) => FS_CALLS.includes(c))).toEqual([]);
  });

  /** The positive control: a value that IS recordable does reach the filesystem. */
  it("does canonicalize a value it can record", () => {
    writeFileSync(join(dir, "real.ts"), "x");
    state.calls = [];
    expect(redactedTarget(dir, dir, "Read", { file_path: join(dir, "real.ts") })).toBe("real.ts");
    expect(state.calls.filter((c) => FS_CALLS.includes(c)).length).toBeGreaterThan(0);
  });
});
