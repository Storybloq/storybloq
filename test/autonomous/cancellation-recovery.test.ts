/**
 * T-450 step 6a commit B2b part 2: the nonterminal recovery dispatcher.
 *
 * A cancel that crashed between write 1 and write 4 leaves the session NOT in
 * SESSION_END, so a re-issued cancel reaches the ordinary path. Today that path
 * would run a FRESH cancellation: re-derive the disposition from the ticket's
 * current state and attempt a SECOND stash pop. Both are wrong, and they are
 * wrong in different ways.
 *
 * THE SECOND POP is the destructive one. The first pop may already have
 * succeeded, in which case popping again applies a stash that is no longer
 * there, or worse, applies an unrelated one that has since taken its ref.
 *
 * THE RE-DERIVED DISPOSITION is the quietly dishonest one. The ticket release
 * happens BEFORE any transition write, so by re-entry the ticket is already
 * open; re-deriving would record `unchanged`, an audit record asserting that
 * nothing happened to a ticket this session in fact released.
 *
 * SO THE TRANSITION IS RESUMED, not restarted, under its original
 * `transitionId`. `outcome: null` becomes `indeterminate` WITHOUT a pop,
 * because whether the first pop ran is precisely what cannot be known: the
 * durable state is identical whether we crashed before the pop or after it and
 * before write 3, and recovery must behave identically in both.
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
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { gitStashPop } from "../../src/autonomous/git-inspector.js";
import { readCancellationTransition } from "../../src/autonomous/cancellation-transition.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

// Valid interception: `killSidecar` lives in liveness.js, a different module
// from its guide.ts caller, so replacing the export replaces what the caller
// resolves (the L-041 trap applies only to same-module calls).
const inject = vi.hoisted(() => ({ killThrows: false }));
vi.mock("../../src/autonomous/liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/liveness.js")>();
  return {
    ...actual,
    killSidecar: ((pid: unknown, opts?: unknown) => {
      if (inject.killThrows) throw new Error("injected kill failure");
      return (actual.killSidecar as (p: unknown, o?: unknown) => unknown)(pid, opts);
    }) as typeof actual.killSidecar,
  };
});

const NOW = new Date().toISOString();
const PRIOR_TID = "aaaaaaaa-1111-4222-8333-444444444444";
// Valid uuid, simply not this session's. `sessionId` is uuid-typed in the
// schema, so a readable stand-in like "another-session" is rejected as
// MALFORMED before the identity gate is reached: the test would pass and would
// be testing the wrong branch.
const OTHER_SESSION = "77777777-6666-4555-8444-333333333333";

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
    title: "test", date: "2026-08-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

function writeIssue(root: string): void {
  writeFileSync(join(root, ".story", "issues", "ISS-001.json"), JSON.stringify({
    id: "ISS-001", title: "Test issue", status: "open", severity: "medium",
    components: [], impact: "A test.", resolution: "", location: [],
    discoveredDate: "2026-08-01", resolvedDate: null, relatedTickets: [],
  }));
}

function writeTicket(root: string, status = "inprogress"): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status, phase: "p1", order: 10, createdDate: "2026-08-01",
    completedDate: null, blockedBy: [],
  }));
}

/**
 * A session mid-cancellation: the transition is written, the session has NOT
 * reached SESSION_END. This is the durable state a crash between write 1 and
 * write 4 leaves behind.
 */
