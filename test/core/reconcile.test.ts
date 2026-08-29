import { describe, it, expect } from "vitest";
import { computeReconcilePlan } from "../../src/core/reconcile.js";
import type { Arrangement } from "../../src/models/arrangement.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makeRoadmap, makePhase } from "./test-factories.js";

const state = (opts: Parameters<typeof makeState>[0]) =>
  makeState({ roadmap: makeRoadmap([makePhase({ id: "p1" })]), ...opts });

describe("computeReconcilePlan", () => {
  it("returns empty plan when no duplicates exist", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-002", createdDate: "2026-01-02" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(0);
    expect(result.plan.warnings).toHaveLength(0);
  });

  it("older createdDate wins when two tickets share a displayId", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    const rename = result.plan.renames[0]!;
    expect(rename.id).toBe("t-bbb0000000000002");
    expect(rename.oldDisplayId).toBe("T-042");
    expect(rename.newDisplayId).toMatch(/^T-\d{3,}$/);
    expect(rename.entityType).toBe("ticket");
  });

  it("valid reservation wins before timestamp", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdAt: "2026-01-01T00:00:00.000Z" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdAt: "2026-02-01T00:00:00.000Z" }),
      ],
    });
    const result = computeReconcilePlan(s, {
      reservations: {
        ticket: new Map([["T-042", "t-bbb0000000000002"]]),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-aaa0000000000001");
    expect(result.plan.renames[0]!.reason).toContain("valid reservation");
  });

  it("does not reassign a number a tombstone still holds (ISS-689)", () => {
    // T-100 is a tombstone (lifecycle deleted). Two active tickets collide on
    // T-099; the renamed loser must skip T-100 (the tombstone's number) and take
    // T-101, or restoring/surfacing the tombstone would resurrect a duplicate.
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-099", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-099", createdDate: "2026-01-15" }),
        makeTicket({ id: "t-ccc0000000000100", displayId: "T-100", createdDate: "2026-01-02", lifecycle: "deleted" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    const rename = result.plan.renames[0]!;
    expect(rename.id).toBe("t-bbb0000000000002");
    expect(rename.newDisplayId).not.toBe("T-100");
    expect(rename.newDisplayId).toBe("T-101");
  });

  it("protected branch ownership wins before timestamp", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdAt: "2026-01-01T00:00:00.000Z" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdAt: "2026-02-01T00:00:00.000Z" }),
      ],
    });
    const result = computeReconcilePlan(s, {
      protectedOwners: {
        ticket: new Set(["t-bbb0000000000002"]),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-aaa0000000000001");
    expect(result.plan.renames[0]!.reason).toContain("protected branch ownership");
  });

  it("createdAt wins over createdDate when available", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01", createdAt: "2026-02-01T00:00:00.000Z" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-03-01", createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-aaa0000000000001");
  });

  it("lower canonical id wins when timestamps are equal", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-zzz0000000000099", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-zzz0000000000099");
  });

  it("legacy item wins over canonical item with same displayId", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "T-042", createdDate: "2026-03-01" }),
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-aaa0000000000001");
  });

  it("legacy item with matching effectiveDisplayId wins over suffixed legacy item", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "T-042", displayId: "T-042", createdDate: "2026-03-01" }),
        makeTicket({ id: "T-042a", displayId: "T-042", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("T-042a");
  });

  it("resolves each entity type independently", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-001", createdDate: "2026-01-15" }),
      ],
      issues: [
        makeIssue({ id: "i-aaa0000000000001", displayId: "ISS-001", discoveredDate: "2026-01-01" }),
        makeIssue({ id: "i-bbb0000000000002", displayId: "ISS-001", discoveredDate: "2026-02-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(2);
    const ticketRename = result.plan.renames.find((r) => r.entityType === "ticket");
    const issueRename = result.plan.renames.find((r) => r.entityType === "issue");
    expect(ticketRename).toBeDefined();
    expect(issueRename).toBeDefined();
    expect(ticketRename!.id).toBe("t-bbb0000000000002");
    expect(issueRename!.id).toBe("i-bbb0000000000002");
  });

  it("refuses when any entity has non-empty _conflicts", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", _conflicts: [{ field: "title", ours: "A", theirs: "B" }] } as any),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("conflict");
  });

  it("allocates new displayId using maxSequentialNumber + 1", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-050", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-050", createdDate: "2026-01-15" }),
        makeTicket({ id: "t-ccc0000000000003", displayId: "T-100", createdDate: "2026-01-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.newDisplayId).toBe("T-101");
  });

  it("renumbers multiple losers in a three-way duplicate", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" }),
        makeTicket({ id: "t-ccc0000000000003", displayId: "T-042", createdDate: "2026-01-20" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(2);
    const newIds = result.plan.renames.map((r) => r.newDisplayId);
    expect(new Set(newIds).size).toBe(2);
  });

  it("is deterministic across input array order: same losers -> same newDisplayIds (ISS-694)", () => {
    // N-059's "concurrent reconcile (self-correcting)" invariant: two clones with
    // equivalent state must produce the SAME renumbering, so the deterministic
    // tie-breaks (loser sort + sequential nextSeq) must not depend on array order.
    const items = [
      { id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }, // winner
      { id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-01-15" },
      { id: "t-ccc0000000000003", displayId: "T-042", createdDate: "2026-01-20" },
    ];
    const planFor = (order: typeof items) => {
      const s = state({ tickets: order.map((t) => makeTicket(t)) });
      const result = computeReconcilePlan(s);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unexpected");
      return new Map(result.plan.renames.map((r) => [r.id, r.newDisplayId]));
    };

    const forward = planFor(items);
    const reversed = planFor([...items].reverse());

    // The winner (earliest createdDate) is never renamed; both losers map identically.
    expect(forward).toEqual(reversed);
    expect(forward.has("t-aaa0000000000001")).toBe(false);
    // Pinned numbers: nextSeq = max(42)+1 = 43; losers in compareEntities order.
    expect(forward.get("t-bbb0000000000002")).toBe("T-043");
    expect(forward.get("t-ccc0000000000003")).toBe("T-044");
  });

  it("produces empty plan when run on already-reconciled state (idempotent)", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "2026-01-01" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-043", createdDate: "2026-01-15" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(0);
  });

  it("item with valid timestamp wins over item with missing timestamp", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-042", createdDate: "2026-06-01" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-aaa0000000000001");
  });

  it("falls back to canonical id when both timestamps are missing", () => {
    const s = state({
      tickets: [
        makeTicket({ id: "t-zzz0000000000099", displayId: "T-042", createdDate: "" }),
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-042", createdDate: "" }),
      ],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(1);
    expect(result.plan.renames[0]!.id).toBe("t-zzz0000000000099");
  });
});

