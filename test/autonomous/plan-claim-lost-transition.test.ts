/**
 * ISS-767: PLAN claim-lost recovery must reach PICK_TICKET through the REAL
 * walker, not just the stage.
 *
 * The ISS-759 fix returns `goto PICK_TICKET` from PlanStage.report() when the
 * ticket claim is lost to another user. But PLAN's row in the state-machine
 * transition table listed only [PLAN_REVIEW, HANDOVER], so processAdvance's
 * assertTransition(PLAN, PICK_TICKET) threw BEFORE any state was persisted --
 * the session stuck in PLAN forever and the draft lock never cleared.
 *
 * The existing stage-level test (plan-claim-gate.test.ts test 3) asserts only
 * the advance object PlanStage.report() returns; it never runs the walker, so
 * it missed this gap. This test drives handleAutonomousGuide end to end so the
 * transition-table entry is actually exercised.
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
import { todayISO } from "../../src/cli/helpers.js";

const NOW = new Date().toISOString();

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
  // Ticket is open on disk but claimed by a DIFFERENT user (foreign claim),
  // so the PLAN claim recheck fails and the stage returns goto PICK_TICKET.
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "open", phase: "p1", order: 10, createdDate: "2026-07-02",
    completedDate: null, blockedBy: [],
    claim: { user: "rival@example.com", branch: "main", since: NOW },
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss767-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("PLAN claim-lost transition to PICK_TICKET (ISS-767)", () => {
  it("plan_written on a lost claim reaches PICK_TICKET through the walker and clears the draft lock", async () => {
    const session = createSession(root, "coding", "test-workspace");
    const sessDir = join(root, ".story", "sessions", session.sessionId);
    writeSessionSync(sessDir, {
      ...session,
      state: "PLAN",
      previousState: "PICK_TICKET",
      ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
      // draft lock held by THIS user; the on-disk foreign claim beats it.
      pendingTicketClaim: { user: "me@example.com", branch: "main", since: NOW },
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);
    writeFileSync(join(sessDir, "plan.md"), "# Plan\n\nEXISTING: none found within src/; closest candidate lacks the behaviour; new implementation limited to this fixture\n1. Do the thing.\n", "utf-8");

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "plan_written" },
    });

    const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
    // Load-bearing RED assertion: pre-fix, assertTransition throws this exact
    // message before any state write. The arrow is the one the error string uses.
    expect(text).not.toContain("Invalid state transition: PLAN → PICK_TICKET");
    expect(result.isError).toBeFalsy();

    // Session advanced to PICK_TICKET and the draft lock was cleared on disk.
    const after = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(after.state).toBe("PICK_TICKET");
    expect(after.ticket).toBeUndefined();
    expect((after as Record<string, unknown>).pendingTicketClaim).toBeUndefined();

    // The foreign claim on disk is untouched by the recovery.
    const written = JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(written.status).toBe("open");
    expect(written.claim.user).toBe("rival@example.com");
  });
});

// T-481 T12 / T12r: the PLAN claim stamps updatedDate; a skip release stamps
// only when a claim is released, never for an earmark-only clear.
const T481_ARRANGEMENT = "a-0123456789abcdef";
const T481_RESERVED_BY = { client: "claude" as const, id: "pen-task-1" };

function t481Ticket(extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "open", phase: "p1", order: 10, createdDate: "2020-01-01",
    updatedDate: "2020-01-01", completedDate: null, blockedBy: [],
    ...extra,
  }));
}

function t481Read(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8")) as Record<string, unknown>;
}

function t481Earmark(sessionId: string): Record<string, unknown> {
  return {
    stage: "assigned", reservedBy: T481_RESERVED_BY, arrangementId: T481_ARRANGEMENT,
    since: NOW, holderRole: "worker", holderSession: sessionId,
  };
}

function t481Session(state: string): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state,
    previousState: "PICK_TICKET",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

describe("T-481 T12: the PLAN claim stamps updatedDate", () => {
  it("claiming a ticket last updated 2020-01-01 stamps today", async () => {
    t481Ticket({});
    const { sessionId, sessDir } = t481Session("PLAN");
    writeFileSync(join(sessDir, "plan.md"), "# Plan\n\nEXISTING: none found within src/; closest candidate lacks the behaviour; new implementation limited to this fixture\n1. Do the thing.\n", "utf-8");

    const result = await handleAutonomousGuide(root, {
      action: "report", sessionId, report: { completedAction: "plan_written" },
    });
    expect(result.isError).toBeFalsy();

    const written = t481Read();
    expect(written.status).toBe("inprogress");
    expect(written.claimedBySession).toBe(sessionId);
    expect(written.updatedDate).toBe(todayISO());
  });
});

for (const state of ["PLAN", "PLAN_REVIEW", "CODE_REVIEW"] as const) {
  describe(`T-481 T12r: skip_ticket release in ${state}`, () => {
    it("an earmark-only clear removes the earmark and keeps updatedDate", async () => {
      const { sessionId } = t481Session(state);
      t481Ticket({ earmark: t481Earmark(sessionId) });

      const result = await handleAutonomousGuide(root, {
        action: "report", sessionId, report: { completedAction: "skip_ticket", notes: "not workable" },
      });
      expect(result.isError).toBeFalsy();

      const written = t481Read();
      expect(written.earmark).toBeNull();
      expect(written.status).toBe("open");
      expect(written.updatedDate).toBe("2020-01-01");
    });

    it("a claim release together with the earmark clear stamps today", async () => {
      const { sessionId } = t481Session(state);
      t481Ticket({
        status: "inprogress", claimedBySession: sessionId,
        claim: { user: "me@example.com", branch: "main", since: NOW },
        earmark: t481Earmark(sessionId),
      });

      const result = await handleAutonomousGuide(root, {
        action: "report", sessionId, report: { completedAction: "skip_ticket", notes: "not workable" },
      });
      expect(result.isError).toBeFalsy();

      const written = t481Read();
      expect(written.earmark).toBeNull();
      expect(written.status).toBe("open");
      expect(written.claimedBySession).toBeUndefined();
      expect(written.updatedDate).toBe(todayISO());
    });
  });
}
