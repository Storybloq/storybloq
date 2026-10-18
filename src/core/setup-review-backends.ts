/**
 * T-536: the two reviewers the setup review starts itself, codex and claude.
 * Each runs without tools, without project access and without a saved session,
 * answers against SETUP_REVIEW_SCHEMA, and has its raw answer kept byte for
 * byte so the record can be checked against it later.
 */
import { spawn, type ChildProcess } from "node:child_process";

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

export function codexArgs(schemaFile: string, outFile: string): string[] {
  return ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", "--output-schema", schemaFile, "-o", outFile, "-"];
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
export const KILL_GRACE_MS = 5000;

export interface ProcessLimits {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
}

/**
 * Each backend runs in its own process group, so a timeout reaches whatever it
 * started too. Windows has no process groups to signal; there the child alone
 * is signalled.
 */
const OWN_GROUP = process.platform !== "win32";

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (OWN_GROUP && child.pid !== undefined) process.kill(-child.pid, signal);
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

function trackGroup(child: ChildProcess): void {
  if (liveGroups.size === 0) {
    for (const sig of STOP_SIGNALS) {
      const handler = (): void => stopGroupsOnSignal(sig);
      stopHandlers.set(sig, handler);
      process.prependListener(sig, handler);
    }
  }
  liveGroups.add(child);
}

function untrackGroup(child: ChildProcess): void {
  if (liveGroups.delete(child) && liveGroups.size === 0) removeStopHandlers();
}

/**
 * Lets go of a child that will not close: its pipes are destroyed and it is
 * unref'd, so a process it started outside the group cannot keep this one
 * running.
 */
function release(child: ChildProcess): void {
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
function escalate(child: ChildProcess, timeoutMs: number, graceMs: number, onTimeout: () => void, giveUp: () => void): () => void {
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

/**
 * The backend can start a review: `--version` exits 0 within the probe
 * timeout, and for claude, `--help` lists every flag the review passes. An
 * older claude that lacks one would pass a version probe and then fail the
 * review itself; it takes the unavailable path instead.
 */
export async function probeBackend(backend: SetupReviewBackend, env: NodeJS.ProcessEnv, limits: ProcessLimits = {}): Promise<string | null> {
  const stdout = await runProbe(backend, ["--version"], env, limits);
  if (stdout === null) return null;
  if (backend === "claude") {
    const help = await runProbe(backend, ["--help"], env, limits);
    if (help === null || !claudeArgs("{}").filter((a) => a.startsWith("--")).every((flag) => help.includes(flag))) return null;
  }
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
