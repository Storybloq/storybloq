/**
 * ISS-913 (merged ISS-983): `recoverPendingMutation`'s `ticket_update` replay
 * proves ownership against the session's `claimEpoch` inside the SAME project
 * lock as the write, instead of trusting an `expectedCurrent` status match.
 * Reachable via `start` (and any other entry that recovers before
 * reconciling) -- `report`/`resume` are gated by `claimPreflightBlock` ahead
 * of recovery and are not exposed the same way (ISS-913's own REACHABILITY
 * section), so every fixture here drives `action: "start"`, matching
 * iss965-mutation-recovery.test.ts's T13 suite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
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

/**
 * Plants a session sitting in WRITE_TESTS (inside RECONCILED_STATES, matching
 * the T13 fixture shape) with an explicit `pendingProjectMutation` and an
 * explicit (possibly absent or malformed) `claimEpoch` -- unlike
 * iss965-mutation-recovery.test.ts's shared helper, which always mints a
 * matching epoch, this lets each test control epoch presence/validity
 * independently of the ticket's actual claim state.
 */
function plantSession(
  root: string,
  mutation: Record<string, unknown> | null,
  claimEpoch: unknown,
): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "WRITE_TESTS",
    previousState: "PLAN_REVIEW",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    claimEpoch,
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
  const logPath = join(sessDir, "events.log");
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss913-recovery-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

