/**
 * T-450 step 6a commit B2b part 2: the narrowly authorized, fail-closed
 * exception to handleCancel's SESSION_END refusal.
 *
 * Publication (write 4) is what makes a session terminal, and it happens BEFORE
 * the tail. So a crash anywhere in the tail leaves a session that is terminal
 * and whose shutdown never finished: the sidecar may still be running, the
 * resume marker may still be on disk telling the next session to resume this
 * one, and the ended marker may be missing. Today's refusal, `Session already
 * ended.`, makes that state unreachable through the API, which is exactly the
 * dead end that sent three operators to `storybloq session stop`.
 *
 * THE EXCEPTION GRANTS NO NEW AUTHORITY. It finishes a cancellation that was
 * already authorized, under that transition's own recorded `action`, its own
 * `authority`, and its own `transitionId` as the evidence pointer. It re-runs
 * the TAIL and nothing else: no ticket release, no stash pop, no state write.
 *
 * AND IT IS FAIL CLOSED. The gate is the completion marker, and only two of its
 * six classifications open it. `absent` and `owned-mismatched` are ours and
 * unfinished. `matching` says the tail is done. The remaining three -- `foreign`,
 * `malformed`, `io-unreadable` -- are each a case where acting would destroy or
 * fabricate evidence, so each refuses and each names its own condition.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Legitimate here for the same reason it is in the collision suite: the lock
// lives in a DIFFERENT module from its caller, so replacing the module's export
// really does replace what the caller resolves. (L-041 bites only when caller
// and callee share a module and the call binds lexically.)
const lockFails = vi.hoisted(() => ({ value: false }));

// Stages the one race `retryAdvice` exists for: the completion marker changing
// BETWEEN authorization and the composing of the reply. Nothing on disk can
// produce that ordering, so it is produced at the seam instead. Same module
// legitimacy as the lock above -- `classifyCompletionMarker` lives in
// `cancellation-transition.js`, not in `guide.js` where its caller is.
//
// The owner id is carried IN the hoisted object rather than read from a
// module-level const: the factory runs during the import phase, before this
// file's own top-level bindings are initialized.
const markerRace = vi.hoisted(() => ({ script: null as null | string[], owner: "" }));

vi.mock("../../src/autonomous/cancellation-transition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/cancellation-transition.js")>();
  return {
    ...actual,
    classifyCompletionMarker: (dir: string, tid: string) => {
      const next = markerRace.script?.shift();
      if (next === undefined || next === "actual") return actual.classifyCompletionMarker(dir, tid);
      if (next === "foreign") return { kind: "foreign", owner: markerRace.owner };
      return { kind: next };
    },
  };
});

vi.mock("../../src/autonomous/telemetry-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/telemetry-writer.js")>();
  return {
    ...actual,
    withTelemLock: <T,>(dir: string, fn: () => T): T | undefined =>
      lockFails.value ? undefined : actual.withTelemLock(dir, fn),
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
import { classifyCompletionMarker } from "../../src/autonomous/cancellation-transition.js";
import { telemetryDirPath } from "../../src/autonomous/liveness.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const TID = "bbbbbbbb-2222-4333-8444-555555555555";
const OTHER_TID = "cccccccc-3333-4444-8555-666666666666";
const ENDED_AT = "2026-08-01T10:00:00.000Z";
// A VALID uuid that is simply not this session's. `sessionId` is uuid-typed in
// the schema, so a human-readable stand-in like "some-other-session" is
// rejected as MALFORMED before the identity check is ever reached: the test
// would pass, and would be testing the wrong branch.
const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";

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
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-08-01",
    completedDate: null, blockedBy: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function publishedTransition(sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "published",
    transitionId: TID,
    action: "ordinary_cancellation",
    authority: { kind: "legacy" },
    disposition: { kind: "released", ticketId: "T-001" },
    sessionId,
    sessionStartedAt: "2026-08-01T00:00:00.000Z",
    // The published equation: terminalRevision === transitionStartedRevision + 2.
    transitionStartedRevision: 2,
    stash: { outcome: "popped" },
    endedAt: ENDED_AT,
    terminalRevision: 4,
    shutdownArtifact: { schemaVersion: 1, filename: "cancellation-shutdown.json" },
    ...over,
  };
}

/**
 * A session whose publication landed and whose tail did not: terminal on disk,
 * with a published transition and no completion marker.
 */
