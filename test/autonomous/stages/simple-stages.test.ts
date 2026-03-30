/**
 * T-137: Tests for the 5 simple extracted stages.
 * Tests enter() and report() contracts, type discrimination, behavioral equivalence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StageContext, isStageAdvance, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { ImplementStage } from "../../../src/autonomous/stages/implement.js";
import { PlanStage } from "../../../src/autonomous/stages/plan.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import { HandoverStage } from "../../../src/autonomous/stages/handover.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "PICK_TICKET",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: {
      level: "low",
      guideCallCount: 0,
      ticketsCompleted: 0,
      compactionCount: 0,
      eventsLogBytes: 0,
    },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    defaults: {
      maxTicketsPerSession: 3,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ImplementStage
// ---------------------------------------------------------------------------

describe("ImplementStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new ImplementStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "impl-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("has correct stage ID", () => {
    expect(stage.id).toBe("IMPLEMENT");
  });

  it("enter() returns StageResult with instruction", async () => {
    const state = makeState({
      state: "IMPLEMENT",
      ticket: { id: "T-001", title: "Test ticket", claimed: true },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(false);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("Implement");
      expect(result.instruction).toContain("T-001");
    }
  });

  it("report() returns plain advance (no hardcoded result)", async () => {
    const state = makeState({
      state: "IMPLEMENT",
      ticket: { id: "T-001", title: "Test", claimed: true, risk: "low" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "implementation_done" });
    expect(advance.action).toBe("advance");
    // T-139: ImplementStage no longer hardcodes next stage instruction —
    // the pipeline walker calls nextStage.enter() instead.
    expect("result" in advance).toBe(false);
  });

  it("report() updates ticket with realizedRisk", async () => {
    const state = makeState({
      state: "IMPLEMENT",
      ticket: { id: "T-001", title: "Test", claimed: true, risk: "low" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, { completedAction: "implementation_done" });
    expect(ctx.state.ticket?.realizedRisk).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PlanStage
// ---------------------------------------------------------------------------

describe("PlanStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plan-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("has correct stage ID", () => {
    expect(stage.id).toBe("PLAN");
  });

  it("enter() returns StageResult", async () => {
    const state = makeState({ state: "PLAN", ticket: { id: "T-001", title: "Test", claimed: true } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(false);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("Plan");
    }
  });

  it("report() retries when plan file missing", async () => {
    const state = makeState({ state: "PLAN", ticket: { id: "T-001", title: "Test", claimed: true } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("not found");
    }
  });

  it("report() retries when plan file is empty", async () => {
    const state = makeState({ state: "PLAN", ticket: { id: "T-001", title: "Test", claimed: true } });
    writeFileSync(join(sessionDir, "plan.md"), "", "utf-8");
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("retry");
  });

  it("report() advances with plan review instruction when plan exists", async () => {
    const state = makeState({ state: "PLAN", ticket: { id: "T-001", title: "Test", claimed: true } });
    writeFileSync(join(sessionDir, "plan.md"), "# Implementation Plan\n\n1. Step one\n2. Step two\n", "utf-8");
    // Need .story directory for project lock
    mkdirSync(join(testRoot, ".story", "tickets"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "issues"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "notes"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "handovers"), { recursive: true });
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({ version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }), "utf-8");
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }), "utf-8");
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("advance");
    if (advance.action === "advance" && "result" in advance && advance.result) {
      expect(advance.result.instruction).toContain("Plan Review");
    }
  });

  it("report() detects unchanged plan after revise (ISS-035)", async () => {
    const planContent = "# Same Plan\n\nNothing changed.";
    writeFileSync(join(sessionDir, "plan.md"), planContent, "utf-8");

    // Compute the expected hash (DJB2 — must match guide.ts simpleHash: & 0xffffffff + base 36)
    let hash = 5381;
    for (let i = 0; i < planContent.length; i++) {
      hash = ((hash << 5) + hash + planContent.charCodeAt(i)) & 0xffffffff;
    }
    const planHash = hash.toString(36);

    const state = makeState({
      state: "PLAN",
      ticket: { id: "T-001", title: "Test", claimed: true, lastPlanHash: planHash },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("not changed");
    }
  });
});

// ---------------------------------------------------------------------------
// CompleteStage
// ---------------------------------------------------------------------------

describe("CompleteStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "complete-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    // Minimal .story/ for loadProject
    mkdirSync(join(testRoot, ".story", "tickets"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "issues"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "notes"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "handovers"), { recursive: true });
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({ version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }), "utf-8");
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }), "utf-8");
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("has correct stage ID", () => {
    expect(stage.id).toBe("COMPLETE");
  });

  it("enter() returns StageAdvance (auto-advance), not StageResult", async () => {
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001" }],
      config: { maxTicketsPerSession: 3, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
  });

  it("enter() routes to HANDOVER when no more tickets", async () => {
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001" }],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result)) {
      const advance = result as Record<string, unknown>;
      expect(advance.action).toBe("goto");
      expect(advance.target).toBe("HANDOVER");
    }
  });

  it("enter() routes to HANDOVER when ticket cap reached", async () => {
    // Create a ticket so nextTickets returns something
    writeFileSync(join(testRoot, ".story", "tickets", "T-999.json"), JSON.stringify({
      id: "T-999", title: "Test", description: "", type: "task", status: "open",
      phase: null, order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [],
    }), "utf-8");
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001" }, { id: "T-002" }, { id: "T-003" }],
      config: { maxTicketsPerSession: 3, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result)) {
      if (isStageAdvance(result) && result.action === "goto") {
        expect((result as { target: string }).target).toBe("HANDOVER");
      }
    }
  });

  it("report() delegates to enter() logic", async () => {
    const state = makeState({ state: "COMPLETE", completedTickets: [{ id: "T-001" }] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "acknowledged" });
    expect(advance.action).toBe("goto");
  });

  // --- T-147: Periodic checkpoint handovers ---

  it("enter() writes checkpoint handover at handoverInterval", async () => {
    writeFileSync(join(testRoot, ".story", "tickets", "T-999.json"), JSON.stringify({
      id: "T-999", title: "Test", description: "", type: "task", status: "open",
      phase: null, order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [],
    }), "utf-8");
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001" }, { id: "T-002" }],
      config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 2 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const handoversBefore = readdirSync(join(testRoot, ".story", "handovers"));
    await stage.enter(ctx);
    const handoversAfter = readdirSync(join(testRoot, ".story", "handovers"));

    expect(handoversAfter.length).toBeGreaterThan(handoversBefore.length);
    // Verify the handover file contains checkpoint content
    const newFile = handoversAfter.find((f) => !handoversBefore.includes(f));
    expect(newFile).toBeDefined();
    if (newFile) {
      const content = readFileSync(join(testRoot, ".story", "handovers", newFile), "utf-8");
      expect(content).toContain("Checkpoint");
      expect(content).toContain("T-001");
    }
  });

  it("enter() skips checkpoint when handoverInterval is 0", async () => {
    writeFileSync(join(testRoot, ".story", "tickets", "T-999.json"), JSON.stringify({
      id: "T-999", title: "Test", description: "", type: "task", status: "open",
      phase: null, order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [],
    }), "utf-8");
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001" }, { id: "T-002" }],
      config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 0 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const handoversBefore = readdirSync(join(testRoot, ".story", "handovers"));
    await stage.enter(ctx);
    const handoversAfter = readdirSync(join(testRoot, ".story", "handovers"));

    expect(handoversAfter.length).toBe(handoversBefore.length);
  });

  it("enter() skips checkpoint when ticketsDone not divisible by interval", async () => {
    writeFileSync(join(testRoot, ".story", "tickets", "T-999.json"), JSON.stringify({
      id: "T-999", title: "Test", description: "", type: "task", status: "open",
      phase: null, order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [],
    }), "utf-8");
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001" }, { id: "T-002" }, { id: "T-003" }],
      config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 2 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const handoversBefore = readdirSync(join(testRoot, ".story", "handovers"));
    await stage.enter(ctx);
    const handoversAfter = readdirSync(join(testRoot, ".story", "handovers"));

    expect(handoversAfter.length).toBe(handoversBefore.length);
  });
});

// ---------------------------------------------------------------------------
// HandoverStage
// ---------------------------------------------------------------------------

describe("HandoverStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new HandoverStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "handover-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(testRoot, ".story", "handovers"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "tickets"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "issues"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "notes"), { recursive: true });
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({ version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }), "utf-8");
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }), "utf-8");
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("has correct stage ID", () => {
    expect(stage.id).toBe("HANDOVER");
  });

  it("enter() returns StageResult with handover instruction", async () => {
    const state = makeState({ state: "HANDOVER", completedTickets: [{ id: "T-001" }] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(false);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("handover");
    }
  });

  it("report() retries when handoverContent missing", async () => {
    const state = makeState({ state: "HANDOVER" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "handover_written" });
    expect(advance.action).toBe("retry");
  });

  it("report() ends session when handover content provided", async () => {
    const state = makeState({ state: "HANDOVER", completedTickets: [{ id: "T-001" }] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "handover_written",
      handoverContent: "# Session Handover\n\nWork done.",
    });
    expect(advance.action).toBe("advance");
    // Session should be ended
    expect(ctx.state.state).toBe("SESSION_END");
    expect(ctx.state.status).toBe("completed");
    expect(ctx.state.terminationReason).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// PickTicketStage
// ---------------------------------------------------------------------------

describe("PickTicketStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PickTicketStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "pick-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(testRoot, ".story", "tickets"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "issues"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "notes"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "handovers"), { recursive: true });
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({ version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }), "utf-8");
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }), "utf-8");
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("has correct stage ID", () => {
    expect(stage.id).toBe("PICK_TICKET");
  });

  it("report() retries when ticketId missing", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "ticket_picked" });
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("ticketId");
    }
  });

  it("report() retries when ticket not found", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-999" });
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("not found");
    }
  });

  it("report() advances with PLAN instruction when ticket is valid", async () => {
    // Create a valid ticket
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Test ticket", description: "Build something", type: "task",
      status: "open", phase: null, order: 10, createdDate: "2026-01-01",
      completedDate: null, blockedBy: [],
    }), "utf-8");
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });
    expect(advance.action).toBe("advance");
    if (advance.action === "advance" && "result" in advance && advance.result) {
      expect(advance.result.instruction).toContain("Plan for T-001");
    }
    // State should have ticket set
    expect(ctx.state.ticket?.id).toBe("T-001");
  });
});
