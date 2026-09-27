/**
 * T-537 S3: a pending completion replay stops at an owner checkpoint that has
 * not released. Report, start and resume refuse and keep the session exactly
 * as it was (state, the whole marker including its postMutation, ticket);
 * cancel, even in auto mode behind the soft gate, abandons the completion,
 * records it, never applies it, and still releases; once the owner approves,
 * report replays the completion with its evidence and applies the
 * postMutation. Pick-ticket and finalize refuse such a ticket too. RED at 09e7dade: recovery there writes the completion
 * directly and has no checkpoint notion.
 *
 * Fixture shape follows iss965-mutation-recovery.test.ts: a session in
 * WRITE_TESTS holding a proven claim on T-001, with a pendingProjectMutation
 * completing T-001, and T-001 blocked by the owner checkpoint T-009.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
import { checkpointDigest } from "../../src/core/owner-checkpoint.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = new Date().toISOString();
const CONTENT = { kind: "decision", question: "Ship the new onboarding?", evidenceRefs: [] as string[] };
const DIGEST = checkpointDigest(CONTENT);

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 4, project: "test", type: "npm", language: "typescript",
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

/** T-009: the owner checkpoint, pending unless `approved`. */
function writeCheckpoint(root: string, approved: boolean): void {
  const resolution = approved
    ? { resolution: { response: "yes", respondedBy: "owner", respondedAt: NOW, revision: 1, digest: DIGEST, generation: 2 } }
    : {};
  writeTicket(root, "T-009", {
    title: "Owner decision",
    status: approved ? "complete" : "open",
    completedDate: approved ? "2026-09-26" : null,
    order: 5,
    ownerCheckpoint: {
      ...CONTENT, owner: "owner", lifecycle: "active",
      revision: 1, digest: DIGEST, generation: approved ? 2 : 1, history: [],
      ...resolution,
    },
  });
}

function readTicketRaw(root: string, id: string): string {
  return readFileSync(join(root, ".story", "tickets", `${id}.json`), "utf-8");
}

function readTicket(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readTicketRaw(root, id));
}

/** Advances the session when the completion lands; a blocked or abandoned completion never applies it. */
const POST_MUTATION = { nextSessionState: "HANDOVER", terminationReason: "t537-post-mutation", clearTicket: true };

/** A session (WRITE_TESTS by default) with a proven claim on T-001 and a pending completion of it. */
function plantBlockedCompletion(
  root: string,
  extra: Record<string, unknown> = {},
): { sessionId: string; sessDir: string; mutation: Record<string, unknown> } {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const epoch = {
    ticketId: "T-001", sessionId: session.sessionId, user: "me@example.com",
    branch: "main", since: NOW, establishedAt: NOW,
  };
  const mutation = {
    type: "ticket_update", target: "T-001", value: "complete",
    expectedCurrent: "inprogress", transitionId: "txn-cp-1",
    postMutation: POST_MUTATION,
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
    mode: "auto",
    stuckRetryCount: 0,
    ...extra,
  } as unknown as FullSessionState);
  writeTicket(root, "T-001", {
    blockedBy: ["T-009"],
    claimedBySession: session.sessionId,
    claim: { user: "me@example.com", branch: "main", since: NOW },
  });
  return { sessionId: session.sessionId, sessDir, mutation };
}

/** The session file exactly as written: a refusal must not touch it (revision, lease, ownership included). */
function readStateRaw(sessDir: string): string {
  return readFileSync(join(sessDir, "state.json"), "utf-8");
}

function readState(sessDir: string): FullSessionState & Record<string, unknown> {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState & Record<string, unknown>;
}

