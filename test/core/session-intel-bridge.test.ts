import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, existsSync, truncateSync, appendFileSync, utimesSync, chmodSync, renameSync, readFileSync, realpathSync } from "node:fs";

/**
 * ISS-1185 test seam: counts real `execFileSync` invocations (still
 * delegating to the genuine implementation) so a test can prove git was
 * never invoked at all, not merely that its result was unused. `vi.spyOn`
 * cannot target a named export of a Node builtin ESM module directly.
 */
const execProbe: { calls: number } = { calls: 0 };
vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    execFileSync: (...args: Parameters<typeof mod.execFileSync>) => {
      execProbe.calls++;
      return (mod.execFileSync as (...a: typeof args) => ReturnType<typeof mod.execFileSync>)(...args);
    },
  };
});
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fault-injection seam on the presence write, test-side only: `beforeMutate`
 * runs after the lock is held and before the mutation callback (a PreCompact
 * racing the lock); `failWrite` runs the mutation callback and then reports
 * the write as failed (the callback's side effects happen, the record does
 * not change). Both are one-shot.
 */
const inject: { beforeMutate: (() => void) | null; failWrite: boolean; beforeCall: (() => void) | null } = { beforeMutate: null, failWrite: false, beforeCall: null };
vi.mock("../../src/core/presence-enrichment.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/core/presence-enrichment.js")>();
  const wrapped: typeof mod.applyPresenceEnrichment = (root, sessionId, budgetMs, source, mutate, now) => {
    // T-501 seam: runs BEFORE the lock is taken and before the record is
    // read, standing in for another process that stamps in the window
    // between an unlocked read and this call's lock. One-shot.
    const beforeCall = inject.beforeCall;
    inject.beforeCall = null;
    beforeCall?.();
    const before = inject.beforeMutate;
    const fail = inject.failWrite;
    inject.beforeMutate = null;
    inject.failWrite = false;
    if (!before && !fail) return mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, mutate, now);
    let sawWrite = false;
    const outcome = mod.applyPresenceEnrichment(root, sessionId, budgetMs, source, (base, nowIso) => {
      before?.();
      const next = mutate(base, nowIso);
      if (fail) { sawWrite = true; return base; } // record left as it was
      return next;
    }, now);
    return fail && sawWrite && outcome.status === "written" ? { status: "skipped-write-failed" } : outcome;
  };
  return { ...mod, applyPresenceEnrichment: wrapped };
});
import {
  PENDING_MAX_LISTED,
  PENDING_SUBDIR,
  WORKTREE_DISCOVERY_SUCCESS_TTL_MS,
  applyAssumedReset,
  applyBoundaryReset,
  discoverWorktreeRoots,
  resetWorktreeDiscoveryCache,
  worktreeDiscoveryStats,
  findPresenceRecordAcrossWorktrees,
  judgeSample,
  markCompactPending,
  persistSample,
  readPresenceRecord,
  reconcileIntel,
  reconcileUnderLock,
  resolveCallerBinding,
  revalidateCandidateIdentity,
  compactSample,
  consumeUsageAdvisory,
  stampHandover,
  claimImperativeEmission,
} from "../../src/core/session-intel/presence-bridge.js";
import { resolveSessionIntelConfig } from "../../src/core/session-intel/config.js";
import { computeSample } from "../../src/core/session-intel/sampler.js";
import { scanTail } from "../../src/core/session-intel/transcript-scan.js";
import { processEra } from "../../src/core/session-intel/process-era.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../src/core/presence-enrichment.js";
import { emptySessionIntel, type SessionIntelPresence } from "../../src/presence/session-intel-fields.js";
import { presenceFileBase } from "../../src/presence/types.js";
import type { CeilingResolution, TokenPressureSample, UsageAdvisoryInput } from "../../src/core/session-intel/types.js";
import { SID, assistantRecord, bareStoryInit, boundaryRecord, git, growingSession, makeWorktreePair, symlinkSync, writeTranscript } from "./session-intel-fixtures.js";

