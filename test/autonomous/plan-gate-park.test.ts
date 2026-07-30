/**
 * ISS-904: the plan-gate park, and the cancel deadlock it escapes.
 *
 * Three things are pinned here, and they fail for different reasons:
 *
 *  1. A park at the plan gate ADVANCES a targeted queue. `skip_ticket` already
 *     existed at PLAN and PLAN_REVIEW -- the filing's claim that it is gated on
 *     a pending branch mismatch is wrong -- but it routes to HANDOVER and never
 *     touches `skippedTargets`, so it ends the session instead of moving past
 *     one unworkable item.
 *
 *  2. The park must NOT weaken the ISS-784 claim-loss guard. A park the pipeline
 *     performed clears the draft ticket, so `reconcileSessionReality` returns
 *     NOT_CHECKED; a park performed by hand leaves the draft in place and still
 *     trips the guard exactly as before. Both directions are asserted, because a
 *     fix that silenced the guard would pass the first assertion alone.
 *
 *  3. A claim-lost session can always cancel. The observed deadlock: the
 *     claim-loss guard says "cancel this session", the cancel soft gate says
 *     "continue with ticket_picked", and that report is the claim-loss guard
 *     again. Both guards were individually correct and neither yielded.
 *
 * Everything drives handleAutonomousGuide end to end. A stage-level test would
 * miss the state-machine row exactly as it did for ISS-767.
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
  // Needed by the PICK_TICKET claim path; without it a pick fails before any
  // state write and a reset assertion would silently measure nothing.
  gitUserEmail: vi.fn().mockResolvedValue({ ok: true, data: "me@example.com" }),
}));

/**
 * Two seams the ledger cannot be driven into from the outside.
 *
 * `stealClaimOnLock` reproduces the genuine TOCTOU race the park's ownership
 * check exists for: the guide preflight passes, and the claim moves before the
 * park takes the project lock. Rewriting the ticket BEFORE the call instead
 * would only exercise the preflight, which fires first and never reaches the
 * stage -- so a fixture that mutates up front proves nothing about this branch.
 */
import { gitHead } from "../../src/autonomous/git-inspector.js";

const hoisted = vi.hoisted(() => ({ failTicketWrite: false, stealClaimOnLock: null as null | (() => void) }));
vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
    withProjectLock: async (...args: Parameters<typeof actual.withProjectLock>) => {
      const steal = hoisted.stealClaimOnLock;
      if (steal) { hoisted.stealClaimOnLock = null; steal(); }
      return actual.withProjectLock(...args);
    },
    writeTicketUnlocked: async (...args: Parameters<typeof actual.writeTicketUnlocked>) => {
      if (hoisted.failTicketWrite) throw new Error("simulated ledger write failure");
      return actual.writeTicketUnlocked(...args);
    },
  };
});

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { isValidTransition } from "../../src/autonomous/state-machine.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = new Date().toISOString();
const MINE = "me@example.com";

interface TicketOverrides {
  readonly status?: string;
  readonly claimedBySession?: string | null;
  readonly claim?: { user: string; branch: string; since: string } | null;
  readonly displayId?: string;
}

function writeTicket(root: string, id: string, title: string, over: TicketOverrides = {}): void {
  const base: Record<string, unknown> = {
    id, title, description: "A test.", type: "task",
    status: over.status ?? "open", phase: "p1", order: 10,
    createdDate: "2026-07-02", completedDate: null, blockedBy: [],
  };
  if (over.displayId) base.displayId = over.displayId;
  // Keyed on PROPERTY PRESENCE, not on the value. ISS-759 gates on key presence,
  // so an explicit null is a distinct ledger state from an absent key, and a
  // `!= null` test could not express it -- it would silently drop both.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(over, k);
  if (has("claimedBySession")) base.claimedBySession = over.claimedBySession;
  if (has("claim")) base.claim = over.claim;
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify(base));
}

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

function readTicket(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", `${id}.json`), "utf-8"));
}

