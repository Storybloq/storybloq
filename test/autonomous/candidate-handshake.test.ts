/**
 * T-450 step 6b: `authorizeCandidateRecovery`, the five-step handshake.
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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { authorizeCandidateRecovery } from "../../src/autonomous/candidate-recovery.js";
import {
  evidenceFingerprint,
  readOwnerLiveness,
  telemetryDirPath,
  OWNER_STALE_MS,
  type OwnableLivenessState,
} from "../../src/autonomous/liveness.js";
import type { SuccessorServers } from "../../src/autonomous/mcp-registry.js";

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
  writeFileSync(join(tDir, "shutdown"), STALE_AT);
  writeFileSync(join(tDir, "sidecar.pid"), String(pid));
}

const NO_SERVERS: SuccessorServers = { kind: "observed", servers: [] };

/** The verdict a caller would have been SHOWN, and its fingerprint. */
function shown(state: OwnableLivenessState = candidateState()) {
  const verdict = readOwnerLiveness(sessDir, () => state, NOW, OWNER_STALE_MS, () => NO_SERVERS);
  if (verdict.kind !== "gone-candidate") throw new Error(`fixture is ${verdict.kind}, not gone-candidate`);
  return { verdict, fingerprint: evidenceFingerprint(verdict.signals) };
}

function depsFor(state: OwnableLivenessState, over: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    staleThresholdMs: OWNER_STALE_MS,
    readState: () => state,
    readSuccessors: () => NO_SERVERS,
    loadTicket: async () => null,
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

    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION,
      clientTaskId: CALLER,
      confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint,
      sessionRevision: 4,
      ticket: null,
      claimEpoch: null,
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

    await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: null, claimEpoch: null,
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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: "fp-from-a-different-picture", sessionRevision: 4,
      ticket: null, claimEpoch: null,
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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 7, ticket: null, claimEpoch: null,
    }, depsFor(state));

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

    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: null, claimEpoch: null,
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

    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: evidenceFingerprint(verdict.signals), sessionRevision: 4,
      ticket: null, claimEpoch: null,
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

    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: evidenceFingerprint(verdict.signals), sessionRevision: 4,
      ticket: null, claimEpoch: null,
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

    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: evidenceFingerprint(verdict.signals), sessionRevision: 4,
      ticket: null, claimEpoch: null,
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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: "11111111-2222-4333-8444-555555555555",
      clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: null, claimEpoch: null,
    }, depsFor(state));

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("session-mismatch");
  });

  it("refuses a caller with no task identity: candidate authority is task-bound", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: undefined, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: null, claimEpoch: null,
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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: OWNER.id, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: null, claimEpoch: null,
    }, depsFor(state));

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("caller-is-owner");
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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: TICKET, claimEpoch: EPOCH,
    }, depsFor(state, { loadTicket: async () => heldTicket() }));

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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: TICKET, claimEpoch: EPOCH,
    }, depsFor(state, { loadTicket: async () => foreign }));

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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: null, claimEpoch: null,
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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: TICKET, claimEpoch: EPOCH,
    }, depsFor(state, { loadTicket: async () => { throw new Error("ledger unreadable"); } }));

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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: TICKET, claimEpoch: EPOCH,
    }, depsFor(state, { loadTicket: async () => null }));

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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: null, claimEpoch: EPOCH,
    }, depsFor(state));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    expect(result.ticketWork.kind).toBe("blocked");
    if (result.ticketWork.kind !== "blocked") return;
    expect(result.ticketWork.why).toBe("claim-context-mismatch");
  });

  it("reports an epoch naming a DIFFERENT ticket than the session's as blocked", async () => {
    const state = candidateState();
    const { fingerprint } = shown(state);
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4,
      ticket: { id: "T-999" }, claimEpoch: EPOCH,
    }, depsFor(state));

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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: TICKET, claimEpoch: null,
    }, depsFor(state));

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
    const result = await authorizeCandidateRecovery(sessDir, {
      sessionId: SESSION, clientTaskId: CALLER, confirmedSessionRevision: 4,
      confirmedFingerprint: fingerprint, sessionRevision: 4, ticket: TICKET,
      claimEpoch: { ...EPOCH, ...held },
    }, depsFor(state, { loadTicket: async () => unpersistable }));

    expect(result.kind).toBe("authorized");
    if (result.kind !== "authorized") return;
    // The branch is REACHED, not merely tolerated: reconciliation says held.
    expect(result.claimReconciliation).toBe("held");
    expect(result.ticketWork.kind).toBe("blocked");
    if (result.ticketWork.kind !== "blocked") return;
    expect(result.ticketWork.why).toBe("unpersistable-preimage");
  });
});
