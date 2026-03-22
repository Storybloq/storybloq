import { formatSnapshotResult } from "../../core/output-formatter.js";
import { saveSnapshot } from "../../core/snapshot.js";
import { withProjectLock } from "../../core/project-loader.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";

export async function handleSnapshot(
  root: string,
  format: OutputFormat,
  options?: { quiet?: boolean },
): Promise<CommandResult> {
  let result: { filename: string; retained: number; pruned: number } | undefined;

  await withProjectLock(root, { strict: false }, async (loadResult) => {
    result = await saveSnapshot(root, loadResult);
  });

  if (!result) {
    throw new Error("snapshot: withProjectLock completed without setting result");
  }

  if (options?.quiet) {
    return { output: "" };
  }

  return { output: formatSnapshotResult(result, format) };
}