function readState(root: string, sessionId: string): FullSessionState {
  return JSON.parse(
    readFileSync(join(root, ".story", "sessions", sessionId, "state.json"), "utf-8"),
  ) as FullSessionState;
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

/**
 * Canonical id deliberately DIFFERENT from the display id, and `targetWork`
 * carries the display form -- the real mixed-ledger shape. An implementation
 * that recorded only one form in `skippedTargets` would leave the queue
 * re-offering the parked item forever, and a fixture where the two forms are
 * equal cannot catch that.
 */
const CANON = "t-abc123def4567890";
const DISPLAY = "T-001";

/** A session at PLAN_REVIEW holding a provable claim on the parkable ticket. */
function seedHoldingSession(root: string, opts: { targeted?: boolean } = {}) {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const claim = { user: MINE, branch: "main", since: NOW };

  writeTicket(root, CANON, "Defective filing", {
    status: "inprogress", claimedBySession: session.sessionId, claim, displayId: DISPLAY,
  });
  writeTicket(root, "T-002", "The next target");

  writeSessionSync(sessDir, {
    ...session,
    state: "PLAN_REVIEW",
    previousState: "PLAN",
    ticket: { id: CANON, displayId: DISPLAY, title: "Defective filing", risk: "low", claimed: true },
    claimEpoch: {
      ticketId: CANON, sessionId: session.sessionId,
      user: claim.user, branch: claim.branch, since: claim.since,
      establishedAt: NOW,
    },
    // The DISPLAY form, which is what an operator types.
    ...(opts.targeted ? { targetWork: [DISPLAY, "T-002"] } : {}),
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);

  return { session, sessDir };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss904-"));
  setupProject(root);
});

/**
 * vi.restoreAllMocks() below strips the implementations the module factory
 * set, so every test after the first sees gitHead resolve undefined.
 * PICK_TICKET now reads it to establish the item's finalization baseline
 * (ISS-922) and fails closed when HEAD cannot be resolved, so the
 * implementation is re-armed per test rather than left to the factory.
 */
beforeEach(() => {
  vi.mocked(gitHead).mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } } as never);
});

