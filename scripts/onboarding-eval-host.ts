// T-538 commit 2a (plan 5.1 to 5.4, Addendum B): the host route's turn mechanics as pure parts. How a
// process result reads (wrapped or not), the leftover check after a turn, the turn's capture limits, the
// tool server's sandboxed launch, the one environment table, and Codex's tool approvals.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { runInGroup } from "../src/core/process-group.js";

// --- how a process result reads (Addendum B, ruling 1) --------------------------------------------------

/** Signal numbers to names, the first name for a number (SIGABRT before SIGIOT). */
const SIGNAL_NAMES = new Map<number, string>();
for (const [name, n] of Object.entries(osConstants.signals)) if (!SIGNAL_NAMES.has(n)) SIGNAL_NAMES.set(n, name);

export interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly wrapped: boolean;
  /** The failure as written on the record; null for exit 0 with no signal. */
  readonly form: string | null;
  /** Derived: the signal that ended the process, whether it came back as a signal or, wrapped, as 128 + n. */
  readonly killedBy: string | null;
}

/**
 * The one reading of a process result. The form is named by the launch kind, never guessed from the number:
 * unwrapped keeps `killed by <signal>` and `exit <n>`; a process under the sandbox wrapper that exits 128 + n
 * with no signal is `exit <128+n> (wrapped, signal <n> inside the sandbox)`, with `killedBy` derived beside
 * the raw exit code and signal, which are always kept.
 */
export function processOutcome(exitCode: number | null, signal: string | null, wrapped: boolean): ProcessOutcome {
  const base = { exitCode, signal, wrapped };
  if (signal) return { ...base, form: `killed by ${signal}`, killedBy: signal };
  if (wrapped && exitCode !== null && exitCode > 128 && SIGNAL_NAMES.has(exitCode - 128)) {
    const n = exitCode - 128;
    return { ...base, form: `exit ${exitCode} (wrapped, signal ${n} inside the sandbox)`, killedBy: SIGNAL_NAMES.get(n)! };
  }
  if (exitCode !== 0) return { ...base, form: `exit ${exitCode}`, killedBy: null };
  return { ...base, form: null, killedBy: null };
}

// --- the leftover check (5.1) ----------------------------------------------------------------------------

export interface LeftoverHolder { readonly pid: number; readonly command: string }
export interface LeftoverCheck {
  readonly status: "clean" | "holders" | "failed";
  readonly holders: readonly LeftoverHolder[];
  /** The cleanup failure it names; null when clean. */
  readonly reason: string | null;
}

/**
 * `lsof -F pc` output, read from the output only: its exit status is 1 whether it found holders, found
 * none or could not read the tree. Any stderr is a failed check, named by its first line; empty stdout and
 * stderr is clean; holders are the `p` lines with their `c` lines, and `f` lines are ignored. Any other
 * line is a failed check too, never skipped.
 */
export function parseLsof(stdout: string, stderr: string): LeftoverCheck {
  const failed = (why: string): LeftoverCheck => ({ status: "failed", holders: [], reason: `leftover check failed: ${why}` });
  const err = stderr.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (err !== undefined) return failed(err);
  const holders: { pid: number; command: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "" || line.startsWith("f")) continue;
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (!Number.isInteger(pid) || pid <= 0) return failed(`unreadable output line ${JSON.stringify(line.slice(0, 40))}`);
      if (!holders.some((h) => h.pid === pid)) holders.push({ pid, command: "" });
      continue;
    }
    if (line.startsWith("c") && holders.length > 0) { holders.at(-1)!.command = line.slice(1); continue; }
    return failed(`unreadable output line ${JSON.stringify(line.slice(0, 40))}`);
  }
  if (holders.length === 0) return { status: "clean", holders: [], reason: null };
  return { status: "holders", holders, reason: `leftover: ${holders.map((h) => `${h.pid} ${h.command}`).join(", ")}` };
}

export const LSOF = "/usr/sbin/lsof";

