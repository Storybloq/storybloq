/**
 * T-450 step 5, commit A: a characterization suite for the cancellation tail.
 *
 * WHY THIS EXISTS. Step 5 extracts the tail of `handleCancel` into one helper so
 * candidate cancellation can call it rather than a second spelling of it. That
 * extraction is only as good as the tests that pin it, and a plan review found
 * that the tests I had claimed as pins do not execute this path at all: only
 * three files invoke `action: "cancel"`, and the ones asserting strings like
 * `cancelled` build synthetic objects instead of driving the guide.
 *
 * So this suite is written and passing against the CURRENT code BEFORE the
 * extraction, and is not edited afterwards. A suite written after a refactor
 * characterizes the refactor's output, which proves nothing.
 *
 * HOW TO READ THE ASSERTIONS. Every assertion is labelled:
 *
 *   COMPATIBILITY INVARIANT -- behavior the extraction must preserve and that
 *   step 6 must keep preserving.
 *
 *   DOCUMENTED CURRENT HAZARD -- behavior recorded so a change to it is
 *   VISIBLE. Explicitly NOT an endorsement. This tail is single-attempt and not
 *   retryable: `killSidecar` signals a raw pid with no generation check,
 *   `removeResumeMarker` deletes by path with no session identity, `markEnded`
 *   overwrites its timestamp, and `appendEvent` appends. Nothing here asserts
 *   that any of that is correct; step 6 is where the durable protocol lands.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Call-order recording. Each mock DELEGATES to the real implementation via
// `importOriginal`, so behavior is unchanged and only the order is observed.
// A mock that replaced the implementation would characterize the mock.
const ORDER: string[] = [];

vi.mock("../../src/autonomous/liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/liveness.js")>();
  return {
    ...actual,
    killSidecar: vi.fn((...args: Parameters<typeof actual.killSidecar>) => {
      ORDER.push("killSidecar");
      return actual.killSidecar(...args);
    }),
    writeShutdownMarker: vi.fn((...args: Parameters<typeof actual.writeShutdownMarker>) => {
      ORDER.push("writeShutdownMarker");
      return actual.writeShutdownMarker(...args);
    }),
  };
});

vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  return {
    ...actual,
    appendEvent: vi.fn((...args: Parameters<typeof actual.appendEvent>) => {
      ORDER.push("appendEvent");
      return actual.appendEvent(...args);
    }),
  };
});

vi.mock("../../src/autonomous/telemetry-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/telemetry-writer.js")>();
  return {
    ...actual,
    writeEvent: vi.fn((...args: Parameters<typeof actual.writeEvent>) => {
      const event = args[1] as { type?: string } | undefined;
      if (event?.type === "session_cancelled") ORDER.push("telemetry:session_cancelled");
      return actual.writeEvent(...args);
    }),
    markEnded: vi.fn((...args: Parameters<typeof actual.markEnded>) => {
      ORDER.push("markEnded");
      return actual.markEnded(...args);
    }),
  };
});

// Toggled by the refresh-isolation test only. Off for every other case.
const REFRESH = { fail: false };

vi.mock("../../src/autonomous/status-writer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/status-writer.js")>();
  return {
    ...actual,
    refreshStatusForSession: vi.fn((...args: Parameters<typeof actual.refreshStatusForSession>) => {
      ORDER.push("refreshStatusForSession");
      // DEFENSIVE CONTRACT-VIOLATION INJECTION, used by exactly one test. The
      // real function does not promise to throw; this deliberately breaks that
      // to prove the CALLER's catch keeps the rest of the tail running.
      if (REFRESH.fail) throw new Error("injected refresh failure");
      return actual.refreshStatusForSession(...args);
    }),
  };
});

vi.mock("../../src/autonomous/resume-marker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/resume-marker.js")>();
  return {
    ...actual,
    removeResumeMarker: vi.fn((...args: Parameters<typeof actual.removeResumeMarker>) => {
      ORDER.push("removeResumeMarker");
      return actual.removeResumeMarker(...args);
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

function writeTicket(root: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-08-01",
    completedDate: null, blockedBy: [],
    ...extra,
  }));
}

interface PlantOptions {
  readonly ticketId?: string | null;
  readonly autoStash?: { ref: string; stashedAt: string } | null;
  readonly extra?: Record<string, unknown>;
}

function plantSession(root: string, opts: PlantOptions = {}): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const ticket = opts.ticketId === null
    ? undefined
    : { id: opts.ticketId ?? "T-001", title: "Test ticket", risk: "low", claimed: true };
  writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    ...(ticket ? { ticket } : {}),
    compactPending: true,
    compactPreparedAt: NOW,
    compactObservedAt: NOW,
    resumeBlocked: true,
    git: {
      branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123",
      ...(opts.autoStash ? { autoStash: opts.autoStash } : {}),
    },
    reviews: { plan: [], code: [] },
    ...opts.extra,
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

function readTicket(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
}

/** Every `cancelled` entry in events.log, so "exactly one" is assertable. */
function cancelledEvents(sessDir: string): Record<string, unknown>[] {
  let raw = "";
  try { raw = readFileSync(join(sessDir, "events.log"), "utf-8"); } catch { return []; }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt.type === "cancelled") out.push(evt);
    } catch { /* skip garbage */ }
  }
  return out;
}

