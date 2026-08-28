import { describe, it, expect } from "vitest";
import {
  nextTicket,
  nextTickets,
  blockedTickets,
  ticketsUnblockedBy,
  umbrellaProgress,
  currentPhase,
  phasesWithStatus,
  isBlockerCleared,
  isCrossNodeBlocked,
} from "../../src/core/queries.js";
import { makeTicket, makeIssue, makeState, makeRoadmap, makePhase } from "./test-factories.js";

describe("nextTicket", () => {
  it("returns first unblocked leaf in first non-complete phase", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "complete" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.ticket.id).toBe("T-002");
    }
  });

  it("skips complete phases", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p2", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const result = nextTicket(state);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.ticket.id).toBe("T-002");
    }
  });

  it("skips empty/umbrella-only phases", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }), // umbrella
        makeTicket({ id: "T-002", phase: "p2", parentTicket: "T-001", status: "open" }),
        makeTicket({ id: "T-003", phase: "p2", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    // p1 has T-001 which is an umbrella → phaseTickets returns empty → skip
    const result = nextTicket(state);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.ticket.phase).toBe("p2");
    }
  });

  it("returns all_blocked when all incomplete leaves are blocked", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", blockedBy: ["T-999"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    expect(result.kind).toBe("all_blocked");
    if (result.kind === "all_blocked") {
      expect(result.phaseId).toBe("p1");
      expect(result.blockedCount).toBe(2);
    }
  });

  it("returns all_complete when all phases are complete", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(nextTicket(state).kind).toBe("all_complete");
  });

  it("returns empty_project for empty state", () => {
    const state = makeState({ roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    expect(nextTicket(state).kind).toBe("empty_project");
  });

  it("returns empty_project for no roadmap phases", () => {
    const state = makeState();
    expect(nextTicket(state).kind).toBe("empty_project");
  });

  it("excludes unphased tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: null, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    // p1 has no tickets → vacuously complete. Unphased T-001 excluded.
    expect(nextTicket(state).kind).toBe("all_complete");
  });

  it("respects ticket order within phase", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open" }),
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    if (result.kind === "found") {
      expect(result.ticket.id).toBe("T-001");
    }
  });

  it("includes unblockImpact", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    if (result.kind === "found") {
      expect(result.unblockImpact.wouldUnblock).toHaveLength(1);
      expect(result.unblockImpact.wouldUnblock[0]!.id).toBe("T-002");
    }
  });

  it("includes umbrellaProgress when ticket has parentTicket", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }),
        makeTicket({ id: "T-002", phase: "p1", order: 10, status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", phase: "p1", order: 20, status: "open", parentTicket: "T-001" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    if (result.kind === "found") {
      expect(result.ticket.id).toBe("T-003");
      expect(result.umbrellaProgress).not.toBeNull();
      expect(result.umbrellaProgress!.total).toBe(2);
      expect(result.umbrellaProgress!.complete).toBe(1);
    }
  });

  it("umbrellaProgress is null when ticket has no parent", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    if (result.kind === "found") {
      expect(result.umbrellaProgress).toBeNull();
    }
  });

  it("skips blocked tickets, returns first unblocked", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    if (result.kind === "found") {
      expect(result.ticket.id).toBe("T-002");
    }
  });

  const ASSIGNED_EARMARK = {
    stage: "assigned" as const,
    reservedBy: { client: "claude" as const, id: "pen-task-1" },
    arrangementId: "a-0123456789abcdef",
    since: "2026-08-28T00:00:00.000Z",
    holderRole: "worker" as const,
    holderSession: "11111111-1111-4111-8111-111111111111",
  };

  it("T-475 section 5: skips an OPEN earmarked ticket, returns the next unearmarked one", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", earmark: ASSIGNED_EARMARK }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.ticket.id).toBe("T-002");
    }
  });

  it("T-475 section 5: never skips an INPROGRESS earmarked ticket -- R5's normal worked state", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", order: 10, status: "inprogress", earmark: ASSIGNED_EARMARK })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.ticket.id).toBe("T-001");
    }
  });
});