const cfg = resolveSessionIntelConfig(null);
const T0 = Date.parse("2026-09-09T12:00:00Z");
const at = (m: number) => new Date(T0 + m * 60_000).toISOString();

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "si-bridge-"));
  try {
    mkdirSync(join(root, ".story"), { recursive: true });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seed(root: string, intel: Partial<SessionIntelPresence>, sessionId = SID): void {
  const r = applyPresenceEnrichment(root, sessionId, LIFECYCLE_LOCK_BUDGET_MS, "test", (base) => ({ ...base, sessionIntel: { ...emptySessionIntel(), ...intel } }));
  expect(r.status).toBe("written");
}

const intelOf = (root: string) => readPresenceRecord(root, SID)!.sessionIntel!;

/** T-501: a window well above the recommended max, so every advisory path is exercised. */
const USAGE: UsageAdvisoryInput = { window: 1_000_000, source: "user", provenance: "capture" };

function ceiling(): CeilingResolution {
  return { ceiling: 417_737, source: "setting", confidence: "high", sampleCount: 0, independentSessions: 0, effectiveSampleWindow: 0, basis: "t", conflict: null, autoCompactWindowAtStart: 450_000, captureKind: "startup", nativeWindow: null, highWaterMark: null };
}

function sampleFor(path: string, era: string | null, revisionSeen: number | null, record: SessionIntelPresence | null = null): TokenPressureSample {
  const scan = scanTail({ path, sessionId: SID, era, revisionSeen, epochSince: null })!;
  return computeSample({ scan, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: at(0), record, usage: USAGE });
}

describe("pure resets", () => {
  const base: SessionIntelPresence = { ...emptySessionIntel(), era: "1:2", revision: 3, lastSample: null, handoverWrittenAt: at(5), tokensAtHandover: 100, handoverBoundaryAt: null };

  it("applyBoundaryReset: newer boundary bumps revision, sets epoch, clears the sample; handover before ts cleared, after ts migrated; idempotent", () => {
    const cleared = applyBoundaryReset(base, at(6));
    expect(cleared).toMatchObject({ lastBoundaryAt: at(6), epoch: { kind: "observed", at: at(6) }, revision: 4, handoverWrittenAt: null, tokensAtHandover: null, handoverBoundaryAt: null });
    const migrated = applyBoundaryReset(base, at(4));
    expect(migrated).toMatchObject({ handoverWrittenAt: at(5), tokensAtHandover: 100, handoverBoundaryAt: at(4), revision: 4 });
    expect(applyBoundaryReset(cleared, at(6))).toBe(cleared);
    expect(applyBoundaryReset(cleared, at(3))).toBe(cleared);
  });

  it("applyAssumedReset: assumed epoch, everything from before cleared including a later handover", () => {
    const r = applyAssumedReset(base, at(4));
    expect(r).toMatchObject({ lastBoundaryAt: at(4), epoch: { kind: "assumed", at: at(4) }, revision: 4, handoverWrittenAt: null, tokensAtHandover: null, handoverBoundaryAt: null });
    expect(applyAssumedReset(r, at(4))).toBe(r);
  });
});

describe("reconcileIntel (pure classification)", () => {
  const file = (name: string, event: { eventId: string; era: string | null; at: string } | null, mtimeMs = T0) => ({ name, path: `/p/${name}`, event, mtimeMs });
  const intel: SessionIntelPresence = { ...emptySessionIntel(), era: "1:2" };

  it("a pending at or before the newest boundary is resolved; a young one remains (incomplete); an old one expires to an assumed identity", () => {
    const now = T0 + 10 * 60_000;
    const listing = { complete: true, files: [file("a", { eventId: "a", era: "1:2", at: at(1) }), file("b", { eventId: "b", era: "1:2", at: at(9) })] };
    const r = reconcileIntel(intel, { timestamp: at(2), trigger: "auto", preTokens: 1, postTokens: 1 }, listing, cfg, now);
    expect(r.intel.lastBoundaryAt).toBe(at(2));
    expect(r.unlink).toEqual(["/p/a"]);
    expect(r.remaining).toBe(1);
    expect(r.status).toBe("incomplete");
    const later = reconcileIntel(intel, null, { complete: true, files: [file("b", { eventId: "b", era: "1:2", at: at(1) })] }, cfg, now);
    expect(later.intel.epoch).toEqual({ kind: "assumed", at: at(1) });
    expect(later.unlink).toEqual(["/p/b"]);
    expect(later.status).toBe("complete");
  });

  it("unparsable: pending while young, unlinked once past the TTL; an incomplete listing is never complete", () => {
    const now = T0 + 10 * 60_000;
    const young = reconcileIntel(intel, null, { complete: true, files: [file("x", null, now - 1000)] }, cfg, now);
    expect(young).toMatchObject({ remaining: 1, status: "incomplete", unlink: [] });
    const old = reconcileIntel(intel, null, { complete: true, files: [file("x", null, T0)] }, cfg, now);
    expect(old).toMatchObject({ remaining: 0, status: "complete", unlink: ["/p/x"] });
    expect(reconcileIntel(intel, null, { complete: false, files: [] }, cfg, now).status).toBe("incomplete");
  });

  it("era isolation: a null-era or foreign-era pending is stale cleanup, never blocking or resetting the current era", () => {
    const now = T0 + 10 * 60_000;
    const listing = { complete: true, files: [file("n", { eventId: "n", era: null, at: at(1) }), file("f", { eventId: "f", era: "7:7", at: at(1) })] };
    const r = reconcileIntel(intel, null, listing, cfg, now);
    expect(r.intel).toBe(intel);
    expect(r.unlink.sort()).toEqual(["/p/f", "/p/n"]);
    expect(r).toMatchObject({ remaining: 0, status: "complete" });
    // A record with no era cannot be blocked by anything either.
    const noEra = reconcileIntel({ ...intel, era: null }, null, { complete: true, files: [file("x", { eventId: "x", era: "1:2", at: at(9) })] }, cfg, now);
    expect(noEra).toMatchObject({ remaining: 0, status: "complete", unlink: ["/p/x"] });
  });

  it("a real boundary on top of an assumed identity resets normally", () => {
    const assumed = applyAssumedReset(intel, at(1));
    const r = reconcileIntel(assumed, { timestamp: at(2), trigger: "auto", preTokens: 1, postTokens: 1 }, { complete: true, files: [] }, cfg, T0);
    expect(r.intel.epoch).toEqual({ kind: "observed", at: at(2) });
    expect(r.intel.revision).toBe(assumed.revision + 1);
  });
});

describe("pending files and reconcileUnderLock", () => {
  it("markCompactPending publishes atomically, accepts same-content EEXIST, refuses different content, leaves no tmp", () => {
    withRoot((root) => {
      const ev = { eventId: "e1", era: "1:2", at: at(1) };
      expect(markCompactPending(root, SID, ev)).toBe(true);
      expect(markCompactPending(root, SID, ev)).toBe(true);
      expect(markCompactPending(root, SID, { ...ev, era: "9:9" })).toBe(false);
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      expect(readdirSync(dir)).toHaveLength(1);
      expect(readdirSync(dir)[0]).toMatch(/\.json$/);
    });
  });

  it("writes the record FIRST, then unlinks resolved files; a stale .tmp is removed; 33 expired files drain 32 then the rest", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      for (let i = 0; i < PENDING_MAX_LISTED + 1; i++) markCompactPending(root, SID, { eventId: `e${String(i).padStart(2, "0")}`, era: "1:2", at: at(i) });
      const stale = join(dir, ".tmp-dead");
      writeFileSync(stale, "{");
      utimesSync(stale, (T0 - 1e6) / 1000, (T0 - 1e6) / 1000);
      const now = T0 + 60 * 60_000; // every pending is past the 5 min TTL
      const r1 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r1.status).toBe("incomplete");
      expect(existsSync(stale)).toBe(false);
      expect(readdirSync(dir)).toHaveLength(1);
      expect(intelOf(root).epoch).toEqual({ kind: "assumed", at: at(PENDING_MAX_LISTED - 1) });
      const r2 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r2.status).toBe("complete");
      expect(readdirSync(dir)).toHaveLength(0);
      expect(intelOf(root).epoch).toEqual({ kind: "assumed", at: at(PENDING_MAX_LISTED) });
    });
  });

  it("write-before-unlink: when the record write FAILS after the mutation ran, every pending file and the record survive untouched", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      for (let i = 0; i < 3; i++) markCompactPending(root, SID, { eventId: `e${i}`, era: "1:2", at: at(i) });
      const before = readPresenceRecord(root, SID);
      const now = T0 + 60 * 60_000; // all expired: the mutation computes three resets and three unlinks
      inject.failWrite = true;
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.enrichment?.status).toBe("skipped-write-failed");
      expect(r.status).toBe("incomplete");
      expect(readdirSync(dir).sort()).toHaveLength(3); // deletion was permitted; it was never attempted
      expect(readPresenceRecord(root, SID)).toEqual(before);
      // The next pass, with the write working, does the whole job.
      const r2 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r2.status).toBe("complete");
      expect(readdirSync(dir)).toHaveLength(0);
      expect(intelOf(root).revision).toBe(3);
    });
  });

  it("a pending directory created and published while the lock was awaited is seen by reconciliation and by persistence (no cached absence)", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      expect(existsSync(dir)).toBe(false);
      inject.beforeMutate = () => { expect(markCompactPending(root, SID, { eventId: "race", era: "1:2", at: at(1) })).toBe(true); };
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now: T0 + 2 * 60_000 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.status).toBe("incomplete");
      expect(r.reason).toMatch(/pending/);
      rmSync(dir, { recursive: true });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(2, 1, 1));
      const s = sampleFor(path, "1:2", intelOf(root).revision);
      inject.beforeMutate = () => { expect(markCompactPending(root, SID, { eventId: "race2", era: "1:2", at: at(3) })).toBe(true); };
      const out = persistSample({ root, sessionId: SID, sample: s, transcriptPath: path, cfg, now: T0 + 4 * 60_000, recompute: () => s });
      expect(out).toMatchObject({ status: "rejected", reason: expect.stringMatching(/pending/) });
      expect(intelOf(root).lastSample).toBeNull();
    });
  });

  it("an interrupted cleanup after a successful write is repaired on retry without another bump; a busy lock leaves everything", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      for (let i = 0; i < 3; i++) markCompactPending(root, SID, { eventId: `e${i}`, era: "1:2", at: at(i) });
      const now = T0 + 60 * 60_000; // all expired
      // 1. Lock held: never reaches the write, nothing unlinked, record untouched.
      const lock = join(root, ".story", "telemetry", "presence", `${presenceFileBase(SID)}.lock`);
      mkdirSync(lock);
      try {
        const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, 0);
        expect(r.enrichment?.status).toBe("skipped-lock-busy");
      } finally {
        rmSync(lock, { recursive: true });
      }
      expect(readdirSync(dir)).toHaveLength(3);
      expect(intelOf(root).revision).toBe(0);
      // 2. Record write succeeds, cleanup is interrupted (directory made unwritable).
      chmodSync(dir, 0o500);
      let r2;
      try {
        r2 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(r2.enrichment?.status).toBe("written");
      // Three expired events, each newer than the last: three assumed resets, three bumps.
      expect(intelOf(root)).toMatchObject({ revision: 3, epoch: { kind: "assumed", at: at(2) } });
      expect(readdirSync(dir)).toHaveLength(3); // the write landed, the unlinks did not
      // 3. Retry: resolved by `at <= lastBoundaryAt`, unlinked, no further bump.
      const r3 = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r3.status).toBe("complete");
      expect(readdirSync(dir)).toHaveLength(0);
      expect(intelOf(root).revision).toBe(3);
    });
  });

  it("a pending resolved by the tail's boundary with no SessionStart ever arriving; a delayed second pass is a no-op", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      markCompactPending(root, SID, { eventId: "e", era: "1:2", at: at(1) });
      const b = { timestamp: at(2), trigger: "auto" as const, preTokens: 1, postTokens: 1 };
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [b], transcriptPath: null, source: "other", now: T0 + 3 * 60_000 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.status).toBe("complete");
      const rev = intelOf(root).revision;
      expect(intelOf(root).lastBoundaryAt).toBe(at(2));
      reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [b], transcriptPath: null, source: "compact", now: T0 + 4 * 60_000 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(intelOf(root).revision).toBe(rev);
    });
  });

  it("a boundary beyond the tail is found by the backward scan when a pending exists or the source is compact", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const lines = [boundaryRecord({ ts: at(1), pre: 400_000 }), ...growingSession(3000, 1_000, 100)];
      const path = writeTranscript(join(root, "projects"), "p", SID, lines);
      expect(scanTail({ path, sessionId: SID, era: null, revisionSeen: null, epochSince: null })!.boundaries).toHaveLength(0);
      const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: path, source: "compact", now: T0 }, LIFECYCLE_LOCK_BUDGET_MS);
      expect(r.status).toBe("complete");
      expect(intelOf(root).lastBoundaryAt).toBe(at(1));
    });
  });

  it("a busy lock is incomplete for a sampler (budget 0) and leaves the file for the next entry point", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      markCompactPending(root, SID, { eventId: "e", era: "1:2", at: at(1) });
      const lock = join(root, ".story", "telemetry", "presence", `${presenceFileBase(SID)}.lock`);
      mkdirSync(lock);
      try {
        const r = reconcileUnderLock({ root, sessionId: SID, cfg, tailBoundaries: [], transcriptPath: null, source: "other", now: T0 }, 0);
        expect(r.status).toBe("incomplete");
        expect(r.enrichment?.status).toBe("skipped-lock-busy");
      } finally {
        rmSync(lock, { recursive: true });
      }
      const dir = join(root, ".story", "telemetry", PENDING_SUBDIR, presenceFileBase(SID));
      expect(readdirSync(dir)).toHaveLength(1);
    });
  });
});

