/**
 * T-450 step 7b -- the guide caller for an owner-gone candidate takeover of a
 * LIVE, non-COMPACT session.
 *
 * Three things are under test and they fail in different directions:
 *
 *  - THE INPUT SURFACE. A confirmation object accepted and DISCARDED is the
 *    worst outcome available, because the caller has already told a human the
 *    takeover was authorized on the picture they confirmed. Every misuse
 *    refuses at the boundary, before any mutation, at both boundaries alike.
 *  - THE SPLIT. The COMPACT resume body applies preCompactState recovery,
 *    clears compactPending, resets pressure and removes the resume marker.
 *    Applying any of that to a mid-IMPLEMENT session corrupts it, so the
 *    candidate path is a separate handler and every REFUSED non-candidate
 *    resume of a live non-COMPACT session leaves the session file
 *    byte-identical. (An ordinary COMPACT resume mutates on purpose; that is
 *    the path this one exists to stay out of.)
 *  - NO STAGE SIDE EFFECTS. `CompleteStage.enter` writes state unconditionally
 *    and `FinalizeStage.enter` runs git and can fast-forward into
 *    `handleCommit`, so the directive is purely rendered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, existsSync, chmodSync } from "node:fs";
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
import { gitHead, gitStatus, gitIsAncestor, gitStash } from "../../src/autonomous/git-inspector.js";
import { createSession, writeSessionSync, readSession, prepareForCompact, isLeaseExpired } from "../../src/autonomous/session.js";
import {
  telemetryDirPath,
  readOwnerLiveness,
  evidenceFingerprint,
  OWNER_STALE_MS,
  type OwnableLivenessState,
} from "../../src/autonomous/liveness.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const FINGERPRINT_SHAPE = /^[a-f0-9]{64}$/;
const A_VALID_FINGERPRINT = "a".repeat(64);
const OWNER = { client: "claude", id: "the-dead-owner-task", boundAt: "2026-08-03T00:00:00.000Z" } as const;
const CALLER = "the-recovering-task";
/** A chmod that does not actually deny would exercise a different branch under
 * the same test name, so skip rather than lie. */
const canDenyRead = typeof process.getuid === "function" && process.getuid() !== 0;

let root: string;
let sessDir: string;
let sessionId: string;
let cachedDeadPid: number | null = null;

/** A pid that is genuinely free: spawned, run to completion, reaped, confirmed. */
function deadPid(): number {
  if (cachedDeadPid !== null) return cachedDeadPid;
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof child.pid !== "number") throw new Error("could not allocate a pid to reap");
  try {
    process.kill(child.pid, 0);
    throw new Error(`pid ${child.pid} is still live, so it cannot stand in for a dead one`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  cachedDeadPid = child.pid;
  return cachedDeadPid;
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
    title: "test", date: "2026-08-03",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "inprogress",
    phase: "p1", order: 10, description: "", createdDate: "2026-08-03",
    blockedBy: [], parentTicket: null, completedDate: null,
    updatedAt: "2026-08-03T00:00:00.000Z",
  }));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

/**
 * A LIVE, non-COMPACT session whose recorded owner is a confirmed candidate for
 * being gone: stale activity, a dead recorded MCP pid, a shutdown marker with a
 * past mtime and a dead sidecar pid -- and a LEASE THAT IS STILL LIVE, which is
 * the whole subject of this ticket.
 */
function makeCandidateSession(over: Partial<FullSessionState> = {}): FullSessionState {
  const session = createSession(root, "coding", "test-workspace");
  sessionId = session.sessionId;
  sessDir = join(root, ".story", "sessions", sessionId);

  const staleAt = new Date(Date.now() - OWNER_STALE_MS - 10 * 60_000).toISOString();
  const written = writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    status: "active",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123", itemBaseHead: "abc123" },
    ownerTask: OWNER,
    lease: {
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      lastHeartbeat: staleAt,
    },
    lastGuideCall: staleAt,
    mcpServerPid: deadPid(),
    mcpGuideCallAt: staleAt,
    claimEpoch: {
      ticketId: "T-001",
      sessionId: session.sessionId,
      user: null,
      branch: null,
      since: null,
      establishedAt: staleAt,
    },
    ...over,
  } as FullSessionState);

  // The ledger side of a held claim. A claim-bearing posture refuses a session
  // that is ON a ticket but cannot PROVE the claim is its own, so the fixture
  // has to carry the pair the pipeline itself writes: the session stamp on the
  // ticket and a matching epoch in state. The all-null epoch is the legitimate
  // "no claim key existed at acquisition" shape, and it matches a ticket
  // carrying the stamp and no `claim` record.
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "inprogress",
    phase: "p1", order: 10, description: "", createdDate: "2026-08-03",
    blockedBy: [], parentTicket: null, completedDate: null,
    updatedAt: "2026-08-03T00:00:00.000Z",
    claimedBySession: sessionId,
  }));

  const tDir = telemetryDirPath(sessDir);
  mkdirSync(tDir, { recursive: true });
  const marker = join(tDir, "shutdown");
  writeFileSync(marker, staleAt);
  const at = new Date(Date.parse(staleAt));
  utimesSync(marker, at, at);
  writeFileSync(join(tDir, "sidecar.pid"), String(deadPid()));

  return written;
}

