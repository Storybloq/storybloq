/**
 * T-450 step 8 -- the guide caller for an owner-gone candidate CANCELLATION.
 *
 * The second door onto the step-6b authority layer, and the one that ENDS a
 * session rather than adopting it. Until this exists, a session whose owner is
 * confirmed dead can only be taken over (7b) or stopped through the admin CLI,
 * which is the fail-open ISS-904 was filed about.
 *
 * What is under test, and the direction each thing fails in:
 *
 *  - THE INPUT SURFACE. A confirmation object accepted and DISCARDED is the
 *    worst outcome available: the caller has already told a human the
 *    cancellation was authorized on the picture they confirmed. Every misuse
 *    refuses at the boundary, before any mutation.
 *  - THE SESSION-ID REQUIREMENT. `handleCancel` auto-selects an active session
 *    when `sessionId` is absent, and the confirmation carries a revision and a
 *    fingerprint but NO session identity. Without this rule a human who
 *    confirmed a picture for session A could end session B, and nothing
 *    downstream could tell, because the commit's input id and the evidence
 *    directory would both come from the wrongly selected session and agree.
 *  - THE SPLIT ROUTES ON PRESENCE ALONE. Two earlier drafts added conjuncts
 *    (a live-ownership conflict, a terminal refusal) and both DROPPED the
 *    confirmed field in cases they did not anticipate. The rule they violated:
 *    do not put a gate in front of a resume-first commit, because a gate
 *    cannot see the durable records that make a retry legitimate.
 *  - THE REFUSALS SAY THE RIGHT THING. The shared refusal renderer was written
 *    for takeover and names `ownerGoneCandidateTakeover` in its retry
 *    instruction. Handed to a cancel caller unchanged, it would instruct them
 *    to ADOPT a session they had confirmed they wanted ENDED.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from "node:fs";
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
import { createSession, writeSessionSync, readSession } from "../../src/autonomous/session.js";
import {
  telemetryDirPath,
  readOwnerLiveness,
  evidenceFingerprint,
  OWNER_STALE_MS,
  type OwnableLivenessState,
} from "../../src/autonomous/liveness.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const A_VALID_FINGERPRINT = "a".repeat(64);
const OWNER = { client: "claude", id: "the-dead-owner-task", boundAt: "2026-08-03T00:00:00.000Z" } as const;
const CALLER = "the-recovering-task";

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
  writeTicket({ status: "inprogress", claimedBySession: null });
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function writeTicket(over: { status: string; claimedBySession: string | null }): void {
  const base: Record<string, unknown> = {
    id: "T-001", title: "Test ticket", type: "task", status: over.status,
    phase: "p1", order: 10, description: "", createdDate: "2026-08-03",
    blockedBy: [], parentTicket: null,
    completedDate: over.status === "complete" ? "2026-08-03" : null,
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  if (over.claimedBySession !== null) base.claimedBySession = over.claimedBySession;
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify(base));
}

/**
 * A session whose recorded owner is a confirmed candidate for being gone:
 * stale activity, a dead recorded MCP pid, a shutdown marker with a past mtime
 * and a dead sidecar pid.
 *
 * The lease is LIVE by default, which is the cell 7b's takeover door and this
 * cancel door both serve. `leaseExpired` flips it, which is the case revision 1
 * of the plan silently dropped.
 */
function makeCandidateSession(
  over: Partial<FullSessionState> = {},
  opts: { leaseExpired?: boolean } = {},
): FullSessionState {
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
      expiresAt: opts.leaseExpired
        ? new Date(Date.now() - 60_000).toISOString()
        : new Date(Date.now() + 30 * 60_000).toISOString(),
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

  // The ledger side of a held claim: the session stamp on the ticket, matching
  // the all-null epoch in state. A claim-bearing posture refuses a session that
  // is ON a ticket but cannot PROVE the claim is its own.
  writeTicket({ status: "inprogress", claimedBySession: sessionId });

  const tDir = telemetryDirPath(sessDir);
  mkdirSync(tDir, { recursive: true });
  const marker = join(tDir, "shutdown");
  writeFileSync(marker, staleAt);
  const at = new Date(Date.parse(staleAt));
  utimesSync(marker, at, at);
  writeFileSync(join(tDir, "sidecar.pid"), String(deadPid()));

  return written;
}

/**
 * The current picture, computed the way the guide does, WITHOUT requiring the
 * session to be a gone-candidate. `shown()` asserts the verdict because most
 * tests want a fixture they can prove is a candidate; this one is for the cases
 * that are deliberately NOT candidates and still need a current, matching
 * confirmation so the handshake reaches its eligibility check.
 */