afterEach(() => {
  hoisted.failTicketWrite = false;
  hoisted.stealClaimOnLock = null;
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("plan-gate park (ISS-904)", () => {
  it("the state machine permits PLAN_REVIEW -> PICK_TICKET", () => {
    // Load-bearing: processAdvance calls assertTransition BEFORE persisting, so
    // without this row the park throws and the session stays wedged in
    // PLAN_REVIEW -- the ISS-767 failure shape, one stage over.
    expect(isValidTransition("PLAN_REVIEW", "PICK_TICKET")).toBe(true);
  });

  it("parks the item, advances a targeted queue, and records the reason on the ticket", async () => {
    const { session, sessDir } = seedHoldingSession(root, { targeted: true });
    const reason = "Acceptance criterion 2 requires a committed handover to contain its own commit SHA.";

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: reason },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain("Invalid state transition");

    const after = readState(root, session.sessionId);
    expect(after.state).toBe("PICK_TICKET");
    expect(after.ticket).toBeUndefined();
    // Cleared so reconcileSessionReality returns NOT_CHECKED rather than
    // reconciling an epoch against a ticket this session deliberately let go.
    expect((after as Record<string, unknown>).claimEpoch).toBeUndefined();

    // The queue can now advance: getRemainingTargets filters targetWork by
    // string equality, so the id form present in targetWork must be recorded.
    expect(after.skippedTargets).toContain(DISPLAY);
    expect(after.skippedTargets).toContain(CANON);
    expect(after.skippedTargets).not.toContain("T-002");

    // The claim was released, so another session can take the item up.
    const ticket = readTicket(root, CANON);
    expect(ticket.status).toBe("open");
    expect(ticket.claimedBySession).toBeUndefined();
    expect(ticket.claim).toBeUndefined();

    // Acceptance: "the park reason is readable on the item afterward".
    const park = ticket.park as Record<string, unknown> | undefined;
    expect(park).toBeDefined();
    expect(park!.reason).toBe(reason);
    expect(park!.stage).toBe("PLAN_REVIEW");
    expect(park!.sessionId).toBe(session.sessionId);
    expect(park!.parkedAt).toEqual(expect.any(String));

    expect(sessDir).toContain(session.sessionId);
  });

  it("refuses a park with no reason and changes nothing", async () => {
    const { session } = seedHoldingSession(root, { targeted: true });

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item" },
    });

    expect(textOf(result)).toContain("requires a reason");

    // An unexplained park is indistinguishable from the hand-release that
    // caused the deadlock, so nothing may move until a reason is supplied.
    const after = readState(root, session.sessionId);
    expect(after.state).toBe("PLAN_REVIEW");
    expect(after.skippedTargets ?? []).not.toContain(DISPLAY);
    expect(after.skippedTargets ?? []).not.toContain(CANON);
    expect(readTicket(root, CANON).status).toBe("inprogress");
  });

  it("a pipeline park does NOT then trip the claim-loss guard", async () => {
    const { session } = seedHoldingSession(root, { targeted: true });

    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "Filing contradicts itself." },
    });

    // The very next call is the one that used to fail: the ticket left
    // `inprogress` and the claim keys are gone, which is exactly the ledger
    // shape the guard reads as "released".
    const next = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "ticket_picked", ticketId: "T-002" },
    });

    expect(textOf(next)).not.toContain("Claim lost");
  });

  it("refuses park_item from a stage that does not handle it", async () => {
    const { session, sessDir } = seedHoldingSession(root, { targeted: true });
    // IMPLEMENT treats any action other than `no_implementation_needed` as
    // "implementation done", so an unguarded park here would silently advance
    // the pipeline rather than park anything.
    const state = readState(root, session.sessionId);
    writeSessionSync(sessDir, { ...state, state: "IMPLEMENT", previousState: "PLAN_REVIEW" } as FullSessionState);

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "not workable" },
    });

    expect(textOf(result)).toContain("only valid at");
    expect(readState(root, session.sessionId).state).toBe("IMPLEMENT");
    expect(readTicket(root, CANON).park).toBeUndefined();
  });

  it("writes NOTHING when the claim moved between the preflight and the project lock", async () => {
    const { session } = seedHoldingSession(root, { targeted: true });

    // The preflight passed on the state seeded above; the claim moves before the
    // park takes the lock. Stamping a park record onto a ticket another session
    // is now working is the ISS-784 violation this path exists to avoid.
    const foreign = { user: "rival@example.com", branch: "main", since: NOW };
    hoisted.stealClaimOnLock = () => {
      writeTicket(root, CANON, "Defective filing", {
        status: "inprogress", claimedBySession: "someone-else", claim: foreign, displayId: DISPLAY,
      });
    };

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "Filing contradicts itself." },
    });

    // The foreign ticket is byte-for-byte untouched.
    const ticket = readTicket(root, CANON);
    expect(ticket.park).toBeUndefined();
    expect(ticket.status).toBe("inprogress");
    expect(ticket.claimedBySession).toBe("someone-else");
    expect(ticket.claim).toEqual(foreign);

    // The session drops the item and re-picks, which is what plan.ts:188 already
    // does on claim failure, and it is TOLD the reason was not recorded rather
    // than being left to assume the park landed.
    expect(textOf(result)).toContain("NOT recorded");
    expect(readState(root, session.sessionId).state).toBe("PICK_TICKET");
  });

  it("fails closed when the ledger write throws, keeping the claim reconcilable", async () => {
    const { session } = seedHoldingSession(root, { targeted: true });
    hoisted.failTicketWrite = true;

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "Filing contradicts itself." },
    });

    expect(textOf(result)).toContain("was not written");

    // Everything preserved. Clearing the draft here would abandon a claim this
    // session still owns and that nothing could later release, and would silence
    // the ISS-784 guard on a park that never happened.
    const after = readState(root, session.sessionId);
    expect(after.state).toBe("PLAN_REVIEW");
    expect(after.ticket?.id).toBe(CANON);
    expect((after as Record<string, unknown>).claimEpoch).toBeDefined();
    expect(after.skippedTargets ?? []).not.toContain(DISPLAY);

    const ticket = readTicket(root, CANON);
    expect(ticket.status).toBe("inprogress");
    expect(ticket.claimedBySession).toBe(session.sessionId);
  });

  it("a park performed OUTSIDE the pipeline still trips the claim-loss guard", async () => {
    const { session } = seedHoldingSession(root, { targeted: true });

    // Same ledger end-state as the park above, reached by hand: the session
    // still holds its draft ticket and epoch, so the guard must still fire.
    // This is the ISS-784 half of the acceptance and it must not regress.
    writeTicket(root, CANON, "Defective filing", { status: "open", displayId: DISPLAY });

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "plan_review_round", verdict: "approve" },
    });

    expect(textOf(result)).toContain("Claim lost");
  });
});

