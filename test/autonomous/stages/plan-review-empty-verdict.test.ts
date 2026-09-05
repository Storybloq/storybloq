/**
 * ISS-1114: the contradictory change-request guard, PLAN_REVIEW side.
 *
 * The plan-side harm is sharper than the code side's and is what these tests
 * are built around. `plan-review.ts` runs the findings-clean landing check
 * BEFORE the revise branch, and an empty change-request has no critical or
 * major findings, so from `minRounds` onward it routes STRAIGHT TO IMPLEMENT.
 * The plan is treated as approved on the strength of a review that requested
 * changes and named none. `minRounds` never exceeds 3, so an ordinary ticket
 * reaches it on round 2 or 3.
 *
 * The central test below is therefore written as "without the guard this LANDS
 * to IMPLEMENT, with the guard it retries", never as "it loops in PLAN_REVIEW".
 * The loop phrasing would pass for the wrong reason: it is satisfied by the
 * pre-guard behavior at low round numbers and would not fail if the guard
 * regressed.
 *
 * FIXTURE NOTE. The motivating corpus is LobbyKit session 3d3e637d, T-158 plan
 * rounds 4 to 22: nineteen consecutive `revise` verdicts with `findingCount: 0`,
 * reviewer codex on all nineteen, confirmed in both the events log and the
 * per-round verdict artifacts. That session PREDATES the findings-clean landing
 * check, which is why it ran on for 51 rounds instead of landing at round 4. It
 * is evidence for the PREDICATE and never a behavioral expectation of current
 * source, so it is not replayed from disk here: the guard needs only a verdict
 * and a finding count, and the states below are synthesized.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { readSession } from "../../../src/autonomous/session.js";
import { SessionStateSchema } from "../../../src/autonomous/session-types.js";
import type { FullSessionState, ReviewRecord } from "../../../src/autonomous/session-types.js";

function planRound(round: number): ReviewRecord {
  return {
    round,
    reviewer: "codex",
    verdict: "revise",
    findingCount: 1,
    criticalCount: 0,
    majorCount: 1,
    suggestionCount: 0,
    timestamp: new Date().toISOString(),
  };
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    frozenGate: { status: "ungated" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    currentReviewStartedAt: now,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex"] },
  };
}

/**
 * The plan stage reaches the real ledger on two paths these tests exercise: the
 * park writes the reason onto the ticket, and the IMPLEMENT landing snapshots
 * plan.md. Both fail closed (returning `retry`) when their inputs are missing,
 * so a test lacking this setup would see a `retry` that has nothing to do with
 * the guard under test.
 */
function setupProject(root: string, sessionDir: string): void {
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
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open", phase: "p1", order: 10,
    description: "Test", blockedBy: [], parentTicket: null,
  }));
  writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\nA plan the landing path can snapshot.\n");
}

const EMPTY_REPORT = { completedAction: "plan_review_round", verdict: "revise", findings: [] } as const;

function artifactCount(sessionDir: string): number {
  const dir = join(sessionDir, "telemetry", "reviews");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
}

