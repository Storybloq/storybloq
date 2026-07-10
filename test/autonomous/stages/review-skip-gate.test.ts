/**
 * Opt-in risk-gated review skipping.
 *
 * stages.PLAN_REVIEW.skipIfRiskBelow / stages.CODE_REVIEW.skipIfRiskBelow let a
 * project skip a review stage when the effective risk is below a configured
 * floor. Unset config → byte-identical current behavior (never skips). The skip
 * advances through legal transitions (PLAN_REVIEW → IMPLEMENT, CODE_REVIEW →
 * FINALIZE) rather than bypassing the state machine.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanStage } from "../../../src/autonomous/stages/plan.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import { shouldSkipForRisk } from "../../../src/autonomous/review-depth.js";
import { isValidTransition } from "../../../src/autonomous/state-machine.js";
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

function makeRecipe(stages: Record<string, Record<string, unknown>> = {}): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages,
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

/** Init an isolated git repo with one commit; returns the base commit sha. */
function initGitRepo(dir: string): string {
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# base\n", "utf-8");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "base"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}

function gitAt(base: string): FullSessionState["git"] {
  return { branch: "story/T-001-test", mergeBase: base, expectedHead: base } as FullSessionState["git"];
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

describe("shouldSkipForRisk", () => {
  it("never skips without a valid threshold", () => {
    expect(shouldSkipForRisk("low", undefined)).toBe(false);
    expect(shouldSkipForRisk("high", undefined)).toBe(false);
    expect(shouldSkipForRisk("low", "banana")).toBe(false);
    expect(shouldSkipForRisk("low", 2)).toBe(false);
    expect(shouldSkipForRisk("low", "")).toBe(false);
  });

  it("a 'low' floor never skips (nothing ranks below the floor)", () => {
    expect(shouldSkipForRisk("low", "low")).toBe(false);
    expect(shouldSkipForRisk("medium", "low")).toBe(false);
    expect(shouldSkipForRisk("high", "low")).toBe(false);
  });

  it("'medium' floor skips only low", () => {
    expect(shouldSkipForRisk("low", "medium")).toBe(true);
    expect(shouldSkipForRisk("medium", "medium")).toBe(false);
    expect(shouldSkipForRisk("high", "medium")).toBe(false);
  });

  it("'high' floor skips low and medium", () => {
    expect(shouldSkipForRisk("low", "high")).toBe(true);
    expect(shouldSkipForRisk("medium", "high")).toBe(true);
    expect(shouldSkipForRisk("high", "high")).toBe(false);
  });
});

describe("skip transition edges exist (state machine invariant)", () => {
  it("PLAN_REVIEW → IMPLEMENT and CODE_REVIEW → FINALIZE are legal", () => {
    expect(isValidTransition("PLAN_REVIEW", "IMPLEMENT")).toBe(true);
    expect(isValidTransition("CODE_REVIEW", "FINALIZE")).toBe(true);
  });
});

describe("CODE_REVIEW.enter() risk gate", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "code-review-gate-"));
    sessionDir = join(testRoot, ".story", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("no config → runs the review (byte-identical default)", async () => {
    const state = makeState({ state: "CODE_REVIEW", ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("skipIfRiskBelow 'medium' + realizedRisk low + clean sensitive-free tree → skips", async () => {
    const base = initGitRepo(testRoot);
    const state = makeState({ state: "CODE_REVIEW", git: gitAt(base), ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("action" in result && result.action).toBe("advance");
  });

  it("does NOT skip when an untracked sensitive file is present (fail-closed)", async () => {
    const base = initGitRepo(testRoot);
    writeFileSync(join(testRoot, "config.ts"), "export const x = 1;\n", "utf-8"); // untracked + sensitive
    const state = makeState({ state: "CODE_REVIEW", git: gitAt(base), ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("does NOT skip when git introspection fails (fail-closed)", async () => {
    // testRoot is not a git repo → the changed-file lookup fails → review runs.
    const state = makeState({ state: "CODE_REVIEW", git: gitAt("deadbeef"), ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("does NOT skip when there is no merge base (fail-closed)", async () => {
    const state = makeState({ state: "CODE_REVIEW", git: { branch: "b", mergeBase: null, expectedHead: null } as FullSessionState["git"], ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("does NOT skip in review mode (terminal at code-review approval)", async () => {
    const base = initGitRepo(testRoot);
    const state = makeState({ state: "CODE_REVIEW", mode: "review", git: gitAt(base), ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "low" } } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("skipIfRiskBelow 'medium' + realizedRisk high → runs the review", async () => {
    const state = makeState({ state: "CODE_REVIEW", ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "high" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("realizedRisk overrides a stale low ticket.risk seed for the gate", async () => {
    // A trivial-looking ticket (risk 'low') whose implementation turned out to
    // be high-risk must still be reviewed: realizedRisk wins.
    const state = makeState({ state: "CODE_REVIEW", ticket: { id: "T-001", title: "T", claimed: true, risk: "low", realizedRisk: "high" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "high" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("issue-fix reviews are not gated (currentIssue set)", async () => {
    const state = makeState({
      state: "CODE_REVIEW",
      ticket: { id: "T-001", title: "T", claimed: true, realizedRisk: "low" },
      currentIssue: { id: "ISS-001", title: "an issue", severity: "low", status: "open" },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ CODE_REVIEW: { skipIfRiskBelow: "high" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });
});

describe("PLAN_REVIEW.enter() risk gate", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new PlanReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plan-review-gate-"));
    sessionDir = join(testRoot, ".story", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("no config → runs the review (byte-identical default)", async () => {
    const state = makeState({ state: "PLAN_REVIEW", ticket: { id: "T-001", title: "T", claimed: true, risk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("skipIfRiskBelow 'medium' + risk low → skips (advance)", async () => {
    const state = makeState({ state: "PLAN_REVIEW", ticket: { id: "T-001", title: "T", claimed: true, risk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ PLAN_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("action" in result && result.action).toBe("advance");
  });

  it("skipIfRiskBelow 'high' + risk medium → skips (advance)", async () => {
    const state = makeState({ state: "PLAN_REVIEW", ticket: { id: "T-001", title: "T", claimed: true, risk: "medium" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ PLAN_REVIEW: { skipIfRiskBelow: "high" } }));
    const result = await stage.enter(ctx);
    expect("action" in result && result.action).toBe("advance");
  });

  it("skipIfRiskBelow 'medium' + risk high → runs the review", async () => {
    const state = makeState({ state: "PLAN_REVIEW", ticket: { id: "T-001", title: "T", claimed: true, risk: "high" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ PLAN_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });

  it("does NOT skip in plan mode (terminal at plan-review approval)", async () => {
    const state = makeState({ state: "PLAN_REVIEW", mode: "plan", ticket: { id: "T-001", title: "T", claimed: true, risk: "low" } } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ PLAN_REVIEW: { skipIfRiskBelow: "medium" } }));
    const result = await stage.enter(ctx);
    expect("instruction" in result).toBe(true);
  });
});

describe("PLAN.report() defers precompute so PLAN_REVIEW.enter() can skip", () => {
  let testRoot: string;
  let sessionDir: string;
  const plan = new PlanStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "plan-gate-"));
    sessionDir = join(testRoot, ".story", "sessions", SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\n1. Do the thing.\n", "utf-8");
    writeStoryProject(testRoot, baseTicket);
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("gate active (risk below floor) → bare advance, no precomputed result", async () => {
    const state = makeState({ ticket: { id: "T-001", title: "T", claimed: true, risk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ PLAN_REVIEW: { skipIfRiskBelow: "medium" } }));
    const advance = await plan.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("advance");
    expect("result" in advance && advance.result).toBeFalsy();
  });

  it("gate configured but risk at/above floor → keeps the precompute", async () => {
    const state = makeState({ ticket: { id: "T-001", title: "T", claimed: true, risk: "high" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ PLAN_REVIEW: { skipIfRiskBelow: "medium" } }));
    const advance = await plan.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("advance");
    expect("result" in advance && advance.result).toBeTruthy();
  });

  it("no gate → keeps the precompute (unchanged behavior)", async () => {
    const state = makeState({ ticket: { id: "T-001", title: "T", claimed: true, risk: "low" } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await plan.report(ctx, { completedAction: "plan_written" });
    expect(advance.action).toBe("advance");
    expect("result" in advance && advance.result).toBeTruthy();
  });
});
