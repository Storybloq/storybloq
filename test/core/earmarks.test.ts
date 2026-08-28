import { describe, it, expect } from "vitest";
import {
  tryAcquireEarmark,
  canPlaceEarmark,
  isEarmarkVisible,
  notHiddenByEarmark,
  isTicketEarmarkStale,
  isIssueEarmarkStale,
  provenEarmarkOwnership,
  describeEarmarkHolder,
  clearSameSessionEarmark,
  earmarkMatchesArrangement,
} from "../../src/core/earmarks.js";
import type { Earmark } from "../../src/models/types.js";

const ARRANGEMENT_ID = "a-0123456789abcdef";
const RESERVED_BY = { client: "claude" as const, id: "task-1" };
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function reserved(overrides: Partial<Earmark> = {}): Earmark {
  return {
    stage: "reserved",
    reservedBy: RESERVED_BY,
    arrangementId: ARRANGEMENT_ID,
    since: "2026-08-28T00:00:00.000Z",
    holderRole: "worker",
    holderSession: null,
    ...overrides,
  } as Earmark;
}

function assigned(overrides: Partial<Earmark> = {}): Earmark {
  return {
    stage: "assigned",
    reservedBy: RESERVED_BY,
    arrangementId: ARRANGEMENT_ID,
    since: "2026-08-28T00:00:00.000Z",
    holderRole: "worker",
    holderSession: SESSION_A,
    ...overrides,
  } as Earmark;
}

describe("tryAcquireEarmark (R5 -- convert, never clear)", () => {
  it("acts as a no-op when there is no earmark", () => {
    const result = tryAcquireEarmark(null, SESSION_A, "worker");
    expect(result).toEqual({ ok: true, write: null });
  });

  it("converts a role-matching reservation into an assignment to the picking session", () => {
    const result = tryAcquireEarmark(reserved({ holderRole: "worker" }), SESSION_A, "worker");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.write).not.toBeNull();
      expect(result.write?.stage).toBe("assigned");
      expect((result.write as Earmark & { stage: "assigned" }).holderSession).toBe(SESSION_A);
    }
  });

  it("refuses a reservation held for a different role", () => {
    const result = tryAcquireEarmark(reserved({ holderRole: "pen" }), SESSION_A, "worker");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.holder.holderRole).toBe("pen");
  });

  it("passes with no write when already assigned to this session", () => {
    const result = tryAcquireEarmark(assigned({ holderSession: SESSION_A }), SESSION_A, "worker");
    expect(result).toEqual({ ok: true, write: null });
  });

  it("refuses an assignment held by another session (pick-vs-pick, R5's core fix)", () => {
    const result = tryAcquireEarmark(assigned({ holderSession: SESSION_B }), SESSION_A, "worker");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.holder.holderSession).toBe(SESSION_B);
  });

  it("never returns a write that clears the earmark -- every ok:true either mints assigned or leaves it null", () => {
    for (const current of [null, reserved({ holderRole: "worker" }), assigned({ holderSession: SESSION_A })]) {
      const result = tryAcquireEarmark(current, SESSION_A, "worker");
      if (result.ok) {
        expect(result.write === null || result.write?.stage === "assigned").toBe(true);
      }
    }
  });

  it("closes the two-transaction gap (pick-ticket.ts's issue path): a rival placement against the JUST-CONVERTED earmark is refused, never overwrites it", () => {
    // Simulates the sequence across pick-ticket.ts's two sequential locked
    // transactions for the issue path: transaction 1 (this test) converts a
    // worker-reservation into an assignment to SESSION_A via tryAcquireEarmark.
    // A rival's placement call, reading that now-committed state, must refuse
    // via canPlaceEarmark -- CAS logic, not lock mechanics, so composing the
    // two pure functions directly proves the gap is closed without needing
    // real process concurrency.
    const acquisition = tryAcquireEarmark(reserved({ holderRole: "worker" }), SESSION_A, "worker");
    expect(acquisition.ok).toBe(true);
    const committed = acquisition.ok && acquisition.write ? acquisition.write : reserved({ holderRole: "worker" });

    const rivalAttempt = assigned({ holderSession: SESSION_B });
    const rivalResult = canPlaceEarmark(committed, "open", rivalAttempt);

    expect(rivalResult.ok).toBe(false);
    if (!rivalResult.ok) {
      expect(rivalResult.holder.stage).toBe("assigned");
      expect((rivalResult.holder as Earmark & { stage: "assigned" }).holderSession).toBe(SESSION_A);
    }
  });
});

