import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { evaluatePressure, pressureMeetsThreshold } from "../context-pressure.js";
import { nextTickets } from "../../core/queries.js";
import { findFirstPostComplete, type NextStageResult } from "./registry.js";
import { isTargetedMode, getRemainingTargets, buildTargetedCandidatesText, buildTargetedPickInstruction, buildTargetedStuckHandover } from "../target-work.js";
import { detectBranchAffinity, buildAffinityAnnotation } from "../branch-affinity.js";

/**
 * COMPLETE stage -- Ticket completed, decide next action.
 *
 * enter(): Auto-advances -- evaluates pressure, checks ticket cap, routes to
 *          PICK_TICKET (continue) or HANDOVER (done). Returns StageAdvance,
 *          not StageResult, so the walker processes it immediately.
 *
 * report(): Not normally called -- CompleteStage auto-advances from enter().
 *           If called (e.g. crash recovery), delegates to enter() logic.
 *
 * ISS-088: Refactored from monolithic enter() into focused helpers:
 *   tryCheckpoint() -- mid-session checkpoint handover + snapshot
 *   buildHandoverResult() -- instruction for session-ending HANDOVER
 *   buildTargetedPickResult() -- instruction for targeted mode PICK_TICKET
 *   buildStandardPickResult() -- instruction for standard auto PICK_TICKET
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
            `# Ticket Complete -- ${mode} mode session ending`,
            "",
            `Ticket **${(ctx.state.ticket as Record<string, unknown> | undefined)?.displayId as string | undefined ?? ctx.state.ticket?.id}** completed. Write a brief session handover.`,
            "",
            'Call me with completedAction: "handover_written" and include the content in handoverContent.',
          ].join("\n"),
          reminders: [],
          transitionedFrom: "COMPLETE",
        },
      } as StageAdvance;
    }

    // ISS-084: Checkpoint at handoverInterval boundaries
    await this.tryCheckpoint(ctx, totalWorkDone, ticketsDone, issuesDone);

    // Load project state for routing decisions
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return {
        action: "goto",
        target: "HANDOVER",
        result: {
          instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Ending session -- write a handover noting the error.`,
          reminders: [],
          transitionedFrom: "COMPLETE",
        },
      } as StageAdvance;
    }

    // Determine next target: HANDOVER or PICK_TICKET
    const targetedRemaining = isTargetedMode(ctx.state) ? getRemainingTargets(ctx.state) : null;
    let nextTarget: string;

    if (targetedRemaining !== null) {
      nextTarget = targetedRemaining.length === 0 ? "HANDOVER" : "PICK_TICKET";
    } else if (maxTickets > 0 && totalWorkDone >= maxTickets) {
      nextTarget = "HANDOVER";
    } else {
      const nextResult = nextTickets(projectState, 1);
      if (nextResult.kind === "found") {
        nextTarget = "PICK_TICKET";
      } else {
        const openIssues = projectState.issues.filter(i => i.status === "open");
        nextTarget = openIssues.length > 0 ? "PICK_TICKET" : "HANDOVER";
      }
    }

    // ISS-034: context-pressure enforcement. COMPLETE is the one clean rotation
    // boundary -- ticket committed, working tree clean, no partial work. When the
    // evaluated pressure has reached the configured compactThreshold, rotate the
    // session here (write a handover and end) instead of picking more work into a
    // degrading context window. This is the ONLY place compactThreshold changes
    // behavior; before this it merely labeled contextPressure.level for display.
    // Rotation never overrides a decision that was already going to HANDOVER, and
    // only fires when there is more work we would otherwise have continued into.
    if (nextTarget === "PICK_TICKET" && pressureMeetsThreshold(pressure, ctx.state.config.compactThreshold)) {
      ctx.appendEvent("pressure_rotation", {
        level: pressure,
        compactThreshold: ctx.state.config.compactThreshold,
        ticketsDone,
        issuesDone,
      });
      return this.buildHandoverResult(ctx, targetedRemaining, ticketsDone, issuesDone, { pressureRotation: true });
    }

    if (nextTarget === "HANDOVER") {
      return this.buildHandoverResult(ctx, targetedRemaining, ticketsDone, issuesDone);
    }

    // PICK_TICKET path
    if (targetedRemaining !== null) {
      return this.buildTargetedPickResult(ctx, targetedRemaining, projectState);
    }
    return this.buildStandardPickResult(ctx, projectState, ticketsDone, maxTickets);
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    return this.enter(ctx);
  }

  // ---------------------------------------------------------------------------
  // Checkpoint -- mid-session handover + snapshot (best-effort)
  // ---------------------------------------------------------------------------

  private async tryCheckpoint(
    ctx: StageContext,
    totalWorkDone: number,
    ticketsDone: number,
    issuesDone: number,
  ): Promise<void> {
    const handoverInterval = ctx.state.config.handoverInterval ?? 5;
    if (handoverInterval <= 0 || totalWorkDone <= 0 || totalWorkDone % handoverInterval !== 0) return;

    try {
      const { handleHandoverCreate } = await import("../../cli/commands/handover.js");
      const completedIds = ctx.state.completedTickets.map((t) => (t as Record<string, unknown>).displayId as string | undefined ?? t.id).join(", ");
      const resolvedIds = (ctx.state.resolvedIssues ?? []).map((id) => ctx.state.resolvedIssueDisplayIds?.[id] ?? id).join(", ");
      const content = [
        `# Checkpoint -- ${totalWorkDone} items completed`,
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

  // ---------------------------------------------------------------------------
  // HANDOVER instruction -- session ending
  // ---------------------------------------------------------------------------

  private buildHandoverResult(
    ctx: StageContext,
    targetedRemaining: string[] | null,
    ticketsDone: number,
    issuesDone: number,
    opts?: { pressureRotation?: boolean },
  ): StageAdvance {
    // Check postComplete pipeline before going to HANDOVER
    const postComplete = ctx.state.resolvedPostComplete ?? ctx.recipe.postComplete;
    const postResult = findFirstPostComplete(postComplete, ctx);
    if (postResult.kind === "found") {
      ctx.writeState({ pipelinePhase: "postComplete" as const });
      return { action: "goto", target: postResult.stage.id };
    }

    const pressureRotation = opts?.pressureRotation ?? false;
    const level = ctx.state.contextPressure?.level ?? "high";

    const handoverHeader = pressureRotation
      ? `# Session Rotating -- context pressure ${level} (${ticketsDone} ticket(s), ${issuesDone} issue(s) done)`
      : targetedRemaining !== null
        ? `# Targeted Session Complete -- All ${ctx.state.targetWork.length} target(s) done`
        : `# Session Complete -- ${ticketsDone} ticket(s) and ${issuesDone} issue(s) done`;

    const rotationNote = pressureRotation
      ? [
          "",
          `Context pressure has reached your configured \`compactThreshold\` (**${ctx.state.config.compactThreshold}**). There is more work available, but rather than continue into a degrading context window the session is rotating now, at a clean boundary -- the ticket is committed and the tree is clean. Write a handover so the next session resumes this work with a fresh context.`,
        ]
      : [];

    return {
      action: "goto",
      target: "HANDOVER",
      result: {
        instruction: [
          handoverHeader,
          ...rotationNote,
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

  // ---------------------------------------------------------------------------
  // Targeted PICK_TICKET instruction
  // ---------------------------------------------------------------------------

  private buildTargetedPickResult(
    ctx: StageContext,
    targetedRemaining: string[],
    projectState: { issues: readonly { id: string; status: string }[] } & Record<string, unknown>,
  ): StageAdvance {
    const { text: candidatesText, firstReady } = buildTargetedCandidatesText(targetedRemaining, projectState);

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

  // ---------------------------------------------------------------------------
  // Standard auto PICK_TICKET instruction
  // ---------------------------------------------------------------------------

  private buildStandardPickResult(
    ctx: StageContext,
    projectState: Record<string, unknown>,
    ticketsDone: number,
    maxTickets: number,
  ): StageAdvance {
    const candidates = nextTickets(projectState, 5);
    let candidatesText = "";
    if (candidates.kind === "found") {
      candidatesText = candidates.candidates.map((c: { ticket: { id: string; title: string; type: string } }, i: number) => {
        const did = (c.ticket as Record<string, unknown>).displayId as string | undefined ?? c.ticket.id;
        return `${i + 1}. **${did}: ${c.ticket.title}** (${c.ticket.type})`;
      }).join("\n");
    }

    // T-328: Branch affinity annotation
    const affinity = detectBranchAffinity(ctx.state.git?.branch ?? null);
    const { warningText } = buildAffinityAnnotation(affinity);
    if (warningText) {
      candidatesText = warningText + "\n\n" + candidatesText;
    }

    const topCandidate = candidates.kind === "found" ? candidates.candidates[0] : null;
    const topDisplayId = topCandidate ? ((topCandidate.ticket as Record<string, unknown>).displayId as string | undefined ?? topCandidate.ticket.id) : null;

    return {
      action: "goto",
      target: "PICK_TICKET",
      result: {
        instruction: [
          `# Ticket Complete -- Continuing (${ticketsDone}/${maxTickets})`,
          "",
          "Do NOT stop. Do NOT ask the user. Continue immediately with the next ticket.",
          "",
          candidatesText,
          "",
          topCandidate
            ? `Pick **${topDisplayId}** (highest priority) by calling \`storybloq_autonomous_guide\` now:`
            : "Pick a ticket by calling `storybloq_autonomous_guide` now:",
          '```json',
          topCandidate
            ? `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${topCandidate.ticket.id}" } }`
            : `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`,
          '```',
        ].join("\n"),
        reminders: [
          "Do NOT stop or summarize. Call autonomous_guide IMMEDIATELY to pick the next ticket.",
          "Do NOT ask the user for confirmation.",
          "You are in autonomous mode -- continue working until all tickets are done or the session limit is reached.",
        ],
        transitionedFrom: "COMPLETE",
        contextAdvice: "ok",
      },
    };
  }
}
