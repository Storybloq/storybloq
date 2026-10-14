/**
 * ISS-1376: the start-time test baseline. The resolver's decision table
 * (R*), the capture's cause classification and process-tree cleanup (C*),
 * and the session schema's optional failure field (S1). Fixtures are small
 * node scripts written to a temp dir; no test waits for real minutes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_MAX_BUFFER,
  DEFAULT_BASELINE_TIMEOUT_MS,
  captureTestBaseline,
  resolveBaselineTimeout,
  type BaselineSpawn,
} from "../../src/autonomous/test-baseline.js";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";
import type { TeardownTimers } from "../../src/core/process-tree.js";

const posix = process.platform !== "win32";
const NODE = JSON.stringify(process.execPath);
/** Every fixture process carries this in its argv, for the final sweep. */
const MARKER = `iss1376-fixture-${process.pid}`;

let dir: string;
const pidFiles: string[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iss1376-"));
});

/** Kill any fixture process a test (or a mutant) left alive, from outside. */
function sweep(): void {
  for (const f of pidFiles.splice(0)) {
    if (!existsSync(f)) continue;
    const pid = Number(readFileSync(f, "utf-8").trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

afterEach(() => sweep());

afterAll(() => {
  sweep();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
/** Write a fixture script; returns its path. */
function script(body: string): string {
  const p = join(dir, `f${n++}.cjs`);
  writeFileSync(p, body);
  return p;
}
/** A command that runs the fixture as the process itself (no shell left in between). */
const execNode = (file: string): string => `exec ${NODE} ${JSON.stringify(file)} ${MARKER}`;
const pidFile = (): string => {
  const p = join(dir, `pid${n++}`);
  pidFiles.push(p);
  return p;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

const SLEEP = "setTimeout(() => {}, 60000);\n";
const IGNORE_TERM = "process.on('SIGTERM', () => {});\n";

describe("ISS-1376 resolveBaselineTimeout: the decision table", () => {
  const st = (t?: unknown, w?: unknown) => ({
    TEST: t === undefined ? { enabled: true } : { enabled: true, testTimeoutMs: t },
    WRITE_TESTS: w === undefined ? { enabled: true } : { enabled: true, testTimeoutMs: w },
  });
  const ms = (r: ReturnType<typeof resolveBaselineTimeout>) => (r.ok ? r.timeoutMs : `refused: ${r.message}`);

  it("R1: every row", () => {
    // TEST only
    expect(ms(resolveBaselineTimeout(st(), true, false))).toBe(DEFAULT_BASELINE_TIMEOUT_MS);
    expect(ms(resolveBaselineTimeout(st(), true, false))).toBe(120000);
    expect(ms(resolveBaselineTimeout(st(2000, 9000), true, false))).toBe(2000);
    // WRITE_TESTS only
    expect(ms(resolveBaselineTimeout(st(), false, true))).toBe(120000);
    expect(ms(resolveBaselineTimeout(st(2000), false, true))).toBe(2000);
    expect(ms(resolveBaselineTimeout(st(undefined, 9000), false, true))).toBe(9000);
    expect(ms(resolveBaselineTimeout(st(2000, 9000), false, true))).toBe(9000);
    expect(ms(resolveBaselineTimeout(st(9000, 2000), false, true))).toBe(2000);
    // both on
    expect(ms(resolveBaselineTimeout(st(), true, true))).toBe(120000);
    expect(ms(resolveBaselineTimeout(st(4000, 4000), true, true))).toBe(4000);
    const r = resolveBaselineTimeout(st(4000, 4000), true, true);
    expect(r.ok && r.note).toBeFalsy();
  });

  it("R2: both on, TEST 1000 and WRITE_TESTS absent gives 1000 (absent never acts as 120000)", () => {
    expect(ms(resolveBaselineTimeout(st(1000), true, true))).toBe(1000);
  });

  it("R3: both on, WRITE_TESTS 1000 and TEST absent gives 1000", () => {
    expect(ms(resolveBaselineTimeout(st(undefined, 1000), true, true))).toBe(1000);
  });

  it("R4: both on with different values takes the larger either way, with a note", () => {
    const a = resolveBaselineTimeout(st(1000, 5000), true, true);
    const b = resolveBaselineTimeout(st(5000, 1000), true, true);
    expect(ms(a)).toBe(5000);
    expect(ms(b)).toBe(5000);
    expect(a.ok && a.note).toContain("using the larger, 5000 ms");
    expect(b.ok && b.note).toContain("using the larger, 5000 ms");
  });

  it("R5: rejects anything but a whole number from 1 to 3600000, on each key", () => {
    for (const bad of [0, -1, 1.5, "60000", null, 3600001]) {
      const t = resolveBaselineTimeout(st(bad), true, false);
      expect(t.ok, `TEST ${String(bad)}`).toBe(false);
      expect(!t.ok && t.message).toContain("stages.TEST.testTimeoutMs");
      const w = resolveBaselineTimeout(st(undefined, bad), false, true);
      expect(w.ok, `WRITE_TESTS ${String(bad)}`).toBe(false);
      expect(!w.ok && w.message).toContain("stages.WRITE_TESTS.testTimeoutMs");
    }
    expect(ms(resolveBaselineTimeout(st(1), true, false))).toBe(1);
    expect(ms(resolveBaselineTimeout(st(3600000), true, false))).toBe(3600000);
  });

  it("R6: both on, a valid WRITE_TESTS value does not hide an invalid TEST value", () => {
    const r = resolveBaselineTimeout(st(-5, 4000), true, true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("stages.TEST.testTimeoutMs");
  });

  it("R7: WRITE_TESTS only, an invalid TEST value refuses (it is the fallback)", () => {
    const r = resolveBaselineTimeout(st(-5, 4000), false, true);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toContain("stages.TEST.testTimeoutMs");
  });

  it("R8: TEST only ignores an invalid WRITE_TESTS value", () => {
    expect(ms(resolveBaselineTimeout(st(undefined, -5), true, false))).toBe(120000);
  });
});

describe.skipIf(!posix)("ISS-1376 captureTestBaseline: causes", () => {
  const cwd = (): string => dir;

  it("C1: a run past the timeout records timeout", async () => {
    const r = await captureTestBaseline(execNode(script(SLEEP)), cwd(), 500, { killGraceMs: 300, cleanupCapMs: 1000 });
    expect(r.kind === "ran" && r.failure).toBe("timeout");
  });

  it("C2: a fixture that exits 0 on SIGTERM still records timeout", async () => {
    const f = script("process.on('SIGTERM', () => process.exit(0));\n" + SLEEP);
    const r = await captureTestBaseline(execNode(f), cwd(), 500, { killGraceMs: 300, cleanupCapMs: 1000 });
    expect(r).toMatchObject({ kind: "ran", failure: "timeout", exitCode: 0 });
  });

  it("C3: a fixture that exits 3 on SIGTERM records timeout with exit 3", async () => {
    const f = script("process.on('SIGTERM', () => process.exit(3));\n" + SLEEP);
    const r = await captureTestBaseline(execNode(f), cwd(), 500, { killGraceMs: 300, cleanupCapMs: 1000 });
    expect(r).toMatchObject({ kind: "ran", failure: "timeout", exitCode: 3 });
  });

  it("C4: a fixture that ignores SIGTERM is killed after the grace, and cleanup is confirmed", async () => {
    const f = script(IGNORE_TERM + SLEEP);
    const started = Date.now();
    const r = await captureTestBaseline(execNode(f), cwd(), 300, { killGraceMs: 300, cleanupCapMs: 2000 });
    expect(r).toMatchObject({ kind: "ran", failure: "timeout" });
    expect(r.cleanup).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("C5: a fixture killed by a signal from outside, with no expiry, records signal", async () => {
    const f = script("setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);\n" + SLEEP);
    const r = await captureTestBaseline(execNode(f), cwd(), 10000, { killGraceMs: 300, cleanupCapMs: 1000 });
    expect(r).toMatchObject({ kind: "ran", failure: "signal", signal: "SIGKILL" });
  });

  it("C6: output past 5 MiB records maxBuffer with exactly 5 MiB captured", async () => {
    const f = script("const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 6; i++) process.stdout.write(b);\n" + SLEEP);
    const r = await captureTestBaseline(execNode(f), cwd(), 10000, { killGraceMs: 300, cleanupCapMs: 1000 });
    expect(r.kind === "ran" && r.failure).toBe("maxBuffer");
    expect(r.kind === "ran" && Buffer.byteLength(r.stdout, "utf-8")).toBe(BASELINE_MAX_BUFFER);
  });

  it("C7: an ordinary failing suite has no failure and parseable counts", async () => {
    const f = script("console.log('Tests 2 failed | 5 passed'); process.exit(1);\n");
    const r = await captureTestBaseline(execNode(f), cwd(), 10000);
    expect(r).toMatchObject({ kind: "ran", exitCode: 1 });
    expect(r.kind === "ran" && r.failure).toBeUndefined();
    expect(r.kind === "ran" && r.stdout).toContain("2 failed");
  });

  it("C8: counts printed before a timeout are kept, and the run still records timeout", async () => {
    const f = script("console.log('5 passed 1 failed');\n" + SLEEP);
    const r = await captureTestBaseline(execNode(f), cwd(), 500, { killGraceMs: 300, cleanupCapMs: 1000 });
    expect(r).toMatchObject({ kind: "ran", failure: "timeout" });
    expect(r.kind === "ran" && r.stdout).toContain("5 passed 1 failed");
  });

  it("C9: a fast pass records no failure", async () => {
    const f = script("console.log('Tests 4 passed'); process.exit(0);\n");
    const r = await captureTestBaseline(execNode(f), cwd(), 10000);
    expect(r).toMatchObject({ kind: "ran", exitCode: 0 });
    expect(r.kind === "ran" && r.failure).toBeUndefined();
  });
});

/** Fake timers that record what is pending and what was cleared; fired by hand. */
function fakeTimers(): TeardownTimers & { pending: Map<number, () => void>; cleared: Set<number>; byMs: Map<number, number> } {
  let id = 0;
  const pending = new Map<number, () => void>();
  const cleared = new Set<number>();
  const byMs = new Map<number, number>();
  return {
    pending,
    cleared,
    byMs,
    setTimeout(fn, ms) {
      id += 1;
      pending.set(id, fn);
      byMs.set(ms, id);
      return id;
    },
    clearTimeout(handle) {
      cleared.add(handle as number);
      pending.delete(handle as number);
    },
  };
}

type FakeChild = EventEmitter & {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
  unref: () => void;
};
type CaptureKill = (pid: number, signal: NodeJS.Signals | 0) => unknown;
function fakeChild(pid?: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.unref = () => {};
  return child;
}

describe("ISS-1376 captureTestBaseline: cause and timer seams", () => {
  /**
   * A fake child whose group stays alive until the test ends it: SIGTERM is
   * only recorded, so the teardown is still pending while the test looks at
   * the expiry timer.
   */
  function heldChild(pid: number): { child: FakeChild; termSent: () => boolean; finish: () => void; killFn: CaptureKill } {
    const child = fakeChild(pid);
    let term = false;
    return {
      child,
      termSent: () => term,
      finish: () => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      },
      killFn: (_pid, signal) => {
        if (signal === "SIGTERM") term = true;
        if (signal === 0 && child.exitCode !== null) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      },
    };
  }

  it("C6c: starting termination clears the expiry timer", async () => {
    const timers = fakeTimers();
    const h = heldChild(424242);
    const done = captureTestBaseline("x", dir, 777, {
      spawnFn: (() => h.child) as unknown as BaselineSpawn,
      timers,
      platform: "linux",
      killFn: h.killFn,
    });
    const expiryId = timers.byMs.get(777)!;
    expect(timers.pending.has(expiryId)).toBe(true);
    h.child.stdout.write(Buffer.alloc(BASELINE_MAX_BUFFER + 1, 120));
    expect(await until(h.termSent)).toBe(true);
    // Termination has started and the capture has not settled yet.
    expect(timers.cleared.has(expiryId)).toBe(true);
    expect(timers.pending.has(expiryId)).toBe(false);
    h.finish();
    const r = await done;
    expect(r.kind === "ran" && r.failure).toBe("maxBuffer");
  });

  it("C6d: the first cause is kept when a second trigger fires", async () => {
    const timers = fakeTimers();
    const h = heldChild(424243);
    const done = captureTestBaseline("x", dir, 778, {
      spawnFn: (() => h.child) as unknown as BaselineSpawn,
      timers,
      platform: "linux",
      killFn: h.killFn,
    });
    const expiry = timers.pending.get(timers.byMs.get(778)!)!;
    h.child.stdout.write(Buffer.alloc(BASELINE_MAX_BUFFER + 1, 120));
    expect(await until(h.termSent)).toBe(true);
    // The expiry fires late (as a timer already queued would): it must not
    // replace the overflow that came first.
    expiry();
    h.finish();
    const r = await done;
    expect(r.kind === "ran" && r.failure).toBe("maxBuffer");
  });
});

describe.skipIf(!posix)("ISS-1376 captureTestBaseline: the whole process tree", () => {
  /**
   * A shell leader plus a SIGTERM-ignoring grandchild that redirects its
   * streams. The leader runs its tail (the trigger) only once the grandchild
   * has written its pid file, which it does after installing its SIGTERM
   * handler, so no trigger can fire against a grandchild still starting up.
   * The wait is bounded (100 x 50 ms).
   */
  function treeCommand(pf: string, leaderTail: string): string {
    const g = script(`${IGNORE_TERM}require('fs').writeFileSync(${JSON.stringify(pf)}, String(process.pid));\n${SLEEP}`);
    const ready = `i=0; while [ ! -s ${JSON.stringify(pf)} ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done`;
    return `${NODE} ${JSON.stringify(g)} ${MARKER} >/dev/null 2>&1 & ${ready}; ${leaderTail}`;
  }
  const grandchild = async (pf: string): Promise<number> => {
    expect(await until(() => existsSync(pf) && readFileSync(pf, "utf-8").trim() !== "")).toBe(true);
    return Number(readFileSync(pf, "utf-8").trim());
  };

  // The timeout covers the leader's readiness wait as well, so it is long
  // enough for the grandchild to start under load and still well under the
  // test timeout.
  it("C10: a timeout kills the grandchild too, and cleanup is confirmed", { timeout: 15000 }, async () => {
    const pf = pidFile();
    const done = captureTestBaseline(treeCommand(pf, "sleep 30"), dir, 3000, { killGraceMs: 300, cleanupCapMs: 2000 });
    const gpid = await grandchild(pf);
    const r = await done;
    expect(r).toMatchObject({ kind: "ran", failure: "timeout" });
    expect(r.cleanup).toBeUndefined();
    expect(alive(gpid)).toBe(false);
  });

  it("C11: an overflow kills the grandchild too, and cleanup is confirmed", { timeout: 15000 }, async () => {
    const pf = pidFile();
    const big = script("const b = Buffer.alloc(1024 * 1024, 120); for (let i = 0; i < 6; i++) process.stdout.write(b);\n");
    const done = captureTestBaseline(treeCommand(pf, `${NODE} ${JSON.stringify(big)} ${MARKER}; sleep 30`), dir, 10000, { killGraceMs: 300, cleanupCapMs: 2000 });
    const gpid = await grandchild(pf);
    const r = await done;
    expect(r).toMatchObject({ kind: "ran", failure: "maxBuffer" });
    expect(r.cleanup).toBeUndefined();
    expect(alive(gpid)).toBe(false);
  });

  it("C13: a group that is already gone confirms at once, well under the cap", async () => {
    const started = Date.now();
    const r = await captureTestBaseline(execNode(script(SLEEP)), dir, 200, { killGraceMs: 200, cleanupCapMs: 5000 });
    expect(r).toMatchObject({ kind: "ran", failure: "timeout" });
    expect(r.cleanup).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("C14: when every signal fails with EPERM it settles unconfirmed within the bound and throws nothing", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => { uncaught.push(err); };
    process.on("uncaughtException", onUncaught);
    try {
      const pf = pidFile();
      const f = script(`require('fs').writeFileSync(${JSON.stringify(pf)}, String(process.pid));\n${IGNORE_TERM}${SLEEP}`);
      const started = Date.now();
      const r = await captureTestBaseline(execNode(f), dir, 200, {
        killGraceMs: 200,
        cleanupCapMs: 300,
        killFn: () => {
          throw Object.assign(new Error("not permitted"), { code: "EPERM" });
        },
      });
      expect(r).toMatchObject({ kind: "ran", failure: "timeout", cleanup: "unconfirmed" });
      expect(Date.now() - started).toBeLessThan(200 + 200 + 300 + 1500);
      await new Promise((res) => setTimeout(res, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("C17: with signalling failing, the host process still exits within the bound", { timeout: 20000 }, async () => {
    const pf = pidFile();
    const fixture = script(`require('fs').writeFileSync(${JSON.stringify(pf)}, String(process.pid));\n${IGNORE_TERM}${SLEEP}`);
    const modUrl = new URL("../../src/autonomous/test-baseline.ts", import.meta.url).href;
    const host = join(dir, `host${n++}.mts`);
    writeFileSync(host, [
      `import { spawn } from "node:child_process";`,
      `import { captureTestBaseline } from ${JSON.stringify(modUrl)};`,
      `console.log("start " + Date.now());`,
      `const eperm = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };`,
      // Every signal fails, the group signal and the direct-child fallback
      // alike, so the leader itself stays alive: only the unref lets the host exit.
      `const spawnFn = (cmd, o) => { const c = spawn(cmd, o); c.kill = eperm; return c; };`,
      `const r = await captureTestBaseline(${JSON.stringify(execNode(fixture))}, ${JSON.stringify(dir)}, 200, {`,
      `  killGraceMs: 200, cleanupCapMs: 300, killFn: eperm, spawnFn,`,
      `});`,
      `console.log(JSON.stringify({ failure: r.kind === "ran" ? r.failure : r.kind, cleanup: r.cleanup }));`,
    ].join("\n"));
    // `node --import tsx` from the package root, as the other subprocess tests
    // run it; the tsx CLI's IPC pipe can collide with a stale one in TMPDIR.
    const pkgRoot = fileURLToPath(new URL("../..", import.meta.url));
    const res = spawnSync(process.execPath, ["--import", "tsx", host], { cwd: pkgRoot, encoding: "utf-8", timeout: 12000 });
    const ended = Date.now();
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim().split("\n").pop()!)).toEqual({ failure: "timeout", cleanup: "unconfirmed" });
    const gpid = await (async () => {
      expect(await until(() => existsSync(pf))).toBe(true);
      return Number(readFileSync(pf, "utf-8").trim());
    })();
    expect(alive(gpid)).toBe(true);
    // Measured from the host's own first line, so the loader's startup is not counted.
    const hostStart = Number(/^start (\d+)$/m.exec(res.stdout)![1]);
    expect(ended - hostStart).toBeLessThan(3000);
  });
});

describe("ISS-1376 captureTestBaseline: platform and launch failures", () => {
  it("C12: win32 spawns without detached and kills the tree with taskkill, never a group signal", async () => {
    const timers = fakeTimers();
    const child = fakeChild(5150);
    child.kill = () => {
      process.nextTick(() => { child.exitCode = 1; child.emit("exit", 1, null); });
      return true;
    };
    let spawnOpts: Record<string, unknown> | null = null;
    const taskkills: number[] = [];
    const kills: number[] = [];
    const done = captureTestBaseline("x", dir, 779, {
      platform: "win32",
      timers,
      spawnFn: ((_cmd: string, o: Record<string, unknown>) => {
        spawnOpts = o;
        return child;
      }) as unknown as BaselineSpawn,
      runTaskkill: (pid) => {
        taskkills.push(pid);
        process.nextTick(() => { child.exitCode = 1; child.emit("exit", 1, null); });
        return new EventEmitter() as never;
      },
      killFn: (pid) => {
        kills.push(pid);
        return true;
      },
    });
    timers.pending.get(timers.byMs.get(779)!)!();
    const r = await done;
    expect(spawnOpts).toMatchObject({ detached: false, shell: true });
    expect(taskkills).toEqual([5150]);
    expect(kills.filter((p) => p < 0)).toEqual([]);
    expect(r).toMatchObject({ kind: "ran", failure: "timeout" });
  });

  it.skipIf(!posix)("C15: a missing cwd is a launch error, settled quickly, never a timeout", async () => {
    const started = Date.now();
    const r = await captureTestBaseline("echo hi", join(dir, "does-not-exist"), 10000);
    expect(r).toMatchObject({ kind: "launchError", code: "ENOENT" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("C16: a synchronous spawn throw and an error with no pid are both launch errors with no timer left", async () => {
    const t1 = fakeTimers();
    const r1 = await captureTestBaseline("x", dir, 780, {
      timers: t1,
      spawnFn: (() => {
        throw Object.assign(new Error("spawn boom"), { code: "EBOOM" });
      }) as unknown as BaselineSpawn,
    });
    expect(r1).toEqual({ kind: "launchError", code: "EBOOM", message: "spawn boom" });
    expect(t1.pending.size).toBe(0);

    const t2 = fakeTimers();
    const child = fakeChild(undefined);
    const p2 = captureTestBaseline("x", dir, 781, { timers: t2, spawnFn: (() => child) as unknown as BaselineSpawn });
    child.emit("error", Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" }));
    const r2 = await p2;
    expect(r2).toEqual({ kind: "launchError", code: "ENOENT", message: "spawn /bin/sh ENOENT" });
    expect(t2.pending.size).toBe(0);
  });
});

describe("ISS-1376 session schema", () => {
  it("S1: a baseline without failure (written before the field) still parses, and one with it parses too", () => {
    const shape = SessionStateSchema.shape.testBaseline;
    expect(shape.safeParse({ exitCode: 1, passCount: 3, failCount: 1, summary: "x" }).success).toBe(true);
    expect(shape.safeParse({ exitCode: 1, passCount: 3, failCount: 1, summary: "x", failure: "timeout" }).success).toBe(true);
    expect(shape.safeParse({ exitCode: 1, passCount: 3, failCount: 1, summary: "x", failure: "bogus" }).success).toBe(false);
  });
});

describe.skipIf(!posix)("ISS-1376 fixture sweep", () => {
  it("leaves no fixture process behind", async () => {
    sweep();
    expect(await until(() => spawnSync("pgrep", ["-f", MARKER]).status === 1)).toBe(true);
  });
});

