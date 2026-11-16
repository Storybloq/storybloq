/**
 * C-v4.1 commit 4, plan section 4.1: the hardened, streaming git runner for
 * git facts.
 *
 * Every call runs under the land runner's sanitised environment (landEnv),
 * with GIT_NO_REPLACE_OBJECTS=1 and GIT_NO_LAZY_FETCH=1 set here as well, and
 * with `-c core.fsmonitor=false` ahead of the subcommand. Each call has its
 * own timeout and output bound. At either limit, or when a caller's record
 * bound is passed, the child gets SIGTERM, then SIGKILL two seconds later,
 * and no partial output is returned. The runner never throws.
 */
import { spawn } from "node:child_process";
import { landEnv } from "../land.js";

export const GIT_FACTS_TIMEOUT_MS = 30_000;
export const GIT_FACTS_MAX_BYTES = 256 * 1024 * 1024;
export const GIT_FACTS_KILL_GRACE_MS = 2_000;
const STDERR_CAP = 4096;

export interface GitFactsRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Stop once more than this many NUL bytes have been seen (a record bound). */
  readonly maxNuls?: number;
  /** Test seam: the executable to spawn instead of git; `-c core.fsmonitor=false` is then not added. */
  readonly command?: string;
  /** Test seam: the environment (default gitFactsEnv()). */
  readonly env?: NodeJS.ProcessEnv;
}

export type GitFactsFailure = "timeout" | "output" | "records" | "exit" | "spawn";

export type GitFactsResult =
  | { readonly kind: "ok"; readonly stdout: Buffer }
  | { readonly kind: "failed"; readonly reason: GitFactsFailure; readonly detail: string };

export function gitFactsEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...landEnv(baseEnv), GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
}

export function runGitFacts(req: GitFactsRequest): Promise<GitFactsResult> {
  const timeoutMs = req.timeoutMs ?? GIT_FACTS_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? GIT_FACTS_MAX_BYTES;
  const command = req.command ?? "git";
  const args = req.command === undefined ? ["-c", "core.fsmonitor=false", ...req.args] : [...req.args];
  return new Promise((resolvePromise) => {
    let settled = false;
    let stopped: GitFactsFailure | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let nuls = 0;
    let stderr = "";

    const finish = (r: GitFactsResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolvePromise(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: req.cwd, env: req.env ?? gitFactsEnv(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolvePromise({ kind: "failed", reason: "spawn", detail: (e as Error).message });
      return;
    }

    const stop = (why: GitFactsFailure): void => {
      if (stopped !== null) return;
      stopped = why;
      chunks.length = 0;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); }, GIT_FACTS_KILL_GRACE_MS);
    };

    const timer = setTimeout(() => stop("timeout"), timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stopped !== null) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { stop("output"); return; }
      if (req.maxNuls !== undefined) {
        for (let i = 0; i < chunk.length; i += 1) if (chunk[i] === 0) nuls += 1;
        if (nuls > req.maxNuls) { stop("records"); return; }
      }
      chunks.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8").slice(0, STDERR_CAP - stderr.length);
    });
    child.stdin!.on("error", () => { /* a child that exits early closes stdin; the exit decides */ });
    child.on("error", (e) => finish({ kind: "failed", reason: "spawn", detail: e.message }));
    child.on("close", (code, signal) => {
      if (stopped === "timeout") finish({ kind: "failed", reason: "timeout", detail: `git timeout after ${timeoutMs} ms` });
      else if (stopped === "output") finish({ kind: "failed", reason: "output", detail: `git output over limit (${maxBytes} bytes)` });
      else if (stopped === "records") finish({ kind: "failed", reason: "records", detail: "git output over the record limit" });
      else if (code !== 0) finish({ kind: "failed", reason: "exit", detail: `git exited ${code ?? signal}: ${stderr.trim()}` });
      else finish({ kind: "ok", stdout: Buffer.concat(chunks) });
    });
    if (req.input !== undefined) child.stdin!.end(req.input);
    else child.stdin!.end();
  });
}
