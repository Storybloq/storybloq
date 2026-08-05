import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writePreparingIntent,
  verifyPreparingIntent,
  activateIntent,
  abortIntent,
  recordDirectStop,
  repairParkedSessionRecord,
  claimAttempt,
  recordAttemptSpawn,
  settleAttempt,
  touchAttemptProgress,
  clearSupersededAttempt,
  clearInteractiveAttempt,
  failRecord,
  mutateLimitLedger,
  limitLedgerLockPath,
  markResumed,
  markInteractive,
  beginCancellation,
  completeCancellation,
  clearCancellingAttempt,
  blockCancellation,
  requeueRecord,
  upgradeResetTime,
  selectDueRecords,
  readLimitLedger,
  hasPendingLimitRecords,
  reconcileLimitLedger,
  limitLedgerPath,
  limitRecordKey,
  isLimitResumeGloballyDisabled,
  deferBackoffMs,
  listLimitStops,
  MAX_DEFER_COUNT,
  INTERACTIVE_DEADLINE_MS,
  PRUNE_TERMINAL_AFTER_MS,
  PRUNE_MANUAL_AFTER_MS,
  DEDUPE_WINDOW_MS,
  type LimitStopInput,
  type SessionLimitSnapshot,
} from "../../src/core/limit-ledger.js";
import { captureProcessSignatureSync } from "../../src/core/limit-lock.js";

const NOW = Date.parse("2026-07-05T12:00:00Z");
const RESET = NOW + 5 * 3_600_000;

// Process signatures exist only on darwin/linux; elsewhere a live claimant
// resolves to "unknown" (no signature to confirm). A recorded-but-unknown
// claimant is PRESERVED regardless of age -- the wall-clock fallback applies
// ONLY to legacy attempts with no recorded claimant (claimantPid == null).
// SIG_SUPPORTED gates only the cases that need a POSITIVE "alive" identity.
const SIG_SUPPORTED = process.platform === "darwin" || process.platform === "linux";
/** Attempt claimant fields for a CONFIRMED-DEAD claimant (abandoned by death, not age). */
function deadClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: deadPid(), claimantSignature: null };
}
/** Attempt claimant fields for a LIVE claimant (this test process). */
function liveClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: process.pid, claimantSignature: captureProcessSignatureSync(process.pid) };
}
/**
 * Attempt claimant fields whose identity resolves to "unknown" on EVERY platform
 * (a live pid with no recorded signature). A recorded-but-unknown claimant may
 * still be alive/suspended and must never be abandoned on age.
 */
function unknownClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: process.pid, claimantSignature: null };
}

function stopInput(overrides: Partial<LimitStopInput> = {}): LimitStopInput {
  return {
    clientTaskId: "sess-abc",
    storybloqSessionId: "sb-uuid-1",
    projectRoot: "/tmp/project",
    cwd: "/tmp/project",
    sessionType: "autonomous",
    limitType: "session",
    transcriptPath: "/tmp/t.jsonl",
    detectedAt: NOW,
    resetAt: RESET,
    resetSource: "absolute",
    rawBanner: "You've hit your session limit · resets 5pm (UTC)",
    mode: "headless",
    gitHead: "abc123",
    ...overrides,
  };
}

