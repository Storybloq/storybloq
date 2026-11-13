/**
 * ISS-1499 slice A: the only I/O of the lineage feature. Reads the final
 * bytes of each handover synchronously and applies the tail rule of
 * `handover-lineage.ts`. Never throws because of a handover file, never
 * follows a symlink, never blocks on a special file.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { isFilenameAdmitted } from "./handover-brief.js";
import {
  LINEAGE_TAIL_BYTES,
  readLineageTail,
  type LineageScan,
  type ScannedFile,
} from "./handover-lineage.js";

/** Reads one handover's tail. `name` must come from the folder listing. */
export function scanHandoverFile(handoversDir: string, name: string): ScannedFile {
  if (!isFilenameAdmitted(name)) return { name, state: "unknown", reason: "name_too_long" };
  const path = join(handoversDir, name);
  try {
    if (!lstatSync(path).isFile()) return { name, state: "unknown", reason: "not_regular" };
  } catch {
    return { name, state: "unknown", reason: "unreadable" };
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile()) return { name, state: "unknown", reason: "unreadable" };
    const len = Math.min(st.size, LINEAGE_TAIL_BYTES);
    const tail = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, tail, got, len - got, st.size - len + got);
      if (n === 0) break;
      got += n;
    }
    if (got < len) return { name, state: "unknown", reason: "unreadable" };
    const r = readLineageTail(tail, st.size <= LINEAGE_TAIL_BYTES);
    return r.kind === "linked"
      ? { name, state: "linked", lineage: r.parsed }
      : { name, state: "unlinked", nearMiss: r.nearMiss };
  } catch {
    return { name, state: "unknown", reason: "unreadable" };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Scans every name of a listing, in listing order. `enumerated` is false
 * when the folder could not be listed (then `names` is empty).
 */
export function scanHandoverLineage(
  handoversDir: string,
  names: readonly string[],
  enumerated: boolean,
): LineageScan {
  const files = names.map((n) => scanHandoverFile(handoversDir, n));
  return { files, enumerated, complete: enumerated && files.every((f) => f.state !== "unknown") };
}
