/**
 * T-424: COMPACT-lane wiring for usage-limit stops.
 *
 * prepareForLimitStop / clearInterruption / findResumableSession staleness /
 * handleResume limit behavior / clear-compact --force / resume-prompt wording.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { gitHead, gitStatus, gitIsAncestor } from "../../src/autonomous/git-inspector.js";
import {
  createSession,
  writeSessionSync,
  prepareForCompact,
  prepareForLimitStop,
  clearInterruption,
  downgradeLimitParkToCompact,
  findResumableSession,
  validateLimitPermissionMode,
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import {
  handleSessionClearCompact,
  handleSessionResumePrompt,
  handleSessionStop,
} from "../../src/cli/commands/session-compact.js";
import { recordDirectStop, readLimitLedger, limitRecordKey, mutateLimitLedger } from "../../src/core/limit-ledger.js";
import { captureProcessSignatureSync } from "../../src/core/limit-lock.js";
import { spawnSync } from "node:child_process";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

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
/** Attempt fields whose identity resolves to "unknown" on EVERY platform (live pid, no signature). */
function unknownClaimant(): { claimantPid: number; claimantSignature: string | null } {
  return { claimantPid: process.pid, claimantSignature: null };
}

const mockedGitHead = vi.mocked(gitHead);
const mockedGitStatus = vi.mocked(gitStatus);
const mockedGitIsAncestor = vi.mocked(gitIsAncestor);

let root: string;
let globalDir: string;
let savedGlobalDir: string | undefined;
let savedClaudeSession: string | undefined;
let savedWakeAttempt: string | undefined;
let savedDisableWaker: string | undefined;

const RESET_AT = Date.now() + 5 * 3_600_000;
const EVENT_ID = "le-test-0001";

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-03-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
    blockedBy: [], parentTicket: null,
  }));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

function makeWorkingSession(dir: string, overrides: Partial<FullSessionState> = {}): { state: FullSessionState; sessDir: string } {
  const session = createSession(dir, "coding", realpathSync(dir));
  const sessDir = join(dir, ".story", "sessions", session.sessionId);
  const state = writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123", itemBaseHead: "abc123" },
    reviews: { plan: [], code: [] },
    ...overrides,
  } as FullSessionState);
  return { state, sessDir };
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

function limitOpts(overrides: Record<string, unknown> = {}): { expectedHead: string; permissionMode: string | null; resumeAt: number; limitEventId: string } {
  return { expectedHead: "abc123", permissionMode: "acceptEdits", resumeAt: RESET_AT, limitEventId: EVENT_ID, ...overrides };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t424-session-"));
  globalDir = mkdtempSync(join(tmpdir(), "t424-global-"));
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  savedClaudeSession = process.env.CLAUDE_CODE_SESSION_ID;
  savedWakeAttempt = process.env.STORYBLOQ_WAKE_ATTEMPT;
  savedDisableWaker = process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.STORYBLOQ_WAKE_ATTEMPT;
  // These flows call spawnWakerIfNeeded; disable the real detached spawn so no
  // background waker process leaks out of the test.
  process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = "1";
  setupProject(root);
  mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });
  mockedGitStatus.mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } } as never);
  mockedGitIsAncestor.mockResolvedValue({ ok: true, data: false });
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  if (savedClaudeSession !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedClaudeSession;
  else delete process.env.CLAUDE_CODE_SESSION_ID;
  if (savedWakeAttempt !== undefined) process.env.STORYBLOQ_WAKE_ATTEMPT = savedWakeAttempt;
  else delete process.env.STORYBLOQ_WAKE_ATTEMPT;
  if (savedDisableWaker !== undefined) process.env.STORYBLOQ_DISABLE_WAKER_SPAWN = savedDisableWaker;
  else delete process.env.STORYBLOQ_DISABLE_WAKER_SPAWN;
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});

