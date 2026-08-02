/**
 * T-450 step 6b: the durable cancellation-intent protocol.
 *
 * The candidate invariant `transitionStartedRevision ===
 * confirmedSessionRevision + 1` requires that NOTHING increments the session
 * revision between authorize and write 1, so the pre-publication phases live
 * in their own file, `cancellation-intent.json`, not in `state.json`.
 *
 * THE LOAD-BEARING PROPERTY, asserted after every injected crash: the
 * canonical pathname is NEVER freed. There is no instant at which it is
 * absent, so a crash anywhere leaves either the old intent (retry) or the new
 * one (proceed), and absence stays unambiguous permission to create. Archives
 * are evidence, never authority: exactly one transitionId is ever LIVE.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCancellationIntent,
  classifyIntentOwnership,
  createCancellationIntent,
  advanceCancellationIntent,
  supersedeCancellationIntent,
  readoptCancellationIntent,
  __intentTesting,
} from "../../src/autonomous/candidate-recovery.js";
import { CANCELLATION_INTENT_FILE, type CancellationIntent } from "../../src/autonomous/session-types.js";

const TID = "aaaaaaaa-1111-4222-8333-444444444444";
const TID2 = "bbbbbbbb-1111-4222-8333-444444444444";
const SESSION = "eeeeeeee-1111-4222-8333-444444444444";
const STARTED = "2026-08-02T00:00:00.000Z";
const TASK = "task-candidate";

function minimalEvidence() {
  return {
    activity: { kind: "unknown" as const, reason: "absent" },
    lease: { kind: "unknown" as const, reason: "absent" },
    deathMarker: { kind: "unreadable" as const, reason: "absent" },
    markerValidity: { kind: "unknown" as const, reason: "no-recorded-pid", pid: null },
    sidecarProbe: { kind: "unknown" as const, reason: "no-pid", pid: null },
    observedAt: "2026-08-01T00:00:00.000Z",
    staleThresholdMs: 2_700_000,
    successors: { kind: "unavailable" as const, reason: "test fixture" },
  };
}

function intentFixture(over: Partial<Record<string, unknown>> = {}): CancellationIntent {
  return {
    schemaVersion: 1,
    phase: "authorized",
    transitionId: TID,
    confirmationEpoch: 0,
    clientTaskId: TASK,
    sessionId: SESSION,
    sessionStartedAt: STARTED,
    confirmedSessionRevision: 1,
    confirmedFingerprint: "fp-1",
    evidence: minimalEvidence(),
    ticketPreimage: null,
    ...over,
  } as CancellationIntent;
}

function txnFixture() {
  // `value` is REQUIRED and nullable, exactly the in-memory Field<T>: an
  // absent key persists {present: false, value: null}, an explicit null
  // persists {present: true, value: null}, and they must survive round-trip
  // as different states (ISS-759 gates on presence).
  const snapshot = (status: string) => ({
    ticketId: "T-001",
    lifecycle: { present: false, value: null },
    status: { present: true, value: status },
    completedDate: { present: true, value: null },
    claim: { present: false, value: null },
    claimedBySession: { present: true, value: SESSION },
  });
  return {
    kind: "release" as const,
    phase: "prepared" as const,
    ticketId: "T-001",
    transitionId: TID,
    fromEpoch: null,
    toEpoch: null,
    fromBusiness: snapshot("inprogress"),
    toBusiness: snapshot("open"),
    startedAt: STARTED,
  };
}

let sessDir: string;

function intentOnDisk(): CancellationIntent {
  const read = readCancellationIntent(sessDir);
  if (read.kind !== "valid") throw new Error(`expected valid intent, got ${read.kind}`);
  return read.intent;
}

/** The never-freed-pathname invariant plus single-live-transitionId. */
function assertCanonicalInvariants(liveTids: readonly string[]): void {
  expect(existsSync(join(sessDir, CANCELLATION_INTENT_FILE))).toBe(true);
  const read = readCancellationIntent(sessDir);
  expect(read.kind).toBe("valid");
  if (read.kind === "valid") expect(liveTids).toContain(read.intent.transitionId);
}

beforeEach(() => {
  sessDir = mkdtempSync(join(tmpdir(), "t450-intent-"));
  __intentTesting.at = () => undefined;
});

afterEach(() => {
  __intentTesting.at = () => undefined;
  rmSync(sessDir, { recursive: true, force: true });
});

