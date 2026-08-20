/**
 * ISS-1022: filesystem primitives for the presence hook.
 *
 * Everything here runs SYNCHRONOUSLY on the per-tool-call hot path, in a
 * process that a `PreToolUse` non-zero exit would turn into a blocked tool. So
 * the posture is: bound every read by type and size, never follow a symlink at
 * a path we generate, never block, and prefer dropping an update to stalling.
 *
 * Path-safety honesty (same posture as `src/bus/paths.ts`): Node has no
 * `openat`, so a directory validated as a string can be swapped for a symlink
 * before a later child operation. What is claimed here is what is enforced:
 * components verified, symlinks and non-directories refused, reads bounded,
 * dev/ino revalidated immediately before and after the rename, unlink
 * restricted to regular files inside a revalidated directory, and a failed
 * post-check reported as a FAILED write rather than as success.
 */

import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";

import { MAX_RECORD_BYTES, PRESENCE_TTL_MS } from "./types.js";

/**
 * Lock-acquire budget. Deliberately NOT the 2s deadline the autonomous lock
 * discipline uses: this lock is taken inside a synchronous hook, so a stale
 * lock left by a crashed hook would stall EVERY tool call on the project until
 * the staleness floor cleared it. A dropped presence update is repaired by the
 * next event; a stalled tool call is user-visible.
 */
export const LOCK_ACQUIRE_BUDGET_MS = 150;
/** A lock older than this belonged to a process that is gone. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 5;

const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const O_NONBLOCK = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
const IDENTITY_RETRY_LIMIT = 5;

/**
 * Synchronous sleep with no busy-wait. `Atomics.wait` is permitted on Node's
 * main thread (unlike a browser main thread); the try/catch covers runtimes
 * where it is not, where the loop degrades to a spin bounded by the same
 * deadline rather than sleeping.
 */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  try {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
  } catch {
    // Not available here; the caller's deadline still bounds the loop.
  }
}

/**
 * Bounded, non-following, non-blocking read of a file we generated.
 *
 * Every `null` means "could not prove what this file holds": absent,
 * oversized, empty, a symlink, a FIFO, a device, unreadable, or an identity
 * that changed mid-open. Callers treat that as "no record", never as an error
 * worth surfacing.
 */
