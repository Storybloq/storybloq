import { describe, it, expect } from "vitest";
import { validateProject, mergeValidation } from "../../src/core/validation.js";
import { makeTicket, makeIssue, makeNote, makeLesson, makeState, makeRoadmap, makePhase, minimalConfig } from "./test-factories.js";
import { ProjectState } from "../../src/core/project-state.js";
import type { Config } from "../../src/models/config.js";
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

  it("reports unresolved entity conflicts as validation errors", () => {
    const ticket = makeTicket({ id: "T-001", phase: "p1" });
    (ticket as Record<string, unknown>)._conflicts = [
      { fieldPath: "/title", kind: "field", base: "A", ours: "B", theirs: "C" },
    ];
    const state = makeState({
      tickets: [ticket],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === "unresolved_conflicts" && f.entity === "T-001")).toBe(true);
  });

  it("reports unresolved config and roadmap conflicts as validation errors", () => {
    const state = makeState({
      config: { ...minimalConfig, _conflicts: [{ fieldPath: "/project", kind: "field" }] } as Config,
      roadmap: { ...makeRoadmap([makePhase({ id: "p1" })]), _conflicts: [{ fieldPath: "/phases", kind: "field" }] } as any,
    });
    const result = validateProject(state);
    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.code === "unresolved_conflicts" && f.entity === "config.json")).toBe(true);
    expect(result.findings.some((f) => f.code === "unresolved_conflicts" && f.entity === "roadmap.json")).toBe(true);
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

  it("reports duplicate issue dedupe keys", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", dedupeKey: "review:shared" }),
        makeIssue({ id: "ISS-002", dedupeKey: "review:shared" }),
      ],
    });
    expect(
      validateProject(state).findings.some((f) => f.code === "duplicate_issue_dedupe_key"),
    ).toBe(true);
  });

  it("ignores deleted issues when checking duplicate dedupe keys", () => {
    const state = makeState({
      issues: [
        makeIssue({ id: "ISS-001", dedupeKey: "review:shared", lifecycle: "deleted" }),
        makeIssue({ id: "ISS-002", dedupeKey: "review:shared" }),
      ],
    });
    expect(
      validateProject(state).findings.some((f) => f.code === "duplicate_issue_dedupe_key"),
    ).toBe(false);
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

  it("reports parentTicket cycle through display ID refs", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", phase: "p1", parentTicket: "T-002" }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-002", phase: "p1", parentTicket: "T-001" }),
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

  it("reports blockedBy cycle through display ID refs", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "t-aaa0000000000001", displayId: "T-001", phase: "p1", blockedBy: ["T-002"] }),
        makeTicket({ id: "t-bbb0000000000002", displayId: "T-002", phase: "p1", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "blocked_by_cycle")).toBe(true);
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

  it("reports blockedBy referencing umbrella through display ID refs", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "t-parent000000001", displayId: "T-001", phase: "p1" }),
        makeTicket({ id: "t-child0000000002", displayId: "T-002", phase: "p1", parentTicket: "T-001" }),
        makeTicket({ id: "t-blocked0000003", displayId: "T-003", phase: "p1", blockedBy: ["T-001"] }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    expect(validateProject(state).findings.some((f) => f.code === "blocked_by_umbrella")).toBe(true);
  });

  it("warns when refs resolve to deleted tickets by display ID", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "t-deleted0000001", displayId: "T-001", phase: "p1", lifecycle: "deleted" }),
        makeTicket({ id: "t-blocked0000002", displayId: "T-002", phase: "p1", blockedBy: ["T-001"], parentTicket: "T-001" }),
      ],
      issues: [makeIssue({ id: "ISS-001", relatedTickets: ["T-001"] })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const codes = validateProject(state).findings.map((f) => f.code);
    expect(codes).toContain("blocked_by_deleted");
    expect(codes).toContain("parent_deleted");
    expect(codes).toContain("related_ticket_deleted");
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

describe("ISS-729: team-mode duplicate displayId detection", () => {
  const teamConfig = { ...minimalConfig, team: { enabled: true } } as Config;

  it("flags duplicate ticket displayIds as a warning in team mode (not error)", () => {
    const state = makeState({
      config: teamConfig,
      tickets: [
        makeTicket({ id: "T-aaaa11112222", displayId: "T-042", phase: "p1" }),
        makeTicket({ id: "T-bbbb33334444", displayId: "T-042", phase: "p1" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    } as never);
    const result = validateProject(state);
    const finding = result.findings.find((f) => f.code === "duplicate_display_id");
    expect(finding).toBeDefined();
    expect(finding!.level).toBe("warning");
    expect(finding!.entity).toBe("T-042");
    expect(finding!.message).toContain("T-aaaa11112222");
    expect(finding!.message).toContain("T-bbbb33334444");
    // Warning, not error: the canonical ids are unique so the project is valid.
    expect(result.errorCount).toBe(0);
    expect(result.valid).toBe(true);
  });

  it("also flags duplicate issue displayIds in team mode", () => {
    const state = makeState({
      config: teamConfig,
      issues: [
        makeIssue({ id: "ISS-aaaa1111", displayId: "ISS-007" }),
        makeIssue({ id: "ISS-bbbb2222", displayId: "ISS-007" }),
      ],
    } as never);
    const finding = validateProject(state).findings.find((f) => f.code === "duplicate_display_id");
    expect(finding).toBeDefined();
    expect(finding!.entity).toBe("ISS-007");
  });

  it("does NOT flag duplicate displayIds in non-team mode (gated off)", () => {
    const state = makeState({
      tickets: [
        makeTicket({ id: "T-aaaa11112222", displayId: "T-042", phase: "p1" }),
        makeTicket({ id: "T-bbbb33334444", displayId: "T-042", phase: "p1" }),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    } as never);
    expect(validateProject(state).findings.some((f) => f.code === "duplicate_display_id")).toBe(false);
  });

  it("does NOT flag a displayId still held by a tombstone (active-only, ISS-689)", () => {
    const state = makeState({
      config: teamConfig,
      tickets: [
        makeTicket({ id: "T-aaaa11112222", displayId: "T-042", phase: "p1" }),
        makeTicket({ id: "T-bbbb33334444", displayId: "T-042", phase: "p1", lifecycle: "deleted" } as never),
      ],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    } as never);
    expect(validateProject(state).findings.some((f) => f.code === "duplicate_display_id")).toBe(false);
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

  it("ISS-730: drops cross_reference loader warnings (validate runs its own pass)", () => {
    const base = validateProject(makeState());
    const warnings: LoadWarning[] = [
      { file: "T-001", message: "[invalid_parent_ref] dangling", type: "cross_reference" },
    ];
    const merged = mergeValidation(base, warnings);
    // The only loader warning was cross_reference, so nothing is merged in.
    expect(merged).toBe(base);
    expect(merged.findings.some((f) => f.code === "loader_cross_reference")).toBe(false);
  });

  it("ISS-730: cross_reference is dropped but other loader warnings still merge", () => {
    const base = validateProject(makeState());
    const warnings: LoadWarning[] = [
      { file: "T-001", message: "[invalid_parent_ref] dangling", type: "cross_reference" },
      { file: "tickets/T-bad.json", message: "Invalid JSON", type: "parse_error" },
    ];
    const merged = mergeValidation(base, warnings);
    expect(merged.findings.some((f) => f.code === "loader_parse_error")).toBe(true);
    expect(merged.findings.some((f) => f.code === "loader_cross_reference")).toBe(false);
  });
});

describe("crossNodeBlockedBy validation (T-337)", () => {
  const orchConfig: Config = {
    version: 2, schemaVersion: 2, project: "studio", type: "orchestrator", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    nodes: {
      engine: { path: "~/Dev/engine", health: "green", dependsOn: [] },
      cloud: { path: "~/Dev/cloud", health: "yellow", dependsOn: ["engine"] },
    },
  };

  function makeOrchestratorState(tickets: ReturnType<typeof makeTicket>[]): ProjectState {
    return new ProjectState({
      tickets,
      issues: [],
      notes: [],
      lessons: [],
      roadmap: { version: 2, phases: [{ id: "p1", name: "Phase 1", order: 10, description: "" }], blockers: [] },
      config: orchConfig,
      handoverFilenames: [],
    });
  }

  it("passes validation for valid cross-node refs", () => {
    const ticket = makeTicket({ id: "T-001", phase: "p1" });
    (ticket as Record<string, unknown>).crossNodeBlockedBy = ["engine:T-061"];
    const state = makeOrchestratorState([ticket]);
    const result = validateProject(state);
    expect(result.findings.filter((f) => f.code.includes("cross_node"))).toHaveLength(0);
  });

  it("flags ref to non-existent node", () => {
    const ticket = makeTicket({ id: "T-001", phase: "p1" });
    (ticket as Record<string, unknown>).crossNodeBlockedBy = ["nonexistent:T-001"];
    const state = makeOrchestratorState([ticket]);
    const result = validateProject(state);
    expect(result.findings.some((f) => f.code === "unknown_cross_node_ref")).toBe(true);
  });

  it("does not check cross-node refs on non-orchestrator projects", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001", phase: "p1" })],
      roadmap: makeRoadmap([makePhase({ id: "p1" })]),
    });
    const result = validateProject(state);
    expect(result.findings.filter((f) => f.code.includes("cross_node"))).toHaveLength(0);
  });
});

describe("stale_earmark (T-475, AM-a/AM-b)", () => {
  const NOW = "2026-08-30T00:00:00.000Z";
  const STALE_SINCE = "2026-08-01T00:00:00.000Z"; // well past any reasonable threshold

  function reservedEarmark(overrides: Record<string, unknown> = {}) {
    return {
      stage: "reserved",
      reservedBy: { client: "claude", id: "task-1" },
      arrangementId: "a-0123456789abcdef",
      since: STALE_SINCE,
      holderRole: "worker",
      holderSession: null,
      ...overrides,
    };
  }

  function assignedEarmark(overrides: Record<string, unknown> = {}) {
    return {
      stage: "assigned",
      reservedBy: { client: "claude", id: "task-1" },
      arrangementId: "a-0123456789abcdef",
      since: STALE_SINCE,
      holderRole: "worker",
      holderSession: "11111111-1111-4111-8111-111111111111",
      ...overrides,
    };
  }

  it("flags a stale reserved ticket earmark past the default 48h threshold", () => {
    const ticket = makeTicket({ id: "T-001", phase: "p1", earmark: reservedEarmark() as never });
    const state = makeState({ tickets: [ticket], roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = validateProject(state, NOW);
    expect(result.findings.some((f) => f.code === "stale_earmark" && f.entity === "T-001")).toBe(true);
  });

  it("does not flag an assigned ticket earmark whose holder matches the actual claim, regardless of age", () => {
    const ticket = makeTicket({
      id: "T-001", phase: "p1",
      earmark: assignedEarmark({ holderSession: "11111111-1111-4111-8111-111111111111" }) as never,
      claimedBySession: "11111111-1111-4111-8111-111111111111",
    } as never);
    const state = makeState({ tickets: [ticket], roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = validateProject(state, NOW);
    expect(result.findings.some((f) => f.code === "stale_earmark")).toBe(false);
  });

  it("flags a stale assigned ticket earmark with no matching claim", () => {
    const ticket = makeTicket({
      id: "T-001", phase: "p1",
      earmark: assignedEarmark() as never,
      claimedBySession: null,
    } as never);
    const state = makeState({ tickets: [ticket], roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = validateProject(state, NOW);
    expect(result.findings.some((f) => f.code === "stale_earmark" && f.entity === "T-001")).toBe(true);
  });

  it("flags the dead-session sweep strand: issue inprogress + assigned earmark + no live session, past threshold (AM-b)", () => {
    // The exact residue a session dying mid-sweep leaves behind: status was
    // already set to inprogress and the earmark converted to assigned before
    // the crash. Issues carry no claimedBySession to match against at all, so
    // this is the only way `validate` ever surfaces this strand.
    const issue = makeIssue({ id: "ISS-001", status: "inprogress", earmark: assignedEarmark() as never } as never);
    const state = makeState({ issues: [issue] });
    const result = validateProject(state, NOW);
    expect(result.findings.some((f) => f.code === "stale_earmark" && f.entity === "ISS-001")).toBe(true);
  });

  it("respects recipeOverrides.earmarkStaleThresholdHours", () => {
    const ticket = makeTicket({ id: "T-001", phase: "p1", earmark: reservedEarmark({ since: NOW }) as never });
    const config = { ...minimalConfig, recipeOverrides: { earmarkStaleThresholdHours: 1 } } as Config;
    const state = makeState({ tickets: [ticket], roadmap: makeRoadmap([makePhase({ id: "p1" })]), config });
    // Fresh earmark, 2 hours later, threshold 1h -- stale under the override
    // even though it would not be stale under the 48h default.
    const later = "2026-08-30T02:00:00.000Z";
    const result = validateProject(state, later);
    expect(result.findings.some((f) => f.code === "stale_earmark")).toBe(true);
  });

  it("never flags a deleted ticket or issue regardless of earmark age", () => {
    const ticket = makeTicket({ id: "T-001", phase: "p1", earmark: reservedEarmark() as never } as never);
    (ticket as Record<string, unknown>).lifecycle = "deleted";
    const issue = makeIssue({ id: "ISS-001", earmark: assignedEarmark() as never } as never);
    (issue as Record<string, unknown>).lifecycle = "deleted";
    const state = makeState({ tickets: [ticket], issues: [issue], roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const result = validateProject(state, NOW);
    expect(result.findings.some((f) => f.code === "stale_earmark")).toBe(false);
  });
});
