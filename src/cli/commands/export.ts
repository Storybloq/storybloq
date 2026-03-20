import { formatExport } from "../../core/output-formatter.js";
import { CliValidationError } from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

export function handleExport(
  ctx: CommandContext,
  mode: "all" | "phase",
  phaseId: string | null,
): CommandResult {
  if (mode === "phase") {
    if (!phaseId) {
      throw new CliValidationError("invalid_input", "Missing --phase value");
    }
    // Verify phase exists
    const phase = ctx.state.roadmap.phases.find((p) => p.id === phaseId);
    if (!phase) {
      throw new CliValidationError("not_found", `Phase "${phaseId}" not found in roadmap`);
    }
  }

  return { output: formatExport(ctx.state, mode, phaseId, ctx.format) };
}
