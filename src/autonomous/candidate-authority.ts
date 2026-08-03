/**
 * T-450 step 7a: PER-STATE TAKEOVER AUTHORITY.
 *
 * The five-step handshake in `candidate-recovery.ts` answers "is the recorded
 * owner a recovery candidate, and is the picture the human confirmed still the
 * picture". This module answers the separate question the plan requires and
 * nothing implemented until now: given that the owner IS gone, may this
 * session's WORK be handed to a new owner at all?
 *
 * A single "has a held epoch" rule is wrong in both directions. As a permit it
 * is a fail-open: it says nothing at PICK_TICKET, where no epoch exists yet. As
 * a requirement it is a fail-closed that refuses a long list of legitimate
 * states -- exactly the sessions this ticket exists to rescue. So authority is
 * per workflow state, and the state set is not invented here: the claim-bearing
 * row is `RECONCILED_STATES` (claim-preflight.ts) verbatim, adopting the
 * preflight's boundary rather than inventing a second one.
 *
 * PURE. Every input is a value the caller read; this module performs no I/O, so
 * the whole matrix can be crossed in a table test without a filesystem. What it
 * must never do is guess: a ledger record that could not be READ is its own
 * refusal, never absence, because "we looked and nothing is owed" and "we could
 * not look" lead somewhere different.
 */

import type { WorkflowState, FinalizeCheckpoint, FullSessionState } from "./session-types.js";
import { WORKFLOW_STATES } from "./session-types.js";
import type { ClaimEpoch, ClaimReconciliation } from "./claim-reconciliation.js";
import { parseClaimEpoch } from "./claim-preflight.js";
import type { Ticket } from "../models/ticket.js";

// ---------------------------------------------------------------------------
// Postures
// ---------------------------------------------------------------------------

export type TakeoverPosture =
  | "pre-acquisition"
  | "claim-bearing"
  | "issue-work"
  | "own-completion-window"
  | "post-completion-boundary"
  | "not-reachable";

/**
 * PLAN is the one state whose posture is not fixed. plan.md puts it in two
 * rows: before an epoch is minted it is pre-acquisition, and after (the
 * PLAN_REVIEW revise loop sends the session back with one already minted) it is
 * claim-bearing. Mapping it to a marker keeps the table below TOTAL without
 * lying about which row it is in.
 */
type PostureRule = TakeoverPosture | "plan-epoch-dependent";

/**
 * Every workflow state, exhaustively. `satisfies Record<WorkflowState, ...>` is
 * the point of this declaration: a state added to WORKFLOW_STATES later fails
 * COMPILATION here rather than silently inheriting whichever arm a runtime
 * default happened to pick.
 */
const POSTURE_BY_STATE = {
  INIT: "pre-acquisition",
  LOAD_CONTEXT: "pre-acquisition",
  PICK_TICKET: "pre-acquisition",
  PLAN: "plan-epoch-dependent",
  PLAN_REVIEW: "claim-bearing",
  IMPLEMENT: "claim-bearing",
  WRITE_TESTS: "claim-bearing",
  TEST: "claim-bearing",
  CODE_REVIEW: "claim-bearing",
  BUILD: "claim-bearing",
  VERIFY: "claim-bearing",
  FINALIZE: "own-completion-window",
  // The candidate flow is non-COMPACT only, and a terminal session is refused
  // by the handshake's own C3 gate before this module is reached. Both are
  // rows rather than omissions so the `satisfies` pin stays total.
  COMPACT: "not-reachable",
  HANDOVER: "post-completion-boundary",
  COMPLETE: "post-completion-boundary",
  LESSON_CAPTURE: "post-completion-boundary",
  ISSUE_FIX: "issue-work",
  ISSUE_SWEEP: "post-completion-boundary",
  SESSION_END: "not-reachable",
} satisfies Record<WorkflowState, PostureRule>;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type TakeoverRefusalReason =
  | "unknown-state"
  | "not-reachable"
  | "ledger-unreadable"
  | "claim-not-acquirable"
  | "claim-not-held"
  | "claim-epoch-malformed"
  | "residual-claim"
  | "issue-not-resolvable"
  | "finalize-shape-inconsistent"
  | "finalize-item-unresolvable"
  | "finalize-baseline-missing";