describe("nextTickets", () => {
  it("count=1 with no blocked phases returns same ticket as nextTicket", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const single = nextTicket(state);
    const multi = nextTickets(state, 1);
    expect(multi.kind).toBe("found");
    if (multi.kind === "found" && single.kind === "found") {
      expect(multi.candidates).toHaveLength(1);
      expect(multi.candidates[0]!.ticket.id).toBe(single.ticket.id);
    }
  });

  it("count=1 with phase 1 all-blocked continues to phase 2 (differs from nextTicket)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-002", phase: "p2", order: 10, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    // nextTicket stops at blocked phase
    expect(nextTicket(state).kind).toBe("all_blocked");
    // nextTickets continues past it
    const result = nextTickets(state, 1);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.ticket.id).toBe("T-002");
      expect(result.skippedBlockedPhases).toHaveLength(1);
      expect(result.skippedBlockedPhases[0]!.phaseId).toBe("p1");
    }
  });

  it("collects multiple candidates across phases", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
        makeTicket({ id: "T-003", phase: "p2", order: 10, status: "open" }),
        makeTicket({ id: "T-004", phase: "p2", order: 20, status: "open" }),
        makeTicket({ id: "T-005", phase: "p2", order: 30, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const result = nextTickets(state, 3);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(3);
      expect(result.candidates[0]!.ticket.id).toBe("T-001");
      expect(result.candidates[1]!.ticket.id).toBe("T-002");
      expect(result.candidates[2]!.ticket.id).toBe("T-003");
    }
  });

  it("skips blocked phase, collects from later phase with skippedBlockedPhases", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-003", phase: "p2", order: 10, status: "open" }),
        makeTicket({ id: "T-004", phase: "p2", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const result = nextTickets(state, 3);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]!.ticket.id).toBe("T-003");
      expect(result.candidates[1]!.ticket.id).toBe("T-004");
      expect(result.skippedBlockedPhases).toHaveLength(1);
      expect(result.skippedBlockedPhases[0]!.phaseId).toBe("p1");
      expect(result.skippedBlockedPhases[0]!.blockedCount).toBe(2);
    }
  });

  it("count exceeding available returns all available (partial fill)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTickets(state, 10);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("all tickets in all phases blocked returns all_blocked with all phases", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-002", phase: "p2", status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-003", phase: "p2", status: "open", blockedBy: ["T-999"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const result = nextTickets(state, 3);
    expect(result.kind).toBe("all_blocked");
    if (result.kind === "all_blocked") {
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0]!.phaseId).toBe("p1");
      expect(result.phases[0]!.blockedCount).toBe(1);
      expect(result.phases[1]!.phaseId).toBe("p2");
      expect(result.phases[1]!.blockedCount).toBe(2);
    }
  });

  it("all phases complete returns all_complete", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(nextTickets(state, 3).kind).toBe("all_complete");
  });

  it("empty project returns empty_project", () => {
    const state = makeState({ roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    expect(nextTickets(state, 3).kind).toBe("empty_project");
  });

  it("collects multiple unblocked leaves in same phase before moving on", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open" }),
        makeTicket({ id: "T-004", phase: "p2", order: 10, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const result = nextTickets(state, 3);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(3);
      // T-001 and T-003 from p1 (T-002 blocked), then T-004 from p2
      expect(result.candidates[0]!.ticket.id).toBe("T-001");
      expect(result.candidates[1]!.ticket.id).toBe("T-003");
      expect(result.candidates[2]!.ticket.id).toBe("T-004");
    }
  });

  it("includes inprogress tickets as candidates", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "inprogress" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTickets(state, 2);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]!.ticket.id).toBe("T-001");
      expect(result.candidates[0]!.ticket.status).toBe("inprogress");
    }
  });

  it("count < 1 treated as 1", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTickets(state, 0);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.candidates).toHaveLength(1);
    }
  });

  it("T-475 section 5: excludes an OPEN earmarked ticket, includes an INPROGRESS earmarked one", () => {
    const earmark = {
      stage: "assigned" as const,
      reservedBy: { client: "claude" as const, id: "pen-task-1" },
      arrangementId: "a-0123456789abcdef",
      since: "2026-08-28T00:00:00.000Z",
      holderRole: "worker" as const,
      holderSession: "11111111-1111-4111-8111-111111111111",
    };
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10, status: "open", earmark }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "inprogress", earmark }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTickets(state, 5);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      const ids = result.candidates.map((c) => c.ticket.id);
      expect(ids).not.toContain("T-001");
      expect(ids).toContain("T-002");
      expect(ids).toContain("T-003");
    }
  });
});

