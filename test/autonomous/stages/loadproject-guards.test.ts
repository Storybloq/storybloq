/**
 * ISS-103: Tests for ISS-089 loadProject() guards and ISS-098 codexUnavailable filtering.
 *
 * Verifies that stages recover gracefully when loadProject() throws,
 * and that nextReviewer() respects the codexUnavailable flag.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

// ---------------------------------------------------------------------------
// StageContext subclass that makes loadProject() throw
// ---------------------------------------------------------------------------

class ThrowingCtx extends StageContext {
  override async loadProject(): Promise<never> {
    throw new Error("simulated loadProject failure");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
    ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
    targetWork: [],
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

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  mkdirSync(join(storyDir, "notes"), { recursive: true });
  mkdirSync(join(storyDir, "lessons"), { recursive: true });
  mkdirSync(join(storyDir, "handovers"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-03-31", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-iss103-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
  setupProject(testRoot);
});

afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// ISS-089: PickTicketStage.enter() loadProject guard
// ---------------------------------------------------------------------------

describe("ISS-089: PickTicketStage.enter() with throwing loadProject", () => {
  it("returns retry with error message instead of crashing", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const ctx = new ThrowingCtx(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("action", "retry");
    expect((result as { instruction: string }).instruction).toContain("Failed to load project state");
    expect((result as { instruction: string }).instruction).toContain("simulated loadProject failure");
  });
});

// ---------------------------------------------------------------------------
// ISS-089: PickTicketStage.report() loadProject guard (ticket_picked)
// ---------------------------------------------------------------------------

describe("ISS-089: PickTicketStage.report() with throwing loadProject", () => {
  it("returns retry when validating a ticket pick", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const ctx = new ThrowingCtx(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });
    expect(result).toHaveProperty("action", "retry");
    expect((result as { instruction: string }).instruction).toContain("Failed to load project state");
  });

  it("returns retry when validating an issue pick", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const ctx = new ThrowingCtx(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(result).toHaveProperty("action", "retry");
    expect((result as { instruction: string }).instruction).toContain("Failed to load project state");
  });
});

// ---------------------------------------------------------------------------
// ISS-089: CompleteStage.enter() loadProject guard
// ---------------------------------------------------------------------------

describe("ISS-089: CompleteStage.enter() with throwing loadProject", () => {
  it("routes to HANDOVER with error note instead of crashing", async () => {
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const ctx = new ThrowingCtx(testRoot, sessionDir, makeState({ state: "COMPLETE" }), makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
    const r = result as { result?: { instruction: string } };
    expect(r.result?.instruction).toContain("Failed to load project state");
  });
});

// ---------------------------------------------------------------------------
// ISS-089: IssueFixStage.enter() loadProject guard
// ---------------------------------------------------------------------------

describe("ISS-089: IssueFixStage.enter() with throwing loadProject", () => {
  it("falls back to minimal info from session state", async () => {
    const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
    const stage = new IssueFixStage();
    const state = makeState({
      state: "ISSUE_FIX",
      currentIssue: { id: "ISS-001", title: "Test issue", severity: "high" },
    });
    const ctx = new ThrowingCtx(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    // Should NOT crash, should return instruction with fallback info
    expect(result).not.toHaveProperty("action"); // StageResult (no action = instruction)
    const r = result as { instruction: string };
    expect(r.instruction).toContain("ISS-001");
    expect(r.instruction).toContain("could not load full issue details");
  });
});

// ---------------------------------------------------------------------------
// ISS-089: IssueFixStage.report() loadProject guard
// ---------------------------------------------------------------------------

describe("ISS-089: IssueFixStage.report() with throwing loadProject", () => {
  it("returns retry with error message", async () => {
    const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
    const stage = new IssueFixStage();
    const state = makeState({
      state: "ISSUE_FIX",
      currentIssue: { id: "ISS-001", title: "Test issue", severity: "high" },
    });
    const ctx = new ThrowingCtx(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_fixed" });
    expect(result).toHaveProperty("action", "retry");
    expect((result as { instruction: string }).instruction).toContain("Failed to load project state");
  });
});

// ---------------------------------------------------------------------------
// ISS-089: IssueSweepStage.enter() loadProject guard
// ---------------------------------------------------------------------------

describe("ISS-089: IssueSweepStage.enter() with throwing loadProject", () => {
  it("skips sweep and goes to HANDOVER", async () => {
    const { IssueSweepStage } = await import("../../../src/autonomous/stages/issue-sweep.js");
    const stage = new IssueSweepStage();
    const ctx = new ThrowingCtx(testRoot, sessionDir, makeState({ state: "ISSUE_SWEEP" }), makeRecipe());
    const result = await stage.enter(ctx);
    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "HANDOVER");
  });
});

// ---------------------------------------------------------------------------
// ISS-089: IssueSweepStage.report() loadProject guard (verify current issue)
// ---------------------------------------------------------------------------

describe("ISS-089: IssueSweepStage.report() with throwing loadProject", () => {
  it("returns retry when verifying current issue resolution", async () => {
    const { IssueSweepStage } = await import("../../../src/autonomous/stages/issue-sweep.js");
    const stage = new IssueSweepStage();
    const state = makeState({
      state: "ISSUE_SWEEP",
      issueSweepState: { remaining: ["ISS-001", "ISS-002"], current: "ISS-001", resolved: [] },
    });
    const ctx = new ThrowingCtx(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_fixed" });
    expect(result).toHaveProperty("action", "retry");
    expect((result as { instruction: string }).instruction).toContain("Failed to load project state");
  });
});

// ---------------------------------------------------------------------------
// ISS-098: nextReviewer with codexUnavailable=true
// ---------------------------------------------------------------------------

describe("ISS-098: nextReviewer with codexUnavailable", () => {
  it("filters codex from backends when codexUnavailable is true", async () => {
    const { nextReviewer } = await import("../../../src/autonomous/review-depth.js");

    // With codex available, first round selects codex (first backend)
    expect(nextReviewer([], ["codex", "agent"])).toBe("codex");

    // With codex unavailable, first round selects agent (codex filtered)
    expect(nextReviewer([], ["codex", "agent"], true)).toBe("agent");
  });

  it("falls back to agent when all backends are codex and codex is unavailable", async () => {
    const { nextReviewer } = await import("../../../src/autonomous/review-depth.js");
    // Single codex backend, unavailable -> returns default "agent"
    expect(nextReviewer([], ["codex"], true)).toBe("agent");
  });

  it("alternates among remaining backends when codex is filtered", async () => {
    const { nextReviewer } = await import("../../../src/autonomous/review-depth.js");
    // backends: codex, agent, lenses. With codex unavailable -> effective: agent, lenses
    const round1 = { round: 1, reviewer: "agent", verdict: "revise", findingCount: 1, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString() };
    expect(nextReviewer([round1], ["codex", "agent", "lenses"], true)).toBe("lenses");
  });

  it("does not filter codex when codexUnavailable is false or undefined", async () => {
    const { nextReviewer } = await import("../../../src/autonomous/review-depth.js");
    expect(nextReviewer([], ["codex", "agent"], false)).toBe("codex");
    expect(nextReviewer([], ["codex", "agent"], undefined)).toBe("codex");
  });
});

// ---------------------------------------------------------------------------
// ISS-110: codexUnavailableSince timestamp-based TTL
// ---------------------------------------------------------------------------

describe("ISS-110: codexUnavailableSince TTL", () => {
  it("filters codex when timestamp is recent", async () => {
    const { nextReviewer, isCodexUnavailable } = await import("../../../src/autonomous/review-depth.js");
    const recent = new Date().toISOString();
    expect(isCodexUnavailable(recent)).toBe(true);
    expect(nextReviewer([], ["codex", "agent"], undefined, recent)).toBe("agent");
  });

  it("does not filter codex when timestamp is expired (>10 min)", async () => {
    const { nextReviewer, isCodexUnavailable } = await import("../../../src/autonomous/review-depth.js");
    const expired = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    expect(isCodexUnavailable(expired)).toBe(false);
    expect(nextReviewer([], ["codex", "agent"], undefined, expired)).toBe("codex");
  });

  it("returns false for undefined or invalid timestamps", async () => {
    const { isCodexUnavailable } = await import("../../../src/autonomous/review-depth.js");
    expect(isCodexUnavailable(undefined)).toBe(false);
    expect(isCodexUnavailable("not-a-date")).toBe(false);
  });

  it("prefers timestamp over boolean when both present", async () => {
    const { nextReviewer } = await import("../../../src/autonomous/review-depth.js");
    // Boolean says unavailable, but timestamp is expired -> codex is available
    const expired = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    expect(nextReviewer([], ["codex", "agent"], true, expired)).toBe("codex");
  });
});