/** What a completed item looks like in the ledger: released, and closed. */
function releaseLedgerClaim(): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "complete",
    phase: "p1", order: 10, description: "", createdDate: "2026-08-03",
    blockedBy: [], parentTicket: null, completedDate: "2026-08-03",
    updatedAt: "2026-08-03T00:00:00.000Z",
  }));
}

/** The picture a caller would have been SHOWN, computed the way the guide does. */
function shown(): { revision: number; fingerprint: string } {
  const state = readSession(sessDir);
  if (!state) throw new Error("fixture session is unreadable");
  const verdict = readOwnerLiveness(
    sessDir,
    () => state as unknown as OwnableLivenessState,
    Date.now(),
    OWNER_STALE_MS,
    () => ({ kind: "observed", servers: [] }),
  );
  if (verdict.kind !== "gone-candidate") {
    throw new Error(`fixture is ${verdict.kind}, not gone-candidate`);
  }
  return { revision: state.revision, fingerprint: evidenceFingerprint(verdict.signals) };
}

const guide = (args: Record<string, unknown>) =>
  handleAutonomousGuide(root, { clientTaskId: CALLER, ...args } as never);

const textOf = (r: { content: readonly { text?: string }[] }): string =>
  r.content.map((c) => c.text ?? "").join("\n");

const rawState = (): string => readFileSync(join(sessDir, "state.json"), "utf-8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-7b-"));
  setupProject(root);
});