describe("cancel deadlock (ISS-904)", () => {
  it("a claim-lost session can cancel instead of cycling between the two guards", async () => {
    const { session } = seedHoldingSession(root);
    // The claim goes to another user, exactly as a merge would hand it over.
    writeTicket(root, CANON, "Defective filing", { status: "open", displayId: DISPLAY });

    // Guard 1 sends the session to cancel.
    const report = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "plan_review_round", verdict: "approve" },
    });
    expect(textOf(report)).toContain("Claim lost");
    expect(textOf(report)).toContain('"action": "cancel"');

    // Guard 2 used to send it straight back to report. It must not.
    const cancel = await handleAutonomousGuide(root, {
      action: "cancel",
      sessionId: session.sessionId,
    });
    expect(textOf(cancel)).not.toContain("Cancel Refused");
    expect(textOf(cancel)).not.toContain("Cancel Rejected");

    const after = readState(root, session.sessionId);
    expect(after.state).toBe("SESSION_END");
  });

  it("cancelling a claim-lost session neither replays its pending mutation nor releases the foreign claim", async () => {
    const { session, sessDir } = seedHoldingSession(root);

    // The claim went to another user, as a merge would hand it over. The session
    // stamp still matches, which is exactly the split state whose stamp-only
    // release would strip the WINNER's claim.
    const foreign = { user: "rival@example.com", branch: "main", since: NOW };
    writeTicket(root, CANON, "Defective filing", {
      status: "inprogress", claimedBySession: session.sessionId, claim: foreign, displayId: DISPLAY,
    });

    // A mutation prepared while the session still believed it owned the ticket.
    const state = readState(root, session.sessionId);
    writeSessionSync(sessDir, {
      ...state,
      pendingProjectMutation: {
        type: "ticket_update", target: CANON, value: "complete",
        expectedCurrent: "inprogress", transitionId: "txn-1",
      },
    } as unknown as FullSessionState);

    const cancel = await handleAutonomousGuide(root, {
      action: "cancel",
      sessionId: session.sessionId,
    });
    expect(textOf(cancel)).not.toContain("Cancel Refused");

    const ticket = readTicket(root, CANON);
    // The pending completion was NOT replayed onto a ticket this session no
    // longer owns...
    expect(ticket.status).toBe("inprogress");
    // ...and the winner's claim was NOT stripped by the stamp-only release.
    expect(ticket.claim).toEqual(foreign);
    expect(ticket.claimedBySession).toBe(session.sessionId);

    const after = readState(root, session.sessionId);
    expect(after.state).toBe("SESSION_END");
    expect(after.pendingProjectMutation ?? null).toBeNull();
  });

  it("a healthy mid-pipeline session is still refused, with the real condition named", async () => {
    // No epoch, so the claim preflight is NOT_CHECKED and the bypass must not
    // fire. The soft gate stays exactly as strict as it was.
    const session = createSession(root, "coding", "test-workspace");
    writeTicket(root, "T-001", "Healthy work", { status: "inprogress" });
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "PLAN_REVIEW",
      previousState: "PLAN",
      ticket: { id: "T-001", displayId: "T-001", title: "Healthy work", risk: "low", claimed: true },
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    const cancel = await handleAutonomousGuide(root, {
      action: "cancel",
      sessionId: session.sessionId,
    });
    const text = textOf(cancel);

    expect(text).toContain("Cancel Refused");
    // N-097 operator 3: the refusal must name the condition blocking THIS
    // session, not assert context size regardless of state.
    expect(text).toContain("PLAN_REVIEW");
    expect(text).toContain("Condition that refused it");
    // The designed alternative, not the admin CLI that cost an operator a queue.
    expect(text).toContain("park_item");
    expect(text).not.toContain("storybloq session stop");
    // The old text printed a ticket_picked continuation that is wrong anywhere
    // except PICK_TICKET.
    expect(text).not.toContain('"completedAction": "ticket_picked"');

    expect(readState(root, session.sessionId).state).toBe("PLAN_REVIEW");
  });
});

