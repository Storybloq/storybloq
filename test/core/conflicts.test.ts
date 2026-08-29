import { describe, it, expect } from "vitest";
import { hasConflicts, assertNoConflicts } from "../../src/core/conflicts.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState } from "./test-factories.js";

describe("hasConflicts", () => {
  it("returns false when no conflicts", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001" })],
      issues: [makeIssue({ id: "ISS-001" })],
    });
    const report = hasConflicts(state);
    expect(report.hasConflicts).toBe(false);
    expect(report.items).toHaveLength(0);
  });

  it("detects ticket with _conflicts", () => {
    const ticket = makeTicket({ id: "T-001" });
    (ticket as Record<string, unknown>)._conflicts = [
      { fieldPath: "status", kind: "field", base: "open", ours: "inprogress", theirs: "complete" },
    ];
    const state = makeState({ tickets: [ticket] });
    const report = hasConflicts(state);
    expect(report.hasConflicts).toBe(true);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.type).toBe("ticket");
    expect(report.items[0]!.id).toBe("T-001");
    expect(report.items[0]!.conflictCount).toBe(1);
  });

  it("detects issue with _conflicts", () => {
    const issue = makeIssue({ id: "ISS-001" });
    (issue as Record<string, unknown>)._conflicts = [
      { fieldPath: "severity", kind: "field", base: "low", ours: "high", theirs: "medium" },
    ];
    const state = makeState({ issues: [issue] });
    const report = hasConflicts(state);
    expect(report.hasConflicts).toBe(true);
    expect(report.items[0]!.type).toBe("issue");
  });

  it("reports all conflicted items", () => {
    const t1 = makeTicket({ id: "T-001" });
    (t1 as Record<string, unknown>)._conflicts = [
      { fieldPath: "status", kind: "field", base: "a", ours: "b", theirs: "c" },
    ];
    const t2 = makeTicket({ id: "T-002" });
    const n1 = makeNote({ id: "N-001" });
    (n1 as Record<string, unknown>)._conflicts = [
      { fieldPath: "content", kind: "field", base: "a", ours: "b", theirs: "c" },
      { fieldPath: "title", kind: "field", base: "a", ours: "b", theirs: "c" },
    ];
    const state = makeState({ tickets: [t1, t2], notes: [n1] });
    const report = hasConflicts(state);
    expect(report.hasConflicts).toBe(true);
    expect(report.items).toHaveLength(2);
    expect(report.items.map((i) => i.id).sort()).toEqual(["N-001", "T-001"]);
    const noteItem = report.items.find((i) => i.id === "N-001");
    expect(noteItem!.conflictCount).toBe(2);
  });

  it("T-478: detects a conflicted arrangement when the optional arrangements parameter is supplied", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
    const report = hasConflicts(state, [
      { id: "a-0123456789abcdef", _conflicts: [{ fieldPath: "lifecycle", kind: "field", base: "active", ours: "suspended", theirs: "closed" }] },
      { id: "a-fedcba9876543210" },
    ]);
    expect(report.hasConflicts).toBe(true);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]!.type).toBe("arrangement");
    expect(report.items[0]!.id).toBe("a-0123456789abcdef");
  });

  it("T-478: omitting the arrangements parameter leaves behavior unchanged (backward compat)", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
    const report = hasConflicts(state);
    expect(report.hasConflicts).toBe(false);
  });
});

describe("assertNoConflicts", () => {
  it("throws when conflicts present", () => {
    const ticket = makeTicket({ id: "T-001" });
    (ticket as Record<string, unknown>)._conflicts = [
      { fieldPath: "status", kind: "field", base: "a", ours: "b", theirs: "c" },
    ];
    const state = makeState({ tickets: [ticket] });
    expect(() => assertNoConflicts(state)).toThrow("unresolved conflicts");
  });

  it("does not throw when clean", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
    expect(() => assertNoConflicts(state)).not.toThrow();
  });
});
