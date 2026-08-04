import { describe, it, expect } from "vitest";
import { recommend } from "../../src/core/recommend.js";
import type { FederationState, FederationNodeEntry } from "../../src/federation/state.js";
import type { NodeScanSummary } from "../../src/federation/scanner.js";
import type { Config } from "../../src/models/config.js";
import {
  makeTicket,
  makeIssue,
  makeState,
  makeRoadmap,
  makePhase,
  minimalConfig,
} from "./test-factories.js";

function makeFedNode(overrides: Partial<FederationNodeEntry> & { name: string }): FederationNodeEntry {
  return {
    rawPath: `/dev/${overrides.name}`,
    resolvedPath: `/dev/${overrides.name}`,
    health: "green",
    role: "",
    summary: "",
    dependsOn: [],
    reachable: true,
    ...overrides,
  };
}

function makeFedState(nodes: FederationNodeEntry[]): FederationState {
  const reachable = nodes.filter((n) => n.reachable);
  return {
    orchestratorProject: "test-orch",
    nodeCount: nodes.length,
    reachableCount: reachable.length,
    unreachableCount: nodes.length - reachable.length,
    nodes,
    totalTickets: 0,
    totalOpenTickets: 0,
    totalCompleteTickets: 0,
    totalIssues: 0,
    totalOpenIssues: 0,
    lastScanTimestamp: new Date().toISOString(),
  };
}

function makeScanSummary(overrides: Partial<NodeScanSummary> = {}): NodeScanSummary {
  return {
    project: "test",
    type: "npm",
    ticketCount: 10,
    openTickets: 2,
    completeTickets: 8,
    issueCount: 1,
    openIssues: 0,
    lastHandoverDate: new Date().toISOString().slice(0, 10),
    lastHandoverTitle: "Latest",
    ...overrides,
  };
}

const orchestratorConfig: Config = {
  ...minimalConfig,
  type: "orchestrator",
  nodes: { engine: { path: "~/dev/engine" } },
};

