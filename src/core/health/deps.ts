/**
 * T-502: the default `HealthDeps` adapters.
 *
 * This is the ONLY module in `core/health` that touches the real home
 * directory, environment, clock, platform or a subprocess. Everything else is
 * a pure function of its inputs, which is what makes the six checks
 * testable without a network, a spawn or a writable HOME -- and what makes
 * THIS module the one that has to be tested against a real (isolated) HOME,
 * because nothing else exercises the syscalls.
 */

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { nativeRebuildDir, resolveBundledBridge } from "../bridge-resolve.js";
import { readAutoCompactWindowDiagnostic } from "../claude-settings.js";
import { readBoundedFileDetailed } from "../bounded-read.js";
import { isHealthCheckGloballyDisabled } from "../global-config.js";
import { readPresenceRecord, resolveCallerBinding } from "../session-intel/presence-bridge.js";
import { readSessionIntelConfig, resolveSessionIntelConfig } from "../session-intel/config.js";
import { SKILL_MARKER_FILE, SKILL_MARKER_MAX_BYTES, skillTargets } from "../skill-version-marker.js";
import { readUpdateCacheSync, refreshUpdateCache } from "../update-check.js";
import type { HealthDeps, HealthMarkerRead, HealthRead, HealthRun, McpLaunch, McpProbe } from "./types.js";

/**
 * Three-valued bounded read, delegating to the shared
 * `readBoundedFileDetailed` so `storybloq health` and Claude Code's settings
 * reader cannot drift on what "unreadable" means. The only thing added here
 * is the empty-file case: an empty document is content we read successfully
 * and cannot parse, which the JSON layer above turns into indeterminate,
 * rather than a file that is not there.
 */
export function readFileThreeValued(path: string, maxBytes: number): HealthRead {
  return readBoundedFileDetailed(path, maxBytes);
}

/**
 * A capped probe that distinguishes a missing binary from one that did not
 * answer, because "Codex is not installed" and "codex --version did not
 * answer" are different sentences and only one of them may be said when the
 * probe timed out.
 *
 * `killSignal: "SIGKILL"` is deliberate. `spawnSync`'s default SIGTERM waits
 * for the child to exit, so a wrapper that catches or ignores SIGTERM would
 * hold the whole command (and, on the MCP surface, the server's event loop)
 * past `timeoutMs`. The cap has to be enforceable, not advisory.
 *
 * Only ETIMEDOUT is a timeout. A child that dies on a signal of its own, or
 * hits the output buffer limit, is a FAILED probe: reporting it as a timeout
 * would put the wrong reason in front of the user.
 */
export function runBounded(cmd: string, args: readonly string[], timeoutMs: number): HealthRun {
  const result = spawnSync(cmd, [...args], {
    timeout: Math.max(1, timeoutMs),
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf-8",
  });
  const code = (result.error as { code?: string } | undefined)?.code;
  if (code === "ENOENT") return { kind: "enoent" };
  if (code === "ETIMEDOUT") return { kind: "timeout" };
  if (result.error) return { kind: "failed", code: result.status ?? null };
  if (result.signal !== null) return { kind: "failed", code: null };
  if (result.status !== 0) return { kind: "failed", code: result.status ?? null };
  return { kind: "ok", stdout: result.stdout ?? "" };
}

// ---------------------------------------------------------------------------
// T-509: the MCP initialize probe.
// ---------------------------------------------------------------------------

/** Below this much remaining budget a probe is not launched at all. */
export const BRIDGE_PROBE_MIN_MS = 250;
const LINE_LIMIT = 64 * 1024;
const TOTAL_LIMIT = 256 * 1024;
const STDERR_TAIL = 4 * 1024;
const TERM_GRACE_MS = 200;
/** After a good answer, how long stderr is still read before the ok settles: stdout and stderr are separate pipes with no cross-stream ordering, and the bridge reports a degraded native module on stderr. */
export const STDERR_DRAIN_MS = 150;
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

