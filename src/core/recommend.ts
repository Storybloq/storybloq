/**
 * Context-aware work recommendation engine.
 *
 * Unlike nextTicket (queue-based, phase order), recommend considers the full
 * project state and suggests a ranked list mixing tickets and issues, each
 * with a human-readable rationale.
 */
import type { ProjectState } from "./project-state.js";
import { isActiveLifecycle } from "./project-state.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { IssueSeverity } from "../models/types.js";
import type { FederationState, FederationNodeEntry } from "../federation/state.js";
import type { TrajectoryDisposition, IdOccurrence, TrajectoryHandoverInput } from "./markdown-sections.js";
import { parseHandoverMarkdown, buildTrajectory, firstDispositionPerHandover } from "./markdown-sections.js";
import {
  nextTicket,
  currentPhase,
  ticketsUnblockedBy,
  umbrellaProgress,
  descendantLeaves,
  isCrossNodeBlocked,
} from "./queries.js";
import { validateProject } from "./validation.js";
import { notHiddenByEarmark } from "./earmarks.js";
import { isNonActionableDisposition } from "./issue-disposition.js";
import { applyClaimAnnotations } from "./claims.js";
import { checkpointState, hasOwnerCheckpoint, pendingCheckpointBlockers, reassessCheckpoints } from "./owner-checkpoint.js";
import { displayIdOf } from "./resolver.js";
import type { Claim } from "../models/types.js";

// --- Types ---

export type RecommendCategory =
  | "validation_errors"
  | "critical_issue"
  | "fed_red_blocker"
  | "inprogress_ticket"
  | "fed_unreachable"
  | "high_impact_unblock"
  | "fed_bottleneck"
  | "near_complete_umbrella"
  | "fed_high_issues"
  | "phase_momentum"
  | "fed_stale_node"
  | "quick_win"
  | "open_issue"
  | "handover_context"
  | "debt_trend"
  | "checkpoint_reassess";

export interface RecommendOptions {
  /** Successfully-read handovers, last 10 intended, newest first. Replaces `latestHandoverContent`. */
  readonly recentHandovers?: readonly { filename: string; content: string }[];
  /** `0` = window fully read; positive = that many intended files failed to read; `null` = the directory itself could not be listed. */
  readonly unreadableHandoverCount?: number | null;
  readonly previousOpenIssueCount?: number;
  readonly federationState?: FederationState;
  readonly crossNodeRefStatuses?: Record<string, string>;
  readonly currentUser?: string;
}

export type RecommendItemKind = "ticket" | "issue" | "action";

export interface Recommendation {
  readonly id: string;
  readonly displayId?: string;
  readonly kind: RecommendItemKind;
  readonly title: string;
  readonly category: RecommendCategory;
  readonly reason: string;
  readonly score: number;
  /** Present when the item is claimed (own or foreign); foreign claims are also downranked. */
  readonly claim?: Claim;
  /** Ticket/issue kind only -- computed by computeActionability (ISS-1154). */
  readonly actionability?: Actionability;
  /** Tickets only. */
  readonly phase?: string | null;
  /** Issues only. */
  readonly severity?: IssueSeverity;
}

export interface RecommendResult {
  readonly recommendations: readonly Recommendation[];
  readonly totalCandidates: number;
  /** Full excluded total, including fresh-add candidates rejected before insertion. */
  readonly excludedCount: number;
  /** Top `effectiveCount` by pre-exclusion score, descending. */
  readonly excluded: readonly ExcludedRecommendation[];
  /** `0` = window fully read; positive = that many handovers failed; `null` = directory listing itself failed. */
  readonly unreadableHandoverCount: number | null;
}

// --- ISS-1154: actionability classification ---

export type ActionabilityStatus =
  | "actionable"
  | "blocked"
  | "duplicate"
  | "escalate_only"
  | "owner_gated"
  // ISS-1113: the structured tier returns the disposition itself, so these
  // three joined the union with the enum. Additive at every consumer: nothing
  // switches exhaustively on this type, it is interpolated as a string.
  | "pre_existing"
  | "accepted_out_of_scope"
  | "forced_landing"
  | "complete";

export interface Actionability {
  readonly status: ActionabilityStatus;
  readonly reason: string;
  readonly source: "ledger" | "structured" | "handover" | "heuristic";
}

export interface ExcludedRecommendation {
  readonly id: string;
  readonly displayId?: string;
  readonly kind: "ticket" | "issue";
  readonly title: string;
  readonly actionability: Actionability;
}

export interface ActionabilityContext {
  readonly state: ProjectState;
  readonly crossNodeRefStatuses?: Record<string, string>;
  /** Newest-handover disposition per canonical id, over the successfully-read subset (tier 3). */
  readonly latestDispositionById: ReadonlyMap<string, TrajectoryDisposition>;
}

// Reference shape only ("duplicate of X" / "superseded by X"), not a bare
// occurrence of the word -- a bare match demotes real work whose title or
// resolution merely discusses duplicates (see ISS-1149, ISS-1154 itself).
const DUPLICATE_TEXT_RE = /\bdup(?:licate)?\s+of\b|\bsuperseded\s+by\b/i;

