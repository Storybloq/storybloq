import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

/**
 * PlanReviewStage.enter(), which until now no test reached.
 *
 * It was unreachable in practice as well as untested: PlanStage.report()
 * returned a precomputed PLAN_REVIEW instruction, and processAdvance prefers
 * `advance.result` over the next stage's enter(). Every PLAN -> PLAN_REVIEW
 * transition therefore used the copy in plan.ts, which had drifted from this
 * method in three ways. These tests pin the behavior the single source
 * restores.
 */

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    previousState: "PLAN",
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

const recipe = {
  id: "coding",
  pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
  postComplete: [],
  stages: {},
  dirtyFileHandling: "block",
  defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
} as unknown as ResolvedRecipe;

describe("PlanReviewStage.enter", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-plan-review-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  const ctxWith = (state: Partial<FullSessionState> = {}) =>
    new StageContext(testRoot, sessionDir, makeState(state), recipe);

  it("serves the full lens protocol when the reviewer is lenses", async () => {
    // The copy in plan.ts had no lenses branch, so a lenses-configured project
    // was told to "launch a code review agent" on round one instead.
    const ctx = ctxWith({
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"], handoverInterval: 3 },
    } as Partial<FullSessionState>);

    const result = await stage.enter(ctx);
    expect(result.instruction).toContain("Multi-Lens Plan Review");
    expect(result.instruction).toContain("storybloq_review_lenses_prepare");
    expect(result.instruction).toContain("storybloq_review_lenses_judge");
    expect(result.instruction).not.toContain("Launch a code review agent");
  });

  it("honors codex unavailability, which the plan.ts copy bypassed", async () => {
    // plan.ts called nextReviewer WITHOUT the unavailability arguments, so
    // ISS-098/ISS-110 could not take effect on the first round.
    const ctx = ctxWith({
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
      codexUnavailable: true,
      codexUnavailableSince: new Date().toISOString(),
    } as Partial<FullSessionState>);

    const result = await stage.enter(ctx);
    expect(result.instruction).toContain("**agent**");
    expect(result.instruction).not.toContain("Run a plan review using **codex**");
  });

  it("stamps currentReviewStartedAt, which the plan.ts copy never wrote", async () => {
    const ctx = ctxWith();
    expect(ctx.state.currentReviewStartedAt).toBeFalsy();
    await stage.enter(ctx);
    expect(ctx.state.currentReviewStartedAt).toBeTruthy();
  });

  it("keeps the ordinary bridge instruction for a codex reviewer", async () => {
    const ctx = ctxWith();
    const result = await stage.enter(ctx);
    expect(result.instruction).toContain("Plan Review -- Round 1");
    expect(result.instruction).toContain("plan_review_round");
  });
});
