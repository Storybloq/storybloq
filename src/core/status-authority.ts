/**
 * The lifecycle authorisation every non-CLI status change goes through
 * (T-538 S3a-1 review finding 1; reused by S3a-2's setup-verify). A writer
 * that moves a ticket into or out of complete asks `authoriseStatusChange`
 * first, inside the lock and before it prepares its transaction, and writes
 * nothing when the answer is a refusal.
 *
 * It applies the same rules `storybloq ticket update` applies, without a
 * force path:
 * - completing: `clearClaimOnComplete` against the caller's ownership
 *   evidence (both `claim.user` and `claimedBySession`); the caller then
 *   writes it through `prepareCompletionWrite` (checkpoint-evidence.ts), which
 *   applies the owner checkpoint rule and records the evidence, as
 *   `completeDependent` does for the ticket CLI;
 * - reopening: `guardCompletedTicketMutation` when the ticket carries claim
 *   material; a claim-free reopen only when the caller's policy names it.
 */
import type { Ticket } from "../models/ticket.js";
import type { ClaimEpoch } from "../autonomous/claim-reconciliation.js";
import { clearClaimOnComplete, guardCompletedTicketMutation, hasClaimMaterial, type CompletionGuardOptions } from "./claims.js";
import { clearSameSessionEarmark } from "./earmarks.js";

/**
 * The session store could not be read: no proof that no session is running.
 * `unreadable` is set when the scan worked but an entry that may hold this
 * ticket's epoch could not be read; its message names that entry (ISS-1402).
 */
export class CompletionOwnershipUnavailable extends Error {
  constructor(message: string, readonly unreadable = false) {
    super(message);
  }
}

/**
 * The caller's ownership evidence for a status change: its git identity and
 * the epoch of the local active session, if any. A scan that fails, or an
 * entry it cannot read (which may hold this ticket's epoch), throws
 * `CompletionOwnershipUnavailable` rather than reading as "none" (ISS-1402).
 */
export async function collectCompletionOwnership(root: string): Promise<CompletionGuardOptions> {
  let completingUser: string | null = null;
  try {
    const { gitUserEmail } = await import("../autonomous/git-inspector.js");
    completingUser = await gitUserEmail(root);
  } catch {
    // Identity unavailable counts as unproven, not as permission.
  }

  const activeEpochs: ClaimEpoch[] = [];
  let unreadable: string | null = null;
  try {
    const { findActiveSessionDetailed, describeUnreadableSessionEntry } = await import("../autonomous/session.js");
    const scan = findActiveSessionDetailed(root);
    if (scan.unreadable.length > 0) unreadable = describeUnreadableSessionEntry(scan.unreadable[0]!);
    const active = scan.match;
    // Only status "active" records veto. Archived and superseded ones retain a
    // stale epoch for the ticket forever, and scanning them would block every
    // later legitimate claimant.
    const epoch = active && active.state.status === "active"
      ? (active.state as Record<string, unknown>).claimEpoch as ClaimEpoch | undefined
      : undefined;
    if (epoch) activeEpochs.push(epoch);
  } catch (err) {
    throw new CompletionOwnershipUnavailable(err instanceof Error ? err.message : String(err));
  }
  // An entry the scan could not read may be the session holding this ticket: no veto set can be trusted.
  if (unreadable !== null) throw new CompletionOwnershipUnavailable(unreadable, true);

  return { completingUser, activeEpochs };
}

export type StatusDecision =
  | { readonly ok: true; readonly ticket: Ticket }
  | { readonly ok: false; readonly reason: string };

export interface StatusPolicy {
  /** Whether a reopen of a complete ticket with no claim material is this caller's to make. */
  readonly claimFreeReopen: boolean;
}

/**
 * Decides whether `existing` may become `next` (every other change already
 * applied by the caller), returning the ticket to write: a completion strips
 * the claim (and still goes through `prepareCompletionWrite`). A change that keeps the status
 * is not a lifecycle change and passes unchanged.
 */
export function authoriseStatusChange(
  existing: Ticket,
  next: Ticket,
  guard: CompletionGuardOptions,
  policy: StatusPolicy,
  label: string,
): StatusDecision {
  if (next.status === "complete") {
    // A no-op touches nothing; any other write to complete work is authorised, as the ticket updater does.
    if (existing.status === "complete" && JSON.stringify(existing) === JSON.stringify(next)) return { ok: true, ticket: next };
    const completion = clearClaimOnComplete(next, guard);
    if (completion.rejected) {
      return { ok: false, reason: `Cannot complete ${label}: it is claimed by ${next.claim?.user ?? "another session"} and this caller cannot prove ownership${guard.completingUser === null ? " (git user.email is not configured)" : ""}.` };
    }
    let ticket = completion.ticket;
    if (existing.claimedBySession) ticket = clearSameSessionEarmark(ticket, existing.claimedBySession).item;
    return { ok: true, ticket };
  }

  if (existing.status === "complete") {
    const authorized = hasClaimMaterial(existing) ? guardCompletedTicketMutation(existing, guard).authorized : policy.claimFreeReopen;
    if (!authorized) return { ok: false, reason: `Cannot reopen ${label}: it is complete and this caller cannot prove ownership.` };
  }
  return { ok: true, ticket: next };
}
