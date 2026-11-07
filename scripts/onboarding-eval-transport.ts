// T-538 S5b-0: the seam between the host runner and a project (plan section 8). No caller until the
// conversion commit. This commit holds the exec half and inspect; the helper, copy-out and stop
// operations join with the commits that own them.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export type AttemptPath = string & { __brand: "attempt" };
export function asAttemptPath(p: string): AttemptPath {
  if (!(p === "/vol/att" || p.startsWith("/vol/att/")) || p.split("/").includes("..")) throw new Error("not a path under /vol/att");
  return p as AttemptPath;
}

export const ALLOWED_ENV = ["HOME", "CODEX_HOME", "TMPDIR", "PATH", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_SETUP_REVIEW_DIR", "STORYBLOQ_EVAL_EVENTS", "STORYBLOQ_EVAL_FAULT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] as const;
export const STDIN_LIMIT = 16 * 1048576;
export const WATCHDOG_MARGIN_SECONDS = 60;

export interface ExecSpec {
  readonly argv: readonly string[];
  readonly cwd: AttemptPath;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: Buffer | null;
  readonly timeoutSeconds: number;
  readonly stdoutLimit: number;
  readonly stderrLimit: number;
}
export type Outcome = "ok" | "container-gone" | "ambiguous";
export interface EnvelopeLine {
  readonly status: number | null;
  readonly signal: string | null;
  readonly timedOut: "no" | "term" | "kill";
  readonly stdinAccepted: number;
}
export interface ExecResult {
  readonly child: { readonly status: number | null; readonly signal: string | null } | null;
  readonly timedOut: "no" | "term" | "kill" | null;
  readonly cliStatus: number | null;
  readonly outcome: Outcome;
  readonly stdinAccepted: number | null;
  readonly overLimit: "stdout" | "stderr" | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}
export interface ExecTransport {
  execSync(spec: ExecSpec): ExecResult;
  execStream(spec: ExecSpec, onLine: (line: Buffer) => void): Promise<ExecResult>;
  inspect(): unknown;
  /** Null when the daemon's id equals the manifest's, else why not. */
  daemonProblem(expected: string): string | null;
}

/** The container's numbers: the host's own table differs (SIGUSR1 is 30 on macOS). */
export const LINUX_SIGNALS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31 };

/** The envelope's line only if it is the last thing on stderr, for this exec; the rest stays as it was. */
export function parseEnvelopeLine(stderr: Buffer, execId: string): { readonly line: EnvelopeLine; readonly rest: Buffer } | null {
  const marker = Buffer.from(`\0EVAL-ENVELOPE ${execId} `);
  const at = stderr.lastIndexOf(marker);
  if (at < 0 || stderr[stderr.length - 1] !== 0x0a) return null;
  const text = stderr.toString("utf8", at + marker.length, stderr.length - 1);
  if (text.includes("\n")) return null;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
  const v = o as Partial<EnvelopeLine>;
  const statusOk = v.status === null || (Number.isInteger(v.status) && (v.status as number) >= 0 && (v.status as number) <= 255);
  const signalOk = v.signal === null || (typeof v.signal === "string" && Object.hasOwn(LINUX_SIGNALS, v.signal));
  if (!statusOk || !signalOk || (v.status === null) === (v.signal === null) || !["no", "term", "kill"].includes(v.timedOut as string) || !Number.isSafeInteger(v.stdinAccepted) || (v.stdinAccepted as number) < 0) return null;
  return { line: v as EnvelopeLine, rest: stderr.subarray(0, at) };
}

export const lineAgrees = (line: EnvelopeLine, cliStatus: number | null): boolean => cliStatus === (line.signal !== null ? 128 + LINUX_SIGNALS[line.signal]! : line.status);

/** Section 8's rule, never resolved by exit number. `running` is null when inspect itself failed. */
export function decideOutcome(line: EnvelopeLine | null, cliStatus: number | null, running: () => boolean | null): Outcome {
  if (line !== null) return lineAgrees(line, cliStatus) ? "ok" : "ambiguous";
  return running() === false ? "container-gone" : "ambiguous";
}

export const DOCKER_EXE = "/Applications/Docker.app/Contents/Resources/bin/docker";
export const DOCKER_ENDPOINT = "unix:///Users/amirshayegh/.docker/run/docker.sock";

export interface DockerConfig {
  readonly exe: string;
  readonly endpoint: string;
  /** A scratch HOME and an empty config folder: nothing of the host's Docker setup applies. */
  readonly home: string;
  readonly configDir: string;
  readonly containerId: string;
  /** The host watchdog's margin past the envelope's own timeout; only a test shortens it. */
  readonly watchdogMarginSeconds?: number;
}

const launchFailure = (e: Error): Buffer => Buffer.from(`docker did not run to its end: ${(e as NodeJS.ErrnoException).code ?? e.message}\n`);

