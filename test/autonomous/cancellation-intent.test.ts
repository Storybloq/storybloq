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
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, linkSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readCancellationIntent,
  classifyIntentOwnership,
  createCancellationIntent,
  advanceCancellationIntent,
  supersedeCancellationIntent,
  readoptCancellationIntent,
  retireClosedIntent,
  __intentTesting,
} from "../../src/autonomous/candidate-recovery.js";
import {
  CANCELLATION_INTENT_FILE,
  CANCELLATION_SHUTDOWN_ARTIFACT,
  type CancellationIntent,
} from "../../src/autonomous/session-types.js";

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

  it("a crash at EVERY create seam leaves a state the retry RESOLVES, with no cleanup", () => {
    // The property is retryability, so the test retries: no unlink, no
    // hand-repair, nothing a crashed process would not do on restart.
    //
    // This is why creation builds the file under a temp name and claims the
    // canonical one with `link`. Under the obvious `wx` spelling the inode
    // appears before the first byte, so a crash in that window left a
    // zero-length canonical, which reads as malformed; malformed is never
    // absence, and absence is the only state that permits a create -- so the
    // retry got `exists` forever and the session was wedged with no operation
    // able to clear it. An earlier version of this test asserted that wedged
    // state and then deleted the file by hand, which documented the bug
    // rather than pinning the property.
    for (const point of ["create:tmp-opened", "create:tmp-written", "create:tmp-fsynced",
                         "create:linked", "create:dir-fsynced", "create:tmp-removed"]) {
      __intentTesting.at = (p) => { if (p === point) throw new Error(`injected at ${p}`); };
      expect(() => createCancellationIntent(sessDir, intentFixture())).toThrow(/injected/);
      __intentTesting.at = () => undefined;

      // Either the canonical name is absent (the claim had not happened yet)
      // or it holds a COMPLETE, valid intent. Never an empty or partial one.
      const afterCrash = readCancellationIntent(sessDir);
      expect(["absent", "valid"]).toContain(afterCrash.kind);

      const retry = createCancellationIntent(sessDir, intentFixture());
      if (afterCrash.kind === "absent") {
        expect(retry.ok).toBe(true);
      } else {
        // Already created: the honest answer, and the caller routes through
        // classification rather than creating over its own record.
        expect(retry.ok).toBe(false);
        if (!retry.ok) expect(retry.reason).toBe("exists");
      }
      expect(intentOnDisk().transitionId).toBe(TID);

      for (const f of readdirSync(sessDir)) rmSync(join(sessDir, f), { force: true });
    }
  });
});

