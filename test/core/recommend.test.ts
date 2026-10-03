import { describe, it, expect } from "vitest";
import { recommend, computeActionability, partitionByActionability } from "../../src/core/recommend.js";
import type { FederationState, FederationNodeEntry } from "../../src/federation/state.js";
import type { NodeScanSummary } from "../../src/federation/scanner.js";
import type { Config } from "../../src/models/config.js";
import type { ProjectState } from "../../src/core/project-state.js";
import type { TrajectoryDisposition } from "../../src/core/markdown-sections.js";
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

  // --- ISS-1154: handover-context promotion (formerly ISS-018's +50 boost) ---

  it("ticket named as continuation in >= 2 handovers gets promoted to handover_context/675", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const recentHandovers = [
      { filename: "2026-09-11-h2.md", content: "## Next\n- T-001: do this thing\n" },
      { filename: "2026-09-10-h1.md", content: "## Next\n- T-001: still open\n" },
    ];
    const withHandover = recommend(state, 10, { recentHandovers });
    const without = recommend(state, 10);
    const t1With = withHandover.recommendations.find((r) => r.id === "T-001");
    const t1Without = without.recommendations.find((r) => r.id === "T-001");
    expect(t1With).toBeDefined();
    expect(t1With!.score).toBeGreaterThan(t1Without!.score);
    expect(t1With!.category).toBe("handover_context");
    expect(t1With!.reason).toContain("handover context");
  });

  it("complete ticket named in a Done section gets no promotion (never recommended)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const recentHandovers = [
      { filename: "2026-09-11-h2.md", content: "## Done\n- T-001: shipped\n" },
      { filename: "2026-09-10-h1.md", content: "## Done\n- T-001: shipped\n" },
    ];
    const result = recommend(state, 10, { recentHandovers });
    const t1 = result.recommendations.find((r) => r.id === "T-001");
    expect(t1).toBeUndefined(); // complete tickets are never recommended
  });

  it("no recentHandovers option = no promotion (graceful degradation)", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const withEmpty = recommend(state, 10, { recentHandovers: [] });
    const withoutOption = recommend(state, 10);
    const scoreWithEmpty = withEmpty.recommendations.find((r) => r.id === "T-001")!.score;
    const scoreWithoutOption = withoutOption.recommendations.find((r) => r.id === "T-001")!.score;
    expect(scoreWithEmpty).toBe(scoreWithoutOption);
  });

  it("a single qualifying mention (not >= 2) does not promote", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const recentHandovers = [{ filename: "2026-09-11-h1.md", content: "## Next\n- T-001: still open\n" }];
    const result = recommend(state, 10, { recentHandovers });
    const t1 = result.recommendations.find((r) => r.id === "T-001");
    expect(t1!.category).not.toBe("handover_context");
  });

  it("unclassified handover prose (no matching heading) contributes no continuation signal", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "inprogress" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    // No classifying heading at all -- parseHandoverMarkdown's unclassified
    // fallback produces zero orderedIdOccurrences (ISS-1154 retires the old
    // full-document-scan fallback entirely).
    const recentHandovers = [
      { filename: "2026-09-11-h2.md", content: "Some notes about T-001 and T-002 progress.\n" },
      { filename: "2026-09-10-h1.md", content: "Some notes about T-001 and T-002 progress.\n" },
    ];
    const result = recommend(state, 10, { recentHandovers });
    const t1 = result.recommendations.find((r) => r.id === "T-001");
    expect(t1!.category).not.toBe("handover_context");
  });

  // --- T-475 section 5: Layer 2 (advisory) earmark exclusion ---

  const ASSIGNED_EARMARK = {
    stage: "assigned" as const,
    reservedBy: { client: "claude" as const, id: "pen-task-1" },
    arrangementId: "a-0123456789abcdef",
    since: "2026-08-28T00:00:00.000Z",
    holderRole: "worker" as const,
    holderSession: "11111111-1111-4111-8111-111111111111",
  };

  it("hides an OPEN earmarked critical issue from critical_issue", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", severity: "critical", status: "open", earmark: ASSIGNED_EARMARK })],
    });
    const result = recommend(state, 10);
    expect(result.recommendations.find((r) => r.id === "ISS-001")).toBeUndefined();
  });

  it("never hides an INPROGRESS earmarked critical issue -- R5's normal worked state", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", severity: "critical", status: "inprogress", earmark: ASSIGNED_EARMARK })],
    });
    const result = recommend(state, 10);
    expect(result.recommendations.find((r) => r.id === "ISS-001")).toBeDefined();
  });

  it("hides an OPEN earmarked medium/low issue from open_issue", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", severity: "medium", status: "open", earmark: ASSIGNED_EARMARK })],
    });
    const result = recommend(state, 10);
    expect(result.recommendations.find((r) => r.id === "ISS-001")).toBeUndefined();
  });

  it("hides an OPEN earmarked chore from quick_win", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open", type: "chore", earmark: ASSIGNED_EARMARK })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    expect(result.recommendations.find((r) => r.id === "T-001")).toBeUndefined();
  });

  it("hides an OPEN earmarked ticket from high_impact_unblock", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open", earmark: ASSIGNED_EARMARK }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", phase: "p1", status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    expect(result.recommendations.find((r) => r.category === "high_impact_unblock" && r.id === "T-001")).toBeUndefined();
  });

  it("never hides an INPROGRESS earmarked ticket from inprogress_ticket", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "inprogress", earmark: ASSIGNED_EARMARK })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10);
    const rec = result.recommendations.find((r) => r.id === "T-001");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("inprogress_ticket");
  });

  // ISS-1154: applyHandoverBoost now requires genuine continuation/carried
  // mentions in >= 2 handovers (not a single-document scan), and never
  // promotes an id whose current score already sits at or above 675.
  function twoContinuationHandovers(id: string): { filename: string; content: string }[] {
    return [
      { filename: "2026-09-11-h2.md", content: `## Next\n- ${id}: pick this back up\n` },
      { filename: "2026-09-10-h1.md", content: `## Next\n- ${id}: still open\n` },
    ];
  }

  it("applyHandoverBoost does not surface an OPEN earmarked ticket referenced in >= 2 handovers (fresh-add branch)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open", earmark: ASSIGNED_EARMARK }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }), // keeps the phase non-empty
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuationHandovers("T-001") });
    expect(result.recommendations.find((r) => r.id === "T-001")).toBeUndefined();
    expect(result.excluded.find((r) => r.id === "T-001")).toBeUndefined();
  });

  it("applyHandoverBoost does not re-surface an OPEN earmarked ticket already suppressed by another generator (fresh-add branch)", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open", type: "chore", earmark: ASSIGNED_EARMARK })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    // T-001 would otherwise be a quick_win candidate -- already suppressed by
    // notHiddenByEarmark before this ever reaches dedup, so it hits the
    // fresh-add branch here, which also silently skips an earmark-hidden item.
    const result = recommend(state, 10, { recentHandovers: twoContinuationHandovers("T-001") });
    expect(result.recommendations.find((r) => r.id === "T-001")).toBeUndefined();
    expect(result.excluded.find((r) => r.id === "T-001")).toBeUndefined();
  });

  it("applyHandoverBoost does not lower or bump an already-high-scoring rec even with qualifying mentions (mutate guard)", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "inprogress" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const withHandover = recommend(state, 10, { recentHandovers: twoContinuationHandovers("T-001") });
    const without = recommend(state, 10);
    const t1With = withHandover.recommendations.find((r) => r.id === "T-001");
    const t1Without = without.recommendations.find((r) => r.id === "T-001");
    expect(t1With).toBeDefined();
    // inprogress_ticket (800) already sits above the 675 band -- untouched.
    expect(t1With!.score).toBe(t1Without!.score);
    expect(t1With!.category).toBe("inprogress_ticket");
  });

  it("applyHandoverBoost promotes an existing lower-scoring actionable rec to handover_context/675", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", severity: "low", status: "open" })],
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuationHandovers("ISS-001") });
    const rec = result.recommendations.find((r) => r.id === "ISS-001");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("handover_context");
    expect(rec!.score).toBe(675);
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

