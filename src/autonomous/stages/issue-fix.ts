import { displayIdOf } from "../../core/resolver.js";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput, FullSessionState, IssueExit } from "../session-types.js";
import { effectiveReviewEffort } from "../review-effort.js";
import { clearSameSessionEarmark } from "../../core/earmarks.js";
import { loadCitationContext } from "../../core/ruling-loader.js";
import { resolveEntityCitations } from "../../core/ruling.js";
import { formatCitedRulingsSection } from "../../core/output-formatter.js";
import type { IssueResolutionEpoch } from "../issue-resolution-epoch.js";
import { classifySweepExit, releaseImage, dispositionLabel, inlineField, ISSUE_EXIT_LINES, type SweepExit } from "./issue-sweep.js";
import { touchUpdated } from "../../core/metadata-touch.js";
import { localDateOf } from "../../core/local-date.js";

/**
 * ISS-1380 (plan 2h): what to do when a deferral left the issue file unchanged.
 * FINALIZE accepts it only after proving it from git and a fresh classification.
 */
export const DEFERRAL_UNCHANGED_HINT = (id: string): string =>
  `If the deferral left .story/issues/${id}.json unchanged, it is not required in the commit. If this item changed nothing else either, leave the working tree clean and call me with completedAction: "files_staged" and nothing staged; it then completes without a commit.`;

/**
 * ISS-1380: one handover line per finished issue, naming its exit from the
 * record captured when it finished, never from the issue file. A resolved
 * issue with no record (an older session) reads as resolved; a deferred one
 * with no record says its details are unavailable, never resolved.
 */
export function finishedIssueLines(state: Pick<FullSessionState, "resolvedIssues" | "deferredIssues" | "issueExits" | "resolvedIssueDisplayIds">): string[] {
  const exits = new Map((state.issueExits ?? []).map((e) => [e.id, e]));
  const deferred = new Set(state.deferredIssues ?? []);
  return [...(state.resolvedIssues ?? []), ...(state.deferredIssues ?? [])].map((id) => {
    const label = state.resolvedIssueDisplayIds?.[id] ?? id;
    const e = exits.get(id);
    const what = !e
      ? deferred.has(id) ? "deferred; details unavailable" : "resolved"
      : e.exit === "fixed"
      ? "resolved"
      : e.exit === "disposed"
        ? `closed as ${inlineField(e.kind ?? "")}: ${inlineField(e.reason ?? "")}`
        : `deferred: ${inlineField(dispositionLabel(e.disposition ?? ""))}, ${inlineField(e.reason ?? "")}; evidence ${inlineField(e.ref ?? "")}`;
    return `- ${label} (${what}${e && e.commitHash === null ? ", no commit" : ""})`;
  });
}

/**
 * ISS-1380: the refusal FINALIZE and COMPLETE give for a malformed recorded
 * exit. Nothing is booked: a malformed exit is never read as fixed.
 */
export function malformedIssueExitRefusal(stage: "FINALIZE" | "COMPLETE", field: string, label: string, sessionId: string): string {
  return [
    `${stage} refuses: the exit recorded for ${label} (\`${field}\` in this session's state.json) is malformed, so this session cannot tell whether the issue was fixed, closed or deferred.`,
    "",
    `${stage === "FINALIZE" ? "Nothing was committed or booked for it." : "This item is not completed."} Park here: an operator must restore \`${field}\` to the exit ISSUE_FIX recorded, or end session ${sessionId}. Setting it to null would book the issue as fixed.`,
  ].join("\n");
}

/** ISS-1380: one line naming the exit an issue took, for FINALIZE and the reports. */
export function issueExitLine(label: string, exit: IssueExit | null | undefined): string {
  if (!exit || exit.exit === "fixed") return `Issue ${label} resolved (fixed).`;
  if (exit.exit === "disposed") return `Issue ${label} closed as ${exit.kind}: ${exit.reason}`;
  return `Issue ${label} deferred (${dispositionLabel(exit.disposition)}): ${exit.reason} (evidence ${exit.ref})`;
}

/**
 * ISSUE_FIX stage -- T-153: Fix a single issue picked from PICK_TICKET.
 *
 * enter(): Present issue details, instruct Claude to fix and mark resolved.
 * report(): Verify issue status changed to resolved, goto FINALIZE.
 *
 * Uses goto transitions (not pipeline walker) since ISSUE_FIX is not in
 * the main pipeline. After FINALIZE commits, routing goes through COMPLETE
 * (ISS-084: issues count toward session cap and checkpoint handovers).
 */
