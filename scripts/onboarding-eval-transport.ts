// T-538 S5b-0: the seam between the host runner and a project (plan section 8). No caller until the
// conversion commit. Commit 3 holds exec and inspect; commit 6a adds the helper's reads, the live capture,
// the stop, the final pack and the removal, each through the exact executable and endpoint.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, linkSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { HelperOp, LiveTry, ReadAnswer } from "./eval-helper.js";
import { packCreateArgs } from "./onboarding-eval-container.js";
import type { StepResult } from "./onboarding-eval-lifecycle.js";
import { PACK_RECORD_LIMIT, parsePackRecords, type PackProfile, type PackRecords } from "./onboarding-eval-reader.js";
import { PACK_LIMITS } from "./onboarding-eval-tar-gate.js";

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
/** A helper answer the runner cannot use: over its limit, malformed, or not ok. A harness defect, never evidence about the attempt. */
export class HelperDefect extends Error {}

export const HELPER_STDOUT_LIMIT = 64 * 1048576;
export const HELPER_TIMEOUT_SECONDS = 300;
const HELPER_ENV = { HOME: "/vol/att/home", PATH: "/usr/local/bin:/usr/bin:/bin" } as const;

export interface LiveCapture {
  /** Consistent: the ledger's digest was the same before and after one try whose pack exited 0 with no error record. */
  readonly status: "consistent" | "inconclusive";
  readonly tries: number;
  readonly d1: string;
  readonly d2: string;
  readonly problems: readonly string[];
  readonly packExit: number | null;
  readonly tar: Buffer;
  readonly records: PackRecords | { readonly refused: string };
  readonly readiness: LiveTry["readiness"];
  readonly outsideGroup: number;
}

export interface PackRequest {
  readonly image: string;
  readonly volume: string;
  readonly target: string;
  readonly profile: PackProfile;
  /** The host folder the tar is written in, as `<profile>.tar.part`, then published as `<profile>.tar`. */
  readonly rawDir: string;
  /** Called with the helper's id before it starts, so the attempt state can record it. */
  readonly onCreated: (helperId: string) => void;
  readonly timeoutMs: number;
}
export type PackResult =
  | { readonly ok: true; readonly tarPath: string; readonly sha256: string; readonly bytes: number; readonly records: PackRecords }
  | { readonly ok: false; readonly reason: string };

export interface ExecTransport {
  /** A harness step. Asynchronous so each stream stops at its own limit, as a turn's does. */
  exec(spec: ExecSpec, signal?: AbortSignal): Promise<ExecResult>;
  /** A cancel kills the docker CLI, as a limit does; the process inside is stopped only by stopping the attempt. */
  execStream(spec: ExecSpec, onLine: (line: Buffer) => void, signal?: AbortSignal): Promise<ExecResult>;
  inspect(): unknown;
  /** Null when the daemon's id equals the manifest's, else why not. */
  daemonProblem(expected: string): string | null;
  /** One file through the helper: no link followed, regular only; null when absent. A refusal throws. */
  readBytes(path: AttemptPath, limit: number): Promise<Buffer | null>;
  /** One helper operation's document; anything else throws HelperDefect. */
  helper(op: HelperOp, args: readonly string[]): Promise<unknown>;
  /** Section 9's consistency boundary over the project's ledger, retried twice, 2 s apart. */
  captureLive(readiness: readonly (readonly string[])[]): Promise<LiveCapture>;
  stop(seconds: number, signal: AbortSignal): Promise<StepResult>;
  packFinal(r: PackRequest, signal: AbortSignal): Promise<PackResult>;
  /** Every container and volume labelled with this attempt, by label; how many are left after. */
  remove(signal: AbortSignal): Promise<{ readonly left: number }>;
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
  /** The attempt's label value: what the pack helper is labelled with and what removal selects. */
  readonly attemptId?: string;
  /** Resolves after `ms`, or early when the signal aborts; only a test replaces it. */
  readonly wait?: (ms: number) => Promise<void>;
}

const launchFailure = (e: Error): Buffer => Buffer.from(`docker did not run to its end: ${(e as NodeJS.ErrnoException).code ?? e.message}\n`);

