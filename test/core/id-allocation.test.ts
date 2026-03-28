import { describe, it, expect } from "vitest";
import { nextTicketID, nextIssueID, nextNoteID, nextLessonID, nextOrder } from "../../src/core/id-allocation.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makeRoadmap, makePhase } from "./test-factories.js";

describe("nextTicketID", () => {
  it("returns T-001 for empty array", () => {
    expect(nextTicketID([])).toBe("T-001");
  });

  it("returns T-002 when max is T-001", () => {
    const tickets = [makeTicket({ id: "T-001" })];
    expect(nextTicketID(tickets)).toBe("T-002");
  });

  it("handles suffixed IDs — T-077a → numeric 77, returns T-078", () => {
    const tickets = [
      makeTicket({ id: "T-001" }),
      makeTicket({ id: "T-077" }),
      makeTicket({ id: "T-077a" }),
    ];
    expect(nextTicketID(tickets)).toBe("T-078");
  });

  it("handles large numbers without excess padding", () => {
    const tickets = [makeTicket({ id: "T-999" })];
    expect(nextTicketID(tickets)).toBe("T-1000");
  });

  it("handles non-contiguous IDs", () => {
    const tickets = [
      makeTicket({ id: "T-001" }),
      makeTicket({ id: "T-005" }),
      makeTicket({ id: "T-010" }),
    ];
    expect(nextTicketID(tickets)).toBe("T-011");
  });

  it("handles mixed suffixed and non-suffixed", () => {
    const tickets = [
      makeTicket({ id: "T-077" }),
      makeTicket({ id: "T-077a" }),
      makeTicket({ id: "T-077b" }),
    ];
    expect(nextTicketID(tickets)).toBe("T-078");
  });
});

describe("nextIssueID", () => {
  it("returns ISS-001 for empty array", () => {
    expect(nextIssueID([])).toBe("ISS-001");
  });

  it("returns ISS-010 when max is ISS-009", () => {
    const issues = [makeIssue({ id: "ISS-009" })];
    expect(nextIssueID(issues)).toBe("ISS-010");
  });

  it("handles large numbers", () => {
    const issues = [makeIssue({ id: "ISS-999" })];
    expect(nextIssueID(issues)).toBe("ISS-1000");
  });
});

describe("nextNoteID", () => {
  it("returns N-001 for empty array", () => {
    expect(nextNoteID([])).toBe("N-001");
  });

  it("returns N-004 when max is N-003", () => {
    const notes = [
      makeNote({ id: "N-001" }),
      makeNote({ id: "N-003" }),
    ];
    expect(nextNoteID(notes)).toBe("N-004");
  });

  it("ignores malformed IDs", () => {
    const notes = [
      makeNote({ id: "N-002" }),
      { id: "NOTE-bad", title: null, content: "x", tags: [], status: "active" as const, createdDate: "2026-03-20", updatedDate: "2026-03-20" },
    ] as any;
    expect(nextNoteID(notes)).toBe("N-003");
  });
});

describe("nextLessonID", () => {
  it("returns L-001 for empty array", () => {
    expect(nextLessonID([])).toBe("L-001");
  });

  it("returns L-004 when max is L-003", () => {
    const lessons = [
      makeLesson({ id: "L-001" }),
      makeLesson({ id: "L-003" }),
    ];
    expect(nextLessonID(lessons)).toBe("L-004");
  });

  it("ignores malformed IDs", () => {
    const lessons = [
      makeLesson({ id: "L-002" }),
      { id: "LESSON-bad" } as any,
    ];
    expect(nextLessonID(lessons)).toBe("L-003");
  });
});

describe("nextOrder", () => {
  it("returns 10 for empty phase", () => {
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(nextOrder("p1", state)).toBe(10);
  });

  it("returns max + 10 for non-empty phase", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10 }),
        makeTicket({ id: "T-002", phase: "p1", order: 30 }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(nextOrder("p1", state)).toBe(40);
  });

  it("handles null phase", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: null, order: 20 })],
    });
    expect(nextOrder(null, state)).toBe(30);
  });
});
