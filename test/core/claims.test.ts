import { describe, it, expect } from "vitest";
import {
  buildClaim,
  canClaim,
  isClaimStale,
  clearClaimOnComplete,
  releaseClaimIfOwned,
  releaseSessionClaim,
  applyClaimAnnotations,
} from "../../src/core/claims.js";
import type { Claim } from "../../src/models/types.js";
import type { Ticket } from "../../src/models/ticket.js";
import { makeTicket, makeState, makeRoadmap, makePhase } from "./test-factories.js";

const now = "2026-05-26T12:00:00.000Z";

describe("buildClaim", () => {
  it("creates claim with user, branch, and timestamp", () => {
    const claim = buildClaim("alice@example.com", "feature/foo", now);
    expect(claim.user).toBe("alice@example.com");
    expect(claim.branch).toBe("feature/foo");
    expect(claim.since).toBe(now);
  });
});

describe("canClaim", () => {
  it("allows claim on unclaimed ticket", () => {
    const ticket = makeTicket({ id: "T-001" }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(true);
  });

  it("allows re-claim by same user on same branch", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(true);
  });

  it("rejects claim when claimed by another user without force", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "bob@example.com", branch: "feature/bar", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo");
    expect(result.allowed).toBe(false);
    expect(result.claimedBy).toBe("bob@example.com");
  });

  it("allows claim when forced even if claimed by another", () => {
    const ticket = makeTicket({
      id: "T-001",
      claim: { user: "bob@example.com", branch: "feature/bar", since: now },
    }) as Ticket;
    const result = canClaim(ticket, "alice@example.com", "feature/foo", true);
    expect(result.allowed).toBe(true);
  });
});

describe("isClaimStale", () => {
  it("returns false for fresh claim within threshold", () => {
    const claim: Claim = { user: "alice@example.com", branch: "feature/foo", since: now };
    const checkTime = new Date(now).getTime() + 1 * 60 * 60 * 1000; // 1 hour later
    expect(isClaimStale(claim, 48, checkTime)).toBe(false);
  });

  it("returns true for claim older than threshold", () => {
    const claim: Claim = { user: "alice@example.com", branch: "feature/foo", since: now };
    const checkTime = new Date(now).getTime() + 49 * 60 * 60 * 1000; // 49 hours later
    expect(isClaimStale(claim, 48, checkTime)).toBe(true);
  });
});

describe("clearClaimOnComplete", () => {
  it("clears a claim-only ticket when the completing email matches", () => {
    // No claimedBySession: there is no independent session stamp to prove, so a
    // matching git identity is the whole of the available evidence.
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = clearClaimOnComplete(ticket, { completingUser: "alice@example.com" });
    expect(result.rejected).toBe(false);
    expect(result.ticket.claim).toBeUndefined();
  });

  it("rejects a session-stamped ticket on matching email alone", () => {
    // The two ownership fields are independent: email proves the `claim` half
    // and says nothing about `claimedBySession`. Accepting it here would let a
    // CLI completion bypass the autonomous completion path entirely.
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
      claimedBySession: "session-1",
    }) as Ticket;
    const result = clearClaimOnComplete(ticket, { completingUser: "alice@example.com" });
    expect(result.rejected).toBe(true);
    expect(result.ticket.status).toBe("inprogress");
    expect(result.ticket.claim).toBeDefined();
    expect(result.ticket.claimedBySession).toBe("session-1");
  });

  it("clears a session-stamped ticket when a live epoch proves the stamp is ours", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
      claimedBySession: "session-1",
    }) as Ticket;
    const result = clearClaimOnComplete(ticket, {
      completingUser: "alice@example.com",
      activeEpochs: [{
        ticketId: "T-001",
        sessionId: "session-1",
        user: "alice@example.com",
        branch: "feature/foo",
        since: now,
        establishedAt: now,
      }],
    });
    expect(result.rejected).toBe(false);
    expect(result.ticket.claim).toBeUndefined();
    expect(result.ticket.claimedBySession).toBeUndefined();
  });

  it("rejects when a live epoch names the right session but a stale claim tuple", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
      claimedBySession: "session-1",
    }) as Ticket;
    const result = clearClaimOnComplete(ticket, {
      completingUser: "alice@example.com",
      activeEpochs: [{
        ticketId: "T-001",
        sessionId: "session-1",
        user: "alice@example.com",
        branch: "feature/foo",
        since: "2020-01-01T00:00:00.000Z",
        establishedAt: now,
      }],
    });
    expect(result.rejected).toBe(true);
  });

  it("rejects when another live session also targets the ticket", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
      claimedBySession: "session-1",
    }) as Ticket;
    const mine = {
      ticketId: "T-001",
      sessionId: "session-1",
      user: "alice@example.com",
      branch: "feature/foo",
      since: now,
      establishedAt: now,
    };
    const theirs = { ...mine, sessionId: "session-2" };
    const result = clearClaimOnComplete(ticket, {
      completingUser: "alice@example.com",
      activeEpochs: [mine, theirs],
    });
    expect(result.rejected).toBe(true);
  });

  it("the administrative bypass clears both fields with no proof at all", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claim: { user: "someone-else@example.com", branch: "main", since: now },
      claimedBySession: "session-9",
    }) as Ticket;
    const result = clearClaimOnComplete(ticket, {
      completingUser: null,
      activeEpochs: [],
      authorized: true,
    });
    expect(result.rejected).toBe(false);
    expect(result.ticket.claim).toBeUndefined();
    expect(result.ticket.claimedBySession).toBeUndefined();
  });

  it("preserves claim when ticket is not complete", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "inprogress",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
    }) as Ticket;
    const result = clearClaimOnComplete(ticket, { completingUser: "alice@example.com" });
    expect(result.ticket.claim).toBeDefined();
  });

  // ISS-759(a): the gate must be key PRESENCE, not truthiness. A completed
  // ticket carrying claimedBySession: null (the pre-ISS-652 release shape)
  // must still have the KEY stripped, not survive as an explicit null.
  it("strips a present-but-null claimedBySession key on complete (ISS-759)", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "complete",
      claimedBySession: null,
    }) as Ticket;
    const result = clearClaimOnComplete(ticket, { completingUser: null });
    expect("claimedBySession" in result.ticket).toBe(false);
    expect("claim" in result.ticket).toBe(false);
  });
});

