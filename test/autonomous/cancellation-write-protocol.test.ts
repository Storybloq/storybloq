/**
 * T-450 step 6a commit B2b: the ordinary-cancel write protocol.
 *
 * The shipped tail publishes a terminal state and then performs six follow-up
 * effects, each a `: void` writer with a bare catch, so a session can be
 * durably CANCELLED while every one of them silently did nothing. B2a landed
 * the durable artifacts recovery reads; this is the protocol that produces
 * them.
 *
 * FOUR WRITES, and the shape is load-bearing:
 *   1. nonterminal transition at `stash_pending`, outcome `null`, carrying the
 *      already-computed disposition, authority and action;
 *   2. the stash pop attempt;
 *   3. the outcome, still `stash_pending`, now concrete;
 *   4. terminal publication, transition at `published`.
 *
 * WHY DISPOSITION RIDES IN WRITE 1. Ticket release precedes every transition
 * write, so a crash between the release and publication would otherwise lose
 * the `released` result: re-entry would see an open ticket and reconstruct
 * `unchanged`, which is a FALSE audit record. Persisting it in write 1 means
 * every window after a successful release retains the truth.
 *
 * WHY WRITE 3 IS NOT FOLDED INTO WRITE 4. Folding makes every crash between the
 * pop and publication resolve to `indeterminate`, including the ones whose
 * outcome was known. The extra write buys the distinction.
 *
 * These tests drive `handleAutonomousGuide` rather than the internal function,
 * because the entry point is where the protocol has to hold.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Writer call order, observed rather than inferred. Legitimate interception:
 * these live in `cancellation-transition.js`, a DIFFERENT module from the
 * `guide.ts` caller, so replacing the module's exports really does replace what
 * the caller resolves (L-041).
 */
const WRITES: string[] = [];

/**
 * Armed by exactly one test, to prove that a failure to MINT a transition
 * degrades to the shipped tail rather than taking the cancellation down. The
 * transition is an enhancement to a path that already worked.
 */
const entropy = vi.hoisted(() => ({ fail: false }));

/** Armed per-test to force a specific tail writer to fail deterministically. */
const inject = vi.hoisted(() => ({ resumeThrows: false, telemetryCancelFails: false, killThrows: false }));

vi.mock("../../src/autonomous/liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/liveness.js")>();
  return {
    ...actual,
    killSidecar: vi.fn((...args: Parameters<typeof actual.killSidecar>) => {
      if (inject.killThrows) throw new Error("simulated kill failure");
      return (actual.killSidecar as (...a: unknown[]) => unknown)(...args);
    }),
  };
});

vi.mock("../../src/autonomous/resume-marker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/resume-marker.js")>();
  return {
    ...actual,
    removeResumeMarker: vi.fn((...args: Parameters<typeof actual.removeResumeMarker>) => {
      if (inject.resumeThrows) throw new Error("simulated resume-marker failure");
      return (actual.removeResumeMarker as (...a: unknown[]) => unknown)(...args);
    }),
  };
});

vi.mock("../../src/autonomous/telemetry-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/telemetry-writer.js")>();
  return {
    ...actual,
    writeEvent: vi.fn((...args: Parameters<typeof actual.writeEvent>) => {
      const event = args[1] as { type?: string } | undefined;
      // Drop only THIS cancellation's record, leaving every other telemetry
      // write intact, so the test isolates the one postcondition it is about.
      if (inject.telemetryCancelFails && event?.type === "session_cancelled") return;
      return actual.writeEvent(...args);
    }),
  };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => {
      if (entropy.fail) throw new Error("simulated entropy source failure");
      return actual.randomUUID();
    },
  };
});

