/**
 * T-488 Run A at the CODE_REVIEW stage: the record, the artifact and the event
 * agree, and a PLAN redirect no longer destroys what it clears.
 *
 * The agreement is the point of the ticket. The fleet audit found 667 records
 * carrying a backend session id and zero exact review-to-turn joins, and 422
 * review events across 130 local sessions carrying no item id at all -- three
 * sinks per round, none of which could be joined to the others. A field chosen
 * wrongly here is unrecoverable, because every record already written stays
 * unjoinable no matter what is fixed later.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import type { FullSessionState, ReviewRecord } from "../../../src/autonomous/session-types.js";

const ISSUE_ID = "i-abc1230000000500";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 1,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null, resolvedIssues: [],
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    landingDecision: null, currentReviewStartedAt: now,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(maxReviewRounds = 3): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: { CODE_REVIEW: { maxReviewRounds } },
    dirtyFileHandling: "block", branchStrategy: "none",
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

function artifacts(sessionDir: string): Record<string, unknown>[] {
  const dir = join(sessionDir, "telemetry", "reviews");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as Record<string, unknown>);
}

function artifactNames(sessionDir: string): string[] {
  const dir = join(sessionDir, "telemetry", "reviews");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
}

function events(sessionDir: string, type: string): Record<string, unknown>[] {
  const log = join(sessionDir, "events.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf-8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type)
    .map((e) => (e.data ?? e) as Record<string, unknown>);
}

const APPROVE = { completedAction: "code_review_round", verdict: "approve", findings: [] } as const;

/**
 * A context that remembers every state write, so a test can rewind to a real
 * intermediate state instead of inventing one.
 */
/**
 * Records each write AND the complete state it produced.
 *
 * The snapshot is what makes a crash reproducible. Rewinding by spreading the
 * FINAL state and patching two fields back keeps every later change the round
 * made -- the advanced counter, the cleared `currentReviewStartedAt` -- so the
 * "crash" starts from a state no crash could have left.
 */
class RecordingContext extends StageContext {
  readonly writes: Record<string, unknown>[] = [];
  readonly snapshots: FullSessionState[] = [];
  override writeState(updates: Partial<FullSessionState>, opts?: { refreshStatus?: boolean }): FullSessionState {
    this.writes.push(updates as Record<string, unknown>);
    const next = super.writeState(updates, opts);
    this.snapshots.push(structuredClone(next) as FullSessionState);
    return next;
  }
}

