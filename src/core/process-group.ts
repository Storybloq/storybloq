/**
 * Process groups for the commands storybloq starts and must be able to stop
 * whole (ISS-1391, extracted for T-538 S3a-2): the setup reviewers and
 * setup-verify's test command. Each child runs in its own process group, so
 * a timeout reaches whatever it started too. Windows has no process groups
 * to signal; there the child alone is signalled.
 */
import { spawn, type ChildProcess } from "node:child_process";

export const KILL_GRACE_MS = 5000;

export const OWN_GROUP = process.platform !== "win32";

export function signalGroup(child: ChildProcess, signal: NodeJS.Signals, own: boolean = OWN_GROUP): void {
  signalGroupReported(child, signal, own);
}

/**
 * ISS-1470: signalGroup that says what the kill did: "sent", "gone" when the group was already gone
 * (ESRCH, or the child's own kill answering false without a group), or the errno it failed with. signalGroup itself still swallows the answer for callers that
 * only need the attempt (the ISS-1391 terminating-signal handler among them).
 * ISS-1469: a group signal goes through the child's group handle, so it answers "released" once the handle is disarmed.
 */
export function signalGroupReported(child: ChildProcess, signal: NodeJS.Signals, own: boolean = OWN_GROUP): string {
  if (own && child.pid !== undefined) return groupHandle(child, own).signal(signal);
  return signalChild(child, signal);
}

/** The child alone (no group: Windows, or no pid): never a negative pid. */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): string {
  try {
    return child.kill(signal) ? "sent" : "gone";
  } catch (e) {
    return errorAnswer(e);
  }
}

function errorAnswer(e: unknown): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ESRCH") return "gone";
  return code ?? (e as Error).message;
}

/**
 * ISS-1469: the raw group send, with no guard: what a group handle's signal sends once its checks pass.
 * Production code calls it only as a handle's `send` (setup-review's start probe seam defaults to it);
 * everything else signals through groupHandle(child).signal.
 */
export function rawGroupSend(child: ChildProcess, signal: NodeJS.Signals): string {
  if (child.pid === undefined) return "gone";
  try {
    processGroupSeams.send(child.pid, signal);
    return "sent";
  } catch (e) {
    return errorAnswer(e);
  }
}

// --- One handle per owned child (ISS-1469) ---------------------------------------

/**
 * ISS-1469: the one way a child's process group is signalled or probed. Every caller holding the same
 * child gets the same handle, so they share one latch: once the handle is disarmed it never sends again.
 *
 * It disarms, in the same synchronous step, when any of these is seen: a probe of the group answering
 * ESRCH (a lifecycle probe, a confirmation poll, or the gone-watch that runs every CONFIRM_POLL_MS from
 * the leader's exit), the group signal itself answering ESRCH, a SIGKILL that was sent, or settle().
 * A positive-pid ESRCH alone (the leader reaped) does not disarm: the group may still have members.
 *
 * signal(sig) in one synchronous step: disarmed answers "released" and sends nothing. Before the leader's
 * exit notice, `kill(leaderPid, 0)` answering ESRCH means libuv has already reaped the leader, so the
 * group is probed first, exactly as after the notice; any other answer means no reap was seen (not that
 * the leader is unreaped: a replacement process with that number answers too). After the notice, or
 * after a reap was seen, the signal is sent only when the group probe answers "alive"; "gone" disarms.
 *
 * The guarantee: once the group has been seen absent, or a final SIGKILL has gone out, nothing more is
 * sent to that number by anyone holding the child. The accepted residual: a switch from this group to a
 * foreign one with no absence seen in between cannot be told apart, so the foreign group is signalled.
 * That includes a reuse before the leader's exit notice that a replacement answers, a reaped leader whose
 * number already names a foreign group when the group is probed, and a replacement between a probe and its
 * signal. The pid counter can wrap while the original group is alive, so no allocation rate bounds it.
 * On Linux a pidfd for the leader could close this; darwin has no equivalent.
 */