afterEach(async () => {
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// 7b.1 -- the input surface
// ---------------------------------------------------------------------------

describe("T-450 7b.1: the confirmation is validated at the boundary, never discarded", () => {
  const picture = { sessionRevision: 1, evidenceFingerprint: A_VALID_FINGERPRINT };

  it("refuses the field on a non-resume action", async () => {
    makeCandidateSession();
    const r = await guide({ sessionId, action: "report", report: { completedAction: "x" }, ownerGoneCandidateTakeover: picture });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('only valid with action "resume"');
  });

  it("refuses the field without takeover: true", async () => {
    makeCandidateSession();
    const before = rawState();
    const r = await guide({ sessionId, action: "resume", ownerGoneCandidateTakeover: picture });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("requires takeover: true");
    expect(rawState()).toBe(before);
  });

  it.each([
    ["a malformed fingerprint", { sessionRevision: 1, evidenceFingerprint: "not-a-digest" }],
    ["an uppercase fingerprint", { sessionRevision: 1, evidenceFingerprint: "A".repeat(64) }],
    ["a negative revision", { sessionRevision: -1, evidenceFingerprint: A_VALID_FINGERPRINT }],
    ["a fractional revision", { sessionRevision: 1.5, evidenceFingerprint: A_VALID_FINGERPRINT }],
    ["a non-finite revision", { sessionRevision: Number.POSITIVE_INFINITY, evidenceFingerprint: A_VALID_FINGERPRINT }],
    ["an unknown extra key", { sessionRevision: 1, evidenceFingerprint: A_VALID_FINGERPRINT, extra: true }],
  ])("refuses %s at the DIRECT guide boundary, not only at the MCP schema", async (_label, bad) => {
    makeCandidateSession();
    const before = rawState();
    const r = await guide({ sessionId, action: "resume", takeover: true, ownerGoneCandidateTakeover: bad });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("ownerGoneCandidateTakeover is malformed");
    expect(rawState()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7b.2 -- the split
// ---------------------------------------------------------------------------

describe("T-450 7b.2: the split", () => {
  it("refuses the field on a COMPACT session rather than silently ignoring it", async () => {
    makeCandidateSession({ state: "COMPACT", compactPending: true, preCompactState: "IMPLEMENT" } as never);
    const before = rawState();

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: 1, evidenceFingerprint: A_VALID_FINGERPRINT },
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("already the confirmed-owner-gone path");
    expect(rawState()).toBe(before);
  });

  it("leaves an ordinary non-candidate resume of a live session byte-identical", async () => {
    makeCandidateSession();
    const before = rawState();

    const r = await guide({ sessionId, action: "resume", takeover: true });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not in COMPACT state");
    expect(rawState()).toBe(before);
  });

  it("replaces a near-expiry lease with the canonical ownership fence", async () => {
    // WHY THE FENCE IS RE-STAMPED AT ALL. The conjunct only proves the lease
    // was live when the takeover STARTED, and staging a heartbeat generation
    // blocks on a child's readiness -- so a lease with little left can expire
    // inside that window, and an expired fence on a freshly recovered session
    // is adoptable by any other task through `adoptExpiredLease` on its very
    // next call. The takeover therefore publishes its own fence
    // UNCONDITIONALLY, which is what this pins; it does not try to reproduce
    // the expiry race, which no stable test can.
    //
    // Pinned DETERMINISTICALLY rather than by racing a real clock. The fixture
    // lease has five minutes left -- enough headroom that no scheduler hiccup
    // can expire it before the conjunct is evaluated -- and the canonical fence
    // is forty-five, so an INHERITED lease and a RE-STAMPED one are far apart
    // and the assertion never has to be tight.
    const nearExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
    makeCandidateSession({
      lease: {
        expiresAt: nearExpiry,
        lastHeartbeat: new Date(Date.now() - 90 * 60_000).toISOString(),
      },
    } as never);
    const { revision, fingerprint } = shown();

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
    });

    expect(textOf(r)).toContain("is now yours");
    const after = readSession(sessDir)!;
    expect(isLeaseExpired(after)).toBe(false);
    // Re-stamped, not inherited.
    expect(after.lease!.expiresAt).not.toBe(nearExpiry);
    expect(Date.parse(after.lease!.expiresAt!) - Date.now()).toBeGreaterThan(40 * 60_000);
    // The activity stamp moves too: the liveness verdict reads `lastGuideCall`
    // as ACTIVITY, so a new owner published under the dead owner's stale
    // timestamp reads as stale itself and invites a second takeover of the
    // session that was just recovered.
    expect(Date.parse(after.lastGuideCall!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("falls through to the existing gate when the lease is EXPIRED", async () => {
    // The live-lease conjunct is the SCOPE boundary, not a safety mechanism: an
    // authorized candidate commit would re-stamp the fence either way. What it
    // holds is that this door answers the question the ticket is about, a LIVE
    // non-COMPACT lease. The expired-lease case already has `adoptExpiredLease`
    // and stays with ISS-964.
    makeCandidateSession({ lease: { expiresAt: new Date(Date.now() - 60_000).toISOString(), lastHeartbeat: new Date(Date.now() - 90 * 60_000).toISOString() } } as never);
    const before = rawState();
    const { revision, fingerprint } = shown();

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
    });

    expect(r.isError).toBe(true);
    // The EXISTING message, not a candidate refusal: this never reached the
    // candidate handler at all.
    expect(textOf(r)).toContain("not in COMPACT state");
    expect(rawState()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7b.3 -- the flow
// ---------------------------------------------------------------------------

describe("T-450 7b.3: the flow", () => {
  it("commits ownership, the generation and the postimage, and renders a directive", async () => {
    makeCandidateSession();
    const { revision, fingerprint } = shown();

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
    });

    expect(textOf(r)).toContain("is now yours");
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain("IMPLEMENT");

    const after = readSession(sessDir)!;
    expect(after.ownerTask?.id).toBe(CALLER);
    expect(after.candidateTakeover).toBeTruthy();
    expect(after.heartbeatGeneration).toBeTruthy();
    // The session's WORK is untouched: only who is driving it changed.
    expect(after.state).toBe("IMPLEMENT");
    expect(after.ticket?.id).toBe("T-001");
    expect(after.compactPending).toBeFalsy();
  });

  it("appends candidate_takeover naming both owners and the generation", async () => {
    makeCandidateSession();
    const { revision, fingerprint } = shown();
    await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
    });

    const events = readFileSync(join(sessDir, "events.log"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const event = events.find((e) => e.type === "candidate_takeover");
    expect(event).toBeTruthy();
    expect(event.data.takeoverKind).toBe("owner_gone_candidate_takeover");
    // Captured BEFORE the commit: afterwards state names the NEW owner.
    expect(event.data.priorOwnerTask.id).toBe(OWNER.id);
    expect(event.data.newOwnerTask.id).toBe(CALLER);
    expect(event.data.heartbeatGeneration).toBeTruthy();
    expect(event.data.cycleNonce).toBeTruthy();
  });

  it("a crash retry VERIFIES the durable postimage rather than being refused as caller-is-owner", async () => {
    makeCandidateSession();
    const { revision, fingerprint } = shown();
    const picture = { sessionRevision: revision, evidenceFingerprint: fingerprint };
    await guide({ sessionId, action: "resume", takeover: true, ownerGoneCandidateTakeover: picture });

    const afterFirst = readSession(sessDir)!;
    // A CRASH between the durable postimage and the intent close: the postimage
    // is on disk and the intent is still open. Re-opening it is exactly that
    // state, and it is the state the commit's step 2 exists for.
    const intentFile = join(sessDir, "cancellation-intent.json");
    const intent = JSON.parse(readFileSync(intentFile, "utf-8"));
    // The `closed` arm carries an `outcome` the `authorized` arm forbids
    // (the union is strict), so reopening means dropping it.
    delete intent.outcome;
    intent.phase = "authorized";
    writeFileSync(intentFile, JSON.stringify(intent));

    const r = await guide({ sessionId, action: "resume", takeover: true, ownerGoneCandidateTakeover: picture });

    expect(textOf(r)).toContain("is now yours");
    expect(textOf(r)).toContain("already landed");
    const afterSecond = readSession(sessDir)!;
    // VERIFY, NEVER REDO: no second state write.
    expect(afterSecond.revision).toBe(afterFirst.revision);

    const events = readFileSync(join(sessDir, "events.log"), "utf-8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const resumed = events.find((e) => e.type === "candidate_takeover_resumed");
    expect(resumed).toBeTruthy();
    // NO priorOwnerTask (state already names the new owner) and NO
    // committedRevision claim (this path reports the CURRENT state, possibly
    // many revisions after the original write).
    expect(resumed.data.priorOwnerTask).toBeUndefined();
    // And the DIRECTIVE must agree with the audit record: on this path
    // `info.state` already names the caller, so rendering it as the previous
    // owner would tell the operator they took the session over from themselves.
    expect(textOf(r)).not.toContain(`Previous owner: claude:${CALLER}`);
    expect(textOf(r)).toContain("not recoverable here");
    expect(resumed.data.committedRevision).toBeUndefined();
    expect(events.filter((e) => e.type === "candidate_takeover")).toHaveLength(1);
  });

  it("refuses without a caller identity, in the SAME words as the other takeover door", async () => {
    makeCandidateSession();
    const { revision, fingerprint } = shown();
    const before = rawState();

    const r = await handleAutonomousGuide(root, {
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
    } as never);

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("requires a valid clientTaskId");
    expect(rawState()).toBe(before);
  });

  it("returns re-confirm with FRESH evidence when the picture moved, and mutates nothing", async () => {
    makeCandidateSession();
    const { revision } = shown();
    const before = rawState();

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: A_VALID_FINGERPRINT },
    });

    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain("The picture changed");
    // Fresh evidence goes back so the client re-presents rather than starting
    // over blind.
    expect(text).toMatch(new RegExp(`evidenceFingerprint: "${FINGERPRINT_SHAPE.source.slice(1, -1)}"`));
    expect(rawState()).toBe(before);
  });

  it("a refused takeover never STAGES a heartbeat generation", async () => {
    // This is what the pre-check is FOR. The commit's first act stages a
    // generation, which spawns a child and blocks on its readiness; running it
    // before the handshake is even plausible would spawn-and-kill a process on
    // every refused takeover. Without the pre-check nothing here is incorrect,
    // only wasteful -- which is exactly why it needs a test of its own rather
    // than riding on a correctness assertion.
    makeCandidateSession();
    const { fingerprint } = shown();

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: 999, evidenceFingerprint: fingerprint },
    });

    expect(r.isError).toBe(true);
    expect(existsSync(join(telemetryDirPath(sessDir), "generations"))).toBe(false);
  });

  it("returns re-confirm when the REVISION moved, and mutates nothing", async () => {
    makeCandidateSession();
    const { fingerprint } = shown();
    const before = rawState();

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: 999, evidenceFingerprint: fingerprint },
    });

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("revision-moved");
    expect(rawState()).toBe(before);
  });

  it.skipIf(!canDenyRead)("an UNREADABLE ledger refuses as unreadable, never as a ticket that is absent", async () => {
    // The three-way loader contract: `undefined` means the read FAILED,
    // `null` means it positively resolved to nothing. Collapsing the first into
    // the second tells the authority matrix "there is no ticket" when the truth
    // is "we could not look" -- and at a claim-bearing posture that is the
    // difference between an honest refusal and a wrong one.
    makeCandidateSession();
    const { revision, fingerprint } = shown();
    const ticketsDir = join(root, ".story", "tickets");
    chmodSync(ticketsDir, 0o000);

    let r;
    try {
      r = await guide({
        sessionId, action: "resume", takeover: true,
        ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
      });
    } finally {
      chmodSync(ticketsDir, 0o755);
    }

    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("the ledger ticket could not be read");
    expect(textOf(r)).toContain("a failed read is not a finding that nothing is owed");
  });

  it("refuses when the caller is already the owner", async () => {
    makeCandidateSession({ ownerTask: { client: "claude", id: CALLER, boundAt: "2026-08-03T00:00:00.000Z" } } as never);
    const before = rawState();

    // The picture is computed against a session this caller already owns, so
    // the handshake refuses before anything is written.
    const state = readSession(sessDir)!;
    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: state.revision, evidenceFingerprint: A_VALID_FINGERPRINT },
    });

    expect(r.isError).toBe(true);
    expect(rawState()).toBe(before);
  });

  it("refuses a terminal session", async () => {
    makeCandidateSession({ status: "completed" } as never);
    const before = rawState();
    const state = readSession(sessDir)!;

    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: state.revision, evidenceFingerprint: A_VALID_FINGERPRINT },
    });

    expect(r.isError).toBe(true);
    expect(rawState()).toBe(before);
  });
});

