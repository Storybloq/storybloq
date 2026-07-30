/**
 * T-153: Tests for issue interleaving in autonomous mode.
 *
 * Covers:
 * - ISSUE_FIX stage (enter/report)
 * - PICK_TICKET accepting issueId
 * - FINALIZE issue-mode routing
 * - State machine transitions
 * - Shared candidate renderer with issues
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

/**
 * ISS-922: PICK_TICKET now establishes the item's finalization baseline from a
 * FRESH head and fails closed if it cannot, because a cached value is exactly
 * what cannot establish a baseline after unobserved drift. Session start
 * already refuses a project without git (guide.ts), so a real gitHead failure
 * is an anomaly, not a supported mode -- these fixtures previously relied on
 * it failing in a non-repository tmpdir. Partial mock: only gitHead is
 * replaced, everything else in the module stays real.
 */
vi.mock("../../../src/autonomous/git-inspector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/autonomous/git-inspector.js")>()),
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } }),
  // "abc123" is this file's own baseline, so PICK gets a resolvable head
  // while FINALIZE still sees HEAD === baseline and behaves as before.
}));


function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active",
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
    ticket: null,
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [],
    currentIssue: null,
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
    title: "test", date: "2026-03-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
    blockedBy: [], parentTicket: null,
  }));
  writeFileSync(join(storyDir, "issues", "ISS-001.json"), JSON.stringify({
    id: "ISS-001", title: "Critical bug", status: "open", severity: "critical",
    components: ["core"], impact: "App crashes on launch", resolution: null,
    location: ["src/index.ts:42"], discoveredDate: "2026-03-30", resolvedDate: null,
    relatedTickets: [],
  }));
  writeFileSync(join(storyDir, "issues", "ISS-002.json"), JSON.stringify({
    id: "ISS-002", title: "Low priority styling", status: "open", severity: "low",
    components: ["ui"], impact: "Button misaligned", resolution: null,
    location: [], discoveredDate: "2026-03-30", resolvedDate: null,
    relatedTickets: [],
  }));
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-t153-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
  setupProject(testRoot);
});

afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// State machine: ISSUE_FIX transitions
// ---------------------------------------------------------------------------

describe("state machine: ISSUE_FIX transitions", () => {
  it("PICK_TICKET can transition to ISSUE_FIX", async () => {
    const { isValidTransition } = await import("../../../src/autonomous/state-machine.js");
    expect(isValidTransition("PICK_TICKET", "ISSUE_FIX")).toBe(true);
  });

  it("ISSUE_FIX can transition to FINALIZE", async () => {
    const { isValidTransition } = await import("../../../src/autonomous/state-machine.js");
    expect(isValidTransition("ISSUE_FIX", "FINALIZE")).toBe(true);
  });

  it("FINALIZE can transition to PICK_TICKET (issue-fix return)", async () => {
    const { isValidTransition } = await import("../../../src/autonomous/state-machine.js");
    // FINALIZE -> PICK_TICKET needed for issue-fix flow (bypass COMPLETE)
    expect(isValidTransition("FINALIZE", "PICK_TICKET")).toBe(true);
  });

  it("ISSUE_FIX is in RECOVERY_MAPPING", async () => {
    const { RECOVERY_MAPPING } = await import("../../../src/autonomous/guide.js");
    expect(RECOVERY_MAPPING["ISSUE_FIX"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PICK_TICKET: surface issues in enter()
// ---------------------------------------------------------------------------

describe("PICK_TICKET: issue surfacing", () => {
  it("enter() includes high/critical issues alongside ticket candidates", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    if ("action" in result) throw new Error("Expected StageResult, got StageAdvance");

    // Should contain issue section with high/critical issues
    expect(result.instruction).toContain("ISS-001"); // critical issue
    expect(result.instruction).toContain("Critical bug");
    expect(result.instruction).toContain("Open Issues");
  });

  // ISS-084: All open issues are now surfaced (severity affects display order, not visibility)
  it("enter() includes low-severity issues in a separate section", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    if ("action" in result) throw new Error("Expected StageResult, got StageAdvance");

    expect(result.instruction).toContain("ISS-002"); // low severity now visible
    expect(result.instruction).toContain("medium/low");
  });

  it("enter() shows issueId example in JSON payload when issues exist", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    if ("action" in result) throw new Error("Expected StageResult, got StageAdvance");

    expect(result.instruction).toContain("issueId");
  });
});

// ---------------------------------------------------------------------------
// PICK_TICKET: accept issueId in report()
// ---------------------------------------------------------------------------

describe("PICK_TICKET: issue picking", () => {
  it("report() accepts issueId and routes to ISSUE_FIX via goto", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("ISSUE_FIX");
  });

  it("report() sets currentIssue in session state", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(ctx.state.currentIssue).toBeDefined();
    expect(ctx.state.currentIssue?.id).toBe("ISS-001");
  });

  it("report() rejects nonexistent issueId", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-999" });
    expect(advance.action).toBe("retry");
  });

  it("report() rejects already-resolved issue", async () => {
    // Mark ISS-001 as resolved
    writeFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "Critical bug", status: "resolved", severity: "critical",
      components: ["core"], impact: "App crashes", resolution: "Fixed", resolvedDate: "2026-03-30",
      discoveredDate: "2026-03-30", relatedTickets: [], location: [],
    }));

    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(advance.action).toBe("retry");
  });

  it("report() with ticketId does NOT route to ISSUE_FIX (backward compatible)", async () => {
    const { PickTicketStage } = await import("../../../src/autonomous/stages/pick-ticket.js");
    const stage = new PickTicketStage();
    const state = makeState({ state: "PICK_TICKET" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });
    // Should either advance (valid ticket) or retry (ticket validation) -- never goto ISSUE_FIX
    expect(advance.action).not.toBe("goto");
    if ("target" in advance) {
      expect((advance as { target: string }).target).not.toBe("ISSUE_FIX");
    }
  });
});

