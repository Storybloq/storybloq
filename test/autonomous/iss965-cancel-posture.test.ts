/**
 * ISS-965 T8 (Acceptance 8, D4-reshaped): cancelling a session AFTER it has
 * been terminalized by claimPreflightBlock (state HANDOVER, ticket already
 * `complete`) must not attempt any ledger write -- the ticket bytes must be
 * identical before and after cancel.
 *
 * `cancelClaimPosture` (guide.ts) computes posture from
 * `reconcileClaim(...).status === "held" ? "held" : "lost"` -- it already
 * treats "completed-consistent" as "lost" (D4's correct, non-mutated
 * behavior) because that ternary only special-cases the literal "held"
 * string. The audit surface this test pins is `cancelledEventData(...).ticketId`
 * in the "cancelled" event, via `auditOf` (cancellation-transition.ts):
 *
 *   - correct ("lost" posture):  disposition = {kind:"not-authorized"}
 *                                -> auditOf -> {ticketId: null, ...}
 *   - REVERSE-FIX MUTANT: map "completed-consistent" into cancelClaimPosture's
 *     "held" branch (`posture === "held" || status === "completed-consistent"
 *     ? "held" : "lost"`). mayWriteTicket becomes true, so the cancel path
 *     enters the release-attempt branch under the project lock; it finds
 *     ticket.status !== "inprogress" (ours is "complete") and lands on
 *     disposition = {kind:"unchanged", ticketId, reason:"not-inprogress"}
 *     -> auditOf -> {ticketId: "T-001", ...}.
 *
 * Non-equivalent by that ticketId field: null under correct behavior, the
 * real id under the mutant, even though `writeTicketUnlocked` never runs
 * either way (the "not-inprogress" guard blocks the actual byte write). This
 * is the audit-surface observable D4 asked for, since ticket BYTES cannot
 * discriminate the two arms.
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
import type { FullSessionState } from "../../src/autonomous/session-types.js";
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

function writeTicket(root: string, extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-07-02",
    completedDate: null, blockedBy: [],
    ...extra,
  }));
}

function readTicketRaw(root: string): string {
  return readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8");
}

function plantSession(
  root: string,
  state: string,
  extra: Partial<FullSessionState> = {},
): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const epoch = {
    ticketId: "T-001", sessionId: session.sessionId, user: "me@example.com",
    branch: "main", since: NOW, establishedAt: NOW,
  };
  writeSessionSync(sessDir, {
    ...session,
    state,
    previousState: "PLAN_REVIEW",
    mode: "guided",
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

function cancelledEventData(sessDir: string): Record<string, unknown> | null {
  let raw = "";
  try { raw = readFileSync(join(sessDir, "events.log"), "utf-8"); } catch { return null; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt.type === "cancelled") return (evt.data as Record<string, unknown>) ?? null;
    } catch { /* skip */ }
  }
  return null;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss965-cancel-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

