/**
 * ISS-965 T7 (pending-mutation discard + start-path no-replay), T12
 * (crash-point idempotent re-entry), T13 (start-in-crash-window boundedness).
 *
 * All three share one fixture shape: a session sitting in a pre-terminal
 * working stage (WRITE_TESTS) whose ticket has ALREADY reached the
 * completed-consistent shape on disk (status "complete", both claim keys
 * gone), the exact disk state a crash between terminalizeCompletedSession's
 * event-append and its state-rename would leave (guide.ts:513-523's own
 * docstring names this window).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let CHECK_ON = true;

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  // ISS-965 T13's fixtures drive handleStart, which reads gitStatus's `data`
  // as raw porcelain lines (string[]) -- unlike report/resume/cancel, which
  // never read it, so the {clean,trackedDirty,untrackedPaths} shape other
  // suites use never surfaces there. An empty array is a clean tree.
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
  gitUserEmail: vi.fn().mockResolvedValue("me@example.com"),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = new Date().toISOString();

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    gitState: { requireCommitOnComplete: CHECK_ON },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-07-02",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  // A real repository with no commit naming T-001: gitState none.
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "x\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "init");
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
}

function writeTicket(root: string, id: string, extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: `Ticket ${id}`, description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-07-02",
    completedDate: null, blockedBy: [],
    ...extra,
  }));
}

function readTicketRaw(root: string, id: string): string {
  return readFileSync(join(root, ".story", "tickets", `${id}.json`), "utf-8");
}

function readTicket(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readTicketRaw(root, id));
}

/** The pre-terminal crash-window fixture: WRITE_TESTS + a pendingProjectMutation. */
function plantPreTerminalSession(
  root: string,
  mutation: Record<string, unknown> | null,
  withEpoch = true,
): { sessionId: string; sessDir: string } {
  // T13's handleStart tests match sessions by workspace, unlike report/resume/
  // cancel which look up by sessionId directly -- a literal placeholder never
  // matches deriveWorkspaceId(root), so findActiveSessionFull would silently
  // filter this session out as "wrong workspace" and mask the very refusal
  // path being tested.
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const epoch = {
    ticketId: "T-001", sessionId: session.sessionId, user: "me@example.com",
    branch: "main", since: NOW, establishedAt: NOW,
  };
  writeSessionSync(sessDir, {
    ...session,
    state: "WRITE_TESTS",
    previousState: "PLAN_REVIEW",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    ...(withEpoch ? { claimEpoch: epoch } : {}),
    pendingProjectMutation: mutation,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

function eventsOfType(sessDir: string, type: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(sessDir, "events.log"), "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "c6-guide-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});


describe("C-v4.1 commit 6: the guide's completion asks the completion check", () => {
  const marker = { type: "ticket_update", target: "T-001", value: "complete", expectedCurrent: "inprogress", transitionId: "txn-c6" };

  it("refuses with the policy on and no commit naming the ticket: names the gitState, the key and the manual escape; nothing written, marker kept", async () => {
    writeTicket(root, "T-001", {});
    const { sessionId, sessDir } = plantPreTerminalSession(root, marker, false);
    const before = readTicketRaw(root, "T-001");
    const result = await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("gitState none");
    expect(text).toContain("gitState.requireCommitOnComplete");
    expect(text).toContain("storybloq ticket update T-001 --status complete --no-git-check");
    expect(readTicketRaw(root, "T-001")).toBe(before);
    expect(readState(sessDir).pendingProjectMutation).not.toBeNull();
    expect(eventsOfType(sessDir, "completion_git_refused")).toHaveLength(1);
  });

  it("completes as before with the policy off", async () => {
    CHECK_ON = false;
    try {
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "c6-guide-"));
      setupProject(root);
      writeTicket(root, "T-001", {});
      const { sessionId } = plantPreTerminalSession(root, marker, false);
      await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } });
      expect(readTicket(root, "T-001").status).toBe("complete");
    } finally { CHECK_ON = true; }
  });
});

describe("C-v4.1 commit 6: cancel after a git refusal", () => {
  const marker = { type: "ticket_update", target: "T-001", value: "complete", expectedCurrent: "inprogress", transitionId: "txn-c6-cancel" };
  const held = (sessionId: string) => ({ claimedBySession: sessionId, claim: { user: "me@example.com", branch: "main", since: NOW } });

  it("an auto session with work remaining and a held claim: after the refusal, cancel clears the marker and ends; the ticket is not complete", async () => {
    const { sessionId, sessDir } = plantPreTerminalSession(root, marker);
    writeTicket(root, "T-001", held(sessionId));
    const refused = await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } });
    expect(refused.isError).toBe(true);
    expect(eventsOfType(sessDir, "completion_git_refused")[0]!.data).toMatchObject({ ticketId: "T-001", transitionId: "txn-c6-cancel" });
    const cancelled = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(cancelled.isError).toBeFalsy();
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.state).toBe("SESSION_END");
    expect(readTicket(root, "T-001").status).not.toBe("complete");
    expect(eventsOfType(sessDir, "checkpoint_blocked_abandoned")).toHaveLength(1);
  });

  it("no widening: the same session without a git refusal still meets the soft gate", async () => {
    const { sessionId, sessDir } = plantPreTerminalSession(root, marker);
    writeTicket(root, "T-001", held(sessionId));
    const before = readState(sessDir);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    const text = (result.content[0] as { text: string }).text;
    expect(result.isError).toBeFalsy();
    const after = readState(sessDir);
    expect(after.state).toBe(before.state);
    expect(after.pendingProjectMutation).toEqual(before.pendingProjectMutation);
    expect(text).toMatch(/item\(s\) finished/);
  });

  it("a refusal of an earlier completion does not excuse a later one (matched by transitionId)", async () => {
    const { sessionId, sessDir } = plantPreTerminalSession(root, { ...marker, transitionId: "txn-later" });
    writeTicket(root, "T-001", held(sessionId));
    writeFileSync(join(sessDir, "events.log"), JSON.stringify({ rev: 1, type: "completion_git_refused", timestamp: NOW, data: { ticketId: "T-001", reason: "x", transitionId: "txn-earlier" } }) + "\n", { flag: "a" });
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect((result.content[0] as { text: string }).text).toMatch(/item\(s\) finished/);
    expect(readState(sessDir).state).toBe("WRITE_TESTS");
    expect(readState(sessDir).pendingProjectMutation).not.toBeNull();
  });
});