export interface ProbeMcpOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly clientVersion?: string;
  /** Test seam: the spawn function (default `child_process.spawn`). */
  readonly spawn?: typeof spawn;
  /** Test seam: creates the scratch cwd (default mkdtemp under os.tmpdir()). */
  readonly mkScratch?: () => string;
}

const KILL_POLL_MS = 100;
const KILL_MAX_WAIT_MS = 3000;

/**
 * Launch an MCP server exactly as registered, send `initialize`, and judge the
 * first message that answers id 1. The server is never left running: one
 * idempotent finalizer clears the timer, closes the streams and kills the
 * process GROUP (the launch is detached on POSIX so an npx/bunx launcher's
 * descendants die with it; `taskkill /T` on win32), then waits for the exit.
 *
 * Cleanup exits are intentional and never reported as failures; only an exit
 * observed BEFORE the answer is. A crash after the handshake but before
 * cleanup starts is "answered then exited", because that server is not
 * healthy either.
 */
export function probeMcpServer(launch: McpLaunch, deadlineAt: number, capMs: number, opts: ProbeMcpOptions): Promise<McpProbe> {
  const now = opts.now ?? (() => Date.now());
  const platform = opts.platform ?? process.platform;
  // The allocation is min(cap, remaining), never more than either; under the
  // floor there is no launch at all, whichever of the two is the reason.
  const allocatedMs = Math.min(capMs, deadlineAt - now());
  if (allocatedMs < BRIDGE_PROBE_MIN_MS) return Promise.resolve({ kind: "not-attempted", reason: "budget exhausted" });
  const startedAt = now();
  const [command, ...args] = launch.argv;
  if (command === undefined) return Promise.resolve({ kind: "failed", reason: "empty command", code: null, signal: null, stderr: "", allocatedMs });

  return new Promise<McpProbe>((resolveProbe) => {
    let settled = false;
    let answered = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let stdoutBuf = "";
    let stdoutTotal = 0;
    let stderrTail = "";
    let timer: NodeJS.Timeout | null = null;

    // The server runs in a scratch directory of its own: the bridge writes
    // its review database into process.cwd() at startup, and a health check
    // must leave nothing behind in the caller's project. Removed after the
    // teardown, whatever the outcome. No scratch dir, no launch: the shared
    // temp dir would collect a persistent database instead.
    let scratch: string | null = null;
    try {
      scratch = (opts.mkScratch ?? (() => fs.mkdtempSync(join(tmpdir(), "storybloq-mcp-probe-"))))();
    } catch (err: unknown) {
      resolveProbe({ kind: "failed", reason: `scratch directory: ${err instanceof Error ? err.message : String(err)}`, code: null, signal: null, stderr: "", allocatedMs });
      return;
    }
    const dropScratch = (): void => {
      if (scratch === null) return;
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // best effort
      }
      scratch = null;
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = (opts.spawn ?? spawn)(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...opts.env, ...launch.envOverrides },
        cwd: scratch,
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (err: unknown) {
      dropScratch();
      resolveProbe(spawnFailure(err, allocatedMs));
      return;
    }

    const finish = (result: McpProbe): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void teardown(child, exited !== null, platform).then(() => {
        dropScratch();
        resolveProbe(result);
      });
    };

    child.once("error", (err: NodeJS.ErrnoException) => {
      finish(spawnFailure(err, allocatedMs));
    });
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (settled) return;
      if (answered) {
        // Answered, then died on its own before cleanup started.
        finish({ kind: "failed", reason: `answered then exited ${code ?? signal ?? "?"}`, code, signal, stderr: stderrTail, allocatedMs });
        return;
      }
      finish({ kind: "failed", reason: "exited before answering", code, signal, stderr: stderrTail, allocatedMs });
    });

    child.stdin?.on("error", () => {
      // EPIPE when the server closed stdin: nothing to do, the exit or the
      // timer reports the outcome.
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    });
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (settled) return;
      // Limits are BYTES: the decoded string undercounts multibyte output.
      stdoutTotal += Buffer.byteLength(chunk, "utf-8");
      stdoutBuf += chunk;
      if (stdoutTotal > TOTAL_LIMIT || (!stdoutBuf.includes("\n") && Buffer.byteLength(stdoutBuf, "utf-8") > LINE_LIMIT)) {
        finish({ kind: "failed", reason: "output limit", code: null, signal: null, stderr: stderrTail, allocatedMs });
        return;
      }
      let nl: number;
      while (!settled && (nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (Buffer.byteLength(line, "utf-8") > LINE_LIMIT) {
          finish({ kind: "failed", reason: "output limit", code: null, signal: null, stderr: stderrTail, allocatedMs });
          return;
        }
        const message = parseMessage(line);
        if (message === null) continue;
        const request = serverRequest(message);
        if (request !== null) {
          // Request ids are independent per direction: a server may send its
          // own request with id 1 while ours is pending. Answer a ping (empty
          // result) so a server that waits for it can proceed; anything else
          // is left unanswered, as a real client that lacks the capability would.
          if (request.method === "ping") {
            try {
              child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n");
            } catch {
              // best effort
            }
          }
          continue;
        }
        const verdict = judgeResponse(message, allocatedMs, stderrTail);
        if (verdict === null) continue;
        if (verdict.kind === "ok") {
          answered = true;
          if (exited !== null) {
            finish({ kind: "failed", reason: `answered then exited ${exited.code ?? exited.signal ?? "?"}`, code: exited.code, signal: exited.signal, stderr: stderrTail, allocatedMs });
            return;
          }
          try {
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          } catch {
            // best effort
          }
          // Keep reading stderr for a bounded moment before the ok settles, so
          // a warning the server wrote just before its answer is not lost to
          // pipe ordering. An exit during the drain is still "answered then
          // exited" through the exit listener.
          if (timer) clearTimeout(timer);
          const drain = Math.max(0, Math.min(STDERR_DRAIN_MS, startedAt + allocatedMs - now()));
          timer = setTimeout(() => finish({ ...verdict, stderr: stderrTail }), drain);
          return;
        }
        finish(verdict);
      }
    });

    timer = setTimeout(() => finish({ kind: "timeout", allocatedMs }), allocatedMs);

    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "storybloq", version: opts.clientVersion ?? "unknown" } },
    };
    try {
      child.stdin?.write(JSON.stringify(init) + "\n");
    } catch {
      // EPIPE surfaces on the error listener above.
    }
  });
}

