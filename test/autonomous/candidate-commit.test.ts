/**
 * T-450 step 6b: the two commit paths (ruling ea611619 Parts B and C).
 *
 * `commitCandidateTakeover` publishes ONE atomic durable postimage: the
 * ownership rebind, the resulting generation, the refreshed MCP pair, and the
 * `candidateTakeover` proof, in the SAME write, so a crash cannot produce a
 * completed takeover with no audit record or a proof without its fact. The
 * intent then closes content-gated (B8): strict parse of the RE-READ
 * persisted postimage plus cycleNonce equality with the live intent, never
 * revision math.
 *
 * `commitCandidateCancel` drives the phase table: durable intent, the
 * five-step claim transaction, the shared core's writes 1-4 under candidate
 * init, the tail, and the content-gated close against the RE-READ published
 * transition (C2). Every branch is resume-first: a crash at any boundary is
 * finished by re-running the driver, which verifies and continues, never
 * redoes.
 *
 * The staged generation is OWNED by the takeover attempt: `discard` runs on
 * every exit that does not commit, and each injected failure below proves the
 * discard individually, not only the invalidated-generation race.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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

// The session module is passed through UNCHANGED except that withSessionLock
// is wrapped in a spy, so the lock-discipline tests can assert exactly who
// acquires it: the `Locked` forms never, the wrappers exactly once.
vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  return { ...mod, withSessionLock: vi.fn(mod.withSessionLock) };
});

import {
  closeTakeoverIntent,
  closeCancellationIntentOnPublication,
  commitCandidateTakeoverLocked,
  commitCandidateTakeoverWithSessionLock,
  commitCandidateCancelLocked,
  readCancellationIntent,
  createCancellationIntent,
  advanceCancellationIntent,
  type CandidateHandshakeDeps,
  type CandidateHandshakeInput,
  type CandidateTakeoverDeps,
  type CandidateCancelDeps,
  type CandidateTicketIO,
  type NewCycleIntent,
} from "../../src/autonomous/candidate-recovery.js";
import {
  evidenceFingerprint,
  readOwnerLiveness,
  telemetryDirPath,
  OWNER_STALE_MS,
  type OwnableLivenessState,
  type StagedHeartbeatGeneration,
} from "../../src/autonomous/liveness.js";
import {
  createSession,
  writeSessionSync,
  writeSessionDurableSync,
  withSessionLock,
  __stateWriteTesting,
  LEASE_DURATION_MS,
} from "../../src/autonomous/session.js";
import {
  CandidateTakeoverPostimageSchema,
  CancellationTransitionSchema,
  type CancellationIntent,
  type FullSessionState,
} from "../../src/autonomous/session-types.js";
import { classifyCompletionMarker } from "../../src/autonomous/cancellation-transition.js";
import type { SuccessorServers } from "../../src/autonomous/mcp-registry.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = Date.now();
const STALE_AT = new Date(NOW - 30 * 60_000).toISOString();
const OWNER: OwnerTask = { client: "claude", id: "task-owner", boundAt: new Date(NOW - 2 * 3_600_000).toISOString() };
const CALLER: OwnerTask = { client: "claude", id: "task-candidate", boundAt: new Date(NOW - 60_000).toISOString() };
const NO_SERVERS: SuccessorServers = { kind: "observed", servers: [] };

let root: string;
let sessDir: string;
let sessionId: string;

/** A dead pid: allocated then reaped, so probes answer definitively absent. */
let cachedDeadPid: number | null = null;
function deadPid(): number {
  if (cachedDeadPid !== null) return cachedDeadPid;
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof child.pid !== "number") throw new Error("could not allocate a pid to reap");
  try {
    process.kill(child.pid, 0);
    throw new Error(`pid ${child.pid} is still live after being reaped`);
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
    title: "test", date: "2026-08-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

/** A live session owned by the (dead) owner task. */
function plantLive(over: Record<string, unknown> = {}): FullSessionState {
  const session = createSession(root, "coding", "test-workspace");
  sessionId = session.sessionId;
  sessDir = join(root, ".story", "sessions", sessionId);
  return writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    ownerTask: OWNER,
    mcpServerPid: deadPid(),
    mcpGuideCallAt: STALE_AT,
    lastGuideCall: STALE_AT,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
    ...over,
  } as unknown as FullSessionState);
}

/** The telemetry half of a gone-candidate picture: a shutdown marker whose
 * MTIME comes from the same clock as everything else (the ISS-957 rule). */
function writeMarker(): void {
  const tDir = telemetryDirPath(sessDir);
  mkdirSync(tDir, { recursive: true });
  const marker = join(tDir, "shutdown");
  writeFileSync(marker, STALE_AT);
  const at = new Date(Date.parse(STALE_AT));
  utimesSync(marker, at, at);
  writeFileSync(join(tDir, "sidecar.pid"), String(deadPid()));
}

function livenessStateOf(state: FullSessionState): OwnableLivenessState {
  const raw = state as unknown as Record<string, unknown>;
  return {
    heartbeatGeneration: raw.heartbeatGeneration,
    lastGuideCall: raw.lastGuideCall as string | null,
    mcpServerPid: raw.mcpServerPid as number | null,
    mcpGuideCallAt: raw.mcpGuideCallAt as string | null,
    lease: null,
    ownerTask: raw.ownerTask as OwnableLivenessState["ownerTask"],
  };
}

function currentState(): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

function handshakeDeps(over: Partial<CandidateHandshakeDeps> = {}): CandidateHandshakeDeps {
  return {
    now: () => NOW,
    staleThresholdMs: OWNER_STALE_MS,
    readState: () => livenessStateOf(currentState()),
    readLifecycle: () => {
      const s = currentState();
      return { state: s.state, status: (s as unknown as Record<string, unknown>).status as string ?? "active" };
    },
    readSuccessors: () => NO_SERVERS,
    loadTicket: async () => null,
    // REQUIRED, not optional: the matrix's issue rows must be able to tell a
    // failed read from a positive absence, and a missing loader is a failed
    // read. `null` is the positive answer for every fixture here, none of
    // which sits at an issue-bearing posture.
    loadIssue: async () => null,
    // THE SERVER-DERIVED HALF. `sessionRevision`, `ticket` and `claimEpoch`
    // used to ride in the handshake INPUT; the handshake now reads them out of
    // the session state itself, and this is the same state.json the commit
    // drivers read, so both sides decide on one observation.
    readSessionState: () => currentState(),
    ...over,
  };
}

/** The fingerprint of the picture a human would have been shown. */
function shownFingerprint(): string {
  const verdict = readOwnerLiveness(
    sessDir, () => livenessStateOf(currentState()), NOW, OWNER_STALE_MS, () => NO_SERVERS,
  );
  if (verdict.kind !== "gone-candidate") {
    throw new Error(`fixture is ${verdict.kind}, not gone-candidate`);
  }
  return evidenceFingerprint(verdict.signals);
}

function inputFor(state: FullSessionState, over: Partial<CandidateHandshakeInput> = {}): CandidateHandshakeInput {
  return {
    sessionId,
    clientTaskId: CALLER.id,
    confirmedSessionRevision: state.revision,
    confirmedFingerprint: shownFingerprint(),
    ...over,
  };
}

/** A FAKE staged generation for tests that never publish it or that inject
 * their own validator: structurally the real class's shape, cast through the
 * brand. Tests that let the real `discardStagedGeneration` run must NOT use
 * this (it was never issued, so discard refuses it); they pass their own
 * discard spy instead. */
function fakeStaged(id = "gen-test"): StagedHeartbeatGeneration {
  return {
    id, dir: join(sessDir, "telemetry", "generations", id), sessionDir: sessDir,
    pid: deadPid(), identity: "0:0", issued: true,
  } as unknown as StagedHeartbeatGeneration;
}

function takeoverDeps(over: Partial<CandidateTakeoverDeps> = {}): CandidateTakeoverDeps {
  return {
    handshake: handshakeDeps(),
    stage: () => fakeStaged(),
    validateStaged: () => ({ ok: true, argvProof: "proven" }),
    discardStaged: () => undefined,
    withProjectLock: async (fn) => { await fn(); },
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t450-commit-"));
  setupProject(root);
  vi.mocked(withSessionLock).mockClear();
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

describe("T-450 7b: the fence refreshes ownership, not progress", () => {
  it("leaves contextPressure.guideCallCount UNCHANGED across a committed takeover", async () => {
    // The other half of the fence decision, and the half nothing pinned. The
    // fence is stamped deliberately WITHOUT `refreshLease`, because that helper
    // also advances `contextPressure.guideCallCount`: a takeover is an
    // ownership change, not a step of the work, and counting it as one would
    // push the session toward a rotation it did not earn.
    //
    // Every existing fence assertion passes under a refactor to `refreshLease`,
    // which is exactly why this one exists: it is the only assertion that fails.
    plantLive();
    writeMarker();

    // SEEDED NONZERO, and the preimage asserted. `createSession` seeds
    // `guideCallCount: 0`, so an equality assertion against the default would
    // read 0 === 0 and pass a regression that rebuilt contextPressure from
    // defaults -- catching only the increment, which is not the whole claim.
    //
    // Seeded BEFORE the confirmation is computed: the seed write bumps the
    // revision, and a confirmation captured earlier would then be refused as
    // re-confirm rather than reaching the fence at all.
    const seeded = currentState() as unknown as Record<string, unknown>;
    writeSessionSync(sessDir, {
      ...(seeded as never),
      contextPressure: { ...(seeded.contextPressure as Record<string, unknown>), guideCallCount: 7 },
    } as never);

    const preimage = currentState();
    const before = ((preimage as unknown as Record<string, unknown>)
      .contextPressure as Record<string, unknown> | undefined)?.guideCallCount ?? null;
    expect(before).toBe(7);

    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(preimage as FullSessionState), callerTask: CALLER,
    }, takeoverDeps());

    expect(result.kind).toBe("committed");
    const postimage = currentState() as unknown as Record<string, unknown>;
    const after = (postimage.contextPressure as Record<string, unknown> | undefined)?.guideCallCount ?? null;

    expect(after).toBe(before);
  });
});

describe("T-450 7b: the fence is one normalized instant", () => {
  it("an EXTREME but parseable clock does not abort the takeover mid-commit", async () => {
    // `Number.isFinite` alone accepts JavaScript's maximum Date, and the expiry
    // derived from it is out of range, so rendering it throws a RangeError --
    // inside the write, after a generation has already been staged. Aborting a
    // takeover there is far worse than stamping the fence from the wall clock.
    const state = plantLive();
    writeMarker();
    const maxDate = new Date(8_640_000_000_000_000).toISOString();

    const before = Date.now();
    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({ nowIso: () => maxDate }));
    const after = Date.now();

    expect(result.kind).toBe("committed");
    const raw = currentState() as unknown as Record<string, unknown>;
    const lease = raw.lease as { expiresAt: string; lastHeartbeat: string };
    expect(Date.parse(lease.lastHeartbeat)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(lease.lastHeartbeat)).toBeLessThanOrEqual(after);
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.lastHeartbeat)).toBe(LEASE_DURATION_MS);
  });

  it("an UNPARSEABLE injected clock still publishes three readable, agreeing timestamps", async () => {
    // Rescuing only `expiresAt` would leave the supplied garbage in
    // `lastGuideCall` -- and that is the field the owner-liveness path reads as
    // ACTIVITY, the one refreshed here specifically to stop an immediate second
    // takeover of the session just recovered.
    const state = plantLive();
    writeMarker();

    // Bracketed by the WALL CLOCK: a fallback that regressed to any fixed
    // parseable instant (epoch zero, say) would still parse, still agree with
    // itself and still be exactly one duration wide. Only these bounds say the
    // fallback is the clock we actually meant.
    const before = Date.now();
    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({ nowIso: () => "not-a-date" }));
    const after = Date.now();

    expect(result.kind).toBe("committed");
    const raw = currentState() as unknown as Record<string, unknown>;
    const lease = raw.lease as { expiresAt: string; lastHeartbeat: string };

    expect(Number.isFinite(Date.parse(lease.lastHeartbeat))).toBe(true);
    expect(Number.isFinite(Date.parse(raw.lastGuideCall as string))).toBe(true);
    expect(Number.isFinite(Date.parse(lease.expiresAt))).toBe(true);
    // THE FOURTH TIMESTAMP, and it was the one this write left behind. It used
    // to be stamped from a SECOND raw `nowIso()`, so under this exact injected
    // clock it persisted the literal garbage while its three neighbours
    // described wall time -- one record describing two times, inside the write
    // whose whole contract is one instant.
    expect(Number.isFinite(Date.parse(raw.mcpGuideCallAt as string))).toBe(true);
    expect(raw.mcpGuideCallAt).toBe(lease.lastHeartbeat);
    // ONE instant: the two activity fields agree, and the fence is exactly the
    // canonical duration after it.
    expect(lease.lastHeartbeat).toBe(raw.lastGuideCall);
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.lastHeartbeat)).toBe(LEASE_DURATION_MS);
    expect(Date.parse(lease.lastHeartbeat)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(lease.lastHeartbeat)).toBeLessThanOrEqual(after);
  });
});

