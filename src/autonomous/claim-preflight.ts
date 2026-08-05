import type { Ticket } from "../models/ticket.js";
import type { Claim } from "../models/types.js";
import type { SessionState } from "./session-types.js";
import {
  reconcileClaim,
  type ClaimEpoch,
  type ClaimReconciliation,
  type Field,
  type TicketClaimState,
} from "./claim-reconciliation.js";

/**
 * The impure edge of T-442: read the ledger, hand it to the pure reconciler.
 *
 * This runs at the top of every guide entry point that can advance or finish a
 * session (report, resume, pre_compact, cancel) and BEFORE `recoverPendingMutation`.
 * Ordering matters: recovery replays a mutation the session prepared while it
 * still believed it held the claim, so replaying first would let a session that
 * has already lost the ticket write to it one more time.
 */

const DEFAULT_CLAIM_STALENESS_HOURS = 24;

/**
 * The states in which reconciliation applies: after the claim is confirmed at
 * PLAN and before the session begins writing its own completion.
 *
 * FINALIZE onward is deliberately excluded. FINALIZE instructs the agent to set
 * the ticket to `complete` in the ledger BEFORE the session's draft ticket is
 * cleared, so from the preflight's vantage point a session's own authorized
 * completion is indistinguishable from a foreign one -- both leave a `complete`
 * ticket with the claim keys stripped. Gating there would block every session at
 * its own finish line. Protection does not lapse: from FINALIZE onward the
 * completion guard (clearClaimOnComplete) is the mechanism, and it refuses any
 * completion the caller cannot prove is theirs. The one case neither covers is a
 * second actor sharing the same git identity, which is ISS-895.
 */
const RECONCILED_STATES: ReadonlySet<string> = new Set([
  // PLAN is included for the revise loop: PLAN_REVIEW can send the session back
  // to PLAN with an epoch already minted, and a takeover in that window would
  // otherwise reach the claim-write short-circuit unchecked. Initial PLAN is
  // unaffected -- it has no epoch yet, so it returns NOT_CHECKED anyway.
  "PLAN",
  "PLAN_REVIEW",
  "IMPLEMENT",
  "WRITE_TESTS",
  "TEST",
  "CODE_REVIEW",
  "BUILD",
  "VERIFY",
]);

function field<T>(container: object, key: string): Field<T> {
  if (!(key in container)) return { present: false, value: null };
  const value = (container as Record<string, unknown>)[key];
  return { present: true, value: (value ?? null) as T | null };
}

/** Absent, malformed, or partially-written epochs all read as "no epoch". */
export function parseClaimEpoch(value: unknown): ClaimEpoch | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.ticketId !== "string" || raw.ticketId.length === 0) return null;
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) return null;
  if (typeof raw.establishedAt !== "string") return null;
  // The nullable slots are parsed STRICTLY: the key must be present and its value
  // must be a string or null. Degrading a malformed value to null is NOT the safe
  // default it appears to be -- an all-null epoch is a legitimate shape that means
  // "no claim key existed at acquisition", and it MATCHES a ticket carrying the
  // session stamp and no `claim`. So a corrupt epoch that lost its user, branch,
  // and since would normalize into a valid bare epoch and prove ownership it never
  // had. Rejecting instead routes it to `epoch-unverifiable`.
  const nullableString = (v: unknown): string | null | undefined =>
    v === null || typeof v === "string" ? v : undefined;
  const user = nullableString(raw.user);
  const branch = nullableString(raw.branch);
  const since = nullableString(raw.since);
  if (user === undefined || branch === undefined || since === undefined) return null;
  if (!("user" in raw) || !("branch" in raw) || !("since" in raw)) return null;

  return { ticketId: raw.ticketId, sessionId: raw.sessionId, user, branch, since, establishedAt: raw.establishedAt };
}

/** Presence-preserving projection of a ticket's two ownership fields. */
export function readTicketClaimState(ticket: Ticket | undefined | null): TicketClaimState {
  if (!ticket) {
    return {
      found: false,
      status: null,
      claimedBySession: { present: false, value: null },
      claim: { present: false, value: null },
    };
  }
  return {
    found: true,
    status: ticket.status ?? null,
    claimedBySession: field<string>(ticket, "claimedBySession"),
    claim: field<Claim>(ticket, "claim"),
  };
}

export interface ClaimPreflightResult {
  /** False for sessions with no epoch (pre-T-442, or before PLAN minted one). */
  readonly checked: boolean;
  readonly epoch: ClaimEpoch | null;
  readonly reconciliation: ClaimReconciliation | null;
}

