import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import type { Issue } from "../../models/issue.js";
import { isDeleted } from "../../core/project-state.js";
import { tryAcquireEarmark, clearSameSessionEarmark } from "../../core/earmarks.js";
import { loadCitationContext } from "../../core/ruling-loader.js";
import { resolveEntityCitations } from "../../core/ruling.js";
import { formatCitedRulingsSection } from "../../core/output-formatter.js";

type SweepAcquisition =
  | { kind: "acquired"; issue: Issue; remaining: string[] }
  | { kind: "exhausted" }
  | { kind: "error"; message: string };

/**
 * ISSUE_SWEEP stage -- postComplete stage that sweeps open issues.
 *
 * Runs after all tickets are done. Partitions issues: session-created first
 * (guide has full context), then pre-existing. Each group sorted by severity
 * (critical → high → medium → low) then discoveredDate.
 *
 * enter(): Load issues, build ordered candidate queue, acquire the first
 *          earmark-eligible one (T-475 Layer 1), return instruction.
 * report(): Issue resolved → mark resolved, acquire next eligible. More →
 *           retry with next. All done or none eligible → advance to
 *           HANDOVER.
 */
export class IssueSweepStage implements WorkflowStage {
  readonly id = "ISSUE_SWEEP";

  skip(ctx: StageContext): boolean {
    const issueConfig = ctx.recipe.stages?.ISSUE_SWEEP as Record<string, unknown> | undefined;
    return !issueConfig?.enabled;
  }