export class IssueFixStage implements WorkflowStage {
  readonly id = "ISSUE_FIX";

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    const issue = ctx.state.currentIssue;
    if (!issue) {
      return { action: "goto", target: "PICK_TICKET" };
    }
    const issueLabel = displayIdOf(issue);

    // Load full issue details from project state
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch {
      // Fallback to minimal info from session state
      return {
        instruction: [
          "# Fix Issue",
          "",
          `**${issueLabel}**: ${issue.title} (severity: ${issue.severity})`,
          "",
          "(Warning: could not load full issue details from .story/ -- using session state.)",
          "",
          ...ISSUE_EXIT_LINES,
          "",
          "When done, call `storybloq_autonomous_guide` with:",
          '```json',
          `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_fixed" } }`,
          '```',
        ].join("\n"),
        reminders: [
          ...ISSUE_EXIT_LINES,
          "Do NOT ask the user for confirmation.",
        ],
      };
    }
    const fullIssue = projectState.issues.find(i => i.id === issue.id);

    const details = fullIssue
      ? [
          `**${(fullIssue as Record<string, unknown>).displayId as string | undefined ?? fullIssue.id}**: ${fullIssue.title}`,
          "",
          `Severity: ${fullIssue.severity}`,
          fullIssue.impact ? `Impact: ${fullIssue.impact}` : "",
          fullIssue.components.length > 0 ? `Components: ${fullIssue.components.join(", ")}` : "",
          fullIssue.location.length > 0 ? `Location: ${fullIssue.location.join(", ")}` : "",
        ].filter(Boolean).join("\n")
      : `**${issueLabel}**: ${issue.title} (severity: ${issue.severity})`;

    // T-476 acceptance 4: resolve fresh from disk for THIS issue, never from
    // the possibly-stale `issue` snapshot on session state.
    const citedRulingsSection = fullIssue
      ? formatCitedRulingsSection(resolveEntityCitations(fullIssue, loadCitationContext(ctx.root)))
      : "";