export function readBoundedNoFollow(path: string, maxBytes = MAX_RECORD_BYTES): string | null {
  for (let attempt = 0; attempt < IDENTITY_RETRY_LIMIT; attempt++) {
    let fd: number | null = null;
    try {
      const linkStat = fs.lstatSync(path);
      // lstat is the PORTABLE half of the refusal: it never follows, so a
      // symlink is rejected even where O_NOFOLLOW is unavailable.
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) return null;
      fd = fs.openSync(path, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) return null;
      if (opened.dev !== linkStat.dev || opened.ino !== linkStat.ino) {
        continue; // swapped under us -- re-lstat and try again
      }
      if (opened.size <= 0 || opened.size > maxBytes) return null;
      // Bound the READ, not just the pre-read stat: the same inode can grow
      // between fstat and read.
      const cap = maxBytes + 1;
      const buf = Buffer.allocUnsafe(cap);
      let total = 0;
      while (total < cap) {
        const n = fs.readSync(fd, buf, total, cap - total, total);
        if (n <= 0) break;
        total += n;
      }
      if (total > maxBytes) return null;
      return buf.subarray(0, total).toString("utf-8");
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  return null;
}

/**
 * Bounded read of a file that may legitimately be a symlink (`.story/config.json`
 * is USER input, and the deliberate config-symlink policy in
 * `core/limit-config.ts` honours it). The link is resolved FIRST and the
 * resolved target is then opened no-follow, so honouring the link does not
 * re-open a swap-to-symlink race.
 */
export function readBoundedFollowingLink(path: string, maxBytes: number): string | null {
  let target: string;
  try {
    target = fs.realpathSync(path);
  } catch {
    return null;
  }
  return readBoundedNoFollow(target, maxBytes);
}

/**
 * Is `path` a DIRECT child of `dir`?
 *
 * The write and unlink helpers below are exported and document containment, so
 * they enforce it rather than trusting every call site to pass a child. Without
 * this, `removeRegularFile` would happily unlink any regular file on the
 * machine once its unrelated `dir` argument validated.
 */
function isDirectChild(dir: string, path: string): boolean {
  return dirname(resolve(path)) === resolve(dir);
}

/** dev/ino identity of a path, or null if it is not a real directory. */
export interface DirIdentity { readonly dev: number; readonly ino: number }

export function directoryIdentity(path: string): DirIdentity | null {
  try {
    const st = fs.lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * Ensures `<root>/.story/telemetry/presence` exists as a real directory chain
 * and returns its path, or null.
 *
 * Each level is created with a plain (non-recursive) `mkdirSync` and then
 * validated with `lstat`, because `mkdirSync(..., { recursive: true })` accepts
 * an existing symlink at any level and would silently write through it.
 */
export function ensurePresenceDir(root: string): string | null {
  const levels = [
    join(root, ".story"),
    join(root, ".story", "telemetry"),
    join(root, ".story", "telemetry", "presence"),
  ];
  for (const dir of levels) {
    if (directoryIdentity(dir) === null) {
      try {
        fs.mkdirSync(dir);
      } catch {
        // EEXIST here means something non-directory occupies the path; the
        // identity check below is what decides.
      }
      if (directoryIdentity(dir) === null) return null;
    }
  }
  return levels[2]!;
}

/** Presence directory path without creating anything. Null if it is not a real directory. */
export function presenceDirIfPresent(root: string): string | null {
  const dir = join(root, ".story", "telemetry", "presence");
  return directoryIdentity(dir) === null ? null : dir;
}

/**
 * Acquires a per-record lock, or gives up inside the budget.
 *
 * `mkdir` is the atomic primitive. A lock DIRECTORY older than LOCK_STALE_MS is
 * removed and the loop retries: the only way to create one is inside this
 * function, so an old one means the holder died.
 *
 * Every path through the loop ends at the deadline check. That is not tidiness:
 * this runs synchronously inside a hook, so any path that loops without
 * consulting the deadline is a spin that stalls the user's tool call until the
 * client's own hook timeout fires. A persistent `lstat` failure and a
 * non-directory squatting on the lock path are both such paths, and both now
 * refuse immediately rather than polling for something that can never clear.
 */
export function acquireLock(lockPath: string, budgetMs = LOCK_ACQUIRE_BUDGET_MS): boolean {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
    }

    let stale = false;
    let vanished = false;
    try {
      const st = fs.lstatSync(lockPath);
      // Only a directory is one of ours. A regular file, a symlink or a device
      // at this path can never be cleared by rmdir, so waiting for it to clear
      // would burn the entire budget on every single event.
      if (!st.isDirectory()) return false;
      stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
    } catch (err) {
      // Gone between mkdir and lstat: retry straight away. Anything else
      // (EACCES on the parent, EIO) will not fix itself inside 150ms, and
      // retrying it is the unbounded busy loop this guard exists to prevent.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      vanished = true;
    }

    if (stale) {
      try {
        fs.rmdirSync(lockPath);
      } catch (err) {
        // ENOENT means another reaper won the race, which is fine to retry.
        // Anything else -- a non-empty lock directory (ENOTEMPTY), a
        // permission error -- will not resolve itself, and retrying it without
        // sleeping is a 150ms CPU burn on every single tool call, forever. Same
        // reasoning as the non-directory case above: drop the update instead.
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      }
    }
    if (Date.now() >= deadline) return false;
    // Only sleep when we are genuinely waiting on someone else's live lock.
    if (!stale && !vanished) sleepSync(LOCK_POLL_MS);
  }
}

export function releaseLock(lockPath: string): void {
  try { fs.rmdirSync(lockPath); } catch { /* already gone */ }
}

/**
 * Atomically replaces `targetPath` inside `dir`, revalidating the directory's
 * identity immediately before and after the rename.
 *
 * Returns false on any failure INCLUDING a failed post-check: the caller must
 * not report a write it cannot prove landed in the directory it validated.
 */
export function atomicWriteInDir(dir: string, targetPath: string, content: string): boolean {
  if (!isDirectChild(dir, targetPath)) return false;
  const before = directoryIdentity(dir);
  if (before === null) return false;

  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  let fd: number | null = null;
  try {
    // O_EXCL so we never write through anything that already occupies the path.
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, content, "utf-8");
    fs.closeSync(fd);
    fd = null;

    const beforeRename = directoryIdentity(dir);
    if (beforeRename === null || beforeRename.dev !== before.dev || beforeRename.ino !== before.ino) {
      removeRegularFile(dir, tmp, before);
      return false;
    }
    fs.renameSync(tmp, targetPath);
    const after = directoryIdentity(dir);
    if (after === null || after.dev !== before.dev || after.ino !== before.ino) {
      return false; // landed somewhere we cannot vouch for -- report failure
    }
    return true;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    removeRegularFile(dir, tmp, before);
    return false;
  }
}

