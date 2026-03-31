import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";

/**
 * PICK_TICKET stage — Claude selects the next ticket to work on.
 *
 * enter(): Candidate list + pick instruction (from handleStart or CompleteStage).
 * report(): Validate ticket exists and is open, advance to PLAN.
 */
export class PickTicketStage implements WorkflowStage {
  readonly id = "PICK_TICKET";

  async enter(ctx: StageContext): Promise<StageResult> {
    // Initial enter — provide ticket candidates + high-severity issues (T-153)
    const { state: projectState } = await ctx.loadProject();
    const { nextTickets } = await import("../../core/queries.js");
    const candidates = nextTickets(projectState, 5);

    let candidatesText = "";
    if (candidates.kind === "found") {
      candidatesText = candidates.candidates.map((c: { ticket: { id: string; title: string; type: string } }, i: number) =>
        `${i + 1}. **${c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
      ).join("\n");
    }

    // T-153: Surface high/critical open issues
    const highIssues = projectState.issues.filter(
      i => i.status === "open" && (i.severity === "critical" || i.severity === "high"),
    );
    let issuesText = "";
    if (highIssues.length > 0) {
      issuesText = "\n\n## Open Issues (high+ severity)\n\n" + highIssues.map(
        (i, idx) => `${idx + 1}. **${i.id}: ${i.title}** (${i.severity})`,
      ).join("\n");
    }

    const topCandidate = candidates.kind === "found" ? candidates.candidates[0] : null;
    const hasIssues = highIssues.length > 0;

    // ISS-075: If nothing left to do, route to COMPLETE (which handles HANDOVER/postComplete)
    if (!topCandidate && candidates.kind !== "found" && !hasIssues) {
      return { action: "goto", target: "COMPLETE" };
    }

    return {
      instruction: [
        "# Pick a Ticket or Issue",
        "",
        "## Ticket Candidates",
        "",
        candidatesText || "No ticket candidates found.",
        issuesText,
        "",
        topCandidate
          ? `Pick **${topCandidate.ticket.id}** (highest priority) or an open issue by calling \`claudestory_autonomous_guide\` now:`
          : hasIssues
            ? `Pick an issue to fix by calling \`claudestory_autonomous_guide\` now:`
            : "Pick a ticket by calling `claudestory_autonomous_guide` now:",
        '```json',
        topCandidate
          ? `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
          : `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
        '```',
        ...(hasIssues ? [
          "",
          "Or to fix an issue:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_picked", "issueId": "${highIssues[0].id}" } }`,
          '```',
        ] : []),
      ].join("\n"),
      reminders: [
        "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick a ticket or issue.",
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    // T-153: Accept issueId for issue-fix flow
    const issueId = report.issueId;
    if (issueId) {
      return this.handleIssuePick(ctx, issueId);
    }

    const ticketId = report.ticketId;
    if (!ticketId) {
      return { action: "retry", instruction: "report.ticketId or report.issueId is required." };
    }

    // Validate ticket
    const { state: projectState } = await ctx.loadProject();
    const ticket = projectState.ticketByID(ticketId);
    if (!ticket) {
      return { action: "retry", instruction: `Ticket ${ticketId} not found. Pick a valid ticket.` };
    }
    if (projectState.isBlocked(ticket)) {
      return { action: "retry", instruction: `Ticket ${ticketId} is blocked. Pick an unblocked ticket.` };
    }
    // ISS-027: Reject non-open tickets unless claimed by this session
    if (ticket.status !== "open") {
      const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
      if (!(ticket.status === "inprogress" && ticketClaim === ctx.state.sessionId)) {
        return { action: "retry", instruction: `Ticket ${ticketId} is ${ticket.status} — pick an open ticket.` };
      }
    }

    // Clean up stale plan from previous ticket (ISS-029)
    const planPath = join(ctx.dir, "plan.md");
    try { if (existsSync(planPath)) unlinkSync(planPath); } catch { /* best-effort */ }

    // Stage field updates (persisted atomically with state transition by processAdvance)
    ctx.updateDraft({
      ticket: { id: ticket.id, title: ticket.title, claimed: true },
      reviews: { plan: [], code: [] },
      finalizeCheckpoint: null,
    });

    // Produce PLAN instruction (advance with result for hybrid dispatch)
    return {
      action: "advance",
      result: {
        instruction: [
          `# Plan for ${ticket.id}: ${ticket.title}`,
          "",
          ticket.description ? `## Ticket Description\n\n${ticket.description}` : "",
          "",
          `Write an implementation plan for this ticket. Save it to \`.story/sessions/${ctx.state.sessionId}/plan.md\`.`,
          "",
          "When done, call `claudestory_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "plan_written" } }`,
          '```',
        ].join("\n"),
        reminders: [
          "Write the plan as a markdown file — do NOT use Claude Code's plan mode.",
          "Do NOT ask the user for approval.",
        ],
        transitionedFrom: "PICK_TICKET",
      },
    };
  }

  // T-153: Handle issue pick -- validate and route to ISSUE_FIX
  private async handleIssuePick(ctx: StageContext, issueId: string): Promise<StageAdvance> {
    const { state: projectState } = await ctx.loadProject();
    const issue = projectState.issues.find(i => i.id === issueId);

    if (!issue) {
      return { action: "retry", instruction: `Issue ${issueId} not found. Pick a valid issue or ticket.` };
    }
    if (issue.status !== "open") {
      return { action: "retry", instruction: `Issue ${issueId} is ${issue.status}. Pick an open issue.` };
    }

    // Mark issue as inprogress in .story/
    try {
      const { handleIssueUpdate } = await import("../../cli/commands/issue.js");
      await handleIssueUpdate({ id: issueId, status: "inprogress" }, "json", ctx.root);
    } catch { /* best-effort -- don't block on status update */ }

    ctx.updateDraft({
      currentIssue: { id: issue.id, title: issue.title, severity: issue.severity },
      ticket: undefined,
      reviews: { plan: [], code: [] },
      finalizeCheckpoint: null,
    });

    return { action: "goto", target: "ISSUE_FIX" };
  }
}