function makeArrangement(overrides: Record<string, unknown> = {}): Arrangement {
  return {
    id: "a-0123456789abcdef",
    lifecycle: "active",
    bounds: ["T-473"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "claude-session-abc" },
      { role: "worker", client: "claude", identityAnchor: "claude-session-def" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  } as Arrangement;
}

describe("T-478: computeReconcilePlan arrangements front-gate", () => {
  it("omitting arrangementScan leaves existing behavior fully unchanged", () => {
    const s = state({
      tickets: [makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" })],
    });
    const result = computeReconcilePlan(s);
    expect(result.ok).toBe(true);
  });

  it("a non-empty arrangementScan.warnings fails the plan closed before any per-arrangement check runs", () => {
    const s = state({
      tickets: [makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" })],
    });
    const result = computeReconcilePlan(s, undefined, {
      arrangements: [makeArrangement({ _conflicts: undefined })],
      warnings: ["Could not read .story/arrangements/: symlink rejected"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("Arrangement scan incomplete"))).toBe(true);
    expect(result.errors.some((e) => e.includes("symlink rejected"))).toBe(true);
  });

  it("a conflicted arrangement (non-empty _conflicts) fails the plan closed, naming the arrangement id", () => {
    const s = state({
      tickets: [makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" })],
    });
    const conflicted = makeArrangement({
      id: "a-conflictedaaaaaa",
      _conflicts: [{ fieldPath: "lifecycle", kind: "field", base: "active", ours: "suspended", theirs: "closed" }],
    });
    const result = computeReconcilePlan(s, undefined, {
      arrangements: [conflicted],
      warnings: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("Unresolved conflict on arrangement a-conflictedaaaaaa"))).toBe(true);
  });

  it("a clean arrangementScan (no warnings, no conflicts) leaves the result ok and contributes zero renames", () => {
    const s = state({
      tickets: [makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", createdDate: "2026-01-01" })],
    });
    const result = computeReconcilePlan(s, undefined, {
      arrangements: [makeArrangement()],
      warnings: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.renames).toHaveLength(0);
  });
});
