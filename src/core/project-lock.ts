/**
 * ISS-942: async, identity-verified project lock for `.story/.lock`, replacing
 * proper-lockfile's bare mtime staleness check.
 *
 * Steal policy is stricter than limit-lock.ts's: this lock NEVER steals from an
 * identity-"unknown" holder, only from a provably-"dead" one (ESRCH, or a live
 * pid whose signature mismatches -- proving PID reuse). limit-lock.ts's lease
 * fallback (steal "unknown" after a lease expires) is a documented, accepted
 * residual there because the ledger locks it protects are ALSO generation-CAS'd.
 * `.story/.lock` has no such backstop -- a wrongful steal here can unlink a live
 * holder's real, unrecoverable state. There is therefore no lease/leaseMs
 * concept at all: an identity that can never be resolved (unsupported platform,
 * a stuck `ps`/procfs) leaves the lock permanently unreclaimable rather than
 * risk a wrongful unlink. This is the issue's own fail direction: hang a
 * contender, never remove a live holder's state.
 *
 * `safeUnlinkLock` (autonomous/liveness.ts) still has an unavoidable
 * lstat-then-unlinkSync TOCTOU gap at the syscall level -- fenced by
 * `verifyProjectLockOwnership` immediately before every commit (see
 * project-loader.ts's atomicWrite/atomicCreate/fencedUnlink/fencedLink), same
 * as limit-lock.ts's own containment pattern. Fencing narrows but does not
 * close the double-grant race for ordinary (non-CAS'd) project files, so the
 * steal path itself is additionally SERIALIZED: only one contender at a time
 * may remove-and-reacquire a stale `.story/.lock`, via a second, deliberately
 * trivial, NON-RECLAIMABLE mutex at `.story/.lock-steal` (bare mkdir/rmdir, no
 * identity, no automatic reclaim -- a stuck steal-lock fails explicit rather
 * than being auto-healed, exactly like the legacy-directory-lock case below).
 * An earlier design gave the steal-lock the same identity-based reclaim logic
 * as the primary lock; that recursively reintroduces the identical race one
 * layer down, which is why it has none at all.
 *
 * Legacy lock format: today's `.story/.lock` (proper-lockfile, pre-1.9.0) is a
 * bare directory with no identity information. Detecting one is not treated as
 * an immediate error -- a live older-version holder's directory lock is healthy,
 * transient contention during a mixed-version upgrade window, so it is polled
 * exactly like any other contended acquire and only reported (actionable error,
 * never auto-removed) once the deadline is exhausted with the directory still
 * present.
 */

import * as fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { safeUnlinkLock } from "../autonomous/liveness.js";
import { captureProcessSignatureSync, inspectProcessIdentitySync, type ProcessIdentity } from "./limit-lock.js";
import { ProjectLoaderError } from "./errors.js";

const LOCK_MAX_BYTES = 4_096;
const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_POLL_MS = 50;
const IDENTITY_CACHE_TTL_MS = 500;
const IDENTITY_CACHE_PRUNE_AGE_MS = 5_000;

export interface ProjectLockHandle {
  lockPath: string;
  token: string;
  inode: number | null;
  tmpPath: string;
  pid: number;
  processSignature: string | null;
}

export interface ProjectLockOptions {
  deadlineMs?: number;
  pollMs?: number;
}