describe("T-450 6b: only an adoption may write the adoption receipt", () => {
  // `adoptedFromEpoch` is only worth something if adoption is the ONLY thing
  // that can produce it. The persisted schema has to keep it optional, since
  // an intent that was never adopted genuinely does not carry one, so the
  // schema cannot enforce that and every write API taking a caller-built
  // intent refuses it instead. Without this a record could be CREATED with a
  // fabricated receipt and its first same-epoch adoption request would be
  // waved through as a retry -- the exact hole the receipt exists to close.
  const forged = { adoptedFromEpoch: 0 };

  it("refuses a created intent carrying one", () => {
    const result = createCancellationIntent(sessDir, intentFixture(forged));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("receipt-not-writable");
    expect(readCancellationIntent(sessDir).kind).toBe("absent");
  });

  it("refuses to write a record its own reader would call malformed", () => {
    // Found by the test below meaning to assert something else. Advancement
    // compared the incoming record against the canonical one and checked the
    // edge, but never parsed it, so carrying a `claimTxn` across the
    // ticket_applied -> claim_cleared edge wrote a canonical intent that read
    // back as MALFORMED -- the worst state this module has, since it is not
    // absence (nothing may create over it) and not valid (nothing may advance
    // it). The whole-record pin cannot catch it: `claimTxn` is one of the two
    // fields the phase arms legitimately vary, so only the schema knows which
    // arm may carry one.
    createCancellationIntent(sessDir, intentFixture());
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, intentFixture({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));
    const strayTxn = intentFixture({
      phase: "claim_cleared", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    });
    const result = advanceCancellationIntent(sessDir, strayTxn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
    expect(readCancellationIntent(sessDir).kind).toBe("valid");
    expect(intentOnDisk().phase).toBe("ticket_applied");
  });

  it("refuses a CREATED record that would not parse, leaving the pathname absent", () => {
    const result = createCancellationIntent(sessDir, intentFixture({ claimTxn: txnFixture() }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
    expect(readCancellationIntent(sessDir).kind).toBe("absent");
    expect(existsSync(join(sessDir, `${CANCELLATION_INTENT_FILE}.creating`))).toBe(false);
  });

  it("refuses an ADOPTED record that would not parse", () => {
    createCancellationIntent(sessDir, intentFixture());
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, intentFixture({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));
    const before = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    const result = readoptCancellationIntent(sessDir, {
      transitionId: TID, confirmationEpoch: 1, confirmedSessionRevision: 5, confirmedFingerprint: "fp-3",
      evidence: { not: "an evidence record" } as unknown as ReturnType<typeof minimalEvidence>,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
    expect(readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8")).toBe(before);
  });

  it("refuses a superseding intent carrying one", () => {
    createCancellationIntent(sessDir, intentFixture());
    const result = supersedeCancellationIntent(sessDir, intentFixture({
      transitionId: TID2, confirmationEpoch: 1,
      predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
      ...forged,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("receipt-not-writable");
    expect(intentOnDisk().transitionId).toBe(TID);
  });

  it("preserves a GENUINE receipt through ordinary advancement, and refuses to drop it", () => {
    // Advancement is deliberately not in the refusal list: it must carry a
    // real receipt forward, and the whole-record pin already forbids it
    // changing one. Both halves are asserted here.
    createCancellationIntent(sessDir, intentFixture());
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, intentFixture({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));
    readoptCancellationIntent(sessDir, {
      transitionId: TID, confirmationEpoch: 1, confirmedSessionRevision: 5,
      confirmedFingerprint: "fp-3", evidence: minimalEvidence(),
    });
    const adopted = intentOnDisk();
    expect(adopted.adoptedFromEpoch).toBe(0);

    const cleared = { ...adopted, phase: "claim_cleared" as const };
    delete (cleared as Record<string, unknown>).claimTxn;

    const dropped = advanceCancellationIntent(
      sessDir, { ...cleared, adoptedFromEpoch: undefined } as unknown as CancellationIntent,
    );
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.reason).toBe("identity-mismatch");

    expect(advanceCancellationIntent(sessDir, cleared as unknown as CancellationIntent).ok).toBe(true);
    expect(intentOnDisk().adoptedFromEpoch).toBe(0);
  });
});

describe("T-450 6b: a stale temp can never reach through to a published record", () => {
  // THE CORRUPTION THIS CLOSES. After `link`, the temp name and the published
  // name are two directory entries for ONE inode. A crash before the unlink,
  // or a power loss that drops the un-fsynced unlink, leaves the temp
  // pointing at the LIVE record -- and the temp is opened `w`, which is
  // O_TRUNC, so the next writer of ANY prefix would truncate that live record
  // through the shared inode the moment it opened its own temp. The writers
  // share one deterministic temp name, so this crosses between them: a temp
  // left behind by a create reaches an archive write, and the reverse.
  const TMP = CANCELLATION_INTENT_FILE + ".creating";

  it("survives a temp left hard-linked to the canonical by a crashed create", () => {
    __intentTesting.at = (p) => { if (p === "create:dir-fsynced") throw new Error("injected"); };
    expect(() => createCancellationIntent(sessDir, intentFixture())).toThrow(/injected/);
    __intentTesting.at = () => undefined;

    // The state the crash leaves: canonical published, temp still linked to
    // the very same inode.
    expect(existsSync(join(sessDir, TMP))).toBe(true);
    expect(statSync(join(sessDir, TMP)).ino).toBe(statSync(join(sessDir, CANCELLATION_INTENT_FILE)).ino);

    // A LATER, UNRELATED writer opens its temp. Before the unlink-first fix
    // this truncated the canonical through the shared inode.
    const second = createCancellationIntent(sessDir, intentFixture({ transitionId: TID2 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("exists");
    const after = readCancellationIntent(sessDir);
    expect(after.kind).toBe("valid");
    if (after.kind === "valid") expect(after.intent.transitionId).toBe(TID);
  });

  it("NO CRASH REQUIRED: a create against an existing canonical cannot reach it", () => {
    // The worst member of the family, and it needs no crash at all to fire:
    // with a stale temp linked to the live canonical, `createCancellationIntent`
    // would open that temp (O_TRUNC), truncate the published record through
    // the shared inode, write the NEW intent's bytes into it, fail EEXIST on
    // the link, and return `exists` -- silently replacing the record it had
    // just refused to create, and reporting the refusal. Silent replacement
    // WITH a false refusal.
    createCancellationIntent(sessDir, intentFixture());
    const published = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    linkSync(join(sessDir, CANCELLATION_INTENT_FILE), join(sessDir, TMP));

    const second = createCancellationIntent(sessDir, intentFixture({ transitionId: TID2 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("exists");
    // The refusal has to be the WHOLE truth: nothing was written anywhere the
    // published record can be reached from.
    expect(readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8")).toBe(published);
  });

  it("survives across writers: a stale create temp meets an archive write", () => {
    createCancellationIntent(sessDir, intentFixture());
    // Stage the stale link by hand, which is exactly the durable state the
    // crash above leaves, and is reachable for any prefix.
    linkSync(join(sessDir, CANCELLATION_INTENT_FILE), join(sessDir, TMP));

    const replacement = intentFixture({
      transitionId: TID2, confirmationEpoch: 1,
      predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
    });
    const result = supersedeCancellationIntent(sessDir, replacement);
    expect(result.ok).toBe(true);

    // The archive is the ORIGINAL bytes, not an empty or partial file, and
    // the canonical is the replacement. Neither was reached through the temp.
    const archive = join(sessDir, `cancellation-intent.superseded.${TID}.0.json`);
    expect(readFileSync(archive, "utf-8").length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(archive, "utf-8")).transitionId).toBe(TID);
    expect(intentOnDisk().transitionId).toBe(TID2);
  });

  it("survives a stale temp left linked to an ARCHIVE", () => {
    // The evidence-corrupting direction: a later cycle rewriting archived
    // bytes through a shared inode would break both the byte-strict EEXIST
    // resolution and the archive proof for that triple.
    createCancellationIntent(sessDir, intentFixture());
    const replacement = intentFixture({
      transitionId: TID2, confirmationEpoch: 1,
      predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
    });
    supersedeCancellationIntent(sessDir, replacement);
    const archive = join(sessDir, `cancellation-intent.superseded.${TID}.0.json`);
    const archivedBytes = readFileSync(archive, "utf-8");
    linkSync(archive, join(sessDir, TMP));

    const third = intentFixture({
      transitionId: "dddddddd-1111-4222-8333-444444444444", confirmationEpoch: 2,
      predecessor: { predecessorTransitionId: TID2, predecessorEpoch: 1, predecessorFingerprint: "fp-1" },
    });
    expect(supersedeCancellationIntent(sessDir, third).ok).toBe(true);
    expect(readFileSync(archive, "utf-8")).toBe(archivedBytes);
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
      "supersede:archive:tmp-opened",
      "supersede:archive:tmp-written",
      "supersede:archive:tmp-fsynced",
      "supersede:archive:linked",
      "supersede:archive:dir-fsynced",
      "supersede:archive:tmp-removed",
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

  it("refuses a replacement that IS the canonical intent when no archive proves a cycle ran", () => {
    // Same hole as retirement's, in the writer it was copied from: the retry
    // short-circuit keys on canonical-equals-replacement, which a first call
    // produces trivially by passing the live intent back, skipping the
    // ticket-work gate and the predecessor check behind it.
    const itself = intentOnDisk();
    const result = supersedeCancellationIntent(sessDir, {
      ...itself,
      predecessor: { predecessorTransitionId: TID2, predecessorEpoch: 0, predecessorFingerprint: "fp-0" },
    } as CancellationIntent);
    expect(result.ok).toBe(false);
    expect(intentOnDisk().transitionId).toBe(TID);
  });

  it("refuses a retry whose replacement DIFFERS from the canonical postimage", () => {
    // The remaining false-success path once the archive check is in place: a
    // second call sharing the transitionId and epoch but differing anywhere
    // else is a DIFFERENT record, and reporting success for it would claim
    // durable facts nobody wrote. The archive proves a cycle ran; only
    // whole-record equality proves it produced THIS state.
    expect(supersedeCancellationIntent(sessDir, replacement()).ok).toBe(true);
    expect(existsSync(join(sessDir, ARCHIVE))).toBe(true);

    for (const drift of [
      { confirmedFingerprint: "fp-drifted" },
      { confirmedSessionRevision: 42 },
      { evidence: { ...minimalEvidence(), staleThresholdMs: 60_000 } },
      { predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-other" } },
    ]) {
      const result = supersedeCancellationIntent(sessDir, { ...replacement(), ...drift } as CancellationIntent);
      expect(result.ok).toBe(false);
      expect(intentOnDisk().confirmedFingerprint).toBe("fp-2");
      expect(intentOnDisk().confirmedSessionRevision).toBe(3);
    }
  });

  it("refuses a replacement that is not at authorized, closing the mid-cycle spoof", () => {
    const mid = intentFixture({ transitionId: TID2, confirmationEpoch: 1, phase: "prepared", claimTxn: txnFixture() });
    const result = supersedeCancellationIntent(sessDir, mid);
    expect(result.ok).toBe(false);
    expect(intentOnDisk().transitionId).toBe(TID);
  });

  it("refuses a superseding intent that reuses the canonical transitionId", () => {
    const result = supersedeCancellationIntent(sessDir, intentFixture({
      confirmationEpoch: 1,
      predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transition-id-reused");
    expect(intentOnDisk().confirmationEpoch).toBe(0);
  });

  it("refuses a superseding intent that would not parse", () => {
    const before = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    const result = supersedeCancellationIntent(sessDir, {
      ...replacement(), claimTxn: txnFixture(),
    } as unknown as CancellationIntent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
    expect(readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8")).toBe(before);
    expect(existsSync(join(sessDir, ARCHIVE))).toBe(false);
  });

  it("resolves a ZERO-LENGTH archive as a half-birth rather than wedging the cycle", () => {
    // Retirement had this pinned; supersession did not, and a mutant deleting
    // its copy of the branch survived because nothing was looking. The
    // current writer cannot produce an empty archive (`link` publishes the
    // name only once the bytes are durable), but the name is keyed by an
    // identity that never changes while supersession keeps failing, so
    // anything that ever left an empty file there would wedge the cycle
    // permanently. An empty file is no one's evidence.
    const canonical = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    writeFileSync(join(sessDir, ARCHIVE), "");

    const result = supersedeCancellationIntent(sessDir, replacement());
    expect(result.ok).toBe(true);
    expect(readFileSync(join(sessDir, ARCHIVE), "utf-8")).toBe(canonical);
    expect(intentOnDisk().transitionId).toBe(TID2);
  });

  it("refuses a retry whose replacement equals the canonical but has NO archive behind it", () => {
    // Aimed straight at the archive half of the shortcut's proof. The three
    // conditions are staged so that dropping ONLY that half flips the answer:
    // the canonical IS the replacement, it is at `authorized`, and the
    // archive its predecessor names does not exist.
    expect(supersedeCancellationIntent(sessDir, replacement()).ok).toBe(true);
    rmSync(join(sessDir, ARCHIVE));
    const canonical = intentOnDisk();

    const result = supersedeCancellationIntent(sessDir, canonical);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transition-id-reused");
  });

  it("refuses a retry whose replacement carries NO predecessor at all", () => {
    // A replacement with no predecessor names no archive, so nothing can
    // prove a prior cycle: the proof must be false, not vacuously true.
    // Stage it deliberately: the describe's setup already created a canonical,
    // so a bare `createCancellationIntent` here would refuse as `exists` and
    // leave the fixture as the ORIGINAL intent while reading as if it had
    // staged a new one.
    rmSync(join(sessDir, CANCELLATION_INTENT_FILE));
    expect(createCancellationIntent(sessDir, intentFixture({ transitionId: TID2 })).ok).toBe(true);
    const bare = intentOnDisk();
    expect(bare.transitionId).toBe(TID2);
    expect(bare.predecessor).toBeUndefined();
    const result = supersedeCancellationIntent(sessDir, bare);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transition-id-reused");
  });

  it("refuses a retry whose replacement is mid-cycle, even with a valid archive", () => {
    // The phase half of the same proof, staged so only IT decides. After a
    // real supersession the archive is valid and the canonical IS the
    // replacement; advancing the canonical to `prepared` leaves both halves
    // satisfied and the phase condition the only thing standing between a
    // mid-cycle self-replacement and a false success.
    expect(supersedeCancellationIntent(sessDir, replacement()).ok).toBe(true);
    advanceCancellationIntent(sessDir, { ...replacement(), phase: "prepared", claimTxn: { ...txnFixture(), transitionId: TID2 } } as CancellationIntent);
    const midCycle = intentOnDisk();
    expect(midCycle.phase).toBe("prepared");
    expect(existsSync(join(sessDir, ARCHIVE))).toBe(true);

    const result = supersedeCancellationIntent(sessDir, midCycle);
    expect(result.ok).toBe(false);
    expect(intentOnDisk().phase).toBe("prepared");
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

describe("T-450 6b: advancement pins the WHOLE record, not a chosen few fields", () => {
  // Pen ruling M-A. An earlier draft compared seven scalars, which left four
  // ways for a buggy caller to rewrite durable facts while taking a LEGAL
  // edge. Each of these takes a legal edge and changes exactly one thing.
  const preimage = (status: string) => ({
    ticketId: "T-001",
    lifecycle: { present: false, value: null },
    status: { present: true, value: status },
    completedDate: { present: true, value: null },
    claim: { present: false, value: null },
    claimedBySession: { present: true, value: SESSION },
  });

  beforeEach(() => {
    createCancellationIntent(sessDir, intentFixture());
  });

  it("refuses an evidence swap: epoch N's evidence is what minted epoch N", () => {
    const next = intentFixture({
      phase: "prepared",
      claimTxn: txnFixture(),
      evidence: { ...minimalEvidence(), staleThresholdMs: 60_000 },
    });
    const result = advanceCancellationIntent(sessDir, next);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("identity-mismatch");
    expect(intentOnDisk().evidence.staleThresholdMs).toBe(2_700_000);
  });

  it("refuses a ticketPreimage rewrite: deterministic reconstruction rests on it", () => {
    const result = advanceCancellationIntent(
      sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture(), ticketPreimage: preimage("open") }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("identity-mismatch");
    expect(intentOnDisk().ticketPreimage).toBeNull();
  });

  it("refuses DROPPING the predecessor: an absent optional parses, so only comparison catches it", () => {
    // The audit link is the one erasure a schema check can never see, because
    // `predecessor` is optional: the shortened record is perfectly valid. It
    // matters because acceptance-time validation follows that link, and a
    // supersession chain broken here is unrecoverable after the fact.
    rmSync(join(sessDir, CANCELLATION_INTENT_FILE));
    const withPred = intentFixture({
      predecessor: { predecessorTransitionId: TID2, predecessorEpoch: 0, predecessorFingerprint: "fp-0" },
    });
    createCancellationIntent(sessDir, withPred);

    const stripped = intentFixture({ phase: "prepared", claimTxn: txnFixture() });
    expect((stripped as Record<string, unknown>).predecessor).toBeUndefined();
    const result = advanceCancellationIntent(sessDir, stripped);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("identity-mismatch");
    expect(intentOnDisk().predecessor).toEqual({
      predecessorTransitionId: TID2, predecessorEpoch: 0, predecessorFingerprint: "fp-0",
    });
  });

  it("refuses a claimTxn pointed at a DIFFERENT ticket across the ticket_applied edge", () => {
    // The edge itself is legal and the phases line up, so the schema is happy;
    // without the payload pin the recovery table would reconstruct a release
    // for a ticket nobody ever prepared.
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    const swapped = { ...txnFixture(), phase: "ticket_applied" as const, ticketId: "T-999" };
    const result = advanceCancellationIntent(sessDir, intentFixture({ phase: "ticket_applied", claimTxn: swapped }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("identity-mismatch");
      expect(result.detail).toContain("claim transaction");
    }
    expect(intentOnDisk().phase).toBe("prepared");
  });

  it("refuses a drifted confirmation pair: advancement records work, it never re-confirms", () => {
    // The epoch already had its own test; the pair it travels with did not.
    // A confirmation that drifted through an advancement would leave the
    // record claiming a world nobody re-checked, which is precisely what the
    // candidate invariant rests on not happening.
    for (const drift of [{ confirmedFingerprint: "fp-drift" }, { confirmedSessionRevision: 99 }]) {
      const result = advanceCancellationIntent(
        sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture(), ...drift }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("identity-mismatch");
    }
    expect(intentOnDisk().confirmedFingerprint).toBe("fp-1");
    expect(intentOnDisk().confirmedSessionRevision).toBe(1);
  });

  it("accepts a record whose keys are in a different order: formatting is not a change", () => {
    // The pin must compare VALUES. A merge driver or formatter that rewrote
    // the record with identical content in another key order would otherwise
    // wedge every advancement from that point on.
    const canonical = intentFixture({ phase: "prepared", claimTxn: txnFixture() }) as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(canonical).reverse()) reordered[key] = canonical[key];
    const result = advanceCancellationIntent(sessDir, reordered as unknown as CancellationIntent);
    expect(result.ok).toBe(true);
    expect(intentOnDisk().phase).toBe("prepared");
  });
});

describe("T-450 6b: adoption survives a crash and its verbatim retry", () => {
  const adoption = {
    transitionId: TID,
    confirmationEpoch: 1,
    confirmedSessionRevision: 5,
    confirmedFingerprint: "fp-3",
    evidence: minimalEvidence(),
  };

  function stageTicketApplied(): void {
    for (const f of readdirSync(sessDir)) {
      if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
    }
    createCancellationIntent(sessDir, intentFixture());
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, intentFixture({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));
  }

  beforeEach(stageTicketApplied);

  it("re-running an adoption that already landed reports success, not a stale epoch", () => {
    // Pen ruling M-B. Without the short-circuit the retry every caller is
    // supposed to make gets `epoch-not-monotonic`, which is the answer for a
    // STALE re-authorization: the caller could not tell "already done" from
    // "you are behind", and those two must never be confused.
    expect(readoptCancellationIntent(sessDir, adoption).ok).toBe(true);
    const again = readoptCancellationIntent(sessDir, adoption);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.intent.confirmationEpoch).toBe(1);
  });

  it("an adoption differing on ANY confirmation component is not the already-done case", () => {
    // The short-circuit keys on the whole confirmation triple, so a second
    // authorization that reused the epoch but saw a different world is still
    // refused rather than silently reported as already applied.
    expect(readoptCancellationIntent(sessDir, adoption).ok).toBe(true);
    for (const drift of [
      { ...adoption, confirmedSessionRevision: 6 },
      { ...adoption, confirmedFingerprint: "fp-4" },
    ]) {
      const result = readoptCancellationIntent(sessDir, drift);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("epoch-not-monotonic");
      expect(intentOnDisk().confirmedSessionRevision).toBe(5);
    }
  });

  it("the phase gate runs BEFORE the already-adopted short-circuit", () => {
    // A request carrying the canonical confirmation is the shape of a retry,
    // and at `ticket_applied` that is exactly what it is. At `authorized` and
    // `closed` it is not: adoption does not apply there at all, and answering
    // "already adopted" would report the wrong operation as done and route
    // the caller away from supersession and retirement respectively. The
    // short-circuit may only say "this adoption is already applied"; it may
    // never say "adoption applies".
    for (const stage of ["authorized", "closed"] as const) {
      for (const f of readdirSync(sessDir)) {
        if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
      }
      createCancellationIntent(sessDir, intentFixture());
      if (stage === "closed") {
        advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
        advanceCancellationIntent(sessDir, intentFixture({
          phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
        }));
        advanceCancellationIntent(sessDir, intentFixture({ phase: "claim_cleared" }));
        advanceCancellationIntent(sessDir, intentFixture({
          phase: "closed", outcome: { kind: "cancellation", transitionId: TID },
        }));
      }
      const canonical = intentOnDisk();
      const result = readoptCancellationIntent(sessDir, {
        transitionId: canonical.transitionId,
        confirmationEpoch: canonical.confirmationEpoch,
        confirmedSessionRevision: canonical.confirmedSessionRevision,
        confirmedFingerprint: canonical.confirmedFingerprint,
        evidence: canonical.evidence,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("no-ticket-work");
    }
  });

  it("a matching triple carrying DIFFERENT evidence is not the already-done case", () => {
    // Adoption re-mints the evidence along with the confirmation pair, so a
    // request that matches on the three scalars while carrying other evidence
    // asks for a record this function has not produced. Reporting success
    // would claim a durable state that does not exist; the honest answer is
    // that re-minting evidence needs a new epoch.
    const canonical = intentOnDisk();
    const result = readoptCancellationIntent(sessDir, {
      transitionId: canonical.transitionId,
      confirmationEpoch: canonical.confirmationEpoch,
      confirmedSessionRevision: canonical.confirmedSessionRevision,
      confirmedFingerprint: canonical.confirmedFingerprint,
      evidence: { ...minimalEvidence(), staleThresholdMs: 60_000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("epoch-not-monotonic");
    expect(intentOnDisk().evidence.staleThresholdMs).toBe(2_700_000);
  });

  it("an exactly-matching FIRST request is refused, however precisely it matches", () => {
    // The case that makes the receipt necessary. At `ticket_applied` an
    // adoption request carrying the canonical epoch, revision, fingerprint
    // and evidence looks byte-for-byte like the retry of an adoption that
    // landed -- but no adoption has run, and returning success would collapse
    // two distinct re-authorizations onto one epoch. Equality with the
    // current state proves the post-state exists; it never proves this
    // operation produced it. `adoptedFromEpoch` is what tells them apart: a
    // record that was created and advanced carries no receipt.
    const canonical = intentOnDisk();
    expect(canonical.adoptedFromEpoch).toBeUndefined();
    const result = readoptCancellationIntent(sessDir, {
      transitionId: canonical.transitionId,
      confirmationEpoch: canonical.confirmationEpoch,
      confirmedSessionRevision: canonical.confirmedSessionRevision,
      confirmedFingerprint: canonical.confirmedFingerprint,
      evidence: canonical.evidence,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("epoch-not-monotonic");
  });

  it("records the epoch it adopted FROM, and only then reads a repeat as already done", () => {
    const applied = readoptCancellationIntent(sessDir, adoption);
    expect(applied.ok).toBe(true);
    expect(intentOnDisk().adoptedFromEpoch).toBe(0);

    // Same request again: now there IS a receipt, and it names the epoch this
    // adoption moved off, so the repeat is provably the retry.
    const before = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    const again = readoptCancellationIntent(sessDir, adoption);
    expect(again.ok).toBe(true);
    expect(readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8")).toBe(before);
  });

  it("after a real adoption, a repeat carrying DIFFERENT evidence is still refused", () => {
    // The evidence clause of the already-adopted check can only decide
    // anything once a receipt EXISTS; before that the receipt gate refuses
    // first, so an earlier test aimed at this clause passed without ever
    // reaching it and a mutant deleting the clause survived. Staged after a
    // real adoption, the receipt and all three scalars match and the evidence
    // is the only thing left to disagree about.
    expect(readoptCancellationIntent(sessDir, adoption).ok).toBe(true);
    expect(intentOnDisk().adoptedFromEpoch).toBe(0);

    const result = readoptCancellationIntent(sessDir, {
      ...adoption,
      evidence: { ...minimalEvidence(), staleThresholdMs: 60_000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("epoch-not-monotonic");
    expect(intentOnDisk().evidence.staleThresholdMs).toBe(2_700_000);
  });

  it("a crash at every adopt seam leaves one canonical intent and a completable retry", () => {
    for (const point of ["adopt:tmp-written", "adopt:tmp-fsynced", "adopt:renamed", "adopt:dir-fsynced"]) {
      __intentTesting.at = (p) => { if (p === point) throw new Error(`injected at ${p}`); };
      expect(() => readoptCancellationIntent(sessDir, adoption)).toThrow(/injected/);
      __intentTesting.at = () => undefined;

      assertCanonicalInvariants([TID]);
      expect(intentOnDisk().phase).toBe("ticket_applied");

      const retry = readoptCancellationIntent(sessDir, adoption);
      expect(retry.ok).toBe(true);
      expect(intentOnDisk().confirmationEpoch).toBe(1);
      expect(intentOnDisk().confirmedFingerprint).toBe("fp-3");

      stageTicketApplied();
    }
  });

  it("says closed is FINISHED, not before-begun: retirement is the only route out", () => {
    advanceCancellationIntent(sessDir, intentFixture({ phase: "claim_cleared" }));
    advanceCancellationIntent(sessDir, intentFixture({
      phase: "closed", outcome: { kind: "cancellation", transitionId: TID },
    }));
    const result = readoptCancellationIntent(sessDir, adoption);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no-ticket-work");
      expect(result.detail).toContain("retirement");
    }
  });
});

describe("T-450 6b: retirement is the way out of closed, and only when the outcome is derivable", () => {
  // Pen ruling M-C. Without retirement, one successful takeover forecloses
  // this ticket's own scenario for that session forever: create refuses
  // EEXIST, supersession refuses ticket-work-begun, adoption refuses a
  // finished cycle, and no edge leaves `closed`.
  const ARCHIVE = `cancellation-intent.superseded.${TID}.0.json`;

  const replacement = () => intentFixture({
    transitionId: TID2,
    confirmationEpoch: 1,
    confirmedSessionRevision: 9,
    confirmedFingerprint: "fp-9",
    predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
  });

  /**
   * A published CANDIDATE cancellation as it sits in persisted state. The
   * action and authority are not decoration: a candidate intent authorizes a
   * candidate cancellation, so an ordinary one cannot serve as its proof. An
   * earlier fixture used `ordinary_cancellation` with legacy authority and
   * passed, which is how the missing check was found.
   */
  const publishedTransition = (over: Record<string, unknown> = {}) => ({
    transitionId: TID,
    action: "candidate_recovery_takeover",
    authority: {
      kind: "candidate",
      clientTaskId: TASK,
      confirmedSessionRevision: 1,
      confirmedFingerprint: "fp-1",
      evidence: minimalEvidence(),
    },
    disposition: { kind: "no-ticket" },
    sessionId: SESSION,
    sessionStartedAt: STARTED,
    transitionStartedRevision: 4,
    phase: "published",
    stash: { outcome: "none" },
    endedAt: "2026-08-02T00:01:00.000Z",
    terminalRevision: 6,
    shutdownArtifact: { schemaVersion: 1, filename: CANCELLATION_SHUTDOWN_ARTIFACT },
    ...over,
  });

  const cancelled = { cancellationTransition: publishedTransition(), sessionRevision: 6 };

  type ClosedOutcome = Extract<CancellationIntent, { phase: "closed" }>["outcome"];

  function stageClosed(outcome: ClosedOutcome): void {
    for (const f of readdirSync(sessDir)) {
      if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
    }
    createCancellationIntent(sessDir, intentFixture());
    advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, intentFixture({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));
    advanceCancellationIntent(sessDir, intentFixture({ phase: "claim_cleared" }));
    advanceCancellationIntent(sessDir, intentFixture({ phase: "closed", outcome }));
  }

  it("retires a closed cancellation whose transition IS published in state", () => {
    stageClosed({ kind: "cancellation", transitionId: TID });
    const before = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");

    const result = retireClosedIntent(sessDir, replacement(), cancelled);
    expect(result.ok).toBe(true);

    // Archive first, replace second, canonical pathname never freed.
    expect(readFileSync(join(sessDir, ARCHIVE), "utf-8")).toBe(before);
    const now = intentOnDisk();
    expect(now.transitionId).toBe(TID2);
    expect(now.phase).toBe("authorized");
    expect(now.predecessor?.predecessorTransitionId).toBe(TID);
  });

  it("REFUSES a closed takeover: a revision counter is not proof that it happened", () => {
    // `sessionRevision >= committedRevision` is satisfied by any later write
    // for any reason, so it cannot establish that this takeover was ever
    // committed -- and retirement discards the record, so a weak proof here
    // loses the only trace of it. The real proof is the durable takeover
    // postimage naming this transitionId, which the consumer functions write
    // and which does not exist yet. Refusing costs nothing real: no takeover
    // has been committed, so no closed takeover intent exists to retire.
    stageClosed({ kind: "takeover", committedRevision: 7 });
    for (const sessionRevision of [7, 8, 10_000]) {
      const result = retireClosedIntent(sessDir, replacement(), {
        cancellationTransition: undefined, sessionRevision,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("outcome-underivable");
      expect(intentOnDisk().phase).toBe("closed");
    }
  });

  it("refuses a cancellation the state does not carry as published", () => {
    // Three ways the proof fails, all the same verdict: nothing there, the
    // wrong transition there, and the right transition not yet published.
    for (const durable of [
      { cancellationTransition: undefined, sessionRevision: 6 },
      { cancellationTransition: publishedTransition({ transitionId: TID2 }), sessionRevision: 6 },
      {
        cancellationTransition: {
          transitionId: TID,
          action: "ordinary_cancellation",
          authority: { kind: "legacy" },
          disposition: { kind: "no-ticket" },
          sessionId: SESSION,
          sessionStartedAt: STARTED,
          transitionStartedRevision: 4,
          phase: "stash_pending",
          stash: { outcome: null },
        },
        sessionRevision: 6,
      },
    ]) {
      stageClosed({ kind: "cancellation", transitionId: TID });
      const result = retireClosedIntent(sessDir, replacement(), durable);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("outcome-underivable");
      expect(intentOnDisk().phase).toBe("closed");
      expect(existsSync(join(sessDir, ARCHIVE))).toBe(false);
    }
  });

  it("refuses a published cancellation from a DIFFERENT session, however well the id matches", () => {
    // A transition record is a file: it can be edited, and a copy can be
    // dropped into another session's directory. Matching only the transition
    // id would let one session's published cancellation authorize discarding
    // another session's only record of its own.
    stageClosed({ kind: "cancellation", transitionId: TID });
    for (const over of [
      { sessionId: "cccccccc-1111-4222-8333-444444444444" },
      { sessionStartedAt: "2020-01-01T00:00:00.000Z" },
    ]) {
      const result = retireClosedIntent(sessDir, replacement(), {
        cancellationTransition: publishedTransition(over), sessionRevision: 6,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("outcome-underivable");
      expect(intentOnDisk().phase).toBe("closed");
    }
  });

  it("refuses a cancellation of the WRONG KIND, however well the id and provenance match", () => {
    // A candidate intent is proved by a candidate cancellation held by the
    // same client task. An ordinary one published in this very session, with
    // this very transition id, proves something else happened.
    stageClosed({ kind: "cancellation", transitionId: TID });
    for (const over of [
      { action: "ordinary_cancellation", authority: { kind: "legacy" } },
      { authority: { kind: "task", callerTaskId: TASK } },
      {
        authority: {
          kind: "candidate", clientTaskId: "some-other-task",
          confirmedSessionRevision: 1, confirmedFingerprint: "fp-1", evidence: minimalEvidence(),
        },
      },
    ]) {
      const result = retireClosedIntent(sessDir, replacement(), {
        cancellationTransition: publishedTransition(over), sessionRevision: 6,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("outcome-underivable");
      expect(intentOnDisk().phase).toBe("closed");
    }
  });

  it("refuses while the session has not reached the publication's terminal revision", () => {
    // Publication is not durability. `terminalRevision` is the revision the
    // publishing write produces, so a state behind it is a state where the
    // record read here is ahead of what survived.
    stageClosed({ kind: "cancellation", transitionId: TID });
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: publishedTransition({ terminalRevision: 9 }), sessionRevision: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outcome-underivable");
      expect(result.detail).toContain("not durable yet");
    }
  });

  it("refuses an outcome pointing at a transition that is not the intent's own", () => {
    // The intent authorizes exactly one transition and carries its id, so an
    // outcome naming a different one is a record contradicting itself. Caught
    // before the state is consulted at all, because a valid published record
    // for that other id would otherwise satisfy the proof.
    stageClosed({ kind: "cancellation", transitionId: TID2 });
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: publishedTransition({ transitionId: TID2 }), sessionRevision: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outcome-underivable");
      expect(result.detail).toContain("another transition's record");
    }
  });

  it("refuses a replacement that IS the canonical intent, with no archive to prove a cycle ran", () => {
    // The retry short-circuit keys on canonical-equals-replacement, which a
    // first call can produce trivially by passing the live intent back. With
    // only that check it would return success ahead of the closed-phase gate
    // and the derivability proof -- reporting a retirement that never
    // happened, from a cycle that never ended. The archive is what tells the
    // two apart.
    for (const phase of ["authorized", "closed"] as const) {
      for (const f of readdirSync(sessDir)) {
        if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
      }
      if (phase === "closed") stageClosed({ kind: "cancellation", transitionId: TID });
      else createCancellationIntent(sessDir, intentFixture());

      const itself = intentOnDisk();
      const result = retireClosedIntent(
        sessDir,
        { ...itself, predecessor: { predecessorTransitionId: TID2, predecessorEpoch: 0, predecessorFingerprint: "fp-0" } } as CancellationIntent,
        cancelled,
      );
      // WHICH guard refuses is not the point and is not asserted: passing the
      // intent back as its own replacement trips several at once (its epoch
      // cannot exceed itself, its predecessor cannot name itself). The point
      // is that a guard ran at all rather than the short-circuit reporting a
      // retirement that never happened.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["not-closed", "epoch-not-monotonic", "predecessor-mismatch", "transition-id-reused"])
          .toContain(result.reason);
      }
      expect(intentOnDisk().phase).toBe(phase);
    }
  });

  it("refuses the retry shortcut for an archive that does not PROVE the prior cycle", () => {
    // Existence at the pathname is not the proof; content is. An empty file,
    // an unparseable one, and a perfectly valid intent that is somebody
    // else's must all fail to open the shortcut, because the shortcut runs
    // ahead of every guard and a false positive there reports a retirement
    // that never happened.
    const foreign = JSON.stringify({ ...intentFixture({ transitionId: TID2, confirmationEpoch: 5 }) }, null, 2);
    for (const bytes of ["", "{not json", foreign]) {
      for (const f of readdirSync(sessDir)) {
        if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
      }
      stageClosed({ kind: "cancellation", transitionId: TID });
      // Stage the canonical file AS the replacement, which is the state a
      // crash after the rename leaves, then seed a non-proving archive.
      const repl = replacement();
      writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify(repl, null, 2));
      writeFileSync(join(sessDir, ARCHIVE), bytes);

      const result = retireClosedIntent(sessDir, repl, cancelled);
      expect(result.ok).toBe(false);
      // Not the shortcut's success: the canonical is at `authorized`, so the
      // closed-phase gate is what answers, which is the whole point.
      if (!result.ok) expect(result.reason).toBe("not-closed");
    }
  });

  it("refuses a retirement retry whose replacement differs from the canonical postimage", () => {
    stageClosed({ kind: "cancellation", transitionId: TID });
    expect(retireClosedIntent(sessDir, replacement(), cancelled).ok).toBe(true);
    expect(existsSync(join(sessDir, ARCHIVE))).toBe(true);

    for (const drift of [
      { confirmedFingerprint: "fp-drifted" },
      { evidence: { ...minimalEvidence(), staleThresholdMs: 60_000 } },
    ]) {
      const result = retireClosedIntent(sessDir, { ...replacement(), ...drift } as CancellationIntent, cancelled);
      expect(result.ok).toBe(false);
      expect(intentOnDisk().confirmedFingerprint).toBe("fp-9");
    }
  });

  it("refuses the CLOSED intent handed back as its own replacement, at any generation", () => {
    // The second-generation spoof. A canonical minted by a prior cycle
    // carries a predecessor triple naming a real archive, so handing it back
    // satisfies whole-record equality AND the archive proof on a FIRST call,
    // skipping the predecessor check that would have caught it. `c.phase !==
    // "closed"` closes it totally: retirement only ever renames an
    // `authorized` replacement into place, so a genuine crash-after-rename
    // retry never finds a closed canonical, and a spoof by definition does.
    stageClosed({ kind: "cancellation", transitionId: TID });
    // Give the closed intent a predecessor naming an archive that really
    // exists, which is what a second-generation cycle looks like.
    const closed = intentOnDisk();
    const withPred = {
      ...closed,
      predecessor: { predecessorTransitionId: TID2, predecessorEpoch: 0, predecessorFingerprint: "fp-0" },
    } as CancellationIntent;
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify(withPred, null, 2));
    writeFileSync(
      join(sessDir, `cancellation-intent.superseded.${TID2}.0.json`),
      JSON.stringify(intentFixture({ transitionId: TID2, confirmedFingerprint: "fp-0" }), null, 2),
    );

    const result = retireClosedIntent(sessDir, withPred, cancelled);
    expect(result.ok).toBe(false);
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("refuses a new cycle that reuses the retired intent's transitionId", () => {
    // Archive names survive reuse (they are keyed by id AND a monotonic
    // epoch). What does not survive it is any proof keyed on the
    // transitionId alone: with reuse permitted, cycle 1's durable outcome
    // record names the same id cycle 2's closed intent carries, so cycle 1's
    // record would prove cycle 2's outcome.
    stageClosed({ kind: "cancellation", transitionId: TID });
    const result = retireClosedIntent(sessDir, { ...replacement(), transitionId: TID } as CancellationIntent, cancelled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transition-id-reused");
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("refuses a new-cycle intent that would not parse", () => {
    stageClosed({ kind: "cancellation", transitionId: TID });
    const before = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    const result = retireClosedIntent(
      sessDir, { ...replacement(), claimTxn: txnFixture() } as unknown as CancellationIntent, cancelled,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
    expect(readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8")).toBe(before);
    expect(existsSync(join(sessDir, ARCHIVE))).toBe(false);
  });

  it("refuses a new-cycle intent carrying a fabricated adoption receipt", () => {
    stageClosed({ kind: "cancellation", transitionId: TID });
    const result = retireClosedIntent(
      sessDir, { ...replacement(), adoptedFromEpoch: 0 } as CancellationIntent, cancelled,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("receipt-not-writable");
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("refuses an intent that is not closed: retirement is not an escape from a live cycle", () => {
    for (const phase of ["authorized", "prepared", "ticket_applied", "claim_cleared"] as const) {
      for (const f of readdirSync(sessDir)) {
        if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
      }
      createCancellationIntent(sessDir, intentFixture());
      if (phase !== "authorized") {
        advanceCancellationIntent(sessDir, intentFixture({ phase: "prepared", claimTxn: txnFixture() }));
      }
      if (phase === "ticket_applied" || phase === "claim_cleared") {
        advanceCancellationIntent(sessDir, intentFixture({
          phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
        }));
      }
      if (phase === "claim_cleared") {
        advanceCancellationIntent(sessDir, intentFixture({ phase: "claim_cleared" }));
      }
      const result = retireClosedIntent(sessDir, replacement(), cancelled);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not-closed");
    }
  });

  it("refuses a non-monotonic epoch and a predecessor that does not name the closed intent", () => {
    stageClosed({ kind: "cancellation", transitionId: TID });
    const stale = retireClosedIntent(sessDir, { ...replacement(), confirmationEpoch: 0 } as CancellationIntent, cancelled);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe("epoch-not-monotonic");

    for (const pred of [
      undefined,
      { predecessorTransitionId: TID2, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
      { predecessorTransitionId: TID, predecessorEpoch: 1, predecessorFingerprint: "fp-1" },
      { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-wrong" },
    ]) {
      const result = retireClosedIntent(
        sessDir, { ...replacement(), predecessor: pred } as CancellationIntent, cancelled,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("predecessor-mismatch");
    }
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("refuses a replacement that does not start the new cycle at authorized", () => {
    stageClosed({ kind: "cancellation", transitionId: TID });
    const result = retireClosedIntent(
      sessDir,
      { ...replacement(), phase: "prepared", claimTxn: txnFixture() } as unknown as CancellationIntent,
      cancelled,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("edge-refused");
  });

  it("refuses to retire an absent intent: absence is permission to CREATE", () => {
    const result = retireClosedIntent(sessDir, replacement(), cancelled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nothing-to-supersede");
  });

  it("a crash after EVERY filesystem operation leaves one canonical intent and a completable retry", () => {
    const points = [
      "retire:archive:tmp-opened",
      "retire:archive:tmp-written",
      "retire:archive:tmp-fsynced",
      "retire:archive:linked",
      "retire:archive:dir-fsynced",
      "retire:archive:tmp-removed",
      "retire:dir-fsynced-after-archive",
      "retire:tmp-written",
      "retire:tmp-fsynced",
      "retire:renamed",
      "retire:dir-fsynced",
    ];
    for (const point of points) {
      stageClosed({ kind: "cancellation", transitionId: TID });
      __intentTesting.at = (p) => { if (p === point) throw new Error(`injected at ${p}`); };
      expect(() => retireClosedIntent(sessDir, replacement(), cancelled)).toThrow(/injected/);
      __intentTesting.at = () => undefined;

      assertCanonicalInvariants([TID, TID2]);
      const retry = retireClosedIntent(sessDir, replacement(), cancelled);
      expect(retry.ok).toBe(true);
      expect(intentOnDisk().transitionId).toBe(TID2);
    }
  });

  it("resolves a ZERO-LENGTH archive as a half-birth rather than wedging forever", () => {
    // `wx` creates the inode before the first byte, so a crash in that window
    // leaves an empty archive at the expected name. Byte-comparing it against
    // the canonical would call it someone else's evidence and refuse this
    // cycle permanently; an empty file is evidence of nothing.
    stageClosed({ kind: "cancellation", transitionId: TID });
    const canonical = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    writeFileSync(join(sessDir, ARCHIVE), "");

    const result = retireClosedIntent(sessDir, replacement(), cancelled);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(sessDir, ARCHIVE), "utf-8")).toBe(canonical);
    expect(intentOnDisk().transitionId).toBe(TID2);
  });
});