/** Every process holding a file or a working directory under `tree`, by pid and command name only. */
export function leftoverCheck(tree: string, timeoutMs = 60_000, lsof = LSOF): LeftoverCheck {
  const r = spawnSync(lsof, ["-n", "-P", "-F", "pc", "+D", tree], { encoding: "utf-8", timeout: timeoutMs, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 8 << 20 });
  if (r.error) return { status: "failed", holders: [], reason: `leftover check failed: ${r.error.message}` };
  if (r.signal) return { status: "failed", holders: [], reason: `leftover check failed: killed by ${r.signal}` };
  return parseLsof(r.stdout ?? "", r.stderr ?? "");
}

// --- the turn's capture limits (5.1) ---------------------------------------------------------------------

const MIB = 1 << 20;
export const TURN_LIMITS = {
  deadlineMs: 40 * 60_000,
  stdoutBytes: 64 * MIB,
  stderrBytes: 8 * MIB,
  attemptCaptureBytes: 256 * MIB,
  graceMs: 15_000,
} as const;
export type TurnLimits = { readonly [K in keyof typeof TURN_LIMITS]: number };

/** What one attempt has captured so far, across its turns. */
export interface AttemptCapture { used: number }

/**
 * One turn's capture. Past a limit it stops appending (the capture is truncated at the limit), names the
 * limit once, and calls `stop` once; it never throws from a data callback.
 */
export class TurnCapture {
  private readonly seen = { stdout: 0, stderr: 0 };
  private stopped = false;
  exceeded: string | null = null;

  constructor(private readonly attempt: AttemptCapture, private readonly stop: () => void, private readonly limits: TurnLimits = TURN_LIMITS) {}

  /** The part of `chunk` to keep: all of it, a prefix up to the first limit, or nothing once one is passed. */
  take(stream: "stdout" | "stderr", chunk: Buffer): Buffer {
    if (this.exceeded !== null) return Buffer.alloc(0);
    const own = stream === "stdout" ? this.limits.stdoutBytes : this.limits.stderrBytes;
    const ownRoom = own - this.seen[stream];
    const attemptRoom = this.limits.attemptCaptureBytes - this.attempt.used;
    const room = Math.max(0, Math.min(ownRoom, attemptRoom));
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.seen[stream] += kept.length;
    this.attempt.used += kept.length;
    if (kept.length < chunk.length) {
      this.exceeded = ownRoom <= attemptRoom
        ? `limit: ${stream} over ${own} bytes`
        : `limit: attempt capture over ${this.limits.attemptCaptureBytes} bytes`;
      if (!this.stopped) {
        this.stopped = true;
        try { this.stop(); } catch { /* the stop is the run's own; a failure there shows as its cleanup */ }
      }
    }
    return kept;
  }
}

// --- the tool server inside the sandbox (5.2) ------------------------------------------------------------