interface ProjectLockBody {
  pid: number;
  token: string;
  acquiredAt: number;
  processSignature: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Debug-gated diagnostic log, same convention as autonomous/liveness.ts's livenessLog. */
function projectLockLog(tag: string, detail: Record<string, unknown>): void {
  const debug = process.env.STORYBLOQ_LIVENESS_DEBUG ?? process.env.CLAUDESTORY_LIVENESS_DEBUG;
  if (debug !== "1") return;
  try {
    process.stderr.write("project-lock:" + tag + " " + JSON.stringify(detail) + "\n");
  } catch {
    /* best-effort */
  }
}

// --- Test-only injectable seams (harmless in production: never set outside tests). ---
export const __projectLockTestHooks: {
  /** Fires once, immediately after the steal-lock is acquired, before re-verification. May throw. */
  duringSteal: (() => void) | null;
  /** Fires once, immediately before the stealer's own unlink of the dead lock. */
  beforeStealUnlink: (() => void) | null;
  /** Fires once, immediately before the stealer's own link of its tmp onto the lock path. */
  beforeStealLink: (() => void) | null;
} = {
  duringSteal: null,
  beforeStealUnlink: null,
  beforeStealLink: null,
};

function fireOnce(key: keyof typeof __projectLockTestHooks): void {
  const cb = __projectLockTestHooks[key];
  if (!cb) return;
  __projectLockTestHooks[key] = null;
  cb();
}

// --- Module-level, process-wide identity cache, keyed by the lock body's token
// (a fresh random value per acquisition -- cannot collide across distinct
// holders regardless of inode/pid reuse). Shared across all concurrent
// acquireProjectLockAsync calls so N waiters on one contended lock make
// roughly one ps/procfs call per cache window, not N. ---
const identityCache = new Map<string, { identity: ProcessIdentity; cachedAt: number }>();
let lastPruneAt = 0;

function pruneIdentityCacheIfDue(now: number): void {
  if (now - lastPruneAt < IDENTITY_CACHE_PRUNE_AGE_MS) return;
  lastPruneAt = now;
  for (const [key, entry] of identityCache) {
    if (now - entry.cachedAt > IDENTITY_CACHE_PRUNE_AGE_MS) identityCache.delete(key);
  }
}

// Our own signature never changes for the life of this process -- compute it
// once, lazily, instead of once per self-pid check.
let ownSignatureCache: string | null | undefined;
function ownSignature(): string | null {
  if (ownSignatureCache === undefined) ownSignatureCache = captureProcessSignatureSync(process.pid);
  return ownSignatureCache;
}

function classifyIdentityCached(pid: number, signature: string | null, token: string): ProcessIdentity {
  if (pid === process.pid) {
    // A recorded pid equal to our own does NOT prove the record is ours: the
    // OS can reuse a dead holder's pid for us after a crash. A recorded
    // signature that mismatches our own current one is proof of exactly that
    // PID reuse and must classify "dead" -- shortcutting to "alive" here
    // (as an earlier version of this function did, unconditionally) would
    // make such a stale lock permanently unreclaimable for this process's
    // entire lifetime, since every future check would hit this same
    // self-pid branch without ever comparing signatures. Only a NULL
    // recorded signature (nothing to contradict us) or an unresolvable own
    // signature (can't verify either way) is treated as "alive" -- both are
    // the "cannot disprove it's us" case, not proof that it's a stranger.
    if (signature == null) return "alive";
    const mine = ownSignature();
    if (mine == null) return "alive";
    return mine === signature ? "alive" : "dead";
  }
  const now = Date.now();
  pruneIdentityCacheIfDue(now);
  const cached = identityCache.get(token);
  if (cached && now - cached.cachedAt < IDENTITY_CACHE_TTL_MS) return cached.identity;
  const identity = inspectProcessIdentitySync(pid, signature);
  identityCache.set(token, { identity, cachedAt: now });
  return identity;
}

/** Read the whole lock body from an open fd, looping past short reads (see limit-lock.ts's readLockBody). */
function readBody(fd: number, size: number): string {
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

interface HolderInspection {
  state: "poll" | "legacy" | "dead";
  ino: number | null;
  token: string | null;
}

function getOurUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

/**
 * Inspect the current holder of `lockPath`. Never returns a "steal-eligible"
 * verdict for anything but a provably dead identity -- an unreadable body, a
 * live holder, or an unresolvable identity all classify "poll" (never stolen,
 * per the never-steal-"unknown" policy). A directory at the path is the legacy
 * proper-lockfile format, classified "legacy" and handled by the caller as
 * ordinary contention, not corruption.
 */
function inspectHolder(lockPath: string): HolderInspection {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    // ENOENT (vanished -- next ordinary link attempt succeeds), ELOOP (a
    // symlink sits at the path, no identity signal), or anything else
    // unexpected: never steal without a readable body to reason about.
    return { state: "poll", ino: null, token: null };
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return { state: "legacy", ino: null, token: null };
    const myUid = getOurUid();
    if (!st.isFile() || (myUid >= 0 && st.uid !== myUid) || st.size > LOCK_MAX_BYTES || st.size < 0) {
      return { state: "poll", ino: st.ino, token: null };
    }
    let body: Partial<ProjectLockBody> | null;
    try {
      body = JSON.parse(readBody(fd, st.size)) as Partial<ProjectLockBody>;
    } catch {
      return { state: "poll", ino: st.ino, token: null };
    }
    if (!body || !Number.isInteger(body.pid) || (body.pid as number) <= 0 || typeof body.token !== "string" || !body.token) {
      return { state: "poll", ino: st.ino, token: null };
    }
    const identity = classifyIdentityCached(body.pid as number, body.processSignature ?? null, body.token);
    if (identity === "dead") return { state: "dead", ino: st.ino, token: body.token };
    return { state: "poll", ino: st.ino, token: body.token };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The steal-lock: a deliberately trivial, NON-RECLAIMABLE mkdir/rmdir mutex
 * serializing only the remove-and-reacquire of a proven-dead `.story/.lock`.
 * No identity, no body, no automatic reclaim of any kind -- a stuck steal-lock
 * (a crash mid-critical-section) fails explicit and must be removed manually,
 * the same fail-explicit posture as the legacy-directory-lock case. A smaller
 * critical section is a lower probability of getting stuck, not a correctness
 * argument for auto-healing it; giving this its own reclaim logic would
 * recursively reintroduce the exact race it exists to close, one layer down.
 */
async function acquireStealLock(stealLockPath: string, deadlineMs: number, pollMs: number, startedAt: number): Promise<void> {
  while (true) {
    try {
      fs.mkdirSync(stealLockPath, { mode: 0o700 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new ProjectLoaderError("io_error", `Failed to acquire steal-lock at ${stealLockPath}`, err);
      }
      if (Date.now() - startedAt >= deadlineMs) {
        throw new ProjectLoaderError(
          "io_error",
          `${stealLockPath} is stuck (a steal was interrupted mid-critical-section and is never automatically ` +
            `reclaimed). Confirm no other storybloq process is running against this project, then remove ` +
            `${stealLockPath} manually.`,
        );
      }
      await sleep(pollMs);
    }
  }
}

function releaseStealLock(stealLockPath: string): void {
  try {
    fs.rmdirSync(stealLockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // already gone -- fine.
    // Best-effort by design: this runs in a `finally`, and a caller that just
    // successfully stole the primary lock must keep that valid handle rather
    // than have an unrelated secondary-mutex cleanup failure destroy it (the
    // same "leak, never destroy" direction as everywhere else in this
    // module). The cost is a leaked, non-reclaimable .lock-steal that blocks
    // every future steal until an operator removes it -- surface that loudly
    // via the debug log so it is diagnosable instead of silent.
    projectLockLog("steal-lock-release-failed", { path: stealLockPath, code });
  }
}

type StealOutcome = "acquired" | "retry";

/**
 * Serialized steal: acquire the steal-lock, re-verify (double-checked -- the
 * pre-lock read that triggered this call is advisory only) that the SAME
 * incarnation (matching inode+token) is still dead, then unlink+link under the
 * steal-lock's protection. Any mismatch (voluntarily released, or a different
 * incarnation now present -- live or otherwise) backs off without touching
 * anything. If our own link loses a narrow race to a fresh, ordinary acquirer
 * (EEXIST), that acquirer's lock is exactly as valid as any uncontended
 * acquire -- back off, do not remove it.
 */
async function attemptSteal(
  lockPath: string,
  stealLockPath: string,
  tmpPath: string,
  observedIno: number,
  observedToken: string,
  deadlineMs: number,
  pollMs: number,
  startedAt: number,
): Promise<StealOutcome> {
  await acquireStealLock(stealLockPath, deadlineMs, pollMs, startedAt);
  try {
    fireOnce("duringSteal");
    const fresh = inspectHolder(lockPath);
    if (fresh.state !== "dead" || fresh.ino !== observedIno || fresh.token !== observedToken) {
      return "retry";
    }
    try {
      fireOnce("beforeStealUnlink");
      fs.unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProjectLoaderError("io_error", `Failed to remove dead project lock at ${lockPath}`, err);
      }
      // Already gone (voluntarily released between inspect and unlink) -- fine.
    }
    try {
      fireOnce("beforeStealLink");
      fs.linkSync(tmpPath, lockPath);
      return "acquired";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // A fresh, ordinary acquirer slipped into the gap between our unlink
        // and our link. Its lock is exactly as valid as any uncontended
        // acquire -- retry the whole sequence from scratch, do not touch it.
        return "retry";
      }
      throw new ProjectLoaderError("io_error", `Failed to publish project lock at ${lockPath} after steal`, err);
    }
  } finally {
    releaseStealLock(stealLockPath);
  }
}

/**
 * Acquire `.story/.lock`, polling asynchronously (never blocks the event
 * loop). Throws ProjectLoaderError("io_error", ...) on deadline exhaustion,
 * whether the deadline was spent waiting on a live/unknown holder, a legacy
 * directory lock, or a stuck steal-lock.
 */
export async function acquireProjectLockAsync(lockPath: string, opts: ProjectLockOptions = {}): Promise<ProjectLockHandle> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const stealLockPath = `${lockPath}-steal`;

  try {
    fs.mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort; the link below surfaces real failures */
  }

  const token = randomBytes(16).toString("hex");
  const pid = process.pid;
  const processSignature = captureProcessSignatureSync(pid);
  const body: ProjectLockBody = { pid, token, acquiredAt: Date.now(), processSignature };
  // randomUUID() (122 bits of entropy), created with O_EXCL: two concurrent
  // acquireProjectLockAsync calls in the SAME process (different projects, or
  // a burst against the same one) must never collide on this path -- a
  // collision under plain "w" (truncate, not exclusive) would silently let
  // one call's body overwrite the other's, publishing a token that doesn't
  // match the losing caller's returned handle and leaving it unable to ever
  // verify or release its own (self-owned but unverifiable) lock.
  const tmpPath = `${lockPath}.tmp.${pid}.${randomUUID()}`;
  try {
    const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      // fs.writeSync can perform a short write; loop until the whole buffer
      // is flushed, or a truncated lock body gets linked into place and every
      // contender's ownership verification (JSON.parse) breaks immediately.
      const buf = Buffer.from(JSON.stringify(body));
      let written = 0;
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written);
        if (n <= 0) throw new Error("Project lock body write made no progress");
        written += n;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort; preparation already failed and the tmp path is orphaned either way */
    }
    throw new ProjectLoaderError("io_error", `Failed to prepare project lock body at ${tmpPath}`, err);
  }

