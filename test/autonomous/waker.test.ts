/**
 * T-424: The limit waker -- dispatch matrix, supervision, notify moments,
 * fallback reparse, singleton, and opportunistic respawn.
 *
 * wakerTick is driven directly with injected deps (no real spawns, no sleeps).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, realpathSync, rmSync, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ on: () => {}, unref: () => {}, pid: 55_555 })),
  };
});

import { spawn } from "node:child_process";
import {
  wakerTick,
  runWaker,
  spawnWakerIfNeeded,
  readSessionSnapshot,
  WAKER_ARGV_SENTINEL,
  BLOCKED_GRACE_MS,
  CLAIM_SPAWN_STALE_MS,
  type WakerDeps,
} from "../../src/autonomous/waker.js";
import {
  createSession,
  writeSessionSync,
  prepareForLimitStop,
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import {
  recordDirectStop,
  readLimitLedger,
  limitRecordKey,
  mutateLimitLedger,
  wakerLockPath,
  DEFER_BACKOFF_MS,
  DEDUPE_WINDOW_MS,
  MAX_DEFER_COUNT,
  type LimitRecord,
  type LimitStopInput,
} from "../../src/core/limit-ledger.js";
import { acquireLimitLock, releaseLimitLock, renewLimitLock, captureProcessSignatureSync } from "../../src/core/limit-lock.js";
import { safeUnlinkLock } from "../../src/autonomous/liveness.js";
import { spawnSync } from "node:child_process";
import { readWakeClaim, wakeClaimPath } from "../../src/autonomous/wake-claim.js";
import { telemetryDirPath, newHeartbeatGenerationId } from "../../src/autonomous/liveness.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

// Signatures exist only on darwin/linux; elsewhere a live claimant resolves to
// "unknown" (no signature to confirm). A recorded-but-unknown claimant is
// PRESERVED regardless of age -- the wall-clock fallback applies ONLY to legacy
// attempts with no recorded claimant (claimantPid == null). SIG_SUPPORTED gates
// only the cases that need a POSITIVE "alive" identity.
const SIG_SUPPORTED = process.platform === "darwin" || process.platform === "linux";
/** A pid that is certainly dead (a child that already exited) -> claimant confirmed dead. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid!;
}
/** Attempt identity fields for a CONFIRMED-DEAD claimant (drives claimAbandoned by death, not age). */
function deadClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: deadPid(), claimantSignature: null };
}
/** Attempt identity fields for a LIVE claimant (this test process) -- never abandoned on SIG platforms. */
function liveClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: process.pid, claimantSignature: captureProcessSignatureSync(process.pid) };
}
/**
 * Attempt identity fields whose identity resolves to "unknown" on EVERY platform
 * (a live pid with no recorded signature). A recorded-but-unknown claimant may
 * still be alive/suspended and must never be abandoned on age.
 */
function unknownClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: process.pid, claimantSignature: null };
}

const mockedSpawn = vi.mocked(spawn);

const TASK_ID = "task-waker-0001";
const KEY = limitRecordKey(TASK_ID);

let root: string;
let globalDir: string;
let savedGlobalDir: string | undefined;

function setupProject(dir: string, config: Record<string, unknown> = {}): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...config,
  }));
}

function makeWorkingSession(dir: string, overrides: Partial<FullSessionState> = {}): { state: FullSessionState; sessDir: string } {
  const session = createSession(dir, "coding", realpathSync(dir));
  const sessDir = join(dir, ".story", "sessions", session.sessionId);
  const state = writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
    ...overrides,
  } as FullSessionState);
  return { state, sessDir };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

function record(key = KEY): LimitRecord | undefined {
  return readLimitLedger().records[key] as LimitRecord | undefined;
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
    resetAt: now - 1_000, // due immediately
    resetSource: "absolute",
    rawBanner: null,
    mode: "notify",
    gitHead: null,
    ...overrides,
  };
}

/** Create a parked autonomous session + matching headless ledger record. */
function makeAutonomousStop(opts: {
  permissionMode?: string | null;
  resetAt?: number;
  sessionOverrides?: Partial<FullSessionState>;
  transcriptPath?: string | null;
} = {}): { state: FullSessionState; sessDir: string; rec: LimitRecord } {
  const { state, sessDir } = makeWorkingSession(root, opts.sessionOverrides ?? {});
  const resetAt = opts.resetAt ?? Date.now() - 1_000;
  const up = recordDirectStop(baseStop({
    storybloqSessionId: state.sessionId,
    sessionType: "autonomous",
    mode: "headless",
    resetAt,
    transcriptPath: opts.transcriptPath ?? null,
  }));
  prepareForLimitStop(sessDir, readState(sessDir), {
    expectedHead: "abc123",
    permissionMode: opts.permissionMode ?? "acceptEdits",
    resumeAt: resetAt,
    limitEventId: up.limitEventId,
  });
  return { state, sessDir, rec: record()! };
}

interface TestDeps extends WakerDeps {
  spawns: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
  notifications: string[];
  signals: Array<{ pid: number | null | undefined; markers: readonly string[]; signal?: string }>;
}

/**
 * Default child model: `alivePids` are live ("match") until signalled (a
 * signal kills them, so terminateConfirmed sees a clean "absent" death).
 * `unkillablePids` ignore every signal (stay "match"). `unknownPids` model an
 * uninspectable-but-existing process (tri-state "unknown"): the pid exists so
 * supervision must treat it as possibly-alive, never as confirmed death.
 *
 * probeChild and isChildAlive are kept CONSISTENT: an `isChildAlive` override
 * (used by older tests) synthesizes a matching two-state probeChild unless the
 * test overrides probeChild explicitly.
 */