describe("planGateNonApprovals lifecycle (ISS-904)", () => {
  async function reviewRound(sessionId: string, verdict: string) {
    return handleAutonomousGuide(root, {
      action: "report",
      sessionId,
      report: { completedAction: "plan_review_round", verdict, reviewer: "agent" },
    });
  }

  it("accumulates across rounds, surfaces the park hint only at the threshold, and resets on approval", async () => {
    const { session } = seedHoldingSession(root);

    const r1 = await reviewRound(session.sessionId, "revise");
    expect(readState(root, session.sessionId).planGateNonApprovals).toBe(1);
    expect(textOf(r1)).not.toContain("park_item");

    const r2 = await reviewRound(session.sessionId, "revise");
    expect(readState(root, session.sessionId).planGateNonApprovals).toBe(2);
    expect(textOf(r2)).not.toContain("park_item");

    // Third round is where repeated rejection becomes diagnostic of the FILING.
    const r3 = await reviewRound(session.sessionId, "revise");
    expect(readState(root, session.sessionId).planGateNonApprovals).toBe(3);
    expect(textOf(r3)).toContain("park_item");
    expect(textOf(r3)).toContain("3 review rounds without approval");

    // Approval clears it, so the next ticket does not inherit this one's history.
    await reviewRound(session.sessionId, "approve");
    expect(readState(root, session.sessionId).planGateNonApprovals).toBe(0);
  });

  it("survives a session reload and is reset by a park", async () => {
    const { session } = seedHoldingSession(root);

    await reviewRound(session.sessionId, "revise");
    await reviewRound(session.sessionId, "revise");
    // Read back from disk: the counter is persisted state, not in-memory only,
    // so it survives compaction and resume.
    expect(readState(root, session.sessionId).planGateNonApprovals).toBe(2);

    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "Acceptance criterion 2 contradicts constraint C7." },
    });

    expect(readState(root, session.sessionId).planGateNonApprovals).toBe(0);
  });
});

describe("park ownership without an epoch (ISS-904 round 2)", () => {
  it("refuses to release a split claim when the session carries no epoch", async () => {
    const session = createSession(root, "coding", "test-workspace");
    // The reachable split state: our session stamp, the RIVAL's claim block.
    // releaseSessionClaim's epochless fallback trusts the stamp alone and would
    // delete the rival's winning claim; with no epoch there is no way to tell
    // this from genuine ownership, so nothing may be written.
    const rival = { user: "rival@example.com", branch: "main", since: NOW };
    writeTicket(root, CANON, "Defective filing", {
      status: "inprogress", claimedBySession: session.sessionId, claim: rival, displayId: DISPLAY,
    });
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "PLAN_REVIEW",
      previousState: "PLAN",
      ticket: { id: CANON, displayId: DISPLAY, title: "Defective filing", risk: "low", claimed: true },
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "Filing contradicts itself." },
    });

    const ticket = readTicket(root, CANON);
    expect(ticket.park).toBeUndefined();
    expect(ticket.status).toBe("inprogress");
    expect(ticket.claim).toEqual(rival);
    expect(textOf(result)).toContain("NOT recorded");
  });

  it("parks a freshly picked ticket at PLAN, before any epoch exists", async () => {
    const session = createSession(root, "coding", "test-workspace");
    // PICK_TICKET stages the claim in SESSION state only; the ledger claim and
    // the epoch both arrive at PLAN's `plan_written`. So the ticket here is
    // open and unclaimed -- nothing to prove, nothing foreign to destroy -- and
    // the park must still persist its reason.
    writeTicket(root, CANON, "Defective filing", { status: "open", displayId: DISPLAY });
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "PLAN",
      previousState: "PICK_TICKET",
      ticket: { id: CANON, displayId: DISPLAY, title: "Defective filing", risk: "low", claimed: true },
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "Cited file:line does not exist." },
    });

    const ticket = readTicket(root, CANON);
    const park = ticket.park as Record<string, unknown> | undefined;
    expect(park).toBeDefined();
    expect(park!.reason).toBe("Cited file:line does not exist.");
    expect(park!.stage).toBe("PLAN");
    // Left open, because it was never claimed in the ledger to begin with.
    expect(ticket.status).toBe("open");
    expect(readState(root, session.sessionId).state).toBe("PICK_TICKET");
  });
});

