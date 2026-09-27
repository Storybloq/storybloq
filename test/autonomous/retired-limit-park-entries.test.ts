/**
 * T-534 Part B at the entries that act on a session: guide resume, start and
 * pre_compact, CLI clear-compact and stop. Each entry normalises a legacy
 * usage-limit park (or checks its surviving wake attempts) before it acts,
 * refuses on a failure, and never writes a limit key back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffTreeNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
}));

// A pass-through spy, so one test can interleave a concurrent writer.
vi.mock("../../src/autonomous/retired-limit-park.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/autonomous/retired-limit-park.js")>();
  return { ...real, normalizeRetiredLimitPark: vi.fn(real.normalizeRetiredLimitPark) };
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { gitDiffTreeNames, gitHead, gitIsAncestor } from "../../src/autonomous/git-inspector.js";
import { normalizeRetiredLimitPark } from "../../src/autonomous/retired-limit-park.js";
import { createSession, withoutLimitKeys, writeSessionSync } from "../../src/autonomous/session.js";
import { handleSessionClearCompact, handleSessionCompactPrepare, handleSessionResumePrompt, handleSessionStop } from "../../src/cli/commands/session-compact.js";
import { handleSessionRepair } from "../../src/cli/commands/session.js";
import { acquireProjectLockAsync, releaseProjectLock } from "../../src/core/project-lock.js";
import { RETIREMENT_LOCK_BASENAME } from "../../src/core/limit-retirement.js";
import { deriveWorkspaceId, parseSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const LIMIT = {
  interruptionKind: "limit",
  limitStopPending: true,
  limitResumeAt: Date.parse("2026-09-01T00:00:00.000Z"),
  limitPermissionMode: "bypassPermissions",
  limitEventId: "evt-1",
};
const LIMIT_KEY_NAMES = Object.keys(LIMIT);
const HEAD = "abc123";

let root: string;
let globalDir: string;

function setupProject(dir: string): void {
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 1,
    schemaVersion: 1,
    project: "t534",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    // A clean start runs no test baseline here.
    recipeOverrides: { stages: { WRITE_TESTS: { enabled: false } } },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "t534",
    date: "2026-09-26",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(story, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-09-26",
    blockedBy: [], parentTicket: null,
  }));
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
}

/** A session written through the real writer, then overwritten with raw keys. */
function plant(fields: Record<string, unknown>, workspaceId = "test-workspace"): { id: string; dir: string } {
  const session = createSession(root, "coding", workspaceId);
  const dir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(dir, {
    ...session,
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: HEAD, expectedHead: HEAD, initHead: HEAD, itemBaseHead: HEAD },
  } as never);
  const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8")) as Record<string, unknown>;
  const next = { ...withoutLimitKeys(raw), ...fields };
  // A planted fixture must be a session the reader accepts, or a test would
  // pass on a parse refusal instead of reaching the normalisation.
  expect(parseSessionState(next).success).toBe(true);
  writeFileSync(join(dir, "state.json"), JSON.stringify(next, null, 2) + "\n");
  return { id: session.sessionId, dir };
}

const park = (over: Record<string, unknown> = {}) => ({
  state: "COMPACT",
  compactPending: true,
  preCompactState: "PLAN",
  compactPreparedAt: new Date().toISOString(),
  ...LIMIT,
  ...over,
});

const rawText = (dir: string) => readFileSync(join(dir, "state.json"), "utf-8");
const raw = (dir: string) => JSON.parse(rawText(dir)) as Record<string, unknown>;
const limitKeysIn = (dir: string) => Object.keys(raw(dir)).filter((k) => LIMIT_KEY_NAMES.includes(k));
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

const OWNER = { client: "claude", id: "owner-task", boundAt: "2026-09-26T00:00:00.000Z" };
const liveLease = (workspaceId = "test-workspace") => ({
  workspaceId,
  lastHeartbeat: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
});
/** The file as it is, revision included: a refusal must leave it byte-identical. */
const snapshot = (dir: string) => ({ text: rawText(dir), revision: raw(dir).revision });

