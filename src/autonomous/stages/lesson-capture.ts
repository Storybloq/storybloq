import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";

/**
 * LESSON_CAPTURE — postComplete stage that instructs the agent to capture
 * review patterns as structured lessons.
 *
 * Reads review history already in session state (reviews.plan, reviews.code).
 * Agent uses existing MCP tools (lesson_list, lesson_create, lesson_reinforce).
 * No new data structures — just orchestration.
 */
export class LessonCaptureStage implements WorkflowStage {
  readonly id = "LESSON_CAPTURE";

  skip(ctx: StageContext): boolean {
    const config = ctx.recipe.stages?.LESSON_CAPTURE as Record<string, unknown> | undefined;
    return !config?.enabled;
  }

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    const planReviews = ctx.state.reviews.plan ?? [];
    const codeReviews = ctx.state.reviews.code ?? [];
    const ticketsDone = ctx.state.completedTickets.length;

    // Summarize findings across all review rounds
    const planFindings = planReviews.reduce((sum, r) => sum + (r.findingCount ?? 0), 0);
    const planCritical = planReviews.reduce((sum, r) => sum + (r.criticalCount ?? 0), 0);
    const planMajor = planReviews.reduce((sum, r) => sum + (r.majorCount ?? 0), 0);
    const codeFindings = codeReviews.reduce((sum, r) => sum + (r.findingCount ?? 0), 0);
    const codeCritical = codeReviews.reduce((sum, r) => sum + (r.criticalCount ?? 0), 0);
    const codeMajor = codeReviews.reduce((sum, r) => sum + (r.majorCount ?? 0), 0);
    const totalFindings = planFindings + codeFindings;

    // No findings → nothing to capture
    if (totalFindings === 0) {
      ctx.appendEvent("lesson_capture", { result: "no_findings", ticketsDone });
      return { action: "advance" };
    }

    ctx.appendEvent("lesson_capture", {
      result: "started",
      ticketsDone,
      planFindings,
      codeFindings,
    });

    return {
      instruction: [
        "# Capture Lessons from Review Findings",
        "",
        `This session completed ${ticketsDone} ticket(s). Review summary:`,
        `- **Plan reviews:** ${planReviews.length} round(s), ${planCritical} critical, ${planMajor} major, ${planFindings} total findings`,
        `- **Code reviews:** ${codeReviews.length} round(s), ${codeCritical} critical, ${codeMajor} major, ${codeFindings} total findings`,
        "",
        "Review these findings for recurring patterns worth capturing as lessons:",
        "",
        "1. Call `claudestory_lesson_list` to see existing lessons",
        "2. For each pattern that recurred or was critical/major:",
        "   - If it matches an existing lesson → call `claudestory_lesson_reinforce`",
        "   - If it's a new pattern → call `claudestory_lesson_create` with `source: \"review\"`",
        "3. Skip patterns that are one-off or already well-covered",
        `4. Call \`claudestory_autonomous_guide\` with completedAction: "lessons_captured"`,
        "",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "lessons_captured" } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Check existing lessons first — reinforce before creating duplicates.",
        "Only capture patterns worth remembering across sessions.",
      ],
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    ctx.appendEvent("lesson_capture", { result: "completed" });
    return { action: "advance" };
  }
}
