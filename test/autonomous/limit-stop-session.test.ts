/**
 * T-424: COMPACT-lane wiring for usage-limit stops.
 *
 * prepareForLimitStop / clearInterruption / findResumableSession staleness.
 *
 * T-534 C2: the entries (resume, clear-compact, stop, resume-prompt) now
 * normalise a legacy park instead of honouring it; that behaviour is pinned in
 * retired-limit-park-entries.test.ts. The producer units below leave in C3.
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
  LIMIT_KEYS,
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

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
    // T-534: the limit keys are omitted, never written back as null or false.
    for (const key of LIMIT_KEYS) expect(key in cleared).toBe(false);
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
    for (const key of LIMIT_KEYS) expect(key in downgraded).toBe(false);
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
