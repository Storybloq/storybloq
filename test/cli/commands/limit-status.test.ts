/**
 * T-424: `storybloq limit-status` -- list / cancel / requeue, plus the
 * project-scoped summary helper feeding storybloq_status.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deterministic child-identity control for the cancel path. probeArgvSignature
// and signalWakeChild are partial-mocked so tests can model absent / live-
// killable / identity-unknown children WITHOUT ever sending a real signal to an
// arbitrary pid. h.probe null => delegate to the real implementation.
const h = vi.hoisted(() => ({
  probe: null as null | ((pid: number, markers: readonly string[]) => "match" | "absent" | "unknown"),
  signals: [] as Array<{ pid: number; signal: string }>,
  // Populated by the liveness mock factory so signalWakeChild can gate delivery
  // on the SAME identity source when h.probe is null.
  realProbe: null as null | ((pid: number, markers: readonly string[]) => "match" | "absent" | "unknown"),
}));
vi.mock("../../../src/autonomous/liveness.js", async (orig) => {
  const actual = await orig<typeof import("../../../src/autonomous/liveness.js")>();
  h.realProbe = actual.probeArgvSignature;
  return {
    ...actual,
    probeArgvSignature: (pid: number, markers: readonly string[]) =>
      h.probe ? h.probe(pid, markers) : actual.probeArgvSignature(pid, markers),
  };
});
vi.mock("../../../src/autonomous/wake-claim.js", async (orig) => {
  const actual = await orig<typeof import("../../../src/autonomous/wake-claim.js")>();
  return {
    ...actual,
    // Mirror production signalWakeChild: it delivers ONLY to a POSITIVELY-
    // identified child (hasArgvSignature / probeArgvSignature === "match") and
    // returns false WITHOUT signalling an absent or identity-unknown pid. The
    // mock records a signal only when it would actually be delivered, so tests
    // cannot assert deliveries that the real path never makes.
    signalWakeChild: (pid: number, markers: readonly string[], signal: string) => {
      const identity = h.probe ? h.probe(pid, markers) : h.realProbe?.(pid, markers);
      if (identity !== "match") return false;
      h.signals.push({ pid, signal });
      return true;
    },
  };
});

import { handleLimitStatus } from "../../../src/cli/commands/limit-status.js";
import {
  recordDirectStop,
  readLimitLedger,
  limitRecordKey,
  mutateLimitLedger,
  listLimitStops,
  listLimitStopsForProject,
  type LimitStopInput,
} from "../../../src/core/limit-ledger.js";
import { createSession, writeSessionSync, prepareForLimitStop } from "../../../src/autonomous/session.js";
import { captureProcessSignatureSync } from "../../../src/core/limit-lock.js";
import { spawnSync } from "node:child_process";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

// Process signatures exist only on darwin/linux; elsewhere a live claimant
// resolves to "unknown" (no signature to confirm). A recorded-but-unknown
// claimant is PRESERVED regardless of age -- the wall-clock fallback applies
// ONLY to legacy attempts with no recorded claimant (claimantPid == null).
// SIG_SUPPORTED gates only the cases that need a POSITIVE "alive" identity.
const SIG_SUPPORTED = process.platform === "darwin" || process.platform === "linux";
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;
}
/** Attempt fields for a CONFIRMED-DEAD claimant (drives claimAbandoned by death, not age). */
function deadClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: deadPid(), claimantSignature: null };
}
/** Attempt fields for a LIVE claimant (this test process). */
function liveClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: process.pid, claimantSignature: captureProcessSignatureSync(process.pid) };
}
/**
 * Attempt fields for a claimant whose identity resolves to "unknown" on EVERY
 * platform: a live pid (this process) with no recorded signature, so
 * inspectProcessIdentitySync returns "unknown" (alive, but no signature to
 * confirm). A recorded-but-unknown claimant may still be alive/suspended and
 * must never be abandoned on age.
 */
function unknownClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: process.pid, claimantSignature: null };
}

const TASK_ID = "task-limitstatus-0001";
const KEY = limitRecordKey(TASK_ID);

let root: string;
let globalDir: string;
let savedGlobalDir: string | undefined;

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
}

function baseStop(overrides: Partial<LimitStopInput> = {}): LimitStopInput {
  const now = Date.now();
  return {
    clientTaskId: TASK_ID,
    storybloqSessionId: null,
    projectRoot: root,
    cwd: root,
    sessionType: "plain",
    limitType: "session",
    transcriptPath: null,
    detectedAt: now,
    resetAt: now + 3_600_000,
    resetSource: "absolute",
    rawBanner: null,
    mode: "notify",
    gitHead: null,
    ...overrides,
  };
}

