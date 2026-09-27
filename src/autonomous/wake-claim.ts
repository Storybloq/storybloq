/**
 * T-424: Per-session wake claims -- the reopen-race protocol between the limit
 * waker and the SessionStart "resume" hook.
 *
 * Before spawning `claude -p --resume`, the waker (under the wake-claim lock)
 * writes a claim naming the attempt and passes STORYBLOQ_WAKE_ATTEMPT=
 * "<attemptId>.<token>" in the child's env. Hooks inherit the client's env, so
 * the SessionStart handler can distinguish deterministically:
 *   - env token matches the active claim  -> the waker's own child; stay silent.
 *   - no/mismatched token                 -> an interactive resume; revoke the
 *     claim, mark the ledger record `interactive`, async-SIGTERM the waker's
 *     child (identity-verified), and let the user proceed.
 *
 * Fallback (if a real client turns out to sanitize spawn env -- feasibility
 * gate in the waker): claims also record the child pid, and the hook may match
 * parent-process ancestry instead of the env token.
 */

import * as fs from "node:fs";
import { basename, join } from "node:path";
import { hasArgvSignature } from "./liveness.js";
import { storybloqGlobalDir } from "../core/global-config.js";

export const WAKE_ATTEMPT_ENV = "STORYBLOQ_WAKE_ATTEMPT";

/** Attempt-specific argv sentinel, embedded in the wake child's prompt. */
export function wakeAttemptSentinel(attemptId: string): string {
  return `[storybloq-wake ${attemptId}]`;
}

/**
 * Full identity of a wake child: the resume session UUID PLUS the
 * attempt-specific sentinel embedded in its prompt argv. An interactive
 * `claude --resume <id>` shares the UUID but never the attempt sentinel, so
 * it can never be matched (or signalled) as the wake child.
 */
export function wakeChildMarkers(clientTaskId: string, attemptId: string): string[] {
  return [clientTaskId, wakeAttemptSentinel(attemptId)];
}

const CLAIM_BASENAME = "wake-claim.json";
const CLAIM_LOCK_BASENAME = "wake-claim.lock";
const CLAIM_MAX_BYTES = 4_096;

export interface WakeClaim {
  attemptId: string;
  token: string;
  generation: number;
  childPid: number | null;
  createdAt: number;
}

/**
 * Wake claims live under the TRUSTED global Storybloq dir (created 0700, owned
 * by storybloq), keyed by the session UUID -- NOT under the user's git
 * workspace. This is the security fix: a `.story/sessions/<id>/telemetry` leaf
 * lives inside a tree an attacker with workspace write access could swap for a
 * symlink to redirect our write/unlink/lock outside the session; the global dir
 * cannot be symlink-planted without already owning it (same-uid ACE, out of
 * scope). Keyed by session UUID so the waker (writeWakeClaim(sessionDir)) and
 * the SessionStart hook (readWakeClaim(sessionDir)) resolve the SAME path.
 */
function wakeClaimDir(sessionDir: string): string {
  return join(storybloqGlobalDir(), "wake-claims", basename(sessionDir));
}

export function wakeClaimPath(sessionDir: string): string {
  return join(wakeClaimDir(sessionDir), CLAIM_BASENAME);
}

export function wakeClaimLockPath(sessionDir: string): string {
  return join(wakeClaimDir(sessionDir), CLAIM_LOCK_BASENAME);
}

export function writeWakeClaim(sessionDir: string, claim: WakeClaim): boolean {
  const dir = wakeClaimDir(sessionDir);
  const target = join(dir, CLAIM_BASENAME);
  const tmp = join(dir, `${CLAIM_BASENAME}.tmp.${process.pid}.${Date.now()}`);
  let fd: number | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // O_CREAT|O_EXCL|O_NOFOLLOW: create a FRESH regular file; never write THROUGH
    // a pre-existing symlink or file swapped in at the tmp path.
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const out = Buffer.from(JSON.stringify(claim), "utf-8");
    let written = 0;
    while (written < out.length) {
      const n = fs.writeSync(fd, out, written, out.length - written, written);
      // A zero-byte (or short-then-zero) write must be a HARD failure: publishing
      // a truncated/empty claim would let the waker spawn while SessionStart
      // cannot parse the claim it needs for takeover coordination.
      if (n <= 0) throw new Error("wake-claim short write");
      written += n;
    }
    if (written !== out.length) throw new Error("wake-claim incomplete write");
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
    return true;
  } catch {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    return false;
  }
}

/**
 * Bounded, non-blocking, shape-validated read: SessionStart hooks call this,
 * so a replaced claim path (FIFO, symlink, oversized file) must never block or
 * allocate unbounded memory, and a malformed field must never enter the
 * takeover protocol.
 */
export function readWakeClaim(sessionDir: string): WakeClaim | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      wakeClaimPath(sessionDir),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > CLAIM_MAX_BYTES || st.size <= 0) return null;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    const parsed = JSON.parse(buf.subarray(0, read).toString("utf-8")) as WakeClaim;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.attemptId !== "string" || !parsed.attemptId || parsed.attemptId.length > 128) return null;
    if (typeof parsed.token !== "string" || !parsed.token || parsed.token.length > 128) return null;
    if (!Number.isInteger(parsed.generation) || parsed.generation < 1) return null;
    if (parsed.childPid !== null && (!Number.isInteger(parsed.childPid) || parsed.childPid <= 0)) return null;
    if (!Number.isFinite(parsed.createdAt)) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function clearWakeClaim(sessionDir: string): void {
  // The claim lives in the trusted global dir (see wakeClaimDir); unlink does
  // not follow the final symlink, so it removes the claim entry itself.
  try {
    fs.unlinkSync(wakeClaimPath(sessionDir));
  } catch {
    // ignore
  }
}

/** Parse the "<attemptId>.<token>" env value inherited by the waker's child (and its hooks). */
export function parseWakeAttemptEnv(value: string | undefined): { attemptId: string; token: string } | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  return { attemptId: value.slice(0, dot), token: value.slice(dot + 1) };
}

/** Does the current process's inherited env prove it belongs to the active claim? */
export function envMatchesClaim(claim: WakeClaim | null, envValue: string | undefined): boolean {
  const parsed = parseWakeAttemptEnv(envValue);
  return !!claim && !!parsed && parsed.attemptId === claim.attemptId && parsed.token === claim.token;
}

/**
 * Identity-verified, non-blocking signal to a waker child. Callers pass the
 * FULL marker set -- the resume session UUID plus the attempt-specific prompt
 * sentinel (see waker.wakeChildMarkers) -- and the signal only fires when the
 * process argv carries EVERY marker. The session UUID alone is NOT sufficient
 * identity: an interactive `claude --resume <id>` for the same session shares
 * it, and this guard is what keeps a stale claim + recycled PID from ever
 * SIGTERMing the user's interactive client. Never waits for exit -- the
 * waker's own poll (or reconciliation) confirms termination.
 */
export function signalWakeChild(pid: number | null | undefined, markers: readonly string[], signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid || pid === process.ppid || pid === 1) return false;
  if (markers.length === 0) return false;
  if (!hasArgvSignature(pid, markers)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
