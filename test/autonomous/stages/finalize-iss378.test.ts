/**
 * ISS-378: FINALIZE commit-hash HEAD-drift validation.
 *
 * Before the fix, handleCommit rejected any reported commit whose hash didn't
 * match HEAD via startsWith. When a session was orphaned and resumed after
 * unrelated commits landed, the work commit was unreachable via strict
 * HEAD-equality even though it was still in branch history.
 *
 * The fix: keep the HEAD-prefix fast path for the common no-drift case; on
 * miss, resolve the reported hash and check membership in the candidate set
 * of commits on the ancestry path between initHead and HEAD that touched the
 * expected ticket/issue artifact.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn(),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffTreeNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitResolveCommit: vi.fn(),
  gitRevListAncestryPath: vi.fn(),
}));

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import {
  gitHead,
  gitResolveCommit,
  gitRevListAncestryPath,
} from "../../../src/autonomous/git-inspector.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

const mockedGitHead = vi.mocked(gitHead);
const mockedGitResolveCommit = vi.mocked(gitResolveCommit);
const mockedGitRevListAncestryPath = vi.mocked(gitRevListAncestryPath);

const A40 = "a".repeat(40);
const B40 = "b".repeat(40);
const C40 = "c".repeat(40);
const E40 = "e".repeat(40);

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: "00000000-0000-0000-0000-0000000003f8",
    recipe: "coding",
    state: "FINALIZE",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: "precommit_passed",
    git: {
      branch: "main",
      mergeBase: B40,
      expectedHead: B40,
      initHead: B40,
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
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
    guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
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
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

describe("ISS-378: FINALIZE commit-hash HEAD-drift validation", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new FinalizeStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-iss378-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mockedGitHead.mockReset();
    mockedGitResolveCommit.mockReset();
    mockedGitRevListAncestryPath.mockReset();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("1. acceptsReportForHeadCommit — normal case, fast-path regression guard", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "aaaaaaa" });

    expect(advance.action).toBe("advance");
    expect(mockedGitResolveCommit).not.toHaveBeenCalled();
    expect(mockedGitRevListAncestryPath).not.toHaveBeenCalled();

    const written = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as FullSessionState;
    expect(written.completedTickets[0]?.commitHash).toBe(A40);
    expect(written.git.expectedHead).toBe(A40);
    expect(written.git.mergeBase).toBe(A40);
  });

  it("2. acceptsReportForShortPrefixWhenHeadMatches — sub-4-char prefix regression guard", async () => {
    const head = "abc" + "f".repeat(37);
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: head, branch: "main" } });
    const state = makeState({ git: { branch: "main", mergeBase: B40, expectedHead: B40, initHead: B40 } as FullSessionState["git"] });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "abc" });

    expect(advance.action).toBe("advance");
    expect(mockedGitResolveCommit).not.toHaveBeenCalled();
    expect(mockedGitRevListAncestryPath).not.toHaveBeenCalled();

    const written = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as FullSessionState;
    expect(written.completedTickets[0]?.commitHash).toBe(head);
  });

  it("3. acceptsReportForUppercasePrefixWhenHeadMatches — lowercase normalization guard", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "AAAAAAA" });

    expect(advance.action).toBe("advance");
    expect(mockedGitResolveCommit).not.toHaveBeenCalled();
    expect(mockedGitRevListAncestryPath).not.toHaveBeenCalled();

    const written = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as FullSessionState;
    expect(written.completedTickets[0]?.commitHash).toBe(A40);
  });

  it("4. acceptsReportForCommitInBranchHistory — core ISS-378 drift case", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });
    mockedGitRevListAncestryPath.mockResolvedValue({ ok: true, data: [A40] });

    const state = makeState({
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "aaaaaaa" });

    expect(advance.action).toBe("advance");
    expect(mockedGitRevListAncestryPath).toHaveBeenCalledWith(testRoot, B40, E40, ".story/tickets/T-001.json");

    const written = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as FullSessionState;
    expect(written.completedTickets[0]?.commitHash).toBe(A40);
    expect(written.git.expectedHead).toBe(E40);
    expect(written.git.mergeBase).toBe(E40);

    // Audit-trail contract: events.log records the work commit (normalizedHash), not fullHead.
    const events = readFileSync(join(sessionDir, "events.log"), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
    const commitEvent = events.find((e) => e.type === "commit");
    expect(commitEvent?.data.commitHash).toBe(A40);
    expect(commitEvent?.data.ticketId).toBe("T-001");
  });

  it("5. acceptsReportWhenMultipleCandidateCommitsTouchedArtifact — multiplicity is OK", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });
    mockedGitRevListAncestryPath.mockResolvedValue({ ok: true, data: [A40, C40] });

    const state = makeState({
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "aaaaaaa" });

    expect(advance.action).toBe("advance");
    const written = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as FullSessionState;
    expect(written.completedTickets[0]?.commitHash).toBe(A40);
  });

  it("6. rejectsReportForCommitOutsideCandidateSet — slow-path membership check", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: C40 });
    mockedGitRevListAncestryPath.mockResolvedValue({ ok: true, data: [A40] });

    const state = makeState({
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "ccccccc" });

    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("not a session work commit");
    expect(advance.instruction).toContain(B40.slice(0, 7));
    expect(advance.instruction).toContain(E40.slice(0, 7));
  });

  it("7. rejectsReportWhenNoCommitTouchedArtifact — empty candidate set", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: C40 });
    mockedGitRevListAncestryPath.mockResolvedValue({ ok: true, data: [] });

    const state = makeState({
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "ccccccc" });

    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("No commit on the session ancestry path touched");
    expect(advance.instruction).toContain(".story/tickets/T-001.json");
  });

  it("8. rejectsReportForNonexistentCommit — rev-parse fails", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: false, reason: "git_error", message: "unknown revision" });

    const state = makeState({
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "bogus11" });

    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("does not exist in the repository");
    expect(mockedGitRevListAncestryPath).not.toHaveBeenCalled();
  });

  it("9. rejectsReportForPreviousHeadAsNewCommit — no-new-commit guard regression", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: B40, branch: "main" } });

    const state = makeState({
      git: { branch: "main", mergeBase: B40, expectedHead: B40, initHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: B40 });

    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("No new commit detected");
  });

  it("10. acceptsIssueFixReportForDriftCommit — issue-path variant (ISS-374 observed case)", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });
    mockedGitRevListAncestryPath.mockResolvedValue({ ok: true, data: [A40] });

    const state = makeState({
      ticket: undefined,
      currentIssue: { id: "ISS-999", title: "Test issue", severity: "high" },
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: B40 } as FullSessionState["git"],
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "aaaaaaa" });

    expect(advance.action).toBe("goto");
    expect(mockedGitRevListAncestryPath).toHaveBeenCalledWith(testRoot, B40, E40, ".story/issues/ISS-999.json");

    const written = JSON.parse(readFileSync(join(sessionDir, "state.json"), "utf-8")) as FullSessionState;
    expect(written.resolvedIssues).toContain("ISS-999");
    expect(written.git.expectedHead).toBe(E40);
    expect(written.git.mergeBase).toBe(E40);
  });

  it("11. rejectsReportWhenGitHeadFails — gitHead failure branch", async () => {
    mockedGitHead.mockResolvedValue({ ok: false, reason: "git_error", message: "boom" });

    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "aaaaaaa" });

    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("Cannot resolve HEAD");
    expect(advance.instruction).toContain("boom");
    expect(mockedGitResolveCommit).not.toHaveBeenCalled();
    expect(mockedGitRevListAncestryPath).not.toHaveBeenCalled();
  });

  it("12. rejectsReportWhenAncestryPathEnumerationFails — git error in slow path", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });
    mockedGitRevListAncestryPath.mockResolvedValue({ ok: false, reason: "git_error", message: "rev-list crashed" });

    const state = makeState({
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "aaaaaaa" });

    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("Cannot enumerate candidate commits");
    expect(advance.instruction).toContain(".story/tickets/T-001.json");
    expect(advance.instruction).toContain("rev-list crashed");
  });

  it("13. rejectsReportWhenInitHeadMissing — slow path without session baseline", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: E40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });

    const state = makeState({
      git: { branch: "main", mergeBase: E40, expectedHead: E40, initHead: undefined } as unknown as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());

    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: "aaaaaaa" });

    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("no session baseline is available");
    expect(mockedGitRevListAncestryPath).not.toHaveBeenCalled();
  });
});