function telemetryLines(sessDir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of ["events.jsonl", "telemetry.jsonl"]) {
    let raw = "";
    try { raw = readFileSync(join(sessDir, "telemetry", name), "utf-8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
    }
  }
  return out;
}

function textOf(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("");
}

/** The `session_cancelled` telemetry payload, which carries the same triple. */
function cancelledTelemetryData(sessDir: string): Record<string, unknown> | null {
  const line = telemetryLines(sessDir).find((l) => l.type === "session_cancelled");
  return line ? ((line.data as Record<string, unknown>) ?? {}) : null;
}

/**
 * The disposition triple as persisted in BOTH outputs.
 *
 * Asserted in both because they are written by different code paths
 * (`appendEvent` into events.log, `writeEvent` into telemetry) and a refactor
 * that threaded the disposition into only one of them would still look correct
 * against a single-output assertion.
 */
function expectTriple(
  sessDir: string,
  expected: { ticketId: string | null; released: boolean; conflict: boolean },
): void {
  const events = cancelledEvents(sessDir);
  expect(events).toHaveLength(1);
  const evt = (events[0]?.data as Record<string, unknown>) ?? {};
  expect(evt.ticketId).toBe(expected.ticketId);
  expect(evt.ticketReleased).toBe(expected.released);
  expect(evt.ticketConflict).toBe(expected.conflict);

  const telem = cancelledTelemetryData(sessDir);
  expect(telem, "session_cancelled telemetry missing").not.toBeNull();
  expect(telem?.ticketId).toBe(expected.ticketId);
  expect(telem?.ticketReleased).toBe(expected.released);
  expect(telem?.ticketConflict).toBe(expected.conflict);
}

let root: string;

