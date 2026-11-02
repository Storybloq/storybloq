/**
 * ISS-792: HANDOVER claim release must flip a mid-work handoff back to open.
 *
 * The release block in HandoverStage.report() deleted the claim keys
 * (claimedBySession, claim) but wrote the ticket back with status untouched,
 * leaving a handed-off ticket "inprogress" with no claim. pick-ticket.ts only
 * accepts status "open" or ("inprogress" AND claimedBySession === this
 * session), so the ticket became unpickable by every future session: orphaned.
 * The five sibling release sites (plan, plan-review, code-review, cancel,
 * session-compact) all write { ...rest, status: "open" as const }.
 *
 * The fix also carries the same status fence the two stale-state-exposed
 * siblings use (guide.ts cancel, session-compact): a ticket that is not
 * "inprogress" on disk is never rewritten here, so a stale HANDOVER session
 * whose ticket went complete out-of-band can never reopen it. Stale claims on
 * complete tickets belong to the ISS-652 repair.
 *
 * Ownership carries the ISS-778 disjunction the cancel and session-compact
 * siblings use (ISS-816): release when this session owns the
 * claimedBySession stamp, or when the ticket carries no claim material at
 * all (a bare inprogress ticket); a foreign claim is never released.
 *
 * This drives handleAutonomousGuide's HANDOVER report path end to end (real
 * session files, temp project, mocked git-inspector), the same way
 * cancel-claim-ownership.test.ts drives the cancel path.
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

/** Write a T-001 ticket file; `extra` can override any base field (e.g. status). */
function writeTicket(root: string, extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-07-02",
    completedDate: null, blockedBy: [],
    ...extra,
  }));
}

/** Plant a session sitting in HANDOVER with the given ticket/previousState shape. */
function plantHandoverSession(
  root: string,
  opts: { previousState: string; ticket: Record<string, unknown> | undefined },
): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "HANDOVER",
    previousState: opts.previousState,
    ticket: opts.ticket,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function readTicket(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
}

function rawTicketBytes(root: string): string {
  return readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8");
}

async function reportHandoverWritten(root: string, sessionId: string) {
  return handleAutonomousGuide(root, {
    action: "report",
    sessionId,
    report: {
      completedAction: "handover_written",
      handoverContent: "# Handover\n\nMid-work handoff.",
    },
  });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss792-handover-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  // clearAllMocks resets call history only; the git-inspector mock
  // implementations from the vi.mock factory (which runs once at module load)
  // are preserved. restoreAllMocks would strip those implementations, leaving
  // later tests running against gutted mocks.
  vi.clearAllMocks();
});

