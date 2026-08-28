/**
 * ISS-778: session cancel must release a ticket claim under STRICT ownership.
 *
 * The legacy guard released a ticket iff `!claimedBySession || claimedBySession
 * === sessionId`. The `!claimedBySession` escape hatch destroys a FOREIGN CLI
 * claim: `storybloq ticket start` writes claim{user,branch,since} but never
 * claimedBySession, so a teammate's in-flight ticket gets unclaimed and reopened
 * by someone else's cancel. This drives handleAutonomousGuide's cancel path end
 * to end (real session files, temp project, mocked git-inspector) the same way
 * plan-claim-lost-transition.test.ts drives the report path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock git-inspector before importing guide (matches handle-report-compact.test.ts).
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
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = new Date().toISOString();
const ARRANGEMENT_ID = "a-0123456789abcdef";
const RESERVED_BY = { client: "claude" as const, id: "pen-task-1" };

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1,
    schemaVersion: 1,
    project: "test",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test",
    date: "2026-07-02",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

/** Write a T-001 ticket file with the given extra fields (claim material). */
function writeTicket(root: string, extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-07-02",
    completedDate: null, blockedBy: [],
    ...extra,
  }));
}

/**
 * Plant a session that references T-001 and is cancellable. mode "guided"
 * bypasses the auto-mode soft cancel gate so the release path runs.
 */
function plantSession(root: string): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function readTicket(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
}

/** Parse events.log JSON lines and return the "cancelled" event data (or null). */
function cancelledEventData(sessDir: string): Record<string, unknown> | null {
  let raw = "";
  try { raw = readFileSync(join(sessDir, "events.log"), "utf-8"); } catch { return null; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt.type === "cancelled") return (evt.data as Record<string, unknown>) ?? null;
    } catch { /* skip garbage */ }
  }
  return null;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss778-guide-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("session cancel claim-release ownership (ISS-778, guide site)", () => {
  it("rejects cancellation from a known foreign live task", async () => {
    process.env.STORYBLOQ_CLIENT = "codex";
    writeTicket(root, {});
    const { sessionId, sessDir } = plantSession(root);
    const state = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    writeSessionSync(sessDir, {
      ...state,
      ownerTask: { client: "codex", id: "owner-task", boundAt: "2026-07-09T00:00:00Z" },
    });

    const result = await handleAutonomousGuide(root, {
      action: "cancel",
      sessionId,
      clientTaskId: "foreign-task",
    });

    expect(result.isError).toBe(true);
    const after = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(after.state).toBe("IMPLEMENT");
    expect(readTicket(root).status).toBe("inprogress");
  });

  it("(a) preserves a FOREIGN CLI claim (claimedBySession absent): no release", async () => {
    const foreignClaim = { user: "teammate@example.com", branch: "main", since: NOW };
    writeTicket(root, { claim: foreignClaim });
    const { sessionId } = plantSession(root);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    // The teammate's in-flight ticket must survive our cancel untouched.
    expect(after.status).toBe("inprogress");
    expect(after.claim).toEqual(foreignClaim);
  });

  it("(b) releases when THIS session owns the claim (claimedBySession === sessionId)", async () => {
    const { sessionId } = plantSession(root);
    writeTicket(root, {
      claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
    });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    expect(after.status).toBe("open");
    expect(after.claimedBySession).toBeUndefined();
    expect(after.claim).toBeUndefined();
  });

  it("(c) releases a bare inprogress ticket (no claim, no claimedBySession)", async () => {
    writeTicket(root, {});
    const { sessionId } = plantSession(root);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    expect(after.status).toBe("open");
    expect(after.claim).toBeUndefined();
    expect(after.claimedBySession).toBeUndefined();
  });

  it("(d) does not release a FOREIGN SESSION claim and reports the conflict signal", async () => {
    const otherSession = "ffffffff-0000-0000-0000-000000000009";
    const foreignClaim = { user: "other@example.com", branch: "main", since: NOW };
    writeTicket(root, { claimedBySession: otherSession, claim: foreignClaim });
    const { sessionId, sessDir } = plantSession(root);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    expect(after.status).toBe("inprogress");
    expect(after.claimedBySession).toBe(otherSession);
    expect(after.claim).toEqual(foreignClaim);

    // The guide's existing conflict signal fires (ticketReleased false, conflict true).
    const data = cancelledEventData(sessDir);
    expect(data?.ticketConflict).toBe(true);
    expect(data?.ticketReleased).toBe(false);
  });
});

describe("T-475 section 5: cancel clears a same-session earmark in the same locked write", () => {
  it("clears this session's assigned earmark alongside the claim it releases (epochless path)", async () => {
    const { sessionId } = plantSession(root);
    writeTicket(root, {
      claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
      earmark: {
        stage: "assigned",
        reservedBy: RESERVED_BY,
        arrangementId: ARRANGEMENT_ID,
        since: NOW,
        holderRole: "worker",
        holderSession: sessionId,
      },
    });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    expect(after.status).toBe("open");
    expect(after.earmark).toBeNull();
  });

  it("does not clear a DIFFERENT session's earmark on a conflict (foreign claim survives untouched)", async () => {
    const otherSession = "ffffffff-0000-0000-0000-000000000009";
    const foreignEarmark = {
      stage: "assigned",
      reservedBy: RESERVED_BY,
      arrangementId: ARRANGEMENT_ID,
      since: NOW,
      holderRole: "worker",
      holderSession: otherSession,
    };
    writeTicket(root, {
      claimedBySession: otherSession,
      claim: { user: "other@example.com", branch: "main", since: NOW },
      earmark: foreignEarmark,
    });
    const { sessionId } = plantSession(root);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    expect(after.status).toBe("inprogress");
    expect(after.earmark).toEqual(foreignEarmark);
  });

  it("leaves a reserved (not-yet-picked-up) earmark alone -- it names no session to match", async () => {
    const { sessionId } = plantSession(root);
    const reservedEarmark = {
      stage: "reserved",
      reservedBy: RESERVED_BY,
      arrangementId: ARRANGEMENT_ID,
      since: NOW,
      holderRole: "worker",
      holderSession: null,
    };
    writeTicket(root, {
      claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
      earmark: reservedEarmark,
    });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    expect(after.status).toBe("open");
    expect(after.earmark).toEqual(reservedEarmark);
  });
});
