import { describe, it, expect } from "vitest";
import { computeRepairs } from "../../../src/cli/commands/repair.js";
import { makeState, makeTicket, makeIssue, makeRoadmap, makePhase } from "../../core/test-factories.js";

describe("computeRepairs", () => {
  const phase = makePhase({ id: "p1" });
  const roadmap = makeRoadmap([phase]);

  it("returns empty fixes for clean project", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-001"], phase: "p1" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes).toHaveLength(0);
    expect(result.tickets).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it("fixes issue with stale relatedTickets", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-001", "T-999"] })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0]!.entity).toBe("ISS-001");
    expect(result.fixes[0]!.field).toBe("relatedTickets");
    expect(result.issues).toHaveLength(1);
  });

  it("fixes issue with stale phase", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", phase: "nonexistent" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "ISS-001" && f.field === "phase")).toBe(true);
  });

  it("fixes ticket with stale blockedBy", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", blockedBy: ["T-999"], phase: "p1" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "blockedBy")).toBe(true);
    expect(result.tickets).toHaveLength(1);
  });

  it("fixes ticket with stale parentTicket", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", parentTicket: "T-999", phase: "p1" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "parentTicket")).toBe(true);
  });

  it("fixes ticket with stale phase", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "nonexistent" })],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.some((f) => f.entity === "T-001" && f.field === "phase")).toBe(true);
  });

  it("refuses when load has integrity warnings", () => {
    const state = makeState({ roadmap });
    const result = computeRepairs(state, [
      { file: "T-001.json", message: "Invalid JSON", type: "parse_error" },
    ]);
    expect(result.error).toBeTruthy();
    expect(result.fixes).toHaveLength(0);
  });

  it("refuses on schema_error warnings too", () => {
    const state = makeState({ roadmap });
    const result = computeRepairs(state, [
      { file: "T-002.json", message: "Missing field", type: "schema_error" },
    ]);
    expect(result.error).toBeTruthy();
  });

  it("handles multiple fixes across tickets and issues", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", blockedBy: ["T-888"], phase: "gone" }),
        makeTicket({ id: "T-002", parentTicket: "T-777", phase: "p1" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", relatedTickets: ["T-666"], phase: "also-gone" }),
      ],
      roadmap,
    });
    const result = computeRepairs(state, []);
    expect(result.fixes.length).toBeGreaterThanOrEqual(4);
    expect(result.tickets).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
  });
});
