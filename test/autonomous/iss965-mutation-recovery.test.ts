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
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-07-02",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
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
    claimEpoch: epoch,
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
  root = mkdtempSync(join(tmpdir(), "iss965-mut-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

describe("ISS-965 T7: pending mutation discard at terminalization", () => {
  it("a pendingProjectMutation targeting a DIFFERENT ticket is discarded, never replayed", async () => {
    writeTicket(root, "T-001", { status: "complete", completedDate: "2026-08-05" });
    writeTicket(root, "T-002", {}); // inprogress, untouched by our session's claim
    const { sessionId, sessDir } = plantPreTerminalSession(root, {
      type: "ticket_update", target: "T-002", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-1",
    });

    const before = readTicketRaw(root, "T-002");
    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId,
      report: { completedAction: "tests_written" },
    });
    expect(result.isError).toBeFalsy();

    // Discarded, not replayed: T-002 must be byte-identical.
    expect(readTicketRaw(root, "T-002")).toBe(before);
    expect(readTicket(root, "T-002").status).toBe("inprogress");

    const after = readState(sessDir);
    expect(after.state).toBe("HANDOVER");
    expect(after.pendingProjectMutation).toBeNull();

    const events = eventsOfType(sessDir, "claim_terminalized");
    expect(events.length).toBe(1);
    expect(events[0]?.data).toMatchObject({ discardedPendingMutation: true });
  });

  it("start-path: starting over an existing terminalized session refuses (no resurrection), no ticket write", async () => {
    writeTicket(root, "T-001", { status: "complete", completedDate: "2026-08-05" });
    const { sessionId, sessDir } = plantPreTerminalSession(root, null);

    // Terminalize it first via report.
    const reportResult = await handleAutonomousGuide(root, {
      action: "report", sessionId, report: { completedAction: "tests_written" },
    });
    expect(reportResult.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("HANDOVER");

    const before = readTicketRaw(root, "T-001");
    const startResult = await handleAutonomousGuide(root, { action: "start" });

    // Refused, not silently superseded -- HANDOVER is not compactPending, so
    // handleStart's "already exists" branch fires rather than starting fresh.
    expect(startResult.isError).toBe(true);
    const text = (startResult.content[0] as { text: string }).text;
    expect(text).toContain("already exists");

    expect(readTicketRaw(root, "T-001")).toBe(before);
    // No new session was created alongside the terminalized one.
    const sessionsDir = join(root, ".story", "sessions");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(sessionsDir).length).toBe(1);
  });
});

describe("ISS-965 T12: crash-point idempotent re-entry", () => {
  it("the pre-rename crash shape (old working state + pending mutation) terminalizes cleanly in one composite event", async () => {
    writeTicket(root, "T-001", { status: "complete", completedDate: "2026-08-05" });
    const { sessionId, sessDir } = plantPreTerminalSession(root, {
      type: "ticket_update", target: "T-001", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-crash-1",
    });

    const result = await handleAutonomousGuide(root, {
      action: "report", sessionId, report: { completedAction: "tests_written" },
    });
    expect(result.isError).toBeFalsy();

    const after = readState(sessDir);
    expect(after.state).toBe("HANDOVER");
    expect(after.pendingProjectMutation).toBeNull();
    expect(eventsOfType(sessDir, "claim_terminalized").length).toBe(1);
  });

  it("re-entering the SAME pre-terminal disk shape a second time (simulated crash before rename) terminalizes again, safely", async () => {
    writeTicket(root, "T-001", { status: "complete", completedDate: "2026-08-05" });
    const { sessionId, sessDir } = plantPreTerminalSession(root, {
      type: "ticket_update", target: "T-001", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-crash-2",
    });
    const preTerminalRaw = readFileSync(join(sessDir, "state.json"), "utf-8");

    const first = await handleAutonomousGuide(root, {
      action: "report", sessionId, report: { completedAction: "tests_written" },
    });
    expect(first.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("HANDOVER");
    expect(eventsOfType(sessDir, "claim_terminalized").length).toBe(1);

    // Simulate "the rename did not survive the crash": revert state.json to the
    // pre-terminal shape, leaving events.log (with its one claim_terminalized
    // entry already appended) untouched -- the exact asymmetry the docstring
    // describes. The next report call reconciles the SAME ledger shape (the
    // ticket never changed) and must re-enter terminalization safely.
    writeFileSync(join(sessDir, "state.json"), preTerminalRaw, "utf-8");
    expect(readState(sessDir).state).toBe("WRITE_TESTS");

    const ticketBefore = readTicketRaw(root, "T-001");
    const second = await handleAutonomousGuide(root, {
      action: "report", sessionId, report: { completedAction: "tests_written" },
    });
    expect(second.isError).toBeFalsy();

    const after = readState(sessDir);
    expect(after.state).toBe("HANDOVER");
    expect(after.pendingProjectMutation).toBeNull();
    // Ticket is not re-mutated by the repeated terminalization.
    expect(readTicketRaw(root, "T-001")).toBe(ticketBefore);
    // Both calls appended their own composite event; re-entry does not dedupe
    // OR duplicate beyond one event per call.
    expect(eventsOfType(sessDir, "claim_terminalized").length).toBe(2);
  });
});

describe("ISS-965 T13: start-in-crash-window boundedness (recoverPendingMutation's existing safe branches)", () => {
  it("set-complete on an already-complete ticket is already-applied: marker cleared, no write", async () => {
    writeTicket(root, "T-001", { status: "complete", completedDate: "2026-08-05" });
    const { sessionId, sessDir } = plantPreTerminalSession(root, {
      type: "ticket_update", target: "T-001", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-start-1",
    });

    const before = readTicketRaw(root, "T-001");
    // handleStart runs recoverPendingMutation on an existing, unexpired-lease
    // session before deciding whether to refuse or proceed.
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true); // still refuses: an active session exists

    expect(readTicketRaw(root, "T-001")).toBe(before);
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);
  });

  it("an expectedCurrent mismatch against a ticket that is neither the target nor the expected value is a conflict: marker cleared, no write", async () => {
    // Ticket is "open" -- neither "complete" (the mutation's target value)
    // nor "inprogress" (its expectedCurrent precondition; TICKET_STATUSES is
    // exactly open/inprogress/complete). Recovery must not guess; it logs a
    // conflict and clears the marker without writing.
    writeTicket(root, "T-001", { status: "open" });
    const { sessionId, sessDir } = plantPreTerminalSession(root, {
      type: "ticket_update", target: "T-001", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-start-2",
    });

    const before = readTicketRaw(root, "T-001");
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true);

    expect(readTicketRaw(root, "T-001")).toBe(before);
    expect(readTicket(root, "T-001").status).toBe("open");
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);

    const conflictEvents = eventsOfType(sessDir, "mutation_conflict");
    expect(conflictEvents.length).toBe(1);
    expect(conflictEvents[0]?.data).toMatchObject({ targetId: "T-001", expected: "inprogress", actual: "open" });
  });
});
