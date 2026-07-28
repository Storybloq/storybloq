import type { Ticket } from "../models/ticket.js";
import type { Phase, Blocker } from "../models/roadmap.js";
import type { ProjectState, PhaseStatus } from "./project-state.js";

// --- Result Types ---

export interface UmbrellaProgress {
  readonly total: number;
  readonly complete: number;
  readonly status: PhaseStatus;
}

export interface UnblockImpact {
  readonly ticketId: string;
  readonly wouldUnblock: readonly Ticket[];
}

export interface NextTicketResult {
  readonly kind: "found";
  readonly ticket: Ticket;
  readonly unblockImpact: UnblockImpact;
  readonly umbrellaProgress: UmbrellaProgress | null;
}

export interface NextTicketAllComplete {
  readonly kind: "all_complete";
}

export interface NextTicketAllBlocked {
  readonly kind: "all_blocked";
  readonly phaseId: string;
  readonly blockedCount: number;
}

export interface NextTicketEmpty {
  readonly kind: "empty_project";
}

export type NextTicketOutcome =
  | NextTicketResult
  | NextTicketAllComplete
  | NextTicketAllBlocked
  | NextTicketEmpty;

// --- Multi-candidate result types (nextTickets) ---

export interface NextTicketCandidate {
  readonly ticket: Ticket;
  readonly unblockImpact: UnblockImpact;
  readonly umbrellaProgress: UmbrellaProgress | null;
}

export interface SkippedBlockedPhase {
  readonly phaseId: string;
  readonly blockedCount: number;
}

export interface NextTicketsResult {
  readonly kind: "found";
  readonly candidates: readonly NextTicketCandidate[];
  readonly skippedBlockedPhases: readonly SkippedBlockedPhase[];
}

export interface NextTicketsAllBlocked {
  readonly kind: "all_blocked";
  readonly phases: readonly SkippedBlockedPhase[];
}

export type NextTicketsOutcome =
  | NextTicketsResult
  | NextTicketsAllBlocked
  | NextTicketAllComplete
  | NextTicketEmpty;

export interface PhaseWithStatus {
  readonly phase: Phase;
  readonly status: PhaseStatus;
  readonly leafCount: number;
}

// --- Query Functions ---

/**
 * First non-complete, unblocked leaf ticket in the first non-complete phase
 * (roadmap order). Skips phases with zero leaf tickets.
 * Returns discriminated outcome for exhaustive handling.
 */
export function nextTicket(state: ProjectState): NextTicketOutcome {
  const phases = state.roadmap.phases;
  if (phases.length === 0 || state.leafTickets.length === 0) {
    return { kind: "empty_project" };
  }

  let allPhasesComplete = true;

  for (const phase of phases) {
    const leaves = state.phaseTickets(phase.id);
    if (leaves.length === 0) continue; // skip empty/umbrella-only phases

    const status = state.phaseStatus(phase.id);
    if (status === "complete") continue;

    allPhasesComplete = false;

    // Find first non-complete, unblocked leaf
    const incompleteLeaves = leaves.filter((t) => t.status !== "complete");
    const candidate = incompleteLeaves.find((t) => !state.isBlocked(t));

    if (candidate) {
      const impact = ticketsUnblockedBy(candidate.id, state);
      const progress = candidate.parentTicket
        ? umbrellaProgress(candidate.parentTicket, state)
        : null;
      return {
        kind: "found",
        ticket: candidate,
        unblockImpact: { ticketId: candidate.id, wouldUnblock: impact },
        umbrellaProgress: progress,
      };
    }

    // Phase has incomplete leaves but all are blocked
    return {
      kind: "all_blocked",
      phaseId: phase.id,
      blockedCount: incompleteLeaves.length,
    };
  }

  if (allPhasesComplete) {
    return { kind: "all_complete" };
  }

  // All phases had zero leaves (shouldn't happen if leafTickets.length > 0)
  return { kind: "empty_project" };
}

/**
 * Up to `count` unblocked leaf tickets across all non-complete phases
 * (roadmap order). Unlike nextTicket, continues past fully-blocked phases
 * and collects multiple candidates within the same phase.
 */
export function nextTickets(
  state: ProjectState,
  count: number,
  /**
   * T-328: ids to leave out of consideration entirely (a session's skipped
   * items). Applied BEFORE ranking and truncation -- filtering the returned
   * candidates instead would let a session that skipped the top of the list
   * look like it had no work while eligible lower-ranked tickets remained.
   */
  excludeIds: ReadonlySet<string> = new Set(),
): NextTicketsOutcome {
  const effectiveCount = Math.max(1, count);
  const phases = state.roadmap.phases;
  if (phases.length === 0 || state.leafTickets.length === 0) {
    return { kind: "empty_project" };
  }

  const candidates: NextTicketCandidate[] = [];
  const skippedBlockedPhases: SkippedBlockedPhase[] = [];
  let allPhasesComplete = true;

  for (const phase of phases) {
    if (candidates.length >= effectiveCount) break;

    const leaves = state.phaseTickets(phase.id);
    if (leaves.length === 0) continue;

    const status = state.phaseStatus(phase.id);
    if (status === "complete") continue;

    allPhasesComplete = false;

    const incompleteLeaves = leaves
      .filter((t) => t.status !== "complete")
      .filter((t) => !excludeIds.has(t.id) && !(t.displayId && excludeIds.has(t.displayId)));
    const unblocked = incompleteLeaves.filter((t) => !state.isBlocked(t));

    if (unblocked.length === 0) {
      skippedBlockedPhases.push({
        phaseId: phase.id,
        blockedCount: incompleteLeaves.length,
      });
      continue;
    }

    const remaining = effectiveCount - candidates.length;
    for (const ticket of unblocked.slice(0, remaining)) {
      const impact = ticketsUnblockedBy(ticket.id, state);
      const progress = ticket.parentTicket
        ? umbrellaProgress(ticket.parentTicket, state)
        : null;
      candidates.push({
        ticket,
        unblockImpact: { ticketId: ticket.id, wouldUnblock: impact },
        umbrellaProgress: progress,
      });
    }
  }

  if (candidates.length > 0) {
    return { kind: "found", candidates, skippedBlockedPhases };
  }

  if (skippedBlockedPhases.length > 0) {
    return { kind: "all_blocked", phases: skippedBlockedPhases };
  }

  if (allPhasesComplete) {
    return { kind: "all_complete" };
  }

  return { kind: "empty_project" };
}

