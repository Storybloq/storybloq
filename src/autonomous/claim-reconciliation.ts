import type { Claim } from "../models/types.js";

/**
 * Claim reality reconciliation (T-442, canonical fix for ISS-784).
 *
 * A session claims a ticket at PICK_TICKET, confirms it at PLAN, and until this
 * module existed never looked again. In a shared repo the merge driver arbitrates
 * the ticket-claim group by latest `claim.since`, so a merge can hand the claim to
 * another agent mid-IMPLEMENT; the guide advanced anyway and eventually completed
 * the ticket out from under the winner.
 *
 * Two ticket fields carry ownership and NEITHER is sufficient alone:
 *   - `claimedBySession` -- session uuid, written by the pipeline
 *   - `claim {user,branch,since}` -- user-level, rewritten by the merge driver
 *
 * A merge changes the second without touching the first, so
 * `{ claimedBySession: A, claim.user: B }` is reachable. Ownership therefore means
 * BOTH fields still match the epoch recorded when the claim was acquired.
 *
 * Everything here is pure: no fs, no git, no clock. `now` is injected.
 */

/** Presence tracked separately from value: an absent key differs from an explicit null. */
export interface Field<T> {
  readonly present: boolean;
  readonly value: T | null;
}

/** The token a session records when it legitimately acquires a claim. */
export interface ClaimEpoch {
  readonly ticketId: string;
  readonly sessionId: string;
  readonly user: string | null;
  readonly branch: string | null;
  readonly since: string | null;
  readonly establishedAt: string;
}

/** The claim-bearing slice of a ticket, read straight from the ledger. */
export interface TicketClaimState {
  readonly found: boolean;
  readonly status: string | null;
  readonly claimedBySession: Field<string>;
  readonly claim: Field<Claim>;
}

export interface ClaimConflictDetail {
  readonly kind: "session" | "user" | "inconsistent" | "released";
  readonly sessionHolder: string | null;
  readonly userHolder: string | null;
  readonly since: string | null;
}

export type ClaimReconciliation =
  | { readonly status: "held" }
  | { readonly status: "conflicted"; readonly detail: ClaimConflictDetail }
  | { readonly status: "recovery-required"; readonly reason: "target-unreadable" | "epoch-unverifiable" };

export interface ReconcileClaimInput {
  readonly epoch: ClaimEpoch;
  readonly ticket: TicketClaimState;
  readonly claimStalenessHours: number;
  readonly now: number;
}

function claimMatchesEpoch(claim: Claim, epoch: ClaimEpoch): boolean {
  return claim.user === epoch.user && claim.branch === epoch.branch && claim.since === epoch.since;
}

export function reconcileClaim(input: ReconcileClaimInput): ClaimReconciliation {
  const { epoch, ticket } = input;

  // Fail closed when the target cannot be read at all. Classifying WHY (deleted,
  // renamed, completed elsewhere) is T-443's job; stopping is this one's.
  if (!ticket.found) {
    return { status: "recovery-required", reason: "target-unreadable" };
  }

  const epochHadClaim = epoch.user !== null || epoch.sessionId.length > 0;
  const ledgerHasNothing = !ticket.claimedBySession.present && !ticket.claim.present;

  // Checked before the mismatch split below: "both fields gone" is a release, not
  // two independent disagreements, and reporting it as `inconsistent` would name
  // holders that do not exist.
  if (epochHadClaim && ledgerHasNothing) {
    return {
      status: "conflicted",
      detail: { kind: "released", sessionHolder: null, userHolder: null, since: null },
    };
  }

  const sessionHolder = ticket.claimedBySession.value;
  const sessionMismatch = sessionHolder !== epoch.sessionId;

  const ledgerClaim = ticket.claim.present ? ticket.claim.value : null;
  const userHolder = ledgerClaim ? ledgerClaim.user : null;
  // A null-user epoch records that NO claim key was written at acquisition, so
  // matching it demands the key still be absent. An explicitly present `null`
  // is a different ledger state and must not read as equal (ISS-759 gates on
  // key presence, not truthiness). A partially populated epoch -- null user but
  // a surviving branch or since -- is malformed and can never prove ownership.
  const userMismatch = epoch.user === null
    ? ticket.claim.present || epoch.branch !== null || epoch.since !== null
    : ledgerClaim === null || !claimMatchesEpoch(ledgerClaim, epoch);

  if (sessionMismatch || userMismatch) {
    const kind = sessionMismatch && userMismatch ? "inconsistent" : sessionMismatch ? "session" : "user";
    return {
      status: "conflicted",
      detail: { kind, sessionHolder, userHolder, since: ledgerClaim ? ledgerClaim.since : null },
    };
  }

  // Both fields still ours. A status other than inprogress means something moved
  // the ticket -- our own authorized completion, an external reopen, a foreign
  // completion, or a crash after release. Only a transaction marker distinguishes
  // ours from theirs, and there is deliberately no "but this session caused it" escape
  // hatch: an escape hatch is only sound if the evidence is AUTHENTICATED against
  // the ticket, and TypeScript's structural typing cannot make a plain field
  // unforgeable -- any caller could invent one and bypass both ownership checks
  // below. The authenticated form (an opaque value constructible only by
  // `recoverClaimTransaction` after it matches the ticket-side nonce and the exact
  // expected postimage) arrives with ISS-896. Until then this fails closed.
  if (ticket.status !== "inprogress") {
    return { status: "recovery-required", reason: "epoch-unverifiable" };
  }

  // Deliberately no renewal branch. Bumping `claim.since` is exactly how a claim
  // WINS latest-wins merge arbitration, so renewing a stale claim on an old branch
  // can resurrect a merge-loser and evict the real holder. A stale claim that is
  // still exactly ours is simply held. See ISS-894.
  return { status: "held" };
}

