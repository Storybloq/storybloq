import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import type { Finding, FullSessionState, ReviewRecord } from "../../../src/autonomous/session-types.js";

function review(round: number, verdict = "revise", criticalCount = 0, majorCount = 1): ReviewRecord {
  return {
    round,
    reviewer: "agent",
    verdict,
    findingCount: criticalCount + majorCount,
    criticalCount,
    majorCount,
    suggestionCount: 0,
    timestamp: new Date().toISOString(),
  };
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "CODE_REVIEW",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
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
    guideCallCount: 1,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null,
    resolvedIssues: [],
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    landingDecision: null,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(maxReviewRounds: number): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: { CODE_REVIEW: { maxReviewRounds } },
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

function finding(
  severity: Finding["severity"],
  disposition: Finding["disposition"] = "open",
  extra: Partial<Finding> = {},
): Finding {
  return {
    id: "F-1",
    severity,
    category: "correctness",
    description: "Follow-up needed",
    disposition,
    ...extra,
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
    version: 2,
    schemaVersion: 1,
    project: "test",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test",
    date: "2026-07-09",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
}

function issueCount(root: string): number {
  return readdirSync(join(root, ".story", "issues")).filter((f) => f.endsWith(".json")).length;
}

describe("CodeReviewStage landing cap", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "code-review-landing-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("routes non-critical revise before the cap back to IMPLEMENT", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(3));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.landingDecision).toBeNull();
  });

  it("forces FINALIZE at the cap when revise has no unresolved critical findings", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major"), finding("minor")],
    });

    expect(advance).toMatchObject({ action: "advance" });
    expect(ctx.state.landingDecision).toMatchObject({
      stage: "CODE_REVIEW",
      round: 2,
      maxReviewRounds: 2,
      reason: "max_review_rounds_no_blocking",
      findingCounts: { critical: 0, major: 1, minor: 1, suggestion: 0 },
    });
    expect(issueCount(testRoot)).toBe(2);
  });

  it("lands with an addressed critical while preserving raw and unresolved counts", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("critical", "addressed"), finding("major")],
    });

    expect(advance).toMatchObject({ action: "advance" });
    expect(ctx.state.reviews.code.at(-1)).toMatchObject({
      criticalCount: 1,
      unresolvedCriticalCount: 0,
    });
    expect(ctx.state.lastReviewVerdict).toMatchObject({
      criticalCount: 1,
      unresolvedCriticalCount: 0,
    });
    expect(ctx.state.landingDecision?.reason).toBe("max_review_rounds_no_blocking");
  });

  it("does not duplicate forced deferral issues across repeated reports", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(2));

    const report = {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    } as const;

    await stage.report(ctx, report);
    await stage.report(ctx, report);

    expect(issueCount(testRoot)).toBe(1);
    expect(ctx.state.filedDeferrals).toHaveLength(1);
  });

  it("keeps unresolved critical findings blocking even at the cap", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1, "revise", 1, 0)] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("critical")],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.landingDecision).toBeNull();
    expect(ctx.state.reviews.code.at(-1)).toMatchObject({
      criticalCount: 1,
      unresolvedCriticalCount: 1,
    });
  });

  it("keeps reject blocking even with no critical findings", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1, "revise", 0, 1)] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "reject",
      findings: [],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.landingDecision).toBeNull();
  });

  it("keeps plan redirects routed to PLAN", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major", "open", { recommendedNextState: "PLAN" })],
    });

    expect(advance).toMatchObject({ action: "back", target: "PLAN" });
    expect(ctx.state.landingDecision).toBeNull();
  });

  it("clamps cap below risk minimum to required review rounds", async () => {
    const highRiskState = makeState({
      ticket: { id: "T-001", displayId: "T-001", title: "High risk", claimed: true, risk: "high" },
      reviews: { plan: [], code: [review(1)] },
    });
    const beforeMinimumCtx = new StageContext(testRoot, sessionDir, highRiskState, makeRecipe(1));

    const beforeMinimum = await stage.report(beforeMinimumCtx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });
    expect(beforeMinimum).toMatchObject({ action: "back", target: "IMPLEMENT" });

    const atMinimumCtx = new StageContext(testRoot, sessionDir, makeState({
      ticket: { id: "T-001", displayId: "T-001", title: "High risk", claimed: true, risk: "high" },
      reviews: { plan: [], code: [review(1), review(2)] },
    }), makeRecipe(1));

    const atMinimum = await stage.report(atMinimumCtx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });
    expect(atMinimum).toMatchObject({ action: "advance" });
    expect(atMinimumCtx.state.landingDecision?.maxReviewRounds).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // T-461 phase 3: the light landing guard.
  //
  // Every test above pins today's rule -- a change request at the cap lands with
  // no fix and no re-review. That is tolerable at standard's cap of 12 (and is
  // filed as its own issue). At light's cap of 4 it would be the common case, so
  // light moves the LANDING point one round past the cap and spends that round
  // on the fix.
  //
  // These use makeRecipe(12), the shipped default, so the light cap of 4 is
  // dial-derived rather than configured. The pair is deliberately mutually
  // supporting: the round-5 test fails if the light cap is not applied (at 12,
  // round 5 would route back), and the round-4 test fails if the guard is not
  // applied (at cap 4, round 4 would land). Neither can pass vacuously.
  // ---------------------------------------------------------------------------

  const lightState = (roundsAlready: number, extra: Partial<FullSessionState> = {}) => makeState({
    currentReviewEffort: "light",
    reviews: { plan: [], code: Array.from({ length: roundsAlready }, (_, i) => review(i + 1)) },
    ...extra,
  } as Partial<FullSessionState>);

  it("routes a change request AT the light cap to IMPLEMENT instead of landing", async () => {
    const ctx = new StageContext(testRoot, sessionDir, lightState(3), makeRecipe(12));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "request_changes",
      findings: [finding("major"), finding("minor")],
    });

    // Round 4 == the light cap. Today's rule would land here.
    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.landingDecision).toBeNull();
    // The fix has not been reviewed, so nothing may be deferred away yet.
    expect(issueCount(testRoot)).toBe(0);
  });

  it("lands on the grace round and reports the cap, not the floor", async () => {
    const ctx = new StageContext(testRoot, sessionDir, lightState(4), makeRecipe(12));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "advance" });
    expect(ctx.state.landingDecision).toMatchObject({
      round: 5,
      // 4, not 5: the grace round is an exception to landing, not a larger cap.
      maxReviewRounds: 4,
      reason: "max_review_rounds_no_blocking",
    });
  });

  it("keeps an unresolved critical blocking through the grace round", async () => {
    const ctx = new StageContext(testRoot, sessionDir, lightState(4), makeRecipe(12));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("critical")],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.landingDecision).toBeNull();
  });

  it("does not extend a PROJECT-set cap at light", async () => {
    // Precedence rule 1: the dial narrows within what a project asked for and
    // never past it. A project that wrote maxReviewRounds: 4 gets landing at 4,
    // because a grace round here would be the dial overriding an explicit knob.
    const ctx = new StageContext(testRoot, sessionDir, lightState(3, {
      resolvedReviewEffort: {
        level: "light",
        source: "project",
        explicitKnobs: { codeReviewMaxRounds: true },
      },
    } as Partial<FullSessionState>), makeRecipe(4));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "advance" });
    expect(ctx.state.landingDecision?.maxReviewRounds).toBe(4);
  });

  /**
   * A post-dial session whose `explicitKnobs` did not survive: the session
   * schema is deliberately permissive (a corrupt record must not brick a
   * resume), so `.catch({})` turns damage into an absent flag.
   *
   * The grace round applies there, on purpose, and this is the one place the
   * decision is written down. Two reasons.
   *
   * FAIL-CLOSED DIRECTION: the alternative -- demanding proof the knob was NOT
   * project-set -- makes corruption land a change request with no fix and no
   * re-review. Damage must never buy LESS review than today; that rule already
   * settled `normalizeReviewEffort` and `mapIssueSeverityToEffort`, and it
   * settles this the same way. One extra round on a damaged record is the
   * cheaper mistake by a wide margin.
   *
   * ONE READING OF THE KNOB: `dialCodeReviewMaxRounds` reads the same flag, and
   * in this same cell it ALREADY treats the session as not-project-set and
   * clamps the cap. A floor that honored the knob while the cap ignored it
   * would be the two-readers-disagree bug the shared function exists to
   * prevent -- the pair would be claiming the project's cap is authoritative
   * and overriding it in the same breath.
   */
  it("keeps the grace round when explicitKnobs did not survive", async () => {
    const damaged = { level: "light", source: "start-call" };

    const ctx = new StageContext(testRoot, sessionDir, lightState(3, {
      resolvedReviewEffort: damaged,
    } as Partial<FullSessionState>), makeRecipe(4));
    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });
    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });

    // The control that makes the choice coherent rather than arbitrary: with
    // the SAME damage and a project cap of 8, the cap reader has already
    // clamped to 4. The project's number is not being honored by either reader.
    const clamped = new StageContext(testRoot, sessionDir, lightState(4, {
      resolvedReviewEffort: damaged,
    } as Partial<FullSessionState>), makeRecipe(8));
    await stage.report(clamped, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });
    expect(clamped.state.landingDecision?.maxReviewRounds).toBe(4);
  });

  it("leaves thorough on today's landing point", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      currentReviewEffort: "thorough",
      reviews: { plan: [], code: [review(1)] },
    } as Partial<FullSessionState>), makeRecipe(2));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "advance" });
    expect(ctx.state.landingDecision?.round).toBe(2);
  });

  it("treats an explicit zero cap as unlimited", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: Array.from({ length: 12 }, (_, index) => review(index + 1)) },
    }), makeRecipe(0));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round",
      verdict: "revise",
      findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.landingDecision).toBeNull();
  });
});
