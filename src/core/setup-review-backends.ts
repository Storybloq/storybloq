/**
 * T-536: the two reviewers the setup review starts itself, codex and claude.
 * Each runs without tools, without project access and without a saved session,
 * answers against SETUP_REVIEW_SCHEMA, and has its raw answer kept byte for
 * byte so the record can be checked against it later.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
// ISS-1391's process-group machinery, shared with setup-verify (T-538 S3a-2).
import { escalate, KILL_GRACE_MS, OWN_GROUP, release, signalGroup, signalGroupGuarded, trackGroup, untrackGroup } from "./process-group.js";

export type SetupReviewBackend = "codex" | "claude";
export const SETUP_REVIEW_BACKENDS: readonly SetupReviewBackend[] = ["codex", "claude"];

const VERDICTS: string[] = ["approve", "revise", "reject"];
const SEVERITIES: string[] = ["critical", "major", "minor", "suggestion"];

export const SETUP_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          requirement: { type: "string" },
          description: { type: "string" },
        },
        required: ["severity", "requirement", "description"],
      },
    },
  },
  required: ["verdict", "findings"],
};

export interface SetupReviewFinding {
  readonly severity: string;
  readonly requirement: string;
  readonly description: string;
}

export interface SetupReviewAnswer {
  readonly verdict: "approve" | "revise" | "reject";
  readonly findings: SetupReviewFinding[];
  readonly sessionId?: string;
}

/**
 * The one codex launch, shared by the start probe and the review (ISS-1456).
 * The probe passes `overrides`, its substituted model provider; everything
 * else is identical, so what the probe proves is what the review runs.
 */
/**
 * ISS-1457: what keeps a codex launch from starting anything its user or a
 * project configured. Characterised on codex-cli 0.163.0 with a planted
 * integration on every route: user config.toml (closed by
 * --ignore-user-config; `-c mcp_servers={}` closes nothing, overrides merge),
 * a trusted project's .codex/config.toml and hooks.json at the folder, a git
 * ancestor or nested (trust lives only in user config, so
 * --ignore-user-config closes them), $CODEX_HOME/hooks.json (survives
 * --ignore-user-config; closed only by --disable hooks, even with the
 * hook-trust bypass), and an installed plugin's MCP server (closed by
 * --disable plugins). --ignore-rules drops the execpolicy .rules files. The
 * hook-trust bypass is never passed. Auth still comes from CODEX_HOME.
 */
export const CODEX_ISOLATION_FLAGS: readonly string[] = ["--ignore-user-config", "--ignore-rules", "--disable", "hooks", "--disable", "plugins"];

/** The codex versions whose loading the flags above were proven against; any other fails closed. */
export const CHARACTERISED_CODEX_VERSIONS: readonly string[] = ["0.163.0"];

/** Each launch flag's other form as `codex exec --help` lists it; the help must list both forms. */
export const CODEX_FLAG_FORMS: Readonly<Record<string, string>> = { "-o": "--output-last-message", "--sandbox": "-s" };

/** Every flag the review launch passes, read from the launch itself so the check cannot fall behind it. */
export function codexLaunchFlags(): string[] {
  return [...new Set(codexArgs("/schema", "/out").filter((a) => /^--?[a-z]/.test(a)))];
}

function helpForms(flag: string): string[] {
  const other = CODEX_FLAG_FORMS[flag];
  return other ? [flag, other] : [flag];
}

/** Whether the help lists the flag as an option, not merely mentions it in prose. */
function helpLists(help: string, flag: string): boolean {
  const esc = flag.replace(/[-]/g, "\\-");
  return flag.startsWith("--")
    ? new RegExp(`^\\s*(-[a-zA-Z], )?${esc}(\\s|=|,|$)`, "m").test(help)
    : new RegExp(`^\\s*${esc}, --`, "m").test(help);
}

export function codexArgs(schemaFile: string, outFile: string, overrides: readonly string[] = []): string[] {
  return ["exec", ...overrides, ...CODEX_ISOLATION_FLAGS, "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--output-schema", schemaFile, "-o", outFile, "-"];
}

export function claudeArgs(schemaJson: string): string[] {
  return ["-p", "--output-format", "json", "--json-schema", schemaJson, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-prompts", "none"];
}

/**
 * A claude reviewer started from inside Claude Code would otherwise inherit the
 * parent session's markers; the reviewer must be its own, unattached session.
 */
export function reviewerEnv(backend: SetupReviewBackend, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (backend !== "claude") return env;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    out[k] = v;
  }
  return out;
}