describe("CodeReviewStage identity spine (T-488)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "t488-code-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("record, artifact and event agree on all four ids for a ticket round", () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    return stage.report(ctx, APPROVE).then(() => {
      const record = ctx.state.reviews.code[0] as ReviewRecord;
      const [artifact] = artifacts(sessionDir);
      const [event] = events(sessionDir, "code_review");

      expect(record.workItemId).toBe("T-001");
      expect(record.kind).toBe("ticket");
      expect(record.reviewAttemptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(record.itemAttemptId).toMatch(/^[0-9a-f-]{36}$/);

      for (const sink of [artifact, event]) {
        expect(sink!.workItemId).toBe(record.workItemId);
        expect(sink!.kind).toBe(record.kind);
        expect(sink!.reviewAttemptId).toBe(record.reviewAttemptId);
        expect(sink!.itemAttemptId).toBe(record.itemAttemptId);
      }
    });
  });

  it("an issue-fix round records kind 'issue', and no round writes ticketId", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      ticket: null,
      currentIssue: { id: ISSUE_ID, displayId: "ISS-500", title: "An issue", severity: "high" },
    } as Partial<FullSessionState>), makeRecipe());

    await stage.report(ctx, APPROVE);

    const record = ctx.state.reviews.code[0] as ReviewRecord & { ticketId?: unknown };
    expect(record.workItemId).toBe(ISSUE_ID);
    expect(record.kind).toBe("issue");
    expect(record.ticketId).toBeUndefined();
    expect(artifacts(sessionDir)[0]!.ticketId).toBeUndefined();
    expect(artifacts(sessionDir)[0]!.kind).toBe("issue");
  });

  it("records the backend enum beside the free-text reviewer, never replacing it", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { ...APPROVE, reviewer: "codex + adversarial Opus agent (dual)" });

    const record = ctx.state.reviews.code[0] as ReviewRecord;
    expect(record.reviewer).toBe("codex + adversarial Opus agent (dual)");
    expect(record.backend).toBe("mixed");
  });

  it("carries the codex thread id as the backend run id, with its kind", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { ...APPROVE, reviewer: "codex", reviewerSessionId: "sess-abc" });

    const record = ctx.state.reviews.code[0] as ReviewRecord;
    // The existing join key is untouched -- 644 of 667 fleet values match the
    // external thread DB, so re-pointing it would destroy the one join that
    // partly works.
    expect(record.codexSessionId).toBe("sess-abc");
    expect(record.backendRunId).toBe("sess-abc");
    expect(record.backendRunIdKind).toBe("codex-session");
    expect(record.backendTurnId).toBeUndefined();
  });

  it("preserves the raw severity a reviewer reported", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, {
      completedAction: "code_review_round", verdict: "revise",
      findings: [
        { id: "F1", severity: "blocking", category: "c", description: "d", disposition: "deferred" },
        { id: "F2", severity: "high", category: "c", description: "d", disposition: "open" },
      ],
    } as never);

    const findings = artifacts(sessionDir)[0]!.findings as Record<string, unknown>[];
    // `blocking` is projected onto the legacy display value (ISS-823)...
    expect(findings[0]).toMatchObject({ severity: "critical", rawSeverity: "blocking" });
    // ...while `high` passes straight through a field whose declared type says
    // it cannot, which is the case that makes the raw copy worth having.
    expect(findings[1]).toMatchObject({ severity: "high", rawSeverity: "high" });
    expect(artifacts(sessionDir)[0]!.normalizerVersion).toBe(1);
  });

  it("records payloadConsistent and the artifact outcome", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, APPROVE);

    const record = ctx.state.reviews.code[0] as ReviewRecord;
    expect(record.payloadConsistent).toBe(true);
    expect(record.artifactStatus).toBe("written");
    expect(record.generation).toBe(0);
  });

  it("records unknown provenance rather than fabricating a model", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, APPROVE);

    const record = ctx.state.reviews.code[0] as ReviewRecord;
    expect(record.reviewerIdentity).toEqual({ source: "unknown", evidence: "none" });
    expect(record.implementer).toEqual({ source: "unknown", evidence: "none" });
  });

  it("records a supplied reviewer model as CONFIGURED and its source as UNKNOWN", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { ...APPROVE, reviewerModel: "gpt-6-astra", reviewerTier: "inspector" } as never);

    const record = ctx.state.reviews.code[0] as ReviewRecord;
    expect(record.reviewerIdentity).toMatchObject({
      model: "gpt-6-astra", tier: "inspector", source: "unknown", evidence: "configured",
    });
  });

  it("clears the pending envelope once the round has landed", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, APPROVE);
    expect(ctx.state.pendingReviewAttempt ?? null).toBeNull();
  });

  it("does not double-count when the identical verdict is re-reported after a lost record", async () => {
    // The crash-replay at stage level, rewound to the exact state a crash
    // between the artifact and the state record would leave: the envelope is
    // still set, the artifact is on disk, and the record never landed.
    //
    // The envelope is CAPTURED from the real write rather than reconstructed,
    // because a reconstructed one would carry a fingerprint this code never
    // computed -- and it would then be treated as a different payload, which is
    // correct behavior and would make the test pass for the wrong reason.
    const first = new RecordingContext(testRoot, sessionDir, makeState(), makeRecipe());
    await stage.report(first, { ...APPROVE, notes: "same notes" });

    // The snapshot taken RIGHT AFTER the envelope was persisted, which is the
    // whole state a crash in that window would leave -- not the final state
    // with two fields patched backwards.
    const at = first.writes.findIndex((w) => w.pendingReviewAttempt);
    expect(at).toBeGreaterThanOrEqual(0);
    const crashState = first.snapshots[at]!;
    const envelope = crashState.pendingReviewAttempt;
    expect(envelope).toBeTruthy();
    expect(crashState.reviews.code).toHaveLength(0);
    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1.json"]);

    const rewound = new StageContext(testRoot, sessionDir, crashState, makeRecipe());
    await stage.report(rewound, { ...APPROVE, notes: "same notes" });

    // ONE round, ONE artifact, adopted rather than rewritten or renumbered.
    expect(rewound.state.reviews.code).toHaveLength(1);
    expect((rewound.state.reviews.code[0] as ReviewRecord).reviewAttemptId)
      .toBe((envelope as { reviewAttemptId: string }).reviewAttemptId);
    expect((rewound.state.reviews.code[0] as ReviewRecord).artifactStatus).toBe("exists");
    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1.json"]);
  });

  it("treats a genuine SECOND report of the same verdict as a second round", async () => {
    // The other half of the same rule. Once the envelope is cleared the round
    // is finished, so an identical payload arriving again is a new round -- not
    // a replay to be swallowed.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(12));
    await stage.report(ctx, { ...APPROVE, verdict: "revise", findings: [
      { id: "F1", severity: "minor", category: "c", description: "d", disposition: "open" },
    ] } as never);
    await stage.report(ctx, { ...APPROVE, verdict: "revise", findings: [
      { id: "F1", severity: "minor", category: "c", description: "d", disposition: "open" },
    ] } as never);

    expect(ctx.state.reviews.code).toHaveLength(2);
    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1.json", "T-001-code-r2.json"]);
  });
});

