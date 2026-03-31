import { describe, it, expect } from "vitest";
import { validateProject, mergeValidation } from "../../src/core/validation.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makeRoadmap, makePhase } from "./test-factories.js";
import type { LoadWarning } from "../../src/core/errors.js";

describe("validateProject", () => {
  it("returns valid for clean project", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-001"] })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    expect(result.valid).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it("reports invalid phase ref", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "nonexistent" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === "invalid_phase_ref")).toBe(true);
  });

  it("null phase is valid", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: null })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).valid).toBe(true);
  });

  it("reports invalid blockedBy ref", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-999"] })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    expect(result.findings.some((f) => f.code === "invalid_blocked_by_ref")).toBe(true);
  });

  it("reports invalid parentTicket ref", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", parentTicket: "T-999" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "invalid_parent_ref")).toBe(true);
  });

  it("reports invalid relatedTickets ref on issue", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-999"] })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "invalid_related_ticket_ref")).toBe(true);
  });

  it("reports duplicate ticket IDs", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }),
        makeTicket({ id: "T-001", phase: "p1", title: "Duplicate" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "duplicate_ticket_id")).toBe(true);
  });

  it("reports duplicate issue IDs", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001" }), makeIssue({ id: "ISS-001" })],
    });
    expect(validateProject(state).findings.some((f) => f.code === "duplicate_issue_id")).toBe(true);
  });

  it("reports duplicate note IDs", () => {
    const state = makeState({
      notes: [makeNote({ id: "N-001" }), makeNote({ id: "N-001" })],
    });
    expect(validateProject(state).findings.some((f) => f.code === "duplicate_note_id")).toBe(true);
  });

  it("reports duplicate lesson IDs", () => {
    const state = makeState({
      lessons: [makeLesson({ id: "L-001" }), makeLesson({ id: "L-001" })],
    });
    expect(validateProject(state).findings.some((f) => f.code === "duplicate_lesson_id")).toBe(true);
  });

  it("reports self-referencing supersedes", () => {
    const state = makeState({
      lessons: [makeLesson({ id: "L-001", supersedes: "L-001" })],
    });
    expect(validateProject(state).findings.some((f) => f.code === "self_ref_supersedes")).toBe(true);
  });

  it("reports invalid supersedes ref", () => {
    const state = makeState({
      lessons: [makeLesson({ id: "L-001", supersedes: "L-999" })],
    });
    expect(validateProject(state).findings.some((f) => f.code === "invalid_supersedes_ref")).toBe(true);
  });

  it("accepts valid supersedes ref", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", supersedes: null }),
        makeLesson({ id: "L-002", supersedes: "L-001" }),
      ],
    });
    expect(validateProject(state).findings.filter((f) => f.code.includes("supersedes"))).toHaveLength(0);
  });

  it("detects 2-node supersedes cycle (A->B->A)", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", supersedes: "L-002" }),
        makeLesson({ id: "L-002", supersedes: "L-001" }),
      ],
    });
    expect(validateProject(state).findings.some((f) => f.code === "supersedes_cycle")).toBe(true);
  });

  it("detects 3-node supersedes cycle (A->B->C->A)", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", supersedes: "L-002" }),
        makeLesson({ id: "L-002", supersedes: "L-003" }),
        makeLesson({ id: "L-003", supersedes: "L-001" }),
      ],
    });
    expect(validateProject(state).findings.some((f) => f.code === "supersedes_cycle")).toBe(true);
  });

  it("allows valid supersedes chain (no cycle)", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", supersedes: null }),
        makeLesson({ id: "L-002", supersedes: "L-001" }),
        makeLesson({ id: "L-003", supersedes: "L-002" }),
      ],
    });
    expect(validateProject(state).findings.filter((f) => f.code === "supersedes_cycle")).toHaveLength(0);
  });

  it("flags cycle lessons without affecting non-cycle lessons", () => {
    const state = makeState({
      lessons: [
        makeLesson({ id: "L-001", supersedes: null }),
        makeLesson({ id: "L-002", supersedes: "L-001" }),
        makeLesson({ id: "L-003", supersedes: "L-004" }),
        makeLesson({ id: "L-004", supersedes: "L-003" }),
      ],
    });
    const cycles = validateProject(state).findings.filter((f) => f.code === "supersedes_cycle");
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.every((f) => f.entity === "L-003" || f.entity === "L-004")).toBe(true);
  });

  it("reports duplicate phase IDs", () => {
    const state = makeState({
      roadmap: makeRoadmap([makePhase({ id: "p1" }), makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "duplicate_phase_id")).toBe(true);
  });

  it("reports self-referencing blockedBy", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-001"] })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "self_ref_blocked_by")).toBe(true);
  });

  it("reports self-referencing parentTicket", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1", parentTicket: "T-001" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "self_ref_parent")).toBe(true);
  });

  it("reports parentTicket cycle", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", parentTicket: "T-002" }),
        makeTicket({ id: "T-002", phase: "p1", parentTicket: "T-001" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "parent_cycle")).toBe(true);
  });

  it("reports blockedBy cycle as error", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", blockedBy: ["T-002"] }),
        makeTicket({ id: "T-002", phase: "p1", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    const cycleFinding = result.findings.find((f) => f.code === "blocked_by_cycle");
    expect(cycleFinding).toBeDefined();
    expect(cycleFinding!.level).toBe("error");
    expect(result.valid).toBe(false);
  });

  it("reports blockedBy referencing umbrella", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1" }),
        makeTicket({ id: "T-002", phase: "p1", parentTicket: "T-001" }),
        makeTicket({ id: "T-003", phase: "p1", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "blocked_by_umbrella")).toBe(true);
  });

  it("warns on orphan open issue", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", status: "open", relatedTickets: [] })],
    });
    const result = validateProject(state);
    const finding = result.findings.find((f) => f.code === "orphan_issue");
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("warning");
  });

  it("does not warn on resolved orphan issue", () => {
    const state = makeState({
      issues: [makeIssue({ id: "ISS-001", status: "resolved", relatedTickets: [] })],
    });
    expect(validateProject(state).findings.some((f) => f.code === "orphan_issue")).toBe(false);
  });

  it("reports multiple errors correctly", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "bad", blockedBy: ["T-999"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
    expect(result.valid).toBe(false);
  });

  it("reports duplicate leaf order as info", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-001", phase: "p1", order: 10 }),
        makeTicket({ id: "T-002", phase: "p1", order: 10 }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    const finding = result.findings.find((f) => f.code === "duplicate_order");
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("info");
    expect(result.valid).toBe(true); // info doesn't affect validity
  });
});

describe("mergeValidation", () => {
  it("merges loader warnings into validation result", () => {
    const base = validateProject(makeState());
    const warnings: LoadWarning[] = [
      { file: "tickets/T-bad.json", message: "Invalid JSON", type: "parse_error" },
      { file: "handovers/notes.md", message: "Bad name", type: "naming_convention" },
    ];
    const merged = mergeValidation(base, warnings);
    expect(merged.errorCount).toBe(1); // parse_error → error
    expect(merged.infoCount).toBe(1); // naming_convention → info
    expect(merged.valid).toBe(false);
  });

  it("returns original if no loader warnings", () => {
    const base = validateProject(makeState());
    const merged = mergeValidation(base, []);
    expect(merged).toBe(base); // same reference
  });
});