describe("prepareForLimitStop", () => {
  it("parks the session on the COMPACT lane with limit fields", () => {
    const { state, sessDir } = makeWorkingSession(root);
    const result = prepareForLimitStop(sessDir, state, limitOpts());
    expect(result.preCompactState).toBe("IMPLEMENT");

    const parked = readState(sessDir);
    expect(parked.state).toBe("COMPACT");
    expect(parked.compactPending).toBe(true);
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.limitStopPending).toBe(true);
    expect(parked.limitResumeAt).toBe(RESET_AT);
    expect(parked.limitPermissionMode).toBe("acceptEdits");
    expect(parked.limitEventId).toBe(EVENT_ID);
    expect(parked.git.expectedHead).toBe("abc123");
  });

  it("remaps HANDOVER to PICK_TICKET like prepareForCompact", () => {
    const { state, sessDir } = makeWorkingSession(root, { state: "HANDOVER" } as Partial<FullSessionState>);
    const result = prepareForLimitStop(sessDir, state, limitOpts());
    expect(result.preCompactState).toBe("PICK_TICKET");
  });

  it("ALLOWS FINALIZE (parks it; auto-resume is gated elsewhere)", () => {
    const { state, sessDir } = makeWorkingSession(root, { state: "FINALIZE" } as Partial<FullSessionState>);
    const result = prepareForLimitStop(sessDir, state, limitOpts());
    expect(result.preCompactState).toBe("FINALIZE");
    expect(readState(sessDir).interruptionKind).toBe("limit");
  });

  it("throws on SESSION_END and on stale manual COMPACT", () => {
    const { state, sessDir } = makeWorkingSession(root, { state: "SESSION_END" } as Partial<FullSessionState>);
    expect(() => prepareForLimitStop(sessDir, state, limitOpts())).toThrow("already ended");

    const { state: s2, sessDir: d2 } = makeWorkingSession(root, { state: "COMPACT", compactPending: false } as Partial<FullSessionState>);
    expect(() => prepareForLimitStop(d2, s2, limitOpts())).toThrow("not pending");
  });

  it("upgrades a compact-parked session to kind=limit, preserving the resume target", () => {
    const { state, sessDir } = makeWorkingSession(root, { state: "PLAN" } as Partial<FullSessionState>);
    prepareForCompact(sessDir, state, { expectedHead: "abc123" });
    const compacted = readState(sessDir);
    expect(compacted.interruptionKind ?? null).toBeNull();

    const result = prepareForLimitStop(sessDir, compacted, limitOpts());
    expect(result.preCompactState).toBe("PLAN");
    const parked = readState(sessDir);
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.preCompactState).toBe("PLAN");
    expect(parked.limitResumeAt).toBe(RESET_AT);
  });

  it("re-limit on a limit-parked session takes the NEW event's fields", () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    const newReset = RESET_AT + 3_600_000;
    prepareForLimitStop(sessDir, readState(sessDir), limitOpts({ resumeAt: newReset, limitEventId: "le-test-0002", permissionMode: "bypassPermissions" }));
    const parked = readState(sessDir);
    expect(parked.limitResumeAt).toBe(newReset);
    expect(parked.limitEventId).toBe("le-test-0002");
    expect(parked.limitPermissionMode).toBe("bypassPermissions");
    expect(parked.preCompactState).toBe("IMPLEMENT");
  });

  it("validates permission mode against the closed set", () => {
    expect(validateLimitPermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(validateLimitPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(validateLimitPermissionMode("default")).toBe("default");
    expect(validateLimitPermissionMode("plan")).toBe("plan");
    expect(validateLimitPermissionMode("sudo-everything")).toBeNull();
    expect(validateLimitPermissionMode(null)).toBeNull();
    expect(validateLimitPermissionMode(undefined)).toBeNull();
  });
});

describe("prepareForCompact on a limit-parked session", () => {
  it("keeps kind=limit and does not clobber limitResumeAt (idempotency branch)", () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    prepareForCompact(sessDir, readState(sessDir), { expectedHead: "def456" });
    const parked = readState(sessDir);
    expect(parked.interruptionKind).toBe("limit");
    expect(parked.limitResumeAt).toBe(RESET_AT);
    expect(parked.limitEventId).toBe(EVENT_ID);
    expect(parked.git.expectedHead).toBe("def456");
  });
});

describe("clearInterruption", () => {
  it("clears COMPACT markers and every limit field atomically (on the already-resumed path)", () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    // clearInterruption's contract is the post-resume tail: the session has
    // ALREADY left COMPACT (state restored to preCompactState). Model that first
    // so the fixture is valid, not a stranded COMPACT-but-not-pending record.
    writeSessionSync(sessDir, { ...readState(sessDir), state: "IMPLEMENT" });
    clearInterruption(sessDir, readState(sessDir));
    const cleared = readState(sessDir);
    expect(cleared.state).toBe("IMPLEMENT"); // stays out of COMPACT
    expect(cleared.compactPending).toBe(false);
    expect(cleared.preCompactState).toBeNull();
    expect(cleared.interruptionKind ?? null).toBeNull();
    expect(cleared.limitStopPending).toBe(false);
    expect(cleared.limitResumeAt).toBeNull();
    expect(cleared.limitPermissionMode).toBeNull();
    expect(cleared.limitEventId).toBeNull();
  });
});