export type TakeoverAuthority =
  | { readonly kind: "permitted"; readonly posture: TakeoverPosture }
  | {
      readonly kind: "refused";
      readonly posture: TakeoverPosture | "unknown-state";
      readonly reason: TakeoverRefusalReason;
      readonly detail: string;
    };

/**
 * A ledger read the caller performed, kept as a three-way value rather than
 * `T | null`. `unreadable` is the arm that stops this module from spelling a
 * failed read the same way as a positive finding of absence.
 */
export type LedgerRead<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly detail: string };

/** The ledger issue slice this module needs. */
export interface IssueAuthorityView {
  readonly id: string;
  readonly status: string;
}

export interface TakeoverAuthorityInput {
  /** The session state, read FRESH by the caller under whatever lock it holds. */
  readonly state: FullSessionState;
  /** The ledger ticket for the resolved ticket identity, if there is one. */
  readonly ticket: LedgerRead<Ticket>;
  /** The ledger issue for `state.currentIssue`, if there is one. */
  readonly issue: LedgerRead<IssueAuthorityView>;
  /** The handshake's reconciliation verdict, or "not-checked" when no epoch. */
  readonly reconciliation: ClaimReconciliation["status"] | "not-checked";
}

// ---------------------------------------------------------------------------
// The shared acquisition predicate
// ---------------------------------------------------------------------------

/** The draft claim PickTicket records and PlanStage compares against. */
export interface DraftClaim {
  readonly user: string;
  readonly branch: string;
  readonly since: string;
}

/**
 * `PlanStage`'s acquisition rule, extracted so takeover and the pipeline cannot
 * drift. Requiring a WHOLLY UNCLAIMED target would be stricter than the rule
 * the pipeline actually applies, and would therefore refuse a recovery the
 * ordinary path would have allowed.
 *
 * The `ticket.claim` arm is ISS-759 and is load-bearing: a per-ticket-branch
 * session legitimately holds a claim from a previous branch of the SAME user,
 * so only a FOREIGN user's claim blocks. A claim present with no draft to
 * compare against blocks, because there is then nothing that could prove it
 * ours.
 */
