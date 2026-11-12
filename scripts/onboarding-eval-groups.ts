/**
 * T-538 commit 4 (7.4): every process group the runner, the host and the judge launch is recorded, so the driver
 * can stop nested groups a wrapper's own stop does not reach. When the driver names a groups file in
 * `ONBOARDING_EVAL_GROUPS_FILE`, each launch appends fsynced lines to it:
 *
 *   { id }                  the launch intent, written BEFORE the spawn, so a death between the spawn and the
 *                           registration still leaves a trace;
 *   { id, pgid, start }     the launch, straight after the spawn: the group id and the leader's start time;
 *   { id, done: true }      the group was confirmed gone (or never started), so it is never signalled later.
 *
 * An intent with no launch and no done line is unresolved: the driver cannot name its group, so the cleanup is
 * unconfirmed. The sweep signals a group only when its recorded start time and the current leader's start time
 * are both known and equal; an unknown identity is never signalled, and a different start time is a reused id
 * whose original group is already gone.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { runInGroup as runInGroupCore, signalRecordedGroup } from "../src/core/process-group.js";

export const GROUPS_FILE_ENV = "ONBOARDING_EVAL_GROUPS_FILE";

/** A launched group not yet confirmed gone. `start` is null when the leader's start time could not be read. */
export interface RecordedGroup { readonly id: string; readonly pgid: number; readonly start: string | null }

/** What ps says about a process: its start time, confirmed absence, or a failed query. */
export type Identity =
  | { readonly kind: "start"; readonly value: string }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly reason: string };

/** The leader's identity: ps exits 1 with no output for a pid with no process; anything else unexpected is a failure. */
export function identityOf(pid: number): Identity {
  const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } });
  if (r.error) return { kind: "failed", reason: `ps failed: ${r.error.message}` };
  if (r.signal) return { kind: "failed", reason: `ps killed by ${r.signal}` };
  const out = (r.stdout ?? "").trim();
  if (r.status === 0 && out !== "") return { kind: "start", value: out };
  if (r.status === 1 && out === "") return { kind: "absent" };
  return { kind: "failed", reason: `ps exited ${r.status}` };
}

/** The start time ps reports for `pid`, or null when it is not known. */
export function startOf(pid: number): string | null {
  const i = identityOf(pid);
  return i.kind === "start" ? i.value : null;
}

/** Appends one fsynced line; the folder is fsynced too when the line creates the file. A failure is thrown, never ignored. */
function appendLine(file: string, v: object): void {
  const created = !existsSync(file);
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(v)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) {
    const d = openSync(dirname(file), "r");
    try { fsyncSync(d); } finally { closeSync(d); }
  }
}

export function recordIntent(file: string): string {
  const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
  appendLine(file, { id });
  return id;
}
export function recordLaunch(file: string, id: string, pgid: number): void { appendLine(file, { id, pgid, start: startOf(pgid) }); }
export function recordDone(file: string, id: string): void { appendLine(file, { id, done: true }); }

/**
 * The registry a file holds: launched groups not yet done, intents with no launch and no done (unresolved), and
 * any unreadable line as a problem, never skipped.
 */
export function readGroups(file: string): { readonly groups: readonly RecordedGroup[]; readonly unresolved: readonly string[]; readonly problems: readonly string[] } {
  if (!existsSync(file)) return { groups: [], unresolved: [], problems: [] };
  const intents: string[] = [];
  const launched = new Map<string, RecordedGroup>();
  const done = new Set<string>();
  const problems: string[] = [];
  for (const [i, l] of readFileSync(file, "utf-8").split("\n").entries()) {
    if (l.trim() === "") continue;
    try {
      const v = JSON.parse(l) as { id?: unknown; pgid?: unknown; start?: unknown; done?: unknown };
      if (typeof v.id !== "string" || v.id === "") throw new Error("no id");
      if (v.done === true) done.add(v.id);
      else if (v.pgid === undefined) intents.push(v.id);
      else {
        if (!Number.isInteger(v.pgid) || (v.pgid as number) <= 1) throw new Error("no pgid");
        launched.set(v.id, { id: v.id, pgid: v.pgid as number, start: typeof v.start === "string" ? v.start : null });
      }
    } catch { problems.push(`groups file line ${i + 1} is not a recorded group`); }
  }
  return {
    groups: [...launched.values()].filter((g) => !done.has(g.id)),
    unresolved: intents.filter((id) => !launched.has(id) && !done.has(id)),
    problems,
  };
}

