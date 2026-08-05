import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { BusError } from "./errors.js";
import { canonicalHash } from "./canonical.js";
import { syncDirectory } from "./io.js";

const execFileAsync = promisify(execFile);
const LOCK_MAX_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 20;

const LockBodySchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  acquiredAt: z.string().datetime({ offset: true }),
  processSignature: z.string().min(1).max(512).nullable(),
}).strict();

type LockBody = z.infer<typeof LockBodySchema>;

export interface HardenedLockHandle {
  readonly lockPath: string;
  readonly token: string;
  readonly inode: number;
  readonly tempPath: string;
}

export interface HardenedLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  // When false, NEVER mkdir the lock's parent directory. If the parent is absent the
  // acquisition fails closed (`not_found`) instead of re-creating it. Used by cleanup
  // paths that must never resurrect a deleted runtime (T-428): a guard acquired to remove
  // a waiter must not re-materialize `.story/bus/locks` after the runtime was deleted.
  readonly create?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireReaperGuard(
  lockPath: string,
  deadline: number,
  pollMs: number,
): Promise<HardenedLockHandle> {
  const guardPath = `${lockPath}.reap`;
  // The linked guard shares the staged temp's inode (returned by writeLockTemp from its own
  // handle, so there is no leak-prone lstat outside a cleanup scope); post-link cleanup uses it
  // to prove ownership before removing (never unlink a guard a racing contender may have re-created).
  const { token, tempPath, inode: stagedInode } = await writeLockTemp(guardPath);

  let linked = false;
  try {
    while (Date.now() <= deadline) {
      try {
        await link(tempPath, guardPath);
        linked = true;
        await syncDirectory(dirname(guardPath));
        return { lockPath: guardPath, token, inode: (await lstat(guardPath)).ino, tempPath };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new BusError("io_error", `Cannot acquire reaper guard for ${basename(lockPath)}`, err);
        }
      }
      await delay(pollMs);
    }
    throw new BusError("lock_timeout", `Timed out acquiring reaper guard for ${basename(lockPath)}`);
  } catch (err) {
    // A post-link failure must remove OUR guard hardlink (verified by inode+token, dir-synced
    // for crash durability) so it is not held forever -- but never remove one a contender owns.
    if (linked) await compareAndUnlink(guardPath, stagedInode, token).catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

export async function captureProcessSignature(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "uid=,lstart=,command="], {
        timeout: 500,
        maxBuffer: 128 * 1024,
      });
      const normalized = stdout.trim().replace(/\s+/g, " ");
      return normalized ? `darwin:${canonicalHash(normalized)}` : null;
    }
    if (process.platform === "linux") {
      const procStat = await open(`/proc/${pid}/stat`, "r");
      let raw: string;
      try { raw = await procStat.readFile("utf-8"); } finally { await procStat.close(); }
      const rightParen = raw.lastIndexOf(")");
      if (rightParen < 0) return null;
      const fields = raw.slice(rightParen + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      const proc = await stat(`/proc/${pid}`);
      return startTicks ? `linux:${proc.uid}:${startTicks}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export type ProcessState = "alive" | "dead" | "unknown";

export async function inspectProcessIdentity(pid: number, expectedSignature: string | null): Promise<ProcessState> {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
  if (!expectedSignature) return "unknown";
  const actual = await captureProcessSignature(pid);
  if (!actual) return "unknown";
  return actual === expectedSignature ? "alive" : "dead";
}

type LockReadResult =
  | { readonly status: "ok"; readonly body: LockBody; readonly inode: number }
  | { readonly status: "missing" }
  | { readonly status: "invalid" };

async function readLock(path: string): Promise<LockReadResult> {
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > LOCK_MAX_BYTES) return { status: "invalid" };
    const parsed = LockBodySchema.safeParse(JSON.parse(await handle.readFile("utf-8")));
    return parsed.success
      ? { status: "ok", body: parsed.data, inode: fileStat.ino }
      : { status: "invalid" };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function compareAndUnlink(path: string, expectedInode: number, expectedToken: string): Promise<boolean> {
  let handle;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.ino !== expectedInode || fileStat.size > LOCK_MAX_BYTES) return false;
    const parsed = LockBodySchema.safeParse(JSON.parse(await handle.readFile("utf-8")));
    if (!parsed.success || parsed.data.token !== expectedToken) return false;
    const linked = await lstat(path);
    if (linked.isSymbolicLink() || linked.ino !== fileStat.ino) return false;
    await unlink(path);
    await syncDirectory(dirname(path));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Non-waiting reaper guard: exactly one atomic link attempt, null on contention (never polls).
// Used by the single-attempt try-lock so dead-holder reclamation cannot reintroduce a wait.
async function tryAcquireReaperGuard(lockPath: string): Promise<HardenedLockHandle | null> {
  const guardPath = `${lockPath}.reap`;
  const { token, tempPath, inode: stagedInode } = await writeLockTemp(guardPath);
  let linked = false;
  try {
    await link(tempPath, guardPath);
    linked = true;
    await syncDirectory(dirname(guardPath));
    return { lockPath: guardPath, token, inode: (await lstat(guardPath)).ino, tempPath };
  } catch (err) {
    // A post-link failure must remove OUR guard hardlink (ownership-verified + dir-synced), or
    // it leaks and the guard is held forever. Only a bare `link` EEXIST (linked still false) is
    // benign contention.
    if (linked) await compareAndUnlink(guardPath, stagedInode, token).catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    if (!linked && (err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw new BusError("io_error", `Cannot acquire reaper guard for ${basename(lockPath)}`, err);
  }
}

async function prepareLockParent(lockPath: string, options: HardenedLockOptions): Promise<void> {
  if (options.create === false) {
    // Non-creating mode: refuse if the parent directory is absent, so a cleanup racing a
    // runtime deletion cannot re-materialize it (the check-to-open window is closed by
    // relying on this refusal, not the caller's existsSync precheck). lstat is no-follow.
    const parent = dirname(lockPath);
    let pstat;
    try {
      pstat = await lstat(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BusError("not_found", `Lock parent ${basename(parent)} is absent; refusing to create it.`, err);
      }
      throw err;
    }
    if (pstat.isSymbolicLink() || !pstat.isDirectory()) {
      throw new BusError("corrupt", `Lock parent ${basename(parent)} is a symlink or not a directory.`);
    }
  } else {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  }
}

async function writeLockTemp(lockPath: string): Promise<{ token: string; tempPath: string; inode: number }> {
  const token = randomBytes(32).toString("hex");
  const body: LockBody = {
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    processSignature: await captureProcessSignature(process.pid),
  };
  const tempPath = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
  const tempHandle = await open(tempPath, "wx", 0o600);
  // Preserve the original acquisition path's contract: a close() failure is NOT swallowed, it
  // propagates like a write/sync failure. The first error wins (a write/sync error is not masked
  // by a later close error). Any staging failure cleans up the temp file before rethrowing, so a
  // failed stage never leaves an orphan (the caller only unlinks tempPath after a success). The
  // inode is captured from THIS handle (before close), so callers never need a separate,
  // leak-prone lstat between staging and their own cleanup scope.
  let primaryErr: unknown = null;
  let inode = 0;
  try {
    await tempHandle.writeFile(JSON.stringify(body), "utf-8");
    await tempHandle.sync();
    inode = (await tempHandle.stat()).ino;
  } catch (err) {
    primaryErr = err;
  }
  try {
    await tempHandle.close();
  } catch (err) {
    if (!primaryErr) primaryErr = err;
  }
  if (primaryErr) {
    await unlink(tempPath).catch(() => undefined);
    throw primaryErr;
  }
  return { token, tempPath, inode };
}

type AttemptResult =
  | { readonly status: "acquired"; readonly handle: HardenedLockHandle }
  | { readonly status: "retry" }
  | { readonly status: "busy" };

// Test-only seam: runs immediately AFTER the primary link publishes and BEFORE syncDirectory,
// so a test can force a post-link failure and verify the ownership-verified cleanup removes the
// published lock. Null in production (never in the acquisition path's cost).
let afterPrimaryLinkHook: (() => Promise<void>) | null = null;

// Test-only seam: fires inside acquireHardenedLock's retry loop immediately after an
// attempt yields the "busy" outcome (a live-or-unknown holder, or an unavailable
// reaper guard), before the poll-wait. Never fires on a stale-holder reclaim retry.
// Proves genuine contention on the target acquisition -- NOT confirmed holder
// liveness -- unlike a hook placed before the acquisition call, which could race
// against when that call actually runs. Fires on EVERY busy poll iteration, not just
// the first; consumers must guard for idempotent handling of a possibly-repeated
// signal. Null in production (never in the acquisition path's cost). ISS-940.
let afterBusyAcquireAttemptHook: ((lockPath: string) => Promise<void>) | null = null;

// One full acquisition attempt shared by the deadline loop and the try-lock: a single link,
// and on contention one readLock + identity check. A positively-dead holder is reclaimed via
// the caller-supplied reaper (waiting for acquireHardenedLock, non-waiting for the try-lock),
// then the caller retries the link. A live/unknown holder (or a held reaper) yields "busy".
async function attemptHardenedAcquire(
  lockPath: string,
  tempPath: string,
  token: string,
  stagedInode: number,
  acquireReaper: () => Promise<HardenedLockHandle | null>,
): Promise<AttemptResult> {
  let linked = false;
  try {
    await link(tempPath, lockPath);
    linked = true;
    if (afterPrimaryLinkHook) await afterPrimaryLinkHook();
    await syncDirectory(dirname(lockPath));
    const inode = (await lstat(lockPath)).ino;
    return { status: "acquired", handle: { lockPath, token, inode, tempPath } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // If the link PUBLISHED but a post-link step (sync/lstat) failed, remove OUR lock
      // (ownership-verified + dir-synced) before throwing. Otherwise we would leave a lock whose
      // body names this still-live process, so every later attempt reports busy until we exit.
      // A bare `link` EEXIST (linked still false) is benign contention handled below.
      if (linked) await compareAndUnlink(lockPath, stagedInode, token).catch(() => undefined);
      throw new BusError("io_error", `Cannot acquire lock ${basename(lockPath)}`, err);
    }
  }

  const existing = await readLock(lockPath);
  if (existing.status === "missing") return { status: "retry" };
  if (existing.status === "invalid") {
    throw new BusError("corrupt", `Lock ${basename(lockPath)} is unreadable and will not be broken automatically`);
  }
  const holder = await inspectProcessIdentity(existing.body.pid, existing.body.processSignature);
  if (holder !== "dead") return { status: "busy" };

  const reaper = await acquireReaper();
  if (!reaper) return { status: "busy" };
  try {
    const latest = await readLock(lockPath);
    if (latest.status === "invalid") {
      throw new BusError("corrupt", `Lock ${basename(lockPath)} became unreadable during dead-holder recovery`);
    }
    if (latest.status === "ok") {
      const latestHolder = await inspectProcessIdentity(latest.body.pid, latest.body.processSignature);
      if (latestHolder === "dead") {
        await compareAndUnlink(lockPath, latest.inode, latest.body.token);
      }
    }
  } finally {
    await releaseHardenedLock(reaper);
  }
  return { status: "retry" };
}

export async function acquireHardenedLock(
  lockPath: string,
  options: HardenedLockOptions = {},
): Promise<HardenedLockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  await prepareLockParent(lockPath, options);
  const { token, tempPath, inode: stagedInode } = await writeLockTemp(lockPath);

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() <= deadline) {
      const result = await attemptHardenedAcquire(
        lockPath,
        tempPath,
        token,
        stagedInode,
        () => acquireReaperGuard(lockPath, deadline, pollMs),
      );
      if (result.status === "acquired") return result.handle;
      // "retry" (missing lock / just-reclaimed dead holder) loops immediately; "busy"
      // (live/unknown holder) backs off a poll interval, exactly as the original loop did.
      if (result.status === "busy") {
        if (afterBusyAcquireAttemptHook) await afterBusyAcquireAttemptHook(lockPath);
        await delay(pollMs);
      }
    }
    throw new BusError("lock_timeout", `Timed out acquiring lock ${basename(lockPath)}`);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

// Non-blocking try-lock: guarantees exactly one full acquisition attempt (never the
// deadline-loop's "zero attempts if the clock already passed" hazard) and never polls.
// Returns the handle on success, or null when the lock is held by a live/unknown holder
// (busy). A positively-dead holder is reclaimed via the non-waiting reaper and one retry
// link. Throws only on genuine corruption (unreadable lock) or I/O error.
export async function tryAcquireHardenedLock(
  lockPath: string,
  options: HardenedLockOptions = {},
): Promise<HardenedLockHandle | null> {
  await prepareLockParent(lockPath, options);
  const { token, tempPath, inode: stagedInode } = await writeLockTemp(lockPath);
  try {
    // Attempt 1, then at most one retry (only after a dead-holder reclaim or a vanished lock).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await attemptHardenedAcquire(
        lockPath,
        tempPath,
        token,
        stagedInode,
        () => tryAcquireReaperGuard(lockPath),
      );
      if (result.status === "acquired") return result.handle;
      if (result.status === "busy") break;
      // "retry": fall through to exactly one more link attempt.
    }
    await unlink(tempPath).catch(() => undefined);
    return null;
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

export async function releaseHardenedLock(handle: HardenedLockHandle): Promise<void> {
  await compareAndUnlink(handle.lockPath, handle.inode, handle.token);
  await unlink(handle.tempPath).catch(() => undefined);
}

export async function withHardenedLock<T>(
  lockPath: string,
  handler: () => Promise<T>,
  options: HardenedLockOptions = {},
): Promise<T> {
  const handle = await acquireHardenedLock(lockPath, options);
  try {
    return await handler();
  } finally {
    await releaseHardenedLock(handle);
  }
}

export const __testing = {
  compareAndUnlink,
  inspectProcess: inspectProcessIdentity,
  readLock,
  // Test-only: inject a callback that runs right after the primary link publishes (before
  // syncDirectory) to force a post-link failure. Pass null to clear.
  setAfterPrimaryLinkHook(hook: (() => Promise<void>) | null): void {
    afterPrimaryLinkHook = hook;
  },
  // Test-only: inject a callback that fires on every "busy" (genuine contention)
  // outcome inside acquireHardenedLock's retry loop, before the poll-wait. Pass null
  // to clear. ISS-940.
  setAfterBusyAcquireAttemptHook(hook: ((lockPath: string) => Promise<void>) | null): void {
    afterBusyAcquireAttemptHook = hook;
  },
};