/**
 * Four-tier actionability classifier: ledger > structured > handover >
 * heuristic. Tier 1 (ledger) is a universal precondition for both kinds,
 * checked first, so every caller (generators, the fresh-add branch, and the
 * targeted single-id MCP lookup) gets one consistent answer. Tier 2
 * (structured) is issues-only and always wins outright when present. Tier 3
 * (handover) decides absent tier 2. Tier 4 (heuristic, demote-only) fires
 * only when tiers 2-3 produced no exclusion verdict at all.
 */
export function computeActionability(
  kind: "ticket" | "issue",
  item: Ticket | Issue,
  ctx: ActionabilityContext,
): Actionability {
  // Tier 1: ledger.
  if (!isActiveLifecycle(item)) {
    return { status: "complete", reason: "archived or deleted -- not open backlog", source: "ledger" };
  }
  if (!notHiddenByEarmark(item)) {
    return { status: "blocked", reason: "claimed/hidden by an active earmark", source: "ledger" };
  }
  if (kind === "ticket") {
    const ticket = item as Ticket;
    // T-537: an owner checkpoint is the owner's to answer, never agent work;
    // its status alone does not say whether it released.
    if (hasOwnerCheckpoint(ticket)) {
      const cpState = checkpointState(ticket);
      if (cpState === "approved" || cpState === "retired") {
        return { status: "complete", reason: `owner checkpoint ${cpState}`, source: "ledger" };
      }
      return {
        status: "owner_gated",
        reason: cpState === "unrecognized"
          ? "owner checkpoint this CLI cannot read; it blocks until the file is fixed by hand"
          : "owner checkpoint awaiting the owner's answer",
        source: "ledger",
      };
    }
    // Umbrella stored status is ignored project-wide (see phaseStatus/umbrellaStatus);
    // an umbrella's completion is derived from its descendant leaves instead.
    const ticketStatus = ctx.state.isUmbrella(ticket)
      ? ctx.state.umbrellaStatus(ticket.id)
      : ticket.status;
    if (ticketStatus === "complete") {
      return { status: "complete", reason: "ticket is complete", source: "ledger" };
    }
    const waitingOn = pendingCheckpointBlockers(ctx.state, ticket);
    if (waitingOn.length > 0) {
      const labels = waitingOn.map((c) => {
        const t = ctx.state.ticketByID(c);
        return t ? displayIdOf(t) : c;
      });
      return { status: "owner_gated", reason: `waits on owner checkpoint ${labels.join(", ")}`, source: "ledger" };
    }
    if (ctx.state.isBlocked(ticket) || isCrossNodeBlocked(ticket, ctx.crossNodeRefStatuses)) {
      return { status: "blocked", reason: "blocked by an incomplete dependency", source: "ledger" };
    }
  } else {
    const issue = item as Issue;
    if (issue.status === "resolved") {
      return { status: "complete", reason: "issue is resolved", source: "ledger" };
    }
  }

  // Tier 2: structured (issues only). The list is shared rather than spelled
  // out here (ISS-1113): the issue sweep and COMPLETE ask the same question,
  // and a value wired into one consumer and not the others is exactly the gap
  // that let ISSUE_SWEEP keep handing out owner-gated issues as work.
  if (kind === "issue") {
    const disposition = (item as Issue).disposition;
    if (isNonActionableDisposition(disposition)) {
      return {
        status: disposition,
        reason: `structured disposition: ${disposition}`,
        source: "structured",
      };
    }
  }

  // Tier 3: handover (readable subset only; caller withholds this map's
  // entries for anything the window couldn't read).
  const latestDisposition = ctx.latestDispositionById.get(item.id);
  if (latestDisposition === "blocked") {
    return { status: "blocked", reason: "newest handover marks this blocked", source: "handover" };
  }
  if (latestDisposition === "owner-gated") {
    return { status: "owner_gated", reason: "newest handover marks this owner-gated", source: "handover" };
  }

  // Tier 4: heuristic (demote-only, reached only with no verdict yet).
  const resolution = kind === "issue" ? (item as Issue).resolution : null;
  if (DUPLICATE_TEXT_RE.test(item.title) || (resolution && DUPLICATE_TEXT_RE.test(resolution))) {
    return { status: "duplicate", reason: "title/resolution suggests a duplicate", source: "heuristic" };
  }
  if (kind === "issue") {
    for (const ref of (item as Issue).relatedTickets) {
      const resolved = ctx.state.resolveTicketRef(ref);
      if (resolved.kind !== "found") continue;
      const t = resolved.item;
      if (ctx.state.umbrellaIDs.has(t.id) && ctx.state.umbrellaStatus(t.id) === "inprogress") {
        return {
          status: "duplicate",
          reason: `related ticket ${t.id} is itself an in-progress umbrella`,
          source: "heuristic",
        };
      }
      // ISS-1225: a related ticket that is itself finished is evidence the
      // issue is NOT covered by in-flight work, whatever its umbrella is doing;
      // the parent clause applies only while the related ticket is still open.
      if (t.status === "complete") continue;
      const parent = ctx.state.resolvedParent(t);
      if (parent && ctx.state.umbrellaIDs.has(parent.id) && ctx.state.umbrellaStatus(parent.id) === "inprogress") {
        return {
          status: "duplicate",
          reason: `related ticket ${t.id}'s parent umbrella ${parent.id} is in progress`,
          source: "heuristic",
        };
      }
    }
  }

  return { status: "actionable", reason: "open, no blocking signal", source: "ledger" };
}