function plantInterrupted(
  root: string,
  transition: Record<string, unknown> | undefined,
  opts: { autoStash?: boolean; auto?: boolean; pendingMutation?: boolean } = {},
): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: opts.auto ? "auto" : "guided",
    ...(opts.pendingMutation
      ? { pendingProjectMutation: { type: "issue_update", target: "ISS-001", value: "resolved", expectedCurrent: "open" } }
      : {}),
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    compactPending: true, compactPreparedAt: NOW, compactObservedAt: NOW, resumeBlocked: true,
    git: {
      branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123",
      ...(opts.autoStash ? { autoStash: { ref: "stash@{0}", stashedAt: NOW } } : {}),
    },
    reviews: { plan: [], code: [] },
    // sessionId AND sessionStartedAt are stamped from the real session: the
    // identity gate binds on the id and checks the start time in addition, so a
    // hand-invented start time would make every fixture fail the gate for a
    // reason the test is not about.
    ...(transition
      ? { cancellationTransition: {
          ...transition,
          sessionId: session.sessionId,
          sessionStartedAt: new Date(session.startedAt).toISOString(),
        } }
      : {}),
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function priorTransition(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "stash_pending",
    transitionId: PRIOR_TID,
    action: "ordinary_cancellation",
    authority: { kind: "legacy" },
    // The disposition the FIRST attempt acted on: it released the ticket.
    disposition: { kind: "released", ticketId: "T-001" },
    sessionStartedAt: "2026-08-01T00:00:00.000Z",
    // The revision write 1 PRODUCED. The planted session sits at revision 1,
    // and the per-phase contract for a null outcome is current === tSR.
    transitionStartedRevision: 1,
    stash: { outcome: null },
    ...over,
  };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

function transitionOf(sessDir: string) {
  return readCancellationTransition((readState(sessDir) as Record<string, unknown>).cancellationTransition);
}

let root: string;

beforeEach(() => {
  inject.killThrows = false;
  root = mkdtempSync(join(tmpdir(), "t450-recovery-"));
  setupProject(root);
  vi.mocked(gitStashPop).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof gitStashPop>>);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("T-450: a re-issued cancel RESUMES the interrupted transition", () => {
  it("keeps the original transitionId instead of minting a new one", async () => {
    // A fresh id would orphan the first attempt's evidence: the ended marker
    // and any artifacts it wrote are keyed by the ORIGINAL id, and a completion
    // marker under a new id would attest to a transition that never ran a tail.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition(), { autoStash: true });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.transitionId).toBe(PRIOR_TID);
  });

  it("does NOT attempt a second pop, and records the outcome as indeterminate", async () => {
    // THE DESTRUCTIVE ONE. `outcome: null` covers two indistinguishable crash
    // seams: before the pop ever ran, and after it but before write 3. The
    // durable state is identical, so recovery must behave identically, and the
    // only honest terminal value is `indeterminate`.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition(), { autoStash: true });

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.stash.outcome).toBe("indeterminate");
  });

  it("preserves a CONCRETE outcome verbatim rather than degrading it", async () => {
    // The crash-after-write-3 seam. Folding write 3 into write 4 would have
    // made every one of these resolve to `indeterminate`, including the ones
    // whose outcome was known. The separate write exists to keep this fact.
    writeTicket(root, "open");
    // tSR 0: a concrete outcome means write 3 ran, so the contract is
    // current === tSR + 1, and the planted session sits at revision 1.
    const { sessionId, sessDir } = plantInterrupted(
      root, priorTransition({ stash: { outcome: "popped" }, transitionStartedRevision: 0 }), { autoStash: true },
    );

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.stash.outcome).toBe("popped");
  });

  it("takes the disposition from the RECORD, not from the ticket's current state", async () => {
    // The quietly dishonest one. The ticket was released by the first attempt,
    // so it is `open` now. Re-deriving would record `unchanged`, asserting that
    // nothing happened to a ticket this session in fact released.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition());

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.disposition).toEqual({ kind: "released", ticketId: "T-001" });

    // AND THE AUDIT EVENT, which is derived separately from the transition
    // record and is the part an auditor actually reads. Pinning only the record
    // would leave the event free to report `ticketId: null` on a recovery that
    // is finishing a release that demonstrably happened.
    const events = readFileSync(join(sessDir, "events.log"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const cancelled = events.filter((e) => e.type === "cancelled");
    expect(cancelled.length).toBeGreaterThan(0);
    const data = cancelled[cancelled.length - 1]!.data as Record<string, unknown>;
    expect(data.ticketId).toBe("T-001");
    expect(data.ticketReleased).toBe(true);
  });

  it("still reaches a terminal published state", async () => {
    // Resuming is not a no-op: the point is to FINISH the cancellation, not
    // merely to avoid repeating it.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition());

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const after = readState(sessDir);
    expect(after.state).toBe("SESSION_END");
    expect(after.status).toBe("completed");
    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.phase).toBe("published");
  });

  it("costs exactly ONE write, because writes 1 and 3 are already on disk", async () => {
    // Rewriting write 1 on resume would reset a CONCRETE outcome back to
    // `null`, and rewriting write 3 would spend a revision the published
    // equation does not allow. One write remains: terminal publication.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(
      root, priorTransition({ stash: { outcome: "popped" }, transitionStartedRevision: 0 }), { autoStash: true },
    );
    const before = readState(sessDir).revision;

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    // ONE write, not two: the concrete outcome is already on disk as write 3,
    // and rewriting it would push publication to tSR + 3, breaking the
    // published equation (terminalRevision === tSR + 2). Only write 4 runs.
    expect(readState(sessDir).revision).toBe(before + 1);
    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.terminalRevision).toBe(read.transition.transitionStartedRevision + 2);
  });

  it("publishes at tSR + 2 when resuming a null outcome too", async () => {
    // The null-outcome resume DOES run write 3 (it records `indeterminate`),
    // so both resume shapes land publication on the same equation.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition(), { autoStash: true });

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.terminalRevision).toBe(read.transition.transitionStartedRevision + 2);
  });

  it("finishes the cancellation even in auto mode with work remaining", async () => {
    // The soft gate exists to stop a cancel from STARTING. This one already
    // started, durably. Refusing here would strand a session mid-transition
    // with no route to finish it, which is the dead end the whole ticket is
    // about.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition(), { auto: true });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");
  });

  it("CONTROL: the ordinary path DOES replay a pending project mutation", async () => {
    // Without this, the assertion below is satisfied by a fixture that never
    // had a live mutation in it, and would keep passing however the recovery
    // path were rewritten (L-039).
    writeTicket(root, "open");
    writeIssue(root);
    const { sessionId } = plantInterrupted(root, undefined, { pendingMutation: true });

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const issue = JSON.parse(
      readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(issue.status).toBe("resolved");
  });

  it("does not replay a pending project mutation", async () => {
    // Ticket work is not repeated, and that includes the ISS-024 replay. The
    // first attempt already passed this point; replaying would write to the
    // ledger a second time on behalf of a session that is on its way out.
    writeTicket(root, "open");
    writeIssue(root);
    const { sessionId } = plantInterrupted(root, priorTransition(), { pendingMutation: true });

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const issue = JSON.parse(
      readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(issue.status).toBe("open");
  });
});

