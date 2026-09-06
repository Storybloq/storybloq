/**
 * ISS-1115 step 6: the effective-blocker predicate, at every decision site.
 *
 * THE FIXTURES ARE PAIRS, and that is the whole design. Each pair differs in
 * exactly one field -- `originClass` -- and is identical in severity, category,
 * description and disposition. So a test that passes because the site is
 * broken in some general way (blocking everything, blocking nothing) fails its
 * partner. Only a site that reads provenance passes both.
 *
 * BOTH HALVES ARE REQUIRED EVERYWHERE. "Reintroduced blocks" alone is passed by
 * a predicate that blocks unconditionally, which would stall every session in
 * the fleet; "clean lands" alone is passed by the code as it was before this
 * item. The pen's three clauses are the same point: block, land, and say why.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { readFileSync, readdirSync } from "node:fs";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { verdictFilename, computeContentHash, type ReviewVerdictArtifact } from "../../../src/autonomous/review-verdict.js";

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
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
    ticket: { id: "T-001", displayId: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    currentIssue: null, resolvedIssues: [],
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    landingDecision: null, currentReviewStartedAt: now,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: { CODE_REVIEW: { maxReviewRounds: 5 } },
    dirtyFileHandling: "block", branchStrategy: "none",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"] },
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

function seedArtifact(sessionDir: string, o: {
  round: number; stage?: string; findings?: readonly unknown[];
  backendRunId?: string; backendRunIdKind?: string;
}): void {
  const stage = o.stage ?? "code";
  const findings = o.findings ?? [];
  const artifact = {
    target: "T-001", stage, round: o.round, reviewer: "codex", verdict: "revise",
    findingsCount: findings.length,
    severityCounts: { critical: 0, major: findings.length, minor: 0, suggestion: 0 },
    startedAt: "2026-09-05T00:00:00.000Z", durationMs: 1, summary: "s",
    findings, timestamp: "2026-09-05T00:00:01.000Z", generation: 0,
    ...(o.backendRunId === undefined ? {} : { backendRunId: o.backendRunId }),
    ...(o.backendRunIdKind === undefined ? {} : { backendRunIdKind: o.backendRunIdKind }),
  } as ReviewVerdictArtifact;
  const dir = join(sessionDir, "telemetry", "reviews");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, verdictFilename("T-001", stage, o.round, 0)),
    JSON.stringify({ ...artifact, _contentHash: computeContentHash(artifact) }),
    "utf-8",
  );
}


import {
  outstandingCeilingFindings,
} from "../../../src/autonomous/stages/code-review-ceiling.js";
import { findingIsUnresolved } from "../../../src/autonomous/review-identity.js";
import { SessionStateSchema } from "../../../src/autonomous/session-types.js";

/**
 * The pair. A major finding the reviewer marked `addressed`, twice over: once
 * where the history agrees, once where it says this exact finding was reported
 * fixed before and came back.
 */
const ADDRESSED_CLEAN = {
  id: "F1", severity: "major", category: "correctness",
  description: "the retry path swallows the error", disposition: "addressed",
  originClass: "unchanged", sinceRound: 1,
};
const ADDRESSED_REINTRODUCED = { ...ADDRESSED_CLEAN, originClass: "reintroduced" };

const CRITICAL_CLEAN = { ...ADDRESSED_CLEAN, id: "F2", severity: "critical" };
const CRITICAL_REINTRODUCED = { ...CRITICAL_CLEAN, originClass: "reintroduced" };

const round = (verdict: string, findings: readonly unknown[]) =>
  ({ completedAction: "code_review_round", verdict, reviewer: "codex", findings }) as never;
const planRound = (verdict: string, findings: readonly unknown[]) =>
  ({ completedAction: "plan_review_round", verdict, reviewer: "codex", findings }) as never;

function latestArtifact(sessionDir: string): Record<string, unknown> {
  const dir = join(sessionDir, "telemetry", "reviews");
  const files = readdirSync(dir).sort();
  return JSON.parse(readFileSync(join(dir, files[files.length - 1]!), "utf-8"));
}

describe("the predicate itself", () => {
  it("a settling disposition is overridden by reintroduction, and only by it", () => {
    expect(findingIsUnresolved(ADDRESSED_CLEAN)).toBe(false);
    expect(findingIsUnresolved(ADDRESSED_REINTRODUCED)).toBe(true);
    expect(findingIsUnresolved({ ...ADDRESSED_CLEAN, disposition: "deferred" })).toBe(false);
    expect(findingIsUnresolved({ ...ADDRESSED_REINTRODUCED, disposition: "deferred" })).toBe(true);
  });

  it("an unreadable label blocks too, because a claim that cannot be checked is not a settlement", () => {
    expect(findingIsUnresolved({ ...ADDRESSED_CLEAN, originClass: "sort-of-new" })).toBe(true);
    expect(findingIsUnresolved({ ...ADDRESSED_CLEAN, originClass: 7 })).toBe(true);
  });

  it("an UNLABELLED finding does not block, so nothing regresses before the label exists", () => {
    // The metadata gate handles a missing label; this predicate must not also
    // punish it, or every pre-ISS-1115 session in flight would stop landing.
    const { originClass: _drop, ...unlabelled } = ADDRESSED_CLEAN;
    expect(findingIsUnresolved(unlabelled)).toBe(false);
  });

  it("open and contested are unresolved regardless of provenance, exactly as before", () => {
    expect(findingIsUnresolved({ ...ADDRESSED_CLEAN, disposition: "open" })).toBe(true);
    expect(findingIsUnresolved({ ...ADDRESSED_CLEAN, disposition: "contested" })).toBe(true);
  });
});