describe("T-450 6b: intent creation is exclusive", () => {
  it("creates when absent and reads back schema-valid", () => {
    const result = createCancellationIntent(sessDir, intentFixture());
    expect(result.ok).toBe(true);
    expect(intentOnDisk().transitionId).toBe(TID);
    expect(intentOnDisk().phase).toBe("authorized");
  });

  it("refuses when an intent already exists: exclusive create is the only birth", () => {
    // A second authorize must go through classify -> resume/supersede/adopt,
    // never through a create that would silently discard the first attempt's
    // identity.
    createCancellationIntent(sessDir, intentFixture());
    const second = createCancellationIntent(sessDir, intentFixture({ transitionId: TID2 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("exists");
    expect(intentOnDisk().transitionId).toBe(TID);
  });

  it("a crash between write and fsync still leaves a readable canonical intent", () => {
    __intentTesting.at = (point) => {
      if (point === "create:written") throw new Error("injected crash");
    };
    expect(() => createCancellationIntent(sessDir, intentFixture())).toThrow(/injected/);
    __intentTesting.at = () => undefined;
    assertCanonicalInvariants([TID]);
  });
});

describe("T-450 6b: reading and classifying the intent", () => {
  it("absent is absent: the one state that permits creation", () => {
    expect(readCancellationIntent(sessDir).kind).toBe("absent");
  });

  it("matches ours on sessionId + sessionStartedAt + clientTaskId together", () => {
    createCancellationIntent(sessDir, intentFixture());
    const read = readCancellationIntent(sessDir);
    if (read.kind !== "valid") throw new Error("expected valid");
    expect(classifyIntentOwnership(read.intent, { sessionId: SESSION, startedAt: STARTED }, TASK).kind).toBe("ours");
  });

  it("a mismatch on ANY identity component is foreign", () => {
    createCancellationIntent(sessDir, intentFixture());
    const read = readCancellationIntent(sessDir);
    if (read.kind !== "valid") throw new Error("expected valid");
    const me = { sessionId: SESSION, startedAt: STARTED };
    expect(classifyIntentOwnership(read.intent, { ...me, sessionId: TID2 }, TASK).kind).toBe("foreign");
    expect(classifyIntentOwnership(read.intent, { ...me, startedAt: "2027-01-01T00:00:00.000Z" }, TASK).kind).toBe("foreign");
    expect(classifyIntentOwnership(read.intent, me, "task-other").kind).toBe("foreign");
    // No caller identity cannot prove ownership of a task-bound intent.
    expect(classifyIntentOwnership(read.intent, me, undefined).kind).toBe("foreign");
  });

  it("an unusable live start time fails closed as foreign", () => {
    createCancellationIntent(sessDir, intentFixture());
    const read = readCancellationIntent(sessDir);
    if (read.kind !== "valid") throw new Error("expected valid");
    expect(classifyIntentOwnership(read.intent, { sessionId: SESSION, startedAt: "garbage" }, TASK).kind).toBe("foreign");
  });

  it("invalid JSON is malformed, never absent", () => {
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "not json");
    expect(readCancellationIntent(sessDir).kind).toBe("malformed");
  });

  it("a schema violation is malformed, never absent", () => {
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify({ schemaVersion: 1, phase: "authorized" }));
    expect(readCancellationIntent(sessDir).kind).toBe("malformed");
  });

  it("a nested transaction phase contradicting the intent phase is malformed", () => {
    // An outer `prepared` carrying claimTxn.phase "ticket_applied" asserts
    // two different recovery rows at once; recoverClaimTransaction persists
    // the phase precisely because the postimage-without-nonce observation is
    // only legal under ticket_applied. The schema binds them so the
    // contradiction is unrepresentable rather than merely unwritten.
    const contradictory = {
      ...intentFixture({ phase: "prepared" }),
      claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    };
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify(contradictory));
    expect(readCancellationIntent(sessDir).kind).toBe("malformed");
  });

  it("round-trips an absent field and an explicit null as DIFFERENT states", () => {
    const txn = txnFixture();
    createCancellationIntent(sessDir, intentFixture({ phase: "authorized" }));
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txn }));
    const read = readCancellationIntent(sessDir);
    if (read.kind !== "valid" || read.intent.phase !== "prepared") throw new Error("expected prepared");
    const from = read.intent.claimTxn.fromBusiness;
    expect(from.claim).toEqual({ present: false, value: null });
    expect(from.completedDate).toEqual({ present: true, value: null });
  });

  it("an unreadable intent is unreadable, never absent", () => {
    // A DIRECTORY at the intent path: the read throws EISDIR. Reporting
    // absence would hand out permission to create over evidence we could not
    // inspect.
    mkdirSync(join(sessDir, CANCELLATION_INTENT_FILE));
    expect(readCancellationIntent(sessDir).kind).toBe("unreadable");
  });
});

