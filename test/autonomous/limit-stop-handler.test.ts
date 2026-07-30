/**
 * T-424: StopFailure hook handler (handleSessionLimitStop).
 *
 * Detection gates / autonomous-vs-plain classification / ledger-first intent
 * protocol / FINALIZE notify-only / re-limit generations / prep-failure
 * fallback / never-throw contract, plus readHookStdinContext's StopFailure
 * field extraction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

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

vi.mock("../../src/autonomous/resume-marker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/resume-marker.js")>();
  return { ...actual, writeResumeMarker: vi.fn(actual.writeResumeMarker) };
});

// Partial-mock session.js so a single test can make the FIRST withSessionLock
// scope throw AFTER commit (a lock-release race). Every other export -- and the
// DEFAULT withSessionLock behavior -- stays actual.
vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  return { ...actual, withSessionLock: vi.fn(actual.withSessionLock) };
});

import { gitHead } from "../../src/autonomous/git-inspector.js";
import { writeResumeMarker } from "../../src/autonomous/resume-marker.js";

const actualResumeMarker = await vi.importActual<typeof import("../../src/autonomous/resume-marker.js")>(
  "../../src/autonomous/resume-marker.js",
);
const mockedWriteResumeMarker = vi.mocked(writeResumeMarker);
import { createSession, writeSessionSync, withSessionLock, findSessionById } from "../../src/autonomous/session.js";

const actualSession = await vi.importActual<typeof import("../../src/autonomous/session.js")>(
  "../../src/autonomous/session.js",
);
const mockedWithSessionLock = vi.mocked(withSessionLock);
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import {
  handleSessionLimitStop,
  readHookStdinContext,
} from "../../src/cli/commands/session-compact.js";
import {
  readLimitLedger,
  limitRecordKey,
  mutateLimitLedger,
  writePreparingIntent,
  type LimitRecord,
} from "../../src/core/limit-ledger.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const mockedGitHead = vi.mocked(gitHead);

const TASK_ID = "task-limit-handler-0001";
const KEY = limitRecordKey(TASK_ID);

let root: string;
let globalDir: string;
let savedGlobalDir: string | undefined;
let savedClaudeSession: string | undefined;

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
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function makeOwnedSession(
  dir: string,
  overrides: Partial<FullSessionState> = {},
): { state: FullSessionState; sessDir: string } {
  const session = createSession(dir, "coding", realpathSync(dir));
  const sessDir = join(dir, ".story", "sessions", session.sessionId);
  const state = writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    ownerTask: { client: "claude", id: TASK_ID, boundAt: new Date().toISOString() },
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

function record(): LimitRecord | undefined {
  return readLimitLedger().records[KEY] as LimitRecord | undefined;
}

const SESSION_BANNER = "You've hit your 5-hour limit · resets 6:40pm";

function writeTranscript(dir: string, banner = SESSION_BANNER): string {
  const path = join(dir, "transcript.jsonl");
  const entry = {
    isApiErrorMessage: true,
    error: "rate_limit",
    sessionId: TASK_ID,
    cwd: dir,
    message: { content: [{ type: "text", text: banner }] },
  };
  writeFileSync(path, JSON.stringify({ type: "user", message: "hi" }) + "\n" + JSON.stringify(entry) + "\n");
  return path;
}

let savedWakerSpawn: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t424-handler-"));
  globalDir = mkdtempSync(join(tmpdir(), "t424-handler-global-"));
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  savedClaudeSession = process.env.CLAUDE_CODE_SESSION_ID;
  savedWakerSpawn = process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  // Every successful detection would otherwise spawn a REAL detached waker
  // (using the Vitest argv) that keeps polling the temp ledger after the test.
  process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = "1";
  delete process.env.CLAUDE_CODE_SESSION_ID;
  setupProject(root);
  mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } });
  // vi.restoreAllMocks() wipes vi.fn factory implementations; re-prime the passthrough.
  mockedWriteResumeMarker.mockReset();
  mockedWriteResumeMarker.mockImplementation(actualResumeMarker.writeResumeMarker);
  mockedWithSessionLock.mockReset();
  mockedWithSessionLock.mockImplementation(actualSession.withSessionLock);
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  if (savedClaudeSession !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedClaudeSession;
  else delete process.env.CLAUDE_CODE_SESSION_ID;
  if (savedWakerSpawn === undefined) delete process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  else process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = savedWakerSpawn;
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});

describe("handleSessionLimitStop gates", () => {
  it("ignores non-rate_limit error types", async () => {
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "overloaded" });
    expect(record()).toBeUndefined();
  });

  it("proceeds when errorType is absent (matcher already filtered)", async () => {
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root });
    expect(record()?.status).toBe("stopped");
  });

  it("is silent without a client task id", async () => {
    await handleSessionLimitStop({ cwd: root, errorType: "rate_limit" });
    expect(record()).toBeUndefined();
  });

  it("falls back to the CLAUDE_CODE_SESSION_ID env when no id is passed", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = TASK_ID;
    await handleSessionLimitStop({ cwd: root, errorType: "rate_limit" });
    expect(record()?.clientTaskId).toBe(TASK_ID);
  });

  it("is silent without a .story/ project", async () => {
    const bare = mkdtempSync(join(tmpdir(), "t424-bare-"));
    try {
      await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: bare, errorType: "rate_limit" });
      expect(record()).toBeUndefined();
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("honors the global kill switch", async () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ limitResume: { enabled: false } }));
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });
    expect(record()).toBeUndefined();
  });

  it("honors project limitResume.enabled: false", async () => {
    setupProject(root, { limitResume: { enabled: false } });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });
    expect(record()).toBeUndefined();
  });
});

describe("handleSessionLimitStop plain sessions", () => {
  it("still records a stop when `.story/sessions` cannot be enumerated (ISS-897)", async () => {
    // The regression this guards against was introduced BY the fix beside it.
    // `listAllSessionsDetailed` used to answer "empty project" for any ENOENT,
    // which concealed an unreadable sessions root; it now throws instead. That
    // is right for a display, and it was very nearly fatal here: this call sits
    // on the usage-limit stop path with nothing but the handler's outer catch
    // around it, so an unreadable root meant no ledger record, no parked
    // session, and no waker -- silently, at the moment the agent is stopping.
    //
    // The ownership question genuinely cannot be answered here: the owner is
    // recorded inside a directory this build cannot enumerate. So the outcome
    // is the same `plain` the old code reached, and what changed is that it is
    // no longer silent. Recording the wrong classification is recoverable;
    // recording nothing is not.
    const transcriptPath = writeTranscript(root);
    const sessions = join(root, ".story", "sessions");
    rmSync(sessions, { recursive: true, force: true });
    // A DANGLING symlink: `readdirSync` raises ENOENT exactly as it does for a
    // path that was never created, which is what made the old catch wrong.
    symlinkSync(join(root, ".story", "nowhere"), sessions);

    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await handleSessionLimitStop({
        clientTaskId: TASK_ID, cwd: root, transcriptPath, errorType: "rate_limit",
      });

      const rec = record();
      expect(rec, "the limit stop was lost entirely").toBeDefined();
      expect(rec?.sessionType).toBe("plain");
      expect(rec?.storybloqSessionId).toBeNull();

      // ...and it SAID so. A misclassification an operator can see is a
      // different thing from one they cannot.
      const written = warn.mock.calls.map((c) => String(c[0])).join("");
      expect(written, "recorded plain in silence").toContain("could not be enumerated");
      expect(written).toContain("PLAIN");
    } finally {
      warn.mockRestore();
    }
  });

  it("records a notify stop with transcript evidence", async () => {
    const transcriptPath = writeTranscript(root);
    await handleSessionLimitStop({
      clientTaskId: TASK_ID, cwd: root, transcriptPath, errorType: "rate_limit",
    });

    const rec = record();
    expect(rec?.status).toBe("stopped");
    expect(rec?.sessionType).toBe("plain");
    expect(rec?.mode).toBe("notify");
    expect(rec?.storybloqSessionId).toBeNull();
    expect(rec?.limitType).toBe("session");
    expect(rec?.resetSource).toBe("absolute");
    expect(rec?.rawBanner).toContain("5-hour limit");
    expect(rec?.gitHead).toBe("abc123");
    expect(rec?.resetAt).toBeGreaterThan(Date.now());
  });

  it("ignores a transcript rate_limit entry from a DIFFERENT session (identity boundary)", async () => {
    // A stale/swapped transcript naming another session must not supply THIS
    // stop's reset schedule. The handler passes {sessionId: clientTaskId} to the
    // scan, so a foreign-session banner is skipped and the fallback is used.
    const now = Date.now();
    setupProject(root, { limitResume: { fallbackResetMs: 3_600_000 } });
    const transcriptPath = writeTranscript(root, SESSION_BANNER);
    // Rewrite the entry with a foreign sessionId (absolute 6:40pm banner intact).
    const foreign = {
      isApiErrorMessage: true, error: "rate_limit", sessionId: "some-other-session",
      cwd: root, message: { content: [{ type: "text", text: SESSION_BANNER }] },
    };
    writeFileSync(transcriptPath, JSON.stringify(foreign) + "\n");

    await handleSessionLimitStop({
      clientTaskId: TASK_ID, cwd: root, transcriptPath, errorType: "rate_limit", now,
    });

    const rec = record();
    // Banner rejected: fell back rather than adopting the foreign reset.
    expect(rec?.resetSource).toBe("fallback");
    expect(rec?.rawBanner).toBeNull();
    expect(rec?.resetAt).toBeGreaterThanOrEqual(now + 3_600_000);
  });

  it("honors plainMode: headless", async () => {
    setupProject(root, { limitResume: { plainMode: "headless" } });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });
    expect(record()?.mode).toBe("headless");
  });

  it("uses the configured fallback when the transcript is missing", async () => {
    const now = Date.now();
    setupProject(root, { limitResume: { fallbackResetMs: 3_600_000 } });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit", now });

    const rec = record();
    expect(rec?.resetSource).toBe("fallback");
    expect(rec?.resetAt).toBeGreaterThanOrEqual(now + 3_600_000);
    expect(rec?.resetAt).toBeLessThanOrEqual(now + 3_600_000 + 120_000);
  });

  it("treats a session owned by a DIFFERENT task as plain", async () => {
    makeOwnedSession(root, {
      ownerTask: { client: "claude", id: "someone-else", boundAt: new Date().toISOString() },
    } as Partial<FullSessionState>);
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    expect(rec?.sessionType).toBe("plain");
    expect(rec?.storybloqSessionId).toBeNull();
  });
});

describe("handleSessionLimitStop autonomous sessions", () => {
  it("parks the owned session on the COMPACT lane and activates the ledger record", async () => {
    const { state, sessDir } = makeOwnedSession(root);
    const transcriptPath = writeTranscript(root);
    await handleSessionLimitStop({
      clientTaskId: TASK_ID, cwd: root, transcriptPath,
      errorType: "rate_limit", permissionMode: "acceptEdits",
    });

    const rec = record();
    expect(rec?.status).toBe("stopped");
    expect(rec?.sessionType).toBe("autonomous");
    expect(rec?.mode).toBe("headless");
    expect(rec?.storybloqSessionId).toBe(state.sessionId);
    expect(rec?.preparingOwner).toBeNull();

    const parked = readState(sessDir);
    expect(parked.state).toBe("COMPACT");
    expect(parked.compactPending).toBe(true);
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.limitStopPending).toBe(true);
    expect(parked.limitPermissionMode).toBe("acceptEdits");
    expect(parked.limitEventId).toBe(rec?.limitEventId);
    expect(parked.limitResumeAt).toBe(rec?.resetAt);
    expect(parked.preCompactState).toBe("IMPLEMENT");
    expect(parked.git.expectedHead).toBe("abc123");

    // T-183 resume marker written for compaction survival parity.
    expect(existsSync(join(root, ".claude", "rules", "autonomous-resume.md"))).toBe(true);
  });

  it("matches ownership via legacy claudeCodeSessionId", async () => {
    const { state } = makeOwnedSession(root, {
      ownerTask: null,
      claudeCodeSessionId: TASK_ID,
    } as Partial<FullSessionState>);
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    expect(rec?.sessionType).toBe("autonomous");
    expect(rec?.storybloqSessionId).toBe(state.sessionId);
  });

  it("stays autonomous on a re-limit of an already-parked session with an expired lease", async () => {
    const now = Date.now();
    const { state, sessDir } = makeOwnedSession(root, {
      lease: {
        workspaceId: realpathSync(root),
        lastHeartbeat: new Date(now - 3_600_000).toISOString(),
        expiresAt: new Date(now - 60_000).toISOString(),
      },
    } as Partial<FullSessionState>);
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit", now });
    const first = record();
    expect(first?.generation).toBe(1);

    // Past the dedupe window: a NEW limit event on the parked session.
    const later = now + 120_000;
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit", now: later });

    const second = record();
    expect(second?.generation).toBe(2);
    expect(second?.sessionType).toBe("autonomous");
    expect(second?.status).toBe("stopped");
    expect(second?.storybloqSessionId).toBe(state.sessionId);
    expect(second?.limitEventId).not.toBe(first?.limitEventId);

    const parked = readState(sessDir);
    expect(parked.state).toBe("COMPACT");
    expect(parked.limitEventId).toBe(second?.limitEventId);
    expect(parked.preCompactState).toBe("IMPLEMENT"); // original resume target preserved
  });

  it("records FINALIZE stops notify-only but still parks the session", async () => {
    const { sessDir } = makeOwnedSession(root, { state: "FINALIZE" });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    expect(rec?.status).toBe("stopped");
    expect(rec?.sessionType).toBe("autonomous");
    expect(rec?.mode).toBe("notify");
    expect(rec?.reasonCode).toBe("finalize_stop");

    const parked = readState(sessDir);
    expect(parked.state).toBe("COMPACT");
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.preCompactState).toBe("FINALIZE");
  });

  it("dedupes a duplicate StopFailure within the window into one record", async () => {
    const now = Date.now();
    makeOwnedSession(root);
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit", now });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit", now: now + 5_000 });

    const rec = record();
    expect(rec?.generation).toBe(1);
    expect(rec?.status).toBe("stopped");
    expect(Object.keys(readLimitLedger().records)).toHaveLength(1);
  });

  it("falls back to a notify-only plain record when session prep fails", async () => {
    // COMPACT without compactPending: prepareForLimitStop throws.
    makeOwnedSession(root, { state: "COMPACT", compactPending: false });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    expect(rec?.status).toBe("stopped");
    expect(rec?.sessionType).toBe("plain");
    expect(rec?.mode).toBe("notify");
    expect(rec?.storybloqSessionId).toBeNull();
  });

  it("persists the exact validated limitPermissionMode for every hook value", async () => {
    const cases: Array<{ input: string | undefined; expected: string | null }> = [
      { input: "bypassPermissions", expected: "bypassPermissions" },
      { input: "acceptEdits", expected: "acceptEdits" },
      { input: "default", expected: "default" },
      { input: "plan", expected: "plan" },
      { input: undefined, expected: null },
      { input: "yolo-mode", expected: null }, // unsupported value never becomes posture
    ];
    let i = 0;
    for (const c of cases) {
      // Distinct client task id per case: reusing one id would make the second+
      // stops DEDUPE onto the first record (a deduped non-owner handler does not
      // re-park the session), so each case would not write its own posture.
      const caseTaskId = `${TASK_ID}-posture-${i++}`;
      const projDir = mkdtempSync(join(tmpdir(), "t424-posture-"));
      try {
        setupProject(projDir);
        const { sessDir } = makeOwnedSession(projDir, {
          ownerTask: { client: "claude", id: caseTaskId, boundAt: new Date().toISOString() },
        } as Partial<FullSessionState>);
        await handleSessionLimitStop({
          clientTaskId: caseTaskId, cwd: projDir, errorType: "rate_limit", permissionMode: c.input,
        });
        expect(readState(sessDir).limitPermissionMode, `input=${c.input}`).toBe(c.expected);
      } finally {
        killSidecarsInRoot(projDir);
        await rm(projDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  });

  it("a best-effort marker failure AFTER session prep still activates the intent (never a plain downgrade)", async () => {
    // writeResumeMarker is best-effort and its throw is swallowed INSIDE the
    // session-lock callback, so the callback commits normally: `prepared` is
    // true and activation runs on the SUCCESS path (not the prepared-catch,
    // which only a lock-release failure reaches -- its body is the same
    // activateOrRepair covered by the refile/ownedElsewhere cases below). The
    // property under test is resilience: a swallowed marker failure must leave
    // the parked session + activated autonomous record intact, NO plain record.
    const { sessDir } = makeOwnedSession(root);
    mockedWriteResumeMarker.mockImplementation(() => {
      throw new Error("marker write exploded");
    });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    expect(rec?.status).toBe("stopped");
    expect(rec?.sessionType).toBe("autonomous");
    expect(rec?.mode).toBe("headless");
    const parked = readState(sessDir);
    expect(parked.state).toBe("COMPACT");
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.limitEventId).toBe(rec?.limitEventId);
  });

  it("REFILES a fresh stopped record when the activation CAS loses to a vanished intent", async () => {
    // A racing actor removes the preparing intent AFTER the session commits but
    // BEFORE activation. The best-effort marker write runs in exactly that
    // window, so it stands in for the race. activateOrRepair must NOT leave the
    // parked session without a ledger pointer: it refiles a fresh stopped record.
    const { sessDir } = makeOwnedSession(root);
    mockedWriteResumeMarker.mockImplementation(() => {
      mutateLimitLedger((ledger) => {
        delete ledger.records[KEY]; // intent vanished mid-transaction
        return true;
      });
    });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    expect(rec?.status).toBe("stopped");
    expect(rec?.sessionType).toBe("autonomous");
    expect(rec?.mode).toBe("headless");
    // The refiled record carries the INTENT's event id so it MATCHES the parked
    // session (reconciliation keys on it) -- the whole point of the repair.
    const parked = readState(sessDir);
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.limitEventId).toBe(rec?.limitEventId);
  });

  it("REPAIRS a newer FOREIGN-event ledger record back to the parked session's event (never orphans the park)", async () => {
    // During the lock a newer ledger generation lands carrying a DIFFERENT event
    // but WITHOUT re-parking the session (the session is still committed under
    // OUR event -- we hold the lock). The activation CAS loses, but the ledger
    // record now names a foreign event that no session is parked under: leaving
    // it would orphan our parked session (reconciliation keys on the event).
    // repairParkedSessionRecord must install a record for the SESSION's event,
    // bypassing the dedupe window (a stale detectedAt would otherwise merge onto
    // the foreign-event record and keep its event).
    const { sessDir } = makeOwnedSession(root);
    mockedWriteResumeMarker.mockImplementation(() => {
      mutateLimitLedger((ledger) => {
        const rec = ledger.records[KEY]!;
        rec.status = "stopped"; // non-terminal, but a DIFFERENT event than the park
        rec.generation = rec.generation + 5;
        rec.preparingOwner = null;
        rec.limitEventId = "le-newer-episode";
        return true;
      });
    });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    const parked = readState(sessDir);
    // The ledger record and the parked session name the SAME event -- the repair
    // steered the foreign-event record back to the session's committed event.
    expect(parked.interruptionKind).toBe("limit");
    expect(rec?.limitEventId).toBe(parked.limitEventId);
    expect(rec?.limitEventId).not.toBe("le-newer-episode");
    expect(rec?.status).toBe("stopped"); // non-terminal, dispatchable
    expect(rec?.sessionType).toBe("autonomous");
    expect(rec?.mode).toBe("headless");
    expect(Object.keys(readLimitLedger().records)).toHaveLength(1);
  });

  it("LEAVES a newer SAME-event non-terminal record intact (already points at the parked session)", async () => {
    // A newer generation that shares the session's committed event already points
    // at THIS parked session: the repair must not clobber it (no wasted
    // generation bump, no lost newer intent). We learn the committed event from
    // the session state the handler just parked, then bump the record's
    // generation while keeping that same event.
    const { sessDir } = makeOwnedSession(root);
    mockedWriteResumeMarker.mockImplementation(() => {
      const parkedEvent = readState(sessDir).limitEventId; // committed under our lock
      mutateLimitLedger((ledger) => {
        const rec = ledger.records[KEY]!;
        rec.status = "stopped"; // non-terminal, SAME event -> owned elsewhere
        rec.generation = rec.generation + 5;
        rec.preparingOwner = null;
        rec.limitEventId = parkedEvent!;
        return true;
      });
    });
    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    const rec = record();
    const parked = readState(sessDir);
    expect(rec?.generation).toBe(6); // 1 + 5, untouched by any repair (owned elsewhere)
    expect(rec?.limitEventId).toBe(parked.limitEventId);
    expect(Object.keys(readLimitLedger().records)).toHaveLength(1);
  });

  it("the prepared CATCH path stands down when the session was RE-PARKED under a newer event between scopes", async () => {
    // The primary in-lock repair commits under OUR event, but the lock scope then
    // throws (a lock-release race). BEFORE the catch path re-acquires, a newer
    // StopFailure re-parks the session under a NEWER event and installs its
    // ledger record. The catch path must re-read the session and, seeing it no
    // longer parked under OUR event, stand down -- never install our stale event
    // over the newer record (which would re-create the cross-store orphan).
    const { sessDir } = makeOwnedSession(root);
    mockedWithSessionLock.mockImplementationOnce(async (r: string, fn: () => Promise<void>) => {
      await actualSession.withSessionLock(r, fn); // real park + in-lock repair under OUR event
      // Simulate a concurrent newer episode winning the session AND the ledger
      // during our release, then our release failing:
      const cur = findSessionById(r, readState(sessDir).sessionId)!;
      writeSessionSync(sessDir, { ...cur.state, limitEventId: "le-newer-park" } as FullSessionState);
      mutateLimitLedger((ledger) => {
        const rec = ledger.records[KEY]!;
        rec.status = "stopped";
        rec.generation = rec.generation + 3;
        rec.preparingOwner = null;
        rec.limitEventId = "le-newer-park";
        return true;
      });
      throw new Error("lock release raced");
    });

    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit" });

    // The catch path saw the session parked under the NEWER event and stood
    // down: the newer record survives, our stale event was never installed.
    const rec = record();
    const parked = readState(sessDir);
    expect(parked.limitEventId).toBe("le-newer-park");
    expect(rec?.limitEventId).toBe("le-newer-park"); // NOT our original event
    expect(rec?.generation).toBe(4); // the newer record (1 activated + 3), untouched by a stale repair
    expect(Object.keys(readLimitLedger().records)).toHaveLength(1);
  });

  it("a duplicate arriving while the ORIGINAL intent is still PREPARING never parks the session", async () => {
    // The original handler wrote its intent and is still mid-transaction
    // (status preparing). A duplicate StopFailure for the same task must dedupe
    // onto it (ownerToken null) and NOT park/mutate the session -- otherwise, if
    // the real owner later aborts, the parked session would have no ledger
    // pointer (orphan).
    const { sessDir } = makeOwnedSession(root);
    const now = Date.now();
    writePreparingIntent({
      clientTaskId: TASK_ID, storybloqSessionId: readState(sessDir).sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: now,
      resetAt: now + 5 * 3_600_000, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const before = readState(sessDir);
    expect(before.state).not.toBe("COMPACT"); // owner has not parked it yet
    expect(record()?.status).toBe("preparing");

    await handleSessionLimitStop({ clientTaskId: TASK_ID, cwd: root, errorType: "rate_limit", now: now + 2_000 });

    const after = readState(sessDir);
    expect(after.state).toBe(before.state); // session UNTOUCHED
    expect(after.interruptionKind ?? null).toBeNull();
    expect(after.limitStopPending ?? false).toBe(false);
    // Still exactly one record, still preparing for the ORIGINAL owner to activate.
    expect(record()?.status).toBe("preparing");
    expect(Object.keys(readLimitLedger().records)).toHaveLength(1);
  });

  it("never throws: bad transcript path + git failure still resolve", async () => {
    makeOwnedSession(root);
    mockedGitHead.mockRejectedValueOnce(new Error("git exploded"));
    await expect(handleSessionLimitStop({
      clientTaskId: TASK_ID, cwd: root,
      transcriptPath: join(root, "nope", "missing.jsonl"),
      errorType: "rate_limit",
    })).resolves.toBeUndefined();

    const rec = record();
    expect(rec?.status).toBe("stopped");
    expect(rec?.gitHead).toBeNull();
    expect(rec?.resetSource).toBe("fallback");
  });
});

describe("readHookStdinContext StopFailure fields", () => {
  async function parse(payload: Record<string, unknown>): Promise<Awaited<ReturnType<typeof readHookStdinContext>>> {
    const stream = new PassThrough();
    stream.end(JSON.stringify(payload));
    return readHookStdinContext(stream);
  }

  it("surfaces error_type, permission_mode, and hook_event_name", async () => {
    const ctx = await parse({
      session_id: TASK_ID,
      cwd: "/tmp/x",
      transcript_path: "/tmp/x/t.jsonl",
      error_type: "rate_limit",
      permission_mode: "bypassPermissions",
      hook_event_name: "StopFailure",
    });
    expect(ctx.sessionId).toBe(TASK_ID);
    expect(ctx.errorType).toBe("rate_limit");
    expect(ctx.permissionMode).toBe("bypassPermissions");
    expect(ctx.hookEventName).toBe("StopFailure");
  });

  it("accepts the `error` spelling as errorType", async () => {
    const ctx = await parse({ session_id: TASK_ID, error: "rate_limit" });
    expect(ctx.errorType).toBe("rate_limit");
  });

  it("drops oversized permission_mode values", async () => {
    const ctx = await parse({ session_id: TASK_ID, permission_mode: "x".repeat(65) });
    expect(ctx.permissionMode).toBeUndefined();
  });
});