describe("T-450 6b: commitCandidateTakeover publishes one atomic postimage", () => {
  it("commits ownership, generation, MCP pair and proof in ONE revision, then closes the intent", async () => {
    const state = plantLive();
    writeMarker();

    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps());

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.resumed).toBe(false);

    // ONE write: exactly one revision above the confirmed state.
    const after = currentState();
    expect(after.revision).toBe(state.revision + 1);
    const raw = after as unknown as Record<string, unknown>;
    expect((raw.ownerTask as OwnerTask).id).toBe(CALLER.id);
    expect(raw.heartbeatGeneration).toBe("gen-test");
    expect(raw.mcpServerPid).toBe(process.pid);

    // The proof, in the SAME write, parseable by its own strict reader.
    const post = CandidateTakeoverPostimageSchema.safeParse(raw.candidateTakeover);
    expect(post.success).toBe(true);
    if (!post.success) return;
    expect(post.data.takeoverKind).toBe("owner_gone_candidate_takeover");
    expect(post.data.clientTaskId).toBe(CALLER.id);
    const evidence = post.data.evidence as { argvProof: string };
    expect(evidence.argvProof).toBe("proven");

    // T-450 step 7b: the NEW OWNER'S FENCE, in the same write. Publishing a
    // live owner under the dead owner's decaying lease is what makes a fresh
    // takeover immediately adoptable through the weaker expired-lease gate.
    const lease = raw.lease as { expiresAt: string; lastHeartbeat: string };
    expect(Date.parse(lease.expiresAt) - Date.now()).toBeGreaterThan(40 * 60_000);
    expect(lease.lastHeartbeat).toBe(raw.lastGuideCall);

    // The intent: created by the commit, closed by the gated close, nonce
    // and transitionId agreeing with the postimage.
    const intent = readCancellationIntent(sessDir);
    expect(intent.kind).toBe("valid");
    if (intent.kind !== "valid") return;
    expect(intent.intent.phase).toBe("closed");
    if (intent.intent.phase !== "closed") return;
    expect(intent.intent.cycleNonce).toBe(post.data.cycleNonce);
    expect(intent.intent.transitionId).toBe(post.data.intentTransitionId);
    expect(intent.intent.outcome).toEqual({ kind: "takeover", committedRevision: after.revision });
    expect(result.close.ok).toBe(true);
  });

  it("discards the staged generation on EVERY non-commit exit, each failure individually", async () => {
    const state = plantLive();
    writeMarker();
    const before = readFileSync(join(sessDir, "state.json"), "utf-8");

    const failures: Array<{ name: string; over: Partial<CandidateTakeoverDeps>; stage: string }> = [
      {
        name: "generation validation refusal",
        over: { validateStaged: () => ({ ok: false, reason: "signature-mismatch" }) },
        stage: "generation",
      },
      {
        name: "project lock failure",
        over: { withProjectLock: async () => { throw new Error("lock held elsewhere"); } },
        stage: "project-lock",
      },
      {
        name: "state write failure",
        over: { writeState: () => { throw new Error("disk full"); } },
        stage: "write",
      },
    ];
    for (const failure of failures) {
      const discard = vi.fn();
      const result = await commitCandidateTakeoverLocked(root, sessDir, {
        input: inputFor(state), callerTask: CALLER,
      }, takeoverDeps({ discardStaged: discard, ...failure.over }));

      expect(result.kind, failure.name).toBe("refused");
      if (result.kind === "refused") expect(result.stage, failure.name).toBe(failure.stage);
      expect(discard, failure.name).toHaveBeenCalledTimes(1);
      // The session state never moved. (The durable intent MAY exist after
      // post-validation failures; it is this cycle's evidence and resumable.)
      expect(readFileSync(join(sessDir, "state.json"), "utf-8"), failure.name).toBe(before);
    }
  });

  it("POST-RENAME barrier failure: the postimage IS published, so the generation is KEPT and the intent stays open", async () => {
    // The durability barriers run AFTER the rename, so a failure there leaves
    // a state.json that already carries the rebind and the proof. Treating
    // that as a failed write would report "nothing was published" over a
    // published state and then delete the generation that very state names,
    // leaving a session owned through a generation nobody can find.
    const state = plantLive();
    writeMarker();
    const discard = vi.fn();
    // Captured BEFORE the commit rebinds ownership: the retry must present
    // the same confirmation the crashed attempt carried, and re-deriving it
    // afterwards would describe a picture that no longer exists.
    const input = inputFor(state);

    const original = __stateWriteTesting.at;
    __stateWriteTesting.at = (point) => {
      // AFTER the rename, before the directory fsync completes: precisely the
      // window this path exists for.
      if (point === "state:renamed") throw new Error("simulated dir fsync failure");
    };
    let result: Awaited<ReturnType<typeof commitCandidateTakeoverLocked>>;
    try {
      result = await commitCandidateTakeoverLocked(root, sessDir, {
        input, callerTask: CALLER,
      }, takeoverDeps({
        discardStaged: discard,
        writeState: (next) => writeSessionDurableSync(sessDir, next),
      }));
    } finally {
      __stateWriteTesting.at = original;
    }

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.stage).toBe("write");
    // The detail must NOT claim nothing was published, because something was.
    expect(result.detail).toContain("published at revision");
    expect(result.detail).not.toContain("nothing");

    // The state really did move: rebind and proof are both on disk.
    const after = currentState();
    expect(after.revision).toBe(state.revision + 1);
    const raw = after as unknown as Record<string, unknown>;
    expect((raw.ownerTask as OwnerTask).id).toBe(CALLER.id);
    expect(CandidateTakeoverPostimageSchema.safeParse(raw.candidateTakeover).success).toBe(true);

    // THE TWO OBLIGATIONS. The generation the persisted state names survives,
    // and the intent stays open so the retry re-enters instead of starting a
    // second cycle over a committed one.
    expect(discard).not.toHaveBeenCalled();
    const intent = readCancellationIntent(sessDir);
    expect(intent.kind).toBe("valid");
    if (intent.kind !== "valid") return;
    expect(intent.intent.phase).toBe("authorized");

    // And the retry finishes it: same nonce, closed on the already-committed
    // path, no second write.
    const retry = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps());
    expect(retry.kind).toBe("committed");
    if (retry.kind !== "committed") return;
    expect(retry.resumed).toBe(true);
    expect(currentState().revision).toBe(after.revision);
    const closed = readCancellationIntent(sessDir);
    if (closed.kind !== "valid" || closed.intent.phase !== "closed") throw new Error("retry did not close");
    expect(closed.intent.outcome).toEqual({ kind: "takeover", committedRevision: after.revision });
  });

  it("refuses when staging itself fails, before anything is read or written", async () => {
    const state = plantLive();
    writeMarker();
    const discard = vi.fn();
    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({ stage: () => null, discardStaged: discard }));

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.stage).toBe("staging");
    // Nothing was staged, so there is nothing to discard.
    expect(discard).not.toHaveBeenCalled();
    expect(readCancellationIntent(sessDir).kind).toBe("absent");
  });

  it("re-validates under the lock: a re-confirm outcome refuses and carries the authorization", async () => {
    const state = plantLive();
    writeMarker();
    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state, { confirmedFingerprint: "fp-from-another-picture" }), callerTask: CALLER,
    }, takeoverDeps());

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.stage).toBe("validation");
    expect(result.authorization?.kind).toBe("re-confirm");
  });

  it("CRASH RETRY between postimage and close: verifies the durable proof and only closes (verify, never redo)", async () => {
    const state = plantLive();
    writeMarker();

    // First attempt: commit fully, then reopen the crash window by hand --
    // the intent back at authorized is exactly what a crash between the
    // durable write and the close leaves. The retry presents the SAME
    // confirmation the crashed attempt carried (captured before the commit
    // made this caller the owner); the already-committed path never
    // re-fingerprints, which is the point.
    const input = inputFor(state);
    const first = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps());
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") return;
    const committedState = readFileSync(join(sessDir, "state.json"), "utf-8");
    const intentAfter = readCancellationIntent(sessDir);
    if (intentAfter.kind !== "valid" || intentAfter.intent.phase !== "closed") return;
    const { outcome: _o, ...open } = intentAfter.intent as unknown as Record<string, unknown> & { outcome: unknown };
    writeFileSync(join(sessDir, "cancellation-intent.json"), JSON.stringify({ ...open, phase: "authorized" }, null, 2));

    // The retry: re-validation would refuse (this caller IS the owner now),
    // so the already-committed path must answer first. Its own staged
    // generation is discarded: nothing was committed by THIS attempt.
    const discard = vi.fn();
    const retry = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps({ discardStaged: discard }));

    expect(retry.kind).toBe("committed");
    if (retry.kind !== "committed") return;
    expect(retry.resumed).toBe(true);
    expect(retry.close.ok).toBe(true);
    expect(discard).toHaveBeenCalledTimes(1);
    // The state is BYTE-identical: the retry wrote the intent only.
    expect(readFileSync(join(sessDir, "state.json"), "utf-8")).toBe(committedState);
    const closed = readCancellationIntent(sessDir);
    expect(closed.kind).toBe("valid");
    if (closed.kind === "valid") expect(closed.intent.phase).toBe("closed");
  });

  it("B9: a CONSUMED cycle's lingering postimage is overwritten by the next commit, never trusted", async () => {
    const state = plantLive({
      candidateTakeover: {
        schemaVersion: 1,
        kind: "candidate_takeover_committed",
        cycleNonce: "99999999-9999-4999-8999-999999999999",
        takeoverKind: "owner_gone_candidate_takeover",
        intentTransitionId: "88888888-8888-4888-8888-888888888888",
        clientTaskId: CALLER.id,
        confirmationEpoch: 3,
        evidence: {},
      },
    });
    writeMarker();

    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps());

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.resumed).toBe(false);
    const raw = currentState() as unknown as Record<string, unknown>;
    const post = CandidateTakeoverPostimageSchema.safeParse(raw.candidateTakeover);
    expect(post.success).toBe(true);
    if (!post.success) return;
    expect(post.data.cycleNonce).not.toBe("99999999-9999-4999-8999-999999999999");
    const intent = readCancellationIntent(sessDir);
    if (intent.kind === "valid") expect(post.data.cycleNonce).toBe(intent.intent.cycleNonce);
  });

  it("the already-committed path opens on NONCE EQUALITY, never on the postimage merely parsing", async () => {
    // An open intent of OURS plus a lingering postimage from a CONSUMED
    // cycle: the retry check must fall through to a fresh commit (the stale
    // proof proves nothing about this cycle), not short-circuit into a
    // resumed close against another cycle's record.
    const state = plantLive({
      candidateTakeover: {
        schemaVersion: 1,
        kind: "candidate_takeover_committed",
        cycleNonce: "99999999-9999-4999-8999-999999999999",
        takeoverKind: "owner_gone_candidate_takeover",
        intentTransitionId: "88888888-8888-4888-8888-888888888888",
        clientTaskId: CALLER.id,
        confirmationEpoch: 3,
        evidence: {},
      },
    });
    writeMarker();
    const input = inputFor(state);

    // Stage OUR OWN open intent by letting a first attempt die at the
    // generation gate: the intent survives as this cycle's evidence.
    const first = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps({ validateStaged: () => ({ ok: false, reason: "no-heartbeat" }) }));
    expect(first.kind).toBe("refused");
    const open = readCancellationIntent(sessDir);
    expect(open.kind).toBe("valid");
    if (open.kind !== "valid") return;

    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps());
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.resumed).toBe(false);
    expect(result.postimage.cycleNonce).toBe(open.intent.cycleNonce);
    expect(result.postimage.cycleNonce).not.toBe("99999999-9999-4999-8999-999999999999");
  });

  it("LOCK DISCIPLINE: the Locked form never acquires the session lock; the wrapper acquires it exactly once", async () => {
    const state = plantLive();
    writeMarker();

    await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({ stage: () => null }));
    expect(vi.mocked(withSessionLock)).not.toHaveBeenCalled();

    await commitCandidateTakeoverWithSessionLock(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({ stage: () => null }));
    expect(vi.mocked(withSessionLock)).toHaveBeenCalledTimes(1);
  });

  /**
   * THE TICKET IS A SECOND, INDEPENDENT AXIS on the takeover resume arm too.
   *
   * The confirmation pair describes the SESSION; the claim lives in a ticket
   * file that can move without touching either field. A resume that consults
   * only the confirmation therefore inherits `existing.intent.ticketPreimage`
   * verbatim from an intent minted under an EARLIER authorization, and the
   * postimage it publishes then carries audit evidence the live ledger
   * contradicts. The cancel driver has guarded exactly this since step 6b
   * (`ticketWorkMoved`); the takeover driver did not, and that asymmetry was
   * the defect. The pair below is the takeover analogue of the cancel path's
   * two "TICKET WORK MOVED" tests, and it needs BOTH directions: the moved case
   * proves the guard fires, and the unmoved case proves it does not fire on
   * every resume (which would mint a new cycle for no reason and retire an id
   * that was doing its job).
   *
   * Both stage the crash the same way the nonce-equality test does -- a first
   * attempt that dies at the generation gate, leaving this task's own intent
   * durable at `authorized` -- and both move the ticket axis with
   * `setTicketAxis`, which leaves the revision alone so the confirmation axis
   * stays valid and the ticket axis is the only thing that differs.
   */
  it("TICKET WORK UNMOVED across a resumed takeover: the existing cycle is reused, not superseded", async () => {
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    tickets.bind();
    holdTicket();
    const input = inputFor(state);
    const handshake = handshakeDeps({ loadTicket: async () => tickets.io.load() });

    // FIRST ATTEMPT: dies at the generation gate, after the intent is minted.
    const first = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps({ handshake, validateStaged: () => ({ ok: false, reason: "no-heartbeat" }) }));
    expect(first.kind).toBe("refused");
    const born = readCancellationIntent(sessDir);
    expect(born.kind).toBe("valid");
    if (born.kind !== "valid") return;
    expect(born.intent.phase).toBe("authorized");
    // The premise, asserted rather than assumed: there IS a preimage to inherit,
    // so a reuse here is a real decision and not a comparison of two nulls.
    expect(born.intent.ticketPreimage).not.toBeNull();
    // AND BOTH AXES are genuinely fixed. The crashed attempt wrote nothing, so
    // the confirmation the retry presents is still the one the intent recorded.
    // Asserted rather than assumed: a fixture drift that moved the revision
    // would supersede on the OTHER axis, and the reuse this test exists to pin
    // would silently stop being exercised.
    expect(currentState().revision).toBe(born.intent.confirmedSessionRevision);
    expect(input.confirmedFingerprint).toBe(born.intent.confirmedFingerprint);

    // THE RETRY, with the ticket axis exactly where the crashed attempt left it.
    const retry = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps({ handshake }));
    expect(retry.kind).toBe("committed");
    if (retry.kind !== "committed") return;
    expect(retry.resumed).toBe(false);

    const closed = readCancellationIntent(sessDir);
    expect(closed.kind).toBe("valid");
    if (closed.kind !== "valid") return;
    // SAME cycle end to end: same identity, same confirmation, same preimage.
    expect(closed.intent.transitionId).toBe(born.intent.transitionId);
    expect(closed.intent.confirmationEpoch).toBe(born.intent.confirmationEpoch);
    expect(closed.intent.cycleNonce).toBe(born.intent.cycleNonce);
    expect(closed.intent.ticketPreimage).toEqual(born.intent.ticketPreimage);
    // Nothing was retired, so no supersession link was written.
    expect(closed.intent.predecessor).toBeUndefined();
    expect(retry.postimage.intentTransitionId).toBe(born.intent.transitionId);
  });

  it("TICKET WORK MOVED under a resumed takeover: the cycle is SUPERSEDED onto the fresh preimage", async () => {
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    const input = inputFor(state);
    const handshake = handshakeDeps({ loadTicket: async () => tickets.io.load() });

    // FIRST ATTEMPT: the session is on no ticket and holds no claim, so the
    // intent is minted with a NULL preimage; it then dies at the generation
    // gate, leaving that intent durable at `authorized`.
    const first = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps({ handshake, validateStaged: () => ({ ok: false, reason: "no-heartbeat" }) }));
    expect(first.kind).toBe("refused");
    const born = readCancellationIntent(sessDir);
    expect(born.kind).toBe("valid");
    if (born.kind !== "valid") return;
    expect(born.intent.phase).toBe("authorized");
    expect(born.intent.ticketPreimage).toBeNull();

    // THE CLAIM APPEARS between the passes, and the session records that it is
    // on the ticket. The revision is deliberately untouched, so the
    // confirmation the retry presents is still the right one and the ticket
    // axis alone is what moved.
    tickets.bind();
    holdTicket();
    // The confirmation axis is held fixed, so the supersession below can only
    // be the ticket axis's doing.
    expect(currentState().revision).toBe(born.intent.confirmedSessionRevision);
    expect(input.confirmedFingerprint).toBe(born.intent.confirmedFingerprint);

    const retry = await commitCandidateTakeoverLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, takeoverDeps({ handshake }));
    expect(retry.kind).toBe("committed");
    if (retry.kind !== "committed") return;

    const closed = readCancellationIntent(sessDir);
    expect(closed.kind).toBe("valid");
    if (closed.kind !== "valid") return;

    // A NEW CYCLE: new identity, epoch bumped by exactly one, and a predecessor
    // triple naming the intent it retired, all three components of it.
    expect(closed.intent.transitionId).not.toBe(born.intent.transitionId);
    expect(closed.intent.confirmationEpoch).toBe(born.intent.confirmationEpoch + 1);
    expect(closed.intent.predecessor).toEqual({
      predecessorTransitionId: born.intent.transitionId,
      predecessorEpoch: born.intent.confirmationEpoch,
      predecessorFingerprint: born.intent.confirmedFingerprint,
    });

    // AND IT CARRIES THE FRESH PREIMAGE, not the stale null it would have
    // inherited. This is the whole point: the record now describes the ticket
    // as the live ledger has it, so the published postimage cannot be audit
    // evidence the ledger contradicts.
    expect(closed.intent.ticketPreimage).not.toBeNull();
    expect(closed.intent.ticketPreimage?.ticketId).toBe(TICKET_ID);
    expect(closed.intent.ticketPreimage?.claimedBySession)
      .toEqual({ present: true, value: sessionId });

    // The postimage names the SUPERSEDING cycle, never the retired one.
    expect(retry.postimage.intentTransitionId).toBe(closed.intent.transitionId);
    expect(retry.postimage.cycleNonce).toBe(closed.intent.cycleNonce);
    expect(retry.postimage.cycleNonce).not.toBe(born.intent.cycleNonce);
    expect(retry.postimage.confirmationEpoch).toBe(born.intent.confirmationEpoch + 1);
  });

  /**
   * THE CONFIRMATION IS THE OTHER AXIS, and it moves independently of the
   * ticket. The pair above holds it fixed by construction, so on its own it
   * pins only half the resume guard: an implementation that compared the
   * preimage and nothing else would satisfy both and still reuse an intent
   * whose recorded confirmation is stale.
   *
   * That is not cosmetic. The postimage written below the resume arm is built
   * from the FRESH authorization's evidence while the intent it names would
   * still carry the OLD confirmed revision and fingerprint, so the durable
   * cycle would record two confirmations that disagree about one transition --
   * and `retirement`'s derivability proof, which reads the intent, would be
   * reasoning from the one nobody authorized. The cancel path has compared both
   * axes at its own resume since step 6b; these two cases are the takeover
   * halves of that.
   *
   * The ticket axis is deliberately held FIXED in both (claim held before the
   * crash and still held on the retry, so the preimage is byte-identical),
   * which is what isolates the confirmation axis as the only thing that moved.
   */
  it("CONFIRMED REVISION MOVED under a resumed takeover: the cycle is SUPERSEDED onto the fresh pair", async () => {
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    tickets.bind();
    holdTicket();
    const handshake = handshakeDeps({ loadTicket: async () => tickets.io.load() });

    const first = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({ handshake, validateStaged: () => ({ ok: false, reason: "no-heartbeat" }) }));
    expect(first.kind).toBe("refused");
    const born = readCancellationIntent(sessDir);
    expect(born.kind).toBe("valid");
    if (born.kind !== "valid") return;
    expect(born.intent.phase).toBe("authorized");

    // SOMETHING ELSE WROTE THE SESSION between the crash and the retry. The
    // ticket axis is untouched, so only the confirmed revision can differ.
    const moved = writeSessionSync(sessDir, currentState());
    expect(moved.revision).toBe(born.intent.confirmedSessionRevision + 1);
    // A FRESHLY MATCHING input, so the handshake still authorizes and the
    // refusal cannot come from check 1 instead of the guard under test.
    const movedInput = inputFor(moved);
    expect(movedInput.confirmedSessionRevision).not.toBe(born.intent.confirmedSessionRevision);
    expect(movedInput.confirmedFingerprint).toBe(born.intent.confirmedFingerprint);

    const retry = await commitCandidateTakeoverLocked(root, sessDir, {
      input: movedInput, callerTask: CALLER,
    }, takeoverDeps({ handshake }));
    expect(retry.kind).toBe("committed");
    if (retry.kind !== "committed") return;

    const closed = readCancellationIntent(sessDir);
    expect(closed.kind).toBe("valid");
    if (closed.kind !== "valid") return;

    // A NEW CYCLE, with the full audit link back to the one it retired.
    expect(closed.intent.transitionId).not.toBe(born.intent.transitionId);
    expect(closed.intent.confirmationEpoch).toBe(born.intent.confirmationEpoch + 1);
    expect(closed.intent.predecessor).toEqual({
      predecessorTransitionId: born.intent.transitionId,
      predecessorEpoch: born.intent.confirmationEpoch,
      predecessorFingerprint: born.intent.confirmedFingerprint,
    });

    // CARRYING THE FRESH PAIR AND ITS EVIDENCE, which is the whole point: the
    // intent now records the confirmation the postimage was actually written
    // under.
    expect(closed.intent.confirmedSessionRevision).toBe(movedInput.confirmedSessionRevision);
    expect(closed.intent.confirmedFingerprint).toBe(movedInput.confirmedFingerprint);
    expect(closed.intent.evidence.observedAt).toBe(new Date(NOW).toISOString());

    // The ticket axis really did stay put, so this test cannot be passing for
    // the previous pair's reason.
    expect(closed.intent.ticketPreimage).toEqual(born.intent.ticketPreimage);

    expect(retry.postimage.intentTransitionId).toBe(closed.intent.transitionId);
    expect(retry.postimage.confirmationEpoch).toBe(born.intent.confirmationEpoch + 1);
  });

  it("CONFIRMED FINGERPRINT MOVED under a resumed takeover: the cycle is SUPERSEDED onto the fresh pair", async () => {
    // The other operand of the same disjunction. Pinned separately because a
    // guard that compared only the revision would pass the test above and let
    // a re-confirmed picture be recorded under the old fingerprint.
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    tickets.bind();
    holdTicket();

    const first = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({
      handshake: handshakeDeps({ loadTicket: async () => tickets.io.load() }),
      validateStaged: () => ({ ok: false, reason: "no-heartbeat" }),
    }));
    expect(first.kind).toBe("refused");
    const born = readCancellationIntent(sessDir);
    expect(born.kind).toBe("valid");
    if (born.kind !== "valid") return;

    // THE PICTURE MOVED: the owner's last activity reads older than it did.
    // Still stale, so the verdict stays gone-candidate and the session remains
    // eligible; the digest moves because it digests the ages. The revision is
    // untouched, so the fingerprint is the only half of the pair that differs.
    const olderActivity = new Date(NOW - 60 * 60_000).toISOString();
    const movedLiveness = () => ({
      ...livenessStateOf(currentState()), lastGuideCall: olderActivity,
    });
    const verdict = readOwnerLiveness(sessDir, movedLiveness, NOW, OWNER_STALE_MS, () => NO_SERVERS);
    expect(verdict.kind).toBe("gone-candidate");
    const movedFingerprint = evidenceFingerprint(verdict.signals);
    expect(movedFingerprint).not.toBe(born.intent.confirmedFingerprint);

    const movedInput = { ...inputFor(state), confirmedFingerprint: movedFingerprint };
    expect(movedInput.confirmedSessionRevision).toBe(born.intent.confirmedSessionRevision);

    const retry = await commitCandidateTakeoverLocked(root, sessDir, {
      input: movedInput, callerTask: CALLER,
    }, takeoverDeps({
      handshake: handshakeDeps({
        readState: movedLiveness,
        loadTicket: async () => tickets.io.load(),
      }),
    }));
    expect(retry.kind).toBe("committed");
    if (retry.kind !== "committed") return;

    const closed = readCancellationIntent(sessDir);
    expect(closed.kind).toBe("valid");
    if (closed.kind !== "valid") return;

    expect(closed.intent.transitionId).not.toBe(born.intent.transitionId);
    expect(closed.intent.confirmationEpoch).toBe(born.intent.confirmationEpoch + 1);
    expect(closed.intent.predecessor).toEqual({
      predecessorTransitionId: born.intent.transitionId,
      predecessorEpoch: born.intent.confirmationEpoch,
      predecessorFingerprint: born.intent.confirmedFingerprint,
    });
    expect(closed.intent.confirmedFingerprint).toBe(movedFingerprint);
    expect(closed.intent.confirmedSessionRevision).toBe(born.intent.confirmedSessionRevision);
    // The evidence was re-minted with the picture, not carried over.
    expect(closed.intent.evidence.activity).not.toEqual(born.intent.evidence.activity);
    expect(closed.intent.ticketPreimage).toEqual(born.intent.ticketPreimage);
  });

  /**
   * "WE COULD NOT LOOK" IS NOT "IT IS NOT THERE", carried all the way to the
   * operator's sentence.
   *
   * The claim path loads the ticket inside a try/catch and flattens a throw to
   * `ticket = null` so its own arms can share one variable. That null must NOT
   * be what the authority matrix is handed: spelled as `absent` it becomes a
   * positive finding that the ticket does not exist, which is the exact
   * collapse `LedgerRead`'s three arms exist to prevent.
   *
   * It is not fail-open -- the claim-bearing posture refuses either way,
   * through reconciliation -- and that is precisely why only the REASON can
   * catch it. A test that asserted "refused" would pass on both spellings.
   * So this pins the reason and the detail: `ledger-unreadable`, carrying the
   * failure's own message, rather than `claim-not-held`, which would tell an
   * operator the ticket is gone when the ledger merely could not be read.
   *
   * BOTH unreadable spellings are covered, because they are easy to conflate
   * and only one of them is a thrown error.
   */
  it("LEDGER-UNREADABLE survives to the takeover refusal as itself, never as absence", async () => {
    const spellings: Array<{
      readonly name: string;
      readonly loadTicket: CandidateHandshakeDeps["loadTicket"];
      readonly detail: string;
    }> = [
      {
        name: "a throwing ledger read",
        loadTicket: async () => { throw new Error("ledger unreadable: EIO"); },
        detail: "ledger unreadable: EIO",
      },
      {
        name: "a read that did not answer",
        loadTicket: async () => undefined,
        detail: "the ledger read did not answer",
      },
    ];

    for (const spelling of spellings) {
      // A claim-bearing session (IMPLEMENT) that is ON the ticket, with an
      // epoch naming that same ticket -- so the claim path really does perform
      // the load whose result the matrix then reuses.
      const state = plantLive();
      writeMarker();
      const tickets = ticketFixture();
      tickets.bind();
      holdTicket();

      const result = await commitCandidateTakeoverLocked(root, sessDir, {
        input: inputFor(state), callerTask: CALLER,
      }, takeoverDeps({ handshake: handshakeDeps({ loadTicket: spelling.loadTicket }) }));

      expect(result.kind, spelling.name).toBe("refused");
      if (result.kind !== "refused") continue;
      expect(result.stage, spelling.name).toBe("validation");

      const authorization = result.authorization;
      expect(authorization?.kind, spelling.name).toBe("refused");
      if (authorization?.kind !== "refused") continue;
      expect(authorization.reason, spelling.name).toBe("takeover-unauthorized");

      const authority = authorization.authority;
      expect(authority?.kind, spelling.name).toBe("refused");
      if (authority?.kind !== "refused") continue;

      // THE WHOLE ASSERTION. Both lines are load-bearing: the first says what
      // the reason must be, the second names the wrong answer the collapse
      // produced, so a regression cannot be read as a mere rewording.
      expect(authority.reason, spelling.name).toBe("ledger-unreadable");
      expect(authority.reason, spelling.name).not.toBe("claim-not-held");
      // And the failure's own words reach the operator, so the sentence says
      // WHY the ledger could not be read rather than only that it could not.
      expect(authority.detail, spelling.name).toContain(spelling.detail);
    }
  });

  /**
   * THE FRESH-LOAD BRANCH, which no claim-bearing test can reach.
   *
   * `readLedgerTicket` has four exits, and which one runs is decided by the
   * POSTURE. At a claim-bearing state the claim path has already loaded the
   * ticket, so the reuse branch always answers and the loader inside
   * `readLedgerTicket` is never called; with no target id the early return
   * wins. Every commit-driver test above sits at IMPLEMENT, so between them
   * they pin neither. Replacing that loader's whole body with
   * `return { kind: "absent" }` leaves them all green -- the gap is structural,
   * not a coverage number.
   *
   * POST-COMPLETION is where it actually runs, and it is the first posture a
   * 7b caller meets. The session has let go of its ticket (`ticket` cleared)
   * but still carries the epoch, so the identity fallback resolves a ticket id
   * that the claim path never loaded: `loadedRead` is undefined and the fresh
   * load is the only thing that can answer.
   *
   * Three of the four exits are asserted here, each with the observable that
   * only it produces. The two unreadable spellings are the load-bearing ones --
   * an unreadable ledger reaching the matrix as `absent` would tell an operator
   * the ticket is gone -- and `found` is included because it is the exit that
   * proves the branch delivers the ticket VALUE, not merely a kind: the
   * residual-claim row can only fire if the matrix actually sees this session's
   * stamp on it.
   */
  it("POST-COMPLETION: the authority read loads the ticket ITSELF, and each outcome keeps its own reason", async () => {
    const cases: Array<{
      readonly name: string;
      readonly loadTicket: CandidateHandshakeDeps["loadTicket"];
      readonly reason: string;
      readonly detail: string;
    }> = [
      {
        name: "a throwing ledger read",
        loadTicket: async () => { throw new Error("ledger unreadable: EIO"); },
        reason: "ledger-unreadable",
        detail: "ledger unreadable: EIO",
      },
      {
        name: "a read that did not answer",
        loadTicket: async () => undefined,
        reason: "ledger-unreadable",
        detail: "the ledger read did not answer",
      },
      {
        // The `found` exit. This session's OWN stamp is still on the ticket at
        // a posture whose claim lifecycle has ended, which is the one residue
        // that still refuses after the foreign-stamp row was corrected.
        name: "a ticket still stamped by this very session",
        loadTicket: async () => {
          const tickets = ticketFixture();
          tickets.bind();
          return tickets.io.load() as never;
        },
        reason: "residual-claim",
        detail: "session stamp naming this session",
      },
    ];

    for (const c of cases) {
      // HANDOVER: post-completion-boundary. The ticket is cleared and the
      // epoch retained, which is exactly what a session that finished (or
      // skipped) its item carries, and it is what makes the identity fallback
      // resolve a ticket the claim path never touched.
      const state = plantLive({ state: "HANDOVER" });
      writeMarker();
      setTicketAxis({ ticket: undefined, claimEpoch: epochFor() });

      const result = await commitCandidateTakeoverLocked(root, sessDir, {
        input: inputFor(state), callerTask: CALLER,
      }, takeoverDeps({ handshake: handshakeDeps({ loadTicket: c.loadTicket }) }));

      expect(result.kind, c.name).toBe("refused");
      if (result.kind !== "refused") continue;
      expect(result.stage, c.name).toBe("validation");
      const authorization = result.authorization;
      if (authorization?.kind !== "refused") {
        throw new Error(`${c.name}: expected a refused authorization, got ${authorization?.kind}`);
      }
      expect(authorization.reason, c.name).toBe("takeover-unauthorized");
      const authority = authorization.authority;
      if (authority?.kind !== "refused") {
        throw new Error(`${c.name}: expected a refused authority, got ${authority?.kind}`);
      }
      expect(authority.posture, c.name).not.toBe("claim-bearing");
      expect(authority.reason, c.name).toBe(c.reason);
      expect(authority.detail, c.name).toContain(c.detail);
    }
  });

  it("POST-COMPLETION: an ABSENT ticket is a positive finding, and the takeover proceeds", async () => {
    // The fourth exit, and the control for the three above. A ledger that
    // POSITIVELY answers "no such ticket" leaves no residue to contradict the
    // stage, so the takeover is authorized -- which is what makes the two
    // unreadable spellings' refusals meaningful rather than a posture that
    // refuses everything.
    const state = plantLive({ state: "HANDOVER" });
    writeMarker();
    setTicketAxis({ ticket: undefined, claimEpoch: epochFor() });

    const result = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, takeoverDeps({ handshake: handshakeDeps({ loadTicket: async () => null }) }));

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.postimage.clientTaskId).toBe(CALLER.id);
  });
});