/**
 * All currently blocked incomplete leaf tickets.
 */
export function blockedTickets(state: ProjectState): readonly Ticket[] {
  return state.leafTickets.filter(
    (t) => t.status !== "complete" && state.isBlocked(t),
  );
}

/**
 * Tickets that would become unblocked if ticketId were completed.
 * Direct unblocking only — no transitive chains.
 */
export function ticketsUnblockedBy(
  ticketId: string,
  state: ProjectState,
): readonly Ticket[] {
  const blocked = state.reverseBlocks(ticketId);
  return blocked.filter((t) => {
    if (t.status === "complete") return false;
    // Check if ALL other blockers (excluding ticketId) are complete
    return t.blockedBy.every((bid) => {
      if (bid === ticketId) return true; // skip the ticket we're simulating as complete
      const blocker = state.ticketByID(bid);
      if (!blocker) return false; // unknown = still blocked
      return blocker.status === "complete";
    });
  });
}

/**
 * Progress of an umbrella's descendant leaves.
 * Returns null if ticketId is not an umbrella.
 */
export function umbrellaProgress(
  ticketId: string,
  state: ProjectState,
): UmbrellaProgress | null {
  if (!state.umbrellaIDs.has(ticketId)) return null;
  const leaves = collectDescendantLeaves(ticketId, state, new Set());
  const complete = leaves.filter((t) => t.status === "complete").length;
  return {
    total: leaves.length,
    complete,
    status: state.umbrellaStatus(ticketId),
  };
}

/**
 * First phase in roadmap order that is not complete and has leaf tickets.
 */
export function currentPhase(state: ProjectState): Phase | null {
  for (const phase of state.roadmap.phases) {
    const leaves = state.phaseTickets(phase.id);
    if (leaves.length === 0) continue;
    if (state.phaseStatus(phase.id) !== "complete") return phase;
  }
  return null;
}

/**
 * All roadmap phases with their derived status and leaf count.
 */
export function phasesWithStatus(
  state: ProjectState,
): readonly PhaseWithStatus[] {
  return state.roadmap.phases.map((phase) => ({
    phase,
    status: state.phaseStatus(phase.id),
    leafCount: state.phaseTickets(phase.id).length,
  }));
}

/**
 * Normalizes blocker cleared state across legacy and new formats.
 * Legacy: cleared boolean. New: clearedDate non-null.
 */
export function isBlockerCleared(blocker: Blocker): boolean {
  if (blocker.cleared === true) return true;
  if (blocker.clearedDate != null) return true;
  return false;
}

/**
 * All descendant leaf tickets of an umbrella (recursive).
 * Public wrapper around the private cycle-safe helper.
 */
export function descendantLeaves(
  ticketId: string,
  state: ProjectState,
): Ticket[] {
  return collectDescendantLeaves(ticketId, state, new Set());
}

// --- Cross-Node Blocking ---

/**
 * Check if a ticket is blocked by cross-node references.
 * Conservative: missing cache or unknown ref = blocked.
 * Only "complete" status unblocks.
 */
export function isCrossNodeBlocked(
  ticket: Ticket,
  crossNodeRefStatuses?: Record<string, string>,
): boolean {
  const refs = ticket.crossNodeBlockedBy;
  if (!refs || refs.length === 0) return false;
  if (!crossNodeRefStatuses) return true;
  return refs.some((ref) => {
    const status = crossNodeRefStatuses[ref];
    if (!status) return true;
    return status !== "complete";
  });
}

// --- Private Helpers ---

/**
 * Collects descendant leaf tickets of an umbrella using public API only.
 * Mirrors ProjectState.descendantLeaves but without accessing private methods.
 */
function collectDescendantLeaves(
  ticketId: string,
  state: ProjectState,
  visited: Set<string>,
): Ticket[] {
  if (visited.has(ticketId)) return [];
  visited.add(ticketId);

  const children = state.umbrellaChildren(ticketId);
  const leaves: Ticket[] = [];
  for (const child of children) {
    if (state.umbrellaIDs.has(child.id)) {
      leaves.push(...collectDescendantLeaves(child.id, state, visited));
    } else {
      leaves.push(child);
    }
  }
  return leaves;
}