describe("judgeSample (persistence rule)", () => {
  const obs = { era: "1:2", incarnation: "1:1", sizeAtOpen: 100, consumedOffset: 100, anchor: { offset: 100, sha256: "a".repeat(64) }, authoritative: true, revisionSeen: 0, lastRecordTimestamp: null, epoch: { kind: "unobserved" as const } };
  const s = (o: Partial<typeof obs>) => ({ observation: { ...obs, ...o } }) as unknown as TokenPressureSample;
  const intel: SessionIntelPresence = { ...emptySessionIntel(), era: "1:2", revision: 0, incarnation: "1:1", consumedOffset: 50, baselineAnchor: { offset: 50, sha256: "b".repeat(64) } };
  const ok = { incarnation: "1:1", size: 100, baselineOk: true, incomingOk: true };

  it("accepts only when every rule holds", () => {
    expect(judgeSample(intel, s({}), ok).verdict).toBe("accept");
    expect(judgeSample(intel, s({ era: null }), ok).reason).toMatch(/era/);
    expect(judgeSample({ ...intel, era: null }, s({}), ok).reason).toMatch(/era/);
    expect(judgeSample(intel, s({ era: "9:9" }), ok).reason).toMatch(/era/);
    expect(judgeSample(intel, s({ authoritative: false }), ok).reason).toMatch(/non-authoritative/);
    expect(judgeSample({ ...intel, revision: 1 }, s({}), ok).reason).toMatch(/stale revision/);
    expect(judgeSample(intel, s({}), { ...ok, incarnation: "2:2" }).reason).toMatch(/replaced/);
    expect(judgeSample(intel, s({}), { ...ok, incarnation: null, size: null }).reason).toMatch(/unreadable/);
  });

  it("baseline broken bumps the revision and rejects; incoming broken likewise; older offset rejects without a bump", () => {
    expect(judgeSample(intel, s({}), { ...ok, size: 40 })).toMatchObject({ verdict: "reject", bumpRevision: true, reason: expect.stringMatching(/baseline/) });
    expect(judgeSample(intel, s({}), { ...ok, baselineOk: false })).toMatchObject({ verdict: "reject", bumpRevision: true });
    expect(judgeSample(intel, s({}), { ...ok, incomingOk: false })).toMatchObject({ verdict: "reject", bumpRevision: true, reason: expect.stringMatching(/observation anchor/) });
    expect(judgeSample(intel, s({ consumedOffset: 90, sizeAtOpen: 90 }), { ...ok, size: 85 })).toMatchObject({ verdict: "reject", bumpRevision: true });
    expect(judgeSample(intel, s({ consumedOffset: 40, sizeAtOpen: 40 }), ok)).toMatchObject({ verdict: "reject", bumpRevision: false, reason: expect.stringMatching(/older/) });
    // Baseline check only applies to the same incarnation the record knows.
    expect(judgeSample({ ...intel, incarnation: "0:0" }, s({}), { ...ok, size: 40, baselineOk: false }).reason).toMatch(/observation anchor|older/);
  });
});

