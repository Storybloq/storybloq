/**
 * ISS-048: Plan review revise should stay in PLAN_REVIEW, not round-trip through PLAN.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

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
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("PlanReviewStage — ISS-048 revise routing", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "planrev-iss048-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("revise verdict stays in PLAN_REVIEW (retry)", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [{ id: "f1", severity: "major", category: "logic", description: "Missing error handling", disposition: "open" }],
    });
    expect(advance.action).toBe("retry");
  });

  it("revise retry includes findings summary", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "request_changes",
      findings: [{ id: "f1", severity: "critical", category: "correctness", description: "SQL injection risk", disposition: "open" }],
    });
    expect(advance.action).toBe("retry");
    if (advance.action === "retry") {
      expect(advance.instruction).toContain("SQL injection");
    }
  });

  it("reject verdict goes back to PLAN", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "reject",
      findings: [],
    });
    expect(advance.action).toBe("back");
    if (advance.action === "back") {
      expect(advance.target).toBe("PLAN");
    }
  });

  it("revise preserves review history", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [],
    });
    expect(ctx.state.reviews.plan.length).toBe(1);
  });

  it("reject clears review history", async () => {
    const state = makeState({ reviews: { plan: [{ round: 1, reviewer: "codex", verdict: "revise", findingCount: 2, criticalCount: 0, majorCount: 1, suggestionCount: 1, timestamp: new Date().toISOString() }], code: [] } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "reject",
      findings: [],
    });
    expect(ctx.state.reviews.plan.length).toBe(0);
  });
});
