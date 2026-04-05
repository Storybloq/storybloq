import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";

/**
 * ISSUE_FIX stage -- T-153: Fix a single issue picked from PICK_TICKET.
 *
 * enter(): Present issue details, instruct Claude to fix and mark resolved.
 * report(): Verify issue status changed to resolved, goto FINALIZE.
 *
 * Uses goto transitions (not pipeline walker) since ISSUE_FIX is not in
 * the main pipeline. After FINALIZE commits, routing goes through COMPLETE
 * (ISS-084: issues count toward session cap and checkpoint handovers).
 */
export class IssueFixStage implements WorkflowStage {
  readonly id = "ISSUE_FIX";

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    const issue = ctx.state.currentIssue;
    if (!issue) {
      return { action: "goto", target: "PICK_TICKET" };
    }

    // Load full issue details from project state
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch {
      // Fallback to minimal info from session state
      return {
        instruction: [
          "# Fix Issue",
          "",
          `**${issue.id}**: ${issue.title} (severity: ${issue.severity})`,
          "",
          "(Warning: could not load full issue details from .story/ -- using session state.)",
          "",
          "Fix this issue, then update its status to \"resolved\" in `.story/issues/`.",
          "Add a resolution description explaining the fix.",
          "",
          "When done, call `claudestory_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_fixed" } }`,
          '```',
        ].join("\n"),
        reminders: [
          "Update the issue JSON: set status to \"resolved\", add resolution text, set resolvedDate.",
          "Do NOT ask the user for confirmation.",
        ],
      };
    }
    const fullIssue = projectState.issues.find(i => i.id === issue.id);

    const details = fullIssue
      ? [
          `**${fullIssue.id}**: ${fullIssue.title}`,
          "",
          `Severity: ${fullIssue.severity}`,
          fullIssue.impact ? `Impact: ${fullIssue.impact}` : "",
          fullIssue.components.length > 0 ? `Components: ${fullIssue.components.join(", ")}` : "",
          fullIssue.location.length > 0 ? `Location: ${fullIssue.location.join(", ")}` : "",
        ].filter(Boolean).join("\n")
      : `**${issue.id}**: ${issue.title} (severity: ${issue.severity})`;

    return {
      instruction: [
        "# Fix Issue",
        "",
        details,
        "",
        "Fix this issue, then update its status to \"resolved\" in `.story/issues/`.",
        "Add a resolution description explaining the fix.",
        "",
        "When done, call `claudestory_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_fixed" } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Update the issue JSON: set status to \"resolved\", add resolution text, set resolvedDate.",
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    const issue = ctx.state.currentIssue;
    if (!issue) {
      return { action: "goto", target: "PICK_TICKET" };
    }

    // Verify the issue was actually resolved in project state
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption, then report again.` };
    }
    const current = projectState.issues.find(i => i.id === issue.id);
    if (!current || current.status !== "resolved") {
      return {
        action: "retry",
        instruction: `Issue ${issue.id} is still ${current?.status ?? "missing"}. Update its status to "resolved" in .story/issues/${issue.id}.json with a resolution description and resolvedDate, then report again.`,
        reminders: ["Set status to 'resolved', add resolution text, set resolvedDate."],
      };
    }

    // Issue resolved -- route to FINALIZE for commit
    return {
      action: "goto",
      target: "FINALIZE",
      result: {
        instruction: [
          "# Finalize Issue Fix",
          "",
          `Issue ${issue.id} resolved. Time to commit.`,
          "",
          "1. Run `git reset` to clear the staging area (ensures no stale files from prior operations)",
          `2. Ensure .story/issues/${issue.id}.json is updated with status: "resolved"`,
          "3. Stage only the files you modified for this fix (code + .story/ changes). Do NOT use `git add -A` or `git add .`",
          '4. Call me with completedAction: "files_staged"',
        ].join("\n"),
        reminders: ["Stage both code changes and .story/ issue update in the same commit. Only stage files related to this fix."],
        transitionedFrom: "ISSUE_FIX",
      },
    };
  }
}
