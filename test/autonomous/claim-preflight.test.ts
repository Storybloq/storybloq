import { describe, it, expect } from "vitest";
import {
  parseClaimEpoch,
  readTicketClaimState,
  reconcileSessionReality,
  isClaimLost,
  describeClaimLoss,
} from "../../src/autonomous/claim-preflight.js";
import type { SessionState } from "../../src/autonomous/session-types.js";
import type { Ticket } from "../../src/models/ticket.js";

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

function ticket(overrides: Record<string, unknown> = {}): Ticket {
  return {
    id: "T-001",
    title: "Test",
    status: "inprogress",
    claimedBySession: SESSION,
    claim: { user: "me@example.com", branch: "story/T-001", since: SINCE },
    ...overrides,
  } as unknown as Ticket;
}

function session(overrides: Record<string, unknown> = {}): SessionState {
  return {
    sessionId: SESSION,
    state: "IMPLEMENT",
    ticket: { id: "T-001", title: "Test" },
    claimEpoch: EPOCH,
    ...overrides,
  } as unknown as SessionState;
}

const deps = (t: Ticket | null) => ({ loadTicket: async () => t });

describe("parseClaimEpoch", () => {
  it("returns null for absent, null, and non-object values", () => {
    expect(parseClaimEpoch(undefined)).toBeNull();
    expect(parseClaimEpoch(null)).toBeNull();
    expect(parseClaimEpoch("T-001")).toBeNull();
  });

  it("rejects epochs missing the identifying fields", () => {
    expect(parseClaimEpoch({ sessionId: SESSION, establishedAt: SINCE })).toBeNull();
    expect(parseClaimEpoch({ ticketId: "T-001", establishedAt: SINCE })).toBeNull();
    expect(parseClaimEpoch({ ticketId: "T-001", sessionId: SESSION })).toBeNull();
    expect(parseClaimEpoch({ ticketId: "", sessionId: SESSION, establishedAt: SINCE })).toBeNull();
  });

  it("rejects a malformed nullable field instead of degrading it to null", () => {
    // Degrading is not safe: an all-null epoch is a LEGITIMATE shape meaning "no
    // claim key existed at acquisition", and it matches a stamped ticket with no
    // claim. A corrupt epoch normalized that way would prove ownership it never had.
    expect(parseClaimEpoch({ ...EPOCH, user: 42 })).toBeNull();
    expect(parseClaimEpoch({ ...EPOCH, branch: {} })).toBeNull();
    expect(parseClaimEpoch({ ticketId: "T-001", sessionId: SESSION, establishedAt: SINCE })).toBeNull();
  });

  it("accepts explicit nulls, which are the real bare-epoch shape", () => {
    const parsed = parseClaimEpoch({ ticketId: "T-001", sessionId: SESSION, establishedAt: SINCE, user: null, branch: null, since: null });
    expect(parsed).not.toBeNull();
    expect(parsed!.user).toBeNull();
  });
});

describe("readTicketClaimState", () => {
  it("reports not-found for a missing ticket", () => {
    const s = readTicketClaimState(null);
    expect(s.found).toBe(false);
    expect(s.claimedBySession.present).toBe(false);
  });

  it("distinguishes an absent key from an explicit null", () => {
    const absent = readTicketClaimState(ticket({ claimedBySession: undefined, claim: undefined }));
    // `undefined` assigned explicitly still creates the key, so compare against a
    // genuinely key-less ticket built by omission.
    const keyless = readTicketClaimState({ id: "T-001", title: "T", status: "open" } as unknown as Ticket);
    expect(keyless.claimedBySession.present).toBe(false);
    expect(keyless.claim.present).toBe(false);

    const explicitNull = readTicketClaimState(ticket({ claimedBySession: null }));
    expect(explicitNull.claimedBySession.present).toBe(true);
    expect(explicitNull.claimedBySession.value).toBeNull();
    expect(absent.claimedBySession.present).toBe(true);
  });
});

