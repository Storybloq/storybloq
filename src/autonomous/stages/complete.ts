import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { evaluatePressure } from "../context-pressure.js";
import { nextTickets } from "../../core/queries.js";
import { findFirstPostComplete, type NextStageResult } from "./registry.js";
import { isTargetedMode, getRemainingTargets, buildTargetedCandidatesText, buildTargetedPickInstruction, buildTargetedStuckHandover } from "../target-work.js";

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
    const issuesDone = (ctx.state.resolvedIssues ?? []).length;
    const totalWorkDone = ticketsDone + issuesDone;
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

    // ISS-084: Checkpoint uses totalWorkDone (tickets + issues)
    const handoverInterval = ctx.state.config.handoverInterval ?? 5;
    if (handoverInterval > 0 && totalWorkDone > 0 && totalWorkDone % handoverInterval === 0) {
      try {
        const { handleHandoverCreate } = await import("../../cli/commands/handover.js");
        const completedIds = ctx.state.completedTickets.map((t) => t.id).join(", ");
        const resolvedIds = (ctx.state.resolvedIssues ?? []).join(", ");
        const content = [
          `# Checkpoint — ${totalWorkDone} items completed`,
          "",
          `**Session:** ${ctx.state.sessionId}`,
          ...(completedIds ? [`**Tickets:** ${completedIds}`] : []),
          ...(resolvedIds ? [`**Issues resolved:** ${resolvedIds}`] : []),
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

      ctx.appendEvent("checkpoint", { ticketsDone, issuesDone, totalWorkDone, interval: handoverInterval });
    }

    // ISS-084: Session cap uses totalWorkDone (tickets + issues). Cap takes precedence.
    const { state: projectState } = await ctx.loadProject();
    let nextTarget: string;

    // T-188: Targeted mode -- remaining-count is authoritative termination
    const targetedRemaining = isTargetedMode(ctx.state) ? getRemainingTargets(ctx.state) : null;
    if (targetedRemaining !== null) {
      nextTarget = targetedRemaining.length === 0 ? "HANDOVER" : "PICK_TICKET";
    } else if (maxTickets > 0 && totalWorkDone >= maxTickets) {
      nextTarget = "HANDOVER";
    } else {
      // Check if more work available (tickets or issues)
      const nextResult = nextTickets(projectState, 1);
      if (nextResult.kind === "found") {
        nextTarget = "PICK_TICKET";
      } else {
        // ISS-084: Check for ANY open issues, not just high/critical
        const openIssues = projectState.issues.filter(i => i.status === "open");
        nextTarget = openIssues.length > 0 ? "PICK_TICKET" : "HANDOVER";
      }
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

      const handoverHeader = targetedRemaining !== null
        ? `# Targeted Session Complete -- All ${ctx.state.targetWork.length} target(s) done`
        : `# Session Complete — ${ticketsDone} ticket(s) and ${issuesDone} issue(s) done`;

      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: [
            handoverHeader,
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

    // T-188: Targeted mode -- show only remaining targets, check for stuck
    if (targetedRemaining !== null) {
      const { text: candidatesText, firstReady } = buildTargetedCandidatesText(targetedRemaining, projectState);

      // All remaining targets stuck -- route to HANDOVER with explanation
      if (!firstReady) {
        return {
          action: "goto",
          target: "HANDOVER",
          result: {
            instruction: buildTargetedStuckHandover(candidatesText, ctx.state.sessionId),
            reminders: [],
            transitionedFrom: "COMPLETE",
          },
        } as StageAdvance;
      }

      const precomputed = { text: candidatesText, firstReady };
      const targetedInstruction = buildTargetedPickInstruction(targetedRemaining, projectState, ctx.state.sessionId, precomputed);
      return {
        action: "goto",
        target: "PICK_TICKET",
        result: {
          instruction: [
            `# Item Complete -- Continuing (${ctx.state.targetWork.length - targetedRemaining.length}/${ctx.state.targetWork.length} targets done)`,
            "",
            "Do NOT stop. Do NOT ask the user. Continue immediately with the next target.",
            "",
            targetedInstruction,
          ].join("\n"),
          reminders: [
            "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick the next target.",
            "Do NOT ask the user for confirmation.",
            "You are in targeted auto mode -- pick ONLY from the listed items.",
          ],
          transitionedFrom: "COMPLETE",
          contextAdvice: "ok",
        },
      };
    }

    // Standard auto mode -- back to PICK_TICKET with fresh candidates
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
