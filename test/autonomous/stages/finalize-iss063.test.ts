/**
 * ISS-063: FINALIZE idempotent checkpoint + session ticket exclusion.
 * T-187: Per-ticket timing in completedTickets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock git-inspector for T-187 commit tests
vi.mock("../../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "def456" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
}));

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import { gitHead } from "../../../src/autonomous/git-inspector.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "FINALIZE", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: {
      branch: "main", mergeBase: "abc123", expectedHead: "abc123",
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("ISS-063: FINALIZE idempotent checkpoint", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new FinalizeStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-iss063-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  it("repeated files_staged at 'staged' checkpoint returns commit instruction", async () => {
    const state = makeState({ finalizeCheckpoint: "staged" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "files_staged" });
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("commit_done");
  });

  it("repeated files_staged at 'staged_override' returns commit instruction", async () => {
    const state = makeState({ finalizeCheckpoint: "staged_override" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "files_staged" });
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("commit_done");
  });
});

describe("T-187: per-ticket timing in completedTickets", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new FinalizeStage();
  const mockedGitHead = vi.mocked(gitHead);

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-t187-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "def456" } });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("includes startedAt and completedAt when ticketStartedAt is set", async () => {
    const startTime = "2026-04-04T10:00:00.000Z";
    const state = makeState({
      finalizeCheckpoint: "precommit_passed",
      ticketStartedAt: startTime,
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456" });

    expect(advance.action).toBe("advance");
    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;
    const last = written.completedTickets[written.completedTickets.length - 1];
    expect(last.startedAt).toBe(startTime);
    expect(last.completedAt).toBeDefined();
    expect(new Date(last.completedAt!).getTime()).toBeGreaterThan(0);
  });

  it("clears ticketStartedAt after commit", async () => {
    const state = makeState({
      finalizeCheckpoint: "precommit_passed",
      ticketStartedAt: "2026-04-04T10:00:00.000Z",
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456" });

    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;
    expect(written.ticketStartedAt).toBeNull();
  });

  it("startedAt is undefined when ticketStartedAt is null (backward compat)", async () => {
    const state = makeState({
      finalizeCheckpoint: "precommit_passed",
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456" });

    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;
    const last = written.completedTickets[written.completedTickets.length - 1];
    expect(last.startedAt).toBeUndefined();
    expect(last.completedAt).toBeDefined();
  });

  it("clears ticketStartedAt in issue-fix commit path", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "ghi789" } });
    const state = makeState({
      finalizeCheckpoint: "precommit_passed",
      ticketStartedAt: "2026-04-04T09:00:00.000Z",
      currentIssue: { id: "ISS-001", title: "Test issue", severity: "high" },
      ticket: undefined,
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    await stage.report(ctx, { completedAction: "commit_done", commitHash: "ghi789" });

    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;
    expect(written.ticketStartedAt).toBeNull();
  });
});
