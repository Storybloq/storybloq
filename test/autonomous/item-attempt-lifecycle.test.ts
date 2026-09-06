/**
 * T-488 D4/D7: one attempt per work item, and provenance bound to it.
 *
 * Establishing the attempt at PICK_TICKET alone was the first design and it was
 * wrong: sessions resume directly into PLAN_REVIEW, IMPLEMENT or CODE_REVIEW,
 * and a session can switch subject without passing acquisition again. So one
 * helper owns the decision and establishes lazily wherever it is first reached.
 *
 * The binding is what makes stale attribution impossible rather than unlikely.
 * The case is ordinary, not exotic: `maxTicketsPerSession` reaches 5, and item
 * B's PLAN_REVIEW runs BEFORE B's first IMPLEMENT, so a session-level
 * implementer would still hold item A's model at that exact moment.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { ImplementStage } from "../../src/autonomous/stages/implement.js";
import { CompleteStage } from "../../src/autonomous/stages/complete.js";
import { CodeReviewStage } from "../../src/autonomous/stages/code-review.js";
import type { FullSessionState, ReviewRecord } from "../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "IMPLEMENT", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: null, expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 1,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null, resolvedIssues: [], resolvedIssuesMeta: [],
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    landingDecision: null, currentReviewStartedAt: now,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const d of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(storyDir, d), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-09-05",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
}

const DONE = { completedAction: "implementation_done" } as const;
const APPROVE = { completedAction: "code_review_round", verdict: "approve", findings: [] } as const;

describe("item attempt lifecycle", () => {
  let testRoot: string;
  let sessionDir: string;
  const implement = new ImplementStage();
  const codeReview = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "t488-attempt-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("IMPLEMENT establishes an attempt lazily for a session that never passed acquisition", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    expect(ctx.state.itemAttempt ?? null).toBeNull();

    await implement.report(ctx, DONE as never);

    expect(ctx.state.itemAttempt).toMatchObject({ workItemId: "T-001", kind: "ticket" });
  });

  it("CODE_REVIEW establishes one too, for a session that resumed straight into it", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({ state: "CODE_REVIEW" } as Partial<FullSessionState>), makeRecipe());
    await codeReview.report(ctx, APPROVE);
    expect(ctx.state.itemAttempt).toMatchObject({ workItemId: "T-001", kind: "ticket" });
    expect((ctx.state.reviews.code[0] as ReviewRecord).itemAttemptId)
      .toBe((ctx.state.itemAttempt as { id: string }).id);
  });

  it("a same-session subject switch MINTS a new attempt rather than reusing the old one", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({ state: "CODE_REVIEW" } as Partial<FullSessionState>), makeRecipe());
    await codeReview.report(ctx, APPROVE);
    const first = (ctx.state.itemAttempt as { id: string }).id;

    const next = new StageContext(testRoot, sessionDir, {
      ...ctx.state,
      ticket: { id: "T-002", displayId: "T-002", title: "Second", claimed: true, risk: "low" },
      reviews: { plan: [], code: [] },
    } as FullSessionState, makeRecipe());
    await codeReview.report(next, APPROVE);

    expect((next.state.itemAttempt as { id: string }).id).not.toBe(first);
    expect(next.state.itemAttempt).toMatchObject({ workItemId: "T-002" });
  });

  it("binds the implementer to the attempt so a round can prove it belongs", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await implement.report(ctx, { ...DONE, implementerModel: "sonnet-5", implementerTier: "hands" } as never);

    const attemptId = (ctx.state.itemAttempt as { id: string }).id;
    expect(ctx.state.implementer).toMatchObject({
      itemAttemptId: attemptId, model: "sonnet-5", tier: "hands",
      // The report named a model and a tier and did NOT say how either was
      // chosen, so the source stays unknown rather than being read as a pin.
      source: "unknown", evidence: "configured",
    });
  });

  it("carries THIS item's implementer onto its own review round", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await implement.report(ctx, { ...DONE, implementerModel: "sonnet-5" } as never);

    const review = new StageContext(testRoot, sessionDir, { ...ctx.state, state: "CODE_REVIEW" } as FullSessionState, makeRecipe());
    await codeReview.report(review, APPROVE);

    expect((review.state.reviews.code[0] as ReviewRecord).implementer)
      .toMatchObject({ model: "sonnet-5", evidence: "configured" });
  });

  it("ITEM B's REVIEW BEFORE B's FIRST IMPLEMENT records unknown, never item A's model", async () => {
    // The whole reason the implementer is attempt-bound. This ordering is not
    // an edge case: every multi-item session hits it.
    const a = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await implement.report(a, { ...DONE, implementerModel: "opus-5" } as never);
    expect(a.state.implementer).toMatchObject({ model: "opus-5" });

    // Item B is picked. The session-level implementer still holds A's.
    const b = new StageContext(testRoot, sessionDir, {
      ...a.state,
      state: "CODE_REVIEW",
      ticket: { id: "T-002", displayId: "T-002", title: "Second", claimed: true, risk: "low" },
      reviews: { plan: [], code: [] },
    } as FullSessionState, makeRecipe());
    await codeReview.report(b, APPROVE);

    const record = b.state.reviews.code[0] as ReviewRecord;
    expect(record.workItemId).toBe("T-002");
    expect(record.implementer).toEqual({ source: "unknown", evidence: "none" });
    expect(JSON.stringify(record.implementer)).not.toContain("opus-5");
  });

  it("records no implementer at all when there is no subject to bind one to", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      ticket: null, currentIssue: null,
    } as Partial<FullSessionState>), makeRecipe());
    await implement.report(ctx, { ...DONE, implementerModel: "sonnet-5" } as never);

    // An unbound implementer is exactly the stale-attribution shape this
    // replaced, so it is null rather than a guess.
    expect(ctx.state.implementer ?? null).toBeNull();
  });

  it("COMPLETE clears the attempt and its implementer, and keeps the generation history", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      state: "COMPLETE",
      itemAttempt: { id: "a1", workItemId: "T-001", kind: "ticket", startedAt: new Date().toISOString(), generation: 2 },
      implementer: { itemAttemptId: "a1", model: "opus-5", source: "explicit-pin", evidence: "configured" },
      // Seeded NON-NULL on purpose. Asserting `x ?? null` is null against a
      // fixture that never set `x` passes whether or not COMPLETE clears
      // anything, which is not a test of the clearing.
      pendingReviewAttempt: {
        reviewAttemptId: "r1", itemAttemptId: "a1", workItemId: "T-001", kind: "ticket",
        stage: "code", round: 1, generation: 2, payloadFingerprint: "fp",
        verdict: "revise", reviewer: "codex", summary: "in flight",
        findings: [], decidedAt: new Date().toISOString(),
      },
      reviewGenerationHistory: [{
        itemAttemptId: "a1", generation: 0, lensReviewHistory: [],
        endedAt: new Date().toISOString(), reason: "plan-redirect",
      }],
    } as Partial<FullSessionState>), makeRecipe());

    expect(ctx.state.pendingReviewAttempt).toBeTruthy();

    await new CompleteStage().enter(ctx);

    expect(ctx.state.itemAttempt ?? null).toBeNull();
    expect(ctx.state.implementer ?? null).toBeNull();
    expect(ctx.state.pendingReviewAttempt).toBeNull();
    // The history is the record of what the completed item cost, so it stays.
    expect(ctx.state.reviewGenerationHistory).toHaveLength(1);
  });
});