describe("canPlaceEarmark (placement CAS, section 6)", () => {
  it("accepts a fresh placement over an absent earmark on an open item", () => {
    const result = canPlaceEarmark(null, "open", reserved());
    expect(result).toEqual({ ok: true, earmark: reserved() });
  });

  it("refuses placement over a non-open item, even with no existing earmark", () => {
    const result = canPlaceEarmark(null, "inprogress", reserved());
    expect(result.ok).toBe(false);
  });

  it("refuses a conflicting placement over an existing reservation", () => {
    const existing = reserved({ holderRole: "worker" });
    const attempt = reserved({ holderRole: "pen" });
    const result = canPlaceEarmark(existing, "open", attempt);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.holder).toEqual(existing);
  });

  it("refuses a conflicting placement over an existing assignment", () => {
    const existing = assigned({ holderSession: SESSION_A });
    const attempt = assigned({ holderSession: SESSION_B });
    const result = canPlaceEarmark(existing, "open", attempt);
    expect(result.ok).toBe(false);
  });

  it("accepts an exact idempotent retry (same identity, different since)", () => {
    const existing = reserved({ since: "2026-08-28T00:00:00.000Z" });
    const retry = reserved({ since: "2026-08-28T00:00:05.000Z" });
    const result = canPlaceEarmark(existing, "open", retry);
    expect(result).toEqual({ ok: true, earmark: existing });
  });

  it("accepts an explicit reserved -> assigned conversion for a matching role", () => {
    const existing = reserved({ holderRole: "worker" });
    const conversion = assigned({ holderRole: "worker", holderSession: SESSION_A });
    const result = canPlaceEarmark(existing, "open", conversion);
    expect(result).toEqual({ ok: true, earmark: conversion });
  });

  it("refuses a reserved -> assigned conversion for a mismatched role", () => {
    const existing = reserved({ holderRole: "worker" });
    const conversion = assigned({ holderRole: "pen", holderSession: SESSION_A });
    const result = canPlaceEarmark(existing, "open", conversion);
    expect(result.ok).toBe(false);
  });

  it("never accepts overwriting an assigned earmark back to reserved (not a valid transition)", () => {
    const existing = assigned({ holderSession: SESSION_A });
    const attempt = reserved({ holderRole: "worker" });
    const result = canPlaceEarmark(existing, "open", attempt);
    expect(result.ok).toBe(false);
  });
});

describe("isEarmarkVisible", () => {
  it("is true for an item with no earmark", () => {
    expect(isEarmarkVisible({ earmark: null })).toBe(true);
    expect(isEarmarkVisible({})).toBe(true);
  });

  it("is false for any earmarked item, reserved or assigned", () => {
    expect(isEarmarkVisible({ earmark: reserved() })).toBe(false);
    expect(isEarmarkVisible({ earmark: assigned() })).toBe(false);
  });
});