function validateAnswer(value: unknown): SetupReviewAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reviewer answer is not an object");
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.some((k) => k !== "verdict" && k !== "findings")) throw new Error("reviewer answer has fields outside the schema");
  if (!VERDICTS.includes(v.verdict as string)) throw new Error("reviewer verdict is outside the schema");
  if (!Array.isArray(v.findings)) throw new Error("reviewer findings is not a list");
  const findings = v.findings.map((f): SetupReviewFinding => {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new Error("reviewer finding is not an object");
    const r = f as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== "severity" && k !== "requirement" && k !== "description")) throw new Error("reviewer finding has fields outside the schema");
    if (!SEVERITIES.includes(r.severity as string) || typeof r.requirement !== "string" || typeof r.description !== "string") {
      throw new Error("reviewer finding is outside the schema");
    }
    return { severity: r.severity as string, requirement: r.requirement, description: r.description };
  });
  return { verdict: v.verdict as SetupReviewAnswer["verdict"], findings };
}

/**
 * The raw answer as the backend produced it: codex writes the schema object to
 * its -o file, claude prints a result envelope whose structured_output carries
 * it. Anything outside the schema throws.
 */
export function parseReviewerOutput(backend: SetupReviewBackend, raw: Buffer): SetupReviewAnswer {
  const parsed: unknown = JSON.parse(raw.toString("utf-8"));
  if (backend === "codex") return validateAnswer(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("claude output is not a result object");
  const envelope = parsed as Record<string, unknown>;
  if (envelope.is_error !== false) throw new Error("claude reported an error");
  if (!("structured_output" in envelope)) throw new Error("claude returned no structured output");
  const answer = validateAnswer(envelope.structured_output);
  return typeof envelope.session_id === "string" ? { ...answer, sessionId: envelope.session_id } : answer;
}

export const PROBE_TIMEOUT_MS = 5000;
export { KILL_GRACE_MS };

export interface ProcessLimits {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

function runProbe(backend: SetupReviewBackend, args: string[], env: NodeJS.ProcessEnv, limits: ProcessLimits): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(backend, args, { env: reviewerEnv(backend, env), stdio: ["ignore", "pipe", "ignore"], detached: OWN_GROUP });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(value);
    };
    const cancel = escalate(child, limits.timeoutMs ?? PROBE_TIMEOUT_MS, limits.killGraceMs ?? KILL_GRACE_MS, () => { timedOut = true; }, () => { release(child); finish(null); });
    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (c: string) => { stdout += c; });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 && !timedOut ? stdout : null));
  });
}

async function claudeHasFlags(env: NodeJS.ProcessEnv, limits: ProcessLimits): Promise<boolean> {
  const help = await runProbe("claude", ["--help"], env, limits);
  return help !== null && claudeArgs("{}").filter((a) => a.startsWith("--")).every((flag) => help.includes(flag));
}

/**
 * The backend can start a review: `--version` exits 0 within the probe
 * timeout, and for claude, `--help` lists every flag the review passes. An
 * older claude that lacks one would pass a version probe and then fail the
 * review itself; it takes the unavailable path instead.
 */
export async function probeBackend(backend: SetupReviewBackend, env: NodeJS.ProcessEnv, limits: ProcessLimits = {}): Promise<string | null> {
  const stdout = await runProbe(backend, ["--version"], env, limits);
  if (stdout === null) return null;
  if (backend === "claude" && !(await claudeHasFlags(env, limits))) return null;
  const version = stdout.trim().split("\n")[0]?.trim();
  return version ? version : "unknown version";
}

export interface ReviewerRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly spawnError: string | null;
}

/**
 * Starts the reviewer with the prompt on stdin, in its own process group. At
 * the timeout the whole group gets SIGTERM, then SIGKILL after the grace
 * period, and the run settles one grace period later even if a process it
 * started still holds the pipes.
 */