describe("cancel ownership outside the reconciled states (ISS-904 round 2)", () => {
  it("performs no ticket write when cancelling from HANDOVER with a stale epoch", async () => {
    const session = createSession(root, "coding", "test-workspace");
    // HANDOVER is NOT in RECONCILED_STATES, so a check routed through
    // reconcileSessionReality would return NOT_CHECKED and let cancel write.
    const rival = { user: "rival@example.com", branch: "main", since: NOW };
    writeTicket(root, CANON, "Defective filing", {
      status: "inprogress", claimedBySession: session.sessionId, claim: rival, displayId: DISPLAY,
    });
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "HANDOVER",
      previousState: "PLAN_REVIEW",
      ticket: { id: CANON, displayId: DISPLAY, title: "Defective filing", risk: "low", claimed: true },
      claimEpoch: {
        ticketId: CANON, sessionId: session.sessionId,
        user: MINE, branch: "main", since: NOW, establishedAt: NOW,
      },
      pendingProjectMutation: {
        type: "ticket_update", target: CANON, value: "complete",
        expectedCurrent: "inprogress", transitionId: "txn-1",
      },
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    await handleAutonomousGuide(root, { action: "cancel", sessionId: session.sessionId });

    const ticket = readTicket(root, CANON);
    expect(ticket.status).toBe("inprogress");
    expect(ticket.claim).toEqual(rival);
    expect(ticket.claimedBySession).toBe(session.sessionId);
    expect(readState(root, session.sessionId).state).toBe("SESSION_END");
  });

  it("does not strip a claim stolen between the pre-cancel check and the release lock", async () => {
    const session = createSession(root, "coding", "test-workspace");
    const mine = { user: MINE, branch: "main", since: NOW };
    writeTicket(root, CANON, "Defective filing", {
      status: "inprogress", claimedBySession: session.sessionId, claim: mine, displayId: DISPLAY,
    });
    // HANDOVER so the soft gate does not refuse before the release is reached;
    // the claim is genuinely HELD at the pre-cancel check, which is the point.
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "HANDOVER",
      previousState: "PLAN_REVIEW",
      ticket: { id: CANON, displayId: DISPLAY, title: "Defective filing", risk: "low", claimed: true },
      claimEpoch: {
        ticketId: CANON, sessionId: session.sessionId,
        user: MINE, branch: "main", since: NOW, establishedAt: NOW,
      },
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    // Stolen after that check passes, before the release takes the lock. Only an
    // epoch comparison INSIDE the lock catches this.
    const rival = { user: "rival@example.com", branch: "main", since: NOW };
    hoisted.stealClaimOnLock = () => {
      writeTicket(root, CANON, "Defective filing", {
        status: "inprogress", claimedBySession: session.sessionId, claim: rival, displayId: DISPLAY,
      });
    };

    await handleAutonomousGuide(root, { action: "cancel", sessionId: session.sessionId });

    const ticket = readTicket(root, CANON);
    expect(ticket.claim).toEqual(rival);
    expect(ticket.status).toBe("inprogress");
    expect(readState(root, session.sessionId).state).toBe("SESSION_END");
  });
});

describe("planGateNonApprovals fresh-pick reset (ISS-904 round 2)", () => {
  it("a fresh pick clears a counter left over from the previous ticket", async () => {
    const session = createSession(root, "coding", "test-workspace");
    writeTicket(root, "T-002", "The next target");
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "PICK_TICKET",
      previousState: "PLAN_REVIEW",
      // Left over from an item that was just parked or abandoned.
      planGateNonApprovals: 4,
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "ticket_picked", ticketId: "T-002" },
    });

    // Otherwise the park hint would fire on round one of an unrelated ticket.
    expect(readState(root, session.sessionId).planGateNonApprovals).toBe(0);
  });
});