// --- Constants ---

const SEVERITY_RANK: Record<IssueSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Penalty per phase ahead of current phase (for ticket recommendations). */
const PHASE_DISTANCE_PENALTY = 100;
/** Maximum phase-distance penalty (caps at 4+ phases ahead). */
const MAX_PHASE_PENALTY = 400;

/**
 * Category priority for deterministic tiebreaking (lower = higher priority).
 * Band spacing is 100 and index cap is 99, so scores never cross category
 * boundaries (e.g., band 900 ranges from 801-900, band 800 from 701-800).
 */
const CATEGORY_PRIORITY: Record<RecommendCategory, number> = {
  validation_errors: 1,
  critical_issue: 2,
  fed_red_blocker: 3,
  inprogress_ticket: 4,
  fed_unreachable: 5,
  high_impact_unblock: 6,
  handover_context: 7,
  fed_bottleneck: 8,
  near_complete_umbrella: 9,
  fed_high_issues: 10,
  phase_momentum: 11,
  fed_stale_node: 12,
  debt_trend: 13,
  quick_win: 14,
  open_issue: 15,
  checkpoint_reassess: 16,
};

/**
 * ISS-1154: partitions a sorted candidate list into actionable vs excluded,
 * so recommend() can slice each pool independently and never let an
 * excluded item occupy a recommendation slot. Undefined actionability
 * (unreachable with today's generators, but not provably impossible for a
 * future one) is treated as actionable -- never hidden silently -- which is
 * also why excludedPool's element type carries a guaranteed `actionability`
 * rather than the optional one on `Recommendation`: nothing downstream
 * (formatRecommendations included) can dereference an undefined verdict.
 */
export function partitionByActionability(
  recs: readonly Recommendation[],
): {
  actionablePool: Recommendation[];
  excludedPool: (Recommendation & { actionability: Actionability })[];
} {
  const actionablePool: Recommendation[] = [];
  const excludedPool: (Recommendation & { actionability: Actionability })[] = [];
  for (const rec of recs) {
    if (rec.kind === "action" || rec.actionability === undefined || rec.actionability.status === "actionable") {
      actionablePool.push(rec);
    } else {
      excludedPool.push(rec as Recommendation & { actionability: Actionability });
    }
  }
  return { actionablePool, excludedPool };
}

// --- Public API ---

export function recommend(
  state: ProjectState,
  count: number,
  options?: RecommendOptions,
): RecommendResult {
  const effectiveCount = Math.max(1, Math.min(10, count));
  const dedup = new Map<string, Recommendation>();
  const phaseIndex = buildPhaseIndex(state);

  const crossNodeStatuses = options?.crossNodeRefStatuses;
  const generators = [
    () => generateValidationSuggestions(state),
    () => generateCheckpointReassessments(state),
    () => generateCriticalIssues(state),
    () => generateInProgressTickets(state, phaseIndex, crossNodeStatuses),
    () => generateHighImpactUnblocks(state, crossNodeStatuses),
    () => generateNearCompleteUmbrellas(state, phaseIndex, crossNodeStatuses),
    () => generatePhaseMomentum(state, crossNodeStatuses),
    () => generateQuickWins(state, phaseIndex, crossNodeStatuses),
    () => generateOpenIssues(state),
    () => generateDebtTrend(state, options),
  ];

  if (options?.federationState && state.config.type === "orchestrator") {
    const facts = buildFederationFacts(options.federationState);
    generators.push(
      () => generateFedUnreachable(facts),
      () => generateFedRedBlockers(facts),
      () => generateFedBottleneck(facts),
      () => generateFedHighIssues(facts),
      () => generateFedStaleNodes(facts),
    );
  }

  for (const gen of generators) {
    for (const rec of gen()) {
      const existing = dedup.get(rec.id);
      if (!existing || rec.score > existing.score) {
        dedup.set(rec.id, rec);
      }
    }
  }

  // Phase-distance penalty: tickets in future phases are penalized
  const curPhase = currentPhase(state);
  const curPhaseIdx = curPhase ? phaseIndex.get(curPhase.id) ?? 0 : 0;
  for (const [id, rec] of dedup) {
    if (rec.kind !== "ticket") continue;
    const ticket = state.ticketByID(id);
    if (!ticket || ticket.phase == null) continue;
    const ticketPhaseIdx = phaseIndex.get(ticket.phase);
    if (ticketPhaseIdx === undefined) continue;
    const phasesAhead = ticketPhaseIdx - curPhaseIdx;
    if (phasesAhead > 0) {
      const penalty = Math.min(phasesAhead * PHASE_DISTANCE_PENALTY, MAX_PHASE_PENALTY);
      dedup.set(id, {
        ...rec,
        score: rec.score - penalty,
        reason: rec.reason + " (future phase)",
      });
    }
  }

  // ISS-1154: parse + canonicalize the readable handover window, then
  // classify every ticket/issue rec currently in dedup (four-tier
  // computeActionability), then run the rewritten handover-context
  // promotion pass -- in that order, per the plan.
  const { latestDispositionById, continuationMentionCount } = buildHandoverClassificationInputs(
    state,
    options?.recentHandovers ?? [],
  );

  for (const [id, rec] of dedup) {
    if (rec.kind === "action") continue;
    const item = rec.kind === "ticket" ? state.ticketByID(id) : state.issueByID(id);
    if (!item) continue;
    const actionability = computeActionability(rec.kind, item, {
      state,
      crossNodeRefStatuses: crossNodeStatuses,
      latestDispositionById,
    });
    dedup.set(id, {
      ...rec,
      actionability,
      phase: rec.kind === "ticket" ? (item as Ticket).phase : rec.phase,
      severity: rec.kind === "issue" ? (item as Issue).severity : rec.severity,
    });
  }

  const windowIncomplete = isHandoverWindowIncomplete(options?.unreadableHandoverCount);
  applyHandoverBoost(state, dedup, continuationMentionCount, {
    crossNodeRefStatuses: crossNodeStatuses,
    latestDispositionById,
    windowIncomplete,
  });

  const claims = new Map<string, Claim>();
  for (const t of state.tickets) {
    const claim = (t as Record<string, unknown>).claim as Claim | undefined;
    if (claim) claims.set(t.id, claim);
  }
  // Annotate + downrank claimed items BEFORE sorting so the claim penalty
  // affects ordering. Claimed-by-others stay visible but sink below unclaimed
  // work (ISS-681).
  const annotated = applyClaimAnnotations([...dedup.values()], claims, options?.currentUser ?? null);

  const all = annotated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const catDiff =
      CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    if (catDiff !== 0) return catDiff;
    return a.id.localeCompare(b.id);
  });

  // ISS-1154: partition BEFORE slicing, so an excluded item can never
  // occupy a top-N slot regardless of scarcity (2e).
  const { actionablePool, excludedPool } = partitionByActionability(all);

  const excluded: ExcludedRecommendation[] = excludedPool
    .slice(0, effectiveCount)
    .map((rec) => ({
      id: rec.id,
      displayId: rec.displayId,
      kind: rec.kind as "ticket" | "issue",
      title: rec.title,
      actionability: rec.actionability,
    }));

  return {
    recommendations: actionablePool.slice(0, effectiveCount),
    totalCandidates: all.length,
    excludedCount: excludedPool.length,
    excluded,
    unreadableHandoverCount:
      options?.unreadableHandoverCount === undefined ? 0 : options.unreadableHandoverCount,
  };
}