describe("T-450 6b: the content-gated takeover close (B8)", () => {
  const NONCE = "11111111-1111-4111-8111-111111111111";
  const TID = "22222222-2222-4222-8222-222222222222";

  function stagedIntent(over: Record<string, unknown> = {}): void {
    plantLive();
    writeFileSync(join(sessDir, "cancellation-intent.json"), JSON.stringify({
      schemaVersion: 1,
      transitionId: TID,
      cycleNonce: NONCE,
      confirmationEpoch: 0,
      clientTaskId: CALLER.id,
      sessionId,
      sessionStartedAt: new Date(NOW - 3_600_000).toISOString(),
      confirmedSessionRevision: 1,
      confirmedFingerprint: "fp-1",
      evidence: {
        activity: { kind: "unknown", reason: "absent" },
        lease: { kind: "unknown", reason: "absent" },
        deathMarker: { kind: "unreadable", reason: "absent" },
        markerValidity: { kind: "unknown", reason: "no-recorded-pid", pid: null },
        sidecarProbe: { kind: "unknown", reason: "no-pid", pid: null },
        observedAt: new Date(NOW).toISOString(),
        staleThresholdMs: 2_700_000,
        successors: { kind: "unavailable", reason: "test fixture" },
      },
      ticketPreimage: null,
      phase: "authorized",
      ...over,
    }, null, 2));
  }

  function postimage(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      kind: "candidate_takeover_committed",
      cycleNonce: NONCE,
      takeoverKind: "owner_gone_candidate_takeover",
      intentTransitionId: TID,
      clientTaskId: CALLER.id,
      confirmationEpoch: 0,
      evidence: {},
      ...over,
    };
  }

  it("closes only on a matching durable proof, and records the committed revision", () => {
    stagedIntent();
    const result = closeTakeoverIntent(sessDir, { candidateTakeover: postimage(), committedRevision: 7 });
    expect(result.ok).toBe(true);
    const intent = readCancellationIntent(sessDir);
    expect(intent.kind).toBe("valid");
    if (intent.kind !== "valid" || intent.intent.phase !== "closed") return;
    expect(intent.intent.outcome).toEqual({ kind: "takeover", committedRevision: 7 });
  });

  it("refuses every non-proving record, each with its own reason", () => {
    const cases: Array<{ name: string; value: unknown; reason: string }> = [
      { name: "absent", value: undefined, reason: "not-committed" },
      { name: "null", value: null, reason: "not-committed" },
      { name: "unparseable", value: { schemaVersion: 1, kind: "something-else" }, reason: "takeover-postimage-unreadable" },
      { name: "foreign nonce (a consumed cycle's stale value)",
        value: postimage({ cycleNonce: "33333333-3333-4333-8333-333333333333" }), reason: "not-committed" },
      { name: "nonce match with contradicting transitionId is CORRUPTION",
        value: postimage({ intentTransitionId: "44444444-4444-4444-8444-444444444444" }),
        reason: "takeover-postimage-conflict" },
      { name: "nonce match with contradicting clientTaskId is CORRUPTION",
        value: postimage({ clientTaskId: "task-somebody-else" }), reason: "takeover-postimage-conflict" },
    ];
    for (const c of cases) {
      stagedIntent();
      const result = closeTakeoverIntent(sessDir, { candidateTakeover: c.value, committedRevision: 7 });
      expect(result.ok, c.name).toBe(false);
      if (!result.ok) expect(result.reason, c.name).toBe(c.reason);
      const intent = readCancellationIntent(sessDir);
      if (intent.kind === "valid") expect(intent.intent.phase, c.name).toBe("authorized");
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "t450-commit-"));
      setupProject(root);
    }
  });

  it("refuses to close over a cancellation in flight: the ticket phases are not its to end", () => {
    stagedIntent({
      phase: "prepared",
      claimTxn: {
        kind: "release", ticketId: "T-001", transitionId: TID,
        fromEpoch: null, toEpoch: null,
        fromBusiness: { ticketId: "T-001", lifecycle: { present: false, value: null }, status: { present: true, value: "inprogress" }, completedDate: { present: false, value: null }, claim: { present: false, value: null }, claimedBySession: { present: true, value: "s" } },
        toBusiness: { ticketId: "T-001", lifecycle: { present: false, value: null }, status: { present: true, value: "open" }, completedDate: { present: false, value: null }, claim: { present: false, value: null }, claimedBySession: { present: false, value: null } },
        startedAt: new Date(NOW).toISOString(),
        phase: "prepared",
      },
    });
    const result = closeTakeoverIntent(sessDir, { candidateTakeover: postimage(), committedRevision: 7 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("edge-refused");
  });

  it("is idempotent on the exact same committed revision, and refuses any other closed shape", () => {
    stagedIntent({ phase: "closed", outcome: { kind: "takeover", committedRevision: 7 } });
    const same = closeTakeoverIntent(sessDir, { candidateTakeover: postimage(), committedRevision: 7 });
    expect(same.ok).toBe(true);

    const different = closeTakeoverIntent(sessDir, { candidateTakeover: postimage(), committedRevision: 9 });
    expect(different.ok).toBe(false);
    if (!different.ok) expect(different.reason).toBe("takeover-postimage-conflict");

    stagedIntent({ phase: "closed", outcome: { kind: "cancellation", transitionId: TID } });
    const crossed = closeTakeoverIntent(sessDir, { candidateTakeover: postimage(), committedRevision: 7 });
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.reason).toBe("takeover-postimage-conflict");
  });
});

