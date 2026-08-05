/**
 * ISS-965: claim reconciliation false positive. A session that observes its
 * OWN consistent completion (ticket `complete`, both claim keys stripped --
 * exactly the shape `clearClaimOnComplete` leaves on success) used to read
 * that shape as a foreign claim loss and kill itself with a cancel-and-retype
 * instruction, even though nothing was actually wrong.
 *
 * This drives claimPreflightBlock end to end via handleAutonomousGuide, the
 * same way plan-claim-lost-transition.test.ts and cancel-claim-ownership.test.ts
 * drive their respective entry points with real session files and a temp
 * project (git-inspector mocked).
 *
 * T2 (report, WRITE_TESTS + IMPLEMENT), T3 (resume path observations), T6
 * (foreign arms stay green + amended kill text), T9 (real clearClaimOnComplete
 * strip), T10 (citation strings), T11 (ordering pin: completed-consistent
 * reaches terminalization despite isClaimLost being false for it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  gitUserEmail: vi.fn().mockResolvedValue("me@example.com"),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { handleTicketUpdate } from "../../src/cli/commands/ticket.js";
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

function writeTicket(root: string, extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-07-02",
    completedDate: null, blockedBy: [],
    ...extra,
  }));
}

function readTicket(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
}

/** Plant a session mid-pipeline, holding an epoch matching its own claim. */
function plantSession(root: string, state: string, extra: Partial<FullSessionState> = {}): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const epoch = {
    ticketId: "T-001",
    sessionId: session.sessionId,
    user: "me@example.com",
    branch: "main",
    since: NOW,
    establishedAt: NOW,
  };
  writeSessionSync(sessDir, {
    ...session,
    state,
    previousState: "PLAN_REVIEW",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    claimEpoch: epoch,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
    ...extra,
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
  root = mkdtempSync(join(tmpdir(), "iss965-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

describe("ISS-965 terminal routing", () => {
  describe("T2: report observes its own completion", () => {
    for (const state of ["WRITE_TESTS", "IMPLEMENT"] as const) {
      it(`terminalizes cleanly from ${state}: no kill text, terminal instruction, state persisted HANDOVER`, async () => {
        writeTicket(root, { status: "complete", completedDate: "2026-08-05" });
        const { sessionId, sessDir } = plantSession(root, state);

        const result = await handleAutonomousGuide(root, {
          action: "report",
          sessionId,
          report: { completedAction: state === "WRITE_TESTS" ? "tests_written" : "implementation_done" },
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).not.toContain("Claim lost on");
        expect(text).toContain("Complete -- Session Ending");
        expect(text).toContain("Write a session handover");

        const after = readState(sessDir);
        expect(after.state).toBe("HANDOVER");
        expect(after.previousState).toBe(state);
        expect((after as unknown as Record<string, unknown>).terminalDisposition).toMatchObject({
          kind: "completion-observed",
          ticketId: "T-001",
        });

        // The ledger ticket itself is untouched by terminalization.
        const ticket = readTicket(root);
        expect(ticket.status).toBe("complete");
        expect(ticket).not.toHaveProperty("claim");
        expect(ticket).not.toHaveProperty("claimedBySession");
      });
    }
  });

  describe("T3: resume path observations (compacted terminal session)", () => {
    it("resume returns a handover-writing instruction, never re-dispatches WRITE_TESTS/IMPLEMENT work for the old ticket", async () => {
      const { prepareForCompact } = await import("../../src/autonomous/session.js");
      writeTicket(root, { status: "complete", completedDate: "2026-08-05" });
      const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");

      // Terminalize first (report), then compact it -- this is the shape a
      // real client compaction produces on an already-terminalized session.
      const reportResult = await handleAutonomousGuide(root, {
        action: "report",
        sessionId,
        report: { completedAction: "tests_written" },
      });
      expect(reportResult.isError).toBeFalsy();
      const terminalized = readState(sessDir);
      expect(terminalized.state).toBe("HANDOVER");

      prepareForCompact(sessDir, terminalized, { expectedHead: "abc123" });
      const compacted = readState(sessDir);
      expect(compacted.state).toBe("COMPACT");
      // D2: preCompactState preserves HANDOVER, not the pre-terminal WRITE_TESTS.
      expect(compacted.preCompactState).toBe("HANDOVER");

      const resumeResult = await handleAutonomousGuide(root, { action: "resume", sessionId });
      expect(resumeResult.isError).toBeFalsy();
      const text = (resumeResult.content[0] as { text: string }).text;

      // Same observations as T2: no kill text, and an instruction to write the
      // handover (HandoverStage.enter()'s generic text, since this arrived via
      // the stage-dispatch path rather than claimPreflightBlock's own return).
      expect(text).not.toContain("Claim lost on");
      expect(text).toContain("Write a session handover");
      // Must not read as a fresh dispatch of the old ticket's implementation work.
      expect(text).not.toContain("implementation_done");
      expect(text).not.toContain("tests_written");

      const after = readState(sessDir);
      expect(after.state).toBe("HANDOVER");
    });
  });

  describe("T6: foreign arms stay green, kill text amended", () => {
    it("still kills a genuinely foreign session takeover (claimedBySession mismatch)", async () => {
      const OTHER = "ffffffff-0000-0000-0000-000000000009";
      writeTicket(root, {
        claimedBySession: OTHER,
        claim: { user: "them@example.com", branch: "main", since: NOW },
      });
      const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");

      const result = await handleAutonomousGuide(root, {
        action: "report",
        sessionId,
        report: { completedAction: "tests_written" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Claim lost on");
      expect(text).toContain("T-442");
      // T10: neither citation leaks into the user-facing kill text.
      expect(text).not.toContain("(ISS-784)");
      expect(text).not.toContain("(ISS-965)");

      // Session did not advance past its working stage.
      const after = readState(sessDir);
      expect(after.state).toBe("WRITE_TESTS");
    });

    it("still kills a released-but-not-complete ticket (open, both keys gone -- the ISS-784 merge-loser shape)", async () => {
      writeTicket(root, { status: "open" });
      const { sessionId, sessDir } = plantSession(root, "IMPLEMENT");

      const result = await handleAutonomousGuide(root, {
        action: "report",
        sessionId,
        report: { completedAction: "implementation_done" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("claim was released");
      const after = readState(sessDir);
      expect(after.state).toBe("IMPLEMENT");
    });
  });

  describe("T9: the real clearClaimOnComplete strip, not a hand-authored fixture", () => {
    it("a --force ticket_update(complete) mid-item produces the shape, then report terminal-routes with no claim-lost error", async () => {
      writeTicket(root, {});
      const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");

      // Drive the REAL production strip: handleTicketUpdate -> resolveCompletionGuard
      // -> clearClaimOnComplete, exactly the code path FINALIZE itself uses.
      await handleTicketUpdate("T-001", { status: "complete" }, "json", root, true);
      const stripped = readTicket(root);
      expect(stripped.status).toBe("complete");
      expect(stripped).not.toHaveProperty("claim");
      expect(stripped).not.toHaveProperty("claimedBySession");

      const result = await handleAutonomousGuide(root, {
        action: "report",
        sessionId,
        report: { completedAction: "tests_written" },
      });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain("Claim lost on");
      const after = readState(sessDir);
      expect(after.state).toBe("HANDOVER");
    });
  });

  describe("T10: no stray issue citation in user-facing src strings", () => {
    it("the kill-text template embeds neither (ISS-784) nor (ISS-965)", async () => {
      // Static check on the actual template, independent of any fixture: a
      // future refactor could reintroduce the citation without any of the
      // behavioral tests above noticing if they only assert absence on ONE path.
      const { readFileSync: rf } = await import("node:fs");
      const src = rf(new URL("../../src/autonomous/guide.ts", import.meta.url), "utf-8");
      const killTextMatch = src.match(/`Claim lost on \$\{ticketId\}[\s\S]{0,400}/);
      expect(killTextMatch).not.toBeNull();
      const killTemplate = killTextMatch![0];
      expect(killTemplate).not.toContain("(ISS-784)");
      expect(killTemplate).not.toContain("(ISS-965)");
    });
  });

  describe("T11: ordering pin -- completed-consistent reaches terminalization despite isClaimLost being false for it", () => {
    it("does not fall through to the pipeline (against-tidying regression)", async () => {
      // If claimPreflightBlock's `if (!isClaimLost(result)) return null;` guard
      // were hoisted ABOVE the completed-consistent branch, this exact fixture
      // would return null (isClaimLost is false for completed-consistent by
      // design) and the session would fall through into WriteTestsStage.report(),
      // which expects a "tests_written"-shaped report and would either error on
      // an unepected re-entry or silently advance the pipeline on a finished
      // ticket. Either way the session would NOT land in HANDOVER.
      writeTicket(root, { status: "complete", completedDate: "2026-08-05" });
      const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");

      const result = await handleAutonomousGuide(root, {
        action: "report",
        sessionId,
        report: { completedAction: "tests_written" },
      });

      expect(result.isError).toBeFalsy();
      const after = readState(sessDir);
      expect(after.state).toBe("HANDOVER");
      expect((after as unknown as Record<string, unknown>).terminalDisposition).toMatchObject({
        kind: "completion-observed",
      });
      // The composite event is the audit trail proving THIS path terminalized it
      // (as opposed to some other route landing on HANDOVER coincidentally).
      const events = eventsOfType(sessDir, "claim_terminalized");
      expect(events.length).toBe(1);
      expect(events[0]?.data).toMatchObject({ from: "WRITE_TESTS", to: "HANDOVER", ticketId: "T-001" });
      // Codex round: the event must carry the PROSPECTIVE POST-write revision
      // (matching writeSessionWithEvent's other caller), not the pre-write one --
      // the event is appended before writeSessionSync's internal +1 bump.
      expect(events[0]?.rev).toBe(after.revision);
    });
  });
});