describe("isTicketEarmarkStale (AM-a)", () => {
  const NOW = "2026-08-30T00:00:00.000Z"; // 48h after the fixture's `since`

  it("is never stale with no earmark", () => {
    expect(isTicketEarmarkStale({ earmark: null }, 24, NOW)).toBe(false);
  });

  it("is never stale for an assigned earmark backing the matching claim, regardless of age", () => {
    const ticket = { earmark: assigned({ holderSession: SESSION_A }), claimedBySession: SESSION_A };
    expect(isTicketEarmarkStale(ticket, 1, NOW)).toBe(false);
  });

  it("is stale for a reserved earmark past the threshold", () => {
    expect(isTicketEarmarkStale({ earmark: reserved() }, 24, NOW)).toBe(true);
  });

  it("is not yet stale for a reserved earmark under the threshold", () => {
    expect(isTicketEarmarkStale({ earmark: reserved() }, 72, NOW)).toBe(false);
  });

  it("is stale for an assigned earmark with no matching claim, past threshold", () => {
    const ticket = { earmark: assigned({ holderSession: SESSION_A }), claimedBySession: null };
    expect(isTicketEarmarkStale(ticket, 24, NOW)).toBe(true);
  });

  it("fails closed (stale) on an unparseable since", () => {
    expect(isTicketEarmarkStale({ earmark: reserved({ since: "not-a-date" }) }, 24, NOW)).toBe(true);
  });
});

describe("isIssueEarmarkStale (AM-b -- issues have no claim to match against)", () => {
  const NOW = "2026-08-30T00:00:00.000Z";

  it("is never stale with no earmark", () => {
    expect(isIssueEarmarkStale({ earmark: null }, 24, NOW)).toBe(false);
  });

  it("is ALWAYS stale-eligible for an assigned earmark past threshold -- no matching-claim exemption exists for issues", () => {
    expect(isIssueEarmarkStale({ earmark: assigned() }, 24, NOW)).toBe(true);
  });

  it("is not yet stale for an assigned earmark under the threshold (dead-session sweep strand, not yet flaggable)", () => {
    expect(isIssueEarmarkStale({ earmark: assigned() }, 72, NOW)).toBe(false);
  });

  it("flags a dead-session sweep strand: issue inprogress + assigned + no live session, once past threshold", () => {
    // The exact residue a session dying mid-sweep leaves behind: the choke
    // point already set status to inprogress and converted/left the earmark
    // assigned before the crash, so both fields are present exactly as a
    // live acquisition would leave them. No claimedBySession field exists on
    // Issue at all -- the strand is indistinguishable from a live assignment
    // except by age, which is exactly what this check is for.
    const strandedIssue = { status: "inprogress", earmark: assigned({ since: "2026-08-01T00:00:00.000Z" }) };
    expect(isIssueEarmarkStale(strandedIssue, 24, NOW)).toBe(true);
  });

  it("is stale for a reserved earmark past threshold", () => {
    expect(isIssueEarmarkStale({ earmark: reserved() }, 24, NOW)).toBe(true);
  });
});

describe("provenEarmarkOwnership", () => {
  it("authorizes the reserver (ownerTask) to release a reserved earmark", () => {
    expect(provenEarmarkOwnership(reserved(), { kind: "ownerTask", value: RESERVED_BY })).toBe(true);
  });

  it("authorizes the reserver (ownerTask) to release an assigned earmark they placed", () => {
    expect(provenEarmarkOwnership(assigned(), { kind: "ownerTask", value: RESERVED_BY })).toBe(true);
  });

  it("refuses a different ownerTask", () => {
    expect(
      provenEarmarkOwnership(reserved(), { kind: "ownerTask", value: { client: "claude", id: "task-2" } }),
    ).toBe(false);
    expect(
      provenEarmarkOwnership(reserved(), { kind: "ownerTask", value: { client: "codex", id: "task-1" } }),
    ).toBe(false);
  });

  it("authorizes the assigned holder's own session to self-decline", () => {
    expect(provenEarmarkOwnership(assigned({ holderSession: SESSION_A }), { kind: "session", value: SESSION_A })).toBe(true);
  });

  it("refuses a different session's self-decline attempt", () => {
    expect(provenEarmarkOwnership(assigned({ holderSession: SESSION_A }), { kind: "session", value: SESSION_B })).toBe(false);
  });

  it("refuses a session-kind actor against a reserved earmark (no holderSession to match)", () => {
    expect(provenEarmarkOwnership(reserved(), { kind: "session", value: SESSION_A })).toBe(false);
  });
});

