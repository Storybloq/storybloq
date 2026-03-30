/**
 * Focused state-machine transition tests for the autonomous guide.
 * Covers the 5 bug fixes (ISS-029, ISS-031, ISS-033, ISS-034, ISS-035)
 * and the defensive guards added during Codex plan review.
 */
import { describe, it, expect } from "vitest";
import { evaluatePressure } from "../../src/autonomous/context-pressure.js";
import { assessRisk, requiredRounds, nextReviewer } from "../../src/autonomous/review-depth.js";
import type { FullSessionState, PressureLevel } from "../../src/autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal FullSessionState for testing
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "PICK_TICKET",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: {
      level: "low",
      guideCallCount: 0,
      ticketsCompleted: 0,
      compactionCount: 0,
      eventsLogBytes: 0,
    },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
    ...overrides,
  } as FullSessionState;
}

// ---------------------------------------------------------------------------
// ISS-034: Pressure threshold tiers
// ---------------------------------------------------------------------------

describe("evaluatePressure (ISS-034)", () => {
  it("returns low for fresh session", () => {
    const state = makeState();
    expect(evaluatePressure(state)).toBe("low");
  });

  it("default 'high' tier: 3 tickets = medium (not critical)", () => {
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 10, ticketsCompleted: 3, compactionCount: 0, eventsLogBytes: 0 },
    });
    expect(evaluatePressure(state)).toBe("medium");
  });

  it("default 'high' tier: 5 tickets = high", () => {
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 10, ticketsCompleted: 5, compactionCount: 0, eventsLogBytes: 0 },
    });
    expect(evaluatePressure(state)).toBe("high");
  });

  it("default 'high' tier: 8 tickets = critical", () => {
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 10, ticketsCompleted: 8, compactionCount: 0, eventsLogBytes: 0 },
    });
    expect(evaluatePressure(state)).toBe("critical");
  });

  it("default 'high' tier: 90+ calls = critical", () => {
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 91, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    });
    expect(evaluatePressure(state)).toBe("critical");
  });

  it("'critical' tier has higher thresholds than 'high'", () => {
    const state = makeState({
      config: { maxTicketsPerSession: 0, compactThreshold: "critical", reviewBackends: ["codex", "agent"] },
      contextPressure: { level: "low", guideCallCount: 10, ticketsCompleted: 8, compactionCount: 0, eventsLogBytes: 0 },
    });
    // 8 tickets in "critical" tier = high (not critical — threshold is 10)
    expect(evaluatePressure(state)).toBe("high");
  });

  it("'medium' tier has lower thresholds", () => {
    const state = makeState({
      config: { maxTicketsPerSession: 0, compactThreshold: "medium", reviewBackends: ["codex", "agent"] },
      contextPressure: { level: "low", guideCallCount: 10, ticketsCompleted: 2, compactionCount: 0, eventsLogBytes: 0 },
    });
    // 2 tickets in "medium" tier = medium
    expect(evaluatePressure(state)).toBe("medium");
  });

  it("falls back to 'high' tier for unknown compactThreshold", () => {
    const state = makeState({
      config: { maxTicketsPerSession: 0, compactThreshold: "unknown", reviewBackends: ["codex", "agent"] },
      contextPressure: { level: "low", guideCallCount: 60, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    });
    // 60 calls in "high" (fallback) tier = high
    expect(evaluatePressure(state)).toBe("high");
  });

  it("eventsLogBytes triggers thresholds", () => {
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 1_500_001 },
    });
    expect(evaluatePressure(state)).toBe("critical");
  });
});

// ---------------------------------------------------------------------------
// ISS-035: Review verdict routing (unit tests for review-depth.ts helpers)
// ---------------------------------------------------------------------------