let savedWakerSpawn: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t424-ls-"));
  globalDir = mkdtempSync(join(tmpdir(), "t424-ls-global-"));
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  savedWakerSpawn = process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  // --requeue makes the record immediately due; without this guard the
  // handler would launch a REAL detached waker using the Vitest argv. This env
  // guard ALSO models the global kill switch: spawnWakerIfNeeded is a no-op, so
  // these tests prove the cancel path finishes SYNCHRONOUSLY (never stranded in
  // `cancelling` waiting for a waker that can never start).
  process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = "1";
  h.probe = null;
  h.signals = [];
  setupProject(root);
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  if (savedWakerSpawn === undefined) delete process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  else process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = savedWakerSpawn;
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("limit-status list", () => {
  it("reports an empty queue", async () => {
    const result = await handleLimitStatus();
    expect(result.output).toContain("No pending limit auto-resumes");
    expect(result.errorCode).toBeUndefined();
  });

  it("lists non-terminal records with key, status, and schedule", async () => {
    recordDirectStop(baseStop());
    const result = await handleLimitStatus();
    expect(result.output).toContain(KEY);
    expect(result.output).toContain("stopped");
    expect(result.output).toContain("plain session");
  });

  it("emits JSON when asked", async () => {
    recordDirectStop(baseStop());
    const result = await handleLimitStatus({ format: "json" });
    const parsed = JSON.parse(result.output) as { ok: boolean; data: { limitStops: Array<{ key: string }> } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.limitStops[0]?.key).toBe(KEY);
  });

  it("hides terminal records", async () => {
    recordDirectStop(baseStop());
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.status = "notified";
      return true;
    });
    const result = await handleLimitStatus();
    expect(result.output).toContain("No pending limit auto-resumes");
  });

  it("ISS-944 test 8c: --recent surfaces a terminal defer_exhausted record that the default listing hides", async () => {
    recordDirectStop(baseStop());
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "failed";
      rec.reasonCode = "defer_exhausted";
      rec.updatedAt = Date.now();
      return true;
    });

    const withoutFlag = await handleLimitStatus();
    expect(withoutFlag.output).toContain("No pending limit auto-resumes");

    const withFlag = await handleLimitStatus({ recent: true });
    expect(withFlag.output).toContain(KEY);
    expect(withFlag.output).toContain("defer_exhausted");
  });
});

