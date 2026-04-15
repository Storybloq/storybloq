/**
 * ISS-377: Integration tests for handleReport's COMPACT-state guard.
 *
 * Before the fix, calling action: "report" on a COMPACT session crashed with
 * "Stage COMPACT is not registered" because COMPACT has no pipeline stage.
 * The guard splits stale-compact (pointing to clear-compact) from normal
 * compact (pointing to resume), matching handleResume's own recovery paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const mockedGitHead = vi.mocked(gitHead);
const mockedGitIsAncestor = vi.mocked(gitIsAncestor);

let root: string;
let sessionsDir: string;

function setupProject(dir: string): void {
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
    date: "2026-04-10",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-04-10",
    blockedBy: [], parentTicket: null,
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

function createCompactSession(dir: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const session = createSession(dir, "coding", "test-workspace");
  const sessDir = join(dir, ".story", "sessions", session.sessionId);
  const working = writeSessionSync(sessDir, {
    ...session,
    state: overrides.preCompactState ?? "PLAN",
    ticket: overrides.ticket ?? { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: overrides.reviews ?? { plan: [], code: [] },
  });
  prepareForCompact(sessDir, working, { expectedHead: "abc123" });
  const stateRaw = readFileSync(join(sessDir, "state.json"), "utf-8");
  return JSON.parse(stateRaw) as FullSessionState;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss377-"));
  sessionsDir = join(root, ".story", "sessions");
  setupProject(root);
  mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });
  mockedGitIsAncestor.mockResolvedValue({ ok: true, data: false });
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("handleReport COMPACT guard (ISS-377)", () => {
  it("rejects report on COMPACT session with compactPending=true and points to resume", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    // Sanity check: prepareForCompact should have left compactPending=true.
    expect(session.state).toBe("COMPACT");
    expect(session.compactPending).toBe(true);

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "plan_written" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("COMPACT state");
    expect(text).toContain('action: "resume"');
    // Critically: the pre-fix error must not leak through.
    expect(text).not.toContain("is not registered");
  });

  it("rejects report on stale COMPACT (compactPending=false) and points to clear-compact", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    // Mimic the stale-compact state that handleResume itself rejects:
    // state still COMPACT but compactPending flag cleared.
    const sessDir = join(sessionsDir, session.sessionId);
    writeSessionSync(sessDir, { ...session, compactPending: false });

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "plan_written" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("stale compact");
    expect(text).toContain("clear-compact");
    // Stale path must not point to resume (resume would itself reject it).
    expect(text).not.toContain('action: "resume"');
    expect(text).not.toContain("is not registered");
  });

  it("allows report after resume transitions session out of COMPACT", async () => {
    const session = createCompactSession(root, { preCompactState: "PLAN" });
    // Branch A: HEAD matches expectedHead, so resume restores preCompactState cleanly.
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });

    const resumeResult = await handleAutonomousGuide(root, {
      action: "resume",
      sessionId: session.sessionId,
    });
    expect(resumeResult.isError).toBeFalsy();

    // Verify the resume actually moved the session out of COMPACT.
    const sessDir = join(sessionsDir, session.sessionId);
    const afterResume = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(afterResume.state).toBe("PLAN");
    expect(afterResume.compactPending).toBe(false);

    // Now call report. The COMPACT guard must not fire. The report may or may
    // not fully succeed depending on PLAN-stage expectations in the harness,
    // but if it errors, the error must be PLAN-stage specific, NOT the COMPACT
    // guard or the "is not registered" crash the guard is meant to prevent.
    const reportResult = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "plan_written" },
    });

    if (reportResult.isError) {
      const text = (reportResult.content[0] as { text: string }).text;
      expect(text).not.toContain("COMPACT");
      expect(text).not.toContain("is not registered");
    }
  });
});
