import { describe, it, expect } from "vitest";
import { buildDispatchPlan, buildFederationDispatchPlan, supportsAgentView } from "../../src/core/dispatch-plan.js";
import type { Recommendation } from "../../src/core/recommend.js";

function makeRec(overrides: Partial<Recommendation> & { id: string }): Recommendation {
  return {
    kind: "ticket",
    title: "Test ticket",
    category: "phase_momentum",
    reason: "Next in phase",
    score: 50,
    ...overrides,
  };
}

const RECS: readonly Recommendation[] = [
  makeRec({ id: "ISS-601", kind: "issue", title: "Mac app shows 0 tickets", score: 90, reason: "High severity" }),
  makeRec({ id: "ISS-602", kind: "issue", title: "Silently drops decode failures", score: 85, reason: "High severity" }),
  makeRec({ id: "T-160", kind: "ticket", title: "Beta channel", score: 60 }),
  makeRec({ id: "T-161", kind: "ticket", title: "Keyboard shortcuts", score: 40 }),
  makeRec({ id: "DEBT_TREND", kind: "action", title: "Review debt trend", score: 30, category: "debt_trend" }),
];

describe("supportsAgentView", () => {
  it("returns true for version at minimum", () => {
    expect(supportsAgentView("2.1.139")).toBe(true);
  });

  it("returns true for version above minimum", () => {
    expect(supportsAgentView("2.1.142")).toBe(true);
    expect(supportsAgentView("2.2.0")).toBe(true);
    expect(supportsAgentView("3.0.0")).toBe(true);
  });

  it("returns false for version below minimum", () => {
    expect(supportsAgentView("2.1.138")).toBe(false);
    expect(supportsAgentView("2.0.200")).toBe(false);
    expect(supportsAgentView("1.9.999")).toBe(false);
  });

  it("returns false for non-version strings", () => {
    expect(supportsAgentView("not-a-version")).toBe(false);
    expect(supportsAgentView("")).toBe(false);
  });

  it("extracts version from surrounding text", () => {
    expect(supportsAgentView("Claude Code v2.1.140")).toBe(true);
  });
});

