// T-538 S5b-0 commit 6a: the fake transport (plan v10 section 8, "Production against test"). Tests pass
// it to runAttempt directly; nothing under scripts/ imports it, and no option, env var or argument
// reaches it. Its "container" is a host folder standing for /vol/att, kept outside the attempt's host
// root, so a direct host read of a project path finds nothing. Every exec is recorded with its argv, env
// and cwd, so a test can prove what each step was given (fault isolation).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type LiveIo, liveTry, runOp } from "../../scripts/eval-helper.js";
import type { StepResult } from "../../scripts/onboarding-eval-lifecycle.js";
import { type AttemptPath, asAttemptPath, captureLiveTries, checkExecSpec, type ExecResult, type ExecSpec, ExecStreams, type ExecTransport, HelperDefect, LINUX_SIGNALS, type LiveCapture, type PackRequest, type PackResult } from "../../scripts/onboarding-eval-transport.js";

export interface FakeCall {
  readonly kind: "exec" | "stream" | "helper" | "stop" | "pack" | "remove";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface FakeOptions {
  /** The folder that stands for /vol/att. */
  readonly tree: string;
  /** Scripted answers for the operations a fake cannot perform. */
  readonly stop?: () => StepResult;
  readonly pack?: (r: PackRequest) => PackResult;
  readonly left?: () => number;
  /**
   * What a command gives instead of running: a test's stand-in for the client binary. Its output goes
   * through the same stream limits as a real command's, and it exits `delayMs` later, so a timeout or a
   * cancel reaches it the same way.
   */
  readonly stub?: (argv: readonly string[], env: Readonly<Record<string, string>>) => FakeStub | null;
  /** How long a command the timeout has sent TERM to has before KILL; the envelope's is 30 s. */
  readonly killGraceMs?: number;
  /** Section 9's per-try operations, by try number from 1; the default packs the tree's ledger and answers the CLI with nothing. */
  readonly live?: (tryNo: number) => Partial<LiveIo>;
  /** The live capture's wait between tries; the default records it and resolves at once. */
  readonly wait?: (ms: number) => Promise<void>;
}

export interface FakeStub { readonly status: number; readonly stdout?: string | Buffer; readonly stderr?: string | Buffer; readonly delayMs?: number }

export interface FakeTransport extends ExecTransport {
  readonly calls: FakeCall[];
  /** Every wait the live capture asked for, in order. */
  readonly waits: number[];
  /** /vol/att/<rel> as a host path inside the fake's tree. */
  readonly hostOf: (p: AttemptPath | string) => string;
}

const VOL = "/vol/att";

export function makeFakeTransport(o: FakeOptions): FakeTransport {
  mkdirSync(join(o.tree, "project"), { recursive: true });
  const calls: FakeCall[] = [];
  const hostOf = (p: string): string => (p === VOL ? o.tree : p.startsWith(`${VOL}/`) ? join(o.tree, p.slice(VOL.length + 1)) : p);
  // Paths a command sees and prints are the container's, never the fake's folder.
  const mapIn = (v: string): string => v.split(VOL).join(o.tree);
  const real = realpathSync(o.tree);
  const mapOut = (b: Buffer): Buffer => Buffer.from(b.toString("utf8").split(real).join(VOL).split(o.tree).join(VOL));
  const env = (spec: ExecSpec): Record<string, string> => Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, mapIn(v)]));
  const grace = o.killGraceMs ?? 30_000;
  const waits: number[] = [];
  const wait = o.wait ?? (async (ms: number) => { waits.push(ms); });
  const tarLedger = (): ReturnType<LiveIo["pack"]> => {
    const r = spawnSync("tar", ["--format", "pax", "-cf", "-", ".story"], { cwd: join(o.tree, "project") });
    return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  /**
   * One exec, modelled on production's from runAttempt's side: the same checks and the same per-stream
   * limits. A cut stream or a cancel kills the "CLI", so the result has no child and is ambiguous, as
   * production's is while the container runs. The timeout is the envelope's: TERM, then KILL after the
   * grace, with the child's signal and timedOut reported and the outcome ok.
   */
  const run = (kind: "exec" | "stream", spec: ExecSpec, onLine: ((l: Buffer) => void) | null, signal?: AbortSignal): Promise<ExecResult> => {
    checkExecSpec(spec);
    calls.push({ kind, argv: [...spec.argv], cwd: spec.cwd, env: { ...spec.env } });
    const stubbed = o.stub?.(spec.argv, spec.env) ?? null;
    return new Promise((res) => {
      let done = false;
      let cliKilled = false;
      let timedOut: "no" | "term" | "kill" = "no";
      const timers: NodeJS.Timeout[] = [];
      let stopChild: (sig: "SIGTERM" | "SIGKILL") => void = () => {};
      const settle = (status: number | null, sig: string | null): void => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        const shown = streams.err;
        const base = { overLimit: streams.overLimit(shown), stdout: mapOut(streams.out).subarray(0, spec.stdoutLimit), stderr: mapOut(shown).subarray(0, spec.stderrLimit) };
        if (cliKilled) res({ child: null, timedOut: null, cliStatus: null, outcome: "ambiguous", stdinAccepted: null, ...base });
        else res({ child: { status, signal: sig }, timedOut, cliStatus: sig !== null ? 128 + (LINUX_SIGNALS[sig] ?? 0) : status, outcome: "ok", stdinAccepted: spec.stdin?.length ?? 0, ...base });
      };
      let running = false;
      // As production's: a real command's result comes only once it has exited; a stub has nothing to wait for.
      const killCli = (): void => { if (done) return; cliKilled = true; stopChild("SIGKILL"); if (!running) settle(null, null); };
      const streams = new ExecStreams(spec, onLine === null ? null : (l) => onLine(mapOut(l)), killCli);
      const onAbort = (): void => killCli();
      if (signal?.aborted) { killCli(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      timers.push(setTimeout(() => {
        timedOut = "term";
        stopChild("SIGTERM");
        // A stub settles on TERM at once; a grace timer made after that would outlive the call.
        if (!done) timers.push(setTimeout(() => { timedOut = "kill"; stopChild("SIGKILL"); }, grace));
      }, spec.timeoutSeconds * 1000));
      if (stubbed !== null) {
        // A stub ends on TERM, as a well-behaved client does.
        stopChild = (sig) => { if (!cliKilled) settle(null, sig); };
        streams.stdout(Buffer.from(stubbed.stdout ?? ""));
        streams.stderr(Buffer.from(stubbed.stderr ?? ""));
        if (!done) timers.push(setTimeout(() => settle(stubbed.status, null), stubbed.delayMs ?? 0));
        return;
      }
      running = true;
      const child = spawn(spec.argv[0]!, spec.argv.slice(1).map(mapIn), { cwd: hostOf(spec.cwd), env: env(spec), detached: true, stdio: [spec.stdin !== null ? "pipe" : "ignore", "pipe", "pipe"] });
      // The envelope signals the child's whole group; so does the fake.
      stopChild = (sig) => { try { if (child.pid !== undefined) process.kill(-child.pid, sig); } catch { /* already gone */ } };
      child.stdout!.on("data", (d: Buffer) => streams.stdout(d));
      child.stderr!.on("data", (d: Buffer) => streams.stderr(d));
      child.stdin?.on("error", () => {});
      child.stdin?.end(spec.stdin);
      child.on("error", (e) => { streams.stderr(Buffer.from(String(e))); cliKilled = true; settle(null, null); });
      child.on("close", (status, sig) => settle(status, sig));
    });
  };
  const helper = async (op: Parameters<ExecTransport["helper"]>[0], args: readonly string[]): Promise<unknown> => {
    calls.push({ kind: "helper", argv: [op, ...args], cwd: VOL, env: {} });
    const live = {
      pack: tarLedger,
      cli: (argv: readonly string[]) => ({ status: 0, stdout: mapOut(Buffer.from(JSON.stringify(argv))).toString("utf8") }),
      outside: () => 0,
    };
    try {
      return JSON.parse(mapOut(Buffer.from(JSON.stringify(runOp(op, args.map(mapIn), live)) ?? "null")).toString("utf8")) as unknown;
    } catch (e) {
      throw new HelperDefect(`helper ${op}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    calls,
    waits,
    hostOf,
    exec: (spec, signal) => run("exec", spec, null, signal),
    execStream: (spec, onLine, signal) => run("stream", spec, onLine, signal),
    inspect: () => ({ State: { Running: true, Status: "running" } }),
    daemonProblem: () => null,
    helper,
    async readBytes(path, limit) {
      const a = (await helper("read-bytes", [asAttemptPath(path), String(limit)])) as { absent?: true; refused?: string; base64?: string };
      if (a.absent === true) return null;
      if (a.refused !== undefined) throw new HelperDefect(`read ${path}: ${a.refused}`);
      return Buffer.from(a.base64 ?? "", "base64");
    },
    captureLive(readiness): Promise<LiveCapture> {
      calls.push({ kind: "helper", argv: ["capture-live", ...readiness.map((r) => JSON.stringify(r))], cwd: VOL, env: {} });
      let tryNo = 0;
      // Production's retry and predicate; only the try is the fake's, on its own tree.
      return captureLiveTries(async () => {
        tryNo += 1;
        const io = o.live?.(tryNo) ?? {};
        return liveTry(join(o.tree, "project", ".story"), readiness, { pack: io.pack ?? tarLedger, cli: io.cli ?? (() => ({ status: 0, stdout: "" })), outside: io.outside ?? (() => 0) });
      }, wait);
    },
    async stop() { calls.push({ kind: "stop", argv: [], cwd: VOL, env: {} }); return o.stop?.() ?? { ok: true }; },
    async packFinal(r) { calls.push({ kind: "pack", argv: [r.profile], cwd: VOL, env: {} }); return o.pack?.(r) ?? { ok: false, reason: "the fake has no pack" }; },
    async remove() { calls.push({ kind: "remove", argv: [], cwd: VOL, env: {} }); return { left: o.left?.() ?? 0 }; },
  };
}