export function runReviewer(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number; killGraceMs?: number }): Promise<ReviewerRun> {
  return new Promise((resolve) => {
    let child: ChildProcess & { stdin: NonNullable<ChildProcess["stdin"]>; stdout: NonNullable<ChildProcess["stdout"]>; stderr: NonNullable<ChildProcess["stderr"]> };
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: OWN_GROUP });
    } catch (e) {
      resolve({ exitCode: null, timedOut: false, stdout: Buffer.alloc(0), stderr: "", spawnError: (e as Error).message });
      return;
    }
    const out: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: ReviewerRun): void => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(r);
    };
    const cancel = escalate(child, opts.timeoutMs, opts.killGraceMs ?? KILL_GRACE_MS, () => { timedOut = true; },
      () => { release(child); finish({ exitCode: null, timedOut, stdout: Buffer.concat(out), stderr, spawnError: null }); });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.stdin.on("error", () => { /* a reviewer that exits before reading its prompt fails below */ });
    child.on("error", (e) => finish({ exitCode: null, timedOut, stdout: Buffer.concat(out), stderr, spawnError: e.message }));
    child.on("close", (code) => finish({ exitCode: code, timedOut, stdout: Buffer.concat(out), stderr, spawnError: null }));
    child.stdin.end(opts.input);
  });
}

// --- Start probe (ISS-1456) -----------------------------------------------------

/**
 * Why a reviewer cannot be used. `store-unwritable` is the review store's, not
 * a backend's: no reviewer is started when nothing it answers could be kept.
 */
export type UnavailableCode =
  | "version-failed" | "flags-unsupported" | "sandbox-start-denied" | "network-denied"
  | "probe-inconclusive" | "probe-listener-failed" | "network-disabled-inferred" | "store-unwritable"
  | "isolation-unverified" | "untrusted-location" | "untrusted-codex-home" | "supervisor-failed";

export interface UnavailableReason {
  readonly backend: SetupReviewBackend | "store";
  readonly code: UnavailableCode;
  readonly detail: string;
}

export type StartProbe =
  | { readonly state: "startup-capable"; readonly backend: SetupReviewBackend; readonly version: string }
  | { readonly state: "unavailable"; readonly reason: UnavailableReason };

/** codex prints this when its sandbox denies it what it needs at start (seen on 0.163.0). */
const FATAL_START = /failed to initialize in-process app-server client/;
/**
 * codex prints this while its model provider is unreachable (seen on 0.163.0,
 * also outside any sandbox when the provider's port is closed). In the probe
 * the provider is the CLI's own open listener, so here it means networking is
 * blocked.
 */
const NETWORK_WAIT = /waiting for network/;
const UNKNOWN_FLAG = /unexpected argument/;

export const START_ATTEMPT_MS = 8000;
export const START_TOTAL_MS = 20000;
const STDERR_KEEP = 64 * 1024;

const PROBE_PROMPT = "storybloq setup-review start probe. This request is answered by a local listener and never reaches a model.\n";
const PROBE_ROUTE = "/v1/responses";
const NONCE_HEADER = "x-storybloq-probe";
export const PROBE_KEY_ENV = "STORYBLOQ_PROBE_KEY";

export interface StartProbeLimits {
  readonly attemptMs?: number;
  readonly totalMs?: number;
  readonly killGraceMs?: number;
}

/** The provider the probe substitutes, all through -c, so no config file is written or read for it. */
export function probeOverrides(port: number, nonce: string): string[] {
  const provider = `{ name = "storybloq-probe", base_url = "http://127.0.0.1:${port}/v1", env_key = "${PROBE_KEY_ENV}", wire_api = "responses", `
    + `http_headers = { "X-Storybloq-Probe" = "${nonce}" }, request_max_retries = 0, stream_max_retries = 0 }`;
  return ["-c", 'model_provider="storybloq_probe"', "-c", `model_providers.storybloq_probe=${provider}`];
}

/** Test seams, not reachable through any CLI or MCP input: how the probe's listener binds, and how it signals codex's group. */
export const startProbeSeams: { listen: (server: Server, ready: () => void) => void; signal: (child: ChildProcess, signal: NodeJS.Signals) => void } = {
  listen: (server, ready) => { server.listen(0, "127.0.0.1", ready); },
  signal: (child, signal) => signalGroup(child, signal),
};

type Attempt =
  | { readonly kind: "reached" }
  | { readonly kind: "listener-failed"; readonly detail: string }
  | { readonly kind: "fatal"; readonly line: string }
  | { readonly kind: "network"; readonly line: string }
  | { readonly kind: "flags"; readonly line: string }
  | { readonly kind: "inconclusive"; readonly detail: string };

const lastLine = (text: string): string => text.trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "";

