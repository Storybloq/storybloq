/**
 * ISS-1376: the process-tree teardown shared by the health MCP probe
 * (`health/deps.ts`) and the autonomous test baseline
 * (`autonomous/test-baseline.ts`). Moved out of health/deps.ts unchanged in
 * logic; every constant and global it used is now an option, and each caller
 * passes all of them explicitly.
 */
import type { ChildProcess } from "node:child_process";

/** What the win32 tree kill returns: only its `error` event is observed. */
export interface TaskkillHandle {
  once(event: "error", listener: (err: Error) => void): unknown;
}

export interface TeardownTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TeardownOptions {
  readonly platform: NodeJS.Platform;
  /** How long SIGTERM is given before the first SIGKILL. */
  readonly termGraceMs: number;
  /** Interval between group checks (and SIGKILL resends) after the grace. */
  readonly pollMs: number;
  /** The wait ends unconfirmed this long after the teardown started. */
  readonly maxWaitMs: number;
  /** `process.kill` in production. */
  readonly killFn: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  /** Runs `taskkill /T /F /PID <pid>` in production. */
  readonly runTaskkill: (pid: number) => TaskkillHandle;
  readonly timers: TeardownTimers;
  /** Unref a child whose exit was not confirmed, so it cannot keep the host alive. */
  readonly unrefOnUnconfirmed: boolean;
}

export interface TeardownResult {
  /** The direct child exited and no process is left in its group. */
  readonly confirmed: boolean;
}

/** The production win32 tree kill. */
export function spawnTaskkill(spawnFn: typeof import("node:child_process").spawn): (pid: number) => TaskkillHandle {
  return (pid) => spawnFn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
}

/** The production timers. */
export const realTimers: TeardownTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Idempotent: safe to call whether or not the child already exited. The
 * direct child's exit is NOT proof of cleanup: a detached launcher (npx)
 * can die on SIGTERM while a descendant in its process group ignores it.
 * On POSIX the group's liveness is checked independently (signal 0 to the
 * group) and SIGKILL is re-sent to the group on every poll until the group
 * is gone or `maxWaitMs` elapse. On win32 `taskkill /T /F` kills the
 * tree and the direct child's exit is the only observable, so that is what
 * is awaited there. Nothing here blocks the event loop.
 */
export function teardownProcessTree(child: ChildProcess, alreadyExited: boolean, opts: TeardownOptions): Promise<TeardownResult> {
  const { platform, killFn, timers } = opts;
  for (const s of [child.stdin, child.stdout, child.stderr]) {
    try {
      s?.removeAllListeners("data");
      s?.destroy();
    } catch {
      // already closed
    }
  }
  if (child.pid === undefined) return Promise.resolve({ confirmed: true });
  const pid = child.pid;
  const childExited = (): boolean => alreadyExited || child.exitCode !== null || child.signalCode !== null;
  const groupAlive = (): boolean => {
    if (platform === "win32") return false;
    try {
      killFn(-pid, 0);
      return true;
    } catch (err: unknown) {
      // ESRCH: no such group. EPERM: something in the group still exists.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const gone = (): boolean => childExited() && !groupAlive();
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (platform === "win32") {
        const tk = opts.runTaskkill(pid);
        tk.once("error", () => {
          try {
            child.kill(signal);
          } catch {
            // gone
          }
        });
      } else {
        killFn(-pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // gone
      }
    }
  };
  if (gone()) return Promise.resolve({ confirmed: true });
  return new Promise<TeardownResult>((done) => {
    let finished = false;
    // The pending timer stays REFERENCED: once the direct child has exited
    // it may be the only handle keeping the event loop alive, and a pending
    // promise alone does not. An unref'd timer here would let the process
    // exit before the SIGKILL that the group still needs.
    let timer: unknown = null;
    const end = (confirmed: boolean): void => {
      if (finished) return;
      finished = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      child.removeListener("exit", onExit);
      if (!confirmed && opts.unrefOnUnconfirmed) {
        try {
          child.unref();
        } catch {
          // already released
        }
      }
      done({ confirmed });
    };
    // The direct child's exit alone ends the wait only when nothing else in
    // the group is left; otherwise the poll below keeps killing the group.
    const onExit = (): void => {
      if (!groupAlive()) end(true);
    };
    child.once("exit", onExit);
    kill("SIGTERM");
    const started = Date.now();
    const poll = (): void => {
      timer = null;
      if (finished) return;
      if (gone()) return end(true);
      if (Date.now() - started >= opts.maxWaitMs) return end(false);
      kill("SIGKILL");
      timer = timers.setTimeout(poll, opts.pollMs);
    };
    timer = timers.setTimeout(() => {
      timer = null;
      if (finished) return;
      if (gone()) return end(true);
      kill("SIGKILL");
      timer = timers.setTimeout(poll, opts.pollMs);
    }, opts.termGraceMs);
  });
}