  const startedAt = Date.now();
  let success = false;
  try {
    while (true) {
      try {
        fs.linkSync(tmpPath, lockPath);
        success = true;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw new ProjectLoaderError("io_error", `Failed to acquire project lock at ${lockPath}`, err);
        }
      }

      const holder = inspectHolder(lockPath);

      if (holder.state === "legacy") {
        if (Date.now() - startedAt >= deadlineMs) {
          throw new ProjectLoaderError(
            "io_error",
            `${lockPath} is a legacy-format lock (pre-1.9.0 storybloq, directory-based). Confirm no older-version ` +
              `storybloq process is running against this project, then remove ${lockPath} manually.`,
          );
        }
        await sleep(pollMs);
        continue;
      }

      if (holder.state === "dead") {
        if (Date.now() - startedAt >= deadlineMs) {
          throw new ProjectLoaderError("io_error", `Timed out acquiring project lock at ${lockPath}`);
        }
        const outcome = await attemptSteal(
          lockPath,
          stealLockPath,
          tmpPath,
          holder.ino as number,
          holder.token as string,
          deadlineMs,
          pollMs,
          startedAt,
        );
        if (outcome === "acquired") {
          success = true;
          break;
        }
        continue; // "retry": loop back to an ordinary link attempt immediately.
      }

      // "poll": alive or unknown/unreadable identity -- never stolen. This is
      // the "hang a contender, never remove a live holder's state" mandate.
      if (Date.now() - startedAt >= deadlineMs) {
        throw new ProjectLoaderError("io_error", `Timed out acquiring project lock at ${lockPath}`);
      }
      await sleep(pollMs);
    }

    let ino: number | null = null;
    try {
      ino = fs.statSync(tmpPath).ino;
    } catch {
      /* fencing falls back to token-only comparison */
    }
    return { lockPath, token, inode: ino, tmpPath, pid, processSignature };
  } finally {
    if (!success) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Releases the lock via the shared verified-unlink primitive; never breaks a successor's fresh lock. */
export function releaseProjectLock(handle: ProjectLockHandle): void {
  safeUnlinkLock(handle.lockPath, handle.inode, handle.token);
  try {
    fs.unlinkSync(handle.tmpPath);
  } catch {
    /* ignore */
  }
}

/**
 * Fencing check: does the lock file still carry OUR token on OUR inode?
 * Callers verify immediately before their atomic commit syscall; on false they
 * must discard the mutation rather than commit it. Structurally identical to
 * limit-lock.ts's verifyLockOwnership, duplicated rather than imported since
 * that function is private to LimitLockHandle and limit-lock.ts is out of
 * scope for this fix.
 */
export function verifyProjectLockOwnership(handle: ProjectLockHandle): boolean {
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
    const body = JSON.parse(readBody(fd, st.size)) as { token?: unknown };
    return body?.token === handle.token;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}
