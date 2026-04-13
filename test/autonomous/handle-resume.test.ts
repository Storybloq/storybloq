/**
 * ISS-039: Integration tests for handleResume.
 *
 * Tests the real handleAutonomousGuide with action: "resume" against
 * actual session state files on disk. Git operations are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock git-inspector before importing guide
vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { gitHead, gitIsAncestor } from "../../src/autonomous/git-inspector.js";
import {
  createSession,
  writeSessionSync,
  prepareForCompact,
  readEvents,
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { writeResumeMarker } from "../../src/autonomous/resume-marker.js";

const mockedGitHead = vi.mocked(gitHead);
const mockedGitIsAncestor = vi.mocked(gitIsAncestor);

let root: string;
let sessionsDir: string;

function setupProject(dir: string): void {
  // Minimal .story/ with config and required dirs
  const storyDir = join(dir, ".story");
  mkdirSync(storyDir, { recursive: true });
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  mkdirSync(join(storyDir, "notes"), { recursive: true });
  mkdirSync(join(storyDir, "lessons"), { recursive: true });
  mkdirSync(join(storyDir, "handovers"), { recursive: true });
  mkdirSync(join(storyDir, "sessions"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    schemaVersion: 1,
    project: "test",
    type: "npm",
    language: "typescript",
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test",
    date: "2026-03-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  // Add a ticket for sessions to reference
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
    blockedBy: [], parentTicket: null,
  }));
  // Git init (needed for deriveWorkspaceId)
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

function createCompactSession(dir: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const session = createSession(dir, "coding", "test-workspace");
  const sessDir = join(dir, ".story", "sessions", session.sessionId);
  // Set to a working state
  const working = writeSessionSync(sessDir, {
    ...session,
    state: overrides.preCompactState ?? "PLAN",
    ticket: overrides.ticket ?? { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: overrides.reviews ?? { plan: [], code: [] },
  });
  // prepareForCompact needs (dir, state, opts?) -- sets COMPACT + compactPending
  prepareForCompact(sessDir, working, { expectedHead: "abc123" });
  // Read back the full state
  const stateRaw = readFileSync(join(sessDir, "state.json"), "utf-8");
  return JSON.parse(stateRaw) as FullSessionState;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss039-"));
  sessionsDir = join(root, ".story", "sessions");
  setupProject(root);
  mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });
  mockedGitIsAncestor.mockResolvedValue({ ok: true, data: false });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});

describe("handleResume integration (ISS-039)", () => {
  // --- Early exits ---

  it("returns error when sessionId is missing", async () => {
    const result = await handleAutonomousGuide(root, {
      action: "resume",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("sessionId is required");
  });

  it("returns error when session does not exist", async () => {
    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: "nonexistent-session",
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not found");
  });

  it("returns error when session is not in COMPACT state", async () => {
    const session = createSession(root, "coding", "test-workspace");
    // Session is in INIT state, not COMPACT
    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not in COMPACT state");
  });

  it("returns error when compactPending is false", async () => {
    const session = createCompactSession(root);
    // Clear compactPending manually
    const dir = join(sessionsDir, session.sessionId);
    writeSessionSync(dir, { ...session, compactPending: false });

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("compactPending is false");
  });

  // --- Branch A: HEAD match ---

  it("Branch A: resumes at preCompactState when HEAD matches", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    // Read the session state to verify it was restored
    const stateRaw = readFileSync(join(sessionsDir, session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("PLAN");
    expect(state.compactPending).toBe(false);
    expect(state.resumeBlocked).toBe(false);
  });

  it("Branch A: IMPLEMENT resumes at IMPLEMENT", async () => {
    const session = createCompactSession(root, { preCompactState: "IMPLEMENT" });

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    const stateRaw = readFileSync(join(sessionsDir, session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("IMPLEMENT");
  });

  // --- Branch B: HEAD mismatch ---

  it("Branch B: PLAN recovers to PLAN with resetPlan on HEAD drift", async () => {
    const session = createCompactSession(root, {
      preCompactState: "PLAN",
      reviews: { plan: [{ round: 1, reviewer: "claude", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString() }], code: [] },
    });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "different-head" } });

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    const stateRaw = readFileSync(join(sessionsDir, session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("PLAN");
    expect(state.reviews.plan).toHaveLength(0); // reset
    expect(state.compactPending).toBe(false);
  });

  it("Branch B: CODE_REVIEW recovers to PLAN with both resets", async () => {
    const session = createCompactSession(root, {
      preCompactState: "CODE_REVIEW",
      reviews: {
        plan: [{ round: 1, reviewer: "claude", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString() }],
        code: [{ round: 1, reviewer: "claude", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString() }],
      },
    });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "drifted" } });

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    const stateRaw = readFileSync(join(sessionsDir, session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("PLAN");
    expect(state.reviews.plan).toHaveLength(0);
    expect(state.reviews.code).toHaveLength(0);
  });

  it("Branch B: IMPLEMENT recovers to PLAN preserving no code reviews", async () => {
    const session = createCompactSession(root, {
      preCompactState: "IMPLEMENT",
      reviews: {
        plan: [{ round: 1, reviewer: "claude", verdict: "approve", findingCount: 0, criticalCount: 0, majorCount: 0, suggestionCount: 0, timestamp: new Date().toISOString() }],
        code: [],
      },
    });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "drifted" } });

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    const stateRaw = readFileSync(join(sessionsDir, session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("PLAN");
    expect(state.reviews.plan).toHaveLength(0); // reset (IMPLEMENT maps to PLAN with resetPlan)
    expect(state.compactPending).toBe(false);
    expect(state.ticket?.lastPlanHash).toBeUndefined(); // cleared on drift
  });

  // --- Branch C: cannot validate HEAD ---

  it("Branch C: sets resumeBlocked when git is unavailable", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: false, error: "git not available" } as any);

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBe(true);
    const stateRaw = readFileSync(join(sessionsDir, session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.resumeBlocked).toBe(true);
    expect(state.compactPending).toBe(true); // preserved
    // Lease should be refreshed even on blocked resume
    expect(state.lease?.expiresAt).toBeDefined();
    const expires = new Date(state.lease!.expiresAt!).getTime();
    expect(expires).toBeGreaterThan(Date.now() - 5000); // refreshed recently
  });
});

describe("T-187: resumed event logging", () => {
  it("Branch A: appends 'resumed' event with headMatch: true", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });

    await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    const sessDir = join(sessionsDir, session.sessionId);
    const { events } = readEvents(sessDir);
    const resumed = events.filter(e => e.type === "resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].data.headMatch).toBe(true);
    expect(resumed[0].data.preCompactState).toBe("PLAN");
    expect(resumed[0].data.ticketId).toBe("T-001");
    expect(resumed[0].data.compactionCount).toBeGreaterThanOrEqual(1);
  });

  it("Branch B: appends both 'resume_conflict' and 'resumed' events", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "drifted-head" } });

    await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    const sessDir = join(sessionsDir, session.sessionId);
    const { events } = readEvents(sessDir);
    const conflict = events.filter(e => e.type === "resume_conflict");
    const resumed = events.filter(e => e.type === "resumed");
    expect(conflict).toHaveLength(1);
    expect(resumed).toHaveLength(1);
    expect(resumed[0].data.headMatch).toBe(false);
    expect(resumed[0].data.preCompactState).toBe("PLAN");
    expect(resumed[0].data.recoveryState).toBe("PLAN");
    expect(resumed[0].data.ticketId).toBe("T-001");
  });

  it("Branch C: does NOT append 'resumed' event (failure path)", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: false, error: "git not available" } as any);

    await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    const sessDir = join(sessionsDir, session.sessionId);
    const { events } = readEvents(sessDir);
    const resumed = events.filter(e => e.type === "resumed");
    expect(resumed).toHaveLength(0);
    const blocked = events.filter(e => e.type === "resume_blocked");
    expect(blocked).toHaveLength(1);
  });
});

describe("T-183: resume marker cleanup", () => {
  const markerPath = () => join(root, ".claude", "rules", "autonomous-resume.md");

  it("Branch A: removes marker after successful resume", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });
    writeResumeMarker(root, session.sessionId, { completedTickets: [] });
    expect(existsSync(markerPath())).toBe(true);

    await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(existsSync(markerPath())).toBe(false);
  });

  it("Branch B: removes marker after drift resume", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "drifted-head" } });
    writeResumeMarker(root, session.sessionId, { completedTickets: [] });
    expect(existsSync(markerPath())).toBe(true);

    await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(existsSync(markerPath())).toBe(false);
  });

  it("Branch C: preserves marker when git fails", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: false, error: "git not available" } as any);
    writeResumeMarker(root, session.sessionId, { completedTickets: [] });
    expect(existsSync(markerPath())).toBe(true);

    await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(existsSync(markerPath())).toBe(true);
  });
});

describe("T-184: own-commit drift tolerance", () => {
  it("own-commit drift resumes at preCompactState (no recovery)", async () => {
    const session = createCompactSession(root, { preCompactState: "IMPLEMENT" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "own-commit-head" } });
    mockedGitIsAncestor.mockResolvedValue({ ok: true, data: true }); // expectedHead is ancestor of actual

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    const stateRaw = readFileSync(join(root, ".story", "sessions", session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("IMPLEMENT"); // resumed at preCompactState, not recovered to PLAN
    expect(state.git.expectedHead).toBe("own-commit-head"); // updated
    expect(state.git.mergeBase).toBe("abc123"); // NOT changed (branch-off point preserved)
  });

  it("own-commit drift logs resumed event with ownCommit: true", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "own-commit-head" } });
    mockedGitIsAncestor.mockResolvedValue({ ok: true, data: true });

    await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    const sessDir = join(root, ".story", "sessions", session.sessionId);
    const { events } = readEvents(sessDir);
    const resumed = events.filter(e => e.type === "resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].data.ownCommit).toBe(true);
    expect(resumed[0].data.headMatch).toBe(false);
  });

  it("non-ancestor drift triggers normal Branch B recovery", async () => {
    const session = createCompactSession(root, { preCompactState: "IMPLEMENT" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "external-drift" } });
    mockedGitIsAncestor.mockResolvedValue({ ok: true, data: false }); // not ancestor

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    const stateRaw = readFileSync(join(root, ".story", "sessions", session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("PLAN"); // IMPLEMENT maps to PLAN in RECOVERY_MAPPING
  });

  it("gitIsAncestor failure falls through to Branch B recovery (safe fallback)", async () => {
    const session = createCompactSession(root, { preCompactState: "IMPLEMENT" });
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "drift-head" } });
    mockedGitIsAncestor.mockResolvedValue({ ok: false, reason: "git_error", message: "git failed" });

    const result = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });

    expect(result.isError).toBeFalsy();
    const stateRaw = readFileSync(join(root, ".story", "sessions", session.sessionId, "state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as FullSessionState;
    expect(state.state).toBe("PLAN"); // fell through to Branch B recovery
  });
});