/**
 * One codex start against a listener the CLI owns on 127.0.0.1. Evidence of a
 * start is a request on the expected route carrying this attempt's nonce: the
 * first one latches, and the group is stopped at once, so no model is ever
 * asked and retries are ignored. Text is only ever negative evidence.
 *
 * Everything happens before `deadline`, an absolute time shared by every
 * attempt: the listener, the start, and the stop. The attempt's own bound and
 * its two grace periods are clamped to the time left, and at the deadline the
 * attempt ends whatever state it is in. On every way it ends, codex's process
 * group is stopped (SIGKILL, once) and released, so nothing codex left behind
 * outlives it, and the listener is closed.
 */
function startAttempt(execDir: string, env: NodeJS.ProcessEnv, attemptMs: number, graceMs: number, deadline: number): Promise<Attempt> {
  return new Promise((resolve) => {
    const nonce = randomBytes(16).toString("hex");
    let reached = false;
    const stray: string[] = [];
    let child: ChildProcess | null = null;
    let stderr = "";
    let earlyLine: { kind: "fatal" | "network"; line: string } | null = null;
    let timedOut = false;
    let settled = false;
    let stopped = false;
    // ISS-1457 round 2: once codex's exit is seen its group id may be reused, so every group signal from
    // then on goes only to a group a probe in the same step finds alive (process-group's guarded signal).
    let leaderExited = false;
    let held: string | null = null;
    const timers: NodeJS.Timeout[] = [];
    const later = (fn: () => void, ms: number): void => { timers.push(setTimeout(fn, Math.max(0, ms))); };
    const groupSignal = (target: ChildProcess, sig: NodeJS.Signals): void => {
      const outcome = signalGroupGuarded(target, sig, leaderExited, OWN_GROUP, startProbeSeams.signal);
      if (outcome !== "sent" && outcome !== "gone") held = outcome;
    };
    const stopGroup = (): void => {
      if (stopped || !child) return;
      stopped = true;
      groupSignal(child, "SIGKILL");
    };
    const stopOnExit = (): void => { if (child) groupSignal(child, "SIGKILL"); };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      if (req.method === "POST" && req.url === PROBE_ROUTE && req.headers[NONCE_HEADER] === nonce) {
        if (!reached) {
          reached = true;
          stopGroup();
        }
      } else if (stray.length < 5) {
        stray.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
      }
      res.writeHead(503, { connection: "close" });
      res.end();
    });
    const finish = (a: Attempt): void => {
      if (settled) return;
      settled = true;
      if (child) {
        stopGroup();
        release(child);
        untrackGroup(child);
        // A group the guarded signal held back from, on an answer other than gone, is named.
        if (held !== null && a.kind === "inconclusive") a = { ...a, detail: `${a.detail}; process group ${child.pid} answered ${held} after codex exited, so it was not signalled` };
      }
      for (const t of timers) clearTimeout(t);
      process.removeListener("exit", stopOnExit);
      server.closeAllConnections();
      server.close();
      resolve(a);
    };
    // The hard end: whatever is still running, listener setup included.
    later(() => {
      if (reached) return finish({ kind: "reached" });
      timedOut = true;
      finish({ kind: "inconclusive", detail: "no start within the start check's total bound" });
    }, deadline - Date.now());
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (!child) finish({ kind: "listener-failed", detail: e.code ?? e.message });
    });
    startProbeSeams.listen(server, () => {
      if (settled) return;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const schemaFile = join(execDir, "schema.json");
      try {
        writeFileSync(schemaFile, JSON.stringify(SETUP_REVIEW_SCHEMA), { mode: 0o600 });
        child = spawn("codex", codexArgs(schemaFile, join(execDir, "out.json"), probeOverrides(port, nonce)), {
          cwd: execDir, env: { ...reviewerEnv("codex", env), [PROBE_KEY_ENV]: "storybloq-probe-not-a-credential" },
          stdio: ["pipe", "ignore", "pipe"], detached: OWN_GROUP,
        });
      } catch (e) {
        finish({ kind: "inconclusive", detail: `codex could not be started: ${(e as Error).message}` });
        return;
      }
      const started = child;
      started.once("exit", () => { leaderExited = true; });
      trackGroup(started, stopOnExit);
      process.once("exit", stopOnExit);
      // The attempt's bound and its stop, clamped so they end by the deadline.
      const left = deadline - Date.now();
      const grace = Math.max(0, Math.min(graceMs, Math.floor(left / 4)));
      const bound = Math.max(0, Math.min(attemptMs, left - 2 * grace));
      later(() => {
        timedOut = true;
        groupSignal(started, "SIGTERM");
        later(() => {
          stopGroup();
          later(() => settle(null), grace);
        }, grace);
      }, bound);
      started.stderr!.setEncoding("utf-8");
      started.stderr!.on("data", (c: string) => {
        stderr = (stderr + c).slice(-STDERR_KEEP);
        if (earlyLine || reached) return;
        const lines = stderr.split("\n");
        const fatal = lines.find((l) => FATAL_START.test(l));
        const network = lines.find((l) => NETWORK_WAIT.test(l));
        if (fatal) earlyLine = { kind: "fatal", line: fatal.trim() };
        else if (network) earlyLine = { kind: "network", line: network.trim() };
        if (earlyLine) stopGroup();
      });
      started.stdin!.on("error", () => { /* a codex that exits before reading the prompt is classified below */ });
      started.stdin!.end(PROBE_PROMPT);
      const settle = (code: number | null): void => {
        if (reached) return finish({ kind: "reached" });
        const fatal = earlyLine?.kind === "fatal" ? earlyLine.line : stderr.split("\n").find((l) => FATAL_START.test(l))?.trim();
        if (fatal) return finish({ kind: "fatal", line: fatal });
        if (earlyLine?.kind === "network") return finish({ kind: "network", line: earlyLine.line });
        if (code === 2 && UNKNOWN_FLAG.test(stderr)) return finish({ kind: "flags", line: stderr.split("\n").find((l) => UNKNOWN_FLAG.test(l))!.trim() });
        const why = timedOut ? `no start within ${(bound / 1000).toFixed(1)} seconds` : `exited with status ${code ?? "unknown"} before reaching the check`;
        const strayNote = stray.length > 0 ? `; requests without this check's nonce: ${stray.join(", ")}` : "";
        const tail = lastLine(stderr);
        finish({ kind: "inconclusive", detail: `${why}${tail ? `: ${tail}` : ""}${strayNote}` });
      };
      started.on("error", (e) => finish({ kind: "inconclusive", detail: `codex could not be started: ${e.message}` }));
      started.on("close", (code) => settle(code));
    });
  });
}

