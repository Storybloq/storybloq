/**
 * ISS-1115 F5: the PLAN stage gets the packet too.
 *
 * WHY THIS FILE EXISTS AT ALL. The code stage was wired and this one was not,
 * and the gap survived a green run: the edit meant to wire it raised before
 * writing the file, and the stage suite passed anyway because nothing asserted
 * the plan instruction's contents. That is the third of this run's green-suite
 * illusions and the only one a mutant could never have found, because there was
 * no code to mutate.
 *
 * AND ITS SUBJECT IS THE PLAN. An earlier plan said both stages shared the
 * "Pass the FULL unified diff to the reviewer" anchor. That line does not exist
 * here and there is no `diffCommand` on this path, so these tests assert the
 * plan-shaped directive rather than a diff-shaped one.
 *
 * WHAT THESE ASSERT, EXACTLY. The guide INSTRUCTION, which is handed to the
 * implementing agent. That agent then composes the backend request, so an
 * assertion here proves the agent was told, not that the reviewer received it.
 * The instruction therefore has to state the handoff, and that is asserted too.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { verdictFilename, computeContentHash, type ReviewVerdictArtifact } from "../../../src/autonomous/review-verdict.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active", mode: "auto",
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
    postComplete: [], stages: { PLAN_REVIEW: { minRounds: 1 }, CODE_REVIEW: { maxReviewRounds: 5 } },
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

describe("ISS-1115 F5: the plan-review instruction carries the packet", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "iss1115-plan-"));
    sessionDir = join(testRoot, ".story", "sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    setupProject(testRoot);
  });
  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("ROUND 2 carries the prior round's acceptances", async () => {
    seedArtifact(sessionDir, { round: 1, stage: "plan", findings: [DEFERRED] });
    const state = makeState({
      reviews: {
        plan: [{ round: 1, reviewer: "codex", verdict: "revise", findingCount: 1, criticalCount: 0, majorCount: 1, suggestionCount: 0, timestamp: "2026-09-05T00:00:01.000Z" }],
        code: [],
      },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("Prior review history");
    expect(result.instruction).toContain("the widget name is inconsistent");
    expect(result.instruction).toContain("Status unconfirmed");
  });

  it("carries the reporting rule and the completeness disclosure on every round", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    // The mandatory payload, on round 1, where there is no history to nest it
    // inside. This is the round a reviewer first learns to classify.
    expect(result.instruction).toContain("REPORTING RULE");
    expect(result.instruction).toContain("originClass");
    expect(result.instruction).toContain("CONTEXT COMPLETENESS");
  });

  it("names the PLAN as the subject, not a diff", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("plan.md");
    // The anchor an earlier plan wrongly claimed this stage shared.
    expect(result.instruction).not.toContain("Pass the FULL unified diff");
  });

  it("STATES THE HANDOFF rather than leaving the packet behind", async () => {
    // "Call `review_plan` with the plan content" was the whole instruction
    // before this run, so an agent following it literally would send the plan
    // and drop the context it had just been given.
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    expect(result.instruction).toMatch(/passing BOTH the context above and the full plan content|giving it the context above and the full plan content/);
  });

  it("carries RULES.md and REVIEW.md, the same project rules the lenses get", async () => {
    writeFileSync(join(testRoot, "RULES.md"), "RULE: no em dashes anywhere.", "utf-8");
    writeFileSync(join(testRoot, "REVIEW.md"), "## Security\nBlocking: blocking\n", "utf-8");
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("no em dashes anywhere");
    expect(result.instruction).toContain("Blocking: blocking");
  });
});