describe("T-450 6b: phase advancement takes exactly the allowed edges", () => {
  beforeEach(() => {
    createCancellationIntent(sessDir, intentFixture());
  });

  it("walks authorized -> prepared -> ticket_applied -> claim_cleared -> closed", () => {
    const txn = txnFixture();
    expect(advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txn })).ok).toBe(true);
    expect(advanceCancellationIntent(sessDir, intentFixture({ phase: "ticket_applied", claimTxn: { ...txn, phase: "ticket_applied" } })).ok).toBe(true);
    expect(advanceCancellationIntent(sessDir, intentFixture({ phase: "claim_cleared" })).ok).toBe(true);
    expect(advanceCancellationIntent(sessDir, intentFixture({
      phase: "closed", outcome: { kind: "cancellation", transitionId: TID },
    })).ok).toBe(true);
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("refuses every skipped edge: each phase's durable obligations exist for the next", () => {
    for (const phase of ["ticket_applied", "claim_cleared", "closed"] as const) {
      const next = phase === "closed"
        ? intentFixture({ phase, outcome: { kind: "cancellation", transitionId: TID } })
        : phase === "ticket_applied"
          ? intentFixture({ phase, claimTxn: { ...txnFixture(), phase: "ticket_applied" } })
          : intentFixture({ phase });
      const result = advanceCancellationIntent(sessDir, next);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("edge-refused");
    }
    expect(intentOnDisk().phase).toBe("authorized");
  });

  it("a same-phase advance refuses: idempotent reads are reads, not advancements", () => {
    const result = advanceCancellationIntent(sessDir, intentFixture());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("edge-refused");
  });

  it("refuses a transitionId that is not the canonical one", () => {
    const result = advanceCancellationIntent(
      sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture(), transitionId: TID2 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("identity-mismatch");
  });

  it("refuses an epoch that is not the canonical one: advancement never re-confirms", () => {
    const result = advanceCancellationIntent(
      sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture(), confirmationEpoch: 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("identity-mismatch");
  });

  it("a crash at every advance seam leaves exactly one valid canonical intent, and the retry completes", () => {
    for (const point of ["advance:tmp-written", "advance:tmp-fsynced", "advance:renamed", "advance:dir-fsynced"]) {
      __intentTesting.at = (p) => { if (p === point) throw new Error(`injected at ${p}`); };
      expect(() => advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() })))
        .toThrow(/injected/);
      __intentTesting.at = () => undefined;

      assertCanonicalInvariants([TID]);
      const phase = intentOnDisk().phase;
      expect(["authorized", "prepared"]).toContain(phase);

      // The retry: from `authorized` the same advance re-runs; from `prepared`
      // (crash after the rename landed) the work is already done.
      if (phase === "authorized") {
        expect(advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() })).ok).toBe(true);
      }
      expect(intentOnDisk().phase).toBe("prepared");

      // Reset for the next injection point.
      rmSync(join(sessDir, CANCELLATION_INTENT_FILE));
      createCancellationIntent(sessDir, intentFixture());
    }
  });
});

