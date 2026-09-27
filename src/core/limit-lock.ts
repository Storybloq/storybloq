/**
 * T-424: Synchronous link-based lock with lease + process-identity verified
 * stealing, for the limit-resume machinery (global ledger lock, waker
 * singleton lock, per-session wake-claim locks).
 *
 * Combines the two proven storybloq lock layers:
 *   - src/autonomous/liveness.ts: link-lock acquire loop, O_NOFOLLOW reads,
 *     token+inode verified unlink (safeUnlinkLock), argv-signature guards.
 *   - src/bus/lock.ts: processSignature identity (pid liveness alone is not
 *     PID-reuse-safe; the recorded start-time signature is what proves the
 *     holder is still the same process).
 *
 * Steal policy (per the T-424 design):
 *   - holder identity verified alive  -> never steal, poll.
 *   - holder dead (ESRCH/EPERM or signature mismatch) -> steal immediately
 *     (a dead process cannot write; the fencing check covers residue).
 *   - holder identity unknown -> steal only after the lease expires.
 *   - unreadable body -> steal only after a long mtime-based break window.
 *
 * Every steal goes through liveness.safeUnlinkLock (inode+token verified under
 * a held fd), so a racing new holder is never broken.
 *
 * Fencing: holders of long-ish critical sections call verifyLockOwnership()
 * immediately before their atomic rename; on loss they discard the mutation
 * and retry. A stalled ex-holder can therefore never clobber a successor.
 *
 * KNOWN LIMITATION (accepted, documented -- T-424 review). Stealing an
 * identity-"unknown" holder (null processSignature: `ps`/procfs failed at
 * acquire, or a platform with no signature source) on LEASE EXPIRY is not
 * provably safe: if that holder is actually alive and stalled mid-write, a
 * single-syscall gap between a writer's final verifyLockOwnership and its
 * unconditional rename can, in principle, let the stale ex-holder overwrite a
 * successor's commit. Closing it fully requires OS advisory locks (flock/fcntl)
 * or renameat2(RENAME_NOREPLACE) -- both rejected here for NFS/portability. The
 * lease fallback is retained deliberately: removing it (never steal a live PID)
 * would DEADLOCK the lock whenever a dead holder's PID is reused or on any
 * no-signature platform. The exposure is bounded in depth: (1) on darwin/linux a
 * live holder normally has a verifiable signature -> "alive" -> never stolen, and
 * PID reuse -> signature MISMATCH -> "dead" -> safely stolen, so "unknown" means a
 * transient probe failure; (2) renewLimitLock re-captures a null signature so a
 * one-time hiccup self-heals; (3) ledger writes are generation-CAS'd and fenced
 * by verifyLockOwnership, so a transient dual belief does not commit corrupt
 * record fields. See the T-424 follow-up issue for a re-read-before-rename ledger
 * hardening that shrinks the window further.
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { safeUnlinkLock, sleepMs } from "../autonomous/liveness.js";
import { captureProcessSignatureSync, inspectProcessIdentitySync } from "./process-identity.js";

const LOCK_MAX_BYTES = 4_096;
const DEFAULT_DEADLINE_MS = 2_000;
const DEFAULT_POLL_MS = 25;
export const DEFAULT_LEASE_MS = 10_000;
const UNREADABLE_BREAK_MS = 30_000;
/** A lease timestamp this far in the future is bogus (corrupt clock/body), not skew -- treat as expired. */
const FUTURE_SKEW_MAX_MS = 300_000;

export interface LimitLockHandle {
  lockPath: string;
  token: string;
  inode: number | null;
  tmpPath: string;
}

export interface LimitLockOptions {
  deadlineMs?: number;
  pollMs?: number;
  leaseMs?: number;
}

interface LimitLockBody {
  pid: number;
  token: string;
  acquiredAt: number;
  renewedAt: number;
  processSignature: string | null;
}

export class LimitLockError extends Error {
  constructor(lockPath: string) {
    super(`Could not acquire limit lock at ${lockPath}`);
    this.name = "LimitLockError";
  }
}

function getOurUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

interface HolderInspection {
  state: "steal" | "poll";
  ino: number | null;
  token: string | null;
  // The `renewedAt` observed in the holder's body at inspect time (null when
  // there was no readable body). A steal fences on this too: if the holder
  // renews the lease in place (same inode+token, newer renewedAt) between our
  // inspect and our unlink, the lock is fresh and must NOT be stolen.
  renewedAt: number | null;
}