describe("blockedTickets", () => {
  it("returns incomplete blocked leaf tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open", blockedBy: ["T-001"] }),
      ],
    });
    const blocked = blockedTickets(state);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.id).toBe("T-002");
  });

  it("returns empty when nothing is blocked", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", status: "open" })],
    });
    expect(blockedTickets(state)).toHaveLength(0);
  });

  it("excludes complete tickets", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "complete", blockedBy: ["T-001"] }),
      ],
    });
    expect(blockedTickets(state)).toHaveLength(0);
  });

  it("includes tickets blocked by unknown IDs", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", status: "open", blockedBy: ["T-999"] })],
    });
    expect(blockedTickets(state)).toHaveLength(1);
  });
});

describe("ticketsUnblockedBy", () => {
  it("returns tickets that would become unblocked", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "open", blockedBy: ["T-001"] }),
      ],
    });
    const result = ticketsUnblockedBy("T-001", state);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("T-002");
  });

  it("excludes tickets with other incomplete blockers", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-003", status: "open" }),
        makeTicket({ id: "T-002", status: "open", blockedBy: ["T-001", "T-003"] }),
      ],
    });
    // Completing T-001 alone wouldn't unblock T-002 (T-003 still open)
    expect(ticketsUnblockedBy("T-001", state)).toHaveLength(0);
  });

  it("returns empty for non-blocker", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", status: "open" })],
    });
    expect(ticketsUnblockedBy("T-001", state)).toHaveLength(0);
  });

  it("does not include transitive unblocking", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "open", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", status: "open", blockedBy: ["T-002"] }),
      ],
    });
    const result = ticketsUnblockedBy("T-001", state);
    // Only T-002 directly unblocks, not T-003
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("T-002");
  });

  it("handles ticket blocked by multiple where others are complete", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "complete" }),
        makeTicket({ id: "T-003", status: "open", blockedBy: ["T-001", "T-002"] }),
      ],
    });
    // T-002 is complete, only T-001 remains → completing T-001 unblocks T-003
    expect(ticketsUnblockedBy("T-001", state)).toHaveLength(1);
  });
});

describe("umbrellaProgress", () => {
  it("returns correct counts for umbrella", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001", status: "complete" }),
        makeTicket({ id: "T-003", parentTicket: "T-001", status: "open" }),
        makeTicket({ id: "T-004", parentTicket: "T-001", status: "open" }),
      ],
    });
    const result = umbrellaProgress("T-001", state);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(3);
    expect(result!.complete).toBe(1);
    expect(result!.status).toBe("inprogress");
  });

  it("returns null for non-umbrella", () => {
    const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
    expect(umbrellaProgress("T-001", state)).toBeNull();
  });

  it("handles nested umbrellas", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", parentTicket: "T-002", status: "complete" }),
        makeTicket({ id: "T-004", parentTicket: "T-002", status: "open" }),
      ],
    });
    const result = umbrellaProgress("T-001", state);
    expect(result!.total).toBe(2); // T-003 and T-004 are the leaves
    expect(result!.complete).toBe(1);
  });

  it("handles cycle in parentTicket without infinite loop", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", parentTicket: "T-002" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
      ],
    });
    const result = umbrellaProgress("T-001", state);
    expect(result).not.toBeNull();
    // Should terminate and return some result without crashing
    expect(result!.total).toBeGreaterThanOrEqual(0);
  });
});

