import { describe, it, expect } from "vitest";
import { type PhaseStatus } from "../../src/core/project-state.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makePhase, makeRoadmap } from "./test-factories.js";

// --- Tests ---

describe("ProjectState", () => {
  describe("public raw inputs", () => {
    it("exposes tickets, issues, roadmap, config, handoverFilenames", () => {
      const tickets = [makeTicket({ id: "T-001" })];
      const issues = [makeIssue({ id: "ISS-001" })];
      const handovers = ["2026-01-01-initial.md"];
      const state = makeState({ tickets, issues, handoverFilenames: handovers });

      expect(state.tickets).toHaveLength(1);
      expect(state.issues).toHaveLength(1);
      expect(state.roadmap.title).toBe("test");
      expect(state.config.project).toBe("test");
      expect(state.handoverFilenames).toEqual(handovers);
    });
  });

  describe("umbrella detection", () => {
    it("identifies a ticket with children as an umbrella", () => {
      const parent = makeTicket({ id: "T-001" });
      const child = makeTicket({ id: "T-002", parentTicket: "T-001" });
      const state = makeState({ tickets: [parent, child] });

      expect(state.isUmbrella(parent)).toBe(true);
      expect(state.isUmbrella(child)).toBe(false);
    });

    it("ticket with no children is not an umbrella", () => {
      const ticket = makeTicket({ id: "T-001" });
      const state = makeState({ tickets: [ticket] });
      expect(state.isUmbrella(ticket)).toBe(false);
    });

    it("umbrellaIDs set is correct", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", parentTicket: "T-001" }),
      ];
      const state = makeState({ tickets });
      expect(state.umbrellaIDs).toEqual(new Set(["T-001"]));
    });
  });

  describe("leaf tickets", () => {
    it("excludes umbrellas", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
        makeTicket({ id: "T-003" }),
      ];
      const state = makeState({ tickets });
      const leafIDs = state.leafTickets.map((t) => t.id);
      expect(leafIDs).toContain("T-002");
      expect(leafIDs).toContain("T-003");
      expect(leafIDs).not.toContain("T-001");
    });

    it("handles single parent and child", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
      ];
      const state = makeState({ tickets });
      expect(state.leafTickets).toHaveLength(1);
      expect(state.leafTickets[0]!.id).toBe("T-002");
    });
  });

  describe("phase tickets", () => {
    it("returns leaf tickets sorted by order", () => {
      const tickets = [
        makeTicket({ id: "T-003", phase: "p1", order: 30 }),
        makeTicket({ id: "T-001", phase: "p1", order: 10 }),
        makeTicket({ id: "T-002", phase: "p1", order: 20 }),
      ];
      const state = makeState({ tickets });
      const ids = state.phaseTickets("p1").map((t) => t.id);
      expect(ids).toEqual(["T-001", "T-002", "T-003"]);
    });

    it("excludes umbrella tickets", () => {
      const tickets = [
        makeTicket({ id: "T-001", phase: "p1" }),
        makeTicket({ id: "T-002", phase: "p1", parentTicket: "T-001" }),
      ];
      const state = makeState({ tickets });
      const ids = state.phaseTickets("p1").map((t) => t.id);
      expect(ids).toEqual(["T-002"]);
    });

    it("returns empty for unknown phase", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001", phase: "p1" })] });
      expect(state.phaseTickets("unknown")).toEqual([]);
    });

    it("groups null-phase tickets separately", () => {
      const tickets = [
        makeTicket({ id: "T-001", phase: "p1", order: 10 }),
        makeTicket({ id: "T-002", phase: null, order: 20 }),
      ];
      const state = makeState({ tickets });
      expect(state.phaseTickets("p1")).toHaveLength(1);
      expect(state.phaseTickets(null)).toHaveLength(1);
      expect(state.phaseTickets(null)[0]!.id).toBe("T-002");
    });
  });

  describe("phase status", () => {
    it("returns complete when all leaf tickets complete", () => {
      const tickets = [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p1", status: "complete" }),
      ];
      const state = makeState({ tickets });
      expect(state.phaseStatus("p1")).toBe("complete");
    });

    it("returns inprogress when any ticket is inprogress", () => {
      const tickets = [
        makeTicket({ id: "T-001", phase: "p1", status: "inprogress" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }),
      ];
      const state = makeState({ tickets });
      expect(state.phaseStatus("p1")).toBe("inprogress");
    });

    it("returns inprogress when some complete but not all", () => {
      const tickets = [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }),
      ];
      const state = makeState({ tickets });
      expect(state.phaseStatus("p1")).toBe("inprogress");
    });

    it("returns notstarted when all tickets are open", () => {
      const tickets = [
        makeTicket({ id: "T-001", phase: "p1", status: "open" }),
        makeTicket({ id: "T-002", phase: "p1", status: "open" }),
      ];
      const state = makeState({ tickets });
      expect(state.phaseStatus("p1")).toBe("notstarted");
    });

    it("returns notstarted for empty phase", () => {
      const state = makeState();
      expect(state.phaseStatus("p1")).toBe("notstarted");
    });

    it("ignores umbrella stored status — derives from leaves only", () => {
      const tickets = [
        makeTicket({ id: "T-001", phase: "p1", status: "complete" }), // umbrella, stored as complete
        makeTicket({ id: "T-002", phase: "p1", status: "open", parentTicket: "T-001" }), // leaf is open
      ];
      const state = makeState({ tickets });
      // Phase status should be notstarted (only leaf T-002 counts, it's open)
      expect(state.phaseStatus("p1")).toBe("notstarted");
    });
  });

  describe("umbrella status", () => {
    it("returns complete when all children complete", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001", status: "complete" }),
        makeTicket({ id: "T-003", parentTicket: "T-001", status: "complete" }),
      ];
      const state = makeState({ tickets });
      expect(state.umbrellaStatus("T-001")).toBe("complete");
    });

    it("returns inprogress when any child is inprogress", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001", status: "inprogress" }),
        makeTicket({ id: "T-003", parentTicket: "T-001", status: "open" }),
      ];
      const state = makeState({ tickets });
      expect(state.umbrellaStatus("T-001")).toBe("inprogress");
    });

    it("returns notstarted when no children", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
      expect(state.umbrellaStatus("T-001")).toBe("notstarted");
    });

    it("handles nested umbrellas", () => {
      const tickets = [
        makeTicket({ id: "T-001" }), // top umbrella
        makeTicket({ id: "T-002", parentTicket: "T-001" }), // nested umbrella
        makeTicket({ id: "T-003", parentTicket: "T-002", status: "complete" }), // leaf
        makeTicket({ id: "T-004", parentTicket: "T-002", status: "open" }), // leaf
      ];
      const state = makeState({ tickets });
      // T-001 → T-002 → [T-003 (complete), T-004 (open)]
      expect(state.umbrellaStatus("T-001")).toBe("inprogress");
      expect(state.umbrellaStatus("T-002")).toBe("inprogress");
    });

    it("handles cycle in parentTicket", () => {
      const tickets = [
        makeTicket({ id: "T-001", parentTicket: "T-002" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
      ];
      const state = makeState({ tickets });
      // Both are umbrellas (each referenced as parentTicket)
      // descendantLeaves should not infinite loop
      expect(state.umbrellaStatus("T-001")).toBe("notstarted");
    });
  });

  describe("umbrella children", () => {
    it("returns direct children", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", parentTicket: "T-001" }),
      ];
      const state = makeState({ tickets });
      const ids = state.umbrellaChildren("T-001").map((t) => t.id);
      expect(ids).toContain("T-002");
      expect(ids).toContain("T-003");
    });

    it("returns empty for leaf ticket", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
      expect(state.umbrellaChildren("T-001")).toEqual([]);
    });
  });

  describe("reverse blocks", () => {
    it("finds tickets blocked by a given ticket", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", blockedBy: ["T-001"] }),
      ];
      const state = makeState({ tickets });
      const ids = state.reverseBlocks("T-001").map((t) => t.id);
      expect(ids).toContain("T-002");
      expect(ids).toContain("T-003");
    });

    it("returns empty when nothing is blocked by ticket", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
      expect(state.reverseBlocks("T-001")).toEqual([]);
    });
  });

  describe("isBlocked", () => {
    it("returns false for ticket with empty blockedBy", () => {
      const ticket = makeTicket({ id: "T-001", blockedBy: [] });
      const state = makeState({ tickets: [ticket] });
      expect(state.isBlocked(ticket)).toBe(false);
    });

    it("returns true when blocked by open ticket", () => {
      const blocker = makeTicket({ id: "T-001", status: "open" });
      const blocked = makeTicket({ id: "T-002", blockedBy: ["T-001"] });
      const state = makeState({ tickets: [blocker, blocked] });
      expect(state.isBlocked(blocked)).toBe(true);
    });

    it("returns true when blocked by inprogress ticket", () => {
      const blocker = makeTicket({ id: "T-001", status: "inprogress" });
      const blocked = makeTicket({ id: "T-002", blockedBy: ["T-001"] });
      const state = makeState({ tickets: [blocker, blocked] });
      expect(state.isBlocked(blocked)).toBe(true);
    });

    it("returns false when blocked by complete ticket", () => {
      const blocker = makeTicket({ id: "T-001", status: "complete" });
      const blocked = makeTicket({ id: "T-002", blockedBy: ["T-001"] });
      const state = makeState({ tickets: [blocker, blocked] });
      expect(state.isBlocked(blocked)).toBe(false);
    });

    it("returns true when blocked by unknown/missing ticket (conservative)", () => {
      const blocked = makeTicket({ id: "T-002", blockedBy: ["T-999"] });
      const state = makeState({ tickets: [blocked] });
      expect(state.isBlocked(blocked)).toBe(true);
    });

    it("returns false when all blockers are complete", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "complete" }),
        makeTicket({ id: "T-002", status: "complete" }),
        makeTicket({ id: "T-003", blockedBy: ["T-001", "T-002"] }),
      ];
      const state = makeState({ tickets });
      expect(state.isBlocked(tickets[2]!)).toBe(false);
    });

    it("returns true when any one blocker is not complete", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "complete" }),
        makeTicket({ id: "T-002", status: "open" }),
        makeTicket({ id: "T-003", blockedBy: ["T-001", "T-002"] }),
      ];
      const state = makeState({ tickets });
      expect(state.isBlocked(tickets[2]!)).toBe(true);
    });
  });

  describe("blocked count", () => {
    it("returns zero when no tickets are blocked", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
      expect(state.blockedCount).toBe(0);
    });

    it("counts tickets blocked by missing IDs", () => {
      const tickets = [
        makeTicket({ id: "T-001", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-002" }),
      ];
      const state = makeState({ tickets });
      expect(state.blockedCount).toBe(1);
    });

    it("returns correct count", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-003", blockedBy: ["T-001"] }),
        makeTicket({ id: "T-004" }),
      ];
      const state = makeState({ tickets });
      expect(state.blockedCount).toBe(2);
    });

    it("excludes umbrella tickets from blocked count", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }), // umbrella (T-003 references it)
        makeTicket({ id: "T-003", parentTicket: "T-002", blockedBy: ["T-001"] }), // leaf, blocked
      ];
      const state = makeState({ tickets });
      // T-002 is umbrella, should NOT be counted; T-003 is leaf + blocked
      expect(state.blockedCount).toBe(1);
    });

    it("excludes complete tickets from blocked count", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "open" }),
        makeTicket({ id: "T-002", status: "complete", blockedBy: ["T-001"] }),
      ];
      const state = makeState({ tickets });
      // T-002 is complete, should NOT be counted even though it has blockedBy
      expect(state.blockedCount).toBe(0);
    });
  });

  describe("counts", () => {
    it("computes ticket counts correctly", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "complete" }),
        makeTicket({ id: "T-002", status: "open" }),
        makeTicket({ id: "T-003", status: "inprogress" }),
      ];
      const state = makeState({ tickets });
      expect(state.totalTicketCount).toBe(3);
      expect(state.completeTicketCount).toBe(1);
      expect(state.openTicketCount).toBe(2); // open + inprogress
    });

    it("leaf counts exclude umbrellas", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "complete" }), // umbrella (T-002 references it)
        makeTicket({ id: "T-002", status: "complete", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", status: "open", parentTicket: "T-001" }),
      ];
      const state = makeState({ tickets });
      // All counts now use leaf tickets only (exclude umbrella T-001)
      expect(state.totalTicketCount).toBe(2);
      expect(state.completeTicketCount).toBe(1);
      expect(state.leafTicketCount).toBe(2);
      expect(state.completeLeafTicketCount).toBe(1);
    });

    it("openTicketCount includes inprogress", () => {
      const tickets = [
        makeTicket({ id: "T-001", status: "inprogress" }),
      ];
      const state = makeState({ tickets });
      expect(state.openTicketCount).toBe(1);
    });

    it("computes activeIssueCount correctly (open + inprogress, excludes resolved)", () => {
      const issues = [
        makeIssue({ id: "ISS-001", status: "open" }),
        makeIssue({ id: "ISS-002", status: "resolved" }),
        makeIssue({ id: "ISS-003", status: "open" }),
        makeIssue({ id: "ISS-004", status: "inprogress" }),
      ];
      const state = makeState({ issues });
      expect(state.activeIssueCount).toBe(3);
    });

    it("computes issuesBySeverity for active issues (excludes resolved)", () => {
      const issues = [
        makeIssue({ id: "ISS-001", status: "open", severity: "high" }),
        makeIssue({ id: "ISS-002", status: "inprogress", severity: "high" }),
        makeIssue({ id: "ISS-003", status: "resolved", severity: "high" }),
        makeIssue({ id: "ISS-004", status: "open", severity: "low" }),
      ];
      const state = makeState({ issues });
      expect(state.issuesBySeverity.get("high")).toBe(2);
      expect(state.issuesBySeverity.get("low")).toBe(1);
      expect(state.issuesBySeverity.get("critical")).toBeUndefined();
    });
  });

  describe("lookup", () => {
    it("ticketByID returns the ticket", () => {
      const ticket = makeTicket({ id: "T-001" });
      const state = makeState({ tickets: [ticket] });
      expect(state.ticketByID("T-001")).toBe(ticket);
    });

    it("ticketByID returns undefined for missing ID", () => {
      const state = makeState();
      expect(state.ticketByID("T-999")).toBeUndefined();
    });

    it("issueByID returns the issue", () => {
      const issue = makeIssue({ id: "ISS-001" });
      const state = makeState({ issues: [issue] });
      expect(state.issueByID("ISS-001")).toBe(issue);
    });
  });

  describe("deletion safety", () => {
    it("ticketsBlocking finds referencing tickets", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }),
      ];
      const state = makeState({ tickets });
      expect(state.ticketsBlocking("T-001")).toEqual(["T-002"]);
    });

    it("ticketsBlocking returns empty when nothing references", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
      expect(state.ticketsBlocking("T-001")).toEqual([]);
    });

    it("childrenOf finds child tickets", () => {
      const tickets = [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", parentTicket: "T-001" }),
      ];
      const state = makeState({ tickets });
      expect(state.childrenOf("T-001")).toEqual(["T-002"]);
    });

    it("childrenOf returns empty for leaf ticket", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
      expect(state.childrenOf("T-001")).toEqual([]);
    });

    it("issuesReferencing finds referencing issues", () => {
      const tickets = [makeTicket({ id: "T-001" })];
      const issues = [makeIssue({ id: "ISS-001", relatedTickets: ["T-001"] })];
      const state = makeState({ tickets, issues });
      expect(state.issuesReferencing("T-001")).toEqual(["ISS-001"]);
    });

    it("issuesReferencing returns empty when no references", () => {
      const state = makeState({ tickets: [makeTicket({ id: "T-001" })] });
      expect(state.issuesReferencing("T-001")).toEqual([]);
    });
  });

  describe("edge cases", () => {
    it("handles empty inputs", () => {
      const state = makeState();
      expect(state.totalTicketCount).toBe(0);
      expect(state.activeIssueCount).toBe(0);
      expect(state.leafTickets).toEqual([]);
      expect(state.umbrellaIDs.size).toBe(0);
      expect(state.blockedCount).toBe(0);
    });

    it("duplicate ticket IDs: first wins", () => {
      const first = makeTicket({ id: "T-001", title: "First" });
      const second = makeTicket({ id: "T-001", title: "Second" });
      const state = makeState({ tickets: [first, second] });
      expect(state.ticketByID("T-001")?.title).toBe("First");
    });

    it("duplicate issue IDs: last wins", () => {
      const first = makeIssue({ id: "ISS-001", title: "First" });
      const second = makeIssue({ id: "ISS-001", title: "Second" });
      const state = makeState({ issues: [first, second] });
      expect(state.issueByID("ISS-001")?.title).toBe("Second");
    });
  });

  describe("lessonTags", () => {
    it("returns deduplicated sorted tags from all lessons", () => {
      const lessons = [
        makeLesson({ id: "L-001", tags: ["testing", "architecture"] }),
        makeLesson({ id: "L-002", tags: ["testing", "performance"] }),
        makeLesson({ id: "L-003", tags: ["security"] }),
      ];
      const state = makeState({ lessons });
      expect(state.lessonTags).toEqual(["architecture", "performance", "security", "testing"]);
    });

    it("returns empty array when no lessons", () => {
      const state = makeState();
      expect(state.lessonTags).toEqual([]);
    });

    it("returns empty array when lessons have no tags", () => {
      const lessons = [
        makeLesson({ id: "L-001", tags: [] }),
      ];
      const state = makeState({ lessons });
      expect(state.lessonTags).toEqual([]);
    });

    it("handles lessons with null/undefined tags gracefully", () => {
      const lessons = [
        makeLesson({ id: "L-001", tags: ["valid"] }),
        // Force null tags to simulate malformed data bypassing schema validation
        makeLesson({ id: "L-002", tags: null as unknown as string[] }),
        makeLesson({ id: "L-003", tags: undefined as unknown as string[] }),
      ];
      const state = makeState({ lessons });
      expect(state.lessonTags).toEqual(["valid"]);
    });

    it("handles mix of empty and populated tags", () => {
      const lessons = [
        makeLesson({ id: "L-001", tags: [] }),
        makeLesson({ id: "L-002", tags: ["arch", "testing"] }),
        makeLesson({ id: "L-003", tags: [] }),
      ];
      const state = makeState({ lessons });
      expect(state.lessonTags).toEqual(["arch", "testing"]);
    });
  });

  describe("isEmptyScaffold", () => {
    it("returns true for empty state (0 everything, empty roadmap)", () => {
      const state = makeState();
      expect(state.isEmptyScaffold).toBe(true);
    });

    it("returns true for default scaffold (1 phase id='p0')", () => {
      const state = makeState({ roadmap: makeRoadmap([makePhase({ id: "p0" })]) });
      expect(state.isEmptyScaffold).toBe(true);
    });

    it("returns false when tickets exist", () => {
      const state = makeState({
        tickets: [makeTicket({ id: "T-001" })],
        roadmap: makeRoadmap([makePhase({ id: "p0" })]),
      });
      expect(state.isEmptyScaffold).toBe(false);
    });

    it("returns false when issues exist", () => {
      const state = makeState({
        issues: [makeIssue({ id: "ISS-001" })],
        roadmap: makeRoadmap([makePhase({ id: "p0" })]),
      });
      expect(state.isEmptyScaffold).toBe(false);
    });

    it("returns false when handovers exist", () => {
      const state = makeState({
        handoverFilenames: ["2026-01-01-initial.md"],
        roadmap: makeRoadmap([makePhase({ id: "p0" })]),
      });
      expect(state.isEmptyScaffold).toBe(false);
    });

    it("returns false for 2+ phases even with 0 tickets", () => {
      const state = makeState({
        roadmap: makeRoadmap([makePhase({ id: "p0" }), makePhase({ id: "p1" })]),
      });
      expect(state.isEmptyScaffold).toBe(false);
    });

    it("returns false for 1 custom phase (id='mvp'), 0 tickets", () => {
      const state = makeState({
        roadmap: makeRoadmap([makePhase({ id: "mvp" })]),
      });
      expect(state.isEmptyScaffold).toBe(false);
    });

    it("returns true when phase id='p0' but name is edited", () => {
      const state = makeState({
        roadmap: makeRoadmap([makePhase({ id: "p0", name: "Renamed Phase" })]),
      });
      expect(state.isEmptyScaffold).toBe(true);
    });

    it("returns true when notes/lessons exist but nothing else", () => {
      const state = makeState({
        notes: [makeNote({ id: "N-001" })],
        roadmap: makeRoadmap([makePhase({ id: "p0" })]),
      });
      expect(state.isEmptyScaffold).toBe(true);
    });
  });
});