export interface GroupHandle {
  /** "sent", "released" (disarmed: nothing sent), "gone", or the probe's or kill's error code. `send` is a test seam for the raw send. */
  signal(sig: NodeJS.Signals, send?: (child: ChildProcess, sig: NodeJS.Signals) => string | void): string;
  /** "alive", "gone" (which disarms), or the error code; it still answers once disarmed. */
  probe(): "gone" | "alive" | string;
  /** The run is over: disarm first, then stop the gone-watch. Call it before releasing any callback. */
  settle(): void;
  readonly disarmed: boolean;
}

const handles = new WeakMap<ChildProcess, GroupHandle>();

export function groupHandle(child: ChildProcess, own: boolean = OWN_GROUP): GroupHandle {
  const known = handles.get(child);
  if (known) return known;
  const pid = child.pid;
  const grouped = own && pid !== undefined;
  let disarmed = false;
  let leaderExited = child.exitCode != null || child.signalCode != null;
  let watch: NodeJS.Timeout | null = null;
  const stopWatch = (): void => {
    if (watch !== null) clearTimeout(watch);
    watch = null;
  };
  const disarm = (): void => {
    disarmed = true;
    stopWatch();
  };
  const probe = (): string => {
    if (pid === undefined) return "gone";
    const seen = probeGroup(pid);
    if (seen === "gone" && grouped) disarm();
    return seen;
  };
  const arm = (): void => {
    watch = setTimeout(tick, CONFIRM_POLL_MS);
    watch.unref?.();
  };
  const tick = (): void => {
    watch = null;
    if (disarmed) return;
    probe();
    if (!disarmed) arm();
  };
  const handle: GroupHandle = {
    get disarmed() { return disarmed; },
    probe,
    settle: disarm,
    signal: (sig, send) => {
      if (!grouped) return signalChild(child, sig);
      if (disarmed) return "released";
      if (leaderExited || leaderReaped(pid!)) {
        const seen = probe();
        if (seen !== "alive") return seen;
      }
      let answer: string;
      if (send) {
        const r = send(child, sig);
        answer = typeof r === "string" ? r : "sent";
      } else {
        answer = rawGroupSend(child, sig);
      }
      if (answer === "gone" || (answer === "sent" && sig === "SIGKILL")) disarm();
      return answer;
    },
  };
  if (grouped && typeof child.once === "function") {
    child.once("exit", () => {
      leaderExited = true;
      if (!disarmed && watch === null) arm();
    });
  }
  handles.set(child, handle);
  return handle;
}

