import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { gitDiffCachedNames, gitHead, gitDiffTreeNames, gitResolveCommit, gitRevListAncestryPath } from "../git-inspector.js";

/**
 * FINALIZE stage — 3-checkpoint sub-machine for staging, pre-commit, and commit.
 *
 * Checkpoints (tracked via state.finalizeCheckpoint):
 * 1. files_staged → verify staged files, overlap detection (ISS-025)
 * 2. precommit_passed → verify staging intact after hooks
 * 3. commit_done → validate commit hash, advance to COMPLETE
 *
 * ISS-084: Both ticket and issue fixes route through COMPLETE so session
 * limits and checkpoint handovers apply uniformly.
 *
 * enter(): Instruction to stage files.
 * report(): Process checkpoint actions via retry (sub-steps) and advance (commit done).
 *
 * HIGHEST RISK extraction — copied verbatim from handleReportFinalize.
 */
export class FinalizeStage implements WorkflowStage {
  readonly id = "FINALIZE";

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    // ISS-031: Already committed (re-entry guard)
    if (ctx.state.finalizeCheckpoint === "committed") {
      return { action: "advance" };
    }

    // ISS-105/ISS-106: Detect pre-existing commit before instructing staging.
    // Agents in the issue-fix pipeline typically commit before reporting back,
    // so HEAD has already advanced. Skip the staging ceremony entirely.
    const previousHead = ctx.state.git.expectedHead ?? ctx.state.git.initHead;
    if (previousHead) {
      const headResult = await gitHead(ctx.root);
      if (headResult.ok && headResult.data.hash !== previousHead) {
        // HEAD advanced -- validate and fast-forward to handleCommit
        const treeResult = await gitDiffTreeNames(ctx.root, headResult.data.hash);
        const ticketId = ctx.state.ticket?.id;
        if (ticketId) {
          const ticketPath = `.story/tickets/${ticketId}.json`;
          if (treeResult.ok && !treeResult.data.includes(ticketPath)) {
            // Commit exists but missing ticket file -- fall through to staging instruction
          } else {
            ctx.writeState({ finalizeCheckpoint: "precommit_passed" });
            return this.handleCommit(ctx, { completedAction: "commit_done", commitHash: headResult.data.hash });
          }
        }
        const issueId = ctx.state.currentIssue?.id;
        if (issueId) {
          const issuePath = `.story/issues/${issueId}.json`;
          if (treeResult.ok && !treeResult.data.includes(issuePath)) {
            // Commit exists but missing issue file -- fall through to staging instruction
          } else {
            ctx.writeState({ finalizeCheckpoint: "precommit_passed" });
            return this.handleCommit(ctx, { completedAction: "commit_done", commitHash: headResult.data.hash });
          }
        }
        // No ticket or issue to validate -- accept the commit as-is
        if (!ticketId && !issueId) {
          ctx.writeState({ finalizeCheckpoint: "precommit_passed" });
          return this.handleCommit(ctx, { completedAction: "commit_done", commitHash: headResult.data.hash });
        }
      }
    }

    // ISS-099: Single combined instruction -- stage, verify, commit in one round-trip
    return {
      instruction: [
        "# Finalize",
        "",
        "Code review passed. Time to commit.",
        "",
        "1. Run `git reset` to clear the staging area (ensures no stale files from prior operations)",
        ctx.state.ticket ? `2. Update ticket ${ctx.state.ticket.id} status to "complete" in .story/` : "",
        ctx.state.currentIssue ? `2. Ensure .story/issues/${ctx.state.currentIssue.id}.json is updated with status: "resolved"` : "",
        "3. Stage only the files you modified for this fix (code + .story/ changes). Do NOT use `git add -A` or `git add .`",
        "4. Call me with completedAction: \"files_staged\"",
      ].filter(Boolean).join("\n"),
      reminders: [
        ctx.state.currentIssue
          ? "Stage both code changes and .story/ issue update in the same commit. Only stage files related to this fix."
          : "Stage both code changes and .story/ ticket update in the same commit. Only stage files related to this ticket.",
      ],
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

    // --- Checkpoint: precommit (kept for backward compatibility) ---
    if (action === "precommit_passed") {
      return this.handlePrecommit(ctx);
    }

    // --- Checkpoint: commit ---
    // ISS-099: Accept commit_done from any checkpoint, including null.
    // When the agent stages and commits in one go, there's no intermediate checkpoint.
    if (action === "commit_done") {
      if (!checkpoint) {
        ctx.writeState({ finalizeCheckpoint: "precommit_passed" });
      }
      return this.handleCommit(ctx, report);
    }

    return {
      action: "retry",
      instruction: 'Unexpected action at FINALIZE. Stage files and call with completedAction: "files_staged", or commit and call with completedAction: "commit_done".',
    };
  }