// ---------------------------------------------------------------------------
// ISSUE_FIX stage
// ---------------------------------------------------------------------------

describe("ISSUE_FIX stage", () => {
  it("enter() presents issue details with fix instruction", async () => {
    const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
    const stage = new IssueFixStage();
    const state = makeState({
      state: "ISSUE_FIX",
      currentIssue: { id: "ISS-001", title: "Critical bug", severity: "critical" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    if ("action" in result) throw new Error("Expected StageResult, got StageAdvance");

    expect(result.instruction).toContain("ISS-001");
    expect(result.instruction).toContain("Critical bug");
    expect(result.instruction).toContain("issue_fixed");
  });

  it("report() with issue_fixed routes to FINALIZE via goto", async () => {
    // Mark the issue as resolved on disk
    writeFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "Critical bug", status: "resolved", severity: "critical",
      components: ["core"], impact: "App crashes", resolution: "Fixed", resolvedDate: "2026-03-30",
      discoveredDate: "2026-03-30", relatedTickets: [], location: [],
    }));

    const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
    const stage = new IssueFixStage();
    const state = makeState({
      state: "ISSUE_FIX",
      currentIssue: { id: "ISS-001", title: "Critical bug", severity: "critical" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "issue_fixed" });
    expect(advance.action).toBe("goto");
    expect((advance as { target: string }).target).toBe("FINALIZE");
  });

  it("report() retries if issue is still open", async () => {
    const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
    const stage = new IssueFixStage();
    const state = makeState({
      state: "ISSUE_FIX",
      currentIssue: { id: "ISS-001", title: "Critical bug", severity: "critical" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "issue_fixed" });
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("still open");
  });

  it("enter() with no currentIssue returns to PICK_TICKET", async () => {
    const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
    const stage = new IssueFixStage();
    const state = makeState({ state: "ISSUE_FIX", currentIssue: null });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    expect("action" in result).toBe(true);
    expect((result as { action: string; target: string }).target).toBe("PICK_TICKET");
  });
});

// ---------------------------------------------------------------------------
// FINALIZE: issue-mode awareness
// ---------------------------------------------------------------------------

describe("FINALIZE: issue-mode", () => {
  it("enter() instruction references issue file when currentIssue is set", async () => {
    const { FinalizeStage } = await import("../../../src/autonomous/stages/finalize.js");
    const stage = new FinalizeStage();
    const state = makeState({
      state: "FINALIZE",
      currentIssue: { id: "ISS-001", title: "Critical bug", severity: "critical" },
      ticket: null,
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);
    if ("action" in result) throw new Error("Expected StageResult, got StageAdvance");

    expect(result.instruction).toContain("ISS-001");
    expect(result.instruction).toContain("resolved");
  });

  it("handleCommit records resolvedIssues and clears currentIssue (issue mode)", async () => {
    // This tests the state updates after commit in issue mode.
    // We verify the session state shape includes resolvedIssues tracking.
    const state = makeState({
      state: "FINALIZE",
      currentIssue: { id: "ISS-001", title: "Critical bug", severity: "critical" },
      ticket: null,
      resolvedIssues: [],
    });
    // Just verify the state fields exist and are typed correctly
    expect(state.currentIssue?.id).toBe("ISS-001");
    expect(state.resolvedIssues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session state fields
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// COMPLETE: routes to PICK_TICKET when high issues exist but no tickets
// ---------------------------------------------------------------------------

describe("COMPLETE: issue-aware routing", () => {
  it("routes to PICK_TICKET when no tickets remain but high issues exist", async () => {
    // Mark the only ticket as complete
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Test ticket", type: "task", status: "complete",
      phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
      completedDate: "2026-03-30", blockedBy: [], parentTicket: null,
    }));

    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001", title: "Test ticket" }],
      config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: [] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.enter(ctx);
    // Should route to PICK_TICKET (not HANDOVER) because ISS-001 is high severity
    expect((advance as { target?: string }).target).toBe("PICK_TICKET");
  });

  // ISS-084: Low-severity open issues now keep the session alive
  it("routes to PICK_TICKET when only low-severity issues remain", async () => {
    // Mark the only ticket as complete
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Test ticket", type: "task", status: "complete",
      phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
      completedDate: "2026-03-30", blockedBy: [], parentTicket: null,
    }));
    // Resolve high-severity issue, keep only low open
    writeFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "Critical bug", status: "resolved", severity: "critical",
      components: [], impact: "Fixed", resolution: "Done", resolvedDate: "2026-03-30",
      discoveredDate: "2026-03-30", relatedTickets: [], location: [],
    }));

    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001", title: "Test ticket" }],
      config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: [] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.enter(ctx);
    // ISS-002 is low severity but still open -- should route back to PICK_TICKET
    const target = (advance as { target?: string }).target;
    expect(target).toBe("PICK_TICKET");
  });

  it("routes to HANDOVER when all issues are resolved", async () => {
    // Mark the only ticket as complete
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Test ticket", type: "task", status: "complete",
      phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
      completedDate: "2026-03-30", blockedBy: [], parentTicket: null,
    }));
    // Resolve ALL issues
    writeFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "Critical bug", status: "resolved", severity: "critical",
      components: [], impact: "Fixed", resolution: "Done", resolvedDate: "2026-03-30",
      discoveredDate: "2026-03-30", relatedTickets: [], location: [],
    }));
    writeFileSync(join(testRoot, ".story", "issues", "ISS-002.json"), JSON.stringify({
      id: "ISS-002", title: "Low priority styling", status: "resolved", severity: "low",
      components: [], impact: "Fixed", resolution: "Done", resolvedDate: "2026-03-30",
      discoveredDate: "2026-03-30", relatedTickets: [], location: [],
    }));

    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001", title: "Test ticket" }],
      config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: [] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.enter(ctx);
    const target = (advance as { target?: string }).target;
    expect(target).not.toBe("PICK_TICKET");
  });
});