export function canAcquireTicketClaim(
  ticket: Pick<Ticket, "status"> & Record<string, unknown>,
  sessionId: string,
  draftClaim: DraftClaim | undefined,
): boolean {
  const claimedBySession = ticket.claimedBySession as string | undefined;
  if (ticket.status === "inprogress" && claimedBySession === sessionId) return true;
  if (ticket.status !== "open") return false;
  if (claimedBySession && claimedBySession !== sessionId) return false;
  const claim = ticket.claim as { user?: string } | undefined;
  if (claim && draftClaim) return claim.user === draftClaim.user;
  if (claim && !draftClaim) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Claim signals
// ---------------------------------------------------------------------------

/**
 * What the LEDGER says about a live claim, and what the session's epoch says
 * about identity. The split matters, and getting it wrong is the single most
 * repeated mistake in this design's review history.
 *
 * A retained `claimEpoch` is NOT an active claim. Nothing in FinalizeStage or
 * CompleteStage clears it (the only clears are PlanStage abandoning a draft and
 * the park stage), so EVERY healthy post-completion session still carries one.
 * `pendingTicketClaim` is the same: written at pick, cleared only on those same
 * two paths, so a normal completed session carries it too. Counting either as
 * an active claim would refuse takeover on every ordinary COMPLETE session.
 * They are session-side acquisition metadata; only the ledger says a claim is
 * live.
 */
export interface ClaimSignals {
  /** L1: the ledger ticket carries a session stamp. */
  readonly ledgerSessionStamp: "ours" | "foreign" | null;
  /** L2: the ledger ticket carries a claim record. */
  readonly ledgerClaim: boolean;
  /** E1: an epoch is present and does not parse. Never read as absence. */
  readonly epochMalformed: boolean;
  /**
   * E2: a parsed epoch that names the ticket the session is on RIGHT NOW, and
   * therefore proves something about a LIVE claim.
   *
   * Keyed on `state.ticket` and nothing else. A retained epoch naming some
   * OTHER ticket is not a contradiction and must not be read as one: nothing
   * clears `claimEpoch` between items (the only clears are PlanStage abandoning
   * a draft and the park stage), and `PickTicketStage` does not clear it when it
   * picks the next item, so a session on its second item carries the first
   * item's epoch until `PlanStage` mints a new one at plan.ts:190. Treating that
   * disagreement as a refusal would refuse takeover on every multi-item session
   * between PICK_TICKET and the next mint.
   *
   * NOR does a disagreement matter where the session no longer names its own
   * item. An earlier revision refused there, on the theory that post-completion
   * the epoch and the completed list describe the same finished work; they do
   * not. The SKIP path MANUFACTURES the disagreement legitimately -- a session
   * that completed T-1 and then skipped T-2 arrives carrying T-2's epoch and a
   * completed list ending in T-1 -- so `resolveTicketIdentity` is pure
   * PRECEDENCE (the epoch wins, the completed list is the fallback) and has no
   * conflict arm to return. Its return type cannot express a refusal, by design.
   */
  readonly epochProvesCurrent: boolean;
}

/**
 * `parseClaimEpoch` folds absent, null and malformed into one answer, so
 * "present but unparseable" cannot be asked of it alone. The raw comparison
 * below matches the shipped preflight's absence semantics exactly: an explicit
 * null is ABSENT, not malformed. An `Object.hasOwn` spelling would classify it
 * the other way and change behavior.
 */
export function claimSignals(state: FullSessionState, ticket: Ticket | null): ClaimSignals {
  const rawEpoch = (state as Record<string, unknown>).claimEpoch;
  const epochPresent = rawEpoch !== undefined && rawEpoch !== null;
  const parsed: ClaimEpoch | null = parseClaimEpoch(rawEpoch);
  const currentTicketId = state.ticket?.id ?? null;

  const stamp = ticket ? ((ticket as Record<string, unknown>).claimedBySession as string | undefined) : undefined;

  return {
    ledgerSessionStamp: stamp ? (stamp === state.sessionId ? "ours" : "foreign") : null,
    ledgerClaim: ticket ? (ticket as Record<string, unknown>).claim !== undefined : false,
    epochMalformed: epochPresent && parsed === null,
    epochProvesCurrent: parsed !== null && currentTicketId !== null && parsed.ticketId === currentTicketId,
  };
}

// ---------------------------------------------------------------------------
// FINALIZE
// ---------------------------------------------------------------------------

/**
 * The baseline the stage needs to attribute a commit to THIS item
 * (`FinalizeStage.itemBaseline`). With none resolvable, the stage cannot tell an
 * inherited commit from this item's work, and authorizing a handover into a
 * stage that cannot attribute its own output is the fail-open this ticket
 * exists to remove.
 *
 * Deliberately item-kind-agnostic, mirroring the stage: `itemBaseline` is read
 * at finalize.ts:163, :295 and :524, none of which branch on ticket vs issue,
 * and PickTicketStage writes `itemBaseHead` on both the ticket and the issue
 * path. A baseline missing on the ticket arm is exactly as unattributable as one
 * missing on the issue arm, so gating only the issue arm would leave the same
 * fail-open under the other kind.
 */
export function finalizationBaselineValid(state: FullSessionState): boolean {
  const baseline = state.git.itemBaseHead ?? state.git.expectedHead ?? state.git.initHead;
  return typeof baseline === "string" && baseline.length > 0;
}

export type FinalizeItem =
  | { readonly kind: "ticket"; readonly id: string }
  | { readonly kind: "issue"; readonly id: string }
  | { readonly kind: "unresolvable"; readonly detail: string };

/**
 * WHICH ledger records the authority decision for this state will actually
 * read.
 *
 * This exists because "the ticket this session is about" is a DIFFERENT
 * question in each posture, and answering it with one rule loads the wrong
 * record in two of them:
 *
 *   - At a pre-acquisition or claim-bearing state it is `state.ticket` and
 *     nothing else. Falling back to the retained epoch there loads the PREVIOUS
 *     item -- a healthy multi-item session at PICK_TICKET carries the last
 *     item's epoch -- and then judges the current session by whether that
 *     finished ticket is re-acquirable, which it is not. Every such session
 *     would be refused.
 *   - At FINALIZE/`committed` the session names neither item, so the answer is
 *     whatever `finalizedItem` recorded. Reading `currentIssue` there yields
 *     nothing, and an issue-arm crash -- the exact case `finalizedItem` exists
 *     for -- would find its issue absent and be refused.
 *
 * Returning the targets as data keeps the caller doing I/O and this module
 * doing decisions, while ensuring both agree on what was read.
 */
export interface AuthorityLedgerTargets {
  readonly ticketId: string | null;
  readonly issueId: string | null;
}

export function authorityLedgerTargets(state: FullSessionState): AuthorityLedgerTargets {
  const none: AuthorityLedgerTargets = { ticketId: null, issueId: null };
  const workflowState = state.state;
  if (!(WORKFLOW_STATES as readonly string[]).includes(workflowState)) return none;

  const rule = POSTURE_BY_STATE[workflowState as WorkflowState];
  switch (rule) {
    case "not-reachable":
      return none;
    case "pre-acquisition":
    case "plan-epoch-dependent":
    case "claim-bearing":
      // Both arms of the epoch-dependent rule key on the same field, so the
      // posture does not need resolving to answer this.
      return { ticketId: state.ticket?.id ?? null, issueId: null };
    case "issue-work":
      return { ticketId: null, issueId: state.currentIssue?.id ?? null };
    case "post-completion-boundary":
      return { ticketId: resolveTicketIdentity(state).id, issueId: null };
    case "own-completion-window": {
      const item = resolveFinalizeItem(state);
      if (item.kind === "ticket") return { ticketId: item.id, issueId: null };
      if (item.kind === "issue") return { ticketId: null, issueId: item.id };
      return none;
    }
  }
}

/**
 * WHICH item FINALIZE is finalizing.
 *
 * Before `committed` the session still names it. At `committed` it does not:
 * that write clears `ticket` / `currentIssue` in the same breath as recording
 * the checkpoint, and the advance happens after, so a crash in between leaves a
 * legitimate session with neither field.
 *
 * `finalizedItem` is written by that same write and is therefore authoritative.
 * For a state written before this field shipped, the fallback is state fields
 * only and it FAILS CLOSED: exactly one of the two collections non-empty
 * resolves, and anything else refuses. It deliberately does not consult the
 * session events -- they carry no revision, so in the very window this exists
 * for (a crash between the state write and the event append) the last `commit`
 * event still belongs to the PREVIOUS item, which is the wrong-kind
 * misclassification `finalizedItem` was introduced to remove.
 */
export function resolveFinalizeItem(state: FullSessionState): FinalizeItem {
  if (state.finalizeCheckpoint !== "committed") {
    if (state.ticket?.id) return { kind: "ticket", id: state.ticket.id };
    if (state.currentIssue?.id) return { kind: "issue", id: state.currentIssue.id };
    return { kind: "unresolvable", detail: "the session names neither a ticket nor an issue at this checkpoint" };
  }

  const recorded = state.finalizedItem;
  if (recorded) {
    if (recorded.kind === "none") {
      return { kind: "unresolvable", detail:
        "this FINALIZE reached the committed checkpoint with no item to attribute, so there is no " +
        "completed work for a new owner to take over" };
    }
    return { kind: recorded.kind, id: recorded.id };
  }

  const tickets = state.completedTickets ?? [];
  const issues = state.resolvedIssues ?? [];
  const lastTicket = tickets.length > 0 ? tickets[tickets.length - 1] : null;
  const lastIssue = issues.length > 0 ? issues[issues.length - 1] : null;

  if (lastTicket && !lastIssue) return { kind: "ticket", id: lastTicket.id };
  if (lastIssue && !lastTicket) return { kind: "issue", id: lastIssue };
  return {
    kind: "unresolvable",
    detail: lastTicket && lastIssue
      ? "this state predates the finalized-item record and has completed both a ticket and an issue, " +
        "so which one the committed checkpoint belongs to cannot be determined from state alone"
      : "this state predates the finalized-item record and has completed neither a ticket nor an issue",
  };
}

/**
 * Whether the ledger shape agrees with how far FINALIZE has actually got.
 * `committed` is the strict row: an `inprogress` ticket still holding a live
 * claim at `committed` contradicts a commit that already landed.
 *
 * The issue column is `resolved` at EVERY checkpoint including `none`, because
 * ISSUE_FIX refuses to advance until the issue reads `resolved` and only then
 * routes here, so a healthy issue enters FINALIZE already resolved.
 */
const FINALIZE_TICKET_SHAPES = {
  none: ["inprogress-held", "complete-stripped"],
  staged: ["inprogress-held", "complete-stripped"],
  staged_override: ["inprogress-held", "complete-stripped"],
  precommit_passed: ["inprogress-held", "complete-stripped"],
  committed: ["complete-stripped"],
} satisfies Record<FinalizeCheckpoint | "none", readonly string[]>;

export type FinalizeTicketShape = "inprogress-held" | "complete-stripped" | "contradictory";

export function finalizeTicketShape(ticket: Ticket, signals: ClaimSignals): FinalizeTicketShape {
  const claimKeysStripped = signals.ledgerSessionStamp === null && !signals.ledgerClaim;
  if (ticket.status === "complete" && claimKeysStripped) return "complete-stripped";
  if (ticket.status === "inprogress" && !claimKeysStripped) return "inprogress-held";
  return "contradictory";
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const refuse = (
  posture: TakeoverPosture | "unknown-state",
  reason: TakeoverRefusalReason,
  detail: string,
): TakeoverAuthority => ({ kind: "refused", posture, reason, detail });

/**
 * WHICH ticket the residual-claim check should be read against.
 *
 * `state.ticket` is present in the pre-acquisition and claim-bearing postures
 * and is the key there. It is ABSENT at post-completion and at
 * FINALIZE/`committed`, where treating it as "no ticket" would make the signals
 * blind to exactly the residual they exist to catch, so the fallback names the
 * ticket this session most recently HELD.
 *
 * The epoch wins over the completed list, and a disagreement between them is
 * NOT a contradiction. They answer different questions -- the epoch names the
 * last ticket claimed, the list names the last ticket finished -- and the SKIP
 * path decouples them: code-review.ts:162 sends a session to HANDOVER with
 * `ticket` cleared and `claimEpoch` retained after releasing the claim, so a
 * session that completed T-1 and then skipped T-2 legitimately arrives carrying
 * an epoch for T-2 and a completed list ending in T-1. Reading that as
 * contradictory would refuse takeover on every skip that follows a completion.
 * The epoch is the right answer there: T-2 is where residue could be.
 */
export function resolveTicketIdentity(state: FullSessionState): { readonly id: string | null } {
  const sessionTicketId = state.ticket?.id ?? null;
  if (sessionTicketId) return { id: sessionTicketId };

  const parsed = parseClaimEpoch((state as Record<string, unknown>).claimEpoch);
  const tickets = state.completedTickets ?? [];
  return { id: parsed?.ticketId ?? tickets[tickets.length - 1]?.id ?? null };
}

/**
 * May this session's work be handed to a new owner?
 *
 * Called from inside the handshake so BOTH the cheap pre-check and the
 * authoritative in-lock recheck get it from one implementation, and the window
 * between them closes for free.
 */
export function decideTakeoverAuthority(input: TakeoverAuthorityInput): TakeoverAuthority {
  const { state, ticket, issue, reconciliation } = input;

  const workflowState = state.state;
  if (!(WORKFLOW_STATES as readonly string[]).includes(workflowState)) {
    return refuse("unknown-state", "unknown-state",
      `${workflowState} is not a known workflow state, so no authority rule applies to it`);
  }

  const rule = POSTURE_BY_STATE[workflowState as WorkflowState];

  if (ticket.kind === "unreadable") {
    return refuse("unknown-state", "ledger-unreadable",
      `the ledger ticket could not be read (${ticket.detail}); a failed read is not a finding that ` +
      "nothing is owed, and takeover may not be authorized past evidence nobody could load");
  }
  const ledgerTicket = ticket.kind === "found" ? ticket.value : null;
  const signals = claimSignals(state, ledgerTicket);

  if (signals.epochMalformed) {
    return refuse("unknown-state", "claim-epoch-malformed",
      "the recorded claim epoch is present but does not parse, so this session's claim history cannot " +
      "be read at all; that is never the same as having no claim");
  }

  // PLAN straddles the mint. Before plan.ts:190 writes an epoch for the ticket
  // this session is ON, PLAN is pre-acquisition; after, it is claim-bearing. A
  // retained epoch from a PREVIOUS item does not move it, which is why the test
  // is `epochProvesCurrent` and not merely "an epoch exists".
  const posture: TakeoverPosture = rule === "plan-epoch-dependent"
    ? (signals.epochProvesCurrent ? "claim-bearing" : "pre-acquisition")
    : rule;

  switch (posture) {
    case "not-reachable":
      return refuse(posture, "not-reachable",
        `takeover does not apply at ${workflowState}`);

    case "pre-acquisition": {
      if (signals.epochProvesCurrent) {
        return refuse(posture, "claim-not-held",
          "an epoch for the ticket this session is currently on exists at a pre-acquisition state, so " +
          "the recorded claim history contradicts the stage this session reports being at");
      }
      if (!ledgerTicket) return { kind: "permitted", posture };
      const draft = (state as Record<string, unknown>).pendingTicketClaim as DraftClaim | undefined;
      if (!canAcquireTicketClaim(ledgerTicket, state.sessionId, draft)) {
        return refuse(posture, "claim-not-acquirable",
          `ticket ${ledgerTicket.id} could not be acquired by this session under the same rule the plan ` +
          "stage applies, so a takeover would inherit work the ordinary path would not have granted");
      }
      return { kind: "permitted", posture };
    }

    case "claim-bearing": {
      // NOTHING TO PROVE is not the same as FAILING TO PROVE, and conflating
      // them here would refuse takeover on whole classes of healthy session.
      // `claimEpoch` is minted at exactly one place, plan.ts:190/:231, and only
      // when the session is on a TICKET whose claim was actually written. An
      // ISSUE-driven session therefore reaches IMPLEMENT, TEST and CODE_REVIEW
      // with no ticket and no epoch by design -- and ISS-084 routes issue fixes
      // through this pipeline identically, so that is a first-class path, not an
      // edge. The shipped handshake already names this case positively
      // (`ticketWork` "no-ticket": "no ticket work is owed"), and the matrix
      // must agree with it rather than overrule it.
      if (state.ticket?.id == null) {
        return { kind: "permitted", posture };
      }
      if (!signals.epochProvesCurrent) {
        return refuse(posture, "claim-not-held",
          `this session is on ticket ${state.ticket.id} but records no claim epoch proving it, so it ` +
          "cannot show the work being handed on is its to hand on");
      }
      if (reconciliation !== "held") {
        return refuse(posture, "claim-not-held",
          `the recorded claim reconciles as ${reconciliation}, not held; the ticket is no longer provably ` +
          "this session's, so its work may not be handed on");
      }
      return { kind: "permitted", posture };
    }

    case "issue-work": {
      const currentIssueId = state.currentIssue?.id;
      if (!currentIssueId) {
        return refuse(posture, "issue-not-resolvable",
          "this session is at ISSUE_FIX but records no current issue");
      }
      if (issue.kind === "unreadable") {
        return refuse(posture, "ledger-unreadable",
          `the ledger issue could not be read (${issue.detail})`);
      }
      if (issue.kind === "absent") {
        return refuse(posture, "issue-not-resolvable",
          `issue ${currentIssueId} no longer resolves in the ledger`);
      }
      if (issue.value.id !== currentIssueId) {
        return refuse(posture, "issue-not-resolvable",
          `the resolved ledger issue is ${issue.value.id} while the session records ${currentIssueId}`);
      }
      if (!["open", "inprogress", "resolved"].includes(issue.value.status)) {
        return refuse(posture, "issue-not-resolvable",
          `issue ${currentIssueId} is ${issue.value.status}, which is not a posture ISSUE_FIX can be resumed at`);
      }
      return { kind: "permitted", posture };
    }

    case "post-completion-boundary": {
      // THE QUESTION IS WHETHER *THIS* SESSION LET GO, and the session stamp is
      // three-valued, so `!== null` answers a different question than the one
      // being asked. A FOREIGN stamp is positive proof this session let go: the
      // ticket has since been picked up by someone else, which cannot happen
      // while this session still holds it. Reading it as residue refuses a
      // recovery because of another session's legitimate work.
      //
      // The chain is reachable, not theoretical: a session completes T-1 and
      // SKIPS T-2 (code-review.ts:162), `releaseSessionClaim` strips T-2's claim
      // keys and reopens it (claims.ts:101/:129), and the session reaches
      // HANDOVER still carrying T-2's epoch, which is what the identity fallback
      // resolves to. Another session then picks T-2 and stamps it. Refusing here
      // would deny recovery of the FIRST session by citing the SECOND session's
      // claim as the first one's residue.
      //
      // A claim record with NO stamp at all stays conservative and refuses: it
      // cannot be attributed to anyone (`claim` carries user/branch/since and no
      // session id), so it is not provably foreign and may still be ours.
      const residue =
        signals.ledgerSessionStamp === "ours"
          ? "a session stamp naming this session"
          : signals.ledgerSessionStamp === null && signals.ledgerClaim
            ? "a claim record that cannot be attributed to another session"
            : null;
      if (residue !== null) {
        return refuse(posture, "residual-claim",
          `the ledger ticket still carries ${residue} at ${workflowState}, where this session's claim ` +
          "lifecycle has already ended; the ledger contradicts the stage");
      }
      // Deliberately NOT also requiring `complete`. The residual-claim question
      // is whether this session let go, and both exits from a ticket satisfy it:
      // FinalizeStage completes and strips, while the SKIP path releases through
      // `releaseSessionClaim`, which strips the claim keys and writes the status
      // back to "open" (claims.ts:101/:129). A skipped ticket therefore reaches
      // HANDOVER as open-and-unclaimed, which is healthy, and demanding
      // `complete` here would refuse takeover on every skipped item.
      return { kind: "permitted", posture };
    }

    case "own-completion-window": {
      const checkpoint: FinalizeCheckpoint | "none" = state.finalizeCheckpoint ?? "none";
      const item = resolveFinalizeItem(state);
      if (item.kind === "unresolvable") {
        return refuse(posture, "finalize-item-unresolvable", item.detail);
      }

      if (item.kind === "issue") {
        if (issue.kind === "unreadable") {
          return refuse(posture, "ledger-unreadable", `the ledger issue could not be read (${issue.detail})`);
        }
        if (issue.kind === "absent" || issue.value.id !== item.id) {
          return refuse(posture, "issue-not-resolvable",
            `the issue this FINALIZE is completing (${item.id}) does not resolve in the ledger`);
        }
        if (issue.value.status !== "resolved") {
          return refuse(posture, "finalize-shape-inconsistent",
            `issue ${item.id} is ${issue.value.status} at FINALIZE/${checkpoint}, but ISSUE_FIX only routes ` +
            "here once the issue reads resolved");
        }
        if (!finalizationBaselineValid(state)) {
          return refuse(posture, "finalize-baseline-missing",
            "no finalization baseline resolves, so this stage cannot attribute a commit to its own item");
        }
        return { kind: "permitted", posture };
      }

      if (!finalizationBaselineValid(state)) {
        return refuse(posture, "finalize-baseline-missing",
          "no finalization baseline resolves, so this stage cannot attribute a commit to its own item");
      }
      if (!ledgerTicket) {
        return refuse(posture, "finalize-item-unresolvable",
          `the ticket this FINALIZE is completing (${item.id}) does not resolve in the ledger`);
      }
      const shape = finalizeTicketShape(ledgerTicket, signals);
      if (!(FINALIZE_TICKET_SHAPES[checkpoint] as readonly string[]).includes(shape)) {
        return refuse(posture, "finalize-shape-inconsistent",
          `ticket ${item.id} presents as ${shape} at checkpoint ${checkpoint}, which contradicts how far ` +
          "the stage has got");
      }
      if (shape === "inprogress-held" && reconciliation !== "held") {
        return refuse(posture, "claim-not-held",
          `ticket ${item.id} is still inprogress at FINALIZE/${checkpoint} and its claim reconciles as ` +
          `${reconciliation}, not held`);
      }
      return { kind: "permitted", posture };
    }
  }
}