/** A bare claim with no signature is unverifiable, so it is preserved and holds its session. */
function holdAttempt(sessionId: string): void {
  writeFileSync(join(globalDir, "limit-ledger.json"), JSON.stringify({
    schemaVersion: 1,
    records: {
      "claude:task-1": {
        clientTaskId: "task-1",
        projectRoot: root,
        storybloqSessionId: sessionId,
        attempt: { id: "wake-a1", childPid: null, claimantPid: process.pid, claimantSignature: null },
      },
    },
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t534-entries-"));
  globalDir = mkdtempSync(join(tmpdir(), "t534-entries-global-"));
  vi.stubEnv("STORYBLOQ_GLOBAL_DIR", globalDir);
  setupProject(root);
  vi.mocked(gitHead).mockResolvedValue({ ok: true, data: { hash: HEAD } } as never);
  vi.mocked(gitIsAncestor).mockResolvedValue({ ok: true, data: false } as never);
  vi.mocked(gitDiffTreeNames).mockResolvedValue({ ok: false } as never);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(globalDir, { recursive: true, force: true });
});

describe("guide resume", () => {
  it("normalises a legacy park, resumes it, and writes no limit key back", async () => {
    const { id, dir } = plant(park());
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
    expect(result.isError).toBeFalsy();
    expect(limitKeysIn(dir)).toEqual([]);

    const settled = rawText(dir);
    expect((await normalizeRetiredLimitPark(root, id)).kind).toBe("unchanged");
    expect(rawText(dir)).toBe(settled);
  });

  it("refuses while a wake attempt survives, leaving the session and ledger untouched", async () => {
    const { id, dir } = plant(park());
    holdAttempt(id);
    const ledgerBefore = readFileSync(join(globalDir, "limit-ledger.json"), "utf-8");
    const before = rawText(dir);

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("wake-a1");
    expect(rawText(dir)).toBe(before);
    expect(readFileSync(join(globalDir, "limit-ledger.json"), "utf-8")).toBe(ledgerBefore);
  });

  it("refuses the same way while Part A's retirement lock is held", async () => {
    const { id, dir } = plant(park());
    holdAttempt(id);
    const lock = await acquireProjectLockAsync(join(globalDir, RETIREMENT_LOCK_BASENAME), { deadlineMs: 1000 });
    try {
      const before = rawText(dir);
      const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
      expect(result.isError).toBe(true);
      expect(rawText(dir)).toBe(before);
    } finally {
      releaseProjectLock(lock);
    }
  });

  it("refuses on a malformed ledger and names the file", async () => {
    const { id } = plant(park());
    writeFileSync(join(globalDir, "limit-ledger.json"), "{broken");
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(join(globalDir, "limit-ledger.json"));
  });

  it("resumes once the attempt is gone", async () => {
    const { id } = plant(park());
    holdAttempt(id);
    expect((await handleAutonomousGuide(root, { action: "resume", sessionId: id })).isError).toBe(true);
    await rm(join(globalDir, "limit-ledger.json"));
    expect((await handleAutonomousGuide(root, { action: "resume", sessionId: id })).isError).toBeFalsy();
  });
});

describe("session clear-compact", () => {
  it("normalises then clears, with no limit key written", async () => {
    const { id, dir } = plant(park());
    const message = await handleSessionClearCompact(root, id);
    expect(message).toContain("Compact markers cleared");
    expect(limitKeysIn(dir)).toEqual([]);
    expect(raw(dir)).toMatchObject({ state: "COMPACT", compactPending: true });
  });

  it("refuses while a wake attempt survives, even with --force", async () => {
    const { id, dir } = plant(park());
    holdAttempt(id);
    const before = rawText(dir);
    await expect(handleSessionClearCompact(root, id, { force: true })).rejects.toThrow(/wake-a1/);
    expect(rawText(dir)).toBe(before);
  });

  it("refuses a FINALIZE park git cannot classify, and --force recovers it to IMPLEMENT", async () => {
    const { id, dir } = plant(park({ preCompactState: "FINALIZE", finalizeCheckpoint: null }));
    vi.mocked(gitHead).mockResolvedValue({ ok: true, data: { hash: "def456" } } as never);
    vi.mocked(gitDiffTreeNames).mockResolvedValue({ ok: true, data: [".story/tickets/T-001.json"] } as never);
    vi.mocked(gitIsAncestor).mockResolvedValue({ ok: false, reason: "git_error", message: "boom" } as never);
    const before = rawText(dir);

    await expect(handleSessionClearCompact(root, id)).rejects.toThrow(/clear-compact .*--force/);
    expect(rawText(dir)).toBe(before);

    const message = await handleSessionClearCompact(root, id, { force: true });
    expect(message).toContain("recovers to IMPLEMENT");
    expect(raw(dir)).toMatchObject({ state: "COMPACT", compactPending: true, preCompactState: "IMPLEMENT" });
    expect(limitKeysIn(dir)).toEqual([]);
  });
});

describe("session stop", () => {
  it("refuses under a surviving wake attempt before releasing anything", async () => {
    const { id, dir } = plant(park());
    holdAttempt(id);
    const before = rawText(dir);
    await expect(handleSessionStop(root, id)).rejects.toThrow(/wake-a1/);
    expect(rawText(dir)).toBe(before);
  });

  it("stops a park with no surviving attempt and writes no limit key", async () => {
    const { id, dir } = plant(park());
    await handleSessionStop(root, id);
    expect(raw(dir)).toMatchObject({ state: "SESSION_END", status: "completed" });
    expect(limitKeysIn(dir)).toEqual([]);
  });
});

describe("guide pre_compact", () => {
  it("strips inert keys from a live session before compacting it", async () => {
    const { id, dir } = plant({ state: "PLAN", interruptionKind: null, limitStopPending: false });
    const result = await handleAutonomousGuide(root, { action: "pre_compact", sessionId: id });
    expect(result.isError).toBeFalsy();
    expect(raw(dir)).toMatchObject({ state: "COMPACT", compactPending: true });
    expect(limitKeysIn(dir)).toEqual([]);
  });

  it("refuses an inconsistent park and leaves it untouched", async () => {
    const { id, dir } = plant(park({ compactPending: false }));
    const before = rawText(dir);
    const result = await handleAutonomousGuide(root, { action: "pre_compact", sessionId: id });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("inconsistent usage-limit park");
    expect(rawText(dir)).toBe(before);
  });
});

describe("guide start", () => {
  it("reports a failed park elsewhere without letting it block a clean start", async () => {
    const other = plant(park(), "another-workspace");
    holdAttempt(other.id);
    const before = rawText(other.dir);

    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null } as never);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("left untouched");
    expect(text(result)).toContain(`session ${other.id} was stopped by the retired usage-limit auto-resume`);
    expect(text(result)).not.toContain("is still recorded");
    expect(rawText(other.dir)).toBe(before);
  });

  it("names a recorded wake attempt, not a retired park, for a key-free session it holds", async () => {
    const other = plant({ state: "PLAN" }, "another-workspace");
    holdAttempt(other.id);
    const before = rawText(other.dir);

    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null } as never);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(
      `a legacy usage-limit wake attempt wake-a1 is still recorded for session ${other.id} (limit-ledger.json)`,
    );
    expect(text(result)).not.toContain("stopped by the retired");
    expect(rawText(other.dir)).toBe(before);
  });

  it("refuses when the park it would resume is the one that failed", async () => {
    const target = plant(park(), deriveWorkspaceId(root));
    holdAttempt(target.id);
    const before = rawText(target.dir);

    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null } as never);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`Cannot start: session ${target.id} was stopped by the retired usage-limit auto-resume`);
    expect(rawText(target.dir)).toBe(before);
  });
});