  private async handleStage(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const checkpoint = ctx.state.finalizeCheckpoint;

    // ISS-063: If already staged (override or not), skip overlap and return
    // the commit instruction idempotently. Prevents infinite loop when
    // agent re-reports files_staged after a successful override.
    if (checkpoint === "staged" || checkpoint === "staged_override") {
      return {
        action: "retry",
        instruction: [
          "Files staged. Now commit.",
          "",
          ctx.state.ticket
            ? `Commit with message: "feat: <description> (${ctx.state.ticket.id})"`
            : "Commit with a descriptive message.",
          "",
          'Call me with completedAction: "commit_done" and include the commitHash.',
        ].join("\n"),
      };
    }

    const stagedResult = await gitDiffCachedNames(ctx.root);
    if (!stagedResult.ok || stagedResult.data.length === 0) {
      // ISS-046: Check if agent already committed (staging area empty because commit happened)
      const headResult = await gitHead(ctx.root);
      const previousHead = ctx.state.git.expectedHead ?? ctx.state.git.initHead;
      if (headResult.ok && previousHead && headResult.data.hash !== previousHead) {
        // HEAD advanced — agent committed before reporting files_staged
        // Validate commit contains ticket/issue file if applicable
        const treeResult = await gitDiffTreeNames(ctx.root, headResult.data.hash);
        const ticketId = ctx.state.ticket?.id;
        if (ticketId) {
          const ticketPath = `.story/tickets/${ticketId}.json`;
          if (treeResult.ok && !treeResult.data.includes(ticketPath)) {
            return {
              action: "retry",
              instruction: `Commit detected (${headResult.data.hash.slice(0, 7)}) but ticket file ${ticketPath} is not in the commit. Amend the commit to include it: \`git add ${ticketPath} && git commit --amend --no-edit\`, then report completedAction: "commit_done" with the new hash.`,
            };
          }
        }
        // T-153: Validate issue file in commit (issue-fix mode)
        const earlyIssueId = ctx.state.currentIssue?.id;
        if (earlyIssueId) {
          const issuePath = `.story/issues/${earlyIssueId}.json`;
          if (treeResult.ok && !treeResult.data.includes(issuePath)) {
            return {
              action: "retry",
              instruction: `Commit detected (${headResult.data.hash.slice(0, 7)}) but issue file ${issuePath} is not in the commit. Amend the commit to include it: \`git add ${issuePath} && git commit --amend --no-edit\`, then report completedAction: "commit_done" with the new hash.`,
            };
          }
        }
        // Commit is valid — fast-forward checkpoint so handleCommit accepts it
        ctx.writeState({ finalizeCheckpoint: "precommit_passed" });
        return this.handleCommit(ctx, { ...report, commitHash: headResult.data.hash });
      }
      return { action: "retry", instruction: 'No files are staged. Stage your changes and call me again with completedAction: "files_staged".' };
    }

    // ISS-025 + ISS-063: Overlap detection — block staging of pre-existing untracked files.
    // Exclude the current session's ticket and issue files from overlap (the guide picked
    // this work, so its .story/ files are expected even if untracked at session start).
    const baselineUntracked = ctx.state.git.baseline?.untrackedPaths ?? [];
    if (baselineUntracked.length > 0) {
      const sessionTicketPath = ctx.state.ticket?.id
        ? `.story/tickets/${ctx.state.ticket.id}.json`
        : null;
      const sessionIssuePath = ctx.state.currentIssue?.id
        ? `.story/issues/${ctx.state.currentIssue.id}.json`
        : null;
      const overlap = stagedResult.data.filter(
        (f: string) => baselineUntracked.includes(f) && f !== sessionTicketPath && f !== sessionIssuePath,
      );
      if (overlap.length > 0) {
        if (report.overrideOverlap) {
          // Override accepted; proceed with staging
        } else {
          return {
            action: "retry",
            instruction: `Pre-existing untracked files are staged: ${overlap.join(", ")}. Unstage them with \`git restore --staged ${overlap.join(" ")}\`, or report with overrideOverlap: true to proceed.`,
          };
        }
      }
    }

    // ISS-047: Validate ticket file is in staged set
    const ticketId = ctx.state.ticket?.id;
    if (ticketId) {
      const ticketPath = `.story/tickets/${ticketId}.json`;
      if (!stagedResult.data.includes(ticketPath)) {
        return {
          action: "retry",
          instruction: `Ticket file ${ticketPath} is not staged. Run \`git add ${ticketPath}\` and call me again with completedAction: "files_staged".`,
        };
      }
    }

    // T-153: Validate issue file is in staged set (issue-fix mode)
    const issueId = ctx.state.currentIssue?.id;
    if (issueId) {
      const issuePath = `.story/issues/${issueId}.json`;
      if (!stagedResult.data.includes(issuePath)) {
        return {
          action: "retry",
          instruction: `Issue file ${issuePath} is not staged. Run \`git add ${issuePath}\` and call me again with completedAction: "files_staged".`,
        };
      }
    }

    // ISS-099: Skip precommit round-trip -- go straight to commit instruction
    ctx.writeState({
      finalizeCheckpoint: "precommit_passed",
    });

    return {
      action: "retry",
      instruction: [
        "Files staged. Now commit.",
        "",
        ctx.state.ticket
          ? `Commit with message: "feat: <description> (${ctx.state.ticket.id})"`
          : "Commit with a descriptive message.",
        "",
        'Call me with completedAction: "commit_done" and include the commitHash.',
      ].join("\n"),
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

    // ISS-025 + ISS-063: Re-check overlap after hooks (skip if user previously overrode)
    if (checkpoint !== "staged_override") {
      const baselineUntracked = ctx.state.git.baseline?.untrackedPaths ?? [];
      if (baselineUntracked.length > 0) {
        const sessionTicketPath = ctx.state.ticket?.id
          ? `.story/tickets/${ctx.state.ticket.id}.json`
          : null;
        const sessionIssuePath = ctx.state.currentIssue?.id
          ? `.story/issues/${ctx.state.currentIssue.id}.json`
          : null;
        const overlap = stagedResult.data.filter(
          (f: string) => baselineUntracked.includes(f) && f !== sessionTicketPath && f !== sessionIssuePath,
        );
        if (overlap.length > 0) {
          ctx.writeState({ finalizeCheckpoint: null });
          return { action: "retry", instruction: `Pre-commit hooks staged pre-existing untracked files: ${overlap.join(", ")}. Unstage them and re-stage, then call with completedAction: "files_staged".` };
        }
      }
    }

    // ISS-047: Re-validate ticket file in staged set after hooks
    const ticketId = ctx.state.ticket?.id;
    if (ticketId) {
      const ticketPath = `.story/tickets/${ticketId}.json`;
      if (!stagedResult.data.includes(ticketPath)) {
        return {
          action: "retry",
          instruction: `Pre-commit hooks may have modified the staged set. Ticket file ${ticketPath} is no longer staged. Run \`git add ${ticketPath}\` and call me again with completedAction: "files_staged".`,
        };
      }
    }

    // T-153: Re-validate issue file after hooks (issue-fix mode)
    const precommitIssueId = ctx.state.currentIssue?.id;
    if (precommitIssueId) {
      const issuePath = `.story/issues/${precommitIssueId}.json`;
      if (!stagedResult.data.includes(issuePath)) {
        return {
          action: "retry",
          instruction: `Pre-commit hooks may have modified the staged set. Issue file ${issuePath} is no longer staged. Run \`git add ${issuePath}\` and call me again with completedAction: "files_staged".`,
        };
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

    // ISS-378: Accept any new session-scoped commit on the ancestry path between
    // initHead and HEAD that touches the expected ticket/issue artifact. The fast
    // path preserves prior behavior for the normal flow (reported hash matches
    // HEAD); the slow path adds drift tolerance for orphan resume.
    const headResult = await gitHead(ctx.root);
    if (!headResult.ok) {
      return {
        action: "retry",
        instruction: `Cannot resolve HEAD (git error: ${headResult.message ?? "unknown"}). Verify the commit succeeded and report again.`,
      };
    }
    const fullHead = headResult.data.hash;
    const previousHead = ctx.state.git.expectedHead ?? ctx.state.git.initHead;
    const initHead = ctx.state.git.initHead;
    const reportedHash = commitHash.toLowerCase();

    let normalizedHash: string;

    if (fullHead === reportedHash || fullHead.startsWith(reportedHash)) {
      normalizedHash = fullHead;
    } else {
      const resolvedResult = await gitResolveCommit(ctx.root, reportedHash);
      if (!resolvedResult.ok) {
        return {
          action: "retry",
          instruction: `Commit hash ${commitHash} does not exist in the repository. Verify the commit succeeded and report the correct hash.`,
        };
      }
      normalizedHash = resolvedResult.data;

      const ticketId = ctx.state.ticket?.id;
      const issueId = ctx.state.currentIssue?.id;
      const expectedPath = ticketId
        ? `.story/tickets/${ticketId}.json`
        : issueId
        ? `.story/issues/${issueId}.json`
        : null;
      if (!expectedPath) {
        return {
          action: "retry",
          instruction: `Commit hash mismatch: reported ${commitHash} but HEAD is ${fullHead}. Verify the commit succeeded and report the correct hash.`,
        };
      }
      if (!initHead) {
        return {
          action: "retry",
          instruction: `Commit hash mismatch: reported ${commitHash} but HEAD is ${fullHead} and no session baseline is available. Verify the commit succeeded and report the correct hash.`,
        };
      }

      const candidatesResult = await gitRevListAncestryPath(ctx.root, initHead, fullHead, expectedPath);
      if (!candidatesResult.ok) {
        return {
          action: "retry",
          instruction: `Cannot enumerate candidate commits for ${expectedPath} (git error: ${candidatesResult.message ?? "unknown"}). Verify the commit succeeded and report again.`,
        };
      }
      const candidates = candidatesResult.data;
      if (candidates.length === 0) {
        return {
          action: "retry",
          instruction: `No commit on the session ancestry path touched ${expectedPath}. ` +
            `Ensure the ${ticketId ? "ticket" : "issue"} file update is included in a commit between the session baseline and HEAD, then report the commit hash.`,
        };
      }
      if (!candidates.includes(normalizedHash)) {
        return {
          action: "retry",
          instruction: `Commit ${commitHash} is not a session work commit for ${expectedPath}. ` +
            `It is either outside the session range (baseline ${initHead.slice(0, 7)}..HEAD ${fullHead.slice(0, 7)}), on a merged-in side branch, or does not modify the expected file. ` +
            `Report the actual work commit.`,
        };
      }
    }

    if (previousHead && normalizedHash === previousHead) {
      return { action: "retry", instruction: `No new commit detected: reported hash ${normalizedHash.slice(0, 7)} equals session baseline. Create a commit first, then report the new hash.` };
    }

    // ISS-084: Issue-fix mode -- record resolved issue, route through COMPLETE
    // (so session limits and checkpoint handovers apply uniformly)
    const currentIssue = ctx.state.currentIssue;
    if (currentIssue) {
      ctx.writeState({
        finalizeCheckpoint: "committed",
        resolvedIssues: [...(ctx.state.resolvedIssues ?? []), currentIssue.id],
        currentIssue: null,
        ticketStartedAt: null,
        git: {
          ...ctx.state.git,
          mergeBase: fullHead,
          expectedHead: fullHead,
        },
      });

      ctx.appendEvent("commit", { commitHash: normalizedHash, issueId: currentIssue.id });

      return { action: "goto", target: "COMPLETE" };
    }

    // Normal ticket-fix mode
    const completedTicket = ctx.state.ticket
      ? {
          id: ctx.state.ticket.id,
          title: ctx.state.ticket.title,
          commitHash: normalizedHash,
          risk: ctx.state.ticket.risk,
          realizedRisk: ctx.state.ticket.realizedRisk,
          startedAt: ctx.state.ticketStartedAt ?? undefined,
          completedAt: new Date().toISOString(),
        }
      : undefined;

    ctx.writeState({
      finalizeCheckpoint: "committed",
      completedTickets: completedTicket
        ? [...ctx.state.completedTickets, completedTicket]
        : ctx.state.completedTickets,
      ticket: undefined,
      ticketStartedAt: null,
      git: {
        ...ctx.state.git,
        mergeBase: fullHead,
        expectedHead: fullHead,
      },
    });

    ctx.appendEvent("commit", { commitHash: normalizedHash, ticketId: completedTicket?.id });

    return { action: "advance" };
  }
}
