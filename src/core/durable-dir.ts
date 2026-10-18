/**
 * ISS-1399: directory durability for multi-file commits.
 *
 * A rename, a create or an unlink is durable only once the directory that
 * holds the entry is synced; fsync on the file covers its bytes, not its name.
 */
import { open } from "node:fs/promises";

/**
 * The codes a filesystem that cannot sync a directory at all answers with;
 * any other failure is real. The one list: setup-review's synchronous
 * fsyncDir and the transaction's syncDir both ask this.
 */
export function isDirSyncUnsupported(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code ?? "";
  if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") return true;
  return platform === "win32" && (code === "EISDIR" || code === "EPERM");
}

/** Syncs one directory's entries to disk; a filesystem that cannot do it at all is not an error. */
export async function syncDir(path: string): Promise<void> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (err) {
    if (!isDirSyncUnsupported(err)) throw err;
  } finally {
    await handle?.close();
  }
}
