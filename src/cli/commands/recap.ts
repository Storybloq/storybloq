import { formatRecap } from "../../core/output-formatter.js";
import { loadLatestSnapshot, buildRecap } from "../../core/snapshot.js";
import type { CommandContext, CommandResult } from "../types.js";

export async function handleRecap(ctx: CommandContext): Promise<CommandResult> {
  const snapshotInfo = await loadLatestSnapshot(ctx.root);
  const recap = await buildRecap(ctx.state, snapshotInfo, ctx.root);
  return { output: formatRecap(recap, ctx.state, ctx.format) };
}