/** Whether `kill(leaderPid, 0)` answers ESRCH: the leader has been reaped. Any other answer proves nothing either way. */
function leaderReaped(pid: number): boolean {
  try {
    processGroupSeams.leader(pid);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * ISS-1391: a signal's default action ends the CLI without running "exit"
 * listeners, so while any group is live each terminating signal has a handler
 * that kills every live group first. It is prepended, so it decides before the
 * caller's own listeners run: a caller that listens for the signal owns the
 * exit; otherwise the signal is raised again and ends the CLI as it would have.
 */
// Each live child with the kill that stops it: by default a plain group SIGKILL, for a run in group its guarded one.
const liveGroups = new Map<ChildProcess, () => void>();
const STOP_SIGNALS: NodeJS.Signals[] = OWN_GROUP ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM"];
const stopHandlers = new Map<NodeJS.Signals, () => void>();

function stopGroupsOnSignal(sig: NodeJS.Signals): void {
  const ours = stopHandlers.get(sig);
  const others = process.listeners(sig).some((l) => l !== ours);
  for (const stopIt of liveGroups.values()) stopIt();
  liveGroups.clear();
  removeStopHandlers();
  if (!others) process.kill(process.pid, sig);
}

function removeStopHandlers(): void {
  for (const [sig, handler] of stopHandlers) process.removeListener(sig, handler);
  stopHandlers.clear();
}

export function trackGroup(child: ChildProcess, stopIt: () => void = () => signalGroup(child, "SIGKILL")): void {
  if (liveGroups.size === 0) {
    for (const sig of STOP_SIGNALS) {
      const handler = (): void => stopGroupsOnSignal(sig);
      stopHandlers.set(sig, handler);
      process.prependListener(sig, handler);
    }
  }
  liveGroups.set(child, stopIt);
}

export function untrackGroup(child: ChildProcess): void {
  if (liveGroups.delete(child) && liveGroups.size === 0) removeStopHandlers();
}

/**
 * Lets go of a child that will not close: its pipes are destroyed and it is
 * unref'd, so a process it started outside the group cannot keep this one
 * running.
 */
export function release(child: ChildProcess): void {
  processGroupSeams.onRelease(child);
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/**
 * At the timeout: SIGTERM to the group, SIGKILL after the grace period, and
 * after one more grace period `giveUp` settles the caller even if something
 * still holds the pipes open. Returns the canceller for a settled run.
 */
export function escalate(child: ChildProcess, timeoutMs: number, graceMs: number, onTimeout: () => void, giveUp: () => void): () => void {
  const timers: NodeJS.Timeout[] = [];
  // ISS-1469: one handle for the timers, the exit listener and the signal handler alike.
  const handle = groupHandle(child);
  const stopOnExit = (): void => signalGroup(child, "SIGKILL");
  process.once("exit", stopOnExit);
  trackGroup(child);
  timers.push(setTimeout(() => {
    onTimeout();
    signalGroup(child, "SIGTERM");
    timers.push(setTimeout(() => {
      signalGroup(child, "SIGKILL");
      timers.push(setTimeout(() => {
        handle.settle();
        giveUp();
      }, graceMs));
    }, graceMs));
  }, timeoutMs));
  return () => {
    handle.settle();
    for (const t of timers) clearTimeout(t);
    process.removeListener("exit", stopOnExit);
    untrackGroup(child);
  };
}

// --- A whole run, confirmed gone (T-538 S3a-2) ---------------------------------

/** How often, and for how long, a run polls for its group to be gone after the last signal. */
export const CONFIRM_POLL_MS = 50;
export const CONFIRM_BOUND_MS = 2000;

/**
 * Test seams, not reachable through any CLI or MCP input: the liveness probe
 * `kill(-pgid, 0)`, whether runs get their own group (false is the Windows
 * path, provable on any platform with a fake child), and spawn itself.
 */
export const processGroupSeams: {
  probe: (pgid: number) => void;
  /** ISS-1469: the raw group send, the only non-zero negative-pid kill. */
  send: (pgid: number, signal: NodeJS.Signals) => void;
  /** ISS-1469: `kill(leaderPid, 0)`, whose ESRCH says the leader has been reaped. */
  leader: (pid: number) => void;
  /** ISS-1469: called first thing in release(), so a row can signal while callbacks are released. */
  onRelease: (child: ChildProcess) => void;
  ownGroup: boolean;
  spawn: typeof spawn;
} = {
  probe: (pgid) => process.kill(-pgid, 0),
  send: (pgid, signal) => process.kill(-pgid, signal),
  leader: (pid) => process.kill(pid, 0),
  onRelease: () => {},
  ownGroup: OWN_GROUP,
  // Read at call time: a module-load capture breaks a test's partial node:child_process mock.
  spawn: ((...args: Parameters<typeof spawn>) => spawn(...args)) as typeof spawn,
};

/** "gone" on ESRCH, "alive" when the probe succeeds, and the error code for anything else (EPERM included). */
function probeGroup(pgid: number): "gone" | "alive" | string {
  try {
    processGroupSeams.probe(pgid);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : code ?? String(err);
  }
}

/**
 * T-538 commit 4: a group known only by its recorded id, with no child handle (the eval driver's sweep of the
 * groups a runner recorded, and its recovery after a restart). `signal` 0 is the probe; any other signal is the
 * raw group send. Both go through processGroupSeams. Throws what kill throws (ESRCH: the group is gone). The id
 * must be a real group id: 0, 1 and anything not an integer above 1 are refused, never sent.
 */
export function signalRecordedGroup(pgid: number, signal: NodeJS.Signals | 0): void {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`not a recorded process group id: ${pgid}`);
  if (signal === 0) processGroupSeams.probe(pgid);
  else processGroupSeams.send(pgid, signal);
}

/** T-538 commit 4: whether a recorded group may still exist: false only on ESRCH; EPERM and any other answer count as alive. */
export function recordedGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`not a recorded process group id: ${pgid}`);
  return probeGroup(pgid) !== "gone";
}