vi.mock("../../src/autonomous/cancellation-transition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/cancellation-transition.js")>();
  return {
    ...actual,
    writeShutdownArtifact: vi.fn((...args: Parameters<typeof actual.writeShutdownArtifact>) => {
      const ok = actual.writeShutdownArtifact(...args);
      WRITES.push(`artifact:${ok}`);
      return ok;
    }),
    writeCompletionMarker: vi.fn((...args: Parameters<typeof actual.writeCompletionMarker>) => {
      WRITES.push("marker");
      return actual.writeCompletionMarker(...args);
    }),
  };
});

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
import {
  readCancellationTransition,
  readShutdownArtifact,
  classifyCompletionMarker,
} from "../../src/autonomous/cancellation-transition.js";
import { CANCELLATION_SHUTDOWN_ARTIFACT } from "../../src/autonomous/session-types.js";
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
    title: "test", date: "2026-08-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

function writeTicket(root: string): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-08-01",
    completedDate: null, blockedBy: [],
  }));
}

function plantSession(
  root: string,
  opts: { autoStash?: { ref: string; stashedAt: string } | null } = {},
): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    compactPending: true,
    compactPreparedAt: NOW,
    compactObservedAt: NOW,
    resumeBlocked: true,
    git: {
      branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123",
      ...(opts.autoStash ? { autoStash: opts.autoStash } : {}),
    },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

/** The transition as the strict reader sees it, which is how recovery reads it. */
function transitionOf(sessDir: string) {
  const raw = (readState(sessDir) as Record<string, unknown>).cancellationTransition;
  return readCancellationTransition(raw);
}

let root: string;

beforeEach(() => {
  WRITES.length = 0;
  entropy.fail = false;
  inject.resumeThrows = false;
  inject.telemetryCancelFails = false;
  inject.killThrows = false;
  root = mkdtempSync(join(tmpdir(), "t450-write-protocol-"));
  setupProject(root);
  vi.mocked(gitStashPop).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof gitStashPop>>);
});

