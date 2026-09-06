import { join } from "node:path";
import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput, FullSessionState } from "../session-types.js";
import {
  implementerProvenanceFromReport,
  resolveItemAttempt,
  type ItemAttempt,
  type ReviewSubject,
} from "../review-identity.js";
import { assessRisk, normalizeRiskLevel } from "../review-depth.js";
import { gitDiffStat, gitDiffNames } from "../git-inspector.js";
import { resolveOrReadFrozenGateStatus, renderUnresolvedHold } from "./gate-enforcement.js";
import { readPlanSnapshot } from "../../core/plan-snapshot.js";
import { readBoundedRegularFile, PLAN_ACK_MAX_BYTES } from "../../core/pin-utils.js";

/**
 * ISS-1050 full fix: the byte bound on plan text embedded directly into this
 * stage's instruction. Distinct from PLAN_ACK_MAX_BYTES (pin-utils.ts), which
 * bounds a defensive read against a hostile/corrupted file -- this bounds a
 * legitimate, self-authored plan against blowing out the prompt itself.
 * Measured with Buffer.byteLength, not .length -- plan.md is UTF-8 and a
 * multi-byte character would otherwise undercount against the real payload
 * an LLM context actually pays for.
 */
export const IMPLEMENT_PROMPT_PLAN_MAX_BYTES = 200_000;

function renderSnapshotUnreadableHold(filename: string, reason: string): string {
  return [
    "# Implement -- blocked",
    "",
    `This ticket's approved-plan snapshot (\`${filename}\`) could not be read: ${reason}.`,
    "Do NOT treat plan.md as approved and do NOT implement from it. Escalate to your operator.",
  ].join("\n");
}

function renderMissingSnapshotHold(): string {
  return [
    "# Implement -- blocked",
    "",
    "This ticket is duet-mode gated, but no approved-plan snapshot is on record for it.",
    "Do NOT treat plan.md as approved and do NOT implement from it. Escalate to your operator -- PLAN_REVIEW may not have landed normally, or this session predates the snapshot mechanism.",
  ].join("\n");
}

function renderOversizeSnapshotBlock(byteLength: number): string {
  return [
    "# Implement -- blocked",
    "",
    `The approved plan is too large to embed directly (${byteLength.toLocaleString()} bytes, over the ${IMPLEMENT_PROMPT_PLAN_MAX_BYTES.toLocaleString()}-byte embed bound).`,
    "Reduce the plan's size and re-run PLAN_REVIEW; do not implement from a truncated read.",
  ].join("\n");
}

type PlanSource =
  | { kind: "embed"; text: string }
  | { kind: "pointer" }
  | { kind: "block"; instruction: string };

/**
 * ISS-1050 full fix: resolve what IMPLEMENT reads from, closing the
 * plan-ack post-approval edit window structurally -- a gated landing embeds
 * the exact content PLAN_REVIEW snapshotted, never a fresh (and potentially
 * edited) read of plan.md.
 *
 * D1 (never fail open): a snapshot ref that is present but unreadable blocks
 * regardless of current gate status (R2-FIX 2 -- no gate-status branching on
 * this path); a gated item with NO ref at all also blocks, since a gated
 * landing must always have produced one. Only when the ref is entirely
 * absent AND the item is ungated does this fall back to reading plan.md
 * directly -- the pre-ISS-1050 behavior, for the one case this mechanism was
 * never protecting in the first place.
 */
async function resolvePlanSource(ctx: StageContext, absolutePlanPath: string): Promise<PlanSource> {
  const gateStatus = await resolveOrReadFrozenGateStatus(ctx);
  if (gateStatus.status === "unresolved") {
    return { kind: "block", instruction: renderUnresolvedHold(gateStatus.reason) };
  }

  const ref = ctx.state.approvedPlanSnapshot;
  if (ref) {
    const read = readPlanSnapshot(ctx.dir, ref);
    if (read.status !== "ok") {
      return { kind: "block", instruction: renderSnapshotUnreadableHold(ref.filename, read.reason) };
    }
    // R-A4-1: the size decision is made HERE, inside the snapshot-backed arm,
    // while provenance is still known -- merging into a bare string before
    // checking size would let an oversize snapshot-backed plan fall through
    // to the pointer instruction below, which names the MUTABLE plan.md and
    // reopens the exact post-advance edit window this fix exists to close.
    const byteLength = Buffer.byteLength(read.text, "utf8");
    if (byteLength > IMPLEMENT_PROMPT_PLAN_MAX_BYTES) {
      return { kind: "block", instruction: renderOversizeSnapshotBlock(byteLength) };
    }
    return { kind: "embed", text: read.text };
  }

  if (gateStatus.status === "gated") {
    return { kind: "block", instruction: renderMissingSnapshotHold() };
  }

  const fallback = readBoundedRegularFile(absolutePlanPath, PLAN_ACK_MAX_BYTES);
  if (fallback.status !== "ok") {
    return { kind: "pointer" };
  }
  const fallbackText = fallback.bytes.toString("utf-8");
  // Ungated and never snapshotted -- this mechanism never protected this
  // path, so an oversize plan here degrades to the pointer instruction (the
  // pre-ISS-1050 behavior) rather than blocking.
  if (Buffer.byteLength(fallbackText, "utf8") > IMPLEMENT_PROMPT_PLAN_MAX_BYTES) {
    return { kind: "pointer" };
  }
  return { kind: "embed", text: fallbackText };
}