function plantUnfinished(
  root: string,
  transition: (sessionId: string) => Record<string, unknown> | undefined,
): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const raw = transition(session.sessionId);
  // Stamped from the real session for the same reason as the live-session
  // fixtures: the gate checks the start time in addition to the id.
  const t = raw && raw.sessionStartedAt === "2026-08-01T00:00:00.000Z"
    ? { ...raw, sessionStartedAt: new Date(session.startedAt).toISOString() }
    : raw;
  writeSessionSync(sessDir, {
    ...session,
    state: "SESSION_END",
    previousState: "IMPLEMENT",
    status: "completed",
    terminationReason: "cancelled",
    mode: "guided",
    ticket: undefined,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
    ...(t ? { cancellationTransition: t } : {}),
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function plantMarker(sessDir: string, content: string): string {
  const path = join(telemetryDirPath(sessDir), "cancellation-complete.json");
  mkdirSync(telemetryDirPath(sessDir), { recursive: true });
  writeFileSync(path, content);
  return path;
}

let root: string;

beforeEach(() => {
  lockFails.value = false;
  markerRace.script = null;
  markerRace.owner = "";
  root = mkdtempSync(join(tmpdir(), "t450-terminal-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("T-450: an unfinished tail on a terminal session is recoverable", () => {
  it("ACCEPTS the cancel and finishes the tail, rather than refusing as already ended", async () => {
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeFalsy();
    // The completion marker is the whole point: it is what says the tail is
    // durably done, and its absence is what made this session recoverable.
    expect(classifyCompletionMarker(sessDir, TID).kind).toBe("matching");
  });

  it("writes the shutdown artifact under the ORIGINAL transitionId", async () => {
    // The evidence pointer. Recovery finishes an authorized transition; it does
    // not start one, so every artifact it writes is keyed to that transition.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const artifact = JSON.parse(
      readFileSync(join(telemetryDirPath(sessDir), "cancellation-shutdown.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(artifact.transitionId).toBe(TID);
  });

  it("repeats NONE of the destructive half: no pop, and the ticket is untouched", async () => {
    // The tail is idempotent; the head is not. Recovery re-runs only the tail.
    const { sessionId } = plantUnfinished(root, publishedTransition);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
    const ticket = JSON.parse(
      readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(ticket.status).toBe("inprogress");
  });

  it("writes the ended marker with the transition's RECORDED endedAt, not now", async () => {
    // The session ended when it ended. A recovery pass stamping its own clock
    // would move a termination time that is already durable, and the audit
    // would then disagree with the transition record it came from.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const ended = JSON.parse(
      readFileSync(join(telemetryDirPath(sessDir), "ended"), "utf-8"),
    ) as Record<string, unknown>;
    expect(ended.timestamp).toBe(ENDED_AT);
    expect(ended.transitionId).toBe(TID);
  });

  it("recovers a marker that is OURS but wrong, rather than leaving it wrong", async () => {
    // `owned-mismatched` names our transition and fails its own shape rules, so
    // ownership is proven and nothing another writer owns is at risk.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    plantMarker(sessDir, JSON.stringify({ transitionId: TID, schemaVersion: 99 }));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeFalsy();
    expect(classifyCompletionMarker(sessDir, TID).kind).toBe("matching");
  });

  it("stamps the audit event with the RECORDED terminal revision and prior state", async () => {
    // The session no longer knows either of these. Its revision has moved past
    // the one write 4 produced, and its `state` is SESSION_END rather than the
    // state cancellation interrupted. Stamping today's values would append an
    // audit event that misattributes the termination, and one the postcondition
    // could not match against the transition it belongs to.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const events = readFileSync(join(sessDir, "events.log"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const cancelled = events.filter((e) => e.type === "cancelled");
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled[cancelled.length - 1]!.rev).toBe(4);
    expect((cancelled[cancelled.length - 1]!.data as Record<string, unknown>).previousState).toBe("IMPLEMENT");
  });

  it("PRESERVES an identifier-free resume marker, which only a first pass may delete", async () => {
    // Same asymmetry as the ended marker, and the same reason. A first pass may
    // delete an id-free marker because it provably runs before any newer
    // session could have written one. A recovery pass has no such proof, and
    // deleting it would silently disable a LIVE session's resume.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    const markerPath = join(root, ".claude", "rules", "autonomous-resume.md");
    writeFileSync(markerPath, "# resume\n\nno session id here\n");

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(existsSync(markerPath)).toBe(true);
    const artifact = JSON.parse(
      readFileSync(join(telemetryDirPath(sessDir), "cancellation-shutdown.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(artifact.resumeMarker).toBe("preserved-unstructured");
  });

  it("does not clobber a status file that names a DIFFERENT live session", async () => {
    // `buildInactivePayload()` carries no sessionId, so a status refresh here
    // would blank the file with no way to tell whose session it described. A
    // later session that became active in the meantime would vanish from
    // status.json while still running. Recovery writes no session state, so it
    // has no business refreshing a file derived from session state.
    const { sessionId } = plantUnfinished(root, publishedTransition);
    const statusPath = join(root, ".story", "status.json");
    const other = JSON.stringify({ active: true, sessionId: "some-other-live-session" }, null, 2);
    writeFileSync(statusPath, other);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(readFileSync(statusPath, "utf-8")).toBe(other);
  });
});

describe("T-450: the exception is fail closed, and every refusal names its condition", () => {
  it("REFUSES a marker it could not READ, because unreadable is not absent", async () => {
    // The whole protocol turns on this distinction. Treating a read failure as
    // absence would let recovery proceed and write over a marker it never saw.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    // A directory at the marker path: it exists, it is not a symlink, and
    // reading it answers EISDIR.
    mkdirSync(join(telemetryDirPath(sessDir), "cancellation-complete.json"), { recursive: true });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("could not be read");
  });

  it("REFUSES to adopt an identifier-free ended marker, which only a first pass may do", async () => {
    // `markEnded`'s first pass may adopt a legacy-shaped marker because it
    // provably runs before this transition wrote one. By recovery time that
    // reasoning is gone: an identifier-free marker could belong to anyone. So
    // the ended postcondition goes unmet, and the completion marker, which
    // attests that ALL postconditions hold, is not written.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });
    writeFileSync(
      join(telemetryDirPath(sessDir), "ended"),
      JSON.stringify({ reason: "cancelled", timestamp: "2026-07-01T00:00:00.000Z" }),
    );

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    // The cancel itself is accepted -- the tail ran, and what it could finish it
    // finished. What it may NOT do is CLAIM completion: the reply says the
    // shutdown is still incomplete, names the postcondition that failed, and
    // says the transition stays recoverable.
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).toContain("NOT complete");
    expect(text).toContain("ended-marker");
    // The gate is still open here -- the completion marker is absent -- so the
    // retry advice is the one case where promising a retry is true.
    expect(text).toContain("re-issuing cancel will retry");
    expect(classifyCompletionMarker(sessDir, TID).kind).toBe("absent");
    // And the reason survives to whoever finds the transition unfinished.
    const artifact = JSON.parse(
      readFileSync(join(telemetryDirPath(sessDir), "cancellation-shutdown.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(String(artifact.detail)).toContain("ended-marker");
  });

  it("does NOT duplicate the audit record when the tail is re-run", async () => {
    // `events.log` is append-only. A recovery that re-appends leaves two
    // `cancelled` records for one cancellation, and a reader cannot tell a
    // retry from a second cancel. The record carries its transitionId, which is
    // what makes skipping it safe rather than merely quiet.
    //
    // The legacy-shaped ended marker keeps the tail INCOMPLETE, so a second
    // cancel is still authorized and actually re-runs it. Without that, the
    // first pass would write the completion marker and the second would refuse.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });
    writeFileSync(
      join(telemetryDirPath(sessDir), "ended"),
      JSON.stringify({ reason: "cancelled", timestamp: "2026-07-01T00:00:00.000Z" }),
    );

    await handleAutonomousGuide(root, { action: "cancel", sessionId });
    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const cancelled = readFileSync(join(sessDir, "events.log"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0]!.data as Record<string, unknown>).transitionId).toBe(TID);
  });

  it("keeps the retry promise and the gate in agreement", async () => {
    // The advice after an incomplete tail must not promise a retry the gate
    // would refuse, so it RE-CLASSIFIES the completion marker rather than
    // assuming the classification authorization saw.
    //
    // WHAT THIS TEST REACHES: the `absent` branch, which is the one that
    // genuinely promises a retry, and the proof that the promise is kept. The
    // closed-gate branches are reached by the race test below, which stages the
    // mid-tail change at the module seam because nothing on disk can produce
    // that ordering.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });
    writeFileSync(
      join(telemetryDirPath(sessDir), "ended"),
      JSON.stringify({ reason: "cancelled", timestamp: "2026-07-01T00:00:00.000Z" }),
    );

    const first = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(JSON.stringify(first)).toContain("re-issuing cancel will retry");
    // The promise is kept: the gate really is still open.
    const second = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(second.isError).toBeFalsy();

    // And once a foreign marker exists, the gate closes and the refusal names
    // it -- the same fact the advice would have reported, reached through the
    // path this suite can actually construct.
    plantMarker(sessDir, JSON.stringify({ schemaVersion: 1, transitionId: OTHER_TID, completedAt: ENDED_AT }));
    const third = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(third.isError).toBeTruthy();
    expect(JSON.stringify(third)).toContain(OTHER_TID);
  });

  it("appends NO audit record when the lock cannot be taken, and reports incomplete", async () => {
    // Appending outside the lock would defeat the serialization at exactly the
    // moment it matters: the holder may already have read the event as absent
    // and be about to append, so both would write. Failing closed costs
    // nothing, because the unmet postcondition keeps the transition
    // recoverable and a later pass appends the record. It is DEFERRED, not
    // lost -- which is only true because this recovery path exists.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    lockFails.value = true;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(existsSync(join(sessDir, "events.log"))).toBe(false);
    expect(classifyCompletionMarker(sessDir, TID).kind).toBe("absent");
    expect(JSON.stringify(result)).toContain("NOT complete");

    // And the deferral is real: with the lock available, a later pass lands it.
    lockFails.value = false;
    await handleAutonomousGuide(root, { action: "cancel", sessionId });
    const cancelled = readFileSync(join(sessDir, "events.log"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type === "cancelled");
    expect(cancelled).toHaveLength(1);
  });

  it("will not let ANOTHER transition's audit record satisfy this one's postcondition", async () => {
    // The read-back exists to prove OUR record landed. Matching on type and
    // revision alone would let a `cancelled` event belonging to a different
    // transition certify a record that was in fact never written, and the
    // completion marker would then attest to an audit trail that has no entry
    // for this cancellation. The telemetry read-back was bound to the
    // transition for exactly this reason; this is the same defect in the other
    // half of the pair.
    //
    // The lock is forced unavailable so our own append genuinely does not
    // happen, which is what makes the foreign record the only candidate.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    writeFileSync(join(sessDir, "events.log"), JSON.stringify({
      rev: 4, type: "cancelled", timestamp: ENDED_AT,
      data: { previousState: "IMPLEMENT", transitionId: OTHER_TID },
    }) + "\n");
    lockFails.value = true;

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(JSON.stringify(result)).toContain("NOT complete");
    expect(classifyCompletionMarker(sessDir, TID).kind).toBe("absent");
  });

  it("does NOT promise a retry once the gate has closed underneath it", async () => {
    // Authorization saw `absent` and the tail ran; by the time the reply is
    // composed a competing writer has left a marker of its own. Promising a
    // retry there would be the same untruth as reporting a completion that did
    // not occur, moved one sentence over: the next `authorizeTailRecovery` will
    // REFUSE a foreign marker. So the classification is re-read rather than
    // remembered.
    const { sessionId } = plantUnfinished(root, publishedTransition);
    // Keeps the tail incomplete so the advice is reached at all.
    mkdirSync(telemetryDirPath(join(root, ".story", "sessions", sessionId)), { recursive: true });
    writeFileSync(
      join(telemetryDirPath(join(root, ".story", "sessions", sessionId)), "ended"),
      JSON.stringify({ reason: "cancelled", timestamp: "2026-07-01T00:00:00.000Z" }),
    );
    // Call 1 is authorization (real: absent). Call 2 is the advice.
    markerRace.owner = OTHER_TID;
    markerRace.script = ["actual", "foreign"];

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const text = JSON.stringify(result);
    expect(text).toContain("NOT complete");
    expect(text).toContain(OTHER_TID);
    expect(text).toContain("refused until it is inspected");
    expect(text).not.toContain("re-issuing cancel will retry");
  });

  it("REFUSES when this session's own startedAt cannot be read", async () => {
    // The id is the REUSABLE half of the identity: a directory outlives the
    // session that made it. Dropping the provenance check when provenance
    // cannot be established drops it exactly where it was load-bearing.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    const raw = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as Record<string, unknown>;
    raw.startedAt = "not a date";
    writeFileSync(join(sessDir, "state.json"), JSON.stringify(raw, null, 2));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("provenance");
    expect(existsSync(join(telemetryDirPath(sessDir), "cancellation-complete.json"))).toBe(false);
  });

  it("REFUSES when the tail is already attested complete", async () => {
    // `matching` is the ordinary case: this is a session that cancelled
    // cleanly, and the legacy refusal is the correct answer for it.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    plantMarker(sessDir, JSON.stringify({ schemaVersion: 1, transitionId: TID, completedAt: ENDED_AT }));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("already ended");
  });

  it("REFUSES a FOREIGN marker and leaves it byte-for-byte intact", async () => {
    // A valid marker naming another transition is durable evidence that a
    // different cancellation ran here. Overwriting it would destroy the only
    // trace of a conflict worth surfacing.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    const foreign = JSON.stringify({ schemaVersion: 1, transitionId: OTHER_TID, completedAt: ENDED_AT });
    const path = plantMarker(sessDir, foreign);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain(OTHER_TID);
    expect(readFileSync(path, "utf-8")).toBe(foreign);
  });

  it("REFUSES a MALFORMED marker rather than assuming it is ours", async () => {
    // A marker with no readable transitionId proves ownership in neither
    // direction. Repairing it would claim a transition we cannot show it
    // belongs to; declaring completion over it would attest to a tail nothing
    // recorded.
    const { sessionId, sessDir } = plantUnfinished(root, publishedTransition);
    const junk = "{ not json at all";
    const path = plantMarker(sessDir, junk);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("malformed");
    expect(readFileSync(path, "utf-8")).toBe(junk);
  });

  it("REFUSES when the transition names a DIFFERENT session", async () => {
    // Identity binds on sessionId. A record copied or misfiled into this
    // session's directory authorizes nothing here.
    const { sessionId } = plantUnfinished(root, () => publishedTransition(OTHER_SESSION));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    // The refusal names the identity mismatch, not some earlier condition that
    // happened to fire first.
    expect(JSON.stringify(result)).toContain(OTHER_SESSION);
  });

  it("REFUSES a published record whose revisions do not satisfy the equation", async () => {
    // terminalRevision === transitionStartedRevision + 2 is the published
    // arm's shape check: write 3 and write 4 are the only writes after tSR.
    // A record that violates it was not produced by this protocol's write
    // sequence, and finishing its tail would attest artifacts to a transition
    // whose own arithmetic says it is not what it claims.
    const { sessionId } = plantUnfinished(root, (id) => publishedTransition(id, { terminalRevision: 9 }));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("revision");
  });

  it("REFUSES task authority when the caller is not the recorded caller", async () => {
    const { sessionId } = plantUnfinished(root, (id) => publishedTransition(id, {
      authority: { kind: "task", callerTaskId: "task-original" },
    }));

    const result = await handleAutonomousGuide(root, {
      action: "cancel", sessionId, clientTaskId: "task-somebody-else",
    });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("task-original");
  });

  it("RECOVERS task authority for the recorded caller", async () => {
    const { sessionId, sessDir } = plantUnfinished(root, (id) => publishedTransition(id, {
      authority: { kind: "task", callerTaskId: "task-original" },
    }));

    const result = await handleAutonomousGuide(root, {
      action: "cancel", sessionId, clientTaskId: "task-original",
    });

    expect(result.isError).toBeFalsy();
    expect(classifyCompletionMarker(sessDir, TID).kind).toBe("matching");
  });

  it("REFUSES a terminal session whose transition never reached publication", async () => {
    // Contradictory: publication is what makes a session terminal. A terminal
    // session holding a `stash_pending` record was terminated by something
    // other than this protocol, and the tail this branch knows how to finish is
    // not the tail that was interrupted.
    const { sessionId } = plantUnfinished(root, (id) => ({
      phase: "stash_pending", transitionId: TID, action: "ordinary_cancellation",
      authority: { kind: "legacy" }, disposition: { kind: "released", ticketId: "T-001" },
      sessionId: id, sessionStartedAt: "2026-08-01T00:00:00.000Z",
      transitionStartedRevision: 1, stash: { outcome: null },
    }));

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
  });

  it("REFUSES a terminal session with no transition record at all", async () => {
    // The legacy shape. There is no recorded tail to finish, and no authority
    // under which to finish one.
    const { sessionId, sessDir } = plantUnfinished(root, () => undefined);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("already ended");
    expect(existsSync(join(telemetryDirPath(sessDir), "cancellation-complete.json"))).toBe(false);
  });
});
