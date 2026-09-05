/**
 * ISS-1114: the contradictory change-request guard, CODE_REVIEW side.
 *
 * A `revise` or `request_changes` verdict carrying zero findings states that
 * changes are required and supplies nothing to act on. Before this guard it
 * reached the `nextAction` ladder as an ordinary change-request and either
 * routed to IMPLEMENT with nothing to implement or, at or above the T-461
 * landing floor, landed at FINALIZE.
 *
 * FIXTURE NOTE, and it matters for how these tests are read. The field corpus
 * that motivated this work is LobbyKit session 3d3e637d: T-131 code rounds 1 to
 * 3 are each `request_changes` with `findingCount: 0`, each followed by a
 * CODE_REVIEW to IMPLEMENT back-transition, and round 4 approved with the same
 * zero findings; the same session carries 19 consecutive empty plan revises on
 * T-158 (rounds 4 to 22). That session PREDATES the findings-clean landing
 * check, which is why it ran on instead of landing. It is evidence for the
 * PREDICATE and is deliberately NOT replayed from disk here: the guard needs
 * only a verdict and a finding count, so the states below are synthesized
 * rather than copying another project's session corpus into this repo.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import { readSession } from "../../../src/autonomous/session.js";
import { SessionStateSchema } from "../../../src/autonomous/session-types.js";
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
    currentReviewStartedAt: now,
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

function finding(severity: Finding["severity"], extra: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    severity,
    category: "correctness",
    description: "Follow-up needed",
    disposition: "open",
    ...extra,
  };
}

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const d of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(storyDir, d), { recursive: true });
  }
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
    date: "2026-09-05",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
}

/** Hash-form id, matching how post-migration issues are actually filed. */
const ISSUE_ID = "i-abc1230000000500";

const EMPTY_REPORT = { completedAction: "code_review_round", verdict: "revise", findings: [] } as const;

function artifactCount(sessionDir: string): number {
  const dir = join(sessionDir, "telemetry", "reviews");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
}

function codeReviewEventCount(sessionDir: string): number {
  const log = join(sessionDir, "events.log");
  if (!existsSync(log)) return 0;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const text = require("node:fs").readFileSync(log, "utf-8") as string;
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    .filter((e: { type?: string }) => e.type === "code_review").length;
}

