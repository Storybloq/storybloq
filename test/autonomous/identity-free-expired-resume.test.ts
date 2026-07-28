/**
 * T-446 / ISS-898: identity-free expired-COMPACT recovery, measured against the
 * real guide rather than inferred from the prose.
 *
 * The U5 row claims a resume with NO caller identity is accepted, binds no new
 * `ownerTask`, and leaves any recorded owner in place. That is a claim about a
 * round trip, so it is exercised end to end here across the whole owner axis,
 * including the codex-owner case that distinguishes CLEARING the legacy
 * `claudeCodeSessionId` from preserving it. Git operations are mocked; session
 * state is real files on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock git-inspector before importing guide
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
import { gitHead, gitIsAncestor } from "../../src/autonomous/git-inspector.js";
import {
  createSession,
  writeSessionSync,
  prepareForCompact,
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const mockedGitHead = vi.mocked(gitHead);
const mockedGitIsAncestor = vi.mocked(gitIsAncestor);

let root: string;

function setupProject(dir: string): void {
  // Minimal .story/ with config and required dirs
  const storyDir = join(dir, ".story");
  mkdirSync(storyDir, { recursive: true });
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  mkdirSync(join(storyDir, "notes"), { recursive: true });
  mkdirSync(join(storyDir, "lessons"), { recursive: true });
  mkdirSync(join(storyDir, "handovers"), { recursive: true });
  mkdirSync(join(storyDir, "sessions"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1,
    schemaVersion: 1,
    project: "test",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test",
    date: "2026-03-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  // Add a ticket for sessions to reference
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "open",
    phase: "p1", order: 10, description: "", createdDate: "2026-03-30",
    blockedBy: [], parentTicket: null,
  }));
  // Git init (needed for deriveWorkspaceId)
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

function createCompactSession(dir: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const session = createSession(dir, "coding", "test-workspace");
  const sessDir = join(dir, ".story", "sessions", session.sessionId);
  // Set to a working state
  const working = writeSessionSync(sessDir, {
    ...session,
    state: overrides.preCompactState ?? "PLAN",
    ticket: overrides.ticket ?? { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: overrides.reviews ?? { plan: [], code: [] },
  });
  // prepareForCompact needs (dir, state, opts?) -- sets COMPACT + compactPending
  prepareForCompact(sessDir, working, { expectedHead: "abc123" });
  // Read back the full state
  const stateRaw = readFileSync(join(sessDir, "state.json"), "utf-8");
  return JSON.parse(stateRaw) as FullSessionState;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss039-"));
  setupProject(root);
  mockedGitHead.mockResolvedValue({ ok: true, data: { hash: "abc123" } });
  mockedGitIsAncestor.mockResolvedValue({ ok: true, data: false });
});

afterEach(async () => {
  killSidecarsInRoot(root);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  vi.restoreAllMocks();
});


/**
 * T-446 / ISS-898 case 3: what the guide ACTUALLY does with an identity-free
 * expired-COMPACT resume.
 *
 * The session guard reports `resumable: true` and `bindsOwner: false` for that
 * row (U5). `resumable` is documented as "the server will accept this call",
 * which is a claim about runtime behavior, and the guard derives it from prose.
 * A prose-derived claim about a round trip is exactly the kind of thing that is
 * wrong without anyone noticing, so it is observed here instead of asserted
 * there. If this ever goes red, U5's capabilities are wrong and ISS-898 case 3
 * is no longer a documentation gap but a live defect.
 *
 * U5's owner axis is `any`, so one ownerless probe would not cover it. Two
 * pieces of state the guard cannot see reach the guide's enforcement path and
 * could plausibly split the row:
 *
 *   - a preexisting `ownerTask`, which decides whether "no owner is bound" and
 *     "the session ends up unowned" are the same statement (they are not), and
 *   - `claudeCodeSessionId`, which `liveOwnershipConflict` still resolves
 *     ownership through and which the scanner does not project (ISS-899).
 *
 * So the whole axis is enumerated below, each case asserting acceptance AND the
 * precise post-resume ownership. Acceptance turns out to be uniform -- the
 * foreign-owner check needs a caller identity to compare against, and there is
 * none -- while ownership splits by FIELD, and not in the way it first appears.
 * `ownerTask` is preserved rather than cleared or rebound. `claudeCodeSessionId`
 * is DERIVED from `ownerTask` whenever one is recorded (`legacyClaudeSessionIdForOwner`):
 * it becomes a claude owner's id, and it is CLEARED for a codex owner, which has
 * no claude id to put there. It survives untouched only when no `ownerTask`
 * exists. An earlier draft of these cases said a codex owner "leaves the field
 * alone"; the case that would have shown otherwise -- a codex owner WITH an
 * existing legacy id -- was missing, so the claim went unchallenged until it was
 * added. "Ownership is preserved" is true of one field and false of the other,
 * which is why every case pins both.
 */