describe("downgradeLimitParkToCompact", () => {
  it("downgrades a still-parked limit stop to an ordinary compact park (cancellation path)", () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    // Cancellation clears the auto-resume WHILE the session is still parked in
    // COMPACT: it must stay a resumable compact park (state COMPACT +
    // compactPending), never clearInterruption's stranded state, and every limit
    // field must be gone so a later ordinary compaction starts clean.
    downgradeLimitParkToCompact(sessDir, readState(sessDir));
    const downgraded = readState(sessDir);
    expect(downgraded.state).toBe("COMPACT");
    expect(downgraded.compactPending).toBe(true);
    expect(downgraded.interruptionKind ?? null).toBeNull();
    expect(downgraded.limitStopPending).toBe(false);
    expect(downgraded.limitResumeAt).toBeNull();
    expect(downgraded.limitPermissionMode).toBeNull();
    expect(downgraded.limitEventId).toBeNull();
    // Still discoverable as a resumable compact session.
    const match = findResumableSession(root);
    expect(match).not.toBeNull();
  });

  it("KEEPS a FINALIZE park limit-kind on downgrade so the manual-recovery gate survives cancellation", () => {
    // Cancelling a FINALIZE limit park must NOT convert it to a clean compact
    // park: clearing interruptionKind is the guide's "git state verified" signal
    // (clear-compact --force), so a clean downgrade would let the generic resume
    // path replay finalization with no verification (duplicate commits). The park
    // stays limit-kind with preCompactState FINALIZE (gate held); only the
    // scheduling fields clear. The cancelled LEDGER record is what stops auto-resume.
    const { state, sessDir } = makeWorkingSession(root, { state: "FINALIZE" });
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    expect(parked.preCompactState).toBe("FINALIZE");
    expect(parked.interruptionKind).toBe("limit");

    downgradeLimitParkToCompact(sessDir, readState(sessDir));
    const downgraded = readState(sessDir);
    expect(downgraded.state).toBe("COMPACT");
    expect(downgraded.compactPending).toBe(true);
    expect(downgraded.interruptionKind).toBe("limit"); // gate preserved
    expect(downgraded.preCompactState).toBe("FINALIZE"); // gate preserved
    expect(downgraded.limitStopPending).toBe(false); // scheduling cleared
    expect(downgraded.limitResumeAt).toBeNull();
    expect(downgraded.limitPermissionMode).toBeNull();
  });
});

describe("findResumableSession staleness (limit-aware)", () => {
  it("a limit park hours old is NOT stale while its reset is still ahead", () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    // Age the prepared timestamp far past the 1h compact window.
    writeSessionSync(sessDir, {
      ...readState(sessDir),
      compactPreparedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    });
    const match = findResumableSession(root);
    expect(match).not.toBeNull();
    expect(match!.stale).toBe(false);
  });

  it("a limit park past reset + grace IS stale", () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts({ resumeAt: Date.now() - 25 * 3_600_000 }));
    const match = findResumableSession(root);
    expect(match).not.toBeNull();
    expect(match!.stale).toBe(true);
  });

  it("compact-kind staleness keeps the 1h window", () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForCompact(sessDir, state, { expectedHead: "abc123" });
    writeSessionSync(sessDir, {
      ...readState(sessDir),
      compactPreparedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    const match = findResumableSession(root);
    expect(match!.stale).toBe(true);
  });
});