function spawnFailure(err: unknown, allocatedMs: number): McpProbe {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return { kind: "enoent", allocatedMs };
  const reason = typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
  return { kind: "failed", reason, code: null, signal: null, stderr: "", allocatedMs };
}

function parseMessage(line: string): Record<string, unknown> | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  return msg as Record<string, unknown>;
}

/** A server-initiated REQUEST (has a method and an id); notifications and responses are null. */
function serverRequest(m: Record<string, unknown>): { id: unknown; method: string } | null {
  if (typeof m["method"] !== "string" || m["id"] === undefined || m["id"] === null) return null;
  return { id: m["id"], method: m["method"] };
}

/** Null for a message that is not the RESPONSE to our id 1 (notifications, requests, other ids). */
function judgeResponse(m: Record<string, unknown>, allocatedMs: number, stderr: string): McpProbe | null {
  if (m["id"] !== 1) return null;
  // A message carrying a method is a request or notification, never a response.
  if (m["method"] !== undefined) return null;
  const failed = (reason: string): McpProbe => ({ kind: "failed", reason, code: null, signal: null, stderr, allocatedMs });
  if (m["jsonrpc"] !== "2.0") return failed("malformed initialize result (jsonrpc)");
  if (m["error"] !== undefined) {
    const message = (m["error"] as { message?: unknown } | null)?.message;
    return failed(`protocol error: ${typeof message === "string" ? message : JSON.stringify(m["error"])}`);
  }
  const result = m["result"];
  if (!result || typeof result !== "object" || Array.isArray(result)) return failed("malformed initialize result (result)");
  const r = result as Record<string, unknown>;
  if (typeof r["protocolVersion"] !== "string") return failed("malformed initialize result (protocolVersion)");
  if (!SUPPORTED_PROTOCOLS.has(r["protocolVersion"])) return failed(`unsupported protocol version ${r["protocolVersion"]}`);
  if (!r["capabilities"] || typeof r["capabilities"] !== "object" || Array.isArray(r["capabilities"])) return failed("malformed initialize result (capabilities)");
  const info = r["serverInfo"];
  if (!info || typeof info !== "object" || Array.isArray(info)) return failed("malformed initialize result (serverInfo)");
  const name = (info as Record<string, unknown>)["name"];
  const version = (info as Record<string, unknown>)["version"];
  if (typeof name !== "string") return failed("malformed initialize result (serverInfo.name)");
  if (typeof version !== "string") return failed("malformed initialize result (serverInfo.version)");
  return { kind: "ok", serverName: name, serverVersion: version, protocolVersion: r["protocolVersion"], allocatedMs, stderr };
}

