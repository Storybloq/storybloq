/**
 * T-427 rendezvous long-poll (`storybloq bus poll --wait --timeout <s>`).
 *
 * Blocks until a peer message lands in this endpoint's mailbox or the deadline
 * fires, then exits so a background caller (Claude Code re-invokes the agent when a
 * background command exits) gets push-equivalent wakeup for an explicit wait state.
 *
 * Design (per the approved plan):
 *  - CHECKS only DETECT and record an outcome; the COORDINATOR owns the single
 *    cleanup + exit. setOutcome never awaits, so no check can deadlock on cleanup.
 *  - A single COALESCING worker: at most one check runs and at most one rerun queues,
 *    regardless of watch/interval storms. Watch events + startup + the deadline-final
 *    poll are AUTHORITATIVE (always pollBus); interval ticks are a cheap fold-free
 *    mailboxHasPointerCandidate scan that escalates to pollBus only on a candidate.
 *  - Never holds a bus lock while blocked: pollBus acquires+releases per call, and the
 *    waiter marker file is a plain durable file, not a held mutex, so the peer's send
 *    is never wedged.
 *  - At most one waiter per endpoint: a dedicated `locks/waiter-<endpointId>.lock`
 *    records {waiterId,pid,startedAt,argvMarkers}; a second `--wait` FAILS CLOSED
 *    (exit 5) when the incumbent's argv identity probes "match" OR "unknown", and only
 *    steals a positively-absent (dead) incumbent. Cleanup is identity-matched and
 *    non-creating, so it never removes a live contender's record.
 */

import { randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { z } from "zod";
import { probeArgvSignature } from "../autonomous/liveness.js";
import { BusError } from "./errors.js";
import { durableCreate, durableUnlink, readJsonNoFollow, rejectPathSymlink } from "./io.js";
import { withHardenedLock } from "./lock.js";
import { endpointLockPath, endpointMailboxPath, resolveBusPaths, type BusPaths } from "./paths.js";
import { mailboxHasPointerCandidate, pollBus, type BusPollResult } from "./store.js";

// The identity markers a live `bus poll --wait` process carries in its argv. A
// contended acquire probes the incumbent's pid for ALL of these; reused from the
// T-424 liveness helper -- never reimplement process liveness.
export const WAIT_ARGV_MARKERS: readonly string[] = ["storybloq", "bus", "poll", "--wait"];

export const WAIT_TIMEOUT_MIN_SECONDS = 1;
export const WAIT_TIMEOUT_MAX_SECONDS = 3600;
// Default deadline for a `bus poll --wait` with no explicit --timeout. A background
// rendezvous should hold long enough to actually catch a peer reply, so this is minutes.
export const WAIT_DEFAULT_TIMEOUT_SECONDS = 300;

const WAITER_POLL_INTERVAL_MS = 1000;

// Test-only seam: runs inside cleanupWaiter AFTER the existsSync precheck and BEFORE the
// non-creating guard acquisition, so a test can delete the runtime in exactly that window
// and prove the create:false guard never re-materializes any bus path.
let afterCleanupExistenceCheckHook: (() => Promise<void>) | null = null;

const WaiterRecordSchema = z.object({
  schema: z.literal("storybloq-bus-waiter/v1"),
  waiterId: z.string().uuid(),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime({ offset: true }),
  argvMarkers: z.array(z.string().min(1)).min(1),
}).passthrough();

type WaiterRecord = z.infer<typeof WaiterRecordSchema>;

export interface WaiterIdentity {
  readonly waiterId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly argvMarkers: readonly string[];
}

/** Thrown by acquireWaiter when a live `--wait` already owns this endpoint (exit 5). */
export class WaiterActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaiterActiveError";
  }
}

// Injectable argv-liveness probe (default is the real one). A test injects a fake
// because the vitest process argv never carries WAIT_ARGV_MARKERS.
export type ArgvProbe = (pid: number, markers: readonly string[]) => "match" | "absent" | "unknown";

function waiterPath(paths: BusPaths, endpointId: string): string {
  return endpointLockPath(paths, "waiter", endpointId);
}

