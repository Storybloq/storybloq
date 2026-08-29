import { displayIdOf } from "./resolver.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { Arrangement } from "../models/arrangement.js";
import type { ProjectState } from "./project-state.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX, NOTE_ID_REGEX, LESSON_ID_REGEX } from "../models/types.js";
import {
  maxSequentialNumber,
  TICKET_NUMERIC_REGEX,
  ISSUE_NUMERIC_REGEX,
  NOTE_NUMERIC_REGEX,
  LESSON_NUMERIC_REGEX,
} from "./id-allocation.js";
import { compareByRank, rebalanceRanks, REBALANCE_THRESHOLD } from "./fractional-index.js";

export type EntityType = "ticket" | "issue" | "note" | "lesson";

export interface ReconcileRename {
  entityType: EntityType;
  id: string;
  oldDisplayId: string;
  newDisplayId: string;
  reason: string;
}

export interface ReconcileWarning {
  message: string;
}

export interface ReconcileContext {
  reservations?: Partial<Record<EntityType, ReadonlyMap<string, string>>>;
  protectedOwners?: Partial<Record<EntityType, ReadonlySet<string>>>;
  warnings?: ReconcileWarning[];
}

export interface ReconcilePlan {
  renames: ReconcileRename[];
  warnings: ReconcileWarning[];
}

export type ReconcileResult =
  | { ok: true; plan: ReconcilePlan }
  | { ok: false; errors: string[] };

interface Resolvable {
  id: string;
  displayId?: string | null;
  previousDisplayIds?: string[] | null;
}

interface EntityWithTimestamp extends Resolvable {
  _conflicts?: unknown[] | null;
}

function getEntityTimestamp(entityType: EntityType, entity: Record<string, unknown>): string | null {
  // Prefer sub-day ISO 8601 createdAt when available
  const createdAt = entity.createdAt;
  if (typeof createdAt === "string" && createdAt !== "" && !isNaN(Date.parse(createdAt))) {
    return createdAt;
  }
  const field = entityType === "issue" ? "discoveredDate" : "createdDate";
  const value = entity[field];
  if (typeof value !== "string" || value === "") return null;
  if (isNaN(Date.parse(value))) return null;
  return value;
}

function isLegacyId(entityType: EntityType, id: string): boolean {
  switch (entityType) {
    case "ticket": return TICKET_ID_REGEX.test(id);
    case "issue": return ISSUE_ID_REGEX.test(id);
    case "note": return NOTE_ID_REGEX.test(id);
    case "lesson": return LESSON_ID_REGEX.test(id);
  }
}

function hasLegacyPriority(entityType: EntityType, item: Resolvable): boolean {
  return isLegacyId(entityType, item.id) && displayIdOf(item) === item.id;
}

