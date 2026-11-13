import { describe, expect, it } from "vitest";
import { readReceipts, ReceiptSchema, RECEIPT_ID_REGEX } from "../../src/core/receipts.js";
import { TicketSchema } from "../../src/models/ticket.js";
import { IssueSchema } from "../../src/models/issue.js";
import { BOARD, SHA, receipt } from "./receipt-fixture.js";

/** C-v4.1 3.1 to 3.4: the receipt model and the raw reader (commit 1). */

describe("the receipts field on the record schemas", () => {
  it("loads any value, so a malformed array never blocks a ticket or an issue", () => {
    for (const receipts of [undefined, "nonsense", [1, null, { id: 3 }], [receipt()]]) {
      const ticket = TicketSchema.safeParse({
        id: "T-001", title: "t", type: "task", status: "open", phase: null, order: 10, description: "",
        createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null, receipts,
      });
      expect(ticket.success, JSON.stringify(ticket.error?.issues)).toBe(true);
      const issue = IssueSchema.safeParse({
        id: "ISS-001", title: "i", status: "open", severity: "low", components: [], impact: "none",
        resolution: null, location: [], discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [], receipts,
      });
      expect(issue.success, JSON.stringify(issue.error?.issues)).toBe(true);
    }
  });
});

describe("the receipt model (v 1)", () => {
  it("accepts a well-formed receipt of each kind", () => {
    expect(ReceiptSchema.safeParse(receipt()).success).toBe(true);
    expect(ReceiptSchema.safeParse(receipt({ kind: "mutant", attestation: undefined, data: { applied: 5, killed: 4, survived: 1 } })).success).toBe(true);
    expect(ReceiptSchema.safeParse(receipt({
      kind: "review", attestation: undefined, base: "b".repeat(40),
      data: { provider: "codex", model: "m", sessionId: "s", verdict: "approve" },
    })).success).toBe(true);
    expect(ReceiptSchema.safeParse(receipt({
      kind: "device", unitRef: `${BOARD}:T-002`, covers: [`${BOARD}:T-003`],
      data: { deviceClass: "real", deviceLabel: "iPhone", build: "42" },
    })).success).toBe(true);
  });

  it("mints ids of the form rc- plus 16 Crockford characters", () => {
    expect(RECEIPT_ID_REGEX.test("rc-0123456789abcdef")).toBe(true);
    expect(RECEIPT_ID_REGEX.test("rc-0123456789abcdeu")).toBe(false);
    expect(RECEIPT_ID_REGEX.test("lm-0123456789abcdef")).toBe(false);
  });

  it.each([
    ["landing is not a receipt kind on this surface", { kind: "landing" }],
    ["test pass with failures", { data: { passed: 1, failed: 2 } }],
    ["mutant killed plus survived over applied", { kind: "mutant", attestation: undefined, data: { applied: 2, killed: 2, survived: 1 } }],
    ["review pass without approve", { kind: "review", attestation: undefined, base: "b".repeat(40), data: { verdict: "request_changes" } }],
    ["device pass built from another sha", { kind: "device", unitRef: `${BOARD}:T-002`, attestation: { builtFromSha: "c".repeat(40), builtClean: true }, data: { deviceClass: "real" } }],
    ["an unknown data key", { data: { passed: 1, extra: 1 } }],
    ["builtFromSha inside data", { data: { passed: 1, builtFromSha: SHA } }],
    ["more than 8 data keys", { kind: "review", attestation: undefined, base: "b".repeat(40), data: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])) }],
    ["test without attestation", { attestation: undefined }],
    ["review without base", { kind: "review", attestation: undefined, data: { verdict: "approve" } }],
    ["more than 32 supersedes", { supersedes: Array.from({ length: 33 }, (_, i) => `rc-${String(i).padStart(16, "0")}`) }],
    ["more than 64 covers", { kind: "device", unitRef: `${BOARD}:T-002`, covers: Array.from({ length: 65 }, (_, i) => `${BOARD}:T-${i}`), data: { deviceClass: "real" } }],
    ["a command over 1,000 bytes", { command: "x".repeat(1001) }],
    ["an unknown top-level key", { extra: true }],
  ])("refuses %s", (_label, over) => {
    expect(ReceiptSchema.safeParse(receipt(over)).success).toBe(false);
  });
});

describe("readReceipts", () => {
  it("reads missing and malformed fields", () => {
    expect(readReceipts({})).toEqual({ state: "missing" });
    expect(readReceipts({ receipts: { not: "an array" } })).toEqual({ state: "malformed" });
  });

  it("gives each entry its own state, and never aborts", () => {
    const good = receipt();
    const future = receipt({ id: "rc-1111111111111111", v: 2, kind: "something-new" });
    const noId = receipt({ id: undefined });
    const broken = receipt({ id: "rc-2222222222222222", result: "maybe" });
    const conflicted = receipt({ id: "rc-3333333333333333" });
    const read = readReceipts({
      receipts: [good, future, noId, broken, 7, conflicted],
      _conflicts: [{ fieldPath: "receipts", kind: "receipt", id: "rc-3333333333333333", base: null, ours: "d1", theirs: "d2" }],
    });
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.entries.map((e) => e.state)).toEqual(["ok", "unsupported-version", "no-id", "malformed", "malformed", "conflicted"]);
    expect(read.entries[0]).toMatchObject({ state: "ok", index: 0, receipt: { id: good.id } });
    const malformed = read.entries[3] as { state: "malformed"; path: unknown[] };
    expect(malformed.path).toEqual(["result"]);
  });

  it("reads an id kept twice by a both-resolution as conflicted-kept", () => {
    const a = receipt();
    const b = receipt({ result: "fail", data: { passed: 1, failed: 1 } });
    const read = readReceipts({ receipts: [a, b] });
    expect(read.state === "ok" && read.entries.map((e) => e.state)).toEqual(["conflicted-kept", "conflicted-kept"]);
  });

  it("counts only ok entries", () => {
    const read = readReceipts({ receipts: [receipt(), receipt({ id: "rc-4444444444444444", v: 3 })] });
    expect(read.state === "ok" && read.entries.filter((e) => e.state === "ok").length).toBe(1);
  });
});