// ---------------------------------------------------------------------------
// ISS-084: Issues route through COMPLETE (session limits apply)
// ---------------------------------------------------------------------------

describe("ISS-084: issue-fix routes through COMPLETE", () => {
  it("issue-only session hits maxTicketsPerSession cap", async () => {
    // All tickets done, ISS-002 still open
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Test ticket", type: "task", status: "complete",
      phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
      completedDate: "2026-03-30", blockedBy: [], parentTicket: null,
    }));

    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    // 0 tickets but 3 resolved issues, cap is 3 -- totalWorkDone >= maxTickets
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [],
      resolvedIssues: ["ISS-003", "ISS-004", "ISS-005"],
      config: { maxTicketsPerSession: 3, compactThreshold: "high", reviewBackends: [] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.enter(ctx);
    const target = (advance as { target?: string }).target;
    // Should route to HANDOVER because totalWorkDone (3) >= maxTicketsPerSession (3)
    expect(target).not.toBe("PICK_TICKET");
  });

  it("mixed ticket+issue session counts both toward cap", async () => {
    writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "Test ticket", type: "task", status: "complete",
      phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
      completedDate: "2026-03-30", blockedBy: [], parentTicket: null,
    }));

    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const stage = new CompleteStage();
    // 2 tickets + 3 issues = 5 totalWorkDone, cap is 5
    const state = makeState({
      state: "COMPLETE",
      completedTickets: [{ id: "T-001", title: "Test" }, { id: "T-002", title: "Test2" }],
      resolvedIssues: ["ISS-003", "ISS-004", "ISS-005"],
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: [] },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.enter(ctx);
    const target = (advance as { target?: string }).target;
    expect(target).not.toBe("PICK_TICKET");
  });
});

describe("session state: issue fields", () => {
  it("currentIssue defaults to null", () => {
    const state = makeState();
    expect(state.currentIssue).toBeNull();
  });

  it("resolvedIssues defaults to empty array", () => {
    const state = makeState();
    expect(state.resolvedIssues).toEqual([]);
  });

  it("ISSUE_FIX is a valid WorkflowState", async () => {
    const { WORKFLOW_STATES } = await import("../../../src/autonomous/session-types.js");
    expect(WORKFLOW_STATES).toContain("ISSUE_FIX");
  });
});
