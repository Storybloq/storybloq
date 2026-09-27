/**
 * T-534: one lock for every Storybloq writer of a Claude Code settings file.
 * Each writer reads the file, edits it in memory and renames a new copy over
 * it; two of them interleaving silently drop the first one's edit. The lock
 * is held from the read to the rename and sits beside the resolved file, so a
 * symlinked settings.json and its target share one lock, including before
 * the file exists. Writers that cannot
 * take it within the deadline skip, exactly as they skip an unreadable file.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acquireProjectLockAsync, releaseProjectLock, type ProjectLockHandle } from "./project-lock.js";

export const SETTINGS_LOCK_SUFFIX = ".storybloq.lock";
const SETTINGS_LOCK_DEADLINE_MS = 5_000;
const MAX_SYMLINK_HOPS = 40;
const MAX_ACQUIRE_ATTEMPTS = 3;

/**
 * The path a settings file's writes land on, for a file that may not exist
 * yet: an existing path is its realpath; a dangling symlink is followed to
 * its target; a missing path is its nearest existing ancestor's realpath with
 * the missing tail appended. So an alias and the canonical spelling agree on
 * initial setup too, not only once the file exists.
 *
 * Iterative, with one symlink-hop budget shared by the link walk and the
 * parent walk, so a cycle through a parent (`a -> a/child`) terminates. Null
 * when the budget runs out or a link cannot be read: the destination is
 * unusable and no writer may take a lock for it.
 */
export function canonicalSettingsPath(settingsPath: string): string | null {
  let current = resolve(settingsPath);
  const tail: string[] = [];
  let hops = 0;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      // Missing, dangling, or a loop: resolve it by hand below.
    }
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      // The final component (or its parent chain) is missing: walk up.
    }
    if (isLink) {
      if (++hops > MAX_SYMLINK_HOPS) return null;
      try {
        current = resolve(dirname(current), readlinkSync(current));
      } catch {
        return null;
      }
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

/** The lock beside the canonical destination, or null when the destination is unusable. */
export function settingsLockPath(settingsPath: string): string | null {
  const canonical = canonicalSettingsPath(settingsPath);
  return canonical === null ? null : `${canonical}${SETTINGS_LOCK_SUFFIX}`;
}

/**
 * Runs `fn` holding the settings lock for `settingsPath`, or returns `busy`
 * when the lock cannot be taken or the destination cannot be resolved. Not
 * reentrant: `fn` must not call another locked writer for the same file.
 */
export async function withSettingsWriteLock<T>(
  settingsPath: string,
  busy: T,
  fn: (handle: ProjectLockHandle) => Promise<T>,
  deadlineMs: number = SETTINGS_LOCK_DEADLINE_MS,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const lockPath = settingsLockPath(settingsPath);
    // An unusable destination (a symlink cycle, an unreadable link) is
    // skipped like a held lock: there is nothing safe to write through.
    if (lockPath === null) return busy;
    let handle: ProjectLockHandle;
    try {
      handle = await acquireProjectLockAsync(lockPath, { deadlineMs });
    } catch {
      return busy;
    }
    // The destination can move while we wait (a symlink repointed, a parent
    // swapped): the lock is only good for the path it was derived from.
    if (settingsLockPath(settingsPath) !== lockPath) {
      releaseProjectLock(handle);
      continue;
    }
    try {
      return await fn(handle);
    } finally {
      releaseProjectLock(handle);
    }
  }
  return busy;
}