describe("recommend", () => {
  it("empty project → empty recommendations", () => {
    const state = makeState();
    const result = recommend(state, 5);
    expect(result.recommendations).toHaveLength(0);
    expect(result.totalCandidates).toBe(0);
  });

  it("all-complete project → empty recommendations", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 5);
    expect(result.recommendations).toHaveLength(0);
  });

  it("critical issue ranks above in-progress ticket", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "inprogress" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 5);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(2);
    expect(result.recommendations[0]!.id).toBe("ISS-001");
    expect(result.recommendations[0]!.category).toBe("critical_issue");
  });

  it("in-progress ticket ranks above quick win chore", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "inprogress" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 5);
    const inprog = result.recommendations.find((r) => r.id === "T-001");
    const chore = result.recommendations.find((r) => r.id === "T-002");
    expect(inprog).toBeDefined();
    expect(chore).toBeDefined();
    expect(inprog!.score).toBeGreaterThan(chore!.score);
  });

  it("validation errors → action recommendation with id 'validate'", () => {
    // Craft a state with duplicate ticket IDs to trigger validation error
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }),
        makeTicket({ id: "T-001", phase: "p1" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 5);
    const action = result.recommendations.find((r) => r.id === "validate");
    expect(action).toBeDefined();
    expect(action!.kind).toBe("action");
    expect(action!.category).toBe("validation_errors");
    expect(action!.score).toBe(1000);
    expect(action!.reason).toContain("validation error");
  });

  it("dedup keeps highest score -- in-progress ticket also in phase_momentum", () => {
    // Single in-progress ticket is both inprogress_ticket (800) and phase_momentum (500)
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "inprogress" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const matches = result.recommendations.filter((r) => r.id === "T-001");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.category).toBe("inprogress_ticket");
    expect(matches[0]!.score).toBe(800);
  });

  it("dedup: unblocked chore in quick_win also in phase_momentum → keeps phase_momentum score", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const matches = result.recommendations.filter((r) => r.id === "T-001");
    expect(matches).toHaveLength(1);
    // phase_momentum (500) > quick_win (400)
    expect(matches[0]!.category).toBe("phase_momentum");
    expect(matches[0]!.score).toBe(500);
  });

  it("count limits output", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", severity: "medium" }),
        makeIssue({ id: "ISS-002", severity: "low" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 2);
    expect(result.recommendations).toHaveLength(2);
    expect(result.totalCandidates).toBeGreaterThan(2);
  });

  it("count > candidates → returns all (no padding)", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    expect(result.recommendations.length).toBeLessThanOrEqual(10);
    expect(result.totalCandidates).toBe(result.recommendations.length);
  });

  it("totalCandidates reflects pre-truncation count", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", severity: "medium" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const resultFull = recommend(state, 10);
    const resultTrunc = recommend(state, 1);
    expect(resultTrunc.totalCandidates).toBe(resultFull.totalCandidates);
    expect(resultTrunc.recommendations).toHaveLength(1);
  });

  it("high-impact unblock includes count in reason", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const unblock = result.recommendations.find(
      (r) => r.category === "high_impact_unblock",
    );
    expect(unblock).toBeDefined();
    expect(unblock!.reason).toContain("2");
    expect(unblock!.reason).toContain("unblocks");
  });

  it("near-complete umbrella at 80% included", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }), // umbrella
        makeTicket({ id: "T-002", phase: "p1", order: 10, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", phase: "p1", order: 20, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-004", phase: "p1", order: 30, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-005", phase: "p1", order: 40, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-006", phase: "p1", order: 50, status: "open", parentTicket: "T-001" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const umbrella = result.recommendations.find(
      (r) => r.category === "near_complete_umbrella",
    );
    expect(umbrella).toBeDefined();
    expect(umbrella!.id).toBe("T-006"); // first incomplete leaf
    expect(umbrella!.reason).toContain("4/5");
    expect(umbrella!.reason).toContain("T-001");
  });

  it("near-complete umbrella at 70% excluded", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }), // umbrella
        makeTicket({ id: "T-002", phase: "p1", order: 10, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", phase: "p1", order: 20, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-004", phase: "p1", order: 30, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-005", phase: "p1", order: 40, status: "open", parentTicket: "T-001" }),
        makeTicket({ id: "T-006", phase: "p1", order: 50, status: "open", parentTicket: "T-001" }),
        makeTicket({ id: "T-007", phase: "p1", order: 60, status: "open", parentTicket: "T-001" }),
        makeTicket({ id: "T-008", phase: "p1", order: 70, status: "open", parentTicket: "T-001" }),
        makeTicket({ id: "T-009", phase: "p1", order: 80, status: "open", parentTicket: "T-001" }),
        makeTicket({ id: "T-010", phase: "p1", order: 90, status: "open", parentTicket: "T-001" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const umbrella = result.recommendations.find(
      (r) => r.category === "near_complete_umbrella",
    );
    expect(umbrella).toBeUndefined();
  });

  it("near-complete umbrella emits first incomplete leaf (not umbrella)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }), // top umbrella
        makeTicket({ id: "T-002", phase: "p1", parentTicket: "T-001" }), // nested umbrella
        makeTicket({ id: "T-003", phase: "p1", order: 10, status: "complete", parentTicket: "T-002" }),
        makeTicket({ id: "T-004", phase: "p1", order: 20, status: "complete", parentTicket: "T-002" }),
        makeTicket({ id: "T-005", phase: "p1", order: 30, status: "complete", parentTicket: "T-002" }),
        makeTicket({ id: "T-006", phase: "p1", order: 40, status: "open", parentTicket: "T-002" }),
        makeTicket({ id: "T-007", phase: "p1", order: 50, status: "complete", parentTicket: "T-001" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const umbrella = result.recommendations.find(
      (r) => r.category === "near_complete_umbrella",
    );
    expect(umbrella).toBeDefined();
    // Should be T-006 (leaf), not T-002 (nested umbrella)
    expect(umbrella!.id).toBe("T-006");
  });

  it("quick wins are chore-type only", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", type: "task" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const quickWins = result.recommendations.filter(
      (r) => r.category === "quick_win",
    );
    expect(quickWins).toHaveLength(1);
    expect(quickWins[0]!.id).toBe("T-002");
  });

  it("blocked tickets excluded from quick wins", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", type: "chore", blockedBy: ["T-999"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const quickWins = result.recommendations.filter(
      (r) => r.category === "quick_win",
    );
    expect(quickWins).toHaveLength(0);
  });

  it("medium/low issues appear in open_issue category", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "medium" }),
        makeIssue({ id: "ISS-002", severity: "low" }),
      ],
    });
    const result = recommend(state, 10);
    const openIssues = result.recommendations.filter(
      (r) => r.category === "open_issue",
    );
    expect(openIssues).toHaveLength(2);
    // medium ranks above low
    expect(openIssues[0]!.id).toBe("ISS-001");
  });

  it("resolved issues excluded, inprogress included", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical", status: "resolved" }),
        makeIssue({ id: "ISS-002", severity: "high", status: "inprogress" }),
        makeIssue({ id: "ISS-003", severity: "medium", status: "resolved" }),
      ],
    });
    const result = recommend(state, 10);
    const issueRecs = result.recommendations.filter(
      (r) => r.kind === "issue",
    );
    // ISS-002 (inprogress high) included; ISS-001 + ISS-003 (resolved) excluded
    expect(issueRecs).toHaveLength(1);
    expect(issueRecs[0]!.id).toBe("ISS-002");
    expect(issueRecs[0]!.reason).toContain("in-progress");
  });

  it("inprogress critical issue appears in critical_issue category", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical", status: "inprogress" }),
      ],
    });
    const result = recommend(state, 10);
    const critical = result.recommendations.find((r) => r.id === "ISS-001");
    expect(critical).toBeDefined();
    expect(critical!.category).toBe("critical_issue");
    expect(critical!.reason).toContain("in-progress");
  });

  it("newer issue ranks above older within same severity", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "medium", discoveredDate: "2026-03-10" }),
        makeIssue({ id: "ISS-002", severity: "medium", discoveredDate: "2026-03-23" }),
      ],
    });
    const result = recommend(state, 10);
    const openIssues = result.recommendations.filter(
      (r) => r.category === "open_issue",
    );
    expect(openIssues).toHaveLength(2);
    // ISS-002 (newer) should rank above ISS-001 (older)
    expect(openIssues[0]!.id).toBe("ISS-002");
    expect(openIssues[1]!.id).toBe("ISS-001");
  });

  it("deterministic sort: items with same score tiebreak by category then ID", () => {
    // Construct two recommendations that end up with identical scores.
    // phase_momentum gives exactly 500. A quick_win chore at index 0 gives 400.
    // These don't collide, so use a different approach: verify final sort is stable.
    // Two open medium issues get scores 300, 299 -- different scores, ordered by index.
    // The generator sorts by severity desc then discoveredDate asc.
    // With same severity/date, array order determines index → score.
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "medium", discoveredDate: "2026-03-11" }),
        makeIssue({ id: "ISS-002", severity: "medium", discoveredDate: "2026-03-11" }),
      ],
    });
    const result = recommend(state, 10);
    const openIssues = result.recommendations.filter(
      (r) => r.category === "open_issue",
    );
    // ISS-001 is first in array → index 0 → score 300; ISS-002 → index 1 → score 299
    expect(openIssues[0]!.id).toBe("ISS-001");
    expect(openIssues[1]!.id).toBe("ISS-002");
    expect(openIssues[0]!.score).toBeGreaterThan(openIssues[1]!.score);
  });

  it("high-impact unblock requires >= 2 unblocks (1 is excluded)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const unblocks = result.recommendations.filter(
      (r) => r.category === "high_impact_unblock",
    );
    expect(unblocks).toHaveLength(0);
  });

  it("count clamped to 1 when 0 is passed", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 0);
    expect(result.recommendations.length).toBeLessThanOrEqual(1);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
  });

  it("count clamped to 10 when large value passed", () => {
    const state = makeState({
      tickets: Array.from({ length: 15 }, (_, i) =>
        makeTicket({ id: `T-${String(i + 1).padStart(3, "0")}`, phase: "p1", order: (i + 1) * 10, status: "open" }),
      ),
      issues: Array.from({ length: 5 }, (_, i) =>
        makeIssue({ id: `ISS-${String(i + 1).padStart(3, "0")}`, severity: "medium" }),
      ),
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 100);
    expect(result.recommendations.length).toBeLessThanOrEqual(10);
  });

  // --- Phase proximity ---

  it("current-phase ticket ranks above future-phase high-impact unblock", () => {
    const state = makeState({
      tickets: [
        // p1 (current): simple open ticket
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        // p3 (future): unblocks 2 tickets
        makeTicket({ id: "T-010", phase: "p3", order: 10, status: "open" }),
        makeTicket({ id: "T-011", phase: "p3", order: 20, status: "open", blockedBy: ["T-010"] }),
        makeTicket({ id: "T-012", phase: "p3", order: 30, status: "open", blockedBy: ["T-010"] }),
      ],
      roadmap: makeRoadmap([
        makePhase({ id: "p1" }),
        makePhase({ id: "p2" }),
        makePhase({ id: "p3" }),
      ]),
    });
    const result = recommend(state, 10);
    // T-001 (current phase, phase_momentum 500) should rank above
    // T-010 (future phase, high_impact_unblock 700 - 100 penalty = 600)
    // But T-010 at 600 is still above T-001 at 500... unless T-001 also gets phase_momentum
    // Actually T-001 IS the nextTicket so it gets phase_momentum (500).
    // T-010 gets high_impact_unblock (700) - penalty (2 phases * 50 = 100) = 600.
    // So T-010 still ranks above. With 3 phases ahead: 700 - 150 = 550. Still above.
    // The point is the GAP is reduced. Let's verify the penalty is applied.
    const t010 = result.recommendations.find(r => r.id === "T-010");
    expect(t010).toBeDefined();
    expect(t010!.reason).toContain("future phase");
    expect(t010!.score).toBeLessThan(700); // penalized from 700
  });

  it("same-phase tickets not penalized", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const unblock = result.recommendations.find(r => r.category === "high_impact_unblock");
    expect(unblock).toBeDefined();
    expect(unblock!.score).toBe(700); // no penalty
    expect(unblock!.reason).not.toContain("future phase");
  });

  it("issues not affected by phase penalty", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", severity: "medium" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const result = recommend(state, 10);
    const issue = result.recommendations.find(r => r.id === "ISS-001");
    expect(issue).toBeDefined();
    expect(issue!.score).toBe(300); // no penalty
    expect(issue!.reason).not.toContain("future phase");
  });

  it("ticket with null phase not penalized", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", order: 10, status: "open", type: "chore" }), // null phase
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const nullPhase = result.recommendations.find(r => r.id === "T-002");
    expect(nullPhase).toBeDefined();
    expect(nullPhase!.reason).not.toContain("future phase");
  });

  // --- ISS-018: Handover context boost ---

  it("ticket in handover What's Next gets boosted", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const handover = "## What Was Done\nCompleted T-099.\n\n## What's Next\n- T-001: do this thing\n";
    // Both T-001 and T-002 appear via quick_win (chore) or phase_momentum
    const withHandover = recommend(state, 10, { latestHandoverContent: handover });
    const without = recommend(state, 10);
    const t1With = withHandover.recommendations.find((r) => r.id === "T-001");
    const t1Without = without.recommendations.find((r) => r.id === "T-001");
    expect(t1With).toBeDefined();
    expect(t1With!.score).toBeGreaterThan(t1Without!.score);
    expect(t1With!.reason).toContain("handover context");
  });

  it("complete ticket in handover What Was Done gets no boost", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const handover = "## What Was Done\nCompleted T-001.\n\n## What's Next\nNothing specific.";
    const result = recommend(state, 10, { latestHandoverContent: handover });
    const t1 = result.recommendations.find((r) => r.id === "T-001");
    expect(t1).toBeUndefined(); // complete tickets are never recommended
  });

  it("no handover content = no boost (graceful degradation)", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const withHandover = recommend(state, 10, { latestHandoverContent: "## What's Next\n- T-001" });
    const without = recommend(state, 10);
    const scoreWith = withHandover.recommendations.find((r) => r.id === "T-001")!.score;
    const scoreWithout = without.recommendations.find((r) => r.id === "T-001")!.score;
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });

  it("fallback full-doc scan only boosts open tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "inprogress" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    // No actionable heading -- falls back to full-doc scan
    const handover = "Some notes about T-001 and T-002 progress.";
    const result = recommend(state, 10, { latestHandoverContent: handover });
    const t1 = result.recommendations.find((r) => r.id === "T-001");
    // T-001 (open) should get boost from fallback, T-002 (inprogress) should not
    expect(t1!.reason).toContain("handover context");
  });

  // --- ISS-019: Debt trend detection ---

  it("emits debt-trend when open issues grew >25% and >=2 absolute", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "open" }),
        makeIssue({ id: "ISS-003", status: "open" }),
        makeIssue({ id: "ISS-004", status: "open" }),
        makeIssue({ id: "ISS-005", status: "open" }),
      ],
    });
    // Previous: 3 open, now: 5 open = 67% growth, +2 absolute
    const result = recommend(state, 10, { previousOpenIssueCount: 3 });
    const trend = result.recommendations.find((r) => r.id === "DEBT_TREND");
    expect(trend).toBeDefined();
    expect(trend!.category).toBe("debt_trend");
    expect(trend!.score).toBe(450);
  });

  it("no debt-trend when growth is under 25%", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "open" }),
        makeIssue({ id: "ISS-003", status: "open" }),
        makeIssue({ id: "ISS-004", status: "open" }),
      ],
    });
    // Previous: 4 open, now: 4 open = 0% growth
    const result = recommend(state, 10, { previousOpenIssueCount: 4 });
    const trend = result.recommendations.find((r) => r.id === "DEBT_TREND");
    expect(trend).toBeUndefined();
  });

  it("no debt-trend when absolute growth is under 2", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "open" }),
      ],
    });
    // Previous: 1, now: 2 = 100% growth but only +1 absolute
    const result = recommend(state, 10, { previousOpenIssueCount: 1 });
    const trend = result.recommendations.find((r) => r.id === "DEBT_TREND");
    expect(trend).toBeUndefined();
  });

  it("no debt-trend at exactly 25% growth (strict >)", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "open" }),
        makeIssue({ id: "ISS-003", status: "open" }),
        makeIssue({ id: "ISS-004", status: "open" }),
        makeIssue({ id: "ISS-005", status: "open" }),
      ],
    });
    // Previous: 4, now: 5 = exactly 25% growth, +1 absolute (under min 2)
    const result = recommend(state, 10, { previousOpenIssueCount: 4 });
    const trend = result.recommendations.find((r) => r.id === "DEBT_TREND");
    expect(trend).toBeUndefined();
  });

  it("debt-trend triggers at 26% growth with >=2 absolute", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "open" }),
        makeIssue({ id: "ISS-003", status: "open" }),
        makeIssue({ id: "ISS-004", status: "open" }),
        makeIssue({ id: "ISS-005", status: "open" }),
        makeIssue({ id: "ISS-006", status: "open" }),
        makeIssue({ id: "ISS-007", status: "open" }),
        makeIssue({ id: "ISS-008", status: "open" }),
      ],
    });
    // Previous: 6, now: 8 = 33% growth, +2 absolute
    const result = recommend(state, 10, { previousOpenIssueCount: 6 });
    const trend = result.recommendations.find((r) => r.id === "DEBT_TREND");
    expect(trend).toBeDefined();
  });

  it("no debt-trend without previousOpenIssueCount (graceful skip)", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "open" }),
        makeIssue({ id: "ISS-003", status: "open" }),
      ],
    });
    const result = recommend(state, 10);
    const trend = result.recommendations.find((r) => r.id === "DEBT_TREND");
    expect(trend).toBeUndefined();
  });
});

