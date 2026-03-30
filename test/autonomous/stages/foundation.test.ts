/**
 * T-128a: Foundation tests for stage abstraction infrastructure.
 * Tests StageContext, registry, recipe loader, and pipeline helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  StageContext,
  isStageAdvance,
  type StageResult,
  type StageAdvance,
  type ResolvedRecipe,
  type WorkflowStage,
} from "../../../src/autonomous/stages/types.js";
import {
  registerStage,
  getStage,
  hasStage,
  registeredStageIds,
  findNextStage,
  findFirstPostComplete,
  validatePipeline,
  type NextStageResult,
} from "../../../src/autonomous/stages/registry.js";
import { resolveRecipe } from "../../../src/autonomous/recipes/loader.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "PICK_TICKET",
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
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(overrides: Partial<ResolvedRecipe> = {}): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    defaults: {
      maxTicketsPerSession: 3,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isStageAdvance type guard
// ---------------------------------------------------------------------------

describe("isStageAdvance", () => {
  it("returns true for advance action", () => {
    const advance: StageAdvance = { action: "advance" };
    expect(isStageAdvance(advance)).toBe(true);
  });

  it("returns true for retry action", () => {
    const advance: StageAdvance = { action: "retry", instruction: "try again" };
    expect(isStageAdvance(advance)).toBe(true);
  });

  it("returns true for goto action", () => {
    const advance: StageAdvance = { action: "goto", target: "PICK_TICKET" };
    expect(isStageAdvance(advance)).toBe(true);
  });

  it("returns true for back action", () => {
    const advance: StageAdvance = { action: "back", target: "PLAN", reason: "rejected" };
    expect(isStageAdvance(advance)).toBe(true);
  });

  it("returns false for StageResult", () => {
    const result: StageResult = { instruction: "do something" };
    expect(isStageAdvance(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StageContext
// ---------------------------------------------------------------------------

describe("StageContext", () => {
  let testRoot: string;
  let sessionDir: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "ctx-test-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("state getter returns initial state", () => {
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    expect(ctx.state.sessionId).toBe("00000000-0000-0000-0000-000000000001");
    expect(ctx.state.state).toBe("PICK_TICKET");
  });

  it("writeState updates internal state and increments revision", () => {
    const state = makeState({ revision: 5 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const written = ctx.writeState({ state: "PLAN", previousState: "PICK_TICKET" });

    expect(written.state).toBe("PLAN");
    expect(written.revision).toBe(6); // incremented by writeSessionSync
    expect(ctx.state.state).toBe("PLAN"); // internal snapshot updated
    expect(ctx.state.revision).toBe(6);
  });

  it("multiple writeState calls produce consistent state", () => {
    const state = makeState({ revision: 0 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    ctx.writeState({ state: "PLAN" });
    expect(ctx.state.revision).toBe(1);

    ctx.writeState({ state: "PLAN_REVIEW" });
    expect(ctx.state.revision).toBe(2);
    expect(ctx.state.state).toBe("PLAN_REVIEW");

    ctx.writeState({ state: "IMPLEMENT" });
    expect(ctx.state.revision).toBe(3);
    expect(ctx.state.state).toBe("IMPLEMENT");
  });

  it("writeState persists to disk", () => {
    const state = makeState({ revision: 0 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    ctx.writeState({ state: "PLAN" });

    const onDisk = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8"));
    expect(onDisk.state).toBe("PLAN");
    expect(onDisk.revision).toBe(1);
  });

  it("appendEvent writes to events.log", () => {
    const state = makeState({ revision: 1 });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    ctx.appendEvent("test_event", { key: "value" });

    const log = readFileSync(join(sessionDir, "events.log"), "utf-8").trim();
    const event = JSON.parse(log);
    expect(event.type).toBe("test_event");
    expect(event.data.key).toBe("value");
    expect(event.rev).toBe(1);
  });

  it("recipe is accessible", () => {
    const recipe = makeRecipe({ id: "test-recipe" });
    const ctx = new StageContext(testRoot, sessionDir, makeState(), recipe);
    expect(ctx.recipe.id).toBe("test-recipe");
    expect(ctx.recipe.pipeline).toContain("PLAN");
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("Stage registry", () => {
  // Note: registry is a module-level singleton. Tests that register stages
  // share state. We use unique IDs to avoid conflicts.

  it("registers and retrieves a stage", () => {
    const stage: WorkflowStage = {
      id: "_TEST_REG_1",
      enter: async () => ({ instruction: "test" }),
      report: async () => ({ action: "advance" }),
    };
    registerStage(stage);
    expect(getStage("_TEST_REG_1")).toBe(stage);
    expect(hasStage("_TEST_REG_1")).toBe(true);
  });

  it("throws on duplicate registration", () => {
    const stage: WorkflowStage = {
      id: "_TEST_REG_2",
      enter: async () => ({ instruction: "test" }),
      report: async () => ({ action: "advance" }),
    };
    registerStage(stage);
    expect(() => registerStage(stage)).toThrow("already registered");
  });

  it("returns undefined for unregistered stage", () => {
    expect(getStage("_NONEXISTENT")).toBeUndefined();
    expect(hasStage("_NONEXISTENT")).toBe(false);
  });

  it("registeredStageIds includes registered stages", () => {
    const ids = registeredStageIds();
    expect(ids).toContain("_TEST_REG_1");
    expect(ids).toContain("_TEST_REG_2");
  });
});

// ---------------------------------------------------------------------------
// Pipeline helpers (findNextStage, findFirstPostComplete, validatePipeline)
// ---------------------------------------------------------------------------

describe("Pipeline helpers", () => {
  // Register test stages with skip behavior
  const stageA: WorkflowStage = {
    id: "_PIPE_A",
    enter: async () => ({ instruction: "A" }),
    report: async () => ({ action: "advance" }),
  };
  const stageB: WorkflowStage = {
    id: "_PIPE_B",
    enter: async () => ({ instruction: "B" }),
    report: async () => ({ action: "advance" }),
    skip: () => true, // always skips
  };
  const stageC: WorkflowStage = {
    id: "_PIPE_C",
    enter: async () => ({ instruction: "C" }),
    report: async () => ({ action: "advance" }),
  };

  beforeEach(() => {
    try { registerStage(stageA); } catch { /* already registered */ }
    try { registerStage(stageB); } catch { /* already registered */ }
    try { registerStage(stageC); } catch { /* already registered */ }
  });

  describe("findNextStage", () => {
    it("finds the next stage in pipeline", () => {
      const pipeline = ["_PIPE_A", "_PIPE_C"];
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const next = findNextStage(pipeline, "_PIPE_A", ctx);
      expect(next.kind).toBe("found");
      if (next.kind === "found") expect(next.stage.id).toBe("_PIPE_C");
    });

    it("skips stages with skip() returning true", () => {
      const pipeline = ["_PIPE_A", "_PIPE_B", "_PIPE_C"];
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const next = findNextStage(pipeline, "_PIPE_A", ctx);
      expect(next.kind).toBe("found");
      if (next.kind === "found") expect(next.stage.id).toBe("_PIPE_C");
    });

    it("returns exhausted when pipeline ends", () => {
      const pipeline = ["_PIPE_A", "_PIPE_C"];
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const next = findNextStage(pipeline, "_PIPE_C", ctx);
      expect(next.kind).toBe("exhausted");
    });

    it("returns exhausted for unknown current stage", () => {
      const pipeline = ["_PIPE_A", "_PIPE_C"];
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const next = findNextStage(pipeline, "_UNKNOWN", ctx);
      expect(next.kind).toBe("exhausted");
    });

    it("returns exhausted when all remaining stages skip", () => {
      const pipeline = ["_PIPE_A", "_PIPE_B"];
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const next = findNextStage(pipeline, "_PIPE_A", ctx);
      expect(next.kind).toBe("exhausted");
    });

    it("returns unregistered for pipeline entry not in registry", () => {
      const pipeline = ["_PIPE_A", "_UNREGISTERED_STAGE", "_PIPE_C"];
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const next = findNextStage(pipeline, "_PIPE_A", ctx);
      expect(next.kind).toBe("unregistered");
      if (next.kind === "unregistered") expect(next.id).toBe("_UNREGISTERED_STAGE");
    });
  });

  describe("findFirstPostComplete", () => {
    it("finds first non-skipping postComplete stage", () => {
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const result = findFirstPostComplete(["_PIPE_B", "_PIPE_C"], ctx);
      expect(result.kind).toBe("found");
      if (result.kind === "found") expect(result.stage.id).toBe("_PIPE_C");
    });

    it("returns exhausted for empty array", () => {
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      expect(findFirstPostComplete([], ctx).kind).toBe("exhausted");
    });

    it("returns exhausted when all stages skip", () => {
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      expect(findFirstPostComplete(["_PIPE_B"], ctx).kind).toBe("exhausted");
    });

    it("returns unregistered for unknown postComplete entry", () => {
      const ctx = new StageContext("/tmp", "/tmp", makeState(), makeRecipe());
      const result = findFirstPostComplete(["_PC_UNKNOWN"], ctx);
      expect(result.kind).toBe("unregistered");
      if (result.kind === "unregistered") expect(result.id).toBe("_PC_UNKNOWN");
    });
  });

  describe("validatePipeline", () => {
    it("returns empty for valid pipeline", () => {
      expect(validatePipeline(["_PIPE_A", "_PIPE_C"])).toEqual([]);
    });

    it("returns unregistered IDs", () => {
      const missing = validatePipeline(["_PIPE_A", "_MISSING_1", "_PIPE_C", "_MISSING_2"]);
      expect(missing).toEqual(["_MISSING_1", "_MISSING_2"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Recipe loader
// ---------------------------------------------------------------------------

describe("resolveRecipe", () => {
  it("loads coding recipe with default pipeline", () => {
    const recipe = resolveRecipe("coding");
    expect(recipe.id).toBe("coding");
    expect(recipe.pipeline).toContain("PICK_TICKET");
    expect(recipe.pipeline).toContain("PLAN");
    expect(recipe.pipeline).toContain("COMPLETE");
    expect(recipe.postComplete).toContain("ISSUE_SWEEP");
  });

  it("applies project overrides over recipe defaults", () => {
    const recipe = resolveRecipe("coding", {
      maxTicketsPerSession: 0,
      compactThreshold: "critical",
    });
    expect(recipe.defaults.maxTicketsPerSession).toBe(0);
    expect(recipe.defaults.compactThreshold).toBe("critical");
    expect(recipe.defaults.reviewBackends).toEqual(["codex", "agent"]); // unchanged
  });

  it("includes TEST and WRITE_TESTS stages by default", () => {
    const recipe = resolveRecipe("coding");
    expect(recipe.pipeline).toContain("TEST");
    expect(recipe.pipeline).toContain("WRITE_TESTS");
  });

  it("rejects recipe names with path traversal characters", () => {
    expect(() => resolveRecipe("../../etc/passwd")).toThrow("Invalid recipe name");
    expect(() => resolveRecipe("foo/bar")).toThrow("Invalid recipe name");
  });

  it("falls back to defaults for unknown recipe", () => {
    const recipe = resolveRecipe("nonexistent-recipe");
    expect(recipe.id).toBe("nonexistent-recipe");
    expect(recipe.pipeline).toContain("PICK_TICKET");
    expect(recipe.defaults.maxTicketsPerSession).toBe(3);
  });

  it("preserves recipe stages config", () => {
    const recipe = resolveRecipe("coding");
    expect(recipe.stages).toHaveProperty("PLAN_REVIEW");
    expect(recipe.stages).toHaveProperty("CODE_REVIEW");
  });
});