/**
 * Unlinks `path` only when it is a regular file and `dir` still has the
 * identity it was validated with. Never removes a directory or a symlink.
 */
export function removeRegularFile(dir: string, path: string, expected: DirIdentity | null): boolean {
  if (!isDirectChild(dir, path)) return false;
  const current = directoryIdentity(dir);
  if (current === null) return false;
  if (expected && (current.dev !== expected.dev || current.ino !== expected.ino)) return false;
  try {
    const st = fs.lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    fs.unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes EVERY presence record in `dir`, whatever its age. The opt-out's
 * cleanup half.
 *
 * Deliberately not expressed as a zero-TTL sweep: `now - mtime > 0` is false
 * for a file written in the same millisecond, so "delete everything" would
 * silently leave the newest record behind -- the one most likely to still be
 * animating a row in the app.
 */
export function removeAllPresenceRecords(dir: string): number {
  const identity = directoryIdentity(dir);
  if (identity === null) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    // Dirent.isFile() is false for a symlink, so links are skipped here as
    // well as by removeRegularFile's own lstat check.
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json") && !entry.name.startsWith(".tmp-")) continue;
    if (removeRegularFile(dir, join(dir, entry.name), identity)) removed++;
  }
  return removed;
}

/**
 * Removes presence records untouched for longer than the TTL, plus any
 * abandoned temp files and stale locks.
 *
 * Runs ONLY on SessionStart and SessionEnd -- a per-session cost, never a
 * per-tool-call one.
 *
 * A session that is genuinely alive but has been idle past the TTL loses its
 * record here, and its next event rebuilds one with a fresh `startedAt`. That
 * is the accepted trade: hooks fire on events, so twelve hours of silence is
 * indistinguishable from a process that died, and keeping the record would mean
 * showing a start time for a session nobody can confirm still exists.
 */
export function sweepPresenceDir(dir: string, now = Date.now(), ttlMs = PRESENCE_TTL_MS): number {
  const identity = directoryIdentity(dir);
  if (identity === null) return 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Only our own lock directories, and only when stale.
      if (!entry.name.endsWith(".lock")) continue;
      try {
        const st = fs.lstatSync(path);
        if (now - st.mtimeMs > LOCK_STALE_MS) {
          try { fs.rmdirSync(path); removed++; } catch { /* raced */ }
        }
      } catch { /* vanished */ }
      continue;
    }
    if (!entry.isFile()) continue;
    const isRecord = entry.name.endsWith(".json");
    const isTemp = entry.name.startsWith(".tmp-");
    if (!isRecord && !isTemp) continue;
    try {
      const st = fs.lstatSync(path);
      if (now - st.mtimeMs > ttlMs || (isTemp && now - st.mtimeMs > LOCK_STALE_MS)) {
        if (removeRegularFile(dir, path, identity)) removed++;
      }
    } catch { /* vanished */ }
  }
  return removed;
}
