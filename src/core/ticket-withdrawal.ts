/**
 * T-486 U2-6: what stops a ticket from being withdrawn. A withdrawn ticket
 * never releases the tickets waiting on it, and a withdrawn leaf holds every
 * umbrella above it (project-state.ts, `dependencyRelease`), so a withdrawal
 * with a live dependent would strand that dependent. The setter runs this
 * early for a clear message; the authority is the check at the withdrawal's
 * own commit (project-loader.ts, `assertWithdrawalLedgerCurrent`).
 *
 * crossNodeBlockedBy edges are not checked: orchestrator diagnostics own them.
 */
import type { Ticket } from "../models/ticket.js";
import { ProjectLoaderError } from "./errors.js";
import { isDeleted, type ProjectState } from "./project-state.js";
import { displayIdOf } from "./resolver.js";

/**
 * Why `ticket` cannot be withdrawn on `graph`, empty when it can. An umbrella
 * is refused outright. Otherwise every live ticket whose blockedBy resolves to
 * the ticket, or to any ancestor of it in either child list, is named with its
 * edge. `graph` must hold `ticket` as it will be written.
 */
export function withdrawalRefusals(graph: ProjectState, ticket: Ticket): string[] {
  const label = displayIdOf(ticket);
  if (graph.hasAnyChild(ticket.id)) return [`${label} has child tickets; withdraw its open children instead`];
  const ancestors = new Map<string, string>();
  const seen = new Set<string>([ticket.id]);
  let frontier: string[] = [ticket.id];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const parent of graph.parentsOf(id)) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        const found = graph.ticketByID(parent);
        ancestors.set(parent, found ? displayIdOf(found) : parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  const edges: string[] = [];
  for (const dependent of graph.tickets) {
    if (isDeleted(dependent) || dependent.id === ticket.id) continue;
    for (const ref of dependent.blockedBy) {
      const resolved = graph.resolveTicketRef(ref);
      if (resolved.kind !== "found") continue;
      if (resolved.item.id === ticket.id) edges.push(`${displayIdOf(dependent)} blockedBy ${label}`);
      else if (ancestors.has(resolved.item.id)) edges.push(`${displayIdOf(dependent)} blockedBy umbrella ${ancestors.get(resolved.item.id)} (ancestor of ${label})`);
    }
  }
  return edges;
}

/** Throws when `withdrawalRefusals` names anything. */
export function assertWithdrawable(graph: ProjectState, ticket: Ticket): void {
  const refusals = withdrawalRefusals(graph, ticket);
  if (refusals.length === 0) return;
  const edges = graph.hasAnyChild(ticket.id) ? "" : "; retarget or remove the edges";
  throw new ProjectLoaderError("conflict", `Cannot withdraw ${displayIdOf(ticket)}: ${refusals.join("; ")}${edges}.`);
}
