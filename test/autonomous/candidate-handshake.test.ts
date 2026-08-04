/**
 * T-450 step 6b: `authorizeCandidateCancel`, the five-step handshake.
 *
 * The CANCEL variant is what this suite drives, deliberately. The handshake now
 * has two entry points over one core, and only cancel is the matrix-free one:
 * `authorizeCandidateTakeover` runs the per-state takeover authority matrix on
 * top, which is a separate question with its own tests. Pointing these at the
 * takeover variant would quietly turn handshake tests into posture tests.
 *
 * This is the gate between "a human was shown an owner-gone offer" and "a
 * takeover or cancellation may be committed". Two checks carry it, and keeping
 * them APART is the whole design:
 *
 *   CHECK 1 asks did the picture change: the fingerprint of what was OBSERVED,
 *   recomputed from freshly read signals, must equal what the human confirmed,
 *   and the session revision must not have moved. It is deliberately
 *   time-independent, so it cannot answer the second question.
 *
 *   CHECK 2 asks is it still eligible NOW: liveness re-evaluated against the
 *   current clock. This is what catches "same raw signals, owner no longer
 *   stale", which check 1 cannot see by construction.
 *
 * The handshake MUTATES NOTHING. Re-authorization after a revision move must
 * be cheap and repeatable, because the candidate invariant relies on it being
 * re-run rather than worked around.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { authorizeCandidateCancel, authorizeCandidateTakeover } from "../../src/autonomous/candidate-recovery.js";
import {
  evidenceFingerprint,
  readOwnerLiveness,
  telemetryDirPath,
  OWNER_STALE_MS,
  type OwnableLivenessState,
} from "../../src/autonomous/liveness.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import type { SuccessorServers, RegisteredServer } from "../../src/autonomous/mcp-registry.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const STALE_AT = new Date(NOW - 30 * 60_000).toISOString();
const OWNER = { client: "claude" as const, id: "task-owner", boundAt: "2026-08-02T10:00:00.000Z" };
const CALLER = "task-candidate";
const SESSION = "eeeeeeee-1111-4222-8333-444444444444";

let sessDir: string;

/** A dead pid: allocated then reaped, so probes answer definitively absent. */
let cachedDeadPid: number | null = null;