/** Test seam, not reachable from any input: runs after the spawn, before the launch is recorded. */
export const groupsSeams: { afterSpawn: (pgid: number) => void } = { afterSpawn: () => {} };

/** `runInGroup`, with each launch recorded in the driver's groups file when one is named. */
export const runInGroup: typeof runInGroupCore = async (o) => {
  const file = process.env[GROUPS_FILE_ENV];
  if (file === undefined || file === "") return runInGroupCore(o);
  const id = recordIntent(file);
  let spawned = false;
  const g = await runInGroupCore({ ...o, onSpawn: (pgid, signal) => { spawned = true; groupsSeams.afterSpawn(pgid); recordLaunch(file, id, pgid); o.onSpawn?.(pgid, signal); } });
  if (g.cleanup === "confirmed" || !spawned) recordDone(file, id);
  return g;
};

export interface SweepSignals {
  /** The group signal (process-group.ts signalRecordedGroup); throws ESRCH when the group is gone. */
  readonly signal: (pgid: number, signal: NodeJS.Signals | 0) => void;
  readonly identityOf: (pid: number) => Identity;
}

export const realSweepSignals: SweepSignals = { signal: signalRecordedGroup, identityOf };

/** The group probe: "gone" only on ESRCH; any other answer is a group that may still exist. */
const probe = (s: SweepSignals, pgid: number): "gone" | "present" => {
  try { s.signal(pgid, 0); return "present"; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "present"; }
};

/**
 * Stops every recorded group that is provably ours and confirms each one gone, recording it done. A group the
 * probe finds gone is done. A present group is signalled only when its recorded start time and the current
 * leader's are both known and equal; a different start time is a reused id (ours is gone, the other is left
 * alone), and an unknown identity is never signalled. Returns what could not be confirmed gone.
 */
export async function sweepGroups(file: string, graceMs: number, s: SweepSignals = realSweepSignals): Promise<string[]> {
  const { groups, unresolved, problems } = readGroups(file);
  const out = [...problems, ...unresolved.map((id) => `the launch ${id} recorded no process group, so it cannot be confirmed gone`)];
  const ours: RecordedGroup[] = [];
  for (const g of groups) {
    if (probe(s, g.pgid) === "gone") { recordDone(file, g.id); continue; }
    const now = s.identityOf(g.pgid);
    if (g.start === null) { out.push(`the recorded group ${g.pgid} has no recorded start time, so it is not signalled`); continue; }
    if (now.kind === "failed") { out.push(`the recorded group ${g.pgid} could not be identified (${now.reason}), so it is not signalled`); continue; }
    if (now.kind === "absent") { out.push(`the recorded group ${g.pgid} has no leader to identify, so it is not signalled`); continue; }
    if (now.value !== g.start) { recordDone(file, g.id); continue; }
    ours.push(g);
  }
  for (const g of ours) { try { s.signal(g.pgid, "SIGKILL"); } catch { /* gone already, or confirmed below */ } }
  const until = Date.now() + graceMs;
  let left = ours.filter((g) => probe(s, g.pgid) === "present");
  while (left.length > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    left = left.filter((g) => probe(s, g.pgid) === "present");
  }
  for (const g of ours) if (!left.includes(g)) recordDone(file, g.id);
  for (const g of left) out.push(`the recorded group ${g.pgid} was not confirmed gone`);
  return out;
}