/**
 * T-442 / ISS-784. Six sites release claims today, and all six accept
 * `claimedBySession === sessionId` and then delete BOTH keys. In the reachable
 * split state `{ claimedBySession: A, claim.user: B }` -- produced whenever the
 * merge driver hands claim.user to B without touching A's stamp -- session A
 * therefore destroys B's winning claim. Three of those sites (the skip_ticket
 * paths in plan.ts, plan-review.ts, code-review.ts) check only the stamp and were
 * never hardened by ISS-778/ISS-816 at all.
 *
 * `releaseClaimIfOwned` is the single predicate all six route through.
 */
describe("releaseClaimIfOwned (T-442)", () => {
  const epoch = {
    ticketId: "T-001",
    sessionId: "session-1",
    user: "alice@example.com",
    branch: "feature/foo",
    since: now,
    establishedAt: now,
  };

  it("releases when both fields match the epoch exactly", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "inprogress",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
      claimedBySession: "session-1",
    }) as Ticket;
    const result = releaseClaimIfOwned(ticket, epoch);
    expect(result.released).toBe(true);
    expect("claim" in result.ticket).toBe(false);
    expect("claimedBySession" in result.ticket).toBe(false);
    expect(result.ticket.status).toBe("open");
  });

  it("releases NOTHING in the split state, so a foreign user claim survives", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "inprogress",
      claim: { user: "bob@example.com", branch: "feature/bar", since: "2026-05-27T00:00:00.000Z" },
      claimedBySession: "session-1",
    }) as Ticket;
    const result = releaseClaimIfOwned(ticket, epoch);
    expect(result.released).toBe(false);
    expect(result.ticket.claim).toEqual({
      user: "bob@example.com",
      branch: "feature/bar",
      since: "2026-05-27T00:00:00.000Z",
    });
    expect(result.ticket.status).toBe("inprogress");
  });

  it("releases nothing on a bare ticket carrying no claim material", () => {
    // The old stamp-or-bare fallback is dropped: with migration and transaction
    // recovery in place a bare inprogress ticket has no provable owner, so
    // reopening it is not an ownership-preserving operation.
    const ticket = makeTicket({ id: "T-001", status: "inprogress" }) as Ticket;
    const result = releaseClaimIfOwned(ticket, epoch);
    expect(result.released).toBe(false);
    expect(result.ticket.status).toBe("inprogress");
  });

  it("releases nothing when the epoch belongs to a different ticket", () => {
    const ticket = makeTicket({
      id: "T-002",
      status: "inprogress",
      claim: { user: "alice@example.com", branch: "feature/foo", since: now },
      claimedBySession: "session-1",
    }) as Ticket;
    expect(releaseClaimIfOwned(ticket, epoch).released).toBe(false);
  });
});

/**
 * T-442: completion is split by BOTH fields, because an email match alone would
 * let an autonomous ticket bypass the transaction, while a claim-only CLI ticket
 * has no session state to transact in. "Autonomous ownership" means a NON-NULL
 * session uuid, not merely a present key -- a historical `claimedBySession: null`
 * ticket has no session owner (ISS-759).
 */