describe("ownership is decided on the original state, before any normalisation (T-534 round 2)", () => {
  it("resume: a foreign or unidentified caller leaves an owned live park and its revision untouched", async () => {
    const { id, dir } = plant(park({ ownerTask: OWNER, lease: liveLease() }));
    const before = snapshot(dir);
    for (const clientTaskId of ["intruder-task", undefined]) {
      const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id, clientTaskId } as never);
      expect(result.isError).toBe(true);
      expect(snapshot(dir)).toEqual(before);
    }
    // The owner normalises and resumes it.
    const owned = await handleAutonomousGuide(root, { action: "resume", sessionId: id, clientTaskId: OWNER.id } as never);
    expect(owned.isError).toBeFalsy();
    expect(limitKeysIn(dir)).toEqual([]);
  });

  it("pre_compact: a foreign or unidentified caller leaves an owned live session untouched", async () => {
    const { id, dir } = plant({ state: "PLAN", ownerTask: OWNER, lease: liveLease(), interruptionKind: null, limitStopPending: false });
    const before = snapshot(dir);
    for (const clientTaskId of ["intruder-task", undefined]) {
      const result = await handleAutonomousGuide(root, { action: "pre_compact", sessionId: id, clientTaskId } as never);
      expect(result.isError).toBe(true);
      expect(snapshot(dir)).toEqual(before);
    }
  });

  it("start: a foreign or unidentified caller never normalises an owned live park in the project", async () => {
    const { dir } = plant(park({ ownerTask: OWNER, lease: liveLease(deriveWorkspaceId(root)) }), deriveWorkspaceId(root));
    const before = snapshot(dir);
    for (const clientTaskId of ["intruder-task", undefined]) {
      await handleAutonomousGuide(root, { action: "start", sessionId: null, clientTaskId } as never);
      expect(snapshot(dir)).toEqual(before);
    }
  });
});

