// T-538 S5b-0 commit 5: the disk and runner monitor, a separate process from the runner (plan v10 section 12,
// the M7 ruling). A 1 s tick reads both volumes' free space. Under a volume's stop threshold, three misses in
// a row, or a tick that stalled, it writes limit-hit.json and then kills: docker kill during the attempt, the
// pack helper during a pack. If the runner's pid is gone it writes runner-lost.json and runs docker stop -t 10.
// The record is written before the action, so the cause of record survives the kill. Nothing calls this yet.
import { statfs } from "node:fs/promises";
import { LIMITS, type Limits } from "./onboarding-eval-limits.js";

export type Volume = "sharge" | "hostData";
export type Phase = "attempt" | "pack" | "done";

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
 * One tick, pure. Order: a stalled tick first (the readings are late, so they cannot clear it), then the
 * runner, then each volume. A null reading is a miss; three in a row is a limit hit, a good reading resets.
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
  readonly freeBytes: (v: Volume) => Promise<number | null>;
  readonly runnerAlive: () => boolean;
  readonly phase: () => Phase;
  readonly writeRecord: (name: "limit-hit.json" | "runner-lost.json", body: Record<string, unknown>) => void;
  readonly dockerKill: () => Promise<void>;
  readonly dockerStop: (seconds: number) => Promise<void>;
  readonly killPackHelper: () => Promise<void>;
}

export type MonitorEnd = { readonly ended: "done" } | { readonly ended: "limit-hit"; readonly action: "docker-kill" | "pack-helper-kill"; readonly reason: string } | { readonly ended: "runner-lost"; readonly reason: string };

/** The loop: tick every diskTickMs until the phase is done or one action has fired; it fires at most once. */
export async function runMonitor(d: MonitorDeps, l: Limits = LIMITS): Promise<MonitorEnd> {
  let s = initialState(d.now());
  for (;;) {
    await d.sleep(l.diskTickMs);
    const phase = d.phase();
    if (phase === "done") return { ended: "done" };
    const [sharge, hostData] = await Promise.all([d.freeBytes("sharge"), d.freeBytes("hostData")]);
    const now = d.now();
    const t = evaluateTick(s, now, { sharge, hostData }, d.runnerAlive(), l);
    if (t.kind === "none") { s = t.state; continue; }
    if (t.kind === "runner-lost") {
      d.writeRecord("runner-lost.json", { at: now, phase, reason: t.reason });
      await d.dockerStop(10);
      return { ended: "runner-lost", reason: t.reason };
    }
    const action = phase === "pack" ? "pack-helper-kill" : "docker-kill";
    d.writeRecord("limit-hit.json", { at: now, phase, volume: t.volume, free: t.free, reason: t.reason, action });
    if (action === "pack-helper-kill") await d.killPackHelper(); else await d.dockerKill();
    return { ended: "limit-hit", action, reason: t.reason };
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
