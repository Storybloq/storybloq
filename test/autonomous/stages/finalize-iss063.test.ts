/**
 * ISS-063: FINALIZE idempotent checkpoint + session ticket exclusion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "FINALIZE", revision: 1, status: "active",
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
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("ISS-063: FINALIZE idempotent checkpoint", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new FinalizeStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-iss063-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("repeated files_staged at 'staged' checkpoint returns pre-commit instruction", async () => {
    const state = makeState({ finalizeCheckpoint: "staged" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "files_staged" });
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("pre-commit");
  });

  it("repeated files_staged at 'staged_override' returns pre-commit instruction", async () => {
    const state = makeState({ finalizeCheckpoint: "staged_override" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "files_staged" });
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("pre-commit");
  });
});