function deadPid(): number {
  // ALLOCATED AND REAPED, not assumed. The constant this replaced (2^22 - 1)
  // was justified as being above the default pid_max, which is not a property
  // of the machine the suite runs on: Linux permits `pid_max` up to 2^22, so
  // on a host configured that way the "dead" pid is a valid live one and
  // these tests silently start asserting the wrong branch. `spawnSync` runs
  // its child to completion and reaps it before returning, so its pid is
  // genuinely free, and the signal-0 probe confirms it rather than trusting
  // it.
  if (cachedDeadPid !== null) return cachedDeadPid;
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof child.pid !== "number") throw new Error("could not allocate a pid to reap");
  try {
    process.kill(child.pid, 0);
    throw new Error(`pid ${child.pid} is still live after being reaped, so it cannot stand in for a dead one`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  cachedDeadPid = child.pid;
  return cachedDeadPid;
}

/** The observations that reach `gone-candidate`. */
function candidateState(over: Partial<OwnableLivenessState> = {}): OwnableLivenessState {
  return {
    lastGuideCall: STALE_AT,
    mcpServerPid: deadPid(),
    mcpGuideCallAt: STALE_AT,
    lease: null,
    ownerTask: OWNER,
    ...over,
  };
}

/** The telemetry half: a shutdown marker plus a sidecar pid file. */
function writeMarker(pid: number): void {
  const tDir = telemetryDirPath(sessDir);
  mkdirSync(tDir, { recursive: true });
  const marker = join(tDir, "shutdown");
  writeFileSync(marker, STALE_AT);
  // MTIME IS THE SIGNAL, and it must come from the INJECTED clock.
  //
  // `readDeathMarker` never reads this file's contents: it stats the file and
  // compares `st.mtime` against the `now` it was handed. Leaving the mtime at
  // the real wall-clock time means the test controls one clock and the
  // filesystem controls the other, and the comparison is then
  // `realNow - NOW`. That is negative only while real time is BEHIND the
  // pinned constant, so the whole suite passes until the wall clock crosses
  // it and then reads every marker as `future`, which is unreadable, which
  // makes the verdict `undetermined` and fails the fixture precondition in
  // `shown()` rather than any assertion. See ISS-957: a fake clock pinned to
  // a then-future date is a bomb whose fuse is the calendar.
  const at = new Date(Date.parse(STALE_AT));
  utimesSync(marker, at, at);
  writeFileSync(join(tDir, "sidecar.pid"), String(pid));
}

const NO_SERVERS: SuccessorServers = { kind: "observed", servers: [] };

/** The verdict a caller would have been SHOWN, and its fingerprint. */
function shown(state: OwnableLivenessState = candidateState()) {
  const verdict = readOwnerLiveness(sessDir, () => state, NOW, OWNER_STALE_MS, () => NO_SERVERS);
  if (verdict.kind !== "gone-candidate") throw new Error(`fixture is ${verdict.kind}, not gone-candidate`);
  return { verdict, fingerprint: evidenceFingerprint(verdict.signals) };
}

/** The revision every test here confirms against, and the one the session
 * state reports unless a test moves it on purpose. */
const REVISION = 4;

/**
 * THE SERVER-DERIVED HALF of the picture.
 *
 * `sessionRevision`, `ticket` and `claimEpoch` used to travel in the handshake
 * INPUT, alongside what the caller confirmed. They are now read by the
 * handshake itself out of `deps.readSessionState()`, so the fixture carries
 * them here instead: the value a test used to pass is still the value the code
 * decides on, it just arrives by the provenance the split established.
 */
function depsFor(
  state: OwnableLivenessState,
  over: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
) {
  return {
    now: () => NOW,
    staleThresholdMs: OWNER_STALE_MS,
    readState: () => state,
    // A LIVE session by default: the terminal gate (C3) has its own tests,
    // and every other test here is about a session that is still running.
    readLifecycle: () => ({ state: "IMPLEMENT", status: "active" }),
    readSuccessors: () => NO_SERVERS,
    loadTicket: async () => null,
    // Required by the deps contract. This suite drives the CANCEL variant,
    // which never consults the issue rows, so the positive `null` is exact.
    loadIssue: async () => null,
    readSessionState: () =>
      ({ revision: REVISION, ticket: null, claimEpoch: null, ...session }) as unknown as FullSessionState,
    ...over,
  };
}

let root: string;

beforeEach(() => {
  // The session directory is NAMED by its session id, exactly as
  // `sessionDir(root, sessionId)` builds it, because the handshake binds the
  // authorization to the directory it took its evidence from.
  root = mkdtempSync(join(tmpdir(), "t450-handshake-"));
  sessDir = join(root, ".story", "sessions", SESSION);
  mkdirSync(sessDir, { recursive: true });
  writeMarker(deadPid());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("T-450 6b: the handshake authorizes only what was confirmed", () => {
  it("authorizes when the picture is unchanged and the owner is still gone", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);

    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION,
      clientTaskId: CALLER,
      confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    // The payload IS the persisted candidate authority arm, ready to hand to
    // `applyCancellationTransition`'s init without reshaping.
    expect(result.authority.kind).toBe("candidate");
    expect(result.authority.clientTaskId).toBe(CALLER);
    expect(result.authority.confirmedSessionRevision).toBe(4);
    expect(result.authority.confirmedFingerprint).toBe(fingerprint);
    // Evidence persisted through the shipped schema, never re-projected.
    expect(result.authority.evidence.staleThresholdMs).toBe(OWNER_STALE_MS);
    expect(result.authority.evidence.observedAt).toBe(new Date(NOW).toISOString());
  });

  it("mutates NOTHING: the session directory is byte-identical afterwards", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);
    const before = readdirSync(telemetryDirPath(sessDir)).sort();

    await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state));

    expect(readdirSync(telemetryDirPath(sessDir)).sort()).toEqual(before);
    expect(readdirSync(sessDir).sort()).toEqual(["telemetry"]);
  });

  it("CHECK 1 refuses a changed picture and returns FRESH evidence to re-confirm", async () => {
    // The human confirmed one picture; something in it moved before the
    // confirmation arrived. Authorizing would take over on a picture nobody
    // was shown. The refusal carries the CURRENT evidence so the caller can
    // re-present rather than starting over blind.
    const state = candidateState();
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: "fp-from-a-different-picture",
    }, depsFor(state));

    expect(result.kind).toBe("re-confirm");
    if (result.kind !== "re-confirm") return;
    expect(result.reason).toBe("fingerprint-changed");
    expect(result.fresh.fingerprint).toBe(shown(state).fingerprint);
    expect(result.fresh.evidence.observedAt).toBe(new Date(NOW).toISOString());
  });

  it("CHECK 1 refuses a moved session revision, and says both numbers", async () => {
    // The revision half of check 1. It is what makes the candidate invariant
    // (tSR === confirmed + 1) reachable at write 1: anything that moved the
    // session invalidates the confirmation here rather than at the write.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
      // The state's revision differs from the confirmed one, which is the
      // whole staging: the session moved between being shown and confirmed.
    }, depsFor(state, {}, { revision: 7 }));

    expect(result.kind).toBe("re-confirm");
    if (result.kind !== "re-confirm") return;
    expect(result.reason).toBe("revision-moved");
    expect(result.detail).toContain("4");
    expect(result.detail).toContain("7");
  });

  it("CHECK 2 refuses when the owner is no longer stale, with the fingerprint UNCHANGED", async () => {
    // THE ELIGIBILITY-ONLY CASE, and the reason the two checks are separate.
    // Every stored signal is held fixed while the stale threshold moves, so
    // the fingerprint (which excludes time and policy by design) stays EQUAL
    // while the verdict flips candidate -> active. Forward elapsed time could
    // not stage this: it would change the ages the fingerprint digests.
    const state = candidateState();
    const { fingerprint } = shown(state);

    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, { staleThresholdMs: 60 * 60_000 }));

    expect(result.kind).toBe("ineligible");
    if (result.kind !== "ineligible") return;
    expect(result.verdict).toBe("active");
  });

  it("CHECK 2 refuses an UNDETERMINED verdict even when check 1 passes", async () => {
    // The gate is `permitsRecoveryOffer` and nothing else (B-3), which is
    // strictly narrower than "not active". Evidence we could not confirm may
    // not authorize, and the caller is owed a sentence naming what is missing.
    // Check 1 is made to PASS here, by confirming this picture's own
    // fingerprint, so the refusal can only come from check 2.
    const state = candidateState({ lastGuideCall: "not-a-date" });
    const verdict = readOwnerLiveness(sessDir, () => state, NOW, OWNER_STALE_MS, () => NO_SERVERS);
    expect(verdict.kind).toBe("undetermined");

    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: evidenceFingerprint(verdict.signals),
    }, depsFor(state));

    expect(result.kind).toBe("ineligible");
    if (result.kind !== "ineligible") return;
    expect(result.verdict).toBe("undetermined");
    expect(result.detail).toContain("could not be confirmed");
  });

  it("CHECK 2 refuses a CONTRADICTED verdict even when check 1 passes", async () => {
    // A live successor whose identity is the owner's own proves the owner's
    // client is alive, so the death marker records a restart rather than the
    // client going away. That is evidence that DISAGREES, not evidence that is
    // missing, and it gets its own sentence.
    const state = candidateState();
    const successors: SuccessorServers = {
      kind: "observed",
      servers: [{ pid: process.pid, identity: OWNER, registeredAt: STALE_AT }],
    };
    const verdict = readOwnerLiveness(sessDir, () => state, NOW, OWNER_STALE_MS, () => successors);
    expect(verdict.kind).toBe("contradicted");

    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: evidenceFingerprint(verdict.signals),
    }, depsFor(state, { readSuccessors: () => successors }));

    expect(result.kind).toBe("ineligible");
    if (result.kind !== "ineligible") return;
    expect(result.verdict).toBe("contradicted");
  });

  it("refuses when the observed signals do not fit the persisted evidence record", async () => {
    // The evidence is the authorization's audit trail. If the signals cannot
    // round-trip through the shipped schema, an authorization written from
    // them would be unreadable to every future validator, so the handshake
    // refuses rather than minting authority nothing can later verify. A
    // registry over the schema's 64-server bound is the reachable way to
    // stage it.
    const state = candidateState();
    const tooMany: SuccessorServers = {
      kind: "observed",
      servers: Array.from({ length: 65 }, (_, i) => ({
        pid: 100_000 + i, identity: null, registeredAt: STALE_AT,
      })),
    };
    const verdict = readOwnerLiveness(sessDir, () => state, NOW, OWNER_STALE_MS, () => tooMany);

    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: evidenceFingerprint(verdict.signals),
    }, depsFor(state, { readSuccessors: () => tooMany }));

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("unpersistable-evidence");
  });

  it("refuses when the authorization names a different session than the evidence directory", async () => {
    // Every signal comes out of `sessionDir`, so an authorization naming
    // another session would carry evidence about one session as authority
    // over another. The directory's own name is the binding.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: "11111111-2222-4333-8444-555555555555",
      clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state));

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("session-mismatch");
  });

  it("refuses a caller with no task identity: candidate authority is task-bound", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: undefined, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state));

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("no-caller-identity");
  });

  it("refuses a caller that IS the recorded owner: that is a resume, not a recovery", async () => {
    // Taking over from yourself is never the owner-gone path. The ordinary
    // same-owner resume already covers it, and routing it here would mint
    // candidate authority for a session that was never anyone else's.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: OWNER.id, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state));

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("caller-is-owner");
  });

  it("refuses a TERMINAL session even when every liveness signal would authorize (C3)", async () => {
    // The eligibility gate judges the OWNER's liveness, and a cleanly ended
    // session's owner is legitimately gone -- so without this gate a terminal
    // session is a PERFECT candidate: stale activity, surviving death marker,
    // nothing to contradict. Ruling ea611619 C3: cancellation ends a session
    // and this one already ended; takeover continues a live session, and a
    // terminal one has nothing to continue. Both lifecycle spellings refuse.
    const state = candidateState();
    const { fingerprint } = shown(state);
    for (const lifecycle of [
      { state: "SESSION_END", status: "completed" },
      { state: "SESSION_END", status: "active" },
      { state: "IMPLEMENT", status: "completed" },
    ]) {
      const result = await authorizeCandidateCancel(sessDir, {
        sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
        confirmedFingerprint: fingerprint,
      }, depsFor(state, { readLifecycle: () => lifecycle }));

      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") continue;
      expect(result.reason).toBe("session-terminal");
      expect(result.detail).toContain(lifecycle.state);
    }
  });

  it("refuses a COMPACT session on BOTH doors, takeover included (step 8.1)", async () => {
    // The gate is OPERATION-AGNOSTIC, and the takeover arm is the reason this
    // test exists rather than a cancel-only one. On the takeover path the
    // guide refuses COMPACT first (guide.ts, "the candidate handshake is for
    // LIVE non-COMPACT sessions"), so the core's arm is reachable only by a
    // DIRECT core caller -- which is exactly what this test is. Without it the
    // arm would be unpinned code whose removal no test notices.
    //
    // It is kept anyway because the invariant belongs to the handshake, not to
    // one door: a COMPACT session is not a FRESH owner-gone recovery candidate
    // whichever operation asks, so a future third door inherits the refusal
    // instead of re-deriving it, and the takeover path stays refused in the
    // core if the guide-level check is ever refactored away.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const input = {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    };
    const deps = depsFor(state, { readLifecycle: () => ({ state: "COMPACT", status: "active" }) });

    for (const [label, authorize] of [
      ["cancel", authorizeCandidateCancel],
      ["takeover", authorizeCandidateTakeover],
    ] as const) {
      const result = await authorize(sessDir, input, deps);
      expect(result.kind, `${label} did not refuse a COMPACT session`).toBe("refused");
      if (result.kind !== "refused") continue;
      expect(result.reason).toBe("session-compact");
      // The remedy, in full. A refusal that does not name a followable next
      // step sends the operator to the admin CLI, which is the fail-open this
      // whole ticket exists to close.
      expect(result.detail).toContain(`{ "sessionId": "${SESSION}", "action": "resume", "takeover": true }`);
    }
  });

  it("the terminal gate is a PROVIDER read at authorize time, not a snapshot", async () => {
    // A session can end between two authorizations. The first call sees the
    // live session and authorizes; the second sees the terminal one and
    // refuses. A captured snapshot could not tell them apart.
    const state = candidateState();
    const { fingerprint } = shown(state);
    let lifecycle = { state: "IMPLEMENT", status: "active" };
    const deps = depsFor(state, { readLifecycle: () => lifecycle });
    const input = {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    };

    expect((await authorizeCandidateCancel(sessDir, input, deps)).kind).toBe("authorized");
    lifecycle = { state: "SESSION_END", status: "completed" };
    const second = await authorizeCandidateCancel(sessDir, input, deps);
    expect(second.kind).toBe("refused");
    if (second.kind === "refused") expect(second.reason).toBe("session-terminal");
  });
});

