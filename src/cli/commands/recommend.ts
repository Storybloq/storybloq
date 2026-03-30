import { recommend } from "../../core/recommend.js";
import { formatRecommendations } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";

export function handleRecommend(ctx: CommandContext, count: number): CommandResult {
  const result = recommend(ctx.state, count);
  return { output: formatRecommendations(result, ctx.state, ctx.format) };
}