beforeEach(() => {
  ORDER.length = 0;
  root = mkdtempSync(join(tmpdir(), "t450-cancel-char-"));
  setupProject(root);
  vi.mocked(gitStashPop).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof gitStashPop>>);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("T-450 step 5: the cancellation transition, characterized before extraction", () => {
  it("writes every terminal field and preserves unrelated ones", async () => {
    // COMPATIBILITY INVARIANT. The plan's earlier draft would have published
    // only terminal status, evidence and release disposition, silently dropping
    // the compact clearing, previousState, terminationReason and ticket reset.
    // This is the assertion that would have caught that.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root, { extra: { workspaceId: "ws-keep-me" } });
    const before = readState(sessDir);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    const after = readState(sessDir);
    expect(after.state).toBe("SESSION_END");
    expect(after.previousState).toBe("IMPLEMENT");
    expect(after.status).toBe("completed");
    expect((after as Record<string, unknown>).terminationReason).toBe("cancelled");
    expect(after.compactPending).toBe(false);
    expect((after as Record<string, unknown>).compactPreparedAt).toBeNull();
    expect((after as Record<string, unknown>).compactObservedAt).toBeNull();
    expect((after as Record<string, unknown>).resumeBlocked).toBe(false);
    expect(after.ticket).toBeUndefined();

    // Preservation: fields the transition does not own must survive it.
    expect((after as Record<string, unknown>).workspaceId).toBe("ws-keep-me");
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it("pops the recorded stash ref and reports nothing when it succeeds", async () => {
    // COMPATIBILITY INVARIANT. The stash restore is the ONLY pre-publication
    // effect the tail owns, and it must use the ref the session recorded.
    writeTicket(root);
    const { sessionId } = plantSession(root, {
      autoStash: { ref: "stash@{7}", stashedAt: NOW },
    });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(vi.mocked(gitStashPop)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gitStashPop).mock.calls[0]?.[1]).toBe("stash@{7}");
    expect(textOf(result)).not.toContain("Auto-stash pop failed");
  });

  it("records the failure and appends the stash note when the pop fails", async () => {
    // COMPATIBILITY INVARIANT. A failed pop must not abort cancellation, and it
    // must be visible in BOTH the audit event and the caller's text, because a
    // silent failure strands the user's working changes in a stash they were
    // never told about.
    writeTicket(root);
    vi.mocked(gitStashPop).mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof gitStashPop>>);
    const { sessionId, sessDir } = plantSession(root, {
      autoStash: { ref: "stash@{0}", stashedAt: NOW },
    });

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    expect(readState(sessDir).state).toBe("SESSION_END");
    const events = cancelledEvents(sessDir);
    expect(events).toHaveLength(1);
    expect((events[0]?.data as Record<string, unknown>)?.stashPopFailed).toBe(true);
    expect(textOf(result)).toContain("Auto-stash pop failed");
  });

  it("does not touch the stash when the session recorded none", async () => {
    // COMPATIBILITY INVARIANT.
    writeTicket(root);
    const { sessionId } = plantSession(root);
    await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(vi.mocked(gitStashPop)).not.toHaveBeenCalled();
  });

  it("appends exactly ONE cancelled event, carrying the written revision", async () => {
    // COMPATIBILITY INVARIANT. The event must follow the write because it
    // carries `written.revision`; an event emitted before the write would carry
    // the pre-write revision and misdate the audit trail.
    //
    // "Exactly one" is asserted because `appendEvent` APPENDS. That is also the
    // DOCUMENTED CURRENT HAZARD behind this tail being single-attempt: a rerun
    // would duplicate this entry rather than converge. Nothing here asserts
    // that rerunning is safe.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const events = cancelledEvents(sessDir);
    expect(events).toHaveLength(1);
    expect(events[0]?.rev).toBe(readState(sessDir).revision);
  });

  it("emits session_cancelled telemetry and the ended marker", async () => {
    // COMPATIBILITY INVARIANT. `markEnded` requires an already-persisted
    // SESSION_END, so both of these prove publication happened first.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const cancelled = telemetryLines(sessDir).filter((l) => l.type === "session_cancelled");
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(sessDir, "telemetry", "ended"))).toBe(true);
    const ended = JSON.parse(readFileSync(join(sessDir, "telemetry", "ended"), "utf-8")) as Record<string, unknown>;
    expect(ended.reason).toBe("cancelled");
  });

  it("removes the resume marker", async () => {
    // COMPATIBILITY INVARIANT that removal happens on a successful cancel.
    //
    // DOCUMENTED CURRENT HAZARD: removal is by PATH with no session identity,
    // so a delayed retry would delete a marker belonging to a NEWER session.
    // Recorded, not endorsed. Step 6 scopes this to an identity.
    writeTicket(root);
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
    writeFileSync(join(root, ".claude", "rules", "autonomous-resume.md"), "resume me\n");
    const { sessionId } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(existsSync(join(root, ".claude", "rules", "autonomous-resume.md"))).toBe(false);
  });

  it("runs the post-publication effects in the shipped order", async () => {
    // COMPATIBILITY INVARIANT. The order is observable and the extraction must
    // not reshuffle it: sidecar shutdown before the audit append, the audit
    // append before telemetry, the ended marker after the telemetry event, and
    // resume-marker removal last.
    writeTicket(root);
    const { sessionId } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    const idx = (name: string) => ORDER.lastIndexOf(name);
    // Every effect must have RUN. Without this, a missing effect yields -1 and
    // the `<` comparisons below can pass vacuously, which would let a mutant
    // that deletes an effect survive the very test meant to pin its position.
    for (const name of [
      "refreshStatusForSession", "killSidecar", "writeShutdownMarker", "appendEvent",
      "telemetry:session_cancelled", "markEnded", "removeResumeMarker",
    ]) {
      expect(idx(name), `${name} never ran`).toBeGreaterThanOrEqual(0);
    }
    // 2b before 3: the status refresh happens inside the publishing write, so it
    // precedes every post-publication effect.
    expect(idx("refreshStatusForSession")).toBeLessThan(idx("killSidecar"));
    expect(idx("killSidecar")).toBeLessThan(idx("writeShutdownMarker"));
    expect(idx("writeShutdownMarker")).toBeLessThan(idx("appendEvent"));
    expect(idx("appendEvent")).toBeLessThan(idx("telemetry:session_cancelled"));
    expect(idx("telemetry:session_cancelled")).toBeLessThan(idx("markEnded"));
    expect(idx("markEnded")).toBeLessThan(idx("removeResumeMarker"));
  });

  it("refreshes project status as part of publication", async () => {
    // COMPATIBILITY INVARIANT. The refresh is what makes the cancelled session
    // stop showing as active to every reader outside this process.
    writeTicket(root);
    const { sessionId } = plantSession(root);

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expect(ORDER).toContain("refreshStatusForSession");
    expect(existsSync(join(root, ".story", "status.json"))).toBe(true);
  });

  it("publishes terminal state and finishes the tail even when the refresh fails", async () => {
    // COMPATIBILITY INVARIANT, and the correction that mattered most in review:
    // publication (2a) and refresh (2b) are SEPARATE checkpoints.
    // `writeSessionAndRefresh` writes first, then runs the refresh inside its own
    // best-effort catch, so a refresh failure can neither reverse the terminal
    // write nor suppress the effects after it.
    //
    // The injection is labelled DEFENSIVE CONTRACT-VIOLATION: the real refresh
    // does not promise to throw. This pins the caller's catch, not the callee's.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    REFRESH.fail = true;
    try {
      const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
      expect(result.isError).toBeFalsy();
    } finally {
      REFRESH.fail = false;
    }

    // Publication survived.
    expect(readState(sessDir).state).toBe("SESSION_END");
    expect((readState(sessDir) as Record<string, unknown>).terminationReason).toBe("cancelled");
    // ...and every post-publication effect still ran.
    for (const name of [
      "killSidecar", "writeShutdownMarker", "appendEvent",
      "telemetry:session_cancelled", "markEnded", "removeResumeMarker",
    ]) {
      expect(ORDER, `${name} was suppressed by the refresh failure`).toContain(name);
    }
    expect(cancelledEvents(sessDir)).toHaveLength(1);
  });
});

