/**
 * ISS-069: Tests for no-op ticket flow (ticket needs no code changes).
 *
 * When a plan says "no changes needed" (e.g., bug already fixed), the agent
 * should be able to skip WRITE_TESTS, IMPLEMENT, and route to COMPLETE
 * without requiring a commit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "WRITE_TESTS", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: {
      branch: "main", mergeBase: "abc123", expectedHead: "abc123",
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    testBaseline: { failCount: 2, exitCode: 1, timestamp: now },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [],
    currentIssue: null,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "WRITE_TESTS", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: { WRITE_TESTS: { enabled: true, command: "npm test", onExhaustion: "plan" } },
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-iss069-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// WRITE_TESTS: no_tests_needed escape hatch
// ---------------------------------------------------------------------------

describe("WRITE_TESTS: no_tests_needed", () => {
  it("report with no_tests_needed gotos COMPLETE", async () => {
    const { WriteTestsStage } = await import("../../../src/autonomous/stages/write-tests.js");
    const stage = new WriteTestsStage();
    const state = makeState({ state: "WRITE_TESTS" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "no_tests_needed" });
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("COMPLETE");
  });

  it("enter instruction mentions no_tests_needed option", async () => {
    const { WriteTestsStage } = await import("../../../src/autonomous/stages/write-tests.js");
    const stage = new WriteTestsStage();
    const state = makeState({ state: "WRITE_TESTS" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    if ("action" in result) throw new Error("Expected StageResult, got StageAdvance");

    expect(result.instruction).toContain("no_tests_needed");
    expect(result.instruction).toContain("no code changes");
  });
});

// ---------------------------------------------------------------------------
// IMPLEMENT: no_implementation_needed escape hatch
// ---------------------------------------------------------------------------

describe("IMPLEMENT: no_implementation_needed", () => {
  it("report with no_implementation_needed gotos COMPLETE", async () => {
    const { ImplementStage } = await import("../../../src/autonomous/stages/implement.js");
    const stage = new ImplementStage();
    const state = makeState({ state: "IMPLEMENT" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "no_implementation_needed" });
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// State machine: WRITE_TESTS and IMPLEMENT can goto COMPLETE
// ---------------------------------------------------------------------------

describe("state machine: no-op transitions", () => {
  it("WRITE_TESTS can transition to COMPLETE", async () => {
    const { isValidTransition } = await import("../../../src/autonomous/state-machine.js");
    expect(isValidTransition("WRITE_TESTS", "COMPLETE")).toBe(true);
  });

  it("IMPLEMENT can transition to COMPLETE", async () => {
    const { isValidTransition } = await import("../../../src/autonomous/state-machine.js");
    expect(isValidTransition("IMPLEMENT", "COMPLETE")).toBe(true);
  });
});
