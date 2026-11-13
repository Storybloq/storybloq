import { describe, expect, it } from "vitest";
import { recordRevision } from "../../src/core/record-revision.js";
import { MERGE_RESOLUTION_AUTHORITY, resolveReceiptConflict } from "../../src/core/receipt-resolve.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { receipt } from "./receipt-fixture.js";

/** C-v4.1 5.2 (moved forward to commit 3): a record's revision ignores bookkeeping only. */

type Json = Record<string, unknown>;
const TICKET: Json = {
  id: "T-001", title: "Ticket", description: "d", type: "task", status: "open", phase: "p0", order: 10,
  createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null,
};
const ISSUE: Json = {
  id: "ISS-001", title: "Issue", status: "open", severity: "low", components: [], impact: "i", resolution: null,
  location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
};
const RECEIPT_CONFLICT = { kind: "receipt", id: "rc-aaaaaaaaaaaaaaaa", field: "receipts", base: [], ours: [], theirs: [] };

describe("recordRevision", () => {
  it.each([
    ["receipts and landings", { receipts: [{ id: "rc-x" }], landings: [{ sha: "a" }] }],
    ["update stamps", { updatedAt: "2026-02-02T00:00:00Z", updatedDate: "2026-02-02", lastModifiedBy: "s" }],
    ["claim and earmark", { claim: { by: "x" }, claimedBySession: "s", earmark: { id: "e" } }],
    ["rank and order", { rank: "V", order: 99 }],
    ["display ids", { displayId: "T-009", previousDisplayIds: ["T-008"] }],
    ["receipt conflicts", { _conflicts: [RECEIPT_CONFLICT, { ...RECEIPT_CONFLICT, kind: "receipt-opaque", id: "oc-0000000000000000" }] }],
    ["the resolution history (pen ruling on a 5.2 gap)", { receiptResolutions: [{ id: "rr-0000000000000000" }] }],
    ["ticket completion", { status: "complete", completedDate: "2026-03-03", lifecycle: { s: 1 }, checkpointEvidence: [{ a: 1 }], resolutionKind: "fixed" }],
  ])("a ticket's %s do not change its revision", (_l, extra) => {
    expect(recordRevision({ ...TICKET, ...extra }, "ticket")).toBe(recordRevision(TICKET, "ticket"));
  });

  it("issue completion does not change an issue's revision", () => {
    const done = { status: "resolved", resolvedDate: "2026-03-03", resolution: "fixed", resolutionKind: "fixed", lifecycle: { s: 1 } };
    expect(recordRevision({ ...ISSUE, ...done }, "issue")).toBe(recordRevision(ISSUE, "issue"));
  });

  it("a substantive field, an unknown field and a non-receipt conflict change it", () => {
    const base = recordRevision(TICKET, "ticket");
    expect(recordRevision({ ...TICKET, title: "Other" }, "ticket")).not.toBe(base);
    expect(recordRevision({ ...TICKET, someFutureField: 1 }, "ticket")).not.toBe(base);
    expect(recordRevision({ ...TICKET, _conflicts: [{ kind: "field", field: "title" }] }, "ticket")).not.toBe(base);
    expect(recordRevision({ ...ISSUE, impact: "other" }, "issue")).not.toBe(recordRevision(ISSUE, "issue"));
  });

  it("issue completion fields are substantive on a ticket only where the plan says so", () => {
    // resolvedDate is issue bookkeeping, not ticket bookkeeping.
    expect(recordRevision({ ...TICKET, resolvedDate: "2026-03-03" }, "ticket")).not.toBe(recordRevision(TICKET, "ticket"));
  });

  it("is a sha256 hex digest", () => {
    expect(recordRevision(TICKET, "ticket")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolving a receipt conflict leaves the revision unchanged", () => {
    const A = receipt({ id: "rc-aaaaaaaaaaaaaaaa" });
    const A2 = receipt({ id: "rc-aaaaaaaaaaaaaaaa", result: "fail", data: { passed: 1, failed: 1 } });
    const merged = threeWayMerge({ ...TICKET, receipts: [] }, { ...TICKET, receipts: [A] }, { ...TICKET, receipts: [A2] }, "ticket").merged as Json;
    const before = recordRevision(merged, "ticket");
    const next = structuredClone(merged);
    resolveReceiptConflict(next, { receipt: A.id as string, keep: "ours", label: "T-001" }, MERGE_RESOLUTION_AUTHORITY);
    expect(next.receiptResolutions).toHaveLength(1);
    expect(recordRevision(next, "ticket")).toBe(before);
  });

  it("a top-level key holding undefined reads as absent, as in the written file", () => {
    expect(recordRevision({ ...TICKET, ownerCheckpoint: undefined }, "ticket")).toBe(recordRevision(TICKET, "ticket"));
  });
});
