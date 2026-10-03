import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z, type ZodType } from "zod";
import { BusError } from "./errors.js";

const DEFAULT_MAX_BYTES = 64 * 1024;

export async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM") throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Durably flush a file's contents to disk, then its containing directory entry.
// Used to make an in-place writeFile (e.g. `.story/.gitignore`) crash-durable so a
// power loss cannot preserve a durably-written sibling while losing this file. A
// missing file (ENOENT) is a no-op; other errors propagate.
export async function syncFile(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await syncDirectory(dirname(path));
}

// ISS-1004: the exact name `writeDurableTemp` gives a staging file,
// `<target>.tmp.<pid>.<uuid>`. Enumerations that refuse unknown names use this to
// recognise the Bus's own in-flight write and nothing else.
const DURABLE_TEMP_NAME = /^(.+)\.tmp\.(\d+)\.([0-9a-f-]{36})$/;
const DurableTempUuidSchema = z.string().uuid();

/**
 * The target basename when `name` has the full durable-write staging shape,
 * otherwise null. Callers still require a regular non-symlink file and check the
 * returned target against their own record shape before skipping the entry.
 */
export function durableTempTarget(name: string): string | null {
  const match = DURABLE_TEMP_NAME.exec(name);
  if (!match || !DurableTempUuidSchema.safeParse(match[3]!).success) return null;
  return match[1]!;
}

type DurableTempWriter = (handle: FileHandle, content: string) => Promise<void>;

const defaultTempWriter: DurableTempWriter = async (handle, content) => {
  await handle.writeFile(content, "utf-8");
  await handle.sync();
};

async function writeDurableTemp(
  target: string,
  content: string,
  writer: DurableTempWriter = defaultTempWriter,
): Promise<string> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temp, "wx", 0o600);
  let failure: unknown;
  try {
    await writer(handle, content);
  } catch (err) {
    failure = err;
  }
  try {
    await handle.close();
  } catch (err) {
    failure ??= err;
  }
  if (failure) {
    await unlink(temp).catch(() => undefined);
    throw failure;
  }
  return temp;
}