// --- ISS-1154: computeActionability, the four-tier classifier ---

describe("computeActionability", () => {
  const noDispositions = new Map<string, TrajectoryDisposition>();

  function ctx(
    state: ProjectState,
    overrides: Partial<{
      crossNodeRefStatuses: Record<string, string>;
      latestDispositionById: ReadonlyMap<string, TrajectoryDisposition>;
    }> = {},
  ) {
    return {
      state,
      crossNodeRefStatuses: overrides.crossNodeRefStatuses,
      latestDispositionById: overrides.latestDispositionById ?? noDispositions,
    };
  }

  // --- Tier 1: ledger (universal precondition, both kinds) ---

  it("archived ticket -> complete/ledger", () => {
    const ticket = makeTicket({ id: "T-001", lifecycle: "archived" });
    const state = makeState({ tickets: [ticket] });
    const result = computeActionability("ticket", ticket, ctx(state));
    expect(result.status).toBe("complete");
    expect(result.source).toBe("ledger");
  });

  it("deleted issue -> complete/ledger", () => {
    const issue = makeIssue({ id: "ISS-001", lifecycle: "deleted" });
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("complete");
    expect(result.source).toBe("ledger");
  });

  it("earmark-hidden open ticket -> blocked/ledger", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "open",
      earmark: {
        stage: "assigned",
        holderRole: "worker",
        holderSession: "11111111-1111-4111-8111-111111111111",
        reservedBy: { client: "claude", id: "test-session" },
        arrangementId: "a-0123456789abcdef",
        since: "2026-08-28T00:00:00.000Z",
      },
    });
    const state = makeState({ tickets: [ticket] });
    const result = computeActionability("ticket", ticket, ctx(state));
    expect(result.status).toBe("blocked");
    expect(result.source).toBe("ledger");
  });

  it("complete ticket -> complete/ledger", () => {
    const ticket = makeTicket({ id: "T-001", status: "complete" });
    const state = makeState({ tickets: [ticket] });
    const result = computeActionability("ticket", ticket, ctx(state));
    expect(result.status).toBe("complete");
    expect(result.source).toBe("ledger");
  });

  it("resolved issue -> complete/ledger", () => {
    const issue = makeIssue({ id: "ISS-001", status: "resolved" });
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("complete");
    expect(result.source).toBe("ledger");
  });

  it("ticket blocked by an incomplete ticket -> blocked/ledger", () => {
    const blocker = makeTicket({ id: "T-001", status: "open" });
    const ticket = makeTicket({ id: "T-002", status: "open", blockedBy: ["T-001"] });
    const state = makeState({ tickets: [blocker, ticket] });
    const result = computeActionability("ticket", ticket, ctx(state));
    expect(result.status).toBe("blocked");
    expect(result.source).toBe("ledger");
  });

  it("cross-node blocked ticket -> blocked/ledger", () => {
    const ticket = makeTicket({
      id: "T-001",
      status: "open",
      crossNodeBlockedBy: ["engine:T-005"],
    });
    const state = makeState({ tickets: [ticket] });
    const result = computeActionability(
      "ticket",
      ticket,
      ctx(state, { crossNodeRefStatuses: { "engine:T-005": "open" } }),
    );
    expect(result.status).toBe("blocked");
    expect(result.source).toBe("ledger");
  });

  // --- Tier 2: structured (issues only) ---

  it("issue disposition escalate_only -> escalate_only/structured", () => {
    const issue = makeIssue({ id: "ISS-001", disposition: "escalate_only" } as never);
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("escalate_only");
    expect(result.source).toBe("structured");
  });

  it("issue disposition owner_gated -> owner_gated/structured", () => {
    const issue = makeIssue({ id: "ISS-001", disposition: "owner_gated" } as never);
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("owner_gated");
    expect(result.source).toBe("structured");
  });

  it("issue disposition duplicate -> duplicate/structured", () => {
    const issue = makeIssue({ id: "ISS-001", disposition: "duplicate" } as never);
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("duplicate");
    expect(result.source).toBe("structured");
  });

  it("structured tier wins outright over a conflicting handover disposition", () => {
    const issue = makeIssue({ id: "ISS-001", disposition: "duplicate" } as never);
    const state = makeState({ issues: [issue] });
    const dispositions = new Map<string, TrajectoryDisposition>([["ISS-001", "continuation"]]);
    const result = computeActionability("issue", issue, ctx(state, { latestDispositionById: dispositions }));
    expect(result.status).toBe("duplicate");
    expect(result.source).toBe("structured");
  });

  // --- Tier 3: handover ---

  it("newest handover disposition blocked -> blocked/handover", () => {
    const ticket = makeTicket({ id: "T-001", status: "open" });
    const state = makeState({ tickets: [ticket] });
    const dispositions = new Map<string, TrajectoryDisposition>([["T-001", "blocked"]]);
    const result = computeActionability("ticket", ticket, ctx(state, { latestDispositionById: dispositions }));
    expect(result.status).toBe("blocked");
    expect(result.source).toBe("handover");
  });

  it("newest handover disposition owner-gated -> owner_gated/handover", () => {
    const issue = makeIssue({ id: "ISS-001", status: "open" });
    const state = makeState({ issues: [issue] });
    const dispositions = new Map<string, TrajectoryDisposition>([["ISS-001", "owner-gated"]]);
    const result = computeActionability("issue", issue, ctx(state, { latestDispositionById: dispositions }));
    expect(result.status).toBe("owner_gated");
    expect(result.source).toBe("handover");
  });

  it("newest handover disposition continuation -> no exclusion from this tier (falls through to default)", () => {
    const ticket = makeTicket({ id: "T-001", status: "open" });
    const state = makeState({ tickets: [ticket] });
    const dispositions = new Map<string, TrajectoryDisposition>([["T-001", "continuation"]]);
    const result = computeActionability("ticket", ticket, ctx(state, { latestDispositionById: dispositions }));
    expect(result.status).toBe("actionable");
  });

  // --- Tier 4: heuristic (demote-only, reached only with no verdict yet) ---

  it("issue title matches /duplicate/i -> duplicate/heuristic", () => {
    const issue = makeIssue({ id: "ISS-001", title: "Duplicate of ISS-002" });
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("duplicate");
    expect(result.source).toBe("heuristic");
  });

  it("issue resolution matches /superseded/i -> duplicate/heuristic", () => {
    const issue = makeIssue({ id: "ISS-001", resolution: "Superseded by ISS-002" });
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("duplicate");
    expect(result.source).toBe("heuristic");
  });

  it("ISS-1149-shaped title ('duplicate member-artifact join keys are documented, not counted') stays actionable -- bare 'duplicate' is not a reference", () => {
    const issue = makeIssue({ id: "ISS-1149", severity: "low", title: "duplicate member-artifact join keys are documented, not counted" });
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("actionable");
  });

  it("ISS-1154-shaped title ('blocked and duplicate items') stays actionable -- bare 'duplicate' is not a reference", () => {
    const issue = makeIssue({ id: "ISS-1154", severity: "high", title: "recommend half: classify blocked and duplicate items" });
    const state = makeState({ issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("actionable");
  });

  it("issue's relatedTickets resolves directly to an in-progress umbrella ticket -> duplicate/heuristic", () => {
    // T-002 is the leaf that makes T-001 an umbrella; the issue relates
    // directly to the umbrella T-001 itself (state.umbrellaIDs.has(t.id) branch).
    const umbrella = makeTicket({ id: "T-001", status: "inprogress" });
    const child = makeTicket({ id: "T-002", status: "inprogress", parentTicket: "T-001" });
    const issue = makeIssue({ id: "ISS-001", relatedTickets: ["T-001"] });
    const state = makeState({ tickets: [umbrella, child], issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("duplicate");
    expect(result.source).toBe("heuristic");
  });

  it("resolvedParent umbrella in-progress via display-id parentTicket -> duplicate/heuristic", () => {
    // The issue relates to the LEAF T-002 (not itself an umbrella); T-002's
    // parentTicket is the umbrella's DISPLAY id, resolved to the umbrella's
    // canonical id via resolvedParent -- exercising the resolvedParent(t)
    // branch distinctly from the direct-umbrella-match branch above.
    const umbrella = makeTicket({ id: "t-umbrella1", displayId: "T-001", status: "inprogress" });
    const child = makeTicket({ id: "T-002", status: "inprogress", parentTicket: "T-001" });
    const issue = makeIssue({ id: "ISS-001", relatedTickets: ["T-002"] });
    const state = makeState({ tickets: [umbrella, child], issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("duplicate");
    expect(result.source).toBe("heuristic");
  });

  it("ISS-1225: a COMPLETE leaf under an in-progress umbrella is evidence the issue is not covered -> actionable", () => {
    // T-285/T-286 shape from the field: the related ticket is done, the
    // umbrella still has other children in flight. The parent clause must
    // not fire for a finished related ticket.
    const umbrella = makeTicket({ id: "T-001", status: "inprogress" });
    const done = makeTicket({ id: "T-002", status: "complete", parentTicket: "T-001" });
    const inflight = makeTicket({ id: "T-003", status: "inprogress", parentTicket: "T-001" });
    const issue = makeIssue({ id: "ISS-001", relatedTickets: ["T-002"] });
    const state = makeState({ tickets: [umbrella, done, inflight], issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("actionable");
    expect(result.source).toBe("ledger");
  });

  it("ISS-1225: an OPEN or in-progress leaf under an in-progress umbrella still yields duplicate, and a direct in-progress umbrella reference is unchanged", () => {
    for (const leafStatus of ["open", "inprogress"] as const) {
      // Umbrella status is derived from its children, so a sibling in flight
      // keeps the umbrella in progress while the related leaf is merely open.
      const umbrella = makeTicket({ id: "T-001", status: "inprogress" });
      const leaf = makeTicket({ id: "T-002", status: leafStatus, parentTicket: "T-001" });
      const sibling = makeTicket({ id: "T-009", status: "inprogress", parentTicket: "T-001" });
      const issue = makeIssue({ id: "ISS-001", relatedTickets: ["T-002"] });
      const state = makeState({ tickets: [umbrella, leaf, sibling], issues: [issue] });
      const result = computeActionability("issue", issue, ctx(state));
      expect(result.status, leafStatus).toBe("duplicate");
      expect(result.reason).toContain("parent umbrella T-001 is in progress");
    }
    // Direct reference to the in-progress umbrella itself: unchanged.
    const umbrella = makeTicket({ id: "T-001", status: "inprogress" });
    const leaf = makeTicket({ id: "T-002", status: "complete", parentTicket: "T-001" });
    const inflight = makeTicket({ id: "T-003", status: "inprogress", parentTicket: "T-001" });
    const issue = makeIssue({ id: "ISS-001", relatedTickets: ["T-001"] });
    const state = makeState({ tickets: [umbrella, leaf, inflight], issues: [issue] });
    const direct = computeActionability("issue", issue, ctx(state));
    expect(direct.status).toBe("duplicate");
    expect(direct.reason).toContain("is itself an in-progress umbrella");
  });

  it("stale completed umbrella does NOT match the heuristic tier", () => {
    const umbrella = makeTicket({ id: "T-001", status: "complete" });
    const child = makeTicket({ id: "T-002", status: "complete", parentTicket: "T-001" });
    const issue = makeIssue({ id: "ISS-001", relatedTickets: ["T-002"] });
    const state = makeState({ tickets: [umbrella, child], issues: [issue] });
    const result = computeActionability("issue", issue, ctx(state));
    expect(result.status).toBe("actionable");
  });

  it("default: no verdict from any tier -> actionable/ledger", () => {
    const ticket = makeTicket({ id: "T-001", status: "open" });
    const state = makeState({ tickets: [ticket] });
    const result = computeActionability("ticket", ticket, ctx(state));
    expect(result.status).toBe("actionable");
    expect(result.source).toBe("ledger");
    expect(result.reason).toBe("open, no blocking signal");
  });
});

// --- ISS-1154: recommend() integration -- promotion/partition/window-incomplete ---

describe("recommend: ISS-1154 promotion, partition, and window-incomplete", () => {
  function twoContinuations(id: string): { filename: string; content: string }[] {
    return [
      { filename: "2026-09-11-h2.md", content: `## Next\n- ${id}: pick this back up\n` },
      { filename: "2026-09-10-h1.md", content: `## Next\n- ${id}: still open\n` },
    ];
  }

  // --- Fresh-add branch ---

  it("fresh-add: a plain ticket picked up by no generator appears at handover_context/675", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 5, status: "open" }), // claimed by phase_momentum
        makeTicket({ id: "T-002", phase: "p1", order: 10, status: "open" }), // picked up by no generator
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-002") });
    const rec = result.recommendations.find((r) => r.id === "T-002");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("handover_context");
    expect(rec!.score).toBe(675);
  });

  it("fresh-add: an archived ticket is rejected entirely (absent from both recommendations and excluded)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 5, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 10, status: "open", lifecycle: "archived" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-002") });
    expect(result.recommendations.find((r) => r.id === "T-002")).toBeUndefined();
    expect(result.excluded.find((r) => r.id === "T-002")).toBeUndefined();
  });

  it("fresh-add: a completed ticket named in two continuations is rejected entirely, not counted into excluded", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 5, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 10, status: "complete" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-002") });
    expect(result.recommendations.find((r) => r.id === "T-002")).toBeUndefined();
    expect(result.excluded.find((r) => r.id === "T-002")).toBeUndefined();
    expect(result.excludedCount).toBe(0);
  });

  it("fresh-add: an earmark-hidden open ticket is rejected entirely (absent from both arrays)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 5, status: "open" }),
        makeTicket({
          id: "T-002",
          phase: "p1",
          order: 10,
          status: "open",
          earmark: {
            stage: "assigned",
            holderRole: "worker",
            holderSession: "11111111-1111-4111-8111-111111111111",
            reservedBy: { client: "claude", id: "test-session" },
            arrangementId: "a-0123456789abcdef",
            since: "2026-08-28T00:00:00.000Z",
          },
        }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-002") });
    expect(result.recommendations.find((r) => r.id === "T-002")).toBeUndefined();
    expect(result.excluded.find((r) => r.id === "T-002")).toBeUndefined();
  });

  it("fresh-add: a non-actionable (blocked) variant is rejected from insertion but present in excluded", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 5, status: "open" }),
        makeTicket({ id: "T-blocker", phase: "p1", order: 8, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 10, status: "open", blockedBy: ["T-blocker"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-002") });
    expect(result.recommendations.find((r) => r.id === "T-002")).toBeUndefined();
    const excludedEntry = result.excluded.find((r) => r.id === "T-002");
    expect(excludedEntry).toBeDefined();
    expect(excludedEntry!.actionability.status).toBe("blocked");
  });

  // --- Existing-dedup mutation guard ---

  it("existing-dedup guard: an id already selected by another generator, excluded via tier 3, is NOT promoted", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", severity: "low", status: "open" })], // open_issue candidate
    });
    // Two older continuations, then a newest blocked mention -- latestDisposition
    // is "blocked" (tier 3 excludes), so continuationMentionCount(id)=1 (only
    // the older handover's first-occurrence reduces to continuation; the
    // newest handover's first-occurrence is "blocked", not continuation) --
    // but even a hypothetical count >= 2 must never promote an excluded item.
    const recentHandovers = [
      { filename: "2026-09-12-h3.md", content: "## Blocked\n- ISS-001: waiting on external\n" },
      { filename: "2026-09-11-h2.md", content: "## Next\n- ISS-001: pick this back up\n" },
      { filename: "2026-09-10-h1.md", content: "## Next\n- ISS-001: still open\n" },
    ];
    const result = recommend(state, 10, { recentHandovers });
    const rec = result.recommendations.find((r) => r.id === "ISS-001");
    expect(rec).toBeUndefined(); // excluded, not promoted, not recommended
    const excludedEntry = result.excluded.find((r) => r.id === "ISS-001");
    expect(excludedEntry).toBeDefined();
    expect(excludedEntry!.actionability.status).toBe("blocked");
    expect(excludedEntry!.actionability.source).toBe("handover");
  });

  // --- Future-phase-immunity ---

  it("future-phase-immunity: a promoted existing rec lands at exactly 675 regardless of the phase penalty it incurred first", () => {
    const state = makeState({
      tickets: [
        // Anchors p1 as current (currentPhase skips phases with no tickets),
        // so T-001 in p4 genuinely incurs a phase-distance penalty first.
        makeTicket({ id: "T-anchor", phase: "p1", status: "inprogress" }),
        makeTicket({ id: "T-001", phase: "p4", status: "open", type: "chore" }), // quick_win, 3 phases ahead
      ],
      roadmap: makeRoadmap([
        makePhase({ id: "p1" }),
        makePhase({ id: "p2" }),
        makePhase({ id: "p3" }),
        makePhase({ id: "p4" }),
      ]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-001") });
    const rec = result.recommendations.find((r) => r.id === "T-001");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("handover_context");
    expect(rec!.score).toBe(675); // not 400 - 300 = 100
  });

  it("decayed-score boundary (phase-distance instantiation): an unblock 3+ phases ahead scores under 675, ranking below the promoted item", () => {
    // Section 1's post-approval amendment: the base-score-only scope means an
    // unblock ranked >= index 26 (700-26=674), OR one 3+ phases ahead
    // (700-300=400), scores under 675. This test uses the phase-distance
    // realization. The index-26 realization is deliberately NOT tested
    // end-to-end: it needs 27 real high_impact_unblock candidates scored
    // 700..674, and recommend()'s `recommendations` is hard-capped at 10
    // (effectiveCount = Math.max(1, Math.min(10, count))) regardless of the
    // `count` argument -- so both the index-26 item and the 675 promoted
    // item would rank ~26th/27th overall and neither would ever surface in
    // `recommendations`, and since both are actionable, neither would
    // surface in `excluded` either. There is no way to observe that specific
    // ordering through the public RecommendResult API; this is a plan
    // realizability note (pen-accepted), not a coverage gap.
    const state = makeState({
      tickets: [
        // currentPhase() skips phases with zero leaf tickets, so p1 needs a
        // ticket of its own (not otherwise a candidate) to anchor it as
        // "current" -- otherwise p4 (the only phase with tickets) would be
        // current and T-001 would incur no phase-distance penalty at all.
        makeTicket({ id: "T-anchor", phase: "p1", status: "inprogress" }),
        makeTicket({ id: "T-001", phase: "p4", status: "open" }),
        makeTicket({ id: "T-001a", phase: "p4", status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-001b", phase: "p4", status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-999", phase: null, status: "open" }), // fresh-add handover ticket
      ],
      roadmap: makeRoadmap([
        makePhase({ id: "p1" }),
        makePhase({ id: "p2" }),
        makePhase({ id: "p3" }),
        makePhase({ id: "p4" }),
      ]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-999") });
    const unblock = result.recommendations.find((r) => r.id === "T-001");
    const handoverTicket = result.recommendations.find((r) => r.id === "T-999");
    expect(unblock).toBeDefined();
    expect(unblock!.score).toBe(400); // 700 - min(3 * 100, 400)
    expect(handoverTicket).toBeDefined();
    expect(handoverTicket!.score).toBe(675);
    expect(result.recommendations.indexOf(handoverTicket!)).toBeLessThan(result.recommendations.indexOf(unblock!));
  });

  // --- ISS-1154 scenario fixture ---

  it("ISS-1154 scenario: promoted handover ticket ranks directly after the surviving critical, ahead of open_issue/quick_win", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-777", phase: null, status: "open" }), // fresh-add via handover
        makeTicket({ id: "T-200", phase: "p1", status: "open", type: "chore" }), // quick_win
      ],
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical", status: "open" }), // excluded via handover tier
        makeIssue({ id: "ISS-002", severity: "critical", status: "open", disposition: "duplicate" } as never),
        makeIssue({ id: "ISS-003", severity: "critical", status: "open", disposition: "duplicate" } as never),
        makeIssue({ id: "ISS-004", severity: "critical", status: "open", disposition: "duplicate" } as never),
        makeIssue({ id: "ISS-005", severity: "critical", status: "open" }), // surviving actionable critical
        makeIssue({ id: "ISS-900", severity: "low", status: "open" }), // open_issue
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const recentHandovers = [
      { filename: "2026-09-11-h2.md", content: "## Next\n- T-777: pick this back up\n\n## Blocked\n- ISS-001: waiting on external\n" },
      { filename: "2026-09-10-h1.md", content: "## Next\n- T-777: still open\n" },
    ];
    const result = recommend(state, 10, { recentHandovers });

    const recIds = result.recommendations.map((r) => r.id);
    expect(recIds).not.toContain("ISS-001");
    expect(recIds).not.toContain("ISS-002");
    expect(recIds).not.toContain("ISS-003");
    expect(recIds).not.toContain("ISS-004");

    for (const excludedIssueId of ["ISS-001", "ISS-002", "ISS-003", "ISS-004"]) {
      const entry = result.excluded.find((r) => r.id === excludedIssueId);
      expect(entry, `${excludedIssueId} should be reachable via excluded`).toBeDefined();
      expect(entry!.actionability.reason.length).toBeGreaterThan(0);
    }

    const survivingCriticalIdx = recIds.indexOf("ISS-005");
    const handoverIdx = recIds.indexOf("T-777");
    const quickWinIdx = recIds.indexOf("T-200");
    const openIssueIdx = recIds.indexOf("ISS-900");
    expect(survivingCriticalIdx).toBe(0);
    expect(handoverIdx).toBe(1);
    expect(handoverIdx).toBeLessThan(quickWinIdx);
    expect(handoverIdx).toBeLessThan(openIssueIdx);
  });

  it("ISS-1154 scenario variant: surviving critical also excluded -> handover ticket ranks first", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-777", phase: null, status: "open" })],
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical", status: "open" }), // excluded via handover tier
        makeIssue({ id: "ISS-005", severity: "critical", status: "open", disposition: "duplicate" } as never), // also excluded
      ],
    });
    const recentHandovers = [
      { filename: "2026-09-11-h2.md", content: "## Next\n- T-777: pick this back up\n\n## Blocked\n- ISS-001: waiting on external\n" },
      { filename: "2026-09-10-h1.md", content: "## Next\n- T-777: still open\n" },
    ];
    const result = recommend(state, 10, { recentHandovers });
    expect(result.recommendations[0]?.id).toBe("T-777");
  });

  // --- Sparse backlog / all-excluded ---

  it("partition-before-slice: count=1 gives the slot to the lower-scoring actionable ticket, not the higher-scoring excluded issue", () => {
    // ISS-005 (critical_issue, score 900) outranks T-777 (handover_context,
    // score 675) on raw score alone. If recommendations were sliced to
    // effectiveCount BEFORE excluded candidates were removed, the single
    // slot would go to ISS-005 and it would never reach `excluded` either
    // (dropped by the slice, not by partition). Partition-before-slice
    // requires T-777 to fill the slot and ISS-005 to surface in `excluded`.
    const state = makeState({
      tickets: [makeTicket({ id: "T-777", phase: null, status: "open" })],
      issues: [
        makeIssue({ id: "ISS-005", severity: "critical", status: "open", disposition: "duplicate" } as never),
      ],
    });
    const result = recommend(state, 1, { recentHandovers: twoContinuations("T-777") });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.id).toBe("T-777");
    const entry = result.excluded.find((r) => r.id === "ISS-005");
    expect(entry).toBeDefined();
    expect(entry!.actionability.status).toBe("duplicate");
  });

  it("partitionByActionability: a hand-built rec with undefined actionability is treated as actionable, never hidden into excludedPool", () => {
    // Unreachable via recommend() with today's generators (every ticket/issue
    // rec is annotated with a real actionability before this runs), but not
    // provably impossible for a future one -- this pins the fail-safe
    // directly against the partition, independent of how a rec got here.
    const undefinedActionabilityRec = {
      id: "T-999",
      kind: "ticket" as const,
      title: "Hand-built rec, no actionability computed",
      category: "quick_win" as const,
      reason: "test fixture",
      score: 500,
    };
    const { actionablePool, excludedPool } = partitionByActionability([undefinedActionabilityRec]);
    expect(actionablePool).toHaveLength(1);
    expect(actionablePool[0]?.id).toBe("T-999");
    expect(excludedPool).toHaveLength(0);
  });

  it("all-excluded backlog: recommendations is empty, excluded carries every candidate with its reason", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", severity: "critical", status: "open", disposition: "duplicate" } as never),
        makeIssue({ id: "ISS-002", severity: "critical", status: "open", disposition: "escalate_only" } as never),
      ],
    });
    const result = recommend(state, 10);
    expect(result.recommendations).toHaveLength(0);
    expect(result.excludedCount).toBe(2);
    expect(result.excluded.map((r) => r.id).sort()).toEqual(["ISS-001", "ISS-002"]);
    for (const entry of result.excluded) {
      expect(entry.actionability.reason.length).toBeGreaterThan(0);
    }
  });

  // --- Window-incomplete ---

  it("window-incomplete: an unreadable non-newest file does not disable tier-3 exclusion over the readable subset", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", severity: "low", status: "open" })],
    });
    // Newest readable handover marks ISS-001 blocked; an older readable
    // handover marks it continuation; the unreadable file (not represented
    // in recentHandovers at all, since only successfully-read files are
    // included) sits conceptually between them. Tier 3 still evaluates the
    // readable subset and produces the newest (blocked) verdict -- it is not
    // disabled outright just because the window is marked incomplete.
    const recentHandovers = [
      { filename: "2026-09-12-h3.md", content: "## Blocked\n- ISS-001: waiting on external\n" },
      { filename: "2026-09-10-h1.md", content: "## Next\n- ISS-001: still open\n" },
    ];
    const result = recommend(state, 10, { recentHandovers, unreadableHandoverCount: 1 });
    expect(result.recommendations.find((r) => r.id === "ISS-001")).toBeUndefined();
    const entry = result.excluded.find((r) => r.id === "ISS-001");
    expect(entry).toBeDefined();
    expect(entry!.actionability.status).toBe("blocked");
    expect(entry!.actionability.source).toBe("handover");
  });

  it("window-incomplete (positive count): disables promotion entirely for an otherwise-eligible candidate", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, {
      recentHandovers: twoContinuations("T-001"),
      unreadableHandoverCount: 2,
    });
    const rec = result.recommendations.find((r) => r.id === "T-001");
    expect(rec).toBeDefined();
    expect(rec!.category).not.toBe("handover_context");
  });

  it("window-incomplete (null: directory listing failed): disables promotion entirely", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, {
      recentHandovers: twoContinuations("T-001"),
      unreadableHandoverCount: null,
    });
    const rec = result.recommendations.find((r) => r.id === "T-001");
    expect(rec).toBeDefined();
    expect(rec!.category).not.toBe("handover_context");
    expect(result.unreadableHandoverCount).toBeNull();
  });

  it("window-complete (undefined, option omitted): behaves as complete -- promotion proceeds", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = recommend(state, 10, { recentHandovers: twoContinuations("T-001") });
    const rec = result.recommendations.find((r) => r.id === "T-001");
    expect(rec!.category).toBe("handover_context");
    expect(result.unreadableHandoverCount).toBe(0);
  });

  it("unreadableHandoverCount reflects the actual value: positive, null, and 0/omitted", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })], roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    expect(recommend(state, 10, { unreadableHandoverCount: 3 }).unreadableHandoverCount).toBe(3);
    expect(recommend(state, 10, { unreadableHandoverCount: null }).unreadableHandoverCount).toBeNull();
    expect(recommend(state, 10, { unreadableHandoverCount: 0 }).unreadableHandoverCount).toBe(0);
    expect(recommend(state, 10).unreadableHandoverCount).toBe(0);
  });
});