const NOT_CHECKED: ClaimPreflightResult = { checked: false, epoch: null, reconciliation: null };

export interface ReconcileSessionRealityDeps {
  /** Returns the ticket as stored, or null/undefined when it cannot be read. */
  readonly loadTicket: (ticketId: string) => Promise<Ticket | null | undefined>;
  readonly claimStalenessHours?: number;
  readonly now?: number;
}

/**
 * Reconciles the session's recorded claim against the ledger.
 *
 * Fails OPEN in exactly one direction: a session with no epoch is not checked at
 * all. That is the pre-T-442 compatibility path, and it is safe because such a
 * session never gained the ability to prove ownership in the first place -- it
 * keeps the pre-T-442 behavior rather than being parked on a check it cannot pass.
 * Once an epoch exists, an unreadable ticket fails CLOSED (`recovery-required`).
 */
export async function reconcileSessionReality(
  state: SessionState,
  deps: ReconcileSessionRealityDeps,
): Promise<ClaimPreflightResult> {
  if (!RECONCILED_STATES.has(String(state.state))) return NOT_CHECKED;

  // Absent and malformed are NOT the same thing. The compatibility exception is
  // for sessions that never had an epoch; a present-but-corrupt one (partial
  // write, truncated state, `{}`) would otherwise silently disable reconciliation
  // for a session that DID acquire a claim -- a fail-open in the one place that
  // must fail closed.
  const rawEpoch = (state as Record<string, unknown>).claimEpoch;
  const epochAbsent = rawEpoch === undefined || rawEpoch === null;
  if (epochAbsent) return NOT_CHECKED;

  const epoch = parseClaimEpoch(rawEpoch);
  if (!epoch) {
    return {
      checked: true,
      epoch: null,
      reconciliation: { status: "recovery-required", reason: "epoch-unverifiable" },
    };
  }

  // A session that has moved off the ticket (draft cleared at PLAN failure, or
  // the ticket completed and the walker advanced) has nothing to reconcile.
  if (!state.ticket || state.ticket.id !== epoch.ticketId) return NOT_CHECKED;

  let ticket: Ticket | null | undefined;
  try {
    ticket = await deps.loadTicket(epoch.ticketId);
  } catch {
    ticket = null;
  }

  const reconciliation = reconcileClaim({
    epoch,
    ticket: readTicketClaimState(ticket),
    claimStalenessHours: deps.claimStalenessHours ?? DEFAULT_CLAIM_STALENESS_HOURS,
    now: deps.now ?? Date.now(),
  });

  return { checked: true, epoch, reconciliation };
}

/**
 * Statuses that are NOT a claim loss. An allow-list rather than `!== "held"`
 * so an unknown future status fails CLOSED (reads as a loss) by construction,
 * instead of silently passing until someone remembers to update this check.
 *
 * ISS-965: "completed-consistent" MUST be here. It means the session's own
 * authorized completion left the ticket claim-stripped -- the claim really is
 * gone, but this is not a foreign loss, so it must not read as one.
 */
const NON_LOSS_STATUSES: ReadonlySet<string> = new Set(["held", "completed-consistent"]);

/** True when the preflight found the session no longer provably owns its ticket. */
export function isClaimLost(result: ClaimPreflightResult): boolean {
  return result.checked && result.reconciliation !== null
    && !NON_LOSS_STATUSES.has(result.reconciliation.status);
}

/** Human-readable one-liner for the park handover and the guide instruction. */
export function describeClaimLoss(result: ClaimPreflightResult): string {
  const r = result.reconciliation;
  // Literal comparisons, not NON_LOSS_STATUSES.has(): Set.has() doesn't narrow
  // the discriminated union, so TS can't see r.detail exists past this point.
  if (!r || r.status === "held" || r.status === "completed-consistent") return "";
  if (r.status === "recovery-required") {
    return r.reason === "target-unreadable"
      ? "the ticket could not be read from the ledger"
      : "the ticket left `inprogress` without a transaction proving this session did it";
  }
  const { kind, sessionHolder, userHolder } = r.detail;
  switch (kind) {
    case "released":
      return "the claim was released -- both ownership fields are gone from the ticket";
    case "session":
      return `the session stamp now reads ${sessionHolder ?? "(absent)"}`;
    case "user":
      return `the user claim now belongs to ${userHolder ?? "(absent)"}`;
    default:
      return `both ownership fields changed (session ${sessionHolder ?? "(absent)"}, user ${userHolder ?? "(absent)"})`;
  }
}
