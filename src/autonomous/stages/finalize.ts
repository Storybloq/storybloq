import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput, FullSessionState } from "../session-types.js";
import { gitDiffCachedNames, gitHead, gitDiffTreeNames, gitResolveCommit, gitRevListAncestryPath, gitCommitterEmail, gitUserEmail } from "../git-inspector.js";
import { parseClaimEpoch } from "../claim-preflight.js";
import { effectiveReviewEffort, effortDisclosureLine, normalizeReviewEffortSource } from "../review-effort.js";
import { checkBusShip } from "../../bus/store.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The commit from which the CURRENT item must produce a new, validated commit
 * (ISS-922). Initialized at item pick; reset when drift invalidates the epoch.
 *
 * NOT expectedHead: that records the last OBSERVED head, and park,
 * resume-drift and checkout all legitimately advance it -- onto the very
 * commit FINALIZE has not yet seen. That is what closed all three exits from
 * this stage and stranded a session with no supported recovery.
 *
 * NOT mergeBase either: it is the fork point from main for the first item, so
 * on a feature branch it sits behind HEAD before any work exists, which would
 * fire the already-committed shortcut against a pre-existing branch commit.
 *
 * The fallback chain covers session state written by an older CLI, which
 * carries no itemBaseHead. diagnoseStrandedCommit() makes the refusal
 * actionable when that older state is itself already poisoned.
 */
function itemBaseline(state: FullSessionState): string | undefined {
  return state.git.itemBaseHead ?? state.git.expectedHead ?? state.git.initHead;
}

/**
 * Does `candidate` LOOK like this item's work commit, stranded by a baseline a
 * pre-fix CLI advanced onto it? (ISS-922.)
 *
 * DIAGNOSIS ONLY. This never causes the guide to accept a commit. It decides
 * whether the refusal can name a specific likely commit and the steps to
 * confirm it, or has to stay generic. That limit is deliberate and was the
 * outcome of review: the evidence available here cannot separate a stranded
 * work commit from a pre-existing branch tip.
 *
 * Why not heal automatically. A pre-fix state records only that expectedHead
 * moved, never which writer moved it. Parking moved it (the bug). But so did
 * the pre-fix checkout writer, which promotes expectedHead alone and leaves
 * mergeBase behind -- identical in every observable respect. If a session
 * adopts an existing branch whose tip already contains this item's ledger
 * update from an earlier session, every check below passes on a commit this
 * session neither produced nor reviewed. Auto-accepting would mark the item
 * shipped on unreviewed work; refusing costs one operator step, which the
 * message spells out. A false completion is the worse failure, so this fails
 * closed by construction rather than by having enough evidence.
 *
 * LEGACY ONLY, enforced as the first condition. A session written by this CLI
 * has an itemBaseHead that means exactly one thing, so "candidate equals the
 * baseline" is already conclusive there and nothing needs diagnosing. Running
 * these checks on such a session would actively misread a pre-existing commit
 * as the item's work -- for instance the commit that FILED this item, if HEAD
 * sat on it when the item was picked, since that commit descends from initHead
 * and does modify the item's ledger file.
 *
 * The remaining conditions each refuse cases the others admit:
 *   - mergeBase on the candidate is the pre-fix foreign-drift writer's
 *     signature; that writer moved mergeBase and expectedHead together.
 *   - Ancestry membership refuses a candidate on unrelated or orphan history,
 *     which the tree check alone would accept.
 *   - Direct tree evidence refuses a merge commit, which ancestry alone would
 *     accept (ISS-923).
 *
 * The itemBaseHead and initHead guards are also what keep this off the paths
 * whose fixtures mock git thinly -- they short-circuit before any git call.
 */
type StrandedDiagnosis = "likely_stranded" | "not_attributable" | "git_error";

