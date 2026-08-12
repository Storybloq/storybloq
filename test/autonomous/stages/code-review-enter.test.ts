import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

/**
 * CodeReviewStage.enter(), the sibling of plan-review-enter.test.ts.
 *
 * Two defects this pins, both found by mapping the two stages against each
 * other rather than by reading either one alone:
 *
 * 1. The default branch had NO report envelope. It ended at "When done, report
 *    verdict and findings" -- no session id, no completedAction, no verdict
 *    vocabulary -- making it the only instruction in either stage that did not
 *    tell the agent how to report. It surfaced when review mode switched to
 *    this stage and could no longer report a verdict at all.
 * 2. No bridgeCodex branch. PLAN_REVIEW has named `review_plan` since the
 *    bridge shipped; CODE_REVIEW named no tool, so a Claude-client session told
 *    to review with "codex" was left to guess. `review_code` appeared nowhere
 *    in src/ before this.
 */

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000009",
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"], handoverInterval: 3 },
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    previousState: "IMPLEMENT",
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

const recipe = {
  id: "coding",
  pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
  postComplete: [],
  stages: {},
  dirtyFileHandling: "block",
  defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex"], handoverInterval: 3 },
} as unknown as ResolvedRecipe;

describe("CodeReviewStage.enter", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CodeReviewStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-code-review-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const enter = async (state: Partial<FullSessionState> = {}) => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(state), recipe);
    return (await stage.enter(ctx)).instruction;
  };

  it("names the report contract with the CODE verdict vocabulary", async () => {
    const text = await enter();
    expect(text).toContain("storybloq_autonomous_guide");
    expect(text).toContain('"completedAction": "code_review_round"');
    // request_changes exists here and NOT in plan review, so this must not be
    // a copy of plan-review's envelope.
    expect(text).toContain("<approve|revise|request_changes|reject>");
    expect(text).toContain(makeState().sessionId);
  });

  it("names review_code on the bridge path", async () => {
    vi.stubEnv("STORYBLOQ_CLIENT", "claude");
    const text = await enter();
    expect(text).toContain("`review_code` MCP tool");
    expect(text).not.toContain("review_plan");
  });

  it("falls back to a review agent when the reviewer is not bridged codex", async () => {
    vi.stubEnv("STORYBLOQ_CLIENT", "claude");
    const text = await enter({
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    } as Partial<FullSessionState>);
    expect(text).toContain("Launch a code review agent");
    expect(text).not.toContain("review_code");
  });

  it("clamps the round header so it never counts down", async () => {
    // Without the clamp a high-risk ticket past its minimum prints
    // "Round 4 of 3 minimum". Once effort can LOWER the minimum this gets
    // worse: at light the minimum is 1, so every round after the first would
    // read "Round N of 1".
    const highRisk = { ticket: { id: "T-001", title: "t", risk: "high", claimed: true } } as Partial<FullSessionState>;
    expect(await enter(highRisk)).toContain("Round 1 of 3 minimum");

    const pastMinimum = {
      ...highRisk,
      reviews: {
        plan: [],
        code: [1, 2, 3].map((round) => ({
          round, reviewer: "codex", verdict: "revise",
          findingCount: 0, criticalCount: 0, unresolvedCriticalCount: 0,
          majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString(),
        })),
      },
    } as Partial<FullSessionState>;
    expect(await enter(pastMinimum)).toContain("Round 4 of 4 minimum");
  });

  // -------------------------------------------------------------------------
  // T-461 phase 3: the effort substitution actually reaching the instruction.
  // Without these the substitution is indistinguishable from dead code, because
  // every level behaves identically at `standard`.
  // -------------------------------------------------------------------------

  it("lowers the stated minimum at light and raises it at thorough", async () => {
    const highRisk = { ticket: { id: "T-001", title: "t", risk: "high", claimed: true } };
    // standard is the anchor: risk-derived, unchanged.
    expect(await enter(highRisk as Partial<FullSessionState>)).toContain("Round 1 of 3 minimum");
    // light collapses a high-risk item to a single round...
    expect(await enter({ ...highRisk, currentReviewEffort: "light" } as Partial<FullSessionState>))
      .toContain("Round 1 of 1 minimum");
    // ...and thorough lifts a LOW-risk item off its single round.
    expect(await enter({
      ticket: { id: "T-001", title: "t", risk: "low", claimed: true },
      currentReviewEffort: "thorough",
    } as Partial<FullSessionState>)).toContain("Round 1 of 2 minimum");
  });

  it("narrows to one fast reviewer at light without inventing one", async () => {
    vi.stubEnv("STORYBLOQ_CLIENT", "claude");
    const marker = { level: "light", source: "start-call" };
    // lenses fans out to many agents, so light drops it when codex is available.
    const text = await enter({
      currentReviewEffort: "light",
      resolvedReviewEffort: marker,
      config: {
        maxTicketsPerSession: 5, compactThreshold: "high",
        reviewBackends: ["lenses", "codex", "agent"], handoverInterval: 3,
      },
    } as Partial<FullSessionState>);
    expect(text).toContain("`review_code` MCP tool");
    expect(text).not.toContain("Multi-Lens");

    // A lenses-ONLY project keeps lenses: the dial narrows within the allowed
    // list and never invents a reviewer the project did not configure.
    const lensOnly = await enter({
      currentReviewEffort: "light",
      resolvedReviewEffort: marker,
      config: {
        maxTicketsPerSession: 5, compactThreshold: "high",
        reviewBackends: ["lenses"], handoverInterval: 3,
      },
    } as Partial<FullSessionState>);
    expect(lensOnly).toContain("Multi-Lens");
  });

  it("discloses the level on every branch, including standard", async () => {
    expect(await enter()).toContain("Review effort: standard (legacy)");

    vi.stubEnv("STORYBLOQ_CLIENT", "claude");
    expect(await enter({
      currentReviewEffort: "light",
      currentReviewEffortSource: "size-mapped",
      resolvedReviewEffort: { level: "light", source: "start-call" },
      config: {
        maxTicketsPerSession: 5, compactThreshold: "high",
        reviewBackends: ["lenses"], handoverInterval: 3,
      },
    } as Partial<FullSessionState>)).toContain("Review effort: light (size-mapped).");
  });

  /**
   * The depth wording is branch-appropriate, which is the whole reason the
   * `deliberate` clause was split out of it. `deliberate` is an argument of the
   * codex-bridge MCP tools; the lenses harness has no such input and a review
   * subagent has no tool call to put it on. An instruction naming it on those
   * paths tells the agent to pass an argument that does not exist.
   */
  it("names deliberate only where a tool accepts it", async () => {
    vi.stubEnv("STORYBLOQ_CLIENT", "claude");
    const light = { currentReviewEffort: "light" } as Partial<FullSessionState>;

    const bridge = await enter(light);
    expect(bridge).toContain("Call `review_code` MCP tool with the diff. Request a quick pass -- correctness blockers only, skip style and polish. Pass deliberate: false.");

    // Same level, agent reviewer: the depth ASK survives (the caller writes the
    // subagent's prompt), the deliberate argument does not.
    const agent = await enter({
      ...light,
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    } as Partial<FullSessionState>);
    expect(agent).toContain("Launch a code review agent to review the diff. Request a quick pass");
    expect(agent).not.toContain("deliberate");

    // Lenses composes its review programmatically: no depth ask, no argument,
    // but still disclosed.
    const lenses = await enter({
      ...light,
      resolvedReviewEffort: { level: "light", source: "start-call" },
      config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"], handoverInterval: 3 },
    } as Partial<FullSessionState>);
    expect(lenses).toContain("Multi-Lens");
    expect(lenses).not.toContain("deliberate");
    expect(lenses).not.toContain("quick pass");
    expect(lenses).toContain("Review effort: light");
  });

  it("records when the round started", async () => {
    const ctx = new StageContext(testRoot, sessionDir, makeState(), recipe);
    await stage.enter(ctx);
    expect(ctx.state.currentReviewStartedAt).toBeTruthy();
  });
});