// A short-lived mutex serializing the read->probe->unlink->create acquisition and the
// read->unlink cleanup for one endpoint. It is held only for the few syscalls of each
// transaction (NEVER while the waiter is blocked, so the peer's send is never wedged),
// and closes the TOCTOU where a contender could replace a record between another
// process's read/probe and its unlink. The persistent single-waiter marker is the
// separate waiter-<id>.lock FILE, not this guard.
function waiterGuardPath(paths: BusPaths, endpointId: string): string {
  return endpointLockPath(paths, "waiter-guard", endpointId);
}

function sameIdentity(record: WaiterRecord, identity: WaiterIdentity): boolean {
  return record.waiterId === identity.waiterId &&
    record.pid === identity.pid &&
    record.startedAt === identity.startedAt;
}

// Acquire the single-waiter slot. durableCreate is O_EXCL, so exactly one create
// wins a race; a loser (EEXIST) re-probes the incumbent. FAIL CLOSED: a "match" or
// "unknown" incumbent throws WaiterActiveError; only a positively-absent (dead)
// incumbent is stolen (unlink + retry). A bounded retry guards against pathological
// churn where a create keeps racing a concurrent steal.
export async function acquireWaiter(
  paths: BusPaths,
  endpointId: string,
  identity: WaiterIdentity,
  probe: ArgvProbe = probeArgvSignature,
): Promise<void> {
  const path = waiterPath(paths, endpointId);
  const body = JSON.stringify({
    schema: "storybloq-bus-waiter/v1",
    waiterId: identity.waiterId,
    pid: identity.pid,
    startedAt: identity.startedAt,
    argvMarkers: [...identity.argvMarkers],
  } satisfies WaiterRecord, null, 2) + "\n";

  // The whole read->probe->unlink->create sequence runs under the guard, so a
  // concurrent acquire or cleanup cannot replace the record between our probe and our
  // steal-unlink (the race that would otherwise delete a live foreign waiter).
  await withHardenedLock(waiterGuardPath(paths, endpointId), async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await durableCreate(path, body);
        return;
      } catch (err) {
        if (!(err instanceof BusError) || err.code !== "conflict") throw err; // EEXIST -> conflict
      }
      // The slot is held. Read + probe the incumbent.
      let record: WaiterRecord;
      try {
        record = await readJsonNoFollow(path, WaiterRecordSchema);
      } catch (err) {
        // A corrupt/symlinked/unreadable waiter file cannot be proven dead -> fail
        // closed rather than stomp it (a symlink here would be an attack surface).
        if (err instanceof BusError && err.code === "not_found") continue; // vanished -> retry create
        throw new WaiterActiveError(
          "Another `bus poll --wait` may be active on this endpoint (its waiter record is unreadable). It cannot be proven dead, so it is left in place; verify no `storybloq bus poll --wait` is running for this endpoint, then retry.",
        );
      }
      const liveness = probe(record.pid, record.argvMarkers);
      if (liveness === "match" || liveness === "unknown") {
        throw new WaiterActiveError(
          "Another `bus poll --wait` is already waiting on this endpoint. Only one waiter is allowed per endpoint.",
        );
      }
      // Positively absent (dead / pid-reused by another uid) -> steal, then retry.
      await durableUnlink(path);
    }
    throw new WaiterActiveError("Could not acquire the endpoint waiter slot (contended). Retry shortly.");
  });
}

