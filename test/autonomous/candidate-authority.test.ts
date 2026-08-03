import { describe, it, expect } from "vitest";
import {
  decideTakeoverAuthority,
  canAcquireTicketClaim,
  claimSignals,
  resolveFinalizeItem,
  resolveTicketIdentity,
  authorityLedgerTargets,
  finalizationBaselineValid,
  type TakeoverAuthorityInput,
  type LedgerRead,
  type IssueAuthorityView,
} from "../../src/autonomous/candidate-authority.js";
import { WORKFLOW_STATES, type FullSessionState } from "../../src/autonomous/session-types.js";
import type { Ticket } from "../../src/models/ticket.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = "11111111-1111-4111-8111-111111111111";
const EPOCH = {
  ticketId: "T-1",
  sessionId: SESSION,
  user: "amir",
  branch: "story/T-1",
  since: "2026-08-01T00:00:00.000Z",
  establishedAt: "2026-08-01T00:00:00.000Z",
};

function state(over: Record<string, unknown> = {}): FullSessionState {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    recipe: "default",
    state: "IMPLEMENT",
    previousState: null,
    revision: 7,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    resolvedIssues: [],
    finalizeCheckpoint: null,
    finalizedItem: null,
    git: { branch: null, mergeBase: null, itemBaseHead: "aaaa1111" },
    ticket: { id: "T-1", displayId: "T-1", title: "t", risk: "low" },
    claimEpoch: EPOCH,
    ...over,
  } as unknown as FullSessionState;
}

function ticket(over: Record<string, unknown> = {}): Ticket {
  return {
    id: "T-1",
    title: "t",
    status: "inprogress",
    claimedBySession: SESSION,
    claim: { user: "amir", branch: "story/T-1", since: EPOCH.since },
    ...over,
  } as unknown as Ticket;
}

const found = <T,>(value: T): LedgerRead<T> => ({ kind: "found", value });
const absent = <T,>(): LedgerRead<T> => ({ kind: "absent" });
const unreadable = <T,>(): LedgerRead<T> => ({ kind: "unreadable", detail: "EIO" });

function decide(over: Partial<TakeoverAuthorityInput> = {}) {
  return decideTakeoverAuthority({
    state: state(),
    ticket: found(ticket()),
    issue: absent<IssueAuthorityView>(),
    reconciliation: "held",
    ...over,
  });
}

// ---------------------------------------------------------------------------

describe("T-450 7a: the posture map is total", () => {
  it("assigns a posture to EVERY workflow state, so a new state cannot inherit an arm", () => {
    // The compile-time guarantee is `satisfies Record<WorkflowState, PostureRule>`
    // in the module. This is the runtime half: every state reaches a decision
    // and none falls through to an unknown-state refusal by accident.
    for (const s of WORKFLOW_STATES) {
      const r = decide({ state: state({ state: s, claimEpoch: undefined, ticket: undefined }), ticket: absent<Ticket>() });
      if (r.kind === "refused") {
        expect(r.reason, `${s} fell through to unknown-state`).not.toBe("unknown-state");
      }
    }
  });

  it("refuses a state that is not in the workflow at all", () => {
    const r = decide({ state: state({ state: "TELEPORT" }) });
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.reason).toBe("unknown-state");
  });

  it("COMPACT and SESSION_END are never reachable", () => {
    for (const s of ["COMPACT", "SESSION_END"]) {
      const r = decide({ state: state({ state: s }) });
      expect(r.kind).toBe("refused");
      if (r.kind === "refused") expect(r.reason).toBe("not-reachable");
    }
  });
});