describe("the ledger, not interruptionKind, is the evidence (T-534 round 2)", () => {
  it("a running session with a live preserved attempt is not stripped, and later mutations refuse", async () => {
    const { id, dir } = plant({ state: "PLAN", ...LIMIT });
    holdAttempt(id);
    const before = rawText(dir);

    expect((await normalizeRetiredLimitPark(root, id)).kind).toBe("failed");
    expect(rawText(dir)).toBe(before);
    await expect(handleSessionStop(root, id)).rejects.toThrow(/wake-a1/);
    const cancel = await handleAutonomousGuide(root, { action: "cancel", sessionId: id } as never);
    expect(cancel.isError).toBe(true);
    expect(rawText(dir)).toBe(before);
  });

  it("stop and cancel check the ledger for a session with no limit metadata at all", async () => {
    const { id, dir } = plant({ state: "PLAN" });
    holdAttempt(id);
    const before = rawText(dir);
    await expect(handleSessionStop(root, id)).rejects.toThrow(/wake-a1/);
    expect((await handleAutonomousGuide(root, { action: "cancel", sessionId: id } as never)).isError).toBe(true);
    expect(rawText(dir)).toBe(before);
  });

  it("a key-free COMPACT park with a surviving attempt refuses normalisation and resume, byte-identical", async () => {
    const { id, dir } = plant({ state: "COMPACT", compactPending: true, preCompactState: "PLAN", compactPreparedAt: new Date().toISOString() });
    holdAttempt(id);
    const before = snapshot(dir);
    const result = await normalizeRetiredLimitPark(root, id);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.reason).toContain("wake-a1");
    const resumed = await handleAutonomousGuide(root, { action: "resume", sessionId: id } as never);
    expect(resumed.isError).toBe(true);
    await expect(handleSessionClearCompact(root, id)).rejects.toThrow(/wake-a1/);
    expect(snapshot(dir)).toEqual(before);
  });

  it("pre_compact checks the ledger before adopting an expired foreign lease, leaving state byte-identical", async () => {
    const expired = { workspaceId: deriveWorkspaceId(root), lastHeartbeat: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T00:30:00.000Z" };
    const { id, dir } = plant({ state: "PLAN", ownerTask: OWNER, lease: expired });
    holdAttempt(id);
    const before = snapshot(dir);
    const result = await handleAutonomousGuide(root, { action: "pre_compact", sessionId: id, clientTaskId: "adopter-task" } as never);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("wake-a1");
    expect(snapshot(dir)).toEqual(before);
  });

  it("the owner-gone candidate doors check the ledger before any handshake, leaving state byte-identical", async () => {
    const expired = { workspaceId: deriveWorkspaceId(root), lastHeartbeat: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T00:30:00.000Z" };
    const { id, dir } = plant({ state: "PLAN", ownerTask: OWNER, lease: expired });
    holdAttempt(id);
    const before = snapshot(dir);
    // The confirmation is well formed but stale: without the ledger check the
    // doors would refuse it in the handshake instead, never naming the attempt.
    const confirmed = { sessionRevision: before.revision as number, evidenceFingerprint: "0".repeat(64) };

    const takeover = await handleAutonomousGuide(root, {
      action: "resume", sessionId: id, clientTaskId: "adopter-task", takeover: true, ownerGoneCandidateTakeover: confirmed,
    } as never);
    expect(takeover.isError).toBe(true);
    expect(text(takeover)).toContain(`Cannot recover session ${id}`);
    expect(text(takeover)).toContain("wake-a1");
    expect(snapshot(dir)).toEqual(before);

    const cancel = await handleAutonomousGuide(root, {
      action: "cancel", sessionId: id, clientTaskId: "adopter-task", ownerGoneCandidateCancel: confirmed,
    } as never);
    expect(cancel.isError).toBe(true);
    expect(text(cancel)).toContain(`Cannot cancel session ${id}`);
    expect(text(cancel)).toContain("wake-a1");
    expect(snapshot(dir)).toEqual(before);
  });

  it("the CLI PreCompact hook skips a session a wake attempt may still run, and compacts it once the attempt is gone", async () => {
    const { id, dir } = plant({ state: "PLAN", ownerTask: OWNER, lease: liveLease(deriveWorkspaceId(root)) });
    holdAttempt(id);
    const before = snapshot(dir);
    const errors: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      await handleSessionCompactPrepare({ cwd: root, client: "claude", clientTaskId: OWNER.id });
    } finally {
      process.stderr.write = write;
    }
    expect(errors.join("")).toContain("compact-prepare skipped");
    expect(errors.join("")).toContain("wake-a1");
    expect(snapshot(dir)).toEqual(before);

    // The same call reaches the session once nothing holds it, so the skip above is the ledger's doing.
    writeFileSync(join(globalDir, "limit-ledger.json"), JSON.stringify({ schemaVersion: 1, records: {} }));
    await handleSessionCompactPrepare({ cwd: root, client: "claude", clientTaskId: OWNER.id });
    expect(raw(dir)).toMatchObject({ state: "COMPACT", compactPending: true });
  });

  it("repair skips an eligible session without limit metadata while the ledger holds an attempt for it", async () => {
    // Repair only sees stale sessions of this root's own workspace.
    const expired = { workspaceId: deriveWorkspaceId(root), lastHeartbeat: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T00:30:00.000Z" };
    const { id, dir } = plant({ state: "PLAN", lease: expired });
    holdAttempt(id);
    const out = await handleSessionRepair(root, { dryRun: false, all: true, yes: true });
    expect(out).toContain("usage_limit_wake_attempt");
    expect(raw(dir)).toMatchObject({ status: "active", state: "PLAN" });

    await rm(join(globalDir, "limit-ledger.json"));
    await handleSessionRepair(root, { dryRun: false, all: true, yes: true });
    expect(raw(dir)).toMatchObject({ status: "superseded" });
  });
});

describe("resume hook adopts the normalised state (T-534 round 2)", () => {
  const captureStdout = () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    return out;
  };
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(normalizeRetiredLimitPark).mockClear();
  });

  // findResumableSession only sees a session of this root's workspace.
  const ownedPark = (opts: { keyFree?: boolean } = {}) => {
    const fields: Record<string, unknown> = park({ ownerTask: OWNER, lease: liveLease(deriveWorkspaceId(root)) });
    if (opts.keyFree) for (const k of LIMIT_KEY_NAMES) delete fields[k];
    return plant(fields, deriveWorkspaceId(root));
  };

  it("gives a resume instruction for a normalised owned park", async () => {
    const { id, dir } = ownedPark();
    const out = captureStdout();
    await handleSessionResumePrompt({ clientTaskId: OWNER.id, cwd: root, source: "compact" });
    expect(normalizeRetiredLimitPark).toHaveBeenCalled();
    expect(out.join("")).toContain(id);
    expect(limitKeysIn(dir)).toEqual([]);
  });

  it("gives no instruction and writes nothing for a key-free owned park a wake attempt may still run", async () => {
    const { id, dir } = ownedPark({ keyFree: true });
    expect(limitKeysIn(dir)).toEqual([]);
    holdAttempt(id);
    const before = snapshot(dir);
    const out = captureStdout();
    await handleSessionResumePrompt({ clientTaskId: OWNER.id, cwd: root, source: "compact" });
    expect(normalizeRetiredLimitPark).toHaveBeenCalled();
    expect(out.join("")).toContain(
      "cannot resume yet: a legacy usage-limit wake attempt wake-a1 is still recorded for this session (limit-ledger.json)",
    );
    expect(out.join("")).not.toContain("stopped by the retired");
    expect(out.join("")).not.toContain("Resume");
    expect(snapshot(dir)).toEqual(before);
  });

  it("names the retired park, not a recorded attempt, for a legacy park a wake attempt holds", async () => {
    const { id, dir } = ownedPark();
    holdAttempt(id);
    const before = snapshot(dir);
    const out = captureStdout();
    await handleSessionResumePrompt({ clientTaskId: OWNER.id, cwd: root, source: "compact" });
    expect(out.join("")).toContain("cannot resume yet: it was stopped by the retired usage-limit auto-resume");
    expect(out.join("")).not.toContain("is still recorded");
    expect(snapshot(dir)).toEqual(before);
  });

  it("gives no instruction when a concurrent resume rewrote the session before normalisation", async () => {
    const { id, dir } = ownedPark();
    const actual = await vi.importActual<typeof import("../../src/autonomous/retired-limit-park.js")>(
      "../../src/autonomous/retired-limit-park.js",
    );
    vi.mocked(normalizeRetiredLimitPark).mockImplementationOnce(async (r, sessionId, opts) => {
      // Another process resumed and normalised the park in the meantime.
      const current = withoutLimitKeys(raw(dir));
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        ...current, state: "PLAN", compactPending: false, preCompactState: null,
        revision: (current.revision as number) + 1,
      }, null, 2) + "\n");
      return actual.normalizeRetiredLimitPark(r, sessionId, opts);
    });
    const out = captureStdout();
    await handleSessionResumePrompt({ clientTaskId: OWNER.id, cwd: root, source: "compact" });
    expect(normalizeRetiredLimitPark).toHaveBeenCalled();
    expect(out.join("")).not.toContain(id);
    expect(raw(dir)).toMatchObject({ state: "PLAN", compactPending: false });
  });
});
