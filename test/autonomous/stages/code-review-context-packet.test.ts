/**
 * ISS-1115 acceptance, at the seam that actually ships: does a round-2 codex
 * instruction CONTAIN the accepted-residuals block?
 *
 * The unit tests for the packet builder prove it assembles correctly. They do
 * not prove it reaches a reviewer, and that is the whole issue: the builder
 * could be perfect and the branch could still emit the one-line diff
 * instruction it emitted before. This file asserts against the instruction
 * string the backend is actually handed.
 *
 * It also pins the floor at the stage level. The packet guarantees the capture
 * directive survives every budget; this checks the assembled INSTRUCTION still
 * carries it, because a floor that holds inside a module and is lost when the
 * caller reassembles the text protects nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
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

const DEFERRED = {
  id: "F-EARLIER", severity: "major", category: "naming",
  description: "the widget name is inconsistent with the module",
  disposition: "deferred", dispositionReason: "owner-accepted-risk",
};

describe("ISS-1115: the codex instruction carries the round context packet", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-stage-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("ROUND 2 contains the accepted residuals from round 1", async () => {
    seedArtifact(sessionDir, { round: 1, findings: [DEFERRED] });
    const state = makeState({
      reviews: {
        plan: [],
        code: [{ round: 1, reviewer: "codex", verdict: "revise", findingCount: 1, criticalCount: 0, majorCount: 1, suggestionCount: 0, timestamp: "2026-09-05T00:00:01.000Z" }],
      },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    // The acceptance criterion, asserted against the instruction the agent is
    // handed. Renamed from "Accepted residuals" when reconciliation was dropped
    // at gate 1: nothing here claims an entry is CURRENTLY accepted, so calling
    // the block that would have been a false label.
    expect(result.instruction).toContain("Prior review history");
    expect(result.instruction).toContain("the widget name is inconsistent");
    expect(result.instruction).toContain("Status unconfirmed");
    // owner-accepted-risk renders as a decision, distinct from valid-deferred.
    expect(result.instruction).toMatch(/accepted risk \(a decision that was taken\)/);
    // And the reporting rule that makes re-raises visible.
    expect(result.instruction).toContain("originClass");
    expect(result.instruction).toMatch(/reintroduced/);
  });

  it("ROUND 1 carries no residuals, because there are none, and says nothing false", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    expect(result.instruction).not.toContain("Prior review history");
    // No claim of completeness or incompleteness where there is no history.
    expect(result.instruction).not.toMatch(/could not be recovered/i);
  });

  it("carries RULES.md and REVIEW.md when the project has them", async () => {
    writeFileSync(join(testRoot, "RULES.md"), "RULE: no em dashes anywhere.", "utf-8");
    writeFileSync(join(testRoot, "REVIEW.md"), "## Security\nBlocking: blocking\n", "utf-8");
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    // Before this run the codex path received neither, while every lens did.
    expect(result.instruction).toContain("no em dashes anywhere");
    expect(result.instruction).toContain("Blocking: blocking");
  });

  it("declares an incomplete history rather than presenting a short list as whole", async () => {
    // Round 1's artifact was lost; round 2's survived. A reviewer told "these
    // are the accepted residuals" here would be reading a partial set.
    seedArtifact(sessionDir, { round: 2, findings: [DEFERRED] });
    const state = makeState({
      reviews: {
        plan: [],
        code: [
          { round: 1, reviewer: "codex", verdict: "revise", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: "2026-09-05T00:00:01.000Z" },
          { round: 2, reviewer: "codex", verdict: "revise", findingCount: 1, criticalCount: 0, majorCount: 1, suggestionCount: 0, timestamp: "2026-09-05T00:00:02.000Z" },
        ],
      },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(result.instruction).toMatch(/INCOMPLETE/i);
    expect(result.instruction).toContain("round 1");
  });

  it("ISS-1115 item 3: passes the plan-review codex session id forward", async () => {
    seedArtifact(sessionDir, {
      round: 1, stage: "plan",
      backendRunId: "codex-sess-abc", backendRunIdKind: "codex-session",
    });
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("codex-sess-abc");
    expect(result.instruction).toMatch(/session_id/);
  });
});

describe("ISS-1115 F2: the floor survives instruction assembly", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-floor-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("every instruction still tells the reviewer to capture the FULL diff", async () => {
    // Round 1, round 2 with residuals, and a round with a huge rules file that
    // pushes hard against the budget: the capture directive is in all of them.
    writeFileSync(join(testRoot, "RULES.md"), "R".repeat(50_000), "utf-8");
    seedArtifact(sessionDir, { round: 1, findings: [DEFERRED] });

    for (const codeRounds of [0, 1]) {
      const state = makeState({
        reviews: {
          plan: [],
          code: Array.from({ length: codeRounds }, (_, i) => ({
            round: i + 1, reviewer: "codex", verdict: "revise", findingCount: 1,
            criticalCount: 0, majorCount: 1, suggestionCount: 0,
            timestamp: "2026-09-05T00:00:01.000Z",
          })),
        },
      } as Partial<FullSessionState>);
      const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

      const result = await stage.enter(ctx);

      expect(result.instruction).toContain("Capture the diff with");
      expect(result.instruction).toContain("Pass the FULL unified diff");
      // ISS-937's rider is untouched and still reaches the reviewer.
      expect(result.instruction).toContain("file-scoped chunks");
    }
  });
});