/**
 * Read the whole lock body from an open fd. fs.readSync may return FEWER bytes
 * than requested (a short read); a single unchecked read leaves the tail of the
 * buffer zero-filled, and JSON.parse over those trailing NULs throws -- making a
 * live, valid lock look corrupt (misclassified as unreadable, then stolen).
 * Loop until EOF or the buffer fills, and decode only the bytes actually read.
 */
function readLockBody(fd: number, size: number): string {
  const cap = Math.min(size > 0 ? size : 0, LOCK_MAX_BYTES);
  if (cap <= 0) return "";
  const buf = Buffer.alloc(cap);
  let read = 0;
  while (read < buf.length) {
    const n = fs.readSync(fd, buf, read, buf.length - read, read);
    if (n <= 0) break;
    read += n;
  }
  return buf.subarray(0, read).toString("utf-8");
}

function inspectHolder(lockPath: string, leaseMs: number, now: number): HolderInspection {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // ENOENT: the lock vanished between the caller's EEXIST and this open. Do
    // NOT return "steal" -- that would send a null inode into safeUnlinkLock,
    // which with no fence unconditionally unlinks whatever races back onto the
    // path (dual ownership). POLL instead: the caller retries linkSync, which
    // now succeeds against the empty path.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "poll", ino: null, token: null, renewedAt: null };
    return unreadableDisposition(lockPath, now);
  }
  try {
    const st = fs.fstatSync(fd);
    const myUid = getOurUid();
    if (!st.isFile() || (myUid >= 0 && st.uid !== myUid) || st.size > LOCK_MAX_BYTES || st.size < 0) {
      return unreadableDisposition(lockPath, now, st.ino);
    }
    let body: LimitLockBody;
    try {
      body = JSON.parse(readLockBody(fd, st.size)) as LimitLockBody;
    } catch {
      return unreadableDisposition(lockPath, now, st.ino);
    }
    if (!body || !Number.isInteger(body.pid) || body.pid <= 0 || typeof body.token !== "string" || !body.token) {
      return unreadableDisposition(lockPath, now, st.ino);
    }
    const renewedAt = Number.isFinite(body.renewedAt) ? body.renewedAt : null;
    const identity = inspectProcessIdentitySync(body.pid, body.processSignature ?? null);
    if (identity === "alive") return { state: "poll", ino: st.ino, token: body.token, renewedAt };
    if (identity === "dead") return { state: "steal", ino: st.ino, token: body.token, renewedAt };
    // unknown: honor the lease.
    const base = Math.max(
      Number.isFinite(body.acquiredAt) ? body.acquiredAt : 0,
      Number.isFinite(body.renewedAt) ? body.renewedAt : 0,
    );
    if (base > now + FUTURE_SKEW_MAX_MS) return { state: "steal", ino: st.ino, token: body.token, renewedAt };
    if (now - base > leaseMs) return { state: "steal", ino: st.ino, token: body.token, renewedAt };
    return { state: "poll", ino: st.ino, token: body.token, renewedAt };
  } catch {
    return unreadableDisposition(lockPath, now);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function unreadableDisposition(lockPath: string, now: number, ino: number | null = null): HolderInspection {
  // A steal MUST be fenceable: safeUnlinkLock needs a non-null inode to
  // guarantee it unlinks only the exact file we inspected. With no inode (open
  // failed, or the fstat that would supply one never ran) we cannot fence, so we
  // must never break the lock -- a fresh valid lock may have raced onto the path.
  // POLL until we can read an inode or the caller's deadline expires.
  if (ino == null) return { state: "poll", ino: null, token: null, renewedAt: null };
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    return { state: "poll", ino, token: null, renewedAt: null };
  }
  if (mtimeMs > 0 && now - mtimeMs > UNREADABLE_BREAK_MS) return { state: "steal", ino, token: null, renewedAt: null };
  return { state: "poll", ino, token: null, renewedAt: null };
}