describe("limit-status --cancel", () => {
  it("reports unknown keys", async () => {
    const result = await handleLimitStatus({ cancel: "claude:nope" });
    expect(result.errorCode).toBe("not_found");
  });

  it("cancels a plain record with no live child", async () => {
    recordDirectStop(baseStop());
    const result = await handleLimitStatus({ cancel: TASK_ID }); // bare id accepted
    expect(result.errorCode).toBeUndefined();
    expect(result.output).toContain("Cancelled");
    expect(readLimitLedger().records[KEY]?.status).toBe("cancelled");
  });

  it("cancels an autonomous record and clears the session interruption", async () => {
    const session = createSession(root, "coding", realpathSync(root));
    const sessDir = join(root, ".story", "sessions", session.sessionId);
    const state = writeSessionSync(sessDir, {
      ...session,
      state: "IMPLEMENT",
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as FullSessionState);
    const up = recordDirectStop(baseStop({
      storybloqSessionId: state.sessionId,
      sessionType: "autonomous",
      mode: "headless",
    }));
    prepareForLimitStop(sessDir, JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState, {
      permissionMode: null, resumeAt: Date.now() + 3_600_000, limitEventId: up.limitEventId,
    });

    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.output).toContain("Cancelled");
    expect(readLimitLedger().records[KEY]?.status).toBe("cancelled");

    const cleared = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    // Cancellation DOWNGRADES the limit park to an ordinary compact park so the
    // session stays recoverable -- compactPending stays true (never stranded as
    // COMPACT-but-not-pending); only the limit-specific fields are cleared.
    expect(cleared.compactPending).toBe(true);
    expect(cleared.state).toBe("COMPACT");
    expect(cleared.interruptionKind).toBeNull();
    expect(cleared.limitStopPending).toBe(false);
    expect(cleared.limitEventId).toBeNull();
  });

  it("rejects cancelling a terminal record", async () => {
    recordDirectStop(baseStop());
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.status = "cancelled";
      return true;
    });
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.errorCode).toBe("invalid_input");
  });

  it("leaves a resuming record with a NULL-childPid attempt in cancelling (claim-to-spawn window)", async () => {
    // The waker claimed but has not recorded a child yet: a spawn may still
    // materialize. Cancellation must NOT terminalize or clear session state --
    // it stands the record down to `cancelling` and the waker finishes it.
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-inflight", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.errorCode).toBeUndefined();
    expect(result.output).toContain("mid-spawn");
    const rec = readLimitLedger().records[KEY]!;
    expect(rec.status).toBe("cancelling"); // NOT cancelled
    expect(rec.attempt?.id).toBe("wa-inflight");
  });

  it("completes synchronously when a null-childPid claim's CLAIMANT is confirmed dead (crashed without spawning)", async () => {
    // A null-childPid attempt whose claimant is CONFIRMED DEAD is abandoned: no
    // child will ever materialize (a live child carries a concrete pid). The
    // cancel must terminalize HERE -- never rely on a waker that the kill switch
    // may keep from starting, which would strand it `cancelling`. Positive
    // death evidence, not wall-clock age, drives this.
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-stale", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        lastProgressAt: Date.now(), // FRESH age -- death, not age, is what completes it
        ...deadClaimant(),
      };
      return true;
    });
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.errorCode).toBeUndefined();
    expect(result.output).not.toContain("mid-spawn");
    const rec = readLimitLedger().records[KEY]!;
    expect(rec.status).toBe("cancelled");
    expect(rec.attempt).toBeNull();
    expect(h.signals).toHaveLength(0); // no child to signal
  });

  it("does NOT complete a null-childPid cancel while a SUSPENDED (alive) claimant could still spawn, even past the stale age", async () => {
    if (!SIG_SUPPORTED) return; // requires a positive "alive" identity
    // A claimant that is alive but aged past CLAIM_SPAWN_STALE_MS (suspended,
    // e.g. across laptop sleep) may still resume and spawn a child. The cancel
    // must NOT terminalize on age alone -- it stays `cancelling` (retry later).
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-suspended", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        lastProgressAt: Date.now() - 130_000, // aged, but claimant alive
        ...liveClaimant(),
      };
      return true;
    });
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.output).toContain("mid-spawn");
    const rec = readLimitLedger().records[KEY]!;
    expect(rec.status).toBe("cancelling"); // NOT cancelled
    expect(rec.attempt?.id).toBe("wa-suspended");
  });

  it("does NOT complete a null-childPid cancel while claimant identity is UNKNOWN, even past the stale age (all platforms)", async () => {
    // Identity is "unknown" on a platform with no process signature, or after a
    // transient signature/proc-inspection failure. A recorded claimant whose
    // identity is unknown may still be alive/suspended -- age must NOT abandon
    // it, or a resumed claimant would spawn an untracked child. Platform-
    // independent: unknownClaimant resolves "unknown" everywhere.
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-unknown", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        lastProgressAt: Date.now() - 130_000, // aged, identity unknown
        ...unknownClaimant(),
      };
      return true;
    });
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.output).toContain("mid-spawn");
    const rec = readLimitLedger().records[KEY]!;
    expect(rec.status).toBe("cancelling"); // NOT cancelled -- age never overrides a recorded claimant
    expect(rec.attempt?.id).toBe("wa-unknown");
  });

  function seedLiveChild(childPid: number): void {
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-live", token: "t", generation: rec.generation,
        childPid, spawnedAt: Date.now(), transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });
  }

  it("completes synchronously when the child is already absent (no waker needed)", async () => {
    // Confirmed-absent pid: the CLI cancel must terminalize HERE (no signal, no
    // stuck `cancelling`) even though waker spawning is disabled (kill-switch).
    h.probe = () => "absent";
    seedLiveChild(4242);
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.errorCode).toBeUndefined();
    const rec = readLimitLedger().records[KEY]!;
    expect(rec.status).toBe("cancelled");
    expect(rec.attempt).toBeNull();
    expect(h.signals).toHaveLength(0); // nothing to signal
  });

  it("SIGTERMs a live killable child, confirms death, and completes synchronously", async () => {
    // Live until signalled, then absent: SIGTERM is delivered, death confirmed,
    // and the cancel completes without any waker.
    h.probe = (pid) => (h.signals.some((s) => s.pid === pid) ? "absent" : "match");
    seedLiveChild(4242);
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.errorCode).toBeUndefined();
    expect(h.signals.some((s) => s.pid === 4242 && s.signal === "SIGTERM")).toBe(true);
    const rec = readLimitLedger().records[KEY]!;
    expect(rec.status).toBe("cancelled");
    expect(rec.attempt).toBeNull();
  });

  it("blocks the cancel (attempt preserved, no signal to an unidentified pid) when death cannot be confirmed", async () => {
    // Identity-unknown throughout: the child's argv never matches, so -- exactly
    // like production's hasArgvSignature gate -- NO signal is ever delivered to
    // the unidentified pid, and death cannot be confirmed. The cancel stands
    // down to manual/cancellation_blocked with the attempt evidence PRESERVED,
    // synchronously (never stuck `cancelling`), even with waker spawning off.
    h.probe = () => "unknown";
    seedLiveChild(4242);
    const result = await handleLimitStatus({ cancel: KEY });
    expect(result.errorCode).toBe("invalid_input");
    expect(result.output).toContain("4242");
    const rec = readLimitLedger().records[KEY]!;
    expect(rec.status).toBe("manual");
    expect(rec.reasonCode).toBe("cancellation_blocked");
    expect(rec.attempt?.childPid).toBe(4242);
    // No signal is delivered to a pid we cannot positively identify as our child.
    expect(h.signals).toHaveLength(0);
  });
});