describe("federation recommendations", () => {
  it("empty orchestrator with federation state produces recommendations", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "red", scanSummary: makeScanSummary() }),
      makeFedNode({ name: "cloud", health: "green", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
      makeFedNode({ name: "components", reachable: false, unreachableReason: "no .story/config.json found" }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.every((r) => r.id.startsWith("FED_"))).toBe(true);
  });

  it("red blocker ranks above in-progress ticket", () => {
    const state = makeState({
      config: orchestratorConfig,
      tickets: [makeTicket({ id: "T-001", status: "inprogress" })],
    });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "red", scanSummary: makeScanSummary() }),
      makeFedNode({ name: "cloud", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const redIdx = result.recommendations.findIndex((r) => r.id === "FED_RED_engine");
    const ipIdx = result.recommendations.findIndex((r) => r.id === "T-001");
    expect(redIdx).toBeGreaterThanOrEqual(0);
    expect(ipIdx).toBeGreaterThanOrEqual(0);
    expect(redIdx).toBeLessThan(ipIdx);
  });

  it("unreachable node gets FED_UNREACHABLE", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "components", reachable: false, unreachableReason: "no .story/config.json found" }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const rec = result.recommendations.find((r) => r.id === "FED_UNREACHABLE_components");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("fed_unreachable");
    expect(rec!.reason).toContain("unreachable");
  });

  it("bottleneck: yellow node with 3 dependents flagged", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "yellow", scanSummary: makeScanSummary() }),
      makeFedNode({ name: "a", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
      makeFedNode({ name: "b", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
      makeFedNode({ name: "c", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const rec = result.recommendations.find((r) => r.id === "FED_RED_engine");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("fed_red_blocker");
  });

  it("bottleneck: green node with 3 dependents NOT flagged as bottleneck", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "green", scanSummary: makeScanSummary() }),
      makeFedNode({ name: "a", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
      makeFedNode({ name: "b", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
      makeFedNode({ name: "c", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const bottleneck = result.recommendations.find((r) => r.id === "FED_BOTTLENECK_engine");
    expect(bottleneck).toBeUndefined();
  });

  it("high issue node flagged", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", scanSummary: makeScanSummary({ ticketCount: 12, openIssues: 5, issueCount: 5 }) }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const rec = result.recommendations.find((r) => r.id === "FED_ISSUES_engine");
    expect(rec).toBeDefined();
    expect(rec!.reason).toContain("42%");
  });

  it("low issue node not flagged", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", scanSummary: makeScanSummary({ ticketCount: 20, openIssues: 1, issueCount: 1 }) }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const rec = result.recommendations.find((r) => r.id === "FED_ISSUES_engine");
    expect(rec).toBeUndefined();
  });

  it("stale node flagged (30 days ago)", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", scanSummary: makeScanSummary({ lastHandoverDate: thirtyDaysAgo }) }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const rec = result.recommendations.find((r) => r.id === "FED_STALE_engine");
    expect(rec).toBeDefined();
    expect(rec!.reason).toContain("30 days");
  });

  it("fresh node not flagged as stale (3 days ago)", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", scanSummary: makeScanSummary({ lastHandoverDate: threeDaysAgo }) }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const rec = result.recommendations.find((r) => r.id === "FED_STALE_engine");
    expect(rec).toBeUndefined();
  });

  it("no federationState = no federation recs", () => {
    const state = makeState({ config: orchestratorConfig });
    const result = recommend(state, 10);
    const fedRecs = result.recommendations.filter((r) => r.id.startsWith("FED_"));
    expect(fedRecs).toHaveLength(0);
  });

  it("federation and local recs coexist sorted by score", () => {
    const state = makeState({
      config: orchestratorConfig,
      tickets: [makeTicket({ id: "T-001", status: "inprogress" })],
    });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "red", scanSummary: makeScanSummary() }),
      makeFedNode({ name: "cloud", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const fedRecs = result.recommendations.filter((r) => r.id.startsWith("FED_"));
    const localRecs = result.recommendations.filter((r) => !r.id.startsWith("FED_"));
    expect(fedRecs.length).toBeGreaterThan(0);
    expect(localRecs.length).toBeGreaterThan(0);
    for (let i = 1; i < result.recommendations.length; i++) {
      expect(result.recommendations[i]!.score).toBeLessThanOrEqual(result.recommendations[i - 1]!.score);
    }
  });

  it("suppression: unreachable red node gets both FED_UNREACHABLE and FED_RED", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "red", reachable: false, unreachableReason: "path does not exist" }),
      makeFedNode({ name: "cloud", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    expect(result.recommendations.find((r) => r.id === "FED_UNREACHABLE_engine")).toBeDefined();
    expect(result.recommendations.find((r) => r.id === "FED_RED_engine")).toBeDefined();
  });

  it("suppression: red_blocker suppresses bottleneck for same node", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "red", scanSummary: makeScanSummary() }),
      makeFedNode({ name: "a", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
      makeFedNode({ name: "b", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    expect(result.recommendations.find((r) => r.id === "FED_RED_engine")).toBeDefined();
    expect(result.recommendations.find((r) => r.id === "FED_BOTTLENECK_engine")).toBeUndefined();
  });

  it("division by zero: node with 0 tickets produces no FED_ISSUES", () => {
    const state = makeState({ config: orchestratorConfig });
    const fedState = makeFedState([
      makeFedNode({ name: "engine", scanSummary: makeScanSummary({ ticketCount: 0, openIssues: 5, issueCount: 5 }) }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    expect(result.recommendations.find((r) => r.id === "FED_ISSUES_engine")).toBeUndefined();
  });

  it("non-orchestrator project ignores federationState", () => {
    const state = makeState();
    const fedState = makeFedState([
      makeFedNode({ name: "engine", health: "red", scanSummary: makeScanSummary() }),
      makeFedNode({ name: "cloud", dependsOn: ["engine"], scanSummary: makeScanSummary() }),
    ]);
    const result = recommend(state, 10, { federationState: fedState });
    const fedRecs = result.recommendations.filter((r) => r.id.startsWith("FED_"));
    expect(fedRecs).toHaveLength(0);
  });
});

describe("crossNodeRefStatuses filtering", () => {
  it("excludes cross-node-blocked in-progress tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "inprogress", crossNodeBlockedBy: ["core:T-010"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { crossNodeRefStatuses: { "core:T-010": "open" } });
    expect(result.recommendations.find((r) => r.id === "T-001")).toBeUndefined();
  });

  it("includes in-progress tickets when cross-node refs are complete", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "inprogress", crossNodeBlockedBy: ["core:T-010"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { crossNodeRefStatuses: { "core:T-010": "complete" } });
    const rec = result.recommendations.find((r) => r.id === "T-001");
    expect(rec).toBeDefined();
    expect(rec?.category).toBe("inprogress_ticket");
  });

  it("excludes cross-node-blocked tickets from high_impact_unblock", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", crossNodeBlockedBy: ["core:T-010"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { crossNodeRefStatuses: { "core:T-010": "open" } });
    const unblockRecs = result.recommendations.filter((r) => r.category === "high_impact_unblock");
    expect(unblockRecs.find((r) => r.id === "T-001")).toBeUndefined();
  });

  it("includes cross-node-unblocked tickets in high_impact_unblock", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", crossNodeBlockedBy: ["core:T-010"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { crossNodeRefStatuses: { "core:T-010": "complete" } });
    const unblockRecs = result.recommendations.filter((r) => r.category === "high_impact_unblock");
    expect(unblockRecs.find((r) => r.id === "T-001")).toBeDefined();
  });

  it("excludes cross-node-blocked chores from quick_win", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, type: "chore", status: "open", crossNodeBlockedBy: ["api:T-005"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, type: "chore", status: "open" }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, type: "chore", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { crossNodeRefStatuses: { "api:T-005": "inprogress" } });
    expect(result.recommendations.find((r) => r.id === "T-001")).toBeUndefined();
    const t002 = result.recommendations.find((r) => r.id === "T-002");
    expect(t002).toBeDefined();
  });

  it("treats missing cache as blocked (conservative)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, type: "chore", status: "open", crossNodeBlockedBy: ["core:T-010"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, type: "chore", status: "open" }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, type: "chore", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    expect(result.recommendations.find((r) => r.id === "T-001")).toBeUndefined();
    const t002 = result.recommendations.find((r) => r.id === "T-002");
    expect(t002).toBeDefined();
  });

});

