/**
 * T-486 U2-3: one counting contract and one identity policy for tickets
 * (plan V3A 5a, amendment B3).
 *
 * Both consumers call these on the records the loader accepted: ProjectState
 * on `loadProject`'s tickets and `loadTicketRecords` on its own. The loader's
 * defaults (legacy `displayId` among them) are already applied; nothing here
 * defaults a field.
 */
import type { Ticket } from "../models/ticket.js";
import { checkpointReleases, hasOwnerCheckpoint } from "./owner-checkpoint.js";
import { isEffectivelyWithdrawn } from "./resolution-kind.js";

export interface TicketCounts {
  /** Active, non-umbrella tickets. */
  readonly leaf: number;
  /** Leaves that derive complete: a checkpoint by its release, otherwise stored complete. */
  readonly terminal: number;
  /** Terminal leaves whose withdrawal is effective. */
  readonly withdrawn: number;
  /** Terminal leaves that were not withdrawn. */
  readonly delivered: number;
  /** Leaves that are not terminal, in-progress and blocked work included. */
  readonly active: number;
}

/** Terminal for phase status, counts and dependency release alike (T-537). */
export function derivesComplete(t: Ticket): boolean {
  return hasOwnerCheckpoint(t) ? checkpointReleases(t) : t.status === "complete";
}

function isActiveTicket(t: Ticket): boolean {
  const lifecycle = (t as Record<string, unknown>).lifecycle;
  return lifecycle == null || lifecycle === "active";
}

/**
 * Resolves a ticket ref the way ProjectState builds its graph: canonical id;
 * else the current `displayId` holders, resolving only when there is one;
 * else, only when no ticket holds it as a current `displayId`, a unique
 * `previousDisplayIds` entry. An unmatched or ambiguous ref stays as written
 * (B3, D1: a current-display collision is ambiguous and never falls through
 * to a historical alias).
 */
export function ticketRefNormalizer(tickets: readonly Ticket[]): (ref: string) => string {
  const byId = new Set<string>();
  const byDisplay = new Map<string, string[]>();
  const byPrev = new Map<string, string[]>();
  for (const t of tickets) {
    byId.add(t.id);
    const did = (t as Record<string, unknown>).displayId as string | undefined;
    if (did) byDisplay.set(did, [...(byDisplay.get(did) ?? []), t.id]);
    for (const prev of ((t as Record<string, unknown>).previousDisplayIds as string[] | undefined) ?? []) {
      byPrev.set(prev, [...(byPrev.get(prev) ?? []), t.id]);
    }
  }
  return (ref: string): string => {
    if (byId.has(ref)) return ref;
    const display = byDisplay.get(ref);
    if (display !== undefined) return display.length === 1 ? display[0]! : ref;
    const prev = byPrev.get(ref);
    if (prev?.length === 1) return prev[0]!;
    return ref;
  };
}

/** Umbrellas: tickets named as `parentTicket` by an active ticket. */
export function umbrellaIdsOf(tickets: readonly Ticket[], normalize = ticketRefNormalizer(tickets)): Set<string> {
  const ids = new Set<string>();
  for (const t of tickets) {
    if (isActiveTicket(t) && t.parentTicket != null) ids.add(normalize(t.parentTicket));
  }
  return ids;
}

/** Counts over accepted records that passed the identity policy. */
export function computeTicketCounts(tickets: readonly Ticket[]): TicketCounts {
  const umbrellas = umbrellaIdsOf(tickets);
  const leaves = tickets.filter((t) => isActiveTicket(t) && !umbrellas.has(t.id));
  const terminal = leaves.filter(derivesComplete);
  const withdrawn = terminal.filter((t) => isEffectivelyWithdrawn(t)).length;
  return {
    leaf: leaves.length,
    terminal: terminal.length,
    withdrawn,
    delivered: terminal.length - withdrawn,
    active: leaves.length - terminal.length,
  };
}

export interface TicketIdentityDiagnostic {
  readonly code: "duplicate-id" | "display-id-collision";
  /** The canonical id (duplicate-id) or the shared display id (display-id-collision). */
  readonly key: string;
  /** Every file involved, when the caller knows them; otherwise empty. */
  readonly files: readonly string[];
  /** The canonical ids that share the display id (display-id-collision only). */
  readonly ids: readonly string[];
  readonly message: string;
}

export interface TicketIdentityReport {
  /** Records kept for counts and dependency release, in input order. */
  readonly counted: readonly Ticket[];
  /** Canonical ids claimed by more than one record; every such record is excluded. */
  readonly duplicateIds: ReadonlySet<string>;
  readonly diagnostics: readonly TicketIdentityDiagnostic[];
}

/**
 * B3. (i) Records sharing one canonical id are all excluded from counts and
 * from dependency release, with a duplicate-id diagnostic naming every file.
 * (ii) Distinct canonical tickets sharing a display id are all kept, with a
 * display-id-collision diagnostic; `storybloq reconcile` resolves them.
 * Reference resolution is not changed here.
 *
 * `files[i]` is the file `tickets[i]` was read from, when known.
 */
export function applyTicketIdentityPolicy(tickets: readonly Ticket[], files?: readonly string[]): TicketIdentityReport {
  const byId = new Map<string, number[]>();
  tickets.forEach((t, i) => byId.set(t.id, [...(byId.get(t.id) ?? []), i]));
  const duplicateIds = new Set<string>();
  const diagnostics: TicketIdentityDiagnostic[] = [];
  for (const [id, at] of byId) {
    if (at.length < 2) continue;
    duplicateIds.add(id);
    const named = files ? at.map((i) => files[i]!) : [];
    diagnostics.push({
      code: "duplicate-id",
      key: id,
      files: named,
      ids: [id],
      message: `Ticket id ${id} is claimed by ${at.length} records${named.length > 0 ? ` (${named.join(", ")})` : ""}; all are left out of counts and dependency release.`,
    });
  }
  const counted = tickets.filter((t) => !duplicateIds.has(t.id));
  const byDisplay = new Map<string, number[]>();
  tickets.forEach((t, i) => {
    // A tombstone is not a reconcile-actionable collision (ISS-689).
    if (duplicateIds.has(t.id) || (t as Record<string, unknown>).lifecycle === "deleted") return;
    const did = (t as Record<string, unknown>).displayId;
    if (typeof did === "string" && did.length > 0) byDisplay.set(did, [...(byDisplay.get(did) ?? []), i]);
  });
  for (const [did, at] of byDisplay) {
    if (at.length < 2) continue;
    const ids = at.map((i) => tickets[i]!.id);
    const named = files ? at.map((i) => files[i]!) : [];
    diagnostics.push({
      code: "display-id-collision",
      key: did,
      files: named,
      ids,
      message: `Display id ${did} is carried by ${at.length} tickets (${ids.join(", ")}); all are counted. Run storybloq reconcile.`,
    });
  }
  return { counted, duplicateIds, diagnostics };
}