describe("T-450 7a: the shared acquisition predicate", () => {
  it("matches PlanStage: already ours at inprogress is acquirable", () => {
    expect(canAcquireTicketClaim(ticket({ status: "inprogress", claimedBySession: SESSION }), SESSION, undefined)).toBe(true);
  });

  it("refuses a non-open ticket that is not already ours", () => {
    expect(canAcquireTicketClaim(ticket({ status: "complete", claimedBySession: undefined, claim: undefined }), SESSION, undefined)).toBe(false);
  });

  it("refuses a foreign session stamp", () => {
    expect(canAcquireTicketClaim(ticket({ status: "open", claimedBySession: "other", claim: undefined }), SESSION, undefined)).toBe(false);
  });

  it("ISS-759: a SAME-USER claim on ANOTHER branch is still acquirable", () => {
    // The rule that must not tighten. A per-ticket-branch session legitimately
    // holds a claim from a previous branch of the same user, and requiring a
    // wholly unclaimed target would refuse a recovery PLAN itself would allow.
    const t = ticket({ status: "open", claimedBySession: undefined, claim: { user: "amir", branch: "story/OLD", since: "x" } });
    expect(canAcquireTicketClaim(t, SESSION, { user: "amir", branch: "story/NEW", since: "y" })).toBe(true);
  });

  it("refuses a FOREIGN user's claim", () => {
    const t = ticket({ status: "open", claimedBySession: undefined, claim: { user: "someone", branch: "b", since: "x" } });
    expect(canAcquireTicketClaim(t, SESSION, { user: "amir", branch: "b", since: "x" })).toBe(false);
  });

  it("refuses a claim with NO draft to compare against", () => {
    const t = ticket({ status: "open", claimedBySession: undefined, claim: { user: "amir", branch: "b", since: "x" } });
    expect(canAcquireTicketClaim(t, SESSION, undefined)).toBe(false);
  });
});

describe("T-450 7a: claim-bearing", () => {
  it("permits a held epoch that reconciles held", () => {
    expect(decide({ state: state({ state: "IMPLEMENT" }) }).kind).toBe("permitted");
  });

  it("refuses when the claim reconciles as anything other than held", () => {
    for (const r of ["conflicted", "recovery-required", "not-checked"] as const) {
      const d = decide({ reconciliation: r });
      expect(d.kind, `reconciliation ${r} should refuse`).toBe("refused");
      if (d.kind === "refused") expect(d.reason).toBe("claim-not-held");
    }
  });

  it("refuses when no usable epoch is recorded at all", () => {
    const d = decide({ state: state({ claimEpoch: undefined }) });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("claim-not-held");
  });

  it("a foreign ledger stamp alone does not permit: claimedBySession is a stamp, not a proof", () => {
    const d = decide({ ticket: found(ticket({ claimedBySession: "other" })), reconciliation: "conflicted" });
    expect(d.kind).toBe("refused");
  });
});