/**
 * Exact incompleteness predicate (ISS-1154): JS `null`/`0`/`undefined` are
 * ALL falsy, so "truthy" is the wrong word for this check. `undefined`
 * (option omitted, e.g. an existing caller not yet passing it) is treated as
 * complete, for backward compatibility. Explicit `0` is complete. A positive
 * number, or explicit `null`, is incomplete. Used everywhere this file (and
 * its CLI/MCP callers) check the flag -- one predicate, never re-derived.
 */
export function isHandoverWindowIncomplete(unreadableHandoverCount: number | null | undefined): boolean {
  return unreadableHandoverCount !== undefined && unreadableHandoverCount !== 0;
}

export interface HandoverClassificationInputs {
  readonly latestDispositionById: ReadonlyMap<string, TrajectoryDisposition>;
  readonly continuationMentionCount: ReadonlyMap<string, number>;
}

/**
 * Resolves a raw occurrence id token to its current canonical ticket/issue
 * id (folding a historical display-id alias into the entity's current
 * mentions); a `missing`/`ambiguous` token is dropped.
 */
function canonicalizeOccurrences(state: ProjectState, occurrences: readonly IdOccurrence[]): IdOccurrence[] {
  const canonical: IdOccurrence[] = [];
  for (const occurrence of occurrences) {
    const asTicket = state.resolveTicketRef(occurrence.id);
    if (asTicket.kind === "found") {
      canonical.push({ id: asTicket.item.id, disposition: occurrence.disposition });
      continue;
    }
    const asIssue = state.resolveIssueRef(occurrence.id);
    if (asIssue.kind === "found") {
      canonical.push({ id: asIssue.item.id, disposition: occurrence.disposition });
    }
  }
  return canonical;
}

/**
 * Exported so the MCP targeted single-id lookup (`withActionability` on
 * `storybloq_issue_get`/`storybloq_ticket_get`, ISS-1154 2h) can build the
 * same tier-3 input `recommend()` itself builds, from the same shared
 * `loadClassificationContext` handover read.
 */
export function buildHandoverClassificationInputs(
  state: ProjectState,
  recentHandovers: readonly { filename: string; content: string }[],
): HandoverClassificationInputs {
  const trajectoryInputs: TrajectoryHandoverInput[] = [];
  const continuationMentionCount = new Map<string, number>();

  for (const handover of recentHandovers) {
    const parsed = parseHandoverMarkdown(handover.content, handover.filename);
    const canonical = canonicalizeOccurrences(state, parsed.orderedIdOccurrences);
    trajectoryInputs.push({ filename: handover.filename, orderedIdOccurrences: canonical });

    const firstThisHandover = firstDispositionPerHandover(canonical);
    for (const [id, disposition] of firstThisHandover) {
      if (disposition === "continuation" || disposition === "carried") {
        continuationMentionCount.set(id, (continuationMentionCount.get(id) ?? 0) + 1);
      }
    }
  }

  const trajectory = buildTrajectory(trajectoryInputs);
  const latestDispositionById = new Map<string, TrajectoryDisposition>();
  for (const entry of trajectory) {
    latestDispositionById.set(entry.id, entry.latestDisposition);
  }

  return { latestDispositionById, continuationMentionCount };
}