describe("T-450 step 5: the ticket disposition payload, every reachable arm", () => {
  // COMPATIBILITY INVARIANT for the whole table. The extraction may model
  // disposition as a discriminated union internally, but the PERSISTED payload
  // shape is `{ ticketId, ticketReleased, ticketConflict }` and every arm below
  // pins the exact triple. Changing the audit shape is not behavior-preserving.

  async function cancelAt(plant: PlantOptions = {}): Promise<string> {
    const { sessionId, sessDir } = plantSession(root, plant);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    return sessDir;
  }

  it("released: this session owns the claim", async () => {
    const { sessionId, sessDir } = plantSession(root);
    writeTicket(root, { claimedBySession: sessionId, claim: { user: "me@x", branch: "main", since: NOW } });

    await handleAutonomousGuide(root, { action: "cancel", sessionId });

    expectTriple(sessDir, { ticketId: "T-001", released: true, conflict: false });
    expect(readTicket(root).status).toBe("open");
  });

  it("conflict: a foreign session holds the claim", async () => {
    writeTicket(root, {
      claimedBySession: "ffffffff-0000-0000-0000-000000000009",
      claim: { user: "other@x", branch: "main", since: NOW },
    });
    expectTriple(await cancelAt(), { ticketId: "T-001", released: false, conflict: true });
    expect(readTicket(root).status).toBe("inprogress");
  });

  it("unchanged/missing: the session names a ticket the project does not have", async () => {
    // The release block IS entered (ticketId truthy) but the project lookup
    // finds nothing, so neither flag is set while the id is still reported.
    // A successful no-op, deliberately distinct from a failure.
    expectTriple(await cancelAt(), { ticketId: "T-001", released: false, conflict: false });
  });

  it("unchanged/not-inprogress: the ticket exists but has moved on", async () => {
    writeTicket(root, { status: "complete" });
    expectTriple(await cancelAt(), { ticketId: "T-001", released: false, conflict: false });
    expect(readTicket(root).status).toBe("complete");
  });

  it("unchanged/empty-id: an empty-string ticket id survives as \"\", not null", async () => {
    // The schema is `z.string()` with no `.min(1)`, so "" is valid. The release
    // block's truthy gate skips it, but the payload mapping is `ticketId ?? null`
    // and "" is not nullish, so the shipped payload reports "".
    //
    // This is the arm that separates a nullish mapping from a truthy one. A
    // refactor using `ticketId || null` would turn "" into null and change the
    // audit record with no other test noticing. Verified: that exact mutant is
    // killed by this case and by nothing else in the suite.
    writeTicket(root);
    expectTriple(await cancelAt({ ticketId: "" }), { ticketId: "", released: false, conflict: false });
  });

  it("no-ticket: the session carries no ticket at all", async () => {
    writeTicket(root);
    expectTriple(await cancelAt({ ticketId: null }), { ticketId: null, released: false, conflict: false });
    expect(readTicket(root).status).toBe("inprogress");
  });

  it("not-authorized: a VALID, OWNED epoch for another ticket still suppresses the release", async () => {
    // This one is built to DISCRIMINATE guide.ts:487, and getting there took two
    // attempts worth recording.
    //
    // The epoch must parse (else it dies at :480 instead, proving nothing about
    // the mismatch check). But parsing is not enough: an epoch naming a ticket
    // that does not exist yields a non-held posture by either route, so deleting
    // :487 changes no outcome and the test is green while pinning nothing.
    //
    // So the epoch names a ticket this session GENUINELY OWNS: T-999 carries the
    // session stamp and no claim block, which is exactly what an all-null epoch
    // matches. With :487 present the epoch is rejected for naming a ticket other
    // than the draft, giving `indeterminate`, and the payload reports no ticket
    // at all. Without :487 the posture resolves to `held`, `mayWriteTicket` flips
    // true, and the release is ATTEMPTED against the draft T-001 using a T-999
    // epoch. It does not succeed: `releaseClaimIfOwned` (claims.ts:93) refuses on
    // the id mismatch, so the observed payload becomes
    // `{ ticketId: "T-001", ticketReleased: false, ticketConflict: true }`.
    // Different from the expected `{ null, false, false }` in two of the three
    // fields (`ticketReleased` is false either way), which is what kills it.
    //
    // Worth noting for step 6: the id comparison in `releaseClaimIfOwned` is a
    // SECOND, independent refusal behind :487. Losing :487 alone does not corrupt
    // a ticket; it downgrades a clean "not authorized" into a reported conflict.
    //
    // COMPATIBILITY INVARIANT: authority is scoped to the ticket the session is
    // actually working, not to any ticket it can prove a claim on.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    writeFileSync(join(root, ".story", "tickets", "T-999.json"), JSON.stringify({
      id: "T-999", title: "Other ticket", description: "", type: "task",
      status: "inprogress", phase: "p1", order: 20, createdDate: "2026-08-01",
      completedDate: null, blockedBy: [], claimedBySession: sessionId,
    }));
    const state = readState(sessDir);
    writeSessionSync(sessDir, {
      ...state,
      claimEpoch: {
        ticketId: "T-999", sessionId, establishedAt: NOW,
        user: null, branch: null, since: null,
      },
    } as unknown as FullSessionState);

    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    expectTriple(sessDir, { ticketId: null, released: false, conflict: false });
    // The draft ticket is untouched, which is the point: proving a claim on one
    // ticket must not authorize writing another.
    expect(readTicket(root).status).toBe("inprogress");
  });

  it("not-authorized: a MALFORMED epoch also suppresses the release", async () => {
    // The other route to `indeterminate` (guide.ts:480). Kept as its own case so
    // the two inputs are distinguishable: a refactor that dropped the mismatch
    // check would still pass this one, and a refactor that dropped the parse
    // check would still pass the one above.
    writeTicket(root, {
      claimedBySession: "ffffffff-0000-0000-0000-000000000009",
      claim: { user: "other@x", branch: "main", since: NOW },
    });
    // `since` key absent, which parseClaimEpoch rejects outright rather than
    // degrading to null (an all-null epoch is a legitimate shape that would
    // prove ownership it never had).
    const { sessionId, sessDir } = plantSession(root);
    const state = readState(sessDir);
    writeSessionSync(sessDir, {
      ...state,
      claimEpoch: { ticketId: "T-001", sessionId, establishedAt: NOW, user: null, branch: null },
    } as unknown as FullSessionState);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    expectTriple(sessDir, { ticketId: null, released: false, conflict: false });
    expect(readTicket(root).status).toBe("inprogress");
  });

  it("failed: the release throws, and cancellation still completes", async () => {
    // Production-realistic injection rather than a mock that violates a callee
    // contract: the tickets directory is made unwritable, so the release write
    // genuinely fails inside the block's own try/catch.
    //
    // COMPATIBILITY INVARIANT: a failed release must NOT abort cancellation. The
    // session still reaches SESSION_END. The shipped payload cannot distinguish
    // this from `unchanged`, which is exactly why the extraction models them as
    // separate union arms internally while mapping both to the same triple.
    writeTicket(root);
    const { sessionId, sessDir } = plantSession(root);
    const ticketsDir = join(root, ".story", "tickets");
    chmodSync(ticketsDir, 0o555);
    try {
      const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
      expect(result.isError).toBeFalsy();
    } finally {
      chmodSync(ticketsDir, 0o755);
    }
    expect(readState(sessDir).state).toBe("SESSION_END");
    expectTriple(sessDir, { ticketId: "T-001", released: false, conflict: false });
  });
});