describe("T-450: a transition that is not this session's fails closed", () => {
  it("REFUSES a record naming ANOTHER session rather than resuming it", async () => {
    // Otherwise the two recovery paths disagree: the terminal branch refuses
    // this and the live one would adopt the foreign record's transitionId,
    // disposition and stash outcome as its own.
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition());
    // plantInterrupted stamps the real sessionId in; overwrite it.
    const raw = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as Record<string, unknown>;
    (raw.cancellationTransition as Record<string, unknown>).sessionId = OTHER_SESSION;
    writeFileSync(join(sessDir, "state.json"), JSON.stringify(raw, null, 2));
    const before = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain(OTHER_SESSION);
    expect(readState(sessDir).revision).toBe(before);
    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
  });

  it("REFUSES a record from an EARLIER session in the same directory", async () => {
    // Session directories are reused. A record left behind by a previous
    // incarnation carries the right id and the wrong provenance, which is
    // exactly why `sessionStartedAt` is checked in addition to the id and never
    // instead of it.
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition());
    const raw = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as Record<string, unknown>;
    (raw.cancellationTransition as Record<string, unknown>).sessionStartedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(join(sessDir, "state.json"), JSON.stringify(raw, null, 2));
    const before = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("earlier session");
    expect(readState(sessDir).revision).toBe(before);
  });
});