export interface GroupRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** From spawn until the group is confirmed gone. */
  readonly timeoutMs: number;
  readonly killGraceMs?: number;
  /** Both streams merged, for callers that do not tell them apart. */
  readonly onData?: (chunk: Buffer) => void;
  /** ISS-1457: stdout and stderr apart; each overrides onData for its stream. */
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
  /** ISS-1457: written to the leader's stdin, which is otherwise closed. Abandoned, not awaited, once the leader exits or is stopped. */
  readonly stdin?: Buffer;
  /**
   * ISS-1457: called once with the group id right after spawn, and the run's own group signal, the only
   * way a caller may signal the group (see GroupSignal). ISS-1469: and its probe, the way a caller polls it.
   */
  readonly onSpawn?: (pgid: number, signal: GroupSignal, probe: GroupProbe) => void;
  /** ISS-1457: called once when the leader's exit event fires, before anything else reacts to it. */
  readonly onLeaderExit?: () => void;
  /**
   * T-538 5.1: called once right after spawn with a stop the caller may ask for and the leader's stdin,
   * which is then a pipe. Mutually exclusive with `stdin`: both given is a spawn error.
   */
  readonly control?: (c: GroupControl) => void;
}

/** Queued stdin past which `write` answers false (the caller should wait), and past which the group is stopped. */
export const CONTROL_QUEUE_SOFT = 1 << 20;
export const CONTROL_QUEUE_HARD = 8 << 20;

/**
 * T-538 5.1: what a caller may do to a running group. `stop()` runs the deadline's own sequence (SIGTERM,
 * the grace, SIGKILL, confirmation) and is idempotent. `write` takes the chunk exactly once and never throws;
 * it answers false when more than 1 MiB is queued, and more than 8 MiB queued stops the group as
 * `stdin overflow`. A broken pipe, a write after exit and a write after `endInput()` are swallowed and
 * reported once on the result as `inputError`.
 */
export interface GroupControl {
  stop(): void;
  write(chunk: Buffer): boolean;
  endInput(): void;
}

/**
 * ISS-1457 round 2: every negative-pid signal a run in group sends, through the child's group handle
 * (ISS-1469, see GroupHandle for the guarantee and the accepted residual). Answers "sent", "released" once
 * the handle is disarmed, or the probe's or kill's answer when nothing was sent ("gone", or an error code
 * such as EPERM). A run that signalled after the leader's exit says so in GroupRun.signalledAfterLeaderExit.
 */
export type GroupSignal = (signal: NodeJS.Signals) => string;

/** ISS-1469: the run's own group probe, through the same handle: "alive", "gone" (which disarms the handle), or the error code. */
export type GroupProbe = () => "gone" | "alive" | string;

export interface GroupRun {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  /** Whether the whole group was seen gone (ESRCH) before the run settled; anything else is unconfirmed. */
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly cleanupDetail: string | null;
  /**
   * ISS-1457 round 3: present only when a signal went to the group after the leader's exit event, so the
   * accepted residual (see GroupSignal) is on the record: the group id and each signal, in order.
   */
  readonly signalledAfterLeaderExit?: { readonly pgid: number; readonly signals: readonly NodeJS.Signals[] };
  /** T-538 5.1: the first input problem of a run with `control` (`stdin overflow`, `write after exit`, `write after endInput`, or the pipe's error code); absent when there was none. */
  readonly inputError?: string;
}