function compareEntities(
  entityType: EntityType,
  a: EntityWithTimestamp & Record<string, unknown>,
  b: EntityWithTimestamp & Record<string, unknown>,
  displayId: string,
  context?: ReconcileContext,
): number {
  const aLegacy = hasLegacyPriority(entityType, a);
  const bLegacy = hasLegacyPriority(entityType, b);
  if (aLegacy && !bLegacy) return -1;
  if (!aLegacy && bLegacy) return 1;

  const reservationOwner = context?.reservations?.[entityType]?.get(displayId);
  const aReservationOwner = reservationOwner === a.id;
  const bReservationOwner = reservationOwner === b.id;
  if (aReservationOwner && !bReservationOwner) return -1;
  if (!aReservationOwner && bReservationOwner) return 1;

  const protectedOwners = context?.protectedOwners?.[entityType];
  const aProtectedOwner = protectedOwners?.has(a.id) === true;
  const bProtectedOwner = protectedOwners?.has(b.id) === true;
  if (aProtectedOwner && !bProtectedOwner) return -1;
  if (!aProtectedOwner && bProtectedOwner) return 1;

  const aTs = getEntityTimestamp(entityType, a);
  const bTs = getEntityTimestamp(entityType, b);
  if (aTs !== null && bTs === null) return -1;
  if (aTs === null && bTs !== null) return 1;
  if (aTs !== null && bTs !== null && aTs !== bTs) {
    return aTs < bTs ? -1 : 1;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function winningReason(
  entityType: EntityType,
  displayId: string,
  winner: EntityWithTimestamp & Record<string, unknown>,
  loser: EntityWithTimestamp & Record<string, unknown>,
  context?: ReconcileContext,
): string {
  const winnerLegacy = hasLegacyPriority(entityType, winner);
  const loserLegacy = hasLegacyPriority(entityType, loser);
  if (winnerLegacy && !loserLegacy) return "legacy ID priority";

  const reservationOwner = context?.reservations?.[entityType]?.get(displayId);
  if (reservationOwner === winner.id && reservationOwner !== loser.id) return "valid reservation";

  const protectedOwners = context?.protectedOwners?.[entityType];
  const winnerProtected = protectedOwners?.has(winner.id) === true;
  const loserProtected = protectedOwners?.has(loser.id) === true;
  if (winnerProtected && !loserProtected) return "protected branch ownership";

  const winnerTs = getEntityTimestamp(entityType, winner);
  const loserTs = getEntityTimestamp(entityType, loser);
  if (winnerTs !== null && loserTs === null) return "valid timestamp vs missing";
  if (winnerTs !== null && loserTs !== null && winnerTs !== loserTs) return "earlier timestamp";

  return "lower canonical ID";
}

function hasConflicts(entity: EntityWithTimestamp): boolean {
  const c = entity._conflicts;
  return Array.isArray(c) && c.length > 0;
}

function reconcileEntityType<T extends EntityWithTimestamp & Record<string, unknown>>(
  entityType: EntityType,
  items: readonly T[],
  displayPrefix: string,
  numericRegex: RegExp,
  context?: ReconcileContext,
): { renames: ReconcileRename[]; nextSeq: number } {
  const activeItems = items.filter((item) => (item as Record<string, unknown>).lifecycle !== "deleted");
  const groups = new Map<string, T[]>();
  for (const item of activeItems) {
    const did = displayIdOf(item);
    let group = groups.get(did);
    if (!group) {
      group = [];
      groups.set(did, group);
    }
    group.push(item);
  }

  // ISS-689: allocate next sequential numbers from the FULL item set (including
  // tombstones), not just active items. Collision grouping above is intentionally
  // over active items only, but a renamed loser must never be handed a displayId a
  // tombstone still holds (its displayId/previousDisplayIds), or restoring/surfacing
  // that tombstone would resurrect a duplicate reconcile itself created.
  let nextSeq = maxSequentialNumber(items as readonly Resolvable[], numericRegex) + 1;
  const renames: ReconcileRename[] = [];

  for (const [displayId, group] of groups) {
    if (group.length <= 1) continue;

    const sorted = [...group].sort((a, b) => compareEntities(entityType, a, b, displayId, context));
    const winner = sorted[0]!;
    const losers = sorted.slice(1);

    for (const loser of losers) {
      const newDisplayId = `${displayPrefix}${String(nextSeq).padStart(3, "0")}`;
      nextSeq++;

      const winnerLabel = winningReason(entityType, displayId, winner, loser, context);

      renames.push({
        entityType,
        id: loser.id,
        oldDisplayId: displayId,
        newDisplayId,
        reason: `${displayIdOf(winner)} wins (${winnerLabel})`,
      });
    }
  }

  return { renames, nextSeq };
}

/**
 * T-478: the full `loadArrangementsSafe(root)` result, not just the accepted
 * `.arrangements` -- an unreadable arrangement file, a symlink-rejected
 * directory (`core/readdir-safe.ts`'s new failure modes), or a schema-invalid
 * record would silently drop out of `.arrangements` alone, and
 * `reconcile`/`reconcile --ci` would report clean while a real unresolved
 * conflict sits in a file the scan never saw. A non-empty `warnings` fails
 * the whole plan closed (see below) BEFORE the per-arrangement `_conflicts`
 * check ever runs: an incomplete scan cannot prove conflict absence.
 */
export interface ArrangementScan {
  readonly arrangements: readonly Arrangement[];
  readonly warnings: readonly string[];
}

export function computeReconcilePlan(state: ProjectState, context?: ReconcileContext, arrangementScan?: ArrangementScan): ReconcileResult {
  const errors: string[] = [];

  for (const t of state.tickets) {
    if (hasConflicts(t as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on ticket ${t.id}. Run 'storybloq resolve' first.`);
    }
  }
  for (const i of state.issues) {
    if (hasConflicts(i as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on issue ${i.id}. Run 'storybloq resolve' first.`);
    }
  }
  for (const n of state.notes) {
    if (hasConflicts(n as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on note ${n.id}. Run 'storybloq resolve' first.`);
    }
  }
  for (const l of state.lessons) {
    if (hasConflicts(l as EntityWithTimestamp)) {
      errors.push(`Unresolved conflict on lesson ${l.id}. Run 'storybloq resolve' first.`);
    }
  }

  // T-478 arrangements front-gate: an incomplete scan cannot prove conflict
  // absence, so it fails the whole plan closed BEFORE the per-arrangement
  // check below -- same posture as a ProjectState load failure would have,
  // if arrangements were on the strict load path (they deliberately are not,
  // per T-473's binding item 2; this is why the scan result must be passed
  // in explicitly rather than read from `state`).
  if (arrangementScan) {
    if (arrangementScan.warnings.length > 0) {
      for (const w of arrangementScan.warnings) {
        errors.push(`Arrangement scan incomplete: ${w}. Run 'storybloq validate' for details.`);
      }
    } else {
      for (const a of arrangementScan.arrangements) {
        if (hasConflicts(a as EntityWithTimestamp)) {
          errors.push(`Unresolved conflict on arrangement ${a.id}. Run 'storybloq resolve' first.`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const tickets = reconcileEntityType("ticket", state.tickets as (Ticket & Record<string, unknown>)[], "T-", TICKET_NUMERIC_REGEX, context);
  const issues = reconcileEntityType("issue", state.issues as (Issue & Record<string, unknown>)[], "ISS-", ISSUE_NUMERIC_REGEX, context);
  const notes = reconcileEntityType("note", state.notes as (Note & Record<string, unknown>)[], "N-", NOTE_NUMERIC_REGEX, context);
  const lessons = reconcileEntityType("lesson", state.lessons as (Lesson & Record<string, unknown>)[], "L-", LESSON_NUMERIC_REGEX, context);

  const renames = [...tickets.renames, ...issues.renames, ...notes.renames, ...lessons.renames];
  const warnings: ReconcileWarning[] = [...(context?.warnings ?? [])];

  return { ok: true, plan: { renames, warnings } };
}

export interface RebalanceChange {
  entityType: "ticket" | "issue";
  id: string;
  phase: string | null;
  oldRank: string;
  newRank: string;
}

export interface RebalanceResult {
  changes: RebalanceChange[];
  phasesRebalanced: number;
}

export function computeRebalancePlan(state: ProjectState): RebalanceResult {
  const changes: RebalanceChange[] = [];
  let phasesRebalanced = 0;

  const phases = state.roadmap?.phases ?? [];
  for (const phase of phases) {
    const tickets = state.phaseTickets(phase.id);
    const ranked = tickets.filter((t) => {
      if (t.rank == null) return false;
      if ((t as Record<string, unknown>)._conflicts) return false;
      return true;
    });

    if (ranked.length === 0) continue;

    const needsRebalance = ranked.some((t) => t.rank!.length > REBALANCE_THRESHOLD);
    if (!needsRebalance) continue;

    const sorted = [...ranked].sort(compareByRank);
    const freshRanks = rebalanceRanks(sorted.length);

    let phaseChanged = false;
    for (let i = 0; i < sorted.length; i++) {
      const oldRank = sorted[i]!.rank!;
      const newRank = freshRanks[i]!;
      if (oldRank !== newRank) {
        changes.push({
          entityType: "ticket",
          id: sorted[i]!.id,
          phase: phase.id,
          oldRank,
          newRank,
        });
        phaseChanged = true;
      }
    }
    if (phaseChanged) phasesRebalanced++;
  }

  return { changes, phasesRebalanced };
}