describe("T-450 6b: supersession never frees the canonical pathname", () => {
  const replacement = () => intentFixture({
    transitionId: TID2,
    confirmationEpoch: 1,
    confirmedSessionRevision: 3,
    confirmedFingerprint: "fp-2",
    predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
  });
  const ARCHIVE = `cancellation-intent.superseded.${TID}.0.json`;

  beforeEach(() => {
    createCancellationIntent(sessDir, intentFixture());
  });

  it("archives first, replaces second, and the audit chain names the predecessor", () => {
    const before = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    const result = supersedeCancellationIntent(sessDir, replacement());
    expect(result.ok).toBe(true);

    expect(readFileSync(join(sessDir, ARCHIVE), "utf-8")).toBe(before);
    const now = intentOnDisk();
    expect(now.transitionId).toBe(TID2);
    expect(now.confirmationEpoch).toBe(1);
    expect(now.predecessor).toEqual({
      predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1",
    });
  });

  it("refuses a non-monotonic confirmationEpoch", () => {
    const result = supersedeCancellationIntent(sessDir, { ...replacement(), confirmationEpoch: 0 } as CancellationIntent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("epoch-not-monotonic");
  });

  it("refuses a predecessor triple that does not name the canonical intent", () => {
    const bad = intentFixture({
      transitionId: TID2, confirmationEpoch: 1,
      predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-wrong" },
    });
    const result = supersedeCancellationIntent(sessDir, bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("predecessor-mismatch");
  });

  it("refuses once ticket work has begun: the transitionId IS that work's audit identity", () => {
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, intentFixture({ phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" } }));
    const result = supersedeCancellationIntent(sessDir, replacement());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ticket-work-begun");
  });

  it("refuses a foreign archive at the expected name: someone else's evidence", () => {
    writeFileSync(join(sessDir, ARCHIVE), JSON.stringify({ not: "our archive" }));
    const result = supersedeCancellationIntent(sessDir, replacement());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("archive-conflict");
    expect(intentOnDisk().transitionId).toBe(TID);
  });

  it("a crash after EVERY filesystem operation leaves one canonical intent, one live transitionId, and a completable retry", () => {
    const points = [
      "supersede:archive-written",
      "supersede:archive-fsynced",
      "supersede:dir-fsynced-after-archive",
      "supersede:tmp-written",
      "supersede:tmp-fsynced",
      "supersede:renamed",
      "supersede:dir-fsynced",
    ];
    for (const point of points) {
      __intentTesting.at = (p) => { if (p === point) throw new Error(`injected at ${p}`); };
      expect(() => supersedeCancellationIntent(sessDir, replacement())).toThrow(/injected/);
      __intentTesting.at = () => undefined;

      // The canonical pathname was never absent, and whichever intent it
      // holds, exactly that transitionId is live.
      assertCanonicalInvariants([TID, TID2]);

      // A RETRIED supersession completes rather than refusing on its own
      // half-done evidence: EEXIST on the archive resolves by strict match,
      // and an already-renamed canonical resolves as already-superseded.
      const retry = supersedeCancellationIntent(sessDir, replacement());
      expect(retry.ok).toBe(true);
      expect(intentOnDisk().transitionId).toBe(TID2);

      // Reset: fresh session dir state for the next injection point.
      rmSync(join(sessDir, CANCELLATION_INTENT_FILE));
      rmSync(join(sessDir, ARCHIVE), { force: true });
      for (const f of readdirSync(sessDir)) {
        if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
      }
      createCancellationIntent(sessDir, intentFixture());
    }
  });

  it("supersession of an absent intent refuses: absence is permission to CREATE", () => {
    rmSync(join(sessDir, CANCELLATION_INTENT_FILE));
    const result = supersedeCancellationIntent(sessDir, replacement());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nothing-to-supersede");
  });
});

describe("T-450 6b: adoption re-mints the confirmation pair, never the identity", () => {
  beforeEach(() => {
    createCancellationIntent(sessDir, intentFixture());
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, intentFixture({ phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" } }));
  });

  it("keeps the transitionId and phase, bumps the epoch, replaces the confirmation pair and evidence", () => {
    const result = readoptCancellationIntent(sessDir, {
      transitionId: TID,
      confirmationEpoch: 1,
      confirmedSessionRevision: 5,
      confirmedFingerprint: "fp-3",
      evidence: minimalEvidence(),
    });
    expect(result.ok).toBe(true);
    const now = intentOnDisk();
    expect(now.transitionId).toBe(TID);
    expect(now.phase).toBe("ticket_applied");
    expect(now.confirmationEpoch).toBe(1);
    expect(now.confirmedSessionRevision).toBe(5);
    expect(now.confirmedFingerprint).toBe("fp-3");
  });

  it("refuses before ticket work exists: that is supersession's territory", () => {
    rmSync(join(sessDir, CANCELLATION_INTENT_FILE));
    createCancellationIntent(sessDir, intentFixture());
    const result = readoptCancellationIntent(sessDir, {
      transitionId: TID, confirmationEpoch: 1, confirmedSessionRevision: 5,
      confirmedFingerprint: "fp-3", evidence: minimalEvidence(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-ticket-work");
  });

  it("refuses a different transitionId: adoption is not replacement", () => {
    const result = readoptCancellationIntent(sessDir, {
      transitionId: TID2, confirmationEpoch: 1, confirmedSessionRevision: 5,
      confirmedFingerprint: "fp-3", evidence: minimalEvidence(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("identity-mismatch");
  });

  it("refuses a non-monotonic epoch", () => {
    const result = readoptCancellationIntent(sessDir, {
      transitionId: TID, confirmationEpoch: 0, confirmedSessionRevision: 5,
      confirmedFingerprint: "fp-3", evidence: minimalEvidence(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("epoch-not-monotonic");
  });
});
