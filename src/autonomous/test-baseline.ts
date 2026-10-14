/**
 * ISS-1376: the autonomous start's test baseline. One resolver decides how
 * long the baseline may run (stages.TEST / stages.WRITE_TESTS
 * `testTimeoutMs`), and one capture function runs it in its own process
 * tree, records why it failed when it did, and always cleans the tree up
 * through the teardown shared with the health probe.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  realTimers,
  spawnTaskkill,
  teardownProcessTree,
  type TaskkillHandle,
  type TeardownTimers,
} from "../core/process-tree.js";

export const DEFAULT_BASELINE_TIMEOUT_MS = 120_000;
export const MAX_BASELINE_TIMEOUT_MS = 3_600_000;
/** Per-stream capture limit. */
export const BASELINE_MAX_BUFFER = 5 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_CLEANUP_CAP_MS = 5000;
const DEFAULT_POLL_MS = 100;

export type BaselineTimeoutResolution =
  | { readonly ok: true; readonly timeoutMs: number; readonly note?: string }
  | { readonly ok: false; readonly message: string };

type StageRecord = Record<string, unknown> | undefined;

/**
 * The baseline timeout (plan section 1). Every applicable supplied value is
 * validated before any choice: WRITE_TESTS' value when WRITE_TESTS is on,
 * TEST's value when TEST is on or as WRITE_TESTS' fallback. An absent value
 * never takes part; the default applies only when nothing applicable was
 * supplied.
 */
export function resolveBaselineTimeout(
  stages: Record<string, StageRecord> | undefined,
  testEnabled: boolean,
  writeTestsEnabled: boolean,
): BaselineTimeoutResolution {
  const supplied = (stage: "TEST" | "WRITE_TESTS"): { present: boolean; value: unknown } => {
    const rec = stages?.[stage];
    if (rec === undefined || rec === null || typeof rec !== "object") return { present: false, value: undefined };
    const value = (rec as Record<string, unknown>).testTimeoutMs;
    return { present: value !== undefined, value };
  };
  const t = supplied("TEST");
  const w = supplied("WRITE_TESTS");
  const tApplicable = t.present && (testEnabled || writeTestsEnabled);
  const wApplicable = w.present && writeTestsEnabled;
  for (const [stage, entry, applicable] of [["WRITE_TESTS", w, wApplicable], ["TEST", t, tApplicable]] as const) {
    if (applicable && !isValidTimeout(entry.value)) {
      return {
        ok: false,
        message: `stages.${stage}.testTimeoutMs is ${JSON.stringify(entry.value) ?? String(entry.value)}; it must be a whole number of milliseconds from 1 to ${MAX_BASELINE_TIMEOUT_MS}.`,
      };
    }
  }
  const tv = tApplicable ? (t.value as number) : undefined;
  const wv = wApplicable ? (w.value as number) : undefined;
  if (writeTestsEnabled && !testEnabled) {
    return { ok: true, timeoutMs: wv ?? tv ?? DEFAULT_BASELINE_TIMEOUT_MS };
  }
  if (testEnabled && !writeTestsEnabled) {
    return { ok: true, timeoutMs: tv ?? DEFAULT_BASELINE_TIMEOUT_MS };
  }
  if (tv !== undefined && wv !== undefined) {
    if (tv === wv) return { ok: true, timeoutMs: tv };
    const larger = Math.max(tv, wv);
    return {
      ok: true,
      timeoutMs: larger,
      note: `TEST and WRITE_TESTS set different baseline timeouts (${tv} ms, ${wv} ms); using the larger, ${larger} ms.`,
    };
  }
  return { ok: true, timeoutMs: tv ?? wv ?? DEFAULT_BASELINE_TIMEOUT_MS };
}

function isValidTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_BASELINE_TIMEOUT_MS;
}

export type BaselineFailure = "timeout" | "maxBuffer" | "signal";

export type BaselineCapture =
  | {
      readonly kind: "ran";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly failure?: BaselineFailure;
      readonly signal: NodeJS.Signals | null;
      readonly cleanup?: "unconfirmed";
      readonly pid?: number;
    }
  | {
      readonly kind: "launchError";
      readonly code: string | null;
      readonly message: string;
      readonly cleanup?: "unconfirmed";
      readonly pid?: number;
    };