describe("T-450 7a: epoch signals are about identity, not liveness", () => {
  it("E1: an epoch present but unparseable REFUSES, and is never read as absence", () => {
    const d = decide({ state: state({ claimEpoch: { ticketId: "T-1" } }) });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("claim-epoch-malformed");
  });

  it("E1 spelling: explicit null is ABSENT (as the shipped preflight treats it), not malformed", () => {
    // An Object.hasOwn implementation would call this malformed and change
    // behavior. Absent means the claim-bearing row refuses for the ordinary
    // "no claim" reason, NOT the malformed one.
    const d = decide({ state: state({ claimEpoch: null }) });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("claim-not-held");
  });

  it("E1 spelling: an absent property and an explicit undefined both read as absent", () => {
    for (const over of [{ claimEpoch: undefined }, {}]) {
      const s = state(over);
      if (!("claimEpoch" in over)) delete (s as Record<string, unknown>).claimEpoch;
      const sig = claimSignals(s, null);
      expect(sig.epochMalformed).toBe(false);
    }
  });

  it("E1 variants: empty object and partial object are MALFORMED", () => {
    for (const raw of [{}, { ticketId: "T-1", sessionId: SESSION }]) {
      const sig = claimSignals(state({ claimEpoch: raw }), null);
      expect(sig.epochMalformed).toBe(true);
    }
  });

  it("a RETAINED epoch from a previous item is history, not a contradiction", () => {
    // Nothing clears claimEpoch between items and PickTicketStage does not
    // clear it when it picks the next one, so a session on its second ticket
    // carries the first ticket's epoch until PlanStage mints a new one. Reading
    // that as an identity conflict would refuse takeover on every multi-item
    // session in the window between PICK_TICKET and the next mint.
    const d = decide({
      state: state({ state: "PICK_TICKET", ticket: { id: "T-9", displayId: "T-9", title: "x", risk: "low" }, claimEpoch: EPOCH }),
      ticket: found(ticket({ id: "T-9", status: "open", claimedBySession: undefined, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });

  it("PLAN reads as pre-acquisition while the epoch still names the PREVIOUS item", () => {
    const d = decide({
      state: state({ state: "PLAN", ticket: { id: "T-9", displayId: "T-9", title: "x", risk: "low" }, claimEpoch: EPOCH }),
      ticket: found(ticket({ id: "T-9", status: "open", claimedBySession: undefined, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
    if (d.kind === "permitted") expect(d.posture).toBe("pre-acquisition");
  });

  it("the epoch and the completed list may DISAGREE without that being a contradiction", () => {
    // They answer different questions, and the skip path decouples them: a
    // session that completed T-1 then SKIPPED T-2 arrives at HANDOVER carrying
    // an epoch for T-2 and a completed list ending in T-1. The epoch wins,
    // because T-2 is where residue could be.
    const d = decide({
      state: state({ state: "HANDOVER", ticket: undefined, claimEpoch: EPOCH, completedTickets: [{ id: "T-77" }] }),
      ticket: absent<Ticket>(),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });
});

describe("T-450 7a: nothing to prove is not failing to prove", () => {
  it("PERMITS an ISSUE-driven session at every claim-bearing state", () => {
    // claimEpoch is minted at exactly one place, plan.ts:190/:231, and only
    // when the session is on a TICKET whose claim was written. An issue-driven
    // session has no ticket and therefore no epoch, by design -- and ISS-084
    // routes issue fixes through this pipeline identically. Requiring an epoch
    // here refused takeover on every one of them.
    for (const s of ["IMPLEMENT", "TEST", "CODE_REVIEW", "WRITE_TESTS"]) {
      const d = decide({
        state: state({ state: s, ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-1" } }),
        ticket: absent<Ticket>(),
        reconciliation: "not-checked",
      });
      expect(d.kind, `${s} on an issue-driven session`).toBe("permitted");
    }
  });

  it("still REFUSES a session that is on a ticket and cannot prove it", () => {
    // The other half. PlanStage swallows a failed claim write (plan.ts:182
    // best-effort catch) and leaves the session on the ticket with no epoch, so
    // this shape is reachable and must not be handed on.
    const d = decide({
      state: state({ state: "IMPLEMENT", claimEpoch: undefined }),
      ticket: found(ticket()),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("claim-not-held");
  });

  it("PERMITS a ticket-less session at PICK_TICKET carrying only a retained epoch", () => {
    const d = decide({
      state: state({ state: "PICK_TICKET", ticket: undefined, claimEpoch: EPOCH, completedTickets: [{ id: "T-1" }] }),
      ticket: absent<Ticket>(),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });
});

describe("T-450 7a: post-completion, the regression that took two rounds to kill", () => {
  const POST = ["COMPLETE", "LESSON_CAPTURE", "ISSUE_SWEEP", "HANDOVER"];

  it("PERMITS the ordinary healthy shape at every post-completion state", () => {
    // The trio a NORMAL completed session carries: a retained claimEpoch and a
    // retained pendingTicketClaim (nothing in FinalizeStage or CompleteStage
    // clears either) against a complete ticket with both claim keys stripped.
    // Counting either retained field as an active claim would refuse takeover
    // on every healthy session that ever finished a ticket.
    for (const s of POST) {
      const d = decide({
        state: state({
          state: s,
          ticket: undefined,
          claimEpoch: EPOCH,
          pendingTicketClaim: { user: "amir", branch: "story/T-1", since: EPOCH.since },
          completedTickets: [{ id: "T-1", displayId: "T-1", title: "t" }],
        }),
        ticket: found(ticket({ status: "complete", claimedBySession: undefined, claim: undefined })),
        reconciliation: "not-checked",
      });
      expect(d.kind, `${s} should permit the healthy completed shape`).toBe("permitted");
    }
  });

  it("REFUSES a residual ledger session stamp", () => {
    const d = decide({
      state: state({ state: "COMPLETE", ticket: undefined, completedTickets: [{ id: "T-1" }] }),
      ticket: found(ticket({ status: "complete", claimedBySession: SESSION, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("residual-claim");
  });

  it("REFUSES a residual ledger claim record", () => {
    const d = decide({
      state: state({ state: "COMPLETE", ticket: undefined, completedTickets: [{ id: "T-1" }] }),
      ticket: found(ticket({ status: "complete", claimedBySession: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("residual-claim");
  });

  it("PERMITS a SKIPPED ticket, which is open and unclaimed rather than complete", () => {
    // code-review.ts:162 sends a skip to HANDOVER with the ticket cleared, and
    // releaseSessionClaim has already stripped the claim keys and written the
    // status back to "open" (claims.ts:101/:129). Demanding "complete" here
    // would refuse takeover on every skipped item. The residual-claim question
    // is whether the session LET GO, and a skip lets go exactly as a completion
    // does.
    const d = decide({
      state: state({ state: "HANDOVER", ticket: undefined, claimEpoch: EPOCH }),
      ticket: found(ticket({ status: "open", claimedBySession: undefined, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });

  it("PERMITS a ticket carrying a FOREIGN stamp: that is proof this session let go", () => {
    // The chain is reachable, not theoretical. A session completes T-1 and SKIPS
    // T-2; releaseSessionClaim strips T-2's claim keys and reopens it; the
    // session reaches HANDOVER still carrying T-2's epoch, which is what the
    // identity fallback resolves to. Another session then picks T-2 and stamps
    // it. Reading that stamp as residue would deny recovery of the FIRST session
    // by citing the SECOND session's legitimate claim as the first one's.
    const d = decide({
      state: state({ state: "HANDOVER", ticket: undefined, claimEpoch: EPOCH, completedTickets: [{ id: "T-77" }] }),
      ticket: found(ticket({ status: "inprogress", claimedBySession: "another-session", claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });

  it("PERMITS a foreign stamp TOGETHER with its claim record", () => {
    // The claim belongs with the stamp. Refusing on the claim half would
    // reinstate the same false refusal one field over.
    const d = decide({
      state: state({ state: "HANDOVER", ticket: undefined, claimEpoch: EPOCH }),
      ticket: found(ticket({ status: "inprogress", claimedBySession: "another-session", claim: { user: "someone", branch: "b", since: "x" } })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });

  it("REFUSES an OURS stamp: that is this session's own residue", () => {
    const d = decide({
      state: state({ state: "HANDOVER", ticket: undefined, claimEpoch: EPOCH }),
      ticket: found(ticket({ status: "complete", claimedBySession: SESSION, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") {
      expect(d.reason).toBe("residual-claim");
      expect(d.detail).toContain("naming this session");
    }
  });

  it("REFUSES an unattributable claim record, which stays conservative", () => {
    // `claim` carries user/branch/since and no session id, so a claim with no
    // stamp beside it is not provably foreign and may still be ours.
    const d = decide({
      state: state({ state: "HANDOVER", ticket: undefined, claimEpoch: EPOCH }),
      ticket: found(ticket({ status: "complete", claimedBySession: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("residual-claim");
  });

  it("still REFUSES a ticket that has NOT been let go", () => {
    const d = decide({
      state: state({ state: "HANDOVER", ticket: undefined, claimEpoch: EPOCH }),
      ticket: found(ticket({ status: "open", claimedBySession: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("residual-claim");
  });
});

describe("T-450 7a: the ticket-resolution key", () => {
  it("prefers the session ticket when present", () => {
    expect(resolveTicketIdentity(state())).toEqual({ id: "T-1" });
  });

  it("falls back to the epoch when the session ticket is cleared", () => {
    expect(resolveTicketIdentity(state({ ticket: undefined }))).toEqual({ id: "T-1" });
  });

  it("falls back to the last completed ticket when there is no epoch", () => {
    const r = resolveTicketIdentity(state({ ticket: undefined, claimEpoch: undefined, completedTickets: [{ id: "T-4" }, { id: "T-8" }] }));
    expect(r).toEqual({ id: "T-8" });
  });

  it("prefers the EPOCH over the completed list when they disagree", () => {
    const r = resolveTicketIdentity(state({ ticket: undefined, completedTickets: [{ id: "T-99" }] }));
    expect(r).toEqual({ id: "T-1" });
  });

  it("resolves to nothing when neither source exists", () => {
    expect(resolveTicketIdentity(state({ ticket: undefined, claimEpoch: undefined }))).toEqual({ id: null });
  });
});

describe("T-450 7a: a failed ledger read is never absence", () => {
  it("an unreadable ticket refuses with ledger-unreadable", () => {
    const d = decide({ ticket: unreadable<Ticket>() });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("ledger-unreadable");
  });

  it("an unreadable issue at ISSUE_FIX refuses with ledger-unreadable", () => {
    const d = decide({
      state: state({ state: "ISSUE_FIX", ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-1" } }),
      ticket: absent<Ticket>(),
      issue: unreadable<IssueAuthorityView>(),
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("ledger-unreadable");
  });
});

describe("T-450 7a: ISSUE_FIX", () => {
  const issueState = (over: Record<string, unknown> = {}) =>
    state({ state: "ISSUE_FIX", ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-1" }, ...over });

  it("permits open, inprogress and resolved", () => {
    for (const status of ["open", "inprogress", "resolved"]) {
      const d = decide({ state: issueState(), ticket: absent<Ticket>(), issue: found({ id: "ISS-1", status }) });
      expect(d.kind, `status ${status}`).toBe("permitted");
    }
  });

  it("refuses a status outside those three", () => {
    const d = decide({ state: issueState(), ticket: absent<Ticket>(), issue: found({ id: "ISS-1", status: "wontfix" }) });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("issue-not-resolvable");
  });

  it("refuses a deleted issue", () => {
    const d = decide({ state: issueState(), ticket: absent<Ticket>(), issue: absent<IssueAuthorityView>() });
    expect(d.kind).toBe("refused");
  });

  it("refuses a mismatched issue id", () => {
    const d = decide({ state: issueState(), ticket: absent<Ticket>(), issue: found({ id: "ISS-2", status: "open" }) });
    expect(d.kind).toBe("refused");
  });

  it("refuses when the session records no current issue at all", () => {
    const d = decide({ state: issueState({ currentIssue: undefined }), ticket: absent<Ticket>(), issue: absent<IssueAuthorityView>() });
    expect(d.kind).toBe("refused");
  });
});

describe("T-450 7a: FINALIZE item resolution", () => {
  it("uses the session fields before the committed checkpoint", () => {
    expect(resolveFinalizeItem(state({ state: "FINALIZE", finalizeCheckpoint: "staged" }))).toEqual({ kind: "ticket", id: "T-1" });
  });

  it("uses finalizedItem at committed, where the session fields are already cleared", () => {
    // The crash window: FinalizeStage writes the checkpoint and clears the item
    // identity in ONE write, and the advance happens after. A session dying in
    // between is legitimate and must still resolve.
    const s = state({
      state: "FINALIZE",
      finalizeCheckpoint: "committed",
      ticket: undefined,
      currentIssue: undefined,
      finalizedItem: { kind: "ticket", id: "T-1", commitHash: "beef" },
      completedTickets: [{ id: "T-1" }],
    });
    expect(resolveFinalizeItem(s)).toEqual({ kind: "ticket", id: "T-1" });
  });

  it("resolves the ISSUE arm at committed, which no inferred correlator could", () => {
    // resolvedIssues holds BARE ID STRINGS with no commit hash, so nothing
    // relates an entry to itemBaseHead. Only the recorded field can answer.
    const s = state({
      state: "FINALIZE",
      finalizeCheckpoint: "committed",
      ticket: undefined,
      finalizedItem: { kind: "issue", id: "ISS-3", commitHash: "beef" },
      resolvedIssues: ["ISS-3"],
    });
    expect(resolveFinalizeItem(s)).toEqual({ kind: "issue", id: "ISS-3" });
  });

  it("survives the ancestor-commit path, where commitHash and itemBaseHead differ", () => {
    // The case that killed the inferred correlator: on the drift-tolerance
    // branch the accepted commit is BEHIND HEAD, so commitHash !== itemBaseHead
    // and an equality-based rule finds nothing. The recorded field does not care.
    const s = state({
      state: "FINALIZE",
      finalizeCheckpoint: "committed",
      ticket: undefined,
      git: { branch: null, mergeBase: null, itemBaseHead: "HEADHEAD" },
      finalizedItem: { kind: "ticket", id: "T-1", commitHash: "ANCESTOR" },
      completedTickets: [{ id: "T-1" }],
      resolvedIssues: ["ISS-9"],
    });
    expect(resolveFinalizeItem(s)).toEqual({ kind: "ticket", id: "T-1" });
  });

  describe("legacy states with no finalizedItem fail CLOSED", () => {
    const legacy = (over: Record<string, unknown>) =>
      resolveFinalizeItem(state({ state: "FINALIZE", finalizeCheckpoint: "committed", ticket: undefined, finalizedItem: null, ...over }));

    it("exactly one collection non-empty resolves", () => {
      expect(legacy({ completedTickets: [{ id: "T-5" }], resolvedIssues: [] })).toEqual({ kind: "ticket", id: "T-5" });
      expect(legacy({ completedTickets: [], resolvedIssues: ["ISS-5"] })).toEqual({ kind: "issue", id: "ISS-5" });
    });

    it("BOTH non-empty refuses as ambiguous, regardless of any commit event", () => {
      const r = legacy({ completedTickets: [{ id: "T-5" }], resolvedIssues: ["ISS-5"] });
      expect(r.kind).toBe("unresolvable");
    });

    it("neither non-empty refuses", () => {
      expect(legacy({ completedTickets: [], resolvedIssues: [] }).kind).toBe("unresolvable");
    });
  });
});

describe("T-450 7a: FINALIZE both axes", () => {
  const fin = (checkpoint: string | null, over: Record<string, unknown> = {}) =>
    state({ state: "FINALIZE", finalizeCheckpoint: checkpoint, ...over });

  const CHECKPOINTS = [null, "staged", "staged_override", "precommit_passed"] as const;

  it("permits an inprogress ticket with a held claim at every pre-commit checkpoint", () => {
    for (const c of CHECKPOINTS) {
      const d = decide({ state: fin(c), ticket: found(ticket()), reconciliation: "held" });
      expect(d.kind, `checkpoint ${c}`).toBe("permitted");
    }
  });

  it("permits a complete, claim-stripped ticket at every pre-commit checkpoint", () => {
    for (const c of CHECKPOINTS) {
      const d = decide({
        state: fin(c),
        ticket: found(ticket({ status: "complete", claimedBySession: undefined, claim: undefined })),
        reconciliation: "not-checked",
      });
      expect(d.kind, `checkpoint ${c}`).toBe("permitted");
    }
  });

  it("REFUSES an inprogress ticket still holding a live claim at committed", () => {
    const d = decide({
      state: fin("committed", { ticket: undefined, finalizedItem: { kind: "ticket", id: "T-1", commitHash: "b" }, completedTickets: [{ id: "T-1" }] }),
      ticket: found(ticket()),
      reconciliation: "held",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-shape-inconsistent");
  });

  it("permits a complete, claim-stripped ticket at committed", () => {
    const d = decide({
      state: fin("committed", { ticket: undefined, finalizedItem: { kind: "ticket", id: "T-1", commitHash: "b" }, completedTickets: [{ id: "T-1" }] }),
      ticket: found(ticket({ status: "complete", claimedBySession: undefined, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });

  it("REFUSES a HALF-STRIPPED ticket at committed: both claim keys must be gone", () => {
    // complete + no session stamp but a claim record still present. Reading the
    // strip as satisfied by EITHER key going would call this complete-stripped
    // and permit it, handing on a ticket the ledger still shows as claimed.
    const d = decide({
      state: fin("committed", { ticket: undefined, finalizedItem: { kind: "ticket", id: "T-1", commitHash: "b" }, completedTickets: [{ id: "T-1" }] }),
      ticket: found(ticket({ status: "complete", claimedBySession: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-shape-inconsistent");
  });

  it("REFUSES the mirror half-strip: a claim record gone but the session stamp left", () => {
    const d = decide({
      state: fin("committed", { ticket: undefined, finalizedItem: { kind: "ticket", id: "T-1", commitHash: "b" }, completedTickets: [{ id: "T-1" }] }),
      ticket: found(ticket({ status: "complete", claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-shape-inconsistent");
  });

  it("REFUSES an inprogress ticket whose claim does not reconcile as held", () => {
    const d = decide({ state: fin("staged"), ticket: found(ticket()), reconciliation: "conflicted" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("claim-not-held");
  });

  it("issue finalization requires resolved at EVERY checkpoint, including none", () => {
    for (const c of [null, "staged", "committed"]) {
      const s = fin(c, {
        ticket: undefined, claimEpoch: undefined,
        currentIssue: c === "committed" ? undefined : { id: "ISS-1" },
        finalizedItem: c === "committed" ? { kind: "issue", id: "ISS-1", commitHash: "b" } : null,
        resolvedIssues: c === "committed" ? ["ISS-1"] : [],
      });
      const ok = decide({ state: s, ticket: absent<Ticket>(), issue: found({ id: "ISS-1", status: "resolved" }), reconciliation: "not-checked" });
      expect(ok.kind, `checkpoint ${c} resolved`).toBe("permitted");
      const bad = decide({ state: s, ticket: absent<Ticket>(), issue: found({ id: "ISS-1", status: "inprogress" }), reconciliation: "not-checked" });
      expect(bad.kind, `checkpoint ${c} inprogress`).toBe("refused");
    }
  });

  it("issue finalization REFUSES when no baseline resolves", () => {
    const s = fin("staged", {
      ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-1" },
      git: { branch: null, mergeBase: null },
    });
    const d = decide({ state: s, ticket: absent<Ticket>(), issue: found({ id: "ISS-1", status: "resolved" }), reconciliation: "not-checked" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-baseline-missing");
  });

  it("TICKET finalization requires a baseline too, on the same terms as the issue arm", () => {
    // finalize.ts reads itemBaseline at :163, :295 and :524 without branching on
    // item kind, so a ticket with no baseline is exactly as unattributable as an
    // issue with none. Gating only the issue arm would leave the fail-open
    // standing under the other kind.
    const s = fin("staged", { git: { branch: null, mergeBase: null } });
    const d = decide({ state: s, ticket: found(ticket()), reconciliation: "held" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-baseline-missing");
  });

  it("accepts a ticket resting on either fallback link, not just itemBaseHead", () => {
    for (const git of [{ expectedHead: "b" }, { initHead: "c" }]) {
      const d = decide({
        state: fin("staged", { git: { branch: null, mergeBase: null, ...git } }),
        ticket: found(ticket()),
        reconciliation: "held",
      });
      expect(d.kind, JSON.stringify(git)).toBe("permitted");
    }
  });

  it("the baseline predicate walks the same fallback chain FinalizeStage does", () => {
    expect(finalizationBaselineValid(state({ git: { itemBaseHead: "a" } }))).toBe(true);
    expect(finalizationBaselineValid(state({ git: { expectedHead: "b" } }))).toBe(true);
    expect(finalizationBaselineValid(state({ git: { initHead: "c" } }))).toBe(true);
    expect(finalizationBaselineValid(state({ git: {} }))).toBe(false);
  });
});

describe("T-450 7a: pre-acquisition", () => {
  const pre = (over: Record<string, unknown> = {}) =>
    state({ state: "PICK_TICKET", ticket: undefined, claimEpoch: undefined, ...over });

  it("permits with no ticket at all", () => {
    expect(decide({ state: pre(), ticket: absent<Ticket>(), reconciliation: "not-checked" }).kind).toBe("permitted");
  });

  it("permits an acquirable ticket", () => {
    const d = decide({
      state: pre({ ticket: { id: "T-1", displayId: "T-1", title: "t", risk: "low" } }),
      ticket: found(ticket({ status: "open", claimedBySession: undefined, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });

  it("refuses a ticket the plan stage itself could not acquire", () => {
    const d = decide({
      state: pre({ ticket: { id: "T-1", displayId: "T-1", title: "t", risk: "low" } }),
      ticket: found(ticket({ status: "open", claimedBySession: "other", claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("claim-not-acquirable");
  });

  it("refuses an epoch for the CURRENT ticket at a pre-acquisition state", () => {
    // T-1 is both what the session is on and what the epoch names, so the claim
    // history says the ticket was already acquired while the stage says it was
    // not. That is the contradiction; a stale epoch for another item is not.
    const d = decide({ state: pre({ claimEpoch: EPOCH, ticket: { id: "T-1", displayId: "T-1", title: "t", risk: "low" } }) });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("claim-not-held");
  });
});

describe("T-450 7a: PLAN is epoch-dependent", () => {
  it("is pre-acquisition before an epoch is minted for THIS ticket", () => {
    const d = decide({
      state: state({ state: "PLAN", claimEpoch: undefined }),
      ticket: found(ticket({ status: "open", claimedBySession: undefined, claim: undefined })),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("permitted");
  });

  it("is claim-bearing once one exists, so the revise loop is gated on held", () => {
    const held = decide({ state: state({ state: "PLAN" }), reconciliation: "held" });
    expect(held.kind).toBe("permitted");
    const lost = decide({ state: state({ state: "PLAN" }), reconciliation: "conflicted" });
    expect(lost.kind).toBe("refused");
    if (lost.kind === "refused") expect(lost.reason).toBe("claim-not-held");
  });
});

describe("T-450 7a: which ledger records each posture actually reads", () => {
  // Asking one question everywhere loaded the wrong record in two postures, and
  // a unit test that hands `decideTakeoverAuthority` a pre-built LedgerRead
  // cannot see it -- the bug lives in choosing WHAT to read.

  it("pre-acquisition and claim-bearing read state.ticket and NOTHING else", () => {
    for (const st of ["PICK_TICKET", "PLAN", "IMPLEMENT", "CODE_REVIEW"]) {
      const t = authorityLedgerTargets(state({ state: st }));
      expect(t, st).toEqual({ ticketId: "T-1", issueId: null });
    }
  });

  it("a RETAINED epoch never selects the previous item at a pre-acquisition state", () => {
    // The defect: falling back to the epoch here loads the ticket the session
    // just finished, then judges this session by whether that finished ticket
    // is re-acquirable. It is not, so every healthy multi-item session at
    // PICK_TICKET was refused.
    const t = authorityLedgerTargets(state({ state: "PICK_TICKET", ticket: undefined, claimEpoch: EPOCH }));
    expect(t).toEqual({ ticketId: null, issueId: null });
  });

  it("an ISSUE-driven claim-bearing state reads no ticket at all", () => {
    const t = authorityLedgerTargets(state({ state: "IMPLEMENT", ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-1" } }));
    expect(t).toEqual({ ticketId: null, issueId: null });
  });

  it("ISSUE_FIX reads the current issue", () => {
    const t = authorityLedgerTargets(state({ state: "ISSUE_FIX", ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-1" } }));
    expect(t).toEqual({ ticketId: null, issueId: "ISS-1" });
  });

  it("post-completion reads the ticket the session most recently HELD", () => {
    const t = authorityLedgerTargets(state({ state: "COMPLETE", ticket: undefined, claimEpoch: EPOCH, completedTickets: [{ id: "T-9" }] }));
    expect(t).toEqual({ ticketId: "T-1", issueId: null });
  });

  it("FINALIZE/committed on the ISSUE arm reads the issue finalizedItem names", () => {
    // currentIssue is already cleared by the committed write, so reading it
    // would find nothing and refuse the exact crash finalizedItem exists for.
    const t = authorityLedgerTargets(state({
      state: "FINALIZE", finalizeCheckpoint: "committed", ticket: undefined, currentIssue: undefined,
      finalizedItem: { kind: "issue", id: "ISS-7", commitHash: "beef" }, resolvedIssues: ["ISS-7"],
    }));
    expect(t).toEqual({ ticketId: null, issueId: "ISS-7" });
  });

  it("FINALIZE/committed on the TICKET arm reads that ticket, not the retained epoch's", () => {
    const t = authorityLedgerTargets(state({
      state: "FINALIZE", finalizeCheckpoint: "committed", ticket: undefined, claimEpoch: EPOCH,
      finalizedItem: { kind: "ticket", id: "T-42", commitHash: "beef" }, completedTickets: [{ id: "T-42" }],
    }));
    expect(t).toEqual({ ticketId: "T-42", issueId: null });
  });

  it("reads nothing for a state outside the workflow, rather than guessing", () => {
    expect(authorityLedgerTargets(state({ state: "TELEPORT" }))).toEqual({ ticketId: null, issueId: null });
  });
});

describe("T-450 7a: a no-item commit is recorded, not left to the legacy guess", () => {
  const committed = (over: Record<string, unknown>) =>
    resolveFinalizeItem(state({ state: "FINALIZE", finalizeCheckpoint: "committed", ticket: undefined, currentIssue: undefined, ...over }));

  it('kind "none" resolves to unresolvable and says why', () => {
    const r = committed({ finalizedItem: { kind: "none", commitHash: "beef" }, completedTickets: [{ id: "T-5" }] });
    expect(r.kind).toBe("unresolvable");
    if (r.kind === "unresolvable") expect(r.detail).toContain("no item to attribute");
  });

  it('kind "none" beats the legacy fallback that would have named an OLDER item', () => {
    // With null here the legacy branch sees exactly one non-empty collection
    // and confidently returns T-5 -- a ticket this checkpoint is not about.
    const recorded = committed({ finalizedItem: { kind: "none", commitHash: "beef" }, completedTickets: [{ id: "T-5" }] });
    const legacy = committed({ finalizedItem: null, completedTickets: [{ id: "T-5" }] });
    expect(recorded.kind).toBe("unresolvable");
    expect(legacy).toEqual({ kind: "ticket", id: "T-5" });
  });

  it("a no-item commit is refused rather than authorized against someone else's work", () => {
    const d = decide({
      state: state({
        state: "FINALIZE", finalizeCheckpoint: "committed", ticket: undefined, currentIssue: undefined,
        finalizedItem: { kind: "none", commitHash: "beef" }, completedTickets: [{ id: "T-5" }],
      }),
      ticket: absent<Ticket>(),
      reconciliation: "not-checked",
    });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-item-unresolvable");
  });
});
