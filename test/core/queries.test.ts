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
  waitingInventory,
} from "../../src/core/queries.js";
import { handleTicketNext } from "../../src/cli/commands/ticket.js";
import { SCENARIO_SPECS } from "../../scripts/owner-checkpoint-vectors.js";
import { TicketSchema, type Ticket } from "../../src/models/ticket.js";
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

  it("offers an unphased ticket once phases are exhausted (ISS-1112 inverts the old exclusion pin)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: null, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    // p1 has no tickets, so phased work is exhausted; the unphased leaf is offered.
    const result = nextTicket(state);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.ticket.id).toBe("T-001");
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

// ISS-1112: unphased leaves are offered after phased work, never before it.
describe("ISS-1112: unphased fall-through", () => {
  const EARMARK = {
    stage: "assigned" as const,
    reservedBy: { client: "claude" as const, id: "pen-task-1" },
    arrangementId: "a-0123456789abcdef",
    since: "2026-08-28T00:00:00.000Z",
    holderRole: "worker" as const,
    holderSession: "11111111-1111-4111-8111-111111111111",
  };
  const ids = (outcome: ReturnType<typeof nextTickets>) =>
    outcome.kind === "found" ? outcome.candidates.map((c) => c.ticket.id) : outcome.kind;

  it("Q1a: nextTicket never returns an unphased leaf while phased work is open", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: null, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    expect(result.kind === "found" && result.ticket.id).toBe("T-002");
  });

  it("Q1b: nextTickets fills spare capacity with unphased leaves after the phased candidates", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: null, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(ids(nextTickets(state, 1))).toEqual(["T-002"]);
    expect(ids(nextTickets(state, 5))).toEqual(["T-002", "T-001"]);
  });

  it("Q2: once every phase is complete, nextTicket returns the unphased leaf", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: null, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTicket(state);
    expect(result.kind === "found" && result.ticket.id).toBe("T-002");
  });

  it("Q3: a blocked open phase keeps nextTicket's all_blocked contract (D2)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open", blockedBy: ["T-009"] }),
        makeTicket({ id: "T-009", phase: "p2", status: "open" }),
        makeTicket({ id: "T-002", phase: null, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    expect(nextTicket(state).kind).toBe("all_blocked");
  });

  it("Q4: nextTickets fills past a blocked phase and reports it alongside the unphased candidate", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", status: "open", blockedBy: ["T-003"] }),
        makeTicket({ id: "T-003", phase: null, status: "open", blockedBy: ["T-004"] }),
        makeTicket({ id: "T-004", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: null, status: "open" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = nextTickets(state, 5);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.candidates.map((c) => c.ticket.id)).toEqual(["T-002", "T-003"]);
    expect(result.skippedBlockedPhases).toEqual([{ phaseId: "p1", blockedCount: 1 }]);
  });

  it("Q5: a board with only unphased tickets is never empty_project or all_complete", () => {
    const withPhases = makeState({
      tickets: [makeTicket({ id: "T-001", phase: null, status: "open" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const noPhases = makeState({
      tickets: [makeTicket({ id: "T-001", phase: null, status: "open" })],
      roadmap: makeRoadmap([]),
    });
    for (const state of [withPhases, noPhases]) {
      const one = nextTicket(state);
      expect(one.kind === "found" && one.ticket.id).toBe("T-001");
      expect(ids(nextTickets(state, 3))).toEqual(["T-001"]);
    }
  });

  it.each([
    ["blocked", { blockedBy: ["T-002"] }, new Set<string>()],
    ["earmark-hidden", { earmark: EARMARK }, new Set<string>()],
    ["owner checkpoint", { ownerCheckpoint: {} }, new Set<string>()],
    ["complete", { status: "complete" }, new Set<string>()],
    ["excluded by id", {}, new Set(["T-001"])],
    ["excluded by displayId", { displayId: "T-501" }, new Set(["T-501"])],
  ] as const)("Q6: an unphased leaf that is %s is skipped and its eligible sibling returned", (_label, overrides, exclude) => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: null, status: "open", order: 10, ...(overrides as object) }),
        makeTicket({ id: "T-002", phase: null, status: "open", order: 20 }),
        makeTicket({ id: "T-008", phase: "p1", status: "open", blockedBy: ["T-009"] }),
        makeTicket({ id: "T-009", phase: "p1", status: "open", blockedBy: ["T-008"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const found = nextTickets(state, 5, exclude);
    expect(found.kind === "found" && found.candidates.map((c) => c.ticket.id)).toEqual(["T-002"]);
    if (exclude.size === 0) {
      // nextTicket stops at the blocked phase (D2); with that phase gone it must still skip T-001.
      const unblockedPhase = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: null, status: "open", order: 10, ...(overrides as object) }),
          makeTicket({ id: "T-002", phase: null, status: "open", order: 20 }),
          makeTicket({ id: "T-008", phase: "p1", status: "complete" }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const one = nextTicket(unblockedPhase);
      expect(one.kind === "found" && one.ticket.id).toBe("T-002");
    }
  });

  it("Q7: an unphased umbrella parent is never a candidate", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: null, status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "complete", parentTicket: "T-001" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(nextTicket(state).kind).toBe("all_complete");
    expect(nextTickets(state, 5).kind).toBe("all_complete");
  });

  it("Q8: zero phases with no eligible unphased leaf stays empty_project in both functions", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: null, status: "complete" }),
        makeTicket({ id: "T-002", phase: null, status: "open", blockedBy: ["T-003"] }),
        makeTicket({ id: "T-003", phase: null, status: "open", blockedBy: ["T-002"] }),
      ],
      roadmap: makeRoadmap([]),
    });
    expect(nextTicket(state).kind).toBe("empty_project");
    expect(nextTickets(state, 5).kind).toBe("empty_project");
  });

  it("Q9: unphased candidates come in rank order, truncate at count, and carry unblock and umbrella fields", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-010", phase: null, status: "open", rank: "b" }),
        makeTicket({ id: "T-002", phase: null, status: "open", order: 5 }),
        makeTicket({ id: "T-001", phase: null, status: "open", rank: "a", parentTicket: "T-020" }),
        makeTicket({ id: "T-003", phase: null, status: "open", order: 1 }),
        makeTicket({ id: "T-020", phase: null, status: "open" }),
        makeTicket({ id: "T-021", phase: "p1", status: "complete", parentTicket: "T-020" }),
        makeTicket({ id: "T-030", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-031", phase: null, status: "open", blockedBy: ["T-001"], order: 99 }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(ids(nextTickets(state, 10))).toEqual(["T-001", "T-010", "T-003", "T-002"]);
    expect(ids(nextTickets(state, 2))).toEqual(["T-001", "T-010"]);
    const one = nextTicket(state);
    expect(one.kind).toBe("found");
    if (one.kind !== "found") return;
    expect(one.ticket.id).toBe("T-001");
    expect(one.unblockImpact.ticketId).toBe("T-001");
    expect(one.unblockImpact.wouldUnblock.map((t) => t.id)).toEqual(["T-031"]);
    expect(one.umbrellaProgress).toEqual({ total: 2, complete: 1, status: "inprogress" });
  });
});