describe("handleResume for limit-parked sessions", () => {
  it("resumes and clears ALL limit fields (Branch A)", async () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: parked.sessionId });
    expect(result.isError).toBeFalsy();

    const resumed = readState(sessDir);
    expect(resumed.state).toBe("IMPLEMENT");
    expect(resumed.compactPending).toBe(false);
    expect(resumed.interruptionKind ?? null).toBeNull();
    expect(resumed.limitStopPending).toBe(false);
    expect(resumed.limitResumeAt).toBeNull();
    expect(resumed.limitPermissionMode).toBeNull();
    expect(resumed.limitEventId).toBeNull();
  });

  it("clears limit fields on the drift-recovery path too", async () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "drifted99" } });

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: parked.sessionId });
    expect(result.isError).toBeFalsy();

    const resumed = readState(sessDir);
    expect(resumed.state).not.toBe("COMPACT");
    expect(resumed.interruptionKind ?? null).toBeNull();
    expect(resumed.limitStopPending).toBe(false);
  });

  it("rejects ordinary resume of a FINALIZE limit stop with manual-recovery instructions", async () => {
    const { state, sessDir } = makeWorkingSession(root, { state: "FINALIZE" } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: parked.sessionId });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("usage limit during FINALIZE");
    expect(text).toContain("git log");
    expect(text).toContain(`clear-compact ${parked.sessionId} --force`);

    // Session stays parked and discoverable.
    const after = readState(sessDir);
    expect(after.state).toBe("COMPACT");
    expect(after.compactPending).toBe(true);
    expect(after.interruptionKind).toBe("limit");
  });

  it("rejects a FINALIZE limit resume BEFORE any recovery mutation runs", async () => {
    // Seed a pending deferral: an ordinary FINALIZE limit resume must reject
    // without draining it (no resume-side writes before the guard).
    const { state, sessDir } = makeWorkingSession(root, { state: "FINALIZE" } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    writeSessionSync(sessDir, {
      ...parked,
      pendingDeferrals: [{ fingerprint: "fp-1", title: "deferred finding", severity: "minor", source: "code_review" }],
    } as unknown as FullSessionState);
    const beforeRevision = readState(sessDir).revision;

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: parked.sessionId });
    expect(result.isError).toBe(true);

    const after = readState(sessDir);
    expect(after.revision).toBe(beforeRevision); // no session writes at all
    expect((after as unknown as { pendingDeferrals: unknown[] }).pendingDeferrals).toHaveLength(1);
  });

  it("force-clear then clean-HEAD resume re-enters FINALIZE at its recorded checkpoint", async () => {
    // The sanctioned manual-recovery path: after the user verifies git state,
    // clear-compact --force drops the limit gate. With HEAD unchanged the
    // generic resume restores FINALIZE directly.
    //
    // Scope, stated honestly (ISS-922): this pins ONLY that `state` and
    // `finalizeCheckpoint` survive the force-clear and the resume. HEAD equals
    // the baseline throughout and no landed commit is modelled, so it proves
    // nothing about already-landed commits being detected and skipped -- the
    // claim its earlier comment made. That guarantee is pinned for real, over
    // a repository with an actual work commit, in finalize-iss922.test.ts.
    const { state, sessDir } = makeWorkingSession(root, {
      state: "FINALIZE",
      finalizeCheckpoint: "precommit_passed",
    } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);

    const msg = await handleSessionClearCompact(root, parked.sessionId, { force: true });
    expect(msg).toContain("re-enters FINALIZE at its recorded checkpoint");

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: parked.sessionId });
    expect(result.isError).toBeFalsy();
    const resumed = readState(sessDir);
    expect(resumed.state).toBe("FINALIZE");
    expect(resumed.finalizeCheckpoint).toBe("precommit_passed");
    expect(resumed.interruptionKind ?? null).toBeNull();
    expect(resumed.limitStopPending).toBe(false);
  });

  it("force-clear then drifted-HEAD resume routes FINALIZE through RECOVERY_MAPPING to IMPLEMENT", async () => {
    // If the workspace moved externally while stopped, the drift branch maps
    // FINALIZE -> IMPLEMENT with the code checkpoint reset instead of
    // re-entering finalization against an unknown tree.
    const { state, sessDir } = makeWorkingSession(root, {
      state: "FINALIZE",
      finalizeCheckpoint: "precommit_passed",
      reviews: {
        plan: [],
        code: [{
          round: 1, reviewer: "codex", verdict: "approve", findingCount: 0,
          criticalCount: 0, majorCount: 0, suggestionCount: 0,
          timestamp: new Date().toISOString(),
        }],
      },
    } as unknown as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);

    await handleSessionClearCompact(root, parked.sessionId, { force: true });

    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "def999" } });
    mockedGitIsAncestor.mockResolvedValue({ ok: true, data: false });

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: parked.sessionId });
    expect(result.isError).toBeFalsy();
    const resumed = readState(sessDir);
    expect(resumed.state).toBe("IMPLEMENT");
    expect(resumed.finalizeCheckpoint).toBeNull();
    expect(resumed.reviews.code).toHaveLength(0); // resetCode
    expect(resumed.interruptionKind ?? null).toBeNull();
  });
});

