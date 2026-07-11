/**
 * Per-ticket risk seed → PLAN_REVIEW depth.
 *
 * Regression coverage for the discarded-risk bug: the PLAN stage used to
 * overwrite the ticket's risk with assessRisk(undefined, undefined) === "low"
 * on every plan, so PLAN_REVIEW's requiredRounds() was pinned to the 1-round
 * minimum regardless of the ticket's risk. PLAN now carries the ticket's risk
 * seed (normalized, default "low") into the review-round computation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanStage } from "../../../src/autonomous/stages/plan.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { normalizeRiskLevel } from "../../../src/autonomous/review-depth.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "PLAN",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "story/T-001-test", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["agent"] },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

const baseTicket = {
  id: "T-001",
  title: "Test ticket",
  description: "A test.",
  type: "task",
  status: "open",
  phase: "p1",
  order: 10,
  createdDate: "2026-01-01",
  completedDate: null,
  blockedBy: [],
};

function writeStoryProject(testRoot: string, ticket: Record<string, unknown>): void {
  for (const dir of ["tickets", "issues", "notes", "handovers"]) {
    mkdirSync(join(testRoot, ".story", dir), { recursive: true });
  }
  writeFileSync(
    join(testRoot, ".story", "config.json"),
    JSON.stringify({
      version: 1,
      schemaVersion: 1,
      project: "test",
      type: "npm",
      language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
    "utf-8",
  );
  writeFileSync(
    join(testRoot, ".story", "roadmap.json"),
    JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Desc." }],
      blockers: [],
    }),
    "utf-8",
  );
  writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify(ticket, null, 2), "utf-8");
}

describe("normalizeRiskLevel", () => {
  it("passes through the canonical levels", () => {
    expect(normalizeRiskLevel("low")).toBe("low");
    expect(normalizeRiskLevel("medium")).toBe("medium");
    expect(normalizeRiskLevel("high")).toBe("high");
  });

  it("defaults anything else to low", () => {
    expect(normalizeRiskLevel(undefined)).toBe("low");
    expect(normalizeRiskLevel(null)).toBe("low");
    expect(normalizeRiskLevel("")).toBe("low");
    expect(normalizeRiskLevel("HIGH")).toBe("low");
    expect(normalizeRiskLevel("banana")).toBe("low");
  });
});

describe("PLAN carries the ticket risk seed into review depth", () => {
  let testRoot: string;
  let sessionDir: string;
  const plan = new PlanStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plan-risk-"));
    sessionDir = join(testRoot, ".story", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf-8");
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("preserves a high risk seed and requires 3 plan-review rounds", async () => {
    writeStoryProject(testRoot, baseTicket);
    const state = makeState({ ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "high" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await plan.report(ctx, { completedAction: "plan_written" });

    expect(advance.action).toBe("advance");
    // The risk seed survives PLAN instead of being clobbered to "low".
    expect(ctx.state.ticket?.risk).toBe("high");
    // The precomputed PLAN_REVIEW instruction reflects requiredRounds("high") === 3.
    if (advance.action === "advance" && "result" in advance && advance.result) {
      expect(advance.result.instruction).toContain("of 3 minimum");
    } else {
      throw new Error("expected advance with a precomputed PLAN_REVIEW instruction");
    }
  });

  it("keeps an unseeded ticket UNCLASSIFIED while depth defaults to 1 round", async () => {
    // Adapted 2026-07-11 (Codex R2 finding 1): the old behavior persisted the
    // normalized "low" back into session state, which made an unclassified
    // ticket satisfy skipIfRiskBelow. Depth still defaults to low (1 round),
    // but the PERSISTED seed stays absent so skip gates can never fire on it.
    writeStoryProject(testRoot, baseTicket);
    const state = makeState({ ticket: { id: "T-001", title: "Test ticket", claimed: true } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await plan.report(ctx, { completedAction: "plan_written" });

    expect(advance.action).toBe("advance");
    expect(ctx.state.ticket?.risk).toBeUndefined();
    if (advance.action === "advance" && "result" in advance && advance.result) {
      expect(advance.result.instruction).toContain("of 1 minimum");
    } else {
      throw new Error("expected advance with a precomputed PLAN_REVIEW instruction");
    }
  });
});

describe("PLAN_REVIEW depth reflects the seeded risk", () => {
  let testRoot: string;
  let sessionDir: string;
  const planReview = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plan-review-risk-"));
    sessionDir = join(testRoot, ".story", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("high-risk ticket → PLAN_REVIEW enter() requires 3 rounds", async () => {
    const state = makeState({
      state: "PLAN_REVIEW",
      ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "high" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await planReview.enter(ctx);
    if ("instruction" in result) {
      expect(result.instruction).toContain("of 3 minimum");
    } else {
      throw new Error("expected a StageResult with an instruction");
    }
  });

  it("low-risk ticket → PLAN_REVIEW enter() requires 1 round", async () => {
    const state = makeState({
      state: "PLAN_REVIEW",
      ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await planReview.enter(ctx);
    if ("instruction" in result) {
      expect(result.instruction).toContain("of 1 minimum");
    } else {
      throw new Error("expected a StageResult with an instruction");
    }
  });
});
