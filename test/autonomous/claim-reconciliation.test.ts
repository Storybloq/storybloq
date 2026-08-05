import { describe, it, expect } from "vitest";
import {
  reconcileClaim,
  type ClaimEpoch,
  type TicketClaimState,
} from "../../src/autonomous/claim-reconciliation.js";

/**
 * T-442, the pure core (canonical fix for ISS-784).
 *
 * A session claims a ticket at PICK_TICKET, confirms it at PLAN, then never looks
 * again. In a shared repo the merge driver arbitrates the ticket-claim group by
 * latest `claim.since`, so a merge can hand the claim to another agent
 * mid-IMPLEMENT while this session keeps working and eventually completes the
 * ticket out from under the winner.
 *
 * Two ticket fields carry ownership and NEITHER is sufficient alone:
 *   - `claimedBySession` -- session uuid, written by the pipeline
 *   - `claim {user,branch,since}` -- user-level, rewritten by the merge driver
 * A merge changes the second without touching the first, so
 * `{ claimedBySession: A, claim.user: B }` is reachable. Ownership therefore means
 * BOTH fields still match the epoch this session recorded when it acquired the claim.
 *
 * These cases are the authorization rule. Everything downstream (the guide
 * preflight, the release predicate, the completion veto) trusts this verdict, so
 * each row is asserted rather than left to the integration test.
 */

const NOW = Date.parse("2026-07-28T12:00:00.000Z");
const SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444";

function epoch(over: Partial<ClaimEpoch> = {}): ClaimEpoch {
  return {
    ticketId: "t-abc",
    sessionId: SESSION_A,
    user: "alice@example.com",
    branch: "story/T-001",
    since: "2026-07-28T09:00:00.000Z",
    establishedAt: "2026-07-28T09:00:00.000Z",
    ...over,
  };
}

/** Ledger state matching the epoch above: this session still holds the claim. */
function ledger(over: Partial<TicketClaimState> = {}): TicketClaimState {
  return {
    found: true,
    status: "inprogress",
    claimedBySession: { present: true, value: SESSION_A },
    claim: {
      present: true,
      value: { user: "alice@example.com", branch: "story/T-001", since: "2026-07-28T09:00:00.000Z" },
    },
    ...over,
  };
}

const reconcile = (l: TicketClaimState, e: ClaimEpoch = epoch()) =>
  reconcileClaim({ epoch: e, ticket: l, claimStalenessHours: 48, now: NOW });