describe("ISS-913: recoverPendingMutation proves ownership inside its own lock", () => {
  it("non-completion replay against a foreign-owned ticket is refused, not replayed (RED-at-parent)", async () => {
    writeTicket(root, "T-001", {
      status: "open",
      claim: { user: "rival@test.com", branch: "rival-branch", since: NOW },
      claimedBySession: "rival-session-id",
    });
    const epoch = {
      ticketId: "T-001", sessionId: "our-epoch-session-id", user: "me@example.com",
      branch: "main", since: NOW, establishedAt: NOW,
    };
    const { sessionId, sessDir } = plantSession(root, {
      type: "ticket_update", target: "T-001", value: "inprogress",
      expectedCurrent: "open", transitionId: "txn-a",
    }, epoch);

    const before = readTicketRaw(root, "T-001");
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true);

    // Refused: the rival's claim, not this session's write, survives untouched.
    expect(readTicketRaw(root, "T-001")).toBe(before);
    expect(readTicket(root, "T-001").status).toBe("open");
    expect((readTicket(root, "T-001") as { claimedBySession?: string }).claimedBySession).toBe("rival-session-id");

    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);

    const conflicts = eventsOfType(sessDir, "mutation_conflict");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.data).toMatchObject({ targetId: "T-001", expected: "open", actual: "open" });
  });

  it("already-applied short-circuit against a foreign-owned ticket (non-completion target) is refused, not silently trusted (RED-at-parent)", async () => {
    // Status already equals the marker's target value -- the exact shape
    // parent treats as "my write already landed" unconditionally, without
    // ever checking who actually holds the ticket now.
    writeTicket(root, "T-001", {
      status: "inprogress",
      claim: { user: "rival@test.com", branch: "rival-branch", since: NOW },
      claimedBySession: "rival-session-id",
    });
    const epoch = {
      ticketId: "T-001", sessionId: "our-epoch-session-id", user: "me@example.com",
      branch: "main", since: NOW, establishedAt: NOW,
    };
    const { sessionId, sessDir } = plantSession(root, {
      type: "ticket_update", target: "T-001", value: "inprogress",
      expectedCurrent: "open", transitionId: "txn-b",
    }, epoch);

    const before = readTicketRaw(root, "T-001");
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true);

    expect(readTicketRaw(root, "T-001")).toBe(before);
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);

    const conflicts = eventsOfType(sessDir, "mutation_conflict");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.data).toMatchObject({ targetId: "T-001", expected: "open", actual: "inprogress" });
  });

  it("already-applied short-circuit against a CONTRADICTORY completed ticket (still carrying a rival claim) is refused, not treated as this session's own success (RED-at-parent, Codex review-code round 1)", async () => {
    // Status already equals the marker's target value ("complete"), but the
    // ticket still carries a RIVAL's claim/session stamp -- a status match is
    // not proof this session's own write produced it, and clearing the
    // marker here would also release `postMutation`, letting the session
    // believe ITS OWN completion succeeded when a foreign actor's did.
    writeTicket(root, "T-001", {
      status: "complete",
      completedDate: "2026-08-05",
      claim: { user: "rival@test.com", branch: "rival-branch", since: NOW },
      claimedBySession: "rival-session-id",
    });
    const epoch = {
      ticketId: "T-001", sessionId: "our-epoch-session-id", user: "me@example.com",
      branch: "main", since: NOW, establishedAt: NOW,
    };
    const { sessionId, sessDir } = plantSession(root, {
      type: "ticket_update", target: "T-001", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-b2",
    }, epoch);

    const before = readTicketRaw(root, "T-001");
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true);

    // Byte-identical: the rival's claim on the already-complete ticket
    // survives untouched, and no postMutation-driven advance occurred.
    expect(readTicketRaw(root, "T-001")).toBe(before);
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);

    const conflicts = eventsOfType(sessDir, "mutation_conflict");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.data).toMatchObject({ targetId: "T-001", expected: "inprogress", actual: "complete" });
  });

  it("completion replay against a foreign-owned ticket is refused, not silently completed with a live claim still attached (RED-at-parent, ISS-913's own reproduction)", async () => {
    writeTicket(root, "T-001", {
      status: "inprogress",
      claim: { user: "rival@test.com", branch: "rival-branch", since: NOW },
      claimedBySession: "rival-session-id",
    });
    const epoch = {
      ticketId: "T-001", sessionId: "our-epoch-session-id", user: "me@example.com",
      branch: "main", since: NOW, establishedAt: NOW,
    };
    const { sessionId, sessDir } = plantSession(root, {
      type: "ticket_update", target: "T-001", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-c",
    }, epoch);

    const before = readTicketRaw(root, "T-001");
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true);

    // Byte-identical: parent flips this to "complete" while the rival's claim
    // is still attached (the exact "contradictory" shape ISS-983 found).
    expect(readTicketRaw(root, "T-001")).toBe(before);
    expect(readTicket(root, "T-001").status).toBe("inprogress");
    expect((readTicket(root, "T-001") as { claim?: unknown }).claim).toBeTruthy();

    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);

    const conflicts = eventsOfType(sessDir, "mutation_conflict");
    expect(conflicts.length).toBe(1);
  });

  it("completion replay with PROVEN ownership strips the claim and sets completedDate (RED-at-parent: parent leaves the claim attached and completedDate unset)", async () => {
    const sessionEpochId = "will-be-filled";
    writeTicket(root, "T-001", {
      status: "inprogress",
      claim: { user: "me@example.com", branch: "main", since: NOW },
      claimedBySession: sessionEpochId,
    });
    const { sessionId, sessDir } = plantSession(root, {
      type: "ticket_update", target: "T-001", value: "complete",
      expectedCurrent: "inprogress", transitionId: "txn-d",
    }, null); // epoch filled in below once we know the real sessionId

    // The epoch and the ticket's claimedBySession must both name the SAME
    // session id (provenOwnership checks both fields), so mint the epoch
    // after the session exists and rewrite the ticket + session to match.
    const epoch = {
      ticketId: "T-001", sessionId, user: "me@example.com",
      branch: "main", since: NOW, establishedAt: NOW,
    };
    writeTicket(root, "T-001", {
      status: "inprogress",
      claim: { user: "me@example.com", branch: "main", since: NOW },
      claimedBySession: sessionId,
    });
    const stateBefore = readState(sessDir);
    writeSessionSync(sessDir, { ...stateBefore, claimEpoch: epoch } as unknown as FullSessionState);

    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true); // still refuses to start: an active session exists

    const ticket = readTicket(root, "T-001") as {
      status: string; completedDate: string | null; claim?: unknown; claimedBySession?: unknown;
    };
    expect(ticket.status).toBe("complete");
    expect(ticket.completedDate).not.toBeNull();
    expect(ticket.claim).toBeUndefined();
    expect(ticket.claimedBySession).toBeUndefined();

    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);
    expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(0);
  });

  it("a malformed (present but corrupt) epoch routes to conflict unconditionally, even though the ticket would otherwise replay cleanly (RED-at-parent)", async () => {
    // A ticket with no claim material at all -- parent would replay this
    // without hesitation, and a validly-epoched session would too. The point
    // here is narrower: a PRESENT epoch that fails parseClaimEpoch must not
    // be folded into the "no epoch, trust it" legacy path.
    writeTicket(root, "T-001", { status: "open" });
    const { sessionId, sessDir } = plantSession(root, {
      type: "ticket_update", target: "T-001", value: "inprogress",
      expectedCurrent: "open", transitionId: "txn-e",
    }, { ticketId: "T-001" }); // missing sessionId/establishedAt -- fails parseClaimEpoch

    const before = readTicketRaw(root, "T-001");
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true);

    expect(readTicketRaw(root, "T-001")).toBe(before);
    expect(readTicket(root, "T-001").status).toBe("open");

    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);
    expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(1);
  });

  it("an ABSENT epoch (pre-T-442 session) keeps today's ungated replay behavior, even against a foreign-looking ticket (non-regression pin)", async () => {
    // No claimEpoch key at all -- a session that never gained the ability to
    // prove ownership. Scope item 4 of ISS-913 requires this keep working
    // exactly as it did before this fix, since narrowing it would strand
    // every pre-T-442 session's crash recovery.
    writeTicket(root, "T-001", { status: "open" });
    const { sessionId, sessDir } = plantSession(root, {
      type: "ticket_update", target: "T-001", value: "inprogress",
      expectedCurrent: "open", transitionId: "txn-f", claimedBySession: "legacy-session-stamp",
    }, null);

    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true); // still refuses to start: an active session exists

    const ticket = readTicket(root, "T-001") as { status: string; claimedBySession?: string };
    expect(ticket.status).toBe("inprogress");
    expect(ticket.claimedBySession).toBe("legacy-session-stamp");

    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.sessionId).toBe(sessionId);
    expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(0);
  });
});
