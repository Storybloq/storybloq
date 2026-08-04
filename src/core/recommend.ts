/**
 * Context-aware work recommendation engine.
 *
 * Unlike nextTicket (queue-based, phase order), recommend considers the full
 * project state and suggests a ranked list mixing tickets and issues, each
 * with a human-readable rationale.
 */
import type { ProjectState } from "./project-state.js";
import type { Ticket } from "../models/ticket.js";
import type { IssueSeverity } from "../models/types.js";
import type { FederationState, FederationNodeEntry } from "../federation/state.js";
import {
  nextTicket,
  currentPhase,
  ticketsUnblockedBy,
  umbrellaProgress,
  descendantLeaves,
  isCrossNodeBlocked,
} from "./queries.js";
import { validateProject } from "./validation.js";
import { applyClaimAnnotations } from "./claims.js";
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
  | "debt_trend";

export interface RecommendOptions {
  readonly latestHandoverContent?: string;
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
}

export interface RecommendResult {
  readonly recommendations: readonly Recommendation[];
  readonly totalCandidates: number;
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
  fed_bottleneck: 7,
  near_complete_umbrella: 8,
  fed_high_issues: 9,
  phase_momentum: 10,
  fed_stale_node: 11,
  debt_trend: 12,
  quick_win: 13,
  handover_context: 14,
  open_issue: 15,
};

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

  // ISS-018: Handover context boost -- tickets referenced in actionable sections get +50
  applyHandoverBoost(state, dedup, options);

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

  return {
    recommendations: all.slice(0, effectiveCount),
    totalCandidates: all.length,
  };
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

function generateCriticalIssues(state: ProjectState): Recommendation[] {
  const issues = state.activeIssues
    .filter(
      (i) =>
        i.status !== "resolved" &&
        (i.severity === "critical" || i.severity === "high"),
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
      (t) => t.status !== "complete" && !state.isBlocked(t) && !isCrossNodeBlocked(t, crossNodeStatuses),
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
      (t) => t.status !== "complete" && !state.isBlocked(t) && !isCrossNodeBlocked(t, crossNodeStatuses),
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
      t.status === "open" && t.type === "chore" && !state.isBlocked(t) && !isCrossNodeBlocked(t, crossNodeStatuses),
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
        (i.severity === "medium" || i.severity === "low"),
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

// --- ISS-018: Handover context boost ---

const TICKET_ID_RE = /\bT-\d{3}[a-z]?\b/g;
const ACTIONABLE_HEADING_RE = /^#+\s.*(next|open|remaining|todo|blocked)/im;
const HANDOVER_BOOST = 50;
const HANDOVER_BASE_SCORE = 350;

/**
 * Boost tickets referenced in the latest handover's actionable sections.
 * Falls back to full-document scan for tickets not already complete/inprogress.
 */
function applyHandoverBoost(
  state: ProjectState,
  dedup: Map<string, Recommendation>,
  options?: RecommendOptions,
): void {
  if (!options?.latestHandoverContent) return;
  const content = options.latestHandoverContent;

  // Try to isolate actionable sections (What's Next, Open Items, etc.)
  let actionableIds = extractTicketIdsFromActionableSections(content);

  // Fallback: full-doc scan, but only boost open tickets
  if (actionableIds.size === 0) {
    const allIds = new Set(content.match(TICKET_ID_RE) ?? []);
    for (const id of allIds) {
      const ticket = state.ticketByID(id);
      if (ticket && ticket.status !== "complete" && ticket.status !== "inprogress") {
        actionableIds.add(id);
      }
    }
  }

  for (const id of actionableIds) {
    const ticket = state.ticketByID(id);
    if (!ticket || ticket.status === "complete") continue;

    const existing = dedup.get(id);
    if (existing) {
      dedup.set(id, {
        ...existing,
        score: existing.score + HANDOVER_BOOST,
        reason: existing.reason + " (handover context)",
      });
    } else {
      dedup.set(id, {
        id,
        kind: "ticket",
        title: ticket.title,
        category: "handover_context",
        reason: "Referenced in latest handover",
        score: HANDOVER_BASE_SCORE,
      });
    }
  }
}

function extractTicketIdsFromActionableSections(content: string): Set<string> {
  const ids = new Set<string>();
  const lines = content.split("\n");
  let inActionable = false;

  for (const line of lines) {
    if (/^#+\s/.test(line)) {
      inActionable = ACTIONABLE_HEADING_RE.test(line);
    }
    if (inActionable) {
      const matches = line.match(TICKET_ID_RE);
      if (matches) for (const m of matches) ids.add(m);
    }
  }
  return ids;
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