/** The wrapper's settings: only the roots are writable, no network, neither /tmp nor TMPDIR. */
export function sandboxSettings(roots: readonly string[]): string[] {
  return [
    'sandbox_mode="workspace-write"',
    `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    "sandbox_workspace_write.network_access=false",
    "sandbox_workspace_write.exclude_slash_tmp=true",
    "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  ];
}

/**
 * F2: the tool server's launcher. A client starts its MCP server with the client's own environment merged
 * under the configured one (Claude's env block overlays, it does not replace), so the server column of 5.3
 * holds only if something replaces the environment. This script does: `<launcher> NAME... -- command args`
 * runs the command under `/usr/bin/env -i` with exactly the named variables that are set, nothing else.
 * Values travel as the client delivered them and are never written into an argument list or a file.
 */
export const SERVER_LAUNCHER_TEXT = `#!/bin/sh
# T-538 F2: the evaluation tool server's launcher. Usage: <this> NAME... -- command [args...]
# Runs the command with exactly the named variables that are set; nothing else is inherited.
set -f
names=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  case "$1" in
    ''|[0-9]*|*[!A-Z0-9_]*) echo "server launcher: bad variable name" >&2; exit 64 ;;
  esac
  names="$names $1"
  shift
done
[ "$#" -gt 0 ] || { echo "server launcher: no command" >&2; exit 64; }
for k in $names; do
  eval "isset=\\\${$k+x}"
  if [ "$isset" = x ]; then eval "set -- \\"$k=\\\${$k}\\" \\"\\$@\\""; fi
done
exec /usr/bin/env -i "$@"
`;

/** A variable name the launcher accepts: upper case, digits and underscore, not starting with a digit. */
export const LAUNCHER_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `/bin/sh <launcher> <server column names> -- codexBin sandbox <settings> -- <node> <bundle> --entry mcp`: the
 * one launch both clients are given. The names are the server column's for the attempt (5.3), fixed at
 * provisioning so the launch is the same on every turn; a variable the column drops later is simply unset.
 */
export function serverLaunch(codexBin: string, node: string, bundle: string, roots: readonly string[], launcher: string, names: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
  if (!codexBin.startsWith("/")) throw new Error(`onboarding-eval: the codex executable ${codexBin} is not an absolute path`);
  if (!launcher.startsWith("/")) throw new Error(`onboarding-eval: the server launcher ${launcher} is not an absolute path`);
  for (const n of names) if (!LAUNCHER_NAME.test(n)) throw new Error(`onboarding-eval: ${n} is not a variable name the server launcher accepts`);
  return { command: "/bin/sh", args: [launcher, ...[...names].sort(), "--", codexBin, "sandbox", ...sandboxSettings(roots).flatMap((s) => ["-c", s]), "--", node, bundle, "--entry", "mcp"] };
}

/** Writes the launcher, read-only, as a new file; returns its path. */
export function writeServerLauncher(dir: string): string {
  const file = join(dir, "server-launcher.sh");
  writeFileSync(file, SERVER_LAUNCHER_TEXT, { mode: 0o500, flag: "wx" });
  return file;
}

// --- harness commands on project content (5.7) -------------------------------------------------------------

/** Each stream of a harness command keeps at most this many bytes. */
export const SANDBOXED_STREAM_BYTES = 1024 * 1024;

export interface SandboxedRun {
  /** The wrapper's exit status, raw: a command killed inside the sandbox shows as 128+n with no signal (Addendum B). */
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** A stream passed SANDBOXED_STREAM_BYTES and was cut there. */
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly cleanup: "confirmed" | "unconfirmed";
}

/**
 * `codex sandbox <the 5.2 settings> -- /bin/sh -c <command>` in its own process group under one deadline: the
 * only way the harness runs anything in the project (plan 5.7). `env` is the command's whole environment.
 */
export async function sandboxedRun(o: { readonly codexBin: string; readonly roots: readonly string[]; readonly cwd: string; readonly command: string; readonly deadlineMs: number; readonly env: NodeJS.ProcessEnv; readonly graceMs?: number }): Promise<SandboxedRun> {
  if (!o.codexBin.startsWith("/")) throw new Error(`onboarding-eval: the codex executable ${o.codexBin} is not an absolute path`);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const len = { out: 0, err: 0 };
  let truncated = false;
  const keep = (into: Buffer[], k: "out" | "err", c: Buffer): void => {
    const room = SANDBOXED_STREAM_BYTES - len[k];
    if (c.length > room) truncated = true;
    if (room > 0) { const part = c.subarray(0, room); into.push(part); len[k] += part.length; }
  };
  const r = await runInGroup({
    command: o.codexBin, args: ["sandbox", ...sandboxSettings(o.roots).flatMap((s) => ["-c", s]), "--", "/bin/sh", "-c", o.command],
    cwd: o.cwd, env: o.env, timeoutMs: o.deadlineMs, killGraceMs: o.graceMs ?? TURN_LIMITS.graceMs,
    onStdout: (c) => keep(out, "out", c), onStderr: (c) => keep(err, "err", c),
  });
  return {
    status: r.timedOut ? null : r.exitCode, signal: r.signal, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8"),
    truncated, timedOut: r.timedOut, spawnError: r.spawnError, cleanup: r.cleanup,
  };
}

// --- one environment table (5.3) -------------------------------------------------------------------------

export type EnvRole = "client" | "server";

export interface EnvInputs {
  readonly client: "claude" | "codex";
  readonly path: string;
  readonly home: string;
  readonly tmp: string;
  readonly lang: string;
  /** The Codex arm's client-home/.codex. */
  readonly clientCodexHome?: string;
  readonly claudeConfigDir?: string;
  /** Passed through, never read, logged or hashed. */
  readonly oauthToken?: string;
  readonly runnerHome: string;
  readonly globalDir: string;
  readonly events: string;
  /** Present only while a session is armed. */
  readonly fault?: string | null;
  readonly faultId?: string | null;
  readonly reviewResponses?: string | null;
  readonly reviewStore: string;
  readonly outside: string;
  readonly tools: string;
  readonly degraded: boolean;
}

/**
 * The single source for every variable a client turn and its tool server get (plan 5.3's table); `server`
 * is `mcpEnvFor`. A required value that is undefined or empty throws before anything is written.
 */
export function envFor(role: EnvRole, i: EnvInputs): Record<string, string> {
  const env: Record<string, string> = {};
  const need = (k: string, v: string | undefined): void => {
    if (v === undefined || v === "") throw new Error(`onboarding-eval: ${k} has no value for the ${role} environment`);
    env[k] = v;
  };
  need("PATH", i.path);
  need("HOME", i.home);
  need("TMPDIR", i.tmp);
  need("LANG", i.lang);
  if (role === "client") {
    if (i.client === "codex") need("CODEX_HOME", i.clientCodexHome);
    else {
      need("CLAUDE_CONFIG_DIR", i.claudeConfigDir);
      need("CLAUDE_CODE_OAUTH_TOKEN", i.oauthToken);
    }
  } else need("CODEX_HOME", i.runnerHome);
  need("STORYBLOQ_CLIENT", i.client);
  need("STORYBLOQ_GLOBAL_DIR", i.globalDir);
  need("STORYBLOQ_EVAL_EVENTS", i.events);
  if (i.fault) {
    env.STORYBLOQ_EVAL_FAULT = i.fault;
    if (i.faultId) env.STORYBLOQ_EVAL_FAULT_ID = i.faultId;
  }
  if (i.reviewResponses) env.STORYBLOQ_EVAL_REVIEW_RESPONSES = i.reviewResponses;
  need("STORYBLOQ_SETUP_REVIEW_DIR", i.reviewStore);
  if (role === "server") {
    need("STORYBLOQ_EVAL_OUTSIDE", i.outside);
    need("STORYBLOQ_EVAL_TOOLS", i.tools);
  }
  if (role === "client" && i.degraded) env.ENABLE_TOOL_SEARCH = "true";
  return env;
}

export const mcpEnvFor = (i: EnvInputs): Record<string, string> => envFor("server", i);

/** Every key of `env` that the role's column does not name, and every one it names that is missing. */
export function envKeyProblems(env: NodeJS.ProcessEnv, expected: Record<string, string>, role: EnvRole): string[] {
  const problems: string[] = [];
  for (const k of Object.keys(expected)) if (env[k] === undefined) problems.push(`${k} is missing from the ${role} environment`);
  for (const k of Object.keys(env)) if (!Object.hasOwn(expected, k)) problems.push(`${k} is not in the ${role} column`);
  return problems;
}

// --- Codex's tool approvals (Addendum B, ruling 2) -------------------------------------------------------

/** The approval tables the scratch config carries: one per name in the inventory's union, nothing else. */
export function codexApprovalTables(names: readonly string[]): string {
  return [...new Set(names)].sort().map((n) => `[mcp_servers.storybloq.tools.${n}]\napproval_mode = "approve"\n`).join("\n");
}

/**
 * The config's approvals against the inventory's union: every name approved, exactly once, with
 * `approval_mode = "approve"`, and no approval for another server or a name outside the union.
 */
export function codexApprovalProblems(config: string, names: readonly string[]): string[] {
  const problems: string[] = [];
  const want = new Set(names);
  const seen = new Map<string, string | null>();
  let table: string | null = null;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^\]]*)\]$/.exec(line);
    if (header) {
      table = header[1]!.trim();
      const tool = /^mcp_servers\.([^.]+)\.tools\.(.+)$/.exec(table);
      if (tool) {
        if (tool[1] !== "storybloq") problems.push(`[${table}] approves a tool of another server`);
        else if (!want.has(tool[2]!)) problems.push(`[${table}] approves a name outside the inventory`);
        else if (seen.has(tool[2]!)) problems.push(`[${table}] appears twice`);
        else seen.set(tool[2]!, null);
      }
      continue;
    }
    if (/approval_mode/.test(line)) {
      const tool = table === null ? null : /^mcp_servers\.storybloq\.tools\.(.+)$/.exec(table);
      if (tool === null || !want.has(tool[1]!)) { if (!problems.some((p) => p.startsWith(`[${table}]`))) problems.push(`approval_mode outside an approval table${table === null ? "" : ` in [${table}]`}`); continue; }
      seen.set(tool[1]!, line);
    }
  }
  for (const n of want) {
    if (!seen.has(n)) problems.push(`${n} has no approval table`);
    else if (seen.get(n) !== 'approval_mode = "approve"') problems.push(`${n} is not approved`);
  }
  return problems;
}

// --- what each turn must show (5.1, 5.2) -----------------------------------------------------------------

export const NO_SANDBOXED_SERVER = "no sandboxed storybloq server";
/** P1: a tool server launch in the turn that is not held with the pinned inventory, by attempt id. */
export const UNSANDBOXED_SERVER = "unsandboxed storybloq server launch";

/** One tool server launch: an attempt line with `entry: "mcp"`. */
export interface ServerLaunchLine {
  readonly attempt: string;
  readonly sandbox?: string;
  readonly tools?: string;
}

/**
 * The tool server launches in the part of the events log a turn added, in log order: every attempt line with
 * `entry: "mcp"`, whatever its keys. Lines that do not parse are skipped here; the events log as a whole is read
 * strictly by the grading.
 */
export function serverLaunchLines(added: string): ServerLaunchLine[] {
  const out: ServerLaunchLine[] = [];
  for (const raw of added.split("\n")) {
    let v: unknown;
    try { v = JSON.parse(raw); } catch { continue; }
    const x = v as Record<string, unknown> | null;
    if (x === null || typeof x !== "object" || x.seq !== undefined || x.entry !== "mcp") continue;
    out.push({
      attempt: typeof x.attempt === "string" ? x.attempt : "(no attempt id)",
      ...(typeof x.sandbox === "string" ? { sandbox: x.sandbox } : {}),
      ...(typeof x.tools === "string" ? { tools: x.tools } : {}),
    });
  }
  return out;
}

/** A launch the entry confined: its probe held and it enforced the pinned inventory. */
export function launchHeld(l: ServerLaunchLine, toolsSha256: string): boolean {
  return l.sandbox === "held" && l.tools === toolsSha256;
}

/**
 * The launch failure a turn's server launches give, shared by the runner and the regrade: the first launch that
 * is not held with the pinned inventory (no probe, a probe that found the outside writable, or another
 * inventory) is "unsandboxed storybloq server launch <attempt id>", even when that server refused to serve; with
 * every launch held, a turn with none is "no sandboxed storybloq server"; otherwise null.
 */
export function serverLaunchFailure(launches: readonly ServerLaunchLine[], toolsSha256: string): string | null {
  const bad = launches.find((l) => !launchHeld(l, toolsSha256));
  if (bad !== undefined) return `${UNSANDBOXED_SERVER} ${bad.attempt}`;
  return launches.length === 0 ? NO_SANDBOXED_SERVER : null;
}

/** The held launches in the part of the events log a turn added, by attempt id. */
export function heldServerLaunches(added: string, toolsSha256: string): string[] {
  return serverLaunchLines(added).filter((l) => launchHeld(l, toolsSha256)).map((l) => l.attempt);
}

/** One turn's host checks, a replay input (`host-checks.json`) of a host-v2 record. */
export interface TurnHostChecks {
  /** The turn's file stem, `turn-NN-<label>`. */
  readonly file: string;
  /** Every tool server launch the turn added, by attempt id, in log order. */
  readonly launches: readonly string[];
  /** The held server launches the turn added, by attempt id. */
  readonly servers: readonly string[];
  readonly leftover: { readonly status: LeftoverCheck["status"]; readonly reason: string | null };
  /** The capture limit the turn passed, as its failure names it; null when none. */
  readonly limit: string | null;
  /** 5.5: the request folder's failure (`review requests: ...`) that ended the turn; null when none. */
  readonly review: string | null;
}

export const HOST_CHECKS_RAW = "host-checks.json";

export function hostChecksText(turns: readonly TurnHostChecks[], toolsSha256: string): string {
  return `${JSON.stringify({ toolsSha256, turns }, null, 2)}\n`;
}
