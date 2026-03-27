import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { gitDiffCachedNames, gitHead } from "../git-inspector.js";

/**
 * FINALIZE stage — 3-checkpoint sub-machine for staging, pre-commit, and commit.
 *
 * Checkpoints (tracked via state.finalizeCheckpoint):
 * 1. files_staged → verify staged files, overlap detection (ISS-025)
 * 2. precommit_passed → verify staging intact after hooks
 * 3. commit_done → validate commit hash, advance to COMPLETE
 *
 * enter(): Instruction to stage files.
 * report(): Process checkpoint actions via retry (sub-steps) and advance (commit done).
 *
 * HIGHEST RISK extraction — copied verbatim from handleReportFinalize.
 */
export class FinalizeStage implements WorkflowStage {
  readonly id = "FINALIZE";

  async enter(ctx: StageContext): Promise<StageResult> {
    return {
      instruction: [
        "# Finalize",
        "",
        "Code review passed. Time to commit.",
        "",
        ctx.state.ticket ? `1. Update ticket ${ctx.state.ticket.id} status to "complete" in .story/` : "",
        "2. Stage all changed files (code + .story/ changes)",
        "3. Call me with completedAction: \"files_staged\"",
      ].filter(Boolean).join("\n"),
      reminders: ["Stage both code changes and .story/ ticket update in the same commit."],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const action = report.completedAction;
    const checkpoint = ctx.state.finalizeCheckpoint;

    // ISS-031: Already committed — advance regardless of action (re-entry guard)
    if (checkpoint === "committed") {
      return { action: "advance" };
    }

    // --- Checkpoint: stage ---
    if (action === "files_staged" && (!checkpoint || checkpoint === "staged" || checkpoint === "staged_override")) {
      return this.handleStage(ctx, report);
    }

    // --- Checkpoint: precommit ---
    if (action === "precommit_passed") {
      return this.handlePrecommit(ctx);
    }

    // --- Checkpoint: commit ---
    if (action === "commit_done") {
      return this.handleCommit(ctx, report);
    }

    return {
      action: "retry",
      instruction: 'Unexpected action at FINALIZE. Stage files and call with completedAction: "files_staged", or commit and call with completedAction: "commit_done".',
    };
  }

  private async handleStage(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const stagedResult = await gitDiffCachedNames(ctx.root);
    if (!stagedResult.ok || stagedResult.data.length === 0) {
      return { action: "retry", instruction: 'No files are staged. Stage your changes and call me again with completedAction: "files_staged".' };
    }

    // ISS-025: Overlap detection — block staging of pre-existing untracked files
    const baselineUntracked = ctx.state.git.baseline?.untrackedPaths ?? [];
    let overlapOverridden = false;
    if (baselineUntracked.length > 0) {
      const overlap = stagedResult.data.filter((f: string) => baselineUntracked.includes(f));
      if (overlap.length > 0) {
        if (report.overrideOverlap) {
          overlapOverridden = true;
        } else {
          return {
            action: "retry",
            instruction: `Pre-existing untracked files are staged: ${overlap.join(", ")}. Unstage them with \`git restore --staged ${overlap.join(" ")}\`, or report with overrideOverlap: true to proceed.`,
          };
        }
      }
    }

    ctx.writeState({
      finalizeCheckpoint: overlapOverridden ? "staged_override" : "staged",
    });

    return {
      action: "retry",
      instruction: [
        "Files staged. Now run pre-commit checks.",
        "",
        'Run any pre-commit hooks or linting, then call me with completedAction: "precommit_passed".',
        'If pre-commit fails, fix the issues, re-stage, and call me with completedAction: "files_staged" again.',
      ].join("\n"),
      reminders: ["Verify staged set is intact after pre-commit hooks."],
    };
  }

  private async handlePrecommit(ctx: StageContext): Promise<StageAdvance> {
    const checkpoint = ctx.state.finalizeCheckpoint;

    if (!checkpoint || checkpoint === null) {
      return { action: "retry", instruction: 'You must stage files first. Call me with completedAction: "files_staged" after staging.' };
    }
    // checkpoint === "committed" is handled by the top-level guard in report()

    // Verify staged set is still intact after hooks
    const stagedResult = await gitDiffCachedNames(ctx.root);
    if (!stagedResult.ok || stagedResult.data.length === 0) {
      ctx.writeState({ finalizeCheckpoint: null });
      return { action: "retry", instruction: 'Pre-commit hooks appear to have cleared the staging area. Re-stage your changes and call me with completedAction: "files_staged".' };
    }

    // ISS-025: Re-check overlap after hooks (skip if user previously overrode)
    if (checkpoint !== "staged_override") {
      const baselineUntracked = ctx.state.git.baseline?.untrackedPaths ?? [];
      if (baselineUntracked.length > 0) {
        const overlap = stagedResult.data.filter((f: string) => baselineUntracked.includes(f));
        if (overlap.length > 0) {
          ctx.writeState({ finalizeCheckpoint: null });
          return { action: "retry", instruction: `Pre-commit hooks staged pre-existing untracked files: ${overlap.join(", ")}. Unstage them and re-stage, then call with completedAction: "files_staged".` };
        }
      }
    }

    ctx.writeState({ finalizeCheckpoint: "precommit_passed" });

    return {
      action: "retry",
      instruction: [
        "Pre-commit passed. Now commit.",
        "",
        ctx.state.ticket
          ? `Commit with message: "feat: <description> (${ctx.state.ticket.id})"`
          : "Commit with a descriptive message.",
        "",
        'Call me with completedAction: "commit_done" and include the commitHash.',
      ].join("\n"),
    };
  }

  private async handleCommit(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const checkpoint = ctx.state.finalizeCheckpoint;

    if (!checkpoint || checkpoint === null) {
      return { action: "retry", instruction: 'You must stage files first. Call me with completedAction: "files_staged" after staging.' };
    }
    if (checkpoint === "staged" || checkpoint === "staged_override") {
      return { action: "retry", instruction: 'You must pass pre-commit checks first. Call me with completedAction: "precommit_passed".' };
    }
    // checkpoint === "committed" is handled by the top-level guard in report()

    const commitHash = report.commitHash;
    if (!commitHash) {
      return { action: "retry", instruction: "Missing commitHash in report. Call me again with the commit hash." };
    }

    // Validate commitHash matches actual HEAD and is a new commit (ISS-033)
    const headResult = await gitHead(ctx.root);
    const previousHead = ctx.state.git.expectedHead ?? ctx.state.git.initHead;
    if (!headResult.ok || headResult.data.hash !== commitHash) {
      return {
        action: "retry",
        instruction: `Commit hash mismatch: reported ${commitHash} but HEAD is ${headResult.ok ? headResult.data.hash : "unknown"}. Verify the commit succeeded and report the correct hash.`,
      };
    }
    if (previousHead && commitHash === previousHead) {
      return { action: "retry", instruction: `No new commit detected: HEAD (${commitHash}) has not changed. Create a commit first, then report the new hash.` };
    }

    const completedTicket = ctx.state.ticket
      ? { id: ctx.state.ticket.id, title: ctx.state.ticket.title, commitHash, risk: ctx.state.ticket.risk }
      : undefined;

    ctx.writeState({
      finalizeCheckpoint: "committed",
      completedTickets: completedTicket
        ? [...ctx.state.completedTickets, completedTicket]
        : ctx.state.completedTickets,
      ticket: undefined,
      git: {
        ...ctx.state.git,
        mergeBase: commitHash,
        expectedHead: commitHash,
      },
    });

    ctx.appendEvent("commit", { commitHash, ticketId: completedTicket?.id });

    return { action: "advance" };
  }
}