/**
 * Runs `command` in its own process group with stdout and stderr merged into
 * `onData`, and settles only once the group is confirmed gone. When the
 * leader exits, whatever it left in the group is stopped (SIGTERM, SIGKILL
 * after the grace period). At the deadline, which runs from spawn until the
 * group is gone, the whole group is stopped the same way and the run is
 * marked timed out. After the last signal the group is polled every 50 ms
 * for at most 2 s; a group not seen gone (ESRCH) by the bound, whether the
 * probe still finds it or answers anything else (EPERM included), leaves the
 * cleanup unconfirmed.
 *
 * Without process groups (Windows) there is no group to probe: at the
 * deadline the child itself gets SIGTERM, SIGKILL after the grace period,
 * and the run settles when it has exited and closed, or after the same 2 s
 * bound, unconfirmed if it never exited.
 */
export function runInGroup(opts: GroupRunOptions): Promise<GroupRun> {
  const grace = opts.killGraceMs ?? KILL_GRACE_MS;
  const own = processGroupSeams.ownGroup;
  return new Promise((resolve) => {
    if (opts.stdin && opts.control) {
      resolve({ exitCode: null, signal: null, timedOut: false, spawnError: "stdin and control are mutually exclusive", cleanup: "confirmed", cleanupDetail: null });
      return;
    }
    let child: ChildProcess;
    try {
      child = processGroupSeams.spawn(opts.command, [...opts.args], { cwd: opts.cwd, env: opts.env, stdio: [opts.stdin || opts.control ? "pipe" : "ignore", "pipe", "pipe"], detached: own });
    } catch (e) {
      resolve({ exitCode: null, signal: null, timedOut: false, spawnError: (e as Error).message, cleanup: "confirmed", cleanupDetail: null });
      return;
    }
    // ISS-1469: created before any listener of this run, so its exit notice comes first.
    const handle = groupHandle(child, own);
    const timers: NodeJS.Timeout[] = [];
    const later = (fn: () => void, ms: number): void => { timers.push(setTimeout(fn, ms)); };
    let timedOut = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let exited = false;
    const afterExit: NodeJS.Signals[] = [];
    const groupSignal: GroupSignal = (sig) => {
      const outcome = handle.signal(sig);
      if (outcome === "sent" && exited && own) afterExit.push(sig);
      return outcome;
    };
    const stopOnExit = (): void => {
      groupSignal("SIGKILL");
    };
    process.once("exit", stopOnExit);
    trackGroup(child, stopOnExit);
    let closed = false;
    let phase: "running" | "terming" | "confirming" = "running";
    let settled = false;
    let inputError: string | null = null;
    let controlError: string | null = null;

    const finish = (r: Omit<GroupRun, "exitCode" | "signal" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      // ISS-1469: disarmed before any callback is released, so nothing released below can still signal.
      handle.settle();
      for (const t of timers) clearTimeout(t);
      process.removeListener("exit", stopOnExit);
      untrackGroup(child);
      child.stdin?.destroy();
      release(child);
      resolve({ exitCode, signal, timedOut, ...r, ...(controlError !== null ? { spawnError: controlError } : {}), ...(inputError !== null ? { inputError } : {}), ...(afterExit.length > 0 && child.pid !== undefined ? { signalledAfterLeaderExit: { pgid: child.pid, signals: [...afterExit] } } : {}) });
    };

    // After the last signal: poll for the group gone, then for the leader reaped and its pipes drained, within the bound.
    const confirm = (): void => {
      if (phase === "confirming") return;
      phase = "confirming";
      const pgid = child.pid!;
      const started = Date.now();
      let gone = false;
      let answer: string | null = null;
      const tick = (): void => {
        if (settled) return;
        if (!gone) {
          // Darwin answers EPERM for a group of just-killed zombies, so any other answer is polled through, never trusted.
          const seen = handle.probe();
          gone = seen === "gone";
          answer = seen === "gone" || seen === "alive" ? null : seen;
        }
        if (gone && exited && closed) return finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
        if (Date.now() - started >= CONFIRM_BOUND_MS) {
          // Every process in the group is gone; only a process outside it can still hold the pipes.
          if (gone && exited) return finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
          if (answer !== null) return finish({ spawnError: null, cleanup: "unconfirmed", cleanupDetail: `kill(-${pgid}, 0) answered ${answer} ${CONFIRM_BOUND_MS} ms after the last signal` });
          return finish({ spawnError: null, cleanup: "unconfirmed", cleanupDetail: `process group ${pgid} still present ${CONFIRM_BOUND_MS} ms after the last signal` });
        }
        later(tick, CONFIRM_POLL_MS);
      };
      tick();
    };

    const kill = (): void => {
      if (phase === "confirming") return;
      groupSignal("SIGKILL");
      confirm();
    };

    // No group (Windows): the child alone, SIGTERM then SIGKILL, then wait for it to exit and close within the bound. Never a negative-pid probe.
    const stopChild = (): void => {
      if (phase !== "running") return;
      phase = "terming";
      signalGroup(child, "SIGTERM", false);
      later(() => {
        if (settled) return;
        phase = "confirming";
        signalGroup(child, "SIGKILL", false);
        const started = Date.now();
        const tick = (): void => {
          if (settled) return;
          if (exited && closed) return finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
          if (Date.now() - started >= CONFIRM_BOUND_MS) {
            if (exited) return finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
            return finish({ spawnError: null, cleanup: "unconfirmed", cleanupDetail: `process ${child.pid} still running ${CONFIRM_BOUND_MS} ms after the last signal` });
          }
          later(tick, CONFIRM_POLL_MS);
        };
        tick();
      }, grace);
    };

    // SIGTERM, then SIGKILL after the grace period unless the group is gone first.
    const stop = (): void => {
      if (!own) return stopChild();
      if (phase !== "running") return;
      if (handle.probe() === "gone") return confirm();
      phase = "terming";
      // A group that does not answer alive after the leader's exit gets no signal at all: it is only confirmed.
      if (groupSignal("SIGTERM") !== "sent") return confirm();
      const started = Date.now();
      const wait = (): void => {
        if (phase !== "terming" || settled) return;
        if (handle.probe() === "gone") return confirm();
        if (Date.now() - started >= grace) return kill();
        later(wait, CONFIRM_POLL_MS);
      };
      later(wait, CONFIRM_POLL_MS);
    };

    // The deadline runs from spawn until the group is gone: at it, a stop already under way goes straight to SIGKILL.
    later(() => {
      timedOut = true;
      if (phase === "running") stop();
      else if (phase === "terming" && own) kill();
    }, opts.timeoutMs);

    const onOut = opts.onStdout ?? opts.onData ?? ((): void => {});
    const onErr = opts.onStderr ?? opts.onData ?? ((): void => {});
    child.stdout!.on("data", (c: Buffer) => onOut(c));
    child.stderr!.on("data", (c: Buffer) => onErr(c));
    if (child.pid !== undefined) opts.onSpawn?.(child.pid, groupSignal, handle.probe);
    // The control callback runs last, once every lifecycle listener is installed, so a throw cannot leave the group unwatched.
    let startControl: (() => void) | null = null;
    if (opts.control && child.pid !== undefined) {
      const input = child.stdin!;
      let ended = false;
      const report = (what: string): void => { if (inputError === null) inputError = what; };
      input.on("error", (e: NodeJS.ErrnoException) => report(e.code ?? e.message));
      const control: GroupControl = {
        stop: () => { if (!settled) stop(); },
        write: (chunk) => {
          try {
            if (exited || settled) { report("write after exit"); return false; }
            if (ended) { report("write after endInput"); return false; }
            if (input.destroyed) { report("write after exit"); return false; }
            input.write(chunk);
            if (input.writableLength > CONTROL_QUEUE_HARD) {
              report("stdin overflow");
              stop();
              return false;
            }
            return input.writableLength <= CONTROL_QUEUE_SOFT;
          } catch (e) {
            report(thrownText(e, true));
            return false;
          }
        },
        endInput: () => {
          if (ended) return;
          ended = true;
          try { input.end(); } catch { /* the pipe is already gone */ }
        },
      };
      const callback = opts.control;
      startControl = () => {
        try {
          callback(control);
        } catch (e) {
          controlError = `control: ${thrownText(e, false)}`;
          if (!settled) stop();
        }
      };
    }
    if (opts.stdin && child.stdin) {
      // A leader that exits before reading its input fails on its own; the write is never waited for.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }
    child.on("error", (e) => {
      // No process was started (a missing cwd or executable): nothing to stop.
      if (child.pid === undefined || !own) finish({ spawnError: e.message, cleanup: "confirmed", cleanupDetail: null });
    });
    child.on("close", () => {
      closed = true;
      if (!own && exited) finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
    });
    child.on("exit", (code, sig) => {
      // First, so no signal from here on, including one the caller sends from onLeaderExit, skips the probe.
      exited = true;
      opts.onLeaderExit?.();
      child.stdin?.destroy();
      exitCode = code;
      signal = sig;
      // Whatever the leader left behind in its group is stopped.
      if (own && phase === "running") stop();
      else if (!own && closed) finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
    });
    startControl?.();
  });
}

/** A thrown value as text, never dereferencing what may be null, undefined, a string or an object whose own accessors throw. */
function thrownText(e: unknown, preferCode: boolean): string {
  try {
    if (e instanceof Error) {
      const code = preferCode ? (e as NodeJS.ErrnoException).code : undefined;
      return typeof code === "string" ? code : String(e.message);
    }
    return String(e);
  } catch {
    return "an unprintable value";
  }
}

// --- An owned group around a body (T-538 S3b) ----------------------------------

/** Why no owned group can be run here, or null: Windows has no process group to own, so BUILD and VERIFY are unsupported there. */
export function ownedGroupUnsupported(): string | null {
  return processGroupSeams.ownGroup ? null : "this platform has no process groups to own (Windows)";
}

export interface OwnedGroupOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** From the first signal of the stop until SIGKILL. */
  readonly shutdownTimeoutMs: number;
  readonly onData: (chunk: Buffer) => void;
}