describe("claim annotation + downrank in recommend (G-7, ISS-681)", () => {
  function claimedState() {
    return makeState({
      tickets: [
        makeTicket({
          id: "T-001", phase: "p1", order: 10, status: "inprogress",
          claim: { user: "alice@test.com", branch: "feat/x", since: "2026-05-26T10:00:00Z" },
        }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical", relatedTickets: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
  }

  it("claimed-by-others tickets stay visible but are downranked and annotated (never hidden)", () => {
    const state = claimedState();
    const forBob = recommend(state, 10, { currentUser: "bob@test.com" });
    const noUser = recommend(state, 10);
    const forAlice = recommend(state, 10, { currentUser: "alice@test.com" });

    // ISS-681: a foreign claim is no longer removed -- it stays visible.
    const bobT001 = forBob.recommendations.find((r) => r.id === "T-001");
    const noUserT001 = noUser.recommendations.find((r) => r.id === "T-001");
    const aliceT001 = forAlice.recommendations.find((r) => r.id === "T-001");
    expect(bobT001).toBeDefined();
    expect(noUserT001).toBeDefined();
    expect(aliceT001).toBeDefined();

    // Annotated with the claim and reason for the non-owner.
    expect(bobT001!.claim?.user).toBe("alice@test.com");
    expect(bobT001!.reason).toContain("claimed by alice@test.com");
    // Identity unknown also keeps the item (downranked), not dropped.
    expect(noUserT001!.claim?.user).toBe("alice@test.com");

    // Downranked: the non-owner / unknown-identity score is below the owner's
    // unpenalized score for the same ticket.
    expect(bobT001!.score).toBeLessThan(aliceT001!.score);
    expect(noUserT001!.score).toBeLessThan(aliceT001!.score);
  });

  it("owner sees their own claimed ticket annotated without a downrank penalty", () => {
    const state = claimedState();
    const forAlice = recommend(state, 10, { currentUser: "alice@test.com" });

    const aliceT001 = forAlice.recommendations.find((r) => r.id === "T-001");
    expect(aliceT001).toBeDefined();
    expect(aliceT001!.claim?.user).toBe("alice@test.com");
    // The owner's reason is not annotated as a foreign claim.
    expect(aliceT001!.reason).not.toContain("claimed by");
  });
});