  /**
   * T-475 Layer 1 (binding choke point): confirmed at round 2 that sweep
   * previously bypassed acquisition entirely -- it handed out a fix
   * instruction straight from an in-memory queue with no lock and no status
   * write at all. This is the single acquisition transaction both enter()
   * and report()'s advance-to-next logic call: scans `candidateIds` in
   * order under ONE lock, skips any issue that no longer exists, is no
   * longer open, or is earmarked to someone else (R5 convert-not-clear,
   * same predicate as the ticket/issue choke points in pick-ticket.ts), and
   * atomically converts+claims the first eligible one. Fail-closed: any
   * thrown error refuses (never hands out an instruction under uncertainty).
   */
  private async acquireNextSweepIssue(
    ctx: StageContext,
    candidateIds: readonly string[],
  ): Promise<SweepAcquisition> {
    let outcome: SweepAcquisition = { kind: "exhausted" };
    try {
      const { withProjectLock, writeIssueUnlocked } = await import("../../core/project-loader.js");
      await withProjectLock(ctx.root, { strict: false }, async ({ state: freshState }) => {
        for (let i = 0; i < candidateIds.length; i++) {
          const id = candidateIds[i]!;
          const freshIssue = freshState.issues.find(x => x.id === id);
          if (!freshIssue || freshIssue.status !== "open" || isDeleted(freshIssue)) continue;
          const decision = tryAcquireEarmark(freshIssue.earmark, ctx.state.sessionId, "worker");
          if (!decision.ok) continue; // earmarked to someone else -- skip, do not retry within this sweep
          const updated: Issue = {
            ...freshIssue,
            status: "inprogress",
            ...(decision.write ? { earmark: decision.write } : {}),
          };
          await writeIssueUnlocked(updated, ctx.root);
          outcome = { kind: "acquired", issue: updated, remaining: candidateIds.slice(i + 1) };
          return;
        }
        outcome = { kind: "exhausted" };
      });
    } catch (err) {
      outcome = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    return outcome;
  }

  private instructionFor(issue: Issue, remainingCount: number, root: string): string {
    // T-476 acceptance 4: resolved fresh from disk for THIS issue on every
    // call, never carried over from a previous sweep iteration.
    const citedRulingsSection = formatCitedRulingsSection(resolveEntityCitations(issue, loadCitationContext(root)));
    return [
      `# Issue Sweep -- ${remainingCount} open issue(s)`,
      "",
      `Fix **${issue.id}**: ${issue.title}`,
      "",
      `Severity: ${issue.severity}`,
      issue.impact ? `Impact: ${issue.impact}` : "",
      citedRulingsSection,
    ].filter(Boolean).join("\n");
  }

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch {
      // Can't load issues -- skip sweep, proceed to HANDOVER
      return { action: "goto", target: "HANDOVER" };
    }
    const allIssues = projectState.issues.filter(i => i.status === "open");

    if (allIssues.length === 0) {
      // No open issues -- goto HANDOVER directly (not advance, which would
      // re-enter ISSUE_SWEEP via findFirstPostComplete and loop until depth limit)
      return { action: "goto", target: "HANDOVER" };
    }

    // Partition: session-created first (matched by filedDeferrals fingerprints)
    const sessionIssueIds = new Set(
      (ctx.state.filedDeferrals ?? []).map(d => d.issueId),
    );

    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sortFn = (a: typeof allIssues[0], b: typeof allIssues[0]) => {
      const sa = severityOrder[a.severity] ?? 4;
      const sb = severityOrder[b.severity] ?? 4;
      if (sa !== sb) return sa - sb;
      return a.discoveredDate.localeCompare(b.discoveredDate);
    };

    const sessionIssues = allIssues.filter(i => sessionIssueIds.has(i.id)).sort(sortFn);
    const preExisting = allIssues.filter(i => !sessionIssueIds.has(i.id)).sort(sortFn);
    const ordered = [...sessionIssues, ...preExisting];
    const orderedIds = ordered.map(i => i.id);

    const acquisition = await this.acquireNextSweepIssue(ctx, orderedIds);
    if (acquisition.kind !== "acquired") {
      // "exhausted" (every open issue is earmarked to someone else) and
      // "error" (lock/read/write failure) both fail closed the same way
      // here: no instruction is handed out under uncertainty, and this
      // stage's own established convention on a load failure is already
      // goto HANDOVER rather than retry-forever.
      return { action: "goto", target: "HANDOVER" };
    }

    ctx.writeState({
      issueSweepState: { remaining: acquisition.remaining, current: acquisition.issue.id, resolved: [] },
      pipelinePhase: "postComplete" as const,
    });

    return {
      instruction: [
        this.instructionFor(acquisition.issue, ordered.length, ctx.root),
        "",
        `When done, call \`storybloq_autonomous_guide\` with:`,
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "issue_fixed", "notes": "..." } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Fix the issue and update its status to resolved in .story/issues/.",
        "Do NOT ask the user for confirmation.",
      ],
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const sweep = ctx.state.issueSweepState;
    if (!sweep) {
      return { action: "advance" }; // No sweep state -- skip to HANDOVER
    }

    const current = sweep.current;
    if (current) {
      // T-475 (round-3 finding, confirmed and fixed): acquisition now sets
      // the picked issue to "inprogress", so the OLD check here
      // (`status === "open"` => retry) no longer catches an unfixed issue --
      // it's "inprogress", not "open", and would silently fall through as
      // resolved. Require "resolved" explicitly; every other status gets
      // its own distinct message rather than one collapsed "not open" check.
      let verifyState;
      try {
        ({ state: verifyState } = await ctx.loadProject());
      } catch (err) {
        return { action: "retry", instruction: `Failed to load project state: ${err instanceof Error ? err.message : String(err)}. Check .story/ files, then report again.` };
      }
      const currentIssue = verifyState.issues.find(i => i.id === current);
      if (!currentIssue) {
        return {
          action: "retry",
          instruction: `Issue ${current} could not be found in .story/issues/. Check for corruption, then report again.`,
        };
      }
      if (isDeleted(currentIssue)) {
        return {
          action: "retry",
          instruction: `Issue ${current} was deleted (tombstoned) instead of resolved. Set its status to "resolved" with a resolution description, then report again.`,
        };
      }
      if (currentIssue.status !== "resolved") {
        return {
          action: "retry",
          instruction: `Issue ${current} is still ${currentIssue.status}, not resolved. Update its status to "resolved" in .story/issues/${current}.json, then report again.`,
          reminders: ["Set status to 'resolved' and add a resolution description."],
        };
      }

      // Section 5 (completion, new seam): the agent's own status-update write
      // just confirmed above landed a genuine resolution -- clear a
      // same-session assigned earmark left over from this stage's own
      // acquisition, in a fresh locked write (best-effort: a failure here
      // leaves a stale-eligible earmark for `validate` to flag, never blocks
      // the sweep from advancing).
      try {
        const { withProjectLock, writeIssueUnlocked } = await import("../../core/project-loader.js");
        await withProjectLock(ctx.root, { strict: false }, async ({ state: ps }) => {
          const issue = ps.issues.find((i) => i.id === current);
          if (!issue) return;
          const { cleared, item: next } = clearSameSessionEarmark(issue, ctx.state.sessionId);
          if (cleared) await writeIssueUnlocked(next, ctx.root);
        });
      } catch { /* best-effort */ }

      // Issue resolved -- acquire the next eligible issue from the queue.
      const resolved = [...sweep.resolved, current];
      const acquisition = await this.acquireNextSweepIssue(ctx, sweep.remaining);

      if (acquisition.kind !== "acquired") {
        // "exhausted" (nothing left, or everything left is earmarked to
        // someone else) and "error" both end the sweep here rather than
        // handing out an instruction under uncertainty.
        ctx.writeState({ issueSweepState: { remaining: [], current: null, resolved } });
        ctx.appendEvent("issue_sweep_complete", { resolved: resolved.length });
        return { action: "goto", target: "HANDOVER" };
      }

      ctx.writeState({
        issueSweepState: { remaining: acquisition.remaining, current: acquisition.issue.id, resolved },
      });

      return {
        action: "retry",
        instruction: [
          this.instructionFor(acquisition.issue, acquisition.remaining.length + 1, ctx.root),
          "",
          'When done, report with completedAction: "issue_fixed".',
        ].join("\n"),
        reminders: ["Update issue status to resolved in .story/issues/."],
      };
    }

    // No current issue -- sweep is done
    ctx.appendEvent("issue_sweep_complete", { resolved: sweep.resolved.length });
    return { action: "goto", target: "HANDOVER" };
  }
}
