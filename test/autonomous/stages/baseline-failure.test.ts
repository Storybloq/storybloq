/**
 * ISS-1376: a baseline that timed out, overflowed or was killed is not a
 * comparison. The TEST stage must not wave failures through against it, and
 * WRITE_TESTS must treat it as uncaptured. A legacy baseline (no failure
 * field) behaves exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { TestStage } from "../../../src/autonomous/stages/test.js";
import { WriteTestsStage } from "../../../src/autonomous/stages/write-tests.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000001376",
    recipe: "coding", state: "TEST", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "WRITE_TESTS", "IMPLEMENT", "TEST", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: { TEST: { enabled: true, command: "npm test" }, WRITE_TESTS: { enabled: true, command: "npm test" } },
    dirtyFileHandling: "block",
    branchStrategy: "current",
    reviewEffort: {
      level: "standard",
      source: "default",
      explicitKnobs: { codeReviewMaxRounds: false, planReviewBackends: false, codeReviewBackends: false },
    },
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
  };
}

describe("ISS-1376: stages and a baseline that did not complete", () => {
  let testRoot: string;
  let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-iss1376-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("T1: TEST does not advance over a timed-out baseline with no counts; it goes back to IMPLEMENT", async () => {
    const state = makeState({ testBaseline: { exitCode: 1, passCount: -1, failCount: -1, summary: "", failure: "timeout" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await new TestStage().report(ctx, { completedAction: "tests_done", notes: "exit code: 1, 8 passed, 2 failed" });
    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
  });

  it("T2: TEST does not advance over a timed-out baseline whose partial counts look worse", async () => {
    const state = makeState({ testBaseline: { exitCode: 1, passCount: 5, failCount: 2, summary: "", failure: "timeout" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await new TestStage().report(ctx, { completedAction: "tests_done", notes: "exit code: 1, 9 passed, 1 failed" });
    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
  });

  it("T3: a legacy baseline with no counts and no failure field still advances as before", async () => {
    const state = makeState({ testBaseline: { exitCode: 1, passCount: -1, failCount: -1, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await new TestStage().report(ctx, { completedAction: "tests_done", notes: "exit code: 1, 8 passed, 2 failed" });
    expect(advance.action).toBe("advance");
  });

  it("W1: WRITE_TESTS treats a failure-set baseline as uncaptured, even with counts", async () => {
    const state = makeState({
      state: "WRITE_TESTS",
      testBaseline: { exitCode: 1, passCount: 5, failCount: 2, summary: "", failure: "maxBuffer" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await new WriteTestsStage().report(ctx, { completedAction: "tests_written", notes: "exit code: 1, 5 passed, 3 failed" });
    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("Cannot validate TDD results");
  });
});