describe("T-450 7b.4: establishment after a takeover", () => {
  it("a later COMPACT resume re-spawns the sidecar into the session's GENERATION", async () => {
    makeCandidateSession();
    const { revision, fingerprint } = shown();
    await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
    });

    const taken = readSession(sessDir)!;
    const generation = taken.heartbeatGeneration as string;
    expect(generation).toBeTruthy();

    const legacyPidFile = join(telemetryDirPath(sessDir), "sidecar.pid");
    // Session CREATION spawned a legacy sidecar, before any generation existed.
    // What matters is that the resume does not write there again.
    const legacyBefore = existsSync(legacyPidFile) ? readFileSync(legacyPidFile, "utf-8") : null;

    prepareForCompact(sessDir, taken, { expectedHead: "abc123" });
    await guide({ sessionId, action: "resume" });

    // Spawning into legacy would attach the NEW owner's heartbeat to the
    // DISPLACED owner's telemetry, which is the confusion generations exist to
    // end.
    const gDir = join(telemetryDirPath(sessDir), "generations", generation);
    expect(existsSync(join(gDir, "sidecar.pid"))).toBe(true);
    expect(existsSync(legacyPidFile) ? readFileSync(legacyPidFile, "utf-8") : null).toBe(legacyBefore);
  });
});