function makeDeps(
  overrides: Partial<WakerDeps> = {},
  opts: { alivePids?: number[]; unkillablePids?: number[]; unknownPids?: number[] } = {},
): TestDeps {
  const spawns: TestDeps["spawns"] = [];
  const notifications: string[] = [];
  const signals: TestDeps["signals"] = [];
  const alive = new Set(opts.alivePids ?? []);
  const unkillable = new Set(opts.unkillablePids ?? []);
  const unknown = new Set(opts.unknownPids ?? []);
  const defaultProbe = (pid: number): "match" | "absent" | "unknown" =>
    unknown.has(pid) ? "unknown" : alive.has(pid) || unkillable.has(pid) ? "match" : "absent";
  const isChildAlive: WakerDeps["isChildAlive"] =
    overrides.isChildAlive ?? ((pid) => defaultProbe(pid) === "match");
  const probeChild: WakerDeps["probeChild"] =
    overrides.probeChild ??
    (overrides.isChildAlive
      ? (pid, markers) => (isChildAlive(pid, markers) ? "match" : "absent")
      : (pid) => defaultProbe(pid));
  const signalChild: WakerDeps["signalChild"] =
    overrides.signalChild ??
    ((pid, markers, signal) => {
      signals.push({ pid, markers, signal });
      if (pid != null) alive.delete(pid);
      return true;
    });
  return {
    now: () => Date.now(),
    sleep: async () => {},
    spawnChild: (cmd, args, opts2) => {
      spawns.push({ cmd, args, cwd: opts2.cwd, env: opts2.env });
      return { pid: 4_242 };
    },
    detectClaude: () => "2.1.0",
    notify: (message) => {
      notifications.push(message);
    },
    ...overrides,
    isChildAlive,
    probeChild,
    signalChild,
    spawns,
    notifications,
    signals,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t424-waker-"));
  globalDir = mkdtempSync(join(tmpdir(), "t424-waker-global-"));
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  setupProject(root);
  // vi.restoreAllMocks() wipes vi.fn factory implementations; re-prime each test.
  mockedSpawn.mockReset();
  mockedSpawn.mockImplementation((() => ({ on: () => {}, unref: () => {}, pid: 55_555 })) as never);
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Notify-mode dispatch
// ---------------------------------------------------------------------------

describe("wakerTick notify dispatch", () => {
  it("notifies a due plain record and settles it notified", async () => {
    recordDirectStop(baseStop());
    const deps = makeDeps();
    const result = await wakerTick(deps);

    expect(deps.notifications).toHaveLength(1);
    expect(deps.notifications[0]).toContain(`claude --resume ${TASK_ID}`);
    expect(deps.spawns).toHaveLength(0);
    expect(record()?.status).toBe("notified");
    expect(result.remaining).toBe(0); // waker may exit
  });

  it("uses the finalize wording for finalize_stop records", async () => {
    const { state, sessDir } = makeWorkingSession(root, { state: "FINALIZE" });
    const up = recordDirectStop(baseStop({
      storybloqSessionId: state.sessionId,
      sessionType: "autonomous",
      mode: "notify",
      reasonCode: "finalize_stop",
    }));
    prepareForLimitStop(sessDir, readState(sessDir), {
      permissionMode: null, resumeAt: Date.now() - 1_000, limitEventId: up.limitEventId,
    });

    const deps = makeDeps();
    await wakerTick(deps);
    expect(deps.notifications[0]).toContain("mid-finalize");
    expect(deps.notifications[0]).toContain("clear-compact");
    expect(record()?.status).toBe("notified");
  });

  it("suppresses notifications when the project disables notify", async () => {
    setupProject(root, { limitResume: { notify: false } });
    recordDirectStop(baseStop());
    const deps = makeDeps();
    await wakerTick(deps);
    expect(deps.notifications).toHaveLength(0);
    expect(record()?.status).toBe("notified"); // still settled
  });

  it("skips records whose project disabled limitResume entirely", async () => {
    setupProject(root, { limitResume: { enabled: false } });
    recordDirectStop(baseStop());
    const deps = makeDeps();
    await wakerTick(deps);
    expect(record()?.status).toBe("stopped"); // untouched
    expect(deps.notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Headless dispatch (plain + autonomous)
// ---------------------------------------------------------------------------

describe("wakerTick headless dispatch", () => {
  it("spawns a plain headless resume with no permission flags", async () => {
    recordDirectStop(baseStop({ mode: "headless" }));
    const deps = makeDeps();
    const result = await wakerTick(deps);

    expect(result.spawnedKeys).toEqual([KEY]);
    expect(deps.spawns).toHaveLength(1);
    const call = deps.spawns[0]!;
    expect(call.cmd).toBe("claude");
    expect(call.args.slice(0, 3)).toEqual(["-p", "--resume", TASK_ID]);
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    expect(call.args).not.toContain("--permission-mode");

    const rec = record();
    expect(rec?.status).toBe("resuming");
    expect(rec?.wakeAttempts).toBe(1);
    expect(rec?.attempt?.childPid).toBe(4_242);
  });

  it("wakes a parked autonomous session with the guide prompt, posture flag, env token, and wake claim", async () => {
    const { state, sessDir } = makeAutonomousStop({ permissionMode: "acceptEdits" });
    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(1);
    const call = deps.spawns[0]!;
    expect(call.args.slice(0, 3)).toEqual(["-p", "--resume", TASK_ID]);
    const prompt = call.args[3]!;
    expect(prompt).toContain("storybloq_autonomous_guide");
    expect(prompt).toContain(state.sessionId);
    expect(call.args).toContain("--permission-mode");
    expect(call.args).toContain("acceptEdits");
    expect(call.cwd).toBe(root);

    const rec = record();
    expect(rec?.status).toBe("resuming");
    const envToken = call.env.STORYBLOQ_WAKE_ATTEMPT;
    expect(envToken).toBe(`${rec?.attempt?.id}.${rec?.attempt?.token}`);

    const claim = readWakeClaim(sessDir);
    expect(claim?.attemptId).toBe(rec?.attempt?.id);
    expect(claim?.childPid).toBe(4_242);
    expect(claim?.generation).toBe(rec?.generation);
  });

  it("marks a manually-resumed session resumed without spawning", async () => {
    const { sessDir } = makeAutonomousStop();
    // The user resumed: the session left COMPACT before the waker fired.
    const current = readState(sessDir);
    writeSessionSync(sessDir, {
      ...current,
      state: "IMPLEMENT",
      compactPending: false,
      interruptionKind: null,
      limitStopPending: false,
      limitResumeAt: null,
      limitPermissionMode: null,
      limitEventId: null,
    } as FullSessionState);

    const deps = makeDeps();
    await wakerTick(deps);
    expect(deps.spawns).toHaveLength(0);
    expect(record()?.status).toBe("resumed");
  });

  it("stands a bypass-posture session down to manual without the opt-in", async () => {
    makeAutonomousStop({ permissionMode: "bypassPermissions" });
    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0);
    const rec = record();
    expect(rec?.status).toBe("manual");
    expect(rec?.reasonCode).toBe("bypass_not_opted_in");
    expect(deps.notifications[0]).toContain("inheritBypass");
  });

  it("passes --dangerously-skip-permissions when the project opted in", async () => {
    setupProject(root, { limitResume: { inheritBypass: true } });
    makeAutonomousStop({ permissionMode: "bypassPermissions" });
    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(1);
    expect(deps.spawns[0]!.args).toContain("--dangerously-skip-permissions");
  });

  it("defers (with notification) when a live client still owns the session", async () => {
    const { sessDir } = makeAutonomousStop();
    const tDir = telemetryDirPath(sessDir);
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "alive"), String(Date.now()));

    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0);
    const rec = record();
    expect(rec?.status).toBe("deferred");
    expect(rec?.nextAttemptAt).toBeGreaterThan(Date.now() + DEFER_BACKOFF_MS[0]! - 5_000);
    expect(deps.notifications[0]).toContain("still open in a terminal");
  });

  // T-450 step 7b.4: after an owner-gone takeover the session is bound to a
  // heartbeat GENERATION, and the legacy directory keeps the DEAD owner's
  // leftovers. A waker that still reads legacy judges the live REPLACEMENT owner
  // absent and spawns a second resume against a session someone is actively
  // driving -- the double-driving hazard T-450 exists to prevent, through the
  // back door.
  it("defers when the live heartbeat is in the session's GENERATION, not the legacy directory", async () => {
    const generation = newHeartbeatGenerationId();
    const { sessDir } = makeAutonomousStop({ sessionOverrides: { heartbeatGeneration: generation } as any });
    const gDir = join(telemetryDirPath(sessDir), "generations", generation);
    mkdirSync(gDir, { recursive: true });
    writeFileSync(join(gDir, "alive"), String(Date.now()));
    // Legacy is silent: the displaced owner left nothing behind.
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });

    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0);
    expect(record()?.status).toBe("deferred");
    expect(deps.notifications[0]).toContain("still open in a terminal");
  });

  // A read fault is not evidence of absence. Failing OPEN here spawns a
  // duplicate driver, which is unrecoverable; declining to spawn is not.
  it("fails CLOSED when the owner heartbeat cannot be read at all", async () => {
    const { sessDir } = makeAutonomousStop({ sessionOverrides: { heartbeatGeneration: "not-a-generation" } as any });
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });
    // A legacy heartbeat that a fallback would have consulted -- and it belongs
    // to the DISPLACED owner, which is why there is no fallback.
    writeFileSync(join(telemetryDirPath(sessDir), "alive"), String(Date.now()));

    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0);
    expect(record()?.status).toBe("deferred");
    // Its OWN words. Reusing the live-client message would assert liveness from
    // evidence that could not be read.
    expect(deps.notifications[0]).not.toContain("still open in a terminal");
    expect(deps.notifications[0]).toContain("heartbeat");
  });

  it("stands down to manual with its own reason when unreadable telemetry outlasts the grace", async () => {
    const resetAt = Date.now() - BLOCKED_GRACE_MS - 60_000;
    const { sessDir } = makeAutonomousStop({
      resetAt,
      sessionOverrides: { heartbeatGeneration: "not-a-generation" } as any,
    });
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });

    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0);
    const rec = record();
    expect(rec?.status).toBe("manual");
    expect(rec?.reasonCode).toBe("telemetry_unreadable");
    expect(deps.notifications[0]).not.toContain("still open in a terminal");
  });

  it("stands down to manual when still blocked past the post-reset grace", async () => {
    const resetAt = Date.now() - BLOCKED_GRACE_MS - 60_000;
    const { sessDir } = makeAutonomousStop({ resetAt });
    const tDir = telemetryDirPath(sessDir);
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "alive"), String(Date.now()));

    const deps = makeDeps();
    await wakerTick(deps);

    const rec = record();
    expect(rec?.status).toBe("manual");
    expect(rec?.reasonCode).toBe("blocked_client");
    expect(deps.notifications[0]).toContain("--requeue");
  });

  it("defers when the claude CLI is missing", async () => {
    makeAutonomousStop();
    const deps = makeDeps({ detectClaude: () => null });
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0);
    expect(record()?.status).toBe("deferred");
    expect(deps.notifications[0]).toContain("claude CLI was not found");
  });

  it("fails the record with gave-up notification once attempts are exhausted", async () => {
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.wakeAttempts = 5;
      return true;
    });

    const deps = makeDeps();
    await wakerTick(deps);
    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("attempts_exhausted");
    expect(deps.notifications[0]).toContain("Gave up");
  });

  it("respects maxConcurrent counted against live children", async () => {
    setupProject(root, { limitResume: { maxConcurrent: 1, plainMode: "headless" } });
    // One record already resuming with a LIVE child...
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-live", token: "t", generation: rec.generation,
        childPid: 999, spawnedAt: Date.now(), transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });
    // ...and a second due record in the same project.
    const otherKey = limitRecordKey("task-waker-0002");
    recordDirectStop(baseStop({ clientTaskId: "task-waker-0002", mode: "headless" }));

    const deps = makeDeps({ isChildAlive: (pid) => pid === 999 });
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0); // slot occupied by the live child
    expect(record(otherKey)?.status).toBe("stopped");
  });

  it("an IDENTITY-UNKNOWN existing child still consumes a maxConcurrent slot", async () => {
    // A tri-state "unknown" probe (pid exists, argv unreadable) is NOT confirmed
    // death: the child is possibly-alive, so it must count against maxConcurrent
    // exactly like a "match". Treating it as absent would over-dispatch beside a
    // live resume.
    setupProject(root, { limitResume: { maxConcurrent: 1, plainMode: "headless" } });
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-unknown", token: "t", generation: rec.generation,
        childPid: 999, spawnedAt: Date.now(), transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });
    const otherKey = limitRecordKey("task-waker-0002");
    recordDirectStop(baseStop({ clientTaskId: "task-waker-0002", mode: "headless" }));

    // 999 is uninspectable-but-existing: probeChild -> "unknown".
    const deps = makeDeps({}, { unknownPids: [999] });
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0); // slot held by the possibly-live child
    expect(record(otherKey)?.status).toBe("stopped");
    // The unknown child's attempt is untouched -- never treated as dead.
    expect(record()?.attempt?.childPid).toBe(999);
    expect(record()?.status).toBe("resuming");
  });

  it("a not-confirmed-dead null-PID claim (about to spawn) holds a maxConcurrent slot regardless of age", async () => {
    // A claim whose child has not spawned yet (childPid null) but whose CLAIMANT
    // is NOT confirmed dead -- alive on signature platforms, "unknown" elsewhere,
    // even aged past the stale window (e.g. a suspended waker) -- will still
    // materialize a child. Counting it as a free slot would let a second child
    // spawn beside the one about to exist and exceed maxConcurrent. The claim is
    // kept AGED on EVERY platform: an aged recorded claimant is abandoned only on
    // confirmed death, so both alive and unknown identities hold the slot.
    setupProject(root, { limitResume: { maxConcurrent: 1, plainMode: "headless" } });
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-claim", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        // aged past the stale window, but the claimant is not confirmed dead.
        lastProgressAt: Date.now() - (CLAIM_SPAWN_STALE_MS + 60_000),
        ...(SIG_SUPPORTED ? liveClaimant() : unknownClaimant()),
      };
      return true;
    });
    const otherKey = limitRecordKey("task-waker-0002");
    recordDirectStop(baseStop({ clientTaskId: "task-waker-0002", mode: "headless" }));

    const deps = makeDeps({});
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0); // slot held by the about-to-spawn claim
    expect(record(otherKey)?.status).toBe("stopped");
    // The claim is untouched (fresh, deferred by supervision).
    expect(record()?.attempt?.id).toBe("wa-claim");
  });

  it("a NON-resuming record's live child (cancelling) still holds a maxConcurrent slot", async () => {
    // A live wake child occupies a slot regardless of the record's status: a
    // cancelling/interactive/manual-blocked record can still name a running
    // child. Counting only `resuming` under-counts and over-dispatches beside it.
    setupProject(root, { limitResume: { maxConcurrent: 1, plainMode: "headless" } });
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "cancelling";
      rec.attempt = {
        id: "wa-cancel", token: "t", generation: rec.generation,
        childPid: 999, spawnedAt: Date.now(), transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });
    const otherKey = limitRecordKey("task-waker-0002");
    recordDirectStop(baseStop({ clientTaskId: "task-waker-0002", mode: "headless" }));

    // 999 is live and unkillable, so finish-cancel cannot confirm its death:
    // it blocks the cancel (-> manual/cancellation_blocked) but PRESERVES the
    // attempt naming the live child, which must still hold a slot.
    const deps = makeDeps({}, { unkillablePids: [999] });
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(0); // slot held by the blocked-cancel record's live child
    expect(record(otherKey)?.status).toBe("stopped");
    expect(record()?.status).toBe("manual");
    expect(record()?.reasonCode).toBe("cancellation_blocked");
    expect(record()?.attempt?.childPid).toBe(999);
  });

  it("counts maxConcurrent PER PROJECT: a busy project never starves another project's queue", async () => {
    setupProject(root, { limitResume: { maxConcurrent: 1, plainMode: "headless" } });
    // Project A: slot occupied by a live child.
    recordDirectStop(baseStop({ mode: "headless" }));
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-live", token: "t", generation: rec.generation,
        childPid: 999, spawnedAt: Date.now(), transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });
    // Project B: its own config, its own due record, zero live children.
    const rootB = mkdtempSync(join(tmpdir(), "t424-waker-b-"));
    try {
      setupProject(rootB, { limitResume: { maxConcurrent: 1, plainMode: "headless" } });
      const keyB = limitRecordKey("task-waker-projb");
      recordDirectStop(baseStop({
        clientTaskId: "task-waker-projb", mode: "headless", projectRoot: rootB, cwd: rootB,
      }));

      const deps = makeDeps({ isChildAlive: (pid) => pid === 999 });
      await wakerTick(deps);

      // Project B dispatched despite project A's occupied slot.
      expect(deps.spawns).toHaveLength(1);
      expect(deps.spawns[0]!.cwd).toBe(rootB);
      expect(record(keyB)?.status).toBe("resuming");
      expect(record()?.status).toBe("resuming"); // A untouched, still its live child
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("wakes a plan-posture session in plan mode (posture preserved, never widened)", async () => {
    makeAutonomousStop({ permissionMode: "plan" });
    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(1);
    const args = deps.spawns[0]!.args;
    const i = args.indexOf("--permission-mode");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("plan");
  });

  it("plain headless children carry the attempt env token and argv sentinel", async () => {
    recordDirectStop(baseStop({ mode: "headless" }));
    const deps = makeDeps();
    await wakerTick(deps);

    expect(deps.spawns).toHaveLength(1);
    const call = deps.spawns[0]!;
    const attemptId = record()?.attempt?.id;
    expect(attemptId).toBeTruthy();
    expect(call.env.STORYBLOQ_WAKE_ATTEMPT?.startsWith(`${attemptId}.`)).toBe(true);
    // The prompt (argv) embeds the attempt sentinel, making the child
    // identity-verifiable without a wake claim.
    expect(call.args.some((a) => a.includes(`[storybloq-wake ${attemptId}]`))).toBe(true);
  });

  it("terminates the child when the record moved between claim and spawn (no untracked orphan)", async () => {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() - 1_000 });
    // Simulate an interactive takeover that lands EXACTLY between the waker's
    // spawn and its recordAttemptSpawn CAS: spawnChild flips the record.
    const deps = makeDeps({
      spawnChild: (cmd, args, opts2) => {
        deps.spawns.push({ cmd, args, cwd: opts2.cwd, env: opts2.env });
        mutateLimitLedger((ledger) => {
          const rec = ledger.records[KEY]!;
          rec.status = "interactive";
          return true;
        });
        return { pid: 6_666 };
      },
    }, { alivePids: [6_666] }); // the spawned child is alive: termination must CONFIRM its death
    const result = await wakerTick(deps);

    // Spawn happened, but the CAS failed: the child was terminated (SIGTERM,
    // then confirmed absent) and the tick reports nothing spawned.
    expect(deps.spawns).toHaveLength(1);
    expect(result.spawnedKeys).toEqual([]);
    expect(deps.signals.some((s) => s.pid === 6_666 && s.signal === "SIGTERM")).toBe(true);
    expect(record()?.status).toBe("interactive");
    // Confirmed termination cleared the claim.
    expect(existsSync(wakeClaimPath(sessDir))).toBe(false);
  });

  it("keeps the wake claim and notifies when a CAS-lost child cannot be confirmed dead", async () => {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() - 1_000 });
    const deps = makeDeps({
      spawnChild: (cmd, args, opts2) => {
        deps.spawns.push({ cmd, args, cwd: opts2.cwd, env: opts2.env });
        mutateLimitLedger((ledger) => {
          const rec = ledger.records[KEY]!;
          rec.status = "interactive";
          return true;
        });
        return { pid: 6_667 };
      },
    }, { unkillablePids: [6_667] }); // ignores every signal: death cannot be confirmed
    const result = await wakerTick(deps);

    expect(result.spawnedKeys).toEqual([]);
    // SIGTERM then SIGKILL, both unconfirmed -> the claim is the last artifact
    // naming the pid, so it is NOT cleared, and the user is notified.
    expect(deps.signals.filter((s) => s.pid === 6_667).map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(wakeClaimPath(sessDir))).toBe(true);
    // The durable artifact must actually NAME the orphan: the pre-spawn claim
    // carried childPid null, so it is rewritten with the real pid.
    expect(readWakeClaim(sessDir)?.childPid).toBe(6_667);
    // And the ledger attempt is attached too, so a claim-less path could find it.
    expect(record()?.attempt?.childPid).toBe(6_667);
    expect(deps.notifications.some((n) => n.includes("6667"))).toBe(true);
  });

  it("PLAIN CAS-lost child is tracked via the ledger attempt (no wake claim exists there)", async () => {
    // A plain headless record has NO per-session wake claim. When its spawn CAS
    // loses (a re-limit changed the record) and the child cannot be confirmed
    // dead, the ONLY durable tracking is the ledger attempt: attachOrphanChildPid
    // must persist the real pid onto the lingering attempt.
    recordDirectStop(baseStop({ mode: "headless" }));
    const deps = makeDeps({
      spawnChild: (cmd, args, opts2) => {
        deps.spawns.push({ cmd, args, cwd: opts2.cwd, env: opts2.env });
        // A re-limit lands between spawn and the recordAttemptSpawn CAS: it
        // bumps generation and resets status to `stopped`, keeping the attempt.
        recordDirectStop(baseStop({ mode: "headless", detectedAt: Date.now() + DEDUPE_WINDOW_MS + 1 }));
        return { pid: 6_668 };
      },
    }, { unkillablePids: [6_668] });
    const result = await wakerTick(deps);

    expect(deps.spawns).toHaveLength(1);
    expect(result.spawnedKeys).toEqual([]);
    // The child could not be confirmed dead; the ledger attempt now names it.
    expect(record()?.attempt?.childPid).toBe(6_668);
    expect(deps.notifications.some((n) => n.includes("6668"))).toBe(true);
  });

  it("requeues quietly when an interactive reopen wins the wake-claim recheck", async () => {
    makeAutonomousStop({ resetAt: Date.now() - 1_000 });
    // The interactive side already holds the record: markInteractive flips it
    // after the due-scan claim but before the wake-claim recheck. Simulate by
    // flipping status inside detectClaude (which dispatchClaimed calls before
    // the claim-lock recheck).
    const deps = makeDeps({
      detectClaude: () => {
        mutateLimitLedger((ledger) => {
          const rec = ledger.records[KEY]!;
          rec.status = "interactive";
          return true;
        });
        return "2.1.0";
      },
    });
    const result = await wakerTick(deps);

    // The recheck saw a non-resuming record: no spawn, no signal, no claim.
    expect(deps.spawns).toHaveLength(0);
    expect(result.spawnedKeys).toEqual([]);
    expect(record()?.status).toBe("interactive");
  });
});

