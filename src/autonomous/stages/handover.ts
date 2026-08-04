import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { handleHandoverCreate } from "../../cli/commands/handover.js";
import { gitStashPop } from "../git-inspector.js";
import { removeResumeMarker } from "../resume-marker.js";
import { formatCompactReport } from "../../core/session-report-formatter.js";
import { loadProject } from "../../core/project-loader.js";
import { nextTickets } from "../../core/queries.js";

/**
 * HANDOVER stage - the agent writes a session handover document.
 * Terminal stage - always transitions to SESSION_END.
 *
 * enter(): Instruction to write handover.
 * report(): Create handover, drain deferrals, end session.
 */
export class HandoverStage implements WorkflowStage {
  readonly id = "HANDOVER";

  async enter(ctx: StageContext): Promise<StageResult> {
    const ticketsDone = ctx.state.completedTickets.length;
    const issuesDone = (ctx.state.resolvedIssues ?? []).length;
    const rotation = ctx.state.contextRotation;
    if (rotation) {
      const remaining = rotation.remainingTargets
        .map((id) => ctx.state.targetWorkDisplayIds[id] ?? id)
        .join(", ");
      return {
        instruction: [
          "# Context Rotation Required",
          "",
          `Context pressure is **${rotation.level}**, which reached the configured \`compactThreshold\` (**${rotation.compactThreshold}**).`,
          `${rotation.ticketsDone} ticket(s) and ${rotation.issuesDone} issue(s) are complete. The current item is finalized, and more work remains.`,
          ...(remaining ? [`Remaining targeted work: ${remaining}.`] : []),
          "",
          "Compaction was not confirmed, and Storybloq cannot invoke the client's compaction command. End this bounded session at the clean item boundary and write a handover for the next task.",
          "",
          'Call me with completedAction: "handover_written" and include the content in handoverContent.',
        ].join("\n"),
        reminders: [
          "Do not select another item in this session.",
          "Write the context-rotation handover now.",
        ],
        transitionedFrom: ctx.state.previousState ?? undefined,
      };
    }
    return {
      instruction: [
        `# Session Complete - ${ticketsDone} ticket(s) and ${issuesDone} issue(s) done`,
        "",
        "Write a session handover summarizing what was accomplished, decisions made, and what's next.",
        "",
        'Call me with completedAction: "handover_written" and include the content in handoverContent.',
      ].join("\n"),
      reminders: [
        "Before recording a new lesson, call storybloq_lesson_list to check existing lessons. Then choose: create (new insight), reinforce (existing lesson confirmed), update (refine wording), or skip.",
      ],
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

    // T-125: Restore auto-stashed changes before session end
    let stashPopFailed = false;
    const autoStash = ctx.state.git.autoStash;
    if (autoStash) {
      const popResult = await gitStashPop(ctx.root, autoStash.ref);
      if (!popResult.ok) {
        stashPopFailed = true;
        // Leave stash intact -- user can manually pop with: git stash pop
      }
    }

    // Release ticket claim on session end: for a still-inprogress ticket, delete
    // the claim keys AND flip status back to open so the ticket stays pickable
    // (ISS-792). Ownership matches the cancel and session-compact paths exactly
    // (ISS-778/ISS-816): release when this session owns the claimedBySession
    // stamp, or when the ticket carries no claim material at all; a foreign
    // claim is never touched. The status guard means a non-inprogress ticket is
    // never rewritten here, even with a stale claim stamp: normal completion
    // clears ctx.state.ticket in FINALIZE and clearClaimOnComplete owns that
    // path, while stale claims on complete tickets belong to the ISS-652 repair.
    const ticketId = ctx.state.ticket?.id;
    if (ticketId) {
      try {
        const { withProjectLock, writeTicketUnlocked } = await import("../../core/project-loader.js");
        await withProjectLock(ctx.root, { strict: false }, async ({ state: projectState }) => {
          const ticket = projectState.ticketByID(ticketId);
          if (ticket && ticket.status === "inprogress") {
            const ticketClaim = (ticket as Record<string, unknown>).claimedBySession;
            const ticketClaimBlock = (ticket as Record<string, unknown>).claim;
            // ISS-778/ISS-816: strict ownership, matching the cancel and
            // session-compact paths. Release when this session owns the
            // claimedBySession stamp, or when the ticket carries no claim material
            // at all (a bare inprogress ticket, nothing foreign to destroy). A
            // foreign claim (another session's claimedBySession, or a CLI claim
            // block that never sets claimedBySession) is never released here.
            if (ticketClaim === ctx.state.sessionId || (!ticketClaim && ticketClaimBlock == null)) {
              // ISS-652: delete the keys rather than writing an explicit null,
              // so a released ticket carries no residual claim state.
              const { claimedBySession: _cb, claim: _cl, ...rest } = ticket as Record<string, unknown>;
              await writeTicketUnlocked({ ...rest, status: "open" as const } as typeof ticket, ctx.root);
            }
          }
        });
      } catch { /* best-effort */ }
    }

    // ISS-037: final drain of pending deferrals before session end
    await ctx.drainDeferrals();
    const hasUnfiled = (ctx.state.pendingDeferrals ?? []).length > 0;

    // End session (T-260: finalize kills sidecar + writes shutdown marker)
    ctx.finalizeSession({
      state: "SESSION_END",
      previousState: "HANDOVER",
      status: "completed" as const,
      terminationReason: "normal" as const,
      deferralsUnfiled: hasUnfiled,
    });

    ctx.appendEvent("session_end", {
      ticketsCompleted: ctx.state.completedTickets.length,
      issuesResolved: (ctx.state.resolvedIssues ?? []).length,
      handoverFailed,
    });

    // T-183: Clean resume marker
    removeResumeMarker(ctx.root);

    // T-185: Build compact session report
    let reportSection = "";
    try {
      const { state: projectState } = await loadProject(ctx.root);
      const nextResult = nextTickets(projectState, 5);
      const openIssues = projectState.issues.filter(i => i.status === "open" || i.status === "inprogress").slice(0, 5);
      const remainingWork = {
        tickets: nextResult.kind === "found"
          ? nextResult.candidates.map(c => ({ id: (c.ticket as Record<string, unknown>).displayId as string | undefined ?? c.ticket.id, title: c.ticket.title }))
          : [],
        issues: openIssues.map(i => ({ id: (i as Record<string, unknown>).displayId as string | undefined ?? i.id, title: i.title, severity: i.severity })),
      };
      reportSection = "\n\n" + formatCompactReport({ state: ctx.state, endedAt: new Date().toISOString(), remainingWork });
    } catch { /* best-effort */ }

    const ticketsDone = ctx.state.completedTickets.length;
    const issuesDone = (ctx.state.resolvedIssues ?? []).length;
    const resolvedList = (ctx.state.resolvedIssues ?? []).map((id) => `- ${ctx.state.resolvedIssueDisplayIds?.[id] ?? id} (resolved)`).join("\n");
    // Terminal -- return advance but the walker will see SESSION_END is terminal
    return {
      action: "advance",
      result: {
        instruction: [
          "# Session Complete",
          "",
          `${ticketsDone} ticket(s) and ${issuesDone} issue(s) completed.${handoverFailed ? " Handover creation failed -- fallback saved to session directory." : " Handover written."}${stashPopFailed ? " Auto-stash pop failed -- run `git stash pop` manually." : ""} Session ended.`,
          "",
          ctx.state.completedTickets.map((t) => `- ${(t as Record<string, unknown>).displayId as string | undefined ?? t.id}${t.title ? `: ${t.title}` : ""} (${t.commitHash ?? "no commit"})`).join("\n"),
          ...(resolvedList ? [resolvedList] : []),
        ].join("\n") + reportSection,
        reminders: [],
        transitionedFrom: "HANDOVER",
      },
    };
  }
}
