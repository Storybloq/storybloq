import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluatePressure,
  pressureAfterCompaction,
  pressureMeetsThreshold,
} from "../../../src/autonomous/context-pressure.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import "../../../src/autonomous/stages/index.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import { HandoverStage } from "../../../src/autonomous/stages/handover.js";
import {
  isStageAdvance,
  StageContext,
  type ResolvedRecipe,
  type StageAdvance,
  type StageResult,
} from "../../../src/autonomous/stages/types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding",
    state: "COMPLETE",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [{ id: "T-001" }],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: {
      level: "low",
      guideCallCount: 5,
      ticketsCompleted: 1,
      compactionCount: 0,
      eventsLogBytes: 0,
      workItemsAtLastCompaction: 0,
      eventsLogBytesAtLastCompaction: 0,
    },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    contextRotation: null,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 5,
    config: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
      handoverInterval: 5,
    },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    branchStrategy: "none",
    defaults: {
      maxTicketsPerSession: 0,
      compactThreshold: "high",
      reviewBackends: ["codex", "agent"],
    },
  };
}

function instructionOf(result: StageResult | StageAdvance): string {
  if (!isStageAdvance(result)) return result.instruction;
  return "result" in result ? result.result?.instruction ?? "" : "";
}

describe("context-pressure compaction policy", () => {
  it("compares pressure levels against supported thresholds", () => {
    expect(pressureMeetsThreshold("medium", "medium")).toBe(true);
    expect(pressureMeetsThreshold("medium", "high")).toBe(false);
    expect(pressureMeetsThreshold("high", "high")).toBe(true);
    expect(pressureMeetsThreshold("high", "critical")).toBe(false);
    expect(pressureMeetsThreshold("critical", "critical")).toBe(true);
  });

  it("preserves the existing high fallback for unknown and legacy values", () => {
    expect(pressureMeetsThreshold("medium", "low")).toBe(false);
    expect(pressureMeetsThreshold("high", "low")).toBe(true);
    expect(pressureMeetsThreshold("medium", "unknown")).toBe(false);
    expect(pressureMeetsThreshold("high", undefined)).toBe(true);
  });

  it("resets pressure against cumulative work after successful compaction", () => {
    const before = makeState({
      completedTickets: Array.from({ length: 5 }, (_, index) => ({ id: `T-${index}` })),
      resolvedIssues: ["ISS-001"],
      contextPressure: {
        level: "high",
        guideCallCount: 60,
        ticketsCompleted: 6,
        compactionCount: 2,
        eventsLogBytes: 900_000,
      },
    });

    const contextPressure = pressureAfterCompaction(before);
    const resumed = { ...before, guideCallCount: 0, contextPressure } as FullSessionState;

    expect(contextPressure.compactionCount).toBe(3);
    expect(contextPressure.workItemsAtLastCompaction).toBe(6);
    expect(contextPressure.eventsLogBytesAtLastCompaction).toBe(900_000);
    expect(evaluatePressure(resumed)).toBe("low");
  });
});

