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
  // ISS-982: this file is not about attribution, so every commit_done report
  // below passes overrideAttribution: true. These are still called
  // unconditionally when the fast path fires (Mutant E's design), so they
  // need a resolved value even though the override makes it moot.
  gitCommitterEmail: vi.fn().mockResolvedValue({ ok: true, data: "unused@example.com" }),
  gitUserEmail: vi.fn().mockResolvedValue("unused@example.com"),
}));

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import { gitHead, gitCommitterEmail, gitUserEmail } from "../../../src/autonomous/git-inspector.js";
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
    // ISS-982: re-establish after vi.restoreAllMocks() wipes the module-factory default.
    vi.mocked(gitCommitterEmail).mockResolvedValue({ ok: true, data: "unused@example.com" });
    vi.mocked(gitUserEmail).mockResolvedValue("unused@example.com");
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

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456", overrideAttribution: true });

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

    await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456", overrideAttribution: true });

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

    await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456", overrideAttribution: true });

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

    await stage.report(ctx, { completedAction: "commit_done", commitHash: "ghi789", overrideAttribution: true });

    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;
    expect(written.ticketStartedAt).toBeNull();
  });
});

/**
 * T-450 step 7a: WHICH ITEM DID THIS FINALIZE FINALIZE?
 *
 * At `finalizeCheckpoint: "committed"` the session no longer names its own
 * item: the same write that records the checkpoint also clears `ticket` (or
 * `currentIssue`). Everything downstream that has to attribute a crashed
 * FINALIZE -- `resolveFinalizeItem`, and through it the takeover authority
 * matrix -- reads `finalizedItem` and nothing else, because the fallbacks are
 * strictly weaker: `resolvedIssues` holds bare id strings with no commit hash,
 * `completedTickets` is a different collection entirely, and a session that
 * finished one of each cannot be told apart from them at all.
 *
 * So `finalizedItem` has to be WRITTEN, in that same state, or the read is
 * decoration. These pin the write on both arms: the issue arm (where the
 * evidence is thinnest) and the ticket arm.
 */
describe("T-450 7a: FINALIZE records the item it committed", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new FinalizeStage();
  const mockedGitHead = vi.mocked(gitHead);

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-t450-7a-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "def456" } });
    // ISS-982: re-establish after vi.restoreAllMocks() wipes the module-factory default.
    vi.mocked(gitCommitterEmail).mockResolvedValue({ ok: true, data: "unused@example.com" });
    vi.mocked(gitUserEmail).mockResolvedValue("unused@example.com");
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("ISSUE arm: finalizedItem names the issue and its hash, in the same state that clears currentIssue", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "ghi789" } });
    const state = makeState({
      finalizeCheckpoint: "precommit_passed",
      currentIssue: { id: "ISS-001", title: "Test issue", severity: "high" },
      ticket: undefined,
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "ghi789", overrideAttribution: true });
    expect(advance.action).toBe("goto");

    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;

    // ONE state carries all three facts. Asserting them together is the point:
    // the checkpoint that makes the session anonymous, the clearing that makes
    // it anonymous, and the record that survives it must not be separable.
    expect(written.finalizeCheckpoint).toBe("committed");
    expect(written.currentIssue).toBeNull();
    expect(written.finalizedItem).toEqual({
      kind: "issue", id: "ISS-001", commitHash: "ghi789",
    });

    // AND the fallback really is weaker, which is why the record above has to
    // exist: the resolved-issue list carries the id with no hash and no kind.
    expect(written.resolvedIssues).toContain("ISS-001");
  });

  it("TICKET arm: finalizedItem names the ticket and its hash, in the same state that clears ticket", async () => {
    const state = makeState({ finalizeCheckpoint: "precommit_passed" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456", overrideAttribution: true });
    expect(advance.action).toBe("advance");

    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;

    expect(written.finalizeCheckpoint).toBe("committed");
    expect(written.ticket).toBeUndefined();
    expect(written.finalizedItem).toEqual({
      kind: "ticket", id: "T-001", commitHash: "def456",
    });
  });

  it("NO-ITEM arm: finalizedItem is recorded as kind 'none', never left null", async () => {
    // THE RE-ENTRY SHAPE: FINALIZE reaches `committed` with neither a ticket
    // nor an issue to attribute.
    //
    // Null would be the obvious spelling and it is the dangerous one, which is
    // why this asserts against it explicitly rather than only asserting the
    // positive value. Null is ALSO how a state written before this field
    // appears, so the reader cannot tell the two apart and falls into the
    // legacy fallback -- which guesses from `completedTickets` /
    // `resolvedIssues`. This session has a prior completed ticket, so that
    // guess would name T-000 as the item THIS checkpoint committed, and a
    // takeover would then be authorized against work this commit is not about.
    // Recording `none` positively is what makes null mean legacy and nothing
    // else.
    const priorTicket = {
      id: "T-000", title: "an earlier ticket this session already finished",
      commitHash: "aaa111", completedAt: "2026-04-04T09:00:00.000Z",
    };
    const state = makeState({
      finalizeCheckpoint: "precommit_passed",
      ticket: undefined,
      currentIssue: undefined,
      completedTickets: [priorTicket],
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "def456", overrideAttribution: true });
    expect(advance.action).toBe("advance");

    const written = JSON.parse(
      readFileSync(join(sessionDir, "state.json"), "utf-8"),
    ) as FullSessionState;

    expect(written.finalizeCheckpoint).toBe("committed");
    expect(written.finalizedItem).toEqual({ kind: "none", commitHash: "def456" });
    // Said twice on purpose: the value above is the fix, and `not null` is the
    // defect it replaced. A future change that reverts to null would satisfy
    // neither, but only this line says WHY.
    expect(written.finalizedItem).not.toBeNull();

    // Nothing was completed by this commit, so the prior list is untouched --
    // which is exactly what makes the legacy fallback's guess wrong rather
    // than merely imprecise.
    expect(written.completedTickets).toEqual([priorTicket]);
  });
});
