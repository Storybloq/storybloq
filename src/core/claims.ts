import type { Claim } from "../models/types.js";
import type { Ticket } from "../models/ticket.js";
import type { Recommendation } from "./recommend.js";
import type { ClaimEpoch } from "../autonomous/claim-reconciliation.js";

export interface CanClaimResult {
  allowed: boolean;
  claimedBy?: string;
}

export function buildClaim(user: string, branch: string, since: string): Claim {
  return { user, branch, since };
}

export function canClaim(
  ticket: Ticket,
  user: string,
  branch: string,
  force?: boolean,
): CanClaimResult {
  if (!ticket.claim) {
    return { allowed: true };
  }
  if (ticket.claim.user === user && ticket.claim.branch === branch) {
    return { allowed: true };
  }
  if (force) {
    return { allowed: true };
  }
  return { allowed: false, claimedBy: ticket.claim.user };
}

export function isClaimStale(
  claim: Claim,
  thresholdHours: number,
  nowMs?: number,
): boolean {
  const since = Date.parse(claim.since);
  if (isNaN(since)) return true;
  const now = nowMs ?? Date.now();
  const ageHours = (now - since) / (1000 * 60 * 60);
  return ageHours > thresholdHours;
}

/** Autonomous ownership means a NON-NULL session uuid, not merely a present key. */
function sessionOwnerOf(ticket: Ticket): string | null {
  const value = (ticket as Record<string, unknown>).claimedBySession;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripClaimKeys(ticket: Ticket): Ticket {
  const { claim: _claim, claimedBySession: _session, ...rest } = ticket;
  return rest as Ticket;
}

/**
 * Exact match between a ticket's `claim` and the epoch that recorded it.
 *
 * A null-user epoch records that no claim key existed at acquisition, so it
 * matches only a ticket where the key is still ABSENT -- an explicitly present
 * `null` is a different ledger state (ISS-759 gates on key presence, not
 * truthiness). Such an epoch must also carry null branch and since; a partially
 * populated one is malformed and can never prove ownership.
 */
function claimMatchesEpoch(ticket: Ticket, epoch: ClaimEpoch): boolean {
  if (epoch.user === null) {
    if (epoch.branch !== null || epoch.since !== null) return false;
    return !("claim" in ticket);
  }
  const claim = ticket.claim;
  if (!claim) return false;
  return claim.user === epoch.user && claim.branch === epoch.branch && claim.since === epoch.since;
}

/**
 * Whether `ticket` provably matches `epoch` on BOTH ownership fields (T-442):
 * the ticket id itself, the session stamp, and the `claim` block. Extracted
 * from `releaseClaimIfOwned` (ISS-913) so a second caller -- the crash-recovery
 * replay in `recoverPendingMutation` -- can run the identical proof inside its
 * own project lock instead of trusting an `expectedCurrent` status match, which
 * is not ownership: `{claimedBySession: us, claim.user: rival}` is reachable via
 * the merge driver and passes a status-only check.
 */
export function provenOwnership(ticket: Ticket, epoch: ClaimEpoch): boolean {
  if (ticket.id !== epoch.ticketId) return false;
  if (sessionOwnerOf(ticket) !== epoch.sessionId) return false;
  if (!claimMatchesEpoch(ticket, epoch)) return false;
  return true;
}

/**
 * Releases a claim only when the caller provably owns BOTH ownership fields
 * (T-442). Six sites released claims before this existed, and every one of them
 * accepted `claimedBySession === sessionId` and then deleted BOTH keys. In the
 * reachable split state `{ claimedBySession: A, claim.user: B }` -- produced
 * whenever the merge driver hands `claim.user` to B without touching A's stamp --
 * session A therefore destroyed B's winning claim. Three of those sites (the
 * skip_ticket paths in plan.ts, plan-review.ts, code-review.ts) checked only the
 * stamp and were never hardened by ISS-778/ISS-816 at all.
 *
 * There is deliberately no bare-ticket fallback. A ticket carrying no claim
 * material has no provable owner, so reopening it is not an ownership-preserving
 * operation; those route to recovery or an explicit administrative force path.
 */
export function releaseClaimIfOwned(
  ticket: Ticket,
  epoch: ClaimEpoch,
): { released: boolean; ticket: Ticket } {
  if (!provenOwnership(ticket, epoch)) return { released: false, ticket };

  // ISS-759/ISS-652: delete the keys rather than writing explicit nulls, so a
  // released ticket carries no residual state.
  return { released: true, ticket: { ...stripClaimKeys(ticket), status: "open" as const } };
}

/**
 * Session-side release used by the skip/abandon paths (T-442).
 *
 * With an epoch this is exactly `releaseClaimIfOwned`: both ownership fields must
 * match, so the split state `{ claimedBySession: us, claim.user: them }` is left
 * alone instead of having the other user's winning claim deleted.
 *
 * Without an epoch -- a session that started before T-442, or one that never
 * reached PLAN -- there is no proof to check against, and this deliberately keeps
 * the pre-T-442 behavior (stamp matches, both keys go). Narrowing it here would
 * regress ISS-759's guarantee that a released ticket carries no residual claim
 * keys, and the residual exposure is bounded: releasing only returns the ticket
 * to `open`, claims are advisory, and the severe half of ISS-784 -- completing a
 * ticket out from under its holder -- is guarded by clearClaimOnComplete
 * regardless of epoch. Epoch-less sessions drain out as sessions turn over.
 */
export function releaseSessionClaim(
  ticket: Ticket,
  sessionId: string,
  epoch?: ClaimEpoch | null,
): { released: boolean; ticket: Ticket } {
  if (epoch) return releaseClaimIfOwned(ticket, epoch);

  if (sessionOwnerOf(ticket) !== sessionId) return { released: false, ticket };

  return { released: true, ticket: { ...stripClaimKeys(ticket), status: "open" as const } };
}

export interface CompletionGuardOptions {
  /** Git identity of the caller, or null when it could not be resolved. */
  readonly completingUser: string | null;
  /** Epochs held by local sessions with status "active" that target this ticket. */
  readonly activeEpochs?: readonly ClaimEpoch[];
  /** Status to restore when a completion is rejected. */
  readonly previousStatus?: Ticket["status"];
  /**
   * Administrative bypass (`--force`). Expressed as an explicit flag rather than
   * as a maximally-permissive options object, because the two-field rule now
   * REJECTS on an empty epoch set: a permissive-looking object would have been
   * indistinguishable from "discovery found nothing", which must fail closed.
   */
  readonly authorized?: boolean;
}

/**
 * Strips a completed ticket's claim, refusing when the caller cannot prove the
 * claim is theirs (T-442, the ISS-784 regression point).
 *
 * Rejection is total rather than "complete but keep the claim": completing the
 * ticket is itself the harm to the session still working on it, and a claim left
 * on a complete ticket manufactures the invalid `claim_on_complete` state
 * team-doctor reports.
 *
 * The matrix splits on BOTH fields, because an email match alone would let an
 * autonomous ticket bypass the completion transaction, while a claim-only CLI
 * ticket has no session state to transact in.
 */
export function clearClaimOnComplete(
  ticket: Ticket,
  options?: CompletionGuardOptions,
): { rejected: boolean; ticket: Ticket } {
  if (ticket.status !== "complete") return { rejected: false, ticket };
  if (options?.authorized) {
    const hadKeys = ("claim" in ticket) || ("claimedBySession" in ticket);
    return { rejected: false, ticket: hadKeys ? stripClaimKeys(ticket) : ticket };
  }

  const hasClaim = ticket.claim != null;
  const hasAnyKey = ("claim" in ticket) || ("claimedBySession" in ticket);

  // Legacy: nothing to authorize against. Residual keys are still stripped so a
  // present-but-null claimedBySession does not survive on disk (ISS-759).
  if (!hasClaim && sessionOwnerOf(ticket) === null) {
    return { rejected: false, ticket: hasAnyKey ? stripClaimKeys(ticket) : ticket };
  }

  const reject = () => ({
    rejected: true,
    ticket: { ...ticket, status: options?.previousStatus ?? ("inprogress" as const) },
  });

  if (hasClaim) {
    // Unresolvable identity counts as unproven, not as permission.
    if (!options || options.completingUser === null) return reject();
    if (ticket.claim!.user !== options.completingUser) return reject();
  }

  // The two ownership fields are INDEPENDENT, so a matching email proves only the
  // `claim` half. A non-null `claimedBySession` names an autonomous session that
  // may still be mid-flight, and email cannot separate two sessions running under
  // one repo's git config. Clearing that stamp therefore requires a positively
  // matching epoch from a live local session -- not merely the absence of a
  // conflicting one, which is what an empty veto set would have meant.
  //
  // Consequence: an ORPHANED stamp left by a crashed session no longer completes
  // silently. That is the intended reading -- the anomaly is surfaced and cleared
  // with the explicit administrative bypass. See ISS-895 for positive caller
  // identity, which would let this authorize without a live session.
  const stampOwner = sessionOwnerOf(ticket);
  if (stampOwner !== null) {
    const epochs = options?.activeEpochs;
    if (!epochs || epochs.length === 0) return reject();
    const proven = epochs.some((epoch) =>
      epoch.ticketId === ticket.id &&
      epoch.sessionId === stampOwner &&
      claimMatchesEpoch(ticket, epoch),
    );
    if (!proven) return reject();
  }

  // Any OTHER active session targeting this ticket vetoes the completion, even
  // when the stamp above checked out: a second live claimant means the ledger is
  // contested and completing would resolve that contest by force.
  for (const epoch of options?.activeEpochs ?? []) {
    if (epoch.ticketId !== ticket.id) continue;
    if (epoch.sessionId !== stampOwner) return reject();
  }

  return { rejected: false, ticket: stripClaimKeys(ticket) };
}

/**
 * Whether `guard` proves the caller may mutate an already-complete `existing`
 * ticket -- a transition OUT of complete, or any field change while it stays
 * complete (ISS-981). `clearClaimOnComplete` only runs its ownership check for
 * transitions INTO complete; both other shapes bypass it entirely today.
 *
 * ISS-981's own filing names the claim-FREE case -- the common shape, since a
 * successful completion strips claim keys -- as the headline defect: "no
 * claim, no --force" lets any caller reopen or rewrite a ticket a session just
 * finished. `clearClaimOnComplete`'s "legacy: nothing to authorize against"
 * pass is correct for ITS OWN direction (completing an unclaimed ticket steals
 * nothing from anyone), but reusing that polarity here would leave exactly
 * the gap ISS-981 exists to close, so a claim-free ticket is NOT authorized
 * by default -- `--force` (`guard.authorized`) is the only path for it.
 *
 * A claim-bearing ticket (the ISS-913 "contradictory" shape, or any other
 * reason completion never stripped it) still delegates to
 * `clearClaimOnComplete` against the UNCHANGED `existing` ticket: that asks
 * exactly "would completing this ticket right now be authorized," the same
 * proof a mutation of already-complete work should require, and reuses its
 * proven-ownership/epoch-veto matrix rather than re-deriving it.
 * `clearClaimOnComplete`'s own side effects (status/claim rewrite) are
 * discarded; only its authorization verdict is used.
 */
export function guardCompletedTicketMutation(
  existing: Ticket,
  guard: CompletionGuardOptions,
): { authorized: boolean } {
  if (guard.authorized) return { authorized: true };
  const hasClaim = existing.claim != null;
  const hasSessionStamp = sessionOwnerOf(existing) !== null;
  if (!hasClaim && !hasSessionStamp) return { authorized: false };
  const probe = clearClaimOnComplete(existing, guard);
  return { authorized: !probe.rejected };
}

// Claimed-by-others items are downranked far below unclaimed work but never
// hidden (N-059 decision #22: claims are advisory, surfaced and downranked, not
// removed). The max generator score is ~1000, so this penalty guarantees a
// claimed-by-others candidate sinks beneath every unclaimed one while keeping
// the relative order among claimed items.
const CLAIM_DOWNRANK_PENALTY = 10000;

/// Annotates recommendations with their claim and downranks those claimed by
/// another user (or by anyone, when the current identity is unknown). It never
/// removes a recommendation -- claims are advisory. ISS-681.
export function applyClaimAnnotations(
  recommendations: readonly Recommendation[],
  claims: ReadonlyMap<string, Claim>,
  currentUser: string | null,
): Recommendation[] {
  if (claims.size === 0) {
    return [...recommendations];
  }
  return recommendations.map((rec) => {
    const claim = claims.get(rec.id);
    if (!claim) return rec;
    // Own claim: surface it, no penalty.
    if (currentUser !== null && claim.user === currentUser) {
      return { ...rec, claim };
    }
    // Claimed by another user, or identity unknown (currentUser === null):
    // annotate and downrank, never hide.
    return {
      ...rec,
      claim,
      score: rec.score - CLAIM_DOWNRANK_PENALTY,
      reason: `${rec.reason} (claimed by ${claim.user})`,
    };
  });
}
