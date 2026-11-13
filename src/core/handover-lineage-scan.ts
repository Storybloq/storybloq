/**
 * ISS-1499 slice A: the only I/O of the lineage feature. Reads the final
 * bytes of each handover synchronously and applies the tail rule of
 * `handover-lineage.ts`. Never throws because of a handover file, never
 * follows a symlink, never blocks on a special file.
 */
/**
 * RED commit stub: every function throws. The implementation lands in commit 2.
 */
import type { LineageScan, ScannedFile } from "./handover-lineage.js";

export function scanHandoverFile(handoversDir: string, name: string): ScannedFile {
  void handoversDir;
  void name;
  throw new Error("ISS-1499: scanHandoverFile is not implemented in the RED commit");
}

export function scanHandoverLineage(
  handoversDir: string,
  names: readonly string[],
  enumerated: boolean,
): LineageScan {
  void handoversDir;
  void names;
  void enumerated;
  throw new Error("ISS-1499: scanHandoverLineage is not implemented in the RED commit");
}