describe("PlanReviewStage empty change-request guard (ISS-1114)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "planrev-empty-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot, sessionDir);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("stops the FALSE LANDING: an empty revise at minRounds no longer routes to IMPLEMENT", async () => {
    // risk low means requiredRounds 1, so minRounds is 1 and round 1 already
    // satisfies `!hasCriticalOrMajor && roundNum >= minRounds`. Before the guard
    // this advanced to IMPLEMENT and implementation began on a review that
    // requested changes and supplied nothing.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(advance).not.toMatchObject({ action: "advance" });
    expect((advance as { instruction: string }).instruction)
      .toContain("requests changes but supplies no actionable changes");
    expect(ctx.state.reviews.plan).toHaveLength(0);
    expect(artifactCount(sessionDir)).toBe(0);
    expect(ctx.state.reviewRepairAttempts).toHaveLength(1);
  });

  it("stops the false landing at a later round too", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [planRound(1), planRound(2)], code: [] },
      planReviewRoundCounter: { ticketId: "T-001", completedRounds: 2 },
    } as Partial<FullSessionState>), makeRecipe());

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.reviews.plan).toHaveLength(2);
    expect(ctx.state.reviewRepairAttempts?.[0]).toMatchObject({ round: 3, attempt: 1, stage: "plan" });
  });

  it("treats request_changes identically to revise", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round", verdict: "request_changes", findings: [],
    });

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.reviewRepairAttempts?.[0]).toMatchObject({ verdict: "request_changes" });
  });

  it("records a second attempt for the same round", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    await stage.report(ctx, EMPTY_REPORT);
    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.reviewRepairAttempts).toHaveLength(2);
    expect(ctx.state.reviewRepairAttempts?.[1]).toMatchObject({ round: 1, attempt: 2 });
  });

  it("parks on the third empty payload with a schema-valid empty-verdict record", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    await stage.report(ctx, EMPTY_REPORT);
    await stage.report(ctx, EMPTY_REPORT);
    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance.action).not.toBe("retry");
    expect(ctx.state.pendingPlanCeilingEscalation).toMatchObject({
      ticketId: "T-001",
      trigger: "empty-verdict",
      repairAttempts: 2,
      unresolvedCritical: 0,
      unresolvedMajor: 0,
      round: 1,
      findings: [],
    });
    expect(ctx.state.pendingPlanCeilingEscalation?.ceiling).toBeGreaterThan(0);
    const persisted = readSession(sessionDir);
    expect(() => SessionStateSchema.parse(persisted)).not.toThrow();
    expect(persisted?.pendingPlanCeilingEscalation?.trigger).toBe("empty-verdict");
    expect(ctx.state.pendingPlanCeilingEscalation?.reason).toContain("codex");
    expect(ctx.state.pendingPlanCeilingEscalation?.reason).toContain("cannot distinguish");
  });

  it("preserves the findings-clean landing ordering for a non-empty revise", async () => {
    // ISS-598/ISS-1031 put the landing check before `isRevise`. A revise with
    // only a minor finding and no unresolved critical or major must still land
    // at IMPLEMENT once past minRounds; the new guard must not disturb it.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "revise",
      findings: [{ id: "f1", severity: "minor", category: "style", description: "Naming nit", disposition: "open" }],
    });

    expect(advance).toMatchObject({ action: "advance" });
    expect(ctx.state.reviewRepairAttempts ?? []).toHaveLength(0);
    expect(ctx.state.reviews.plan).toHaveLength(1);
  });

  it("still retries an approve carrying a major finding (ISS-035 preserved)", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const advance = await stage.report(ctx, {
      completedAction: "plan_review_round",
      verdict: "approve",
      findings: [{ id: "f1", severity: "major", category: "logic", description: "Missing error handling", disposition: "open" }],
    });

    expect(advance).toMatchObject({ action: "retry" });
    expect((advance as { instruction: string }).instruction).toContain("Contradictory review payload");
    expect(ctx.state.reviewRepairAttempts ?? []).toHaveLength(0);
  });

  it("does not count another ticket's attempts toward this ticket's cap", async () => {
    const at = new Date().toISOString();
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviewRepairAttempts: [
        { workItemId: "T-999", kind: "ticket", stage: "plan", round: 1, attempt: 1, verdict: "revise", reviewer: "codex", at, attemptDurationMs: 0 },
        { workItemId: "T-999", kind: "ticket", stage: "plan", round: 1, attempt: 2, verdict: "revise", reviewer: "codex", at, attemptDurationMs: 0 },
      ],
    } as Partial<FullSessionState>), makeRecipe());

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.pendingPlanCeilingEscalation ?? null).toBeNull();
  });

  it("does not count a code-stage attempt toward the plan-stage cap", async () => {
    const at = new Date().toISOString();
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviewRepairAttempts: [
        { workItemId: "T-001", kind: "ticket", stage: "code", round: 1, attempt: 1, verdict: "revise", reviewer: "codex", at, attemptDurationMs: 0 },
        { workItemId: "T-001", kind: "ticket", stage: "code", round: 1, attempt: 2, verdict: "revise", reviewer: "codex", at, attemptDurationMs: 0 },
      ],
    } as Partial<FullSessionState>), makeRecipe());

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.pendingPlanCeilingEscalation ?? null).toBeNull();
  });

  it("survives a reject generation reset without carrying attempts across it", async () => {
    // A reject CLEARS `reviews.plan`, so `roundNum` restarts at 1. The durable
    // `planReviewRoundCounter` counts across rejects by design (ISS-904), which
    // is exactly why the attempt key is derived from it and not from the array.
    const at = new Date().toISOString();
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [] },
      planReviewRoundCounter: { ticketId: "T-001", completedRounds: 4 },
      reviewRepairAttempts: [
        { workItemId: "T-001", kind: "ticket", stage: "plan", round: 1, attempt: 1, verdict: "revise", reviewer: "codex", at, attemptDurationMs: 0 },
        { workItemId: "T-001", kind: "ticket", stage: "plan", round: 1, attempt: 2, verdict: "revise", reviewer: "codex", at, attemptDurationMs: 0 },
      ],
    } as Partial<FullSessionState>), makeRecipe());

    const advance = await stage.report(ctx, EMPTY_REPORT);

    // Pending round is 5 from the counter, not 1 from the cleared array, so the
    // two banked attempts are not this round's and this payload is repaired.
    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.pendingPlanCeilingEscalation ?? null).toBeNull();
    expect(ctx.state.reviewRepairAttempts?.at(-1)).toMatchObject({ round: 5, attempt: 1 });
  });

  it("numbers a counterless session from 1, matching how the counter initializes", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [planRound(1)], code: [] },
      planReviewRoundCounter: null,
    } as Partial<FullSessionState>), makeRecipe());

    await stage.report(ctx, EMPTY_REPORT);

    expect(ctx.state.reviewRepairAttempts?.[0]).toMatchObject({ round: 1, attempt: 1 });
  });

  it("falls through unchanged when there is no ticket", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      ticket: null,
    } as Partial<FullSessionState>), makeRecipe());

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).not.toMatchObject({ action: "retry", instruction: expect.stringContaining("supplies no actionable changes") });
    expect(ctx.state.reviewRepairAttempts ?? []).toHaveLength(0);
    expect(ctx.state.pendingPlanCeilingEscalation ?? null).toBeNull();
  });

  it("keeps attempts across a state reload from disk", async () => {
    const ctx1 = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx1, EMPTY_REPORT);

    const reloaded1 = readSession(sessionDir);
    expect(reloaded1?.reviewRepairAttempts).toHaveLength(1);

    const ctx2 = new StageContext(testRoot, sessionDir, reloaded1!, makeRecipe());
    await stage.report(ctx2, EMPTY_REPORT);

    const reloaded2 = readSession(sessionDir);
    expect(reloaded2?.reviewRepairAttempts).toHaveLength(2);

    const ctx3 = new StageContext(testRoot, sessionDir, reloaded2!, makeRecipe());
    await stage.report(ctx3, EMPTY_REPORT);

    expect(readSession(sessionDir)?.pendingPlanCeilingEscalation)
      .toMatchObject({ trigger: "empty-verdict", repairAttempts: 2 });
  });

  it("resumes a park interrupted after the escalation write without double-counting", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, EMPTY_REPORT);
    await stage.report(ctx, EMPTY_REPORT);

    const boom = vi.spyOn(ctx, "drainDeferrals").mockRejectedValueOnce(new Error("interrupted"));
    await expect(stage.report(ctx, EMPTY_REPORT)).rejects.toThrow("interrupted");
    boom.mockRestore();

    const afterCrash = readSession(sessionDir);
    expect(afterCrash?.pendingPlanCeilingEscalation).toMatchObject({ trigger: "empty-verdict", completed: false });
    const attemptsAtCrash = afterCrash?.reviewRepairAttempts?.length ?? 0;

    const resumeCtx = new StageContext(testRoot, sessionDir, afterCrash!, makeRecipe());
    const resumed = await stage.report(resumeCtx, EMPTY_REPORT);

    // The resume has to FINISH the park. Asserting only "nothing extra
    // happened" is satisfied by a resume that returns retry forever, which
    // parks nothing. The plan stage parks to PICK_TICKET, not HANDOVER.
    expect(resumed.action).toBe("goto");
    expect((resumed as { target: string }).target).toBe("PICK_TICKET");
    expect(resumeCtx.state.pendingPlanCeilingEscalation?.completed).toBe(true);
    expect(resumeCtx.state.reviewRepairAttempts?.length ?? 0).toBe(attemptsAtCrash);
    expect(resumeCtx.state.reviews.plan).toHaveLength(0);
    expect(artifactCount(sessionDir)).toBe(0);
  });

  it("measures per-attempt intervals rather than cumulative round time", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-09-05T00:00:00.000Z");
    vi.setSystemTime(t0);
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      currentReviewStartedAt: t0.toISOString(),
    }), makeRecipe());

    vi.setSystemTime(new Date(t0.getTime() + 8_000));
    await stage.report(ctx, EMPTY_REPORT);
    vi.setSystemTime(new Date(t0.getTime() + 30_000));
    await stage.report(ctx, EMPTY_REPORT);

    const attempts = ctx.state.reviewRepairAttempts ?? [];
    expect(attempts[0]?.attemptDurationMs).toBe(8_000);
    expect(attempts[1]?.attemptDurationMs).toBe(22_000);
  });

  it("persists a nonnegative duration for absent, invalid and backward clocks", async () => {
    for (const startedAt of [null, "not-a-timestamp", new Date(Date.now() + 60_000).toISOString()]) {
      const dir = mkdtempSync(join(tmpdir(), "planrev-clock-"));
      const sDir = join(dir, ".story", "sessions", "s1");
      mkdirSync(sDir, { recursive: true });
      setupProject(dir, sDir);
      const ctx = new StageContext(dir, sDir, makeState({
        currentReviewStartedAt: startedAt,
      } as Partial<FullSessionState>), makeRecipe());

      const advance = await stage.report(ctx, EMPTY_REPORT);

      expect(advance).toMatchObject({ action: "retry" });
      const d = ctx.state.reviewRepairAttempts?.[0]?.attemptDurationMs;
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
