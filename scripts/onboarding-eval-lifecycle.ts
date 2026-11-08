// T-538 S5b-0 commit 5: section 11's order, retry, quarantine, retention and stop cause, as primitives
// over injected operations and a clock, so every path is a test with fakes and the real ones run under
// the conversion commit. Nothing calls this yet. Plan v10 section 11, the M5 rulings and section 12.
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { LIMITS, operationDeadline, retryAllowed, type Budget, type Limits } from "./onboarding-eval-limits.js";

/** Why the attempt stopped. The runner's own decision, written before it acts, is the cause of record. */
export type StopReason = "flow-ended" | "cap" | "limit" | "deadline" | "watchdog" | "runner-lost" | "unrequested-exit";
export interface StopCause {
  readonly reason: StopReason;
  /** True when the runner wrote its decision before acting; an unrequested exit is classified by the clock. */
  readonly decided: boolean;
  /** Read only after exit: something in the cgroup was OOM killed, never "the attempt died of OOM". */
  readonly oomKilledNote: boolean;
  readonly detail: string;
}

/**
 * The M5 ruling: a recorded runner decision wins. An exit the runner did not ask for is classified by the
 * runner's clock against the deadline, never by the exit code, which a same-uid tool can set to anything.
 */
export function classifyStop(i: { readonly decision: { readonly reason: Exclude<StopReason, "unrequested-exit">; readonly detail: string } | null; readonly exitedAt: number; readonly deadline: number; readonly oomKilled: boolean | null }): StopCause {
  const oomKilledNote = i.oomKilled === true;
  if (i.decision !== null) return { reason: i.decision.reason, decided: true, oomKilledNote, detail: i.decision.detail };
  if (i.exitedAt >= i.deadline) return { reason: "deadline", decided: false, oomKilledNote, detail: "PID 1 exited at or after the attempt deadline" };
  return { reason: "unrequested-exit", decided: false, oomKilledNote, detail: oomKilledNote ? "PID 1 exited before the deadline with OOMKilled set: an end of the attempt for adjudication, which a tool can cause" : "PID 1 exited before the deadline, not at the runner's request" };
}

/** What a step reports. `ok: false` carries a reason; `skipped` means it was not started for lack of time. */
export type StepResult = { readonly ok: true } | { readonly ok: false; readonly reason: string } | { readonly skipped: string };

/** The operations section 11 orders; each receives its absolute deadline and must stop by it. */
export interface CleanupOps {
  readonly writeStopRecord: (cause: StopCause) => void;
  readonly stop: (deadline: number) => Promise<StepResult>;
  readonly confirm: () => Promise<{ readonly running: boolean; readonly status: string; readonly oomKilled: boolean | null }>;
  readonly proxyPack: (deadline: number) => Promise<StepResult>;
  readonly attemptPack: (deadline: number, attempt: number) => Promise<StepResult>;
  /** Removes the failed try's staging; false when the removal itself failed. */
  readonly clearStaging: () => boolean;
  readonly writeState: () => void;
  readonly retain: () => Promise<StepResult>;
  readonly removeObjects: () => Promise<{ readonly left: number }>;
  readonly writeQuarantine: (reason: string) => void;
  readonly now: () => number;
}

export interface CleanupOutcome {
  readonly steps: readonly string[];
  readonly findings: readonly string[];
  readonly disposition: "packed" | "quarantined";
  readonly corroboration: "available" | "evidence-lost";
  readonly retention: "done" | "pending";
  readonly cleanup: "done" | "objects-left";
}

/**
 * Section 11 from step 1, in order, always. A proxy failure does not stop the attempt pack. The attempt pack
 * gets one retry, only after its staging is removed and only with five minutes left; otherwise, and whenever
 * completion is impossible, quarantine, written while only local writes are needed. Nothing is removed from a
 * quarantined attempt. A cleanup failure keeps the disposition and names the objects left.
 */
