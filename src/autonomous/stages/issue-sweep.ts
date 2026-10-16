import { randomUUID } from "node:crypto";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { FullSessionState, GuideReportInput } from "../session-types.js";
import type { Issue } from "../../models/issue.js";
import type { ProjectState } from "../../core/project-state.js";
import { isDeleted } from "../../core/project-state.js";
import { isNonActionableDisposition } from "../../core/issue-disposition.js";
import { tryAcquireEarmark, clearSameSessionEarmark, describeEarmarkHolder } from "../../core/earmarks.js";
import { dispositionEvidenceView, effectiveResolutionKind } from "../../core/resolution-kind.js";
import { entityFingerprint } from "../pending-artifacts.js";
import { loadCitationContext } from "../../core/ruling-loader.js";
import { resolveEntityCitations } from "../../core/ruling.js";
import { formatCitedRulingsSection } from "../../core/output-formatter.js";

type SweepState = NonNullable<FullSessionState["issueSweepState"]>;

/** T-486 U4: how the sweep finished an issue it acquired. */
export type SweepOutcome = "fixed" | "disposed" | "deferred";
export type DisposedEntry = { id: string; kind: string };
export type DeferredEntry = { id: string; disposition: string; reason: string; ref: string };
export type ConflictedEntry = { id: string; reason: string };
export type SweepEntry = { id: string } | DisposedEntry | DeferredEntry;

/**
 * T-486 U4 (v2 5a): what the current issue's state lets the sweep do with it.
 * `conflicted` means this session cannot finish it (another session holds
 * it, or it carries merge conflicts); it is listed, never written.
 */
export type SweepExit =
  | { kind: "conflicted"; reason: string }
  | { kind: "fixed"; entry: { id: string } }
  | { kind: "disposed"; entry: DisposedEntry }
  | { kind: "deferred"; entry: DeferredEntry }
  | { kind: "retry"; text: string; reminders?: string[] };

/** The marker type both sweep steps record on `pendingProjectMutation`. */
export const SWEEP_STEP = "issue_sweep_step";

type ReleaseStep = {
  variant: "release";
  transitionId: string;
  current: string;
  outcome: SweepOutcome;
  entry: SweepEntry;
  releasePre: string;
  releasePost: string;
};
type AcquireStep = {
  variant: "acquire";
  transitionId: string;
  next: { id: string; pre: string; post: string };
  after: string[];
};
export type ParsedSweepStep = ReleaseStep | AcquireStep | { variant: "malformed" };

export type SweepStepRecovery =
  | { kind: "settled"; updates: Partial<FullSessionState>; events: Array<{ type: string; data: Record<string, unknown> }> }
  | { kind: "pending"; reason: string };

/** The text every blocked call returns while a sweep step is unconfirmed (5h). */
export function sweepStepPendingText(reason: string): string {
  return `The issue sweep's last step could not be confirmed (${reason}). Nothing was acquired or advanced; retry the same call.`;
}

