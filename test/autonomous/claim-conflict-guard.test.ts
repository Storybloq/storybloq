import { describe, it, expect } from "vitest";
import {
  recoverClaimTransaction,
  type ClaimTxn,
  type TicketSnapshot,
} from "../../src/autonomous/claim-reconciliation.js";

/**
 * T-442, the crash protocol.
 *
 * The ticket is a git-tracked project file; the claim epoch lives in gitignored
 * session state. They CANNOT be written atomically, so every claim transition has
 * a crash window. One five-step protocol covers all three transitions
 * (acquire / release / complete):
 *
 *   1. write intent at phase "prepared"
 *   2. under the project lock, verify the whole preimage and mutate the ticket,
 *      stamping it with `claimTxnId`
 *   3. atomically write toEpoch AND phase "ticket_applied" in one session write
 *   4. remove the ticket nonce
 *   5. clear the intent
 *
 * Recovery is a predicate over three INDEPENDENT axes: phase, business snapshot,
 * and nonce state. The nonce is deliberately not part of the business snapshot --
 * step 4 must match "exact postimage with nonce" and step 5 "exact postimage with
 * nonce absent", which one combined snapshot cannot do.
 *
 * Every unmatched combination fails closed. That is the property under test here:
 * a foreign write that merely resembles our postimage must never be mistaken for
 * our own completed step.
 */

const NONCE = "txn-0001";
const SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444";

const field = <T,>(value: T | null, present = value !== null) => ({ present, value });

function snapshot(over: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    ticketId: "t-abc",
    lifecycle: field("active"),
    status: field("inprogress"),
    completedDate: field(null, false),
    claim: field({ user: "alice@example.com", branch: "story/T-001", since: "2026-07-28T09:00:00.000Z" }),
    claimedBySession: field(SESSION_A),
    ...over,
  };
}

/** The postimage a `complete` transaction intends: complete, claim gone. */
function completedSnapshot(): TicketSnapshot {
  return snapshot({
    status: field("complete"),
    completedDate: field("2026-07-28"),
    claim: field(null, false),
    claimedBySession: field(null, false),
  });
}

function txn(over: Partial<ClaimTxn> = {}): ClaimTxn {
  return {
    kind: "complete",
    phase: "prepared",
    ticketId: "t-abc",
    transitionId: NONCE,
    fromEpoch: {
      ticketId: "t-abc",
      sessionId: SESSION_A,
      user: "alice@example.com",
      branch: "story/T-001",
      since: "2026-07-28T09:00:00.000Z",
      establishedAt: "2026-07-28T09:00:00.000Z",
    },
    toEpoch: null,
    fromBusiness: snapshot(),
    toBusiness: completedSnapshot(),
    startedAt: "2026-07-28T11:00:00.000Z",
    ...over,
  };
}

const recover = (t: ClaimTxn, observed: TicketSnapshot, nonce: string | null) =>
  recoverClaimTransaction(t, { observed, nonce });

describe("claim transaction recovery (T-442)", () => {
  describe('phase "prepared"', () => {
    it("retries the mutation when the preimage is untouched", () => {
      expect(recover(txn(), snapshot(), null).action).toBe("apply-mutation");
    });

    it("advances when the mutation landed and carries our nonce", () => {
      expect(recover(txn(), completedSnapshot(), NONCE).action).toBe("commit-epoch");
    });

    it("fails closed on our postimage WITHOUT the nonce, which is ambiguous here", () => {
      // A foreign actor can produce exactly `status: complete` with no claim. In
      // "prepared" that is indistinguishable from our own landed write, so it is
      // never treated as success. (Under "ticket_applied" the same observation IS
      // legal -- that is why the phase must be persisted.)
      expect(recover(txn(), completedSnapshot(), null).action).toBe("recovery-required");
    });

    it("fails closed on a different nonce", () => {
      expect(recover(txn(), completedSnapshot(), "txn-9999").action).toBe("recovery-required");
    });
  });

  describe('phase "ticket_applied"', () => {
    const applied = txn({ phase: "ticket_applied" });

    it("removes the nonce when the postimage still carries it", () => {
      expect(recover(applied, completedSnapshot(), NONCE).action).toBe("remove-nonce");
    });

    it("clears the intent when cleanup already ran, instead of wedging", () => {
      // Crash between steps 4 and 5. A nonce-required rule would call this foreign
      // and the session would never converge.
      expect(recover(applied, completedSnapshot(), null).action).toBe("clear-intent");
    });

    it("fails closed when the snapshot is not the one we intended", () => {
      expect(recover(applied, snapshot(), null).action).toBe("recovery-required");
    });
  });

  describe("foreign writes that resemble our postimage", () => {
    it("rejects a foreign claim change that preserved our nonce through a spread", () => {
      // The reason the whole business snapshot is compared rather than just status
      // plus nonce: an object spread carries claimTxnId along for free.
      const tampered = { ...completedSnapshot(), claim: field({ user: "bob@example.com", branch: "x", since: "2026-07-28T11:00:00.000Z" }) };
      expect(recover(txn(), tampered, NONCE).action).toBe("recovery-required");
    });

    it("rejects a foreign completedDate edit", () => {
      const tampered = { ...completedSnapshot(), completedDate: field("2026-07-29") };
      expect(recover(txn(), tampered, NONCE).action).toBe("recovery-required");
    });

    it("rejects a foreign lifecycle change", () => {
      const tampered = { ...completedSnapshot(), lifecycle: field("tombstoned") };
      expect(recover(txn(), tampered, NONCE).action).toBe("recovery-required");
    });

    it("rejects a postimage with the right values but the wrong key shape", () => {
      // present:true/value:null is not the same as an absent key -- the existing
      // claim cleanup gates on key presence (ISS-759), so the snapshot must too.
      const tampered = { ...completedSnapshot(), claimedBySession: field(null, true) };
      expect(recover(txn(), tampered, NONCE).action).toBe("recovery-required");
    });

    it("rejects a tombstoned target", () => {
      const tampered = { ...completedSnapshot(), lifecycle: field("deleted") };
      expect(recover(txn(), tampered, null).action).toBe("recovery-required");
    });
  });

  it("never returns a write action for any unmatched combination", () => {
    // Exhaustiveness: the predicate fails closed by default rather than falling
    // through to an optimistic branch.
    const unmatched = snapshot({ status: field("open") });
    for (const phase of ["prepared", "ticket_applied"] as const) {
      for (const nonce of [null, NONCE, "txn-9999"]) {
        expect(recover(txn({ phase }), unmatched, nonce).action).toBe("recovery-required");
      }
    }
  });
});