// ---------------------------------------------------------------------------
// Claim transactions
// ---------------------------------------------------------------------------

/**
 * The ticket is a git-tracked project file; the epoch lives in gitignored session
 * state. They cannot be written atomically, so every claim transition runs as a
 * five-step transaction:
 *
 *   1. write intent at phase "prepared"
 *   2. under the project lock, verify the whole preimage and mutate the ticket,
 *      stamping it with `claimTxnId`
 *   3. atomically write toEpoch AND phase "ticket_applied" in one session write
 *   4. remove the ticket nonce
 *   5. clear the intent
 *
 * Recovery is a predicate over three INDEPENDENT axes: phase, business snapshot,
 * and nonce. The nonce is deliberately not part of the snapshot -- step 4 must
 * match "postimage with nonce" and step 5 "postimage with nonce absent", which one
 * combined value cannot do.
 */
export interface TicketSnapshot {
  readonly ticketId: string;
  readonly lifecycle: Field<string>;
  readonly status: Field<string>;
  readonly completedDate: Field<string>;
  readonly claim: Field<Claim>;
  readonly claimedBySession: Field<string>;
}

export interface ClaimTxn {
  readonly kind: "acquire" | "release" | "complete";
  readonly phase: "prepared" | "ticket_applied";
  readonly ticketId: string;
  readonly transitionId: string;
  readonly fromEpoch: ClaimEpoch | null;
  readonly toEpoch: ClaimEpoch | null;
  readonly fromBusiness: TicketSnapshot;
  readonly toBusiness: TicketSnapshot;
  readonly startedAt: string;
}

export type ClaimTxnAction =
  | "apply-mutation"
  | "commit-epoch"
  | "remove-nonce"
  | "clear-intent"
  | "recovery-required";

/**
 * Structural, key-order-independent equality. `JSON.stringify` was wrong here:
 * a merge driver or formatter that rewrites a ticket with the same claim fields
 * in a different key order would have forced `recovery-required` on a business
 * snapshot that never actually changed.
 */
function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => valueEquals(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && valueEquals(ao[k], bo[k]));
}

function fieldEquals<T>(a: Field<T>, b: Field<T>): boolean {
  if (a.present !== b.present) return false;
  return valueEquals(a.value ?? null, b.value ?? null);
}

function snapshotEquals(a: TicketSnapshot, b: TicketSnapshot): boolean {
  return a.ticketId === b.ticketId &&
    fieldEquals(a.lifecycle, b.lifecycle) &&
    fieldEquals(a.status, b.status) &&
    fieldEquals(a.completedDate, b.completedDate) &&
    fieldEquals(a.claim, b.claim) &&
    fieldEquals(a.claimedBySession, b.claimedBySession);
}

export function recoverClaimTransaction(
  txn: ClaimTxn,
  observed: { readonly observed: TicketSnapshot; readonly nonce: string | null },
): { readonly action: ClaimTxnAction } {
  const isFrom = snapshotEquals(observed.observed, txn.fromBusiness);
  const isTo = snapshotEquals(observed.observed, txn.toBusiness);
  const ours = observed.nonce === txn.transitionId;
  const bare = observed.nonce === null;

  if (txn.phase === "prepared") {
    if (isFrom && bare) return { action: "apply-mutation" };
    if (isTo && ours) return { action: "commit-epoch" };
    // Our postimage WITHOUT the nonce is genuinely ambiguous here: a foreign actor
    // can produce the same status and claim shape. Only under "ticket_applied" is
    // that observation legal, which is why the phase is persisted.
    return { action: "recovery-required" };
  }

  if (isTo && ours) return { action: "remove-nonce" };
  if (isTo && bare) return { action: "clear-intent" };
  return { action: "recovery-required" };
}
