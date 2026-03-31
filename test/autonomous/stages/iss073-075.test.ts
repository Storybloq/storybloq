/**
 * ISS-073: Review contradiction guard should respect finding disposition.
 * ISS-075: PICK_TICKET should exit when all work is done.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState, Finding } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
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

function makeFinding(severity: Finding["severity"], disposition: Finding["disposition"]): Finding {
  return { id: "F-1", severity, category: "test", description: "Test finding", disposition };
}

function setupProject(root: string): void {
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
    title: "test", date: "2026-03-31", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-iss073-075-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
  setupProject(testRoot);
});

afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// ISS-073: Plan review -- disposition-aware contradiction guard
// ---------------------------------------------------------------------------

describe("ISS-073: plan-review contradiction guard respects disposition", () => {
  it("approve + critical addressed -> advances (not blocked)", async () => {
    const { PlanReviewStage } = await import("../../../src/autonomous/stages/plan-review.js");
    const stage = new PlanReviewStage();
    const state = makeState({ state: "PLAN_REVIEW", reviews: { plan: [], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "approve",
      findings: [makeFinding("critical", "addressed")],
    });
    expect(advance.action).not.toBe("retry");
  });

  it("approve + major deferred -> advances (not blocked)", async () => {
    const { PlanReviewStage } = await import("../../../src/autonomous/stages/plan-review.js");
    const stage = new PlanReviewStage();
    const state = makeState({ state: "PLAN_REVIEW", reviews: { plan: [], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "approve",
      findings: [makeFinding("major", "deferred")],
    });
    expect(advance.action).not.toBe("retry");
  });

  it("approve + critical open -> blocked (retry)", async () => {
    const { PlanReviewStage } = await import("../../../src/autonomous/stages/plan-review.js");
    const stage = new PlanReviewStage();
    const state = makeState({ state: "PLAN_REVIEW", reviews: { plan: [], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "approve",
      findings: [makeFinding("critical", "open")],
    });
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("Contradictory");
  });

  it("approve + major contested -> blocked (retry)", async () => {
    const { PlanReviewStage } = await import("../../../src/autonomous/stages/plan-review.js");
    const stage = new PlanReviewStage();
    const state = makeState({ state: "PLAN_REVIEW", reviews: { plan: [], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "approve",
      findings: [makeFinding("major", "contested")],
    });
    expect(advance.action).toBe("retry");
  });
});

// ---------------------------------------------------------------------------
// ISS-073: Code review -- same disposition-aware guard
// ---------------------------------------------------------------------------

describe("ISS-073: code-review contradiction guard respects disposition", () => {
  it("approve + critical addressed -> advances (not blocked)", async () => {
    const { CodeReviewStage } = await import("../../../src/autonomous/stages/code-review.js");
    const stage = new CodeReviewStage();
    const state = makeState({ state: "CODE_REVIEW", reviews: { plan: [{ round: 1, reviewer: "agent", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString() }], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "approve",
      findings: [makeFinding("critical", "addressed")],
    });
    expect(advance.action).not.toBe("retry");
  });

  it("approve + critical open -> blocked (retry)", async () => {
    const { CodeReviewStage } = await import("../../../src/autonomous/stages/code-review.js");
    const stage = new CodeReviewStage();
    const state = makeState({ state: "CODE_REVIEW", reviews: { plan: [{ round: 1, reviewer: "agent", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString() }], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "approve",
      findings: [makeFinding("critical", "open")],
    });
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("Contradictory");
  });
});

// ---------------------------------------------------------------------------
// ISS-075: PICK_TICKET exits when all work is done
// ---------------------------------------------------------------------------

describe("ISS-075: PICK_TICKET exit when no work", () => {
  it("enter with no tickets and no high issues -> goto COMPLETE", async () => {
    // All tickets complete, no high issues
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Done", type: "task", status: "complete",
      phase: "p1", order: 10, description: "", createdDate: "2026-03-31",
      completedDate: "2026-03-31", blockedBy: [], parentTicket: null,
    }));

    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    expect("action" in result).toBe(true);
    expect((result as { action: string; target: string }).action).toBe("goto");
    expect((result as { target: string }).target).toBe("COMPLETE");
  });

  it("enter with no tickets but high issues -> returns instruction", async () => {
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Done", type: "task", status: "complete",
      phase: "p1", order: 10, description: "", createdDate: "2026-03-31",
      completedDate: "2026-03-31", blockedBy: [], parentTicket: null,
    }));
    writeFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "Critical bug", status: "open", severity: "critical",
      components: [], impact: "Bad", resolution: null, resolvedDate: null,
      discoveredDate: "2026-03-31", relatedTickets: [], location: [],
    }));

    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    // Should return instruction (not StageAdvance) because there are issues to work on
    expect("instruction" in result).toBe(true);
    expect((result as { instruction: string }).instruction).toContain("ISS-001");
  });

  it("PICK_TICKET can transition to COMPLETE", async () => {
    const { isValidTransition } = await import("../../../src/autonomous/state-machine.js");
    expect(isValidTransition("PICK_TICKET", "COMPLETE")).toBe(true);
  });
});
