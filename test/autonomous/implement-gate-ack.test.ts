/**
 * T-474: `ImplementStage.enter()` renders the pen's ratify-with-deltas text
 * from a plan-ack gate that just cleared, once, and renders nothing extra
 * when no such deltas exist.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { ImplementStage } from "../../src/autonomous/stages/implement.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000474",
    recipe: "coding", state: "IMPLEMENT", revision: 1, status: "active",
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

describe("ImplementStage.enter() (T-474 deltas rendering)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new ImplementStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "implement-gate-ack-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("renders the deltas section when approvedPlanAckDeltas is present", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({ approvedPlanAckDeltas: "Follow up with a caching layer in a later ticket." }), makeRecipe());
    const result = await stage.enter(ctx);
    expect(result.instruction).toContain("## Pen-approved plan-ack deltas (binding)");
    expect(result.instruction).toContain("Follow up with a caching layer in a later ticket.");
  });

  it("renders nothing extra when approvedPlanAckDeltas is absent", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({ approvedPlanAckDeltas: null }), makeRecipe());
    const result = await stage.enter(ctx);
    expect(result.instruction).not.toContain("Pen-approved plan-ack deltas");
  });

  it("renders nothing extra when approvedPlanAckDeltas was never set (undefined)", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await stage.enter(ctx);
    expect(result.instruction).not.toContain("Pen-approved plan-ack deltas");
  });
});
