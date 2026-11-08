/**
 * ISS-1457 (plan v3 section 6): the setup reviewer runs under a supervisor,
 * a separate node process in its own group, so the reviewer's group is
 * stopped even when the CLI that asked for the review dies. The CLI holds the
 * only write end of a pipe on the supervisor's fd 3 and never writes to it:
 * end of file there means the CLI is gone.
 *
 * Protocol, JSON lines: supervisor -> `ready` once fd 3 is watched; CLI ->
 * `start`; supervisor -> `started {pgid}`, then `stdout` and `stderr` chunks
 * (base64, each stream relayed up to RELAY_CAP_BYTES), then `completed`.
 * After `completed` the supervisor never signals that group again and exits.
 * End of file on fd 3 before `start` exits without spawning; after it, the
 * group gets SIGKILL and is polled until gone, then the supervisor exits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIRM_BOUND_MS, CONFIRM_POLL_MS, KILL_GRACE_MS, OWN_GROUP, runInGroup, type GroupRun } from "./process-group.js";

/** Each stream is relayed up to this many bytes; the rest is dropped and the run says so. */
export const RELAY_CAP_BYTES = 1024 * 1024;
export const SUPERVISOR_READY_MS = 5_000;
/** After `completed`, how long the supervisor may take to exit before it is stopped. */
const EXIT_BOUND_MS = 1_000;

export interface StartMessage {
  readonly type: "start";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** base64 */
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
}

export type SupervisorMessage =
  | { readonly type: "ready" }
  | { readonly type: "started"; readonly pgid: number }
  | { readonly type: "stdout" | "stderr"; readonly data: string }
  | { readonly type: "completed"; readonly run: GroupRun; readonly truncated: { readonly stdout: boolean; readonly stderr: boolean } };

// --- the supervisor's side ---------------------------------------------------------

function send(message: SupervisorMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * The supervisor process. STORYBLOQ_SUPERVISOR_SIGNAL_LOG is a test seam: the
 * CLI starts the supervisor with PATH alone, so no CLI or MCP input reaches it.
 */
export function supervisorMain(): void {
  const signalLog = process.env.STORYBLOQ_SUPERVISOR_SIGNAL_LOG;
  const record = (line: string): void => {
    if (signalLog) appendFileSync(signalLog, `${line}\n`);
  };
  let state: "waiting" | "running" | "done" = "waiting";
  let pgid: number | null = null;
  let leaving = false;

  const exitSoon = (): void => {
    setTimeout(() => process.exit(0), EXIT_BOUND_MS).unref();
    process.stdout.write("", () => process.exit(0));
  };

  // Idempotent: end, close, error on fd 3, and a terminating signal all land here.
  const cliGone = (): void => {
    if (leaving) return;
    if (state === "done") return;
    leaving = true;
    if (state === "waiting" || pgid === null) {
      record("exit-before-spawn");
      process.exit(0);
    }
    const group = pgid!;
    record(`SIGKILL -${group}`);
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      /* already gone */
    }
    const started = Date.now();
    const poll = (): void => {
      let gone = false;
      try {
        process.kill(-group, 0);
      } catch (e) {
        gone = (e as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (gone || Date.now() - started >= CONFIRM_BOUND_MS) {
        record(gone ? "group-gone" : "group-unconfirmed");
        process.exit(gone ? 0 : 1);
      }
      setTimeout(poll, CONFIRM_POLL_MS);
    };
    poll();
  };

  const live = new Socket({ fd: 3, readable: true, writable: false });
  live.on("end", cliGone);
  live.on("close", cliGone);
  live.on("error", cliGone);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, cliGone);
  // A write the CLI can no longer read (EPIPE) or a broken input is the CLI gone, never an unhandled crash
  // that would leave the group running.
  process.stdout.on("error", cliGone);
  process.stdin.on("error", cliGone);
  // Handlers first, then flowing, then ready: an end of file that arrived already is seen, never missed.
  live.resume();
  send({ type: "ready" });

  let buffered = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    if (state !== "waiting" || leaving) return;
    buffered += chunk;
    const nl = buffered.indexOf("\n");
    if (nl < 0) return;
    let start: StartMessage;
    try {
      start = JSON.parse(buffered.slice(0, nl)) as StartMessage;
      if (start.type !== "start") throw new Error("not a start");
    } catch {
      record("bad-start");
      process.exit(2);
    }
    state = "running";
    const sent = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    const relay = (stream: "stdout" | "stderr") => (chunk: Buffer): void => {
      const room = RELAY_CAP_BYTES - sent[stream];
      if (room <= 0) {
        truncated[stream] = true;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated[stream] = true;
      sent[stream] += part.length;
      send({ type: stream, data: part.toString("base64") });
    };
    void runInGroup({
      command: start.command, args: start.args, cwd: start.cwd, env: start.env, timeoutMs: start.timeoutMs, killGraceMs: start.killGraceMs,
      stdin: Buffer.from(start.stdin, "base64"), onStdout: relay("stdout"), onStderr: relay("stderr"),
      onSpawn: (id) => {
        pgid = id;
        send({ type: "started", pgid: id });
      },
    }).then((run) => {
      if (leaving) return;
      // Disarmed: the group is never signalled again from here.
      state = "done";
      pgid = null;
      record("completed");
      send({ type: "completed", run, truncated });
      exitSoon();
    });
  });
  process.stdin.on("end", () => {
    if (state === "waiting") cliGone();
  });
}

