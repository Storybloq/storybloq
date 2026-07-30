/**
 * ISS-899: the skill guard and the guide's enforcement both answer "may this
 * caller touch this session?", and they disagreed in two reachable cells.
 *
 * Both cells are pinned here against BOTH components in one file, because that
 * is the whole point: reading either side alone is how they drifted. Test names
 * say whether the two AGREE BY DESIGN or DIFFER BY DESIGN, so a future change
 * that flips one has to state which it meant.
 *
 *   Cell (a)  session records an `ownerTask`, lease LIVE, caller has NO identity.
 *             CLOSED by this change: the guide used to accept, and now refuses,
 *             matching the guard's monitor-only advice.
 *
 *   Cell (b)  ownerless session carrying a `claudeCodeSessionId` that does not
 *             match the caller. OPEN BY DESIGN: the guard advises attempting a
 *             COMPACT recovery, the guide adjudicates and may refuse. SKILL.md
 *             now describes the adjudication instead of promising the bind.
 *
 * A THIRD cell exists and is deliberately untouched: an ownerless legacy-id
 * session met by an identity-free caller. The owner ruling covered `ownerTask`
 * sessions only, so guide seams keep failing OPEN there and the two CLI paths
 * keep failing CLOSED. That split is pinned below so it cannot change by
 * accident, and it is filed separately.
 *
 * Enforcement is exercised through REAL guide entry points. `liveOwnershipConflict`
 * is unexported, and a unit test of the resolver alone would not catch a seam
 * that forgets to call it, which is exactly the failure this issue is about.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
  gitUserEmail: vi.fn().mockResolvedValue({ ok: true, data: "me@example.com" }),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync, prepareForCompact } from "../../src/autonomous/session.js";
import { evaluateSessionGuard } from "../../src/core/session-guard.js";
import {
  resolveSessionOwnership,
  callerMayAct,
  unidentifiedCallerRemedy,
} from "../../src/autonomous/session-ownership.js";
import type { OwnerTask } from "../../src/autonomous/client-profile.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import * as gitInspector from "../../src/autonomous/git-inspector.js";
import {
  handleSessionCompactPrepare,
  handleSessionResumePrompt,
} from "../../src/cli/commands/session-compact.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const MINE: OwnerTask = { client: "claude", id: "my-task", boundAt: "2026-07-01T00:00:00Z" };
const FOREIGN: OwnerTask = { client: "claude", id: "other-task", boundAt: "2026-07-01T00:00:00Z" };
const FOREIGN_CODEX: OwnerTask = { client: "codex", id: "other-thread", boundAt: "2026-07-01T00:00:00Z" };

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let root: string;

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
    title: "test", date: "2026-07-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open", phase: "p1",
    order: 10, description: "", createdDate: "2026-07-30", blockedBy: [], parentTicket: null,
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

interface SessionShape {
  readonly owner?: OwnerTask;
  readonly legacyId?: string;
  readonly compact?: boolean;
  readonly expired?: boolean;
  readonly extra?: Partial<FullSessionState>;
}

/** A session on disk with the ownership axis and lease supplied. */
function seed(shape: SessionShape): string {
  // The workspace id must be what the guide derives (the realpath), or
  // findActiveSessionFull never sees this session and every start-path
  // assertion below passes vacuously against a session that was never found.
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const base = writeSessionSync(sessDir, {
    ...session,
    state: "PLAN",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);

  if (shape.compact) prepareForCompact(sessDir, base, { expectedHead: "abc123" });
  const current = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;

  writeSessionSync(sessDir, {
    ...current,
    ownerTask: shape.owner,
    claudeCodeSessionId: shape.legacyId,
    lease: {
      ...current.lease,
      expiresAt: new Date(Date.now() + (shape.expired ? -600_000 : 600_000)).toISOString(),
    },
    ...shape.extra,
  } as FullSessionState);
  return session.sessionId;
}

function readState(sessionId: string): FullSessionState {
  return JSON.parse(
    readFileSync(join(root, ".story", "sessions", sessionId, "state.json"), "utf-8"),
  ) as FullSessionState;
}

/**
 * Drive the SessionStart resume-prompt hook with NO ambient identity, so an
 * omitted `clientTaskId` really means an unidentified caller instead of one the
 * hook quietly recovers from the environment.
 */
async function runResumePrompt(clientTaskId?: string): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write;
  const savedClient = process.env.STORYBLOQ_CLIENT;
  const savedClaude = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.STORYBLOQ_CLIENT = "claude";
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await handleSessionResumePrompt({ source: "compact", clientTaskId, cwd: root });
  } finally {
    process.stdout.write = original;
    if (savedClient === undefined) delete process.env.STORYBLOQ_CLIENT;
    else process.env.STORYBLOQ_CLIENT = savedClient;
    if (savedClaude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedClaude;
  }
  return chunks.join("");
}

