import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";

const MAX_TEST_RETRIES = 3;

/**
 * TEST stage — run project tests between IMPLEMENT and CODE_REVIEW.
 * Conditional: skip() returns true when not enabled in recipe config.
 *
 * enter(): Instruction to run the test command.
 * report(): Parse exit code. Pass → advance. Fail + retries left → back(IMPLEMENT).
 *           Fail + retries exhausted → advance with failures documented.
 *           Pre-existing failures (vs baseline) don't block.
 */
export class TestStage implements WorkflowStage {
  readonly id = "TEST";

  skip(ctx: StageContext): boolean {
    const testConfig = ctx.recipe.stages?.TEST as Record<string, unknown> | undefined;
    return !testConfig?.enabled;
  }

  async enter(ctx: StageContext): Promise<StageResult> {
    const testConfig = ctx.recipe.stages?.TEST as Record<string, unknown> | undefined;
    const command = (testConfig?.command as string) ?? "npm test";
    const retryCount = ctx.state.testRetryCount ?? 0;

    return {
      instruction: [
        `# Run Tests${retryCount > 0 ? ` (retry ${retryCount}/${MAX_TEST_RETRIES})` : ""}`,
        "",
        `Run the test suite: \`${command}\``,
        "",
        "Report the results with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "tests_run", "notes": "<exit code and summary>" } }`,
        '```',
        "",
        "Include the exit code (0 = pass, non-0 = fail) and a brief summary of pass/fail counts in notes.",
      ].join("\n"),
      reminders: ["Run the FULL test suite, not a subset."],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const notes = report.notes ?? "";
    const retryCount = ctx.state.testRetryCount ?? 0;

    // Parse exit code from notes — require explicit exit code, default to failure if ambiguous
    const exitCodeMatch = notes.match(/exit\s*(?:code[:\s]*)?\s*(\d+)/i);
    if (!exitCodeMatch) {
      // ISS-053: Increment retry count on parse failure to prevent infinite loop
      const nextRetry = retryCount + 1;
      if (nextRetry >= MAX_TEST_RETRIES) {
        ctx.writeState({ testRetryCount: 0 });
        ctx.appendEvent("tests_parse_exhausted", { retryCount: nextRetry });
        return { action: "advance" }; // Give up parsing, advance to CODE_REVIEW
      }
      ctx.writeState({ testRetryCount: nextRetry });
      return { action: "retry", instruction: 'Could not parse exit code from notes. Include "exit code: 0" (or non-zero) in your notes.' };
    }
    const exitCode = parseInt(exitCodeMatch[1]!, 10);

    if (exitCode === 0) {
      // Tests passed — advance to CODE_REVIEW
      ctx.writeState({ testRetryCount: 0 });
      ctx.appendEvent("tests_passed", { retryCount, notes: notes.slice(0, 200) });
      return { action: "advance" };
    }

    // Tests failed — check if failures are pre-existing (baseline also failed)
    // Only auto-advance if the baseline was also failing — new regressions still block
    const baseline = ctx.state.testBaseline;
    if (baseline && baseline.exitCode !== 0) {
      // Try to parse current fail count to compare with baseline
      const failMatch = notes.match(/(\d+)\s*fail/i);
      const currentFails = failMatch ? parseInt(failMatch[1]!, 10) : undefined;
      // Only auto-advance if we can confirm failures aren't worse, or if
      // baseline has no fail count data (passCount/failCount = -1 = uncaptured)
      const baselineUncaptured = baseline.failCount < 0;
      if (baselineUncaptured || (currentFails !== undefined && baseline.failCount >= 0 && currentFails <= baseline.failCount)) {
        ctx.appendEvent("tests_preexisting_failures", { baselineExitCode: baseline.exitCode, baselineFails: baseline.failCount, currentFails, notes: notes.slice(0, 200) });
        return { action: "advance" };
      }
      // Failures are worse than baseline — treat as new regressions, fall through to retry
    }

    // New failures — retry or document and advance
    if (retryCount < MAX_TEST_RETRIES) {
      ctx.writeState({ testRetryCount: retryCount + 1 });
      ctx.appendEvent("tests_failed_retry", { retryCount: retryCount + 1, notes: notes.slice(0, 200) });
      return {
        action: "back",
        target: "IMPLEMENT",
        reason: `Tests failed (attempt ${retryCount + 1}/${MAX_TEST_RETRIES}). Fix the failing tests.`,
      };
    }

    // Max retries exhausted — document and advance
    ctx.writeState({ testRetryCount: 0 });
    ctx.appendEvent("tests_failed_exhausted", { retryCount, notes: notes.slice(0, 200) });
    return {
      action: "advance",
      result: {
        instruction: [
          "# Tests Failed — Proceeding to Code Review",
          "",
          `Tests failed after ${MAX_TEST_RETRIES} retries. Documenting failures and proceeding to code review.`,
          "",
          "The reviewer should be aware that tests are not fully passing.",
        ].join("\n"),
        reminders: ["Mention test failures in the code review submission."],
      },
    };
  }
}
