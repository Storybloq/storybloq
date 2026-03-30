/**
 * T-131: Tests for VerifyStage (smoke test endpoints between CODE_REVIEW and FINALIZE).
 * TDD: these tests are written BEFORE the implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StageContext, isStageAdvance, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { VerifyStage, detectEndpoints } from "../../../src/autonomous/stages/verify.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "VERIFY",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: {
      level: "low",
      guideCallCount: 0,
      ticketsCompleted: 0,
      compactionCount: 0,
      eventsLogBytes: 0,
    },
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
    config: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "VERIFY", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {
      VERIFY: {
        enabled: true,
        startCommand: "npm run dev",
        readinessUrl: "http://localhost:3000",
        endpoints: ["GET /api/users", "POST /api/habits"],
      },
    },
    dirtyFileHandling: "block",
    defaults: {
      maxTicketsPerSession: 3,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
    ...overrides,
  };
}

describe("VerifyStage", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new VerifyStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "verify-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  // --- skip ---

  it("skip() returns true when not enabled", () => {
    const state = makeState();
    const recipe = makeRecipe({ stages: {} });
    const ctx = new StageContext(testRoot, sessionDir, state, recipe);
    expect(stage.skip!(ctx)).toBe(true);
  });

  it("skip() returns false when enabled", () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    expect(stage.skip!(ctx)).toBe(false);
  });

  // --- enter ---

  it("enter() returns instruction with explicit endpoints", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(false);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("GET /api/users");
      expect(result.instruction).toContain("POST /api/habits");
      expect(result.instruction).toContain("npm run dev");
    }
  });

  it("enter() advances with note when no endpoints found", async () => {
    const state = makeState();
    const recipe = makeRecipe({
      stages: {
        VERIFY: { enabled: true, startCommand: "npm run dev", readinessUrl: "http://localhost:3000", endpoints: [] },
      },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, recipe);
    const result = await stage.enter(ctx);
    // Should auto-advance (no endpoints = skip with note, not error)
    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result)) {
      expect(result.action).toBe("advance");
    }
  });

  it("enter() shows retry count on retry", async () => {
    const state = makeState({ verifyRetryCount: 2 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    if (!isStageAdvance(result)) {
      expect(result.instruction).toContain("Retry 2");
    }
  });

  // --- report: pass ---

  it("report() advances when all endpoints return 2xx", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([
        { endpoint: "GET /api/users", status: 200 },
        { endpoint: "POST /api/habits", status: 201 },
      ]),
    });
    expect(advance.action).toBe("advance");
  });

  it("report() resets verifyRetryCount on success", async () => {
    const state = makeState({ verifyRetryCount: 2 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([
        { endpoint: "GET /api/users", status: 200 },
        { endpoint: "POST /api/habits", status: 201 },
      ]),
    });
    expect(ctx.state.verifyRetryCount).toBe(0);
  });

  // --- report: fail (5xx / 0) ---

  it("report() returns back(IMPLEMENT) on 5xx", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([
        { endpoint: "GET /api/users", status: 200 },
        { endpoint: "POST /api/habits", status: 500 },
      ]),
    });
    expect(advance.action).toBe("back");
    if (advance.action === "back") {
      expect(advance.target).toBe("IMPLEMENT");
    }
  });

  it("report() returns back(IMPLEMENT) on status 0 (connection refused)", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([
        { endpoint: "GET /api/users", status: 0 },
      ]),
    });
    expect(advance.action).toBe("back");
    if (advance.action === "back") {
      expect(advance.target).toBe("IMPLEMENT");
    }
  });

  it("report() resets verifyRetryCount on back(IMPLEMENT)", async () => {
    const state = makeState({ verifyRetryCount: 1 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([{ endpoint: "GET /api/users", status: 500 }]),
    });
    expect(ctx.state.verifyRetryCount).toBe(0);
  });

  // --- report: 4xx ---

  it("report() retries for 4xx from auto-detected endpoints", async () => {
    const state = makeState({ verifyAutoDetected: true });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([
        { endpoint: "GET /api/users", status: 404 },
      ]),
    });
    expect(advance.action).toBe("retry");
  });

  it("report() advances with warning for 4xx from explicit endpoints", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: JSON.stringify([
        { endpoint: "GET /api/users", status: 404 },
        { endpoint: "POST /api/habits", status: 201 },
      ]),
    });
    // Explicit endpoints: 4xx = advance with warning
    expect(advance.action).toBe("advance");
  });

  // --- report: retry ---

  it("report() retries on unparseable results", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: "I ran the tests but forgot to include results",
    });
    expect(advance.action).toBe("retry");
  });

  it("report() increments verifyRetryCount on retry", async () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    await stage.report(ctx, {
      completedAction: "verify_done",
      notes: "unparseable",
    });
    expect(ctx.state.verifyRetryCount).toBe(1);
  });

  // --- report: exhaustion ---

  it("report() advances with degraded event after 3 retries", async () => {
    const state = makeState({ verifyRetryCount: 2 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, {
      completedAction: "verify_done",
      notes: "still unparseable",
    });
    expect(advance.action).toBe("advance");
  });
});

// --- detectEndpoints ---

describe("detectEndpoints", () => {
  it("detects App Router endpoints", () => {
    const result = detectEndpoints(["app/api/users/route.ts"]);
    expect(result.endpoints).toEqual(["GET /api/users"]);
  });

  it("detects App Router with src/ prefix", () => {
    const result = detectEndpoints(["src/app/api/users/route.ts"]);
    expect(result.endpoints).toEqual(["GET /api/users"]);
  });

  it("handles dynamic segments with placeholder", () => {
    const result = detectEndpoints(["app/api/users/[id]/route.ts"]);
    expect(result.endpoints).toEqual(["GET /api/users/1"]);
  });

  it("skips non-API App Router routes (page handlers)", () => {
    const result = detectEndpoints(["app/(dashboard)/route.ts"]);
    expect(result.endpoints).toEqual([]);
  });

  it("strips route group before api segment", () => {
    const result = detectEndpoints(["app/(auth)/api/users/route.ts"]);
    expect(result.endpoints).toEqual(["GET /api/users"]);
  });

  it("deduplicates identical endpoints", () => {
    const result = detectEndpoints(["app/api/users/route.ts", "app/api/users/route.js"]);
    expect(result.endpoints).toEqual(["GET /api/users"]);
  });

  it("detects Pages Router endpoints", () => {
    const result = detectEndpoints(["pages/api/users.ts"]);
    expect(result.endpoints).toEqual(["GET /api/users"]);
  });

  it("handles Pages Router index files", () => {
    const result = detectEndpoints(["pages/api/users/index.ts"]);
    expect(result.endpoints).toEqual(["GET /api/users"]);
  });

  it("skips catch-all routes", () => {
    const result = detectEndpoints(["app/api/[...slug]/route.ts"]);
    expect(result.endpoints).toEqual([]);
    expect(result.skippedRoutes).toEqual(["app/api/[...slug]/route.ts"]);
  });

  it("skips optional catch-all routes", () => {
    const result = detectEndpoints(["app/api/[[...slug]]/route.ts"]);
    expect(result.endpoints).toEqual([]);
    expect(result.skippedRoutes).toEqual(["app/api/[[...slug]]/route.ts"]);
  });

  it("ignores non-route files", () => {
    const result = detectEndpoints(["src/components/Button.tsx", "README.md"]);
    expect(result.endpoints).toEqual([]);
    expect(result.skippedRoutes).toEqual([]);
  });
});