// ---------------------------------------------------------------------------
// No stage side effects
// ---------------------------------------------------------------------------

describe("T-450 7b.3: the directive is purely RENDERED", () => {
  for (const state of ["COMPLETE", "FINALIZE", "VERIFY", "PLAN_REVIEW", "CODE_REVIEW"] as const) {
    it(`takes over at ${state} with exactly one state write and no stage entry`, async () => {
      vi.mocked(gitHead).mockClear();
      vi.mocked(gitStatus).mockClear();
      vi.mocked(gitIsAncestor).mockClear();
      vi.mocked(gitStash).mockClear();
      makeCandidateSession({ state } as never);
      // At COMPLETE the session's claim lifecycle has already ENDED, so the
      // ledger must show it let go -- a stamp still naming this session there
      // is the ledger contradicting the stage, and the matrix refuses it.
      if (state === "COMPLETE") releaseLedgerClaim();
      const { revision, fingerprint } = shown();

      const r = await guide({
        sessionId, action: "resume", takeover: true,
        ownerGoneCandidateTakeover: { sessionRevision: revision, evidenceFingerprint: fingerprint },
      });

      expect(textOf(r)).toContain("is now yours");
      expect(r.isError).toBeFalsy();
      // NO GIT. A revision count alone would not catch this: `FinalizeStage.enter`
      // reads HEAD and can fast-forward into `handleCommit`, and on the mocked
      // path some of that leaves no second state write behind.
      expect(vi.mocked(gitHead)).not.toHaveBeenCalled();
      expect(vi.mocked(gitStatus)).not.toHaveBeenCalled();
      expect(vi.mocked(gitIsAncestor)).not.toHaveBeenCalled();
      expect(vi.mocked(gitStash)).not.toHaveBeenCalled();
      const after = readSession(sessDir)!;
      // ONE write. `CompleteStage.enter` writes state unconditionally and
      // `FinalizeStage.enter` runs git and can fast-forward into handleCommit;
      // either would show up as a second revision bump here.
      expect(after.revision).toBe(revision + 1);
      expect(after.state).toBe(state);
      expect(after.ownerTask?.id).toBe(CALLER);
    });
  }
});