describe("CompleteStage pressure compaction", () => {
  let root: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "complete-pressure-"));
    sessionDir = join(root, ".story", "sessions", "test-session");
    for (const dir of ["tickets", "issues", "notes", "lessons", "handovers", "sessions/test-session"]) {
      mkdirSync(join(root, ".story", dir), { recursive: true });
    }
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
      version: 1,
      schemaVersion: 1,
      project: "test",
      type: "npm",
      language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
      title: "test",
      date: "2026-01-01",
      phases: [],
      blockers: [],
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function addOpenWork(): void {
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001",
      title: "Open bug",
      status: "open",
      severity: "medium",
      components: [],
      impact: "Needs fixing.",
      resolution: null,
      resolvedDate: null,
      discoveredDate: "2026-01-01",
      relatedTickets: [],
      location: [],
    }));
  }

  it("continues to PICK_TICKET below the threshold", async () => {
    addOpenWork();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && result.action === "goto") {
      expect(result.target).toBe("PICK_TICKET");
    }
  });

  it("routes to HANDOVER at high pressure when Storybloq cannot invoke client compaction", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 60,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && result.action === "goto") {
      expect(result.target).toBe("HANDOVER");
    }
    expect(instructionOf(result)).toContain("Context Rotation Required");
    expect(instructionOf(result)).not.toContain('"action": "pre_compact"');
    expect(ctx.state.contextRotation).toMatchObject({
      level: "high",
      compactThreshold: "high",
      ticketsDone: 1,
      issuesDone: 0,
    });
    expect(ctx.state.state).toBe("COMPLETE");
    expect(ctx.state.status).toBe("active");
  });

  it("runs enabled post-complete stages before a pressure-rotation handover", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 60,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
    });
    const recipe: ResolvedRecipe = {
      ...makeRecipe(),
      postComplete: ["LESSON_CAPTURE"],
      stages: { LESSON_CAPTURE: { enabled: true } },
    };
    const ctx = new StageContext(root, sessionDir, state, recipe);

    const result = await stage.enter(ctx);

    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("LESSON_CAPTURE");
    }
    expect(ctx.state.pipelinePhase).toBe("postComplete");
    expect(ctx.state.contextRotation?.level).toBe("high");
  });

  it("waits for critical pressure when configured conservatively", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 90,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
      config: {
        maxTicketsPerSession: 0,
        compactThreshold: "critical",
        reviewBackends: ["codex", "agent"],
        handoverInterval: 5,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && result.action === "goto") {
      expect(result.target).toBe("PICK_TICKET");
    }
    expect(ctx.state.contextRotation).toBeNull();
  });

  it("routes to HANDOVER at critical pressure under the critical threshold", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 130,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
      config: {
        maxTicketsPerSession: 0,
        compactThreshold: "critical",
        reviewBackends: ["codex", "agent"],
        handoverInterval: 5,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && result.action === "goto") {
      expect(result.target).toBe("HANDOVER");
    }
    expect(instructionOf(result)).toContain("Context Rotation Required");
  });

  it("lets normal end-of-work HANDOVER win over pressure compaction", async () => {
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 60,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.enter(ctx);

    expect(isStageAdvance(result)).toBe(true);
    if (isStageAdvance(result) && result.action === "goto") {
      expect(result.target).toBe("HANDOVER");
    }
    expect(instructionOf(result)).not.toContain("Context Rotation Required");
  });

  it("routes a COMPLETE report to HANDOVER instead of a contradictory retry", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: {
        level: "low",
        guideCallCount: 60,
        ticketsCompleted: 1,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await stage.report(ctx, { completedAction: "acknowledged" });

    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("HANDOVER");
      expect("result" in result ? result.result?.instruction : "").toContain("Context Rotation Required");
      expect("result" in result ? result.result?.instruction : "").not.toContain('"action": "pre_compact"');
    }
  });

  it("writes one checkpoint when COMPLETE re-enters at the same work boundary", async () => {
    addOpenWork();
    const completedTickets = Array.from({ length: 3 }, (_, index) => ({ id: `T-${index + 1}` }));
    const ctx = new StageContext(root, sessionDir, makeState({
      completedTickets,
      guideCallCount: 0,
      contextPressure: {
        level: "low",
        guideCallCount: 0,
        ticketsCompleted: 3,
        compactionCount: 0,
        eventsLogBytes: 0,
      },
      config: {
        maxTicketsPerSession: 0,
        compactThreshold: "high",
        reviewBackends: ["codex", "agent"],
        handoverInterval: 3,
      },
    }), makeRecipe());

    await stage.enter(ctx);
    await stage.enter(ctx);

    expect(readdirSync(join(root, ".story", "handovers"))).toHaveLength(1);
    expect(ctx.state.lastCheckpointWorkCount).toBe(3);
  });

  // ISS-958 S6 fixup 2: the display-id tables are read before the .map callbacks (a hoist); the rendered ids are pinned here.
  it("renders resolved issues by display id in the checkpoint handover", async () => {
    addOpenWork();
    const ctx = new StageContext(root, sessionDir, makeState({
      completedTickets: [{ id: "T-001" }],
      resolvedIssues: ["i-0123456789abcdef", "ISS-009"],
      resolvedIssueDisplayIds: { "i-0123456789abcdef": "ISS-042" },
      guideCallCount: 0,
      config: { ...makeState().config, handoverInterval: 3 },
    }), makeRecipe());

    await stage.enter(ctx);

    const files = readdirSync(join(root, ".story", "handovers"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(root, ".story", "handovers", files[0]!), "utf-8")).toContain("**Issues resolved:** ISS-042, ISS-009");
  });

  it("renders resolved issues by display id when the session ends", async () => {
    const ctx = new StageContext(root, sessionDir, makeState({
      state: "HANDOVER",
      resolvedIssues: ["i-0123456789abcdef", "ISS-009"],
      resolvedIssueDisplayIds: { "i-0123456789abcdef": "ISS-042" },
    }), makeRecipe());

    const advance = await new HandoverStage().report(ctx, { completedAction: "handover_written", handoverContent: "# Session Handover\n\nWork done." });

    expect(advance.action).toBe("advance");
    const instruction = "result" in advance ? advance.result?.instruction ?? "" : "";
    expect(instruction).toContain("- ISS-042 (resolved)\n- ISS-009 (resolved)");
  });

  it("preserves rotation reason and remaining targets in the final handover", async () => {
    const state = makeState({
      state: "HANDOVER",
      targetWorkDisplayIds: { "i-0123456789abcdef": "ISS-042" },
      contextRotation: {
        level: "high",
        compactThreshold: "high",
        ticketsDone: 1,
        issuesDone: 0,
        remainingTargets: ["i-0123456789abcdef", "T-099"],
      },
    });
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());

    const result = await new HandoverStage().enter(ctx);

    expect(result.instruction).toContain("Context Rotation Required");
    expect(result.instruction).toContain("ISS-042");
    expect(result.instruction).toContain("T-099");
    expect(result.reminders).toContain("Do not select another item in this session.");
  });
});
