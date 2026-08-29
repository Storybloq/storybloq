/**
 * The round ceiling, driven through `handleAutonomousGuide` end to end (T-470).
 *
 * The stage-level suite (`code-review-ceiling.test.ts`) pins the DECISION: when
 * it fires, what it files, what it records. It cannot pin the two things that
 * only the real path exercises, and both have bitten this codebase before:
 *
 *  1. `processAdvance` calls `assertTransition` BEFORE persisting, so a park
 *     routed to a target the CODE_REVIEW row does not list throws AFTER the
 *     ticket ledger has been mutated. That is the ISS-767 shape, and a
 *     stage-level test that inspects the returned `goto` never reaches it.
 *  2. The LEDGER effects -- reason recorded on the item, claim released, status
 *     back to `open` -- happen across the park and the handover that follows,
 *     through `withProjectLock` and the real writers.
 *
 * So this seeds a session at CODE_REVIEW holding a provable claim, with the
 * ticket-keyed counter one round below the ceiling, and reports one more round.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  // DIRTY, and it has to be. The ceiling ends the session rather than moving on
  // precisely BECAUSE the parked item's work is uncommitted, and the handover
  // says so; a fixture reporting a clean tree would let that assertion pass
  // while contradicting the premise it exists to check.
  gitStatus: vi.fn().mockResolvedValue({
    ok: true,
    data: { clean: false, trackedDirty: ["src/changed.ts"], untrackedPaths: [] },
  }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
  gitUserEmail: vi.fn().mockResolvedValue({ ok: true, data: "me@example.com" }),
}));

/**
 * The genuine TOCTOU the park's ownership check exists for: the guide preflight
 * passes, and the claim moves before the park takes the project lock. Rewriting
 * the ticket BEFORE the call would only exercise the preflight, which fires
 * first and never reaches the stage.
 */
const hoisted = vi.hoisted(() => ({
  stealClaimOnLock: null as null | (() => void),
  /**
   * THE REAL CRASH BOUNDARY, injected rather than reconstructed.
   *
   * `drainDeferrals` creates the issues inside a per-entry try, then writes
   * `filedDeferrals` OUTSIDE it. Those are two different files and the pair is
   * not atomic, so a stop in that window leaves issues in the ledger with
   * nothing in session state recording them -- which is the window the dedupe
   * key exists to close. Throwing from that one write reproduces it exactly;
   * rewinding state.json afterwards would only produce a hybrid that no run
   * ever wrote.
   */
  failStateWriteIf: null as null | ((next: Record<string, unknown>) => boolean),
  /**
   * The OTHER crash boundary: armed by one write, fired on the next.
   *
   * The escalation decision is durable, and the ordinary deferral call that
   * would have queued this round's `deferred` findings has not run yet. A
   * resume enters `escalateCeiling` at the top of `report` and parks without
   * processing the report at all, so anything not already queued by then is
   * gone for good.
   */
  armThenFailNextWriteIf: null as null | ((next: Record<string, unknown>) => boolean),
  armed: false,
}));
vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  return {
    ...actual,
    writeSessionSync: (dir: string, next: Record<string, unknown>) => {
      const fail = hoisted.failStateWriteIf;
      if (fail && fail(next)) {
        hoisted.failStateWriteIf = null;
        throw new Error("simulated crash before the state write landed");
      }
      const arm = hoisted.armThenFailNextWriteIf;
      if (arm) {
        if (hoisted.armed) {
          hoisted.armThenFailNextWriteIf = null;
          hoisted.armed = false;
          throw new Error("simulated crash on the write after the armed one");
        }
        if (arm(next)) hoisted.armed = true;
      }
      return (actual.writeSessionSync as (d: string, n: unknown) => unknown)(dir, next);
    },
  };
});
vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
    withProjectLock: async (...args: Parameters<typeof actual.withProjectLock>) => {
      const steal = hoisted.stealClaimOnLock;
      if (steal) { hoisted.stealClaimOnLock = null; steal(); }
      return actual.withProjectLock(...args);
    },
  };
});

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { gitHead } from "../../src/autonomous/git-inspector.js";
import { CODE_REVIEW_HARD_CEILING_GRACE } from "../../src/autonomous/stages/code-review-ceiling.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = new Date().toISOString();
const MINE = "me@example.com";
const CANON = "t-abc123def4567890";
const DISPLAY = "T-001";
const CAP = 4;
const CEILING = CAP + CODE_REVIEW_HARD_CEILING_GRACE;

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    // The cap the ceiling is derived from, set through the real config rather
    // than a hand-built recipe object, so the resolution path is exercised too.
    recipeOverrides: { stages: { CODE_REVIEW: { maxReviewRounds: CAP } } },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-21",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  // The real file behind the dirty status above, so "the work is still in the
  // tree" is a fact about the fixture and not only about the mock.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "changed.ts"), "export const halfDone = true;\n");
}

