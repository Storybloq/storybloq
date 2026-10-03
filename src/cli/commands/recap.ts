import { formatRecap } from "../../core/output-formatter.js";
import { loadLatestSnapshot, buildRecap } from "../../core/snapshot.js";
import type { CommandContext, CommandResult } from "../types.js";
import { withBoardUncommitted } from "./status.js";

export async function handleRecap(ctx: CommandContext): Promise<CommandResult> {
  const snapshotInfo = await loadLatestSnapshot(ctx.root);
  const recap = await buildRecap(ctx.state, snapshotInfo, ctx.root);
  // ISS-1107: the same uncommitted-board section as status, in both snapshot branches.
  return { output: await withBoardUncommitted(formatRecap(recap, ctx.state, ctx.format), ctx.format, false, ctx.root) };
}
