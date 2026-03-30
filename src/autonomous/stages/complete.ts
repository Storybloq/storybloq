import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { evaluatePressure } from "../context-pressure.js";
import { nextTickets } from "../../core/queries.js";
import { findFirstPostComplete, type NextStageResult } from "./registry.js";

/**
 * COMPLETE stage — Ticket completed, decide next action.
 *
 * enter(): Auto-advances — evaluates pressure, checks ticket cap, routes to
 *          PICK_TICKET (continue) or HANDOVER (done). Returns StageAdvance,
 *          not StageResult, so the walker processes it immediately.
 *
 * report(): Not normally called — CompleteStage auto-advances from enter().
 *           If called (e.g. crash recovery), delegates to enter() logic.
 */
export class CompleteStage implements WorkflowStage {
  readonly id = "COMPLETE";

  async enter(ctx: StageContext): Promise<StageAdvance> {
    const pressure = evaluatePressure(ctx.state);
    ctx.writeState({
      contextPressure: { ...ctx.state.contextPressure, level: pressure },
      finalizeCheckpoint: null,
    });

    const ticketsDone = ctx.state.completedTickets.length;
    const maxTickets = ctx.state.config.maxTicketsPerSession;
    const mode = ctx.state.mode ?? "auto";

    // T-135: Non-auto modes (guided) end after single ticket
    if (mode !== "auto") {
      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: [
            `# Ticket Complete — ${mode} mode session ending`,
            "",
            `Ticket **${ctx.state.ticket?.id}** completed. Write a brief session handover.`,
            "",
            'Call me with completedAction: "handover_written" and include the content in handoverContent.',
          ].join("\n"),
          reminders: [],
          transitionedFrom: "COMPLETE",
        },
      } as StageAdvance;
    }

    // T-147: Periodic checkpoint handover (non-blocking, best-effort)
    const handoverInterval = ctx.state.config.handoverInterval ?? 5;
    if (handoverInterval > 0 && ticketsDone > 0 && ticketsDone % handoverInterval === 0) {
      try {
        const { handleHandoverCreate } = await import("../../cli/commands/handover.js");
        const completedIds = ctx.state.completedTickets.map((t) => t.id).join(", ");
        const content = [
          `# Checkpoint — ${ticketsDone} tickets completed`,
          "",
          `**Session:** ${ctx.state.sessionId}`,
          `**Tickets:** ${completedIds}`,
          "",
          "This is an automatic mid-session checkpoint. The session is still active.",
        ].join("\n");
        await handleHandoverCreate(content, "checkpoint", "md", ctx.root);
      } catch { /* best-effort */ }

      try {
        const { loadProject } = await import("../../core/project-loader.js");
        const { saveSnapshot } = await import("../../core/snapshot.js");
        const loadResult = await loadProject(ctx.root);
        await saveSnapshot(ctx.root, loadResult);
      } catch { /* best-effort */ }

      ctx.appendEvent("checkpoint", { ticketsDone, interval: handoverInterval });
    }

    // Determine next action
    let nextTarget: string;

    if (maxTickets > 0 && ticketsDone >= maxTickets) {
      nextTarget = "HANDOVER";
    } else {
      nextTarget = "PICK_TICKET";
    }

    // Check if more tickets available
    const { state: projectState } = await ctx.loadProject();
    const nextResult = nextTickets(projectState, 1);
    if (nextResult.kind !== "found") {
      nextTarget = "HANDOVER";
    }

    if (nextTarget === "HANDOVER") {
      // Check postComplete pipeline before going to HANDOVER
      const postComplete = ctx.state.resolvedPostComplete ?? ctx.recipe.postComplete;
      const postResult = findFirstPostComplete(postComplete, ctx);
      if (postResult.kind === "found") {
        ctx.writeState({ pipelinePhase: "postComplete" as const });
        return { action: "goto", target: postResult.stage.id };
      }
      // "unregistered" — postComplete stage not available (future stage not deployed).
      // "exhausted" — no enabled postComplete stages.
      // Both: fall through to HANDOVER.

      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: [
            `# Session Complete — ${ticketsDone} ticket(s) done`,
            "",
            "Write a session handover summarizing what was accomplished, decisions made, and what's next.",
            "",
            'Call me with completedAction: "handover_written" and include the content in handoverContent.',
          ].join("\n"),
          reminders: [],
          transitionedFrom: "COMPLETE",
          contextAdvice: "ok",
        },
      } as StageAdvance;
    }

    // Back to PICK_TICKET with fresh candidates
    const candidates = nextTickets(projectState, 5);
    let candidatesText = "";
    if (candidates.kind === "found") {
      candidatesText = candidates.candidates.map((c: { ticket: { id: string; title: string; type: string } }, i: number) =>
        `${i + 1}. **${c.ticket.id}: ${c.ticket.title}** (${c.ticket.type})`,
      ).join("\n");
    }

    const topCandidate = candidates.kind === "found" ? candidates.candidates[0] : null;

    return {
      action: "goto",
      target: "PICK_TICKET",
      result: {
        instruction: [
          `# Ticket Complete — Continuing (${ticketsDone}/${maxTickets})`,
          "",
          "Do NOT stop. Do NOT ask the user. Continue immediately with the next ticket.",
          "",
          candidatesText,
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
          "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick the next ticket.",
          "Do NOT ask the user for confirmation.",
          "You are in autonomous mode — continue working until all tickets are done or the session limit is reached.",
        ],
        transitionedFrom: "COMPLETE",
        contextAdvice: "ok",
      },
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    // CompleteStage normally auto-advances from enter(). If report() is called
    // (e.g. after crash recovery), just re-run the enter() logic.
    return this.enter(ctx);
  }
}