// Identity-matched, NON-creating cleanup: remove the waiter file only when it is
// still OURS. Runs under the same guard as acquisition and re-reads the identity while
// holding it, so a contender that replaces the record after our own wait ends cannot
// have its live waiter deleted. Safe on every path (never touches a foreign record,
// never mkdir's).
export async function cleanupWaiter(paths: BusPaths, endpointId: string, identity: WaiterIdentity): Promise<void> {
  try {
    // Non-creating precondition (optimization): if our waiter record is already gone,
    // there is nothing of ours to remove, so skip the guard entirely. This is the common
    // runtime-deletion case (T-428 deletes `.story/bus` while a wait is blocked): the
    // record vanishes with the runtime.
    if (!existsSync(waiterPath(paths, endpointId))) return;
    if (afterCleanupExistenceCheckHook) await afterCleanupExistenceCheckHook();
    // AUTHORITATIVE guarantee: acquire the guard in non-creating mode so that even if the
    // runtime is deleted in the window between the existsSync check above and this
    // acquisition, the guard refuses (never mkdir's `.story/bus/locks`) rather than
    // resurrecting bus evidence after deletion.
    await withHardenedLock(waiterGuardPath(paths, endpointId), async () => {
      const path = waiterPath(paths, endpointId);
      await rejectPathSymlink(path); // never follow a symlink swapped in at the waiter path
      const record = await readJsonNoFollow(path, WaiterRecordSchema);
      if (sameIdentity(record, identity)) {
        await durableUnlink(path);
      }
    }, { create: false });
  } catch {
    // Absent / not ours / unreadable / lock unavailable -> nothing of ours to remove.
    // Never create.
  }
}

export function classifyBusError(err: unknown): "validation" | "user" {
  if (err instanceof BusError && (err.code === "corrupt" || err.code === "runtime_lost")) return "validation";
  return "user";
}

export type WaitOutcome =
  | { readonly kind: "message"; readonly result: BusPollResult }
  // `result` carries the deadline's final authoritative poll (real endpointId/cursor,
  // empty messages) so a structured consumer never observes a fabricated cursor
  // regression; the exit code (4) is what distinguishes a timeout from a delivery.
  | { readonly kind: "timeout"; readonly result: BusPollResult }
  | { readonly kind: "error"; readonly err: unknown; readonly errorClass: "validation" | "user" }
  | { readonly kind: "signal"; readonly code: number };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export interface WaitOptions {
  readonly root: string;
  readonly endpointId: string;
  readonly clientTaskId: string;
  readonly timeoutMs: number;
  // Max messages to return from the drain poll (forwarded to pollBus, which clamps it).
  // Defaults to pollBus's own default when omitted.
  readonly limit?: number;
  readonly probe?: ArgvProbe;
  // Test seam: fires after the coordinator installs its watcher/interval and arms the
  // deadline, so a test can inject a send at a deterministic point.
  readonly onArmed?: () => void;
}

/**
 * Blocks until a message arrives or the deadline, honoring SIGINT/SIGTERM. Returns a
 * WaitOutcome; the CLI runner maps it to an exit code. Throws WaiterActiveError when a
 * live `--wait` already owns this endpoint (the caller maps that to exit 5).
 */