/** The group while the body runs: its pgid, captured at spawn, and the leader's exit as it happens. */
export interface OwnedGroup {
  readonly pgid: number;
  /** The leader's exit, or null while it runs. */
  exited(): { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  /** Settles when the leader exits. */
  readonly exit: Promise<void>;
  /** Whether a pid in the group outlived the leader, seen at the leader's exit; null while the leader runs. */
  leftAtLeaderExit(): boolean | null;
  /** Whether any pid in the group is alive now: "alive", "gone", or the probe's other answer. */
  probe(): "gone" | "alive" | string;
}

export type OwnedGroupRun<T> =
  | { readonly kind: "spawn-error"; readonly reason: string }
  | {
      readonly kind: "ran";
      readonly value: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
      readonly cleanup: "confirmed" | "unconfirmed";
      readonly cleanupDetail: string | null;
    };

/**
 * Spawns `command` in its own process group, captures the pgid, and runs
 * `body` with it. Whatever the body does or throws, an unconditional finally
 * stops the group: nothing when the probe already finds it gone, otherwise
 * SIGTERM to `-pgid`, SIGKILL once `shutdownTimeoutMs` passes with the group
 * still present, then a bounded confirmation (every 50 ms for at most 2 s)
 * that `kill(-pgid, 0)` answers ESRCH. The group is followed by its pgid,
 * never by whether the leader lives. While it is live the ISS-1391 signal
 * handler kills it if setup-verify itself is signalled. Callers check
 * `ownedGroupUnsupported()` first: on a platform without groups this throws.
 */
export async function runOwnedGroup<T>(opts: OwnedGroupOptions, body: (group: OwnedGroup) => Promise<T>): Promise<OwnedGroupRun<T>> {
  const unsupported = ownedGroupUnsupported();
  if (unsupported !== null) throw new Error(`runOwnedGroup: ${unsupported}`);
  let child: ChildProcess;
  try {
    child = processGroupSeams.spawn(opts.command, [...opts.args], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (e) {
    return { kind: "spawn-error", reason: (e as Error).message };
  }
  const started = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    child.once("spawn", () => resolve({ ok: true }));
    child.once("error", (e) => resolve({ ok: false, reason: e.message }));
  });
  if (!started.ok || child.pid === undefined) {
    release(child);
    return { kind: "spawn-error", reason: started.ok ? "no process id" : started.reason };
  }
  const pgid = child.pid;
  // ISS-1469: every signal and probe of this group, the body's included, goes through one handle.
  const handle = groupHandle(child, true);
  const stopOnExit = (): void => signalGroup(child, "SIGKILL", true);
  process.once("exit", stopOnExit);
  trackGroup(child);
  child.stdout!.on("data", (c: Buffer) => opts.onData(c));
  child.stderr!.on("data", (c: Buffer) => opts.onData(c));

  let leaderExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let leftOver: boolean | null = null;
  const exit = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      // The leader is reaped by now, so a pid the probe still finds is one it left behind (EPERM, darwin's answer for a group of zombies, counts too).
      leftOver = handle.probe() !== "gone";
      leaderExit = { code, signal };
      resolve();
    });
  });
  const group: OwnedGroup = {
    pgid,
    exited: () => leaderExit,
    exit,
    leftAtLeaderExit: () => leftOver,
    probe: () => handle.probe(),
  };

  // Whatever the body returns or throws, the stop below runs: the body's outcome is only held until then.
  let value: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    value = { ok: true, value: await body(group) };
  } catch (error) {
    value = { ok: false, error };
  }
  const stopped = await stopOwned(child, handle, pgid, opts.shutdownTimeoutMs);
  handle.settle();
  process.removeListener("exit", stopOnExit);
  untrackGroup(child);
  release(child);
  return { kind: "ran", value, ...stopped };
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, SIGKILL after the shutdown timeout, then the bounded ESRCH confirmation. */
async function stopOwned(child: ChildProcess, handle: GroupHandle, pgid: number, shutdownTimeoutMs: number): Promise<{ cleanup: "confirmed" | "unconfirmed"; cleanupDetail: string | null }> {
  if (handle.probe() !== "gone") {
    handle.signal("SIGTERM");
    const termAt = Date.now();
    while (handle.probe() !== "gone" && Date.now() - termAt < shutdownTimeoutMs) await pause(CONFIRM_POLL_MS);
    if (handle.probe() !== "gone") handle.signal("SIGKILL");
  }
  const confirmAt = Date.now();
  let answer = handle.probe();
  while (answer !== "gone" && Date.now() - confirmAt < CONFIRM_BOUND_MS) {
    await pause(CONFIRM_POLL_MS);
    answer = handle.probe();
  }
  if (answer === "gone") return { cleanup: "confirmed", cleanupDetail: null };
  return {
    cleanup: "unconfirmed",
    cleanupDetail: answer === "alive"
      ? `process group ${pgid} still present ${CONFIRM_BOUND_MS} ms after the last signal`
      : `kill(-${pgid}, 0) answered ${answer} ${CONFIRM_BOUND_MS} ms after the last signal`,
  };
}
