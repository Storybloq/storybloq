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
import {
  nextTicket,
  currentPhase,
  ticketsUnblockedBy,
  umbrellaProgress,
  descendantLeaves,
} from "./queries.js";
import { validateProject } from "./validation.js";

// --- Types ---

export type RecommendCategory =
  | "validation_errors"
  | "critical_issue"
  | "inprogress_ticket"
  | "high_impact_unblock"
  | "near_complete_umbrella"
  | "phase_momentum"
  | "quick_win"
  | "open_issue";

export type RecommendItemKind = "ticket" | "issue" | "action";

export interface Recommendation {
  readonly id: string;
  readonly kind: RecommendItemKind;
  readonly title: string;
  readonly category: RecommendCategory;
  readonly reason: string;
  readonly score: number;
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
  inprogress_ticket: 3,
  high_impact_unblock: 4,
  near_complete_umbrella: 5,
  phase_momentum: 6,
  quick_win: 7,
  open_issue: 8,
};

// --- Public API ---

export function recommend(
  state: ProjectState,
  count: number,
): RecommendResult {
  const effectiveCount = Math.max(1, Math.min(10, count));
  const dedup = new Map<string, Recommendation>();
  const phaseIndex = buildPhaseIndex(state);

  const generators = [
    () => generateValidationSuggestions(state),
    () => generateCriticalIssues(state),
    () => generateInProgressTickets(state, phaseIndex),
    () => generateHighImpactUnblocks(state),
    () => generateNearCompleteUmbrellas(state, phaseIndex),
    () => generatePhaseMomentum(state),
    () => generateQuickWins(state, phaseIndex),
    () => generateOpenIssues(state),
  ];

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

  const all = [...dedup.values()].sort((a, b) => {
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
      title: "Run claudestory validate",
      category: "validation_errors",
      reason: `${result.errorCount} validation error${result.errorCount === 1 ? "" : "s"} — fix before other work`,
      score: 1000,
    },
  ];
}

function generateCriticalIssues(state: ProjectState): Recommendation[] {
  const issues = state.issues
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
    kind: "issue" as const,
    title: issue.title,
    category: "critical_issue" as const,
    reason: issue.status === "inprogress"
      ? `${capitalize(issue.severity)} severity issue — in-progress, ensure it's being addressed`
      : `${capitalize(issue.severity)} severity issue — address before new features`,
    score: 900 - Math.min(index, 99),
  }));
}

function generateInProgressTickets(state: ProjectState, phaseIndex: Map<string, number>): Recommendation[] {
  const tickets = state.leafTickets.filter(
    (t) => t.status === "inprogress",
  );
  const sorted = sortByPhaseAndOrder(tickets, phaseIndex);

  return sorted.map((ticket, index) => ({
    id: ticket.id,
    kind: "ticket" as const,
    title: ticket.title,
    category: "inprogress_ticket" as const,
    reason: "In-progress — finish what's started",
    score: 800 - Math.min(index, 99),
  }));
}

function generateHighImpactUnblocks(state: ProjectState): Recommendation[] {
  const candidates: { ticket: Ticket; unblockCount: number }[] = [];

  for (const ticket of state.leafTickets) {
    if (ticket.status === "complete") continue;
    if (state.isBlocked(ticket)) continue;

    const wouldUnblock = ticketsUnblockedBy(ticket.id, state);
    if (wouldUnblock.length >= 2) {
      candidates.push({ ticket, unblockCount: wouldUnblock.length });
    }
  }

  candidates.sort((a, b) => b.unblockCount - a.unblockCount);

  return candidates.map(({ ticket, unblockCount }, index) => ({
    id: ticket.id,
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

    // Find first incomplete leaf, sorted by phase+order
    const leaves = descendantLeaves(umbrellaId, state);
    const incomplete = leaves.filter((t) => t.status !== "complete");
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
    kind: "ticket" as const,
    title: c.firstIncompleteLeaf.title,
    category: "near_complete_umbrella" as const,
    reason: `${c.complete}/${c.total} complete in umbrella ${c.umbrellaId} — close it out`,
    score: 600 - Math.min(index, 99),
  }));
}

function generatePhaseMomentum(state: ProjectState): Recommendation[] {
  const outcome = nextTicket(state);
  if (outcome.kind !== "found") return [];

  const ticket = outcome.ticket;
  return [
    {
      id: ticket.id,
      kind: "ticket" as const,
      title: ticket.title,
      category: "phase_momentum" as const,
      reason: `Next in phase order (${ticket.phase ?? "none"})`,
      score: 500,
    },
  ];
}

function generateQuickWins(state: ProjectState, phaseIndex: Map<string, number>): Recommendation[] {
  // chore is a heuristic proxy for "quick win" — not all chores are quick
  const tickets = state.leafTickets.filter(
    (t) =>
      t.status === "open" && t.type === "chore" && !state.isBlocked(t),
  );
  const sorted = sortByPhaseAndOrder(tickets, phaseIndex);

  return sorted.map((ticket, index) => ({
    id: ticket.id,
    kind: "ticket" as const,
    title: ticket.title,
    category: "quick_win" as const,
    reason: "Chore — quick win",
    score: 400 - Math.min(index, 99),
  }));
}

function generateOpenIssues(state: ProjectState): Recommendation[] {
  const issues = state.issues
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
    kind: "issue" as const,
    title: issue.title,
    category: "open_issue" as const,
    reason: issue.status === "inprogress"
      ? `${capitalize(issue.severity)} severity issue — in-progress`
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