export function acquireLimitLock(lockPath: string, opts: LimitLockOptions = {}): LimitLockHandle | null {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  try {
    fs.mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    // best-effort; the link below surfaces real failures
  }
  const token = randomBytes(16).toString("hex");
  const now = Date.now();
  const body: LimitLockBody = {
    pid: process.pid,
    token,
    acquiredAt: now,
    renewedAt: now,
    processSignature: captureProcessSignatureSync(process.pid),
  };
  const tmpPath = `${lockPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(body), { mode: 0o600 });
  } catch {
    return null;
  }
  let success = false;
  let breakFailures = 0;
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs) {
      try {
        fs.linkSync(tmpPath, lockPath);
        success = true;
        let ino: number | null = null;
        try {
          // linkSync made lockPath a hardlink of tmpPath, so they share one
          // inode. Read it from tmpPath (unique to us) -- statting lockPath could
          // adopt a thief's inode if a steal lands in this gap.
          ino = fs.statSync(tmpPath).ino;
        } catch {
          // fencing falls back to token-only comparison
        }
        return { lockPath, token, inode: ino, tmpPath };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          const holder = inspectHolder(lockPath, leaseMs, Date.now());
          // A steal requires a non-null inode to fence safeUnlinkLock against;
          // dispositions never emit steal+null-inode, but guard defensively so a
          // future one cannot blind-unlink a live lock.
          if (holder.state === "steal" && holder.ino != null) {
            const r = safeUnlinkLock(lockPath, holder.ino, holder.token, holder.renewedAt);
            if (!r.unlinked && r.reason !== "raced") {
              breakFailures++;
              if (breakFailures >= 2) return null;
              sleepMs(pollMs);
            }
            continue;
          }
          sleepMs(pollMs);
          continue;
        }
        // Unsupported filesystem or anything unexpected: fail closed.
        return null;
      }
    }
    return null;
  } finally {
    if (!success) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }
}

export function releaseLimitLock(handle: LimitLockHandle): void {
  safeUnlinkLock(handle.lockPath, handle.inode, handle.token);
  try {
    fs.unlinkSync(handle.tmpPath);
  } catch {
    // ignore
  }
}

/**
 * Fencing check: does the lock file still carry OUR token on OUR inode?
 * Callers verify immediately before their atomic rename; on false they must
 * discard the mutation, re-read, and retry.
 */
export function verifyLockOwnership(handle: LimitLockHandle): boolean {
  let fd: number;
  try {
    fd = fs.openSync(handle.lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > LOCK_MAX_BYTES) return false;
    if (handle.inode != null && st.ino !== handle.inode) return false;
    const body = JSON.parse(readLockBody(fd, st.size)) as { token?: unknown };
    return body?.token === handle.token;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/**
 * Renew the lease for holders whose critical section may outlive it. Returns
 * false when ownership was already lost, and mutates handle.inode to the freshly
 * published inode on success.
 *
 * CRITICAL: renewal publishes on a FRESH inode (write a temp, atomically rename
 * it over the lock path) rather than mutating the existing inode in place. This
 * is what makes renewal and stealing MUTUALLY EXCLUSIVE against a contender's
 * verified unlink: safeUnlinkLock opens an fd on the inode it inspected and, as
 * its final act, re-lstats the path and refuses to unlink if the path no longer
 * names that inode. An in-place renewal (same inode) is invisible to that fence,
 * so a contender could read the old renewedAt, the holder could renew in place,
 * and the contender's inode fence would still pass and evict the fresh lock. By
 * swapping the inode on every renewal, ANY renewal that COMPLETES before a
 * contender inspects the path changes the inode, so that contender fails its
 * final fence and backs off. Before the rename we re-verify the path still names
 * our inode (step 3), and after it we confirm the path names our freshly-written
 * inode carrying our token (step 5) -- so renewal never renames over a successor
 * it can see, and never reports success unless it can confirm it published.
 *
 * NOT fully atomic: a single-syscall gap remains between step 3's lstat and the
 * rename (a contender could unlink+link a successor there, which the rename then
 * clobbers) and between a contender's final lstat and its unlink (which could
 * remove our just-renamed inode). Closing these fully needs renameat2(
 * RENAME_NOREPLACE), which is not portable. They are reachable ONLY when the
 * holder is identity-"unknown" (null processSignature) AND its lease has expired
 * while it is actually alive -- on darwin/linux a live holder with a captured
 * signature is "alive" and is never stolen, and renewal re-captures a null
 * signature (see below) to reach that state. The residual is contained in depth:
 * every ledger writer re-verifies ownership immediately before its atomic commit
 * (verifyLockOwnership) and drops its write on loss, and record mutations are
 * generation-CAS'd -- so a transient dual belief never commits corrupt data.
 */
export function renewLimitLock(handle: LimitLockHandle): boolean {
  // 1) Confirm we still own the lock (current path inode + token).
  let curIno: number;
  let body: LimitLockBody;
  let fd: number;
  try {
    fd = fs.openSync(handle.lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > LOCK_MAX_BYTES) return false;
    if (handle.inode != null && st.ino !== handle.inode) return false;
    body = JSON.parse(readLockBody(fd, st.size)) as LimitLockBody;
    if (body?.token !== handle.token) return false;
    curIno = st.ino;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }

  // 2) Write the renewed body to a fresh temp file. Capture the temp's inode
  // (rename preserves it) so step 5 can confirm THAT exact inode landed at the
  // path -- distinguishing "we published" from "a contender replaced it".
  body.renewedAt = Date.now();
  // Re-capture our identity if `ps`/procfs failed at acquire time (signature
  // null). Without this a one-time hiccup leaves a LIVE holder permanently
  // identity-"unknown" -> lease-only -> stealable while running; a fresh
  // signature makes it "alive" so contenders poll instead of racing a steal.
  if (body.processSignature == null) {
    body.processSignature = captureProcessSignatureSync(process.pid);
  }
  const tmpPath = `${handle.lockPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}`;
  let tmpFd: number;
  try {
    tmpFd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch {
    return false;
  }
  let publishedIno: number;
  try {
    const out = Buffer.from(JSON.stringify(body), "utf-8");
    // writeSync may write fewer bytes than requested; loop until complete or a
    // short write would leave the renewed body malformed.
    let written = 0;
    while (written < out.length) {
      const n = fs.writeSync(tmpFd, out, written, out.length - written, written);
      if (n <= 0) {
        cleanupTmp(tmpPath);
        return false;
      }
      written += n;
    }
    publishedIno = fs.fstatSync(tmpFd).ino;
  } catch {
    cleanupTmp(tmpPath);
    return false;
  } finally {
    try {
      fs.closeSync(tmpFd);
    } catch {
      // ignore
    }
  }

  // 3) Re-verify ownership immediately before the rename: if a contender has
  // stolen the path (its inode differs from ours) since step 1, do NOT rename
  // over the successor -- step down instead. (rename is not conditional, so this
  // check narrows the clobber window to the syscall gap below.)
  try {
    if (fs.lstatSync(handle.lockPath).ino !== curIno) {
      cleanupTmp(tmpPath);
      return false;
    }
  } catch {
    cleanupTmp(tmpPath);
    return false;
  }

  // 4) Atomically publish the renewal on the fresh inode.
  try {
    fs.renameSync(tmpPath, handle.lockPath);
  } catch {
    cleanupTmp(tmpPath);
    return false;
  }

  // 5) Confirm the publication actually landed and is still OURS: the path must
  // name the exact inode we just wrote AND carry our token. If a contender
  // unlinked our fresh inode (ENOENT) or replaced the path in the rename gap,
  // we do NOT own the lock -- report failure so the caller stops trusting the
  // lease (never return true on an ENOENT/foreign inode, which would leave a
  // ghost holder). The caller's own write-fence (verifyLockOwnership before its
  // atomic commit) is the backstop that keeps a raced writer from committing.
  if (!confirmPublished(handle.lockPath, handle.token, publishedIno)) return false;
  handle.inode = publishedIno;
  return true;
}

/**
 * After a renewal's rename, confirm the lock path names the inode we just wrote
 * AND its body still carries our token. Read-only; does NOT mutate the handle.
 */
function confirmPublished(lockPath: string, token: string, expectedIno: number): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.ino !== expectedIno || !st.isFile() || st.size > LOCK_MAX_BYTES) return false;
    const body = JSON.parse(readLockBody(fd, st.size)) as { token?: unknown };
    return body?.token === token;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function cleanupTmp(tmpPath: string): void {
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // ignore
  }
}

/** Run `fn` under the lock. Throws LimitLockError when the lock cannot be acquired. */
export function withLimitLock<T>(lockPath: string, fn: (handle: LimitLockHandle) => T, opts: LimitLockOptions = {}): T {
  const handle = acquireLimitLock(lockPath, opts);
  if (!handle) throw new LimitLockError(lockPath);
  try {
    return fn(handle);
  } finally {
    releaseLimitLock(handle);
  }
}