describe("ISS-965 T8: cancel posture after terminalization", () => {
  it("cancel on a terminalized (HANDOVER) session makes no ticket write; ticket bytes are byte-identical", async () => {
    writeTicket(root, { status: "complete", completedDate: "2026-08-05" });
    const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");

    // Terminalize via report first (mirrors T2/T3/T11's setup).
    const reportResult = await handleAutonomousGuide(root, {
      action: "report",
      sessionId,
      report: { completedAction: "tests_written" },
    });
    expect(reportResult.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("HANDOVER");

    const before = readTicketRaw(root);

    const cancelResult = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(cancelResult.isError).toBeFalsy();

    const after = readTicketRaw(root);
    expect(after).toBe(before);

    // The audit surface D4 asked for: ticketId is null (not-authorized), never
    // the real ticket id, because posture correctly reads as "lost" (not "held").
    const data = cancelledEventData(sessDir);
    expect(data?.ticketId).toBeNull();
    expect(data?.ticketReleased).toBe(false);
    expect(data?.ticketConflict).toBe(false);
  });

  it("no pending mutation is replayed on cancel after terminalization (already discarded at terminalize time)", async () => {
    // F6 (byte-review fixup): added the audit-surface assertion below. Without
    // it, this test survived the file's own named reverse-fix mutant (map
    // completed-consistent into cancelClaimPosture's held branch) -- the
    // "not-inprogress" guard blocks the actual ticket byte-write under EITHER
    // posture, so a ticket-bytes-only check duplicated T7's mutation-discard
    // pin without discriminating anything of its own. The ticketId field in
    // the cancelled event is the same non-ticket-bytes observable T8's first
    // test uses, applied here with a pending mutation additionally in play.
    writeTicket(root, { status: "complete", completedDate: "2026-08-05" });
    const { sessionId, sessDir } = plantSession(root, "WRITE_TESTS");
    // Simulate a mutation that was pending when the ticket finished elsewhere.
    const before = readState(sessDir);
    writeSessionSync(sessDir, {
      ...before,
      pendingProjectMutation: {
        type: "ticket_update", target: "T-001", value: "complete",
        expectedCurrent: "inprogress", transitionId: "txn-1",
      },
    } as FullSessionState);

    const reportResult = await handleAutonomousGuide(root, {
      action: "report",
      sessionId,
      report: { completedAction: "tests_written" },
    });
    expect(reportResult.isError).toBeFalsy();
    expect(readState(sessDir).pendingProjectMutation).toBeNull();

    const beforeTicket = readTicketRaw(root);
    const cancelResult = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(cancelResult.isError).toBeFalsy();
    expect(readTicketRaw(root)).toBe(beforeTicket);

    const data = cancelledEventData(sessDir);
    expect(data?.ticketId).toBeNull();
    expect(data?.ticketReleased).toBe(false);
    expect(data?.ticketConflict).toBe(false);
  });
});

describe("F3 (byte-review fixup): T-178 soft gate and completed-consistent, PRE-terminalization", () => {
  // Distinct from T8 above: T8's sessions are `mode: "guided"`, which bypasses
  // the T-178 soft gate entirely (isAutoMode is false), so those tests never
  // exercised the gate itself. These use `mode: "auto"` and call cancel
  // WITHOUT a prior report/terminalize, driving handleCancel's own gate
  // computation directly, on a session sitting mid-pipeline whose ticket has
  // already reached the completed-consistent shape (e.g. finished by a
  // concurrent path, or the guide has not yet been called since).
  it("cancel is ALLOWED (soft gate stands down) on a completed-consistent shape, with no ticket write", async () => {
    writeTicket(root, { status: "complete", completedDate: "2026-08-05" });
    const { sessionId } = plantSession(root, "WRITE_TESTS", { mode: "auto" });

    const before = readTicketRaw(root);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    // Before the fix: isClaimLost is false for completed-consistent (by
    // design), so the T-178 gate read "nothing unusual" and refused with
    // "no claim-loss condition was detected ... Continue the pipeline" --
    // on a ticket that is already complete. That refusal text must NOT
    // appear now.
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("no claim-loss condition was detected");

    // Standing the gate down grants no additional WRITE permission --
    // cancelClaimPosture is untouched (D4/Ruling-3) and still reads this
    // shape as "lost", so mayWriteTicket stays false.
    expect(readTicketRaw(root)).toBe(before);
  });

  it("genuine claim loss (foreign takeover) still stands the gate down, unchanged by this fix", async () => {
    const OTHER = "ffffffff-0000-0000-0000-000000000009";
    writeTicket(root, {
      claimedBySession: OTHER,
      claim: { user: "them@example.com", branch: "main", since: NOW },
    });
    const { sessionId } = plantSession(root, "WRITE_TESTS", { mode: "auto" });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("no claim-loss condition was detected");
  });

  it("negative control: a NORMAL healthy auto-mode session (claim held, not complete) is still refused by the soft gate", async () => {
    // Proves F3's new `!consistentCompletion` conjunct did not over-widen the
    // standdown to ordinary in-progress work -- only completed-consistent and
    // genuine loss stand the gate down. Claim keys must actually MATCH the
    // session's own epoch (reconciling as "held"): a claim-free inprogress
    // ticket reconciles as "released" (the ISS-784 merge-loser shape), which
    // IS a claim loss and would stand the gate down for an unrelated reason,
    // making this fixture no longer a "no loss" control.
    const { sessionId } = plantSession(root, "WRITE_TESTS", { mode: "auto" });
    writeTicket(root, {
      claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
    });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("no claim-loss condition was detected");
  });
});