/**
 * Idempotent: safe to call whether or not the child already exited. The
 * direct child's exit is NOT proof of cleanup: a detached launcher (npx)
 * can die on SIGTERM while a descendant in its process group ignores it.
 * On POSIX the group's liveness is checked independently (signal 0 to the
 * group) and SIGKILL is re-sent to the group on every poll until the group
 * is gone or KILL_MAX_WAIT_MS elapse. On win32 `taskkill /T /F` kills the
 * tree and the direct child's exit is the only observable, so that is what
 * is awaited there. Nothing here blocks the event loop.
 */
function teardown(child: ReturnType<typeof spawn>, alreadyExited: boolean, platform: NodeJS.Platform): Promise<void> {
  for (const s of [child.stdin, child.stdout, child.stderr]) {
    try {
      s?.removeAllListeners("data");
      s?.destroy();
    } catch {
      // already closed
    }
  }
  if (child.pid === undefined) return Promise.resolve();
  const pid = child.pid;
  const childExited = (): boolean => alreadyExited || child.exitCode !== null || child.signalCode !== null;
  const groupAlive = (): boolean => {
    if (platform === "win32") return false;
    try {
      process.kill(-pid, 0);
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
        const tk = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        tk.once("error", () => {
          try {
            child.kill(signal);
          } catch {
            // gone
          }
        });
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // gone
      }
    }
  };
  if (gone()) return Promise.resolve();
  return new Promise<void>((done) => {
    let finished = false;
    // The pending timer stays REFERENCED: once the direct child has exited
    // it may be the only handle keeping the event loop alive, and a pending
    // promise alone does not. An unref'd timer here would let the process
    // exit before the SIGKILL that the group still needs.
    let timer: NodeJS.Timeout | null = null;
    const end = (): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      timer = null;
      done();
    };
    // The direct child's exit alone ends the wait only when nothing else in
    // the group is left; otherwise the poll below keeps killing the group.
    child.once("exit", () => {
      if (!groupAlive()) end();
    });
    kill("SIGTERM");
    const started = Date.now();
    const poll = (): void => {
      timer = null;
      if (finished || gone()) return end();
      if (Date.now() - started >= KILL_MAX_WAIT_MS) return end();
      kill("SIGKILL");
      timer = setTimeout(poll, KILL_POLL_MS);
    };
    timer = setTimeout(() => {
      timer = null;
      if (finished || gone()) return end();
      kill("SIGKILL");
      timer = setTimeout(poll, KILL_POLL_MS);
    }, TERM_GRACE_MS);
  });
}

