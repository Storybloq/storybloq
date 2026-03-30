import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, isStageAdvance, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { LessonCaptureStage } from "../../../src/autonomous/stages/lesson-capture.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "LESSON_CAPTURE", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [{ id: "T-001" }],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 10,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 5 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding", pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: ["LESSON_CAPTURE", "ISSUE_SWEEP"], stages: { LESSON_CAPTURE: { enabled: true } },
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("LessonCaptureStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new LessonCaptureStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "lesson-capture-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("skip() returns true when not enabled", () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), { ...makeRecipe(), stages: {} });
    expect(stage.skip!(ctx)).toBe(true);
  });

  it("skip() returns false when enabled", () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    expect(stage.skip!(ctx)).toBe(false);
  });

  it("enter() advances when zero findings", async () => {
    const state = makeState({ reviews: { plan: [], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result)) expect(result.action).toBe("advance");
  });

  it("enter() returns instruction when findings exist", async () => {
    const state = makeState({
      reviews: {
        plan: [{ round: 1, reviewer: "codex", verdict: "revise", findingCount: 3, criticalCount: 1, majorCount: 1, suggestionCount: 1, timestamp: new Date().toISOString() }],
        code: [{ round: 1, reviewer: "agent", verdict: "approve", findingCount: 2, criticalCount: 0, majorCount: 1, suggestionCount: 1, timestamp: new Date().toISOString() }],
      },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(false);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("lesson_list");
      expect(result.instruction).toContain("lesson_create");
      expect(result.instruction).toContain("1 critical");
      expect(result.instruction).toContain("3 total findings"); // plan: 3
      expect(result.instruction).toContain("2 total findings"); // code: 2
    }
  });

  it("enter() includes ticket count in instruction", async () => {
    const state = makeState({
      completedTickets: [{ id: "T-001" }, { id: "T-002" }, { id: "T-003" }],
      reviews: { plan: [{ round: 1, reviewer: "codex", verdict: "approve", findingCount: 1, criticalCount: 0, majorCount: 0, suggestionCount: 1, timestamp: new Date().toISOString() }], code: [] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("3 ticket");
    }
  });

  it("report() advances", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "lessons_captured" });
    expect(advance.action).toBe("advance");
  });
});
