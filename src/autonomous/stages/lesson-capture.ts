import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";

/**
 * LESSON_CAPTURE -- postComplete stage that instructs the agent to capture
 * review patterns as structured lessons.
 *
 * Reads review history already in session state (reviews.plan, reviews.code).
 * Agent uses existing MCP tools (lesson_list, lesson_create, lesson_reinforce).
 * No new data structures -- just orchestration.
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
    const issuesDone = (ctx.state.resolvedIssues ?? []).length;

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

    // T-181: Analyze dismissed lens findings for false positive patterns
    const lensHistory = ctx.state.lensReviewHistory ?? [];
    // Only "contested" = false positive. "deferred" = valid but out of scope (filed as issue).
    const dismissed = lensHistory.filter(
      (f) => f.disposition === "contested",
    );

    // Group by (lens, category) and find tuples with high dismissal rates
    const tupleCounts = new Map<string, { total: number; dismissed: number }>();
    for (const f of lensHistory) {
      const key = `${f.lens}:${f.category}`;
      const entry = tupleCounts.get(key) ?? { total: 0, dismissed: 0 };
      entry.total++;
      if (f.disposition === "contested") {
        entry.dismissed++;
      }
      tupleCounts.set(key, entry);
    }

    // Tuples with >= 60% dismissal rate over >= 5 data points
    const falsePositivePatterns: string[] = [];
    for (const [key, counts] of tupleCounts) {
      if (counts.total >= 5 && counts.dismissed / counts.total >= 0.6) {
        falsePositivePatterns.push(
          `- **${key}**: ${counts.dismissed}/${counts.total} dismissed (${Math.round(counts.dismissed / counts.total * 100)}%)`,
        );
      }
    }

    const lensSection = falsePositivePatterns.length > 0
      ? [
          "",
          "## Lens False Positive Patterns",
          "",
          "These (lens, category) tuples have a >60% dismissal rate over 5+ reviews. Create a lesson for each:",
          ...falsePositivePatterns,
          "",
          "For each pattern above, create a lesson: \"Lens X tends to flag category Y, but this project considers it acceptable because [reason from dismiss history].\"",
          "Tag with `source: \"lens-feedback\"` and `tags: [\"lens\", lens-name]`.",
        ].join("\n")
      : "";

    const dismissedSection = dismissed.length > 0 && falsePositivePatterns.length === 0
      ? [
          "",
          `## Dismissed Lens Findings (${dismissed.length})`,
          "",
          "Some lens findings were dismissed this session. Not enough data for automatic patterns yet (need 5+ reviews per tuple at >60% dismissal rate).",
        ].join("\n")
      : "";

    return {
      instruction: [
        "# Capture Lessons from Review Findings",
        "",
        `This session completed ${ticketsDone} ticket(s) and ${issuesDone} issue(s). Review summary:`,
        `- **Plan reviews:** ${planReviews.length} round(s), ${planCritical} critical, ${planMajor} major, ${planFindings} total findings`,
        `- **Code reviews:** ${codeReviews.length} round(s), ${codeCritical} critical, ${codeMajor} major, ${codeFindings} total findings`,
        "",
        "Review these findings for recurring patterns worth capturing as lessons:",
        "",
        "1. Call `storybloq_lesson_list` to see existing lessons",
        "2. For each pattern that recurred or was critical/major:",
        "   - If it matches an existing lesson → call `storybloq_lesson_reinforce`",
        "   - If it's a new pattern → call `storybloq_lesson_create` with `source: \"review\"`",
        "3. Skip patterns that are one-off or already well-covered",
        lensSection,
        dismissedSection,
        `4. Call \`storybloq_autonomous_guide\` with completedAction: "lessons_captured"`,
        "",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "lessons_captured" } }`,
        '```',
      ].filter(Boolean).join("\n"),
      reminders: [
        "Check existing lessons first -- reinforce before creating duplicates.",
        "Only capture patterns worth remembering across sessions.",
        ...(falsePositivePatterns.length > 0
          ? ["Lens false positive patterns MUST be captured as lessons -- they improve future reviews."]
          : []),
      ],
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    ctx.appendEvent("lesson_capture", { result: "completed" });
    return { action: "advance" };
  }
}