// --- Generators (private) ---

function generateValidationSuggestions(
  state: ProjectState,
): Recommendation[] {
  const result = validateProject(state);
  if (result.errorCount === 0) return [];
  return [
    {
      id: "validate",
      kind: "action",
      title: "Run storybloq validate",
      category: "validation_errors",
      reason: `${result.errorCount} validation error${result.errorCount === 1 ? "" : "s"} -- fix before other work`,
      score: 1000,
    },
  ];
}

/**
 * T-537: a completed ticket whose owner checkpoint changed, reopened or
 * stopped releasing since the completion (a reassessment flag). The flag
 * clears only by re-completing the ticket, which records fresh evidence.
 *
 * Scores occupy their own band, 801-850 (850 for the first row, one less per
 * row, floored at 801): above ticket work (in-progress tickets start at 800),
 * since shipped work may no longer match what the owner decided, and inside
 * the lower half of the critical-issue range (801-900), so the first critical
 * issues still lead.
 */
function generateCheckpointReassessments(state: ProjectState): Recommendation[] {
  const out: Recommendation[] = [];
  let index = 0;
  for (const ticket of state.leafTickets) {
    if (ticket.status !== "complete" || !isActiveLifecycle(ticket)) continue;
    const flagged = reassessCheckpoints(state, ticket).filter((v) => v.flag);
    if (flagged.length === 0) continue;
    const labels = flagged.map((v) => {
      const t = state.ticketByID(v.checkpoint);
      return t ? displayIdOf(t) : v.checkpoint;
    });
    out.push({
      id: `checkpoint-reassess:${ticket.id}`,
      displayId: ticket.displayId ?? undefined,
      kind: "action",
      title: `Re-verify ${displayIdOf(ticket)} against owner checkpoint${labels.length === 1 ? "" : "s"} ${labels.join(", ")}`,
      category: "checkpoint_reassess",
      reason: "completed against an owner answer that has since changed; re-verify, then complete it again to record the current answer",
      score: 850 - Math.min(index++, 49),
    });
  }
  return out;
}

function generateCriticalIssues(state: ProjectState): Recommendation[] {
  const issues = state.activeIssues
    .filter(
      (i) =>
        i.status !== "resolved" &&
        (i.severity === "critical" || i.severity === "high") &&
        notHiddenByEarmark(i),
    )
    .sort((a, b) => {
      const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sevDiff !== 0) return sevDiff;
      return b.discoveredDate.localeCompare(a.discoveredDate); // newer first
    });

  return issues.map((issue, index) => ({
    id: issue.id,
    displayId: issue.displayId ?? undefined,
    kind: "issue" as const,
    title: issue.title,
    category: "critical_issue" as const,
    reason: issue.status === "inprogress"
      ? `${capitalize(issue.severity)} severity issue -- in-progress, ensure it's being addressed`
      : `${capitalize(issue.severity)} severity issue -- address before new features`,
    score: 900 - Math.min(index, 99),
  }));
}

function generateInProgressTickets(
  state: ProjectState,
  phaseIndex: Map<string, number>,
  crossNodeStatuses?: Record<string, string>,
): Recommendation[] {
  const tickets = state.leafTickets.filter(
    (t) => t.status === "inprogress" && !isCrossNodeBlocked(t, crossNodeStatuses),
  );
  const sorted = sortByPhaseAndOrder(tickets, phaseIndex);

  return sorted.map((ticket, index) => ({
    id: ticket.id,
    displayId: ticket.displayId ?? undefined,
    kind: "ticket" as const,
    title: ticket.title,
    category: "inprogress_ticket" as const,
    reason: "In-progress -- finish what's started",
    score: 800 - Math.min(index, 99),
  }));
}

function generateHighImpactUnblocks(state: ProjectState, crossNodeStatuses?: Record<string, string>): Recommendation[] {
  const candidates: { ticket: Ticket; unblockCount: number }[] = [];

  for (const ticket of state.leafTickets) {
    if (ticket.status === "complete") continue;
    if (state.isBlocked(ticket)) continue;
    if (isCrossNodeBlocked(ticket, crossNodeStatuses)) continue;
    if (!notHiddenByEarmark(ticket)) continue;

    const wouldUnblock = ticketsUnblockedBy(ticket.id, state);
    if (wouldUnblock.length >= 2) {
      candidates.push({ ticket, unblockCount: wouldUnblock.length });
    }
  }

  candidates.sort((a, b) => b.unblockCount - a.unblockCount);

  return candidates.map(({ ticket, unblockCount }, index) => ({
    id: ticket.id,
    displayId: ticket.displayId ?? undefined,
    kind: "ticket" as const,
    title: ticket.title,
    category: "high_impact_unblock" as const,
    reason: `Completing this unblocks ${unblockCount} other ticket${unblockCount === 1 ? "" : "s"}`,
    score: 700 - Math.min(index, 99),
  }));
}

