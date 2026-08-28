/**
 * T-477 section 4.3: `storybloq landings` -- the CLI-only surface for the
 * landings feed (`core/landings.ts`'s `buildLandings`). No MCP tool and no
 * `storybloq_status` field, per the ratified plan's explicit non-goal.
 */

import { buildLandings, type LandingsOptions } from "../../core/landings.js";
import { formatLandings } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";
import { ExitCode } from "../../core/output-formatter.js";

export function handleLandings(options: LandingsOptions, ctx: CommandContext): CommandResult {
  const result = buildLandings(ctx.root, ctx.state, options);
  return {
    output: formatLandings(result, ctx.format),
    ...(result.status === "landings-unavailable" && { exitCode: ExitCode.USER_ERROR, errorCode: "io_error" as const }),
  };
}
