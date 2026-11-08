// T-538 S5b-0 commit 5: the disk and runner monitor, a separate process from the runner (plan v10 section 12,
// the M7 ruling). A 1 s tick reads both volumes' free space. Under a volume's stop threshold, three misses in
// a row, or a tick that stalled, it writes limit-hit.json and then kills: docker kill during the attempt, the
// pack helper during a pack. If the runner's pid is gone it writes runner-lost.json and runs docker stop -t 10.
// The record is written before the action, so the cause of record survives the kill. Every read and every
// action is bounded by its own timer, so the loop always reaches an outcome. Nothing calls this yet.
import { statfs } from "node:fs/promises";
import { LIMITS, type Limits } from "./onboarding-eval-limits.js";

export type Volume = "sharge" | "hostData";
export type Phase = "attempt" | "pack" | "done";
/** The phase and the object that phase's action targets: the attempt container, or the pack helper. */
export interface PhaseNow { readonly name: Phase; readonly target: string }

export interface MonitorState {
  readonly lastTickAt: number;
  readonly misses: Readonly<Record<Volume, number>>;
}

export type TickDecision =
  | { readonly kind: "none"; readonly state: MonitorState }
  | { readonly kind: "limit-hit"; readonly volume: Volume | null; readonly reason: string; readonly free: number | null }
  | { readonly kind: "runner-lost"; readonly reason: string };

export const initialState = (now: number): MonitorState => ({ lastTickAt: now, misses: { sharge: 0, hostData: 0 } });

/**
 * One tick, pure. `now` is when the tick woke, so slow reads never count as a stall. Order: a stalled tick
 * first, then the runner, then each volume. A null reading is a miss; three in a row is a limit hit, a good
 * reading resets.
 */
export function evaluateTick(s: MonitorState, now: number, free: Readonly<Record<Volume, number | null>>, runnerAlive: boolean, l: Limits = LIMITS): TickDecision {
  const gap = now - s.lastTickAt;
  if (gap > l.monitorTickStallMs) return { kind: "limit-hit", volume: null, reason: `the monitor's tick stalled for ${gap} ms, over ${l.monitorTickStallMs} ms`, free: null };
  if (!runnerAlive) return { kind: "runner-lost", reason: "the runner's process is gone" };
  const misses = { ...s.misses };
  for (const v of ["sharge", "hostData"] as const) {
    const f = free[v];
    if (f === null) {
      misses[v] += 1;
      if (misses[v] >= l.dfMissesToStop) return { kind: "limit-hit", volume: v, reason: `${v}'s free space could not be read ${misses[v]} times in a row`, free: null };
      continue;
    }
    misses[v] = 0;
    const stop = l.volumes[v].stopThresholdBytes;
    if (f < stop) return { kind: "limit-hit", volume: v, reason: `${v} has ${f} bytes free, under its stop threshold of ${stop}`, free: f };
  }
  return { kind: "none", state: { lastTickAt: now, misses } };
}

export interface MonitorDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Resolves after `ms` on the same clock as `now`, or settles early when `signal` aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly freeBytes: (v: Volume) => Promise<number | null>;
  readonly runnerAlive: () => boolean;
  readonly phase: () => PhaseNow;
  readonly writeRecord: (name: "limit-hit.json" | "runner-lost.json" | "action-result.json", body: Record<string, unknown>) => void;
  readonly dockerKill: (target: string) => Promise<void>;
  readonly dockerStop: (target: string, seconds: number) => Promise<void>;
  readonly killPackHelper: (target: string) => Promise<void>;
}

export type ActionResult = "done" | "timed out" | `failed: ${string}`;
export type MonitorEnd =
  | { readonly ended: "done" }
  | { readonly ended: "limit-hit"; readonly action: "docker-kill" | "pack-helper-kill"; readonly target: string; readonly reason: string; readonly result: ActionResult }
  | { readonly ended: "runner-lost"; readonly target: string; readonly reason: string; readonly result: ActionResult };

/** Settles with the promise, or with `fallback` once `ms` pass on the injected clock; the timer is cleared. */
async function within<T>(p: Promise<T>, ms: number, fallback: T, wait: MonitorDeps["wait"]): Promise<T> {
  const ac = new AbortController();
  try {
    return await Promise.race([p, wait(ms, ac.signal).then(() => fallback, () => fallback)]);
  } finally {
    ac.abort();
  }
}

async function act(run: () => Promise<void>, ms: number, wait: MonitorDeps["wait"]): Promise<ActionResult> {
  let p: Promise<ActionResult>;
  try { p = run().then((): ActionResult => "done", (e: unknown): ActionResult => `failed: ${e instanceof Error ? e.message : String(e)}`); } catch (e) { p = Promise.resolve(`failed: ${e instanceof Error ? e.message : String(e)}` as ActionResult); }
  return within(p, ms, "timed out" as ActionResult, wait);
}

/** The loop: tick every diskTickMs until the phase is done or one action has fired; it fires at most once. */
export async function runMonitor(d: MonitorDeps, l: Limits = LIMITS): Promise<MonitorEnd> {
  let s = initialState(d.now());
  const read = (v: Volume): Promise<number | null> => {
    let p: Promise<number | null>;
    try { p = d.freeBytes(v).catch(() => null); } catch { p = Promise.resolve(null); }
    return within(p, l.dfCallTimeoutMs, null, d.wait);
  };
  for (;;) {
    await d.sleep(l.diskTickMs);
    if (d.phase().name === "done") return { ended: "done" };
    const woke = d.now();
    const [sharge, hostData] = await Promise.all([read("sharge"), read("hostData")]);
    const t = evaluateTick(s, woke, { sharge, hostData }, d.runnerAlive(), l);
    if (t.kind === "none") { s = { ...t.state, lastTickAt: d.now() }; continue; }
    // The phase may have moved while the reads were pending: act on the phase as it is now, on its target.
    const p = d.phase();
    if (p.name === "done") return { ended: "done" };
    const at = d.now();
    if (t.kind === "runner-lost") {
      d.writeRecord("runner-lost.json", { at, phase: p.name, target: p.target, reason: t.reason, action: "docker-stop" });
      const result = await act(() => d.dockerStop(p.target, 10), l.stopAfterDetectionMs, d.wait);
      d.writeRecord("action-result.json", { at: d.now(), action: "docker-stop", target: p.target, result });
      return { ended: "runner-lost", target: p.target, reason: t.reason, result };
    }
    const action = p.name === "pack" ? "pack-helper-kill" : "docker-kill";
    d.writeRecord("limit-hit.json", { at, phase: p.name, target: p.target, volume: t.volume, free: t.free, reason: t.reason, action });
    const result = await act(() => (action === "pack-helper-kill" ? d.killPackHelper(p.target) : d.dockerKill(p.target)), l.stopAfterDetectionMs, d.wait);
    d.writeRecord("action-result.json", { at: d.now(), action, target: p.target, result });
    return { ended: "limit-hit", action, target: p.target, reason: t.reason, result };
  }
}

/** A volume's free bytes for an unprivileged process, or null when the call fails or runs past its timeout. */
export async function freeBytesOf(path: string, timeoutMs: number = LIMITS.dfCallTimeoutMs, call: (p: string) => Promise<{ bavail: bigint; bsize: bigint }> = (p) => statfs(p, { bigint: true })): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((res) => { timer = setTimeout(() => res(null), timeoutMs); });
  try {
    const r = await Promise.race([call(path).then((s) => Number(s.bavail * s.bsize)).catch(() => null), late]);
    return r;
  } finally {
    clearTimeout(timer);
  }
}