describe("clear-compact --force for limit-parked sessions", () => {
  it("refuses without --force, naming the pending auto-resume", async () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);

    await expect(handleSessionClearCompact(root, parked.sessionId)).rejects.toThrow(/pending auto-resume.*--force/s);
    expect(readState(sessDir).interruptionKind).toBe("limit");
  });

  it("with --force clears limit fields, keeps the session resumable, cancels the ledger record", async () => {
    const ownerTask = { client: "claude" as const, id: "task-uuid-1", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-uuid-1",
      storybloqSessionId: parked.sessionId,
      projectRoot: root,
      cwd: root,
      sessionType: "autonomous",
      limitType: "session",
      transcriptPath: null,
      detectedAt: Date.now(),
      resetAt: RESET_AT,
      resetSource: "absolute",
      rawBanner: null,
      mode: "headless",
      gitHead: "abc123",
    });

    const msg = await handleSessionClearCompact(root, parked.sessionId, { force: true });
    expect(msg).toContain("Compact markers cleared");

    const after = readState(sessDir);
    expect(after.compactPending).toBe(true); // still resumable
    expect(after.interruptionKind ?? null).toBeNull(); // no longer limit-gated
    expect(after.limitStopPending).toBe(false);

    const rec = readLimitLedger().records[limitRecordKey("task-uuid-1")]!;
    expect(rec.status).toBe("cancelled");
  });

  it("force-clear during the claim-to-spawn window refuses, leaving the record cancelling and the session UNTOUCHED", async () => {
    // Safety-critical: a wake attempt is mid-spawn (claimed, childPid not yet
    // recorded). Force-clear must NOT clear session state under a child that may
    // land any moment. cancelLimitAutoResume CAS's the record to `cancelling`
    // then throws BEFORE any session write -- the two-phase contract.
    const ownerTask = { client: "claude" as const, id: "task-inflight-fc", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-inflight-fc", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-inflight-fc");
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-mid", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });

    await expect(handleSessionClearCompact(root, parked.sessionId, { force: true }))
      .rejects.toThrow(/mid-spawn/i);

    // Record stood down to non-dispatchable `cancelling`; the waker finishes it.
    expect(readLimitLedger().records[key]!.status).toBe("cancelling");
    // Session state was never written -- still limit-parked, nothing cleared.
    const after = readState(sessDir);
    expect(after.interruptionKind).toBe("limit");
    expect(after.limitStopPending).toBe(true);
  });

  it("force-clear with a null-childPid claim whose CLAIMANT is CONFIRMED DEAD completes synchronously (no waker dependency)", async () => {
    // A null-childPid attempt whose claimant is confirmed dead is abandoned (the
    // claimant crashed before spawning); no child will materialize. The cancel
    // must terminalize HERE -- relying on the waker would strand the record
    // `cancelling` forever under the global kill switch. Positive death
    // evidence, not wall-clock age, is what completes it.
    const ownerTask = { client: "claude" as const, id: "task-stale-fc", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-stale-fc", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-stale-fc");
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-stale", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(), // FRESH -- death, not age, completes it
        ...deadClaimant(),
      };
      return true;
    });

    const msg = await handleSessionClearCompact(root, parked.sessionId, { force: true });
    expect(msg).toContain("Compact markers cleared");

    // Record terminalized synchronously; session downgraded to an ordinary
    // compact park (still resumable, limit gate dropped).
    expect(readLimitLedger().records[key]!.status).toBe("cancelled");
    const after = readState(sessDir);
    expect(after.compactPending).toBe(true);
    expect(after.interruptionKind ?? null).toBeNull();
    expect(after.limitStopPending).toBe(false);
  });

  it("force-clear REFUSES while a SUSPENDED (alive) claimant could still spawn, even past the stale age", async () => {
    if (!SIG_SUPPORTED) return; // requires a positive "alive" identity
    // A claimant alive but aged past CLAIM_SPAWN_STALE_MS (suspended, e.g. across
    // laptop sleep) may still resume and spawn a child. Age alone must NOT
    // terminalize: the record stands down to `cancelling` and the session stays
    // limit-parked and UNTOUCHED, exactly as for an in-flight claim.
    const ownerTask = { client: "claude" as const, id: "task-suspended-fc", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-suspended-fc", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-suspended-fc");
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-suspended", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now() - 130_000, // aged, but claimant alive
        ...liveClaimant(),
      };
      return true;
    });

    await expect(handleSessionClearCompact(root, parked.sessionId, { force: true }))
      .rejects.toThrow(/mid-spawn/i);

    expect(readLimitLedger().records[key]!.status).toBe("cancelling"); // NOT cancelled
    const after = readState(sessDir);
    expect(after.interruptionKind).toBe("limit");
    expect(after.limitStopPending).toBe(true);
  });

  it("force-clear REFUSES while claimant identity is UNKNOWN, even past the stale age (all platforms)", async () => {
    // Identity is "unknown" on platforms with no process signature or after a
    // transient inspection failure. A recorded claimant that is unknown may be
    // alive/suspended: age must NOT override it. Runs on EVERY platform.
    const ownerTask = { client: "claude" as const, id: "task-unknown-fc", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-unknown-fc", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-unknown-fc");
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-unknown", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now() - 130_000, // aged, identity unknown
        ...unknownClaimant(),
      };
      return true;
    });

    await expect(handleSessionClearCompact(root, parked.sessionId, { force: true }))
      .rejects.toThrow(/mid-spawn/i);

    expect(readLimitLedger().records[key]!.status).toBe("cancelling"); // NOT cancelled
    const after = readState(sessDir);
    expect(after.interruptionKind).toBe("limit");
    expect(after.limitStopPending).toBe(true);
  });

  it("admin stop during the claim-to-spawn window refuses and leaves the session intact", async () => {
    // handleSessionStop uses the same deferred two-phase cancel: an in-flight
    // attempt throws before SESSION_END is written, so the session is not
    // terminalized beside a potentially-live wake child.
    const ownerTask = { client: "claude" as const, id: "task-inflight-stop", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-inflight-stop", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-inflight-stop");
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-mid2", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });

    await expect(handleSessionStop(root, parked.sessionId)).rejects.toThrow(/mid-spawn/i);

    expect(readLimitLedger().records[key]!.status).toBe("cancelling");
    // Not terminalized: the session is still its pre-stop active/parked state.
    expect(readState(sessDir).state).not.toBe("SESSION_END");
  });
});