// ---------------------------------------------------------------------------
// ISS-944: pre-spawn defer cap -- site wiring (mechanism itself is proven at
// the settleAttempt level in test/core/limit-ledger.test.ts). Test numbers
// trace the ratified plan (.story/sessions/b0366559-4d5d-452d-9881-2c89f684ef3d/
// plan-iss944-revised.md).
// ---------------------------------------------------------------------------

describe("wakerTick pre-spawn defer cap (ISS-944)", () => {
  it("test 1: claude-missing reaches defer_exhausted after MAX_DEFER_COUNT+1 consecutive pre-spawn defers, wakeAttempts stays 0 throughout", async () => {
    makeAutonomousStop();
    const deps = makeDeps({ detectClaude: () => null });

    for (let i = 0; i < MAX_DEFER_COUNT; i++) {
      await wakerTick(deps);
      const mid = record();
      expect(mid?.status).toBe("deferred");
      expect(mid?.wakeAttempts).toBe(0);
      // Force immediately due again -- the cap loop, not backoff timing, is under test.
      mutateLimitLedger((ledger) => {
        ledger.records[KEY]!.nextAttemptAt = Date.now() - 1_000;
        return true;
      });
    }
    await wakerTick(deps);
    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("defer_exhausted");
    expect(rec?.wakeAttempts).toBe(0);
    expect(deps.spawns).toHaveLength(0);
    expect(deps.notifications.at(-1)).toContain("deferred attempts with no spawn since");
  });

  it("test 5a: the wall-clock grace terminalizes to manual BEFORE the count cap would have (grace elapsed, preSpawnDeferCount one below the cap)", async () => {
    const resetAt = Date.now() - BLOCKED_GRACE_MS - 60_000;
    const { sessDir } = makeAutonomousStop({ resetAt });
    const tDir = telemetryDirPath(sessDir);
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "alive"), String(Date.now()));
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.preSpawnDeferCount = MAX_DEFER_COUNT - 1; // one defer away from the cap
      return true;
    });

    const deps = makeDeps();
    await wakerTick(deps);

    const rec = record();
    expect(rec?.status).toBe("manual");
    expect(rec?.reasonCode).toBe("blocked_client"); // grace won, cap never got the chance to fire
  });

  it("test 5b: the count cap terminalizes to defer_exhausted BEFORE the wall-clock grace would have (grace not elapsed, preSpawnDeferCount already at the cap)", async () => {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() - 1_000 }); // just past reset, well under grace
    const tDir = telemetryDirPath(sessDir);
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "alive"), String(Date.now()));
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.preSpawnDeferCount = MAX_DEFER_COUNT;
      return true;
    });

    const deps = makeDeps();
    await wakerTick(deps);

    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("defer_exhausted"); // cap won, grace had not elapsed
  });

  it("test 6a: cap-firing at claude-missing emits defer-exhausted only, never the ordinary claude-missing moment (pen ratification: fixture pins deferCount:0 so the pre-existing once-per-episode guard cannot suppress the ordinary moment for free)", async () => {
    makeAutonomousStop();
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.preSpawnDeferCount = MAX_DEFER_COUNT;
      ledger.records[KEY]!.deferCount = 0;
      return true;
    });
    const deps = makeDeps({ detectClaude: () => null });
    await wakerTick(deps);

    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("defer_exhausted");
    expect(deps.notifications).toHaveLength(1);
    expect(deps.notifications[0]).toContain("deferred attempts with no spawn since");
    expect(deps.notifications[0]).not.toContain("claude CLI was not found");
  });

  it("test 6b: cap-firing at alive-fresh emits defer-exhausted only, never the ordinary alive-blocked moment", async () => {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() - 1_000 });
    const tDir = telemetryDirPath(sessDir);
    mkdirSync(tDir, { recursive: true });
    writeFileSync(join(tDir, "alive"), String(Date.now()));
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.preSpawnDeferCount = MAX_DEFER_COUNT;
      ledger.records[KEY]!.deferCount = 0;
      return true;
    });
    const deps = makeDeps();
    await wakerTick(deps);

    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("defer_exhausted");
    expect(deps.notifications).toHaveLength(1);
    expect(deps.notifications[0]).toContain("deferred attempts with no spawn since");
    expect(deps.notifications[0]).not.toContain("still open in a terminal");
  });

  it("test 6c: cap-firing at telemetry-unreadable emits defer-exhausted only, never the ordinary telemetry-unreadable moment", async () => {
    const { sessDir } = makeAutonomousStop({ sessionOverrides: { heartbeatGeneration: "not-a-generation" } as any });
    mkdirSync(telemetryDirPath(sessDir), { recursive: true });
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.preSpawnDeferCount = MAX_DEFER_COUNT;
      ledger.records[KEY]!.deferCount = 0;
      return true;
    });
    const deps = makeDeps();
    await wakerTick(deps);

    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("defer_exhausted");
    expect(deps.notifications).toHaveLength(1);
    expect(deps.notifications[0]).toContain("deferred attempts with no spawn since");
    expect(deps.notifications[0]).not.toContain("heartbeat");
  });

  it("test 6d: cap-firing at spawn-failure emits defer-exhausted, wakeAttempts stays 0, and the terminal record preserves the real spawn error in lastError", async () => {
    makeAutonomousStop();
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.preSpawnDeferCount = MAX_DEFER_COUNT;
      ledger.records[KEY]!.deferCount = 0;
      return true;
    });
    const deps = makeDeps({
      spawnChild: () => ({ pid: null, error: "spawn failed: ENOENT claude" }),
    });
    await wakerTick(deps);

    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("defer_exhausted");
    expect(rec?.wakeAttempts).toBe(0);
    expect(rec?.lastError).toBe("spawn failed: ENOENT claude");
    expect(deps.notifications).toHaveLength(1);
    expect(deps.notifications[0]).toContain("deferred attempts with no spawn since");
  });
});

