/**
 * ISS-1499 slice B: the per-call machinery every handover reader shares
 * (plan section 3). `TailReader` caches slice A's single-file tail result
 * for one command run and counts the uncached reads; its `observation` is
 * the command's one `lineageObserved` flag. `readHandoverBody` is the one
 * body reader.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { scanHandoverFile } from "./handover-lineage-scan.js";
import type { ScannedFile } from "./handover-lineage.js";

/**
 * Set to true by exactly three events: the `TailReader` returns a `linked`
 * state; the raw fill classifies a body as linked; the caller's memo file
 * exists and decodes. Nothing else decides compatibility.
 */
export interface LineageObservation { seen: boolean }

export class TailReader {
  readonly observation: LineageObservation = { seen: false };
  /** Uncached tail reads made so far. */
  reads = 0;
  private readonly cache = new Map<string, ScannedFile>();
  private readonly listed: ReadonlySet<string>;

  constructor(readonly handoversDir: string, listing: readonly string[]) {
    this.listed = new Set(listing);
  }

  /** Whether `name` is in the listing this reader was made with. */
  has(name: string): boolean {
    return this.listed.has(name);
  }

  /** Slice A's single-file result for `name`, read once per command run. */
  state(name: string): ScannedFile {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const result = scanHandoverFile(this.handoversDir, name);
    this.reads++;
    this.cache.set(name, result);
    if (result.state === "linked") this.observation.seen = true;
    return result;
  }
}

/** Test seam: runs after `fstatSync` and before the read. */
export const bodyReaderSeams: { afterOpen: ((path: string) => void) | null } = { afterOpen: null };

const O_NONBLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

/**
 * The one body reader. Opens the path once (following a symlink exactly as
 * `readFile` does; `O_NONBLOCK` makes opening a FIFO return at once) and
 * reads through that descriptor only:
 * - a regular file: its `fstat` size, decoded as UTF-8;
 * - a directory: read through the same descriptor, which raises the
 *   `EISDIR` error `readFile` raises;
 * - anything else (FIFO, device): fails fast with "not a regular file".
 * An `open` error is rethrown unchanged. This is the one place slice B
 * departs from main on a project with no lineage: main blocks on a FIFO.
 */
export function readHandoverBody(handoversDir: string, name: string): string {
  const path = join(handoversDir, name);
  const fd = openSync(path, constants.O_RDONLY | O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    bodyReaderSeams.afterOpen?.(path);
    if (st.isDirectory()) return readFileSync(fd, "utf-8");
    if (!st.isFile()) throw new Error(`Cannot read handover ${name}: not a regular file`);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