async function diagnoseStrandedCommit(
  ctx: StageContext,
  candidate: string,
  artifactPath: string,
): Promise<StrandedDiagnosis> {
  if (ctx.state.git.itemBaseHead !== undefined) return "not_attributable";

  const initHead = ctx.state.git.initHead;
  if (!initHead || initHead === candidate) return "not_attributable";
  if (ctx.state.git.mergeBase === candidate) return "not_attributable";

  const candidates = await gitRevListAncestryPath(ctx.root, initHead, candidate, artifactPath);
  if (!candidates?.ok) return "git_error";
  if (!candidates.data.includes(candidate)) return "not_attributable";

  const tree = await gitDiffTreeNames(ctx.root, candidate);
  if (!tree?.ok) return "git_error";
  return tree.data.includes(artifactPath) ? "likely_stranded" : "not_attributable";
}

/**
 * The tail of a FINALIZE refusal: what the operator should do about a commit
 * the guide will not record for them. Kept in one place so both refusal paths
 * make the same promise about what has and has not been verified (local git
 * only -- nothing here checks a remote).
 */
function strandedEscape(
  sessionId: string,
  diagnosis: StrandedDiagnosis,
  candidate: string | null,
): string[] {
  if (diagnosis === "git_error") {
    return [
      "Git could not be queried, so this is NOT a statement that the work is uncommitted.",
      `Check the repository yourself, then either commit and report the hash, or end the session with \`storybloq session stop ${sessionId}\`.`,
    ];
  }
  const short = candidate ? candidate.slice(0, 7) : "the commit";
  if (diagnosis === "likely_stranded" && candidate) {
    return [
      `This session's state predates the ISS-922 fix, and commit ${short} both descends from the session start and modifies this item's ledger file. It may be this item's work, stranded by a baseline an older CLI advanced onto it.`,
      `It is NOT recorded automatically: a pre-existing branch tip is indistinguishable from that here. Confirm with \`git show ${short}\`.`,
      `If it IS this item's work, push it if needed, then end the session with \`storybloq session stop ${sessionId}\` -- the commit stays in local git either way.`,
    ];
  }
  return [
    `If you believe the work is already committed, confirm it with \`git show ${short}\`, push it if needed, then end the session with \`storybloq session stop ${sessionId}\` -- the commit stays in local git either way.`,
  ];
}

/**
 * ISS-982: handleCommit's fast path (reported hash equals or prefixes HEAD)
 * previously accepted a re-report with zero further validation -- an agent
 * re-confirming the exact hash a refused auto-detect fast-forward had
 * already observed took this path and bypassed both the ancestry-path
 * enumeration and the artifact-tree check entirely. This decides whether
 * `commitHash` can be attributed to THIS session before the fast path
 * accepts it.
 *
 * Five-way split by CURRENT ITEM KIND, not epoch presence (R4-F2): FINALIZE's
 * ticket-completion write and the issue-pick path both leave a prior item's
 * `claimEpoch` sitting in state, unwritten, so selecting the check by
 * "epoch present" reads a stale identity into an unrelated commit's check.
 *
 * Every unavailable or malformed signal fails CLOSED -- a deliberate
 * asymmetry with `provenOwnership` (ISS-913), which fails closed on a
 * malformed epoch for a different, already-covered reason. Treating
 * unavailable evidence as a match here would silently reopen the gap this
 * exists to close.
 *
 * Returns the refusal detail rather than throwing/returning a boolean alone,
 * so the caller's refusal message can name the actual reason.
 */