describe("persistSample end to end", () => {
  it("accepts a fresh sample, drops an older-offset one, detects truncation with a revision bump, then accepts the next", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(3, 1_000, 100));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      const first = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: first, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      const after = intelOf(root);
      expect(after.consumedOffset).toBe(first.observation.consumedOffset);
      expect(after.baselineAnchor).toEqual(first.observation.anchor);
      expect(after.lastSample?.contextTokens).toBe(first.contextTokens);
      // Newer bytes arrive; an older Stop sample (computed before them) is dropped by offset.
      const older = first;
      appendFileSync(path, assistantRecord({ ts: at(9), read: 5_000 }) + "\n");
      const newer = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: newer, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      expect(persistSample({ root, sessionId: SID, sample: older, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/older/) });
      // Truncate below the baseline, regrow: the detecting sample is rejected with a bump, the next is accepted.
      truncateSync(path, 10);
      appendFileSync(path, growingSession(2, 5, 1).join("\n") + "\n");
      const detecting = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: detecting, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/baseline/) });
      expect(intelOf(root).revision).toBe(1);
      expect(intelOf(root).baselineAnchor).toBeNull();
      const next = sampleFor(path, "1:2", 1);
      expect(persistSample({ root, sessionId: SID, sample: next, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
    });
  });

  it("truncation between read and persist (file shorter than the sample's own offset) is rejected by the incoming check", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(3, 1_000, 100));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      const s = sampleFor(path, "1:2", 0);
      truncateSync(path, s.observation.consumedOffset - 5);
      expect(persistSample({ root, sessionId: SID, sample: s, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/observation anchor/) });
      expect(intelOf(root).revision).toBe(1);
    });
  });

  it("a handover stamped between compute and persist is honoured: suppression is recomputed on the SAME validated scan and the persisted observation is the one that passed", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const tokens = 417_737 - 40_000; // past 0.9 x the ceiling and within 50,000 of it
      const path = writeTranscript(join(root, "projects"), "p", SID, [assistantRecord({ ts: at(0), read: tokens - 2 })]);
      const scan = scanTail({ path, sessionId: SID, era: "1:2", revisionSeen: 0, epochSince: null })!;
      const computed = computeSample({ scan, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: at(0), record: null, usage: USAGE });
      expect(computed.state).toBe("imperative");
      expect(stampHandover(root, SID, "1:2", tokens, T0).status).toBe("written");
      // Production recomputation reuses the validated scan; only suppression changes.
      const recompute = (rec: SessionIntelPresence) => computeSample({ scan, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: at(0), record: rec, usage: USAGE });
      const out = persistSample({ root, sessionId: SID, sample: computed, transcriptPath: path, cfg, now: T0, recompute });
      expect(out.status).toBe("accepted");
      expect(intelOf(root).lastSample).toMatchObject({ rawState: "imperative", state: "advisory", suppressedBy: "handover" });
      expect(intelOf(root).lastSample?.observation).toEqual(computed.observation);
      expect(intelOf(root).handoverBoundaryAt).toBeNull();
    });
  });

  it("stampHandover refuses an ended record, a null caller era, an era mismatch and a record without a subtree (never creates one)", () => {
    withRoot((root) => {
      expect(stampHandover(root, SID, "1:2", 1, T0)).toMatchObject({ status: "refused" });
      expect(readPresenceRecord(root, SID)?.sessionIntel?.handoverWrittenAt ?? null).toBeNull();
      seed(root, { era: "1:2" });
      expect(stampHandover(root, SID, null, 1, T0)).toMatchObject({ status: "refused" });
      expect(stampHandover(root, SID, "9:9", 1, T0)).toMatchObject({ status: "refused", reason: expect.stringMatching(/era/) });
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
      expect(stampHandover(root, SID, "1:2", 1, T0)).toMatchObject({ status: "refused", reason: expect.stringMatching(/ended/) });
      expect(intelOf(root).handoverWrittenAt).toBeNull();
    });
  });

  it("era mismatch, null era, a non-authoritative scan, an ended record and a pending compaction never persist; the stored sample and baseline stay", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(2, 1, 1));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "9:9", 0), transcriptPath: path, cfg, now: T0, recompute }).status).toBe("rejected");
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, null, 0), transcriptPath: path, cfg, now: T0, recompute }).status).toBe("rejected");
      expect(intelOf(root).lastSample).toBeNull();
      // Establish a baseline, then try to replace it with a partial scan of the same era and revision.
      const good = sampleFor(path, "1:2", 0);
      expect(persistSample({ root, sessionId: SID, sample: good, transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      const stored = intelOf(root);
      const partial = { ...good, observation: { ...good.observation, authoritative: false } };
      expect(persistSample({ root, sessionId: SID, sample: partial, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/non-authoritative/) });
      expect(intelOf(root)).toEqual(stored);
      // A compaction published AFTER reconciliation and BEFORE persistence is caught under the lock.
      markCompactPending(root, SID, { eventId: "p", era: "1:2", at: at(1) });
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "1:2", 0), transcriptPath: path, cfg, now: T0 + 2 * 60_000, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/pending/) });
      expect(intelOf(root)).toEqual(stored);
      rmSync(join(root, ".story", "telemetry", PENDING_SUBDIR), { recursive: true });
      // SessionEnd between binding and the write.
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "1:2", 0), transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/ended/) });
      expect(intelOf(root).lastSample).toEqual(stored.lastSample);
    });
  });

  it("a replacement whose baseline prefix matches the old file is rejected as replaced, not validated by the surviving baseline", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      const path = writeTranscript(join(root, "projects"), "p", SID, growingSession(3, 1_000, 100));
      const recompute = (rec: SessionIntelPresence) => sampleFor(path, "1:2", rec.revision, rec);
      expect(persistSample({ root, sessionId: SID, sample: sampleFor(path, "1:2", 0), transcriptPath: path, cfg, now: T0, recompute }).status).toBe("accepted");
      // The sample is computed on the old inode; the file is then replaced by a
      // copy with identical bytes plus a new record (the baseline prefix matches).
      const old = sampleFor(path, "1:2", 0);
      const copy = `${path}.new`;
      writeFileSync(copy, readFileSync(path));
      appendFileSync(copy, assistantRecord({ ts: at(9), read: 5_000 }) + "\n");
      renameSync(copy, path);
      expect(persistSample({ root, sessionId: SID, sample: old, transcriptPath: path, cfg, now: T0, recompute })).toMatchObject({ status: "rejected", reason: expect.stringMatching(/replaced/) });
    });
  });
});

describe("resolveCallerBinding", () => {
  const saved = { ...process.env };
  beforeEach(() => { processEra.reset(); });
  afterEach(() => {
    for (const k of ["CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "STORYBLOQ_CLIENT"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    processEra.reset();
  });

  it("binds only with a live record whose era equals the caller's live era; ended id, era mismatch, null era, codex all unbound", () => {
    withRoot((root) => {
      process.env.CLAUDE_CODE_SESSION_ID = SID;
      process.env.CLAUDE_PID = String(process.pid);
      delete process.env.STORYBLOQ_CLIENT;
      const era = processEra.current()!.id;
      expect(resolveCallerBinding(root).reason).toMatch(/no presence record/);
      seed(root, { era: "9:9" });
      expect(resolveCallerBinding(root)).toMatchObject({ bound: false, reason: expect.stringMatching(/differs/) });
      seed(root, { era });
      expect(resolveCallerBinding(root)).toMatchObject({ bound: true, sessionId: SID, era, check: "live" });
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
      expect(resolveCallerBinding(root)).toMatchObject({ bound: false, reason: expect.stringMatching(/ended/) });
      process.env.STORYBLOQ_CLIENT = "codex";
      expect(resolveCallerBinding(root).reason).toMatch(/not Claude/);
      delete process.env.STORYBLOQ_CLIENT;
      delete process.env.CLAUDE_PID;
      processEra.reset();
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: null }));
      expect(resolveCallerBinding(root)).toMatchObject({ bound: false, era: null, reason: expect.stringMatching(/era unknown/) });
      expect(resolveCallerBinding(null).reason).toMatch(/no project/);
    });
  });
});