describe("buildDispatchPlan", () => {
  describe("ids: 'all'", () => {
    it("includes all non-action recommendations up to maxAgents", () => {
      const plan = buildDispatchPlan(RECS, "all", "/project", "2.1.140", 3);
      expect(plan.entries).toHaveLength(3);
      expect(plan.entries[0].target.id).toBe("ISS-601");
      expect(plan.entries[1].target.id).toBe("ISS-602");
      expect(plan.entries[2].target.id).toBe("T-160");
    });

    it("skips action recommendations", () => {
      const plan = buildDispatchPlan(RECS, "all", "/project", "2.1.140", 10);
      expect(plan.entries).toHaveLength(4);
      expect(plan.skipped).toContainEqual({ id: "DEBT_TREND", reason: "action (not dispatchable)" });
    });

    it("caps at maxAgents", () => {
      const plan = buildDispatchPlan(RECS, "all", "/project", "2.1.140", 2);
      expect(plan.entries).toHaveLength(2);
    });
  });

  describe("ids: specific list", () => {
    it("finds matching recommendations", () => {
      const plan = buildDispatchPlan(RECS, ["ISS-601", "T-160"], "/project", "2.1.140", 5);
      expect(plan.entries).toHaveLength(2);
      expect(plan.entries[0].target.title).toBe("Mac app shows 0 tickets");
      expect(plan.entries[1].target.title).toBe("Beta channel");
    });

    it("accepts unknown IDs with valid format", () => {
      const plan = buildDispatchPlan(RECS, ["T-999"], "/project", "2.1.140", 5);
      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0].target.id).toBe("T-999");
      expect(plan.entries[0].target.kind).toBe("ticket");
      expect(plan.entries[0].target.reason).toBe("explicitly requested");
    });

    it("skips invalid ID formats", () => {
      const plan = buildDispatchPlan(RECS, ["not-valid", "T-001"], "/project", "2.1.140", 5);
      expect(plan.entries).toHaveLength(1);
      expect(plan.skipped).toContainEqual({ id: "not-valid", reason: "invalid ID format" });
    });

    it("skips action IDs", () => {
      const plan = buildDispatchPlan(RECS, ["DEBT_TREND"], "/project", "2.1.140", 5);
      expect(plan.entries).toHaveLength(0);
      expect(plan.skipped).toContainEqual({ id: "DEBT_TREND", reason: "action (not dispatchable)" });
    });

    it("normalizes ID case for unknown IDs", () => {
      const plan = buildDispatchPlan(RECS, ["t-999", "iss-100"], "/project", "2.1.140", 5);
      expect(plan.entries[0].target.id).toBe("T-999");
      expect(plan.entries[1].target.id).toBe("ISS-100");
    });

    it("normalizes ID case and preserves recommendation metadata", () => {
      const plan = buildDispatchPlan(RECS, ["t-160"], "/project", "2.1.140", 5);
      expect(plan.entries).toHaveLength(1);
      expect(plan.entries[0].target.id).toBe("T-160");
      expect(plan.entries[0].target.title).toBe("Beta channel");
      expect(plan.entries[0].target.reason).toBe("Next in phase");
    });

    it("preserves lowercase suffix on letter-suffixed ticket IDs", () => {
      const plan = buildDispatchPlan(RECS, ["t-123a"], "/project", "2.1.140", 5);
      expect(plan.entries[0].target.id).toBe("T-123a");
    });

    it("deduplicates IDs", () => {
      const plan = buildDispatchPlan(RECS, ["T-160", "T-160", "t-160"], "/project", "2.1.140", 5);
      expect(plan.entries).toHaveLength(1);
    });

    it("caps at maxAgents", () => {
      const plan = buildDispatchPlan(RECS, ["T-001", "T-002", "T-003"], "/project", "2.1.140", 2);
      expect(plan.entries).toHaveLength(2);
    });
  });

  describe("claude version detection", () => {
    it("marks ok when version supports Agent View", () => {
      const plan = buildDispatchPlan(RECS, "all", "/project", "2.1.140", 3);
      expect(plan.claudeVersionOk).toBe(true);
    });

    it("marks not ok when version is too old", () => {
      const plan = buildDispatchPlan(RECS, "all", "/project", "2.0.100", 3);
      expect(plan.claudeVersionOk).toBe(false);
    });

    it("marks not ok when version is null", () => {
      const plan = buildDispatchPlan(RECS, "all", "/project", null, 3);
      expect(plan.claudeVersionOk).toBe(false);
      expect(plan.claudeVersion).toBeNull();
    });
  });

  describe("plan structure", () => {
    it("sets mode to parallel", () => {
      const plan = buildDispatchPlan(RECS, "all", "/project", "2.1.140", 3);
      expect(plan.mode).toBe("parallel");
    });

    it("sets cwd to root for all entries", () => {
      const plan = buildDispatchPlan(RECS, "all", "/my/project", "2.1.140", 5);
      for (const entry of plan.entries) {
        expect(entry.cwd).toBe("/my/project");
      }
    });

    it("sets prompt to target ID", () => {
      const plan = buildDispatchPlan(RECS, ["ISS-601"], "/project", "2.1.140", 5);
      expect(plan.entries[0].prompt).toBe("ISS-601");
    });
  });

  describe("empty inputs", () => {
    it("returns empty plan for empty recommendations", () => {
      const plan = buildDispatchPlan([], "all", "/project", "2.1.140", 3);
      expect(plan.entries).toHaveLength(0);
    });

    it("returns empty plan for empty ids", () => {
      const plan = buildDispatchPlan(RECS, [], "/project", "2.1.140", 3);
      expect(plan.entries).toHaveLength(0);
    });
  });
});

