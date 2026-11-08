// T-538 S5b-0 commit 5: the disk and runner monitor on a fake clock, fake volumes and fake docker.
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../scripts/onboarding-eval-limits.js";
import { evaluateTick, freeBytesOf, initialState, runMonitor, type MonitorDeps, type Phase, type Volume } from "../../scripts/onboarding-eval-monitor.js";

const T0 = 1_800_000_000_000;
const GIB = 1 << 30;
const SH = LIMITS.volumes.sharge.stopThresholdBytes;
const HD = LIMITS.volumes.hostData.stopThresholdBytes;
const plenty = { sharge: 100 * GIB, hostData: 100 * GIB };

describe("evaluateTick", () => {
  const s0 = initialState(T0);
  it("plenty of space and a live runner: nothing, and the tick time advances", () => {
    const t = evaluateTick(s0, T0 + 1000, plenty, true);
    expect(t).toEqual({ kind: "none", state: { lastTickAt: T0 + 1000, misses: { sharge: 0, hostData: 0 } } });
  });
  it("each volume stops strictly under its own threshold", () => {
    expect(evaluateTick(s0, T0 + 1000, { sharge: SH, hostData: HD }, true).kind).toBe("none");
    expect(evaluateTick(s0, T0 + 1000, { sharge: SH - 1, hostData: 100 * GIB }, true)).toMatchObject({ kind: "limit-hit", volume: "sharge", free: SH - 1 });
    expect(evaluateTick(s0, T0 + 1000, { sharge: 100 * GIB, hostData: HD - 1 }, true)).toMatchObject({ kind: "limit-hit", volume: "hostData", free: HD - 1 });
  });
  it("three misses in a row stop; a good reading in between resets the count", () => {
    let s = s0;
    for (let i = 1; i <= 2; i++) {
      const t = evaluateTick(s, T0 + i * 1000, { sharge: null, hostData: 100 * GIB }, true);
      if (t.kind !== "none") throw new Error(`stopped at miss ${i}`);
      s = t.state;
    }
    expect(s.misses.sharge).toBe(2);
    expect(evaluateTick(s, T0 + 3000, { sharge: null, hostData: 100 * GIB }, true)).toMatchObject({ kind: "limit-hit", volume: "sharge", reason: "sharge's free space could not be read 3 times in a row" });
    const reset = evaluateTick(s, T0 + 3000, plenty, true);
    expect(reset.kind === "none" && reset.state.misses.sharge).toBe(0);
  });
  it("a tick over 5 s late is a limit hit even with good readings; exactly 5 s is not", () => {
    expect(evaluateTick(s0, T0 + 5000, plenty, true).kind).toBe("none");
    expect(evaluateTick(s0, T0 + 5001, plenty, true)).toMatchObject({ kind: "limit-hit", volume: null, reason: "the monitor's tick stalled for 5001 ms, over 5000 ms" });
  });
  it("the stall wins over a lost runner; a lost runner wins over the volumes", () => {
    expect(evaluateTick(s0, T0 + 6000, plenty, false).kind).toBe("limit-hit");
    expect(evaluateTick(s0, T0 + 1000, { sharge: 0, hostData: 0 }, false).kind).toBe("runner-lost");
  });
});