describe("reconcileSessionReality", () => {
  it("does not check a session at FINALIZE, where its own completion is indistinguishable from a foreign one", async () => {
    // FINALIZE marks the ticket complete BEFORE the draft ticket clears, so
    // gating here would block every session at its own finish line. The
    // completion guard covers this window instead.
    const stripped = { id: "T-001", title: "T", status: "complete" } as unknown as Ticket;
    for (const st of ["FINALIZE", "COMPLETE", "HANDOVER", "LESSON_CAPTURE", "SESSION_END"]) {
      const r = await reconcileSessionReality(session({ state: st }), deps(stripped));
      expect(r.checked, `state ${st} must not be gated`).toBe(false);
    }
  });

  it("checks a re-entered PLAN, which the revise loop reaches with an epoch already minted", async () => {
    const foreign = ticket({ claim: { user: "them@example.com", branch: "main", since: "2026-07-27T11:00:00.000Z" } });
    const r = await reconcileSessionReality(session({ state: "PLAN" }), deps(foreign));
    expect(r.checked).toBe(true);
    expect(isClaimLost(r)).toBe(true);
  });

  it("leaves an initial PLAN unchecked, because it has no epoch yet", async () => {
    const r = await reconcileSessionReality(session({ state: "PLAN", claimEpoch: undefined }), deps(ticket()));
    expect(r.checked).toBe(false);
  });

  it("checks every state between PLAN and VERIFY", async () => {
    for (const st of ["PLAN", "PLAN_REVIEW", "IMPLEMENT", "WRITE_TESTS", "TEST", "CODE_REVIEW", "BUILD", "VERIFY"]) {
      const r = await reconcileSessionReality(session({ state: st }), deps(ticket()));
      expect(r.checked, `state ${st} must be gated`).toBe(true);
    }
  });

  it("does not check a session with no epoch (pre-T-442 compatibility)", async () => {
    const r = await reconcileSessionReality(session({ claimEpoch: undefined }), deps(null));
    expect(r.checked).toBe(false);
    expect(isClaimLost(r)).toBe(false);
  });

  it("fails CLOSED on a present but malformed epoch, unlike a genuinely absent one", async () => {
    // Corruption must not buy a session the pre-T-442 compatibility exception.
    const bareTicket = { id: "T-001", title: "T", status: "inprogress", claimedBySession: SESSION } as unknown as Ticket;
    const cases: Array<[unknown, Ticket]> = [
      [{}, ticket()],
      ["nonsense", ticket()],
      [42, ticket()],
      [{ ticketId: "T-001" }, ticket()],
      [{ sessionId: SESSION, establishedAt: SINCE }, ticket()],
      // The dangerous shapes: valid required fields, but nullable slots missing or
      // mistyped. Normalizing these to null would produce a bare epoch that MATCHES
      // a stamped ticket carrying no claim key, so they are checked against exactly
      // that ticket.
      [{ ticketId: "T-001", sessionId: SESSION, establishedAt: SINCE }, bareTicket],
      [{ ticketId: "T-001", sessionId: SESSION, establishedAt: SINCE, user: 42, branch: null, since: null }, bareTicket],
    ];
    for (const [bad, against] of cases) {
      const r = await reconcileSessionReality(session({ claimEpoch: bad }), deps(against));
      expect(r.checked, `epoch ${JSON.stringify(bad)}`).toBe(true);
      expect(r.reconciliation).toMatchObject({ status: "recovery-required", reason: "epoch-unverifiable" });
      expect(isClaimLost(r)).toBe(true);
    }
  });

  it("treats an explicitly null epoch as absent, matching a legacy session", async () => {
    const r = await reconcileSessionReality(session({ claimEpoch: null }), deps(ticket()));
    expect(r.checked).toBe(false);
  });

  it("does not check a session whose draft has moved off the epoch's ticket", async () => {
    const r = await reconcileSessionReality(
      session({ ticket: { id: "T-999", title: "Other" } }),
      deps(ticket()),
    );
    expect(r.checked).toBe(false);
  });

  it("reports held when both ownership fields still match", async () => {
    const r = await reconcileSessionReality(session(), deps(ticket()));
    expect(r.checked).toBe(true);
    expect(r.reconciliation!.status).toBe("held");
    expect(isClaimLost(r)).toBe(false);
  });

  it("detects a merge handing the user claim to someone else", async () => {
    const r = await reconcileSessionReality(
      session(),
      deps(ticket({ claim: { user: "them@example.com", branch: "main", since: "2026-07-27T11:00:00.000Z" } })),
    );
    expect(isClaimLost(r)).toBe(true);
    expect(r.reconciliation).toMatchObject({ status: "conflicted", detail: { kind: "user" } });
    expect(describeClaimLoss(r)).toContain("them@example.com");
  });

  it("detects another session taking the stamp", async () => {
    const r = await reconcileSessionReality(session(), deps(ticket({ claimedBySession: OTHER })));
    expect(r.reconciliation).toMatchObject({ status: "conflicted", detail: { kind: "session" } });
  });

  it("detects a full release of both fields", async () => {
    const r = await reconcileSessionReality(
      session(),
      deps({ id: "T-001", title: "T", status: "open" } as unknown as Ticket),
    );
    expect(r.reconciliation).toMatchObject({ status: "conflicted", detail: { kind: "released" } });
  });

  it("fails closed when the ticket cannot be read but the epoch exists", async () => {
    const r = await reconcileSessionReality(session(), deps(null));
    expect(r.reconciliation).toMatchObject({ status: "recovery-required", reason: "target-unreadable" });
    expect(describeClaimLoss(r)).toContain("could not be read");
  });

  it("fails closed when a loader throw makes the ticket unreadable", async () => {
    const r = await reconcileSessionReality(session(), {
      loadTicket: async () => { throw new Error("io"); },
    });
    expect(r.reconciliation).toMatchObject({ status: "recovery-required" });
  });

  it("fails closed when the ticket left inprogress with no proof this session did it", async () => {
    const r = await reconcileSessionReality(session(), deps(ticket({ status: "complete" })));
    expect(r.reconciliation).toMatchObject({ status: "recovery-required", reason: "epoch-unverifiable" });
  });

  it("a malformed epoch blocks rather than silently reconciling as bare", async () => {
    // Previously this shape parsed into an all-null epoch, which MATCHES a stamped
    // ticket with no claim key and returned held. It must now block on every ticket
    // shape, including that one.
    const malformed = { ...EPOCH, user: 42 };
    const keyless = { id: "T-001", title: "T", status: "inprogress", claimedBySession: SESSION } as unknown as Ticket;
    for (const t of [ticket(), keyless, { ...keyless, claim: null } as unknown as Ticket]) {
      const r = await reconcileSessionReality(session({ claimEpoch: malformed }), deps(t));
      expect(r.checked).toBe(true);
      expect(isClaimLost(r)).toBe(true);
    }
  });

  it("returns an empty description for a held claim", async () => {
    const r = await reconcileSessionReality(session(), deps(ticket()));
    expect(describeClaimLoss(r)).toBe("");
  });
});