export function defaultHealthDeps(opts: { ledgerRoot: string | null }): HealthDeps {
  return {
    readFile: readFileThreeValued,
    run: runBounded,
    now: () => Date.now(),
    env: process.env,
    homeDir: homedir(),
    platform: process.platform,
    settings: {
      autoCompactWindow: (projectDir) => readAutoCompactWindowDiagnostic(projectDir),
    },
    // STRICTLY read-only, and deliberately NOT `acquireCallerSample`: that
    // helper refreshes a stale sample through `sampleSession`, which PERSISTS
    // a new sample onto the caller's presence record. `storybloq health` is
    // on demand and repeatable, so it must observe session state without
    // touching it -- not merely avoid T-501's once-per-session stamp. A stale
    // or absent stored sample therefore yields null and the check falls back
    // to a window-only evaluation.
    // The interface hands every implementation the remaining budget; this one
    // does not need it, because a single bounded record read is not a
    // budgeted operation once the refresh is gone.
    callerSample: () => {
      const root = opts.ledgerRoot;
      if (root === null) return null;
      try {
        const binding = resolveCallerBinding(root);
        if (!binding.bound || !binding.sessionId) return null;
        const record = readPresenceRecord(binding.recordRoot ?? root, binding.sessionId);
        const sample = record?.sessionIntel?.lastSample;
        if (!sample) return null;
        // FRESHNESS, not just presence. Without this a `oneMillionFlag: true`
        // recorded before the user switched models would keep producing a
        // 1M-model advisory for a session that is no longer running one. The
        // window is sessionIntel's own `maxSampleAgeMs`, the same limit the
        // push path uses to decide a sample is too old to describe -- except
        // that where the push path refreshes, this one gives up.
        const age = Date.now() - Date.parse(sample.sampledAt);
        if (!Number.isFinite(age) || age < 0) return null;
        if (age > readSessionIntelConfig(root).maxSampleAgeMs) return null;
        const flag = sample.usageInput?.oneMillionFlag;
        return flag === undefined ? null : { oneMillionFlag: flag };
      } catch {
        return null;
      }
    },
    sessionIntelConfig: (ledgerRoot) =>
      ledgerRoot === null ? resolveSessionIntelConfig(null) : readSessionIntelConfig(ledgerRoot),
    versionCache: {
      read: (currentVersion) => readUpdateCacheSync(currentVersion),
      refresh: (o) => refreshUpdateCache(o),
    },
    skillMarker: {
      targets: () => skillTargets(),
      installed: (target) => fs.existsSync(join(target.dir, "SKILL.md")),
      marker: (target) => markerRead(join(target.dir, SKILL_MARKER_FILE)),
    },
    // The kill-switch predicate stays the single source of the rule (it sits
    // beside the limitResume and sessionIntel switches, where a reader looks
    // for them); this dep is the injection point that lets a test express the
    // switch as a plain object.
    globalConfig: () => (isHealthCheckGloballyDisabled() ? { healthCheck: { enabled: false } } : null),
    bundledBridge: () => resolveBundledBridge(),
    nativeRebuildDir: (executablePath) => nativeRebuildDir(executablePath),
    // The inherited environment is this deps object's own `env`, merged under
    // the registration's overrides here so the check never reads process.env.
    probeMcp: (launch, deadlineAt, capMs) => probeMcpServer(launch, deadlineAt, capMs, { env: process.env }),
  };
}

function markerRead(path: string): HealthMarkerRead {
  const raw = readFileThreeValued(path, SKILL_MARKER_MAX_BYTES);
  if (raw.kind === "absent") return { kind: "absent" };
  if (raw.kind === "indeterminate") return { kind: "indeterminate", reason: raw.reason };
  const text = raw.text.trim();
  return text.length > 0 ? { kind: "ok", value: text } : { kind: "absent" };
}