describe("currentPhase", () => {
  it("returns first non-complete phase with leaves", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p2", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    expect(currentPhase(state)?.id).toBe("p2");
  });

  it("returns null when all phases complete", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", status: "complete" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(currentPhase(state)).toBeNull();
  });

  it("skips empty phases", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p2", status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    expect(currentPhase(state)?.id).toBe("p2");
  });
});

describe("phasesWithStatus", () => {
  it("returns all phases with status and leaf count", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p2", status: "open" }),
        makeTicket({ id: "T-003", phase: "p2", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const result = phasesWithStatus(state);
    expect(result).toHaveLength(2);
    expect(result[0]!.status).toBe("complete");
    expect(result[0]!.leafCount).toBe(1);
    expect(result[1]!.status).toBe("notstarted");
    expect(result[1]!.leafCount).toBe(2);
  });
});

describe("isBlockerCleared", () => {
  it("returns true for legacy cleared: true", () => {
    expect(isBlockerCleared({ name: "test", cleared: true } as any)).toBe(true);
  });

  it("returns false for legacy cleared: false", () => {
    expect(isBlockerCleared({ name: "test", cleared: false } as any)).toBe(false);
  });

  it("returns true for date-based cleared (clearedDate set)", () => {
    expect(isBlockerCleared({ name: "test", createdDate: "2026-01-01", clearedDate: "2026-01-02" } as any)).toBe(true);
  });

  it("returns false for date-based active (clearedDate null)", () => {
    expect(isBlockerCleared({ name: "test", createdDate: "2026-01-01", clearedDate: null } as any)).toBe(false);
  });

  it("returns false for minimal blocker (name only)", () => {
    expect(isBlockerCleared({ name: "test" } as any)).toBe(false);
  });
});

describe("isCrossNodeBlocked", () => {
  it("returns false for ticket with no crossNodeBlockedBy", () => {
    const ticket = makeTicket({ id: "T-001" });
    expect(isCrossNodeBlocked(ticket)).toBe(false);
  });

  it("returns false for ticket with empty crossNodeBlockedBy", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: [] });
    expect(isCrossNodeBlocked(ticket)).toBe(false);
  });

  it("returns true when crossNodeBlockedBy has refs but no cache provided", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010"] });
    expect(isCrossNodeBlocked(ticket)).toBe(true);
  });

  it("returns true when crossNodeBlockedBy has refs but cache is undefined", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010"] });
    expect(isCrossNodeBlocked(ticket, undefined)).toBe(true);
  });

  it("returns true when ref is not in cache (unknown)", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010"] });
    expect(isCrossNodeBlocked(ticket, {})).toBe(true);
  });

  it("returns true when ref status is not complete", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010"] });
    expect(isCrossNodeBlocked(ticket, { "core:T-010": "open" })).toBe(true);
  });

  it("returns true when ref status is inprogress", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010"] });
    expect(isCrossNodeBlocked(ticket, { "core:T-010": "inprogress" })).toBe(true);
  });

  it("returns false when all refs are complete", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010", "api:T-005"] });
    expect(isCrossNodeBlocked(ticket, { "core:T-010": "complete", "api:T-005": "complete" })).toBe(false);
  });

  it("returns true when some refs are complete but one is not", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010", "api:T-005"] });
    expect(isCrossNodeBlocked(ticket, { "core:T-010": "complete", "api:T-005": "open" })).toBe(true);
  });

  it("returns true for unresolved status", () => {
    const ticket = makeTicket({ id: "T-001", crossNodeBlockedBy: ["core:T-010"] });
    expect(isCrossNodeBlocked(ticket, { "core:T-010": "unresolved" })).toBe(true);
  });
});