describe("CodeReviewStage empty change-request guard (ISS-1114)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "code-review-empty-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("retries an empty revise without counting the round, writing an artifact or emitting an event", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect((advance as { instruction: string }).instruction)
      .toContain("requests changes but supplies no actionable changes");
    // The three consequences of guard POSITION, asserted rather than assumed.
    expect(ctx.state.reviews.code).toHaveLength(0);
    expect(artifactCount(sessionDir)).toBe(0);
    expect(codeReviewEventCount(sessionDir)).toBe(0);
    expect(ctx.state.reviewRepairAttempts).toHaveLength(1);
    expect(ctx.state.reviewRepairAttempts?.[0]).toMatchObject({
      workItemId: "T-001", kind: "ticket", stage: "code", round: 1, attempt: 1, verdict: "revise",
    });
  });

  it("treats request_changes identically to revise", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round", verdict: "request_changes", findings: [],
    });

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.reviews.code).toHaveLength(0);
    expect(ctx.state.reviewRepairAttempts?.[0]).toMatchObject({ attempt: 1, verdict: "request_changes" });
  });

  it("records a second attempt for the same round", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    await stage.report(ctx, EMPTY_REPORT);
    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.reviewRepairAttempts).toHaveLength(2);
    expect(ctx.state.reviewRepairAttempts?.[1]).toMatchObject({ round: 1, attempt: 2 });
    expect(ctx.state.reviews.code).toHaveLength(0);
  });

  it("parks on the third empty payload with a schema-valid empty-verdict record", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(4));

    await stage.report(ctx, EMPTY_REPORT);
    await stage.report(ctx, EMPTY_REPORT);
    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance.action).not.toBe("retry");
    const escalation = ctx.state.pendingCeilingEscalation;
    expect(escalation).toMatchObject({
      workItemId: "T-001",
      kind: "ticket",
      trigger: "empty-verdict",
      repairAttempts: 2,
      unresolvedCritical: 0,
      unresolvedMajor: 0,
      round: 1,
      findings: [],
    });
    // Delta 1: `maxReviewRounds` and `ceiling` are REQUIRED and must be the real
    // values, not sentinels. Round-tripping the persisted state through the
    // schema is what makes a missing required field fail HERE rather than at
    // runtime in a live session.
    expect(escalation?.maxReviewRounds).toBeGreaterThan(0);
    expect(escalation?.ceiling).toBeGreaterThan(0);
    const persisted = readSession(sessionDir);
    expect(() => SessionStateSchema.parse(persisted)).not.toThrow();
    expect(persisted?.pendingCeilingEscalation?.trigger).toBe("empty-verdict");
    // The reason has to carry the ambiguity, not resolve it.
    expect(escalation?.reason).toContain("agent");
    expect(escalation?.reason).toContain("2 time(s)");
    expect(escalation?.reason).toContain("cannot distinguish");
  });

  it("still routes a revise with one minor finding to IMPLEMENT", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(4));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round", verdict: "revise", findings: [finding("minor")],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.reviewRepairAttempts ?? []).toHaveLength(0);
    expect(ctx.state.reviews.code).toHaveLength(2);
  });

  it("still retries an approve carrying a major finding (ISS-035 preserved)", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(3));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round", verdict: "approve", findings: [finding("major")],
    });

    expect(advance).toMatchObject({ action: "retry" });
    expect((advance as { instruction: string }).instruction).toContain("Contradictory review payload");
    expect(ctx.state.reviewRepairAttempts ?? []).toHaveLength(0);
  });

  it("does not let an empty payload land at FINALIZE at the landing floor", async () => {
    // At maxReviewRounds 2 this round is at the forced-landing floor, so before
    // the guard an empty revise reached FINALIZE: the item would have shipped on
    // a review that requested changes and named none.
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(2));

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.landingDecision).toBeNull();
    expect(ctx.state.reviews.code).toHaveLength(1);
  });

  it("does not count another work item's attempts toward this item's cap", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviewRepairAttempts: [
        { workItemId: "T-999", kind: "ticket", stage: "code", round: 1, attempt: 1, verdict: "revise", reviewer: "agent", at: new Date().toISOString(), attemptDurationMs: 0 },
        { workItemId: "T-999", kind: "ticket", stage: "code", round: 1, attempt: 2, verdict: "revise", reviewer: "agent", at: new Date().toISOString(), attemptDurationMs: 0 },
      ],
    } as Partial<FullSessionState>), makeRecipe(3));

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.pendingCeilingEscalation ?? null).toBeNull();
  });

  it("does not count a plan-stage attempt toward the code-stage cap", async () => {
    const at = new Date().toISOString();
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviewRepairAttempts: [
        { workItemId: "T-001", kind: "ticket", stage: "plan", round: 1, attempt: 1, verdict: "revise", reviewer: "agent", at, attemptDurationMs: 0 },
        { workItemId: "T-001", kind: "ticket", stage: "plan", round: 1, attempt: 2, verdict: "revise", reviewer: "agent", at, attemptDurationMs: 0 },
      ],
    } as Partial<FullSessionState>), makeRecipe(3));

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.pendingCeilingEscalation ?? null).toBeNull();
  });

  it("uses the durable counter, so attempts do not carry across a generation reset", async () => {
    // The regression this test exists for: `roundNum` is `reviews.code.length +
    // 1` and a plan redirect CLEARS that array, so an array-derived key would
    // let two attempts banked before the reset be found by the first empty
    // payload after it, parking a fresh round on the spot.
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      codeReviewRoundCounter: { workItemId: "T-001", kind: "ticket", completedRounds: 3 },
      reviewRepairAttempts: [
        { workItemId: "T-001", kind: "ticket", stage: "code", round: 1, attempt: 1, verdict: "revise", reviewer: "agent", at: new Date().toISOString(), attemptDurationMs: 0 },
        { workItemId: "T-001", kind: "ticket", stage: "code", round: 1, attempt: 2, verdict: "revise", reviewer: "agent", at: new Date().toISOString(), attemptDurationMs: 0 },
      ],
    } as Partial<FullSessionState>), makeRecipe(6));

    const advance = await stage.report(ctx, EMPTY_REPORT);

    // Counter says 3 completed, so this is pending round 4, not round 1.
    expect(advance).toMatchObject({ action: "retry" });
    expect(ctx.state.pendingCeilingEscalation ?? null).toBeNull();
    expect(ctx.state.reviewRepairAttempts?.at(-1)).toMatchObject({ round: 4, attempt: 1 });
  });

  it("numbers a counterless session from 1, matching how the counter initializes", async () => {
    // Fallback must be 1, NOT `reviews.code.length + 1`. `nextRoundCounter`
    // initializes a missing counter to completedRounds 1, so a length-based
    // fallback here would collide with the very next counted round.
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
      codeReviewRoundCounter: null,
    } as Partial<FullSessionState>), makeRecipe(6));

    await stage.report(ctx, EMPTY_REPORT);

    expect(ctx.state.reviewRepairAttempts?.[0]).toMatchObject({ round: 1, attempt: 1 });
  });

  it("falls through unchanged when there is no work item", async () => {
    // Delta 2: `decideCeiling` treats this state as reachable and fails safe by
    // declining to park. The guard matches that rather than keying an attempt
    // record on `undefined`.
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      ticket: null, currentIssue: null,
    } as Partial<FullSessionState>), makeRecipe(3));

    const advance = await stage.report(ctx, EMPTY_REPORT);

    expect(advance).not.toMatchObject({ action: "retry", instruction: expect.stringContaining("supplies no actionable changes") });
    expect(ctx.state.reviewRepairAttempts ?? []).toHaveLength(0);
    expect(ctx.state.pendingCeilingEscalation ?? null).toBeNull();
  });

  it("keeps attempts across a state reload from disk", async () => {
    // Same-context assertions cannot catch an attempt record that fails to
    // serialize: the in-memory snapshot would still show it.
    const ctx1 = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(4));
    await stage.report(ctx1, EMPTY_REPORT);

    const reloaded1 = readSession(sessionDir);
    expect(reloaded1?.reviewRepairAttempts).toHaveLength(1);

    const ctx2 = new StageContext(testRoot, sessionDir, reloaded1!, makeRecipe(4));
    await stage.report(ctx2, EMPTY_REPORT);

    const reloaded2 = readSession(sessionDir);
    expect(reloaded2?.reviewRepairAttempts).toHaveLength(2);

    const ctx3 = new StageContext(testRoot, sessionDir, reloaded2!, makeRecipe(4));
    await stage.report(ctx3, EMPTY_REPORT);

    const reloaded3 = readSession(sessionDir);
    expect(reloaded3?.pendingCeilingEscalation).toMatchObject({ trigger: "empty-verdict", repairAttempts: 2 });
  });

  it("resumes a park interrupted after the escalation write without double-counting", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(4));
    await stage.report(ctx, EMPTY_REPORT);
    await stage.report(ctx, EMPTY_REPORT);

    // Interrupt the park AFTER the escalation record is written. The record is
    // what makes the next call resume instead of reprocessing the payload.
    const boom = vi.spyOn(ctx, "drainDeferrals").mockRejectedValueOnce(new Error("interrupted"));
    await expect(stage.report(ctx, EMPTY_REPORT)).rejects.toThrow("interrupted");
    boom.mockRestore();

    const afterCrash = readSession(sessionDir);
    expect(afterCrash?.pendingCeilingEscalation).toMatchObject({ trigger: "empty-verdict", completed: false });
    const attemptsAtCrash = afterCrash?.reviewRepairAttempts?.length ?? 0;

    const resumeCtx = new StageContext(testRoot, sessionDir, afterCrash!, makeRecipe(4));
    const resumed = await stage.report(resumeCtx, EMPTY_REPORT);

    // The resume has to FINISH the park, not merely decline to make things
    // worse. Asserting only "nothing extra happened" is satisfied by a resume
    // that returns retry forever, which parks nothing: the transition and the
    // completion marker are what separate the two.
    expect(resumed.action).toBe("goto");
    expect((resumed as { target: string }).target).toBe("HANDOVER");
    expect(resumeCtx.state.pendingCeilingEscalation?.completed).toBe(true);
    // And it must not bank another attempt, count a round, or write an artifact.
    expect(resumeCtx.state.reviewRepairAttempts?.length ?? 0).toBe(attemptsAtCrash);
    expect(resumeCtx.state.reviews.code).toHaveLength(0);
    expect(artifactCount(sessionDir)).toBe(0);
  });

  it("measures per-attempt intervals rather than cumulative round time", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-09-05T00:00:00.000Z");
    vi.setSystemTime(t0);
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      currentReviewStartedAt: t0.toISOString(),
    }), makeRecipe(6));

    vi.setSystemTime(new Date(t0.getTime() + 10_000));
    await stage.report(ctx, EMPTY_REPORT);
    vi.setSystemTime(new Date(t0.getTime() + 25_000));
    await stage.report(ctx, EMPTY_REPORT);

    const attempts = ctx.state.reviewRepairAttempts ?? [];
    expect(attempts[0]?.attemptDurationMs).toBe(10_000);
    // 15s since attempt 1, NOT 25s since the round started.
    expect(attempts[1]?.attemptDurationMs).toBe(15_000);
  });

  it("persists a nonnegative duration for absent, invalid and backward clocks", async () => {
    for (const startedAt of [null, "not-a-timestamp", new Date(Date.now() + 60_000).toISOString()]) {
      const dir = mkdtempSync(join(tmpdir(), "code-review-clock-"));
      const sDir = join(dir, ".story", "sessions", "s1");
      mkdirSync(sDir, { recursive: true });
      setupProject(dir);
      const ctx = new StageContext(dir, sDir, makeState({
        currentReviewStartedAt: startedAt,
      } as Partial<FullSessionState>), makeRecipe(4));

      const advance = await stage.report(ctx, EMPTY_REPORT);

      expect(advance).toMatchObject({ action: "retry" });
      const d = ctx.state.reviewRepairAttempts?.[0]?.attemptDurationMs;
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parks an issue-fix item too, since escalation dispatches on the current item", async () => {
    // The issue has to EXIST in the ledger, resolved, and be provably this
    // session's. `parkCurrentIssue` refuses to touch an issue it cannot prove
    // ownership of: a missing record takes the `not-ours` branch, which still
    // returns `goto HANDOVER` but writes nothing. Asserting only the escalation
    // record would therefore pass against an issue park that never parked
    // anything -- so the ledger outcome is asserted too.
    //
    // Legacy shape deliberately (no `resolutionEpoch`): status "resolved" plus
    // no stamped epoch is the pre-Amendment-A5 ownership proof, and it keeps
    // this test about the empty-verdict trigger rather than about epoch
    // matching, which `park-issue.test.ts` already owns.
    writeFileSync(join(testRoot, ".story", "issues", `${ISSUE_ID}.json`), JSON.stringify({
      id: ISSUE_ID, displayId: "ISS-500", title: "Issue under fix", status: "resolved",
      severity: "high", components: [], impact: "test", resolution: "fixed in this session",
      location: [], discoveredDate: "2026-09-05", resolvedDate: "2026-09-05",
      relatedTickets: [], order: 10, phase: "p1",
    }));

    const ctx = new StageContext(testRoot, sessionDir, makeState({
      ticket: null,
      currentIssue: { id: ISSUE_ID, displayId: "ISS-500", title: "Issue under fix" },
    } as Partial<FullSessionState>), makeRecipe(4));

    await stage.report(ctx, EMPTY_REPORT);
    await stage.report(ctx, EMPTY_REPORT);
    const advance = await stage.report(ctx, EMPTY_REPORT);

    // The park has to LAND, not merely be requested.
    expect(advance).toMatchObject({ action: "goto", target: "HANDOVER" });
    expect(ctx.state.pendingCeilingEscalation).toMatchObject({
      workItemId: ISSUE_ID, kind: "issue", trigger: "empty-verdict",
      repairAttempts: 2, completed: true,
    });
    // The ledger effect: reopened, so the next session can pick it back up.
    const parked = JSON.parse(
      readFileSync(join(testRoot, ".story", "issues", `${ISSUE_ID}.json`), "utf-8"),
    ) as Record<string, unknown>;
    expect(parked.status).toBe("open");
    // And the escalation carried the reason forward rather than a bare label.
    expect(ctx.state.pendingCeilingEscalation?.reason).toContain("ISS-500");
    expect(ctx.state.pendingCeilingEscalation?.reason).toContain("cannot distinguish");
  });

  it("leaves an empty reject alone, which is a different ticket's scope", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      reviews: { plan: [], code: [review(1)] },
    }), makeRecipe(3));

    const advance = await stage.report(ctx, {
      completedAction: "code_review_round", verdict: "reject", findings: [],
    });

    expect(advance).toMatchObject({ action: "back", target: "IMPLEMENT" });
    expect(ctx.state.reviewRepairAttempts ?? []).toHaveLength(0);
  });
});
