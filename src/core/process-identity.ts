/**
 * Process identity: a pid plus a signature (uid, start time, command) so a
 * recycled pid is never mistaken for the process that wrote a lock body.
 * Shared by the project lock and the limit lock.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { parseLstart } from "./session-intel/process-era.js";

export type PsForm = "legacy" | "pinned";

/** Test seam: answers `ps` in place of the real one, and throws for a failed or timed out run. */
export const __processIdentitySeams: {
  psOutput: ((form: PsForm, pid: number) => string) | null;
  resetOwnStart: () => void;
} = {
  psOutput: null,
  resetOwnStart: () => {
    ownStartCache = undefined;
  },
};

/** The environment a pinned read runs under, so its text never depends on the caller's. */
export function pinnedPsEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", TZ: "UTC" };
}
export const PINNED_PS_FIELDS = "uid=,lstart=";

/**
 * Identity signature for a live process: uid + start time + command. Two
 * different processes recycling the same PID produce different signatures.
 * Sync port of src/bus/lock.ts captureProcessSignature.
 */
export function captureProcessSignatureSync(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") {
      const seam = __processIdentitySeams.psOutput;
      const out = seam
        ? seam("legacy", pid)
        : execFileSync("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,command="], {
            encoding: "utf-8",
            timeout: 500,
            maxBuffer: 128 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          });
      const normalized = out.trim().replace(/\s+/g, " ");
      if (!normalized) return null;
      return "darwin:" + createHash("sha256").update(normalized).digest("hex");
    }
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const rightParen = raw.lastIndexOf(")");
      if (rightParen < 0) return null;
      const fields = raw.slice(rightParen + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      const st = fs.statSync(`/proc/${pid}`);
      return startTicks ? `linux:${st.uid}:${startTicks}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export type ProcessIdentity = "alive" | "dead" | "unknown";

/** The two parts of a `darwin2:<uid>:<startEpochSeconds>` value. */
export interface PinnedIdentity {
  readonly uid: number;
  readonly start: number;
}

const PINNED_VALUE = /^darwin2:(0|[1-9][0-9]{0,9}):([1-9][0-9]{0,12})$/;
const PINNED_PS_LINE = /^(\d{1,10})\s+(\S.*)$/;

/** A recorded `pinnedSignature`, or null when it is absent or malformed. */
export function parsePinnedSignature(value: unknown): PinnedIdentity | null {
  if (typeof value !== "string") return null;
  const match = PINNED_VALUE.exec(value);
  return match ? { uid: Number(match[1]), start: Number(match[2]) } : null;
}

export function parsePinnedPsOutput(stdout: string): PinnedIdentity | null {
  const match = PINNED_PS_LINE.exec(stdout.trim());
  if (!match) return null;
  const start = parseLstart(match[2]!);
  return start === null ? null : { uid: Number(match[1]), start };
}

export function formatPinnedSignature(identity: PinnedIdentity): string {
  return `darwin2:${identity.uid}:${identity.start}`;
}

function readPinnedIdentitySync(pid: number): PinnedIdentity | null {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const seam = __processIdentitySeams.psOutput;
    const out = seam
      ? seam("pinned", pid)
      : execFileSync("/bin/ps", ["-p", String(pid), "-o", PINNED_PS_FIELDS], {
          encoding: "utf-8",
          timeout: 500,
          maxBuffer: 128 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          env: pinnedPsEnv(),
        });
    return parsePinnedPsOutput(out);
  } catch {
    return null;
  }
}

/** The value a lock record carries for another pid, or null off Darwin or on a failed capture. */
export function capturePinnedSignatureSync(pid: number): string | null {
  const identity = readPinnedIdentitySync(pid);
  return identity ? formatPinnedSignature(identity) : null;
}

let ownStartCache: number | undefined;

/**
 * This process's pinned value. Only the start is cached: it cannot change for
 * a living process. The uid is read on every call from the same credential
 * ps's `uid` keyword reports, so a privilege transition never publishes an
 * obsolete uid.
 */
export function ownPinnedSignatureSync(): string | null {
  if (process.platform !== "darwin") return null;
  if (ownStartCache === undefined) {
    const live = readPinnedIdentitySync(process.pid);
    if (!live) return null;
    ownStartCache = live.start;
  }
  const uid = process.geteuid?.();
  return uid === undefined ? null : formatPinnedSignature({ uid, start: ownStartCache });
}

/**
 * The verdict of a well-formed pinned record against the live process.
 *
 * A differing start is proof of reuse, because the value cannot change for a
 * living process. From apple-oss-distributions public sources fetched
 * 2026-11-07 (xnu and adv_cmds, branch main):
 * - ps prints the kernel's exported field: adv_cmds ps/print.c `lstarted` reads
 *   `KI_PROC(k)->p_starttime.tv_sec` and formats it with
 *   `strftime("%c", localtime(&then))`.
 * - The export copies p_start and computes nothing: xnu bsd/kern/kern_sysctl.c
 *   `fill_user64_externproc`, `exp->p_starttime.tv_sec = p->p_start.tv_sec;`
 *   (:1198), and `fill_user32_externproc` (:1135).
 * - Set at fork, kept across exec: bsd/kern/kern_fork.c, under `if (in_exec)`,
 *   "Keep the original start time for exec'ed proc",
 *   `child_proc->p_start.tv_sec = parent_proc->p_start.tv_sec;` (:1125-1127);
 *   otherwise `microtime_with_abstime(&child_proc->p_start, ...)` (:1131).
 * - No other writer: a search of bsd/, osfmk/ and libkern/ for `p_start` member
 *   access finds those lines, the kernel's own process at bsd/kern/bsd_init.c:997,
 *   and only reads elsewhere (kern_proc.c, kern_acct.c, kern_exit.c, proc_info.c,
 *   kern_sysctl.c). bsd/kern/kern_time.c and osfmk/kern/clock.c, where the clock
 *   is set, do not touch it.
 * Limits: the public source is not guaranteed to be the running kernel (Darwin
 * 27.0.0), the clock cannot be stepped in a test, and a search by member name
 * would miss a write through an aliased pointer.
 *
 * Whole seconds: a pid reused within the same second by the same uid reads as
 * alive, which waits. That is why this verdict never grants a signal; see
 * verifyIdentityForSignalSync.
 */
export function pinnedVerdict(recorded: PinnedIdentity, live: PinnedIdentity | null): ProcessIdentity {
  if (!live) return "unknown";
  if (live.start !== recorded.start) return "dead";
  return live.uid === recorded.uid ? "alive" : "unknown";
}

/**
 * The verdict of a `processSignature` against a live capture. On Darwin the
 * legacy value hashes text that depends on the caller's locale and timezone,
 * so a mismatch proves nothing and never yields dead, whatever the recorded
 * form. Linux's value never depended on the environment, so a mismatch stays
 * proof there.
 */
export function legacyVerdict(
  expected: string | null,
  actual: string | null,
  platform: NodeJS.Platform = process.platform,
): ProcessIdentity {
  if (!expected || !actual) return "unknown";
  if (actual === expected) return "alive";
  return platform === "darwin" ? "unknown" : "dead";
}

/** ESRCH is dead, everything else leaves the question to the signatures. */
function pidProbe(pid: number): "gone" | "present" | "denied" {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return code === "EPERM" ? "denied" : "present";
  }
}

export function inspectProcessIdentitySync(
  pid: number,
  expectedSignature: string | null,
  pinnedSignature?: unknown,
): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  if (pidProbe(pid) === "gone") return "dead";
  const recorded = process.platform === "darwin" ? parsePinnedSignature(pinnedSignature) : null;
  if (recorded) return pinnedVerdict(recorded, readPinnedIdentitySync(pid));
  if (!expectedSignature) return "unknown";
  return legacyVerdict(expectedSignature, captureProcessSignatureSync(pid));
}

/**
 * The stricter check before a signal. Whole seconds are safe for lock
 * contention, because a collision waits; they are not safe for a signal, so
 * pinned equality never grants one. Only an exact legacy match in this
 * environment does. Everything else that proves nothing is unknown, so the
 * caller refuses. Linux keeps its mismatch as proof, as in legacyVerdict.
 */
export function verifyIdentityForSignalSync(
  pid: number,
  expectedSignature: string | null,
  pinnedSignature?: unknown,
): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  const probe = pidProbe(pid);
  if (probe === "gone") return "dead";
  const recorded = process.platform === "darwin" ? parsePinnedSignature(pinnedSignature) : null;
  if (recorded) {
    const live = readPinnedIdentitySync(pid);
    if (live && live.start !== recorded.start) return "dead";
  }
  const verdict = legacyVerdict(expectedSignature, expectedSignature ? captureProcessSignatureSync(pid) : null);
  return verdict === "alive" && probe === "denied" ? "unknown" : verdict;
}