describe("ISS-1185: worktree fallback", () => {
  const SID2 = "9c1a2b3d-4e5f-6071-8293-a4b5c6d7e8f9";

  it("discoverWorktreeRoots: finds the main checkout and the worktree; limit caps the list; a non-repo returns []", () => {
    const wt = makeWorktreePair("si-bridge-wt-");
    try {
      const roots = discoverWorktreeRoots(wt.main).map((r) => realpathOf(r));
      expect(roots).toEqual(expect.arrayContaining([realpathOf(wt.main), realpathOf(wt.worktree)]));
      expect(discoverWorktreeRoots(wt.main, { limit: 1 })).toHaveLength(1);
      expect(discoverWorktreeRoots(wt.main, { limit: 0 })).toEqual([]);
      const bare = mkdtempSync(join(tmpdir(), "not-a-repo-"));
      try {
        expect(discoverWorktreeRoots(bare)).toEqual([]);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      wt.cleanup();
    }
  });

  it("discoverWorktreeRoots: an already-past deadline returns [] WITHOUT ever invoking git", () => {
    const wt = makeWorktreePair("si-bridge-wt-deadline-"); // setup itself calls execFileSync (git init/worktree add) several times
    try {
      const before = execProbe.calls;
      const past = 1000;
      const clock = () => 2000; // already past `past`
      expect(discoverWorktreeRoots(wt.main, { deadline: past, clock })).toEqual([]);
      expect(execProbe.calls).toBe(before); // no git invocation happened for this call specifically
    } finally {
      wt.cleanup();
    }
  });

  it("findPresenceRecordAcrossWorktrees: finds a record seeded only under the worktree; exact-id match (a different session's record elsewhere is never mistaken for a match); refuses a symlinked candidate root and a symlinked .story/telemetry component", () => {
    const wt = makeWorktreePair("si-bridge-fpaw-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      expect(findPresenceRecordAcrossWorktrees(wt.main, SID)).toBeNull();
      seed(wt.worktree, { era: "1:2" }, SID);
      const match = findPresenceRecordAcrossWorktrees(wt.main, SID);
      expect(match).toMatchObject({ root: wt.worktree, record: { sessionIntel: { era: "1:2" } } });
      expect(match!.identity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
      // A DIFFERENT session's record living in the same worktree is not a match for SID2.
      expect(findPresenceRecordAcrossWorktrees(wt.main, SID2)).toBeNull();
      seed(wt.worktree, { era: "9:9" }, SID2);
      const forSid2 = findPresenceRecordAcrossWorktrees(wt.main, SID2);
      expect(forSid2!.record.sessionIntel!.era).toBe("9:9");
      // The registered worktree path itself replaced by a symlink to a
      // directory that DOES hold a matching record: git still lists the
      // original path string, but the walk must refuse to follow it.
      const movedAside = join(wt.base, "wt-moved-aside");
      renameSync(wt.worktree, movedAside);
      symlinkSync(movedAside, wt.worktree);
      try {
        expect(findPresenceRecordAcrossWorktrees(wt.main, SID)).toBeNull();
      } finally {
        rmSync(wt.worktree, { force: true }); // remove the symlink itself so wt.cleanup()'s rmSync(base) does not follow it
        renameSync(movedAside, wt.worktree);
      }
    } finally {
      wt.cleanup();
    }
  });

  /**
   * ISS-1211 gate round 2: the discovery memo introduced for the ledger
   * routing must not freeze the worktree set. The orchestrator working style
   * adds a worktree mid-session and a hook running there writes the presence
   * record under it; a long-lived MCP server that had already listed the repo
   * would otherwise never find that record again.
   */
  it("findPresenceRecordAcrossWorktrees: a worktree added after the first listing is found once the discovery TTL expires, and costs nothing before then", () => {
    const wt = makeWorktreePair("si-bridge-late-wt-");
    try {
      resetWorktreeDiscoveryCache();
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      let t = 2_000_000;
      const clock = () => t;
      worktreeDiscoveryStats.spawns = 0;
      expect(findPresenceRecordAcrossWorktrees(wt.main, SID, { clock })).toBeNull();
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      const late = join(wt.base, "wt-late");
      git(wt.main, ["worktree", "add", "-q", "-b", "wt-late-branch", late]);
      bareStoryInit(late);
      seed(late, { era: "1:2" }, SID);
      // Inside the TTL the memo answers, so the one-spawn property survives.
      expect(findPresenceRecordAcrossWorktrees(wt.main, SID, { clock })).toBeNull();
      expect(worktreeDiscoveryStats.spawns).toBe(1);
      // Past it, the repo is re-listed and the record is found where the hook wrote it.
      t += WORKTREE_DISCOVERY_SUCCESS_TTL_MS;
      expect(findPresenceRecordAcrossWorktrees(wt.main, SID, { clock })?.root).toBe(late);
      expect(worktreeDiscoveryStats.spawns).toBe(2);
    } finally {
      resetWorktreeDiscoveryCache();
      wt.cleanup();
    }
  });

  it("findPresenceRecordAcrossWorktrees: refuses a candidate whose .story/telemetry component is a symlink, even when the real target holds a matching record", () => {
    const wt = makeWorktreePair("si-bridge-telemetry-symlink-");
    const shadow = mkdtempSync(join(tmpdir(), "si-bridge-shadow-"));
    try {
      bareStoryInit(wt.main);
      mkdirSync(join(wt.worktree, ".story"), { recursive: true }); // `.story` itself is a real directory
      bareStoryInit(shadow);
      seed(shadow, { era: "1:2" }, SID); // a real, matching record -- reachable only by following the symlink below
      symlinkSync(join(shadow, ".story", "telemetry"), join(wt.worktree, ".story", "telemetry"));
      expect(findPresenceRecordAcrossWorktrees(wt.main, SID)).toBeNull();
    } finally {
      rmSync(shadow, { recursive: true, force: true });
      wt.cleanup();
    }
  });

  it("findPresenceRecordAcrossWorktrees: a deadline expiring mid-walk (after candidate A is genuinely read, before candidate B is reached) stops with candidate B's own matching record never returned", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "si-bridge-multi-wt-")));
    try {
      const main = join(base, "main");
      mkdirSync(main, { recursive: true });
      git(main, ["init", "-q", "--object-format=sha1"]);
      git(main, ["config", "user.email", "test@example.com"]);
      git(main, ["config", "user.name", "Test"]);
      writeFileSync(join(main, "f.txt"), "x\n");
      git(main, ["add", "-A"]);
      git(main, ["commit", "-q", "-m", "init"]);
      const wtA = join(base, "wtA");
      const wtB = join(base, "wtB");
      git(main, ["worktree", "add", "-q", "-b", "a", wtA]); // listed first
      git(main, ["worktree", "add", "-q", "-b", "b", wtB]); // listed second
      bareStoryInit(main);
      bareStoryInit(wtA);
      bareStoryInit(wtB);
      seed(wtA, { era: "9:9" }, SID2); // candidate A holds a record, but for a DIFFERENT session -- read, genuinely inspected, no match for SID
      seed(wtB, { era: "1:2" }, SID); // only candidate B holds SID's own record

      // clock() is called once for the discovery deadline check, then once
      // per listed entry BEFORE that entry is read (`main` itself is listed
      // first and is skipped by identity, not by the deadline, but the
      // per-entry deadline check still runs for it). Budget the schedule so
      // discovery, main's own check, and candidate A's check all pass (A is
      // actually read), and only candidate B's check trips the deadline --
      // proving the walk reached and inspected A, and stopped strictly
      // before reading B.
      function makeClock(schedule: number[]): { clock: () => number; calls: number[] } {
        const calls: number[] = [];
        let i = 0;
        const clock = () => { const n = i < schedule.length ? schedule[i]! : schedule[schedule.length - 1]!; i++; calls.push(n); return n; };
        return { clock, calls };
      }
      const forB = makeClock([0, 10, 20, 100]);
      expect(findPresenceRecordAcrossWorktrees(main, SID, { deadline: 50, clock: forB.clock })).toBeNull();
      expect(forB.calls).toEqual([0, 10, 20, 100]); // discovery, main (skipped by identity), candidate A (read, no match), candidate B (aborted before any read of B)

      // Same schedule, but for SID2 (candidate A's own session): reached and
      // returned after only 3 calls, proving A really is inspected within
      // that budget and the walk never needed to reach candidate B at all.
      const forA = makeClock([0, 10, 20, 100]);
      const match = findPresenceRecordAcrossWorktrees(main, SID2, { deadline: 50, clock: forA.clock });
      expect(match).toMatchObject({ root: wtA, record: { sessionIntel: { era: "9:9" } } });
      expect(forA.calls).toEqual([0, 10, 20]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("revalidateCandidateIdentity: true only when the chain is still safe AND the inode is unchanged since discovery", () => {
    const wt = makeWorktreePair("si-bridge-revalidate-");
    try {
      bareStoryInit(wt.worktree);
      seed(wt.worktree, { era: "1:2" }, SID);
      const match = findPresenceRecordAcrossWorktrees(wt.main, SID)!;
      expect(revalidateCandidateIdentity(wt.worktree, match.identity)).toBe(true);
      // Replace the path with a genuinely different directory instance (via
      // rename, so the inode is guaranteed to differ, unlike rmdir+mkdir at
      // the same path where inode reuse is filesystem-dependent).
      const replacement = mkdtempSync(join(tmpdir(), "si-bridge-replacement-"));
      rmSync(wt.worktree, { recursive: true, force: true });
      renameSync(replacement, wt.worktree);
      expect(revalidateCandidateIdentity(wt.worktree, match.identity)).toBe(false);
    } finally {
      wt.cleanup();
    }
  });

  it("resolveCallerBinding: walk is strictly opt-in -- the 2-3 arg form never falls back, even when a worktree holds a matching record; only an explicit walk arg (even {}) finds it and reports recordRoot/recordRootIdentity", () => {
    const wt = makeWorktreePair("si-bridge-binding-wt-");
    try {
      bareStoryInit(wt.main);
      bareStoryInit(wt.worktree);
      process.env.CLAUDE_CODE_SESSION_ID = SID;
      process.env.CLAUDE_PID = String(process.pid);
      delete process.env.STORYBLOQ_CLIENT;
      processEra.reset();
      const era = processEra.current()!.id;
      seed(wt.worktree, { era });
      // No 4th arg at all: byte-identical to pre-ISS-1185 behavior, unbound.
      expect(resolveCallerBinding(wt.main)).toMatchObject({ bound: false, recordRoot: null, recordRootIdentity: null });
      expect(resolveCallerBinding(wt.main, null, processEra)).toMatchObject({ bound: false, recordRoot: null });
      // An explicit walk, even {}, finds it.
      const bound = resolveCallerBinding(wt.main, null, processEra, {});
      expect(bound).toMatchObject({ bound: true, sessionId: SID, era, recordRoot: wt.worktree });
      expect(bound.recordRootIdentity).toMatchObject({ dev: expect.any(Number), ino: expect.any(Number) });
      // A direct local record takes precedence and reports recordRootIdentity null (it's the trusted root itself, not a walked candidate).
      seed(wt.main, { era }, SID);
      const local = resolveCallerBinding(wt.main, null, processEra, {});
      expect(local).toMatchObject({ bound: true, recordRoot: wt.main, recordRootIdentity: null });
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
      delete process.env.CLAUDE_PID;
      processEra.reset();
      wt.cleanup();
    }
  });
});

function realpathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ---------------------------------------------------------------------------
// T-501: the persisted advisory INPUTS and the once-per-session stamp.
// ---------------------------------------------------------------------------

describe("compactSample: usage inputs", () => {
  it("carries the window, its source and the 1M flag, and null when nothing was resolved", () => {
    withRoot((root) => {
      const path = join(root, "t.jsonl");
      writeFileSync(path, growingSession(2, 1000, 100).join(""));
      const s = sampleFor(path, "1:2", 0);
      expect(compactSample(s).usageInput).toEqual({ window: 1_000_000, source: "user", oneMillionFlag: null });
      const none = computeSample({ scan: scanTail({ path, sessionId: SID, era: "1:2", revisionSeen: 0, epochSince: null })!, ceiling: ceiling(), cfg, sampledBy: "query", sampledAt: at(0), record: null, usage: { window: null, source: null, provenance: "none" } });
      expect(compactSample(none).usageInput).toBeNull();
    });
  });
});

describe("consumeUsageAdvisory", () => {
  const slim = (root: string) => intelOf(root).lastSample!;
  const raw = (root: string) => readFileSync(join(root, ".story", "telemetry", "presence", `${presenceFileBase(SID)}.json`), "utf-8");

  function seeded(root: string): { era: string; revision: number } {
    const path = join(root, "t.jsonl");
    writeFileSync(path, growingSession(2, 1000, 100).join(""));
    seed(root, { era: "1:2", revision: 0, incarnation: null, consumedOffset: 0, baselineAnchor: null });
    const s = sampleFor(path, "1:2", 0);
    const outcome = persistSample({ root, sessionId: SID, sample: s, transcriptPath: path, cfg, now: T0, recompute: () => s });
    expect(outcome.status).toBe("accepted");
    return { era: "1:2", revision: intelOf(root).revision };
  }

  it("stamps once, inside the lock, and refuses the second call", () => {
    withRoot((root) => {
      const { era, revision } = seeded(root);
      const first = consumeUsageAdvisory(root, { sessionId: SID, era }, slim(root), revision, T0);
      expect(first.stamped).toBe(true);
      expect(intelOf(root).usageAdvisoryShownAt).toBe(new Date(T0).toISOString());
      const second = consumeUsageAdvisory(root, { sessionId: SID, era }, slim(root), revision, T0 + 1000);
      expect(second.stamped).toBe(false);
      expect(second.reason).toBe("already shown");
      expect(intelOf(root).usageAdvisoryShownAt).toBe(new Date(T0).toISOString());
    });
  });

  it("a stale revision, an era change, a sample mismatch and an ended session all refuse and leave the record byte-identical", () => {
    withRoot((root) => {
      const { era, revision } = seeded(root);
      const before = raw(root);
      expect(consumeUsageAdvisory(root, { sessionId: SID, era }, slim(root), revision + 1, T0).reason).toBe("stale revision");
      expect(consumeUsageAdvisory(root, { sessionId: SID, era: "9:9" }, slim(root), revision, T0).reason).toBe("era changed since the sample");
      expect(consumeUsageAdvisory(root, { sessionId: SID, era: null }, slim(root), revision, T0).reason).toBe("era changed since the sample");
      expect(consumeUsageAdvisory(root, { sessionId: SID, era }, { ...slim(root), sampledAt: at(9) }, revision, T0).reason).toBe("sample replaced since it was read");
      expect(consumeUsageAdvisory(root, { sessionId: SID, era }, { ...slim(root), observation: { ...slim(root).observation, consumedOffset: 7 } }, revision, T0).reason).toBe("sample replaced since it was read");
      expect(raw(root)).toBe(before);
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(1) }));
      expect(consumeUsageAdvisory(root, { sessionId: SID, era }, slim(root), revision, T0).reason).toBe("session has ended");
    });
  });

  it("no record at all: refuses AND leaves the presence file absent (the abort path)", () => {
    withRoot((root) => {
      const path = join(root, "t.jsonl");
      writeFileSync(path, growingSession(2, 1000, 100).join(""));
      const s = compactSample(sampleFor(path, "1:2", 0));
      const file = join(root, ".story", "telemetry", "presence", `${presenceFileBase(SID)}.json`);
      const r = consumeUsageAdvisory(root, { sessionId: SID, era: "1:2" }, s, 0, T0);
      expect(r.stamped).toBe(false);
      expect(r.reason).toBe("no session intel on the record");
      expect(existsSync(file)).toBe(false);
    });
  });

  it("a failed write refuses without consuming the stamp", () => {
    withRoot((root) => {
      const { era, revision } = seeded(root);
      inject.failWrite = true;
      const failed = consumeUsageAdvisory(root, { sessionId: SID, era }, slim(root), revision, T0);
      expect(failed.stamped).toBe(false);
      expect(intelOf(root).usageAdvisoryShownAt).toBeNull();
      // A later call still stamps: nothing was consumed.
      expect(consumeUsageAdvisory(root, { sessionId: SID, era }, slim(root), revision, T0).stamped).toBe(true);
    });
  });

  it("two concurrent callers produce exactly ONE stamp: the lock serializes them", () => {
    withRoot((root) => {
      const { era, revision } = seeded(root);
      const sample = slim(root);
      const results: boolean[] = [];
      // The second caller runs while the first holds the lock, from inside the
      // first's own mutation callback.
      inject.beforeMutate = () => {
        results.push(consumeUsageAdvisory(root, { sessionId: SID, era }, sample, revision, T0 + 500).stamped);
      };
      results.push(consumeUsageAdvisory(root, { sessionId: SID, era }, sample, revision, T0).stamped);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(intelOf(root).usageAdvisoryShownAt).not.toBeNull();
    });
  });

  it("the stamp check must live INSIDE the lock: a stamp that lands between an unlocked read and the lock is honoured, not overwritten", () => {
    withRoot((root) => {
      const { era, revision } = seeded(root);
      const sample = slim(root);
      const racing = at(3);
      const file = join(root, ".story", "telemetry", "presence", `${presenceFileBase(SID)}.json`);
      // Another process stamps in the window a pre-lock check would read
      // through: the record is written directly, exactly as a second process
      // holding the lock for its own turn would have left it.
      inject.beforeCall = () => {
        const record = JSON.parse(readFileSync(file, "utf-8")) as { sessionIntel: Record<string, unknown> };
        record.sessionIntel.usageAdvisoryShownAt = racing;
        writeFileSync(file, JSON.stringify(record));
      };
      const r = consumeUsageAdvisory(root, { sessionId: SID, era }, sample, revision, T0);
      expect(r.stamped).toBe(false);
      expect(r.reason).toBe("already shown");
      expect(intelOf(root).usageAdvisoryShownAt).toBe(racing);
    });
  });
});