describe("T-450: the resumed tail tells the truth about itself", () => {
  it("reports an incomplete shutdown instead of asserting one it never checked", async () => {
    // F1 from the pen's byte-review of 1091b226: the resumed path dropped the
    // TailOutcome and replied unconditionally. Same honesty rule as the
    // terminal branch: say what was verified.
    //
    // The fixture also pins the RESUMED-TAIL MARKER MODE ruling: a
    // legacy-shaped, identifier-free ended marker may be adopted by a FIRST
    // pass (which provably runs before this transition wrote one) but not by a
    // resume, which arrives after a crash window in which anything may have
    // written it. Under recovery mode markEnded refuses it, the postcondition
    // goes unmet, and the reply must say so.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition());
    const tDir = join(sessDir, "telemetry");
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "ended"), JSON.stringify({ reason: "cancelled", timestamp: "2026-07-01T00:00:00.000Z" }));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).toContain("NOT yet complete");
    expect(text).toContain("ended-marker");
    // And the ruling's preserve half: the identifier-free marker is intact.
    expect(JSON.parse(readFileSync(join(tDir, "ended"), "utf-8")).timestamp).toBe("2026-07-01T00:00:00.000Z");
  });

  it("names a THROWN shutdown call as unknown, never as a missing record", async () => {
    // F2: with the transition present and a sibling outcome undefined (the
    // undefined-on-throw rule), the old fall-through reported "no transition
    // record" -- telling an operator there is nothing to recover exactly when
    // there is.
    writeTicket(root, "open");
    const { sessionId } = plantInterrupted(root, priorTransition());
    inject.killThrows = true;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const text = JSON.stringify(result);
    expect(text).toContain("NOT yet complete");
    expect(text).toContain("sidecar: shutdown call threw, outcome unknown");
    expect(text).not.toContain("no transition record");
  });

  it("survives an UNCREATABLE telemetry directory and reports it, rather than dying on it", async () => {
    // F3: `withTelemLock` created the telemetry directory OUTSIDE its guarded
    // region, so an unmakeable directory escaped the wrapper as a throw and
    // took the whole cancel down -- one failed postcondition suppressing every
    // other, the exact invariant the tail exists to hold. A regular FILE at the
    // telemetry path is the cheapest way to make mkdir fail.
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition());
    writeFileSync(join(sessDir, "telemetry"), "not a directory");

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");
    expect(JSON.stringify(result)).toContain("NOT yet complete");
  });

  it("says nothing extra when the resumed tail completes", async () => {
    // The note is for unverified completions, not a banner.
    writeTicket(root, "open");
    const { sessionId } = plantInterrupted(root, priorTransition());

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).not.toContain("NOT yet complete");
  });
});

describe("T-450: re-entry validates shape and authority before resuming", () => {
  it("REFUSES when the session revision does not match the recorded phase", async () => {
    // The per-phase equations are the re-entry shape check: a null outcome
    // means only write 1 ran, so the session must sit exactly at tSR. A
    // session that has moved past it was written by something after the crash,
    // and resuming over that would publish a terminalRevision the equation
    // rejects -- 6b's locked validator would then refuse the record forever.
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition({ transitionStartedRevision: 5 }));
    const before = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("revision");
    expect(readState(sessDir).revision).toBe(before);
    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
  });

  it("REFUSES task authority when the caller is not the recorded caller", async () => {
    // The record says WHO may finish this cancellation. Legacy has no identity
    // to check; task does, and it is checked.
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(
      root, priorTransition({ authority: { kind: "task", callerTaskId: "task-original" } }),
    );
    const before = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, {
      action: "cancel", sessionId, clientTaskId: "task-somebody-else",
    });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("task-original");
    expect(readState(sessDir).revision).toBe(before);
  });

  it("REFUSES candidate authority ALWAYS, whoever the caller is", async () => {
    // Candidate recovery runs through the locked candidate validator that
    // ships with the candidate paths: fingerprint recomputation, revision
    // anchoring, current eligibility, caller identity. Honoring the record
    // through a plain cancel would bypass every one of those checks, so this
    // path refuses it categorically, matching caller or not.
    //
    // Hand-built minimal-but-VALID evidence: it must survive the strict
    // reader, or this test would exercise the malformed branch instead of the
    // authority gate and pass for the wrong reason (the L-041-adjacent trap
    // this suite already fell into once with a non-uuid sessionId).
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition({
      action: "candidate_recovery_takeover",
      authority: {
        kind: "candidate",
        clientTaskId: "task-candidate",
        confirmedSessionRevision: 0,
        confirmedFingerprint: "fp-1",
        evidence: {
          activity: { kind: "unknown", reason: "absent" },
          lease: { kind: "unknown", reason: "absent" },
          deathMarker: { kind: "unreadable", reason: "absent" },
          markerValidity: { kind: "unknown", reason: "no-recorded-pid", pid: null },
          sidecarProbe: { kind: "unknown", reason: "no-pid", pid: null },
          observedAt: "2026-08-01T00:00:00.000Z",
          staleThresholdMs: 2700000,
          successors: { kind: "unavailable", reason: "test fixture" },
        },
      },
    }));
    // PROVE the fixture parses valid, so the refusal below is the authority
    // gate and nothing earlier.
    const planted = transitionOf(sessDir);
    expect(planted.kind).toBe("valid");
    const before = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, {
      action: "cancel", sessionId, clientTaskId: "task-candidate",
    });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("candidate");
    expect(readState(sessDir).revision).toBe(before);
    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
  });

  it("RESUMES task authority for the recorded caller", async () => {
    writeTicket(root, "open");
    const { sessionId, sessDir } = plantInterrupted(
      root, priorTransition({ authority: { kind: "task", callerTaskId: "task-original" } }),
    );

    const result = await handleAutonomousGuide(root, {
      action: "cancel", sessionId, clientTaskId: "task-original",
    });

    expect(result.isError).toBeFalsy();
    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.transitionId).toBe(PRIOR_TID);
  });
});