/** The same, for the PreCompact hook path. Returns what it wrote to stderr. */
async function runCompactPrepare(clientTaskId?: string): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write;
  const savedClaude = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await handleSessionCompactPrepare({ client: "claude", clientTaskId, cwd: root });
  } finally {
    process.stderr.write = original;
    if (savedClaude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = savedClaude;
  }
  return chunks.join("");
}

interface GuideOutcome { readonly isError: boolean; readonly text: string }

/**
 * Drive the guide with NO caller identity. The env vars must be cleared, not
 * merely left unset: the harness that runs this suite may itself be inside a
 * Claude Code session and would otherwise supply a real id.
 */
async function asAnonymous(call: () => Promise<{ isError?: boolean; content: unknown[] }>): Promise<GuideOutcome> {
  const saved = {
    claude: process.env.CLAUDE_CODE_SESSION_ID,
    codex: process.env.CODEX_THREAD_ID,
    client: process.env.STORYBLOQ_CLIENT,
  };
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  process.env.STORYBLOQ_CLIENT = "claude";
  try {
    const r = await call();
    return { isError: r.isError === true, text: (r.content[0] as { text: string }).text };
  } finally {
    if (saved.claude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = saved.claude;
    if (saved.codex === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = saved.codex;
    if (saved.client === undefined) delete process.env.STORYBLOQ_CLIENT;
    else process.env.STORYBLOQ_CLIENT = saved.client;
  }
}

async function asTask(taskId: string, call: () => Promise<{ isError?: boolean; content: unknown[] }>): Promise<GuideOutcome> {
  const saved = process.env.STORYBLOQ_CLIENT;
  process.env.STORYBLOQ_CLIENT = "claude";
  try {
    const r = await call();
    return { isError: r.isError === true, text: (r.content[0] as { text: string }).text };
  } finally {
    if (saved === undefined) delete process.env.STORYBLOQ_CLIENT;
    else process.env.STORYBLOQ_CLIENT = saved;
    void taskId;
  }
}

/** The refusal a caller with no identity must receive: probe, then escape, never takeover. */
function expectIdentityRemedy(text: string): void {
  expect(text, "must name the identity probe as the first remedy").toContain("printenv CLAUDE_CODE_SESSION_ID");
  expect(text, "must name the Codex probe too").toContain("printenv CODEX_THREAD_ID");
  expect(text, "must name the identity-free escape").toContain("storybloq session stop");
  expect(text, "must NOT prescribe an action that is itself identity-gated").not.toContain("takeover");
}

/**
 * `vi.restoreAllMocks()` in afterEach strips the implementations the module
 * factory set, so without this every test after the first sees the git helpers
 * resolve `undefined` and the guide dies on `.ok` of undefined. Re-armed per
 * test rather than left to the factory.
 */
beforeEach(() => {
  vi.mocked(gitInspector.gitHead).mockResolvedValue({ ok: true, data: { hash: "abc123" } } as never);
  vi.mocked(gitInspector.gitStatus).mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(gitInspector.gitMergeBase).mockResolvedValue({ ok: true, data: "abc123" } as never);
  vi.mocked(gitInspector.gitDiffStat).mockResolvedValue({ ok: false } as never);
  vi.mocked(gitInspector.gitDiffNames).mockResolvedValue({ ok: false } as never);
  vi.mocked(gitInspector.gitDiffCachedNames).mockResolvedValue({ ok: false } as never);
  vi.mocked(gitInspector.gitBlobHash).mockResolvedValue({ ok: false } as never);
  vi.mocked(gitInspector.gitStash).mockResolvedValue({ ok: true } as never);
  vi.mocked(gitInspector.gitStashPop).mockResolvedValue({ ok: true } as never);
  vi.mocked(gitInspector.gitIsAncestor).mockResolvedValue({ ok: true, data: false } as never);
  vi.mocked(gitInspector.gitUserEmail).mockResolvedValue({ ok: true, data: "me@example.com" } as never);

  root = mkdtempSync(join(tmpdir(), "iss899-"));
  setupProject(root);
});

afterEach(async () => {
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The shared resolver, which is the only place precedence is expressed.
// ---------------------------------------------------------------------------

describe("ISS-899 resolveSessionOwnership: one precedence, every arm", () => {
  it("no owner recorded is unowned, whoever asks", () => {
    expect(resolveSessionOwnership({}, MINE)).toEqual({ kind: "unowned" });
    expect(resolveSessionOwnership({}, null)).toEqual({ kind: "unowned" });
  });

  it("ownerTask takes precedence over a legacy id that would say otherwise", () => {
    const v = resolveSessionOwnership({ ownerTask: MINE, claudeCodeSessionId: "other-task" }, MINE);
    expect(v).toEqual({ kind: "same", via: "ownerTask" });
  });

  it("a matching ownerTask is same, a differing one is foreign", () => {
    expect(resolveSessionOwnership({ ownerTask: MINE }, MINE)).toEqual({ kind: "same", via: "ownerTask" });
    const foreign = resolveSessionOwnership({ ownerTask: FOREIGN }, MINE);
    expect(foreign.kind).toBe("foreign");
    expect(foreign).toMatchObject({ via: "ownerTask", ownerDescription: "another live claude task" });
  });

  it("client is part of identity: same id under a different client is foreign", () => {
    const v = resolveSessionOwnership({ ownerTask: { ...MINE, client: "codex" } }, MINE);
    expect(v.kind).toBe("foreign");
  });

  it("a legacy id matches only a claude caller with the same id", () => {
    expect(resolveSessionOwnership({ claudeCodeSessionId: "my-task" }, MINE))
      .toEqual({ kind: "same", via: "legacyId" });
    expect(resolveSessionOwnership({ claudeCodeSessionId: "someone-else" }, MINE).kind).toBe("foreign");
    expect(resolveSessionOwnership({ claudeCodeSessionId: "my-task" }, { ...MINE, client: "codex" }).kind)
      .toBe("foreign");
  });

  it("a legacy id that fails CLIENT_TASK_ID_PATTERN still reads as an owner", () => {
    // Normalizing it to null would reclassify an OWNED session as unowned and
    // route it to auto-resume, which is the ISS-848 shape in reverse.
    const v = resolveSessionOwnership({ claudeCodeSessionId: "not a valid id!!" }, MINE);
    expect(v.kind).toBe("foreign");
    expect(v).toMatchObject({ via: "legacyId" });
    expect(callerMayAct(v)).toBe(false);
  });

  it("an identity-free caller is unidentified-caller, NOT foreign, and carries the via", () => {
    // The distinction the whole fix rests on: the remedy for "you are someone
    // else" is to go to the owning task, and the remedy for "we cannot tell" is
    // to establish an identity. Collapsing them gives one of them wrong advice.
    expect(resolveSessionOwnership({ ownerTask: FOREIGN }, null))
      .toMatchObject({ kind: "unidentified-caller", via: "ownerTask" });
    expect(resolveSessionOwnership({ claudeCodeSessionId: "someone-else" }, null))
      .toMatchObject({ kind: "unidentified-caller", via: "legacyId" });
  });

  it("callerMayAct is true only for same and unowned", () => {
    expect(callerMayAct({ kind: "unowned" })).toBe(true);
    expect(callerMayAct({ kind: "same", via: "legacyId" })).toBe(true);
    expect(callerMayAct(resolveSessionOwnership({ ownerTask: FOREIGN }, null))).toBe(false);
    expect(callerMayAct(resolveSessionOwnership({ ownerTask: FOREIGN }, MINE))).toBe(false);
  });

  it("the remedy names the probe and an escape that needs no identity", () => {
    const text = unidentifiedCallerRemedy("sess-1");
    expectIdentityRemedy(text);
    expect(text).toContain("storybloq session stop sess-1");
  });
});

// ---------------------------------------------------------------------------
// Cell (a): AGREE BY DESIGN after this change.
// ---------------------------------------------------------------------------

describe("ISS-899 cell (a): live ownerTask session, caller with no identity (AGREE BY DESIGN)", () => {
  it("the guard advises monitor-only", () => {
    seed({ owner: FOREIGN });
    const v = evaluateSessionGuard(root, { client: "claude" });
    expect(v.sessions[0]?.relationship).toBe("foreign-live");
    expect(v.overallAction).toBe("monitor-only");
  });

  it("report is refused, with the identity remedy", async () => {
    const sessionId = seed({ owner: FOREIGN });
    const r = await asAnonymous(() => handleAutonomousGuide(root, {
      action: "report", sessionId, report: { completedAction: "plan_written" },
    } as never));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no client task id");
    expectIdentityRemedy(r.text);
  });

  it("cancel is refused, and withholds the ISS-904 takeover prescription", async () => {
    // ISS-904 tells a COMPACT-session caller to resume with takeover: true.
    // That call is itself rejected without a clientTaskId, so offering it here
    // would hand the caller an action that fails for the reason they were
    // blocked. This is the ISS-848 shape and the reason the cell splits.
    const sessionId = seed({ owner: FOREIGN, compact: true });
    const r = await asAnonymous(() => handleAutonomousGuide(root, { action: "cancel", sessionId } as never));
    expect(r.isError).toBe(true);
    expectIdentityRemedy(r.text);
  });

  it("resume is refused", async () => {
    const sessionId = seed({ owner: FOREIGN, compact: true });
    const r = await asAnonymous(() => handleAutonomousGuide(root, { action: "resume", sessionId } as never));
    expect(r.isError).toBe(true);
    expectIdentityRemedy(r.text);
  });

  it("pre_compact is refused", async () => {
    const sessionId = seed({ owner: FOREIGN });
    const r = await asAnonymous(() => handleAutonomousGuide(root, { action: "pre_compact", sessionId } as never));
    expect(r.isError).toBe(true);
    expectIdentityRemedy(r.text);
  });

  it("start is refused", async () => {
    seed({ owner: FOREIGN });
    const r = await asAnonymous(() => handleAutonomousGuide(root, { action: "start", sessionId: null } as never));
    expect(r.isError).toBe(true);
    expectIdentityRemedy(r.text);
  });
});

// ---------------------------------------------------------------------------
// Ordering, which the refusal alone does not achieve.
// ---------------------------------------------------------------------------

describe("ISS-899 start ordering: the refusal must land BEFORE recovery", () => {
  it("an identity-free caller does not replay another task's pending mutation", async () => {
    // Asserting refusal text here would pass against the bug. `handleStart`
    // called recoverPendingMutation on the live session BEFORE any ownership
    // check, so the refusal arrived only after another task's session and
    // project writes had already been replayed. What this pins is the ABSENCE
    // of those writes.
    const sessionId = seed({
      owner: FOREIGN,
      compact: true,
      extra: {
        pendingProjectMutation: {
          type: "ticket_update",
          target: "T-001",
          value: "inprogress",
          expectedCurrent: "open",
        },
      } as unknown as Partial<FullSessionState>,
    });
    const before = readState(sessionId);

    const r = await asAnonymous(() => handleAutonomousGuide(root, { action: "start", sessionId: null } as never));
    expect(r.isError).toBe(true);

    // The two facts that move when recovery runs, and the sibling test below
    // proves they DO move for an identified caller on this same fixture, so
    // neither assertion is vacuous. The ticket file itself is deliberately not
    // asserted: the replay does not reach it in this fixture, so a "ticket
    // unchanged" assertion would pass no matter what the gate did.
    const after = readState(sessionId);
    expect(after.revision, "the session was written to before the refusal").toBe(before.revision);
    expect(after.state).toBe(before.state);
    expect(
      (after as unknown as Record<string, unknown>).pendingProjectMutation,
      "another task's pending mutation was consumed by a caller with no right to it",
    ).toEqual((before as unknown as Record<string, unknown>).pendingProjectMutation);
  });

  it("an IDENTIFIED foreign caller still gets recovery first, unchanged", async () => {
    // The scope fence. Identified foreign callers complete or clear the pending
    // mutation today and are refused afterwards. Hoisting their refusal above
    // recovery would delete writes they currently make, which is a behaviour
    // change this ruling does not authorize.
    const sessionId = seed({
      owner: FOREIGN,
      extra: {
        pendingProjectMutation: {
          type: "ticket_update",
          target: "T-001",
          value: "inprogress",
          expectedCurrent: "open",
        },
      } as unknown as Partial<FullSessionState>,
    });
    const before = readState(sessionId);

    const r = await asTask("my-task", () => handleAutonomousGuide(root, {
      action: "start", sessionId: null, clientTaskId: "my-task",
    } as never));
    expect(r.isError, "start is still refused for a foreign caller").toBe(true);
    expect(r.text, "but NOT via the identity remedy").not.toContain("printenv CLAUDE_CODE_SESSION_ID");

    const after = readState(sessionId);
    expect(
      after.revision,
      "recovery no longer runs for identified callers, which is an unauthorized behaviour change",
    ).toBeGreaterThan(before.revision);
    expect(
      (after as unknown as Record<string, unknown>).pendingProjectMutation,
      "recovery ran but did not consume the marker, so the pair above proves nothing",
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Expired leases: outside the ruled cell, and they must not move.
// ---------------------------------------------------------------------------

describe("ISS-899 scope fence: an EXPIRED lease is not cell (a)", () => {
  it("pre_compact from an identity-free caller is still accepted on an expired owned session", async () => {
    // pre_compact passes enforceAfterExpiry, so it bypasses the ordinary
    // expired-lease early return. Without an explicit live-lease condition on
    // the new refusal, this call would newly fail. It is accepted today and
    // stays accepted; T-446's U5 does not cover it because U5 exercises resume.
    const sessionId = seed({ owner: FOREIGN_CODEX, expired: true });
    const r = await asAnonymous(() => handleAutonomousGuide(root, { action: "pre_compact", sessionId } as never));
    expect(r.isError, "an expired session was swept into the ruled cell").toBe(false);
    expect(readState(sessionId).state).toBe("COMPACT");
  });

  it("resume from an identity-free caller is still accepted on an expired owned session", async () => {
    const sessionId = seed({ owner: FOREIGN, compact: true, expired: true });
    const r = await asAnonymous(() => handleAutonomousGuide(root, { action: "resume", sessionId } as never));
    expect(r.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cell (b): DIFFER BY DESIGN.
// ---------------------------------------------------------------------------

describe("ISS-899 cell (b): ownerless session, mismatched legacy id (DIFFER BY DESIGN)", () => {
  it("the guard advises attempting a COMPACT recovery", () => {
    seed({ legacyId: "someone-elses-task", compact: true });
    const v = evaluateSessionGuard(root, { clientTaskId: "my-task", client: "claude" });
    expect(v.sessions[0]?.relationship, "the guard cannot see the legacy id at all").toBe("unowned-legacy");
    expect(v.sessions[0]?.resumable).toBe(true);
  });

  it("the guide adjudicates and refuses the mismatch, which is the difference", async () => {
    const sessionId = seed({ legacyId: "someone-elses-task", compact: true });
    const r = await asTask("my-task", () => handleAutonomousGuide(root, {
      action: "resume", sessionId, clientTaskId: "my-task",
    } as never));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("legacy Claude Code task");
  });

  it("the true legacy owner still recovers", async () => {
    const sessionId = seed({ legacyId: "my-task", compact: true });
    const r = await asTask("my-task", () => handleAutonomousGuide(root, {
      action: "resume", sessionId, clientTaskId: "my-task",
    } as never));
    expect(r.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The third cell, deliberately left split.
// ---------------------------------------------------------------------------

describe("ISS-899 third cell: ownerless legacy id, caller with no identity (UNRULED, left split -- ISS-924)", () => {
  it("the REPORT seam accepts it, because the ruling covered ownerTask sessions only", async () => {
    // Widening the new refusal to `via === "legacyId"` would change behaviour
    // for a legacy population with no owner ruling behind it. Filed as ISS-924.
    const sessionId = seed({ legacyId: "someone-elses-task" });
    const r = await asAnonymous(() => handleAutonomousGuide(root, {
      action: "report", sessionId, report: { completedAction: "plan_written" },
    } as never));
    // Pin the ACCEPTANCE, not just the absence of the remedy text: the seam
    // must fall through to the ordinary PLAN-stage retry. Asserting only that
    // the remedy is missing would stay green if the report were rejected for
    // some unrelated reason, which is not what "still accept it" claims.
    expect(r.isError, "an unruled cell was swept into the fix").toBe(false);
    expect(r.text, "the report did not reach the stage logic").toContain("Plan file not found");
    expect(r.text).not.toContain("printenv CLAUDE_CODE_SESSION_ID");
    expect(r.text, "some other ownership refusal fired instead").not.toContain("is owned by");
  });

  it("the RESUME seam accepts it too, and it has its OWN copy of the cell (a) gate", async () => {
    // Not redundant with the report test above. `report` routes through
    // liveOwnershipConflict; handleResume re-checks
    // `unidentified-caller && via === "ownerTask"` inline, so that second gate
    // could widen to legacyId on its own and the report test would stay green.
    const sessionId = seed({ legacyId: "someone-elses-task", compact: true });
    const r = await asAnonymous(() => handleAutonomousGuide(root, {
      action: "resume", sessionId,
    } as never));
    expect(r.isError, "the resume seam swept in an unruled cell").toBe(false);
    expect(r.text).not.toContain("printenv CLAUDE_CODE_SESSION_ID");
  });

  it("the resolver calls it unidentified rather than foreign", () => {
    // The resolver half only. On its own this proves nothing about either CLI
    // seam: an earlier version of this file asserted ONLY this while claiming
    // to cover both, and both could have stopped calling it unnoticed.
    const ownership = resolveSessionOwnership({ claudeCodeSessionId: "someone-elses-task" }, null);
    expect(ownership.kind).toBe("unidentified-caller");
    expect(ownership.via).toBe("legacyId");
    expect(callerMayAct(ownership)).toBe(false);
  });

  it("compact-prepare REFUSES it, so the split is enforced and not merely a resolver opinion", async () => {
    const sessionId = seed({ legacyId: "someone-elses-task" });
    const stderr = await runCompactPrepare(undefined);
    const after = readState(sessionId);
    expect(after.state, "an identityless caller compacted a legacy-owned session").not.toBe("COMPACT");
    expect(after.compactPending ?? false).toBe(false);
    expect(stderr).toContain("compact-prepare skipped");
  });

  it("compact-prepare ACCEPTS the recorded legacy owner, or the refusal above proves nothing", async () => {
    // The positive control. Without it the refusal could be a path that never
    // compacts for anybody, which is the vacuity this file already hit twice.
    const sessionId = seed({ legacyId: "someone-elses-task" });
    await runCompactPrepare("someone-elses-task");
    expect(readState(sessionId).state).toBe("COMPACT");
  });

  it("resume-prompt REFUSES the same cell, leaving the observation unwritten", async () => {
    const sessionId = seed({ legacyId: "someone-elses-task", compact: true });
    await runResumePrompt(undefined);
    expect(readState(sessionId).compactObservedAt ?? null).toBeNull();
  });

  it("resume-prompt ACCEPTS the recorded legacy owner", async () => {
    const sessionId = seed({ legacyId: "someone-elses-task", compact: true });
    await runResumePrompt("someone-elses-task");
    expect(readState(sessionId).compactObservedAt ?? null).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The claim SKILL.md now makes about identityless recovery.
// ---------------------------------------------------------------------------

describe("ISS-899 SKILL.md claim: without caller identity, COMPACT recovery succeeds but binds nothing", () => {
  // SKILL.md:250 says exactly this, and says it for BOTH ownerless shapes, so
  // both are measured here. A doc sentence with no entry-point test behind it
  // is how the guard and enforcement drifted apart in the first place.

  it("an ownerless session with NO legacy id recovers and binds no ownerTask", async () => {
    const sessionId = seed({ compact: true });
    const r = await asAnonymous(() => handleAutonomousGuide(root, {
      action: "resume", sessionId,
    } as never));
    expect(r.isError).toBe(false);
    expect(readState(sessionId).ownerTask ?? null, "recovery bound an owner it cannot know").toBeNull();
  });

  it("an ownerless session WITH a legacy id recovers, binds nothing, and keeps the id", async () => {
    const sessionId = seed({ legacyId: "someone-elses-task", compact: true });
    const r = await asAnonymous(() => handleAutonomousGuide(root, {
      action: "resume", sessionId,
    } as never));
    expect(r.isError).toBe(false);
    const after = readState(sessionId);
    expect(after.ownerTask ?? null).toBeNull();
    expect(after.claudeCodeSessionId, "the recorded legacy id was dropped").toBe("someone-elses-task");
  });

  it("an IDENTIFIED caller does bind, or the two assertions above prove nothing", async () => {
    const sessionId = seed({ compact: true });
    const r = await asTask("my-task", () => handleAutonomousGuide(root, {
      action: "resume", sessionId, clientTaskId: "my-task",
    } as never));
    expect(r.isError).toBe(false);
    expect(readState(sessionId).ownerTask?.id).toBe("my-task");
  });
});

// ---------------------------------------------------------------------------
// Copy 4: the CLI resume-prompt path, which gates a STATE WRITE.
// ---------------------------------------------------------------------------

describe("ISS-899 copy 4: the resume-prompt observation write is still owner-gated", () => {
  it("marks compaction observed for the recorded owner", async () => {
    // The positive half. Without it the negative below would pass against a
    // path that never writes for anybody.
    const sessionId = seed({ owner: MINE, compact: true });
    expect(readState(sessionId).compactObservedAt ?? null).toBeNull();
    await runResumePrompt("my-task");
    expect(readState(sessionId).compactObservedAt ?? null).not.toBeNull();
  });

  it("does NOT mark it for a foreign task", async () => {
    const sessionId = seed({ owner: FOREIGN, compact: true });
    await runResumePrompt("my-task");
    expect(readState(sessionId).compactObservedAt ?? null).toBeNull();
  });

  it("does NOT mark it for a caller with no identity on an ownerTask session", async () => {
    // This is cell (a), not the third cell: the session bears an ownerTask.
    // This path ALREADY failed closed before the ruling and the guide seams
    // have now caught up, so the two agree by design. The cell where they still
    // differ is ownerless-plus-legacy-id, covered against both CLI seams above.
    const sessionId = seed({ owner: FOREIGN, compact: true });
    await runResumePrompt(undefined);
    expect(readState(sessionId).compactObservedAt ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The consolidation itself.
// ---------------------------------------------------------------------------

describe("ISS-899 consolidation: precedence lives in exactly one module", () => {
  /**
   * This issue exists because the same precedence was hand-rolled in five
   * places and they drifted. A comment cannot prevent a sixth: this pin is what
   * FOUND the fifth copy, in the limit-stop owner filter, on its first run.
   *
   * Scope, stated plainly so the pin is not read as more than it is. It walks
   * every `.ts` file under `src/` rather than a hand-listed few, so a copy in a
   * NEW module is caught, which the hand-listed version could not do. What it
   * recognises is a direct equality or inequality comparison of
   * `claudeCodeSessionId` in either operand order, plus the one likely helper
   * spelling (feeding the field to `isSameOwnerTask`). A copy written some other
   * way (a switch, a lookup table, a fresh predicate) would still pass, so this
   * is a tripwire on the shape that actually recurred, not a proof of
   * exclusivity. Writing the field, deriving it from an ownerTask, and naming it
   * in advice text all stay legal: persistence and telemetry, not ownership
   * decisions.
   */
  const OWNERSHIP_COMPARISON = /claudeCodeSessionId\s*[!=]==?|[!=]==?\s*[\w.]*claudeCodeSessionId/;
  const OWNERSHIP_PREDICATE = /isSameOwnerTask\s*\([^)]*claudeCodeSessionId/;
  const RESOLVER = join("src", "autonomous", "session-ownership.ts");

  function sourceFilesUnder(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(join(pkgRoot, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFilesUnder(rel));
      else if (entry.name.endsWith(".ts")) found.push(rel);
    }
    return found;
  }

  it("no file under src/ outside the resolver decides ownership from the legacy id", () => {
    const scanned = sourceFilesUnder("src").filter((f) => f !== RESOLVER);
    expect(scanned.length, "the walk found almost nothing, so it is not walking").toBeGreaterThan(50);

    const offending: string[] = [];
    for (const file of scanned) {
      readFileSync(join(pkgRoot, file), "utf-8").split("\n").forEach((raw, i) => {
        const line = raw.trim();
        if (line.startsWith("//") || line.startsWith("*")) return;
        if (OWNERSHIP_COMPARISON.test(line) || OWNERSHIP_PREDICATE.test(line)) {
          offending.push(`${file}:${i + 1}: ${line}`);
        }
      });
    }
    expect(
      offending,
      "a sixth copy of the ownership precedence -- route it through resolveSessionOwnership or ISS-899 recurs",
    ).toEqual([]);
  });

  it("the resolver itself matches, or the walk above is checking nothing", () => {
    const source = readFileSync(join(pkgRoot, RESOLVER), "utf-8");
    expect(OWNERSHIP_COMPARISON.test(source)).toBe(true);
  });

  it("recognises both operand orders and inequality, not just `field ===`", () => {
    // The first version of this pin matched `===` only, so a copy spelled
    // `state.claudeCodeSessionId !== caller.id` would have sailed past it.
    for (const shape of [
      "if (state.claudeCodeSessionId === caller.id) {",
      "if (state.claudeCodeSessionId !== caller.id) {",
      "if (caller.id === state.claudeCodeSessionId) {",
      "if (caller.id !== active.state.claudeCodeSessionId) {",
    ]) {
      expect(OWNERSHIP_COMPARISON.test(shape), shape).toBe(true);
    }
    expect(
      OWNERSHIP_PREDICATE.test("isSameOwnerTask({ client: \"claude\", id: state.claudeCodeSessionId }, caller)"),
    ).toBe(true);
  });
});
