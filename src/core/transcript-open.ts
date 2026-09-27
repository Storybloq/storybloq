/**
 * The read-only transcript open every transcript reader shares. Moved out of
 * the retired T-424 limit-transcript module (T-534) unchanged.
 */

import { openSync, closeSync, fstatSync, constants } from "node:fs";

export interface OpenTranscript {
  readonly fd: number;
  readonly size: number;
  /** `<dev>:<ino>` -- the file's incarnation identity (T-499 observation). */
  readonly incarnation: string;
}

/**
 * The open prelude every transcript reader shares (T-424 tail reads, T-499
 * session-intel scans): O_RDONLY|O_NOFOLLOW|O_NONBLOCK, then fstat must say
 * regular file. Null for anything else (FIFO, device, directory, symlink at
 * the final component, absent, unreadable) with nothing left open. The
 * CALLER owns the returned fd and must close it in a `finally`.
 */
export function openTranscriptReadOnly(filePath: string): OpenTranscript | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return null;
    }
    return { fd, size: st.size, incarnation: `${st.dev}:${st.ino}` };
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    return null;
  }
}