// ISS-1112: open unphased leaves get an explicit floor band with the spec's reason text.
describe("ISS-1112: unphased band", () => {
  it("R1: an open unphased task is recommended in the unphased band with the exact reason", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: null, status: "open", type: "task" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const rec = recommend(state, 10).recommendations.find((r) => r.id === "T-002");
    expect(rec?.category).toBe("unphased_ticket");
    expect(rec?.reason).toBe("unphased, assign a phase to schedule it");
    expect(rec!.score).toBeGreaterThan(100);
    expect(rec!.score).toBeLessThanOrEqual(200);
  });

  it("R2: an unphased chore keeps its higher quick_win band (the unphased band is a floor)", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-002", phase: null, status: "open", type: "chore" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const rec = recommend(state, 10).recommendations.find((r) => r.id === "T-002");
    expect(rec?.category).toBe("quick_win");
  });

  it("R3: a blocked unphased leaf gets no recommendation", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-002", phase: null, status: "open", type: "task", blockedBy: ["T-003"] }),
        makeTicket({ id: "T-003", phase: null, status: "open", type: "task" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const recs = recommend(state, 10).recommendations;
    expect(recs.find((r) => r.id === "T-002")).toBeUndefined();
    expect(recs.find((r) => r.id === "T-003")?.category).not.toBeUndefined();
  });
});
