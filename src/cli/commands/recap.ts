import { formatRecap } from "../../core/output-formatter.js";
import { loadLatestSnapshot, buildRecap } from "../../core/snapshot.js";
import type { CommandContext, CommandResult } from "../types.js";

export async function handleRecap(ctx: CommandContext): Promise<CommandResult> {
  const snapshotInfo = await loadLatestSnapshot(ctx.root);
  const recap = buildRecap(ctx.state, snapshotInfo);
  return { output: formatRecap(recap, ctx.state, ctx.format) };
}
