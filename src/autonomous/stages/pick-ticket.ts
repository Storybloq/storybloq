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
    // Initial enter — provide ticket candidates
    const { state: projectState } = await ctx.loadProject();
    const { nextTickets } = await import("../../core/queries.js");
    const candidates = nextTickets(projectState, 5);

    let candidatesText = "";
    if (candidates.kind === "found") {
      candidatesText = candidates.candidates.map((c: { ticket: { id: string; title: string; type: string } }, i: number) =>
        `${i + 1}. **${c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
      ).join("\n");
    }

    const topCandidate = candidates.kind === "found" ? candidates.candidates[0] : null;

    return {
      instruction: [
        "# Pick a Ticket",
        "",
        candidatesText || "No ticket candidates found.",
        "",
        topCandidate
          ? `Pick **${topCandidate.ticket.id}** (highest priority) by calling \`claudestory_autonomous_guide\` now:`
          : "Pick a ticket by calling `claudestory_autonomous_guide` now:",
        '```json',
        topCandidate
          ? `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
          : `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick a ticket.",
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const ticketId = report.ticketId;
    if (!ticketId) {
      return { action: "retry", instruction: "report.ticketId is required when picking a ticket." };
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

    // Write state transition
    ctx.writeState({
      ticket: { id: ticket.id, title: ticket.title, claimed: true },
      reviews: { plan: [], code: [] },
      finalizeCheckpoint: null,
    });

    ctx.appendEvent("ticket_picked", { ticketId: ticket.id, title: ticket.title });

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
}