export async function waitForBusMessage(opts: WaitOptions): Promise<WaitOutcome> {
  const paths = await resolveBusPaths(opts.root, false);
  const identity: WaiterIdentity = {
    waiterId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argvMarkers: WAIT_ARGV_MARKERS,
  };

  let outcome: WaitOutcome | null = null;
  const settled = deferred<void>();
  let accepting = true;
  let pending = false;
  let authoritativePending = false;
  let workerPromise: Promise<void> | null = null;
  // The most recent authoritative empty poll, carried into a timeout outcome so its
  // envelope reports the endpoint's REAL cursor rather than a fabricated 0.
  let lastEmptyPoll: BusPollResult | null = null;

  function emptyPollFallback(): BusPollResult {
    return lastEmptyPoll ?? { endpointId: opts.endpointId, cursor: 0, messages: [], findings: [] };
  }

  function setOutcome(value: WaitOutcome): void {
    if (outcome) return;
    outcome = value;
    settled.resolve();
  }

  async function runCheck(authoritative: boolean): Promise<{ settled: false } | { settled: true; outcome: WaitOutcome }> {
    if (!authoritative) {
      let candidate: boolean;
      try {
        candidate = await mailboxHasPointerCandidate(paths, opts.endpointId);
      } catch {
        candidate = true; // unsure -> escalate to the authoritative poll
      }
      if (!candidate) return { settled: false };
    }
    const result = await pollBus(opts.root, { endpointId: opts.endpointId, clientTaskId: opts.clientTaskId, limit: opts.limit });
    if (result.messages.length > 0) return { settled: true, outcome: { kind: "message", result } };
    if (result.findings.length > 0) {
      return {
        settled: true,
        outcome: {
          kind: "error",
          err: new BusError("corrupt", "Bus poll surfaced integrity findings while waiting; run `storybloq bus doctor`."),
          errorClass: "validation",
        },
      };
    }
    lastEmptyPoll = result; // real endpointId/cursor for an honest timeout envelope
    return { settled: false };
  }

  async function drainLoop(): Promise<void> {
    try {
      while (pending) {
        const authoritative = authoritativePending;
        pending = false;
        authoritativePending = false;
        if (outcome) return;
        let res: { settled: false } | { settled: true; outcome: WaitOutcome };
        try {
          res = await runCheck(authoritative);
        } catch (err) {
          setOutcome({ kind: "error", err, errorClass: classifyBusError(err) });
          accepting = false;
          return;
        }
        if (res.settled) {
          setOutcome(res.outcome);
          accepting = false;
          return;
        }
      }
    } finally {
      workerPromise = null;
    }
  }

  function drain(): Promise<void> {
    return workerPromise ?? Promise.resolve();
  }

  function requestCheck(authoritative: boolean, internal = false): void {
    if (outcome) return;
    if (!accepting && !internal) return;
    pending = true;
    if (authoritative) authoritativePending = true;
    if (!workerPromise) workerPromise = drainLoop();
  }

  async function onDeadline(): Promise<void> {
    if (outcome) return;
    accepting = false; // freeze new external requests
    await drain(); // let any in-flight/queued work finish
    if (outcome) return;
    requestCheck(true, true); // one internal, worker-tracked final authoritative poll
    await drain();
    if (!outcome) setOutcome({ kind: "timeout", result: emptyPollFallback() });
  }

  let watcher: FSWatcher | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let onSigint: (() => void) | null = null;
  let onSigterm: (() => void) | null = null;

  try {
    // Install the signal handlers BEFORE acquiring the waiter slot. Two reasons: (1) a
    // SIGINT/SIGTERM arriving during startup then exits gracefully (130/143 + cleanup)
    // instead of killing by default signal disposition; (2) it makes the waiter MARKER
    // FILE (created by acquireWaiter, next) a deterministic readiness signal -- once the
    // marker exists, the handlers are provably already installed, which a spawned-process
    // test can wait on without racing the handler installation. The finally removes the
    // handlers on every path, including a WaiterActiveError throw from acquireWaiter.
    onSigint = () => { setOutcome({ kind: "signal", code: 130 }); accepting = false; };
    onSigterm = () => { setOutcome({ kind: "signal", code: 143 }); accepting = false; };
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    await acquireWaiter(paths, opts.endpointId, identity, opts.probe); // may throw WaiterActiveError

    watcher = tryInstallWatcher(endpointMailboxPath(paths, opts.endpointId), () => requestCheck(true));
    timeout = setTimeout(() => { void onDeadline(); }, opts.timeoutMs); // arm the deadline BEFORE startup work
    requestCheck(true); // startup authoritative
    interval = setInterval(() => requestCheck(false), WAITER_POLL_INTERVAL_MS);
    opts.onArmed?.();
    await settled.promise;
  } finally {
    accepting = false;
    if (timeout) clearTimeout(timeout);
    if (interval) clearInterval(interval);
    if (watcher) closeWatcher(watcher);
    await drain(); // never exit mid-poll
    if (onSigint) process.off("SIGINT", onSigint);
    if (onSigterm) process.off("SIGTERM", onSigterm);
    await cleanupWaiter(paths, opts.endpointId, identity); // always-safe identity-matched non-creating
  }

  return outcome ?? { kind: "timeout", result: emptyPollFallback() };
}

function tryInstallWatcher(dir: string, onEvent: () => void): FSWatcher | null {
  try {
    const w = watch(dir, { persistent: false }, () => onEvent());
    w.on("error", () => { closeWatcher(w); }); // fall back to the interval on watcher error
    return w;
  } catch {
    return null;
  }
}

function closeWatcher(watcher: FSWatcher): void {
  try {
    watcher.close();
  } catch {
    // idempotent; already closed
  }
}

export const __waitTesting = {
  setAfterCleanupExistenceCheckHook: (fn: (() => Promise<void>) | null) => { afterCleanupExistenceCheckHook = fn; },
};