describe("round-3 ownership regressions (ISS-904)", () => {
  it("park does not reopen a ticket that completed after the preflight", async () => {
    const { session } = seedHoldingSession(root);
    const mine = { user: MINE, branch: "main", since: NOW };
    // Ownership fields still match, so releaseClaimIfOwned alone would succeed
    // and rewrite status to "open" -- reopening a completed ticket and stamping
    // park metadata onto it. Ownership proof is not lifecycle proof.
    hoisted.stealClaimOnLock = () => {
      const t = readTicket(root, CANON);
      writeFileSync(
        join(root, ".story", "tickets", `${CANON}.json`),
        JSON.stringify({ ...t, status: "complete", completedDate: "2026-07-29" }),
      );
    };

    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "park_item", notes: "Filing contradicts itself." },
    });

    const ticket = readTicket(root, CANON);
    expect(ticket.status).toBe("complete");
    expect(ticket.park).toBeUndefined();
    expect(ticket.claim).toEqual(mine);
  });

  it("a malformed epoch is not mistaken for a legacy epochless session on cancel", async () => {
    const session = createSession(root, "coding", "test-workspace");
    const rival = { user: "rival@example.com", branch: "main", since: NOW };
    // Split claim: our stamp, the rival's claim block. The legacy stamp-only
    // release would strip the rival. A PRESENT but corrupt epoch must never
    // route there -- absent means "never had proof", malformed means "had a
    // claim and the proof is damaged".
    writeTicket(root, CANON, "Defective filing", {
      status: "inprogress", claimedBySession: session.sessionId, claim: rival, displayId: DISPLAY,
    });
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "HANDOVER",
      previousState: "PLAN_REVIEW",
      ticket: { id: CANON, displayId: DISPLAY, title: "Defective filing", risk: "low", claimed: true },
      claimEpoch: { ticketId: CANON, sessionId: session.sessionId },
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    await handleAutonomousGuide(root, { action: "cancel", sessionId: session.sessionId });

    const ticket = readTicket(root, CANON);
    expect(ticket.claim).toEqual(rival);
    expect(ticket.status).toBe("inprogress");
    expect(readState(root, session.sessionId).state).toBe("SESSION_END");
  });

  it("a healthy session at COMPLETE is still refused, despite carrying a finished ticket's epoch", async () => {
    const session = createSession(root, "coding", "test-workspace");
    // FINALIZE clears the draft ticket but leaves claimEpoch behind, and the
    // ledger ticket is complete with its claim keys stripped. Reconciling that
    // reads as "released" -- so an unguarded check would call this claim loss,
    // stand the soft gate down, and let a healthy session discard its remaining
    // targets.
    writeTicket(root, CANON, "Finished work", { status: "complete", displayId: DISPLAY });
    writeTicket(root, "T-002", "Still to do");
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "COMPLETE",
      previousState: "FINALIZE",
      ticket: undefined,
      claimEpoch: {
        ticketId: CANON, sessionId: session.sessionId,
        user: MINE, branch: "main", since: NOW, establishedAt: NOW,
      },
      targetWork: [DISPLAY, "T-002"],
      completedTickets: [{ id: CANON, displayId: DISPLAY }],
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    const cancel = await handleAutonomousGuide(root, { action: "cancel", sessionId: session.sessionId });

    expect(textOf(cancel)).toContain("Cancel Refused");
    expect(readState(root, session.sessionId).state).toBe("COMPLETE");
  });
});

describe("FINALIZE crash window (ISS-904 round 4)", () => {
  it("is refused while the draft still matches a ticket FINALIZE has already completed", async () => {
    const session = createSession(root, "coding", "test-workspace");
    // The legitimate crash window: FINALIZE completed the ledger ticket and
    // stripped its claim, but has not yet cleared the session draft. The draft
    // still matches the epoch, so the off-ticket guard does not fire, and
    // reconciling reads "released" -- which is the session's OWN work, not a
    // loss. This is exactly why claim-preflight.ts excludes FINALIZE from
    // RECONCILED_STATES, and why the gate decision must respect that allowlist.
    writeTicket(root, CANON, "Finished work", {
      status: "complete", displayId: DISPLAY,
    });
    writeTicket(root, "T-002", "Still to do");
    writeSessionSync(join(root, ".story", "sessions", session.sessionId), {
      ...session,
      state: "FINALIZE",
      previousState: "CODE_REVIEW",
      ticket: { id: CANON, displayId: DISPLAY, title: "Finished work", risk: "low", claimed: true },
      claimEpoch: {
        ticketId: CANON, sessionId: session.sessionId,
        user: MINE, branch: "main", since: NOW, establishedAt: NOW,
      },
      targetWork: [DISPLAY, "T-002"],
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    const cancel = await handleAutonomousGuide(root, { action: "cancel", sessionId: session.sessionId });

    expect(textOf(cancel)).toContain("Cancel Refused");
    expect(readState(root, session.sessionId).state).toBe("FINALIZE");
    // And the completed ticket is untouched either way.
    expect(readTicket(root, CANON).status).toBe("complete");
  });
});