describe("ISS-1263: the unbound-era stamp and the emission record", () => {
  it("stampHandover in unbound-era mode lands on a live record whose era is null or differs, writes the same fields as a bound stamp and records the binding", () => {
    withRoot((root) => {
      seed(root, { era: "1:2", lastBoundaryAt: at(1), promptsSinceHandover: 4, lastImperativeAt: at(2), lastImperativeEmittedAt: at(2) });
      expect(stampHandover(root, SID, null, 123, T0, undefined, "unbound-era").status).toBe("written");
      expect(intelOf(root)).toMatchObject({
        handoverWrittenAt: new Date(T0).toISOString(),
        tokensAtHandover: 123,
        handoverBoundaryAt: at(1),
        promptsSinceHandover: 0,
        lastImperativeAt: null,
        handoverStampBinding: "unbound-era",
        // A stamp never resets the rate limit: the two are independent.
        lastImperativeEmittedAt: at(2),
      });
      seed(root, { era: null });
      expect(stampHandover(root, SID, null, 5, T0 + 1000, undefined, "unbound-era").status).toBe("written");
      expect(intelOf(root).handoverStampBinding).toBe("unbound-era");
    });
  });

  it("a bound stamp records its binding; the default mode still refuses a null or mismatched era", () => {
    withRoot((root) => {
      seed(root, { era: "1:2" });
      expect(stampHandover(root, SID, null, 1, T0)).toMatchObject({ status: "refused" });
      expect(stampHandover(root, SID, "9:9", 1, T0)).toMatchObject({ status: "refused" });
      expect(stampHandover(root, SID, "1:2", 1, T0).status).toBe("written");
      expect(intelOf(root).handoverStampBinding).toBe("bound");
    });
  });

  it("unbound-era mode still refuses an ended record and a record without a subtree, and never creates one", () => {
    withRoot((root) => {
      expect(stampHandover(root, SID, null, 1, T0, undefined, "unbound-era")).toMatchObject({ status: "refused" });
      expect(readPresenceRecord(root, SID)?.sessionIntel ?? null).toBeNull();
      seed(root, { era: "1:2" });
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
      expect(stampHandover(root, SID, null, 1, T0, undefined, "unbound-era")).toMatchObject({ status: "refused", reason: expect.stringMatching(/ended/) });
      expect(intelOf(root).handoverWrittenAt).toBeNull();
    });
  });

  it("the boundary resets clear the emission record and the stamp binding with the handover", () => {
    const base: SessionIntelPresence = { ...emptySessionIntel(), era: "1:2", handoverWrittenAt: at(5), tokensAtHandover: 100, handoverStampBinding: "unbound-era", lastImperativeEmittedAt: at(5) };
    expect(applyBoundaryReset(base, at(6))).toMatchObject({ handoverStampBinding: null, lastImperativeEmittedAt: null });
    expect(applyAssumedReset(base, at(6))).toMatchObject({ handoverStampBinding: null, lastImperativeEmittedAt: null });
    // A handover written after the boundary migrates with its binding.
    expect(applyBoundaryReset(base, at(4))).toMatchObject({ handoverStampBinding: "unbound-era", handoverWrittenAt: at(5) });
  });

  it("the stamp binding and the emission record round-trip through the lenient parse; an unknown binding reads null", () => {
    withRoot((root) => {
      seed(root, { era: "1:2", handoverStampBinding: "unbound-era", lastImperativeEmittedAt: at(3) });
      expect(intelOf(root)).toMatchObject({ handoverStampBinding: "unbound-era", lastImperativeEmittedAt: at(3) });
      applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, handoverStampBinding: "sideways" as never, lastImperativeEmittedAt: "not a date" } }));
      expect(intelOf(root)).toMatchObject({ handoverStampBinding: null, lastImperativeEmittedAt: null });
    });
  });

  describe("claimImperativeEmission: the one right to deliver the imperative line", () => {
    const INTERVAL = 600_000;
    const seenOf = (root: string) => { const i = intelOf(root); return { revision: i.revision, lastBoundaryAt: i.lastBoundaryAt, handoverWrittenAt: i.handoverWrittenAt, sampledAt: i.lastSample?.sampledAt ?? null }; };

    it("the first claim writes now; a second inside the interval refuses and writes nothing; at the interval it claims again", () => {
      withRoot((root) => {
        seed(root, { era: "1:2" });
        expect(claimImperativeEmission(root, SID, seenOf(root), T0, INTERVAL)).toBe(true);
        expect(intelOf(root).lastImperativeEmittedAt).toBe(new Date(T0).toISOString());
        expect(claimImperativeEmission(root, SID, seenOf(root), T0 + INTERVAL - 1, INTERVAL)).toBe(false);
        expect(intelOf(root).lastImperativeEmittedAt).toBe(new Date(T0).toISOString());
        expect(claimImperativeEmission(root, SID, seenOf(root), T0 + INTERVAL, INTERVAL)).toBe(true);
        expect(intelOf(root).lastImperativeEmittedAt).toBe(new Date(T0 + INTERVAL).toISOString());
      });
    });

    it("refuses with nothing created for no record and no subtree, and refuses an ended record", () => {
      withRoot((root) => {
        const none = { revision: 0, lastBoundaryAt: null, handoverWrittenAt: null, sampledAt: null };
        expect(claimImperativeEmission(root, SID, none, T0, INTERVAL)).toBe(false);
        expect(readPresenceRecord(root, SID)).toBeNull();
        applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b }));
        expect(claimImperativeEmission(root, SID, none, T0, INTERVAL)).toBe(false);
        expect(readPresenceRecord(root, SID)?.sessionIntel ?? null).toBeNull();
        seed(root, { era: "1:2" });
        applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, endedAt: at(0) }));
        expect(claimImperativeEmission(root, SID, seenOf(root), T0, INTERVAL)).toBe(false);
        expect(intelOf(root).lastImperativeEmittedAt).toBeNull();
      });
    });

    it("acquisition, then a handover stamp, then the claim: refused, nothing written", () => {
      withRoot((root) => {
        seed(root, { era: "1:2" });
        const seen = seenOf(root);
        expect(stampHandover(root, SID, "1:2", 1, T0).status).toBe("written");
        expect(claimImperativeEmission(root, SID, seen, T0 + 1, INTERVAL)).toBe(false);
        expect(intelOf(root).lastImperativeEmittedAt).toBeNull();
      });
    });

    it("acquisition, then a boundary reset, then the claim: refused, and the new epoch's first imperative still claims", () => {
      withRoot((root) => {
        seed(root, { era: "1:2", lastBoundaryAt: at(0) });
        const seen = seenOf(root);
        applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: applyBoundaryReset(b.sessionIntel!, at(1)) }));
        expect(claimImperativeEmission(root, SID, seen, T0 + 1, INTERVAL)).toBe(false);
        expect(intelOf(root).lastImperativeEmittedAt).toBeNull();
        expect(claimImperativeEmission(root, SID, seenOf(root), T0 + 2, INTERVAL)).toBe(true);
      });
    });

    it("a revision bump between acquisition and claim refuses", () => {
      withRoot((root) => {
        seed(root, { era: "1:2", revision: 3 });
        const seen = seenOf(root);
        applyPresenceEnrichment(root, SID, LIFECYCLE_LOCK_BUDGET_MS, "t", (b) => ({ ...b, sessionIntel: { ...b.sessionIntel!, revision: 4 } }));
        expect(claimImperativeEmission(root, SID, seen, T0, INTERVAL)).toBe(false);
        expect(intelOf(root).lastImperativeEmittedAt).toBeNull();
      });
    });

    it("a pending compaction, or a pending listing that cannot rule one out, refuses", () => {
      withRoot((root) => {
        seed(root, { era: "1:2" });
        const seen = seenOf(root);
        markCompactPending(root, SID, { eventId: "p1", era: "1:2", at: at(0) });
        expect(claimImperativeEmission(root, SID, seen, T0, INTERVAL)).toBe(false);
        expect(intelOf(root).lastImperativeEmittedAt).toBeNull();
      });
      withRoot((root) => {
        seed(root, { era: "1:2" });
        const seen = seenOf(root);
        const dir = join(root, ".story", "telemetry", "session-intel-pending", presenceFileBase(SID));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "x.json"), "{}");
        chmodSync(dir, 0o000);
        try {
          expect(claimImperativeEmission(root, SID, seen, T0, INTERVAL)).toBe(false);
        } finally {
          chmodSync(dir, 0o755);
        }
        expect(intelOf(root).lastImperativeEmittedAt).toBeNull();
      });
    });

    it("persistSample never writes the emission record, whoever sampled", () => {
      withRoot((root) => {
        seed(root, { era: "1:2" });
        const tokens = 417_737 - 40_000; // past 0.9 x the ceiling and within 50,000 of it
        const path = writeTranscript(join(root, "projects"), "p", SID, [assistantRecord({ ts: at(0), read: tokens - 2 })]);
        for (const sampledBy of ["prompt-hook", "mcp-refresh", "stop-hook", "query"] as const) {
          const scan = scanTail({ path, sessionId: SID, era: "1:2", revisionSeen: intelOf(root).revision, epochSince: null })!;
          const recompute = (rec: SessionIntelPresence) => computeSample({ scan, ceiling: ceiling(), cfg, sampledBy, sampledAt: at(0), record: rec, usage: USAGE });
          persistSample({ root, sessionId: SID, sample: recompute(intelOf(root)), transcriptPath: path, cfg, now: T0, recompute });
          expect(intelOf(root).lastSample?.state, sampledBy).toBe("imperative");
          expect(intelOf(root).lastImperativeEmittedAt, sampledBy).toBeNull();
        }
      });
    });
  });
});