const TICKET_ID = "T-001";

/** A mutable in-ledger ticket plus the IO both the handshake and the txn
 * steps read, so the two sides compare like with like. */
function ticketFixture() {
  let ticket: Record<string, unknown> = {
    id: TICKET_ID, title: "t", status: "inprogress", type: "task", phase: "p1", order: 1,
    description: "", createdDate: "2026-08-01", completedDate: null, blockedBy: [],
    claimedBySession: "", // bound after plantLive, when sessionId exists
  };
  return {
    bind: () => { ticket.claimedBySession = sessionId; },
    /** Someone else released it between our passes. */
    release: () => { delete ticket.claimedBySession; ticket.status = "open"; },
    get: () => ticket,
    io: {
      load: () => ({ ...ticket }) as never,
      write: async (t: Record<string, unknown>) => { ticket = { ...t }; },
    } satisfies CandidateTicketIO,
  };
}

/** The claim epoch this session recorded at acquisition. It lives in the
 * SESSION STATE, which is where both the handshake and the commit drivers now
 * read it from; it names the sessionId `plantLive` mints, so it can only be
 * built after one. */
function epochFor() {
  return {
    ticketId: TICKET_ID, sessionId, user: null, branch: null, since: null,
    establishedAt: STALE_AT,
  };
}