function generateNearCompleteUmbrellas(
  state: ProjectState,
  phaseIndex: Map<string, number>,
  crossNodeStatuses?: Record<string, string>,
): Recommendation[] {
  const candidates: {
    umbrellaId: string;
    umbrellaTitle: string;
    firstIncompleteLeaf: Ticket;
    complete: number;
    total: number;
    ratio: number;
  }[] = [];

  for (const umbrellaId of state.umbrellaIDs) {
    const progress = umbrellaProgress(umbrellaId, state);
    if (!progress) continue; // type guard (logically impossible)
    if (progress.total < 2) continue;
    if (progress.status === "complete") continue;

    const ratio = progress.complete / progress.total;
    if (ratio < 0.8) continue;

    const leaves = descendantLeaves(umbrellaId, state);
    const incomplete = leaves.filter(
      (t) =>
        t.status !== "complete" &&
        !state.isBlocked(t) &&
        !isCrossNodeBlocked(t, crossNodeStatuses) &&
        notHiddenByEarmark(t),
    );
    const sorted = sortByPhaseAndOrder(incomplete, phaseIndex);
    if (sorted.length === 0) continue;

    const umbrella = state.ticketByID(umbrellaId);
    candidates.push({
      umbrellaId,
      umbrellaTitle: umbrella?.title ?? umbrellaId,
      firstIncompleteLeaf: sorted[0]!,
      complete: progress.complete,
      total: progress.total,
      ratio,
    });
  }

  candidates.sort((a, b) => b.ratio - a.ratio);

  return candidates.map((c, index) => ({
    id: c.firstIncompleteLeaf.id,
    displayId: c.firstIncompleteLeaf.displayId ?? undefined,
    kind: "ticket" as const,
    title: c.firstIncompleteLeaf.title,
    category: "near_complete_umbrella" as const,
    reason: `${c.complete}/${c.total} complete in umbrella ${c.umbrellaId} -- close it out`,
    score: 600 - Math.min(index, 99),
  }));
}

function generatePhaseMomentum(state: ProjectState, crossNodeStatuses?: Record<string, string>): Recommendation[] {
  for (const phase of state.roadmap.phases) {
    if (state.phaseStatus(phase.id) === "complete") continue;
    const leaves = state.phaseTickets(phase.id);
    const candidate = leaves.find(
      (t) =>
        t.status !== "complete" &&
        !state.isBlocked(t) &&
        !isCrossNodeBlocked(t, crossNodeStatuses) &&
        notHiddenByEarmark(t),
    );
    if (!candidate) continue;
    return [
      {
        id: candidate.id,
        displayId: candidate.displayId ?? undefined,
        kind: "ticket" as const,
        title: candidate.title,
        category: "phase_momentum" as const,
        reason: `Next in phase order (${candidate.phase ?? "none"})`,
        score: 500,
      },
    ];
  }
  return [];
}

function generateQuickWins(state: ProjectState, phaseIndex: Map<string, number>, crossNodeStatuses?: Record<string, string>): Recommendation[] {
  const tickets = state.leafTickets.filter(
    (t) =>
      t.status === "open" &&
      t.type === "chore" &&
      !state.isBlocked(t) &&
      !isCrossNodeBlocked(t, crossNodeStatuses) &&
      notHiddenByEarmark(t),
  );
  const sorted = sortByPhaseAndOrder(tickets, phaseIndex);

  return sorted.map((ticket, index) => ({
    id: ticket.id,
    displayId: ticket.displayId ?? undefined,
    kind: "ticket" as const,
    title: ticket.title,
    category: "quick_win" as const,
    reason: "Chore -- quick win",
    score: 400 - Math.min(index, 99),
  }));
}

function generateOpenIssues(state: ProjectState): Recommendation[] {
  const issues = state.activeIssues
    .filter(
      (i) =>
        i.status !== "resolved" &&
        (i.severity === "medium" || i.severity === "low") &&
        notHiddenByEarmark(i),
    )
    .sort((a, b) => {
      const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sevDiff !== 0) return sevDiff;
      return b.discoveredDate.localeCompare(a.discoveredDate); // newer first
    });

  return issues.map((issue, index) => ({
    id: issue.id,
    displayId: issue.displayId ?? undefined,
    kind: "issue" as const,
    title: issue.title,
    category: "open_issue" as const,
    reason: issue.status === "inprogress"
      ? `${capitalize(issue.severity)} severity issue -- in-progress`
      : `${capitalize(issue.severity)} severity issue`,
    score: 300 - Math.min(index, 99),
  }));
}

// --- Helpers ---

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildPhaseIndex(state: ProjectState): Map<string, number> {
  const index = new Map<string, number>();
  state.roadmap.phases.forEach((p, i) => index.set(p.id, i));
  return index;
}