function eventsOfType(sessDir: string, type: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(sessDir, "events.log"), "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

const textOf = (r: { content: unknown[] }): string => (r.content[0] as { text: string }).text;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t537-recovery-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

/** What a blocked call must leave exactly as it was. */
function pipelineOf(state: FullSessionState & Record<string, unknown>): Record<string, unknown> {
  return {
    state: state.state, previousState: state.previousState, ticket: state.ticket,
    terminationReason: state.terminationReason ?? null, pendingProjectMutation: state.pendingProjectMutation,
  };
}

describe("T-537: a pending completion blocked by an owner checkpoint", () => {
  it("report refuses and changes nothing: state, the whole marker and the ticket stay; the refusal is logged", async () => {
    writeCheckpoint(root, false);
    const { sessionId, sessDir, mutation } = plantBlockedCompletion(root);
    const ticketBefore = readTicketRaw(root, "T-001");
    const before = pipelineOf(readState(sessDir));
    const rawBefore = readStateRaw(sessDir);

    const result = await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/waits on owner checkpoint T-009.*resume.*cancel/s);
    expect(readStateRaw(sessDir)).toBe(rawBefore);

    expect(readTicketRaw(root, "T-001")).toBe(ticketBefore);
    const after = readState(sessDir);
    expect(pipelineOf(after)).toEqual(before);
    expect(after.pendingProjectMutation).toEqual(mutation);
    expect(eventsOfType(sessDir, "checkpoint_blocked").map((e) => e.data)).toEqual([{ ticketId: "T-001", checkpoints: ["T-009"] }]);
    expect(eventsOfType(sessDir, "mutation_conflict")).toEqual([]);
  });

  it("start over the blocked session refuses the same way and keeps it", async () => {
    writeCheckpoint(root, false);
    const { sessDir } = plantBlockedCompletion(root);
    const ticketBefore = readTicketRaw(root, "T-001");
    const before = pipelineOf(readState(sessDir));

    const rawBefore = readStateRaw(sessDir);
    const result = await handleAutonomousGuide(root, { action: "start" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/waits on owner checkpoint T-009/);
    expect(readStateRaw(sessDir)).toBe(rawBefore);
    expect(readTicketRaw(root, "T-001")).toBe(ticketBefore);
    expect(pipelineOf(readState(sessDir))).toEqual(before);
  });

  it("resume of a compacted session refuses the same way and keeps it compacted", async () => {
    writeCheckpoint(root, false);
    const { sessionId, sessDir } = plantBlockedCompletion(root, { state: "COMPACT", compactPending: true, preCompactState: "WRITE_TESTS" });
    const ticketBefore = readTicketRaw(root, "T-001");
    const before = pipelineOf(readState(sessDir));

    const rawBefore = readStateRaw(sessDir);
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/waits on owner checkpoint T-009/);
    expect(readStateRaw(sessDir)).toBe(rawBefore);
    expect(readTicketRaw(root, "T-001")).toBe(ticketBefore);
    expect(pipelineOf(readState(sessDir))).toEqual(before);
    expect(readState(sessDir).state).toBe("COMPACT");
  });

  it("cancel in auto mode with a held claim and work remaining abandons the completion: recorded, never applied, marker cleared, claim released; a second cancel adds nothing", async () => {
    writeCheckpoint(root, false);
    const { sessionId, sessDir, mutation } = plantBlockedCompletion(root);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(textOf(result)).not.toMatch(/cannot cancel|refus/i);
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.terminationReason).not.toBe(POST_MUTATION.terminationReason);
    const abandoned = after.checkpointBlockedAbandoned as Array<Record<string, unknown>>;
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ kind: "checkpoint-blocked-abandoned", ticketId: "T-001", checkpoints: ["T-009"], mutation });
    expect(eventsOfType(sessDir, "checkpoint_blocked_abandoned")).toHaveLength(1);

    const ticket = readTicket(root, "T-001");
    expect(ticket.status).not.toBe("complete");
    expect(ticket.checkpointEvidence).toBeUndefined();
    expect(ticket.claimedBySession).toBeUndefined();
    expect(ticket.claim).toBeUndefined();

    await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect((readState(sessDir).checkpointBlockedAbandoned as unknown[]).length).toBe(1);
    expect(eventsOfType(sessDir, "checkpoint_blocked_abandoned")).toHaveLength(1);
    expect(readTicket(root, "T-001").status).not.toBe("complete");
  });

  it("once the owner approves, report replays the completion with its evidence, clears the marker and applies the postMutation", async () => {
    writeCheckpoint(root, false);
    const { sessionId, sessDir } = plantBlockedCompletion(root);
    const blocked = await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } });
    expect(blocked.isError).toBe(true);
    expect(readState(sessDir).state).toBe("WRITE_TESTS");

    writeCheckpoint(root, true);
    await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } });

    const ticket = readTicket(root, "T-001");
    expect(ticket.status).toBe("complete");
    expect(ticket.checkpointEvidence).toEqual([{ checkpoint: "T-009", generation: 2, revision: 1, digest: DIGEST, state: "approved" }]);
    expect(ticket.claim).toBeUndefined();
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.state).not.toBe("WRITE_TESTS");
    expect(after.ticket).toBeUndefined();
    expect(eventsOfType(sessDir, "checkpoint_blocked")).toHaveLength(1);
  });
});