describe("T-450 6b: the handshake reconciles the claim before authorizing", () => {
  const TICKET = { id: "T-001", title: "t", risk: "low" as const, claimed: true };
  const EPOCH = {
    ticketId: "T-001", sessionId: SESSION, user: null, branch: null, since: null,
    establishedAt: "2026-08-02T11:00:00.000Z",
  };

  function heldTicket() {
    return {
      id: "T-001", title: "t", status: "inprogress", type: "task", phase: "p1", order: 1,
      description: "", createdDate: "2026-08-01", completedDate: null, blockedBy: [],
      claimedBySession: SESSION,
    };
  }

  it("carries the ticket preimage when the claim is still ours", async () => {
    // The preimage is what makes recovery at any pre-publication boundary
    // deterministic: the release transaction is reconstructed from it rather
    // than re-read from a ticket the first attempt may already have changed.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, { loadTicket: async () => heldTicket() }, { ticket: TICKET, claimEpoch: EPOCH }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("release");
    if (result.ticketWork.kind !== "release") return;
    const preimage = result.ticketWork.preimage;
    expect(preimage.ticketId).toBe("T-001");
    expect(preimage.status).toEqual({ present: true, value: "inprogress" });
    expect(preimage.claimedBySession).toEqual({ present: true, value: SESSION });
    // An absent key persists as present:false with a null value, distinct
    // from an explicitly null one.
    expect(preimage.claim).toEqual({ present: false, value: null });
  });

  it("authorizes with NO preimage down the audited no-ticket-write path when the claim is lost", async () => {
    // A lost claim does not block the recovery: the session still needs
    // cancelling. What it blocks is the ticket WRITE, so the authorization
    // records that no ticket work is owed rather than fabricating a release
    // for a ticket this session no longer holds.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const foreign = { ...heldTicket(), claimedBySession: "someone-else" };
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, { loadTicket: async () => foreign }, { ticket: TICKET, claimEpoch: EPOCH }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("none");
    if (result.ticketWork.kind !== "none") return;
    expect(result.ticketWork.why).toBe("claim-not-held");
    expect(result.claimReconciliation).not.toBe("held");
  });

  it("carries no preimage when the session holds no ticket at all", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("none");
    if (result.ticketWork.kind !== "none") return;
    expect(result.ticketWork.why).toBe("no-ticket");
    expect(result.claimReconciliation).toBe("not-checked");
  });

  it("reports an unreadable ticket as BLOCKED, never as nothing-owed", async () => {
    // The distinction the commit depends on: "we looked and nothing is owed"
    // versus "we could not look". Collapsing the second into the first would
    // let a transient ledger failure silently skip releasing a claim that
    // still exists, which is the ticket-side version of the fail-open this
    // ticket exists to remove.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, { loadTicket: async () => { throw new Error("ledger unreadable"); } },
      { ticket: TICKET, claimEpoch: EPOCH }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("blocked");
    if (result.ticketWork.kind !== "blocked") return;
    expect(result.ticketWork.why).toBe("ticket-unreadable");
    expect(result.ticketWork.detail).toContain("ledger unreadable");
    expect(result.claimReconciliation).toBe("recovery-required");
  });

  it("reports a MISSING ticket as blocked too: absence from the ledger is not proof of release", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, { loadTicket: async () => null }, { ticket: TICKET, claimEpoch: EPOCH }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("blocked");
    if (result.ticketWork.kind !== "blocked") return;
    expect(result.ticketWork.why).toBe("ticket-unreadable");
  });

  it("reports a claim epoch with no ticket as a BLOCKED contradiction, not as nothing-owed", async () => {
    // An epoch exists, so this session did acquire a claim; the session being
    // on no ticket contradicts that. The old default said "no ticket work is
    // owed", which is a positive claim the inputs do not support.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, {}, { ticket: null, claimEpoch: EPOCH }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("blocked");
    if (result.ticketWork.kind !== "blocked") return;
    expect(result.ticketWork.why).toBe("claim-context-mismatch");
  });

  it("reports an epoch naming a DIFFERENT ticket than the session's as blocked", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, {}, { ticket: { id: "T-999" }, claimEpoch: EPOCH }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("blocked");
    if (result.ticketWork.kind !== "blocked") return;
    expect(result.ticketWork.detail).toContain("T-999");
  });

  it("reports a ticket with NO epoch as nothing-writable: it never could prove ownership", async () => {
    // Distinct from the contradictions above. This is the pre-T-442 shape:
    // no epoch was ever recorded, so the session cannot prove ownership, and
    // that is a positive finding about what may be written rather than a
    // failure to look.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, {}, { ticket: TICKET, claimEpoch: null }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("none");
    if (result.ticketWork.kind !== "none") return;
    expect(result.ticketWork.why).toBe("claim-not-held");
  });

  it("reports a HELD claim whose preimage will not persist as blocked, not as released", async () => {
    // Work IS owed here: the claim reconciles as held. What is missing is a
    // RECORDABLE preimage, so the recovery table could not reconstruct the
    // release deterministically. Saying "nothing owed" would be a lie in the
    // dangerous direction, and a `release` carrying an unpersistable preimage
    // would mint an intent no future validator can read.
    //
    // Staging it needs the two checks to disagree, which they legitimately
    // can: reconciliation compares user/branch/since only, while the
    // persisted snapshot schema is strict about the whole object. A claim
    // carrying an EXTRA key alongside three that match the epoch is therefore
    // held AND unpersistable. (The epoch must name a real user: a null-user
    // epoch records that no claim key was written at acquisition, so a
    // present claim key contradicts it outright and reads as conflicted.) An earlier fixture used a numeric `since`, but
    // that also breaks the match, so it never reached this branch at all --
    // the assertion passed down the claim-not-held path and a mutation
    // survivor is what exposed it.
    const state = candidateState();
    const { fingerprint } = shown(state);
    const held = { user: "amir", branch: "main", since: "2026-08-01T09:00:00.000Z" };
    const unpersistable = {
      ...heldTicket(),
      claim: { ...held, note: "an extra key the strict schema refuses" },
      claimedBySession: SESSION,
    };
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, { loadTicket: async () => unpersistable },
      { ticket: TICKET, claimEpoch: { ...EPOCH, ...held } }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    // The branch is REACHED, not merely tolerated: reconciliation says held.
    expect(result.claimReconciliation).toBe("held");
    expect(result.ticketWork.kind).toBe("blocked");
    if (result.ticketWork.kind !== "blocked") return;
    expect(result.ticketWork.why).toBe("unpersistable-preimage");
  });
});