describe("reconcileClaim (T-442)", () => {
  it("holds when both fields still match the epoch exactly", () => {
    expect(reconcile(ledger()).status).toBe("held");
  });

  describe("lost ownership", () => {
    it("conflicts when another session took the stamp", () => {
      const result = reconcile(ledger({ claimedBySession: { present: true, value: SESSION_B } }));
      expect(result.status).toBe("conflicted");
      if (result.status !== "conflicted") return;
      expect(result.detail.kind).toBe("session");
      expect(result.detail.sessionHolder).toBe(SESSION_B);
    });

    it("conflicts when the merge driver handed claim.user to someone else", () => {
      // The reported failure: claimedBySession still says us, claim.user does not.
      // A stamp-only check would call this held and let the pipeline run on.
      const result = reconcile(ledger({
        claim: { present: true, value: { user: "bob@example.com", branch: "story/T-001", since: "2026-07-28T11:00:00.000Z" } },
      }));
      expect(result.status).toBe("conflicted");
      if (result.status !== "conflicted") return;
      expect(result.detail.kind).toBe("user");
      expect(result.detail.userHolder).toBe("bob@example.com");
    });

    it("reports BOTH holders when the two fields disagree, not just the first checked", () => {
      const result = reconcile(ledger({
        claimedBySession: { present: true, value: SESSION_B },
        claim: { present: true, value: { user: "carol@example.com", branch: "x", since: "2026-07-28T11:00:00.000Z" } },
      }));
      expect(result.status).toBe("conflicted");
      if (result.status !== "conflicted") return;
      expect(result.detail.kind).toBe("inconsistent");
      expect(result.detail.sessionHolder).toBe(SESSION_B);
      expect(result.detail.userHolder).toBe("carol@example.com");
    });

    it("conflicts as released when the epoch had a claim and the ledger has none", () => {
      const result = reconcile(ledger({
        claimedBySession: { present: false, value: null },
        claim: { present: false, value: null },
      }));
      expect(result.status).toBe("conflicted");
      if (result.status !== "conflicted") return;
      expect(result.detail.kind).toBe("released");
    });

    it("does NOT fall through to held when the session stamp is simply absent", () => {
      // An absent stamp is lost ownership, not "no claim to lose". Matching
      // claim.user is corroborating only -- two sessions share one git email.
      const result = reconcile(ledger({ claimedBySession: { present: false, value: null } }));
      expect(result.status).toBe("conflicted");
    });

    it("treats an explicit null stamp as lost, not as a match", () => {
      const result = reconcile(ledger({ claimedBySession: { present: true, value: null } }));
      expect(result.status).toBe("conflicted");
    });
  });

  describe("epoch fingerprint is compared component by component", () => {
    it("conflicts when only the branch differs", () => {
      const result = reconcile(ledger({
        claim: { present: true, value: { user: "alice@example.com", branch: "story/OTHER", since: "2026-07-28T09:00:00.000Z" } },
      }));
      expect(result.status).toBe("conflicted");
    });

    it("conflicts when only `since` differs, i.e. a different claim generation", () => {
      const result = reconcile(ledger({
        claim: { present: true, value: { user: "alice@example.com", branch: "story/T-001", since: "2026-07-28T11:30:00.000Z" } },
      }));
      expect(result.status).toBe("conflicted");
    });
  });

  describe("expired versus taken (the ticket's stated pitfall)", () => {
    it("holds a stale claim that is still exactly ours -- no renewal write", () => {
      // Renewal is deliberately NOT implemented here: bumping claim.since is how a
      // claim WINS latest-wins merge arbitration, so renewing on an old branch can
      // resurrect a loser and evict the real holder. Filed as ISS-894. Asserted so
      // that changing it later is a deliberate edit, not an accident.
      const old = "2026-07-01T09:00:00.000Z";   // ~27 days, past the 48h threshold
      const result = reconcile(
        ledger({ claim: { present: true, value: { user: "alice@example.com", branch: "story/T-001", since: old } } }),
        epoch({ since: old }),
      );
      expect(result.status).toBe("held");
    });

    it("conflicts on a stale claim held by a FOREIGN owner -- never renewable", () => {
      const old = "2026-07-01T09:00:00.000Z";
      const result = reconcile(ledger({
        claimedBySession: { present: true, value: SESSION_B },
        claim: { present: true, value: { user: "bob@example.com", branch: "story/T-001", since: old } },
      }));
      expect(result.status).toBe("conflicted");
    });
  });

  describe("fail closed", () => {
    it("requires recovery when the target cannot be read", () => {
      const result = reconcile({ found: false, status: null, claimedBySession: { present: false, value: null }, claim: { present: false, value: null } });
      expect(result.status).toBe("recovery-required");
      if (result.status !== "recovery-required") return;
      expect(result.reason).toBe("target-unreadable");
    });

    it("requires recovery when the ticket is no longer inprogress and no txn proves it was ours", () => {
      // An earlier draft skipped reconciliation entirely for non-inprogress
      // tickets, which fails open: a crash after release, an external reopen, or a
      // FOREIGN completion each leaves a live epoch while the check is skipped.
      const result = reconcile(ledger({ status: "complete" }));
      expect(result.status).toBe("recovery-required");
    });

    it("fails closed on a non-inprogress state with no authenticated evidence available", () => {
      // There is deliberately no evidence parameter to pass: an escape hatch is
      // only sound once it is authenticated against the ticket, which arrives
      // with ISS-896. Until then every non-inprogress state fails closed.
      for (const status of ["complete", "open", "blocked"]) {
        const result = reconcileClaim({
          epoch: epoch(),
          ticket: ledger({ status }),
          claimStalenessHours: 48,
          now: NOW,
        });
        expect(result, `status ${status}`).toMatchObject({ status: "recovery-required", reason: "epoch-unverifiable" });
      }
    });
  });

  describe("completed-consistent (ISS-965)", () => {
    // ISS-965, 2026-08-05: this used to be "fail closed"'s "still reports a
    // release when no transaction evidence explains it", asserting
    // conflicted/released for this exact shape. A `complete` ticket with both
    // claim keys stripped is what a session's OWN authorized completion leaves
    // (clearClaimOnComplete strips both keys on success) -- reading it as a
    // foreign loss forced a live session into typed cancellation over its own
    // successful completion. Moved here, not left under "fail closed": this
    // shape is no longer a failure mode, it is the expected consistent case.
    it("reports completed-consistent when the ticket is complete and both claim keys are gone", () => {
      const result = reconcileClaim({
        epoch: epoch(),
        ticket: {
          found: true,
          status: "complete",
          claimedBySession: { present: false, value: null },
          claim: { present: false, value: null },
        },
        claimStalenessHours: 48,
        now: NOW,
      });
      expect(result).toMatchObject({ status: "completed-consistent" });
    });
  });

  describe("null-user epoch presence semantics", () => {
    const bare = () => ({ ...epoch(), user: null, branch: null, since: null });

    it("matches an ABSENT claim key", () => {
      const result = reconcileClaim({
        epoch: bare(),
        ticket: {
          found: true,
          status: "inprogress",
          claimedBySession: { present: true, value: SESSION_A },
          claim: { present: false, value: null },
        },
        claimStalenessHours: 48,
        now: NOW,
      });
      expect(result.status).toBe("held");
    });

    it("does NOT match an explicitly present null claim", () => {
      const result = reconcileClaim({
        epoch: bare(),
        ticket: {
          found: true,
          status: "inprogress",
          claimedBySession: { present: true, value: SESSION_A },
          claim: { present: true, value: null },
        },
        claimStalenessHours: 48,
        now: NOW,
      });
      expect(result.status).toBe("conflicted");
    });

    it("rejects a partially populated epoch whose user degraded to null", () => {
      // Defends reconcileClaim itself against an internally inconsistent epoch
      // supplied directly by an internal caller: a null user with a surviving
      // branch. Independent of parser validation, which rejects such shapes
      // before they reach here.
      const result = reconcileClaim({
        epoch: { ...epoch(), user: null },
        ticket: {
          found: true,
          status: "inprogress",
          claimedBySession: { present: true, value: SESSION_A },
          claim: { present: false, value: null },
        },
        claimStalenessHours: 48,
        now: NOW,
      });
      expect(result.status).toBe("conflicted");
    });
  });

  it("is pure: identical inputs give identical verdicts and no wall-clock dependency", () => {
    const l = ledger();
    expect(reconcileClaim({ epoch: epoch(), ticket: l, claimStalenessHours: 48, now: NOW }))
      .toEqual(reconcileClaim({ epoch: epoch(), ticket: l, claimStalenessHours: 48, now: NOW }));
  });
});