// T-481 T5: every next-ticket path skips a ticket that waits on the owner or
// an external party, offers the eligible control, and offers the ticket again
// once the field is cleared.
describe("T-481 T5: the next-ticket candidate filters skip waiting tickets", () => {
  const roadmap2 = () => makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]);
  const w = (extra: Record<string, unknown>) => extra as never;

  for (const wait of ["owner", "external"] as const) {
    it(`nextTicket, phased (${wait}): skips the waiting ticket, offers the control, and offers it once cleared`, () => {
      const tickets = (field: boolean) => [
        makeTicket({ id: "T-001", phase: "p1", order: 10, ...(field ? w({ waitingOn: wait }) : {}) }),
        makeTicket({ id: "T-002", phase: "p1", order: 20 }),
      ];
      const waiting = nextTicket(makeState({ tickets: tickets(true), roadmap: roadmap2() }));
      expect(waiting.kind === "found" && waiting.ticket.id).toBe("T-002");
      const cleared = nextTicket(makeState({ tickets: tickets(false), roadmap: roadmap2() }));
      expect(cleared.kind === "found" && cleared.ticket.id).toBe("T-001");
    });

    it(`nextTickets, phased (${wait}): the waiting ticket is never a candidate`, () => {
      const state = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", order: 10, ...w({ waitingOn: wait }) }),
          makeTicket({ id: "T-002", phase: "p1", order: 20 }),
          makeTicket({ id: "T-003", phase: "p2", order: 10, ...w({ waitingOn: wait }) }),
          makeTicket({ id: "T-004", phase: "p2", order: 20 }),
        ],
        roadmap: roadmap2(),
      });
      const out = nextTickets(state, 5);
      expect(out.kind === "found" && out.candidates.map((c) => c.ticket.id)).toEqual(["T-002", "T-004"]);
    });

    it(`unphased leaves (${wait}): the waiting unphased ticket is skipped by both next paths`, () => {
      const state = makeState({
        tickets: [
          makeTicket({ id: "T-001", phase: "p1", order: 10, status: "complete" }),
          makeTicket({ id: "T-020", phase: null, order: 10, ...w({ waitingOn: wait }) }),
          makeTicket({ id: "T-021", phase: null, order: 20 }),
        ],
        roadmap: makeRoadmap([makePhase({ id: "p1" })]),
      });
      const one = nextTicket(state);
      expect(one.kind === "found" && one.ticket.id).toBe("T-021");
      const many = nextTickets(state, 5);
      expect(many.kind === "found" && many.candidates.map((c) => c.ticket.id)).toEqual(["T-021"]);
    });
  }

  it("an unrecognised waitingOn value reads as none and does not exclude", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", order: 10, ...w({ waitingOn: "maybe" }) })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const out = nextTicket(state);
    expect(out.kind === "found" && out.ticket.id).toBe("T-001");
  });
});