export async function runCleanup(budget: Budget, cause: StopCause, ops: CleanupOps, l: Limits = LIMITS): Promise<CleanupOutcome> {
  const steps: string[] = [];
  const findings: string[] = [];
  const deadline = (cap: number): number | null => operationDeadline(budget, ops.now(), cap, l);
  const skippedOrFailed = (r: StepResult): string | null => ("skipped" in r ? r.skipped : r.ok ? null : r.reason);

  ops.writeStopRecord(cause);
  steps.push("stop-record");
  const stopAt = deadline(l.stopCapMs);
  const stopped = stopAt === null ? { skipped: "no time to stop" } : await ops.stop(stopAt);
  steps.push("stop");
  const c = await ops.confirm();
  steps.push("confirm");
  if (c.running) {
    findings.push(`the attempt is still running after the stop (${skippedOrFailed(stopped) ?? c.status})`);
    ops.writeQuarantine("the attempt could not be stopped");
    steps.push("quarantine");
    return { steps, findings, disposition: "quarantined", corroboration: "evidence-lost", retention: "pending", cleanup: "objects-left" };
  }

  const proxyAt = deadline(l.proxyPackDeadlineCapMs);
  const proxy = proxyAt === null ? { skipped: "under a minute left for the proxy pack" } : await ops.proxyPack(proxyAt);
  steps.push("proxy-pack");
  const proxyProblem = skippedOrFailed(proxy);
  if (proxyProblem !== null) findings.push(`proxy pack: ${proxyProblem}; its volume is kept`);
  const corroboration = proxyProblem === null ? "available" : "evidence-lost";

  let packed = false;
  for (let attempt = 1; attempt <= 2 && !packed; attempt++) {
    const at = deadline(l.packDeadlineCapMs);
    if (at === null) { findings.push(`attempt pack try ${attempt}: under a minute left, not started`); break; }
    const r = await ops.attemptPack(at, attempt);
    steps.push(`attempt-pack-${attempt}`);
    const problem = skippedOrFailed(r);
    if (problem === null) { packed = true; break; }
    findings.push(`attempt pack try ${attempt}: ${problem}`);
    if (!ops.clearStaging()) { findings.push("the failed try's staging could not be removed, so there is no retry"); break; }
    steps.push(`clear-staging-${attempt}`);
    if (attempt === 1 && !retryAllowed(budget, ops.now(), l)) { findings.push("under five minutes left, so there is no retry"); break; }
  }
  if (!packed) {
    ops.writeQuarantine(findings[findings.length - 1] ?? "the attempt pack failed");
    steps.push("quarantine");
    return { steps, findings, disposition: "quarantined", corroboration, retention: "pending", cleanup: "objects-left" };
  }

  ops.writeState();
  steps.push("state");
  const kept = await ops.retain();
  steps.push("retain");
  const keptProblem = skippedOrFailed(kept);
  if (keptProblem !== null) findings.push(`retention-pending: ${keptProblem}`);
  const removed = await ops.removeObjects();
  steps.push("remove");
  if (removed.left > 0) findings.push(`cleanup: ${removed.left} labelled objects are left`);
  return { steps, findings, disposition: "packed", corroboration, retention: keptProblem === null ? "done" : "pending", cleanup: removed.left > 0 ? "objects-left" : "done" };
}

const sha256File = (p: string): string => {
  const h = createHash("sha256");
  const fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { const b = Buffer.allocUnsafe(1 << 20); for (let n = readSync(fd, b); n > 0; n = readSync(fd, b)) h.update(b.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest("hex");
};

export type Retention = { readonly status: "moved"; readonly path: string } | { readonly status: "retention-pending"; readonly path: string; readonly reason: string; readonly leftAt?: string };

/**
 * Step 6: a raw tar to the retention folder, mode 0700 and 0600. A cross-volume move is a copy, a re-hash of
 * the copy against the recorded hash, and only then removal of the source. On any failure the tar stays
 * at its recorded path, and a copy that was made is left and named.
 */
export function retainTar(src: string, destDir: string, recordedSha256: string, copy: (from: string, to: string) => void = copyFileSync): Retention {
  const dest = join(destDir, basename(src));
  try { mkdirSync(destDir, { recursive: true, mode: 0o700 }); } catch (e) { return { status: "retention-pending", path: src, reason: `the destination is not available (${(e as NodeJS.ErrnoException).code ?? "unknown"})` }; }
  try { copy(src, dest); } catch (e) { return { status: "retention-pending", path: src, reason: `the copy failed (${(e as NodeJS.ErrnoException).code ?? "unknown"})`, leftAt: dest }; }
  let got: string;
  try { got = sha256File(dest); } catch (e) { return { status: "retention-pending", path: src, reason: `the copy could not be re-hashed (${(e as NodeJS.ErrnoException).code ?? "unknown"})`, leftAt: dest }; }
  if (got !== recordedSha256) return { status: "retention-pending", path: src, reason: "the copy's hash differs from the recorded hash", leftAt: dest };
  unlinkSync(src);
  return { status: "moved", path: dest };
}

export interface Quarantine { readonly attemptId: string; readonly volume: string; readonly reason: string; readonly at: number }

/** `<driver>/quarantine/<attemptId>.json`, local writes only, never overwriting an open one. */
export function writeQuarantine(driverDir: string, q: Quarantine): string {
  const dir = join(driverDir, "quarantine");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${q.attemptId}.json`);
  const fd = openSync(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, `${JSON.stringify(q, null, 2)}\n`); } finally { closeSync(fd); }
  return p;
}

/** Open quarantines at a driver start; any one blocks the next attempt, and one older than 7 days is reported. */
export function quarantineCheck(driverDir: string, now: number, l: Limits = LIMITS): { readonly refusal: string | null; readonly stale: readonly string[] } {
  let names: string[] = [];
  try { names = readdirSync(join(driverDir, "quarantine")).filter((n) => n.endsWith(".json")).sort(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { refusal: `the quarantine folder could not be read (${(e as NodeJS.ErrnoException).code ?? "unknown"})`, stale: [] }; }
  if (names.length === 0) return { refusal: null, stale: [] };
  const stale: string[] = [];
  for (const n of names) {
    try { const q = JSON.parse(readFileSync(join(driverDir, "quarantine", n), "utf-8")) as Quarantine; if (now - q.at > l.quarantineReportAfterMs) stale.push(q.attemptId); } catch { stale.push(n.replace(/\.json$/, "")); }
  }
  return { refusal: `a quarantine is open (${names.map((n) => n.replace(/\.json$/, "")).join(", ")}); the pen rules retry or remove before another attempt`, stale };
}

/** A pen-ordered removal of a quarantine record, after the pen's ruling; the objects are the caller's. */
export function closeQuarantine(driverDir: string, attemptId: string, ruledBy: string): void {
  const p = join(driverDir, "quarantine", `${attemptId}.json`);
  renameSync(p, join(driverDir, "quarantine", `${attemptId}.closed-${ruledBy.replace(/[^A-Za-z0-9-]/g, "_")}`));
}