describe("SITE 1+2: the approve guard and the counts, on the CODE stage", () => {
  let testRoot: string; let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-blocker-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("BLOCKS an approve carrying a reintroduced finding", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, round("approve", [ADDRESSED_REINTRODUCED]));

    expect(advance.action).toBe("retry");
    if (advance.action === "retry") expect(advance.instruction).toContain("Contradictory review payload");
  });

  it("LANDS the identical approve when the finding is clean", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const advance = await stage.report(ctx, round("approve", [ADDRESSED_CLEAN]));

    expect(advance.action).not.toBe("retry");
  });

  it("counts a reintroduced-and-addressed critical as unresolved, and a clean one as not", async () => {
    // `unresolvedCriticalCount` is what `forcedLanding` reads through
    // `hasUnresolvedCritical`, and it is written durably onto the artifact, so
    // this pins the forced-landing input at the point it is recorded.
    const ctxA = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await ctxA.writeState({});
    await new CodeReviewStage().report(ctxA, round("revise", [CRITICAL_REINTRODUCED]));
    expect(latestArtifact(sessionDir).unresolvedCriticalCount).toBe(1);

    rmSync(join(sessionDir, "telemetry"), { recursive: true, force: true });
    const ctxB = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    await new CodeReviewStage().report(ctxB, round("revise", [CRITICAL_CLEAN]));
    expect(latestArtifact(sessionDir).unresolvedCriticalCount).toBe(0);
  });
});

describe("SITE 3: the clean-landing ladder, on the PLAN stage", () => {
  let testRoot: string; let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-planland-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
    // The landing path snapshots the approved plan, so the file has to be
    // there or the stage retries before the ladder's decision is observable.
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\nDo the thing.\n", "utf-8");
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("a revise whose findings are ALL addressed lands at IMPLEMENT when they are clean", async () => {
    // The plan ladder reaches `!hasCriticalOrMajor && roundNum >= minRounds`
    // before it reaches `isRevise`, so an all-addressed revise is the clean
    // landing this site performs. That is the behaviour that must survive.
    const state = makeState({ state: "PLAN_REVIEW" } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, planRound("revise", [ADDRESSED_CLEAN]));

    // `advance` IS the landing: the stage leaves PLAN_REVIEW for the next
    // pipeline stage. Asserted on the action rather than on the string
    // "IMPLEMENT", which the payload does not carry -- the first draft looked
    // for it and its partner below then passed trivially, since an assertion
    // that a substring is ABSENT is satisfied by every other outcome too.
    expect(advance.action).toBe("advance");
  });

  it("the SAME revise does not land when the finding was reintroduced", async () => {
    const state = makeState({ state: "PLAN_REVIEW" } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, planRound("revise", [ADDRESSED_REINTRODUCED]));

    // Another plan-review round, not a landing: the plan is not approved on the
    // strength of a finding whose own history says it was not fixed last time.
    expect(advance.action).not.toBe("advance");
    expect(advance.action).toBe("retry");
  });
});

describe("SITE 4: the escalation projection carries the blocker AND its provenance", () => {
  it("files a reintroduced finding that a disposition tried to settle", () => {
    const out = outstandingCeilingFindings([ADDRESSED_REINTRODUCED, ADDRESSED_CLEAN], findingIsUnresolved);

    expect(out).toHaveLength(1);
    expect(out[0]!.description).toContain("swallows the error");
  });

  it("carries the LABEL with it, so the park record says why an addressed finding is a blocker", () => {
    // Clause 3. Without this the record shows an `addressed` finding filed as
    // outstanding and nothing anywhere explaining the contradiction.
    const out = outstandingCeilingFindings([ADDRESSED_REINTRODUCED], findingIsUnresolved);

    expect(out[0]!.originClass).toBe("reintroduced");
    expect(out[0]!.sinceRound).toBe(1);
  });

  it("does NOT extend to contested, which is a claim about validity and not lifecycle", () => {
    // The allow-list's own reasoning, deliberately left standing: filing a
    // contested finding mints a ledger issue for something the session already
    // decided was not real.
    const out = outstandingCeilingFindings([
      { ...ADDRESSED_REINTRODUCED, disposition: "contested" },
    ], findingIsUnresolved);

    expect(out).toHaveLength(0);
  });

  it("still drops a plain addressed finding and a suggestion", () => {
    expect(outstandingCeilingFindings([ADDRESSED_CLEAN], findingIsUnresolved)).toHaveLength(0);
    expect(outstandingCeilingFindings([
      { ...ADDRESSED_REINTRODUCED, severity: "suggestion" },
    ], findingIsUnresolved)).toHaveLength(0);
  });
});

describe("SITE 5: the provenance survives the reload that files it", () => {
  it("the escalation schema no longer strips originClass", () => {
    // Zod strips undeclared keys, so before step 6 the label that made the
    // finding a blocker was recorded and then removed on the read-back -- and
    // the resume path is the one that turns these into ledger issues.
    const parsed = SessionStateSchema.parse(makeState({
      pendingCeilingEscalation: {
        ticketId: "T-001", round: 5, ceiling: 5, trigger: "round-ceiling",
        workItemId: "T-001", kind: "ticket", maxReviewRounds: 5,
        reason: "r", unresolvedCritical: 0, unresolvedMajor: 1,
        decidedAt: "2026-09-05T00:00:00.000Z",
        findings: [{
          severity: "major", category: "correctness",
          description: "the retry path swallows the error",
          originClass: "reintroduced", origin: "introduced", sinceRound: 1,
        }],
        fingerprints: [], completed: false,
      },
    } as unknown as Partial<FullSessionState>));

    const f = parsed.pendingCeilingEscalation!.findings[0]!;
    expect(f.originClass).toBe("reintroduced");
    expect(f.origin).toBe("introduced");
    expect(f.sinceRound).toBe(1);
  });
});