/**
 * The digest excludes THIS server's own registry entry, and that exclusion is
 * scoped to the digest alone. Both halves need pinning, because each one
 * without the other is a bug:
 *
 *   Too narrow (digest our own entry) and the handshake is
 *   SELF-INVALIDATING. The guide-call seam rewrites this server's entry
 *   whenever the calling task id differs from the one recorded in it, so one
 *   MCP server serving two tasks rejects the second task's very first
 *   confirmation, having invalidated the picture by looking at it.
 *
 *   Too wide (carry the exclusion into `markerValidity` or `successorPids`)
 *   and a takeover proceeds against a LIVE owner, because our entry turning
 *   out to carry the owner's identity is precisely the signal that the
 *   owner's client is alive somewhere other than the dead server.
 *
 * The pair below is a counterfactual, not two independent assertions. Showing
 * that the fingerprint moves when the owner's identity appears would not
 * prove WHICH field moved it, and a mutant that widened the exclusion into
 * `markerValidity` while leaving some other field reactive would still pass.
 * Restoring only `markerValidity` and watching the original digest come back
 * is what attributes the move to that field alone.
 */
describe("T-450 6b: the digest excludes our own entry, and nothing more than ours", () => {
  /** This server's own registry entry, carrying whatever identity we stamp on it. */
  function ourEntry(identity: RegisteredServer["identity"]): SuccessorServers {
    return { kind: "observed", servers: [{ pid: process.pid, identity, registeredAt: STALE_AT }] };
  }

  it("SUCCESS REGRESSION: an unrelated task stamping OUR entry does not reject the first confirmation", async () => {
    // The human confirmed against a registry that did not list us. Before the
    // authorization arrives, an unrelated task's guide call rewrites THIS
    // server's entry with its own identity and a fresh `registeredAt`. That is
    // process-local churn: it says nothing about whether the set of OTHER live
    // servers moved under the human. The first confirmation must still pass.
    const state = candidateState();
    const { fingerprint } = shown(state);
    // `boundAt` is required by `PersistedRegisteredServerSchema`, which is
    // `.strict()`. Omitting it makes the evidence unpersistable and the
    // handshake refuses before either check runs, which would have made this
    // test pass for entirely the wrong reason had it been asserting a refusal.
    const churned = ourEntry({ client: "claude", id: "task-unrelated", boundAt: "" });

    // The premise, asserted rather than assumed: a non-owner identity leaves
    // `markerValidity` exactly where an empty registry leaves it, so this test
    // is genuinely exercising the successors exclusion and not riding on a
    // marker signal that never moved for an unrelated reason.
    const fresh = readOwnerLiveness(sessDir, () => state, NOW, OWNER_STALE_MS, () => churned);
    expect(fresh.signals.markerValidity).toEqual(shown(state).verdict.signals.markerValidity);

    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
    }, depsFor(state, { readSuccessors: () => churned }));

    expect(result.kind).toBe("authorized");
  });

  it("PAIRED NEGATIVE: the OWNER's identity on our entry moves the digest, and only markerValidity moved it", async () => {
    const state = candidateState();
    const confirmed = shown(state);

    // Our own entry now carries the RECORDED OWNER's identity. `others` is
    // filtered by the recorded dead pid, not by ours, so our entry is in the
    // set the identity question is asked over: the owner's client is alive
    // right now, somewhere other than the dead server.
    const ownerStamped = ourEntry({ client: OWNER.client, id: OWNER.id, boundAt: OWNER.boundAt });
    const fresh = readOwnerLiveness(sessDir, () => state, NOW, OWNER_STALE_MS, () => ownerStamped);

    expect(fresh.signals.markerValidity.kind).toBe("invalidated");
    if (fresh.signals.markerValidity.kind !== "invalidated") return;
    expect(fresh.signals.markerValidity.reason).toBe("superseded-by-owner-identity");
    expect(fresh.signals.markerValidity.successorPids).toEqual([process.pid]);

    // The digest moved.
    expect(evidenceFingerprint(fresh.signals)).not.toBe(confirmed.fingerprint);

    // THE COUNTERFACTUAL. From the same fresh signals, restore ONLY
    // `markerValidity` to its confirmed value. The digest must come back to
    // the confirmed one, DESPITE our entry having appeared in `successors`
    // with a changed identity. That equality is the attribution: the
    // successors exclusion is still doing its job, and the move came from
    // `markerValidity` and nowhere else.
    const counterfactual = { ...fresh.signals, markerValidity: confirmed.verdict.signals.markerValidity };
    expect(evidenceFingerprint(counterfactual)).toBe(confirmed.fingerprint);

    // Restore it and the mismatch returns, so the equality above cannot be a
    // digest that stopped responding to this field altogether.
    expect(evidenceFingerprint({ ...counterfactual, markerValidity: fresh.signals.markerValidity }))
      .not.toBe(confirmed.fingerprint);

    // And end to end: check 1 refuses, nothing is mutated.
    const before = readdirSync(sessDir).sort();
    const result = await authorizeCandidateCancel(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: confirmed.fingerprint,
    }, depsFor(state, { readSuccessors: () => ownerStamped }));

    expect(result.kind).toBe("re-confirm");
    if (result.kind !== "re-confirm") return;
    expect(result.reason).toBe("fingerprint-changed");
    expect(readdirSync(sessDir).sort()).toEqual(before);
  });
});