describe("limit-status --requeue", () => {
  it("returns a manual record to the queue with attempts reset", async () => {
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "manual";
      rec.reasonCode = "bypass_not_opted_in";
      rec.wakeAttempts = 4;
      return true;
    });

    const result = await handleLimitStatus({ requeue: KEY });
    expect(result.errorCode).toBeUndefined();
    const rec = readLimitLedger().records[KEY];
    expect(rec?.status).toBe("stopped");
    expect(rec?.wakeAttempts).toBe(0);
    expect(rec?.reasonCode).toBeNull();
  });

  it("rejects requeueing a dispatchable record", async () => {
    recordDirectStop(baseStop());
    const result = await handleLimitStatus({ requeue: KEY });
    expect(result.errorCode).toBe("invalid_input");
  });

  it("refuses to requeue a blocked cancellation whose child evidence still stands", async () => {
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "manual";
      rec.reasonCode = "cancellation_blocked";
      rec.attempt = {
        id: "wa-blocked", token: "t", generation: rec.generation,
        childPid: 4_040, spawnedAt: Date.now() - 60_000, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now() - 60_000,
      };
      return true;
    });

    const result = await handleLimitStatus({ requeue: KEY });
    expect(result.errorCode).toBe("invalid_input");
    expect(result.output).toContain("4040");
    expect(result.output).toContain("refused");
    const rec = readLimitLedger().records[KEY];
    expect(rec?.status).toBe("manual");
    expect(rec?.attempt?.childPid).toBe(4_040);
  });

  it("rejects --cancel combined with --requeue", async () => {
    const result = await handleLimitStatus({ cancel: KEY, requeue: KEY });
    expect(result.errorCode).toBe("invalid_input");
  });
});

describe("listLimitStopsForProject", () => {
  it("filters by project root, tolerating symlinked path variance", async () => {
    recordDirectStop(baseStop({ projectRoot: realpathSync(root) }));
    const other = mkdtempSync(join(tmpdir(), "t424-ls-other-"));
    try {
      recordDirectStop(baseStop({ clientTaskId: "task-elsewhere", projectRoot: other }));

      expect(listLimitStops()).toHaveLength(2);
      const forRoot = listLimitStopsForProject(root); // non-realpath'd input
      expect(forRoot).toHaveLength(1);
      expect(forRoot[0]?.key).toBe(KEY);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("matches records stored under a symlinked project root when queried by the real path (and vice versa)", async () => {
    // A real directory plus a symlink pointing at it. The ledger stores one
    // form; the query uses the other. Both must resolve to the same record via
    // realpath canonicalization, not raw string equality.
    const realDir = mkdtempSync(join(tmpdir(), "t424-ls-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "t424-ls-link-"));
    const linkDir = join(linkParent, "alias");
    symlinkSync(realDir, linkDir);
    try {
      // Store under the SYMLINK path; query by the REAL path.
      recordDirectStop(baseStop({ clientTaskId: "task-symlinked", projectRoot: linkDir }));
      const bySymlinkKey = limitRecordKey("task-symlinked");

      const byReal = listLimitStopsForProject(realDir);
      expect(byReal.map((r) => r.key)).toContain(bySymlinkKey);

      // And the reverse: query by the symlink path finds it too.
      const byLink = listLimitStopsForProject(linkDir);
      expect(byLink.map((r) => r.key)).toContain(bySymlinkKey);
    } finally {
      // Remove the link's own parent directly; join(linkDir, "..") would
      // traverse THROUGH the symlink to realDir's parent (and fail to resolve
      // once the target is gone), leaking linkParent.
      await rm(realDir, { recursive: true, force: true });
      await rm(linkParent, { recursive: true, force: true });
    }
  });
});
