// T-538 S5b-0 commit 6a: the fake transport (plan v10 section 8, "Production against test"). Tests pass
// it to runAttempt directly; nothing under scripts/ imports it, and no option, env var or argument
// reaches it. Its "container" is a host folder standing for /vol/att, kept outside the attempt's host
// root, so a direct host read of a project path finds nothing. Every exec is recorded with its argv, env
// and cwd, so a test can prove what each step was given (fault isolation).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { liveTry, runOp } from "../../scripts/eval-helper.js";
import type { StepResult } from "../../scripts/onboarding-eval-lifecycle.js";
import { parsePackRecords } from "../../scripts/onboarding-eval-reader.js";
import { ALLOWED_ENV, type AttemptPath, asAttemptPath, type ExecResult, type ExecSpec, type ExecTransport, HelperDefect, type LiveCapture, type PackRequest, type PackResult } from "../../scripts/onboarding-eval-transport.js";

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
  /** Exit status a command gets instead of running: a test's stand-in for the client binary. */
  readonly stub?: (argv: readonly string[], env: Readonly<Record<string, string>>) => { readonly status: number; readonly stdout?: string; readonly stderr?: string } | null;
}

export interface FakeTransport extends ExecTransport {
  readonly calls: FakeCall[];
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
  const check = (spec: ExecSpec): void => {
    for (const k of Object.keys(spec.env)) if (!(ALLOWED_ENV as readonly string[]).includes(k)) throw new Error(`env key ${k} is not allowed`);
    if (spec.argv.length === 0 || !Number.isInteger(spec.timeoutSeconds) || spec.timeoutSeconds <= 0) throw new Error("a bad exec");
    asAttemptPath(spec.cwd);
  };
  const result = (spec: ExecSpec, status: number | null, signal: string | null, out: Buffer, err: Buffer): ExecResult => ({
    child: { status, signal }, timedOut: "no", cliStatus: status, outcome: "ok", stdinAccepted: spec.stdin?.length ?? 0,
    overLimit: out.length > spec.stdoutLimit ? "stdout" : err.length > spec.stderrLimit ? "stderr" : null,
    stdout: mapOut(out).subarray(0, spec.stdoutLimit), stderr: mapOut(err).subarray(0, spec.stderrLimit),
  });
  const env = (spec: ExecSpec): Record<string, string> => Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, mapIn(v)]));
  const run = (kind: "exec" | "stream", spec: ExecSpec, onLine: ((l: Buffer) => void) | null, signal?: AbortSignal): Promise<ExecResult> => {
    check(spec);
    calls.push({ kind, argv: [...spec.argv], cwd: spec.cwd, env: { ...spec.env } });
    const stubbed = o.stub?.(spec.argv, spec.env) ?? null;
    if (stubbed !== null) {
      const out = Buffer.from(stubbed.stdout ?? "");
      if (onLine !== null) for (const l of out.toString("utf8").split("\n").slice(0, -1)) onLine(Buffer.from(l));
      return Promise.resolve(result(spec, stubbed.status, null, out, Buffer.from(stubbed.stderr ?? "")));
    }
    return new Promise((res) => {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1).map(mapIn), { cwd: hostOf(spec.cwd), env: env(spec), stdio: [spec.stdin !== null ? "pipe" : "ignore", "pipe", "pipe"] });
      const outs: Buffer[] = [];
      const errs: Buffer[] = [];
      let pending = Buffer.alloc(0);
      const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutSeconds * 1000);
      signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
      child.stdout!.on("data", (d: Buffer) => {
        outs.push(d);
        if (onLine === null) return;
        pending = Buffer.concat([pending, d]);
        for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) { onLine(mapOut(pending.subarray(0, nl))); pending = pending.subarray(nl + 1); }
      });
      child.stderr!.on("data", (d: Buffer) => errs.push(d));
      child.stdin?.on("error", () => {});
      child.stdin?.end(spec.stdin);
      child.on("error", (e) => { clearTimeout(timer); res({ ...result(spec, null, null, Buffer.alloc(0), Buffer.from(String(e))), child: null, cliStatus: null, outcome: "ambiguous" }); });
      child.on("close", (status, sig) => { clearTimeout(timer); res(result(spec, status, sig, Buffer.concat(outs), Buffer.concat(errs))); });
    });
  };
  const helper = async (op: Parameters<ExecTransport["helper"]>[0], args: readonly string[]): Promise<unknown> => {
    calls.push({ kind: "helper", argv: [op, ...args], cwd: VOL, env: {} });
    const live = {
      pack: () => {
        const r = spawnSync("tar", ["--format", "pax", "-cf", "-", ".story"], { cwd: join(o.tree, "project") });
        return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
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
    async captureLive(readiness): Promise<LiveCapture> {
      calls.push({ kind: "helper", argv: ["capture-live", ...readiness.map((r) => JSON.stringify(r))], cwd: VOL, env: {} });
      const t = liveTry(join(o.tree, "project", ".story"), readiness, { pack: () => { const r = spawnSync("tar", ["--format", "pax", "-cf", "-", ".story"], { cwd: join(o.tree, "project") }); return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: Buffer.alloc(0) }; }, cli: () => ({ status: 0, stdout: "" }), outside: () => 0 });
      return { status: t.d1 === t.d2 ? "consistent" : "inconclusive", tries: 1, d1: t.d1, d2: t.d2, problems: t.problems, packExit: t.packExit, tar: Buffer.from(t.tarBase64, "base64"), records: parsePackRecords(Buffer.alloc(0)), readiness: t.readiness, outsideGroup: 0 };
    },
    async stop() { calls.push({ kind: "stop", argv: [], cwd: VOL, env: {} }); return o.stop?.() ?? { ok: true }; },
    async packFinal(r) { calls.push({ kind: "pack", argv: [r.profile], cwd: VOL, env: {} }); return o.pack?.(r) ?? { ok: false, reason: "the fake has no pack" }; },
    async remove() { calls.push({ kind: "remove", argv: [], cwd: VOL, env: {} }); return { left: o.left?.() ?? 0 }; },
  };
}