/**
 * Whether codex can actually start a review here, not only print a version.
 * One retry when the first attempt proves nothing, inside a total bound;
 * inconclusive never passes.
 */
export async function probeCodexStart(execDir: string, env: NodeJS.ProcessEnv, limits: StartProbeLimits = {}): Promise<{ ok: true } | { ok: false; code: UnavailableCode; detail: string }> {
  const attemptMs = limits.attemptMs ?? START_ATTEMPT_MS;
  const totalMs = limits.totalMs ?? START_TOTAL_MS;
  const graceMs = limits.killGraceMs ?? KILL_GRACE_MS;
  // One absolute deadline for both attempts, their listeners and their stops.
  const deadline = Date.now() + totalMs;
  let last: Attempt | null = null;
  for (let i = 0; i < 2; i += 1) {
    if (i > 0 && deadline - Date.now() < attemptMs) break;
    last = await startAttempt(execDir, env, attemptMs, graceMs, deadline);
    if (last.kind !== "inconclusive") break;
  }
  switch (last!.kind) {
    case "reached": return { ok: true };
    case "listener-failed": return {
      ok: false, code: "probe-listener-failed",
      detail: last!.detail === "EPERM" || last!.detail === "EACCES"
        ? `networking is denied in this sandbox (the start check could not open a local connection: ${last!.detail})`
        : `the start check could not open its local listener (${last!.detail})`,
    };
    case "fatal": return { ok: false, code: "sandbox-start-denied", detail: `cannot start inside this sandbox (${last!.line})` };
    case "network": return { ok: false, code: "network-denied", detail: `cannot reach its model from here (${last!.line})` };
    case "flags": return { ok: false, code: "flags-unsupported", detail: `this version lacks a flag the review needs (${last!.line})` };
    case "inconclusive": return { ok: false, code: "probe-inconclusive", detail: `did not show it can start: ${last!.detail}` };
  }
}