/**
 * IMPLEMENT stage -- Claude writes code to implement the approved plan.
 *
 * enter(): Instruction to implement the plan.
 * report(): Compute realized risk from actual diff, advance to next stage
 *           (CODE_REVIEW or TEST if enabled).
 */
export class ImplementStage implements WorkflowStage {
  readonly id = "IMPLEMENT";

  async enter(ctx: StageContext): Promise<StageResult> {
    const ticket = ctx.state.ticket;
    const planPath = `.story/sessions/${ctx.state.sessionId}/plan.md`;
    // T-474: the pen's ratify-with-deltas text from the plan-ack gate that
    // just cleared, rendered once here and never again -- `approvedPlanAckDeltas`
    // is not re-read by any later stage.
    const deltas = ctx.state.approvedPlanAckDeltas;

    const source = await resolvePlanSource(ctx, join(ctx.dir, "plan.md"));
    if (source.kind === "block") {
      return { instruction: source.instruction, transitionedFrom: ctx.state.previousState ?? undefined };
    }

    // R-A4-1: the oversize decision is made inside resolvePlanSource, where
    // provenance (snapshot-backed vs. never-protected) is still known -- by
    // the time `source` reaches here, "embed" always means "safe to embed."
    const planSection = source.kind === "pointer"
      ? [`Implement the approved plan at \`${planPath}\`.`]
      : ["## Approved plan", "", "```markdown", source.text, "```"];

    return {
      instruction: [
        `# Implement -- ${ticket?.id ?? "unknown"}: ${ticket?.title ?? ""}`,
        "",
        ...planSection,
        "",
        ...(deltas ? ["## Pen-approved plan-ack deltas (binding)", "", deltas, ""] : []),
        "When done, call `storybloq_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "implementation_done" } }`,
        '```',
      ].join("\n"),
      reminders: [
        "Follow the plan exactly. Do NOT deviate without re-planning.",
        "Do NOT ask the user for confirmation.",
        "If you discover pre-existing bugs, failing tests not caused by your changes, or other out-of-scope problems, file them as issues using storybloq_issue_create. Do not fix them inline.",
        "Track which files you create or modify. Only these files should be staged at commit time.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, _report: GuideReportInput): Promise<StageAdvance> {
    // ISS-069: No-op escape hatch -- ticket needs no code changes
    if (_report.completedAction === "no_implementation_needed") {
      ctx.appendEvent("implement", { result: "skipped", reason: "no_changes_needed" });
      return { action: "goto", target: "COMPLETE" };
    }

    // Risk recomputation from actual diff
    const storedRisk = ctx.state.ticket?.risk;
    let realizedRisk = storedRisk == null ? "low" : normalizeRiskLevel(storedRisk, "high");
    const mergeBase = ctx.state.git.mergeBase;
    if (mergeBase) {
      const diffResult = await gitDiffStat(ctx.root, mergeBase);
      const namesResult = await gitDiffNames(ctx.root, mergeBase);
      if (diffResult.ok) {
        realizedRisk = assessRisk(diffResult.data, namesResult.ok ? namesResult.data : undefined);
      }
    }

    // T-488 D7: record what implemented, BOUND to the attempt it implemented
    // for.
    //
    // The binding is the whole mechanism. A session runs up to
    // `maxTicketsPerSession` items, and item B's PLAN_REVIEW runs before B's
    // first IMPLEMENT -- so a session-level field would still hold item A's
    // model at that moment and a snapshot would attach A's provenance to B's
    // round. `implementerForRound` refuses any provenance whose attempt does
    // not match the round's, which makes that misattribution impossible by
    // construction rather than by ordering luck.
    //
    // `resolveItemAttempt` is called here rather than assumed: a session can
    // resume directly into IMPLEMENT without passing acquisition, so this may
    // be where the attempt is first established.
    const subject: ReviewSubject | null = ctx.state.ticket
      ? { workItemId: ctx.state.ticket.id, kind: "ticket" }
      : ctx.state.currentIssue
        ? { workItemId: ctx.state.currentIssue.id, kind: "issue" }
        : null;
    const { attempt } = resolveItemAttempt(
      (ctx.state.itemAttempt ?? null) as ItemAttempt | null,
      subject,
      new Date().toISOString(),
    );
    const implementer = attempt
      ? { itemAttemptId: attempt.id, ...implementerProvenanceFromReport(_report) }
      // No attempt means no subject to bind to, and an unbound implementer is
      // exactly the stale-attribution shape this replaced. Null, not a guess.
      : null;

    // Stage field updates (persisted atomically with state transition by processAdvance)
    ctx.updateDraft({
      ticket: ctx.state.ticket ? { ...ctx.state.ticket, realizedRisk } : ctx.state.ticket,
      ...(attempt ? { itemAttempt: attempt } : {}),
      implementer,
    } as Partial<FullSessionState>);

    // T-139: Return plain advance -- let the next stage's enter() provide its own instruction.
    // Previously hardcoded CODE_REVIEW instruction here, but this breaks when
    // TEST or WRITE_TESTS is inserted between IMPLEMENT and CODE_REVIEW.
    return { action: "advance" };
  }
}
