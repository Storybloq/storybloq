/**
 * T-188: Targeted auto mode tests.
 * Tests getRemainingTargets, buildTargetedCandidatesText,
 * PICK_TICKET targeted filtering, report() enforcement, and COMPLETE termination.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import {
  getRemainingTargets,
  buildTargetedCandidatesText,
} from "../../../src/autonomous/target-work.js";
import { makeTicket, makeIssue, makeState as makeProjectState } from "../../core/test-factories.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

function setupProject(root: string, options?: {
  tickets?: Array<{ id: string; title: string; status: string; phase: string; blockedBy?: string[] }>;
  issues?: Array<{ id: string; title: string; status: string; severity: string }>;
}): void {
  const storyDir = join(root, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  mkdirSync(join(storyDir, "notes"), { recursive: true });
  mkdirSync(join(storyDir, "lessons"), { recursive: true });
  mkdirSync(join(storyDir, "handovers"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-04-03",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));

  for (const t of options?.tickets ?? []) {
    writeFileSync(join(storyDir, "tickets", `${t.id}.json`), JSON.stringify({
      id: t.id, title: t.title, type: "task", status: t.status, phase: t.phase,
      order: 10, description: "", createdDate: "2026-04-03", completedDate: null,
      blockedBy: t.blockedBy ?? [], parentTicket: null,
    }));
  }
  for (const i of options?.issues ?? []) {
    writeFileSync(join(storyDir, "issues", `${i.id}.json`), JSON.stringify({
      id: i.id, title: i.title, status: i.status, severity: i.severity,
      components: [], impact: "test", resolution: null, location: [],
      discoveredDate: "2026-04-03", resolvedDate: null, relatedTickets: [], order: 10,
    }));
  }
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-targeted-auto-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// getRemainingTargets
// ---------------------------------------------------------------------------

describe("getRemainingTargets", () => {
  it("returns empty for empty targetWork (standard mode)", () => {
    const state = makeSessionState({ targetWork: [] });
    expect(getRemainingTargets(state)).toEqual([]);
  });

  it("returns all targets when nothing is done", () => {
    const state = makeSessionState({ targetWork: ["T-001", "T-002", "ISS-001"] });
    expect(getRemainingTargets(state)).toEqual(["T-001", "T-002", "ISS-001"]);
  });

  it("filters out completed tickets (handles object type)", () => {
    const state = makeSessionState({
      targetWork: ["T-001", "T-002", "T-003"],
      completedTickets: [{ id: "T-001", title: "Done ticket" }],
    });
    expect(getRemainingTargets(state)).toEqual(["T-002", "T-003"]);
  });

  it("filters out resolved issues (handles string type)", () => {
    const state = makeSessionState({
      targetWork: ["T-001", "ISS-001", "ISS-002"],
      resolvedIssues: ["ISS-001"],
    });
    expect(getRemainingTargets(state)).toEqual(["T-001", "ISS-002"]);
  });

  it("handles mixed ticket + issue completion", () => {
    const state = makeSessionState({
      targetWork: ["T-001", "ISS-001", "T-002", "ISS-002"],
      completedTickets: [{ id: "T-001" }],
      resolvedIssues: ["ISS-002"],
    });
    expect(getRemainingTargets(state)).toEqual(["ISS-001", "T-002"]);
  });

  it("preserves targetWork order", () => {
    const state = makeSessionState({
      targetWork: ["ISS-002", "T-003", "T-001"],
      completedTickets: [{ id: "T-003" }],
    });
    expect(getRemainingTargets(state)).toEqual(["ISS-002", "T-001"]);
  });

  it("returns empty when all targets are done", () => {
    const state = makeSessionState({
      targetWork: ["T-001", "ISS-001"],
      completedTickets: [{ id: "T-001" }],
      resolvedIssues: ["ISS-001"],
    });
    expect(getRemainingTargets(state)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stuck detection via firstReady (uses test-factories for ProjectState)
// ---------------------------------------------------------------------------

describe("stuck detection (firstReady-based)", () => {
  it("not stuck when open issue targets remain", () => {
    const ps = makeProjectState({
      tickets: [makeTicket({ id: "T-001", blockedBy: ["T-999"] })],
      issues: [makeIssue({ id: "ISS-001", severity: "high" })],
    });
    const { firstReady } = buildTargetedCandidatesText(["T-001", "ISS-001"], ps);
    expect(firstReady).not.toBeNull();
  });

  it("stuck when all targets are blocked by external items", () => {
    const ps = makeProjectState({
      tickets: [
        makeTicket({ id: "T-001", blockedBy: ["T-999"] }),
        makeTicket({ id: "T-002", blockedBy: ["T-888"] }),
      ],
    });
    const { firstReady } = buildTargetedCandidatesText(["T-001", "T-002"], ps);
    expect(firstReady).toBeNull();
  });

  it("not stuck when a blocker is in the target list and unblocked", () => {
    const ps = makeProjectState({
      tickets: [
        makeTicket({ id: "T-001" }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }),
      ],
    });
    const { firstReady } = buildTargetedCandidatesText(["T-001", "T-002"], ps);
    expect(firstReady).toEqual({ id: "T-001", kind: "ticket" });
  });

  it("stuck when mutual-blocking cycle (T-001 blocks T-002, T-002 blocks T-001)", () => {
    const ps = makeProjectState({
      tickets: [
        makeTicket({ id: "T-001", blockedBy: ["T-002"] }),
        makeTicket({ id: "T-002", blockedBy: ["T-001"] }),
      ],
    });
    const { firstReady } = buildTargetedCandidatesText(["T-001", "T-002"], ps);
    expect(firstReady).toBeNull();
  });

  it("stuck when target ticket is missing from project", () => {
    const ps = makeProjectState({ tickets: [] });
    const { firstReady } = buildTargetedCandidatesText(["T-999"], ps);
    expect(firstReady).toBeNull();
  });

  it("stuck when target ticket was completed externally", () => {
    const ps = makeProjectState({
      tickets: [makeTicket({ id: "T-001", status: "complete" })],
    });
    const { firstReady } = buildTargetedCandidatesText(["T-001"], ps);
    expect(firstReady).toBeNull();
  });

  it("stuck when target issue was resolved externally", () => {
    const ps = makeProjectState({
      issues: [makeIssue({ id: "ISS-001", status: "resolved" })],
    });
    const { firstReady } = buildTargetedCandidatesText(["ISS-001"], ps);
    expect(firstReady).toBeNull();
  });

  it("stuck when target issue is missing from project", () => {
    const ps = makeProjectState({ issues: [] });
    const { firstReady } = buildTargetedCandidatesText(["ISS-999"], ps);
    expect(firstReady).toBeNull();
  });

  it("not stuck with mix of resolved and open issues", () => {
    const ps = makeProjectState({
      issues: [
        makeIssue({ id: "ISS-001", status: "resolved" }),
        makeIssue({ id: "ISS-002", status: "open" }),
      ],
    });
    const { firstReady } = buildTargetedCandidatesText(["ISS-001", "ISS-002"], ps);
    expect(firstReady).toEqual({ id: "ISS-002", kind: "issue" });
  });
});

// ---------------------------------------------------------------------------
// buildTargetedCandidatesText (uses test-factories for ProjectState)
// ---------------------------------------------------------------------------

describe("buildTargetedCandidatesText", () => {
  it("shows type, severity, and blocked status", () => {
    const ps = makeProjectState({
      tickets: [
        makeTicket({ id: "T-001", title: "Ready task" }),
        makeTicket({ id: "T-002", title: "Blocked task", blockedBy: ["T-999"] }),
      ],
      issues: [makeIssue({ id: "ISS-001", title: "Open issue", severity: "high" })],
    });
    const { text, firstReady } = buildTargetedCandidatesText(["T-001", "T-002", "ISS-001"], ps);

    expect(text).toContain("T-001: Ready task");
    expect(text).toContain("(task) -- ready");
    expect(text).toContain("T-002: Blocked task");
    expect(text).toContain("blocked by T-999");
    expect(text).toContain("ISS-001: Open issue");
    expect(text).toContain("(issue, high)");
    expect(firstReady).toEqual({ id: "T-001", kind: "ticket" });
  });

  it("firstReady is an issue when all tickets are blocked", () => {
    const ps = makeProjectState({
      tickets: [makeTicket({ id: "T-001", title: "Blocked", blockedBy: ["T-999"] })],
      issues: [makeIssue({ id: "ISS-001", title: "Ready issue", severity: "medium" })],
    });
    const { firstReady } = buildTargetedCandidatesText(["T-001", "ISS-001"], ps);
    expect(firstReady).toEqual({ id: "ISS-001", kind: "issue" });
  });
});

// ---------------------------------------------------------------------------
// PICK_TICKET enter() -- targeted mode
// ---------------------------------------------------------------------------

describe("PICK_TICKET enter() targeted mode", () => {
  it("shows only target items when targetWork is set", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Target ticket", status: "open", phase: "p1" },
        { id: "T-002", title: "Non-target ticket", status: "open", phase: "p1" },
      ],
      issues: [{ id: "ISS-001", title: "Target issue", status: "open", severity: "high" }],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: ["T-001", "ISS-001"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect(result).not.toHaveProperty("target");
    expect(result.instruction).toContain("T-001");
    expect(result.instruction).toContain("ISS-001");
    expect(result.instruction).not.toContain("T-002");
    expect(result.reminders).toBeDefined();
    expect(result.reminders!.some(r => r.includes("targeted auto mode"))).toBe(true);
  });

  it("falls through to standard mode when targetWork is empty", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Regular ticket", status: "open", phase: "p1" },
      ],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: [] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("T-001");
    expect(result.reminders!.some(r => r.includes("targeted auto mode"))).toBe(false);
  });

  it("routes to COMPLETE when all targets are done", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-001", title: "Done ticket", status: "complete", phase: "p1" }],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({
      targetWork: ["T-001"],
      completedTickets: [{ id: "T-001" }],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("target", "COMPLETE");
  });

  it("routes to HANDOVER with stuck explanation when all blocked by external", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Blocked", status: "open", phase: "p1", blockedBy: ["T-999"] },
      ],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: ["T-001"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("target", "HANDOVER");
    const instruction = (result as any).result?.instruction ?? "";
    expect(instruction).toContain("No Workable Targets");
    expect(instruction).toContain("handover_written");
  });

  it("routes to HANDOVER with stuck explanation when mutual-blocking cycle", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Cycle A", status: "open", phase: "p1", blockedBy: ["T-002"] },
        { id: "T-002", title: "Cycle B", status: "open", phase: "p1", blockedBy: ["T-001"] },
      ],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: ["T-001", "T-002"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("target", "HANDOVER");
    const instruction = (result as any).result?.instruction ?? "";
    expect(instruction).toContain("No Workable Targets");
    expect(instruction).toContain("handover_written");
  });
});

// ---------------------------------------------------------------------------
// PICK_TICKET report() -- target enforcement
// ---------------------------------------------------------------------------

describe("PICK_TICKET report() target enforcement", () => {
  it("rejects non-target ticket pick", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Target", status: "open", phase: "p1" },
        { id: "T-002", title: "Non-target", status: "open", phase: "p1" },
      ],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: ["T-001"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-002" });
    expect(result.action).toBe("retry");
    expect(result.instruction).toContain("not a remaining target");
  });

  it("accepts target ticket pick and produces plan instruction", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-001", title: "Target", status: "open", phase: "p1" }],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: ["T-001"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });
    expect(result.action).toBe("advance");
    const instruction = (result as any).result?.instruction ?? "";
    expect(instruction).toContain("T-001");
    expect(instruction).toContain("plan_written");
  });

  it("accepts inprogress issue pick in targeted mode", async () => {
    setupProject(testRoot, {
      issues: [{ id: "ISS-001", title: "InProgress issue", status: "inprogress", severity: "high" }],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: ["ISS-001"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(result.action).toBe("goto");
  });

  it("rejects inprogress issue pick in standard mode", async () => {
    setupProject(testRoot, {
      issues: [{ id: "ISS-001", title: "InProgress issue", status: "inprogress", severity: "high" }],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: [] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(result.action).toBe("retry");
    expect(result.instruction).toContain("inprogress");
  });

  it("rejects non-target issue pick", async () => {
    setupProject(testRoot, {
      issues: [
        { id: "ISS-001", title: "Target issue", status: "open", severity: "high" },
        { id: "ISS-002", title: "Non-target issue", status: "open", severity: "low" },
      ],
    });
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeSessionState({ targetWork: ["ISS-001"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-002" });
    expect(result.action).toBe("retry");
    expect(result.instruction).toContain("not a remaining target");
  });
});

// ---------------------------------------------------------------------------
// COMPLETE enter() -- targeted termination
// ---------------------------------------------------------------------------

describe("COMPLETE enter() targeted termination", () => {
  it("routes to HANDOVER when all targets done", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-001", title: "Done", status: "complete", phase: "p1" }],
    });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeSessionState({
      state: "COMPLETE",
      targetWork: ["T-001", "ISS-001"],
      completedTickets: [{ id: "T-001" }],
      resolvedIssues: ["ISS-001"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("target", "HANDOVER");
  });

  it("routes to PICK_TICKET when targets remain", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Done", status: "complete", phase: "p1" },
        { id: "T-002", title: "Remaining", status: "open", phase: "p1" },
      ],
    });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeSessionState({
      state: "COMPLETE",
      targetWork: ["T-001", "T-002"],
      completedTickets: [{ id: "T-001" }],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("target", "PICK_TICKET");
    expect((result as any).result?.instruction).toContain("T-002");
  });

  it("shows targeted text and reminders in PICK_TICKET instruction", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Done", status: "complete", phase: "p1" },
        { id: "T-002", title: "Next target", status: "open", phase: "p1" },
      ],
      issues: [{ id: "ISS-001", title: "Target issue", status: "open", severity: "medium" }],
    });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeSessionState({
      state: "COMPLETE",
      targetWork: ["T-001", "T-002", "ISS-001"],
      completedTickets: [{ id: "T-001" }],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    const instruction = (result as any).result?.instruction ?? "";
    const reminders = (result as any).result?.reminders ?? [];
    expect(instruction).toContain("T-002: Next target");
    expect(instruction).toContain("ISS-001: Target issue");
    expect(reminders.some((r: string) => r.includes("targeted auto mode"))).toBe(true);
  });

  it("routes to HANDOVER when remaining targets are all blocked", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-001", title: "Done", status: "complete", phase: "p1" },
        { id: "T-002", title: "Blocked", status: "open", phase: "p1", blockedBy: ["T-999"] },
      ],
    });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeSessionState({
      state: "COMPLETE",
      targetWork: ["T-001", "T-002"],
      completedTickets: [{ id: "T-001" }],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("target", "HANDOVER");
    const instruction = (result as any).result?.instruction ?? "";
    expect(instruction).toContain("No Workable Targets");
    expect(instruction).toContain("handover_written");
  });

  it("falls through to standard mode when targetWork is empty", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-001", title: "A ticket", status: "open", phase: "p1" }],
    });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeSessionState({
      state: "COMPLETE",
      targetWork: [],
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("target", "PICK_TICKET");
    const reminders = (result as any).result?.reminders ?? [];
    expect(reminders.some((r: string) => r.includes("targeted auto mode"))).toBe(false);
  });
});