const TARGET: Record<Phase, string> = { attempt: "ctr-attempt", pack: "ctr-pack-helper", done: "" };
function deps(script: {
  free?: (n: number) => Record<Volume, number | null>;
  /** A read that never settles, by tick and volume. */
  hangRead?: (n: number, v: Volume) => boolean;
  alive?: (n: number) => boolean;
  /** The phase for each phase() call within a tick: [at the top, before acting]. */
  phase?: (n: number, call: number) => Phase;
  tickMs?: (n: number) => number;
  hangAction?: boolean;
  failAction?: boolean;
}) {
  let t = T0;
  let n = 0;
  let calls = 0;
  const log: string[] = [];
  const records: Array<{ name: string; body: Record<string, unknown> }> = [];
  const action = (s: string) => (): Promise<void> => {
    log.push(s);
    if (script.hangAction) return new Promise(() => {});
    if (script.failAction) return Promise.reject(new Error("docker said no"));
    return Promise.resolve();
  };
  const d: MonitorDeps = {
    now: () => t,
    // A ceiling: a loop that never ends would starve the test's own timer, so it fails here instead.
    sleep: async (ms) => { n += 1; calls = 0; if (n > 200) throw new Error("the monitor did not end within 200 ticks"); t += script.tickMs?.(n) ?? ms; },
    // The fake timer fires after the event loop turns, so anything that settles first wins; then the clock moves.
    wait: async (ms, signal) => { await new Promise((r) => setImmediate(r)); if (!signal.aborted) t += ms; },
    freeBytes: (v) => (script.hangRead?.(n, v) ? new Promise(() => {}) : Promise.resolve((script.free?.(n) ?? plenty)[v])),
    runnerAlive: () => script.alive?.(n) ?? true,
    phase: () => { calls += 1; const name = script.phase?.(n, calls) ?? "attempt"; return { name, target: TARGET[name] }; },
    writeRecord: (name, body) => { log.push(`record ${name}`); records.push({ name, body }); },
    dockerKill: (target) => action(`docker kill ${target}`)(),
    dockerStop: (target, s) => action(`docker stop -t ${s} ${target}`)(),
    killPackHelper: (target) => action(`kill pack helper ${target}`)(),
  };
  return { d, log, records, ticks: () => n, clock: () => t };
}

describe("runMonitor", () => {
  it("ends quietly when the phase is done, with no record and no kill", async () => {
    const f = deps({ phase: (n) => (n >= 4 ? "done" : "attempt") });
    expect(await runMonitor(f.d)).toEqual({ ended: "done" });
    expect(f.log).toEqual([]);
    expect(f.ticks()).toBe(4);
  });
  it("during the attempt, writes limit-hit.json and then runs docker kill on the attempt, once", async () => {
    const f = deps({ free: (n) => (n >= 3 ? { sharge: SH - 1, hostData: 100 * GIB } : plenty) });
    const e = await runMonitor(f.d);
    expect(e).toMatchObject({ ended: "limit-hit", action: "docker-kill", target: "ctr-attempt", result: "done" });
    expect(f.log).toEqual(["record limit-hit.json", "docker kill ctr-attempt", "record action-result.json"]);
    expect(f.records[0]!.body).toMatchObject({ phase: "attempt", target: "ctr-attempt", volume: "sharge", free: SH - 1, action: "docker-kill" });
    expect(f.records[1]!.body).toMatchObject({ action: "docker-kill", target: "ctr-attempt", result: "done" });
  });
  it("during a pack, kills the pack helper instead of the container", async () => {
    const f = deps({ phase: () => "pack", free: () => ({ sharge: 100 * GIB, hostData: HD - 1 }) });
    const e = await runMonitor(f.d);
    expect(e).toMatchObject({ ended: "limit-hit", action: "pack-helper-kill", target: "ctr-pack-helper" });
    expect(f.log).toEqual(["record limit-hit.json", "kill pack helper ctr-pack-helper", "record action-result.json"]);
  });
  it("a phase that moves to pack while the reads are pending: the action targets the pack helper", async () => {
    const f = deps({ phase: (_n, call) => (call === 1 ? "attempt" : "pack"), free: () => ({ sharge: SH - 1, hostData: 100 * GIB }) });
    const e = await runMonitor(f.d);
    expect(e).toMatchObject({ ended: "limit-hit", action: "pack-helper-kill", target: "ctr-pack-helper" });
    expect(f.log).toEqual(["record limit-hit.json", "kill pack helper ctr-pack-helper", "record action-result.json"]);
    expect(f.records[0]!.body).toMatchObject({ phase: "pack", target: "ctr-pack-helper" });
  });
  it("a phase that moves to done while the reads are pending: no record and no action", async () => {
    const f = deps({ phase: (_n, call) => (call === 1 ? "attempt" : "done"), free: () => ({ sharge: SH - 1, hostData: 100 * GIB }) });
    expect(await runMonitor(f.d)).toEqual({ ended: "done" });
    expect(f.log).toEqual([]);
  });
  it("the same for a lost runner: a phase moved to done means no stop", async () => {
    const f = deps({ alive: () => false, phase: (_n, call) => (call === 1 ? "attempt" : "done") });
    expect(await runMonitor(f.d)).toEqual({ ended: "done" });
    expect(f.log).toEqual([]);
  });
  it("a lost runner writes runner-lost.json and then runs docker stop -t 10", async () => {
    const f = deps({ alive: (n) => n < 2 });
    expect(await runMonitor(f.d)).toMatchObject({ ended: "runner-lost", target: "ctr-attempt", result: "done" });
    expect(f.log).toEqual(["record runner-lost.json", "docker stop -t 10 ctr-attempt", "record action-result.json"]);
  });
  it("a stalled tick stops the attempt", async () => {
    const f = deps({ tickMs: (n) => (n === 3 ? 6000 : 1000) });
    const e = await runMonitor(f.d);
    expect(e).toMatchObject({ ended: "limit-hit", action: "docker-kill" });
    expect(f.ticks()).toBe(3);
  });
  it("ticks at the manifest's 1 s", async () => {
    const seen: number[] = [];
    const f = deps({ phase: (n) => (n >= 2 ? "done" : "attempt") });
    const sleep = f.d.sleep;
    await runMonitor({ ...f.d, sleep: async (ms) => { seen.push(ms); await sleep(ms); } });
    expect(seen).toEqual([1000, 1000]);
  });
});