describe("PLAN redirect: retention and the generation boundary (T-488 D9/D3)", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  const REDIRECT = {
    completedAction: "code_review_round", verdict: "revise",
    findings: [{
      id: "F1", severity: "critical", category: "design",
      description: "the approach is wrong", disposition: "open", recommendedNextState: "PLAN",
    }],
  } as const;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "t488-redirect-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("appends a retention entry preserving realizedRisk and the lens history", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState({
      ticket: { id: "T-001", displayId: "T-001", title: "T", claimed: true, risk: "low", realizedRisk: "high" },
      lensReviewHistory: [{
        ticketId: "T-001", stage: "CODE_REVIEW", lens: "security", category: "authz",
        severity: "critical", disposition: "accepted", description: "why sixty rounds went nowhere",
        timestamp: new Date().toISOString(),
      }],
    } as Partial<FullSessionState>), makeRecipe(12));

    await stage.report(ctx, REDIRECT as never);

    // The clear itself is unchanged -- it is right for a replan.
    expect(ctx.state.lensReviewHistory).toEqual([]);
    expect(ctx.state.ticket?.realizedRisk).toBeUndefined();
    // ...and what it used to destroy is now on record.
    const history = ctx.state.reviewGenerationHistory ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ generation: 0, realizedRisk: "high", reason: "plan-redirect" });
    expect((history[0]!.lensReviewHistory as unknown[])).toHaveLength(1);
  });

  it("OPENS a new generation, so the next round's artifact is not dropped", async () => {
    // The westworld `08a52602` mechanism, in miniature: round 1, a redirect,
    // then round 1 again. Before this the second r1 reproduced the first's
    // filename, `writeReviewVerdict` answered `exists`, and the round vanished.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(12));
    await stage.report(ctx, REDIRECT as never);
    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1.json"]);
    expect((ctx.state.itemAttempt as { generation: number }).generation).toBe(1);

    // A fresh round in the new generation, numbered 1 again because the
    // redirect cleared the array `roundNum` is derived from.
    await stage.report(ctx, { ...APPROVE, notes: "second generation" });

    expect(artifactNames(sessionDir)).toEqual(["T-001-code-r1-g1.json", "T-001-code-r1.json"]);
    const record = ctx.state.reviews.code[0] as ReviewRecord;
    expect(record.round).toBe(1);
    expect(record.generation).toBe(1);
    expect(record.artifactStatus).toBe("written");
  });

  it("clears the envelope on the redirect path too", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(12));
    await stage.report(ctx, REDIRECT as never);
    expect(ctx.state.pendingReviewAttempt ?? null).toBeNull();
  });

  it("carries the ids on the redirect's own event", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe(12));
    await stage.report(ctx, REDIRECT as never);
    const [event] = events(sessionDir, "code_review");
    expect(event!.workItemId).toBe("T-001");
    expect(event!.kind).toBe("ticket");
    expect(event!.reviewAttemptId).toEqual(expect.any(String));
    expect(event!.redirectedTo).toBe("PLAN");
  });
});
