import {
  appendValidationFindings,
  validateProject,
  mergeValidation,
  type ValidationFinding,
  type ValidationResult,
} from "../../core/validation.js";
import { validateIssueSourceRefs } from "../../core/issue-source-ref.js";
import { loadRulingsSafe } from "../../core/ruling-loader.js";
import { ExitCode, formatValidation } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";

/**
 * T-476: this is the ONE `validate` call site that loads the ruling
 * side-store and threads it into `validateProject`'s `aux` parameter --
 * every other `validateProject` caller (issue/ticket pre/post-write checks)
 * is unaffected and continues to see pre-T-476 behavior.
 */
function validateWithRulings(ctx: CommandContext): ValidationResult {
  const { rulings, warnings, unavailableIds, scanCompleteness, hasUnrecoverableEntries } = loadRulingsSafe(ctx.root);
  const baseResult = validateProject(ctx.state, undefined, {
    rulings,
    unavailableRulingIds: unavailableIds,
    rulingScanCompleteness: scanCompleteness,
    rulingHasUnrecoverableEntries: hasUnrecoverableEntries,
  });
  const merged = mergeValidation(baseResult, ctx.warnings);
  // loadRulingsSafe's own per-file warnings (unreadable/invalid JSON/schema
  // mismatch/etc.) mirror loadArrangementsSafe's plain-string convention,
  // not the main ledger's typed LoadWarning -- surfaced here the same way
  // mergeValidation surfaces the main ledger's loader warnings.
  const loaderFindings: ValidationFinding[] = warnings.map((message) => ({
    level: "warning",
    code: "ruling_loader_warning",
    message,
    entity: null,
  }));
  return appendValidationFindings(merged, loaderFindings);
}

export function handleValidate(ctx: CommandContext): CommandResult {
  const complete = validateWithRulings(ctx);
  return {
    output: formatValidation(complete, ctx.format),
    exitCode: complete.valid ? ExitCode.OK : ExitCode.VALIDATION_ERROR,
  };
}

/** Full validation including Git and working-tree source provenance checks. */
export async function handleValidateWithSourceRefs(
  ctx: CommandContext,
): Promise<CommandResult> {
  const withRulings = validateWithRulings(ctx);
  const sourceFindings = await validateIssueSourceRefs(ctx.root, ctx.state.activeIssues);
  const complete = appendValidationFindings(withRulings, sourceFindings);
  return {
    output: formatValidation(complete, ctx.format),
    exitCode: complete.valid ? ExitCode.OK : ExitCode.VALIDATION_ERROR,
  };
}