// T-481 T5i: one waiting inventory, printed by ticket next. It lists every
// unfinished item that waits, with no regard to blockers, phases, claims,
// earmarks, in-progress status or the requested count.
describe("T-481 T5i: waitingInventory and the ticket next listing", () => {
  const w = (extra: Record<string, unknown>) => extra as never;
  const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id).sort();
  const earmark = {
    stage: "assigned", holderRole: "worker", holderSession: "11111111-1111-4111-8111-111111111111",
    reservedBy: { client: "claude", id: "test-session" }, arrangementId: "a-0123456789abcdef",
    since: "2026-08-28T00:00:00.000Z",
  };
  const ctxOf = (state: ReturnType<typeof makeState>) => ({
    state, warnings: [], root: "/tmp/t481-t5i", handoversDir: "/tmp/t481-t5i/.story/handovers", format: "md" as const,
  });

  it("lists in-progress, blocked, later-phase, umbrella and issue waits; next lists them while offering other work", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10 }),
        makeTicket({ id: "T-002", phase: "p1", order: 20, status: "inprogress", ...w({ waitingOn: "owner" }) }),
        makeTicket({ id: "T-003", phase: "p1", order: 30, blockedBy: ["T-001"], ...w({ waitingOn: "external" }) }),
        makeTicket({ id: "T-004", phase: "p2", order: 10, ...w({ waitingOn: "owner" }) }),
        makeTicket({ id: "T-010", phase: "p2", order: 20, ...w({ waitingOn: "owner" }) }),
        makeTicket({ id: "T-011", phase: "p2", order: 30, parentTicket: "T-010" }),
      ],
      issues: [
        makeIssue({ id: "ISS-001", ...w({ waitingOn: "owner" }) }),
        makeIssue({ id: "ISS-002", ...w({ waitingOn: "external" }) }),
        makeIssue({ id: "ISS-003" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p2" })]),
    });
    const inv = waitingInventory(state);
    expect(ids(inv.owner)).toEqual(["ISS-001", "T-002", "T-004", "T-010"]);
    expect(ids(inv.external)).toEqual(["ISS-002", "T-003"]);
    expect(inv.owner.find((x) => x.id === "T-010")).toMatchObject({ umbrella: true });
    expect(inv.owner.find((x) => x.id === "T-004")).not.toMatchObject({ umbrella: true });

    // next returns from p1 with --count 1; the later-phase wait is still listed.
    const one = handleTicketNext(ctxOf(state), 1).output;
    expect(one).toContain("T-001");
    for (const id of ["T-002", "T-003", "T-004", "T-010", "ISS-001", "ISS-002"]) expect(one).toContain(id);
    expect(one).toMatch(/wait on the owner/);
    expect(one).toMatch(/external party/);

    // The umbrella's own child, which does not wait, is still offered.
    const many = nextTickets(state, 5);
    expect(many.kind === "found" && many.candidates.map((c) => c.ticket.id)).toContain("T-011");
    const listed = handleTicketNext(ctxOf(state), 1).output;
    expect(listed).toContain("T-010");
  });

  it("umbrella mismatches read the derived status", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-020", phase: "p1", order: 10, status: "complete", completedDate: "2026-01-02", ...w({ waitingOn: "owner" }) }),
        makeTicket({ id: "T-021", phase: "p1", order: 20, parentTicket: "T-020" }),
        makeTicket({ id: "T-030", phase: "p1", order: 30, ...w({ waitingOn: "owner" }) }),
        makeTicket({ id: "T-031", phase: "p1", order: 40, parentTicket: "T-030", status: "complete", completedDate: "2026-01-02" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(ids(waitingInventory(state).owner)).toEqual(["T-020"]);
  });

  it("archived waiting records are not listed", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", lifecycle: "archived", ...w({ waitingOn: "owner" }) } as never)],
      issues: [makeIssue({ id: "ISS-001", lifecycle: "archived", ...w({ waitingOn: "external" }) } as never)],
    });
    const inv = waitingInventory(state);
    expect(inv.owner).toEqual([]);
    expect(inv.external).toEqual([]);
  });

  it("owner checkpoints: open, pending-stored-complete and unrecognised are listed; approved is not", () => {
    const listed = (name: string, over: Record<string, unknown> = {}) => {
      const spec = SCENARIO_SPECS.find((s) => s.name === name)!;
      const tickets = spec.tickets.map((t) => TicketSchema.parse(t.id === "T-001" ? { ...t, waitingOn: "owner", ...over } : t)) as Ticket[];
      return ids(waitingInventory(makeState({ tickets })).owner).includes("T-001");
    };
    expect(listed("pending")).toBe(true);
    expect(listed("approved")).toBe(false);
    expect(listed("pending", { status: "complete", completedDate: "2026-01-02" })).toBe(true);
    expect(listed("unknown-kind")).toBe(true);
  });

  it("earmarks are ignored: a completed earmarked waiting ticket is finished, an open one is listed", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", status: "complete", completedDate: "2026-01-02", earmark, ...w({ waitingOn: "owner" }) } as never),
        makeTicket({ id: "T-002", earmark, ...w({ waitingOn: "owner" }) } as never),
      ],
    });
    expect(ids(waitingInventory(state).owner)).toEqual(["T-002"]);
  });

  it("ticket next JSON always carries waiting beside data, empty lists when nothing waits (pen ruling)", () => {
    const quiet = makeState({ tickets: [makeTicket({ id: "T-001", phase: "p1", order: 10 })], roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    for (const count of [1, 3]) {
      const out = JSON.parse(handleTicketNext({ ...ctxOf(quiet), format: "json" as const }, count).output);
      expect(out.waiting).toEqual({ owner: [], external: [] });
      expect(out.data).toBeDefined();
    }
    const busy = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", order: 10 }), makeTicket({ id: "T-002", phase: "p1", order: 20, ...w({ waitingOn: "external" }) })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const out = JSON.parse(handleTicketNext({ ...ctxOf(busy), format: "json" as const }, 1).output);
    expect(out.waiting.owner).toEqual([]);
    expect(out.waiting.external.map((x: { id: string }) => x.id)).toEqual(["T-002"]);
  });

  it("complete tickets and resolved issues are not listed", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", status: "complete", completedDate: "2026-01-02", ...w({ waitingOn: "owner" }) })],
      issues: [makeIssue({ id: "ISS-001", status: "resolved", resolvedDate: "2026-01-02", resolution: "done", ...w({ waitingOn: "owner" }) })],
    });
    expect(waitingInventory(state)).toEqual({ owner: [], external: [] });
  });
});
