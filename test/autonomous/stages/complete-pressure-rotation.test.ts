/**
 * ISS-034: context-pressure enforcement.
 *
 * Before this change, evaluatePressure()'s result was written to
 * contextPressure.level for display but never acted upon: the COMPLETE stage
 * always continued to PICK_TICKET while work remained, regardless of pressure,
 * and config.compactThreshold was a no-op. These tests pin the enforced
 * behavior: at a COMPLETE boundary, when the evaluated level has reached the
 * configured compactThreshold, the session rotates (routes to HANDOVER) instead
 * of picking more work.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, isStageAdvance } from "../../../src/autonomous/stages/types.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import { pressureMeetsThreshold } from "../../../src/autonomous/context-pressure.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../../src/autonomous/stages/types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "COMPLETE", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [{ id: "T-001" }],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 5 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "none",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  } as ResolvedRecipe;
}

/** Read the goto target from a StageAdvance. */
function gotoTarget(result: unknown): string | undefined {
  if (result && typeof result === "object" && "action" in result && (result as { action: string }).action === "goto") {
    return (result as { target?: string }).target;
  }
  return undefined;
}

/** Read the instruction string from a StageAdvance carrying a StageResult. */
function instructionOf(result: unknown): string {
  if (result && typeof result === "object" && "result" in result) {
    const r = (result as { result?: { instruction?: string } }).result;
    return r?.instruction ?? "";
  }
  return "";
}

describe("pressureMeetsThreshold — ordinal comparison", () => {
  it("returns true only when level rank >= threshold rank", () => {
    // default threshold "high"
    expect(pressureMeetsThreshold("low", "high")).toBe(false);
    expect(pressureMeetsThreshold("medium", "high")).toBe(false);
    expect(pressureMeetsThreshold("high", "high")).toBe(true);
    expect(pressureMeetsThreshold("critical", "high")).toBe(true);
    // conservative threshold "critical" — only critical fires
    expect(pressureMeetsThreshold("high", "critical")).toBe(false);
    expect(pressureMeetsThreshold("critical", "critical")).toBe(true);
    // aggressive threshold "medium"
    expect(pressureMeetsThreshold("medium", "medium")).toBe(true);
    expect(pressureMeetsThreshold("low", "medium")).toBe(false);
  });

  it("falls back to 'high' for an unknown/legacy threshold value", () => {
    expect(pressureMeetsThreshold("high", "low")).toBe(true);   // "low" -> "high"
    expect(pressureMeetsThreshold("medium", "low")).toBe(false);
    expect(pressureMeetsThreshold("high", undefined)).toBe(true);
    expect(pressureMeetsThreshold("medium", undefined)).toBe(false);
  });
});

describe("CompleteStage — ISS-034 context-pressure rotation", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "complete-pressure-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(testRoot, ".story", "tickets"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "issues"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "notes"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "handovers"), { recursive: true });
    mkdirSync(join(testRoot, ".story", "lessons"), { recursive: true });
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({ version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript", features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true } }));
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({ title: "test", date: "2026-01-01", phases: [], blockers: [] }));
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  /**
   * Add an open issue so COMPLETE sees remaining work. With an empty roadmap
   * nextTickets() returns "empty_project", so the routing falls through to the
   * open-issues check (complete.ts) -- an open issue makes nextTarget PICK_TICKET.
   */
  function addOpenWork(): void {
    writeFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), JSON.stringify({
      id: "ISS-001", title: "Open bug", status: "open", severity: "medium",
      components: [], impact: "needs fixing", resolution: null, resolvedDate: null,
      discoveredDate: "2026-01-01", relatedTickets: [], location: [],
    }));
  }

  it("continues to PICK_TICKET at low pressure with work remaining (regression)", async () => {
    addOpenWork();
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 5, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    expect(gotoTarget(result)).toBe("PICK_TICKET");
  });

  it("rotates to HANDOVER when pressure reaches the default 'high' threshold", async () => {
    addOpenWork();
    // default "high" tier: level becomes "high" at 60+ guide calls
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 60, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(gotoTarget(result)).toBe("HANDOVER");
    const instr = instructionOf(result);
    expect(instr).toContain("Session Rotating");
    expect(instr).toContain("compactThreshold");
  });

  it("does NOT rotate at 'high' pressure when compactThreshold is the conservative 'critical'", async () => {
    addOpenWork();
    // critical tier: 90 calls -> level "high" (>=80) but not "critical" (<=120)
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 90, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
      config: { maxTicketsPerSession: 0, compactThreshold: "critical", reviewBackends: ["codex", "agent"], handoverInterval: 5 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(gotoTarget(result)).toBe("PICK_TICKET");
  });

  it("rotates once 'critical' pressure is reached under the 'critical' threshold", async () => {
    addOpenWork();
    // critical tier: >120 calls -> level "critical"
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 130, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
      config: { maxTicketsPerSession: 0, compactThreshold: "critical", reviewBackends: ["codex", "agent"], handoverInterval: 5 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(gotoTarget(result)).toBe("HANDOVER");
    expect(instructionOf(result)).toContain("Session Rotating");
  });

  it("does not hijack a normal end-of-work HANDOVER (no work left)", async () => {
    // No open ticket -> nextTarget is HANDOVER regardless of pressure; the
    // pressure gate must not fire (it only overrides a would-be PICK_TICKET).
    const state = makeState({
      contextPressure: { level: "low", guideCallCount: 60, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);
    expect(gotoTarget(result)).toBe("HANDOVER");
    const instr = instructionOf(result);
    expect(instr).toContain("Session Complete");
    expect(instr).not.toContain("Session Rotating");
  });
});