describe("buildFederationDispatchPlan (T-336)", () => {
  const engineRecs: Recommendation[] = [
    makeRec({ id: "T-061", title: "replaceAudio", score: 90 }),
    makeRec({ id: "T-073", title: "changePace", score: 60 }),
  ];

  const cloudRecs: Recommendation[] = [
    makeRec({ id: "T-052", kind: "issue", title: "webhook retry", score: 80 }),
  ];

  it("builds plan with entries from multiple nodes", () => {
    const nodeRecs = new Map([
      ["engine", { root: "/dev/engine", recommendations: engineRecs }],
      ["cloud", { root: "/dev/cloud", recommendations: cloudRecs }],
    ]);
    const plan = buildFederationDispatchPlan(nodeRecs, "2.1.140", 5);
    expect(plan.entries.length).toBe(3);
    const cwds = plan.entries.map((e) => e.cwd);
    expect(cwds).toContain("/dev/engine");
    expect(cwds).toContain("/dev/cloud");
  });

  it("sorts by score across all nodes (highest first)", () => {
    const nodeRecs = new Map([
      ["engine", { root: "/dev/engine", recommendations: engineRecs }],
      ["cloud", { root: "/dev/cloud", recommendations: cloudRecs }],
    ]);
    const plan = buildFederationDispatchPlan(nodeRecs, "2.1.140", 5);
    const scores = plan.entries.map((e) => {
      const allRecs = [...engineRecs, ...cloudRecs];
      return allRecs.find((r) => r.id === e.target.id)?.score ?? 0;
    });
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it("caps at maxAgents globally", () => {
    const nodeRecs = new Map([
      ["engine", { root: "/dev/engine", recommendations: engineRecs }],
      ["cloud", { root: "/dev/cloud", recommendations: cloudRecs }],
    ]);
    const plan = buildFederationDispatchPlan(nodeRecs, "2.1.140", 2);
    expect(plan.entries).toHaveLength(2);
    expect(plan.skipped.length).toBeGreaterThanOrEqual(1);
  });

  it("sets claudeVersionOk false when version is too old", () => {
    const nodeRecs = new Map([
      ["engine", { root: "/dev/engine", recommendations: engineRecs }],
    ]);
    const plan = buildFederationDispatchPlan(nodeRecs, "2.0.0", 5);
    expect(plan.claudeVersionOk).toBe(false);
  });

  it("filters out action recommendations", () => {
    const recsWithAction: Recommendation[] = [
      makeRec({ id: "T-061", title: "replaceAudio", score: 90 }),
      makeRec({ id: "DEBT_TREND", kind: "action", title: "Review debt", score: 30, category: "debt_trend" }),
    ];
    const nodeRecs = new Map([
      ["engine", { root: "/dev/engine", recommendations: recsWithAction }],
    ]);
    const plan = buildFederationDispatchPlan(nodeRecs, "2.1.140", 5);
    expect(plan.entries.every((e) => e.target.kind !== "action")).toBe(true);
  });

  it("handles empty node recommendations", () => {
    const nodeRecs = new Map([
      ["engine", { root: "/dev/engine", recommendations: [] }],
    ]);
    const plan = buildFederationDispatchPlan(nodeRecs, "2.1.140", 5);
    expect(plan.entries).toHaveLength(0);
  });

  it("does not deduplicate same ID across different nodes", () => {
    const nodeRecs = new Map([
      ["engine", { root: "/dev/engine", recommendations: [makeRec({ id: "T-001", title: "engine setup", score: 90 })] }],
      ["cloud", { root: "/dev/cloud", recommendations: [makeRec({ id: "T-001", title: "cloud setup", score: 80 })] }],
    ]);
    const plan = buildFederationDispatchPlan(nodeRecs, "2.1.140", 5);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries[0].target.title).toBe("engine setup");
    expect(plan.entries[1].target.title).toBe("cloud setup");
    expect(plan.skipped).toHaveLength(0);
  });

  it("returns empty plan for empty node map", () => {
    const plan = buildFederationDispatchPlan(new Map(), "2.1.140", 5);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });
});

describe("T-475 section 5: dispatch's dry-run display (ids: 'all') never surfaces an earmarked candidate", () => {
  it("an open ticket earmarked to someone never reaches the dispatch plan, end to end through recommend()", async () => {
    const { recommend } = await import("../../src/core/recommend.js");
    const { makeTicket, makeState, makeRoadmap, makePhase } = await import("./test-factories.js");
    const state = makeState({
      tickets: [
        makeTicket({
          id: "T-001", phase: "p1", status: "open", type: "chore",
          earmark: {
            stage: "assigned",
            reservedBy: { client: "claude", id: "pen-task-1" },
            arrangementId: "a-0123456789abcdef",
            since: "2026-08-28T00:00:00.000Z",
            holderRole: "worker",
            holderSession: "11111111-1111-4111-8111-111111111111",
          },
        }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", type: "chore" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });

    const { recommendations } = recommend(state, 10);
    const plan = buildDispatchPlan(recommendations, "all", "/project", "2.1.140", 10);

    expect(plan.entries.some((e) => e.target.id === "T-001")).toBe(false);
    expect(plan.entries.some((e) => e.target.id === "T-002")).toBe(true);
  });
});
