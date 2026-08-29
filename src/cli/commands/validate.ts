import {
  appendValidationFindings,
  validateProject,
  mergeValidation,
  type ValidationFinding,
  type ValidationResult,
} from "../../core/validation.js";
import { validateIssueSourceRefs } from "../../core/issue-source-ref.js";
import { loadRulingsSafe } from "../../core/ruling-loader.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { arrangementGateRiskWarnings } from "../../core/arrangement-bounds.js";
import { ExitCode, formatValidation } from "../../core/output-formatter.js";
import type { CommandContext, CommandResult } from "../types.js";

/**
 * ISS-1050 interim: surfaces a plan-ack-without-pre-commit-ack risk for any
 * on-disk arrangement matching that shape, regardless of how it got there
 * (hand-edit, future create/update once gates become configurable, or a
 * merge-driver-produced record).
 *
 * Also surfaces `loadArrangementsSafe`'s own per-file loader warnings
 * (codex round-1 finding, verified against source): `cli/commands/
 * conflicts.ts`'s `arrangementWarningsSection` tells the user "Run
 * `storybloq validate` for details" whenever the arrangement scan is
 * incomplete -- that promise was broken without this, since nothing else in
 * `validate` surfaced those warnings (`buildStatusArrangements` is
 * `status`-only, and the reconcile/conflicts front-gates report at their own
 * command's call time, not at `validate`'s).
 */
function arrangementFindings(root: string): ValidationFinding[] {
  const { arrangements, warnings } = loadArrangementsSafe(root);
  const findings: ValidationFinding[] = warnings.map((message) => ({
    level: "warning",
    code: "arrangement_loader_warning",
    message,
    entity: null,
  }));
  for (const arrangement of arrangements) {
    for (const warning of arrangementGateRiskWarnings(arrangement.gates)) {
      findings.push({
        level: "warning",
        code: "arrangement_gate_risk",
        message: `arrangement ${arrangement.id}: ${warning}`,
        entity: null,
      });
    }
  }
  return findings;
}

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
  return appendValidationFindings(merged, [...loaderFindings, ...arrangementFindings(ctx.root)]);
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