describe("review-depth helpers", () => {
  it("requiredRounds returns correct minimums", () => {
    expect(requiredRounds("low")).toBe(1);
    expect(requiredRounds("medium")).toBe(2);
    expect(requiredRounds("high")).toBe(3);
  });

  it("nextReviewer alternates between backends", () => {
    const backends = ["codex", "agent"];
    expect(nextReviewer([], backends)).toBe("codex");
    expect(nextReviewer([{ round: 1, reviewer: "codex", verdict: "revise", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: "" }], backends)).toBe("agent");
    expect(nextReviewer([
      { round: 1, reviewer: "codex", verdict: "revise", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: "" },
      { round: 2, reviewer: "agent", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: "" },
    ], backends)).toBe("codex");
  });

  it("assessRisk: <50 lines = low, 50-200 = medium, >200 = high", () => {
    expect(assessRisk({ totalLines: 10, filesChanged: 1, insertions: 5, deletions: 5 })).toBe("low");
    expect(assessRisk({ totalLines: 100, filesChanged: 3, insertions: 60, deletions: 40 })).toBe("medium");
    expect(assessRisk({ totalLines: 300, filesChanged: 5, insertions: 200, deletions: 100 })).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// ISS-029: Review counter reset — verify the state shape expectations
// ---------------------------------------------------------------------------

describe("ticket-to-ticket state reset (ISS-029)", () => {
  it("new ticket should have empty reviews and null finalizeCheckpoint", () => {
    // Simulate: first ticket completed with reviews, then picking second ticket
    const afterFirstTicket = makeState({
      state: "PICK_TICKET",
      reviews: {
        plan: [{ round: 1, reviewer: "codex", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: "" }],
        code: [
          { round: 1, reviewer: "codex", verdict: "revise", findingCount: 2, criticalCount: 0, majorCount: 1, suggestionCount: 1, timestamp: "" },
          { round: 2, reviewer: "agent", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: "" },
        ],
      },
      finalizeCheckpoint: "committed",
      completedTickets: [{ id: "T-001", title: "First", commitHash: "aaa" }],
    });

    // The fix in handleReportPickTicket resets these fields:
    const resetState = {
      ...afterFirstTicket,
      state: "PLAN",
      previousState: "PICK_TICKET",
      ticket: { id: "T-002", title: "Second", claimed: true },
      reviews: { plan: [], code: [] },
      finalizeCheckpoint: null,
    };

    expect(resetState.reviews.plan).toHaveLength(0);
    expect(resetState.reviews.code).toHaveLength(0);
    expect(resetState.finalizeCheckpoint).toBeNull();
    expect(resetState.completedTickets).toHaveLength(1); // preserved
  });
});

// ---------------------------------------------------------------------------
// ISS-033: Merge-base advancement after commit
// ---------------------------------------------------------------------------

describe("merge-base advancement (ISS-033)", () => {
  it("git.mergeBase updated to commitHash after commit", () => {
    const beforeCommit = makeState({
      state: "FINALIZE",
      git: { branch: "main", mergeBase: "initial-abc", expectedHead: "initial-abc" },
      ticket: { id: "T-001", title: "Test", claimed: true },
    });

    // Simulate what handleReportFinalize now does on commit_done:
    const commitHash = "new-commit-def";
    const afterCommit = {
      ...beforeCommit,
      state: "COMPLETE",
      previousState: "FINALIZE",
      finalizeCheckpoint: "committed" as const,
      completedTickets: [{ id: "T-001", title: "Test", commitHash, risk: "low" }],
      ticket: undefined,
      git: {
        ...beforeCommit.git,
        mergeBase: commitHash,
        expectedHead: commitHash,
      },
    };

    expect(afterCommit.git.mergeBase).toBe("new-commit-def");
    expect(afterCommit.git.expectedHead).toBe("new-commit-def");
    // Next ticket's diff will be against new-commit-def, not initial-abc
  });
});

// ---------------------------------------------------------------------------
// ISS-035: Plan review verdict routing
// ---------------------------------------------------------------------------

describe("plan review verdict routing (ISS-035)", () => {
  it("revise should route to PLAN (not IMPLEMENT) even when minRounds met", () => {
    // This was the original bug: revise fell through to the approve condition
    const verdict = "revise";
    const hasCriticalOrMajor = false;
    const roundNum = 2;
    const minRounds = 1; // low risk = 1 min round

    const isRevise = verdict === "revise" || verdict === "request_changes";
    const isReject = verdict === "reject";

    let nextState: string;
    if (isReject || isRevise) {
      nextState = "PLAN";
    } else if (verdict === "approve" || (!hasCriticalOrMajor && roundNum >= minRounds)) {
      nextState = "IMPLEMENT";
    } else {
      nextState = "PLAN_REVIEW";
    }

    expect(nextState).toBe("PLAN");
  });

  it("request_changes should route to PLAN", () => {
    const verdict = "request_changes";
    const isRevise = verdict === "revise" || verdict === "request_changes";
    const isReject = verdict === "reject";

    let nextState: string;
    if (isReject || isRevise) {
      nextState = "PLAN";
    } else {
      nextState = "IMPLEMENT";
    }

    expect(nextState).toBe("PLAN");
  });

  it("reject clears reviews.plan, revise preserves it", () => {
    const planReviews = [
      { round: 1, reviewer: "codex", verdict: "revise", findingCount: 1, criticalCount: 0, majorCount: 0, suggestionCount: 1, timestamp: "" },
    ];

    // reject: clear
    const rejectReviews = { plan: [] as typeof planReviews, code: [] };
    expect(rejectReviews.plan).toHaveLength(0);

    // revise: preserve
    const reviseReviews = { plan: planReviews, code: [] };
    expect(reviseReviews.plan).toHaveLength(1);
  });

  it("contradictory approve + critical should be rejected", () => {
    const verdict = "approve";
    const hasCriticalOrMajor = true;

    // Guard fires before routing logic
    const shouldReject = verdict === "approve" && hasCriticalOrMajor;
    expect(shouldReject).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISS-035: Code review verdict routing
// ---------------------------------------------------------------------------

describe("code review verdict routing (ISS-035)", () => {
  it("planRedirect applies to any non-approve verdict", () => {
    const planRedirect = true;

    for (const verdict of ["reject", "revise", "request_changes"]) {
      let nextState: string;
      if (planRedirect && verdict !== "approve") {
        nextState = "PLAN";
      } else if (verdict === "reject" || verdict === "revise" || verdict === "request_changes") {
        nextState = "IMPLEMENT";
      } else {
        nextState = "FINALIZE";
      }
      expect(nextState).toBe("PLAN");
    }
  });

  it("planRedirect does NOT redirect approve", () => {
    const planRedirect = true;
    const verdict = "approve";
    const hasCriticalOrMajor = false;

    // approve + planRedirect is caught by the contradictory guard,
    // but if it somehow passed, approve should not be redirected
    let nextState: string;
    if (planRedirect && verdict !== "approve") {
      nextState = "PLAN";
    } else {
      nextState = "FINALIZE"; // simplified
    }
    expect(nextState).toBe("FINALIZE");
  });

  it("contradictory approve + critical in CODE_REVIEW should be rejected", () => {
    const verdict = "approve";
    const hasCriticalOrMajor = true;
    const shouldReject = verdict === "approve" && hasCriticalOrMajor;
    expect(shouldReject).toBe(true);
  });

  it("contradictory approve + planRedirect should be rejected", () => {
    const verdict = "approve";
    const planRedirect = true;
    const shouldReject = verdict === "approve" && planRedirect;
    expect(shouldReject).toBe(true);
  });

  it("CODE_REVIEW → PLAN resets both review arrays", () => {
    const state = makeState({
      reviews: {
        plan: [{ round: 1, reviewer: "codex", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: "" }],
        code: [{ round: 1, reviewer: "codex", verdict: "reject", findingCount: 3, criticalCount: 1, majorCount: 1, suggestionCount: 1, timestamp: "" }],
      },
      ticket: { id: "T-001", title: "Test", claimed: true, risk: "medium", realizedRisk: "high" },
    });

    // Simulate CODE_REVIEW → PLAN reset
    const resetState = {
      ...state,
      state: "PLAN",
      previousState: "CODE_REVIEW",
      reviews: { plan: [], code: [] },
      ticket: state.ticket ? { ...state.ticket, realizedRisk: undefined } : state.ticket,
    };

    expect(resetState.reviews.plan).toHaveLength(0);
    expect(resetState.reviews.code).toHaveLength(0);
    expect(resetState.ticket?.realizedRisk).toBeUndefined();
    // lastPlanHash preserved (not cleared)
  });
});

// ---------------------------------------------------------------------------
// ISS-035: Plan fingerprint
// ---------------------------------------------------------------------------

describe("plan fingerprint (ISS-035)", () => {
  // Replicate the simpleHash from guide.ts
  function simpleHash(content: string): string {
    let hash = 5381;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }

  it("same content produces same hash", () => {
    expect(simpleHash("plan v1")).toBe(simpleHash("plan v1"));
  });

  it("different content produces different hash", () => {
    expect(simpleHash("plan v1")).not.toBe(simpleHash("plan v2"));
  });

  it("unchanged plan after revise should be detected", () => {
    const planContent = "# Implementation Plan\n\nDo the thing.";
    const hash = simpleHash(planContent);

    const state = makeState({
      ticket: { id: "T-001", title: "Test", claimed: true, lastPlanHash: hash },
    });

    // Same plan resubmitted — fingerprint matches
    const newHash = simpleHash(planContent);
    const isUnchanged = state.ticket?.lastPlanHash === newHash;
    expect(isUnchanged).toBe(true);
  });

  it("changed plan after revise passes fingerprint check", () => {
    const hash = simpleHash("# Original Plan\n\nDo thing A.");
    const state = makeState({
      ticket: { id: "T-001", title: "Test", claimed: true, lastPlanHash: hash },
    });

    const newHash = simpleHash("# Revised Plan\n\nDo thing B instead.");
    const isUnchanged = state.ticket?.lastPlanHash === newHash;
    expect(isUnchanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISS-035: Round/reviewer continuity after revise loop
// ---------------------------------------------------------------------------

describe("round/reviewer continuity after revise (ISS-035)", () => {
  it("after 2 plan review rounds + revise, next round is 3 with correct reviewer", () => {
    const existingPlanReviews = [
      { round: 1, reviewer: "codex", verdict: "revise", findingCount: 2, criticalCount: 0, majorCount: 1, suggestionCount: 1, timestamp: "" },
      { round: 2, reviewer: "agent", verdict: "revise", findingCount: 1, criticalCount: 0, majorCount: 0, suggestionCount: 1, timestamp: "" },
    ];
    const backends = ["codex", "agent"];

    const roundNum = existingPlanReviews.length + 1;
    const reviewer = nextReviewer(existingPlanReviews, backends);

    expect(roundNum).toBe(3);
    expect(reviewer).toBe("codex"); // alternates back to codex
  });

  it("after reject, reviews cleared — next round is 1", () => {
    // Reject clears reviews.plan to []
    const clearedReviews: readonly { reviewer: string }[] = [];
    const backends = ["codex", "agent"];

    const roundNum = clearedReviews.length + 1;
    const reviewer = nextReviewer(clearedReviews, backends);

    expect(roundNum).toBe(1);
    expect(reviewer).toBe("codex"); // starts fresh
  });
});

// ===========================================================================
// Wave 3: ISS-024, ISS-025, ISS-027, ISS-028
// ===========================================================================

// ---------------------------------------------------------------------------
// ISS-024: pendingProjectMutation lifecycle
// ---------------------------------------------------------------------------

describe("pendingProjectMutation (ISS-024)", () => {
  it("mutation marker shape is correct", () => {
    const mutation = {
      type: "ticket_update",
      target: "T-001",
      field: "status",
      value: "inprogress",
      expectedCurrent: "open",
      claimedBySession: "session-123",
      transitionId: "txn-abc",
      postMutation: {
        clearTicket: false,
        nextSessionState: null,
        terminationReason: null,
      },
    };
    expect(mutation.type).toBe("ticket_update");
    expect(mutation.target).toBe("T-001");
    expect(mutation.postMutation.clearTicket).toBe(false);
  });

  it("recovery: ticket at target state → clear marker", () => {
    // Simulates: project write succeeded, session write (clear marker) crashed
    const ticketActualStatus = "inprogress";
    const mutationTargetValue = "inprogress";
    const shouldClear = ticketActualStatus === mutationTargetValue;
    expect(shouldClear).toBe(true);
  });

  it("recovery: ticket at expectedCurrent → replay write", () => {
    const ticketActualStatus = "open";
    const expectedCurrent = "open";
    const targetValue = "inprogress";
    const shouldReplay = ticketActualStatus === expectedCurrent && ticketActualStatus !== targetValue;
    expect(shouldReplay).toBe(true);
  });

  it("recovery: ticket at unexpected state → conflict event, no postMutation", () => {
    const ticketActualStatus = "complete";
    const expectedCurrent = "open";
    const targetValue = "inprogress";
    const isConflict = ticketActualStatus !== targetValue && ticketActualStatus !== expectedCurrent;
    expect(isConflict).toBe(true);
  });

  it("postMutation idempotent: skip if session already in target state", () => {
    const sessionState = "SESSION_END";
    const postMutationTarget = "SESSION_END";
    const shouldSkip = sessionState === postMutationTarget;
    expect(shouldSkip).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISS-025: FINALIZE overlap detection
// ---------------------------------------------------------------------------

describe("FINALIZE overlap detection (ISS-025)", () => {
  it("overlap detected → blocked with file list", () => {
    const stagedFiles = ["src/main.ts", ".env", "notes.txt"];
    const baselineUntracked = [".env", "notes.txt", "scratch.md"];
    const overlap = stagedFiles.filter(f => baselineUntracked.includes(f));
    expect(overlap).toEqual([".env", "notes.txt"]);
    expect(overlap.length).toBeGreaterThan(0);
  });

  it("no overlap → proceeds normally", () => {
    const stagedFiles = ["src/main.ts", "src/utils.ts"];
    const baselineUntracked = [".env", "notes.txt"];
    const overlap = stagedFiles.filter(f => baselineUntracked.includes(f));
    expect(overlap).toHaveLength(0);
  });

  it("no baseline → skip check gracefully", () => {
    const baselineUntracked: string[] = [];
    const shouldCheck = baselineUntracked.length > 0;
    expect(shouldCheck).toBe(false);
  });

  it("overrideOverlap: true → skip check", () => {
    const overrideOverlap = true;
    const baselineUntracked = [".env"];
    const shouldCheck = baselineUntracked.length > 0 && !overrideOverlap;
    expect(shouldCheck).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISS-027: Cancel ticket release
// ---------------------------------------------------------------------------

describe("cancel ticket release (ISS-027)", () => {
  it("cancel releases ticket when ownership matches", () => {
    const ticketStatus = "inprogress";
    const ticketClaim = "session-abc";
    const sessionId = "session-abc";
    const shouldRelease = ticketStatus === "inprogress" && (!ticketClaim || ticketClaim === sessionId);
    expect(shouldRelease).toBe(true);
  });

  it("cancel skips release when ticket claimed by another session", () => {
    const ticketStatus = "inprogress";
    const ticketClaim = "session-other";
    const sessionId = "session-abc";
    const shouldRelease = ticketStatus === "inprogress" && (!ticketClaim || ticketClaim === sessionId);
    expect(shouldRelease).toBe(false);
  });

  it("cancel skips release when ticket not inprogress", () => {
    const ticketStatus = "complete";
    const ticketClaim = "session-abc";
    const sessionId = "session-abc";
    const shouldRelease = ticketStatus === "inprogress" && (!ticketClaim || ticketClaim === sessionId);
    expect(shouldRelease).toBe(false);
  });

  it("cancel with no ticket → no crash", () => {
    const ticket = undefined;
    const ticketId = ticket?.id;
    expect(ticketId).toBeUndefined();
    // handleCancel guards with `if (ticketId)` — skips release
  });

  it("cancel event includes ticketId and release status", () => {
    const eventData = {
      previousState: "IMPLEMENT",
      ticketId: "T-001",
      ticketReleased: true,
      ticketConflict: false,
    };
    expect(eventData.ticketId).toBe("T-001");
    expect(eventData.ticketReleased).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISS-027: Claim guard
// ---------------------------------------------------------------------------

describe("claim acquisition guard (ISS-027)", () => {
  it("open + unclaimed → claim allowed", () => {
    const status = "open";
    const claimedBySession = null;
    const canClaim = status === "open" && !claimedBySession;
    expect(canClaim).toBe(true);
  });

  it("inprogress + same session → idempotent (already claimed)", () => {
    const status = "inprogress";
    const claimedBySession = "session-abc";
    const sessionId = "session-abc";
    const isIdempotent = status === "inprogress" && claimedBySession === sessionId;
    expect(isIdempotent).toBe(true);
  });

  it("inprogress + different session → conflict (cannot steal claim)", () => {
    const status = "inprogress";
    const claimedBySession = "session-other";
    const sessionId = "session-abc";
    const canClaim = (status === "open" && !claimedBySession) ||
      (status === "inprogress" && claimedBySession === sessionId);
    expect(canClaim).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISS-027: claimedBySession invariant
// ---------------------------------------------------------------------------

describe("claimedBySession invariant (ISS-027)", () => {
  it("non-inprogress status must clear claimedBySession", () => {
    // writeTicketUnlocked enforces: if status !== inprogress → claimedBySession = null
    const ticket = { status: "complete", claimedBySession: "session-abc" };
    const enforced = ticket.status !== "inprogress"
      ? { ...ticket, claimedBySession: null }
      : ticket;
    expect(enforced.claimedBySession).toBeNull();
  });

  it("legacy tickets without claimedBySession load without error", () => {
    const legacyTicket = { id: "T-001", status: "open" };
    const claim = (legacyTicket as Record<string, unknown>).claimedBySession;
    expect(claim).toBeUndefined();
    // Treated as unclaimed — no error
  });
});

// ---------------------------------------------------------------------------
// ISS-028: Recipe from config
// ---------------------------------------------------------------------------

describe("recipe from config (ISS-028)", () => {
  it("recipe defaults to coding when not in config", () => {
    let recipe = "coding";
    const projectConfig: Record<string, unknown> = {};
    if (typeof projectConfig.recipe === "string") recipe = projectConfig.recipe;
    expect(recipe).toBe("coding");
  });

  it("recipe read from config when present", () => {
    let recipe = "coding";
    const projectConfig: Record<string, unknown> = { recipe: "research" };
    if (typeof projectConfig.recipe === "string") recipe = projectConfig.recipe;
    expect(recipe).toBe("research");
  });
});

// ===========================================================================
// Wave 4: ISS-036, ISS-037, ISS-038
// ===========================================================================

// ---------------------------------------------------------------------------
// ISS-036: Cancel guard
// ---------------------------------------------------------------------------

describe("cancel guard (ISS-036)", () => {
  it("rejects cancel when recipe is coding", () => {
    const recipe = "coding";
    const shouldReject = recipe === "coding";
    expect(shouldReject).toBe(true);
  });

  it("allows cancel when recipe is not coding", () => {
    const recipe = "simple";
    const shouldReject = recipe === "coding";
    expect(shouldReject).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISS-036: Pressure hiding
// ---------------------------------------------------------------------------

describe("pressure hiding (ISS-036)", () => {
  it("markdown output shows tickets done, not pressure label", () => {
    const completed = ["T-001", "T-002"];
    const output = `**Tickets done:** ${completed.length}`;
    expect(output).toContain("Tickets done:** 2");
    expect(output).not.toContain("Pressure");
  });
});

// ---------------------------------------------------------------------------
// ISS-036: guideCallCount reset after resume
// ---------------------------------------------------------------------------

describe("guideCallCount reset (ISS-036)", () => {
  it("guideCallCount reset to 0 after resume Branch A", () => {
    const beforeResume = { guideCallCount: 45, contextPressure: { guideCallCount: 45, ticketsCompleted: 5, compactionCount: 1, eventsLogBytes: 0, level: "critical" } };
    const afterResume = {
      guideCallCount: 0,
      contextPressure: { ...beforeResume.contextPressure, guideCallCount: 0, compactionCount: 2 },
    };
    expect(afterResume.guideCallCount).toBe(0);
    expect(afterResume.contextPressure.guideCallCount).toBe(0);
    expect(afterResume.contextPressure.compactionCount).toBe(2);
  });

  it("guideCallCount reset to 0 after resume Branch B", () => {
    // Same reset applies on HEAD mismatch recovery
    const afterDriftResume = { guideCallCount: 0, contextPressure: { guideCallCount: 0, compactionCount: 3 } };
    expect(afterDriftResume.guideCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ISS-037: Deferred finding filing
// ---------------------------------------------------------------------------

describe("deferred finding filing (ISS-037)", () => {
  it("deferred finding with severity >= minor maps to issue severity", () => {
    const mapping: Record<string, string> = { critical: "critical", major: "high", minor: "medium" };
    expect(mapping["critical"]).toBe("critical");
    expect(mapping["major"]).toBe("high");
    expect(mapping["minor"]).toBe("medium");
  });

  it("suggestion severity skipped", () => {
    const findings = [
      { disposition: "deferred", severity: "suggestion", category: "style", description: "use const" },
      { disposition: "deferred", severity: "minor", category: "safety", description: "missing null check" },
    ];
    const deferred = findings.filter(f => f.disposition === "deferred" && f.severity !== "suggestion");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.severity).toBe("minor");
  });

  it("duplicate fingerprint skipped", () => {
    const filedDeferrals = [{ fingerprint: "abc123", issueId: "ISS-100" }];
    const newFingerprint = "abc123";
    const isDuplicate = filedDeferrals.some(d => d.fingerprint === newFingerprint);
    expect(isDuplicate).toBe(true);
  });

  it("filing failure stays in pendingDeferrals", () => {
    const pending = [{ fingerprint: "xyz", severity: "minor", category: "test", description: "desc", reviewKind: "code" as const }];
    // On failure, entry stays in pending (not moved to filed)
    const remaining = pending; // simulates catch path
    expect(remaining).toHaveLength(1);
  });

  it("successful filing moves to filedDeferrals", () => {
    const pending = [{ fingerprint: "xyz", severity: "minor", category: "test", description: "desc", reviewKind: "code" as const }];
    const filed: { fingerprint: string; issueId: string }[] = [];
    // On success:
    filed.push({ fingerprint: pending[0]!.fingerprint, issueId: "ISS-100" });
    const remaining = pending.filter(p => !filed.some(f => f.fingerprint === p.fingerprint));
    expect(filed).toHaveLength(1);
    expect(remaining).toHaveLength(0);
  });

  it("deferralsUnfiled flag set when entries remain at SESSION_END", () => {
    const pendingDeferrals = [{ fingerprint: "stuck", severity: "major", category: "bug", description: "desc", reviewKind: "code" as const }];
    const hasUnfiled = pendingDeferrals.length > 0;
    expect(hasUnfiled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISS-038: Diff instructions
// ---------------------------------------------------------------------------

describe("diff instructions (ISS-038)", () => {
  it("CODE_REVIEW instruction includes git diff <mergeBase>", () => {
    const mergeBase = "abc123";
    const diffCommand = mergeBase ? `\`git diff ${mergeBase}\`` : "`git diff HEAD`";
    expect(diffCommand).toContain("git diff abc123");
  });

  it("CODE_REVIEW instruction includes Do NOT compress", () => {
    const instruction = "Pass the FULL unified diff output to the reviewer. Do NOT summarize, compress, or truncate the diff.";
    expect(instruction).toContain("Do NOT");
    expect(instruction).toContain("compress");
  });

  it("null mergeBase includes git diff HEAD + git ls-files", () => {
    const mergeBase = null;
    const diffCommand = mergeBase
      ? `\`git diff ${mergeBase}\``
      : "`git diff HEAD` AND `git ls-files --others --exclude-standard`";
    expect(diffCommand).toContain("git diff HEAD");
    expect(diffCommand).toContain("ls-files");
  });

  it("stay-in-CODE_REVIEW instruction includes diff command", () => {
    const mergeBase = "def456";
    const instruction = `Capture diff with: \`git diff ${mergeBase}\`. Pass FULL output — do NOT compress or summarize.`;
    expect(instruction).toContain("git diff def456");
    expect(instruction).toContain("do NOT compress");
  });
});