/**
 * Move the session's ticket axis WITHOUT moving its revision.
 *
 * These fields used to be handed to the commit as input, so changing them
 * cost nothing. They are session state now, and the ordinary writer bumps the
 * revision -- which would move the CONFIRMATION axis too and supersede a
 * cycle for a reason the test is not about. Writing state.json directly keeps
 * the two axes independent, exactly as the input/state split did.
 */
function setTicketAxis(over: Record<string, unknown>): void {
  const next = { ...(currentState() as unknown as Record<string, unknown>), ...over };
  writeFileSync(join(sessDir, "state.json"), JSON.stringify(next, null, 2) + "\n");
}

/** The session is on the ticket and holds the epoch it acquired. The ref
 * carries a title because the session schema requires one; the handshake
 * reads only the id. */
function holdTicket(): void {
  setTicketAxis({ ticket: { id: TICKET_ID, title: "t" }, claimEpoch: epochFor() });
}

describe("T-450 6b: commitCandidateCancel drives the phase table end to end", () => {
  function cancelDeps(over: Partial<CandidateCancelDeps> = {}): CandidateCancelDeps {
    return {
      handshake: handshakeDeps(),
      withTicketLock: async () => { throw new Error("this test owes no ticket work"); },
      ...over,
    };
  }

  function eventCount(type: string): number {
    const path = join(sessDir, "events.log");
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf-8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string })
      .filter((e) => e.type === type).length;
  }

  it("NO-TICKET PATH: publishes, closes from authorized, and the record satisfies the equations", async () => {
    const state = plantLive();
    writeMarker();

    const result = await commitCandidateCancelLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, cancelDeps());

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;
    expect(result.resumed).toBe(false);
    expect(result.close.ok).toBe(true);
    expect(result.tail.completed).toBe(true);

    // DELTA AMENDMENT (a): the published record parses through the shipped
    // strict reader and satisfies the equations, no adapter.
    const after = currentState();
    expect(after.state).toBe("SESSION_END");
    const t = CancellationTransitionSchema.safeParse(
      (after as unknown as Record<string, unknown>).cancellationTransition,
    );
    expect(t.success).toBe(true);
    if (!t.success || t.data.phase !== "published") return;
    // DELTA AMENDMENT (b): candidate action under candidate authority is
    // what persisted, and the pairing holds end to end.
    //
    // ISS-967: this assertion used to demand `candidate_recovery_takeover` on
    // the CANCEL path, which is how the defect survived -- the test asserted
    // the value the code was handing it rather than the operation that had
    // actually run. A record read in isolation must say the session was ENDED.
    expect(t.data.action).toBe("candidate_recovery_cancellation");
    expect(t.data.action).not.toBe("candidate_recovery_takeover");
    expect(t.data.authority.kind).toBe("candidate");
    if (t.data.authority.kind !== "candidate") return;
    expect(t.data.authority.clientTaskId).toBe(CALLER.id);
    expect(t.data.transitionStartedRevision).toBe(t.data.authority.confirmedSessionRevision + 1);
    expect(t.data.terminalRevision).toBe(t.data.transitionStartedRevision + 2);
    expect(t.data.terminalRevision).toBe(after.revision);
    expect(t.data.disposition).toEqual({ kind: "no-ticket" });

    // The intent closed on the publication, from `authorized` (the audited
    // no-ticket-write path never fabricates claim phases).
    const intent = readCancellationIntent(sessDir);
    expect(intent.kind).toBe("valid");
    if (intent.kind !== "valid" || intent.intent.phase !== "closed") return;
    expect(intent.intent.outcome).toEqual({ kind: "cancellation", transitionId: t.data.transitionId });

    // Exactly one audit event, and the completion marker names the transition.
    expect(eventCount("cancelled")).toBe(1);
    expect(classifyCompletionMarker(sessDir, t.data.transitionId).kind).toBe("matching");
  });

  it("RELEASE PATH: the five-step transaction releases the ticket, removes the nonce, and records `released`", async () => {
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    tickets.bind();
    holdTicket();

    const result = await commitCandidateCancelLocked(root, sessDir, {
      input: inputFor(state),
      callerTask: CALLER,
    }, cancelDeps({
      handshake: handshakeDeps({ loadTicket: async () => tickets.io.load() }),
      withTicketLock: async (fn) => { await fn(tickets.io); },
    }));

    expect(result.kind).toBe("published");
    if (result.kind !== "published") return;

    // The ticket: open, both ownership fields REMOVED (deleted keys, not
    // nulls), and no transaction nonce left behind.
    const ticket = tickets.get();
    expect(ticket.status).toBe("open");
    expect("claimedBySession" in ticket).toBe(false);
    expect("claim" in ticket).toBe(false);
    expect("claimTxnId" in ticket).toBe(false);

    const after = currentState();
    const t = CancellationTransitionSchema.safeParse(
      (after as unknown as Record<string, unknown>).cancellationTransition,
    );
    if (!t.success || t.data.phase !== "published") return;
    expect(t.data.disposition).toEqual({ kind: "released", ticketId: TICKET_ID });
    const intent = readCancellationIntent(sessDir);
    if (intent.kind !== "valid" || intent.intent.phase !== "closed") return;
    expect(intent.intent.outcome.kind).toBe("cancellation");
    expect(eventCount("cancelled")).toBe(1);
  });

  it("CRASH AT THE TICKET BOUNDARY: the write landed, the advance did not; the retry resumes, never redoes", async () => {
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    tickets.bind();
    holdTicket();
    const input = inputFor(state);
    const handshake = handshakeDeps({ loadTicket: async () => tickets.io.load() });

    // FIRST ATTEMPT: crash immediately after the step-2 ticket write, before
    // the intent records ticket_applied. The durable evidence is the ticket
    // carrying the nonce and an intent still at `prepared`.
    let writes = 0;
    const crashing: CandidateTicketIO = {
      load: tickets.io.load,
      write: async (t) => {
        await tickets.io.write(t);
        writes += 1;
        throw new Error("simulated crash after the ticket write");
      },
    };
    const first = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps({ handshake, withTicketLock: async (fn) => { await fn(crashing); } }));
    expect(first.kind).toBe("refused");
    if (first.kind === "refused") expect(first.stage).toBe("ticket-txn");
    expect(writes).toBe(1);
    expect(tickets.get().claimTxnId).toBe(
      (readCancellationIntent(sessDir) as { intent: CancellationIntent }).intent.transitionId,
    );
    const tidBefore = (readCancellationIntent(sessDir) as { intent: CancellationIntent }).intent.transitionId;

    // THE RETRY: recoverClaimTransaction reads the postimage-with-nonce and
    // answers commit-epoch; the mutation is NOT re-applied (write count
    // proves it: only the nonce removal writes again).
    const counting: CandidateTicketIO = {
      load: tickets.io.load,
      write: async (t) => { await tickets.io.write(t); writes += 1; },
    };
    const retry = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps({ handshake, withTicketLock: async (fn) => { await fn(counting); } }));

    expect(retry.kind).toBe("published");
    if (retry.kind !== "published") return;
    expect(writes).toBe(2);
    // SAME transitionId end to end: the id survived the crash (test 5's
    // core assertion), exactly one cancelled event exists, and the marker
    // names it.
    const after = currentState();
    const t = CancellationTransitionSchema.safeParse(
      (after as unknown as Record<string, unknown>).cancellationTransition,
    );
    if (!t.success) return;
    expect(t.data.transitionId).toBe(tidBefore);
    expect(eventCount("cancelled")).toBe(1);
    expect(classifyCompletionMarker(sessDir, t.data.transitionId).kind).toBe("matching");
    expect("claimTxnId" in tickets.get()).toBe(false);
    expect(tickets.get().status).toBe("open");
  });

  it("TICKET WORK MOVED under an authorized intent: a claim appearing after the crash is RELEASED, not denied", async () => {
    // The ticket is a second axis. The confirmation pair describes the
    // session; the claim lives in a ticket file that can move without
    // touching either field. An authorized intent minted with no ticket work
    // would otherwise be resumed verbatim, skip the transaction, and publish
    // `no-ticket` over a claim that is still held.
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    const handshake = handshakeDeps({ loadTicket: async () => tickets.io.load() });

    // FIRST PASS: no claim exists, so the intent is minted with a null
    // preimage; crash before write 1.
    const first = await commitCandidateCancelLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, cancelDeps({ handshake, apply: async () => { throw new Error("crash before write 1"); } }));
    expect(first.kind).toBe("refused");
    const born = readCancellationIntent(sessDir);
    expect(born.kind).toBe("valid");
    if (born.kind !== "valid") return;
    expect(born.intent.phase).toBe("authorized");
    expect(born.intent.ticketPreimage).toBeNull();

    // THE CLAIM APPEARS between the passes, and the session records that it is
    // on the ticket. The revision is deliberately left where it was, so the
    // confirmation axis is unmoved and the ticket axis alone is what differs.
    tickets.bind();
    holdTicket();

    const retry = await commitCandidateCancelLocked(root, sessDir, {
      input: inputFor(state),
      callerTask: CALLER,
    }, cancelDeps({ handshake, withTicketLock: async (fn) => { await fn(tickets.io); } }));
    expect(retry.kind).toBe("published");
    if (retry.kind !== "published") return;

    // The cycle was superseded onto the fresh preimage, the ticket really was
    // released, and the record says so.
    expect(tickets.get().status).toBe("open");
    expect("claimedBySession" in tickets.get()).toBe(false);
    const t = CancellationTransitionSchema.safeParse(
      (currentState() as unknown as Record<string, unknown>).cancellationTransition,
    );
    expect(t.success).toBe(true);
    if (!t.success || t.data.phase !== "published") return;
    expect(t.data.disposition).toEqual({ kind: "released", ticketId: TICKET_ID });
  });

  it("TICKET WORK MOVED the other way: a claim gone before the retry is not reported as released", async () => {
    // The mirror. An authorized intent carrying a release preimage must not
    // survive into a pass where the claim is gone, or the record promises a
    // release nothing performed.
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    tickets.bind();
    holdTicket();
    const handshake = handshakeDeps({ loadTicket: async () => tickets.io.load() });

    const first = await commitCandidateCancelLocked(root, sessDir, {
      input: inputFor(state),
      callerTask: CALLER,
    }, cancelDeps({
      handshake,
      withTicketLock: async () => { throw new Error("crash inside the transaction"); },
      apply: async () => { throw new Error("unreached"); },
    }));
    expect(first.kind).toBe("refused");
    const born = readCancellationIntent(sessDir);
    if (born.kind !== "valid") throw new Error("expected a durable intent");
    expect(born.intent.ticketPreimage).not.toBeNull();

    // Rewind to AUTHORIZED, which is exactly the durable picture a crash
    // between minting the intent and opening the transaction leaves: the
    // preimage is recorded, no claim transaction exists yet. (The pass above
    // reaches `prepared`, one step further, because nothing can crash between
    // those two writes on demand.)
    const rewound = { ...born.intent, phase: "authorized" } as Record<string, unknown>;
    delete rewound.claimTxn;
    writeFileSync(join(sessDir, "cancellation-intent.json"), JSON.stringify(rewound, null, 2));
    const staleTid = born.intent.transitionId;

    // The claim is released by someone else before the retry, and the session
    // is no longer on the ticket. Revision unmoved: the ticket axis alone.
    tickets.release();
    // `undefined` rather than null: `ticket` is an optional object in the
    // session schema, and JSON.stringify drops the key entirely.
    setTicketAxis({ ticket: undefined, claimEpoch: null });

    const retry = await commitCandidateCancelLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, cancelDeps({ handshake, withTicketLock: async (fn) => { await fn(tickets.io); } }));
    expect(retry.kind).toBe("published");
    if (retry.kind !== "published") return;

    const t = CancellationTransitionSchema.safeParse(
      (currentState() as unknown as Record<string, unknown>).cancellationTransition,
    );
    if (!t.success || t.data.phase !== "published") return;
    // NOT `released`: nothing in this cycle released anything.
    expect(t.data.disposition).not.toEqual({ kind: "released", ticketId: TICKET_ID });

    // AND the stale promise is gone rather than merely unfulfilled. The cycle
    // was superseded onto a fresh identity carrying no preimage; leaving the
    // old id in place with a release recorded against it would keep a durable
    // record of work this session will now never do.
    expect(t.data.transitionId).not.toBe(staleTid);
    const closed = readCancellationIntent(sessDir);
    if (closed.kind !== "valid") throw new Error("expected a durable intent");
    expect(closed.intent.transitionId).not.toBe(staleTid);
    expect(closed.intent.ticketPreimage).toBeNull();
  });

  it("CRASH AFTER THE CLAIM CLEARED: the retry publishes `released`, not the denial a fresh count would give", async () => {
    // The window between the transaction clearing and write 1 landing. On the
    // retry the intent is durably `claim_cleared`, so neither the opener nor
    // the transaction loop runs -- and the ticket is already released, so a
    // freshly recomputed authorization sees no work owed. Counting only what
    // THIS pass did would therefore publish a disposition denying a release
    // that really happened, in the audit record meant to describe it.
    const state = plantLive();
    writeMarker();
    const tickets = ticketFixture();
    tickets.bind();
    holdTicket();
    const input = inputFor(state);
    const handshake = handshakeDeps({ loadTicket: async () => tickets.io.load() });

    const first = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps({
      handshake,
      withTicketLock: async (fn) => { await fn(tickets.io); },
      apply: async () => { throw new Error("simulated crash before write 1"); },
    }));
    expect(first.kind).toBe("refused");
    if (first.kind === "refused") expect(first.stage).toBe("transition");

    // The durable picture the crash leaves: the ticket released, the intent
    // at claim_cleared, and no transition record at all.
    expect(tickets.get().status).toBe("open");
    expect("claimTxnId" in tickets.get()).toBe(false);
    const mid = readCancellationIntent(sessDir);
    expect(mid.kind).toBe("valid");
    if (mid.kind !== "valid") return;
    expect(mid.intent.phase).toBe("claim_cleared");
    expect((currentState() as unknown as Record<string, unknown>).cancellationTransition).toBeUndefined();

    const retry = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps({ handshake, withTicketLock: async (fn) => { await fn(tickets.io); } }));
    expect(retry.kind).toBe("published");
    if (retry.kind !== "published") return;

    const t = CancellationTransitionSchema.safeParse(
      (currentState() as unknown as Record<string, unknown>).cancellationTransition,
    );
    expect(t.success).toBe(true);
    if (!t.success || t.data.phase !== "published") return;
    expect(t.data.disposition).toEqual({ kind: "released", ticketId: TICKET_ID });
  });

  it("CRASH AFTER WRITE 1: the stash_pending record resumes through full validation, not through plain cancel", async () => {
    const state = plantLive();
    writeMarker();
    const input = inputFor(state);

    // Crash the first attempt AFTER write 1. The injected apply persists
    // exactly write 1's record -- built from ITS OWN inputs the way the
    // shared core builds it (identity from state, tSR = the revision the
    // write produces) -- and then dies, so the durable picture is precisely
    // "write 1 landed, nothing after it did": stash_pending, null outcome,
    // no tail artifacts, no events.
    const { applyCancellationTransition: realApply } = await import("../../src/autonomous/cancellation-core.js");
    const crashingApply = (async (...applyArgs: Parameters<typeof realApply>) => {
      const session = applyArgs[1];
      const init = applyArgs[4]!;
      const raw = session.state as unknown as Record<string, unknown>;
      writeSessionSync(sessDir, {
        ...raw,
        cancellationTransition: {
          transitionId: init.transitionId,
          action: init.action,
          authority: init.authority,
          disposition: { kind: "no-ticket" },
          sessionId: session.state.sessionId,
          sessionStartedAt: new Date(Date.parse(raw.startedAt as string)).toISOString(),
          transitionStartedRevision: session.state.revision + 1,
          phase: "stash_pending",
          stash: { outcome: null },
        },
      } as unknown as FullSessionState);
      throw new Error("simulated crash after write 1");
    }) as typeof realApply;

    const first = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps({ apply: crashingApply }));
    expect(first.kind).toBe("refused");
    if (first.kind === "refused") expect(first.stage).toBe("transition");

    const mid = currentState();
    const midT = (mid as unknown as Record<string, unknown>).cancellationTransition as { phase: string; transitionId: string };
    expect(midT.phase).toBe("stash_pending");

    // THE RETRY: the driver routes through the stash_pending resume branch
    // (full candidate validation, then the shared core's resume path).
    const retry = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps());
    expect(retry.kind).toBe("published");
    if (retry.kind !== "published") return;
    expect(retry.resumed).toBe(true);
    const after = currentState();
    expect(after.state).toBe("SESSION_END");
    const t = CancellationTransitionSchema.safeParse(
      (after as unknown as Record<string, unknown>).cancellationTransition,
    );
    if (!t.success || t.data.phase !== "published") return;
    expect(t.data.transitionId).toBe(midT.transitionId);
    const intent = readCancellationIntent(sessDir);
    if (intent.kind === "valid") expect(intent.intent.phase).toBe("closed");
  });

  it("CRASH AFTER WRITE 1 ON A COMPACT SESSION: the durable cycle finishes, the fresh COMPACT gate is never consulted", async () => {
    // T-450 step 8.1. The COMPACT gate added to the fresh authorization path
    // must be UNREACHABLE from the resume path, and this is the case that
    // proves it through the commit driver itself, on the same crash seam the
    // sibling write-1 test uses, rather than through a state assembled by hand
    // to look crashed.
    //
    // The picture is a cycle MINTED BEFORE 8.1 EXISTED, when nothing refused a
    // COMPACT session. Its durable intent is what authorizes the retry, so
    // re-asking a fresh lifecycle question answers wrong by construction -- and
    // answering it would strand the cycle permanently, since nothing else can
    // finish it.
    // THE SESSION IS COMPACT BEFORE THE CYCLE STARTS, which is the only way
    // this picture is reachable. The resume path's revision equation refuses a
    // session written by anything else after write 1, so a session that goes
    // COMPACT AFTER write 1 is not a resumable cycle at all -- it is a foreign
    // write, and it is already refused as one.
    const planted = plantLive();
    writeSessionSync(sessDir, { ...planted, state: "COMPACT", status: "active" } as FullSessionState);
    writeMarker();
    const state = currentState();
    const input = inputFor(state);

    const { applyCancellationTransition: realApply } = await import("../../src/autonomous/cancellation-core.js");
    const crashingApply = (async (...applyArgs: Parameters<typeof realApply>) => {
      const session = applyArgs[1];
      const init = applyArgs[4]!;
      const raw = session.state as unknown as Record<string, unknown>;
      writeSessionSync(sessDir, {
        ...raw,
        cancellationTransition: {
          transitionId: init.transitionId,
          action: init.action,
          authority: init.authority,
          disposition: { kind: "no-ticket" },
          sessionId: session.state.sessionId,
          sessionStartedAt: new Date(Date.parse(raw.startedAt as string)).toISOString(),
          transitionStartedRevision: session.state.revision + 1,
          phase: "stash_pending",
          stash: { outcome: null },
        },
      } as unknown as FullSessionState);
      throw new Error("simulated crash after write 1");
    }) as typeof realApply;

    // The first attempt authorizes as PRE-8.1 CODE DID: the injected lifecycle
    // reader reports the state the gate did not look at. Nothing else about the
    // authorization or the intent is faked. The write-1 record itself is
    // constructed by the injected apply -- the same seam, and the same
    // construction, the sibling crash tests use: built from ITS OWN inputs the
    // way the shared core builds it, with the identity from state and the
    // transition revision the write produces.
    const first = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps({
      handshake: handshakeDeps({ readLifecycle: () => ({ state: "IMPLEMENT", status: "active" }) }),
      apply: crashingApply,
    }));
    expect(first.kind).toBe("refused");
    expect(currentState().state).toBe("COMPACT");

    // THE RETRY runs on the SHIPPED deps, so its fresh path carries the gate.
    // Reaching `published` is the proof it was never consulted.
    const retry = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps());
    expect(retry.kind, JSON.stringify(retry)).toBe("published");
    if (retry.kind !== "published") return;
    expect(retry.resumed).toBe(true);
    expect(currentState().state).toBe("SESSION_END");
  });

  it("CRASH AFTER WRITE 4: the published record finishes tail-only, and never re-evaluates eligibility", async () => {
    const state = plantLive();
    writeMarker();
    const input = inputFor(state);

    // A full commit, then reopen the crash window: marker removed, intent
    // reopened at authorized. That is the durable picture of a crash between
    // write 4 and the tail's completion marker.
    const done = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps());
    expect(done.kind).toBe("published");
    const t = (currentState() as unknown as Record<string, unknown>).cancellationTransition as { transitionId: string };
    rmSync(join(sessDir, "telemetry", "cancellation-complete.json"), { force: true });
    const closed = readCancellationIntent(sessDir);
    if (closed.kind !== "valid" || closed.intent.phase !== "closed") return;
    const { outcome: _o, ...open } = closed.intent as unknown as Record<string, unknown> & { outcome: unknown };
    writeFileSync(join(sessDir, "cancellation-intent.json"), JSON.stringify({ ...open, phase: "authorized" }, null, 2));

    // The retry validates the DURABLE authority only: the handshake deps
    // would now report the session terminal and the owner live, and the
    // published branch must not consult either.
    const retry = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, cancelDeps({
      handshake: handshakeDeps({
        readState: () => ({ lastGuideCall: new Date(NOW).toISOString(), mcpServerPid: process.pid,
          mcpGuideCallAt: new Date(NOW).toISOString(), lease: null, ownerTask: OWNER }),
      }),
    }));
    expect(retry.kind).toBe("published");
    if (retry.kind !== "published") return;
    expect(retry.resumed).toBe(true);
    expect(retry.close.ok).toBe(true);
    expect(classifyCompletionMarker(sessDir, t.transitionId).kind).toBe("matching");
    const intent = readCancellationIntent(sessDir);
    if (intent.kind === "valid") expect(intent.intent.phase).toBe("closed");
    expect(eventCount("cancelled")).toBe(1);
  });

  it("C2: write 4 rides the DURABLE writer for candidate authority, and the ordinary path never does", async () => {
    const state = plantLive();
    writeMarker();
    const points: string[] = [];
    const original = __stateWriteTesting.at;
    __stateWriteTesting.at = (p) => { points.push(p); };
    try {
      const result = await commitCandidateCancelLocked(root, sessDir, {
        input: inputFor(state), callerTask: CALLER,
      }, cancelDeps());
      expect(result.kind).toBe("published");
    } finally {
      __stateWriteTesting.at = original;
    }
    // The durable barrier ran, all four seams, exactly once: write 4 and
    // nothing else routed through it.
    for (const seam of ["state:tmp-written", "state:tmp-fsynced", "state:renamed", "state:dir-fsynced"]) {
      expect(points.filter((p) => p === seam)).toHaveLength(1);
    }

    // The ordinary path: a fresh session cancelled through the shared core
    // with NO init never touches the durable writer.
    const ordinary = plantLive();
    points.length = 0;
    __stateWriteTesting.at = (p) => { points.push(p); };
    try {
      const { applyCancellationTransition: realApply } = await import("../../src/autonomous/cancellation-core.js");
      await realApply(root, { dir: sessDir, state: ordinary }, { kind: "no-ticket" });
    } finally {
      __stateWriteTesting.at = original;
    }
    expect(points).toHaveLength(0);
  });

  it("TEST 11: a reused legacy pid is NOT signalled on the candidate's first pass", async () => {
    // The candidate first pass publishes, so the tail takes the VERIFY form
    // of killSidecar, and a LIVE pid whose argv carries no sidecar marker --
    // a real inert child standing in for the recycled pid -- is probed and
    // declined, never signalled. A blind kill here would be the takeover
    // shooting an unrelated process on a number. (Not this worker's own pid:
    // the suite teardown blind-SIGTERMs recorded sidecarPids, which is
    // exactly the behavior this test proves the CANDIDATE path avoids.)
    const { spawn } = await import("node:child_process");
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const state = plantLive({ sidecarPid: bystander.pid });
      writeMarker();
      const result = await commitCandidateCancelLocked(root, sessDir, {
        input: inputFor(state), callerTask: CALLER,
      }, cancelDeps());
      expect(result.kind).toBe("published");
      // The bystander survived the whole cancellation.
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
      process.kill(bystander.pid!, 0); // throws if it died
    } finally {
      try { bystander.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("DELTA (c): plain tail recovery refuses a candidate-authored record with the categorical message", async () => {
    const state = plantLive();
    writeMarker();
    const done = await commitCandidateCancelLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, cancelDeps());
    expect(done.kind).toBe("published");

    const { authorizeTailRecovery } = await import("../../src/autonomous/cancellation-core.js");
    const { readCancellationTransition } = await import("../../src/autonomous/cancellation-transition.js");
    const after = currentState();
    const prior = readCancellationTransition(
      (after as unknown as Record<string, unknown>).cancellationTransition,
    );
    const verdict = authorizeTailRecovery(sessDir, after, prior, CALLER.id);
    expect(verdict.kind).toBe("refuse");
    if (verdict.kind === "refuse") expect(verdict.message).toContain("candidate");
  });
});

