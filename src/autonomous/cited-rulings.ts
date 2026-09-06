/**
 * T-494: resolving the rulings a review target cites, for the review packet.
 *
 * Kept out of `review-context-packet.ts` on purpose: that module does no ledger
 * IO at all, and it receives everything else the same way. Kept out of the three
 * call sites on purpose too, because three inline copies would drift on the one
 * thing that must not drift -- what happens when the ledger cannot be read.
 *
 * Resolution is ALWAYS fresh from disk for THIS item, never from a snapshot on
 * session state (the T-476 acceptance-4 convention, and the T-055 class of bug
 * it exists to prevent: a superseded ruling riding into an instruction as if it
 * were still current).
 */
import { loadProject } from "../core/project-loader.js";
import { loadCitationContext } from "../core/ruling-loader.js";
import { resolveEntityCitations } from "../core/ruling.js";
import type { CitationResolution } from "../core/ruling.js";

/**
 * Either the resolved citations, or a REASON they could not be resolved.
 *
 * There is deliberately no third case that returns an empty list on failure.
 * "This item cites nothing" and "I could not find out what this item cites" are
 * different claims, and collapsing the second into the first is the exact
 * absence-is-zero error this ticket exists to remove: the reviewer would be
 * shown a packet with no rulings and no reason to doubt it.
 */
export type TargetCitations =
  | { readonly kind: "resolved"; readonly citations: readonly CitationResolution[] }
  | { readonly kind: "unavailable"; readonly reason: string };

export async function citationsForReviewTarget(
  root: string,
  targetId: string,
): Promise<TargetCitations> {
  if (targetId === "" || targetId === "unknown") {
    return { kind: "unavailable", reason: "the review target could not be identified" };
  }
  try {
    const { state } = await loadProject(root);
    const ticket = state.resolveTicketRef(targetId);
    const item = ticket.kind === "found" ? ticket.item : null;
    const issue = item === null ? state.resolveIssueRef(targetId) : null;
    const resolvedItem = item ?? (issue?.kind === "found" ? issue.item : null);
    if (resolvedItem === null) {
      return { kind: "unavailable", reason: `${targetId} could not be resolved to a ticket or issue` };
    }
    // Ledger-level unreadability is already REPRESENTED inside the resolutions
    // themselves (`indeterminate`, `unreadable`), so it flows to the reviewer as
    // a per-citation line rather than as an absence. Only a failure to get that
    // far reaches the `unavailable` branch above.
    return { kind: "resolved", citations: resolveEntityCitations(resolvedItem, loadCitationContext(root)) };
  } catch (err) {
    return { kind: "unavailable", reason: `the ledger could not be read (${(err as Error).message})` };
  }
}