function readTicket(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", `${id}.json`), "utf-8"));
}

function readState(root: string, sessionId: string): FullSessionState {
  return JSON.parse(
    readFileSync(join(root, ".story", "sessions", sessionId, "state.json"), "utf-8"),
  ) as FullSessionState;
}

function issues(root: string): Record<string, unknown>[] {
  return readdirSync(join(root, ".story", "issues"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(root, ".story", "issues", f), "utf-8")));
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

/** A session at CODE_REVIEW, holding a provable claim, one round below the ceiling. */
function seedSession(root: string, completedRounds: number) {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const claim = { user: MINE, branch: "main", since: NOW };

  writeFileSync(join(root, ".story", "tickets", `${CANON}.json`), JSON.stringify({
    id: CANON, displayId: DISPLAY, title: "Non-converging", description: "A test.",
    type: "task", status: "inprogress", phase: "p1", order: 10,
    createdDate: "2026-08-21", completedDate: null, blockedBy: [],
    claimedBySession: session.sessionId, claim,
  }));

  writeSessionSync(sessDir, {
    ...session,
    state: "CODE_REVIEW",
    previousState: "IMPLEMENT",
    ticket: { id: CANON, displayId: DISPLAY, title: "Non-converging", risk: "low", claimed: true },
    claimEpoch: {
      ticketId: CANON, sessionId: session.sessionId,
      user: claim.user, branch: claim.branch, since: claim.since, establishedAt: NOW,
    },
    // What the REPORT path reads. `resolveRecipeFromState` uses
    // `state.resolvedStages`; the config's `recipeOverrides` is folded into it
    // at session START, which this fixture does not run. Both are set, so the
    // fixture matches the shape a real session carries.
    resolvedStages: { CODE_REVIEW: { maxReviewRounds: CAP } },
    codeReviewRoundCounter: { workItemId: CANON, kind: "ticket", completedRounds },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);

  return { session, sessDir };
}

const BLOCKING = [
  { severity: "critical", category: "correctness", description: "Off-by-one in the retry bound", disposition: "open" },
  { severity: "major", category: "security", description: "Token logged at debug level", disposition: "open" },
  { severity: "suggestion", category: "style", description: "Rename this variable", disposition: "open" },
];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ceiling-e2e-"));
  setupProject(root);
  vi.mocked(gitHead).mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } } as never);
});