/** A pid that is certainly dead: a child that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  return r.pid!;
}

describe("limit-ledger", () => {
  let dir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sb-limit-ledger-"));
    savedEnv = process.env.STORYBLOQ_GLOBAL_DIR;
    process.env.STORYBLOQ_GLOBAL_DIR = dir;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
    else process.env.STORYBLOQ_GLOBAL_DIR = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  describe("intent protocol", () => {
    it("writes a non-dispatchable preparing intent, then activates", () => {
      const r = writePreparingIntent(stopInput());
      expect(r.deduped).toBe(false);
      expect(r.generation).toBe(1);
      expect(r.ownerToken).toBeTruthy();

      let ledger = readLimitLedger();
      const rec = ledger.records[r.key]!;
      expect(rec.status).toBe("preparing");
      expect(selectDueRecords(ledger, RESET + 1, 5)).toHaveLength(0);

      expect(verifyPreparingIntent(r.key, r.ownerToken!, r.generation)).toBe(true);
      expect(activateIntent(r.key, "wrong-token", r.generation)).toBe(false);
      expect(activateIntent(r.key, r.ownerToken!, r.generation)).toBe(true);

      ledger = readLimitLedger();
      expect(ledger.records[r.key]!.status).toBe("stopped");
      expect(ledger.records[r.key]!.preparingOwner).toBeNull();
      expect(selectDueRecords(ledger, RESET + 1, 5)).toHaveLength(1);
    });

    it("abort deletes a fresh intent, restores a prior record", () => {
      const r1 = writePreparingIntent(stopInput());
      abortIntent(r1.key, r1.ownerToken!, r1.generation);
      expect(readLimitLedger().records[r1.key]).toBeUndefined();

      // Existing stopped record, then a NEW event's intent, then abort -> restored.
      const r2 = writePreparingIntent(stopInput());
      activateIntent(r2.key, r2.ownerToken!, r2.generation);
      const r3 = writePreparingIntent(stopInput({ detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      expect(r3.generation).toBe(2);
      abortIntent(r3.key, r3.ownerToken!, r3.generation);
      const rec = readLimitLedger().records[r2.key]!;
      expect(rec.status).toBe("stopped");
      expect(rec.generation).toBe(1);
    });

    it("abort restores EVERY prior field, not just status+generation", () => {
      const r1 = writePreparingIntent(stopInput());
      activateIntent(r1.key, r1.ownerToken!, r1.generation);
      claimAttempt(r1.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r1.key, "a1", { childPid: 4242, transcriptOffset: 10, stateRevision: 3 }, NOW);
      const original = readLimitLedger().records[r1.key]!;

      // New intent with DISTINCT values for every mutable field.
      const r2 = writePreparingIntent(stopInput({
        detectedAt: NOW + DEDUPE_WINDOW_MS + 1,
        resetAt: RESET + 999_000,
        resetSource: "fallback",
        rawBanner: "different banner",
        limitType: "weekly",
        mode: "notify",
        reasonCode: "finalize_stop",
        transcriptPath: "/tmp/other.jsonl",
        cwd: "/tmp/elsewhere",
        gitHead: "fff999",
      }));
      expect(r2.generation).toBe(2);
      expect(abortIntent(r2.key, r2.ownerToken!, r2.generation)).toBe(true);

      const restored = readLimitLedger().records[r1.key]!;
      const { updatedAt: _u1, ...restoredRest } = restored;
      const { updatedAt: _u2, ...originalRest } = original;
      expect(restoredRest).toEqual(originalRest);
      // spot-check the fields the hybrid-record bug would corrupt
      expect(restored.limitEventId).toBe(original.limitEventId);
      expect(restored.resetAt).toBe(original.resetAt);
      expect(restored.mode).toBe("headless");
      expect(restored.reasonCode).toBeNull();
      expect(restored.attempt?.childPid).toBe(4242);
    });

    it("abort returns false when the intent was superseded (no ownership)", () => {
      const r1 = writePreparingIntent(stopInput());
      // A newer StopFailure supersedes the intent with generation 2.
      const r2 = writePreparingIntent(stopInput({ detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      expect(r2.generation).toBe(2);
      // The stale gen-1 owner aborts: CAS must fail and mutate nothing.
      expect(abortIntent(r1.key, r1.ownerToken!, r1.generation)).toBe(false);
      const rec = readLimitLedger().records[r1.key]!;
      expect(rec.generation).toBe(2);
      expect(rec.status).toBe("preparing");
    });
  });

  describe("dedupe + generation rules", () => {
    it("merges a duplicate report of the same stop within the window", () => {
      const r1 = recordDirectStop(stopInput());
      const r2 = recordDirectStop(stopInput({ detectedAt: NOW + 10_000 }));
      expect(r2.deduped).toBe(true);
      expect(r2.generation).toBe(1);
      expect(r2.limitEventId).toBe(r1.limitEventId);
      expect(Object.keys(readLimitLedger().records)).toHaveLength(1);
    });

    it("a duplicate with real reset evidence upgrades a fallback estimate", () => {
      recordDirectStop(stopInput({ resetSource: "fallback", rawBanner: null }));
      const r2 = recordDirectStop(stopInput({ detectedAt: NOW + 5_000, resetSource: "absolute", resetAt: RESET + 999 }));
      expect(r2.deduped).toBe(true);
      const rec = readLimitLedger().records[r2.key]!;
      expect(rec.resetSource).toBe("absolute");
      expect(rec.resetAt).toBe(RESET + 999);
      expect(rec.nextAttemptAt).toBe(RESET + 999);
    });

    it("re-limit during resuming is a NEW event: generation bumps, wakeAttempts preserved, attempt kept", () => {
      const r1 = recordDirectStop(stopInput());
      claimAttempt(r1.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r1.key, "a1", { childPid: 4242, transcriptOffset: 100, stateRevision: 7 }, NOW);

      const r2 = recordDirectStop(stopInput({ detectedAt: NOW + 5_000 })); // within window but status=resuming -> new event
      expect(r2.deduped).toBe(false);
      expect(r2.generation).toBe(2);
      expect(r2.limitEventId).not.toBe(r1.limitEventId);
      const rec = readLimitLedger().records[r2.key]!;
      expect(rec.wakeAttempts).toBe(1);
      expect(rec.attempt?.childPid).toBe(4242); // kept for the waker to terminate
      expect(rec.attempt?.generation).toBe(1); // stale generation -> CAS drops its writes
    });

    it("a new event after a terminal status starts a fresh episode: wakeAttempts reset", () => {
      const r1 = recordDirectStop(stopInput());
      claimAttempt(r1.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r1.key, "a1", { childPid: 1, transcriptOffset: 0, stateRevision: 0 }, NOW);
      settleAttempt(r1.key, "a1", { status: "resumed" }, NOW);

      const r2 = recordDirectStop(stopInput({ detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      expect(r2.generation).toBe(2);
      expect(readLimitLedger().records[r2.key]!.wakeAttempts).toBe(0);
    });
  });

  describe("repairParkedSessionRecord (activation-race)", () => {
    const SESSION_EVENT = "le-parked-session";

    it("leaves a NON-TERMINAL record that already names the session's event (owned elsewhere)", () => {
      const r = recordDirectStop(stopInput({ limitEventId: SESSION_EVENT }));
      const before = readLimitLedger().records[r.key]!;
      const installed = repairParkedSessionRecord(
        { ...stopInput(), storybloqSessionId: "sess-1", sessionType: "autonomous", mode: "headless" },
        SESSION_EVENT,
      );
      expect(installed).toBe(false); // already points here
      const after = readLimitLedger().records[r.key]!;
      expect(after.generation).toBe(before.generation); // untouched -- no wasted bump
      expect(after.limitEventId).toBe(SESSION_EVENT);
    });

    it("INSTALLS a stopped record for the session's event over a newer FOREIGN-event record, BYPASSING dedupe", () => {
      // The classic race: a newer non-terminal record names a different event and
      // is within the dedupe window. A plain recordDirectStop would MERGE onto it
      // (stale detectedAt -> negative age) and keep the foreign event, orphaning
      // the parked session. The repair must overwrite with the session's event.
      const r = recordDirectStop(stopInput({ limitEventId: "le-foreign-newer", detectedAt: NOW + 5_000 }));
      const installed = repairParkedSessionRecord(
        { ...stopInput({ detectedAt: NOW }), storybloqSessionId: "sess-1", sessionType: "autonomous", mode: "headless" },
        SESSION_EVENT,
      );
      expect(installed).toBe(true);
      const after = readLimitLedger().records[r.key]!;
      expect(after.status).toBe("stopped");
      expect(after.limitEventId).toBe(SESSION_EVENT); // NOT le-foreign-newer
      expect(after.sessionType).toBe("autonomous");
      expect(after.mode).toBe("headless");
    });

    it("INSTALLS a stopped record over a TERMINAL record for the session's event", () => {
      const r = recordDirectStop(stopInput({ limitEventId: SESSION_EVENT }));
      failRecord(r.key, r.generation, "attempts_exhausted", null, NOW); // terminal (failed) -> no longer points here
      const installed = repairParkedSessionRecord(
        { ...stopInput(), storybloqSessionId: "sess-1", sessionType: "autonomous", mode: "headless" },
        SESSION_EVENT,
      );
      expect(installed).toBe(true);
      const after = readLimitLedger().records[r.key]!;
      expect(after.status).toBe("stopped");
      expect(after.limitEventId).toBe(SESSION_EVENT);
    });

    it("INSTALLS a fresh stopped record when no record exists for the key", () => {
      const input = { ...stopInput(), storybloqSessionId: "sess-1", sessionType: "autonomous" as const, mode: "headless" as const };
      const installed = repairParkedSessionRecord(input, SESSION_EVENT);
      expect(installed).toBe(true);
      const after = readLimitLedger().records[limitRecordKey(input.clientTaskId)]!;
      expect(after.status).toBe("stopped");
      expect(after.limitEventId).toBe(SESSION_EVENT);
    });
  });

  describe("attempt lifecycle", () => {
    it("claim -> spawn -> settle, with CAS protection", () => {
      const r = recordDirectStop(stopInput());
      expect(claimAttempt(r.key, { id: "a1", token: "t1", generation: 99 }, NOW)).toBe(false); // wrong generation
      expect(claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW)).toBe(true);
      expect(claimAttempt(r.key, { id: "a2", token: "t2", generation: 1 }, NOW)).toBe(false); // not dispatchable anymore

      expect(recordAttemptSpawn(r.key, "wrong-id", { childPid: 1, transcriptOffset: 0, stateRevision: 0 }, NOW)).toBe(false);
      expect(recordAttemptSpawn(r.key, "a1", { childPid: 4242, transcriptOffset: 10, stateRevision: 3 }, NOW)).toBe(true);
      expect(readLimitLedger().records[r.key]!.wakeAttempts).toBe(1);

      expect(settleAttempt(r.key, "wrong-id", { status: "resumed" }, NOW)).toBeNull();
      expect(settleAttempt(r.key, "a1", { status: "resumed" }, NOW)).toEqual({
        status: "resumed", reasonCode: null, deferCount: 0, preSpawnDeferCount: 0,
      });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("resumed");
      expect(rec.attempt).toBeNull();
    });

    it("a stale verifier for a superseded generation writes nothing", () => {
      const r1 = recordDirectStop(stopInput());
      claimAttempt(r1.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r1.key, "a1", { childPid: 1, transcriptOffset: 0, stateRevision: 0 }, NOW);
      // Re-limit: new generation while a1 is still registered.
      recordDirectStop(stopInput({ detectedAt: NOW + 5_000 }));
      expect(settleAttempt(r1.key, "a1", { status: "resumed" }, NOW)).toBeNull();
      expect(readLimitLedger().records[r1.key]!.status).toBe("stopped");
    });

    it("deferral applies the backoff ladder", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      settleAttempt(r.key, "a1", { status: "deferred" }, NOW);
      let rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("deferred");
      expect(rec.deferCount).toBe(1);
      expect(rec.nextAttemptAt).toBe(NOW + deferBackoffMs(1));

      claimAttempt(r.key, { id: "a2", token: "t2", generation: 1 }, NOW);
      settleAttempt(r.key, "a2", { status: "deferred" }, NOW);
      rec = readLimitLedger().records[r.key]!;
      expect(rec.nextAttemptAt).toBe(NOW + deferBackoffMs(2));
      expect(deferBackoffMs(99)).toBe(30 * 60_000); // capped
    });
  });

  // ISS-944: the pre-spawn defer cap. Test numbers below trace the ratified
  // plan (.story/sessions/b0366559-4d5d-452d-9881-2c89f684ef3d/
  // plan-iss944-revised.md) so the mapping from spec to test is explicit.
  describe("ISS-944: pre-spawn defer cap (preSpawnDeferCount)", () => {
    /** Claim + settle "deferred" with preSpawnDefer: true, once, returning the SettleResult. */
    function preSpawnDefer(key: string, attemptId: string, now = NOW): ReturnType<typeof settleAttempt> {
      claimAttempt(key, { id: attemptId, token: attemptId, generation: 1 }, now);
      return settleAttempt(key, attemptId, { status: "deferred", preSpawnDefer: true }, now);
    }

    it("test 1: reaches defer_exhausted on the (MAX_DEFER_COUNT+1)th pre-spawn defer, wakeAttempts untouched, deferCount driven by the ordinary ladder and frozen only on the cap-firing call", () => {
      const r = recordDirectStop(stopInput());
      let last: ReturnType<typeof settleAttempt> = null;
      for (let i = 1; i <= MAX_DEFER_COUNT; i++) {
        last = preSpawnDefer(r.key, `a${i}`);
        expect(last?.status).toBe("deferred");
        expect(last?.preSpawnDeferCount).toBe(i);
        expect(last?.deferCount).toBe(i); // ordinary backoff increment, every non-capped call
      }
      // (MAX_DEFER_COUNT+1)th call: cap fires.
      last = preSpawnDefer(r.key, `a${MAX_DEFER_COUNT + 1}`);
      expect(last?.status).toBe("failed");
      expect(last?.reasonCode).toBe("defer_exhausted");
      expect(last?.preSpawnDeferCount).toBe(MAX_DEFER_COUNT); // not incremented further
      expect(last?.deferCount).toBe(MAX_DEFER_COUNT); // NOT incremented on the cap-firing call
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.wakeAttempts).toBe(0); // never counted a real spawn -- criterion 6
      expect(rec.status).toBe("failed");
    });

    it("test 2b: a real spawn resets preSpawnDeferCount but leaves deferCount (backoff-driven) untouched", () => {
      const r = recordDirectStop(stopInput());
      for (let i = 1; i <= MAX_DEFER_COUNT - 1; i++) preSpawnDefer(r.key, `a${i}`);
      let rec = readLimitLedger().records[r.key]!;
      expect(rec.preSpawnDeferCount).toBe(MAX_DEFER_COUNT - 1);
      expect(rec.deferCount).toBe(MAX_DEFER_COUNT - 1);
      expect(rec.wakeAttempts).toBe(0);

      claimAttempt(r.key, { id: "spawn1", token: "t", generation: 1 }, NOW);
      expect(recordAttemptSpawn(r.key, "spawn1", { childPid: 4242, transcriptOffset: 0, stateRevision: 0 }, NOW)).toBe(true);
      rec = readLimitLedger().records[r.key]!;
      expect(rec.preSpawnDeferCount).toBe(0); // reset by the real spawn
      expect(rec.deferCount).toBe(MAX_DEFER_COUNT - 1); // UNCHANGED -- spawn never touches the backoff counter
      expect(rec.wakeAttempts).toBe(1);
    });

    it("test 3a: a stale attempt generation is rejected by the CAS even when preSpawnDeferCount is already cap-eligible (nothing written)", () => {
      const r = recordDirectStop(stopInput());
      for (let i = 1; i <= MAX_DEFER_COUNT; i++) preSpawnDefer(r.key, `a${i}`);
      claimAttempt(r.key, { id: "aFinal", token: "t", generation: 1 }, NOW);
      const before = readLimitLedger().records[r.key]!;
      expect(before.preSpawnDeferCount).toBe(MAX_DEFER_COUNT);
      expect(before.status).toBe("resuming");

      // Isolate the GENERATION guard specifically (not a real re-limit, which
      // legitimately resets preSpawnDeferCount itself -- see upsertStop): the
      // record's generation moves on while this attempt still carries the old one.
      mutateLimitLedger((ledger) => {
        ledger.records[r.key]!.generation = 2;
        return true;
      });

      const result = settleAttempt(r.key, "aFinal", { status: "deferred", preSpawnDefer: true }, NOW);
      expect(result).toBeNull();
      const after = readLimitLedger().records[r.key]!;
      expect(after.preSpawnDeferCount).toBe(MAX_DEFER_COUNT); // unchanged -- CAS refused the write
      expect(after.status).toBe("resuming"); // unchanged
    });

    it("test 3b: a second settle against an already-terminalized defer_exhausted record is refused by the status guard (idempotent)", () => {
      const r = recordDirectStop(stopInput());
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(r.key, `a${i}`);
      const terminal = readLimitLedger().records[r.key]!;
      expect(terminal.status).toBe("failed");
      expect(terminal.reasonCode).toBe("defer_exhausted");

      // status is "failed", not "resuming" -- there is no live attempt to re-settle,
      // so this exercises the same status guard as any post-terminal settle attempt.
      const result = settleAttempt(r.key, `a${MAX_DEFER_COUNT + 1}`, { status: "deferred", preSpawnDefer: true }, NOW);
      expect(result).toBeNull();
      expect(readLimitLedger().records[r.key]!).toEqual(terminal);
    });

    it("test 3c: the preSpawnDefer CONTRACT gates the cap, not the counter's bare value -- a post-spawn-shaped settle (no preSpawnDefer) never terminalizes even at a cap-eligible count", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      // Directly construct the cap-eligible-but-not-flagged scenario (migration,
      // manual repair, or a future call path reaching a cap-eligible count at a
      // post-spawn site) rather than reaching it through preSpawnDefer calls.
      mutateLimitLedger((ledger) => {
        ledger.records[r.key]!.preSpawnDeferCount = MAX_DEFER_COUNT;
        return true;
      });
      const before = readLimitLedger().records[r.key]!.deferCount;

      // superviseAttempt's wrapper shape: no preSpawnDefer at all.
      const result = settleAttempt(r.key, "a1", { status: "deferred" }, NOW);

      expect(result?.status).toBe("deferred"); // NOT "failed"
      expect(result?.reasonCode).toBeNull(); // NOT "defer_exhausted"
      expect(result?.deferCount).toBe(before + 1); // ordinary backoff increment
      expect(result?.preSpawnDeferCount).toBe(MAX_DEFER_COUNT); // unchanged -- never incremented without the flag
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("deferred");
      expect(rec.attempt).toBeNull();
    });

    it("test 4: requeueRecord on a defer_exhausted record resets preSpawnDeferCount (and deferCount) and makes it dispatchable again", () => {
      const r = recordDirectStop(stopInput());
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(r.key, `a${i}`);
      expect(readLimitLedger().records[r.key]!.reasonCode).toBe("defer_exhausted");

      expect(requeueRecord(r.key, NOW + 1000)).toBe(true);
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("stopped");
      expect(rec.preSpawnDeferCount).toBe(0);
      expect(rec.deferCount).toBe(0);
      expect(rec.wakeAttempts).toBe(0);
      expect(rec.reasonCode).toBeNull();
      expect(selectDueRecords(readLimitLedger(), NOW + 1000, 5).map((x) => x.key)).toContain(r.key);
    });

    it("test 4b (+ pen ratification condition 1): the cap-firing terminalize mutation carries the FULL persisted shape, including lastError from the spawn-failure diagnostic", () => {
      const r = recordDirectStop(stopInput());
      for (let i = 1; i <= MAX_DEFER_COUNT; i++) preSpawnDefer(r.key, `a${i}`);
      const preTerminal = readLimitLedger().records[r.key]!;

      claimAttempt(r.key, { id: "aFinal", token: "t", generation: 1 }, NOW);
      const result = settleAttempt(
        r.key,
        "aFinal",
        { status: "deferred", preSpawnDefer: true, lastError: "spawn failed: ENOENT claude" },
        NOW,
      );
      expect(result?.status).toBe("failed");
      expect(result?.reasonCode).toBe("defer_exhausted");

      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("failed");
      expect(rec.reasonCode).toBe("defer_exhausted");
      expect(rec.attempt).toBeNull();
      expect(rec.wakeAttempts).toBe(0);
      expect(rec.deferCount).toBe(preTerminal.deferCount); // unchanged -- not incremented on the cap-firing call
      expect(rec.preSpawnDeferCount).toBe(MAX_DEFER_COUNT);
      expect(rec.nextAttemptAt).toBe(preTerminal.nextAttemptAt); // AS-IS, matching failRecord
      expect(rec.lastError).toBe("spawn failed: ENOENT claude"); // NOT discarded by the cap branch
    });

    it("test 7: defer_exhausted round-trips through a LimitStopSummary read directly", () => {
      const r = recordDirectStop(stopInput());
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(r.key, `a${i}`);
      const summary = listLimitStops({ includeTerminal: true }).find((s) => s.key === r.key);
      expect(summary).toBeDefined();
      expect(summary!.status).toBe("failed");
      expect(summary!.reasonCode).toBe("defer_exhausted");
      expect(summary!.wakeAttempts).toBe(0);
    });

    it("test 8a: listLimitStops() excludes a defer_exhausted record by default; includeTerminal:true includes it with reasonCode intact", () => {
      const r = recordDirectStop(stopInput());
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(r.key, `a${i}`);

      expect(listLimitStops().find((s) => s.key === r.key)).toBeUndefined();
      const withTerminal = listLimitStops({ includeTerminal: true }).find((s) => s.key === r.key);
      expect(withTerminal).toBeDefined();
      expect(withTerminal!.reasonCode).toBe("defer_exhausted");
    });

    it("test 8b: includeTerminal orders active-by-nextAttemptAt-asc FIRST, then terminal-by-updatedAt-desc -- never a mixed comparator", () => {
      // Active records: b's nextAttemptAt is earlier than a's.
      const a = recordDirectStop(stopInput({ clientTaskId: "ord-a", resetAt: RESET + 120_000 }));
      const b = recordDirectStop(stopInput({ clientTaskId: "ord-b", resetAt: RESET + 60_000 }));
      // Terminal records: constructed so naive nextAttemptAt sorting would put
      // them BEFORE the active ones (small nextAttemptAt) and so a naive
      // updatedAt sort within "all records" would misorder them relative to
      // the active group -- only a partition-then-concatenate is correct.
      const c = recordDirectStop(stopInput({ clientTaskId: "ord-c" }));
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(c.key, `c${i}`, NOW + 1_000);
      const d = recordDirectStop(stopInput({ clientTaskId: "ord-d" }));
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(d.key, `d${i}`, NOW + 5_000);
      // c terminalized at NOW+1000 (earlier), d at NOW+5000 (later) -- updatedAt desc means d before c.
      mutateLimitLedger((ledger) => {
        ledger.records[b.key]!.nextAttemptAt = RESET + 60_000;
        ledger.records[a.key]!.nextAttemptAt = RESET + 120_000;
        return true;
      });

      const keys = listLimitStops({ includeTerminal: true }).map((s) => s.key);
      const activeKeys = keys.slice(0, 2);
      const terminalKeys = keys.slice(2);
      expect(activeKeys).toEqual([b.key, a.key]); // active group, nextAttemptAt ascending
      expect(terminalKeys).toEqual([d.key, c.key]); // terminal group, updatedAt descending
    });

    it("test 8b tie-break: equal nextAttemptAt (active) and equal updatedAt (terminal) fall back to key-ascending, not insertion order", () => {
      // Active records with an IDENTICAL nextAttemptAt: without the key
      // tie-breaker, `.sort` order would depend on object property insertion
      // order rather than being deterministic.
      const activeY = recordDirectStop(stopInput({ clientTaskId: "tie-y", resetAt: RESET + 90_000 }));
      const activeX = recordDirectStop(stopInput({ clientTaskId: "tie-x", resetAt: RESET + 90_000 }));
      // Terminal records terminalized at the SAME instant.
      const termY = recordDirectStop(stopInput({ clientTaskId: "tie-term-y" }));
      const termX = recordDirectStop(stopInput({ clientTaskId: "tie-term-x" }));
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(termY.key, `ty${i}`, NOW + 9_000);
      for (let i = 1; i <= MAX_DEFER_COUNT + 1; i++) preSpawnDefer(termX.key, `tx${i}`, NOW + 9_000);

      const keys = listLimitStops({ includeTerminal: true }).map((s) => s.key);
      const activeKeys = keys.slice(0, 2);
      const terminalKeys = keys.slice(2);
      expect(activeKeys).toEqual([activeX.key, activeY.key]); // "claude:tie-x" < "claude:tie-y"
      expect(terminalKeys).toEqual([termX.key, termY.key]); // "claude:tie-term-x" < "claude:tie-term-y"
    });

    it("test 9 (+ pen ratification condition 1 precision): a legacy record missing preSpawnDeferCount entirely defaults to 0 and can complete a preSpawnDefer:true settle normally", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "legacy1", token: "t", generation: 1 }, NOW);
      // Simulate the real shape of every record written before this issue: the
      // field is entirely absent from the persisted JSON, not merely 0.
      mutateLimitLedger((ledger) => {
        const rec = ledger.records[r.key] as Record<string, unknown>;
        delete rec.preSpawnDeferCount;
        return true;
      });
      const loaded = readLimitLedger().records[r.key]!;
      expect(loaded.preSpawnDeferCount).toBe(0); // schema default applied, not undefined

      const result = settleAttempt(r.key, "legacy1", { status: "deferred", preSpawnDefer: true }, NOW);
      expect(result).not.toBeNull();
      expect(result?.preSpawnDeferCount).toBe(1);
      expect(readLimitLedger().records[r.key]!.preSpawnDeferCount).toBe(1);
    });
  });

  describe("due scan", () => {
    it("includes stopped and deferred, excludes exhausted and undue", () => {
      const a = recordDirectStop(stopInput({ clientTaskId: "s1" }));
      const b = recordDirectStop(stopInput({ clientTaskId: "s2", resetAt: RESET + 60_000 }));
      recordDirectStop(stopInput({ clientTaskId: "s3", resetAt: RESET + 10 * 3_600_000 })); // not due
      claimAttempt(b.key, { id: "a1", token: "t", generation: 1 }, NOW);
      recordAttemptSpawn(b.key, "a1", { childPid: 1, transcriptOffset: 0, stateRevision: 0 }, NOW);
      settleAttempt(b.key, "a1", { status: "deferred", nextAttemptAt: RESET + 30_000 }, NOW);

      const due = selectDueRecords(readLimitLedger(), RESET + 60_000, 5);
      expect(due.map((r) => r.clientTaskId)).toEqual(["s1", "s2"]); // sorted by nextAttemptAt
      expect(selectDueRecords(readLimitLedger(), RESET + 60_000, 1).map((r) => r.clientTaskId)).toEqual(["s1"]); // b at cap
    });
  });

  describe("status transitions", () => {
    it("markResumed only from non-terminal states, generation-CAS'd", () => {
      const r = recordDirectStop(stopInput());
      // Stale evidence from an earlier episode never terminalizes this one.
      expect(markResumed(r.key, r.generation - 1, NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.status).toBe("stopped");
      expect(markResumed(r.key, r.generation, NOW)).toBe(true);
      expect(markResumed(r.key, r.generation, NOW)).toBe(false); // already terminal
    });

    it("markResumed rejects generation-1 evidence after a re-limit minted generation 2", () => {
      const r1 = recordDirectStop(stopInput());
      claimAttempt(r1.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      const r2 = recordDirectStop(stopInput({ detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      expect(r2.generation).toBe(2);
      expect(markResumed(r1.key, 1, NOW)).toBe(false); // delayed Stop-hook evidence for gen 1
      expect(readLimitLedger().records[r1.key]!.status).toBe("stopped");
      // The re-limit PRESERVED the gen-1 attempt (it names the old child the
      // waker must still terminate). markResumed must not terminalize while
      // that possibly-live child's evidence stands -- doing so would orphan it.
      expect(markResumed(r1.key, 2, NOW)).toBe(false);
      expect(readLimitLedger().records[r1.key]!.attempt?.id).toBe("a1");
      // Once the waker's supersede pass confirms the old child dead and clears
      // the attempt, gen-2 evidence terminalizes cleanly.
      expect(clearSupersededAttempt(r1.key, "a1", NOW)).toBe(true);
      expect(markResumed(r1.key, 2, NOW)).toBe(true);
    });

    it("markResumed refuses a preparing intent (never destroys detection's activation)", () => {
      const intent = writePreparingIntent(stopInput({ clientTaskId: "s-prep" }));
      expect(readLimitLedger().records[intent.key]!.status).toBe("preparing");
      // A concurrent Stop hook must NOT resolve a mid-transaction intent.
      expect(markResumed(intent.key, intent.generation, NOW)).toBe(false);
      const rec = readLimitLedger().records[intent.key]!;
      expect(rec.status).toBe("preparing");
      expect(rec.preparingOwner).not.toBeNull();
    });

    it("markResumed refuses cancelling and blocked-cancellation records (attempt evidence preserved)", () => {
      // cancelling
      const c = recordDirectStop(stopInput({ clientTaskId: "s-cancelling" }));
      claimAttempt(c.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(c.key, "a1", { childPid: 501, transcriptOffset: 0, stateRevision: 0 }, NOW);
      beginCancellation(c.key, NOW);
      expect(markResumed(c.key, c.generation, NOW)).toBe(false);
      expect(readLimitLedger().records[c.key]!.status).toBe("cancelling");
      expect(readLimitLedger().records[c.key]!.attempt?.childPid).toBe(501);

      // manual + cancellation_blocked (attempt names a possibly-live child)
      const b = recordDirectStop(stopInput({ clientTaskId: "s-blocked" }));
      claimAttempt(b.key, { id: "b1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(b.key, "b1", { childPid: 502, transcriptOffset: 0, stateRevision: 0 }, NOW);
      beginCancellation(b.key, NOW);
      blockCancellation(b.key, NOW);
      expect(markResumed(b.key, b.generation, NOW)).toBe(false);
      const rec = readLimitLedger().records[b.key]!;
      expect(rec.status).toBe("manual");
      expect(rec.reasonCode).toBe("cancellation_blocked");
      expect(rec.attempt?.childPid).toBe(502);
    });

    it("markInteractive returns the active attempt + prior status and gates manual records", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 777, transcriptOffset: 0, stateRevision: 0 }, NOW);
      const out = markInteractive(r.key, NOW);
      expect(out?.attempt?.childPid).toBe(777);
      expect(out?.priorStatus).toBe("resuming");
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("interactive");
      expect(rec.interactiveDeadlineAt).toBe(NOW + INTERACTIVE_DEADLINE_MS);
      // interactive is not requeueable
      expect(requeueRecord(r.key, NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.status).toBe("interactive");

      // an ACTUAL manual record is never converted to interactive
      const r2 = recordDirectStop(stopInput({ clientTaskId: "s-manual" }));
      claimAttempt(r2.key, { id: "a2", token: "t2", generation: 1 }, NOW);
      settleAttempt(r2.key, "a2", { status: "manual", reasonCode: "bypass_not_opted_in" }, NOW);
      expect(markInteractive(r2.key, NOW)).toBeNull();
      const rec2 = readLimitLedger().records[r2.key]!;
      expect(rec2.status).toBe("manual");
      expect(rec2.reasonCode).toBe("bypass_not_opted_in");
      expect(rec2.interactiveDeadlineAt).toBeNull();
    });

    it("markResumed refuses an interactive record whose displaced child is not confirmed dead", () => {
      // An interactive takeover preserves the attempt as evidence of the wake
      // child it async-SIGTERM'd without confirming exit. markResumed must not
      // terminalize (-> resumed) over that possibly-live child.
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 777, transcriptOffset: 0, stateRevision: 0 }, NOW);
      markInteractive(r.key, NOW);
      expect(readLimitLedger().records[r.key]!.attempt?.childPid).toBe(777);

      expect(markResumed(r.key, r.generation, NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.status).toBe("interactive");

      // clearInteractiveAttempt is the ONLY authorized phase-2 clear here, and
      // only from `interactive` with an exact attemptId match.
      expect(clearInteractiveAttempt(r.key, "wrong", NOW)).toBe(false);
      expect(clearInteractiveAttempt(r.key, "a1", NOW)).toBe(true);
      expect(readLimitLedger().records[r.key]!.attempt).toBeNull();

      // Attempt cleared (child confirmed dead): un-attributed Stop evidence may
      // now terminalize the interactive record.
      expect(markResumed(r.key, r.generation, NOW)).toBe(true);
      expect(readLimitLedger().records[r.key]!.status).toBe("resumed");
    });

    it("clearInteractiveAttempt refuses to clear a non-interactive record's attempt", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 777, transcriptOffset: 0, stateRevision: 0 }, NOW);
      // Still `resuming` -- never let a mislabeled clear discard a live child.
      expect(clearInteractiveAttempt(r.key, "a1", NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.attempt?.childPid).toBe(777);
    });

    it("reconcile keeps an interactive record non-terminal while its displaced child lingers", () => {
      // Even when the session ADVANCED out of COMPACT, reconcile must hold the
      // record interactive until supervision confirms the displaced child dead
      // and clears the attempt -- terminalizing would orphan it.
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 777, transcriptOffset: 0, stateRevision: 5 }, NOW);
      markInteractive(r.key, NOW);

      // Session advanced (left COMPACT) -- absent the attempt, interactive -> resumed.
      const advanced: SessionLimitSnapshot = {
        state: "IMPLEMENT",
        compactPending: false,
        interruptionKind: null,
        limitEventId: null,
      };
      reconcileLimitLedger({ now: NOW + 1000, readSession: () => advanced });
      let rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("interactive"); // held: attempt still names a possibly-live child
      expect(rec.attempt?.id).toBe("a1");

      // Supervision confirms death + clears; the next reconcile terminalizes.
      clearInteractiveAttempt(r.key, "a1", NOW + 1000);
      reconcileLimitLedger({ now: NOW + 2000, readSession: () => advanced });
      rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("resumed");
      expect(rec.attempt).toBeNull();
    });

    it("two-phase cancellation", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 555, transcriptOffset: 0, stateRevision: 0 }, NOW);

      const begun = beginCancellation(r.key, NOW);
      // The returned snapshot is POST-CAS: callers key session clears off it.
      expect(begun?.record.attempt?.childPid).toBe(555);
      expect(begun?.record.status).toBe("cancelling");
      expect(begun?.record.limitEventId).toBe(readLimitLedger().records[r.key]!.limitEventId);
      expect(readLimitLedger().records[r.key]!.status).toBe("cancelling");
      // non-dispatchable while cancelling
      expect(claimAttempt(r.key, { id: "a2", token: "t2", generation: 1 }, NOW)).toBe(false);

      // Phase 2 is gated on CONFIRMED child death. While the attempt (a
      // possibly-live child) still stands, completeCancellation REFUSES --
      // terminalizing here would drop the child's evidence.
      expect(completeCancellation(r.key, NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.status).toBe("cancelling");
      expect(readLimitLedger().records[r.key]!.attempt?.childPid).toBe(555);
      // A stale/foreign attempt id never clears the live attempt.
      expect(clearCancellingAttempt(r.key, "wrong-id", NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.attempt?.childPid).toBe(555);

      // Only after the caller confirms death and clears the attempt through
      // the cancel-flow path may the stand-down terminalize.
      expect(clearCancellingAttempt(r.key, "a1", NOW)).toBe(true);
      expect(readLimitLedger().records[r.key]!.attempt).toBeNull();
      expect(completeCancellation(r.key, NOW)).toBe(true);
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("cancelled");
      expect(rec.reasonCode).toBe("user_cancel");
    });

    it("clearCancellingAttempt is scoped to the cancel flow (never discards a dispatchable attempt)", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 999, transcriptOffset: 0, stateRevision: 0 }, NOW);
      // A live, dispatchable resuming attempt: its child death is NOT confirmed,
      // and it is NOT in the cancel flow. The confirmed-death clear must refuse
      // -- otherwise the two-phase precondition could be bypassed to drop a
      // possibly-live child's evidence outside cancellation.
      expect(readLimitLedger().records[r.key]!.status).toBe("resuming");
      expect(clearCancellingAttempt(r.key, "a1", NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.attempt?.childPid).toBe(999);
    });

    it("settleAttempt never fires from a non-resuming status (interactive takeover is preserved)", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 777, transcriptOffset: 0, stateRevision: 0 }, NOW);
      markInteractive(r.key, NOW);
      // A waker that lost the wake-claim race tries to requeue its attempt.
      expect(settleAttempt(r.key, "a1", { status: "stopped" }, NOW)).toBeNull();
      expect(readLimitLedger().records[r.key]!.status).toBe("interactive");
    });

    it("touchAttemptProgress refuses non-resuming records and superseded generations", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 555, transcriptOffset: 0, stateRevision: 0 }, NOW);
      expect(touchAttemptProgress(r.key, "a1", NOW + 1)).toBe(true);

      // interactive takeover: attempt still present, but progress writes stop
      markInteractive(r.key, NOW + 2);
      expect(touchAttemptProgress(r.key, "a1", NOW + 3)).toBe(false);

      // re-limit mints generation 2 while the old attempt lingers: stale verifier writes nothing
      const r2 = recordDirectStop(stopInput({ clientTaskId: "s-gen", detectedAt: NOW }));
      claimAttempt(r2.key, { id: "b1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r2.key, "b1", { childPid: 556, transcriptOffset: 0, stateRevision: 0 }, NOW);
      recordDirectStop(stopInput({ clientTaskId: "s-gen", detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      // new generation keeps the record dispatchable ("stopped"), old attempt kept for termination
      expect(touchAttemptProgress(r2.key, "b1", NOW + DEDUPE_WINDOW_MS + 2)).toBe(false);
    });

    it("blocked cancellation stands down but preserves the attempt evidence", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 555, transcriptOffset: 0, stateRevision: 0 }, NOW);
      beginCancellation(r.key, NOW);
      expect(blockCancellation(r.key, NOW)).toBe(true);
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("manual");
      expect(rec.reasonCode).toBe("cancellation_blocked");
      expect(rec.attempt?.childPid).toBe(555);

      // Requeue is REFUSED while the possibly-live child's evidence stands:
      // making the record dispatchable would let claimAttempt overwrite the
      // attempt and spawn a second child beside the unkillable one.
      expect(requeueRecord(r.key, NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.attempt?.childPid).toBe(555);

      // Even from the blocked state, completeCancellation refuses while the
      // attempt stands -- the manual/cancellation_blocked record still names a
      // child whose death is unconfirmed.
      expect(completeCancellation(r.key, NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.status).toBe("manual");

      // Once the child is finally confirmed dead, the cancel-flow attempt clear
      // (valid on a cancellation_blocked record) drops the evidence and
      // completeCancellation finishes the user's original cancel.
      expect(clearCancellingAttempt(r.key, "a1", NOW)).toBe(true);
      expect(completeCancellation(r.key, NOW)).toBe(true);
      const done = readLimitLedger().records[r.key]!;
      expect(done.status).toBe("cancelled");
      expect(done.attempt).toBeNull();
    });

    it("requeue returns manual/failed records to the queue as a fresh episode", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 1, transcriptOffset: 0, stateRevision: 0 }, NOW);
      settleAttempt(r.key, "a1", { status: "failed", reasonCode: "attempts_exhausted" }, NOW);

      expect(requeueRecord(r.key, NOW + 1000)).toBe(true);
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("stopped");
      expect(rec.wakeAttempts).toBe(0);
      expect(rec.nextAttemptAt).toBe(NOW + 1000);
      expect(rec.reasonCode).toBeNull();
    });

    it("upgradeResetTime is generation-CAS'd and only upgrades fallbacks", () => {
      const r = recordDirectStop(stopInput({ resetSource: "fallback" }));
      expect(upgradeResetTime(r.key, 99, { resetAt: RESET, resetSource: "absolute", rawBanner: "b" }, NOW)).toBe(false);
      expect(upgradeResetTime(r.key, 1, { resetAt: RESET + 5, resetSource: "absolute", rawBanner: "b" }, NOW)).toBe(true);
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.resetAt).toBe(RESET + 5);
      expect(rec.resetSource).toBe("absolute");
      // second upgrade refused: no longer a fallback
      expect(upgradeResetTime(r.key, 1, { resetAt: RESET + 9, resetSource: "relative", rawBanner: "c" }, NOW)).toBe(false);
    });

    it("claimAttempt refuses a dispatchable record that still carries a lingering attempt", () => {
      // Re-limit mints generation 2 while generation 1's child is not yet
      // confirmed dead: the record is dispatchable ("stopped") but its old
      // attempt lingers. A generation-2 claim must be REFUSED (claiming would
      // overwrite the old pid and spawn a second child beside the first).
      const r1 = recordDirectStop(stopInput({ clientTaskId: "s-relimit" }));
      claimAttempt(r1.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r1.key, "a1", { childPid: 999, transcriptOffset: 0, stateRevision: 0 }, NOW);
      recordDirectStop(stopInput({ clientTaskId: "s-relimit", detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      const relimited = readLimitLedger().records[r1.key]!;
      expect(relimited.generation).toBe(2);
      expect(relimited.status).toBe("stopped");
      expect(relimited.attempt?.childPid).toBe(999); // lingering gen-1 evidence

      // The gen-2 claim is refused, and the lingering attempt is NOT overwritten.
      expect(claimAttempt(r1.key, { id: "a2", token: "t2", generation: 2 }, NOW + 1)).toBe(false);
      const after = readLimitLedger().records[r1.key]!;
      expect(after.status).toBe("stopped");
      expect(after.attempt?.id).toBe("a1");
      expect(after.attempt?.childPid).toBe(999);

      // Once the superseded attempt is cleared (child confirmed dead), a fresh
      // gen-2 claim succeeds.
      expect(clearSupersededAttempt(r1.key, "a1", NOW + 2)).toBe(true);
      expect(readLimitLedger().records[r1.key]!.attempt).toBeNull();
      expect(claimAttempt(r1.key, { id: "a2", token: "t2", generation: 2 }, NOW + 3)).toBe(true);
    });

    it("selectDueRecords skips a dispatchable record that still carries an attempt", () => {
      const r = recordDirectStop(stopInput({ clientTaskId: "s-due" }));
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 888, transcriptOffset: 0, stateRevision: 0 }, NOW);
      recordDirectStop(stopInput({ clientTaskId: "s-due", detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("stopped");
      expect(rec.attempt).not.toBeNull();
      // Due by time, dispatchable by status, but the lingering attempt excludes it.
      const due = selectDueRecords(readLimitLedger(), rec.nextAttemptAt + 1, Number.MAX_SAFE_INTEGER);
      expect(due.find((d) => d.key === r.key)).toBeUndefined();
    });

    it("failRecord refuses to terminalize a record that still tracks a child", () => {
      const r = recordDirectStop(stopInput({ clientTaskId: "s-fail" }));
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 777, transcriptOffset: 0, stateRevision: 0 }, NOW);
      recordDirectStop(stopInput({ clientTaskId: "s-fail", detectedAt: NOW + DEDUPE_WINDOW_MS + 1 }));
      // gen 2, dispatchable, lingering gen-1 attempt.
      expect(failRecord(r.key, 2, "attempts_exhausted", null, NOW)).toBe(false);
      expect(readLimitLedger().records[r.key]!.status).toBe("stopped");
      // After the attempt clears, failRecord succeeds.
      clearSupersededAttempt(r.key, "a1", NOW);
      expect(failRecord(r.key, 2, "attempts_exhausted", null, NOW)).toBe(true);
      expect(readLimitLedger().records[r.key]!.status).toBe("failed");
    });
  });

  describe("durability", () => {
    it("quarantines a corrupt ledger file and starts empty", () => {
      writeFileSync(limitLedgerPath(), "{{{not json");
      const r = recordDirectStop(stopInput());
      expect(readLimitLedger().records[r.key]).toBeTruthy();
      const quarantined = readdirSync(dir).filter((f) => f.includes(".corrupt."));
      expect(quarantined).toHaveLength(1);
    });

    it("preserves unknown/invalid records verbatim across writes", () => {
      const alien = { key: "alien", status: "from-the-future", whatever: 1 };
      writeFileSync(limitLedgerPath(), JSON.stringify({ schemaVersion: 1, records: { alien } }));
      recordDirectStop(stopInput());
      const onDisk = JSON.parse(readFileSync(limitLedgerPath(), "utf-8"));
      expect(onDisk.records.alien).toEqual(alien);
      expect(readLimitLedger().records.alien).toBeUndefined(); // excluded from logic
    });

    it("hasPendingLimitRecords distinguishes live queues from settled ones", () => {
      expect(hasPendingLimitRecords()).toBe(false);
      const r = recordDirectStop(stopInput());
      expect(hasPendingLimitRecords()).toBe(true);
      markResumed(r.key, r.generation, NOW);
      expect(hasPendingLimitRecords()).toBe(false);
    });

    it("lockless reads never quarantine (single-writer contract)", () => {
      writeFileSync(limitLedgerPath(), "{{{not json");
      // Lockless probe: empty answer, file untouched.
      expect(hasPendingLimitRecords()).toBe(false);
      expect(readdirSync(dir).filter((f) => f.includes(".corrupt."))).toHaveLength(0);
      expect(readFileSync(limitLedgerPath(), "utf-8")).toBe("{{{not json");
      // The next LOCKED access quarantines it.
      recordDirectStop(stopInput());
      expect(readdirSync(dir).filter((f) => f.includes(".corrupt."))).toHaveLength(1);
    });

    it("fence: a mutation whose lock is stolen mid-RMW is discarded and retried", () => {
      const r = recordDirectStop(stopInput());
      let calls = 0;
      const result = mutateLimitLedger((ledger) => {
        calls += 1;
        if (calls === 1) {
          // Simulate a stalled holder losing its lease: another process steals
          // the lock (unlink + relink with a dead holder's body) while this
          // mutation is in flight. The fence check runs AFTER the temp write,
          // immediately before rename, so this write MUST be discarded.
          rmSync(limitLedgerLockPath());
          writeFileSync(limitLedgerLockPath(), JSON.stringify({
            pid: deadPid(), token: "thief", acquiredAt: NOW, renewedAt: NOW, processSignature: null,
          }));
          ledger.records[r.key]!.lastError = "poisoned-first-attempt";
        } else {
          ledger.records[r.key]!.lastError = "second-attempt";
        }
        return calls;
      });
      // Retried: the callback ran again on a fresh read and committed cleanly.
      expect(result).toBe(2);
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.lastError).toBe("second-attempt");
      // No stray temp files left behind by the discarded write.
      expect(readdirSync(dir).filter((f) => f.includes("limit-ledger.json.tmp"))).toHaveLength(0);
    });

    it("global kill switch reads ~/.claude/storybloq/config.json", () => {
      expect(isLimitResumeGloballyDisabled()).toBe(false);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ limitResume: { enabled: false } }));
      expect(isLimitResumeGloballyDisabled()).toBe(true);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ limitResume: { enabled: true } }));
      expect(isLimitResumeGloballyDisabled()).toBe(false);
    });
  });

  describe("reconciliation", () => {
    const pendingSnap: SessionLimitSnapshot = {
      state: "COMPACT",
      compactPending: true,
      interruptionKind: "limit",
      limitEventId: "", // filled per test
    };

    function deadOwnerIntent(): ReturnType<typeof writePreparingIntent> {
      const r = writePreparingIntent(stopInput());
      // Rewrite the owner to a dead pid with a stale heartbeat.
      const raw = JSON.parse(readFileSync(limitLedgerPath(), "utf-8"));
      raw.records[r.key].preparingOwner = { pid: deadPid(), token: r.ownerToken, heartbeatAt: NOW - 600_000, signature: null };
      writeFileSync(limitLedgerPath(), JSON.stringify(raw));
      return r;
    }

    it("crash order A: owner died AFTER session prep -> intent activates", () => {
      const r = deadOwnerIntent();
      const { changedKeys } = reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      expect(changedKeys).toContain(r.key);
      expect(readLimitLedger().records[r.key]!.status).toBe("stopped");
    });

    it("crash order B: owner died BEFORE session prep -> intent dropped", () => {
      const r = deadOwnerIntent();
      const { changedKeys } = reconcileLimitLedger({
        now: NOW,
        readSession: () => null, // session definitively absent / never prepared
      });
      expect(changedKeys).toContain(r.key);
      expect(readLimitLedger().records[r.key]).toBeUndefined();
    });

    it("leaves an intent alone while its owner is alive", () => {
      const r = writePreparingIntent(stopInput()); // owner = this process, signature matches
      reconcileLimitLedger({ now: NOW, readSession: () => null });
      expect(readLimitLedger().records[r.key]!.status).toBe("preparing");
    });

    it("marks records resumed when the session left COMPACT", () => {
      const r = recordDirectStop(stopInput());
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ state: "IMPLEMENT", compactPending: false, interruptionKind: null, limitEventId: null }),
      });
      expect(readLimitLedger().records[r.key]!.status).toBe("resumed");
    });

    it("re-arms a resumed record whose session is still pending (headless only)", () => {
      const r = recordDirectStop(stopInput());
      markResumed(r.key, r.generation, NOW);
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      expect(readLimitLedger().records[r.key]!.status).toBe("stopped");

      // notify-mode records are never re-armed
      const r2 = recordDirectStop(stopInput({ clientTaskId: "s-notify", mode: "notify" }));
      markResumed(r2.key, r2.generation, NOW);
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r2.limitEventId }),
      });
      expect(readLimitLedger().records[r2.key]!.status).toBe("resumed");
    });

    it("a definitively absent session/project fails attempt-less records with project_gone, never resumed", () => {
      // stopped (no attempt)
      const r1 = recordDirectStop(stopInput({ clientTaskId: "s-gone-1" }));
      // deferred (no attempt)
      const r3 = recordDirectStop(stopInput({ clientTaskId: "s-gone-3" }));
      claimAttempt(r3.key, { id: "a3", token: "t3", generation: 1 }, NOW);
      settleAttempt(r3.key, "a3", { status: "deferred" }, NOW);

      reconcileLimitLedger({ now: NOW, readSession: () => null });

      for (const key of [r1.key, r3.key]) {
        const rec = readLimitLedger().records[key]!;
        expect(rec.status).toBe("failed");
        expect(rec.reasonCode).toBe("project_gone");
      }
    });

    it("project-gone with a tracked child stays NON-terminal until the child is confirmed dead", () => {
      // A running child does not necessarily exit because its cwd was removed;
      // terminalizing here would end its supervision and orphan it.
      const r = recordDirectStop(stopInput({ clientTaskId: "s-gone-live" }));
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 999, transcriptOffset: 0, stateRevision: 0 }, NOW);

      // Child alive (or identity unknown): emit a terminate action, leave the
      // record resuming with its attempt evidence intact.
      const first = reconcileLimitLedger({
        now: NOW,
        readSession: () => null,
        isAttemptChildAlive: () => true,
      });
      expect(first.actions).toContainEqual({
        type: "terminate-project-gone",
        key: r.key,
        attempt: expect.objectContaining({ childPid: 999 }),
        generation: 1, // carried so a delayed action can't fail a newer episode
      });
      let rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("resuming");
      expect(rec.attempt?.childPid).toBe(999);

      // Child confirmed gone: NOW it terminalizes and clears the attempt.
      reconcileLimitLedger({ now: NOW, readSession: () => null, isAttemptChildAlive: () => false });
      rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("failed");
      expect(rec.reasonCode).toBe("project_gone");
      expect(rec.attempt).toBeNull();
    });

    it("routes a blocked cancellation back through finish-cancel until the child dies", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 555, transcriptOffset: 0, stateRevision: 0 }, NOW);
      beginCancellation(r.key, NOW);
      blockCancellation(r.key, NOW);
      const { actions } = reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      expect(actions).toEqual([{ type: "finish-cancel", key: r.key, attempt: expect.objectContaining({ childPid: 555 }) }]);
      // and it is NOT silently resumed/re-armed while blocked
      expect(readLimitLedger().records[r.key]!.status).toBe("manual");
    });

    it("reverts an expired interactive claim to stopped", () => {
      const r = recordDirectStop(stopInput());
      markInteractive(r.key, NOW);
      reconcileLimitLedger({
        now: NOW + INTERACTIVE_DEADLINE_MS + 1,
        readSession: (_root, _id) => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      expect(readLimitLedger().records[r.key]!.status).toBe("stopped");
    });

    it("reclaims a resuming record with a dead child and no progress", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW - 3_600_000);
      recordAttemptSpawn(r.key, "a1", { childPid: 12345, transcriptOffset: 0, stateRevision: 0 }, NOW - 3_600_000);
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
        isAttemptChildAlive: () => false,
      });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("stopped");
      expect(rec.attempt).toBeNull();
    });

    it("HOLDS a resuming bare-claim record whose CLAIMANT is a live (suspended) process, even past the stale age", () => {
      if (!SIG_SUPPORTED) return; // needs a positive "alive" claimant identity
      // A null-childPid attempt aged past CLAIM_SPAWN_STALE_MS but whose claimant
      // is still alive (suspended, e.g. across laptop sleep) may resume and spawn
      // any moment. Reconcile must NOT reclaim it -- a fresh spawn would then be
      // untracked. Session still pending: the natural still-parked case.
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW); // claimant = this live process
      mutateLimitLedger((ledger) => {
        ledger.records[r.key]!.attempt!.lastProgressAt = NOW - 130_000; // aged, claimant alive
        return true;
      });
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("resuming"); // held, not reclaimed
      expect(rec.attempt?.id).toBe("a1");
    });

    it("reclaims a resuming bare-claim record whose CLAIMANT is CONFIRMED DEAD (crashed before spawning)", () => {
      // A null-childPid attempt whose claimant is confirmed dead is abandoned: no
      // child will materialize. Reclaim to `stopped` for re-dispatch. Death, not
      // age, drives this -- the age here is fresh.
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      mutateLimitLedger((ledger) => {
        const attempt = ledger.records[r.key]!.attempt!;
        Object.assign(attempt, { lastProgressAt: NOW, ...deadClaimant() });
        return true;
      });
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("stopped");
      expect(rec.attempt).toBeNull();
    });

    it("project-gone HOLDS a bare-claim record (non-terminal) while its live claimant could still spawn", () => {
      if (!SIG_SUPPORTED) return; // needs a positive "alive" claimant identity
      // Session absent AND a bare claim whose claimant is alive: terminalizing to
      // project_gone would let a subsequent spawn create a child with no ledger
      // evidence naming it. Hold non-terminal until the claimant is confirmed
      // gone. (Uses liveClaimant explicitly to be independent of claim timing.)
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      mutateLimitLedger((ledger) => {
        Object.assign(ledger.records[r.key]!.attempt!, { lastProgressAt: NOW - 130_000, ...liveClaimant() });
        return true;
      });
      reconcileLimitLedger({ now: NOW, readSession: () => null });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("resuming"); // NOT failed/project_gone
      expect(rec.attempt?.id).toBe("a1");
    });

    it("project-gone terminalizes a bare-claim record once its CLAIMANT is CONFIRMED DEAD", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      mutateLimitLedger((ledger) => {
        Object.assign(ledger.records[r.key]!.attempt!, { lastProgressAt: NOW, ...deadClaimant() });
        return true;
      });
      reconcileLimitLedger({ now: NOW, readSession: () => null });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("failed");
      expect(rec.reasonCode).toBe("project_gone");
      expect(rec.attempt).toBeNull();
    });

    it("HOLDS a resuming bare-claim record whose claimant identity is UNKNOWN, even past the stale age (all platforms)", () => {
      // Identity is "unknown" on unsupported platforms and after transient
      // signature/proc failures. An unknown claimant may still be alive/suspended
      // -- age must NOT reclaim its bare claim, or a resumed claimant would spawn
      // an untracked child. Platform-independent (unknownClaimant resolves
      // "unknown" everywhere).
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      mutateLimitLedger((ledger) => {
        Object.assign(ledger.records[r.key]!.attempt!, { lastProgressAt: NOW - 130_000, ...unknownClaimant() });
        return true;
      });
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("resuming"); // held, not reclaimed on age
      expect(rec.attempt?.id).toBe("a1");
    });

    it("project-gone HOLDS a bare-claim record whose claimant identity is UNKNOWN, even past the stale age (all platforms)", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      mutateLimitLedger((ledger) => {
        Object.assign(ledger.records[r.key]!.attempt!, { lastProgressAt: NOW - 130_000, ...unknownClaimant() });
        return true;
      });
      reconcileLimitLedger({ now: NOW, readSession: () => null });
      const rec = readLimitLedger().records[r.key]!;
      expect(rec.status).toBe("resuming"); // NOT failed/project_gone -- claimant may still spawn
      expect(rec.attempt?.id).toBe("a1");
    });

    it("emits a finish-cancel action for a crashed mid-cancel record", () => {
      const r = recordDirectStop(stopInput());
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 555, transcriptOffset: 0, stateRevision: 0 }, NOW);
      beginCancellation(r.key, NOW);
      const { actions } = reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      expect(actions).toEqual([{ type: "finish-cancel", key: r.key, attempt: expect.objectContaining({ childPid: 555 }) }]);
    });

    it("prunes old terminal records", () => {
      const r = recordDirectStop(stopInput());
      markResumed(r.key, r.generation, NOW);
      reconcileLimitLedger({
        now: NOW + PRUNE_TERMINAL_AFTER_MS + 1,
        readSession: () => undefined,
      });
      expect(readLimitLedger().records[r.key]).toBeUndefined();
    });

    it("prunes an aged stood-down manual record", () => {
      const r = recordDirectStop(stopInput({ clientTaskId: "s-old-manual" }));
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      settleAttempt(r.key, "a1", { status: "manual", reasonCode: "bypass_not_opted_in" }, NOW);
      reconcileLimitLedger({ now: NOW + PRUNE_MANUAL_AFTER_MS + 1, readSession: () => undefined });
      expect(readLimitLedger().records[r.key]).toBeUndefined();
    });

    it("NEVER prunes a record still carrying attempt evidence, even when aged", () => {
      // A blocked cancellation preserves an attempt naming a possibly-live
      // child. Age-pruning it would drop the only sentinel supervision uses.
      const r = recordDirectStop(stopInput({ clientTaskId: "s-blocked-old" }));
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      recordAttemptSpawn(r.key, "a1", { childPid: 4040, transcriptOffset: 0, stateRevision: 0 }, NOW);
      beginCancellation(r.key, NOW);
      blockCancellation(r.key, NOW);

      // Way past both prune horizons, but the child alive (or unknown) -> the
      // reconcile emits finish-cancel and the record survives with its attempt.
      const { actions } = reconcileLimitLedger({
        now: NOW + PRUNE_MANUAL_AFTER_MS + PRUNE_TERMINAL_AFTER_MS,
        readSession: () => undefined,
        isAttemptChildAlive: () => true,
      });
      const rec = readLimitLedger().records[r.key];
      expect(rec).toBeTruthy();
      expect(rec!.reasonCode).toBe("cancellation_blocked");
      expect(rec!.attempt?.childPid).toBe(4040);
      expect(actions).toContainEqual({
        type: "finish-cancel", key: r.key, attempt: expect.objectContaining({ childPid: 4040 }),
      });
    });

    it("never re-arms deliberately non-headless outcomes", () => {
      const r = recordDirectStop(stopInput({ mode: "notify", reasonCode: "finalize_stop" }));
      claimAttempt(r.key, { id: "a1", token: "t1", generation: 1 }, NOW);
      settleAttempt(r.key, "a1", { status: "manual", reasonCode: "finalize_stop" }, NOW);
      reconcileLimitLedger({
        now: NOW,
        readSession: () => ({ ...pendingSnap, limitEventId: r.limitEventId }),
      });
      expect(readLimitLedger().records[r.key]!.status).toBe("manual");
    });
  });
});
