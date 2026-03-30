import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";

const MAX_WRITE_TESTS_RETRIES = 3;
const EXIT_CODE_REGEX = /exit\s*(?:code[:\s]*)?\s*(\d+)/i;
const FAIL_COUNT_REGEX = /(\d+)\s*fail/i;

/**
 * WRITE_TESTS stage — TDD: write failing tests before implementation.
 *
 * enter(): Instruct agent to write tests from the approved plan. Tests MUST fail.
 * report(): Verify tests fail with NEW failures (baseline-aware). Advance to IMPLEMENT
 *           when new failing tests are detected.
 *
 * Success = tests fail with MORE failures than baseline (new test contracts written).
 * Failure = tests pass or same failures as baseline (no new tests written).
 */
export class WriteTestsStage implements WorkflowStage {
  readonly id = "WRITE_TESTS";

  skip(ctx: StageContext): boolean {
    const config = ctx.recipe.stages?.WRITE_TESTS as Record<string, unknown> | undefined;
    return !config?.enabled;
  }

  async enter(ctx: StageContext): Promise<StageResult> {
    const config = ctx.recipe.stages?.WRITE_TESTS as Record<string, unknown> | undefined;
    const command = (config?.command as string)
      ?? (ctx.recipe.stages?.TEST as Record<string, unknown> | undefined)?.command as string
      ?? "npm test";
    const retryCount = ctx.state.writeTestsRetryCount ?? 0;
    const planPath = `.story/sessions/${ctx.state.sessionId}/plan.md`;

    return {
      instruction: [
        `# Write Failing Tests (TDD) ${retryCount > 0 ? `— Retry ${retryCount}` : ""}`,
        "",
        "Write tests based on the approved plan. These tests define the contract for the implementation.",
        "",
        "**Critical: Tests MUST fail.** You are writing tests for behavior that does not exist yet.",
        "Do NOT implement the feature — only write tests.",
        "",
        `Plan: \`${planPath}\``,
        `Test command: \`${command}\``,
        "",
        "When done writing tests, run the test command and report the results:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "write_tests_done", "notes": "exit code: <N>, X passed, Y failed" } }`,
        '```',
        "",
        "Include the exit code and pass/fail counts in your notes.",
      ].join("\n"),
      reminders: [
        "Tests MUST fail — they define unimplemented behavior.",
        "Do NOT write implementation code. Only tests.",
        "Include exit code and pass/fail counts in your report notes.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const notes = report.notes ?? "";
    const retryCount = ctx.state.writeTestsRetryCount ?? 0;

    // Parse exit code
    const exitMatch = notes.match(EXIT_CODE_REGEX);
    const exitCode = exitMatch ? parseInt(exitMatch[1]!, 10) : -1;

    // Parse fail count
    const failMatch = notes.match(FAIL_COUNT_REGEX);
    const currentFailCount = failMatch ? parseInt(failMatch[1]!, 10) : -1;

    // Get baseline
    const baseline = ctx.state.testBaseline;
    const baselineFailCount = baseline?.failCount ?? -1;

    const nextRetry = retryCount + 1;

    // Strict baseline validation
    if (baseline === null || baseline === undefined || baselineFailCount < 0) {
      if (nextRetry >= MAX_WRITE_TESTS_RETRIES) {
        return exhaustionAction(ctx);
      }
      ctx.writeState({ writeTestsRetryCount: nextRetry });
      return {
        action: "retry",
        instruction: "Cannot validate TDD results — test baseline was not captured with parseable fail counts. Re-run tests and include explicit pass/fail counts in your report notes (e.g. 'exit code: 1, 10 passed, 3 failed').",
      };
    }

    // Current fail count must be parseable
    if (currentFailCount < 0) {
      if (nextRetry >= MAX_WRITE_TESTS_RETRIES) {
        return exhaustionAction(ctx);
      }
      ctx.writeState({ writeTestsRetryCount: nextRetry });
      return {
        action: "retry",
        instruction: "Could not parse fail count from your report. Re-run tests and include explicit pass/fail counts in notes (e.g. 'exit code: 1, 10 passed, 3 failed').",
      };
    }

    // TDD success: more failures than baseline = new failing tests written
    if (currentFailCount > baselineFailCount) {
      ctx.writeState({ writeTestsRetryCount: 0 });
      ctx.appendEvent("write_tests", {
        exitCode,
        baselineFailCount,
        currentFailCount,
        result: "advance",
      });
      return { action: "advance" };
    }

    // Tests pass or same/decreased failures — no new tests written
    ctx.appendEvent("write_tests", {
      exitCode,
      baselineFailCount,
      currentFailCount,
      result: "retry",
      retryCount: nextRetry,
    });

    if (nextRetry >= MAX_WRITE_TESTS_RETRIES) {
      return exhaustionAction(ctx);
    }
    ctx.writeState({ writeTestsRetryCount: nextRetry });

    // Fix 4: Different guidance for decreased vs unchanged fail count
    let guidance: string;
    if (currentFailCount < baselineFailCount) {
      guidance = `Fail count decreased (${currentFailCount} vs baseline ${baselineFailCount}) — you may have fixed pre-existing failures. Add new failing tests WITHOUT fixing existing ones.`;
    } else if (exitCode === 0) {
      guidance = "All tests pass — you need to write tests for behavior that doesn't exist yet. The tests should FAIL before implementation.";
    } else {
      guidance = `Fail count (${currentFailCount}) has not increased vs baseline (${baselineFailCount}). Write tests for NEW unimplemented behavior, not existing failures.`;
    }

    return {
      action: "retry",
      instruction: [
        `# Write Failing Tests — Retry ${retryCount + 1}`,
        "",
        guidance,
        "",
        "Re-write or add tests, run the test command, and report results with pass/fail counts.",
      ].join("\n"),
      reminders: ["Tests MUST fail with NEW failures. Include pass/fail counts in notes."],
    };
  }
}

function exhaustionAction(ctx: StageContext): StageAdvance {
  const config = ctx.recipe.stages?.WRITE_TESTS as Record<string, unknown> | undefined;
  const onExhaustion = (config?.onExhaustion as string) ?? "plan";

  // Reset retry count so re-entering WRITE_TESTS starts fresh
  ctx.writeState({ writeTestsRetryCount: 0 });
  ctx.appendEvent("write_tests", { result: "exhaustion", onExhaustion });

  if (onExhaustion === "advance") {
    // Return plain advance — let ImplementStage.enter() provide its own instruction.
    // Do NOT include advance.result — it bypasses the next stage's enter().
    return { action: "advance" };
  }

  // Default: back to PLAN with context about why TDD failed
  return {
    action: "back",
    target: "PLAN",
    reason: "TDD exhausted: could not verify new failing tests after 3 attempts. Revise the plan to make the test expectations clearer or simpler.",
  };
}