describe("T-450: contradictory evidence on a live session fails closed", () => {
  it("REFUSES a PUBLISHED transition on a session that is still live", async () => {
    // Write 4 sets SESSION_END, `status: completed` and the published record in
    // ONE write, so no crash can produce this pairing. Resuming it would drive
    // the record back through `stash_pending` and republish it with a fresh
    // `endedAt` and `terminalRevision`, overwriting the termination time it
    // already carries. The terminal path refuses the mirror image of this.
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition({
      phase: "published",
      stash: { outcome: "popped" },
      endedAt: "2026-08-01T09:00:00.000Z",
      terminalRevision: 9,
      shutdownArtifact: { schemaVersion: 1, filename: "cancellation-shutdown.json" },
    }));
    const before = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("published");
    expect(readState(sessDir).revision).toBe(before);
    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.endedAt).toBe("2026-08-01T09:00:00.000Z");
  });

  it("REFUSES when this session's own startedAt cannot be read", async () => {
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(root, priorTransition());
    const raw = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as Record<string, unknown>;
    raw.startedAt = "not a date";
    writeFileSync(join(sessDir, "state.json"), JSON.stringify(raw, null, 2));
    const before = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("provenance");
    expect(readState(sessDir).revision).toBe(before);
    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
  });
});

describe("T-450: a corrupt transition on a live session fails closed", () => {
  it("REFUSES the cancel rather than minting a fresh transition over it", async () => {
    // Fail closed. A malformed record is still a record: something started a
    // cancellation here and we cannot tell what it decided. Starting a fresh
    // one would overwrite the only evidence of it, and could release a ticket
    // or pop a stash the first attempt already handled.
    writeTicket(root);
    const { sessionId, sessDir } = plantInterrupted(root, { phase: "stash_pending", nonsense: true });
    const before = readState(sessDir);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    const after = readState(sessDir);
    expect(after.state).toBe("IMPLEMENT");
    // Validation precedes every state write, so a refusal costs no revision.
    expect(after.revision).toBe(before.revision);
    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
  });

  it("names the corrupt record in the refusal, rather than a bare failure", async () => {
    // An operator who cannot tell WHY a cancel refused reaches for the admin
    // CLI, which is the escape hatch this whole ticket exists to retire.
    writeTicket(root);
    const { sessionId } = plantInterrupted(root, { phase: "stash_pending", nonsense: true });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const text = JSON.stringify(result);
    expect(text).toContain("cancellationTransition");
  });
});