/** A docker CLI call, asynchronous and cancellable: a cancel or the timeout kills it, and it settles only once it has exited. */
function cliCall(exe: string, args: readonly string[], env: Record<string, string>, o: { readonly timeoutMs: number; readonly signal?: AbortSignal; readonly stdoutLimit?: number; readonly onStdout?: (d: Buffer) => boolean }): Promise<{ readonly status: number | null; readonly stdout: Buffer; readonly stderr: Buffer; readonly ended: "exit" | "timeout" | "cancel" | "limit" | "launch" }> {
  return new Promise((res) => {
    let child;
    try { child = spawn(exe, args, { env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { res({ status: null, stdout: Buffer.alloc(0), stderr: launchFailure(e as Error), ended: "launch" }); return; }
    const outs: Buffer[] = [];
    const errs: Buffer[] = [];
    let size = 0;
    let ended: "exit" | "timeout" | "cancel" | "limit" | "launch" = "exit";
    const kill = (why: typeof ended): void => { if (ended === "exit") ended = why; child.kill("SIGKILL"); };
    const timer = setTimeout(() => kill("timeout"), o.timeoutMs);
    const onAbort = (): void => kill("cancel");
    if (o.signal?.aborted) kill("cancel"); else o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      if (o.onStdout !== undefined) { if (!o.onStdout(d)) kill("limit"); return; }
      size += d.length;
      if (size > (o.stdoutLimit ?? 64 * 1048576)) { kill("limit"); return; }
      outs.push(d);
    });
    let errSize = 0;
    // Kept one byte past the records' limit, so an over-limit stream is refused by the record parser, never cut to fit.
    child.stderr.on("data", (d: Buffer) => { if (errSize <= PACK_RECORD_LIMIT) { errs.push(d); errSize += d.length; } });
    let settled = false;
    const settle = (status: number | null, extra: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      res({ status, stdout: Buffer.concat(outs), stderr: Buffer.concat(extra === null ? errs : [...errs, extra]), ended: extra === null ? ended : "launch" });
    };
    child.on("error", (e) => settle(null, launchFailure(e)));
    child.on("close", (status) => settle(status, null));
  });
}

export function makeDockerTransport(c: DockerConfig): ExecTransport {
  if (!/^[0-9a-f]{64}$/.test(c.containerId)) throw new Error("a container is addressed by its 64-hex id, never its name");
  const env = { PATH: "/usr/bin:/bin", HOME: c.home };
  const margin = c.watchdogMarginSeconds ?? WATCHDOG_MARGIN_SECONDS;
  const base = ["--config", c.configDir, "--host", c.endpoint];
  const wait = c.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cli = (args: readonly string[]) => spawnSync(c.exe, [...base, ...args], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1048576 });
  const cliAsync = (args: readonly string[], o: Parameters<typeof cliCall>[3]) => cliCall(c.exe, [...base, ...args], env, o);
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
  /**
   * One exec. Each stream is read up to its own limit: the first to cross it is named, both pipes are
   * closed and the CLI is killed, and the result is given only once the CLI has exited. A cancel and the
   * host watchdog kill it the same way. The line reader is optional, so a harness step reads the same way.
   */
  const run = (spec: ExecSpec, onLine: ((line: Buffer) => void) | null, signal?: AbortSignal): Promise<ExecResult> => {
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
    const end = (): void => { child.stdout?.destroy(); child.stderr?.destroy(); child.kill("SIGKILL"); };
    const stopReading = (which: "stdout" | "stderr"): void => { cutOff ??= which; end(); };
    const watchdog = setTimeout(() => child.kill("SIGKILL"), (spec.timeoutSeconds + margin) * 1000);
    const onAbort = (): void => end();
    if (signal?.aborted) end(); else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => {
      if (cutOff !== null) return;
      outs.push(d);
      outSize += d.length;
      if (outSize > spec.stdoutLimit) return stopReading("stdout");
      if (onLine === null) return;
      pending = Buffer.concat([pending, d]);
      for (let nl = pending.indexOf(0x0a); nl >= 0; nl = pending.indexOf(0x0a)) { onLine(pending.subarray(0, nl)); pending = pending.subarray(nl + 1); }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (cutOff !== null) return;
      errs.push(d);
      errSize += d.length;
      // The envelope's own line may follow the limit by its length, so stderr is cut a line's length later.
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
        signal?.removeEventListener("abort", onAbort);
        res(result(spec, execId, status, Buffer.concat(outs), Buffer.concat(extra === null ? errs : [...errs, extra]), cutOff));
      };
      // A docker that could not start: no status, its reason kept as evidence.
      child.on("error", (e) => settle(null, launchFailure(e)));
      child.on("close", (status) => settle(status, null));
    });
  };
  const helper = async (op: HelperOp, args: readonly string[]): Promise<unknown> => {
    const r = await run({ argv: ["node", "/opt/eval/helper.js", op, ...args], cwd: asAttemptPath("/vol/att"), env: HELPER_ENV, stdin: null, timeoutSeconds: HELPER_TIMEOUT_SECONDS, stdoutLimit: HELPER_STDOUT_LIMIT, stderrLimit: 1048576 }, null);
    if (r.overLimit !== null) throw new HelperDefect(`helper ${op}: its ${r.overLimit} is over the limit`);
    if (r.outcome !== "ok") throw new HelperDefect(`helper ${op}: the exec is ${r.outcome} (CLI status ${r.cliStatus}): ${r.stderr.toString("utf8").slice(0, 400)}`);
    let doc: unknown;
    try { doc = JSON.parse(r.stdout.toString("utf8")); } catch { throw new HelperDefect(`helper ${op}: its output is not one JSON document`); }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new HelperDefect(`helper ${op}: its output is not an object`);
    const d = doc as { ok?: unknown; error?: unknown };
    if (r.child?.status !== 0 || !("ok" in d)) throw new HelperDefect(`helper ${op}: ${typeof d.error === "string" ? d.error : `exit ${r.child?.status ?? r.child?.signal}`}`);
    return d.ok;
  };
  const needAttempt = (): string => {
    if (c.attemptId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.attemptId)) throw new Error("this transport has no attempt id");
    return c.attemptId;
  };
  return {
    exec: (spec, signal) => run(spec, null, signal),
    execStream: (spec, onLine, signal) => run(spec, onLine, signal),
    inspect: () => inspectNow().doc,
    daemonProblem(expected) {
      const r = cli(["info", "--format", "{{.ID}}"]);
      if (r.status !== 0) return "the daemon did not answer";
      return r.stdout.trim() === expected ? null : "the daemon is not the manifest's";
    },
    helper,
    async readBytes(path, limit) {
      const a = (await helper("read-bytes", [asAttemptPath(path), String(limit)])) as ReadAnswer;
      if ("absent" in a) return null;
      if ("refused" in a) throw new HelperDefect(`read ${path}: ${a.refused}`);
      return Buffer.from(a.base64, "base64");
    },
    async captureLive(readiness) {
      let last: LiveTry | null = null;
      let records: LiveCapture["records"] = { refused: "no try ran" };
      let tries = 0;
      for (; tries < 3;) {
        if (tries > 0) await wait(2000);
        tries += 1;
        last = (await helper("capture-live", ["/vol/att/project/.story", ...readiness.map((r) => JSON.stringify(r))])) as LiveTry;
        records = parsePackRecords(Buffer.from(last.recordsBase64, "base64"));
        const readFailure = "refused" in records || records.errors.length > 0;
        if (last.d1 === last.d2 && last.packExit === 0 && !readFailure && last.problems.length === 0) break;
      }
      const t = last!;
      const consistent = t.d1 === t.d2 && t.packExit === 0 && !("refused" in records) && records.errors.length === 0 && t.problems.length === 0;
      return { status: consistent ? "consistent" : "inconclusive", tries, d1: t.d1, d2: t.d2, problems: t.problems, packExit: t.packExit, tar: Buffer.from(t.tarBase64, "base64"), records, readiness: t.readiness, outsideGroup: t.outsideGroup };
    },
    async stop(seconds, signal) {
      const r = await cliAsync(["stop", "-t", String(seconds), c.containerId], { timeoutMs: (seconds + 30) * 1000, signal });
      if (r.ended === "cancel") return { ok: false, reason: "the stop was cancelled" };
      if (r.ended === "timeout") return { ok: false, reason: "the docker stop call did not return" };
      return r.status === 0 ? { ok: true } : { ok: false, reason: `docker stop failed (${r.status}): ${r.stderr.toString("utf8").trim().slice(0, 300)}` };
    },
    async packFinal(req, signal) {
      const id = needAttempt();
      const created = await cliAsync(packCreateArgs(id, req.image, req.volume, req.target, req.profile), { timeoutMs: 60_000, signal, stdoutLimit: 4096 });
      const helperId = created.stdout.toString("utf8").trim();
      if (created.status !== 0 || !/^[0-9a-f]{64}$/.test(helperId)) return { ok: false, reason: `the pack helper was not created (${created.ended}, ${created.status}): ${created.stderr.toString("utf8").trim().slice(0, 300)}` };
      req.onCreated(helperId);
      const part = join(req.rawDir, `${req.profile}.tar.part`);
      const final = join(req.rawDir, `${req.profile}.tar`);
      let fd: number | null = null;
      try {
        fd = openSync(part, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        const hash = createHash("sha256");
        let bytes = 0;
        const out = fd;
        const ran = await cliAsync(["start", "-a", helperId], {
          timeoutMs: req.timeoutMs, signal,
          onStdout: (d) => { bytes += d.length; if (bytes > PACK_LIMITS.archiveBytes) return false; hash.update(d); writeSync(out, d); return true; },
        });
        closeSync(fd);
        fd = null;
        if (ran.ended !== "exit") {
          await cliAsync(["kill", helperId], { timeoutMs: 30_000 });
          return { ok: false, reason: ran.ended === "limit" ? "the archive is over its byte limit" : ran.ended === "cancel" ? "the pack was cancelled" : ran.ended === "timeout" ? "the pack ran past its deadline" : "docker did not start the pack" };
        }
        const exit = cli(["inspect", "--type", "container", "--format", "{{.State.ExitCode}}", helperId]);
        if (exit.status !== 0 || exit.stdout.trim() !== "0") return { ok: false, reason: `the pack helper exited ${exit.stdout.trim() || "unknown"}` };
        const records = parsePackRecords(ran.stderr);
        if ("refused" in records) return { ok: false, reason: records.refused };
        try { linkSync(part, final); } catch (e) { return { ok: false, reason: (e as NodeJS.ErrnoException).code === "EEXIST" ? "an archive of that name is already published" : `the archive could not be published: ${(e as Error).message}` }; }
        unlinkSync(part);
        return { ok: true, tarPath: final, sha256: hash.digest("hex"), bytes, records };
      } catch (e) {
        return { ok: false, reason: `the pack could not be written: ${(e as Error).message}` };
      } finally {
        if (fd !== null) closeSync(fd);
        // The helper holds no evidence: it goes by id after every pack, whatever happened.
        await cliAsync(["rm", "-fv", helperId], { timeoutMs: 30_000 });
      }
    },
    async remove(signal) {
      const label = `label=cpm-t538-attempt=${needAttempt()}`;
      const list = async (kind: "ps" | "volume"): Promise<string[] | null> => {
        const r = await cliAsync(kind === "ps" ? ["ps", "-aq", "--filter", label] : ["volume", "ls", "-q", "--filter", label], { timeoutMs: 30_000, signal });
        return r.status === 0 ? r.stdout.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean) : null;
      };
      const containers = await list("ps");
      if (containers !== null && containers.length > 0) await cliAsync(["rm", "-fv", ...containers], { timeoutMs: 120_000, signal });
      const volumes = await list("volume");
      if (volumes !== null && volumes.length > 0) await cliAsync(["volume", "rm", ...volumes], { timeoutMs: 120_000, signal });
      const [cl, vl] = [await list("ps"), await list("volume")];
      // A listing that failed is counted as one object left: nothing proves it gone.
      return { left: (cl?.length ?? 1) + (vl?.length ?? 1) };
    },
  };
}

export const Transport = {
  /** The only route `main()` will have: the exact executable and endpoint, never from PATH or the environment. */
  production: (o: { readonly home: string; readonly configDir: string; readonly containerId: string; readonly attemptId?: string }): ExecTransport => makeDockerTransport({ ...o, exe: DOCKER_EXE, endpoint: DOCKER_ENDPOINT }),
};