/** Sort tickets by roadmap phase order, then by ticket order within phase. */
function sortByPhaseAndOrder(
  tickets: readonly Ticket[],
  phaseIndex: Map<string, number>,
): Ticket[] {
  return [...tickets].sort((a, b) => {
    const aPhase = (a.phase != null ? phaseIndex.get(a.phase) : undefined) ?? Number.MAX_SAFE_INTEGER;
    const bPhase = (b.phase != null ? phaseIndex.get(b.phase) : undefined) ?? Number.MAX_SAFE_INTEGER;
    if (aPhase !== bPhase) return aPhase - bPhase;
    return a.order - b.order;
  });
}

// --- ISS-1154: handover-context promotion (formerly ISS-018's +50 boost) ---

const HANDOVER_CONTEXT_SCORE = 675;

interface HandoverBoostContext {
  readonly crossNodeRefStatuses?: Record<string, string>;
  readonly latestDispositionById: ReadonlyMap<string, TrajectoryDisposition>;
  readonly windowIncomplete: boolean;
}

/**
 * Promotes an id with genuine continuation/carried mentions in >= 2 of the
 * read handover window to the fixed handover_context/675 band. No
 * promotion at all (existing-mutate or fresh-add) when the window is
 * incomplete -- promotion is the one purely additive/optimistic step, so it
 * alone is withheld under incomplete evidence.
 */
function applyHandoverBoost(
  state: ProjectState,
  dedup: Map<string, Recommendation>,
  continuationMentionCount: ReadonlyMap<string, number>,
  ctx: HandoverBoostContext,
): void {
  if (ctx.windowIncomplete) return;

  for (const [id, count] of continuationMentionCount) {
    if (count < 2) continue;

    const existing = dedup.get(id);
    if (existing) {
      if (existing.actionability?.status === "actionable" && existing.score < HANDOVER_CONTEXT_SCORE) {
        dedup.set(id, {
          ...existing,
          category: "handover_context",
          score: HANDOVER_CONTEXT_SCORE,
          reason: existing.reason + " (handover context)",
        });
      }
      continue;
    }

    const asTicket = state.resolveTicketRef(id);
    const asIssue = asTicket.kind === "found" ? null : state.resolveIssueRef(id);
    let kind: "ticket" | "issue";
    let item: Ticket | Issue;
    if (asTicket.kind === "found") {
      kind = "ticket";
      item = asTicket.item;
    } else if (asIssue && asIssue.kind === "found") {
      kind = "issue";
      item = asIssue.item;
    } else {
      continue; // missing/ambiguous -- nothing to add
    }

    // Silent skip: an archived/deleted item is not real backlog, and an
    // earmark-hidden item is invisible everywhere else in this file --
    // neither is recorded into `excluded` either.
    if (!isActiveLifecycle(item)) continue;
    if (!notHiddenByEarmark(item)) continue;

    const actionability = computeActionability(kind, item, {
      state,
      crossNodeRefStatuses: ctx.crossNodeRefStatuses,
      latestDispositionById: ctx.latestDispositionById,
    });

    // Silent skip, same as archived/earmark-hidden above: a finished item
    // still named as continuation in stale handovers is not real backlog,
    // so it neither gets promoted nor inflates excludedCount. Blocked,
    // duplicate, escalate_only and owner_gated fresh-adds still record into
    // excluded as designed -- only "complete" is withheld here.
    if (actionability.status === "complete") continue;

    dedup.set(id, {
      id,
      displayId: (item as Record<string, unknown>).displayId as string | undefined,
      kind,
      title: item.title,
      category: "handover_context",
      reason: "Referenced in latest handover",
      score: HANDOVER_CONTEXT_SCORE,
      actionability,
      phase: kind === "ticket" ? (item as Ticket).phase : undefined,
      severity: kind === "issue" ? (item as Issue).severity : undefined,
    });
  }
}

// --- Federation generators ---

const FED_STALE_DAYS = 14;
const FED_ISSUE_RATIO_THRESHOLD = 0.3;
const FED_ISSUE_ABSOLUTE_MINIMUM = 3;

interface FederationFacts {
  nodes: FederationNodeEntry[];
  downstreamOf: Map<string, string[]>;
  suppressedScanBased: Set<string>;
  suppressedBottleneck: Set<string>;
}

function buildFederationFacts(fedState: FederationState): FederationFacts {
  const downstreamOf = new Map<string, string[]>();
  for (const node of fedState.nodes) {
    for (const dep of node.dependsOn) {
      const existing = downstreamOf.get(dep);
      if (existing) existing.push(node.name);
      else downstreamOf.set(dep, [node.name]);
    }
  }
  return {
    nodes: fedState.nodes,
    downstreamOf,
    suppressedScanBased: new Set(),
    suppressedBottleneck: new Set(),
  };
}

function generateFedUnreachable(facts: FederationFacts): Recommendation[] {
  const recs: Recommendation[] = [];
  let index = 0;
  for (const node of facts.nodes) {
    if (!node.reachable) {
      facts.suppressedScanBased.add(node.name);
      const reason = node.unreachableReason
        ? `Node "${node.name}" is unreachable (${node.unreachableReason})`
        : `Node "${node.name}" is unreachable`;
      recs.push({
        id: `FED_UNREACHABLE_${node.name}`,
        kind: "action",
        title: `Init ${node.name}`,
        category: "fed_unreachable",
        reason,
        score: 750 - Math.min(index++, 99),
      });
    }
  }
  return recs;
}