/**
 * Reasons known without starting anything. A Codex sandbox with networking
 * off reports it in the environment, and claude -p cannot reach its model
 * from there; this is inferred from the marker, never a readiness check. A
 * stale marker (a terminal opened from inside Codex) reads the same, so the
 * detail names the variable.
 */
export function inferredReasons(env: NodeJS.ProcessEnv): UnavailableReason[] {
  if (env.CODEX_SANDBOX_NETWORK_DISABLED !== "1") return [];
  return [{ backend: "claude", code: "network-disabled-inferred", detail: "network disabled in this sandbox, inferred from CODEX_SANDBOX_NETWORK_DISABLED=1; unset it if this terminal is not sandboxed" }];
}

/**
 * The gate's verdict for one backend. Codex needs `execDir`, a private
 * writable directory the start runs in; claude has no offline start check, so
 * its verdict is the version, the flags and the inferred network state.
 */
export async function probeReviewer(backend: SetupReviewBackend, env: NodeJS.ProcessEnv, execDir: string, limits: ProcessLimits & StartProbeLimits = {}): Promise<StartProbe> {
  const unavailable = (code: UnavailableCode, detail: string): StartProbe => ({ state: "unavailable", reason: { backend, code, detail } });
  if (backend === "claude") {
    const inferred = inferredReasons(env).find((r) => r.backend === "claude");
    if (inferred) return { state: "unavailable", reason: inferred };
  }
  const stdout = await runProbe(backend, ["--version"], env, limits);
  if (stdout === null) return unavailable("version-failed", "not installed, or did not report a version");
  if (backend === "claude" && !(await claudeHasFlags(env, limits))) return unavailable("flags-unsupported", "this version lacks a flag the review needs");
  const version = stdout.trim().split("\n")[0]?.trim() || "unknown version";
  if (backend === "codex") {
    const isolation = await codexIsolationCheck(stdout, env, limits);
    if (isolation !== null) return unavailable("isolation-unverified", isolation);
    const start = await probeCodexStart(execDir, env, limits);
    if (!start.ok) return unavailable(start.code, start.detail);
  }
  return { state: "startup-capable", backend, version };
}

/**
 * ISS-1457: the launch relies on the isolation flags, so before any codex
 * start the version must be a characterised one, `codex exec --help` must
 * list every flag, and `codex features list` must name every feature they
 * disable. Both are help-only calls. Null when isolated; otherwise why not.
 */
export async function codexIsolationCheck(versionOutput: string, env: NodeJS.ProcessEnv, limits: ProcessLimits = {}): Promise<string | null> {
  // The whole output is one line, "codex-cli <version>", and the version token matches the allowlist exactly:
  // a suffix such as -alpha.1 or -custom is a different build, never a characterised one.
  const version = /^codex-cli (\S+)$/.exec(versionOutput.trim())?.[1];
  if (version === undefined || !CHARACTERISED_CODEX_VERSIONS.includes(version)) {
    return `isolation is proven only for codex ${CHARACTERISED_CODEX_VERSIONS.join(", ")}, not ${version ?? JSON.stringify(versionOutput.trim().slice(0, 80))}`;
  }
  const help = await runProbe("codex", ["exec", "--help"], env, limits);
  if (help === null) return "codex exec --help did not answer, so the isolation flags are unverified";
  const missingFlag = codexLaunchFlags().flatMap(helpForms).find((f) => !helpLists(help, f));
  if (missingFlag) return `codex exec --help does not list ${missingFlag}`;
  const features = await runProbe("codex", ["features", "list"], env, limits);
  if (features === null) return "codex features list did not answer, so the disabled features are unverified";
  const disabled = CODEX_ISOLATION_FLAGS.filter((_, i) => CODEX_ISOLATION_FLAGS[i - 1] === "--disable");
  const missingFeature = disabled.find((name) => !new RegExp(`^${name}\\s`, "m").test(features));
  if (missingFeature) return `codex features list does not name ${missingFeature}`;
  return null;
}

/** One line naming every reason, for the gate, run and status output. */
/** The codex line that says its sandbox denied it what it needs at start, if the stderr holds one. */
export function fatalStartLine(stderr: string): string | null {
  return stderr.split("\n").find((l) => FATAL_START.test(l))?.trim() ?? null;
}

export function unavailableLine(reasons: readonly UnavailableReason[]): string {
  return `Reviewer unavailable: ${reasons.map((r) => `${r.backend === "store" ? "review store" : r.backend}: ${r.detail}`).join("; ")}`;
}