function pictureNow(): { sessionRevision: number; evidenceFingerprint: string } {
  const state = readSession(sessDir);
  if (!state) throw new Error("fixture session is unreadable");
  const verdict = readOwnerLiveness(
    sessDir,
    () => state as unknown as OwnableLivenessState,
    Date.now(),
    OWNER_STALE_MS,
    () => ({ kind: "observed", servers: [] }),
  );
  return { sessionRevision: state.revision, evidenceFingerprint: evidenceFingerprint(verdict.signals) };
}

/** The picture a caller would have been SHOWN, computed the way the guide does. */
function shown(): { sessionRevision: number; evidenceFingerprint: string } {
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
  return { sessionRevision: state.revision, evidenceFingerprint: evidenceFingerprint(verdict.signals) };
}

const guide = (args: Record<string, unknown>) =>
  handleAutonomousGuide(root, { clientTaskId: CALLER, ...args } as never);

const textOf = (r: { content: readonly { text?: string }[] }): string =>
  r.content.map((c) => c.text ?? "").join("\n");

const rawState = (): string => readFileSync(join(sessDir, "state.json"), "utf-8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-8-"));
  setupProject(root);
});

afterEach(async () => {
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// 8.1 -- the input surface
// ---------------------------------------------------------------------------

describe("T-450 8.1: the confirmation is validated at the boundary, never discarded", () => {
  const picture = { sessionRevision: 1, evidenceFingerprint: A_VALID_FINGERPRINT };

  it("refuses the field on a non-cancel action", async () => {
    makeCandidateSession();
    const before = rawState();
    const r = await guide({
      sessionId, action: "report", report: { completedAction: "x" },
      ownerGoneCandidateCancel: picture,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('only valid with action "cancel"');
    expect(rawState()).toBe(before);
  });

  it("refuses BOTH candidate fields at once, with its own message", async () => {
    // The mutual-exclusion check must run BEFORE either field's action check,
    // or it is dead code: on `cancel` the takeover field's action check fires
    // first, and on `resume` the cancel field's does. Asserting the dedicated
    // message is what proves the ordering.
    makeCandidateSession();
    const before = rawState();
    const r = await guide({
      sessionId, action: "cancel",
      ownerGoneCandidateTakeover: picture,
      ownerGoneCandidateCancel: picture,
    });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toMatch(/both|mutually exclusive|one of/i);
    expect(text).toContain("ownerGoneCandidateTakeover");
    expect(text).toContain("ownerGoneCandidateCancel");
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
    const r = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: bad });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("ownerGoneCandidateCancel is malformed");
    expect(rawState()).toBe(before);
  });

  it("refuses the field without an explicit sessionId, rather than auto-selecting one", async () => {
    // THE SUBSTITUTION HOLE. handleCancel auto-selects an active session when
    // sessionId is absent, and the confirmation names no session. A human who
    // confirmed an owner-gone picture for one session could end another, and
    // the handshake could not detect it: its session check compares the
    // evidence directory against the input id, and both would come from the
    // wrongly selected session.
    makeCandidateSession();
    const before = rawState();
    const r = await guide({ action: "cancel", ownerGoneCandidateCancel: shown() });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/sessionId/);
    expect(rawState()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 8.2 -- the split routes on presence alone
// ---------------------------------------------------------------------------

describe("T-450 8.2: presence of the field selects the candidate handler", () => {
  it("routes an EXPIRED-lease foreign session to the candidate handler, not to ordinary cancel", async () => {
    // The regression test for a draft that required a live-ownership conflict.
    // `liveOwnershipConflict` returns null outright on an expired lease, so
    // that conjunct dropped the confirmed field exactly here and ran an
    // ordinary cancellation while the caller believed a confirmed owner-gone
    // cancellation had run.
    makeCandidateSession({}, { leaseExpired: true });
    const r = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: shown() });
    expect(r.isError).toBeFalsy();

    // Identified by the DURABLE ARTIFACT, not by wording. An ordinary
    // cancellation of this session would also succeed and could carry similar
    // prose; only the candidate path writes candidate authority and the
    // candidate action, so this is what actually distinguishes the two.
    const after = readSession(sessDir) as unknown as Record<string, unknown>;
    const transition = after.cancellationTransition as
      { action?: string; authority?: { kind?: string; clientTaskId?: string } } | undefined;
    expect(transition?.action).toBe("candidate_recovery_cancellation");
    expect(transition?.authority?.kind).toBe("candidate");
    expect(transition?.authority?.clientTaskId).toBe(CALLER);
  });

  it("RESUMES a crashed cycle on a TERMINAL session instead of refusing it", async () => {
    // THE REGRESSION TEST for a draft that refused terminal sessions in the
    // guide. Write 4 bundles SESSION_END, `status: completed` and the published
    // transition into ONE write, so a crash between write 4 and the tail's
    // completion marker leaves a TERMINAL session carrying a published
    // candidate transition. That is precisely what the commit's
    // published-resume branch exists to finish, and a guide-level terminal
    // refusal would have stranded it forever.
    //
    // The crash window is reopened the same way the commit-level test does it
    // (candidate-commit.test.ts, "CRASH AFTER WRITE 4"): run a real
    // cancellation, then remove the completion marker and reopen the closed
    // intent. That is the durable picture of the crash, built from a real
    // cycle rather than a hand-written record.
    makeCandidateSession();
    // Captured BEFORE the cancellation, so it is the picture the human
    // actually confirmed -- and it goes stale the moment write 1 lands.
    const confirmed = shown();
    const first = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: confirmed });
    expect(first.isError).toBeFalsy();

    rmSync(join(sessDir, "telemetry", "cancellation-complete.json"), { force: true });
    const closedRaw = JSON.parse(readFileSync(join(sessDir, "cancellation-intent.json"), "utf-8"));
    expect(closedRaw.phase).toBe("closed");
    const { outcome: _outcome, ...reopened } = closedRaw as Record<string, unknown>;
    writeFileSync(
      join(sessDir, "cancellation-intent.json"),
      JSON.stringify({ ...reopened, phase: "authorized" }, null, 2),
    );

    // The confirmation is deliberately STALE now: the session revision moved
    // when the cancellation published. A pre-check would refuse this as
    // `re-confirm`, which is exactly why there is no pre-check -- the durable
    // record is what authorizes the retry.
    const second = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: confirmed });
    expect(second.isError, textOf(second)).toBeFalsy();
    const text = textOf(second);
    expect(text).toContain("finished an earlier attempt's durable cancellation cycle");
    // The TICKET line is corrected separately from the sentence above, so it is
    // pinned separately. `resumed` spans both resume branches and this fixture
    // exercises the published one, so a message asserting a phase would look
    // right here while being false on the stash_pending branch. The negative
    // assertion is the one that matters: it is the exact wording that was wrong.
    expect(text).toContain("the original authorization finding is unavailable");
    expect(text).not.toContain("publication had already landed before this call");

    // And the cycle is actually FINISHED, not merely un-refused.
    const intent = JSON.parse(readFileSync(join(sessDir, "cancellation-intent.json"), "utf-8"));
    expect(intent.phase).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// 8.3 -- the routed outcomes, and what each says
// ---------------------------------------------------------------------------

describe("T-450 8.3: every routed outcome is rendered, and says the right thing", () => {
  it("refuses the OWNER and tells them to retry cancel WITHOUT the field", async () => {
    // Not "the ordinary resume applies", which is what the handshake's own
    // detail sentence says and which is the takeover remedy. An owner ending
    // their own session wants ordinary cancel.
    makeCandidateSession({ ownerTask: { client: "claude", id: CALLER, boundAt: OWNER.boundAt } } as never);
    const r = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: shown() });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain("this caller IS the recorded owner");
    // The REMEDY is the point: an owner ending their own session wants an
    // ordinary cancel. The handshake's own detail says "the ordinary resume
    // applies", which is the takeover remedy and would send them to the
    // opposite operation.
    expect(text).toContain('"action": "cancel"');
    expect(text).toContain("no ownerGoneCandidateCancel");
    expect(text).not.toMatch(/ordinary resume applies/);
  });

  it("refuses a caller with NO identity", async () => {
    makeCandidateSession();
    const r = await handleAutonomousGuide(root, {
      sessionId, action: "cancel", ownerGoneCandidateCancel: shown(),
    } as never);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("requires a valid clientTaskId");
  });

  it("refuses when the owner is demonstrably ALIVE, naming the verdict", async () => {
    makeCandidateSession({
      lastGuideCall: new Date().toISOString(),
      mcpServerPid: process.pid,
      mcpGuideCallAt: new Date().toISOString(),
    } as never);
    // The picture must be the CURRENT one. The handshake checks the
    // fingerprint and the revision BEFORE it judges eligibility, so a dummy
    // fingerprint would refuse as `re-confirm` and never reach the verdict
    // this test is about.
    const r = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: pictureNow() });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("is not an owner-gone candidate");
  });

  it("on a moved picture, echoes the FRESH fingerprint and names the CANCEL field", async () => {
    // The takeover renderer instructs a retry with `ownerGoneCandidateTakeover`.
    // Handed to a cancel caller unchanged it would tell them to ADOPT a session
    // they had confirmed they wanted ENDED.
    makeCandidateSession();
    const real = shown();
    const r = await guide({
      sessionId, action: "cancel",
      ownerGoneCandidateCancel: { sessionRevision: real.sessionRevision, evidenceFingerprint: "b".repeat(64) },
    });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain(real.evidenceFingerprint);
    expect(text).toContain("ownerGoneCandidateCancel");
    expect(text).not.toContain("ownerGoneCandidateTakeover");
  });

  it("ENDS the session on the happy path, and releases the ticket claim", async () => {
    makeCandidateSession();
    const r = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: shown() });
    expect(r.isError).toBeFalsy();

    const after = readSession(sessDir);
    expect(after?.state).toBe("SESSION_END");
    expect(after?.status).toBe("completed");

    const ticket = JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(ticket.claimedBySession ?? null).toBeNull();
  });

  it("records the cancellation as a CANCELLATION, not as a takeover", async () => {
    // ISS-967. The durable record names what was DONE, and this session was
    // ended, not adopted. `authority.kind` cannot disambiguate: `candidate` is
    // correct for both operations.
    makeCandidateSession();
    const r = await guide({ sessionId, action: "cancel", ownerGoneCandidateCancel: shown() });
    expect(r.isError).toBeFalsy();

    const after = readSession(sessDir) as unknown as Record<string, unknown>;
    const transition = after.cancellationTransition as
      { action?: string; authority?: { kind?: string } } | undefined;
    // POSITIVE, because the negative form passed on a missing field, on
    // `ordinary_cancellation`, and on anything else wrong. What is being pinned
    // is a durable contract, so it has to name the value.
    expect(transition?.action).toBe("candidate_recovery_cancellation");
    expect(transition?.authority?.kind).toBe("candidate");
  });
});

