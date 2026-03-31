import { formatStatus } from "../../core/output-formatter.js";
import { scanActiveSessions, type ActiveSessionSummary } from "../../core/session-scan.js";
import type { CommandContext, CommandResult } from "../types.js";

export function handleStatus(ctx: CommandContext): CommandResult {
  const sessions = scanActiveSessions(ctx.root);
  return { output: formatStatus(ctx.state, ctx.format, sessions) };
}
