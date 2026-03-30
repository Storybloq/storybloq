/**
 * T-139: Tests for WriteTestsStage (TDD — write failing tests before implementation).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StageContext, isStageAdvance, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { WriteTestsStage } from "../../../src/autonomous/stages/write-tests.js";
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
    state: "WRITE_TESTS",
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
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "10 passed" },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "WRITE_TESTS", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: { WRITE_TESTS: { enabled: true, command: "npm test", onExhaustion: "plan" } },
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
// Tests
// ---------------------------------------------------------------------------

describe("WriteTestsStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new WriteTestsStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "write-tests-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  // --- skip ---

  it("skip() returns true when not enabled", () => {
    const state = makeState();
    const recipe = makeRecipe({ stages: {} });
    const ctx = new StageContext(testRoot, sessionDir, state, recipe);
    expect(stage.skip!(ctx)).toBe(true);
  });

  it("skip() returns false when enabled", () => {
    const state = makeState();
    const recipe = makeRecipe();
    const ctx = new StageContext(testRoot, sessionDir, state, recipe);
    expect(stage.skip!(ctx)).toBe(false);
  });

  // --- enter ---

  it("enter() returns StageResult with TDD instruction", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(false);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("Write Failing Tests");
      expect(result.instruction).toContain("MUST fail");
      expect(result.instruction).toContain("plan");
    }
  });

  it("enter() shows retry count on retry", async () => {
    const state = makeState({ writeTestsRetryCount: 2 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("Retry 2");
    }
  });

  // --- report: TDD success (new failures) ---

  it("report() advances when fail count increases vs baseline", async () => {
    const state = makeState({ testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 1, 10 passed, 3 failed",
    });
    expect(advance.action).toBe("advance");
  });

  it("report() resets writeTestsRetryCount on success", async () => {
    const state = makeState({
      writeTestsRetryCount: 2,
      testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 1, 8 passed, 5 failed",
    });
    expect(ctx.state.writeTestsRetryCount).toBe(0);
  });

  // --- report: retry (tests pass or same failures) ---

  it("report() retries when tests pass (exit code 0)", async () => {
    const state = makeState({ testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 0, 12 passed, 0 failed",
    });
    expect(advance.action).toBe("retry");
  });

  it("report() retries when fail count unchanged vs baseline", async () => {
    const state = makeState({ testBaseline: { exitCode: 1, passCount: 8, failCount: 2, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 1, 8 passed, 2 failed",
    });
    expect(advance.action).toBe("retry");
  });

  it("report() increments writeTestsRetryCount on retry", async () => {
    const state = makeState({ testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 0, 10 passed, 0 failed",
    });
    expect(ctx.state.writeTestsRetryCount).toBe(1);
  });

  // --- report: baseline guards ---

  it("report() retries when baseline is null", async () => {
    const state = makeState({ testBaseline: null });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 1, 8 passed, 3 failed",
    });
    expect(advance.action).toBe("retry");
  });

  it("report() retries when baseline failCount is -1", async () => {
    const state = makeState({ testBaseline: { exitCode: 0, passCount: 10, failCount: -1, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 1, 8 passed, 3 failed",
    });
    expect(advance.action).toBe("retry");
  });

  it("report() retries when current fail count cannot be parsed", async () => {
    const state = makeState({ testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "tests ran but I don't know the counts",
    });
    expect(advance.action).toBe("retry");
  });

  // --- report: exhaustion ---

  it("report() returns back-to-PLAN after 3 retries (default onExhaustion)", async () => {
    const state = makeState({
      writeTestsRetryCount: 2,
      testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 0, 10 passed, 0 failed",
    });
    expect(advance.action).toBe("back");
    if (advance.action === "back") {
      expect(advance.target).toBe("PLAN");
      expect(advance.reason).toContain("TDD exhausted");
    }
  });

  it("report() advances on exhaustion when onExhaustion is 'advance' (no result)", async () => {
    const state = makeState({
      writeTestsRetryCount: 2,
      testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" },
    });
    const recipe = makeRecipe({
      stages: { WRITE_TESTS: { enabled: true, command: "npm test", onExhaustion: "advance" } },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, recipe);
    const advance = await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 0, 10 passed, 0 failed",
    });
    expect(advance.action).toBe("advance");
    // Must NOT include result — let ImplementStage.enter() run
    expect("result" in advance).toBe(false);
  });

  it("report() resets writeTestsRetryCount on exhaustion", async () => {
    const state = makeState({
      writeTestsRetryCount: 2,
      testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, {
      completedAction: "write_tests_done",
      notes: "exit code: 0, 10 passed, 0 failed",
    });
    // Counter reset so re-entry starts fresh
    expect(ctx.state.writeTestsRetryCount).toBe(0);
  });
});