describe("clearClaimOnComplete ownership guard (T-442 / ISS-784)", () => {
  const completed = (over: Record<string, unknown>) =>
    makeTicket({ id: "T-001", status: "complete", ...over }) as Ticket;

  it("strips when the completing user owns the claim", () => {
    const result = clearClaimOnComplete(
      completed({ claim: { user: "alice@example.com", branch: "feature/foo", since: now } }),
      { completingUser: "alice@example.com" },
    );
    expect(result.rejected).toBe(false);
    expect("claim" in result.ticket).toBe(false);
  });

  it("REJECTS the whole completion when the claim belongs to another user", () => {
    // Completing is itself the harm to the winner, and a preserved claim on a
    // complete ticket manufactures team-doctor's invalid claim_on_complete state.
    // So status must not move either.
    const claim = { user: "bob@example.com", branch: "feature/bar", since: now };
    const result = clearClaimOnComplete(
      completed({ claim, claimedBySession: "session-2" }),
      { completingUser: "alice@example.com" },
    );
    expect(result.rejected).toBe(true);
    expect(result.ticket.claim).toEqual(claim);
    expect(result.ticket.claimedBySession).toBe("session-2");
    expect(result.ticket.status).not.toBe("complete");
  });

  it("rejects when git identity could not be resolved and a claim exists", () => {
    const result = clearClaimOnComplete(
      completed({ claim: { user: "bob@example.com", branch: "feature/bar", since: now } }),
      { completingUser: null },
    );
    expect(result.rejected).toBe(true);
  });

  it("keeps legacy behavior for a ticket carrying neither field", () => {
    const result = clearClaimOnComplete(completed({}), { completingUser: null });
    expect(result.rejected).toBe(false);
  });

  it("treats a present-but-null session stamp as NOT autonomous, yet still strips the key", () => {
    // Misclassifying this as autonomous would block a legitimate legacy
    // completion; keeping the residual key would regress ISS-759.
    const result = clearClaimOnComplete(
      completed({ claimedBySession: null }),
      { completingUser: null },
    );
    expect(result.rejected).toBe(false);
    expect("claimedBySession" in result.ticket).toBe(false);
  });

  it("rejects when an active local epoch for the ticket disagrees with the ledger", () => {
    // The local-epoch safety veto. Email alone cannot separate two sessions under
    // one repo git config, so after B takes the claim, A's completion would
    // otherwise pass the user check and clear B's claim.
    const claim = { user: "alice@example.com", branch: "feature/foo", since: now };
    const result = clearClaimOnComplete(
      completed({ claim, claimedBySession: "session-2" }),
      {
        completingUser: "alice@example.com",
        activeEpochs: [{
          ticketId: "T-001",
          sessionId: "session-1",
          user: "alice@example.com",
          branch: "feature/foo",
          since: "2026-05-01T00:00:00.000Z",
          establishedAt: now,
        }],
      },
    );
    expect(result.rejected).toBe(true);
    expect(result.ticket.claim).toEqual(claim);
  });

  it("is not vetoed by an archived session's stale epoch", () => {
    // Scanning every local record would veto permanently: a superseded session
    // retains a mismatching epoch for the ticket forever, so a later legitimate
    // claimant could never complete. Only status:"active" records are in the set.
    const result = clearClaimOnComplete(
      completed({ claim: { user: "alice@example.com", branch: "feature/foo", since: now } }),
      { completingUser: "alice@example.com", activeEpochs: [] },
    );
    expect(result.rejected).toBe(false);
  });
});

describe("applyClaimAnnotations", () => {
  const baseRec = (id: string, score: number) =>
    ({ id, kind: "ticket" as const, title: id, category: "open_ticket" as const, reason: "ready", score });

  it("downranks and annotates tickets claimed by others, keeping them visible", () => {
    const recs = [baseRec("T-001", 100), baseRec("T-002", 90)];
    const claims = new Map<string, Claim>([
      ["T-002", { user: "bob@example.com", branch: "feature/bar", since: now }],
    ]);
    const result = applyClaimAnnotations(recs, claims, "alice@example.com");
    expect(result).toHaveLength(2); // never removed (ISS-681)
    const t002 = result.find((r) => r.id === "T-002")!;
    expect(t002.claim?.user).toBe("bob@example.com");
    expect(t002.reason).toContain("claimed by bob@example.com");
    expect(t002.score).toBeLessThan(90); // downranked
  });

  it("annotates the current user's own claimed ticket without a penalty", () => {
    const recs = [baseRec("T-001", 100)];
    const claims = new Map<string, Claim>([
      ["T-001", { user: "alice@example.com", branch: "feature/foo", since: now }],
    ]);
    const result = applyClaimAnnotations(recs, claims, "alice@example.com");
    expect(result).toHaveLength(1);
    expect(result[0]!.claim?.user).toBe("alice@example.com");
    expect(result[0]!.score).toBe(100); // no penalty for owner
    expect(result[0]!.reason).not.toContain("claimed by");
  });

  it("returns recommendations unchanged when no claims exist", () => {
    const recs = [baseRec("T-001", 100)];
    const result = applyClaimAnnotations(recs, new Map(), "alice@example.com");
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(100);
    expect(result[0]!.claim).toBeUndefined();
  });

  it("downranks (never drops) claimed tickets when currentUser is null (identity unavailable)", () => {
    const recs = [baseRec("T-001", 100)];
    const claims = new Map<string, Claim>([
      ["T-001", { user: "bob@example.com", branch: "feature/bar", since: now }],
    ]);
    const result = applyClaimAnnotations(recs, claims, null);
    expect(result).toHaveLength(1); // ISS-681: never hidden, even with unknown identity
    expect(result[0]!.score).toBeLessThan(100);
    expect(result[0]!.claim?.user).toBe("bob@example.com");
  });
});