export async function durableCreate(target: string, content: string): Promise<void> {
  const temp = await writeDurableTemp(target, content);
  try {
    await link(temp, target);
    await syncDirectory(dirname(target));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new BusError("conflict", `File already exists: ${basename(target)}`, err);
    throw new BusError("io_error", `Failed to create ${basename(target)}`, err);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function durableWrite(target: string, content: string): Promise<void> {
  const temp = await writeDurableTemp(target, content);
  try {
    await rename(temp, target);
    await syncDirectory(dirname(target));
  } catch (err) {
    throw new BusError("io_error", `Failed to write ${basename(target)}`, err);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export async function durableRename(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    await syncDirectory(dirname(to));
  } catch (err) {
    throw new BusError("io_error", `Failed to publish ${basename(to)}`, err);
  }
}

export async function durableUnlink(target: string): Promise<void> {
  try {
    await unlink(target);
    await syncDirectory(dirname(target));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new BusError("io_error", `Failed to remove ${basename(target)}`, err);
    }
  }
}

interface OpenReadNoFollowOptions {
  // Injectable ONLY so a test can force the degraded (flag-unavailable) platform
  // branch and prove the lstat floor + identity check still refuse a symlink.
  readonly noFollowFlag?: number;
  // Test-only seam: runs AFTER the pre-open lstat and BEFORE open, to deterministically
  // exercise the swap window the identity check defends.
  readonly afterInspect?: () => Promise<void>;
}

// Bounded retries for a benign concurrent atomic rename landing in the lstat->open
// window. The window is two syscalls, so a legitimate durableRename settles within one
// retry; the bound only guards against pathological churn.
const NO_FOLLOW_MAX_ATTEMPTS = 5;

// Open a file for reading while refusing a final-component symlink AND verifying the
// opened handle is the same inode lstat saw. The lstat check is the PORTABLE floor:
// lstat never follows, so a symlinked target is refused on EVERY platform, including
// where `O_NOFOLLOW` is unavailable and the open cannot enforce it (there, silently
// substituting 0 would otherwise follow the link). `O_NOFOLLOW` is ALSO applied when
// available. The dev/ino identity check closes the residual lstat->open swap window on
// platforms lacking `O_NOFOLLOW`: a mismatch is EITHER a benign atomic rename (a new
// regular file now lives at the path) OR a symlink swap the degraded open followed, so
// we close and retry the whole lstat/open -- the next lstat reads the CURRENT file, so
// a benign rename settles to a matching regular file while a symlink is rejected. This
// keeps concurrently-rewritten bus-store reads correct (they read the new inode on
// retry) without ever following a swapped-in symlink.
async function openReadNoFollow(path: string, options: OpenReadNoFollowOptions = {}): Promise<FileHandle> {
  const noFollowFlag = options.noFollowFlag ?? (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  // O_NONBLOCK so a swap to a FIFO cannot block the open before identity is verified.
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  for (let attempt = 0; ; attempt++) {
    let linkStat;
    try {
      linkStat = await lstat(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new BusError("not_found", `File not found: ${basename(path)}`, err);
      throw new BusError("io_error", `Failed to inspect ${basename(path)}`, err);
    }
    if (linkStat.isSymbolicLink()) throw new BusError("corrupt", `Symlink rejected: ${basename(path)}`);
    if (!linkStat.isFile()) throw new BusError("corrupt", `${basename(path)} is not a regular file`);
    if (options.afterInspect) await options.afterInspect();
    const handle = await open(path, constants.O_RDONLY | noFollowFlag | nonBlock);
    let openedStat;
    try {
      openedStat = await handle.stat();
    } catch (err) {
      // Close before propagating: the caller only receives the handle on success, so
      // its finally cannot close a handle we fail to return (fd-leak on fstat error).
      await handle.close().catch(() => undefined);
      throw err;
    }
    if (openedStat.isFile() && openedStat.dev === linkStat.dev && openedStat.ino === linkStat.ino) {
      return handle;
    }
    await handle.close().catch(() => undefined);
    if (attempt + 1 >= NO_FOLLOW_MAX_ATTEMPTS) {
      throw new BusError("corrupt", `${basename(path)} changed identity during open`);
    }
  }
}

// Read at most maxBytes+1 bytes from an already-opened handle, rejecting if the file exceeds
// maxBytes. Bounding the READ (not just a pre-read stat) is what actually caps allocation: a
// file the stat saw as small can grow through the same inode before the read completes, so the
// pre-read stat is only a fast-reject and this loop is the real ceiling.
async function boundedReadAll(handle: FileHandle, maxBytes: number, path: string): Promise<string> {
  const cap = maxBytes + 1;
  const buf = Buffer.allocUnsafe(cap);
  let total = 0;
  while (total < cap) {
    const { bytesRead } = await handle.read(buf, total, cap - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) throw new BusError("corrupt", `${basename(path)} exceeds ${maxBytes} bytes`);
  return buf.subarray(0, total).toString("utf-8");
}

export async function readJsonNoFollow<T>(
  path: string,
  schema: ZodType<T>,
  maxBytes = DEFAULT_MAX_BYTES,
  // Injectable ONLY for the degraded-platform / swap tests (see openReadNoFollow).
  noFollowFlag?: number,
  afterInspect?: () => Promise<void>,
): Promise<T> {
  let handle;
  try {
    handle = await openReadNoFollow(path, { noFollowFlag, afterInspect });
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BusError("corrupt", `${basename(path)} is not a regular file`);
    if (stat.size < 0 || stat.size > maxBytes) {
      throw new BusError("corrupt", `${basename(path)} exceeds ${maxBytes} bytes`);
    }
    const raw = await boundedReadAll(handle, maxBytes, path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new BusError("corrupt", `Invalid JSON in ${basename(path)}: ${(err as Error).message}`, err);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new BusError("corrupt", `Invalid schema in ${basename(path)}: ${result.error.issues[0]?.message ?? "unknown error"}`);
    }
    return result.data;
  } catch (err) {
    if (err instanceof BusError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new BusError("not_found", `File not found: ${basename(path)}`, err);
    if (code === "ELOOP") throw new BusError("corrupt", `Symlink rejected: ${basename(path)}`, err);
    throw new BusError("io_error", `Failed to read ${basename(path)}`, err);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Read a text file WITHOUT following a final-component symlink (openReadNoFollow does
// the lstat floor + O_NOFOLLOW + dev/ino identity check). Git does not honor a symlinked
// working-tree `.gitignore`, so any guard that parses `.gitignore` must read it
// no-follow (else a symlinked file whose target carries the expected rule would pass the
// guard while git ignores it). A symlink or swapped identity surfaces as `corrupt`; a
// missing file -> `not_found`. `noFollowFlag` and `afterInspect` are injectable only for
// the degraded-platform / swap tests.
export async function readTextNoFollow(
  path: string,
  maxBytes = DEFAULT_MAX_BYTES,
  noFollowFlag?: number,
  afterInspect?: () => Promise<void>,
): Promise<string> {
  let handle;
  try {
    handle = await openReadNoFollow(path, { noFollowFlag, afterInspect });
    const stat = await handle.stat();
    if (!stat.isFile()) throw new BusError("corrupt", `${basename(path)} is not a regular file`);
    if (stat.size < 0 || stat.size > maxBytes) {
      throw new BusError("corrupt", `${basename(path)} exceeds ${maxBytes} bytes`);
    }
    return await boundedReadAll(handle, maxBytes, path);
  } catch (err) {
    if (err instanceof BusError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new BusError("not_found", `File not found: ${basename(path)}`, err);
    if (code === "ELOOP") throw new BusError("corrupt", `Symlink rejected: ${basename(path)}`, err);
    throw new BusError("io_error", `Failed to read ${basename(path)}`, err);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function listRegularJsonFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new BusError("io_error", `Cannot enumerate ${basename(directory)}`, err);
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

export async function rejectPathSymlink(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new BusError("corrupt", `Symlink rejected: ${basename(path)}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export const __testing = { writeDurableTemp };