afterEach(() => {
  hoisted.stealClaimOnLock = null;
  hoisted.failStateWriteIf = null;
  hoisted.armThenFailNextWriteIf = null;
  hoisted.armed = false;
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the round ceiling through the real guide path (T-470)", () => {
  it("parks to HANDOVER, files the findings, and records the reason on the item", async () => {
    const { session } = seedSession(root, CEILING - 1);

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: BLOCKING },
    });

    expect(result.isError).toBeFalsy();
    // The assertion that only this path can make. A park routed to a target the
    // CODE_REVIEW row does not list throws here, AFTER the ledger has moved.
    expect(textOf(result)).not.toContain("Invalid state transition");

    const after = readState(root, session.sessionId);
    expect(after.state).toBe("HANDOVER");
    expect(after.ticket).toBeUndefined();
    expect(after.claimEpoch).toBeUndefined();

    // The reason is on the ITEM, not only in a gitignored session artifact.
    const ticket = readTicket(root, CANON);
    const park = ticket.park as Record<string, unknown> | undefined;
    expect(park?.stage).toBe("CODE_REVIEW");
    expect(String(park?.reason)).toContain("ceiling");

    // The critical and the major reached the LEDGER; the suggestion did not.
    const filed = issues(root);
    expect(filed.length).toBe(2);
    expect(filed.map((i) => i.severity).sort()).toEqual(["critical", "high"]);

    // The escalation is recorded as finished, which is what the session report
    // renders and what stops the next call resuming it.
    expect(after.pendingCeilingEscalation?.completed).toBe(true);
    expect(after.pendingCeilingEscalation?.round).toBe(CEILING);

    // The work really is still there. This is the whole reason the ceiling ends
    // the session instead of advancing the queue: nothing re-checks the tree
    // mid-session, so the next item would build on top of these changes.
    expect(existsSync(join(root, "src", "changed.ts"))).toBe(true);

    // THE ACTUAL REPORT, rendered from the state the park really produced.
    //
    // Asserting the state field alone was worth nothing: this same path clears
    // both review arrays, and the formatter's empty-review early return was
    // dropping the ceiling section entirely -- so the one report that most
    // needs this explanation said "No reviews recorded" while the field the
    // test checked sat there correctly set.
    const { formatSessionReport } = await import("../../src/core/session-report-formatter.js");
    const report = formatSessionReport(
      { state: after, events: { events: [], malformedCount: 0 }, planContent: null, gitLog: null } as never,
      "markdown" as never,
    );
    expect(report).toContain("Round ceiling reached");
    expect(report).toContain(DISPLAY);
    for (const issue of filed) expect(report).toContain(String(issue.displayId ?? issue.id));
  });

  /**
   * The claim release is `handover.ts`'s existing behaviour, unchanged by this
   * ticket -- which is precisely why it is asserted here. The ceiling relies on
   * it: an item left `inprogress` with a stale `claimedBySession` is the
   * deadlock ISS-904 was written to break, and re-creating it one stage over
   * would make the ceiling worse than the loop it replaces.
   */
  it("leaves the item repickable once the handover is written", async () => {
    const { session } = seedSession(root, CEILING - 1);

    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: BLOCKING },
    });
    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "handover_written" },
    });

    const ticket = readTicket(root, CANON);
    expect(ticket.status).toBe("open");
    expect(ticket.claimedBySession).toBeUndefined();
    expect(ticket.claim).toBeUndefined();
  });

  /**
   * The `not-ours` outcome. Nothing is written to the item -- its claim moved,
   * so it may be complete or owned by another session -- and the handover
   * instruction has to say that rather than "back in the queue", which would
   * contradict the notes directly above it and send the next session after an
   * item that is not theirs.
   */
  it("does not tell the handover writer a dropped item is back in the queue", async () => {
    const { session } = seedSession(root, CEILING - 1);
    hoisted.stealClaimOnLock = () => {
      const t = readTicket(root, CANON);
      writeFileSync(
        join(root, ".story", "tickets", `${CANON}.json`),
        JSON.stringify({ ...t, claimedBySession: "some-other-session" }),
      );
    };

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: BLOCKING },
    });

    const text = textOf(result);
    expect(text).not.toContain("back in the queue");
    expect(text).toContain("left exactly as it is");
    // The tree fact holds in every outcome and is why the session still ends.
    expect(text).toContain("still in the working tree");
    // And the item really was left alone.
    expect(readTicket(root, CANON).park).toBeUndefined();
  });

  /**
   * THE PRODUCTION RETRY PATH, which the stage-level tests cannot reach.
   *
   * `handleReport` drains `pendingDeferrals` through `guide.ts`'s OWN
   * `drainPendingDeferrals` before the stage runs, so that function -- not
   * `StageContext.drainDeferrals` -- is usually what files a ceiling
   * escalation's findings. It had no dedupe key, so a stop between creating an
   * issue there and writing the state recording it filed a second copy on the
   * next call, while every stage-level resume test stayed green because none of
   * them go through this function.
   */
  it("reuses the existing issues when a resumed drain re-files them", async () => {
    const { session } = seedSession(root, CEILING - 1);

    // Stop the run at the moment both issues exist and nothing records it.
    hoisted.failStateWriteIf = (next) =>
      ((next.filedDeferrals as unknown[] | undefined)?.length ?? 0) === 2;

    const crashed = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: BLOCKING },
    });
    expect(crashed.isError).toBe(true);

    // The crash state, as the real run left it: the issues are in the ledger,
    // the queue still holds them, nothing says they were filed, and the park
    // never ran -- so the session still holds the ticket and the ledger claim.
    const firstIds = issues(root).map((i) => i.id).sort();
    expect(firstIds.length).toBe(2);
    const crashState = readState(root, session.sessionId);
    expect(crashState.state).toBe("CODE_REVIEW");
    expect(crashState.filedDeferrals ?? []).toEqual([]);
    expect((crashState.pendingDeferrals ?? []).length).toBe(2);
    expect(crashState.pendingCeilingEscalation?.completed).toBeFalsy();
    // The round IS persisted here: it is written in the shared block above the
    // escalation, which is why the resume must not count it again.
    expect(crashState.codeReviewRoundCounter?.completedRounds).toBe(CEILING);
    expect(crashState.ticket?.id).toBe(CANON);
    expect(readTicket(root, CANON).claimedBySession).toBe(session.sessionId);

    const resumed = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: BLOCKING },
    });

    // The resume has to SUCCEED. Asserting only that the issue ids are
    // unchanged is satisfied by a preflight rejection or any other no-op, which
    // files nothing precisely because it did nothing.
    expect(resumed.isError).toBeFalsy();
    expect(textOf(resumed)).not.toContain("Invalid state transition");

    const final = readState(root, session.sessionId);
    expect(final.state).toBe("HANDOVER");
    expect(final.pendingCeilingEscalation?.completed).toBe(true);
    // Resumed, not re-run: a second round would count again.
    expect(final.codeReviewRoundCounter?.completedRounds).toBe(CEILING);
    // The queue drained, and into the RECORD of what was filed.
    expect(final.pendingDeferrals ?? []).toEqual([]);
    expect((final.filedDeferrals ?? []).map((d) => d.fingerprint).sort())
      .toEqual([...(crashState.pendingCeilingEscalation?.fingerprints ?? [])].sort());

    // Same issues, by ID. A missing dedupe key here mints parallel copies.
    expect(issues(root).map((i) => i.id).sort()).toEqual(firstIds);
  });

  /**
   * THE WINDOW THE ALLOW-LIST OPENED.
   *
   * The escalation owns only OPEN findings, so a `deferred` one in the same
   * round is durable only because it is queued before the decision write. The
   * ordinary call that used to be its only home sits after that write, and a
   * resume enters `escalateCeiling` and parks without processing the report --
   * so a stop in that window would drop it with nothing left to re-derive it
   * from. The report is not replayed; the queue is the only record.
   */
  it("does not lose a deferred finding to a crash right after the decision write", async () => {
    const { session } = seedSession(root, CEILING - 1);
    const MIXED = [
      { severity: "critical", category: "correctness", description: "Off-by-one in the retry bound", disposition: "open" },
      { severity: "major", category: "api", description: "Valid, out of scope", disposition: "deferred" },
    ];

    // Fire on the write AFTER the one that made the decision durable.
    hoisted.armThenFailNextWriteIf = (next) => next.pendingCeilingEscalation != null;

    const crashed = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: MIXED },
    });
    expect(crashed.isError).toBe(true);

    const crashState = readState(root, session.sessionId);
    expect(crashState.pendingCeilingEscalation).toBeTruthy();
    // The escalation owns the open critical ONLY.
    expect(crashState.pendingCeilingEscalation?.findings.map((f) => f.description))
      .toEqual(["Off-by-one in the retry bound"]);
    // And the deferred finding is durable anyway: queued, filed, or both.
    const durable = [
      ...(crashState.pendingDeferrals ?? []).map((d) => d.description),
      ...(crashState.filedDeferrals ?? []).map((d) => d.fingerprint),
    ];
    const alreadyFiled = issues(root).some((i) => JSON.stringify(i).includes("Valid, out of scope"));
    expect(durable.includes("Valid, out of scope") || alreadyFiled).toBe(true);

    const resumed = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      // The resume carries NO findings, exactly as a real one does. If the
      // deferred entry were not already durable, this is where it vanishes.
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: [] },
    });
    expect(resumed.isError).toBeFalsy();
    expect(readState(root, session.sessionId).state).toBe("HANDOVER");

    // Both findings reached the ledger, exactly once each.
    const all = issues(root);
    const text = JSON.stringify(all);
    expect(text).toContain("Off-by-one in the retry bound");
    expect(text).toContain("Valid, out of scope");
    expect(all.length).toBe(2);
  });

  it("does not park a round below the ceiling", async () => {
    const { session } = seedSession(root, CEILING - 2);

    await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "code_review_round", verdict: "request_changes", findings: BLOCKING },
    });

    const after = readState(root, session.sessionId);
    expect(after.state).not.toBe("HANDOVER");
    expect(readTicket(root, CANON).status).toBe("inprogress");
    expect(issues(root).length).toBe(0);
  });
});
