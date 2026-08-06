/**
 * ISS-982: FINALIZE's handleCommit fast path (reported hash equals or
 * prefixes HEAD) accepted a commit with zero further validation -- an agent
 * re-reporting the exact hash a refused auto-detect fast-forward had already
 * observed took this path and bypassed both the ancestry-path enumeration
 * and the artifact-tree check entirely (R2-F1). This suite pins the new
 * commit-attribution check centralized in handleCommit's fast path, the
 * five-way outcome split by current item kind (R4-F2), the explicit
 * overrideAttribution escape, the durable commitAttributionAudits trail
 * (PEN-F1), and the enter()/handleStage fail-open tree-check fix (R2-F1
 * related).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn(),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffTreeNames: vi.fn(),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitResolveCommit: vi.fn(),
  gitRevListAncestryPath: vi.fn(),
  gitCommitterEmail: vi.fn(),
  gitUserEmail: vi.fn(),
}));

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../../src/autonomous/stages/finalize.js";
import {
  gitHead,
  gitDiffTreeNames,
  gitDiffCachedNames,
  gitResolveCommit,
  gitRevListAncestryPath,
  gitCommitterEmail,
  gitUserEmail,
} from "../../../src/autonomous/git-inspector.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

const mockedGitHead = vi.mocked(gitHead);
const mockedGitDiffTreeNames = vi.mocked(gitDiffTreeNames);
const mockedGitDiffCachedNames = vi.mocked(gitDiffCachedNames);
const mockedGitResolveCommit = vi.mocked(gitResolveCommit);
const mockedGitRevListAncestryPath = vi.mocked(gitRevListAncestryPath);
const mockedGitCommitterEmail = vi.mocked(gitCommitterEmail);
const mockedGitUserEmail = vi.mocked(gitUserEmail);

const A40 = "a".repeat(40);
const B40 = "b".repeat(40);

const CLAIM_EMAIL = "claimant@example.com";
const LIVE_EMAIL = "live@example.com";
const OTHER_EMAIL = "other@example.com";
const SESSION_ID = "00000000-0000-0000-0000-000000000982";

function makeEpoch(overrides: Partial<{
  ticketId: string; sessionId: string; user: string | null; branch: string | null; since: string | null; establishedAt: string;
}> = {}) {
  return {
    ticketId: "T-001",
    sessionId: SESSION_ID,
    user: CLAIM_EMAIL,
    branch: "main",
    since: "2026-01-01T00:00:00.000Z",
    establishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "FINALIZE",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    commitAttributionAudits: [],
    finalizeCheckpoint: "precommit_passed",
    git: {
      branch: "main",
      mergeBase: B40,
      expectedHead: B40,
      initHead: B40,
      itemBaseHead: B40,
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
    claimEpoch: makeEpoch(),
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as unknown as FullSessionState;
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

/** null when the stage returned before ever calling ctx.writeState (a pure in-memory refusal). */
function readState(sessionDir: string): FullSessionState | null {
  const path = join(sessionDir, "state.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as FullSessionState;
}

/** events.log is created lazily by the first appendEvent call; absent means none was ever appended. */
function readEvents(sessionDir: string): Array<{ type: string; data: Record<string, unknown> }> {
  const path = join(sessionDir, "events.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("ISS-982: FINALIZE commit-attribution check", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new FinalizeStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "test-iss982-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    mockedGitHead.mockReset();
    mockedGitDiffTreeNames.mockReset();
    mockedGitDiffCachedNames.mockReset();
    mockedGitResolveCommit.mockReset();
    mockedGitRevListAncestryPath.mockReset();
    mockedGitCommitterEmail.mockReset();
    mockedGitUserEmail.mockReset();
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test 1: enter() fast-forward, ticket-mode epoch match -- non-regression
  // -------------------------------------------------------------------------
  it("1. enter() fast-forwards a HEAD-advanced ticket commit whose committer matches the claim epoch", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: CLAIM_EMAIL });

    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect((result as { action?: string }).action).toBe("advance");
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).toBe("committed");
    expect(written.completedTickets[0]?.commitHash).toBe(A40);
  });

  // -------------------------------------------------------------------------
  // Test 2: committer mismatch, no override -- refused, no commit recorded
  // -------------------------------------------------------------------------
  it("2. refuses a ticket commit whose committer mismatches the claim epoch, with no override", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: OTHER_EMAIL });

    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect((result as { action?: string }).action).toBe("retry");
    expect((result as { instruction?: string }).instruction).toContain("could not be attributed");
    expect((result as { instruction?: string }).instruction).toContain("overrideAttribution: true");

    // No commit recorded: checkpoint never reaches "committed", no finalizedItem/
    // completedTickets/resolvedIssues touched, no commit event appended.
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).not.toBe("committed");
    expect(written.finalizedItem).toBeFalsy();
    expect(written.completedTickets).toEqual([]);
    const events = readEvents(sessionDir);
    expect(events.find((e) => e.type === "commit")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test 3: explicit override -- accepted, event carries attributionOverrideRequested
  // -------------------------------------------------------------------------
  it("3. accepts a mismatched commit when overrideAttribution: true is reported, and records the override", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: OTHER_EMAIL });

    const state = makeState({ finalizeCheckpoint: "precommit_passed" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40, overrideAttribution: true });

    expect(advance.action).toBe("advance");
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).toBe("committed");
    expect(written.commitAttributionAudits?.[0]).toMatchObject({
      commitHash: A40, itemKind: "ticket", itemId: "T-001", overrideRequested: true,
    });
    const events = readEvents(sessionDir);
    const commitEvent = events.find((e) => e.type === "commit");
    expect(commitEvent?.data.attributionOverrideRequested).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: issue-mode heuristic (match + mismatch)
  // -------------------------------------------------------------------------
  it("4a. issue-mode fast-forwards when committer matches the live git identity", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [".story/issues/ISS-999.json"] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: LIVE_EMAIL });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    const state = makeState({ ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-999", title: "fixture", severity: "high" } } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect((result as { action?: string }).action).toBe("goto");
    const written = readState(sessionDir);
    expect(written.resolvedIssues).toContain("ISS-999");
  });

  it("4b. issue-mode refuses when committer mismatches the live git identity", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [".story/issues/ISS-999.json"] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: OTHER_EMAIL });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    const state = makeState({ ticket: undefined, claimEpoch: undefined, currentIssue: { id: "ISS-999", title: "fixture", severity: "high" } } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect((result as { action?: string }).action).toBe("retry");
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).not.toBe("committed");
    expect(written.resolvedIssues ?? []).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 5: handleStage ISS-046 fallback reproduces cases 1-4
  // -------------------------------------------------------------------------
  it("5a. handleStage ISS-046 fallback: committer matches claim epoch -> fast-forwards", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffCachedNamesReturnsEmpty();
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: CLAIM_EMAIL });

    // checkpoint must NOT be "staged"/"staged_override" -- handleStage
    // short-circuits with a generic "now commit" retry before reaching the
    // ISS-046 fallback this test exercises.
    const state = makeState({ finalizeCheckpoint: null });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "files_staged" });

    expect(advance.action).toBe("advance");
  });

  it("5b. handleStage ISS-046 fallback: committer mismatches claim epoch -> refused, no commit recorded", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffCachedNamesReturnsEmpty();
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: OTHER_EMAIL });

    const state = makeState({ finalizeCheckpoint: null });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "files_staged" });

    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("could not be attributed");
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).not.toBe("committed");
  });

  // -------------------------------------------------------------------------
  // Test 6: fail-open tree-check git-error case (R2-F1)
  // -------------------------------------------------------------------------
  it("6a. enter(): gitDiffTreeNames failing does NOT fast-forward through handleCommit", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: false, reason: "git_error", message: "boom" });

    const state = makeState();
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    // Falls through to the normal "stage files" instruction, not an advance.
    expect((result as { action?: string }).action).toBeUndefined();
    expect((result as { instruction?: string }).instruction).toContain("Finalize");
    expect(mockedGitCommitterEmail).not.toHaveBeenCalled();
    // ctx.writeState was never called at all -- state.json does not exist.
    expect(readState(sessionDir)?.finalizeCheckpoint).not.toBe("committed");
  });

  it("6b. handleStage ISS-046 fallback: gitDiffTreeNames failing returns a diagnostic, not a false accept", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffCachedNamesReturnsEmpty();
    mockedGitDiffTreeNames.mockResolvedValue({ ok: false, reason: "git_error", message: "boom" });

    const state = makeState({ finalizeCheckpoint: null });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "files_staged" });

    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("could not be verified");
    expect(mockedGitCommitterEmail).not.toHaveBeenCalled();
    // handleStage's own early return fires before any ctx.writeState call.
    expect(readState(sessionDir)?.finalizeCheckpoint).not.toBe("committed");
  });

  // -------------------------------------------------------------------------
  // Test 7: abbreviated-hash report, mismatch still refused (disjunctive gate)
  // -------------------------------------------------------------------------
  it("7. abbreviated-hash report with mismatched committer is refused via the same check", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: OTHER_EMAIL });

    const state = makeState({ finalizeCheckpoint: "precommit_passed" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40.slice(0, 7) });

    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("could not be attributed");
    expect(mockedGitResolveCommit).not.toHaveBeenCalled();
    expect(mockedGitRevListAncestryPath).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8: fail-closed coverage
  // -------------------------------------------------------------------------
  it("8a. gitCommitterEmail git error is treated as non-attributable, refused", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitCommitterEmail.mockResolvedValue({ ok: false, reason: "git_error", message: "unreachable" });

    const state = makeState({ finalizeCheckpoint: "precommit_passed" });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });

    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("could not be attributed");
  });

  it("8b. ticket-mode with a malformed claimEpoch is refused without falling back to the heuristic", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    const state = makeState({ finalizeCheckpoint: "precommit_passed", claimEpoch: { garbage: true } } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });

    expect(advance.action).toBe("retry");
    expect(mockedGitUserEmail).not.toHaveBeenCalled();
  });

  it("8c. ticket-mode with a ticketId-mismatched claimEpoch is refused without falling back to the heuristic", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    const state = makeState({ finalizeCheckpoint: "precommit_passed", claimEpoch: makeEpoch({ ticketId: "T-999" }) } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });

    expect(advance.action).toBe("retry");
    expect(mockedGitUserEmail).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 10: mixed ticket-then-issue session, stale epoch must not be consulted
  // -------------------------------------------------------------------------
  it("10. issue commit after a same-session ticket completion uses the live heuristic, not the stale ticket epoch", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: LIVE_EMAIL });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    // Ticket cleared (completed earlier this session), claimEpoch left behind
    // (finalize.ts's ticket-completion write does not clear it), issue now current.
    const state = makeState({
      ticket: undefined,
      currentIssue: { id: "ISS-999", title: "fixture", severity: "high" },
      claimEpoch: makeEpoch({ user: CLAIM_EMAIL }), // deliberately != LIVE_EMAIL
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });

    expect(advance.action).toBe("goto");
    const written = readState(sessionDir);
    expect(written.resolvedIssues).toContain("ISS-999");
  });

  // -------------------------------------------------------------------------
  // Test 11: ISS-925 non-worsening -- attribution never runs on the equality refusal
  // -------------------------------------------------------------------------
  it("11. ISS-925 equality-refusal path never invokes the attribution check", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: B40, branch: "main" } });

    const state = makeState({
      git: { branch: "main", mergeBase: B40, expectedHead: B40, initHead: undefined, itemBaseHead: B40 } as FullSessionState["git"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: B40 });

    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("No new commit detected");
    expect(mockedGitCommitterEmail).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 13/13b/13c: no-current-item (outcome 5)
  // -------------------------------------------------------------------------
  it("13. itemless commit is refused when committer mismatches the live git identity", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: OTHER_EMAIL });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    const state = makeState({ ticket: undefined, currentIssue: null, claimEpoch: undefined } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect((result as { action?: string }).action).toBe("retry");
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).not.toBe("committed");
  });

  it("13b. itemless commit fast-forwards when committer matches the live git identity", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: LIVE_EMAIL });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    const state = makeState({ ticket: undefined, currentIssue: null, claimEpoch: undefined } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect((result as { action?: string }).action).toBe("advance");
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).toBe("committed");
    expect(written.commitAttributionAudits?.[0]).toMatchObject({ itemKind: "none", itemId: null });
  });

  it("13c. itemless commit with a residual stale epoch still uses the live heuristic, ignoring the epoch", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [] });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: LIVE_EMAIL });
    mockedGitUserEmail.mockResolvedValue(LIVE_EMAIL);

    // Residual epoch from a just-completed ticket, deliberately mismatching
    // the live identity that the committer actually matches.
    const state = makeState({
      ticket: undefined,
      currentIssue: null,
      claimEpoch: makeEpoch({ user: CLAIM_EMAIL }),
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const result = await stage.enter(ctx);

    expect((result as { action?: string }).action).toBe("advance");
    const written = readState(sessionDir);
    expect(written.finalizeCheckpoint).toBe("committed");
  });

  // -------------------------------------------------------------------------
  // Test 14: contradictory both-items-present -- fails closed unconditionally
  // -------------------------------------------------------------------------
  it("14. refuses a commit when both a current ticket and a current issue are present, even with a matching epoch", async () => {
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: CLAIM_EMAIL });

    const state = makeState({
      currentIssue: { id: "ISS-999", title: "fixture", severity: "high" },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const advance = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });

    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("could not be attributed");
    // handleCommit's refusal fires before any ctx.writeState call for this shape.
    expect(readState(sessionDir)?.finalizeCheckpoint).not.toBe("committed");
  });
});

function mockedGitDiffCachedNamesReturnsEmpty() {
  // handleStage's own gitDiffCachedNames() call (mocked to ok:false by
  // default above) must report an EMPTY staged set so it takes the
  // ISS-046 "agent already committed" branch this suite exercises.
  mockedGitDiffCachedNames.mockResolvedValue({ ok: true, data: [] });
}
