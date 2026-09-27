/**
 * T-534: the session helpers that outlive the retired usage-limit auto-resume
 * (T-424). clearInterruption strips the five legacy keys, and a legacy park
 * gets no special staleness window: findResumableSession applies the ordinary
 * one-hour compact rule. The entries' normalisation of a legacy park is pinned
 * in retired-limit-park-entries.test.ts.
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
  clearInterruption,
  findResumableSession,
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

/** Plant a park as the retired auto-resume wrote it: COMPACT plus the raw limit keys. */
function plantLegacyLimitPark(sessDir: string, state: FullSessionState, fields: Record<string, unknown> = {}): void {
  writeSessionSync(sessDir, {
    ...state,
    state: "COMPACT",
    previousState: state.state,
    preCompactState: state.state,
    resumeFromRevision: state.revision,
    compactPending: true,
    compactPreparedAt: new Date().toISOString(),
    compactObservedAt: null,
    interruptionKind: "limit",
    limitStopPending: true,
    limitResumeAt: RESET_AT,
    limitPermissionMode: "acceptEdits",
    limitEventId: EVENT_ID,
    ...fields,
  } as FullSessionState);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t424-session-"));
  globalDir = mkdtempSync(join(tmpdir(), "t424-global-"));
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  savedClaudeSession = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
  delete process.env.CLAUDE_CODE_SESSION_ID;
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
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});

describe("clearInterruption", () => {
  it("clears COMPACT markers and every legacy limit key atomically (on the already-resumed path)", () => {
    const { state, sessDir } = makeWorkingSession(root);
    plantLegacyLimitPark(sessDir, state);
    // clearInterruption's contract is the post-resume tail: the session has
    // ALREADY left COMPACT (state restored to preCompactState). Model that first
    // so the fixture is valid, not a stranded COMPACT-but-not-pending record.
    writeSessionSync(sessDir, { ...readState(sessDir), state: "IMPLEMENT" });
    clearInterruption(sessDir, readState(sessDir));
    const cleared = readState(sessDir);
    expect(cleared.state).toBe("IMPLEMENT"); // stays out of COMPACT
    expect(cleared.compactPending).toBe(false);
    expect(cleared.preCompactState).toBeNull();
    // The limit keys are omitted, never written back as null or false.
    for (const key of LIMIT_KEYS) expect(key in cleared).toBe(false);
  });
});

describe("findResumableSession staleness", () => {
  it("a legacy limit park hours old IS stale even while its reset is still ahead", () => {
    const { state, sessDir } = makeWorkingSession(root);
    plantLegacyLimitPark(sessDir, state, {
      compactPreparedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    });
    const match = findResumableSession(root);
    expect(match).not.toBeNull();
    expect(match!.stale).toBe(true);
  });

  it("a fresh legacy limit park is not stale", () => {
    const { state, sessDir } = makeWorkingSession(root);
    plantLegacyLimitPark(sessDir, state);
    const match = findResumableSession(root);
    expect(match).not.toBeNull();
    expect(match!.stale).toBe(false);
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
