import { describe, it, expect } from "vitest";
import { validateProject } from "../../src/core/validation.js";
import { makeTicket, makeIssue, makeRuling, makeState } from "./test-factories.js";

describe("validateProject with rulings aux", () => {
  it("runs no ruling checks at all when aux.rulings is not supplied (pre-T-476 behavior unchanged)", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-does-not-exist000"] })] });
    const result = validateProject(state);
    expect(result.findings.filter((f) => f.code.includes("ruling"))).toEqual([]);
  });

  it("flags a citation to a ruling that has been superseded", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "superseded_ruling_citation");
    expect(finding).toBeDefined();
    expect(finding?.entity).toBe("T-1");
    expect(finding?.message).toContain("r-0000000000000002");
  });

  it("does not flag a citation to a current (non-superseded) ruling", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    expect(result.findings.filter((f) => f.code.includes("ruling"))).toEqual([]);
  });

  it("flags a dangling citation to a ruling id that does not exist", () => {
    const state = makeState({ issues: [makeIssue({ id: "ISS-1", citesRulings: ["r-doesnotexist0001"] })] });
    const result = validateProject(state, undefined, { rulings: [], unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "dangling_ruling_citation");
    expect(finding).toBeDefined();
    expect(finding?.entity).toBe("ISS-1");
  });

  it("flags a citation to a currently-unreadable ruling", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-broken000000001"] })] });
    const result = validateProject(state, undefined, {
      rulings: [],
      unavailableRulingIds: new Set(["r-broken000000001"]),
      rulingScanCompleteness: "complete",
    });
    const finding = result.findings.find((f) => f.code === "unreadable_ruling_citation");
    expect(finding).toBeDefined();
  });

  it("ruling #4: flags every citation as indeterminate when the ruling scan is incomplete, never dangling", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const result = validateProject(state, undefined, {
      rulings: [],
      unavailableRulingIds: new Set(),
      rulingScanCompleteness: "incomplete",
    });
    const finding = result.findings.find((f) => f.code === "ruling_indeterminate_citation");
    expect(finding).toBeDefined();
    expect(result.findings.some((f) => f.code === "dangling_ruling_citation")).toBe(false);
  });

  it("flags a ruling that supersedes itself", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000001" })];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    expect(result.findings.find((f) => f.code === "ruling_self_supersedes")).toBeDefined();
  });

  it("flags a ruling whose supersedes target does not exist", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000099" })];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    expect(result.findings.find((f) => f.code === "ruling_missing_supersedes_target")).toBeDefined();
  });

  it("flags a ruling whose supersedes target is unreadable, distinctly from a missing target", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000098" })];
    const state = makeState();
    const result = validateProject(state, undefined, {
      rulings,
      unavailableRulingIds: new Set(["r-0000000000000098"]),
      rulingScanCompleteness: "complete",
    });
    expect(result.findings.find((f) => f.code === "ruling_unreadable_supersedes_target")).toBeDefined();
    expect(result.findings.find((f) => f.code === "ruling_missing_supersedes_target")).toBeUndefined();
  });

  it("flags a supersedes cycle among rulings with the SAME code lessons use (generalized, gate-0 ruling)", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000002" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "supersedes_cycle");
    expect(finding).toBeDefined();
  });

  it("flags a supersedes branch (two rulings both superseding the same predecessor)", () => {
    const rulings = [
      makeRuling({ id: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000002", supersedes: "r-0000000000000001" }),
      makeRuling({ id: "r-0000000000000003", supersedes: "r-0000000000000001" }),
    ];
    const state = makeState();
    const result = validateProject(state, undefined, { rulings, unavailableRulingIds: new Set(), rulingScanCompleteness: "complete" });
    const finding = result.findings.find((f) => f.code === "ruling_supersedes_branch");
    expect(finding).toBeDefined();
    expect(finding?.entity).toBe("r-0000000000000001");
  });

  it("is a pure function: identical (state, now, aux) produces identical findings", () => {
    const rulings = [makeRuling({ id: "r-0000000000000001", supersedes: "r-0000000000000099" })];
    const state = makeState({ tickets: [makeTicket({ id: "T-1", citesRulings: ["r-0000000000000001"] })] });
    const aux = { rulings, unavailableRulingIds: new Set<string>(), rulingScanCompleteness: "complete" as const };
    const a = validateProject(state, "2026-08-27T00:00:00Z", aux);
    const b = validateProject(state, "2026-08-27T00:00:00Z", aux);
    expect(a).toEqual(b);
  });
});