/** The child surface the capture uses; a real ChildProcess in production. */
export type BaselineSpawn = (command: string, options: {
  cwd: string;
  shell: true;
  detached: boolean;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: true;
}) => ChildProcess;

export interface CaptureOptions {
  readonly killGraceMs?: number;
  readonly cleanupCapMs?: number;
  readonly pollMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly killFn?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  readonly runTaskkill?: (pid: number) => TaskkillHandle;
  readonly spawnFn?: BaselineSpawn;
  readonly timers?: TeardownTimers;
}

/**
 * Run the baseline command in its own process tree (plan section 2b).
 * Resolves exactly once: on the leader's exit plus both streams closing,
 * on the end of the tree teardown once a timeout or an overflow started it,
 * or at once on a launch failure.
 */
export function captureTestBaseline(command: string, cwd: string, timeoutMs: number, opts: CaptureOptions = {}): Promise<BaselineCapture> {
  const platform = opts.platform ?? process.platform;
  const timers = opts.timers ?? realTimers;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const cleanupCapMs = opts.cleanupCapMs ?? DEFAULT_CLEANUP_CAP_MS;
  const spawnFn: BaselineSpawn = opts.spawnFn ?? ((cmd, o) => spawn(cmd, o));

  return new Promise<BaselineCapture>((resolve) => {
    let settled = false;
    let cause: "timeout" | "maxBuffer" | null = null;
    let terminating = false;
    let expiry: unknown = null;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let launchError: { code: string | null; message: string } | null = null;
    const closed = { stdout: false, stderr: false };
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let child: ChildProcess | null = null;

    const clearExpiry = (): void => {
      if (expiry !== null) timers.clearTimeout(expiry);
      expiry = null;
    };
    const setCause = (c: "timeout" | "maxBuffer"): void => {
      if (cause === null) cause = c;
    };
    const detach = (): void => {
      if (child === null) return;
      child.removeListener("exit", onExit);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.removeListener("close", onStdoutClose);
      child.stderr?.removeListener("close", onStderrClose);
      // The error listener stays: a later kill failure must not become an
      // unhandled "error" event.
    };
    const settle = (result: BaselineCapture): void => {
      if (settled) return;
      settled = true;
      clearExpiry();
      detach();
      resolve(result);
    };
    const teardown = (alreadyExited: boolean): Promise<{ confirmed: boolean }> =>
      teardownProcessTree(child!, alreadyExited, {
        platform,
        termGraceMs: killGraceMs,
        pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
        maxWaitMs: killGraceMs + cleanupCapMs,
        killFn: opts.killFn ?? ((pid, signal) => process.kill(pid, signal)),
        runTaskkill: opts.runTaskkill ?? spawnTaskkill(spawn),
        timers,
        unrefOnUnconfirmed: true,
      });
    const output = (): { stdout: string; stderr: string } => ({
      stdout: Buffer.concat(chunks.stdout).toString("utf-8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf-8"),
    });
    const ranResult = (cleanup: boolean): BaselineCapture => {
      const { stdout, stderr } = output();
      const signal = exited?.signal ?? null;
      const failure: BaselineFailure | undefined = cause ?? (signal !== null ? "signal" : undefined);
      return {
        kind: "ran",
        exitCode: typeof exited?.code === "number" ? exited.code : 1,
        stdout,
        stderr,
        signal,
        ...(failure ? { failure } : {}),
        ...(cleanup ? {} : { cleanup: "unconfirmed" as const }),
        ...(child?.pid !== undefined ? { pid: child.pid } : {}),
      };
    };
    const startTermination = (): void => {
      if (terminating || settled) return;
      terminating = true;
      clearExpiry();
      void teardown(exited !== null).then(({ confirmed }) => settle(ranResult(confirmed)));
    };
    const failLaunch = (err: unknown): void => {
      if (settled) return;
      const e = err as NodeJS.ErrnoException;
      launchError = { code: typeof e?.code === "string" ? e.code : null, message: e instanceof Error ? e.message : String(err) };
      clearExpiry();
      const report = launchError;
      if (child !== null && child.pid !== undefined && !terminating) {
        terminating = true;
        void teardown(exited !== null).then(({ confirmed }) =>
          settle({ kind: "launchError", ...report, ...(confirmed ? {} : { cleanup: "unconfirmed" as const }), pid: child!.pid }),
        );
        return;
      }
      if (child !== null) {
        for (const s of [child.stdout, child.stderr]) {
          try {
            s?.destroy();
          } catch {
            // already closed
          }
        }
      }
      settle({ kind: "launchError", ...report });
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (settled || cause === "maxBuffer") return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      const room = BASELINE_MAX_BUFFER - sizes[stream];
      if (buf.length > room) {
        if (room > 0) chunks[stream].push(buf.subarray(0, room));
        sizes[stream] = BASELINE_MAX_BUFFER;
        setCause("maxBuffer");
        startTermination();
        return;
      }
      chunks[stream].push(buf);
      sizes[stream] += buf.length;
    };
    const onStdout = (chunk: Buffer | string): void => collect("stdout", chunk);
    const onStderr = (chunk: Buffer | string): void => collect("stderr", chunk);
    const maybeFinish = (): void => {
      if (terminating || settled || launchError !== null) return;
      if (exited !== null && closed.stdout && closed.stderr) settle(ranResult(true));
    };
    const onStdoutClose = (): void => {
      closed.stdout = true;
      maybeFinish();
    };
    const onStderrClose = (): void => {
      closed.stderr = true;
      maybeFinish();
    };
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      exited = { code, signal };
      maybeFinish();
    }

    try {
      child = spawnFn(command, {
        cwd,
        shell: true,
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err: unknown) {
      failLaunch(err);
      return;
    }
    child.on("error", (err: Error) => {
      if (exited === null && !terminating) failLaunch(err);
    });
    child.once("exit", onExit);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdout?.once("close", onStdoutClose);
    child.stderr?.once("close", onStderrClose);
    if (!child.stdout) closed.stdout = true;
    if (!child.stderr) closed.stderr = true;
    if (settled) return;
    expiry = timers.setTimeout(() => {
      expiry = null;
      if (settled) return;
      setCause("timeout");
      startTermination();
    }, timeoutMs);
  });
}

/** Parsed counts from the baseline output, as the guide stored them before ISS-1376. */
export function parseBaselineCounts(combined: string, exitCode: number): { passCount: number; failCount: number } {
  const passMatch = combined.match(/(\d+)\s*pass/i);
  const failMatch = combined.match(/(\d+)\s*fail/i);
  const passCount = passMatch ? parseInt(passMatch[1]!, 10) : -1;
  // When all tests pass, vitest omits the fail line entirely. Treat missing fail count as 0
  // when exit code is 0 and passes were detected (runner succeeded, just no failures to report).
  const failCount = failMatch ? parseInt(failMatch[1]!, 10) : (exitCode === 0 && passCount > 0 ? 0 : -1);
  return { passCount, failCount };
}

/** The start's message for a baseline that did not complete (plan section 4). */
export function baselineFailureMessage(failure: BaselineFailure, timeoutMs: number, signal: NodeJS.Signals | null): string {
  switch (failure) {
    case "timeout":
      return `test baseline timed out after ${Math.round(timeoutMs / 1000)} s before the runner printed its summary; raise stages.WRITE_TESTS.testTimeoutMs (currently ${timeoutMs} ms) or stages.TEST.testTimeoutMs.`;
    case "maxBuffer":
      return "test baseline output passed the 5 MiB capture limit and the runner was stopped before its summary; reduce the reporter's output (for example a summary reporter) or disable WRITE_TESTS.";
    case "signal":
      return `test baseline was stopped by signal ${signal ?? "unknown"} before it finished; rerun the start when nothing else is stopping the test process.`;
  }
}

/** The start's warning when the tree teardown could not confirm every process ended. */
export function unconfirmedCleanupWarning(pid: number | undefined): string {
  return `test baseline processes may still be running (process group ${pid ?? "unknown"} did not confirm exit)`;
}

/** The TEST-only start's warning for a baseline that did not complete; the session still starts. */
export function testOnlyBaselineWarning(failure: BaselineFailure, timeoutMs: number, signal: NodeJS.Signals | null): string {
  switch (failure) {
    case "timeout":
      return `test baseline timed out after ${Math.round(timeoutMs / 1000)} s and is not used for comparison; raise stages.TEST.testTimeoutMs (currently ${timeoutMs} ms).`;
    case "maxBuffer":
      return "test baseline output passed the 5 MiB capture limit and is not used for comparison.";
    case "signal":
      return `test baseline was stopped by signal ${signal ?? "unknown"} and is not used for comparison.`;
  }
}
