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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, linkSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";

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
const TID3 = "cccccccc-1111-4222-8333-444444444444";
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

/**
 * A fixture carrying the CANONICAL's minted cycleNonce. Advancement and
 * adoption pin the whole record, and the nonce is minted inside the writers,
 * so a test that advances must thread the nonce exactly the way a real
 * consumer does: by reading the record it was returned. Never used for the
 * new-cycle writers, whose inputs are nonce-less by type and by guard.
 */
function nonced(over: Partial<Record<string, unknown>> = {}): CancellationIntent {
  return { ...intentFixture(over), cycleNonce: intentOnDisk().cycleNonce } as unknown as CancellationIntent;
}

function intentOnDisk(): CancellationIntent {
  const read = readCancellationIntent(sessDir);
  if (read.kind !== "valid") throw new Error(`expected valid intent, got ${read.kind}`);
  return read.intent;
}

/** The never-freed-pathname invariant plus single-live-transitionId. */
/**
 * Every per-attempt temp currently in the session directory.
 *
 * The grammar is `<target>.creating.<pid>.<counter>` and `.tmp.<pid>.<counter>`
 * (ISS-954). It deliberately does NOT match the legacy bare `.creating` /
 * `.tmp` names, because those carry no pid, nothing about their owner can be
 * proven, and the sweep must leave them alone.
 */
function lingeringTemps(): string[] {
  return readdirSync(sessDir).filter((n) => /\.(?:creating|tmp)\.\d+\.[0-9a-z]+$/.test(n)).sort();
}