describe("releaseSessionClaim (T-442)", () => {
  const SESSION = "2b53d2fd-8f92-4cb4-b459-1df54474adc7";
  const OTHER = "9f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8";
  const SINCE = "2026-07-27T10:00:00.000Z";
  const EPOCH = {
    ticketId: "T-001",
    sessionId: SESSION,
    user: "me@example.com",
    branch: "story/T-001",
    since: SINCE,
    establishedAt: SINCE,
  };
  const claimed = (overrides: Record<string, unknown> = {}) => ({
    id: "T-001",
    title: "T",
    status: "inprogress",
    claimedBySession: SESSION,
    claim: { user: "me@example.com", branch: "story/T-001", since: SINCE },
    ...overrides,
  } as unknown as Ticket);

  it("releases and strips both keys when the epoch matches", () => {
    const { released, ticket } = releaseSessionClaim(claimed(), SESSION, EPOCH);
    expect(released).toBe(true);
    expect(ticket.status).toBe("open");
    expect("claim" in ticket).toBe(false);
    expect("claimedBySession" in ticket).toBe(false);
  });

  it("refuses to destroy a foreign claim in the split state when an epoch exists", () => {
    const split = claimed({ claim: { user: "them@example.com", branch: "main", since: SINCE } });
    const { released, ticket } = releaseSessionClaim(split, SESSION, EPOCH);
    expect(released).toBe(false);
    expect(ticket.claim?.user).toBe("them@example.com");
    expect(ticket.status).toBe("inprogress");
  });

  it("refuses when another session holds the stamp", () => {
    const { released } = releaseSessionClaim(claimed({ claimedBySession: OTHER }), SESSION, EPOCH);
    expect(released).toBe(false);
  });

  it("keeps pre-T-442 behavior for an epoch-less session whose stamp matches", () => {
    const { released, ticket } = releaseSessionClaim(claimed(), SESSION, undefined);
    expect(released).toBe(true);
    expect(ticket.status).toBe("open");
    expect("claim" in ticket).toBe(false);
  });

  it("epoch-less release still deletes a FOREIGN claim in the split state (accepted legacy risk)", () => {
    // Pins the deliberately retained pre-T-442 behavior so a future change to it
    // is a decision rather than an accident. The epoch-present test above asserts
    // the opposite for any session that can actually prove ownership.
    const split = claimed({ claim: { user: "them@example.com", branch: "main", since: "2020-01-01T00:00:00.000Z" } });
    const { released, ticket } = releaseSessionClaim(split, SESSION, undefined);
    expect(released).toBe(true);
    expect(ticket.status).toBe("open");
    expect("claim" in ticket).toBe(false);
  });

  it("refuses a partially populated epoch that claims no user but retains a branch", () => {
    const malformed = { ...EPOCH, user: null, branch: "story/T-001", since: null };
    const { released } = releaseSessionClaim(claimed(), SESSION, malformed);
    expect(released).toBe(false);
  });

  it("a null-user epoch matches only an ABSENT claim key, never an explicit null", () => {
    const bare = { ...EPOCH, user: null, branch: null, since: null };
    const keyless = { id: "T-001", title: "T", status: "inprogress", claimedBySession: SESSION } as unknown as Ticket;
    expect(releaseSessionClaim(keyless, SESSION, bare).released).toBe(true);

    const explicitNull = { ...keyless, claim: null } as unknown as Ticket;
    expect(releaseSessionClaim(explicitNull, SESSION, bare).released).toBe(false);
  });

  it("still refuses an epoch-less release when the stamp is not ours", () => {
    const { released } = releaseSessionClaim(claimed({ claimedBySession: OTHER }), SESSION, undefined);
    expect(released).toBe(false);
  });
});