describe("resume-prompt wording for limit-parked sessions", () => {
  async function captureResumePrompt(): Promise<string> {
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      out += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    try {
      await handleSessionResumePrompt({ source: "resume", cwd: root });
    } finally {
      spy.mockRestore();
    }
    return out;
  }

  it("emits limit-aware wording (never the stale clear-compact text) for a pending limit park", async () => {
    const { state, sessDir } = makeWorkingSession(root);
    prepareForLimitStop(sessDir, state, limitOpts());
    // Age past the compact 1h window -- the old code would have called this stale.
    writeSessionSync(sessDir, {
      ...readState(sessDir),
      compactPreparedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    });

    const out = await captureResumePrompt();
    expect(out).toContain("paused at a usage limit");
    expect(out).toContain('"action": "resume"');
    expect(out).not.toContain("Stale compacted session");
    expect(out).not.toContain("clear-compact");
  });

  it("emits manual-recovery wording for a FINALIZE limit stop", async () => {
    const { state, sessDir } = makeWorkingSession(root, { state: "FINALIZE" } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());

    const out = await captureResumePrompt();
    expect(out).toContain("during FINALIZE");
    expect(out).toContain("git log");
    expect(out).not.toContain('"action": "resume"');
  });

  it("stays silent for the waker's own LIVE child (claim + matching resuming ledger attempt)", async () => {
    // The claim file alone is not authoritative: silence requires the ledger to
    // still show this exact attempt as the live `resuming` attempt.
    const ownerTask = { client: "claude" as const, id: "task-self-wake", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    process.env.CLAUDE_CODE_SESSION_ID = "task-self-wake";
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-self-wake", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-self-wake");
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "at-1", token: "tok-1", generation: rec.generation,
        childPid: 4_242, spawnedAt: Date.now(), transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });
    const { writeWakeClaim } = await import("../../src/autonomous/wake-claim.js");
    const gen = readLimitLedger().records[key]!.generation;
    writeWakeClaim(sessDir, { attemptId: "at-1", token: "tok-1", generation: gen, childPid: 4_242, createdAt: Date.now() });
    process.env.STORYBLOQ_WAKE_ATTEMPT = "at-1.tok-1";

    const out = await captureResumePrompt();
    expect(out).toBe("");
    // The record is untouched (still the live resuming attempt).
    expect(readLimitLedger().records[key]!.status).toBe("resuming");
  });

  it("stands a token-carrying child down when its attempt was superseded (stale claim, no live ledger attempt)", async () => {
    // A crashed/superseded waker left a claim file, but the ledger no longer
    // shows a matching resuming attempt. The child must NOT proceed to the
    // guide -- it is doomed (the waker terminates it) and would otherwise race
    // the interactive session.
    const ownerTask = { client: "claude" as const, id: "task-stale-claim", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    process.env.CLAUDE_CODE_SESSION_ID = "task-stale-claim";
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-stale-claim", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    // Ledger stays `stopped` (no resuming attempt), but a stale claim exists.
    const { writeWakeClaim } = await import("../../src/autonomous/wake-claim.js");
    writeWakeClaim(sessDir, { attemptId: "at-stale", token: "tok-stale", generation: 1, childPid: null, createdAt: Date.now() });
    process.env.STORYBLOQ_WAKE_ATTEMPT = "at-stale.tok-stale";

    const out = await captureResumePrompt();
    expect(out).toContain("superseded");
    expect(out).not.toContain('"action": "resume"');
  });

  it("OWNERLESS reopen resolves the CURRENT episode (storybloqSessionId+limitEventId) and stands the waker down, ignoring a stale episode", async () => {
    // A session that lost BOTH owner identifiers cannot derive its ledger key.
    // resolveOwnerlessRecord must locate the CURRENT-episode record and drive the
    // takeover -- never a stale episode's record, and never a bare guide.
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.STORYBLOQ_WAKE_ATTEMPT;
    const { state, sessDir } = makeWorkingSession(root, {
      ownerTask: undefined, claudeCodeSessionId: undefined,
    } as Partial<FullSessionState>);
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    expect(parked.ownerTask ?? null).toBeNull();
    expect(parked.claudeCodeSessionId ?? null).toBeNull();
    expect(parked.limitEventId).toBe(EVENT_ID);

    const baseStop = {
      storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous" as const, limitType: "session" as const, transcriptPath: null,
      detectedAt: Date.now(), resetAt: RESET_AT, resetSource: "absolute" as const,
      rawBanner: null, mode: "headless" as const, gitHead: "abc123",
    };
    recordDirectStop({ ...baseStop, clientTaskId: "ownerless-stale" });
    recordDirectStop({ ...baseStop, clientTaskId: "ownerless-current" });
    const curKey = limitRecordKey("ownerless-current");
    const staleKey = limitRecordKey("ownerless-stale");
    mutateLimitLedger((ledger) => {
      // Stale episode: same session, DIFFERENT event -> must be ignored.
      ledger.records[staleKey]!.limitEventId = "le-stale-0000";
      // Current episode: matches the parked session's event, mid headless resume.
      const cur = ledger.records[curKey]!;
      cur.limitEventId = EVENT_ID;
      cur.status = "resuming";
      cur.attempt = {
        id: "wa-ownerless", token: "t", generation: cur.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });

    const out = await captureResumePrompt();
    expect(out).toContain("is being stopped in favor of this interactive session");
    expect(out).not.toContain('"action": "resume"');
    // The CURRENT record was taken over; the stale episode is untouched.
    expect(readLimitLedger().records[curKey]!.status).toBe("interactive");
    expect(readLimitLedger().records[staleKey]!.status).toBe("stopped");
  });

  it("a tokenless reopen of a resuming record emits the retry message even before childPid lands", async () => {
    // The waker may be BETWEEN claim and spawn (attempt.childPid still null).
    // Emitting the normal resume instruction here would let two clients drive
    // one transcript; the reopen must get the stand-down/retry message.
    // An interactive `claude --resume <id>` reuses the same session id, so the
    // reopen presents the owner's identity (same owner) but no wake-attempt
    // token (not our child).
    const ownerTask = { client: "claude" as const, id: "task-uuid-race", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    process.env.CLAUDE_CODE_SESSION_ID = "task-uuid-race";
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-uuid-race",
      storybloqSessionId: parked.sessionId,
      projectRoot: root,
      cwd: root,
      sessionType: "autonomous",
      limitType: "session",
      transcriptPath: null,
      detectedAt: Date.now(),
      resetAt: RESET_AT,
      resetSource: "absolute",
      rawBanner: null,
      mode: "headless",
      gitHead: "abc123",
    });
    const key = limitRecordKey("task-uuid-race");
    // Claimed but not yet spawned: resuming, childPid null.
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "resuming";
      rec.attempt = {
        id: "wa-inflight", token: "t", generation: rec.generation,
        childPid: null, spawnedAt: null, transcriptOffset: null,
        stateRevision: null, lastProgressAt: Date.now(),
      };
      return true;
    });

    const out = await captureResumePrompt();
    expect(out).toContain("is being stopped in favor of this interactive session");
    expect(out).not.toContain('"action": "resume"');
    // The record was CAS'd to interactive, so the waker's recordAttemptSpawn
    // (and any later dispatch) loses its CAS.
    expect(readLimitLedger().records[key]!.status).toBe("interactive");
  });

  it("stands down (no guide) when the record is already CANCELLING with an in-flight attempt", async () => {
    // A cancellation is terminating a wake child. A tokenless reopen must NOT be
    // told to call the guide (it would race the in-flight cancellation); the
    // transition guard emits a stand-down/retry instead.
    const ownerTask = { client: "claude" as const, id: "task-cancelling", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    process.env.CLAUDE_CODE_SESSION_ID = "task-cancelling";
    delete process.env.STORYBLOQ_WAKE_ATTEMPT;
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-cancelling", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-cancelling");
    mutateLimitLedger((ledger) => {
      const rec = ledger.records[key]!;
      rec.status = "cancelling";
      rec.attempt = {
        id: "wa-cancel", token: "t", generation: rec.generation, childPid: 5_150,
        spawnedAt: Date.now() - 1_000, transcriptOffset: null, stateRevision: null, lastProgressAt: Date.now() - 1_000,
      };
      return true;
    });

    const out = await captureResumePrompt();
    expect(out).toContain("mid-transition");
    expect(out).not.toContain('"action": "resume"');
    // The reopen never mutated the cancellation.
    expect(readLimitLedger().records[key]!.status).toBe("cancelling");
    expect(readLimitLedger().records[key]!.attempt?.childPid).toBe(5_150);
  });

  it("FAILS CLOSED (retry, no guide, no CAS) when the wake-claim lock is unavailable", async () => {
    // A transient wake-claim-lock failure means we cannot PROVE no headless
    // attempt owns the session. The interactive reopen must not be authorized to
    // resume (two clients could drive one transcript); it stands down instead.
    const ownerTask = { client: "claude" as const, id: "task-lockbusy", boundAt: new Date().toISOString() };
    const { state, sessDir } = makeWorkingSession(root, { ownerTask } as Partial<FullSessionState>);
    process.env.CLAUDE_CODE_SESSION_ID = "task-lockbusy";
    delete process.env.STORYBLOQ_WAKE_ATTEMPT;
    prepareForLimitStop(sessDir, state, limitOpts());
    const parked = readState(sessDir);
    recordDirectStop({
      clientTaskId: "task-lockbusy", storybloqSessionId: parked.sessionId, projectRoot: root, cwd: root,
      sessionType: "autonomous", limitType: "session", transcriptPath: null, detectedAt: Date.now(),
      resetAt: RESET_AT, resetSource: "absolute", rawBanner: null, mode: "headless", gitHead: "abc123",
    });
    const key = limitRecordKey("task-lockbusy");

    const { wakeClaimLockPath } = await import("../../src/autonomous/wake-claim.js");
    const { acquireLimitLock, releaseLimitLock } = await import("../../src/core/limit-lock.js");
    // Hold the wake-claim lock so the reopen's takeover CAS cannot even acquire.
    const held = acquireLimitLock(wakeClaimLockPath(sessDir));
    expect(held).not.toBeNull();
    try {
      const out = await captureResumePrompt();
      expect(out).not.toContain('"action": "resume"');
      expect(out).toContain("retry");
      // No CAS happened: the record stays `stopped`, never converted to interactive.
      expect(readLimitLedger().records[key]!.status).toBe("stopped");
    } finally {
      releaseLimitLock(held!);
    }
  });
});