describe("HANDOVER claim release flips a mid-work handoff back to open (ISS-792)", () => {
  it("(1) releases an inprogress ticket owned by this session: claim keys gone AND status open", async () => {
    // Pipeline-exhaustion route (guide.ts) stamps previousState with the
    // mid-work stage id; CODE_REVIEW -> HANDOVER is a valid live-ticket origin.
    const { sessionId } = plantHandoverSession(root, {
      previousState: "CODE_REVIEW",
      ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    });
    writeTicket(root, {
      claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
    });

    const result = await reportHandoverWritten(root, sessionId);
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    // Load-bearing assertion: a handed-off ticket must be re-pickable.
    expect(after.status).toBe("open");
    expect(after.claimedBySession).toBeUndefined();
    expect(after.claim).toBeUndefined();
  });

  it("(2) completed path (post-FINALIZE shape, no session ticket): ticket file untouched", async () => {
    writeTicket(root, {
      status: "complete",
      completedDate: "2026-07-03",
    });
    // FINALIZE clears ctx.state.ticket before COMPLETE -> HANDOVER, and
    // clearClaimOnComplete already released the claim on this path.
    const { sessionId } = plantHandoverSession(root, {
      previousState: "COMPLETE",
      ticket: undefined,
    });

    const before = rawTicketBytes(root);
    const result = await reportHandoverWritten(root, sessionId);
    expect(result.isError).toBeFalsy();

    // No ticket write occurred at all.
    expect(rawTicketBytes(root)).toBe(before);
    const after = readTicket(root);
    expect(after.status).toBe("complete");
    expect(after.claimedBySession).toBeUndefined();
    expect(after.claim).toBeUndefined();
  });

  it("(3) stale session on a COMPLETE ticket with residual claim stamp: never reopened, never rewritten", async () => {
    const { sessionId } = plantHandoverSession(root, {
      previousState: "CODE_REVIEW",
      ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    });
    // Ticket went complete out-of-band while the claim stamp survived.
    // The status fence must short-circuit before the ownership check, matching
    // cancel/session-compact semantics; the stale stamp is ISS-652's to repair.
    writeTicket(root, {
      status: "complete",
      completedDate: "2026-07-03",
      claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
    });

    const before = rawTicketBytes(root);
    const result = await reportHandoverWritten(root, sessionId);
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    // The completed ticket is NOT flipped back to open.
    expect(after.status).toBe("complete");
    // No write at all: the file is byte-identical, stale stamp included.
    expect(rawTicketBytes(root)).toBe(before);
    expect(after.claimedBySession).toBe(sessionId);
  });

  it("(4) bare inprogress ticket with no claim material: released to open on handover (ISS-816)", async () => {
    const { sessionId } = plantHandoverSession(root, {
      previousState: "CODE_REVIEW",
      ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    });
    // No claimedBySession and no claim block: the session flipped the ticket
    // inprogress before any claim material was written (ISS-778 shape).
    writeTicket(root, {});

    const result = await reportHandoverWritten(root, sessionId);
    expect(result.isError).toBeFalsy();

    const after = readTicket(root);
    // Load-bearing assertion: the bare handed-off ticket must be re-pickable.
    expect(after.status).toBe("open");
    expect("claimedBySession" in after).toBe(false);
    expect("claim" in after).toBe(false);
  });

  it("(5) foreign CLI claim block with no claimedBySession: never released, file untouched (ISS-816)", async () => {
    const { sessionId } = plantHandoverSession(root, {
      previousState: "CODE_REVIEW",
      ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    });
    // A CLI claim (storybloq ticket claim) writes a claim block but never
    // claimedBySession. The ticketClaimBlock == null guard must keep the
    // bare-ticket disjunct from swallowing this foreign claim.
    writeTicket(root, {
      claim: { user: "other@example.com", branch: "main", since: NOW },
    });

    const before = rawTicketBytes(root);
    const result = await reportHandoverWritten(root, sessionId);
    expect(result.isError).toBeFalsy();

    // No write at all: byte-identical, still inprogress, claim block intact.
    expect(rawTicketBytes(root)).toBe(before);
    const after = readTicket(root);
    expect(after.status).toBe("inprogress");
    expect(after.claim).toEqual({ user: "other@example.com", branch: "main", since: NOW });
  });

  it("ISS-1405: session end releases past a ticket file that does not parse and names it", async () => {
    const { sessionId } = plantHandoverSession(root, { previousState: "IMPLEMENT", ticket: { id: "T-001", title: "Test ticket", claimed: true } });
    writeTicket(root, { claimedBySession: sessionId });
    writeFileSync(join(root, ".story", "tickets", "T-009.json"), "{not json");
    const reply = await reportHandoverWritten(root, sessionId);
    expect(readTicket(root).claimedBySession).toBeUndefined();
    expect(reply.content.map((c) => ("text" in c ? c.text : "")).join("")).toContain(".story/tickets/T-009.json");
  });

  it("ISS-1405: session end says the claim was not released, and names the file, when the release fails", async () => {
    const { sessionId } = plantHandoverSession(root, { previousState: "IMPLEMENT", ticket: { id: "T-001", title: "Test ticket", claimed: true } });
    writeTicket(root, { claimedBySession: sessionId });
    writeFileSync(join(root, ".story", "tickets", "T-050.json"), rawTicketBytes(root));
    writeFileSync(join(root, ".story", "tickets", "T-009.json"), "{not json");
    const reply = await reportHandoverWritten(root, sessionId);
    expect(readTicket(root).claimedBySession).toBe(sessionId);
    const text = reply.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(text).toContain("NOT released");
    expect(text).toContain("T-050.json");
  });
});
