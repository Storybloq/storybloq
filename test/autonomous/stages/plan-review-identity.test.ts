/**
 * T-488 Run A at the PLAN_REVIEW stage.
 *
 * Two things are specific to this stage and are what the file is built around.
 *
 * Plan review is ticket-scoped -- `escalatePlanCeiling` handles tickets only --
 * so an issue subject cannot arise, and a ticketless round must record NEITHER
 * identity field rather than a placeholder.
 *
 * And a plan `reject` clears `reviews.plan`, which is the SECOND array-clearing
 * event in the codebase after the code stage's PLAN redirect. It opens the same
 * numbering epoch: round 1 recurs and reproduces an existing artifact filename.
 * It is not left to chance here -- the artifact sink identifies the occupant of
 * that path, sees an attempt that is not this one, and advances the generation
 * before writing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import type { FullSessionState, ReviewRecord } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
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
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open", phase: "p1", order: 10,
    description: "Test", blockedBy: [], parentTicket: null,
  }));
  writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\nA plan the landing path can snapshot.\n");
}

function artifactNames(sessionDir: string): string[] {
  const dir = join(sessionDir, "telemetry", "reviews");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

function artifactAt(sessionDir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sessionDir, "telemetry", "reviews", name), "utf-8")) as Record<string, unknown>;
}

function events(sessionDir: string, type: string): Record<string, unknown>[] {
  const log = join(sessionDir, "events.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf-8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type)
    .map((e) => (e.data ?? e) as Record<string, unknown>);
}

const MINOR = {
  id: "F1", severity: "minor", category: "clarity", description: "tighten this", disposition: "open",
} as const;

describe("PlanReviewStage identity spine (T-488)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "t488-plan-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot, sessionDir);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("record, artifact and event agree on all four ids", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { completedAction: "plan_review_round", verdict: "revise", findings: [MINOR] } as never);

    const record = ctx.state.reviews.plan[0] as ReviewRecord;
    const artifact = artifactAt(sessionDir, "T-001-plan-r1.json");
    const [event] = events(sessionDir, "plan_review");

    expect(record.workItemId).toBe("T-001");
    expect(record.kind).toBe("ticket");
    // Asserted to EXIST before they are compared. `undefined === undefined`
    // holds across all three sinks, so a cross-sink equality check on its own
    // passes most loudly in the case where every join was lost.
    expect(record.reviewAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.itemAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    for (const sink of [artifact, event!]) {
      expect(sink.workItemId).toBe("T-001");
      expect(sink.kind).toBe("ticket");
      expect(sink.reviewAttemptId).toBe(record.reviewAttemptId);
      expect(sink.itemAttemptId).toBe(record.itemAttemptId);
    }
  });

  it("records the spine fields a reader needs, and no ticketId", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, {
      completedAction: "plan_review_round", verdict: "revise", findings: [MINOR],
      reviewer: "codex", reviewerSessionId: "sess-plan",
    } as never);

    const record = ctx.state.reviews.plan[0] as ReviewRecord & { ticketId?: unknown };
    expect(record.ticketId).toBeUndefined();
    expect(record.backend).toBe("codex");
    expect(record.backendRunId).toBe("sess-plan");
    expect(record.backendRunIdKind).toBe("codex-session");
    expect(record.normalizerVersion).toBe(1);
    expect(record.generation).toBe(0);
    expect(record.payloadConsistent).toBe(true);
    expect(record.artifactStatus).toBe("written");
  });

  it("writes NEITHER identity field for a round with no ticket at all", async () => {
    // A placeholder here would either fail validation or collide across items,
    // and an id-shaped "unknown" is a value that reads like an address.
    const ctx = new StageContext(testRoot, sessionDir, makeState({ ticket: null } as Partial<FullSessionState>), makeRecipe());
    await stage.report(ctx, { completedAction: "plan_review_round", verdict: "revise", findings: [MINOR] } as never);

    const record = ctx.state.reviews.plan[0] as ReviewRecord;
    expect(record.workItemId).toBeUndefined();
    expect(record.kind).toBeUndefined();
    expect(record.itemAttemptId).toBeUndefined();
    // The round is still recorded, and still carries a round id.
    expect(record.reviewAttemptId).toEqual(expect.any(String));
  });

  it("preserves raw severities on the plan side too", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, {
      completedAction: "plan_review_round", verdict: "revise",
      findings: [{ ...MINOR, severity: "important" }],
    } as never);

    const findings = artifactAt(sessionDir, "T-001-plan-r1.json").findings as Record<string, unknown>[];
    // `important` is real reviewer vocabulary that the normalizer does not
    // remap, so it lands in a field whose declared type says it cannot.
    expect(findings[0]).toMatchObject({ severity: "important", rawSeverity: "important" });
  });

  it("clears the pending envelope once the round has landed", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { completedAction: "plan_review_round", verdict: "revise", findings: [MINOR] } as never);
    expect(ctx.state.pendingReviewAttempt ?? null).toBeNull();
  });

  it("a REJECT restarts the numbering, and the next round's artifact is not dropped", async () => {
    // The plan-side twin of the code stage's redirect. Round 1 lands, the
    // reject empties `reviews.plan`, and the next round is numbered 1 again --
    // which before this reproduced `T-001-plan-r1.json` and answered `exists`.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, {
      completedAction: "plan_review_round", verdict: "reject", findings: [MINOR],
    } as never);
    expect(artifactNames(sessionDir)).toEqual(["T-001-plan-r1.json"]);
    expect(ctx.state.reviews.plan).toHaveLength(0);

    await stage.report(ctx, {
      completedAction: "plan_review_round", verdict: "revise", findings: [MINOR], notes: "after the rewrite",
    } as never);

    // Both survive, and the second says which generation it belongs to.
    expect(artifactNames(sessionDir)).toEqual(["T-001-plan-r1-g1.json", "T-001-plan-r1.json"]);
    const record = ctx.state.reviews.plan[0] as ReviewRecord;
    expect(record.round).toBe(1);
    expect(record.generation).toBe(1);
    expect(record.artifactStatus).toBe("written");
  });

  it("keeps the whole post-reject epoch on one generation, not just the round that collided", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { completedAction: "plan_review_round", verdict: "reject", findings: [MINOR] } as never);
    await stage.report(ctx, {
      completedAction: "plan_review_round", verdict: "revise", findings: [MINOR], notes: "g1 r1",
    } as never);
    await stage.report(ctx, {
      completedAction: "plan_review_round", verdict: "revise", findings: [MINOR], notes: "g1 r2",
    } as never);

    expect(artifactNames(sessionDir)).toEqual([
      "T-001-plan-r1-g1.json", "T-001-plan-r1.json", "T-001-plan-r2-g1.json",
    ]);
    const rounds = ctx.state.reviews.plan as ReviewRecord[];
    expect(rounds.map((r) => r.generation)).toEqual([1, 1]);
  });
});
