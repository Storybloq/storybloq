/**
 * ISS-053: TEST stage parse-failure retry must have a depth limit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { TestStage } from "../../../src/autonomous/stages/test.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
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
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "TEST", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: { TEST: { enabled: true, command: "npm test" } }, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("TestStage — ISS-053 parse-failure retry limit", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new TestStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-iss053-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("unparseable exit code retries with incremented count", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "tests_done",
      notes: "tests ran but I don't know the result",
    });
    expect(advance.action).toBe("retry");
    expect(ctx.state.testRetryCount).toBe(1);
  });

  it("3 unparseable attempts → advance (exhaustion)", async () => {
    const state = makeState({ testRetryCount: 2 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "tests_done",
      notes: "still can't parse",
    });
    expect(advance.action).toBe("advance");
  });

  it("normal test failure still works (exitCode parsed, non-zero)", async () => {
    const state = makeState({ testBaseline: { exitCode: 0, passCount: 10, failCount: 0, summary: "" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "tests_done",
      notes: "exit code: 1, 8 passed, 2 failed",
    });
    // Should retry (back to IMPLEMENT) since tests failed
    expect(advance.action === "back" || advance.action === "retry").toBe(true);
  });
});