function generateFedRedBlockers(facts: FederationFacts): Recommendation[] {
  const recs: Recommendation[] = [];
  let index = 0;
  for (const node of facts.nodes) {
    if (node.health !== "red" && node.health !== "yellow") continue;
    const downstream = facts.downstreamOf.get(node.name);
    if (!downstream || downstream.length === 0) continue;
    facts.suppressedBottleneck.add(node.name);
    const baseScore = node.health === "red" ? 850 : 840;
    recs.push({
      id: `FED_RED_${node.name}`,
      kind: "action",
      title: `Address ${node.name} (${node.health})`,
      category: "fed_red_blocker",
      reason: `Node "${node.name}" is ${node.health} and blocks ${downstream.join(", ")}`,
      score: baseScore - Math.min(index++, 99),
    });
  }
  return recs;
}

function generateFedBottleneck(facts: FederationFacts): Recommendation[] {
  const recs: Recommendation[] = [];
  let index = 0;
  for (const node of facts.nodes) {
    if (facts.suppressedBottleneck.has(node.name)) continue;
    if (node.health === "green") continue;
    const downstream = facts.downstreamOf.get(node.name);
    if (!downstream || downstream.length < 2) continue;
    recs.push({
      id: `FED_BOTTLENECK_${node.name}`,
      kind: "action",
      title: `Bottleneck: ${node.name}`,
      category: "fed_bottleneck",
      reason: `Node "${node.name}" is ${node.health} and depended on by ${downstream.length} nodes (${downstream.join(", ")})`,
      score: 650 - Math.min(index++, 99),
    });
  }
  return recs;
}

function generateFedHighIssues(facts: FederationFacts): Recommendation[] {
  const recs: Recommendation[] = [];
  let index = 0;
  for (const node of facts.nodes) {
    if (facts.suppressedScanBased.has(node.name)) continue;
    if (!node.scanSummary) continue;
    const { openIssues, ticketCount } = node.scanSummary;
    if (ticketCount <= 0) continue;
    if (openIssues < FED_ISSUE_ABSOLUTE_MINIMUM) continue;
    const ratio = openIssues / ticketCount;
    if (ratio <= FED_ISSUE_RATIO_THRESHOLD) continue;
    recs.push({
      id: `FED_ISSUES_${node.name}`,
      kind: "action",
      title: `Issue debt in ${node.name}`,
      category: "fed_high_issues",
      reason: `Node "${node.name}" has ${openIssues} open issues across ${ticketCount} tickets (${Math.round(ratio * 100)}%)`,
      score: 550 - Math.min(index++, 99),
    });
  }
  return recs;
}

function generateFedStaleNodes(facts: FederationFacts, now?: Date): Recommendation[] {
  const recs: Recommendation[] = [];
  const today = now ?? new Date();
  let index = 0;
  for (const node of facts.nodes) {
    if (facts.suppressedScanBased.has(node.name)) continue;
    if (!node.scanSummary) continue;
    const lastDate = node.scanSummary.lastHandoverDate;
    if (lastDate) {
      const parsed = new Date(lastDate);
      if (Number.isNaN(parsed.getTime())) continue;
      const daysSince = Math.floor((today.getTime() - parsed.getTime()) / 86_400_000);
      if (daysSince <= FED_STALE_DAYS) continue;
      recs.push({
        id: `FED_STALE_${node.name}`,
        kind: "action",
        title: `Stale: ${node.name}`,
        category: "fed_stale_node",
        reason: `Node "${node.name}" has no handover activity in ${daysSince} days`,
        score: 475 - Math.min(index++, 99),
      });
    } else {
      recs.push({
        id: `FED_STALE_${node.name}`,
        kind: "action",
        title: `Stale: ${node.name}`,
        category: "fed_stale_node",
        reason: `Node "${node.name}" has never had a handover`,
        score: 475 - Math.min(index++, 99),
      });
    }
  }
  return recs;
}

// --- ISS-019: Debt trend detection ---

const DEBT_TREND_SCORE = 450;
const DEBT_GROWTH_THRESHOLD = 0.25;
const DEBT_ABSOLUTE_MINIMUM = 2;

function generateDebtTrend(
  state: ProjectState,
  options?: RecommendOptions,
): Recommendation[] {
  if (options?.previousOpenIssueCount == null) return [];

  const currentOpen = state.activeIssues.filter((i) => i.status !== "resolved").length;
  const previous = options.previousOpenIssueCount;
  if (previous <= 0) return [];

  const growth = (currentOpen - previous) / previous;
  const absolute = currentOpen - previous;

  if (growth > DEBT_GROWTH_THRESHOLD && absolute >= DEBT_ABSOLUTE_MINIMUM) {
    return [{
      id: "DEBT_TREND",
      kind: "action",
      title: "Issue debt growing",
      category: "debt_trend",
      reason: `Open issues grew from ${previous} to ${currentOpen} (+${Math.round(growth * 100)}%). Consider triaging or resolving issues before adding features.`,
      score: DEBT_TREND_SCORE,
    }];
  }

  return [];
}
