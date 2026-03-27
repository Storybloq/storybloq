import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";

/**
 * ISSUE_SWEEP stage — postComplete stage that sweeps open issues.
 *
 * Runs after all tickets are done. Partitions issues: session-created first
 * (guide has full context), then pre-existing. Each group sorted by severity
 * (critical → high → medium → low) then discoveredDate.
 *
 * enter(): Load issues, build ordered queue, return instruction for first issue.
 * report(): Issue fixed → mark resolved, pop queue. More → retry with next.
 *           All done → advance (→ HANDOVER).
 */
export class IssueSweepStage implements WorkflowStage {
  readonly id = "ISSUE_SWEEP";

  skip(ctx: StageContext): boolean {
    const issueConfig = ctx.recipe.stages?.ISSUE_SWEEP as Record<string, unknown> | undefined;
    return !issueConfig?.enabled;
  }

  async enter(ctx: StageContext): Promise<StageResult> {
    const { state: projectState } = await ctx.loadProject();
    const allIssues = projectState.issues.filter(i => i.status === "open");

    if (allIssues.length === 0) {
      // No open issues — auto-advance
      return { action: "advance" } as StageAdvance;
    }

    // Partition: session-created first (matched by filedDeferrals fingerprints)
    const sessionIssueIds = new Set(
      (ctx.state.filedDeferrals ?? []).map(d => d.issueId),
    );

    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sortFn = (a: typeof allIssues[0], b: typeof allIssues[0]) => {
      const sa = severityOrder[a.severity] ?? 4;
      const sb = severityOrder[b.severity] ?? 4;
      if (sa !== sb) return sa - sb;
      return a.discoveredDate.localeCompare(b.discoveredDate);
    };

    const sessionIssues = allIssues.filter(i => sessionIssueIds.has(i.id)).sort(sortFn);
    const preExisting = allIssues.filter(i => !sessionIssueIds.has(i.id)).sort(sortFn);
    const ordered = [...sessionIssues, ...preExisting];

    const remaining = ordered.map(i => i.id);
    const current = remaining[0] ?? null;

    ctx.writeState({
      issueSweepState: { remaining, current, resolved: [] },
      pipelinePhase: "postComplete" as const,
    });

    const firstIssue = ordered[0]!;
    return {
      instruction: [
        `# Issue Sweep — ${ordered.length} open issue(s)`,
        "",
        `Fix **${firstIssue.id}**: ${firstIssue.title}`,
        "",
        `Severity: ${firstIssue.severity}`,
        firstIssue.impact ? `Impact: ${firstIssue.impact}` : "",
        "",
        `When done, call \`claudestory_autonomous_guide\` with:`,
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_fixed", "notes": "..." } }`,
        '```',
      ].filter(Boolean).join("\n"),
      reminders: [
        "Fix the issue and update its status to resolved in .story/issues/.",
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const sweep = ctx.state.issueSweepState;
    if (!sweep) {
      return { action: "advance" }; // No sweep state — skip to HANDOVER
    }

    const current = sweep.current;
    if (current) {
      // Verify the issue was actually resolved in project state
      const { state: verifyState } = await ctx.loadProject();
      const currentIssue = verifyState.issues.find(i => i.id === current);
      if (currentIssue && currentIssue.status === "open") {
        return {
          action: "retry",
          instruction: `Issue ${current} is still open. Update its status to "resolved" in .story/issues/${current}.json, then report again.`,
          reminders: ["Set status to 'resolved' and add a resolution description."],
        };
      }

      // Issue resolved — advance queue
      const resolved = [...sweep.resolved, current];
      const remaining = sweep.remaining.filter(id => id !== current);
      const next = remaining[0] ?? null;

      ctx.writeState({
        issueSweepState: { remaining, current: next, resolved },
      });

      if (remaining.length === 0) {
        ctx.appendEvent("issue_sweep_complete", { resolved: resolved.length });
        return { action: "advance" };
      }

      // Load next issue details
      const { state: projectState } = await ctx.loadProject();
      const nextIssue = projectState.issues.find(i => i.id === next);

      return {
        action: "retry",
        instruction: [
          `# Issue Sweep — ${remaining.length} remaining`,
          "",
          nextIssue
            ? `Fix **${nextIssue.id}**: ${nextIssue.title}\nSeverity: ${nextIssue.severity}${nextIssue.impact ? `\nImpact: ${nextIssue.impact}` : ""}`
            : `Fix issue ${next}.`,
          "",
          'When done, report with completedAction: "issue_fixed".',
        ].join("\n"),
        reminders: ["Update issue status to resolved in .story/issues/."],
      };
    }

    // No current issue — sweep is done
    ctx.appendEvent("issue_sweep_complete", { resolved: sweep.resolved.length });
    return { action: "advance" };
  }
}
