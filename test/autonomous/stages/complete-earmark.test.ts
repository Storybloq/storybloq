/**
 * T-475 section 5: COMPLETE's own "is there more work" issue check is a
 * Layer-2 (advisory) listing site -- an open issue earmarked to anyone must
 * not count as work available, or the session would route to PICK_TICKET
 * only to find nothing pickable there either.
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

const ASSIGNED_EARMARK = {
  stage: "assigned",
  reservedBy: { client: "claude", id: "pen-task-1" },
  arrangementId: "a-0123456789abcdef",
  since: "2026-08-28T00:00:00.000Z",
  holderRole: "worker",
  holderSession: "11111111-1111-4111-8111-111111111111",
};

describe("CompleteStage: earmark-visible issue check (T-475 section 5)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "complete-earmark-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    for (const sub of ["tickets", "issues", "notes", "handovers", "lessons"]) {
      mkdirSync(join(testRoot, ".story", sub), { recursive: true });
    }
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({
      version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }));
    // Deliberately no tickets at all -- nextTickets returns "empty_project",
    // so the fallback openIssues check is what actually decides the target.
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  function writeIssue(id: string, earmark: unknown = null): void {
    writeFileSync(join(testRoot, ".story", "issues", `${id}.json`), JSON.stringify({
      id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
      impact: "test", resolution: null, location: [], discoveredDate: "2026-01-01",
      resolvedDate: null, relatedTickets: [], earmark,
    }));
  }

  it("routes to PICK_TICKET when an unearmarked open issue exists", async () => {
    writeIssue("ISS-001", null);
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && "target" in result) {
      expect(result.target).toBe("PICK_TICKET");
    }
  });

  it("routes to HANDOVER instead of PICK_TICKET when the only open issue is earmarked", async () => {
    writeIssue("ISS-001", ASSIGNED_EARMARK);
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && "target" in result) {
      expect(result.target).toBe("HANDOVER");
    }
  });
});