async function checkCommitAttribution(
  ctx: StageContext,
  commitHash: string,
): Promise<{ readonly attributable: boolean; readonly detail: string }> {
  const state = ctx.state;
  const ticket = state.ticket;
  const currentIssue = state.currentIssue;

  // Outcome 1: contradictory shape (both a current ticket and a current
  // issue at once) should never occur and is not disambiguated by
  // preferring one field -- fail closed unconditionally, before any
  // identity signal is even read.
  if (ticket && currentIssue) {
    return {
      attributable: false,
      detail: "session state carries both a current ticket and a current issue at once, which should never happen",
    };
  }

  // Outcomes 2/3: ticket mode. A ticket-mode session is supposed to have a
  // valid, matching claim epoch; not having one does NOT fall back to the
  // heuristic below -- that would readmit the exact stale-identity gap this
  // check exists to close.
  if (ticket) {
    const rawEpoch = (state as Record<string, unknown>).claimEpoch;
    const epoch = rawEpoch !== undefined && rawEpoch !== null ? parseClaimEpoch(rawEpoch) : null;
    if (!epoch || epoch.ticketId !== ticket.id || !epoch.user) {
      return {
        attributable: false,
        detail: "no valid claim epoch matching the current ticket is available to attribute this commit",
      };
    }
    const committer = await gitCommitterEmail(ctx.root, commitHash);
    if (!committer.ok) {
      return {
        attributable: false,
        detail: `could not read commit ${commitHash.slice(0, 7)}'s committer (${committer.message ?? "git error"})`,
      };
    }
    if (committer.data !== epoch.user) {
      return {
        attributable: false,
        detail: `commit ${commitHash.slice(0, 7)}'s committer (${committer.data || "unknown"}) does not match the claim identity (${epoch.user})`,
      };
    }
    return { attributable: true, detail: "" };
  }

  // Outcomes 4/5: issue mode, or neither item present. Neither shape has a
  // claim model, so both fall back to the SAME heuristic -- committer
  // against the live git identity -- explicitly heuristic-only, not
  // session-bound proof. Any residual `claimEpoch` (left behind by a
  // just-completed ticket) is ignored unconditionally here.
  const committer = await gitCommitterEmail(ctx.root, commitHash);
  if (!committer.ok) {
    return {
      attributable: false,
      detail: `could not read commit ${commitHash.slice(0, 7)}'s committer (${committer.message ?? "git error"})`,
    };
  }
  const liveEmail = await gitUserEmail(ctx.root);
  if (!liveEmail) {
    return {
      attributable: false,
      detail: "the local git identity (user.email) could not be resolved",
    };
  }
  if (committer.data !== liveEmail) {
    return {
      attributable: false,
      detail: `commit ${commitHash.slice(0, 7)}'s committer (${committer.data || "unknown"}) does not match the local git identity (${liveEmail}) -- heuristic only`,
    };
  }
  return { attributable: true, detail: "" };
}

/** The ledger file this item's commit must contain, or null outside item work. */
function itemArtifactPath(state: FullSessionState): string | null {
  const ticketId = state.ticket?.id;
  if (ticketId) return `.story/tickets/${ticketId}.json`;
  const issueId = state.currentIssue?.id;
  if (issueId) return `.story/issues/${issueId}.json`;
  return null;
}

/**
 * FINALIZE stage -- 3-checkpoint sub-machine for staging, pre-commit, and commit.
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
 * HIGHEST RISK extraction -- copied verbatim from handleReportFinalize.
 */
export class FinalizeStage implements WorkflowStage {
  readonly id = "FINALIZE";

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    // ISS-031: Already committed (re-entry guard)
    if (ctx.state.finalizeCheckpoint === "committed") {
      return { action: "advance" };
    }

    const busBlockers = await busShipBlockers(ctx);
    if (busBlockers.length > 0) {
      return { instruction: formatBusBlockers(busBlockers) };
    }

