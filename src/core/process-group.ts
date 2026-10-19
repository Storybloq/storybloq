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
  try {
    if (own && child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already gone */
  }
}

/**
 * ISS-1391: a signal's default action ends the CLI without running "exit"
 * listeners, so while any group is live each terminating signal has a handler
 * that kills every live group first. It is prepended, so it decides before the
 * caller's own listeners run: a caller that listens for the signal owns the
 * exit; otherwise the signal is raised again and ends the CLI as it would have.
 */
const liveGroups = new Set<ChildProcess>();
const STOP_SIGNALS: NodeJS.Signals[] = OWN_GROUP ? ["SIGINT", "SIGTERM", "SIGHUP"] : ["SIGINT", "SIGTERM"];
const stopHandlers = new Map<NodeJS.Signals, () => void>();

function stopGroupsOnSignal(sig: NodeJS.Signals): void {
  const ours = stopHandlers.get(sig);
  const others = process.listeners(sig).some((l) => l !== ours);
  for (const child of liveGroups) signalGroup(child, "SIGKILL");
  liveGroups.clear();
  removeStopHandlers();
  if (!others) process.kill(process.pid, sig);
}

function removeStopHandlers(): void {
  for (const [sig, handler] of stopHandlers) process.removeListener(sig, handler);
  stopHandlers.clear();
}

export function trackGroup(child: ChildProcess): void {
  if (liveGroups.size === 0) {
    for (const sig of STOP_SIGNALS) {
      const handler = (): void => stopGroupsOnSignal(sig);
      stopHandlers.set(sig, handler);
      process.prependListener(sig, handler);
    }
  }
  liveGroups.add(child);
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
  const stopOnExit = (): void => signalGroup(child, "SIGKILL");
  process.once("exit", stopOnExit);
  trackGroup(child);
  timers.push(setTimeout(() => {
    onTimeout();
    signalGroup(child, "SIGTERM");
    timers.push(setTimeout(() => {
      signalGroup(child, "SIGKILL");
      timers.push(setTimeout(giveUp, graceMs));
    }, graceMs));
  }, timeoutMs));
  return () => {
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
export const processGroupSeams: { probe: (pgid: number) => void; ownGroup: boolean; spawn: typeof spawn } = {
  probe: (pgid) => process.kill(-pgid, 0),
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

export interface GroupRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** From spawn until the group is confirmed gone. */
  readonly timeoutMs: number;
  readonly killGraceMs?: number;
  readonly onData: (chunk: Buffer) => void;
}

export interface GroupRun {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  /** Whether the whole group was seen gone (ESRCH) before the run settled; anything else is unconfirmed. */
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly cleanupDetail: string | null;
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
    let child: ChildProcess;
    try {
      child = processGroupSeams.spawn(opts.command, [...opts.args], { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: own });
    } catch (e) {
      resolve({ exitCode: null, signal: null, timedOut: false, spawnError: (e as Error).message, cleanup: "confirmed", cleanupDetail: null });
      return;
    }
    const timers: NodeJS.Timeout[] = [];
    const later = (fn: () => void, ms: number): void => { timers.push(setTimeout(fn, ms)); };
    const stopOnExit = (): void => signalGroup(child, "SIGKILL", own);
    process.once("exit", stopOnExit);
    trackGroup(child);
    let timedOut = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let exited = false;
    let closed = false;
    let phase: "running" | "terming" | "confirming" = "running";
    let settled = false;

    const finish = (r: Omit<GroupRun, "exitCode" | "signal" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      process.removeListener("exit", stopOnExit);
      untrackGroup(child);
      release(child);
      resolve({ exitCode, signal, timedOut, ...r });
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
          const seen = probeGroup(pgid);
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
      signalGroup(child, "SIGKILL", own);
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
      if (probeGroup(child.pid!) === "gone") return confirm();
      phase = "terming";
      signalGroup(child, "SIGTERM", own);
      const started = Date.now();
      const wait = (): void => {
        if (phase !== "terming" || settled) return;
        if (probeGroup(child.pid!) === "gone") return confirm();
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

    child.stdout!.on("data", (c: Buffer) => opts.onData(c));
    child.stderr!.on("data", (c: Buffer) => opts.onData(c));
    child.on("error", (e) => {
      // No process was started (a missing cwd or executable): nothing to stop.
      if (child.pid === undefined || !own) finish({ spawnError: e.message, cleanup: "confirmed", cleanupDetail: null });
    });
    child.on("close", () => {
      closed = true;
      if (!own && exited) finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
    });
    child.on("exit", (code, sig) => {
      exited = true;
      exitCode = code;
      signal = sig;
      // Whatever the leader left behind in its group is stopped.
      if (own && phase === "running") stop();
      else if (!own && closed) finish({ spawnError: null, cleanup: "confirmed", cleanupDetail: null });
    });
  });
}
