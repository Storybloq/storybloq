import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { handleHandoverCreate } from "../../cli/commands/handover.js";

/**
 * HANDOVER stage — Claude writes a session handover document.
 * Terminal stage — always transitions to SESSION_END.
 *
 * enter(): Instruction to write handover.
 * report(): Create handover, drain deferrals, end session.
 */
export class HandoverStage implements WorkflowStage {
  readonly id = "HANDOVER";

  async enter(ctx: StageContext): Promise<StageResult> {
    const ticketsDone = ctx.state.completedTickets.length;
    return {
      instruction: [
        `# Session Complete — ${ticketsDone} ticket(s) done`,
        "",
        "Write a session handover summarizing what was accomplished, decisions made, and what's next.",
        "",
        'Call me with completedAction: "handover_written" and include the content in handoverContent.',
      ].join("\n"),
      reminders: [],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const content = report.handoverContent;
    if (!content) {
      return { action: "retry", instruction: "Missing handoverContent. Write the handover and include it in the report." };
    }

    // Create handover via existing handler
    let handoverFailed = false;
    try {
      await handleHandoverCreate(content, "auto-session", "md", ctx.root);
    } catch {
      handoverFailed = true;
      try {
        const fallbackPath = join(ctx.dir, "handover-fallback.md");
        writeFileSync(fallbackPath, content, "utf-8");
      } catch { /* truly best-effort */ }
    }

    // ISS-037: final drain of pending deferrals before session end
    // drainPendingDeferrals is called by handleReport pre-dispatch, but we do
    // a final check here via the state's pending deferrals
    const hasUnfiled = (ctx.state.pendingDeferrals ?? []).length > 0;

    // End session
    ctx.writeState({
      state: "SESSION_END",
      previousState: "HANDOVER",
      status: "completed" as const,
      terminationReason: "normal" as const,
      deferralsUnfiled: hasUnfiled,
    });

    ctx.appendEvent("session_end", {
      ticketsCompleted: ctx.state.completedTickets.length,
      handoverFailed,
    });

    const ticketsDone = ctx.state.completedTickets.length;
    // Terminal — return advance but the walker will see SESSION_END is terminal
    return {
      action: "advance",
      result: {
        instruction: [
          "# Session Complete",
          "",
          `${ticketsDone} ticket(s) completed.${handoverFailed ? " Handover creation failed — fallback saved to session directory." : " Handover written."} Session ended.`,
          "",
          ctx.state.completedTickets.map((t) => `- ${t.id}${t.title ? `: ${t.title}` : ""} (${t.commitHash ?? "no commit"})`).join("\n"),
        ].join("\n"),
        reminders: [],
        transitionedFrom: "HANDOVER",
      },
    };
  }
}
