/**
 * BUILD stage tests -- skip logic, enter instruction, pass/fail/retry/exhaustion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { BuildStage } from "../../../src/autonomous/stages/build.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "BUILD", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(buildConfig?: Record<string, unknown>): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "BUILD", "VERIFY", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: buildConfig ? { BUILD: buildConfig } : {},
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("BuildStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new BuildStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-build-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  // --- skip() ---

  it("skips when BUILD not in recipe stages", () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    expect(stage.skip(ctx)).toBe(true);
  });

  it("skips when BUILD.enabled is false", () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe({ enabled: false, command: "npm run build" }));
    expect(stage.skip(ctx)).toBe(true);
  });

  it("does not skip when BUILD.enabled is true", () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe({ enabled: true, command: "npm run build" }));
    expect(stage.skip(ctx)).toBe(false);
  });

  // --- enter() ---

  it("enter includes build command from recipe", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe({ enabled: true, command: "pnpm build" }));
    const result = await stage.enter(ctx);
    expect(result.instruction).toContain("pnpm build");
  });

  it("enter defaults to npm run build when no command specified", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe({ enabled: true }));
    const result = await stage.enter(ctx);
    expect(result.instruction).toContain("npm run build");
  });

  it("enter shows retry count when retrying", async () => {
    const state = makeState({ buildRetryCount: 1 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ enabled: true, command: "npm run build" }));
    const result = await stage.enter(ctx);
    expect(result.instruction).toContain("retry 1/2");
  });

  // --- report() pass ---

  it("exit code 0 advances and resets retryCount", async () => {
    const state = makeState({ buildRetryCount: 1 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ enabled: true }));
    const advance = await stage.report(ctx, {
      completedAction: "build_done",
      notes: "exit code: 0, build succeeded",
    });
    expect(advance.action).toBe("advance");
    expect(ctx.state.buildRetryCount).toBe(0);
  });

  // --- report() fail ---

  it("exit code 1 goes back to IMPLEMENT on first attempt", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe({ enabled: true }));
    const advance = await stage.report(ctx, {
      completedAction: "build_done",
      notes: "exit code: 1, Module not found",
    });
    expect(advance.action).toBe("back");
    expect(ctx.state.buildRetryCount).toBe(1);
  });

  it("exhaust retries after 2 failures advances", async () => {
    const state = makeState({ buildRetryCount: 2 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ enabled: true }));
    const advance = await stage.report(ctx, {
      completedAction: "build_done",
      notes: "exit code: 1, still broken",
    });
    expect(advance.action).toBe("advance");
  });

  // --- report() parse failure ---

  it("unparseable exit code retries with incremented count", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe({ enabled: true }));
    const advance = await stage.report(ctx, {
      completedAction: "build_done",
      notes: "the build did something",
    });
    expect(advance.action).toBe("retry");
    expect(ctx.state.buildRetryCount).toBe(1);
  });

  it("parse failure at retryCount=1 still retries", async () => {
    const state = makeState({ buildRetryCount: 1 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ enabled: true }));
    const advance = await stage.report(ctx, {
      completedAction: "build_done",
      notes: "still unclear what happened",
    });
    expect(advance.action).toBe("retry");
    expect(ctx.state.buildRetryCount).toBe(2);
  });

  it("parse failure at retryCount=2 exhausts (boundary)", async () => {
    const state = makeState({ buildRetryCount: 2 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ enabled: true }));
    const advance = await stage.report(ctx, {
      completedAction: "build_done",
      notes: "still unclear what happened",
    });
    expect(advance.action).toBe("advance");
  });
});