// ---------------------------------------------------------------------------
// Supervision / verify
// ---------------------------------------------------------------------------

describe("wakerTick supervision", () => {
  function primeResumingAttempt(opts: {
    childPid?: number;
    spawnedAgoMs?: number;
    generation?: number;
    transcriptOffset?: number | null;
    stateRevision?: number | string | null;
    lastProgressAgoMs?: number;
  } = {}): void {
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "resuming";
      const now = Date.now();
      rec.attempt = {
        id: "wa-test-attempt",
        token: "tok",
        generation: opts.generation ?? rec.generation,
        childPid: opts.childPid ?? 4_242,
        spawnedAt: now - (opts.spawnedAgoMs ?? 60_000),
        transcriptOffset: opts.transcriptOffset ?? null,
        stateRevision: opts.stateRevision ?? null,
        lastProgressAt: now - (opts.lastProgressAgoMs ?? opts.spawnedAgoMs ?? 60_000),
      };
      return true;
    });
  }

  it("ISS-944 test 2: post-spawn defers stay bounded by the EXISTING wakeAttempts/maxAttempts gate and never reach defer_exhausted", async () => {
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.wakeAttempts = 5; // already at maxAttempts (default 5)
      return true;
    });
    primeResumingAttempt({ spawnedAgoMs: 60_000 });

    const deps = makeDeps({ isChildAlive: () => false });
    await wakerTick(deps); // superviseAttempt: "wake child exited without progress" -> deferred, never asserts preSpawnDefer
    let rec = record();
    expect(rec?.status).toBe("deferred");
    expect(rec?.reasonCode).not.toBe("defer_exhausted");
    expect(rec?.wakeAttempts).toBe(5); // untouched by the post-spawn settle

    mutateLimitLedger((ledger) => {
      ledger.records[KEY]!.nextAttemptAt = Date.now() - 1_000;
      return true;
    });
    await wakerTick(deps); // due again; the give-up gate fires BEFORE dispatch since wakeAttempts >= maxAttempts
    rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("attempts_exhausted"); // NOT defer_exhausted
    expect(deps.notifications.some((n) => n.includes("Gave up"))).toBe(true);
  });

  it("settles resumed (with notification) when the parked session moves on", async () => {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt();
    const current = readState(sessDir);
    writeSessionSync(sessDir, {
      ...current,
      state: "IMPLEMENT",
      compactPending: false,
      interruptionKind: null,
      limitStopPending: false,
      limitEventId: null,
    } as FullSessionState);

    const deps = makeDeps({ isChildAlive: () => true });
    await wakerTick(deps);
    expect(record()?.status).toBe("resumed");
    expect(deps.notifications.some((n) => n.includes("Auto-resumed"))).toBe(true);
  });

  it("interactive record: confirms the displaced child's death and clears the attempt", async () => {
    // An interactive takeover preserved the wake child's attempt as evidence.
    // Supervision terminate-confirms the displaced child and clears the attempt
    // so the record can later terminalize (-> resumed) without orphaning it.
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 4_242 });
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "interactive";
      rec.interactiveDeadlineAt = Date.now() + 1_800_000;
      return true;
    });

    // 4_242 is absent (already exited): terminateConfirmed succeeds at once.
    const deps = makeDeps({});
    await wakerTick(deps);

    expect(record()?.status).toBe("interactive"); // stays interactive...
    expect(record()?.attempt).toBeNull(); // ...but the confirmed-dead attempt is cleared
  });

  it("interactive record: PRESERVES the attempt while the displaced child cannot be confirmed dead", async () => {
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 999 });
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "interactive";
      rec.interactiveDeadlineAt = Date.now() + 1_800_000;
      return true;
    });

    // 999 is live and unkillable: death cannot be confirmed, so a possibly-live
    // child's evidence must NOT be dropped.
    const deps = makeDeps({}, { unkillablePids: [999] });
    await wakerTick(deps);

    expect(record()?.status).toBe("interactive");
    expect(record()?.attempt?.childPid).toBe(999);
  });

  it("terminates the superseded child on a generation flip and keeps the new episode dispatchable", async () => {
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 999 });
    // A re-limit minted generation 2 while the old attempt's child lingers.
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.generation = 2;
      rec.status = "stopped";
      rec.nextAttemptAt = Date.now() + 3_600_000;
      return true;
    });

    const deps = makeDeps({}, { alivePids: [999] });
    await wakerTick(deps);

    // Identity-verified signal: session UUID + attempt sentinel, never UUID alone.
    expect(deps.signals.some((s) =>
      s.pid === 999 && s.markers.includes(TASK_ID) && s.markers.length > 1,
    )).toBe(true);
    const rec = record();
    expect(rec?.attempt).toBeNull();
    expect(rec?.status).toBe("stopped");
  });

  it("keeps a superseded child TRACKED when it ignores signals (no untracked orphan)", async () => {
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 999 });
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.generation = 2;
      rec.status = "stopped";
      rec.nextAttemptAt = Date.now() + 3_600_000;
      return true;
    });

    const deps = makeDeps({}, { unkillablePids: [999] });
    await wakerTick(deps);

    // SIGTERM then SIGKILL were attempted; death unconfirmed -> attempt stays
    // as evidence and termination retries next poll.
    expect(deps.signals.filter((s) => s.pid === 999).map((s) => s.signal ?? "SIGTERM")).toEqual(["SIGTERM", "SIGKILL"]);
    const rec = record();
    expect(rec?.attempt?.childPid).toBe(999);
  });

  it("fails the attempt when handleResume set resumeBlocked (after confirming the child died)", async () => {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 555 });
    const current = readState(sessDir);
    writeSessionSync(sessDir, { ...current, resumeBlocked: true } as FullSessionState);

    // The rejected -p child is still alive; it is terminated (confirmed) before
    // the terminal settle clears its evidence.
    const deps = makeDeps({}, { alivePids: [555] });
    await wakerTick(deps);
    const rec = record();
    expect(rec?.status).toBe("failed");
    expect(rec?.reasonCode).toBe("resume_blocked");
    expect(deps.signals.some((s) => s.pid === 555)).toBe(true);
    expect(deps.notifications.some((n) => n.includes("check git state"))).toBe(true);
  });

  it("keeps a resumeBlocked attempt tracked when its child cannot be confirmed dead", async () => {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 556 });
    const current = readState(sessDir);
    writeSessionSync(sessDir, { ...current, resumeBlocked: true } as FullSessionState);

    const deps = makeDeps({}, { unkillablePids: [556] });
    await wakerTick(deps);
    const rec = record();
    // Death unconfirmed -> NOT terminalized (a terminal record stops being
    // supervised); attempt preserved, termination retries next poll.
    expect(rec?.status).toBe("resuming");
    expect(rec?.attempt?.childPid).toBe(556);
    expect(deps.signals.filter((s) => s.pid === 556).map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("defers when the child exits without progress (approvals denied)", async () => {
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ spawnedAgoMs: 60_000 });

    const deps = makeDeps({ isChildAlive: () => false });
    await wakerTick(deps);
    const rec = record();
    expect(rec?.status).toBe("deferred");
    expect(deps.notifications.some((n) => n.includes("waiting on approvals"))).toBe(true);
  });

  it("settles a plain record resumed on a STRUCTURED turn after clean child exit", async () => {
    const transcriptPath = join(root, "transcript.jsonl");
    writeFileSync(transcriptPath, "line1\n");
    recordDirectStop(baseStop({ mode: "headless", transcriptPath, resetAt: Date.now() + 3_600_000 }));
    primeResumingAttempt({ transcriptOffset: 6, spawnedAgoMs: 60_000 });
    // A session-attributed assistant turn NEWER than the spawn: real evidence
    // the wake ran, not just byte growth.
    const turn = JSON.stringify({
      type: "assistant", sessionId: TASK_ID, cwd: root,
      timestamp: new Date().toISOString(), message: { role: "assistant", content: "done" },
    });
    appendFileSync(transcriptPath, turn + "\n");

    const deps = makeDeps({ isChildAlive: () => false });
    await wakerTick(deps);
    expect(record()?.status).toBe("resumed");
  });

  it("does NOT settle a plain record resumed on arbitrary/foreign growth (weak evidence -> defer)", async () => {
    const transcriptPath = join(root, "transcript.jsonl");
    writeFileSync(transcriptPath, "line1\n");
    recordDirectStop(baseStop({ mode: "headless", transcriptPath, resetAt: Date.now() + 3_600_000 }));
    primeResumingAttempt({ transcriptOffset: 6, spawnedAgoMs: 60_000 });
    // Growth from an unstructured line AND a turn belonging to ANOTHER session:
    // neither is attributable evidence that THIS wake completed.
    appendFileSync(transcriptPath, "not-json garbage line\n");
    appendFileSync(transcriptPath, JSON.stringify({
      type: "assistant", sessionId: "some-other-session",
      timestamp: new Date().toISOString(), message: { content: "x" },
    }) + "\n");

    const deps = makeDeps({ isChildAlive: () => false });
    await wakerTick(deps);
    // Not resumed: the growth is not proof the wake turn ran.
    expect(record()?.status).toBe("deferred");
  });

  it("terminates an inactive child when childInactivityMs is opted in", async () => {
    setupProject(root, { limitResume: { childInactivityMs: 30_000 } });
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 777, spawnedAgoMs: 300_000, lastProgressAgoMs: 300_000 });

    const deps = makeDeps({}, { alivePids: [777] });
    await wakerTick(deps);

    expect(deps.signals.some((s) => s.pid === 777)).toBe(true);
    expect(record()?.status).toBe("deferred");
  });

  it("keeps an inactive-but-unkillable child tracked instead of settling", async () => {
    setupProject(root, { limitResume: { childInactivityMs: 30_000 } });
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 777, spawnedAgoMs: 300_000, lastProgressAgoMs: 300_000 });

    const deps = makeDeps({}, { unkillablePids: [777] });
    await wakerTick(deps);

    // Death unconfirmed: record stays resuming with the attempt tracked.
    const rec = record();
    expect(rec?.status).toBe("resuming");
    expect(rec?.attempt?.childPid).toBe(777);
  });

  it("leaves a healthy quiet child alone when inactivity termination is disabled (default)", async () => {
    makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    primeResumingAttempt({ childPid: 777, spawnedAgoMs: 3_600_000, lastProgressAgoMs: 3_600_000 });

    const deps = makeDeps({ isChildAlive: (pid) => pid === 777 });
    await wakerTick(deps);

    expect(deps.signals).toHaveLength(0);
    expect(record()?.status).toBe("resuming");
  });
});