describe("T-450 6b: the content-gated cancellation close (C2)", () => {
  const TID = "22222222-2222-4222-8222-222222222222";

  function stagedIntent(over: Record<string, unknown> = {}): void {
    plantLive();
    writeFileSync(join(sessDir, "cancellation-intent.json"), JSON.stringify({
      schemaVersion: 1,
      transitionId: TID,
      cycleNonce: "11111111-1111-4111-8111-111111111111",
      confirmationEpoch: 0,
      clientTaskId: CALLER.id,
      sessionId,
      sessionStartedAt: new Date(NOW - 3_600_000).toISOString(),
      confirmedSessionRevision: 1,
      confirmedFingerprint: "fp-1",
      evidence: {
        activity: { kind: "unknown", reason: "absent" },
        lease: { kind: "unknown", reason: "absent" },
        deathMarker: { kind: "unreadable", reason: "absent" },
        markerValidity: { kind: "unknown", reason: "no-recorded-pid", pid: null },
        sidecarProbe: { kind: "unknown", reason: "no-pid", pid: null },
        observedAt: new Date(NOW).toISOString(),
        staleThresholdMs: 2_700_000,
        successors: { kind: "unavailable", reason: "test fixture" },
      },
      ticketPreimage: null,
      phase: "claim_cleared",
      ...over,
    }, null, 2));
  }

  function publishedRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      transitionId: TID,
      action: "candidate_recovery_takeover",
      authority: {
        kind: "candidate", clientTaskId: CALLER.id, confirmedSessionRevision: 1,
        confirmedFingerprint: "fp-1",
        evidence: {
          activity: { kind: "unknown", reason: "absent" },
          lease: { kind: "unknown", reason: "absent" },
          deathMarker: { kind: "unreadable", reason: "absent" },
          markerValidity: { kind: "unknown", reason: "no-recorded-pid", pid: null },
          sidecarProbe: { kind: "unknown", reason: "no-pid", pid: null },
          observedAt: new Date(NOW).toISOString(),
          staleThresholdMs: 2_700_000,
          successors: { kind: "unavailable", reason: "test fixture" },
        },
      },
      disposition: { kind: "no-ticket" },
      sessionId,
      sessionStartedAt: new Date(NOW - 3_600_000).toISOString(),
      transitionStartedRevision: 2,
      phase: "published",
      stash: { outcome: "none" },
      endedAt: new Date(NOW).toISOString(),
      terminalRevision: 4,
      shutdownArtifact: { schemaVersion: 1, filename: "cancellation-shutdown.json" },
      ...over,
    };
  }

  it("closes from claim_cleared on a durable published transition, and is idempotent", () => {
    stagedIntent();
    const result = closeCancellationIntentOnPublication(sessDir, {
      cancellationTransition: publishedRecord(), sessionRevision: 4,
    });
    expect(result.ok).toBe(true);
    const intent = readCancellationIntent(sessDir);
    if (intent.kind !== "valid" || intent.intent.phase !== "closed") return;
    expect(intent.intent.outcome).toEqual({ kind: "cancellation", transitionId: TID });

    const again = closeCancellationIntentOnPublication(sessDir, {
      cancellationTransition: publishedRecord(), sessionRevision: 4,
    });
    expect(again.ok).toBe(true);
  });

  it("refuses every non-proving transition, each with its own reason", () => {
    // Every durable is a THUNK, built AFTER `stagedIntent()` plants the
    // session: `publishedRecord()` reads the module-level `sessionId`, so a
    // prebuilt record would carry whatever the previous test left there --
    // absent under a `-t` filter, stale in a full run -- and the reader
    // would refuse it for the wrong reason while the assertion still passed.
    const cases: Array<{ name: string; durable: () => { cancellationTransition: unknown; sessionRevision: number }; reason: string; detail?: string }> = [
      { name: "absent", durable: () => ({ cancellationTransition: undefined, sessionRevision: 9 }), reason: "not-committed" },
      { name: "malformed", durable: () => ({ cancellationTransition: { phase: "published" }, sessionRevision: 9 }), reason: "not-committed" },
      { name: "another transition's publication",
        durable: () => ({ cancellationTransition: publishedRecord({ transitionId: "33333333-3333-4333-8333-333333333333" }), sessionRevision: 9 }),
        reason: "not-committed" },
      { name: "not yet published",
        // A GENUINELY VALID stash_pending record, not a published one with
        // fields blanked: the stash_pending schema arm is strict, so keys
        // present-with-undefined would fail the READER and this case would
        // never reach the phase gate it exists to pin.
        durable: () => {
          const { endedAt: _e, terminalRevision: _r, shutdownArtifact: _s, ...rest } =
            publishedRecord() as Record<string, unknown>;
          return {
            cancellationTransition: { ...rest, phase: "stash_pending", stash: { outcome: null } },
            sessionRevision: 9,
          };
        },
        reason: "not-committed", detail: "not published" },
      { name: "publication not durable yet (terminalRevision ahead of state)",
        durable: () => ({ cancellationTransition: publishedRecord(), sessionRevision: 3 }),
        reason: "not-committed", detail: "not durable yet" },
    ];
    for (const c of cases) {
      stagedIntent();
      const result = closeCancellationIntentOnPublication(sessDir, c.durable());
      expect(result.ok, c.name).toBe(false);
      if (!result.ok) expect(result.reason, c.name).toBe(c.reason);
      // WHERE it refused matters as much as that it did: "not published" only
      // ever comes from the phase gate, proving the record survived the
      // reader and the gate itself answered.
      if (!result.ok && c.detail) expect(result.detail, c.name).toContain(c.detail);
      const intent = readCancellationIntent(sessDir);
      if (intent.kind === "valid") expect(intent.intent.phase, c.name).toBe("claim_cleared");
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "t450-commit-"));
      setupProject(root);
    }
  });

  it("T-450 step 9: refuses a TRANSPLANTED or non-candidate record, however well the id matches", () => {
    // The gate close applies is retirement's, and until step 9 that was a claim
    // in a docstring rather than a fact. Close read a record out of SESSION
    // STATE -- a file an operator can edit -- and checked only that its
    // transitionId was this intent's.
    //
    // WHY THAT IS WORSE THAN MISSING A LIE. Closing on a bad record writes
    // `phase: "closed"` with an outcome that retirement then REFUSES, on the
    // provenance and authority checks close did not make. The intent is left
    // neither retryable nor retirable: the loose gate does not merely fail to
    // catch, it strands.
    //
    // Every case below is SCHEMA-VALID and carries this intent's transitionId,
    // so each one reaches the gate under test rather than dying at the reader.
    const cases: Array<{ name: string; over: Record<string, unknown>; detail: string }> = [
      { name: "foreign sessionId",
        over: { sessionId: "cccccccc-1111-4222-8333-444444444444" },
        detail: "another session's publication" },
      { name: "foreign incarnation (sessionStartedAt)",
        over: { sessionStartedAt: "2020-01-01T00:00:00.000Z" },
        detail: "another session's publication" },
      { name: "an ORDINARY cancellation under legacy authority",
        over: { action: "ordinary_cancellation", authority: { kind: "legacy" } },
        detail: "candidate recovery record" },
      { name: "candidate authority held by a DIFFERENT client task",
        over: { authority: { kind: "candidate", clientTaskId: "some-other-task",
          confirmedSessionRevision: 1, confirmedFingerprint: "fp-1",
          evidence: (publishedRecord().authority as { evidence: unknown }).evidence } },
        detail: "another client task" },
    ];
    for (const c of cases) {
      stagedIntent();
      const result = closeCancellationIntentOnPublication(sessDir, {
        cancellationTransition: publishedRecord(c.over), sessionRevision: 4,
      });
      expect(result.ok, c.name).toBe(false);
      if (!result.ok) {
        expect(result.reason, c.name).toBe("not-committed");
        // WHERE it refused, not merely that it did: each detail belongs to one
        // gate, so a case dying at the reader or at an earlier check would be
        // caught here rather than counted as coverage.
        expect(result.detail, c.name).toContain(c.detail);
      }
      // AND THE CYCLE IS STILL ALIVE. The refusal has to leave the intent
      // retryable; that is the whole reason a strict check is affordable here.
      // Validity is asserted rather than used as a guard: a regression that
      // DELETED or corrupted the intent would skip a guarded phase check and
      // leave this test green while contradicting its whole claim.
      const intent = readCancellationIntent(sessDir);
      expect(intent.kind, c.name).toBe("valid");
      if (intent.kind !== "valid") continue;
      expect(intent.intent.phase, c.name).toBe("claim_cleared");
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "t450-commit-"));
      setupProject(root);
    }
  });

  it("T-450 step 9: a PRE-ISS-967 record carrying the takeover literal still closes", () => {
    // The compatibility half, and the one a careless implementation of the
    // check above breaks. Before ISS-967 the cancel commit stamped
    // `candidate_recovery_takeover` into the record of a session it had ENDED,
    // because that was the only candidate value the enum had. Those cycles are
    // still out there, and a cancellation-only action check would strand
    // exactly the ones the readoption gate was widened to let finish.
    stagedIntent();
    const result = closeCancellationIntentOnPublication(sessDir, {
      cancellationTransition: publishedRecord({ action: "candidate_recovery_takeover" }),
      sessionRevision: 4,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const intent = readCancellationIntent(sessDir);
    expect(intent.kind).toBe("valid");
    if (intent.kind !== "valid") return;
    expect(intent.intent.phase).toBe("closed");
  });

  it("refuses to close over a nested claim transaction, and allows the no-ticket authorized close", () => {
    stagedIntent({
      phase: "prepared",
      claimTxn: {
        kind: "release", ticketId: "T-001", transitionId: TID,
        fromEpoch: null, toEpoch: null,
        fromBusiness: { ticketId: "T-001", lifecycle: { present: false, value: null }, status: { present: true, value: "inprogress" }, completedDate: { present: false, value: null }, claim: { present: false, value: null }, claimedBySession: { present: true, value: "s" } },
        toBusiness: { ticketId: "T-001", lifecycle: { present: false, value: null }, status: { present: true, value: "open" }, completedDate: { present: false, value: null }, claim: { present: false, value: null }, claimedBySession: { present: false, value: null } },
        startedAt: new Date(NOW).toISOString(),
        phase: "prepared",
      },
    });
    const refused = closeCancellationIntentOnPublication(sessDir, {
      cancellationTransition: publishedRecord(), sessionRevision: 4,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("edge-refused");

    stagedIntent({ phase: "authorized" });
    const allowed = closeCancellationIntentOnPublication(sessDir, {
      cancellationTransition: publishedRecord(), sessionRevision: 4,
    });
    expect(allowed.ok).toBe(true);
  });

  it("refuses a cross-outcome close: a takeover-closed cycle cannot also be a cancellation", () => {
    stagedIntent({ phase: "closed", outcome: { kind: "takeover", committedRevision: 3 } });
    const result = closeCancellationIntentOnPublication(sessDir, {
      cancellationTransition: publishedRecord(), sessionRevision: 4,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("takeover-postimage-conflict");
  });
});

describe("T-450 6b: resume validation refuses what it cannot prove", () => {
  it("stash_pending resume refuses each broken axis with a named detail", async () => {
    // Every axis of the pre-publication validation, broken one at a time.
    // The staging runs the honest crash path once (write 1 landed, nothing
    // after), then each case tampers exactly one thing and expects the
    // driver to refuse at resume-validation rather than publish over it.
    const stage = async () => {
      const state = plantLive();
      writeMarker();
      const input = inputFor(state);
      const { applyCancellationTransition: realApply } = await import("../../src/autonomous/cancellation-core.js");
      const crashingApply = (async (...applyArgs: Parameters<typeof realApply>) => {
        const session = applyArgs[1];
        const init = applyArgs[4]!;
        const raw = session.state as unknown as Record<string, unknown>;
        writeSessionSync(sessDir, {
          ...raw,
          cancellationTransition: {
            transitionId: init.transitionId,
            action: init.action,
            authority: init.authority,
            disposition: { kind: "no-ticket" },
            sessionId: session.state.sessionId,
            sessionStartedAt: new Date(Date.parse(raw.startedAt as string)).toISOString(),
            transitionStartedRevision: session.state.revision + 1,
            phase: "stash_pending",
            stash: { outcome: null },
          },
        } as unknown as FullSessionState);
        throw new Error("simulated crash after write 1");
      }) as typeof realApply;
      const first = await commitCandidateCancelLocked(root, sessDir, {
        input, callerTask: CALLER,
      }, { handshake: handshakeDeps(), apply: crashingApply });
      expect(first.kind).toBe("refused");
      return input;
    };

    // CALLER IDENTITY: another task cannot finish this transition.
    let input = await stage();
    const foreign = await commitCandidateCancelLocked(root, sessDir, {
      input: { ...input, clientTaskId: "task-interloper" },
      callerTask: { ...CALLER, id: "task-interloper" },
    }, { handshake: handshakeDeps() });
    expect(foreign.kind).toBe("refused");
    if (foreign.kind === "refused") {
      // The intent guard answers first (the intent is also task-bound); both
      // spellings refuse before anything writes.
      expect(["intent", "resume-validation"]).toContain(foreign.stage);
    }

    // REVISION EQUATION: something else wrote the session after the crash.
    input = await stage();
    writeSessionSync(sessDir, currentState());
    const moved = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, { handshake: handshakeDeps() });
    expect(moved.kind).toBe("refused");
    if (moved.kind === "refused") {
      expect(moved.stage).toBe("resume-validation");
      expect(moved.detail).toContain("equation");
    }

    // FINGERPRINT: the picture changed since the confirmation.
    input = await stage();
    const changed = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, {
      handshake: handshakeDeps({
        readState: () => ({ ...livenessStateOf(currentState()), lastGuideCall: new Date(NOW - 60 * 60_000).toISOString() }),
      }),
    });
    expect(changed.kind).toBe("refused");
    if (changed.kind === "refused") {
      expect(changed.stage).toBe("resume-validation");
      expect(changed.detail).toContain("picture");
    }

    // ELIGIBILITY: the owner is no longer gone.
    input = await stage();
    const back = await commitCandidateCancelLocked(root, sessDir, {
      input, callerTask: CALLER,
    }, {
      handshake: handshakeDeps({ staleThresholdMs: 365 * 24 * 3_600_000 }),
    });
    expect(back.kind).toBe("refused");
    if (back.kind === "refused") expect(back.stage).toBe("resume-validation");
  });
});

describe("T-450 6b: adoption and the staged-generation race", () => {
  it("EPOCH IS AUDIT-ONLY: a close whose intent drifted past the postimage's epoch still derives", async () => {
    // The crash history the ruling names legal: the postimage lands, then a
    // re-authorization re-mints the confirmation (bumping the epoch and the
    // pair) before the close runs. The nonce rides the whole-record pin
    // through that re-mint, and the close gates on IT alone -- an epoch
    // comparison here would make exactly this recovery history permanently
    // unclosable, recreating the foreclosure the protocol exists to prevent.
    const state = plantLive();
    writeMarker();
    const first = await commitCandidateTakeoverLocked(root, sessDir, {
      input: inputFor(state), callerTask: CALLER,
    }, {
      handshake: handshakeDeps(),
      stage: () => fakeStaged(),
      validateStaged: () => ({ ok: true, argvProof: "proven" }),
      discardStaged: () => undefined,
      withProjectLock: async (fn) => { await fn(); },
    });
    expect(first.kind).toBe("committed");
    if (first.kind !== "committed") return;

    // Reopen the close window WITH the drift adoption would have left: same
    // identity, same nonce, higher epoch, re-minted pair.
    const closed = readCancellationIntent(sessDir);
    if (closed.kind !== "valid" || closed.intent.phase !== "closed") return;
    const { outcome: _o, ...open } = closed.intent as unknown as Record<string, unknown> & { outcome: unknown };
    writeFileSync(join(sessDir, "cancellation-intent.json"), JSON.stringify({
      ...open,
      phase: "authorized",
      confirmationEpoch: closed.intent.confirmationEpoch + 3,
      confirmedSessionRevision: closed.intent.confirmedSessionRevision + 2,
      confirmedFingerprint: "fp-re-minted",
      adoptedFromEpoch: closed.intent.confirmationEpoch,
    }, null, 2));

    const raw = currentState() as unknown as Record<string, unknown>;
    const close = closeTakeoverIntent(sessDir, {
      candidateTakeover: raw.candidateTakeover,
      committedRevision: (currentState()).revision,
    });
    expect(close.ok).toBe(true);
    const reclosed = readCancellationIntent(sessDir);
    if (reclosed.kind === "valid" && reclosed.intent.phase === "closed") {
      // The drifted confirmation survived the close verbatim: nothing was
      // rolled back to match the postimage's audit epoch.
      expect(reclosed.intent.confirmationEpoch).toBe(closed.intent.confirmationEpoch + 3);
      expect(reclosed.intent.cycleNonce).toBe(closed.intent.cycleNonce);
    }
  });

  it("TEST 6: a staged generation invalidated while the lock is delayed refuses and discards", async () => {
    // REAL staging, validation and discard, over the 6a suites' fake-child
    // hook (no live process, so nothing to leak). The child "exits and loses
    // its signature" while `withProjectLock` sits on the acquisition, which
    // is exactly the window `validateStagedGeneration` exists for: readiness
    // passed before the lock, and that answer must not publish.
    const state = plantLive();
    writeMarker();
    const { stageHeartbeatGeneration, validateStagedGeneration, discardStagedGeneration, __testing } =
      await import("../../src/autonomous/liveness.js");
    const realProbe = __testing.probeApi.probeArgvSignature;
    let probeAnswer: "match" | "absent" = "match";
    // Scoped to the FAKE child's pid: the liveness probe of the dead owner
    // must keep answering through the real probe, or the override would
    // change the fingerprint and the refusal would come from validation
    // instead of the generation gate this test is about.
    __testing.probeApi.probeArgvSignature = (pid: number, markers: readonly string[]) =>
      pid === 999_999 ? probeAnswer : realProbe(pid, markers);

    let staged: StagedHeartbeatGeneration | null = null;
    try {
      const result = await commitCandidateTakeoverLocked(root, sessDir, {
        input: inputFor(state), callerTask: CALLER,
      }, {
        handshake: handshakeDeps(),
        stage: () => {
          __testing.stagingHooks.spawn = (dir: string) => {
            writeFileSync(join(dir, "alive"), String(Date.now()));
            return { pid: 999_999, terminate: () => undefined };
          };
          staged = stageHeartbeatGeneration(sessDir, { intervalMs: 50, readinessTimeoutMs: 400, pollMs: 25 });
          __testing.stagingHooks.spawn = null;
          return staged;
        },
        validateStaged: validateStagedGeneration,
        discardStaged: discardStagedGeneration,
        withProjectLock: async (fn) => {
          // The delay window: the staged child is gone by the time the lock
          // is held, and its pid no longer carries the sidecar signature.
          probeAnswer = "absent";
          await fn();
        },
      });

      expect(staged).not.toBeNull();
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.stage).toBe("generation");
      // The REAL discard ran and the bounded removal emptied the directory.
      const dir = (staged! as unknown as { dir: string }).dir;
      expect(existsSync(dir)).toBe(false);
    } finally {
      __testing.probeApi.probeArgvSignature = realProbe;
      __testing.stagingHooks.spawn = null;
      if (staged !== null) {
        try { discardStagedGeneration(staged); } catch { /* already discarded */ }
      }
    }
  });
});
