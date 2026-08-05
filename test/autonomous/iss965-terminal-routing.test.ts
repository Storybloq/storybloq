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
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
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

/**
 * Plant a session mid-pipeline, holding an epoch matching its own claim.
 *
 * F1 (byte-review): workspaceId must be the REAL deriveWorkspaceId(root), not
 * a placeholder -- T9 drives handleTicketUpdate's non-force path, which calls
 * findActiveSessionFull(root) internally (via resolveCompletionGuard) to find
 * this session's epoch. A placeholder workspaceId would filter it out as
 * "wrong workspace" and the completion would reject for lack of proof instead
 * of exercising the real authorized strip. Harmless for the report/resume
 * tests in this file, which look sessions up by sessionId directly.
 */
function plantSession(root: string, state: string, extra: Partial<FullSessionState> = {}): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
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
        // F1 (byte-review): plant real claim keys and drive the completion
        // through handleTicketUpdate's real (non-force) strip, so the
        // "ledger untouched by terminalization" assertions below are checking
        // that terminalization did not RE-ADD keys a real strip removed --
        // not merely that a hand-authored fixture never had any to begin with.
        const { sessionId, sessDir } = plantSession(root, state);
        writeTicket(root, {
          claimedBySession: sessionId,
          claim: { user: "me@example.com", branch: "main", since: NOW },
        });
        await handleTicketUpdate("T-001", { status: "complete" }, "json", root);

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
        // F5 (byte-review fixup): routed through guideResult, so the response
        // carries the same session footer every other instruction does --
        // this is the exact id an agent needs for the "handover_written"
        // call-back the instruction itself asks for, at the point in a long,
        // compaction-prone session it is least likely to still hold.
        expect(text).toContain(`**Session:** ${sessionId}`);

        const after = readState(sessDir);
        expect(after.state).toBe("HANDOVER");
        expect(after.previousState).toBe(state);
        expect((after as unknown as Record<string, unknown>).terminalDisposition).toMatchObject({
          kind: "completion-observed",
          ticketId: "T-001",
        });

        // The ledger ticket itself is untouched by terminalization: still
        // stripped from the real handleTicketUpdate call above, not re-added.
        const ticket = readTicket(root);
        expect(ticket.status).toBe("complete");
        expect(ticket).not.toHaveProperty("claim");
        expect(ticket).not.toHaveProperty("claimedBySession");
      });
    }
  });

  describe("T3: the COMPACT round trip (terminalize via report, park, resume) -- the ONLY reachable resume path for this shape", () => {
    // F4 (byte-review fixup, retitled per the pen's retraction): this is NOT a
    // "resume observes completed-consistent directly" pin -- action:"resume"
    // has an unconditional COMPACT-only guard (guide.ts, before
    // claimPreflightBlock is ever called), so a session sitting in
    // WRITE_TESTS/IMPLEMENT calling resume directly is refused with "not in
    // COMPACT state" before reconciliation runs at all. The COMPACT round trip
    // below is the ONLY way a terminalized session's resume is ever reachable,
    // which is exactly what this test drives end to end. A name overstating
    // that reach is how the next reader would inherit the same mistaken
    // reachability claim this test's title used to encode.
    it("resume after terminalize+park returns a handover-writing instruction, never re-dispatches WRITE_TESTS/IMPLEMENT work for the old ticket", async () => {
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
      // F4 (byte-review fixup): dropped the two absence assertions that used to
      // sit here ("implementation_done"/"tests_written" not in text) -- neither
      // string can appear on ANY arm of this fixture (nothing in HandoverStage's
      // generic text or claimPreflightBlock's terminal instruction ever emits
      // those completedAction values), so they asserted nothing a mutant could
      // ever trip.
      expect(text).not.toContain("Claim lost on");
      expect(text).toContain("Write a session handover");

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
    it("a real (non-force) ticket_update(complete) by the owning session produces the shape via clearClaimOnComplete's authorized-caller branch, then report terminal-routes with no claim-lost error", async () => {
      // F1 (byte-review): the original fixture had NO claim keys and called
      // handleTicketUpdate with force=true, so clearClaimOnComplete's
      // options.authorized branch computed hadKeys=false and returned the
      // ticket byte-untouched -- the not.toHaveProperty assertions below could
      // never fail regardless of whether the strip logic works at all. Plant
      // REAL claim + claimedBySession matching the session's own epoch, and
      // drop force entirely: force also bypasses resolveCompletionGuard's
      // epoch/identity authorization, so the actual field path (the owning
      // session completes its own ticket without --force, exactly what
      // write-tests.ts's "no code changes" branch does) was never exercised.
      const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");
      writeTicket(root, {
        claimedBySession: sessionId,
        claim: { user: "me@example.com", branch: "main", since: NOW },
      });

      // Drive the REAL production strip: handleTicketUpdate -> resolveCompletionGuard
      // (gitUserEmail mocked to "me@example.com", matching the ticket's claim;
      // findActiveSessionFull finds this session's matching epoch) ->
      // clearClaimOnComplete's proven-ownership branch, exactly the code path
      // FINALIZE itself uses -- no force, no admin bypass.
      await handleTicketUpdate("T-001", { status: "complete" }, "json", root);
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
    it("the kill-text template embeds neither (ISS-784) nor (ISS-965), matched to its actual end", async () => {
      // Static check on the actual template, independent of any fixture: a
      // future refactor could reintroduce the citation without any of the
      // behavioral tests above noticing if they only assert absence on ONE path.
      //
      // F6 (byte-review fixup): match up to the statement's real closing `));`
      // instead of a fixed 400-char window -- a fixed window can run past the
      // template into unrelated later code (or, after a future edit lengthens
      // the message, cut off before its actual end), either of which makes the
      // assertion check the wrong text without failing loudly about it.
      const { readFileSync: rf } = await import("node:fs");
      const src = rf(new URL("../../src/autonomous/guide.ts", import.meta.url), "utf-8");
      const killTextMatch = src.match(/`Claim lost on \$\{ticketId\}[\s\S]*?\)\);/);
      expect(killTextMatch).not.toBeNull();
      const killTemplate = killTextMatch![0];
      expect(killTemplate).not.toContain("(ISS-784)");
      expect(killTemplate).not.toContain("(ISS-965)");
    });

    it("no user-facing (ISS-784) citation survives ANYWHERE in src, not just the kill-text template (Acceptance 4, repo-wide)", async () => {
      // F6 (byte-review fixup): Acceptance 4 says "no user-facing string in src
      // still cites (ISS-784)" -- repo-wide, not scoped to one template in one
      // file. The exact parenthesized form "(ISS-784)" was specifically the
      // retired user-facing citation format (historical references in comments
      // use the bare "ISS-784" or "T-442/ISS-784" form, never parenthesized),
      // so this check does not need to distinguish comments from strings to
      // stay within what Acceptance 4 actually requires ("comments may keep
      // historical references") -- confirmed empirically: zero occurrences of
      // the parenthesized form exist anywhere in src today.
      const { readdirSync, readFileSync: rf, statSync } = await import("node:fs");
      const { join: j, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const srcRoot = j(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = j(dir, entry);
          if (statSync(full).isDirectory()) { walk(full); continue; }
          if (!entry.endsWith(".ts")) continue;
          if (rf(full, "utf-8").includes("(ISS-784)")) offenders.push(full);
        }
      };
      walk(srcRoot);

      expect(offenders).toEqual([]);
    });
  });

  describe("F2 (byte-review fixup): drift recovery on a terminalized session lands at HANDOVER, not the SESSION_END dead end", () => {
    it("resume after a park + external HEAD drift on a terminalized session recovers to HANDOVER and stays reportable", async () => {
      // Before the fix, RECOVERY_MAPPING.HANDOVER -> SESSION_END was dead code
      // (preCompactState could never BE "HANDOVER"). Change 5 (session.ts
      // resolveCompactResumeTarget) makes it reachable for a terminalized
      // session, so a park + external drift would land it in SESSION_END: no
      // status change, no handover, no shutdown marker, no registered stage --
      // a permanent dead end, since findActiveSessionFull still counts it as
      // active. This is guide.ts's own drift-recovery branch (claimPreflightBlock
      // returns null here since COMPACT is outside RECONCILED_STATES), so it
      // needs its own discriminated override rather than relying on claim
      // reconciliation.
      const { gitHead } = await import("../../src/autonomous/git-inspector.js");
      const { prepareForCompact } = await import("../../src/autonomous/session.js");

      writeTicket(root, { status: "complete", completedDate: "2026-08-05" });
      const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");

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
      expect(compacted.preCompactState).toBe("HANDOVER");

      // External drift during the park: a different, non-descendant commit
      // (not this session's own -- gitIsAncestor stays false, this file's
      // default mock), simulating a rebase/reset/branch switch elsewhere.
      vi.mocked(gitHead).mockResolvedValueOnce({ ok: true, data: { hash: "d0d0d0d0d0d0" } });

      const resumeResult = await handleAutonomousGuide(root, { action: "resume", sessionId });
      expect(resumeResult.isError).toBeFalsy();
      const text = (resumeResult.content[0] as { text: string }).text;
      // Codex round on the fixup: landing state at HANDOVER is not enough --
      // the response must actually TELL the agent to write the handover
      // (the generic "Recovered to state: HANDOVER. Continue from here."
      // fallback left a real agent with no instruction, even though the
      // session was technically reportable). This must be asserted BEFORE the
      // manual follow-up report below, or the manual call papers over exactly
      // the gap this pins.
      expect(text).toContain("Complete -- Session Ending");
      expect(text).toContain("Write a session handover");
      expect(text).toContain("handover_written");
      expect(text).not.toContain("Continue from here");

      const after = readState(sessDir);
      expect(after.state).toBe("HANDOVER");
      expect(after.state).not.toBe("SESSION_END");
      expect((after as unknown as Record<string, unknown>).terminalDisposition).toMatchObject({
        kind: "completion-observed",
      });

      // Proves it did not land on an unregistered stage: a follow-up report
      // completes normally instead of throwing "Stage SESSION_END is not registered".
      const followUp = await handleAutonomousGuide(root, {
        action: "report",
        sessionId,
        report: { completedAction: "handover_written", handoverContent: "test handover" },
      });
      expect(followUp.isError).toBeFalsy();
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