export function makeDockerTransport(c: DockerConfig): ExecTransport {
  if (!/^[0-9a-f]{64}$/.test(c.containerId)) throw new Error("a container is addressed by its 64-hex id, never its name");
  const env = { PATH: "/usr/bin:/bin", HOME: c.home };
  const margin = c.watchdogMarginSeconds ?? WATCHDOG_MARGIN_SECONDS;
  const base = ["--config", c.configDir, "--host", c.endpoint];
  const cli = (args: readonly string[]) => spawnSync(c.exe, [...base, ...args], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1048576 });
  const inspectNow = (): { readonly running: boolean | null; readonly doc: unknown } => {
    const r = cli(["inspect", "--type", "container", c.containerId]);
    if (r.status !== 0) return { running: /No such (container|object)/i.test(r.stderr ?? "") ? false : null, doc: null };
    const doc = (JSON.parse(r.stdout) as { State: { Running: boolean } }[])[0]!;
    return { running: doc.State.Running, doc };
  };
  const argsFor = (spec: ExecSpec, execId: string): string[] => {
    for (const k of Object.keys(spec.env)) if (!(ALLOWED_ENV as readonly string[]).includes(k)) throw new Error(`env key ${k} is not allowed`);
    if (spec.stdin !== null && spec.stdin.length > STDIN_LIMIT) throw new Error("stdin over the limit");
    if (spec.argv.length === 0 || !Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds <= 0) throw new Error("a bad exec");
    return [...base, "exec", ...(spec.stdin !== null ? ["-i"] : []), "-w", asAttemptPath(spec.cwd), ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), c.containerId, "node", "/opt/eval/envelope.mjs", execId, String(spec.timeoutSeconds), "--", ...spec.argv];
  };
  const result = (spec: ExecSpec, execId: string, cliStatus: number | null, out: Buffer, err: Buffer, cutOff: "stdout" | "stderr" | null): ExecResult => {
    const parsed = parseEnvelopeLine(err, execId);
    const shown = parsed?.rest ?? err;
    const overLimit = cutOff ?? (out.length > spec.stdoutLimit ? "stdout" : shown.length > spec.stderrLimit ? "stderr" : null);
    return {
      child: parsed === null ? null : { status: parsed.line.status, signal: parsed.line.signal },
      timedOut: parsed?.line.timedOut ?? null,
      cliStatus,
      outcome: decideOutcome(parsed?.line ?? null, cliStatus, () => inspectNow().running),
      stdinAccepted: parsed?.line.stdinAccepted ?? null,
      overLimit,
      stdout: out.subarray(0, spec.stdoutLimit),
      stderr: shown.subarray(0, spec.stderrLimit),
    };
  };
  return {
    execSync(spec) {
      const execId = randomUUID();
      const r = spawnSync(c.exe, argsFor(spec, execId), { env, input: spec.stdin ?? undefined, stdio: [spec.stdin !== null ? "pipe" : "ignore", "pipe", "pipe"], timeout: (spec.timeoutSeconds + margin) * 1000, maxBuffer: Math.max(spec.stdoutLimit, spec.stderrLimit + 4096) + 1 });
      const err = r.stderr ?? Buffer.alloc(0);
      return result(spec, execId, r.status, r.stdout ?? Buffer.alloc(0), r.status === null && r.error ? Buffer.concat([err, launchFailure(r.error)]) : err, null);
    },
    execStream(spec, onLine) {
      const execId = randomUUID();
      const args = argsFor(spec, execId);
      const failed = (e: Error): ExecResult => result(spec, execId, null, Buffer.alloc(0), launchFailure(e), null);
      let child;
      try { child = spawn(c.exe, args, { env, stdio: [spec.stdin !== null ? "pipe" : "ignore", "pipe", "pipe"] }); } catch (e) { return Promise.resolve(failed(e as Error)); }
      const outs: Buffer[] = [];
      const errs: Buffer[] = [];
      let outSize = 0;
      let errSize = 0;
      let cutOff: "stdout" | "stderr" | null = null;
      let pending = Buffer.alloc(0);
      const stopReading = (which: "stdout" | "stderr"): void => { cutOff ??= which; child.stdout?.destroy(); child.stderr?.destroy(); child.kill("SIGKILL"); };
      const watchdog = setTimeout(() => child.kill("SIGKILL"), (spec.timeoutSeconds + margin) * 1000);
      child.stdout?.on("data", (d: Buffer) => {
        outs.push(d);
        outSize += d.length;
        if (outSize > spec.stdoutLimit) return stopReading("stdout");
        pending = Buffer.concat([pending, d]);
        for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) { onLine(pending.subarray(0, nl)); pending = pending.subarray(nl + 1); }
      });
      child.stderr?.on("data", (d: Buffer) => {
        errs.push(d);
        errSize += d.length;
        if (errSize > spec.stderrLimit + 4096) stopReading("stderr");
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(spec.stdin);
      return new Promise((res) => {
        let settled = false;
        const settle = (status: number | null, extra: Buffer | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          res(result(spec, execId, status, Buffer.concat(outs), Buffer.concat(extra === null ? errs : [...errs, extra]), cutOff));
        };
        // A docker that could not start: no status, its reason kept as evidence.
        child.on("error", (e) => settle(null, launchFailure(e)));
        child.on("close", (status) => settle(status, null));
      });
    },
    inspect: () => inspectNow().doc,
    daemonProblem(expected) {
      const r = cli(["info", "--format", "{{.ID}}"]);
      if (r.status !== 0) return "the daemon did not answer";
      return r.stdout.trim() === expected ? null : "the daemon is not the manifest's";
    },
  };
}

export const Transport = {
  /** The only route `main()` will have: the exact executable and endpoint, never from PATH or the environment. */
  production: (o: { readonly home: string; readonly configDir: string; readonly containerId: string }): ExecTransport => makeDockerTransport({ ...o, exe: DOCKER_EXE, endpoint: DOCKER_ENDPOINT }),
};