/** T-009's file present but undecodable: whether it is a checkpoint that still blocks cannot be known. */
function writeUndecodableCheckpoint(root: string): void {
  writeFileSync(join(root, ".story", "tickets", "T-009.json"), "{not json");
}

describe("T-537: a project that does not load never confirms a completion", () => {
  it("report, start and compacted resume each refuse on the strict load, name the file and change nothing", async () => {
    for (const call of ["report", "start", "resume"] as const) {
      rmSync(join(root, ".story", "sessions"), { recursive: true, force: true });
      mkdirSync(join(root, ".story", "sessions"), { recursive: true });
      writeUndecodableCheckpoint(root);
      const { sessionId, sessDir, mutation } = plantBlockedCompletion(root, call === "resume" ? { state: "COMPACT", compactPending: true, preCompactState: "WRITE_TESTS" } : {});
      const ticketBefore = readTicketRaw(root, "T-001");
      const before = pipelineOf(readState(sessDir));
      const rawBefore = readStateRaw(sessDir);

      const result = call === "report" ? await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } })
        : call === "start" ? await handleAutonomousGuide(root, { action: "start" })
        : await handleAutonomousGuide(root, { action: "resume", sessionId });
      expect(result.isError, call).toBe(true);
      expect(textOf(result), call).toMatch(/T-001's completion cannot be confirmed: the project did not load cleanly \(.*T-009.*\).*nothing was written/s);

      expect(readTicketRaw(root, "T-001"), call).toBe(ticketBefore);
      expect(readStateRaw(sessDir), call).toBe(rawBefore);
      const after = readState(sessDir);
      expect(pipelineOf(after), call).toEqual(before);
      expect(after.pendingProjectMutation, call).toEqual(mutation);
      const failed = eventsOfType(sessDir, "checkpoint_load_failed");
      expect(failed, call).toHaveLength(1);
      expect(failed[0]!.data, call).toMatchObject({ ticketId: "T-001", reason: expect.stringMatching(/T-009/) });
      expect(eventsOfType(sessDir, "mutation_conflict"), call).toEqual([]);
      expect(eventsOfType(sessDir, "checkpoint_blocked"), call).toEqual([]);
    }
  });

  it("once the file is restored, the same report replays normally against the checkpoint it names", async () => {
    writeUndecodableCheckpoint(root);
    const { sessionId, sessDir } = plantBlockedCompletion(root);
    expect((await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } })).isError).toBe(true);

    writeCheckpoint(root, true);
    await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } });
    expect(readTicket(root, "T-001").status).toBe("complete");
    expect(readState(sessDir).pendingProjectMutation).toBeNull();
  });

  it("cancel abandons the completion with the load failure as its reason: marker cleared, never applied, claim released", async () => {
    writeUndecodableCheckpoint(root);
    const { sessionId, sessDir, mutation } = plantBlockedCompletion(root);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(textOf(result)).not.toMatch(/cannot cancel|refus/i);
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).toBeNull();
    expect(after.terminationReason).not.toBe(POST_MUTATION.terminationReason);
    const abandoned = after.checkpointBlockedAbandoned as Array<Record<string, unknown>>;
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ kind: "checkpoint-blocked-abandoned", ticketId: "T-001", checkpoints: [], mutation });
    expect(abandoned[0]!.reason).toMatch(/^load-failed: .*T-009/);
    const events = eventsOfType(sessDir, "checkpoint_blocked_abandoned");
    expect(events).toHaveLength(1);
    expect((events[0]!.data as Record<string, unknown>).reason).toMatch(/^load-failed: .*T-009/);

    const ticket = readTicket(root, "T-001");
    expect(ticket.status).not.toBe("complete");
    expect(ticket.claimedBySession).toBeUndefined();
    expect(ticket.claim).toBeUndefined();
  });

  it("the completed-consistent preflight (report and start) refuses rather than terminalize when the project does not load, and when a checkpoint no longer releases", async () => {
    for (const [shape, call] of [["undecodable", "report"], ["pending", "report"], ["undecodable", "start"], ["pending", "start"]] as const) {
      const label = `${shape} ${call}`;
      rmSync(join(root, ".story", "sessions"), { recursive: true, force: true });
      mkdirSync(join(root, ".story", "sessions"), { recursive: true });
      if (shape === "undecodable") writeUndecodableCheckpoint(root);
      else writeCheckpoint(root, false);
      const { sessionId, sessDir } = plantBlockedCompletion(root, { pendingProjectMutation: null });
      // The session's own completion landed: complete, both claim keys stripped.
      writeTicket(root, "T-001", { status: "complete", completedDate: "2026-09-26", blockedBy: ["T-009"] });
      const ticketBefore = readTicketRaw(root, "T-001");
      const rawBefore = readStateRaw(sessDir);

      const result = call === "report"
        ? await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "tests_written" } })
        : await handleAutonomousGuide(root, { action: "start" });
      expect(result.isError, label).toBe(true);
      expect(textOf(result), label).toMatch(shape === "undecodable" ? /did not load cleanly \(.*T-009/s : /waits on owner checkpoint T-009/);
      const after = readState(sessDir);
      expect(after.state, label).toBe("WRITE_TESTS");
      expect(readStateRaw(sessDir), label).toBe(rawBefore);
      expect(readTicketRaw(root, "T-001"), label).toBe(ticketBefore);
      expect(eventsOfType(sessDir, shape === "undecodable" ? "checkpoint_load_failed" : "checkpoint_blocked"), label).toHaveLength(1);
    }
  });
});