afterEach(() => {
  entropy.fail = false;
  inject.resumeThrows = false;
  inject.telemetryCancelFails = false;
  inject.killThrows = false;
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("T-450: the ordinary cancel publishes a durable, readable transition", () => {
  it("leaves a VALID published transition, not merely some object", async () => {
    // Read through the strict reader rather than by field poking: recovery only
    // ever sees this record through that reader, so a record that survives a
    // field assertion but fails the reader is a record recovery cannot use.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const read = transitionOf(sessDir);
    expect(read.kind).toBe("valid");
    if (read.kind !== "valid") throw new Error("unreachable");
    expect(read.transition.phase).toBe("published");
  });

  it("binds the transition to THIS session by id, not by timestamp", async () => {
    // sessionStartedAt is wall-clock and millisecond-granular, so two sessions
    // can carry the same value; a transplanted record would pass a timestamp
    // check and apply another session's disposition and authority here.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.sessionId).toBe(sessionId);
  });

  it("persists the disposition it ACTED on, so a later reader cannot reconstruct a false one", async () => {
    // The ticket is released before any transition write. If the disposition
    // were re-derived on re-entry it would read the now-open ticket and record
    // `unchanged`, which is a false audit record of a release that did happen.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.disposition).toEqual({ kind: "released", ticketId: "T-001" });
  });

  it("pairs an ordinary cancellation with legacy authority", async () => {
    // The schema refuses the other pairing outright, so this also proves the
    // writer is not smuggling candidate authority through the ordinary path.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(read.transition.action).toBe("ordinary_cancellation");
    expect(read.transition.authority.kind).toBe("legacy");
  });

  it("records a CONCRETE stash outcome, never null, once published", async () => {
    // `null` means "not yet decided" and is only ever true before publication.
    // The honest terminal value for an unknowable pop is `indeterminate`.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root, {
      autoStash: { ref: "stash@{0}", stashedAt: NOW },
    });

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.stash.outcome).toBe("popped");
  });

  it("distinguishes a FAILED pop from a successful one and from no stash at all", async () => {
    // Three different facts. Collapsing them would strand a user's working
    // changes in a stash they were never told about, with no record of it.
    writeTicket(root);
    vi.mocked(gitStashPop).mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof gitStashPop>>);
    const failed = plantSession(root, { autoStash: { ref: "stash@{0}", stashedAt: NOW } });
    await handleAutonomousGuide(root, { action: "cancel", sessionId: failed.sessionId });

    const failedRead = transitionOf(failed.sessDir);
    if (failedRead.kind !== "valid" || failedRead.transition.phase !== "published") throw new Error("expected published");
    expect(failedRead.transition.stash.outcome).toBe("failed");

    writeTicket(root);
    const none = plantSession(root);
    await handleAutonomousGuide(root, { action: "cancel", sessionId: none.sessionId });

    const noneRead = transitionOf(none.sessDir);
    if (noneRead.kind !== "valid" || noneRead.transition.phase !== "published") throw new Error("expected published");
    expect(noneRead.transition.stash.outcome).toBe("none");
  });

  it("leaves the project status reporting NO active session", async () => {
    // The terminal write refreshes status UNCONDITIONALLY (`always`), and that
    // is the whole point of the mode: `if-active` short-circuits on a session
    // that has just become inactive, which is precisely this one, so the status
    // file would keep describing a session that has ended.
    //
    // Pinned HERE rather than in the characterization suite, whose
    // `ORDER).toContain("refreshStatusForSession")` assertion no longer
    // distinguishes this: writes 1 and 3 happen while the session is still
    // active, so they satisfy that containment on their own and the terminal
    // write's mode became invisible to it. The frozen suite is left untouched;
    // the lost property is re-pinned by observing the FILE instead of the call.
    writeTicket(root);
    const { sessionId } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const status = JSON.parse(
      readFileSync(join(root, ".story", "status.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(status.sessionActive).toBe(false);
  });

  it("records the outcome only AFTER the pop, never before it", async () => {
    // The reason write 3 is a SEPARATE write, observed from inside the pop
    // itself. At pop time the durable record must still say `null`: the outcome
    // is not yet known. If write 3 ran first it would record `none`, and a
    // crash between it and publication would then resolve on recovery to a
    // CONCRETE `none` -- an audit record stating there was no stash to restore,
    // for a stash that was in fact popped a moment later.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root, { autoStash: { ref: "stash@{0}", stashedAt: NOW } });

    let atPopTime: unknown = "the pop never ran";
    vi.mocked(gitStashPop).mockImplementation(async () => {
      const read = transitionOf(sessDir);
      atPopTime = read.kind === "valid" ? read.transition.stash.outcome : `unreadable: ${read.kind}`;
      return { ok: true } as Awaited<ReturnType<typeof gitStashPop>>;
    });

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(atPopTime).toBeNull();
  });

  it("carries a precomputable pointer to the shutdown artifact, not its outcomes", async () => {
    // Publication is write 4 and the sidecar shutdown is step 5, so nothing at
    // publication time can know those outcomes; a field for them could only be
    // fabricated. The pointer is enough for recovery to find and classify it.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.shutdownArtifact.filename).toBe(CANCELLATION_SHUTDOWN_ARTIFACT);
  });

  it("spends exactly two extra state writes, and the terminal revision names the final one", async () => {
    // The arithmetic is asserted as a RELATIVE delta because the step 5 suites
    // pin only relative monotonicity and `events[0].rev === revision`; no
    // absolute revision appears anywhere in them. Two additional pre-terminal
    // writes, on top of the terminal write that already existed at baseline.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    const before = readState(sessDir).revision;

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const after = readState(sessDir);
    expect(after.revision - before).toBe(3);

    const read = transitionOf(sessDir);
    if (read.kind !== "valid" || read.transition.phase !== "published") throw new Error("expected published");
    expect(read.transition.terminalRevision).toBe(after.revision);
    // And the transition knows where it started, which is what lets recovery
    // compute its own deltas without guessing.
    expect(read.transition.transitionStartedRevision).toBe(before);
  });
});

describe("T-450: the tail records what it did, and says so only afterwards", () => {
  it("writes a shutdown artifact bound to the SAME transition the state names", async () => {
    // The completion gate consumes this artifact instead of re-probing
    // liveness, so it has to exist and has to be attributable. An artifact from
    // some other transition would be evidence about a different event.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const stateRead = transitionOf(sessDir);
    if (stateRead.kind !== "valid") throw new Error("expected a valid transition");

    const artifact = readShutdownArtifact(sessDir);
    expect(artifact.kind).toBe("present");
    if (artifact.kind !== "present") throw new Error("unreachable");
    expect(artifact.artifact.transitionId).toBe(stateRead.transition.transitionId);
  });

  it("marks the transition COMPLETE, and the marker is owned by it", async () => {
    // The marker is the whole point of the protocol: it is what lets a later
    // pass tell "the tail finished" from "the tail may never have run".
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("matching");
  });

  it("writes the completion marker AFTER the artifact it attests to", async () => {
    // finalize.ts is the cautionary precedent: it writes its checkpoint and
    // appends its event as two steps, and its own re-entry guard returns before
    // the append, so a crash between them loses the event permanently. A marker
    // written before the thing it attests to is a marker that can lie.
    //
    // Ordering is OBSERVED at the call seam. Inspecting the final on-disk state
    // could not distinguish the two orders: both files exist either way.
    writeTicket(root);
    const { sessionId } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(WRITES).toEqual(["artifact:true", "marker"]);
  });

  it("does NOT mark complete when the artifact it would attest to failed to land", async () => {
    // The marker's whole meaning is "every postcondition holds". Writing it
    // over a failed artifact write would close recovery over evidence that does
    // not exist, which is worse than not writing it at all: the tail would be
    // recorded as finished with nothing to show for it.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    // Make the artifact write fail without touching anything else: a directory
    // where the file belongs means the temp lands but the rename cannot.
    mkdirSync(join(sessDir, "telemetry", CANCELLATION_SHUTDOWN_ARTIFACT), { recursive: true });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    // The cancellation itself still succeeds; the tail is best-effort by design.
    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(readShutdownArtifact(sessDir).kind).not.toBe("present");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
  });

  it("records what the shutdown OBSERVED, not a fixed optimistic answer", async () => {
    // These sessions carry no sidecar pid, so the honest record is
    // `already-absent`. A tail that always wrote `signalled` would produce an
    // artifact asserting a signal that was never sent, and the completion gate
    // consumes this artifact as its proof of what happened.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const artifact = readShutdownArtifact(sessDir);
    if (artifact.kind !== "present") throw new Error("expected a present artifact");
    expect(artifact.artifact.sidecar).toBe("already-absent");
  });

  it("preserves a resume marker belonging to a DIFFERENT session, and records that it did", async () => {
    // `removeResumeMarker` otherwise deletes by PATH with no session identity,
    // so a cancel can erase a NEWER session's recovery marker. The recorded
    // outcome has to say which happened, because "removed" and "left alone" are
    // different facts about someone else's session.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    const markerPath = join(root, ".claude", "rules", "autonomous-resume.md");
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(markerPath, "# Resume\n\nSession: 99999999-8888-4777-8666-555555555555\n");

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    // Someone else's marker survives untouched.
    expect(readFileSync(markerPath, "utf-8")).toContain("99999999-8888-4777-8666-555555555555");
    const artifact = readShutdownArtifact(sessDir);
    if (artifact.kind !== "present") throw new Error("expected a present artifact");
    expect(artifact.artifact.resumeMarker).toBe("preserved-foreign");
  });

  it("still cancels, through the shipped tail, when no transition can be minted", async () => {
    // The transition is an ENHANCEMENT to a path that already worked, so a
    // failure to mint one must degrade to exactly today's behavior. Aborting
    // the cancellation here would be a regression introduced by the very
    // machinery meant to make cancellation more recoverable.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    entropy.fail = true;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeFalsy();
    const after = readState(sessDir);
    expect(after.state).toBe("SESSION_END");
    expect(after.status).toBe("completed");
    // No transition, and therefore none of the artifacts that depend on one.
    expect(transitionOf(sessDir).kind).toBe("absent");
    expect(WRITES).toEqual([]);
  });

  it("withholds the completion marker when the ended marker was REFUSED", async () => {
    // A valid ended marker naming a different transition is durable evidence of
    // a competing one, so markEnded refuses rather than overwriting it. The
    // completion marker asserts that EVERY postcondition holds, so it must not
    // be written over that refusal; the reason is carried in the artifact so
    // whoever finds the transition unfinished can see why.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    mkdirSync(join(sessDir, "telemetry"), { recursive: true });
    writeFileSync(join(sessDir, "telemetry", "ended"), JSON.stringify({
      reason: "cancelled",
      timestamp: "2026-07-01T00:00:00.000Z",
      transitionId: "99999999-8888-4777-8666-555555555555",
    }));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
    expect(WRITES).toEqual(["artifact:true"]);

    const artifact = readShutdownArtifact(sessDir);
    if (artifact.kind !== "present") throw new Error("expected a present artifact");
    expect(artifact.artifact.detail).toContain("ended-marker");
  });

  it("withholds completion when the sidecar was signalled but the shutdown marker never landed", async () => {
    // The kill is only an ACCELERATOR. The justification for it being allowed
    // to fall short is that the shutdown marker is the guaranteed channel,
    // since the sidecar self-exits on it, and SIGTERM delivery is not the same
    // fact as the process having exited. So when the marker never lands, a
    // completion marker asserting every postcondition holds would be false.
    //
    // A REAL matching process rather than a stub: the probe binds on the
    // sidecar sentinel plus this session's telemetry directory, both of which
    // are put on a throwaway child's command line. It is a child rather than
    // this process because `killSidecarsInRoot` in the shared teardown calls
    // the UNVERIFIED `killSidecar`, a blind SIGTERM on whatever pid the state
    // records, and pointing that at the test runner terminates the worker.
    writeTicket(root);
    const session = createSession(root, "coding", "test-workspace");
    const sessDir = join(root, ".story", "sessions", session.sessionId);
    const tDir = join(sessDir, "telemetry");
    mkdirSync(tDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)", tDir, "--claudestory-sidecar-v1"],
      { stdio: "ignore" },
    );
    const childPid = child.pid;
    if (childPid === undefined) throw new Error("could not spawn the probe target");
    try {
      writeSessionSync(sessDir, {
        ...session,
        state: "IMPLEMENT",
        previousState: "PICK_TICKET",
        mode: "guided",
        ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
        compactPending: true, compactPreparedAt: NOW, compactObservedAt: NOW, resumeBlocked: true,
        git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
        reviews: { plan: [], code: [] },
        sidecarPid: childPid,
      } as unknown as FullSessionState);
      // A DANGLING SYMLINK, not a directory. The sidecar's predicate is bare
      // `existsSync`, which a directory satisfies, so a directory here would
      // mean the shutdown really did land. A dangling link makes the write fail
      // AND leaves `existsSync` false, which is genuine absence.
      symlinkSync("/definitely/not/a/real/target/shutdown", join(tDir, "shutdown"));

      const result = await handleAutonomousGuide(root, { action: "cancel", sessionId: session.sessionId });
      expect(result.isError).toBeFalsy();
      expect(readState(sessDir).state).toBe("SESSION_END");

      const read = transitionOf(sessDir);
      if (read.kind !== "valid") throw new Error("expected a valid transition");

      const artifact = readShutdownArtifact(sessDir);
      if (artifact.kind !== "present") throw new Error("expected a present artifact");
      expect(artifact.artifact.sidecar).toBe("signalled");
      expect(artifact.artifact.detail).toContain("shutdown-marker");

      expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
      expect(WRITES).toEqual(["artifact:true"]);
    } finally {
      // Await the exit rather than fire-and-forget: an unreaped child adds load
      // to the rest of the run, and the shared teardown would otherwise act on
      // the pid this session persisted.
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill("SIGKILL");
        });
      }
    }
  });

  it("withholds completion when the AUDIT event never landed", async () => {
    // `appendEvent` is another `: void` best-effort writer with a bare catch.
    // A cancellation whose audit trail was silently lost is exactly what the
    // completion marker must not certify. A directory where events.log belongs
    // makes the append fail without disturbing anything else.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    mkdirSync(join(sessDir, "events.log"), { recursive: true });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    const artifact = readShutdownArtifact(sessDir);
    if (artifact.kind !== "present") throw new Error("expected a present artifact");
    expect(artifact.artifact.detail).toContain("audit-event");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
  });

  it("withholds completion when the TELEMETRY event never landed", async () => {
    // Same argument, different silent writer. Verified independently of the
    // audit event so one covering for the other cannot go unnoticed.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    mkdirSync(join(sessDir, "telemetry", "events.jsonl"), { recursive: true });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    const artifact = readShutdownArtifact(sessDir);
    if (artifact.kind !== "present") throw new Error("expected a present artifact");
    expect(artifact.artifact.detail).toContain("telemetry");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
  });

  it("is not fooled by a PRIOR session_cancelled record already in the log", async () => {
    // Matching on event type alone would let an older record satisfy the check
    // about this cancellation, so a telemetry write that failed would read back
    // as successful and the completion marker would certify a lost record. The
    // event carries its transitionId precisely so the read-back can tell the
    // two apart.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    mkdirSync(join(sessDir, "telemetry"), { recursive: true });
    writeFileSync(join(sessDir, "telemetry", "events.jsonl"), JSON.stringify({
      ts: "2026-07-01T00:00:00.000Z", layer: "guide", type: "session_cancelled",
      data: { transitionId: "99999999-8888-4777-8666-555555555555" },
    }) + "\n");
    // Deterministic: drop ONLY this cancellation's record. No permissions
    // fixture, so this holds on a privileged runner too.
    inject.telemetryCancelFails = true;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    const artifact = readShutdownArtifact(sessDir);
    if (artifact.kind !== "present") throw new Error("expected a present artifact");
    expect(artifact.artifact.detail).toContain("telemetry");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
  });

  it("writes NO artifact, and no completion, when the sidecar kill throws", async () => {
    // The sibling of the resume-marker case, and it must behave identically.
    // Pre-seeding this outcome with a real value would make a THROWN kill
    // indistinguishable from a probe that ran and refused, so the artifact
    // would assert that an identity check happened when it did not. A reader of
    // the artifact should never have to remember that one of its two outcome
    // fields is lossy.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    inject.killThrows = true;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(readShutdownArtifact(sessDir).kind).toBe("absent");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
    expect(WRITES).toEqual([]);
  });

  it("writes NO artifact, and no completion, when the resume-marker removal throws", async () => {
    // An exception leaves the outcome genuinely unknown. Recording `absent`
    // would turn "we could not tell" into the successful observation "there was
    // nothing to remove", which is the unreadable-becomes-absent defect reached
    // through a throw. There is no honest value for the artifact's
    // `resumeMarker` field, so no artifact is written at all, and a published
    // transition with no artifact is exactly how recovery recognises an
    // unfinished tail.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    inject.resumeThrows = true;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expect(readState(sessDir).state).toBe("SESSION_END");

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    expect(readShutdownArtifact(sessDir).kind).toBe("absent");
    expect(classifyCompletionMarker(sessDir, read.transition.transitionId).kind).toBe("absent");
    expect(WRITES).toEqual([]);
  });

  it("stamps the ended marker with the transition, so the marker is attributable", async () => {
    // Without an id on it, an ended marker is evidence that SOME termination
    // happened here, which is not the same claim.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const read = transitionOf(sessDir);
    if (read.kind !== "valid") throw new Error("expected a valid transition");
    const ended = JSON.parse(readFileSync(join(sessDir, "telemetry", "ended"), "utf-8"));
    expect(ended.transitionId).toBe(read.transition.transitionId);
    expect(ended.reason).toBe("cancelled");
  });
});