export function isSweepStepMarker(mutation: unknown): boolean {
  return typeof mutation === "object" && mutation !== null && (mutation as Record<string, unknown>).type === SWEEP_STEP;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const failureText = (err: unknown): string => err instanceof Error ? err.message : String(err);

function parseEntry(outcome: SweepOutcome, value: unknown, current: string): SweepEntry | null {
  if (!isRecord(value) || value.id !== current) return null;
  if (outcome === "fixed") return { id: current };
  if (outcome === "disposed") return isText(value.kind) ? { id: current, kind: value.kind } : null;
  return isText(value.disposition) && isText(value.reason) && isText(value.ref)
    ? { id: current, disposition: value.disposition, reason: value.reason, ref: value.ref }
    : null;
}

/** Reads a sweep marker strictly: any missing or ill-typed field is malformed. */
export function parseSweepStep(mutation: unknown): ParsedSweepStep {
  const malformed = { variant: "malformed" } as const;
  if (!isRecord(mutation) || mutation.type !== SWEEP_STEP || !isText(mutation.transitionId)) return malformed;
  const m = mutation;
  const transitionId = mutation.transitionId;
  if (m.variant === "release") {
    if (!isText(m.current) || !isText(m.releasePre) || !isText(m.releasePost)) return malformed;
    if (m.outcome !== "fixed" && m.outcome !== "disposed" && m.outcome !== "deferred") return malformed;
    const entry = parseEntry(m.outcome, m.entry, m.current);
    if (!entry) return malformed;
    return {
      variant: "release", transitionId, current: m.current, outcome: m.outcome,
      entry, releasePre: m.releasePre, releasePost: m.releasePost,
    };
  }
  if (m.variant === "acquire") {
    const next = m.next;
    if (!isRecord(next) || !isText(next.id) || !isText(next.pre) || !isText(next.post)) return malformed;
    if (!Array.isArray(m.after) || !m.after.every(isText)) return malformed;
    return { variant: "acquire", transitionId, next: { id: next.id, pre: next.pre, post: next.post }, after: [...m.after] };
  }
  return malformed;
}

/** A state written by 1.16.0, or built by hand, carries no outcome lists yet. */
function sweepLists(sweep: SweepState): SweepState {
  return { ...sweep, disposed: sweep.disposed ?? [], deferred: sweep.deferred ?? [], conflicted: sweep.conflicted ?? [] };
}

const EMPTY_SWEEP: SweepState = { remaining: [], current: null, resolved: [], disposed: [], deferred: [], conflicted: [] };

function withOutcome(sweep: SweepState, outcome: SweepOutcome, entry: SweepEntry): SweepState {
  const s = sweepLists(sweep);
  if (outcome === "fixed") return { ...s, current: null, resolved: [...s.resolved, entry.id] };
  if (outcome === "disposed") return { ...s, current: null, disposed: [...s.disposed, entry as DisposedEntry] };
  return { ...s, current: null, deferred: [...s.deferred, entry as DeferredEntry] };
}

function withConflicted(sweep: SweepState, id: string, reason: string): SweepState {
  const s = sweepLists(sweep);
  return { ...s, current: null, conflicted: [...s.conflicted, { id, reason }] };
}

function hasIssueConflicts(issue: Issue): boolean {
  const conflicts = (issue as Record<string, unknown>)._conflicts;
  return Array.isArray(conflicts) && conflicts.length > 0;
}

/**
 * T-486 U4 (5e): the acquisition image. `sweepAcquisition` names the session
 * and the step that acquired the issue, written in the same ledger write as
 * the status change, so a foreign acquisition never matches this step's
 * postimage.
 */
function acquisitionImage(issue: Issue, earmarkWrite: Issue["earmark"] | null, sessionId: string, transitionId: string): Issue {
  return {
    ...issue,
    status: "inprogress",
    ...(earmarkWrite ? { earmark: earmarkWrite } : {}),
    sweepAcquisition: { sessionId, transitionId },
  } as Issue;
}

/**
 * T-486 U4 (5f): the release image. The intent's postimage fingerprint and the
 * write (live or replayed) are both built here, so they cannot disagree.
 */
export function releaseImage(issue: Issue, outcome: SweepOutcome, sessionId: string): Issue {
  const { item } = clearSameSessionEarmark(issue, sessionId);
  const { sweepAcquisition: _acquired, ...rest } = item as Issue & { sweepAcquisition?: unknown };
  return (outcome === "deferred" ? { ...rest, status: "open" } : rest) as Issue;
}

const retry = (text: string, reminders?: string[]): SweepExit => ({ kind: "retry", text, ...(reminders && { reminders }) });

/**
 * T-486 U4 (5c): the exit the current issue's state allows, read inside the
 * sweep lock on the issue the caller is about to act on.
 */
export async function classifySweepExit(issue: Issue, state: ProjectState, root: string, sessionId: string): Promise<SweepExit> {
  const id = issue.id;
  if (hasIssueConflicts(issue)) return { kind: "conflicted", reason: "unresolved merge conflicts" };
  const earmark = issue.earmark;
  if (earmark && !(earmark.stage === "assigned" && earmark.holderSession === sessionId)) {
    return { kind: "conflicted", reason: `earmarked for ${describeEarmarkHolder(earmark)}` };
  }
  const acquired = (issue as Record<string, unknown>).sweepAcquisition;
  if (acquired !== undefined && acquired !== null && !(isRecord(acquired) && acquired.sessionId === sessionId)) {
    const holder = isRecord(acquired) && isText(acquired.sessionId) ? `session ${acquired.sessionId}` : "another session";
    return { kind: "conflicted", reason: `acquired by ${holder}'s issue sweep` };
  }
  if (isDeleted(issue)) {
    return retry(`Issue ${id} was deleted (tombstoned) instead of resolved. Set its status to "resolved" with a resolution description, then report again.`);
  }

  if (issue.status === "resolved") {
    const kind = effectiveResolutionKind(issue);
    if (kind === null || kind === "fixed") return { kind: "fixed", entry: { id } };
    if (!issue.resolution?.trim()) {
      return retry(`Issue ${id} is resolved as ${kind} without a resolution. Give the reason as its resolution, then report again.`);
    }
    if (kind === "duplicate") {
      if (!issue.duplicateOf) {
        return retry(`Issue ${id} is resolved as a duplicate without duplicateOf. Set duplicateOf to the ticket or issue it duplicates, then report again.`);
      }
      const { resolveDuplicateTarget } = await import("../../cli/commands/issue.js");
      try {
        resolveDuplicateTarget(state, issue.duplicateOf, id);
      } catch (err) {
        return retry(`Issue ${id}: duplicateOf: ${failureText(err)}. Fix it, then report again.`);
      }
    }
    return { kind: "disposed", entry: { id, kind } };
  }

  if ((issue.status === "inprogress" || issue.status === "open") && isNonActionableDisposition(issue.disposition)) {
    const disposition = issue.disposition;
    const view = dispositionEvidenceView(issue);
    if (view.state === "unbound") {
      const written = String((issue as Record<string, unknown>).dispositionFor);
      return retry(`Issue ${id}: the evidence was written for disposition ${written}, not ${disposition}. Set the disposition again with its reason and ref, then report again.`);
    }
    if (view.state !== "effective" || view.reason === null || view.ref === null) {
      const raw = issue as Record<string, unknown>;
      const missing = !isText(raw.dispositionReason) ? "dispositionReason" : !isText(raw.dispositionRef) ? "dispositionRef" : "dispositionFor";
      return retry(`Issue ${id} has disposition ${disposition} without a valid ${missing}. A deferral needs a reason and an evidence reference; set them, then report again.`);
    }
    const { resolveDispositionRef } = await import("../../cli/commands/issue.js");
    try {
      resolveDispositionRef(state, root, view.ref);
    } catch (err) {
      return retry(`Issue ${id}: dispositionRef: ${failureText(err)}. Fix it, then report again.`);
    }
    return { kind: "deferred", entry: { id, disposition, reason: view.reason, ref: view.ref } };
  }

  return retry(
    `Issue ${id} is still ${issue.status}, not resolved. Update its status to "resolved" in .story/issues/${id}.json, then report again.`,
    ["Set status to 'resolved' and add a resolution description."],
  );
}

/**
 * T-486 U4 (5g): settles a sweep step left by an interrupted call. Everything
 * is read, classified and written inside one sweep lock; a thrown lock or IO
 * error keeps the marker and is reported as pending, so the caller blocks
 * instead of acting on an unconfirmed step.
 */
export async function recoverIssueSweepStep(root: string, state: FullSessionState): Promise<SweepStepRecovery> {
  const cleared: Partial<FullSessionState> = { pendingProjectMutation: null };
  const settled = (updates: Partial<FullSessionState>, events: Array<{ type: string; data: Record<string, unknown> }> = []): SweepStepRecovery =>
    ({ kind: "settled", updates, events });
  const step = parseSweepStep(state.pendingProjectMutation);
  if (step.variant === "malformed") {
    return settled(cleared, [{ type: "issue_sweep_conflict", data: { reason: "malformed-marker" } }]);
  }
  const stored = state.issueSweepState;
  if (!stored) {
    return settled(cleared, [{ type: "issue_sweep_conflict", data: { transitionId: step.transitionId, reason: "no-sweep-state" } }]);
  }
  const sweep = sweepLists(stored);
  // The outcome already landed: the stored current issue moved on.
  if (step.variant === "release" && sweep.current !== step.current) return settled(cleared);

  const sessionId = state.sessionId;
  let result = null as SweepStepRecovery | null;
  try {
    const { withProjectLockForIssueSweep, writeIssueUnlocked } = await import("../../core/project-loader.js");
    await withProjectLockForIssueSweep(root, async ({ state: projectState }) => {
      if (step.variant === "release") {
        const conflict = (reason: string) => settled(cleared, [{
          type: "issue_sweep_conflict",
          data: { transitionId: step.transitionId, current: step.current, reason },
        }]);
        const issue = projectState.issues.find((i) => i.id === step.current);
        if (!issue) { result = conflict("target-missing"); return; }
        const exit = await classifySweepExit(issue, projectState, root, sessionId);
        if (exit.kind === "conflicted") {
          result = settled({ issueSweepState: withConflicted(sweep, step.current, exit.reason), pendingProjectMutation: null });
          return;
        }
        const recorded = settled({ issueSweepState: withOutcome(sweep, step.outcome, step.entry), pendingProjectMutation: null });
        const fingerprint = entityFingerprint(issue);
        if (fingerprint === step.releasePost) { result = recorded; return; }
        if (fingerprint === step.releasePre) {
          const image = releaseImage(issue, step.outcome, sessionId);
          if (entityFingerprint(image) !== step.releasePost) { result = conflict("inconsistent-marker"); return; }
          await writeIssueUnlocked(image, root);
          result = recorded;
          return;
        }
        result = conflict("changed");
        return;
      }
      const issue = projectState.issues.find((i) => i.id === step.next.id);
      const fingerprint = issue ? entityFingerprint(issue) : null;
      if (fingerprint === step.next.post) {
        result = settled({ issueSweepState: { ...sweep, current: step.next.id, remaining: [...step.after] }, pendingProjectMutation: null });
        return;
      }
      // Not acquired: the stored queue still starts with the candidate.
      if (fingerprint === step.next.pre) { result = settled(cleared); return; }
      result = settled(cleared, [{
        type: "issue_sweep_conflict",
        data: { transitionId: step.transitionId, next: step.next.id, reason: issue ? "changed" : "target-missing" },
      }]);
    });
  } catch (err) {
    return { kind: "pending", reason: failureText(err) };
  }
  return result ?? { kind: "pending", reason: "the sweep lock returned no verdict" };
}

type Acquisition =
  | { kind: "acquired"; issue: Issue; count: number }
  | { kind: "exhausted" }
  | { kind: "error"; message: string }
  | { kind: "pending"; message: string };

type Candidate = { transitionId: string; next: { id: string; pre: string; post: string }; after: string[]; image: Issue };

/**
 * ISSUE_SWEEP stage -- postComplete stage that sweeps open issues.
 *
 * Runs after all tickets are done. Partitions issues: session-created first
 * (guide has full context), then pre-existing. Each group sorted by severity
 * (critical → high → medium → low) then discoveredDate.
 *
 * enter(): First start: build the ordered queue and acquire the first
 *          eligible issue (T-475 Layer 1). Re-entry (resume): keep the stored
 *          queue and lists, show the current issue or acquire the next.
 * report(): Settle the current issue as fixed, disposed, deferred or
 *           conflicted (T-486 U4), then acquire the next eligible one. All
 *           done or none eligible → advance to HANDOVER.
 */
export class IssueSweepStage implements WorkflowStage {
  readonly id = "ISSUE_SWEEP";

  skip(ctx: StageContext): boolean {
    const issueConfig = ctx.recipe.stages?.ISSUE_SWEEP as Record<string, unknown> | undefined;
    return !issueConfig?.enabled;
  }

  /**
   * T-475 Layer 1 (binding choke point) with T-486 U4's recorded steps (5e).
   * Acquisition always reads the queue it is given in order:
   *  1. under the sweep lock, pick the first id that exists, is open, not
   *     deleted, has no merge conflicts, is actionable and earmark eligible;
   *     the ids before it are not eligible and are dropped;
   *  2. record the intent: `remaining` still starts with the candidate, plus
   *     the `acquire` marker;
   *  3. under the sweep lock, write the acquisition image only if the issue
   *     still reads as it did in step 1; otherwise drop it and pick again;
   *  4. record the acquisition and clear the marker.
   * A lock error before the intent ends the scan; one after it keeps the
   * marker for recovery and is reported as pending.
   */
  private async acquire(ctx: StageContext, queue: readonly string[], firstStart: boolean): Promise<Acquisition> {
    const sessionId = ctx.state.sessionId;
    const { withProjectLockForIssueSweep, writeIssueUnlocked } = await import("../../core/project-loader.js");
    let candidates = [...queue];
    for (;;) {
      let pick = null as Candidate | null;
      try {
        await withProjectLockForIssueSweep(ctx.root, async ({ state: freshState }) => {
          for (let i = 0; i < candidates.length; i++) {
            const id = candidates[i]!;
            const freshIssue = freshState.issues.find(x => x.id === id);
            if (!freshIssue || freshIssue.status !== "open" || isDeleted(freshIssue)) continue;
            if (hasIssueConflicts(freshIssue)) continue;
            // T-486 U4 (ISS-1113): enter() filters on a read taken before this
            // lock, so a disposition set since then is caught here, on the
            // read the write acts on.
            if (isNonActionableDisposition(freshIssue.disposition)) continue;
            const decision = tryAcquireEarmark(freshIssue.earmark, sessionId, "worker");
            if (!decision.ok) continue; // earmarked to someone else -- skip, do not retry within this sweep
            const transitionId = `issue-sweep-acquire-${id}-${randomUUID()}`;
            const image = acquisitionImage(freshIssue, decision.write, sessionId, transitionId);
            const pre = entityFingerprint(freshIssue);
            const post = entityFingerprint(image);
            if (!pre || !post) continue;
            pick = { transitionId, next: { id, pre, post }, after: candidates.slice(i + 1), image };
            return;
          }
        });
      } catch (err) {
        return { kind: "error", message: failureText(err) };
      }
      if (!pick) return { kind: "exhausted" };
      const { transitionId, next, after, image } = pick;
      const stored = ctx.state.issueSweepState ? sweepLists(ctx.state.issueSweepState) : EMPTY_SWEEP;
      ctx.writeState({
        issueSweepState: { ...stored, current: null, remaining: [next.id, ...after] },
        pendingProjectMutation: { type: SWEEP_STEP, variant: "acquire", transitionId, next, after },
        ...(firstStart ? { pipelinePhase: "postComplete" as const } : {}),
      });
      let landed = false as boolean;
      try {
        await withProjectLockForIssueSweep(ctx.root, async ({ state: freshState }) => {
          const freshIssue = freshState.issues.find(x => x.id === next.id);
          if (!freshIssue || entityFingerprint(freshIssue) !== next.pre) return;
          await writeIssueUnlocked(image, ctx.root);
          landed = true;
        });
      } catch (err) {
        return { kind: "pending", message: failureText(err) };
      }
      const sweep = sweepLists(ctx.state.issueSweepState ?? EMPTY_SWEEP);
      if (!landed) {
        ctx.writeState({ issueSweepState: { ...sweep, remaining: after }, pendingProjectMutation: null });
        candidates = after;
        continue;
      }
      ctx.writeState({ issueSweepState: { ...sweep, current: next.id, remaining: after }, pendingProjectMutation: null });
      return { kind: "acquired", issue: image, count: after.length + 1 };
    }
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

  private enterInstruction(ctx: StageContext, issue: Issue, count: number): StageResult {
    return {
      instruction: [
        this.instructionFor(issue, count, ctx.root),
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

  private complete(ctx: StageContext): StageAdvance {
    const sweep = sweepLists(ctx.state.issueSweepState ?? EMPTY_SWEEP);
    ctx.appendEvent("issue_sweep_complete", { resolved: sweep.resolved.length });
    return { action: "goto", target: "HANDOVER" };
  }

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    if (isSweepStepMarker(ctx.state.pendingProjectMutation)) {
      return { action: "retry", instruction: sweepStepPendingText("a sweep step is still pending") };
    }
    // T-486 U4 (5j): a resume re-enters this stage. The stored queue and
    // lists are the sweep's record; rebuilding them would drop the current
    // issue (it is inprogress, not open) and every outcome recorded so far.
    const stored = ctx.state.issueSweepState;
    if (stored) return this.reenter(ctx, sweepLists(stored));

    let projectState;
    try {
      ({ state: projectState } = await ctx.loadProject());
    } catch {
      // Can't load issues -- skip sweep, proceed to HANDOVER
      return { action: "goto", target: "HANDOVER" };
    }
    // ISS-1113: an open issue whose disposition says nobody is going to act on
    // it is not sweepable work. This stage sets the issue it picks to
    // `inprogress` and then refuses to advance until that issue reaches
    // `resolved`, so handing it one of these does not merely rank badly -- the
    // stage cannot finish. Filtered at the source, before the queue is built,
    // so a non-actionable issue is never acquired and never earmarked.
    //
    // The predicate is the shared one, so this covers ISS-1154's three values
    // as well as the three ISS-1113 adds. That widening is deliberate: the
    // sweep had no disposition awareness at all, so `owner_gated` and
    // `escalate_only` issues were being handed out as work too.
    const allIssues = projectState.issues.filter(
      i => i.status === "open" && !isNonActionableDisposition(i.disposition),
    );

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

    const acquisition = await this.acquire(ctx, orderedIds, true);
    if (acquisition.kind === "pending") {
      return { action: "retry", instruction: sweepStepPendingText(acquisition.message) };
    }
    if (acquisition.kind !== "acquired") {
      // "exhausted" (every open issue is earmarked to someone else) and
      // "error" (lock/read/write failure) both fail closed the same way
      // here: no instruction is handed out under uncertainty, and this
      // stage's own established convention on a load failure is already
      // goto HANDOVER rather than retry-forever.
      return { action: "goto", target: "HANDOVER" };
    }

    return this.enterInstruction(ctx, acquisition.issue, ordered.length);
  }

  private async reenter(ctx: StageContext, sweep: SweepState): Promise<StageResult | StageAdvance> {
    if (sweep.current) {
      const current = sweep.current;
      let projectState;
      try {
        ({ state: projectState } = await ctx.loadProject());
      } catch (err) {
        return { action: "retry", instruction: `Failed to load project state: ${failureText(err)}. Check .story/ files, then report again.` };
      }
      const issue = projectState.issues.find(i => i.id === current);
      if (!issue) {
        return { action: "retry", instruction: `Issue ${current} could not be found in .story/issues/. Check for corruption, then report again.` };
      }
      return this.enterInstruction(ctx, issue, sweep.remaining.length + 1);
    }
    if (sweep.remaining.length > 0) {
      const acquisition = await this.acquire(ctx, sweep.remaining, false);
      if (acquisition.kind === "pending") {
        return { action: "retry", instruction: sweepStepPendingText(acquisition.message) };
      }
      if (acquisition.kind === "acquired") return this.enterInstruction(ctx, acquisition.issue, acquisition.count);
      ctx.writeState({ issueSweepState: { ...sweepLists(ctx.state.issueSweepState ?? sweep), remaining: [], current: null } });
    }
    return this.complete(ctx);
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    if (isSweepStepMarker(ctx.state.pendingProjectMutation)) {
      return { action: "retry", instruction: sweepStepPendingText("a sweep step is still pending") };
    }
    const sweep = ctx.state.issueSweepState;
    if (!sweep) {
      return { action: "advance" }; // No sweep state -- skip to HANDOVER
    }

    if (sweep.current) {
      const unsettled = await this.settleCurrent(ctx, sweep.current);
      if (unsettled) return unsettled;
    }
    return this.advanceQueue(ctx);
  }

  /**
   * T-486 U4 (5f): finish the current issue. Returns a retry when it cannot be
   * finished yet, or null once `current` is cleared (outcome recorded, or the
   * issue listed as conflicted).
   */
  private async settleCurrent(ctx: StageContext, current: string): Promise<StageAdvance | null> {
    // ISS-089: an unreadable project retries before any lock is taken.
    try {
      await ctx.loadProject();
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${failureText(err)}. Check .story/ files, then report again.` };
    }
    const sessionId = ctx.state.sessionId;
    const { withProjectLockForIssueSweep, writeIssueUnlocked } = await import("../../core/project-loader.js");
    let found = null as Issue | null;
    let exit = null as SweepExit | null;
    try {
      await withProjectLockForIssueSweep(ctx.root, async ({ state: projectState }) => {
        const issue = projectState.issues.find(i => i.id === current);
        if (!issue) return;
        found = issue;
        exit = await classifySweepExit(issue, projectState, ctx.root, sessionId);
      });
    } catch (err) {
      return { action: "retry", instruction: `Failed to load project state: ${failureText(err)}. Check .story/ files, then report again.` };
    }
    if (!found || !exit) {
      return {
        action: "retry",
        instruction: `Issue ${current} could not be found in .story/issues/. Check for corruption, then report again.`,
      };
    }
    const settled: SweepExit = exit;
    const issue: Issue = found;
    if (settled.kind === "retry") {
      return { action: "retry", instruction: settled.text, ...(settled.reminders && { reminders: settled.reminders }) };
    }
    if (settled.kind === "conflicted") {
      ctx.writeState({ issueSweepState: withConflicted(ctx.state.issueSweepState!, current, settled.reason), pendingProjectMutation: null });
      return null;
    }

    const outcome: SweepOutcome = settled.kind;
    const entry: SweepEntry = settled.entry;
    const image = releaseImage(issue, outcome, sessionId);
    const releasePre = entityFingerprint(issue);
    const releasePost = entityFingerprint(image);
    if (!releasePre || !releasePost) {
      return { action: "retry", instruction: `Issue ${current} could not be read as a whole record. Check .story/issues/${current}.json, then report again.` };
    }
    const transitionId = `issue-sweep-release-${current}-${randomUUID()}`;
    ctx.writeState({
      pendingProjectMutation: { type: SWEEP_STEP, variant: "release", transitionId, current, outcome, entry, releasePre, releasePost },
    });

    let verdict = "changed" as "landed" | "changed" | { conflicted: string };
    try {
      await withProjectLockForIssueSweep(ctx.root, async ({ state: projectState }) => {
        const fresh = projectState.issues.find(i => i.id === current);
        if (!fresh) return;
        const again = await classifySweepExit(fresh, projectState, ctx.root, sessionId);
        if (again.kind === "conflicted") { verdict = { conflicted: again.reason }; return; }
        const fingerprint = entityFingerprint(fresh);
        if (fingerprint === releasePost) { verdict = "landed"; return; }
        if (fingerprint === releasePre) {
          await writeIssueUnlocked(image, ctx.root);
          verdict = "landed";
        }
      });
    } catch (err) {
      return { action: "retry", instruction: sweepStepPendingText(failureText(err)) };
    }
    if (typeof verdict === "object") {
      ctx.writeState({ issueSweepState: withConflicted(ctx.state.issueSweepState!, current, verdict.conflicted), pendingProjectMutation: null });
      return null;
    }
    if (verdict === "changed") {
      ctx.writeState({ pendingProjectMutation: null });
      return { action: "retry", instruction: `Issue ${current} changed while it was being released; report again.` };
    }
    // The commit point: the outcome is recorded and the marker cleared together.
    ctx.writeState({ issueSweepState: withOutcome(ctx.state.issueSweepState!, outcome, entry), pendingProjectMutation: null });
    return null;
  }

  private async advanceQueue(ctx: StageContext): Promise<StageAdvance> {
    const sweep = sweepLists(ctx.state.issueSweepState ?? EMPTY_SWEEP);
    if (sweep.remaining.length === 0) return this.complete(ctx);
    const acquisition = await this.acquire(ctx, sweep.remaining, false);
    if (acquisition.kind === "pending") {
      return { action: "retry", instruction: sweepStepPendingText(acquisition.message) };
    }
    if (acquisition.kind !== "acquired") {
      // "exhausted" (nothing left, or everything left is earmarked to
      // someone else) and "error" both end the sweep here rather than
      // handing out an instruction under uncertainty.
      ctx.writeState({ issueSweepState: { ...sweepLists(ctx.state.issueSweepState ?? sweep), remaining: [], current: null } });
      return this.complete(ctx);
    }
    return {
      action: "retry",
      instruction: [
        this.instructionFor(acquisition.issue, acquisition.count, ctx.root),
        "",
        'When done, report with completedAction: "issue_fixed".',
      ].join("\n"),
      reminders: ["Update issue status to resolved in .story/issues/."],
    };
  }
}