describe("runMonitor: every read and action is bounded", () => {
  it("a read that never settles is a miss after 5 s, and three of them stop the attempt, without a stall", async () => {
    const f = deps({ hangRead: (_n, v) => v === "hostData" });
    const e = await runMonitor(f.d);
    expect(e).toMatchObject({ ended: "limit-hit", action: "docker-kill", reason: "hostData's free space could not be read 3 times in a row" });
    expect(f.ticks()).toBe(3);
    expect(f.clock()).toBe(T0 + 3 * (1000 + 5000));
  });
  it("a read that never settles does not hide a lost runner", async () => {
    const f = deps({ hangRead: () => true, alive: (n) => n < 2 });
    expect(await runMonitor(f.d)).toMatchObject({ ended: "runner-lost" });
    expect(f.ticks()).toBe(2);
  });
  it("a read that rejects is a miss, not an escaped rejection", async () => {
    const f = deps({});
    const e = await runMonitor({ ...f.d, freeBytes: (v) => (v === "sharge" ? Promise.reject(new Error("statfs broke")) : Promise.resolve(100 * GIB)) });
    expect(e).toMatchObject({ ended: "limit-hit", reason: "sharge's free space could not be read 3 times in a row" });
  });
  it("a kill that never returns ends the monitor after 15 s, with the timeout in the record", async () => {
    const f = deps({ free: () => ({ sharge: SH - 1, hostData: 100 * GIB }), hangAction: true });
    const before = T0 + 1000;
    const e = await runMonitor(f.d);
    expect(e).toMatchObject({ ended: "limit-hit", result: "timed out" });
    expect(f.records[1]!.body).toMatchObject({ action: "docker-kill", result: "timed out" });
    expect(f.clock()).toBe(before + 15_000);
  });
  it("a stop that never returns ends the monitor the same way", async () => {
    const f = deps({ alive: () => false, hangAction: true });
    expect(await runMonitor(f.d)).toMatchObject({ ended: "runner-lost", result: "timed out" });
    expect(f.records.map((r) => r.name)).toEqual(["runner-lost.json", "action-result.json"]);
  });
  it("an action that fails is reported with its message", async () => {
    const f = deps({ free: () => ({ sharge: SH - 1, hostData: 100 * GIB }), failAction: true });
    expect(await runMonitor(f.d)).toMatchObject({ result: "failed: docker said no" });
  });
});

describe("freeBytesOf", () => {
  it("reads a real volume's free bytes", async () => {
    const f = await freeBytesOf(tmpdir());
    expect(typeof f).toBe("number");
    expect(f!).toBeGreaterThan(0);
  });
  it("a missing path is a miss, not a throw", async () => {
    expect(await freeBytesOf("/nonexistent-t538-volume")).toBeNull();
  });
  it("a call past its timeout is a miss; one inside it is read", async () => {
    const hang = () => new Promise<{ bavail: bigint; bsize: bigint }>(() => {});
    expect(await freeBytesOf(tmpdir(), 20, hang)).toBeNull();
    expect(await freeBytesOf(tmpdir(), 1000, async () => ({ bavail: 3n, bsize: 4096n }))).toBe(12288);
  });
});