// --- the CLI's side -------------------------------------------------------------------

export interface SupervisedRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly spawnError: string | null;
  readonly cleanup: "confirmed" | "unconfirmed";
  readonly cleanupDetail: string | null;
  /** Set when the supervisor itself failed: no ready in time, or it exited before `completed`. */
  readonly supervisorError: string | null;
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };
}

/** Where the built supervisor is: beside the bundle, or, from the sources, in dist. */
export function supervisorEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "setup-review-supervisor.js"), join(here, "..", "..", "dist", "setup-review-supervisor.js")];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/** Test seams, not reachable through any CLI or MCP input. */
export const supervisorSeams: { entry: () => string; readyMs: number } = { entry: supervisorEntry, readyMs: SUPERVISOR_READY_MS };

function stopProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(OWN_GROUP ? -pid : pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

/**
 * Runs the reviewer under a fresh supervisor and settles with its result. No
 * reviewer starts outside it: a supervisor that does not say `ready` within
 * the bound is stopped and the run fails closed.
 */
export function runSupervised(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number; killGraceMs?: number }): Promise<SupervisedRun> {
  const grace = opts.killGraceMs ?? KILL_GRACE_MS;
  return new Promise((resolve) => {
    const entry = supervisorSeams.entry();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let diag = "";
    let pgid: number | null = null;
    let completed: Extract<SupervisorMessage, { type: "completed" }> | null = null;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];

    let sup: ChildProcess;
    try {
      if (!existsSync(entry)) throw new Error(`the supervisor is missing at ${entry}`);
      sup = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe", "pipe"], detached: OWN_GROUP, env: { PATH: process.env.PATH ?? "" } });
    } catch (e) {
      resolve(failed((e as Error).message));
      return;
    }

    function failed(why: string): SupervisedRun {
      return {
        exitCode: null, timedOut: false, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf-8"), spawnError: null,
        cleanup: "unconfirmed", cleanupDetail: null, supervisorError: why, truncated: { stdout: false, stderr: false },
      };
    }
    const finish = (r: SupervisedRun): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      resolve(r);
    };
    const failClosed = (why: string): void => {
      // The supervisor failed: stop it, and as a backstop the group it reported, which it can no longer stop.
      stopProcessGroup(sup.pid);
      if (pgid !== null && completed === null) stopProcessGroup(pgid);
      finish(failed(diag.trim() ? `${why} (${diag.trim().split("\n")[0]})` : why));
    };

    timers.push(setTimeout(() => failClosed(`no ready within ${supervisorSeams.readyMs} ms`), supervisorSeams.readyMs));
    // The outer bound: the run's own deadline, its stop, the confirmation poll, and room for the relay.
    timers.push(setTimeout(() => failClosed("no completion within the run's bound"), supervisorSeams.readyMs + opts.timeoutMs + 2 * grace + CONFIRM_BOUND_MS + 5_000));

    sup.stdin!.on("error", () => {});
    sup.stderr!.on("data", (c: Buffer) => {
      if (diag.length < 4096) diag += String(c);
    });
    let buffered = "";
    sup.stdout!.setEncoding("utf-8");
    sup.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        let msg: SupervisorMessage;
        try {
          msg = JSON.parse(line) as SupervisorMessage;
        } catch {
          return failClosed("an unreadable line from the supervisor");
        }
        if (msg.type === "ready") {
          clearTimeout(timers[0]!);
          const start: StartMessage = {
            type: "start", command, args, cwd: opts.cwd, env: opts.env, stdin: Buffer.from(opts.input).toString("base64"), timeoutMs: opts.timeoutMs, killGraceMs: grace,
          };
          sup.stdin!.end(`${JSON.stringify(start)}\n`);
        } else if (msg.type === "started") {
          pgid = msg.pgid;
        } else if (msg.type === "stdout") {
          out.push(Buffer.from(msg.data, "base64"));
        } else if (msg.type === "stderr") {
          err.push(Buffer.from(msg.data, "base64"));
        } else if (msg.type === "completed") {
          completed = msg;
          const r = msg.run;
          finish({
            exitCode: r.exitCode, timedOut: r.timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf-8"), spawnError: r.spawnError,
            cleanup: r.cleanup, cleanupDetail: r.cleanupDetail, supervisorError: null, truncated: msg.truncated,
          });
          // Disarmed and leaving; stopped only if it overstays.
          const overstay = setTimeout(() => stopProcessGroup(sup.pid), EXIT_BOUND_MS * 2);
          overstay.unref();
          sup.once("exit", () => clearTimeout(overstay));
        }
      }
    });
    sup.on("error", (e) => failClosed(`the supervisor could not start: ${e.message}`));
    sup.on("exit", (code, signal) => {
      if (completed === null) failClosed(`the supervisor exited before the review completed (${signal ?? `status ${code}`})`);
    });
  });
}