describe("T-537: pick and finalize refuse a ticket that waits on an owner checkpoint", () => {
  function plantAt(state: string, extra: Record<string, unknown> = {}): { sessionId: string; sessDir: string } {
    const session = createSession(root, "coding", deriveWorkspaceId(root));
    const sessDir = join(root, ".story", "sessions", session.sessionId);
    writeSessionSync(sessDir, {
      ...session,
      state,
      mode: "auto",
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
      ...extra,
    } as unknown as FullSessionState);
    return { sessionId: session.sessionId, sessDir };
  }

  it("pick-ticket refuses the checkpoint itself and a ticket waiting on it, claiming nothing", async () => {
    writeCheckpoint(root, false);
    writeTicket(root, "T-001", { status: "open", blockedBy: ["T-009"] });
    const { sessionId, sessDir } = plantAt("PICK_TICKET");
    for (const [id, why] of [["T-009", /owner checkpoint/], ["T-001", /waits on owner checkpoint T-009/]] as const) {
      const before = readTicketRaw(root, id);
      const result = await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "ticket_picked", ticketId: id } });
      expect(textOf(result)).toMatch(why);
      expect(textOf(result)).toMatch(/Pick a different ticket/);
      expect(readTicketRaw(root, id)).toBe(before);
      expect(readState(sessDir).state).toBe("PICK_TICKET");
    }
  });

  it("finalize at commit refuses after a checkpoint reopens, names the landed commit, and cancel then leaves the ticket incomplete and released", async () => {
    writeCheckpoint(root, false);
    const { sessionId, sessDir } = plantAt("FINALIZE", {
      finalizeCheckpoint: "precommit_passed",
      ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    });
    const epoch = { ticketId: "T-001", sessionId, user: "me@example.com", branch: "main", since: NOW, establishedAt: NOW };
    writeSessionSync(sessDir, { ...readState(sessDir), claimEpoch: epoch } as unknown as FullSessionState);
    writeTicket(root, "T-001", {
      blockedBy: ["T-009"], claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
    });
    const before = readTicketRaw(root, "T-001");

    const result = await handleAutonomousGuide(root, { action: "report", sessionId, report: { completedAction: "commit_done", commitHash: "abc123" } });
    expect(textOf(result)).toMatch(/waits on owner checkpoint T-009/);
    expect(textOf(result)).toMatch(/already landed.*nothing replays/s);
    expect(readTicketRaw(root, "T-001")).toBe(before);
    expect(readState(sessDir).state).toBe("FINALIZE");

    const cancel = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(textOf(cancel)).not.toMatch(/cannot cancel|refus/i);
    const ticket = readTicket(root, "T-001");
    expect(ticket.status).not.toBe("complete");
    expect(ticket.claim).toBeUndefined();
    expect(ticket.claimedBySession).toBeUndefined();
  });
});