    return {
      instruction: [
        "# Fix Issue",
        "",
        details,
        citedRulingsSection,
        "",
        ...ISSUE_EXIT_LINES,
        "",
        "When done, call `storybloq_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_fixed" } }`,
        '```',
      ].join("\n"),
      reminders: [
        ...ISSUE_EXIT_LINES,
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    const issue = ctx.state.currentIssue;
    if (!issue) {
      return { action: "goto", target: "PICK_TICKET" };
    }
    const issueLabel = displayIdOf(issue);

    // Verify the issue was actually finished in project state
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files for corruption, then report again.` };
    }
    const current = projectState.issues.find(i => i.id === issue.id);
    if (!current) {
      return {
        action: "retry",
        instruction: `Issue ${issueLabel} is still missing. Restore .story/issues/${issue.id}.json, then report again.`,
        reminders: [...ISSUE_EXIT_LINES],
      };
    }

    // ISS-1380: the same three exits as the issue sweep, through its own
    // classifier. This unlocked pass only produces the retry texts; nothing is
    // written until the classification is repeated under the lock below.
    const sessionId = ctx.state.sessionId;
    const first: SweepExit = await classifySweepExit(current, projectState, ctx.root, sessionId);
    if (first.kind === "retry") {
      return { action: "retry", instruction: first.text, reminders: [...(first.reminders ?? []), ...ISSUE_EXIT_LINES] };
    }
    if (first.kind === "conflicted") {
      return {
        action: "retry",
        instruction: `Could not confirm ${issueLabel} is still owned by this session (${first.reason}). Re-check .story/issues/${issue.id}.json and report again.`,
      };
    }

    // Section 5 (completion, new seam): the agent's own status-update write
    // just confirmed above landed a genuine resolution -- clear a
    // same-session assigned earmark left over from PICK_TICKET's issue-path
    // acquisition, AND (ISS-1032, Amendment A5) mint this session's
    // resolution epoch and stamp it onto the issue (passthrough field), in
    // the SAME locked write, mirroring `claimEpoch`'s mint-at-acquisition
    // precedent (plan.ts:190).
    //
    // Codex round-2 findings #2/#3: this used to be a best-effort write, and
    // used to trust the UNLOCKED status check above without re-verifying
    // inside the lock. Both were real holes: (a) a swallowed write failure
    // left the epoch unstamped, silently falling back to the pre-A5
    // status-only proof for THIS session's own resolution -- weakening, not
    // merely failing to strengthen, the guarantee A5 exists to add; (b) a
    // foreign session could reopen/reassign the issue in the window between
    // the unlocked check and this write, and the old code would still stamp
    // OUR epoch over that foreign state. Both are fixed by re-checking
    // freshly-read state INSIDE the lock and treating a failed or refused
    // stamp as retryable rather than silently proceeding to FINALIZE.
    //
    // ISS-1380: the re-check is the classifier again, and it must give the
    // same exit as the unlocked pass. A deferral writes the sweep's release
    // image instead (open, this session's earmark cleared, stamped) and mints
    // no epoch: nothing was resolved.
    const epoch: IssueResolutionEpoch = {
      issueId: issue.id,
      sessionId,
      establishedAt: new Date().toISOString(),
    };
    const stampDate = localDateOf(new Date());
    let exit = null as IssueExit | null;
    try {
      const { withProjectLock, writeIssueUnlocked } = await import("../../core/project-loader.js");
      await withProjectLock(ctx.root, { strict: false }, async ({ state: ps }) => {
        const freshIssue = ps.issues.find((i) => i.id === issue.id);
        if (!freshIssue) return;
        const again = await classifySweepExit(freshIssue, ps, ctx.root, sessionId);
        if (again.kind !== first.kind) return;
        if (again.kind === "deferred") {
          const image = touchUpdated(releaseImage(freshIssue, "deferred", sessionId), freshIssue, stampDate);
          await writeIssueUnlocked(image, ctx.root, { touch: { date: stampDate } });
          exit = { exit: "deferred", disposition: again.entry.disposition, reason: again.entry.reason, ref: again.entry.ref };
          return;
        }
        if (again.kind !== "fixed" && again.kind !== "disposed") return;
        const { item: next } = clearSameSessionEarmark(freshIssue, sessionId);
        await writeIssueUnlocked({ ...next, resolutionEpoch: epoch } as typeof freshIssue, ctx.root);
        // The reason is captured here, from the record just proven, so a later
        // edit to the issue cannot change what the reports say.
        exit = again.kind === "fixed"
          ? { exit: "fixed" }
          : { exit: "disposed", kind: again.entry.kind, reason: (freshIssue.resolution ?? "").trim() };
      });
    } catch { /* exit stays null, handled below */ }

    if (!exit) {
      return {
        action: "retry",
        instruction: `Could not confirm ${issueLabel} is still finished and owned by this session (it may have been reopened, changed or reassigned). Re-check its status in .story/issues/${issue.id}.json and report again.`,
      };
    }
    const settled: IssueExit = exit;
    ctx.updateDraft({
      issueResolutionEpoch: settled.exit === "deferred" ? null : epoch,
      currentIssueExit: settled,
    } as Partial<FullSessionState>);
    ctx.appendEvent("issue_fix_exit", { id: issue.id, ...settled });

    // T-208: Optional code review for issue fixes.
    // T-461: a goto jumps straight to a stage without consulting its skip(),
    // so `reviewEffort: off` has to be checked here explicitly or this path
    // would be the one route that still reviews when review is turned off.
    const enableCodeReview = !!(ctx.recipe.stages.ISSUE_FIX as Record<string, unknown> | undefined)?.enableCodeReview;
    if (enableCodeReview && effectiveReviewEffort(ctx.state, "CODE_REVIEW") !== "off") {
      return { action: "goto", target: "CODE_REVIEW" };
    }

    // Issue finished -- route to FINALIZE for commit
    return {
      action: "goto",
      target: "FINALIZE",
      result: {
        instruction: [
          "# Finalize Issue Fix",
          "",
          `${issueExitLine(issue.id, settled)} Time to commit.`,
          "",
          "1. Run `git reset` to clear the staging area (ensures no stale files from prior operations)",
          `2. Ensure .story/issues/${issue.id}.json carries this exit`,
          "3. Stage only the files you modified for this fix (code + .story/ changes). Do NOT use `git add -A` or `git add .`",
          '4. Call me with completedAction: "files_staged"',
          // ISS-1380 (plan 2h): a deferral the issue already carried can leave
          // its file byte-identical to HEAD; FINALIZE proves that from git.
          ...(settled.exit === "deferred" ? [DEFERRAL_UNCHANGED_HINT(issue.id)] : []),
        ].join("\n"),
        reminders: ["Stage both code changes and .story/ issue update in the same commit. Only stage files related to this fix."],
        transitionedFrom: "ISSUE_FIX",
      },
    };
  }
}
