// T-538 S5b-0 commit 5: section 11's order, retry, quarantine, retention and stop cause, as primitives
// over injected operations and a clock, so every path is a test with fakes and the real ones run under
// the conversion commit. Nothing calls this yet. Plan v10 section 11, the M5 rulings and section 12.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
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

/**
 * The operations section 11 orders. Each asynchronous one receives its absolute deadline, and runCleanup
 * also bounds its await by that deadline, so an operation that never settles cannot hold cleanup past the
 * budget. The synchronous ones are local writes.
 */
export interface CleanupOps {
  readonly writeStopRecord: (cause: StopCause) => void;
  readonly stop: (deadline: number) => Promise<StepResult>;
  readonly confirm: (deadline: number) => Promise<{ readonly running: boolean; readonly status: string; readonly oomKilled: boolean | null }>;
  readonly proxyPack: (deadline: number) => Promise<StepResult>;
  readonly attemptPack: (deadline: number, attempt: number) => Promise<StepResult>;
  /** Removes the failed try's staging; false when the removal itself failed. */
  readonly clearStaging: () => boolean;
  readonly writeState: () => void;
  readonly retain: (deadline: number) => Promise<StepResult>;
  readonly removeObjects: (deadline: number) => Promise<{ readonly left: number }>;
  readonly writeQuarantine: (reason: string) => void;
  readonly now: () => number;
  /** Resolves after `ms` on the same clock as `now`, or settles early when `signal` aborts. */
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type Bounded<T> = { readonly value: T } | { readonly failed: string };

/** Awaits one operation, no later than its deadline; not started when there is no deadline. */
export async function bounded<T>(run: (deadline: number) => Promise<T>, deadline: number | null, ops: Pick<CleanupOps, "now" | "wait">): Promise<Bounded<T>> {
  if (deadline === null) return { failed: "under a minute left, not started" };
  const ac = new AbortController();
  const late = ops.wait(Math.max(0, deadline - ops.now()), ac.signal).then(
    (): Bounded<T> => ({ failed: "did not finish by its deadline" }),
    (): Bounded<T> => ({ failed: "did not finish by its deadline" }),
  );
  let work: Promise<Bounded<T>>;
  try {
    work = run(deadline).then((value): Bounded<T> => ({ value }), (e: unknown): Bounded<T> => ({ failed: `failed (${e instanceof Error ? e.message : String(e)})` }));
  } catch (e) {
    work = Promise.resolve({ failed: `failed (${e instanceof Error ? e.message : String(e)})` });
  }
  try { return await Promise.race([work, late]); } finally { ac.abort(); }
}

/** The real `wait`: a timer the abort clears, so a finished operation leaves no timer behind. */
export const realWait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((res) => {
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

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
  // An operation with no cap of its own (confirm, retention, removal) gets what remains of the budget.
  const rest = (): number | null => deadline(Number.POSITIVE_INFINITY);
  const skippedOrFailed = (r: StepResult): string | null => ("skipped" in r ? r.skipped : r.ok ? null : r.reason);
  const step = (b: Bounded<StepResult>): string | null => ("failed" in b ? b.failed : skippedOrFailed(b.value));

  ops.writeStopRecord(cause);
  steps.push("stop-record");
  const stopAt = deadline(l.stopCapMs);
  const stopped = stopAt === null ? "no time to stop" : step(await bounded(ops.stop, stopAt, ops));
  steps.push("stop");
  const c = await bounded(ops.confirm, rest(), ops);
  steps.push("confirm");
  if ("failed" in c || c.value.running) {
    findings.push("failed" in c ? `the stop could not be confirmed: the inspect ${c.failed}` : `the attempt is still running after the stop (${stopped ?? c.value.status})`);
    ops.writeQuarantine("failed" in c ? "the stop could not be confirmed" : "the attempt could not be stopped");
    steps.push("quarantine");
    return { steps, findings, disposition: "quarantined", corroboration: "evidence-lost", retention: "pending", cleanup: "objects-left" };
  }

  const proxyAt = deadline(l.proxyPackDeadlineCapMs);
  const proxyProblem = proxyAt === null ? "under a minute left for the proxy pack" : step(await bounded(ops.proxyPack, proxyAt, ops));
  steps.push("proxy-pack");
  if (proxyProblem !== null) findings.push(`proxy pack: ${proxyProblem}; its volume is kept`);
  const corroboration = proxyProblem === null ? "available" : "evidence-lost";

  let packed = false;
  for (let attempt = 1; attempt <= 2 && !packed; attempt++) {
    const at = deadline(l.packDeadlineCapMs);
    if (at === null) { findings.push(`attempt pack try ${attempt}: under a minute left, not started`); break; }
    const r = await bounded((d) => ops.attemptPack(d, attempt), at, ops);
    steps.push(`attempt-pack-${attempt}`);
    const problem = step(r);
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
  const keptProblem = step(await bounded(ops.retain, rest(), ops));
  steps.push("retain");
  if (keptProblem !== null) findings.push(`retention-pending: ${keptProblem}`);
  const removed = await bounded(ops.removeObjects, rest(), ops);
  steps.push("remove");
  const removalProblem = "failed" in removed ? `cleanup: the removal ${removed.failed}, so labelled objects may be left` : removed.value.left > 0 ? `cleanup: ${removed.value.left} labelled objects are left` : null;
  if (removalProblem !== null) findings.push(removalProblem);
  return { steps, findings, disposition: "packed", corroboration, retention: keptProblem === null ? "done" : "pending", cleanup: removalProblem === null ? "done" : "objects-left" };
}

const sha256File = (p: string): string => {
  const h = createHash("sha256");
  const fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { const b = Buffer.allocUnsafe(1 << 20); for (let n = readSync(fd, b); n > 0; n = readSync(fd, b)) h.update(b.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest("hex");
};

export type Retention = { readonly status: "moved"; readonly path: string } | { readonly status: "retention-pending"; readonly path: string; readonly reason: string; readonly leftAt?: string };

const code = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? "unknown";

/**
 * Step 6: a raw tar to the retention folder, mode 0700 and 0600. A cross-volume move is a copy, a re-hash of
 * the copy against the recorded hash, and only then removal of the source. Nothing already retained is ever
 * overwritten: the copy goes to an exclusively created part file in the retention folder and is published by
 * a hard link, which fails on an existing name. On any failure the tar stays at its recorded path; a part
 * file whose hash differs is left and named.
 */
export function retainTar(src: string, destDir: string, recordedSha256: string, copy: (from: string, to: string) => void = (f, t) => copyFileSync(f, t, fsConstants.COPYFILE_EXCL)): Retention {
  const dest = join(destDir, basename(src));
  const part = join(destDir, `.${basename(src)}.part-${randomBytes(6).toString("hex")}`);
  const pending = (reason: string, leftAt?: string): Retention => (leftAt === undefined ? { status: "retention-pending", path: src, reason } : { status: "retention-pending", path: src, reason, leftAt });
  const drop = (): void => { try { unlinkSync(part); } catch { /* the part file was never made */ } };
  try { mkdirSync(destDir, { recursive: true, mode: 0o700 }); } catch (e) { return pending(`the destination is not available (${code(e)})`); }
  if (existsSync(dest)) return pending("an archive of that name is already retained, so it is kept and this one stays");
  try { copy(src, part); chmodSync(part, 0o600); } catch (e) { drop(); return pending(`the copy failed (${code(e)})`); }
  let got: string;
  try { got = sha256File(part); } catch (e) { return pending(`the copy could not be re-hashed (${code(e)})`, part); }
  if (got !== recordedSha256) return pending("the copy's hash differs from the recorded hash", part);
  try { linkSync(part, dest); } catch (e) { drop(); return pending(code(e) === "EEXIST" ? "an archive of that name was retained meanwhile, so it is kept and this one stays" : `the copy could not be published (${code(e)})`); }
  drop();
  unlinkSync(src);
  return { status: "moved", path: dest };
}

/** One path component: starts with a letter or digit, then letters, digits, dot, dash or underscore, at most 128. */
export const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function checkAttemptId(id: string): void {
  if (!ATTEMPT_ID.test(id)) throw new Error(`the attempt id ${JSON.stringify(id.slice(0, 160))} is not a single safe path component`);
}

export interface Quarantine { readonly attemptId: string; readonly volume: string; readonly reason: string; readonly at: number }

/** `<driver>/quarantine/<attemptId>.json`, local writes only, never overwriting an open one. */
export function writeQuarantine(driverDir: string, q: Quarantine): string {
  checkAttemptId(q.attemptId);
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
  checkAttemptId(attemptId);
  const p = join(driverDir, "quarantine", `${attemptId}.json`);
  renameSync(p, join(driverDir, "quarantine", `${attemptId}.closed-${ruledBy.replace(/[^A-Za-z0-9-]/g, "_")}`));
}