// ---------------------------------------------------------------------------
// Cancellation completion (finish-cancel via reconcile actions)
// ---------------------------------------------------------------------------

describe("wakerTick cancellation completion", () => {
  function primeCancelling(
    childPid: number | null,
    opts: { lastProgressAgoMs?: number; claimant?: { claimantPid: number; claimantSignature: string | null } } = {},
  ): { sessDir: string } {
    const { sessDir } = makeAutonomousStop({ resetAt: Date.now() + 3_600_000 });
    const progressAgo = opts.lastProgressAgoMs ?? 60_000;
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "cancelling";
      rec.attempt = {
        id: "wa-cancel", token: "t", generation: rec.generation,
        childPid,
        spawnedAt: childPid == null ? null : Date.now() - 60_000,
        transcriptOffset: null, stateRevision: null,
        lastProgressAt: Date.now() - progressAgo,
        ...(opts.claimant ?? {}),
      };
      return true;
    });
    return { sessDir };
  }

  it("keeps a null-childPid cancel PENDING while its claimant is alive, then completes once the claimant is CONFIRMED DEAD", async () => {
    // childPid null: the claimant never recorded a child. finishCancel must NOT
    // complete (nor clear the session) while the CLAIMANT is alive -- a child
    // may still materialize. Only when the claimant is confirmed dead (no child
    // will ever appear) is the absence confirmed. Wall-clock age is not proof.
    const { sessDir } = primeCancelling(null, { lastProgressAgoMs: 1_000, claimant: liveClaimant() });
    await wakerTick(makeDeps());
    let rec = record();
    if (SIG_SUPPORTED) {
      expect(rec?.status).toBe("cancelling"); // live claimant: still pending
      expect(rec?.attempt?.id).toBe("wa-cancel");
      expect(readState(sessDir).limitStopPending).toBe(true); // session UNTOUCHED
    }

    // Claimant confirmed dead (crashed without spawning): now safe to complete.
    mutateLimitLedger((ledger) => {
      Object.assign(ledger.records[KEY]!.attempt!, deadClaimant());
      return true;
    });
    await wakerTick(makeDeps());
    rec = record();
    expect(rec?.status).toBe("cancelled");
    expect(rec?.attempt).toBeNull();
    const state = readState(sessDir);
    expect(state.interruptionKind).toBeNull();
    expect(state.compactPending).toBe(true); // downgraded to an ordinary compact park
  });

  it("keeps a null-childPid cancel PENDING for a SUSPENDED (alive) claimant even past the stale age", async () => {
    if (!SIG_SUPPORTED) return; // requires a positive "alive" identity
    // The claimant is alive but aged well past CLAIM_SPAWN_STALE_MS (e.g.
    // suspended across laptop sleep). It may still resume and spawn, so the
    // cancel must NOT complete on age alone and the session stays untouched.
    const { sessDir } = primeCancelling(null, {
      lastProgressAgoMs: CLAIM_SPAWN_STALE_MS + 60_000,
      claimant: liveClaimant(),
    });
    await wakerTick(makeDeps());
    const rec = record();
    expect(rec?.status).toBe("cancelling");
    expect(rec?.attempt?.id).toBe("wa-cancel");
    expect(readState(sessDir).limitStopPending).toBe(true);
  });

  it("completes a null-childPid cancel via the age fallback when NO claimant identity was recorded (legacy attempt)", async () => {
    // NO recorded claimant (legacy attempt, claimantPid null): the age bound is
    // the ONLY available signal, so a claim aged past CLAIM_SPAWN_STALE_MS
    // completes. Age is a fallback ONLY here, never when a claimant is recorded.
    const { sessDir } = primeCancelling(null, { lastProgressAgoMs: CLAIM_SPAWN_STALE_MS + 1 });
    await wakerTick(makeDeps());
    const rec = record();
    expect(rec?.status).toBe("cancelled");
    expect(rec?.attempt).toBeNull();
    expect(readState(sessDir).interruptionKind).toBeNull();
  });

  it("keeps a null-childPid cancel PENDING while a RECORDED claimant's identity is UNKNOWN, even past the stale age (all platforms)", async () => {
    // A RECORDED claimant whose identity resolves to "unknown" (no signature
    // source, or a transient inspection failure) may still be alive/suspended.
    // Age must NOT complete the cancel here -- doing so could clear the session
    // before that claimant resumes and spawns an untracked child. Unlike the
    // legacy no-claimant case above, a recorded claimant is abandoned ONLY on a
    // confirmed-dead result. Platform-independent.
    const { sessDir } = primeCancelling(null, {
      lastProgressAgoMs: CLAIM_SPAWN_STALE_MS + 60_000,
      claimant: unknownClaimant(),
    });
    await wakerTick(makeDeps());
    const rec = record();
    expect(rec?.status).toBe("cancelling"); // NOT cancelled -- age never overrides a recorded claimant
    expect(rec?.attempt?.id).toBe("wa-cancel");
    expect(readState(sessDir).limitStopPending).toBe(true); // session UNTOUCHED
  });

  it("a stale finish-cancel cannot terminalize a NEWER cancellation generation", async () => {
    // A PLAIN cancelling record (gen 1) with a live child. Mid finish-cancel --
    // between its top read and completeCancellation -- a re-limit + re-cancel
    // supersedes the episode (gen 2, a fresh attempt-less cancel whose own child
    // death is not yet confirmed). The stale finisher holds gen 1, so its
    // generation-fenced completeCancellation must REFUSE to terminalize gen 2.
    recordDirectStop(baseStop({ mode: "headless" })); // plain: no session block
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[KEY]!;
      rec.status = "cancelling";
      rec.attempt = {
        id: "wa-old", token: "t", generation: rec.generation, childPid: 888,
        spawnedAt: Date.now() - 60_000, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now() - 60_000,
      };
      return true;
    });
    const gen1 = record()!.generation;

    let bumped = false;
    const deps = makeDeps({
      probeChild: (pid) => (pid === 888 && !bumped ? "match" : "absent"),
      signalChild: (pid, markers, signal) => {
        deps.signals.push({ pid, markers, signal });
        if (pid === 888 && !bumped) {
          bumped = true; // the SIGTERM window is our injection point
          mutateLimitLedger((ledger) => {
            const rec = ledger.records[KEY]!;
            rec.generation = rec.generation + 1;
            rec.status = "cancelling";
            rec.attempt = null; // gen-2 cancel: no confirmed-dead child yet
            return true;
          });
        }
        return true;
      },
    });
    await wakerTick(deps);

    const rec = record();
    expect(rec?.generation).toBe(gen1 + 1);
    expect(rec?.status).toBe("cancelling"); // NOT "cancelled": the fence held
  });

  it("completes a crashed cancel: SIGTERM kills the child, session interruption cleared", async () => {
    const { sessDir } = primeCancelling(888);
    const deps = makeDeps({}, { alivePids: [888] });
    await wakerTick(deps);

    expect(deps.signals.filter((s) => s.pid === 888).map((s) => s.signal)).toEqual(["SIGTERM"]);
    const rec = record();
    expect(rec?.status).toBe("cancelled");
    expect(rec?.attempt).toBeNull();
    const state = readState(sessDir);
    // Cancellation DOWNGRADES to an ordinary compact park (resumable), never a
    // stranded COMPACT-but-not-pending state: limit fields cleared, compact kept.
    expect(state.interruptionKind).toBeNull();
    expect(state.limitStopPending).toBe(false);
    expect(state.compactPending).toBe(true);
    expect(state.state).toBe("COMPACT");
  });

  it("escalates SIGTERM -> SIGKILL, then stands down blocked with the attempt preserved", async () => {
    primeCancelling(888);
    const deps = makeDeps({}, { unkillablePids: [888] });
    await wakerTick(deps);

    expect(deps.signals.filter((s) => s.pid === 888).map((s) => s.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    const rec = record();
    expect(rec?.status).toBe("manual");
    expect(rec?.reasonCode).toBe("cancellation_blocked");
    expect(rec?.attempt?.childPid).toBe(888);
    expect(deps.notifications.some((n) => n.includes("Could not stop"))).toBe(true);
  });

  it("retries a blocked cancellation and completes it once the child finally dies", async () => {
    const { sessDir } = primeCancelling(888);
    // First tick: unkillable -> manual/cancellation_blocked.
    await wakerTick(makeDeps({}, { unkillablePids: [888] }));
    expect(record()?.status).toBe("manual");

    // Later tick: the child is gone -> reconciliation routes the blocked
    // cancel back through finish-cancel, which completes it.
    await wakerTick(makeDeps());
    const rec = record();
    expect(rec?.status).toBe("cancelled");
    expect(rec?.attempt).toBeNull();
    expect(readState(sessDir).interruptionKind).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fallback reparse
// ---------------------------------------------------------------------------

describe("wakerTick fallback reparse", () => {
  it("upgrades a fallback reset once the SESSION-ATTRIBUTED banner lands in the transcript", async () => {
    const transcriptPath = join(root, "transcript.jsonl");
    const banner = "You've hit your 5-hour limit · resets 11pm";
    // The banner entry carries the matching sessionId: the fallback reparse
    // filters by clientTaskId, so only this session's own evidence upgrades it.
    writeFileSync(transcriptPath, JSON.stringify({
      isApiErrorMessage: true, error: "rate_limit", sessionId: TASK_ID,
      message: { content: [{ type: "text", text: banner }] },
    }) + "\n");

    const now = Date.now();
    recordDirectStop(baseStop({
      mode: "headless",
      transcriptPath,
      resetSource: "fallback",
      detectedAt: now - 120_000, // inside the reparse window
      resetAt: now + 18_000_000, // 5h fallback, not yet due
    }));

    const deps = makeDeps();
    await wakerTick(deps);

    const rec = record();
    expect(rec?.resetSource).toBe("absolute");
    expect(rec?.rawBanner).toBe(banner);
    // Upgraded to the parsed banner time (accuracy, not necessarily sooner).
    expect(rec?.resetAt).not.toBe(now + 18_000_000);
    expect(rec?.resetAt).toBeGreaterThan(now);
    expect(rec?.nextAttemptAt).toBe(rec?.resetAt);
  });

  it("does NOT upgrade a fallback reset from a FOREIGN-session banner (identity boundary)", async () => {
    const transcriptPath = join(root, "transcript.jsonl");
    const banner = "You've hit your 5-hour limit · resets 11pm";
    // A banner belonging to another session must not reschedule this record.
    writeFileSync(transcriptPath, JSON.stringify({
      isApiErrorMessage: true, error: "rate_limit", sessionId: "some-other-session",
      message: { content: [{ type: "text", text: banner }] },
    }) + "\n");

    const now = Date.now();
    recordDirectStop(baseStop({
      mode: "headless", transcriptPath, resetSource: "fallback",
      detectedAt: now - 120_000, resetAt: now + 18_000_000,
    }));

    await wakerTick(makeDeps());

    const rec = record();
    expect(rec?.resetSource).toBe("fallback"); // unchanged: foreign evidence ignored
    expect(rec?.resetAt).toBe(now + 18_000_000);
  });
});

// ---------------------------------------------------------------------------
// runWaker singleton + spawnWakerIfNeeded
// ---------------------------------------------------------------------------

describe("runWaker", () => {
  it("exits immediately when no records remain", async () => {
    const deps = makeDeps();
    await runWaker(deps, { maxTicks: 5, pollMs: 1 });
    expect(deps.spawns).toHaveLength(0);
  });

  it("refuses to start while a live holder owns the waker lock", async () => {
    recordDirectStop(baseStop());
    const handle = acquireLimitLock(wakerLockPath(), { deadlineMs: 200 });
    expect(handle).not.toBeNull();
    try {
      const deps = makeDeps();
      await runWaker(deps, { maxTicks: 1, pollMs: 1 });
      // The tick never ran: the notify record is still stopped.
      expect(record()?.status).toBe("stopped");
      expect(deps.notifications).toHaveLength(0);
    } finally {
      releaseLimitLock(handle!);
    }
  });

  it("the WAKER singleton lock is NOT stealable once its lease is renewed on a fresh inode (no second waker)", async () => {
    // The singleton guarantee must survive a renew/steal race. A real renewal now
    // publishes a FRESH inode; a contender that captured its steal decision before
    // the renewal (old inode + old renewedAt) must fail the fences and refuse to
    // unlink -- otherwise a second waker would run and separate ticks could
    // over-dispatch beyond maxConcurrent.
    recordDirectStop(baseStop());
    const path = wakerLockPath();
    const handle = acquireLimitLock(path)!;
    const oldIno = statSync(path).ino;
    const tOld = JSON.parse(readFileSync(path, "utf-8")).renewedAt;

    // Holder renews -> fresh inode + newer renewedAt (handle tracks the new inode).
    expect(renewLimitLock(handle)).toBe(true);
    const newIno = statSync(path).ino;
    expect(newIno).not.toBe(oldIno);
    expect(handle.inode).toBe(newIno);

    // A steal decision captured BEFORE the renewal (old inode + old renewedAt)
    // aborts on the final inode fence -> the renewed waker lock survives intact.
    const r = safeUnlinkLock(path, oldIno, handle.token, tOld);
    expect(r).toEqual({ unlinked: false, reason: "raced" });
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).ino).toBe(newIno);

    // With the holder still owning the (renewed) lock, a contender waker cannot
    // start: it finds the lock live and performs no tick (the record stays put).
    const deps = makeDeps();
    await runWaker(deps, { maxTicks: 1, pollMs: 1 });
    expect(record()?.status).toBe("stopped");
    expect(deps.spawns).toHaveLength(0);
    expect(deps.notifications).toHaveLength(0);

    releaseLimitLock(handle);
  });

  it("processes records then exits when the ledger drains", async () => {
    recordDirectStop(baseStop()); // notify-mode -> terminal in one tick
    const deps = makeDeps();
    await runWaker(deps, { maxTicks: 10, pollMs: 1 });
    expect(record()?.status).toBe("notified");
  });
});

describe("spawnWakerIfNeeded", () => {
  it("does nothing without pending records", () => {
    expect(spawnWakerIfNeeded()).toBe(false);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("spawns a detached waker-run with the argv sentinel when records pend", () => {
    recordDirectStop(baseStop());
    expect(spawnWakerIfNeeded()).toBe(true);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockedSpawn.mock.calls[0]! as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain("waker-run");
    expect(args).toContain(WAKER_ARGV_SENTINEL);
    expect(opts.detached).toBe(true);
  });

  it("honors the global kill switch", () => {
    recordDirectStop(baseStop());
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ limitResume: { enabled: false } }));
    expect(spawnWakerIfNeeded()).toBe(false);
  });
});

describe("readSessionSnapshot", () => {
  it("distinguishes absent (null) from unreadable (undefined)", () => {
    expect(readSessionSnapshot(root, "no-such-session")).toBeNull();
    const { state, sessDir } = makeWorkingSession(root);
    writeFileSync(join(sessDir, "state.json"), "{corrupt");
    expect(readSessionSnapshot(root, state.sessionId)).toBeUndefined();
  });
});
