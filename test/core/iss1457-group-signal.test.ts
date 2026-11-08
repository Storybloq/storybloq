/**
 * ISS-1457 round 2 (finding 5): every negative-pid signal of a run in group goes through one function.
 * Before the leader's exit event it is sent as always; after it, only when a probe in the same step
 * answers "alive". A group seen gone, or answering EPERM, is never signalled.
 *
 * Round 3: "alive" cannot prove it is still the original group. The system keeps a group id from any new
 * process while a member lives, so the probe misleads only when every original member has exited and an
 * unrelated process has made that number its own group id before the post-exit probe. That case is the
 * accepted residual: the guard signals it. The last row pins that behaviour and the run's record of it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChildProcess, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processGroupSeams, runInGroup, type GroupRunOptions } from "../../src/core/process-group.js";

const real = { ...processGroupSeams };
const realKill = process.kill.bind(process);
let signals: Array<[number, string | number]> = [];
let fakePids = new Set<number>();

afterEach(() => {
  Object.assign(processGroupSeams, real);
  vi.restoreAllMocks();
  signals = [];
  fakePids = new Set();
});

/** Records every real signal (not a probe) sent to a negative pid; one to a fake group is not delivered. */
function watchKill(): void {
  vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
    if (pid < 0 && sig !== 0) signals.push([pid, sig ?? "SIGTERM"]);
    if (fakePids.has(Math.abs(pid))) return true;
    return realKill(pid, sig as NodeJS.Signals);
  }) as typeof process.kill);
}

const PID = 999_999_101;
type Fake = { child: ChildProcess; die: (opts?: { close?: boolean }) => void };
function fakeLeader(): Fake {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const f = {} as Fake;
  Object.assign(ee, { pid: PID, stdin: null, stdout: new PassThrough(), stderr: new PassThrough(), unref: () => {}, kill: () => true });
  f.child = ee as unknown as ChildProcess;
  f.die = (opts) => {
    setImmediate(() => {
      ee.emit("exit", null, "SIGTERM");
      if (opts?.close !== false) setImmediate(() => ee.emit("close", null, "SIGTERM"));
    });
  };
  fakePids.add(PID);
  processGroupSeams.ownGroup = true;
  processGroupSeams.spawn = (() => f.child) as unknown as typeof spawn;
  return f;
}

/** A signal to the fake group reaches the fake leader, which reacts as given. */
function deliver(f: Fake, onSignal: (f: Fake, sig: NodeJS.Signals) => void): void {
  const spy = vi.mocked(process.kill);
  const inner = spy.getMockImplementation()!;
  spy.mockImplementation(((pid: number, sig?: string | number) => {
    const r = inner(pid, sig);
    if (pid === -PID && sig !== 0) onSignal(f, sig as NodeJS.Signals);
    return r;
  }) as typeof process.kill);
}

const eperm = (): never => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
const esrch = (): never => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };

async function run(over: Partial<GroupRunOptions> = {}) {
  return runInGroup({ command: "ignored", args: [], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 100, killGraceMs: 150, ...over });
}

describe("the run's one group signal (ISS-1457 round 2)", () => {
  it("the leader exits during the SIGTERM grace and the probe then answers EPERM: no SIGKILL, unconfirmed, naming the group", async () => {
    let leaderGone = false;
    processGroupSeams.probe = () => { if (leaderGone) eperm(); };
    watchKill();
    const f = fakeLeader();
    deliver(f, (self, sig) => { if (sig === "SIGTERM") { leaderGone = true; self.die(); } });
    const r = await run();
    expect(signals).toEqual([[-PID, "SIGTERM"]]);
    expect(r).toMatchObject({ timedOut: true, cleanup: "unconfirmed" });
    expect(r.cleanupDetail).toBe(`kill(-${PID}, 0) answered EPERM 2000 ms after the last signal`);
  });

  it("the same with the group then seen gone: no SIGKILL, confirmed", async () => {
    let leaderGone = false;
    processGroupSeams.probe = () => { if (leaderGone) esrch(); };
    watchKill();
    const f = fakeLeader();
    deliver(f, (self, sig) => { if (sig === "SIGTERM") { leaderGone = true; self.die(); } });
    const r = await run();
    expect(signals).toEqual([[-PID, "SIGTERM"]]);
    expect(r).toMatchObject({ timedOut: true, cleanup: "confirmed" });
  });

  it("the CLI's own exit after the leader's, with the group gone, sends nothing", async () => {
    processGroupSeams.probe = esrch;
    watchKill();
    const f = fakeLeader();
    // The leader exits at once and something outside the group holds its pipes, so the run is still confirming.
    f.die({ close: false });
    const before = new Set(process.listeners("exit"));
    const pending = run({ timeoutMs: 10_000 });
    const added = process.listeners("exit").filter((l) => !before.has(l));
    expect(added).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 50));
    (added[0] as () => void)();
    const r = await pending;
    expect(signals).toEqual([]);
    expect(r).toMatchObject({ exitCode: null, cleanup: "confirmed" });
  });

  it("accepted residual, pgid reused before the post-exit probe: the reused group is signalled, and the run records each signal sent after the leader's exit with the group id", async () => {
    // The original leader has exited and been reaped (the fake's exit and close) before the first post-exit
    // probe; the fake then answers "alive" for that number, as a foreign group that adopted it would, until
    // the SIGKILL ends that group.
    let reusedGone = false;
    processGroupSeams.probe = () => { if (reusedGone) esrch(); };
    watchKill();
    const f = fakeLeader();
    deliver(f, (_self, sig) => { if (sig === "SIGKILL") reusedGone = true; });
    f.die();
    const r = await run({ timeoutMs: 10_000 });
    expect(signals).toEqual([[-PID, "SIGTERM"], [-PID, "SIGKILL"]]);
    expect(r).toMatchObject({ timedOut: false, cleanup: "confirmed" });
    expect(r.signalledAfterLeaderExit).toEqual({ pgid: PID, signals: ["SIGTERM", "SIGKILL"] });
  });

  it("a run that never signals after the leader's exit has no such record", async () => {
    processGroupSeams.probe = esrch;
    watchKill();
    const f = fakeLeader();
    f.die();
    const r = await run({ timeoutMs: 10_000 });
    expect(signals).toEqual([]);
    expect(r.signalledAfterLeaderExit).toBeUndefined();
  });

  it("a leftover that ignores SIGTERM after the leader's exit is still stopped: SIGTERM then SIGKILL, confirmed", async () => {
    watchKill();
    const dir = mkdtempSync(join(tmpdir(), "iss1457-gs-"));
    const ready = join(dir, "trapped");
    let pgid = 0;
    try {
      const r = await runInGroup({
        command: "/bin/sh", args: ["-c", `(trap '' TERM; : > '${ready}'; sleep 30) & while [ ! -e '${ready}' ]; do sleep 0.01; done; echo done`],
        cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, killGraceMs: 300, onSpawn: (id) => { pgid = id; },
      });
      expect(existsSync(ready)).toBe(true);
      expect(signals).toEqual([[-pgid, "SIGTERM"], [-pgid, "SIGKILL"]]);
      expect(r).toMatchObject({ exitCode: 0, timedOut: false, cleanup: "confirmed" });
    } finally {
      try { if (pgid) realKill(-pgid, "SIGKILL"); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