    // ISS-105/ISS-106: Detect pre-existing commit before instructing staging.
    // Agents in the issue-fix pipeline typically commit before reporting back,
    // so HEAD has already advanced. Skip the staging ceremony entirely.
    const previousHead = itemBaseline(ctx.state);
    if (previousHead) {
      const headResult = await gitHead(ctx.root);
      if (headResult.ok && headResult.data.hash !== previousHead) {
        // HEAD advanced -- validate and fast-forward to handleCommit
        const treeResult = await gitDiffTreeNames(ctx.root, headResult.data.hash);
        const ticketId = ctx.state.ticket?.id;
        if (ticketId) {
          const ticketPath = `.story/tickets/${ticketId}.json`;
          // ISS-982/R2-F1: `!treeResult.ok` must ALSO fall through, not just a
          // confirmed miss -- the original `treeResult.ok && !includes` gate
          // was fail-OPEN on a git error (false && x is false, taking the
          // proceed branch with an unverified tree).
          if (!treeResult.ok || !treeResult.data.includes(ticketPath)) {
            // Commit exists but missing ticket file, or the tree could not be
            // verified -- fall through to staging instruction.
          } else {
            ctx.writeState({ finalizeCheckpoint: "precommit_passed" });
            return this.handleCommit(ctx, { completedAction: "commit_done", commitHash: headResult.data.hash });
          }
        }
        const issueId = ctx.state.currentIssue?.id;
        if (issueId) {
          const issuePath = `.story/issues/${issueId}.json`;
          // ISS-982/R2-F1: same fail-open fix as the ticket branch above.
          if (!treeResult.ok || !treeResult.data.includes(issuePath)) {
            // Commit exists but missing issue file, or the tree could not be
            // verified -- fall through to staging instruction.
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

    const landingDecision = ctx.state.landingDecision?.stage === "CODE_REVIEW"
      ? ctx.state.landingDecision
      : null;
    const landingCopy = landingDecision
      ? [
          "",
          `Code review reached round ${landingDecision.round}/${landingDecision.maxReviewRounds} with zero blocking findings. Non-blocking findings were deferred as follow-ups. Commit this work; do not reopen implementation for those deferred findings.`,
        ]
      : [];

    // T-461: FINALIZE is the last point before the work becomes a commit, so a
    // level below standard is stated here rather than left in a session file.
    // `off` gets its own sentence because it is a different claim: not "this
    // was reviewed less" but "no review verdict exists for this commit", which
    // is what someone reading the history later needs to know.
    const finalizeEffort = effectiveReviewEffort(ctx.state, "CODE_REVIEW");
    const effortCopy = finalizeEffort === "off"
      ? ["", `${effortDisclosureLine(ctx.state, "CODE_REVIEW")} Review stages were skipped for this item; no review verdict exists for this commit.`]
      : finalizeEffort === "light"
        ? ["", `${effortDisclosureLine(ctx.state, "CODE_REVIEW")} This item was reviewed at a lower depth than the project default.`]
        : [];

    // ISS-099: Single combined instruction -- stage, verify, commit in one round-trip
    return {
      instruction: [
        "# Finalize",
        "",
        // T-461: an `off` item has no verdict to have passed, and saying it
        // passed beside the sentence saying no verdict exists would hand the
        // reader two contradictory claims at the commit boundary.
        finalizeEffort === "off"
          ? "Review stages were skipped. Time to commit."
          : "Code review passed. Time to commit.",
        ...landingCopy,
        ...effortCopy,
        "",
        "1. Run `git reset` to clear the staging area (ensures no stale files from prior operations)",
        ctx.state.ticket ? `2. Update ticket ${ticketLabel(ctx)} status to "complete" in .story/` : "",
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

    // ISS-031: Already committed -- advance regardless of action (re-entry guard)
    if (checkpoint === "committed") {
      return { action: "advance" };
    }

    const busBlockers = await busShipBlockers(ctx);
    if (busBlockers.length > 0) {
      return { action: "retry", instruction: formatBusBlockers(busBlockers) };
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
            ? `Commit with message: "feat: <description> (${ticketLabel(ctx)})"`
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
      const previousHead = itemBaseline(ctx.state);
      if (headResult.ok && previousHead && headResult.data.hash !== previousHead) {
        // HEAD advanced -- agent committed before reporting files_staged
        // Validate commit contains ticket/issue file if applicable
        const treeResult = await gitDiffTreeNames(ctx.root, headResult.data.hash);
        // ISS-982/R2-F1: a git error here must NOT silently fall through to
        // "commit is valid" -- hoisted into its own diagnostic rather than
        // reusing the ticket/issue "amend the commit" message, which would
        // misdescribe a git error as a missing file.
        if (!treeResult.ok) {
          return {
            action: "retry",
            instruction: `Commit detected (${headResult.data.hash.slice(0, 7)}) but its contents could not be verified (git error: ${treeResult.message ?? "unknown"}). Verify the commit yourself, then report completedAction: "commit_done" with the hash again.`,
          };
        }
        const ticketId = ctx.state.ticket?.id;
        if (ticketId) {
          const ticketPath = `.story/tickets/${ticketId}.json`;
          if (!treeResult.data.includes(ticketPath)) {
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
          if (!treeResult.data.includes(issuePath)) {
            return {
              action: "retry",
              instruction: `Commit detected (${headResult.data.hash.slice(0, 7)}) but issue file ${issuePath} is not in the commit. Amend the commit to include it: \`git add ${issuePath} && git commit --amend --no-edit\`, then report completedAction: "commit_done" with the new hash.`,
            };
          }
        }
        // Commit is valid -- fast-forward checkpoint so handleCommit accepts it
        ctx.writeState({ finalizeCheckpoint: "precommit_passed" });
        return this.handleCommit(ctx, { ...report, commitHash: headResult.data.hash });
      }
      // ISS-922: a session parked by a pre-fix CLI can arrive here with its
      // baseline already promoted onto the unreported work commit, so the
      // check above sees no advance and there is nothing left to stage. Ask
      // the candidate-specific question directly before dead-ending.
      // ISS-922: a session parked by a pre-fix CLI can arrive here with its
      // baseline already promoted onto an unreported commit, so there is
      // nothing left to stage. Diagnose that shape to make the refusal
      // actionable -- but never act on it; see diagnoseStrandedCommit.
      const strandedPath = itemArtifactPath(ctx.state);
      let stagedDiagnosis: StrandedDiagnosis = headResult.ok ? "not_attributable" : "git_error";
      if (headResult.ok && strandedPath) {
        stagedDiagnosis = await diagnoseStrandedCommit(ctx, headResult.data.hash, strandedPath);
      }
      return {
        action: "retry",
        instruction: [
          'No files are staged. Stage your changes and call me again with completedAction: "files_staged".',
          previousHead ? `(Nothing new was found against baseline ${previousHead.slice(0, 7)}.)` : "",
          ...strandedEscape(
            ctx.state.sessionId,
            stagedDiagnosis,
            headResult.ok ? headResult.data.hash : null,
          ),
        ].filter(Boolean).join("\n"),
      };
    }

    // ISS-025 + ISS-063: Overlap detection -- block staging of pre-existing untracked files.
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
          ? `Commit with message: "feat: <description> (${ticketLabel(ctx)})"`
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
      ctx.writeState({ finalizeCheckpoint: null, finalizedItem: null });
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
          ctx.writeState({ finalizeCheckpoint: null, finalizedItem: null });
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
          ? `Commit with message: "feat: <description> (${ticketLabel(ctx)})"`
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
    const previousHead = itemBaseline(ctx.state);
    const initHead = ctx.state.git.initHead;
    const reportedHash = commitHash.toLowerCase();

    let normalizedHash: string;
    // ISS-982: the fast path below (reported hash equals or prefixes HEAD)
    // skips the ancestry-path enumeration and artifact-tree check the slow
    // path runs -- reporting the exact hash a refused auto-detect
    // fast-forward already observed takes this path unconditionally. The
    // attribution check after the ISS-925 guard is scoped to this path only;
    // the slow path already proves session-ancestry membership independently.
    let tookFastPath: boolean;

    if (fullHead === reportedHash || fullHead.startsWith(reportedHash)) {
      normalizedHash = fullHead;
      tookFastPath = true;
    } else {
      tookFastPath = false;
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
      // ISS-922: a pre-fix CLI may have promoted the baseline onto this very
      // commit, so "equals the baseline" can be an artefact of the poisoning
      // rather than evidence that no work landed. That possibility is
      // DIAGNOSED, never acted on -- see diagnoseStrandedCommit for why the
      // evidence cannot be made sufficient.
      const strandedPath = itemArtifactPath(ctx.state);
      const commitDiagnosis = strandedPath
        ? await diagnoseStrandedCommit(ctx, normalizedHash, strandedPath)
        : "not_attributable";
      // ISS-922: always a refusal. The diagnosis only decides how specific the
      // instructions can be, never whether the commit is recorded.
      return {
        action: "retry",
        instruction: [
          `No new commit detected: reported hash ${normalizedHash.slice(0, 7)} equals the current item's baseline.`,
          "Commit the work, then report the new hash.",
          ...strandedEscape(ctx.state.sessionId, commitDiagnosis, normalizedHash),
        ].join("\n"),
      };
    }

    // ISS-982: attribution check, fast path only, override-gated. The
    // identity-resolution work runs whenever the fast path was taken; the
    // refusal itself is a SEPARATE, single conditional below it (kept apart
    // so a mutant that deletes only the refusal cannot silently disable the
    // resolution work too).
    let attributionRefusal: string | null = null;
    if (tookFastPath) {
      const attribution = await checkCommitAttribution(ctx, normalizedHash);
      if (!attribution.attributable) attributionRefusal = attribution.detail;
    }
    const overrideRequested = report.overrideAttribution === true;

    if (attributionRefusal !== null && !overrideRequested) {
      return {
        action: "retry",
        instruction: [
          `Commit ${normalizedHash.slice(0, 7)} could not be attributed to this session: ${attributionRefusal}.`,
          'If this is genuinely your work, report again with the same completedAction: "commit_done", the same commitHash, and overrideAttribution: true.',
        ].join("\n"),
      };
    }

    // ISS-084: Issue-fix mode -- record resolved issue, route through COMPLETE
    // (so session limits and checkpoint handovers apply uniformly)
    const currentIssue = ctx.state.currentIssue;
    if (currentIssue) {
      const issueDisplayId = (currentIssue as Record<string, unknown>).displayId as string | undefined;
      ctx.writeState({
        finalizeCheckpoint: "committed",
        // T-450 step 7a: recorded in the SAME write that clears currentIssue
        // below, because after this write nothing else identifies the item.
        finalizedItem: { kind: "issue", id: currentIssue.id, commitHash: normalizedHash },
        resolvedIssues: [...(ctx.state.resolvedIssues ?? []), currentIssue.id],
        resolvedIssueDisplayIds: {
          ...(ctx.state.resolvedIssueDisplayIds ?? {}),
          ...(issueDisplayId ? { [currentIssue.id]: issueDisplayId } : {}),
        },
        // T-461: recorded here, beside resolvedIssues, so the list only ever
        // describes issues that actually resolved. currentReviewEffort is
        // overwritten by the next pick, so a skipped review has to be captured
        // durably or its disclosure is lost the moment the session moves on.
        resolvedIssuesMeta: [
          ...(ctx.state.resolvedIssuesMeta ?? []).filter((m) => m.id !== currentIssue.id),
          {
            id: currentIssue.id,
            // NORMALIZED, not copied. Both fields are permissive persisted
            // strings, so a damaged session could otherwise write "corrupt"
            // into a durable audit record that a person later reads as the
            // level this issue was actually reviewed at. These record what
            // GOVERNED the review, which is what the normalizers return.
            reviewEffort: effectiveReviewEffort(ctx.state, "CODE_REVIEW"),
            source: normalizeReviewEffortSource(ctx.state.currentReviewEffortSource),
          },
        ],
        // ISS-982: append-only audit trail, written in the SAME state write
        // as the checkpoint (durable in the all-or-nothing application
        // sense per ISS-958, not crash-durable). Written unconditionally,
        // whether or not a mismatch was ever detected.
        commitAttributionAudits: [
          ...(ctx.state.commitAttributionAudits ?? []),
          { commitHash: normalizedHash, itemKind: "issue" as const, itemId: currentIssue.id, overrideRequested, at: new Date().toISOString() },
        ],
        currentIssue: null,
        ticketStartedAt: null,
        git: {
          ...ctx.state.git,
          mergeBase: fullHead,
          expectedHead: fullHead,
          itemBaseHead: fullHead,
        },
      });

      ctx.appendEvent("commit", { commitHash: normalizedHash, issueId: currentIssue.id, attributionOverrideRequested: overrideRequested });

      return { action: "goto", target: "COMPLETE" };
    }

    // Normal ticket-fix mode
    const completedTicket = ctx.state.ticket
      ? {
          id: ctx.state.ticket.id,
          displayId: ctx.state.ticket.displayId,
          title: ctx.state.ticket.title,
          commitHash: normalizedHash,
          risk: ctx.state.ticket.risk,
          realizedRisk: ctx.state.ticket.realizedRisk,
          startedAt: ctx.state.ticketStartedAt ?? undefined,
          completedAt: new Date().toISOString(),
          // T-461: pinned here because the top-level field is overwritten by
          // the next pick. CODE_REVIEW is the stage whose level a reader of a
          // completed item cares about, and it is the level the commit was
          // actually reviewed at.
          reviewEffort: effectiveReviewEffort(ctx.state, "CODE_REVIEW"),
        }
      : undefined;

    ctx.writeState({
      finalizeCheckpoint: "committed",
      // T-450 step 7a: same write that clears `ticket` below. The no-item
      // re-entry shape is recorded as `none` rather than left null, because
      // null is indistinguishable from a state written before this field and
      // would send the reader into the legacy fallback, which would name an
      // OLDER completed item as the one this checkpoint committed.
      finalizedItem: completedTicket
        ? { kind: "ticket" as const, id: completedTicket.id, commitHash: normalizedHash }
        : { kind: "none" as const, commitHash: normalizedHash },
      completedTickets: completedTicket
        ? [...ctx.state.completedTickets, completedTicket]
        : ctx.state.completedTickets,
      // ISS-982: same append-only audit trail as the issue path above.
      commitAttributionAudits: [
        ...(ctx.state.commitAttributionAudits ?? []),
        {
          commitHash: normalizedHash,
          itemKind: completedTicket ? ("ticket" as const) : ("none" as const),
          itemId: completedTicket ? completedTicket.id : null,
          overrideRequested,
          at: new Date().toISOString(),
        },
      ],
      ticket: undefined,
      ticketStartedAt: null,
      git: {
        ...ctx.state.git,
        mergeBase: fullHead,
        expectedHead: fullHead,
        itemBaseHead: fullHead,
      },
    });

    ctx.appendEvent("commit", { commitHash: normalizedHash, ticketId: completedTicket?.id, attributionOverrideRequested: overrideRequested });

    return { action: "advance" };
  }
}

function ticketLabel(ctx: StageContext): string {
  return ctx.state.ticket?.displayId ?? ctx.state.ticket?.id ?? "unknown";
}

async function busShipBlockers(ctx: StageContext): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(ctx.root, ".story", "config.json"), "utf-8")) as {
      features?: { bus?: unknown };
    };
    if (raw.features?.bus !== true) return [];
  } catch {
    return [];
  }
  try {
    return [...(await checkBusShip(ctx.root)).blockers];
  } catch (err) {
    return [`Bus integrity check failed: ${err instanceof Error ? err.message : String(err)}`];
  }
}

function formatBusBlockers(blockers: readonly string[]): string {
  return [
    "# Finalize blocked by Storybloq Bus",
    "",
    "Resolve the following Bus gate before committing:",
    ...blockers.map((blocker) => `- ${blocker}`),
    "",
    "Use `storybloq bus check --ship` for delivery blockers or `storybloq bus doctor` for runtime integrity, then report the FINALIZE action again.",
  ].join("\n");
}