/** A pid that is genuinely free: allocated, run to completion, reaped, probed. */
function reapedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  if (typeof child.pid !== "number") throw new Error("could not allocate a pid to reap");
  try {
    process.kill(child.pid, 0);
    throw new Error(`pid ${child.pid} is still live after being reaped`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  return child.pid;
}

function assertCanonicalInvariants(liveTids: readonly string[]): void {
  expect(existsSync(join(sessDir, CANCELLATION_INTENT_FILE))).toBe(true);
  const read = readCancellationIntent(sessDir);
  expect(read.kind).toBe("valid");
  if (read.kind === "valid") expect(liveTids).toContain(read.intent.transitionId);
}

beforeEach(() => {
  sessDir = mkdtempSync(join(tmpdir(), "t450-intent-"));
  __intentTesting.at = () => undefined;
  __intentTesting.tempSuffix = null;
});

afterEach(() => {
  __intentTesting.at = () => undefined;
  __intentTesting.tempSuffix = null;
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
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));
    const strayTxn = nonced({
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
    // Rewritten for the per-attempt temp grammar (ISS-954): asserting the
    // single legacy name is absent would now pass vacuously, since no writer
    // can ever produce that name. The property is that the refusal left NO
    // temp of ANY attempt behind.
    expect(lingeringTemps()).toEqual([]);
  });

  it("refuses an ADOPTED record that would not parse", () => {
    createCancellationIntent(sessDir, intentFixture());
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({
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
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({
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
  // THE CORRUPTION THIS CLOSES, in two generations.
  //
  // FIRST: after `link` the temp name and the published name are two entries
  // for ONE inode, so a temp left by a crash pointed at the LIVE record, and
  // an `w` (O_TRUNC) open by the next writer truncated it through the shared
  // inode. That was closed by unlinking before every open.
  //
  // SECOND (ISS-954): unlinking first is what made the name STEALABLE across
  // processes, because `link` and `rename` resolve the name a second time
  // after the bytes are written. Both generations are closed structurally now:
  // the name carries the writing attempt's pid and counter, and `wx` refuses a
  // name already claimed, so no writer can ever open or publish through
  // ANOTHER attempt's temp. The `finally` unlink removes OUR OWN temp on every
  // EXCEPTION path, which is a distinct claim from surviving a KILLED process:
  // `finally` does not run across SIGKILL, so a per-attempt temp CAN still be
  // left hard-linked to a published record. The tests below split accordingly
  // -- exception cleanup asserts the state is UNREACHABLE that way, and the
  // killed-process test stages the state BY HAND and asserts it is HARMLESS,
  // not that it cannot occur.
  //
  // The legacy bare name is still staged by hand in several tests. That is
  // deliberate: it is exactly what an older binary leaves behind, and no
  // current writer may open, publish through, or sweep it.
  const TMP = CANCELLATION_INTENT_FILE + ".creating";

  it("EXCEPTION cleanup: a thrown create removes its own temp via `finally`", () => {
    // NAMED FOR WHAT IT PROVES. An injected throw runs `finally`, so this
    // establishes the exception path only. It deliberately does NOT claim
    // anything about a killed process, which skips `finally` entirely; that is
    // the test below, and conflating the two would assert a property the code
    // does not have.
    __intentTesting.at = (p) => { if (p === "create:dir-fsynced") throw new Error("injected"); };
    expect(() => createCancellationIntent(sessDir, intentFixture())).toThrow(/injected/);
    __intentTesting.at = () => undefined;

    expect(lingeringTemps()).toEqual([]);
    const after = readCancellationIntent(sessDir);
    expect(after.kind).toBe("valid");
    if (after.kind === "valid") expect(after.intent.transitionId).toBe(TID);
  });

  it("KILLED process: the stale temp it leaves is HARMLESS, and the sweep reclaims it", () => {
    // THE TRUE CLAIM, and it is weaker than "a crash leaves no temp". A killed
    // process does not run `finally`, so a per-attempt temp CAN survive still
    // hard-linked to the published canonical. That state is staged here by hand
    // because it is exactly what SIGKILL between `link` and the unlink leaves.
    //
    // It is harmless for two independent reasons, and both are asserted: no
    // later writer can ever reuse that name (it carries the dead attempt's pid
    // and counter, and `wx` would refuse it anyway), and the sweep removes only
    // the TEMP directory entry, never the inode's other link.
    expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);
    const canonical = join(sessDir, CANCELLATION_INTENT_FILE);
    const dead = reapedPid();
    const orphan = join(sessDir, `${CANCELLATION_INTENT_FILE}.creating.${dead}.k1`);
    linkSync(canonical, orphan);

    const inoBefore = statSync(canonical).ino;
    const bytesBefore = readFileSync(canonical, "utf-8");
    expect(statSync(orphan).ino).toBe(inoBefore);

    // Any later writer runs the sweep on its way in.
    const second = createCancellationIntent(sessDir, intentFixture({ transitionId: TID2 }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("exists");

    // The temp entry is gone; the record it shared an inode with is untouched.
    expect(existsSync(orphan)).toBe(false);
    expect(statSync(canonical).ino).toBe(inoBefore);
    expect(readFileSync(canonical, "utf-8")).toBe(bytesBefore);
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

  it("SWEEP: removes a temp whose owner is PROVEN gone, and only that one", () => {
    const dead = reapedPid();
    const deadTemp = `${CANCELLATION_INTENT_FILE}.creating.${dead}.zz`;
    writeFileSync(join(sessDir, deadTemp), "orphan");
    writeFileSync(join(sessDir, TMP), "legacy-bare");

    expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);

    expect(existsSync(join(sessDir, deadTemp))).toBe(false);
    // Legacy bare name: outside the grammar, never swept, never opened.
    expect(readFileSync(join(sessDir, TMP), "utf-8")).toBe("legacy-bare");
  });

  it("SWEEP: an EPERM probe is NOT proof of death, so the temp is kept", () => {
    // MOCKED, not staged against pid 1. `kill(1, 0)` answers EPERM only when
    // unprivileged; as root or in many containers it SUCCEEDS, so a fixture
    // built on it would silently exercise the alive branch and let a mutant
    // that treats EPERM as death survive while staying green.
    const foreign = `${CANCELLATION_INTENT_FILE}.creating.424242.aa`;
    writeFileSync(join(sessDir, foreign), "someone else's live attempt");
    const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 424242) {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return true;
    }) as unknown as typeof process.kill);

    try {
      expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }

    expect(readFileSync(join(sessDir, foreign), "utf-8")).toBe("someone else's live attempt");
  });

  it("SWEEP: an ESRCH probe IS proof, so the same temp is reclaimed", () => {
    // The paired positive, so the test above cannot pass by the sweep simply
    // never deleting anything.
    const foreign = `${CANCELLATION_INTENT_FILE}.creating.424242.aa`;
    writeFileSync(join(sessDir, foreign), "a dead attempt");
    const spy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 424242) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as unknown as typeof process.kill);

    try {
      expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }

    expect(existsSync(join(sessDir, foreign))).toBe(false);
  });

  it("a temp collision is RETRIED, and exhaustion never reports an existing record", () => {
    // THE MISCLASSIFICATION THIS PINS (ISS-954 A2). A temp EEXIST is a name
    // collision; the canonical pathname here is ABSENT. If that errno reached
    // `createCancellationIntent`'s classifier it would return `exists`,
    // reporting a record that is not there. So exhaustion must surface as a
    // throw carrying NO `code`, and never as a refusal.
    //
    // A constant injected suffix makes all 32 attempts collide, which is the
    // only way to reach this branch: the real name carries seeded entropy plus
    // the pid.
    const taken = `${CANCELLATION_INTENT_FILE}.creating.CONST`;
    writeFileSync(join(sessDir, taken), "another attempt's bytes");
    __intentTesting.tempSuffix = () => "CONST";

    try {
      let thrown: unknown;
      try {
        createCancellationIntent(sessDir, intentFixture());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as NodeJS.ErrnoException).code).toBeUndefined();
      expect((thrown as Error).message).toContain("temp-name collision");
    } finally {
      __intentTesting.tempSuffix = null;
    }

    // `wx` refused every attempt, so the squatter's bytes are intact and the
    // canonical was never published.
    expect(readFileSync(join(sessDir, taken), "utf-8")).toBe("another attempt's bytes");
    expect(readCancellationIntent(sessDir).kind).toBe("absent");
  });

  it("the retry walks to a FRESH name and succeeds once one is free", () => {
    // The other side of the same loop: collisions must be retried, not fatal.
    const taken = `${CANCELLATION_INTENT_FILE}.creating.A0`;
    writeFileSync(join(sessDir, taken), "occupied");
    __intentTesting.tempSuffix = (attempt) => (attempt === 0 ? "A0" : `A${attempt}`);

    try {
      expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);
    } finally {
      __intentTesting.tempSuffix = null;
    }

    expect(intentOnDisk().transitionId).toBe(TID);
    expect(readFileSync(join(sessDir, taken), "utf-8")).toBe("occupied");
    expect(lingeringTemps()).toEqual([]);
  });

  it("the LINK writer and the RENAME writer claim distinct, target-derived names", () => {
    // Uniqueness must hold BETWEEN writers, not just across repeated calls to
    // one of them: the two derive from different targets and different kinds.
    const seen: string[] = [];
    __intentTesting.at = (p) => {
      if (p.endsWith(":tmp-written")) seen.push(...lingeringTemps());
    };
    expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);
    expect(advanceCancellationIntent(
      sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }),
    ).ok).toBe(true);
    __intentTesting.at = () => undefined;

    expect(seen.length).toBe(2);
    expect(new Set(seen).size).toBe(2);
    expect(seen[0]).toContain(".creating.");
    expect(seen[1]).toContain(".tmp.");
    // Target-derivation, not just distinctness: both writers here target the
    // canonical, so every captured temp must be derived from its name.
    for (const name of seen) expect(name.startsWith(CANCELLATION_INTENT_FILE)).toBe(true);
    expect(lingeringTemps()).toEqual([]);
  });

  it("CROSS-PROCESS: the inode-steal window itself, with BOTH writers parked before publishing", async () => {
    // THE REGRESSION FOR ISS-954, reproducing the window rather than its
    // aftermath. An earlier version of this test parked one writer and let the
    // other RUN TO COMPLETION. That version did fail on the old shared name,
    // which is what made it look sufficient, but it failed for the WRONG
    // REASON: a completing writer also unlinks the shared temp, so the parked
    // writer hit ENOENT rather than publishing the other's inode. Verifying
    // that a test fails on reverted code is not the same as verifying it fails
    // for the reason it claims.
    //
    // Both writers now stop with their temps WRITTEN AND FSYNCED but NOT
    // published. Under one shared deterministic name, B's open is what the
    // name last resolved to, so releasing A makes A link B'S INODE to the
    // canonical: A reports success while the record on disk is B's. Under
    // per-attempt names A can only ever link its own.
    const runner = join(process.cwd(), "node_modules", ".bin", "tsx");
    const script = join(process.cwd(), "test", "autonomous", "fixtures", "t450-concurrent-writer.ts");
    const spawnParked = (role: string, out: string, tid: string, sig: string, go: string) =>
      spawn(runner, [script, sessDir, role, out], {
        env: {
          ...process.env,
          INTENT: JSON.stringify(intentFixture({ transitionId: tid })),
          PARK_SEAM: "create:tmp-fsynced",
          PARK_SIGNAL: sig,
          PARK_GO: go,
        },
        stdio: "ignore",
      });
    const await_ = async (name: string) => {
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(sessDir, name)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(join(sessDir, name))).toBe(true);
    };

    const a = spawnParked("a", "result-a", TID, "a-parked", "a-go");
    await await_("a-parked");
    // B parks with ITS temp durable. This is the instant the shared name would
    // have stopped meaning what A wrote.
    const bProc = spawnParked("b", "result-b", TID2, "b-parked", "b-go");
    await await_("b-parked");

    // Release A first: it publishes through the name it claimed.
    writeFileSync(join(sessDir, "a-go"), "1");
    await new Promise((r) => a.on("exit", r));
    writeFileSync(join(sessDir, "b-go"), "1");
    await new Promise((r) => bProc.on("exit", r));

    const ra = JSON.parse(readFileSync(join(sessDir, "result-a"), "utf-8"));
    const rb = JSON.parse(readFileSync(join(sessDir, "result-b"), "utf-8"));
    expect([ra.ok, rb.ok].filter(Boolean).length).toBe(1);

    // THE DECISIVE ASSERTION: the writer that reported success must be the one
    // whose bytes are on disk. Under the steal, A returns ok while the
    // canonical holds B's intent.
    const onDisk = readCancellationIntent(sessDir);
    expect(onDisk.kind).toBe("valid");
    if (onDisk.kind !== "valid") return;
    expect(onDisk.intent.transitionId).toBe(ra.ok ? TID : TID2);
  }, 90_000);

  it("the ARCHIVE writer derives its temp from the ARCHIVE, not from the canonical", () => {
    // Target-derivation asserted where it actually matters. Comparing a create
    // against an advance only shows that the `.creating` and `.tmp` KINDS
    // differ; both target the canonical, so reverting the archive writer to
    // derive from `intentPath` would stay green. The archive path is the one
    // that shared a name with the canonical writer before ISS-954, which is how
    // a stale create temp reached an archive write.
    expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);
    const archiveBase = `cancellation-intent.superseded.${TID}.0.json`;

    let archiveTemp: string | undefined;
    __intentTesting.at = (p) => {
      if (p === "supersede:archive:tmp-written") {
        archiveTemp = lingeringTemps().find((n) => n.startsWith(archiveBase));
      }
    };
    const replacement = intentFixture({
      transitionId: TID2, confirmationEpoch: 1,
      predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
    });
    expect(supersedeCancellationIntent(sessDir, replacement).ok).toBe(true);
    __intentTesting.at = () => undefined;

    expect(archiveTemp).toBeDefined();
    expect(archiveTemp).toMatch(new RegExp(`^${archiveBase.replace(/\./g, "\\.")}\\.creating\\.\\d+\\.`));
    expect(lingeringTemps()).toEqual([]);
  });

  it("CROSS-PROCESS, DIFFERENT TARGETS: a create and an archive write cannot reach each other", async () => {
    // THE OTHER HALF OF ISS-954's ACCEPTANCE, and the one the single-process
    // derivation test above cannot reach. Before the fix, createExclusiveDurable
    // derived its temp from the CANONICAL pathname even when publishing an
    // ARCHIVE, so a create and a supersession's archive write collided on one
    // name despite writing to different targets.
    //
    // The harm runs archive-ward: the archive writer parks with the canonical's
    // bytes staged under the shared name, the create then truncates that name
    // and writes ITS bytes, and releasing the archive writer links the name to
    // the archive path. The archive, which is supposed to be the superseded
    // record's evidence, ends up holding an unrelated intent. That breaks both
    // the byte-strict EEXIST resolution and the archive proof for the triple.
    expect(createCancellationIntent(sessDir, intentFixture()).ok).toBe(true);
    const canonicalBytes = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");

    const runner = join(process.cwd(), "node_modules", ".bin", "tsx");
    const script = join(process.cwd(), "test", "autonomous", "fixtures", "t450-concurrent-writer.ts");
    const spawnParked = (mode: string, out: string, intent: unknown, seam: string, sig: string, go: string) =>
      spawn(runner, [script, sessDir, mode, out], {
        env: { ...process.env, INTENT: JSON.stringify(intent), PARK_SEAM: seam, PARK_SIGNAL: sig, PARK_GO: go },
        stdio: "ignore",
      });
    const await_ = async (name: string) => {
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(sessDir, name)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(join(sessDir, name))).toBe(true);
    };

    // The ARCHIVE writer parks first, holding the canonical's bytes staged.
    const superseder = spawnParked(
      "supersede", "result-sup",
      intentFixture({
        transitionId: TID2, confirmationEpoch: 1,
        predecessor: { predecessorTransitionId: TID, predecessorEpoch: 0, predecessorFingerprint: "fp-1" },
      }),
      "supersede:archive:tmp-fsynced", "sup-parked", "sup-go",
    );
    await await_("sup-parked");

    // The CREATE writer then stages its own bytes. Under one shared name this
    // is the instant the archive writer's staged content stops being the
    // canonical's.
    const creator = spawnParked(
      "create", "result-cre", intentFixture({ transitionId: TID3 }),
      "create:tmp-fsynced", "cre-parked", "cre-go",
    );
    await await_("cre-parked");

    writeFileSync(join(sessDir, "sup-go"), "1");
    await new Promise((r) => superseder.on("exit", r));
    writeFileSync(join(sessDir, "cre-go"), "1");
    await new Promise((r) => creator.on("exit", r));

    // THE DECISIVE ASSERTION: the archive holds the record it superseded, not
    // the concurrent create's intent.
    const archive = join(sessDir, `cancellation-intent.superseded.${TID}.0.json`);
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(archive, "utf-8")).toBe(canonicalBytes);
    expect(JSON.parse(readFileSync(archive, "utf-8")).transitionId).toBe(TID);
  }, 90_000);

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
    // The nonce is spelled out because the schema REQUIRES it: a record
    // missing it is malformed for that reason alone, which would leave this
    // test green even if the two phases were no longer bound at all.
    const contradictory = {
      ...intentFixture({ phase: "prepared" }),
      cycleNonce: "55555555-5555-4555-8555-555555555555",
      claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    };
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify(contradictory));
    expect(readCancellationIntent(sessDir).kind).toBe("malformed");
  });

  it("round-trips an absent field and an explicit null as DIFFERENT states", () => {
    const txn = txnFixture();
    createCancellationIntent(sessDir, intentFixture({ phase: "authorized" }));
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txn }));
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
    expect(advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txn })).ok).toBe(true);
    expect(advanceCancellationIntent(sessDir, nonced({ phase: "ticket_applied", claimTxn: { ...txn, phase: "ticket_applied" } })).ok).toBe(true);
    expect(advanceCancellationIntent(sessDir, nonced({ phase: "claim_cleared" })).ok).toBe(true);
    expect(advanceCancellationIntent(sessDir, nonced({
      phase: "closed", outcome: { kind: "cancellation", transitionId: TID },
    })).ok).toBe(true);
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("refuses every skipped edge: each phase's durable obligations exist for the next", () => {
    for (const phase of ["ticket_applied", "claim_cleared", "closed"] as const) {
      const next = phase === "closed"
        ? nonced({ phase, outcome: { kind: "cancellation", transitionId: TID } })
        : phase === "ticket_applied"
          ? nonced({ phase, claimTxn: { ...txnFixture(), phase: "ticket_applied" } })
          : nonced({ phase });
      const result = advanceCancellationIntent(sessDir, next);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("edge-refused");
    }
    expect(intentOnDisk().phase).toBe("authorized");
  });

  it("a same-phase advance refuses: idempotent reads are reads, not advancements", () => {
    const result = advanceCancellationIntent(sessDir, nonced());
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
      expect(() => advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() })))
        .toThrow(/injected/);
      __intentTesting.at = () => undefined;

      assertCanonicalInvariants([TID]);
      const phase = intentOnDisk().phase;
      expect(["authorized", "prepared"]).toContain(phase);

      // The retry: from `authorized` the same advance re-runs; from `prepared`
      // (crash after the rename landed) the work is already done.
      if (phase === "authorized") {
        expect(advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() })).ok).toBe(true);
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
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({ phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" } }));
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

  it("EVERY new cycle mints a FRESH nonce: collision-negligible entropy is what subsumes provenance", () => {
    // Two cycles sharing a nonce would let one cycle's postimage prove the
    // other's outcome; the entropy claim is load-bearing (it is why the
    // postimage omits sessionId/sessionStartedAt), so freshness is pinned
    // across both new-cycle writers reachable from here.
    const before = intentOnDisk().cycleNonce;
    expect(supersedeCancellationIntent(sessDir, replacement()).ok).toBe(true);
    const superseded = intentOnDisk().cycleNonce;
    expect(superseded).not.toBe(before);

    const dir2 = mkdtempSync(join(tmpdir(), "t450-nonce-"));
    try {
      const created = createCancellationIntent(dir2, intentFixture());
      expect(created.ok).toBe(true);
      if (created.ok) {
        expect(created.intent.cycleNonce).not.toBe(before);
        expect(created.intent.cycleNonce).not.toBe(superseded);
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("H2: a DOCTORED ARCHIVE COPY, nonce and all, refuses as nonce-not-writable on every writer", () => {
    // THE ATTACK THE NONCE GATE EXISTS FOR (ruling ea611619 B3). An archived
    // intent carries its cycle's nonce in raw bytes, so a caller can copy one
    // and present it as a replacement: every field self-consistent, the
    // predecessor triple naming a real archive. Without the gate, the copied
    // nonce would match a lingering postimage and a close could succeed with
    // no commit ever running. The gate sits BELOW the retry shortcut, so a
    // genuine crash-after-rename retry (which never learned the minted
    // nonce) is untouched, while any record that CARRIES a nonce -- and
    // every on-disk copy necessarily does -- is refused on the full path.
    expect(supersedeCancellationIntent(sessDir, replacement()).ok).toBe(true);
    const archived = JSON.parse(readFileSync(join(sessDir, ARCHIVE), "utf-8")) as Record<string, unknown>;
    expect(typeof archived.cycleNonce).toBe("string");

    // Supersede: the copy is doctored to look like a fresh next cycle.
    const doctored = {
      ...archived,
      transitionId: TID3,
      confirmationEpoch: 7,
      predecessor: {
        predecessorTransitionId: intentOnDisk().transitionId,
        predecessorEpoch: intentOnDisk().confirmationEpoch,
        predecessorFingerprint: intentOnDisk().confirmedFingerprint,
      },
    };
    const superseded = supersedeCancellationIntent(sessDir, doctored as unknown as CancellationIntent);
    expect(superseded.ok).toBe(false);
    if (!superseded.ok) expect(superseded.reason).toBe("nonce-not-writable");

    // Create: an absent canonical must still refuse a nonce-bearing record.
    const dir2 = mkdtempSync(join(tmpdir(), "t450-h2-"));
    try {
      const created = createCancellationIntent(dir2, archived as unknown as CancellationIntent);
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.reason).toBe("nonce-not-writable");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
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
    // NONCE-STRIPPED: modulo-nonce equality is what a real crash-after-rename
    // retry presents (the caller never learned the minted nonce), and it is
    // the ONLY shape that reaches the archive half. Handing back the
    // canonical nonce and all differs by that key, so equality answers first
    // and the archive proof is never consulted.
    const { cycleNonce: _n, ...canonical } = intentOnDisk() as unknown as Record<string, unknown>;

    // The refusal itself is the kill: with the archive half dropped the
    // shortcut would answer `ok` here. Past it, the reuse guard is what
    // speaks, since a self-replacement reuses its own transitionId.
    const result = supersedeCancellationIntent(sessDir, canonical as unknown as CancellationIntent);
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
    // Nonce-stripped for the same reason as the archive test above: only a
    // modulo-nonce-equal replacement reaches the proof this test is about.
    const { cycleNonce: _n, ...spoof } = bare as unknown as Record<string, unknown>;
    const result = supersedeCancellationIntent(sessDir, spoof as unknown as CancellationIntent);
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
    advanceCancellationIntent(sessDir, { ...intentOnDisk(), phase: "prepared", claimTxn: { ...txnFixture(), transitionId: TID2 } } as CancellationIntent);
    const midCycle = intentOnDisk();
    expect(midCycle.phase).toBe("prepared");
    expect(existsSync(join(sessDir, ARCHIVE))).toBe(true);

    // Hand back the canonical MINUS its nonce: the caller-supplied shape a
    // genuine retry would carry, so the phase condition alone decides.
    const { cycleNonce: _n, ...midCycleBare } = midCycle as Record<string, unknown> & { cycleNonce: string };
    const result = supersedeCancellationIntent(sessDir, midCycleBare as unknown as CancellationIntent);
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
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({ phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" } }));
  });

  it("keeps the transitionId and phase, bumps the epoch, replaces the confirmation pair and evidence", () => {
    const nonceBefore = intentOnDisk().cycleNonce;
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
    // The CYCLE identity survives adoption: adoption re-mints confirmation,
    // never identity, and the takeover close gates on this exact value.
    expect(now.cycleNonce).toBe(nonceBefore);
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
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    const swapped = { ...txnFixture(), phase: "ticket_applied" as const, ticketId: "T-999" };
    const result = advanceCancellationIntent(sessDir, nonced({ phase: "ticket_applied", claimTxn: swapped }));
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
    // NONCED, so the drift is the ONLY difference from the canonical. A
    // record built without the canonical's minted nonce differs on the nonce
    // too, and the whole-record pin then refuses for THAT, leaving this test
    // green while the confirmation pin itself is gone.
    for (const drift of [{ confirmedFingerprint: "fp-drift" }, { confirmedSessionRevision: 99 }]) {
      const result = advanceCancellationIntent(
        sessDir, nonced({ phase: "prepared", claimTxn: txnFixture(), ...drift }),
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
    const canonical = nonced({ phase: "prepared", claimTxn: txnFixture() }) as unknown as Record<string, unknown>;
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
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({
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
        advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
        advanceCancellationIntent(sessDir, nonced({
          phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
        }));
        advanceCancellationIntent(sessDir, nonced({ phase: "claim_cleared" }));
        advanceCancellationIntent(sessDir, nonced({
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
    advanceCancellationIntent(sessDir, nonced({ phase: "claim_cleared" }));
    advanceCancellationIntent(sessDir, nonced({
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
    // ISS-967: this models a published candidate CANCELLATION, so it carries
    // the cancellation action. It used to carry the takeover value, because
    // that was the only candidate value the enum had -- the same defect the
    // issue is about, reproduced in a fixture.
    action: "candidate_recovery_cancellation",
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
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));
    advanceCancellationIntent(sessDir, nonced({ phase: "claim_cleared" }));
    advanceCancellationIntent(sessDir, nonced({ phase: "closed", outcome }));
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

  // ISS-967: the gate was WIDENED, not switched. A cancellation published
  // before the fix carries the takeover literal, and those records still exist
  // wherever one was written; refusing them would strand exactly the crashed
  // cycles this gate exists to let finish. Each value gets its own case so a
  // successful retirement in one cannot disturb the other's fixture.
  it.each([
    ["the new cancellation value", "candidate_recovery_cancellation"],
    ["the pre-fix takeover value", "candidate_recovery_takeover"],
  ])("ISS-967: accepts %s as proof of a candidate cancellation", (_label, action) => {
    stageClosed({ kind: "cancellation", transitionId: TID });
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: publishedTransition({ action }),
      sessionRevision: 6,
    });
    expect(result.ok, `refused a ${action} record`).toBe(true);
  });

  it("REFUSES a closed takeover with NO postimage: a revision counter is not proof that it happened", () => {
    // `sessionRevision >= committedRevision` is satisfied by any later write
    // for any reason, so it cannot establish that this takeover was ever
    // committed -- and retirement discards the record, so a weak proof here
    // loses the only trace of it. The real proof is the durable takeover
    // postimage `commitCandidateTakeover` writes (ruling ea611619 B10);
    // absent, the outcome is underivable, never an error.
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

  /** The postimage that PROVES the staged closed takeover, built from the
   * closed intent's own identity so the nonce and corroboration agree. */
  function provingPostimage(over: Record<string, unknown> = {}): Record<string, unknown> {
    const c = intentOnDisk();
    return {
      schemaVersion: 1,
      kind: "candidate_takeover_committed",
      cycleNonce: c.cycleNonce,
      takeoverKind: "owner_gone_candidate_takeover",
      intentTransitionId: c.transitionId,
      clientTaskId: c.clientTaskId,
      confirmationEpoch: c.confirmationEpoch,
      evidence: {},
      ...over,
    };
  }

  it("B10: RETIRES a closed takeover whose postimage matches on nonce and corroboration", () => {
    stageClosed({ kind: "takeover", committedRevision: 7 });
    const before = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: undefined, candidateTakeover: provingPostimage(), sessionRevision: 7,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(sessDir, ARCHIVE), "utf-8")).toBe(before);
    expect(intentOnDisk().transitionId).toBe(TID2);
    expect(intentOnDisk().phase).toBe("authorized");
  });

  it("B10: the revision precondition refuses BEFORE the postimage is even consulted", () => {
    stageClosed({ kind: "takeover", committedRevision: 7 });
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: undefined, candidateTakeover: provingPostimage(), sessionRevision: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outcome-underivable");
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("B10: a postimage with ANOTHER cycle's nonce is a stale value, underivable and never an error", () => {
    stageClosed({ kind: "takeover", committedRevision: 7 });
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: undefined,
      candidateTakeover: provingPostimage({ cycleNonce: "99999999-9999-4999-8999-999999999999" }),
      sessionRevision: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outcome-underivable");
  });

  it("B10: a nonce match with contradicting corroboration is CORRUPTION, its own refusal", () => {
    for (const conflict of [
      { intentTransitionId: TID3 },
      { clientTaskId: "task-somebody-else" },
    ]) {
      stageClosed({ kind: "takeover", committedRevision: 7 });
      const result = retireClosedIntent(sessDir, replacement(), {
        cancellationTransition: undefined,
        candidateTakeover: provingPostimage(conflict),
        sessionRevision: 7,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("takeover-postimage-conflict");
      expect(intentOnDisk().phase).toBe("closed");
    }
  });

  it("B10: a MALFORMED postimage refuses as unreadable, distinct from underivable", () => {
    stageClosed({ kind: "takeover", committedRevision: 7 });
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: undefined,
      candidateTakeover: { schemaVersion: 1, kind: "not-a-postimage" },
      sessionRevision: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("takeover-postimage-unreadable");
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("B10: an ADOPTED cycle still retires: adoption re-mints the confirmation, never the identity", () => {
    // Raised in review as a permanent foreclosure: if adoption rebound the
    // cycle to the adopting candidate, the postimage's clientTaskId would
    // disagree with the intent's forever and an adopted takeover could never
    // be retired, being read as corruption instead.
    //
    // It does not. Adoption spreads the canonical and overrides only the
    // confirmation quartet plus its own receipt. Every operation that DOES
    // set clientTaskId -- creation and supersession -- mints a fresh nonce,
    // so the nonce gate answers "different cycle" before corroboration is
    // ever reached. Corroboration therefore only ever runs inside one cycle,
    // where the identity is by construction unchanged. Pinned here so the
    // property is enforced rather than argued.
    for (const f of readdirSync(sessDir)) {
      if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
    }
    createCancellationIntent(sessDir, intentFixture());
    const born = intentOnDisk();
    advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
    advanceCancellationIntent(sessDir, nonced({
      phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
    }));

    // A REAL adoption, legal at ticket_applied.
    const adopted = readoptCancellationIntent(sessDir, {
      transitionId: born.transitionId,
      confirmationEpoch: born.confirmationEpoch + 1,
      confirmedSessionRevision: 9,
      confirmedFingerprint: "fp-adopted",
      evidence: minimalEvidence(),
    });
    expect(adopted.ok).toBe(true);
    const after = intentOnDisk();
    expect(after.cycleNonce).toBe(born.cycleNonce);
    expect(after.clientTaskId).toBe(born.clientTaskId);
    expect(after.adoptedFromEpoch).toBe(born.confirmationEpoch);

    // Finish the cycle as a takeover.
    const cleared = { ...intentOnDisk(), phase: "claim_cleared" } as Record<string, unknown>;
    delete cleared.claimTxn;
    expect(advanceCancellationIntent(sessDir, cleared as unknown as CancellationIntent).ok).toBe(true);
    expect(advanceCancellationIntent(sessDir, {
      ...intentOnDisk(), phase: "closed", outcome: { kind: "takeover", committedRevision: 7 },
    } as unknown as CancellationIntent).ok).toBe(true);

    // The postimage the commit wrote, carrying the PRE-adoption epoch and the
    // cycle's original identity, which adoption left alone.
    const post = provingPostimage({ confirmationEpoch: born.confirmationEpoch });
    const closed = intentOnDisk();
    const result = retireClosedIntent(sessDir, {
      ...replacement(),
      confirmationEpoch: closed.confirmationEpoch + 1,
      predecessor: {
        predecessorTransitionId: closed.transitionId,
        predecessorEpoch: closed.confirmationEpoch,
        predecessorFingerprint: closed.confirmedFingerprint,
      },
    } as CancellationIntent, {
      cancellationTransition: undefined, candidateTakeover: post, sessionRevision: 7,
    });
    expect(result.ok).toBe(true);
    expect(intentOnDisk().transitionId).toBe(TID2);
  });

  it("B10: EPOCH IS NEVER COMPARED: a postimage behind the intent's epoch still proves it", () => {
    // The post-postimage adoption history: the intent re-minted its
    // confirmation after the commit, so the postimage's audit epoch is
    // behind. Retirement must still derive, or those recovery histories
    // would be permanently unretirable.
    stageClosed({ kind: "takeover", committedRevision: 7 });
    const drifted = provingPostimage({ confirmationEpoch: 0 });
    const canonical = intentOnDisk();
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify({
      ...canonical, confirmationEpoch: canonical.confirmationEpoch + 5,
    }, null, 2));
    const result = retireClosedIntent(sessDir, {
      ...replacement(),
      confirmationEpoch: canonical.confirmationEpoch + 6,
      predecessor: {
        predecessorTransitionId: canonical.transitionId,
        predecessorEpoch: canonical.confirmationEpoch + 5,
        predecessorFingerprint: canonical.confirmedFingerprint,
      },
    } as CancellationIntent, {
      cancellationTransition: undefined, candidateTakeover: drifted, sessionRevision: 7,
    });
    expect(result.ok).toBe(true);
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

  it("ISS-967: its refusal names BOTH accepted records, not the takeover one alone", () => {
    // Ride-along pin. This message is the only place the gate explains WHICH
    // records it accepts, and before the fix it said a candidate intent is
    // "proved by a candidate_recovery_takeover" -- teaching the exact
    // misreading the issue is about, inside the refusal an operator reads when
    // a retirement is stuck.
    //
    // The fixture is ordinary + legacy DELIBERATELY: it is the only wrong-kind
    // case above that is schema-VALID, so it is the only one that reaches this
    // gate at all. The others refuse one gate earlier, at the unreadable
    // record, with a different message.
    stageClosed({ kind: "cancellation", transitionId: TID });
    const result = retireClosedIntent(sessDir, replacement(), {
      cancellationTransition: publishedTransition({
        action: "ordinary_cancellation", authority: { kind: "legacy" },
      }),
      sessionRevision: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outcome-underivable");
      expect(result.detail).toContain("candidate_recovery_cancellation");
      expect(result.detail).toContain("pre-fix candidate-cancellation records");
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

  it("refuses the CLOSED canonical handed back nonce-stripped as its own replacement", () => {
    // The one spoof the predecessor-and-archive proof cannot refuse on its
    // own: retire once for real, close the SECOND generation, then hand its
    // canonical back minus the nonce. Every half of the shortcut's proof is
    // genuinely true -- modulo-nonce equality holds because the copy IS the
    // canonical, and the predecessor triple names a real archive because a
    // real cycle minted it. Only `c.phase !== "closed"` tells this apart
    // from a crash-after-rename retry, whose canonical is never closed.
    // Without it the shortcut reports the finished cycle as live.
    stageClosed({ kind: "cancellation", transitionId: TID });
    expect(retireClosedIntent(sessDir, replacement(), cancelled).ok).toBe(true);

    // Close the second generation by hand: same record, phase closed, its
    // own published outcome. The nonce and predecessor are preserved.
    const second = intentOnDisk();
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify({
      ...second, phase: "closed", outcome: { kind: "cancellation", transitionId: TID2 },
    }, null, 2));

    const { cycleNonce: _n, ...spoof } = intentOnDisk() as unknown as Record<string, unknown>;
    const result = retireClosedIntent(sessDir, spoof as unknown as CancellationIntent, {
      cancellationTransition: publishedTransition({ transitionId: TID2 }), sessionRevision: 6,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // WHICH downstream guard answers is not pinned; that the shortcut did
      // NOT answer with success is.
      expect(["not-closed", "epoch-not-monotonic", "predecessor-mismatch", "transition-id-reused"])
        .toContain(result.reason);
    }
    expect(intentOnDisk().phase).toBe("closed");
  });

  it("refuses the retry shortcut for an archive that does not PROVE the prior cycle", () => {
    // Existence at the pathname is not the proof; content is. An empty file,
    // an unparseable one, and a perfectly valid intent that is somebody
    // else's must all fail to open the shortcut, because the shortcut runs
    // ahead of every guard and a false positive there reports a retirement
    // that never happened.
    const foreign = JSON.stringify({
      ...intentFixture({ transitionId: TID2, confirmationEpoch: 5 }),
      cycleNonce: "77777777-7777-4777-8777-777777777777",
    }, null, 2);
    for (const bytes of ["", "{not json", foreign]) {
      for (const f of readdirSync(sessDir)) {
        if (f.startsWith("cancellation-intent")) rmSync(join(sessDir, f), { force: true });
      }
      stageClosed({ kind: "cancellation", transitionId: TID });
      // Stage the canonical file AS the replacement (plus the nonce the real
      // rename would have carried), which is the state a crash after the
      // rename leaves, then seed a non-proving archive.
      const repl = replacement();
      writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), JSON.stringify(
        { ...repl, cycleNonce: "88888888-8888-4888-8888-888888888888" }, null, 2,
      ));
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

  it("H2: retirement refuses a doctored archive copy on the full path (nonce-not-writable)", () => {
    // The retirement spelling of the same attack: retire once so a real
    // archive exists, restore the closed canonical, then present a copy of
    // the archived bytes (nonce included) doctored into a plausible next
    // cycle. The shortcut cannot open (the extra nonce key breaks
    // modulo-nonce equality), and the full path must refuse on the nonce
    // BEFORE any other gate can be talked into it.
    stageClosed({ kind: "cancellation", transitionId: TID });
    const closedBytes = readFileSync(join(sessDir, CANCELLATION_INTENT_FILE), "utf-8");
    expect(retireClosedIntent(sessDir, replacement(), cancelled).ok).toBe(true);
    const archivedCopy = JSON.parse(readFileSync(join(sessDir, ARCHIVE), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(sessDir, CANCELLATION_INTENT_FILE), closedBytes);

    const doctored = {
      ...archivedCopy,
      phase: "authorized",
      transitionId: TID3,
      confirmationEpoch: 9,
      predecessor: {
        predecessorTransitionId: TID,
        predecessorEpoch: (JSON.parse(closedBytes) as { confirmationEpoch: number }).confirmationEpoch,
        predecessorFingerprint: (JSON.parse(closedBytes) as { confirmedFingerprint: string }).confirmedFingerprint,
      },
    };
    delete (doctored as Record<string, unknown>).outcome;
    const result = retireClosedIntent(sessDir, doctored as unknown as CancellationIntent, cancelled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nonce-not-writable");
    expect(intentOnDisk().phase).toBe("closed");
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
    // The archive carries a nonce of its own so it PARSES: an archive the
    // strict reader rejects fails the proof for that reason instead, and the
    // phase gate this test exists for would never be reached.
    writeFileSync(
      join(sessDir, `cancellation-intent.superseded.${TID2}.0.json`),
      JSON.stringify({
        ...intentFixture({ transitionId: TID2, confirmedFingerprint: "fp-0" }),
        cycleNonce: "66666666-6666-4666-8666-666666666666",
      }, null, 2),
    );

    // Handed back NONCE-STRIPPED, which is the only shape that can satisfy
    // modulo-nonce equality: a replacement still carrying the canonical's
    // nonce differs from it by that key and is refused on equality alone,
    // leaving the phase gate untested.
    const { cycleNonce: _n, ...spoof } = withPred as unknown as Record<string, unknown>;
    const result = retireClosedIntent(sessDir, spoof as unknown as CancellationIntent, cancelled);
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
        advanceCancellationIntent(sessDir, nonced({ phase: "prepared", claimTxn: txnFixture() }));
      }
      if (phase === "ticket_applied" || phase === "claim_cleared") {
        advanceCancellationIntent(sessDir, nonced({
          phase: "ticket_applied", claimTxn: { ...txnFixture(), phase: "ticket_applied" },
        }));
      }
      if (phase === "claim_cleared") {
        advanceCancellationIntent(sessDir, nonced({ phase: "claim_cleared" }));
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