describe("identity-free expired COMPACT resume (T-446 U5, ISS-898 case 3)", () => {
  async function resumeWithoutIdentity(sessionId: string): Promise<{ isError: boolean; text: string }> {
    const saved = {
      claude: process.env.CLAUDE_CODE_SESSION_ID,
      codex: process.env.CODEX_THREAD_ID,
      client: process.env.STORYBLOQ_CLIENT,
    };
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    process.env.STORYBLOQ_CLIENT = "claude";
    try {
      const result = await handleAutonomousGuide(root, { action: "resume", sessionId });
      return { isError: result.isError === true, text: (result.content[0] as { text: string }).text };
    } finally {
      if (saved.claude === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = saved.claude;
      if (saved.codex === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = saved.codex;
      if (saved.client === undefined) delete process.env.STORYBLOQ_CLIENT;
      else process.env.STORYBLOQ_CLIENT = saved.client;
    }
  }

  type OwnerTask = { client: "claude" | "codex"; id: string; boundAt: string };

  /** COMPACT + compactPending + expired lease, with the owner axis supplied. */
  function expiredCompact(owner: OwnerTask | undefined, legacyId: string | undefined): string {
    const session = createCompactSession(root);
    const sessDir = join(root, ".story", "sessions", session.sessionId);
    const state = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    writeSessionSync(sessDir, {
      ...state,
      ownerTask: owner,
      claudeCodeSessionId: legacyId,
      lease: { ...state.lease, expiresAt: new Date(Date.now() - 600_000).toISOString() },
    } as FullSessionState);
    return session.sessionId;
  }

  const FOREIGN_CLAUDE: OwnerTask = { client: "claude", id: "other-task", boundAt: "2026-07-01T00:00:00Z" };
  const FOREIGN_CODEX: OwnerTask = { client: "codex", id: "other-thread", boundAt: "2026-07-01T00:00:00Z" };

  const CASES: {
    name: string;
    owner?: OwnerTask;
    legacyId?: string;
    expectedOwnerAfter: OwnerTask | null;
    expectedLegacyIdAfter: string | null;
  }[] = [
    { name: "no owner, no legacy id", expectedOwnerAfter: null, expectedLegacyIdAfter: null },
    {
      name: "foreign ownerTask (claude)",
      owner: FOREIGN_CLAUDE,
      expectedOwnerAfter: FOREIGN_CLAUDE,
      // Mirrored from the claude owner's id, which had no legacy id before.
      expectedLegacyIdAfter: FOREIGN_CLAUDE.id,
    },
    {
      name: "foreign ownerTask (codex)",
      owner: FOREIGN_CODEX,
      expectedOwnerAfter: FOREIGN_CODEX,
      // Derived to null for a codex owner: `legacyClaudeSessionIdForOwner`
      // returns null because the recorded owner has no claude id to put
      // there. Reads as "unchanged" here only because it started null; the
      // case below starts populated and shows it is actively cleared.
      expectedLegacyIdAfter: null,
    },
    // The three `claudeCodeSessionId` shapes that reach `liveOwnershipConflict`
    // and that the guard's verdict cannot distinguish (ISS-899).
    {
      name: "no owner, well-formed legacy id",
      legacyId: "legacy-session-id",
      expectedOwnerAfter: null,
      expectedLegacyIdAfter: "legacy-session-id",
    },
    {
      name: "no owner, legacy id that matches nothing",
      legacyId: "11111111-2222-3333-4444-555555555555",
      expectedOwnerAfter: null,
      expectedLegacyIdAfter: "11111111-2222-3333-4444-555555555555",
    },
    {
      name: "no owner, malformed legacy id",
      legacyId: "not a valid id!!",
      expectedOwnerAfter: null,
      expectedLegacyIdAfter: "not a valid id!!",
    },
    {
      name: "foreign ownerTask and a legacy id",
      owner: FOREIGN_CLAUDE,
      legacyId: "legacy-session-id",
      expectedOwnerAfter: FOREIGN_CLAUDE,
      // The mirror overwrites the legacy id that was there.
      expectedLegacyIdAfter: FOREIGN_CLAUDE.id,
    },
    {
      // The codex half of the mirror claim. Without an EXISTING legacy id here,
      // "a codex owner does not touch the field" rests on a case that started
      // null and ended null -- which an implementation that CLEARED the field
      // for codex owners would satisfy just as well.
      name: "foreign ownerTask (codex) and a legacy id",
      owner: FOREIGN_CODEX,
      legacyId: "legacy-session-id",
      expectedOwnerAfter: FOREIGN_CODEX,
      // CLEARED, not preserved. `legacyClaudeSessionIdForOwner` derives this
      // field from `ownerTask` whenever one exists, and a codex owner has no
      // claude id to put there. Measuring this case is what corrected the
      // earlier claim that a codex owner "leaves the field alone".
      expectedLegacyIdAfter: null,
    },
  ];

  for (const c of CASES) {
    it(`is ACCEPTED and binds no new ownerTask: ${c.name}`, async () => {
      const sessionId = expiredCompact(c.owner, c.legacyId);
      const sessionPath = join(root, ".story", "sessions", sessionId, "state.json");

      // The case is only about what it says it is about if the fixture actually
      // persisted it. A schema that dropped either field would otherwise leave
      // this test asserting the ownerless case under every variant name.
      const before = JSON.parse(readFileSync(sessionPath, "utf-8")) as FullSessionState;
      expect(before.ownerTask ?? null, `fixture did not persist ownerTask: ${c.name}`).toEqual(c.owner ?? null);
      expect(before.claudeCodeSessionId ?? null, `fixture did not persist legacy id: ${c.name}`).toBe(c.legacyId ?? null);
      // The cell itself, not just the owner axis. This suite is cited as the
      // evidence for U5, which is the EXPIRED COMPACT row; if the setup drifted
      // to a live lease or a non-pending state these cases could be accepted
      // through an entirely different path and still be green.
      expect(before.state, `not the COMPACT cell: ${c.name}`).toBe("COMPACT");
      expect(before.compactPending, `not compactPending: ${c.name}`).toBe(true);
      expect(
        Date.parse(before.lease.expiresAt),
        `lease is not expired, so this is not the U5 cell: ${c.name}`,
      ).toBeLessThan(Date.now());

      const result = await resumeWithoutIdentity(sessionId);

      // `resumable: true` is a claim about the server accepting the call, and it
      // holds across the whole axis: the foreign-owner rejection needs a caller
      // identity to compare against, so with none it never fires.
      expect(result.isError, `guide rejected the call: ${result.text}`).toBe(false);
      expect(result.text).toContain("Recovered From COMPACT");

      const after = JSON.parse(readFileSync(sessionPath, "utf-8")) as FullSessionState;

      // `bindsOwner: false` means no NEW owner is bound, which is not the same
      // as the session ending up unowned: "successful recovery rebinds
      // ownership" has nothing to act on, so whatever owner was recorded is
      // still recorded. That gap is ISS-898 case 3.
      expect(after.ownerTask ?? null, `ownership changed in case: ${c.name}`).toEqual(c.expectedOwnerAfter);
      expect(after.claudeCodeSessionId ?? null, `legacy id changed in case: ${c.name}`).toBe(c.expectedLegacyIdAfter);
    });
  }

});