describe("describeEarmarkHolder", () => {
  it("names the session and role for an assigned earmark", () => {
    expect(describeEarmarkHolder(assigned({ holderSession: SESSION_A, holderRole: "worker" }))).toContain(SESSION_A);
  });

  it("names the role for a reserved earmark", () => {
    expect(describeEarmarkHolder(reserved({ holderRole: "pen" }))).toContain("pen");
  });
});

describe("notHiddenByEarmark (T-475 section 5: mixed open+inprogress listings)", () => {
  it("hides an OPEN item earmarked to anyone", () => {
    expect(notHiddenByEarmark({ status: "open", earmark: reserved() })).toBe(false);
    expect(notHiddenByEarmark({ status: "open", earmark: assigned() })).toBe(false);
  });

  it("shows an OPEN item with no earmark", () => {
    expect(notHiddenByEarmark({ status: "open", earmark: null })).toBe(true);
  });

  it("never hides an INPROGRESS item, earmarked or not -- R5's normal worked state", () => {
    expect(notHiddenByEarmark({ status: "inprogress", earmark: assigned() })).toBe(true);
    expect(notHiddenByEarmark({ status: "inprogress", earmark: null })).toBe(true);
  });

  it("passes any other status through untouched", () => {
    expect(notHiddenByEarmark({ status: "complete", earmark: assigned() })).toBe(true);
    expect(notHiddenByEarmark({ status: "resolved", earmark: assigned() })).toBe(true);
  });
});

describe("clearSameSessionEarmark (T-475 section 5: PARK/SKIP/cancel/completion self-decline)", () => {
  it("clears an assigned earmark held by the given session", () => {
    const item = { earmark: assigned({ holderSession: SESSION_A }) };
    const result = clearSameSessionEarmark(item, SESSION_A);
    expect(result).toEqual({ cleared: true, item: { earmark: null } });
  });

  it("leaves an assigned earmark held by a DIFFERENT session untouched", () => {
    const item = { earmark: assigned({ holderSession: SESSION_A }) };
    const result = clearSameSessionEarmark(item, SESSION_B);
    expect(result).toEqual({ cleared: false, item });
    expect(result.item).toBe(item); // same reference -- no spurious copy
  });

  it("never touches a reserved earmark -- it names no session to match against", () => {
    const item = { earmark: reserved() };
    const result = clearSameSessionEarmark(item, SESSION_A);
    expect(result).toEqual({ cleared: false, item });
  });

  it("is a no-op on an item with no earmark at all", () => {
    const item = { earmark: null };
    const result = clearSameSessionEarmark(item, SESSION_A);
    expect(result).toEqual({ cleared: false, item });
  });

  it("preserves every other field on the item it clears", () => {
    const item = { id: "T-001", status: "inprogress", earmark: assigned({ holderSession: SESSION_A }) };
    const { item: next } = clearSameSessionEarmark(item, SESSION_A);
    expect(next).toEqual({ id: "T-001", status: "inprogress", earmark: null });
  });
});

describe("earmarkMatchesArrangement (T-475 section 5: arrangement-close bulk clear)", () => {
  it("matches a reserved earmark naming the arrangement", () => {
    expect(earmarkMatchesArrangement(reserved({ arrangementId: ARRANGEMENT_ID }), ARRANGEMENT_ID)).toBe(true);
  });

  it("matches an assigned earmark naming the arrangement", () => {
    expect(earmarkMatchesArrangement(assigned({ arrangementId: ARRANGEMENT_ID }), ARRANGEMENT_ID)).toBe(true);
  });

  it("does not match an earmark naming a DIFFERENT arrangement", () => {
    expect(earmarkMatchesArrangement(assigned({ arrangementId: "a-fedcba9876543210" }), ARRANGEMENT_ID)).toBe(false);
  });

  it("does not match an absent earmark", () => {
    expect(earmarkMatchesArrangement(null, ARRANGEMENT_ID)).toBe(false);
    expect(earmarkMatchesArrangement(undefined, ARRANGEMENT_ID)).toBe(false);
  });
});
