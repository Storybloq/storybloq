/**
 * ISS-050: CompleteStage must not crash on PICK_TICKET path.
 * Regression test — advice variable was removed in T-146 but one reference remained.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, isStageAdvance } from "../../../src/autonomous/stages/types.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../../src/autonomous/stages/types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "COMPLETE", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [{ id: "T-001" }],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 5 },
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

describe("CompleteStage — ISS-050 regression", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "complete-iss050-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(testRoot, ".story", "tickets"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "issues"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "notes"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "handovers"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "lessons"), { recursive: true });
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({ version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }));
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }));
    // Add an open ticket so nextTickets returns something
    writeFileSync(join(testRoot, ".story", "tickets", "T-999.json"), JSON.stringify({
      id: "T-999", title: "Next ticket", description: "", type: "task", status: "open",
      phase: null, order: 10, createdDate: "2026-01-01", completedDate: null, blockedBy: [],
      parentTicket: null,
    }));
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("enter() does not crash with undefined advice (ISS-050)", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    // This call would throw "advice is not defined" before the ISS-050 fix
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
  });

  it("all result paths have contextAdvice 'ok' (not undefined)", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    if (isStageAdvance(result) && "result" in result && result.result) {
      expect(result.result.contextAdvice).toBe("ok");
      expect(result.result.contextAdvice).not.toBeUndefined();
    }
  });
});
