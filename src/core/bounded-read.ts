/**
 * Bounded, non-blocking file reads, shared by the loaders, the hook hot paths
 * and `storybloq health`. Moved out of the retired T-424 limit-config module
 * (T-534) unchanged.
 */

import * as fs from "node:fs";

export const CONFIG_MAX_BYTES = 262_144;

/**
 * Bounded, non-blocking read for hook/waker hot paths: a special-file (FIFO,
 * device) or oversized replacement must not hang or balloon the caller.
 * Symlinks are followed via explicit realpath resolution (a legitimately
 * symlinked config still reads; the O_NOFOLLOW open on the RESOLVED path keeps
 * a swap-to-symlink race from re-introducing traversal).
 */
export function readBoundedFile(path: string, maxBytes = CONFIG_MAX_BYTES): string | null {
  return collapseBoundedRead(readBoundedFileDetailed(path, maxBytes));
}

/**
 * `readBoundedFile`'s collapse, on its own so a loader that takes an injected
 * `BoundedReader` (T-528) keeps exactly the same null rule.
 */
export function collapseBoundedRead(read: BoundedRead): string | null {
  // An empty file collapses to null the way it always has: callers here treat
  // "no usable content" and "nothing there" alike.
  return read.kind === "ok" && read.text.length > 0 ? read.text : null;
}

/**
 * T-502: the same read, with ABSENT and UNREADABLE kept apart.
 *
 * `readBoundedFile` collapses both to null, which is right for the hot paths
 * that just want a config or nothing. It is wrong for `storybloq health`,
 * which must never turn "I could not read your settings" into "your settings
 * are fine": there, an unreadable layer has to suppress the verdict and name
 * the path. Only ENOENT and ENOTDIR count as absent, so an inaccessible
 * parent directory or a symlink loop is reported as indeterminate rather than
 * silently behaving like a missing file.
 */
export type BoundedRead =
  | { readonly kind: "absent" }
  /**
   * `target` is the path `realpathSync` produced and `openSync` actually
   * opened, which is NOT always the path the caller passed. A caller that
   * checked containment on its own resolution of the pathname resolved it a
   * second time, independently, so only this value says what was really read.
   */
  | {
      readonly kind: "ok";
      readonly text: string;
      readonly target: string;
      /**
       * T-528: the exact bytes `text` was decoded from, so a caller that must
       * hash what it parsed (the decisions projection's ledger revision) hashes
       * the same read instead of a second one. Additive: existing callers
       * ignore it.
       */
      readonly bytes: Buffer;
    }
  | { readonly kind: "indeterminate"; readonly reason: string };

/**
 * T-528: the shape of `readBoundedFileDetailed`, for loaders that let a caller
 * substitute a reader which records what was read. Defaulted everywhere, so
 * every existing call is unchanged.
 */
export type BoundedReader = (path: string, maxBytes: number) => BoundedRead;

export function readBoundedFileDetailed(path: string, maxBytes = CONFIG_MAX_BYTES): BoundedRead {
  let target: string;
  try {
    target = fs.realpathSync(path);
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { kind: "absent" }
      : { kind: "indeterminate", reason: code ?? "unresolvable" };
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "indeterminate", reason: "not a regular file" };
    if (st.size > maxBytes) return { kind: "indeterminate", reason: `larger than ${maxBytes} bytes` };
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    const bytes = buf.subarray(0, read);
    return { kind: "ok", text: bytes.toString("utf-8"), target, bytes };
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    return { kind: "indeterminate", reason: code ?? "unreadable" };
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