// ---------------------------------------------------------------------------
// 8.4 -- the takeover door is not disturbed
// ---------------------------------------------------------------------------

describe("T-450 8.4: making the refusal renderer operation-aware adds a caller, it does not move a message", () => {
  it("keeps the pre-existing wording on the reachable `authorized` refusal arm", async () => {
    // Not a hypothetical arm. The commit's `invariant-violated` stage carries
    // an AUTHORIZED authorization into the refusal renderer, and before step 8
    // that fell to the renderer's `default`. Breaking it out for the
    // exhaustiveness check must not reword it, or a shipped takeover message
    // moves -- which the exact-string test above cannot catch, because that one
    // exercises the re-confirm arm.
    //
    // Asserted through the exported renderer rather than by contriving the
    // programming-error stage, so the test pins the STRING rather than a path
    // that only a bug can reach.
    const { __refusalRenderingTesting } = await import("../../src/autonomous/guide.js");
    const authorized = { kind: "authorized" } as never;
    expect(__refusalRenderingTesting.describe("sess-1", authorized, "takeover"))
      .toBe("Takeover of session sess-1 was not authorized.");
    expect(__refusalRenderingTesting.describe("sess-1", authorized, "cancel"))
      .toBe("Cancellation of session sess-1 was not authorized.");
  });

  it("still names ownerGoneCandidateTakeover when a TAKEOVER picture has moved", async () => {
    makeCandidateSession();
    const real = shown();
    const r = await guide({
      sessionId, action: "resume", takeover: true,
      ownerGoneCandidateTakeover: { sessionRevision: real.sessionRevision, evidenceFingerprint: "b".repeat(64) },
    });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    // THE WHOLE STRING, not substrings. The claim being pinned is that the
    // operation-aware refactor left the takeover door's output byte-identical,
    // and a substring check would tolerate substantial rewording around the
    // parts it happens to sample.
    const fresh = pictureNow().evidenceFingerprint;
    expect(text).toBe(
      "[autonomous_guide error] " +
      `The picture changed before this takeover of ${sessionId} was authorized (fingerprint-changed). ` +
      "the evidence changed between being shown and being confirmed\n" +
      "Re-confirm against the current evidence, then retry with " +
      "ownerGoneCandidateTakeover: { sessionRevision: <the session's current revision>, " +
      `evidenceFingerprint: "${fresh}" }.`,
    );
  });
});
