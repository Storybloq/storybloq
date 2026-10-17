/**
 * ISS-1052: `recoverPendingMutation`'s `issue_update` branch (guide.ts) used
 * to be a plain-read-then-separately-locked-write two-step wrapped in a
 * catch that cleared the marker regardless of outcome -- fail-open on a
 * thrown error, and non-atomic even on the happy path. This suite targets
 * guide.ts directly (not just the pick-ticket.ts origin site fixed
 * separately), proving the rewritten branch:
 *  - never clears the marker on a thrown lock/IO error (matches the sibling
 *    `ticket_update` branch's existing correct behavior);
 *  - uses a fingerprint-based 3-way check (postimage match -> already
 *    applied; preimage match -> safe to replay; neither -> conflict) instead
 *    of a status-only comparison, so a foreign edit the status check cannot
 *    see is caught as a conflict rather than silently overwritten;
 *  - falls back to the legacy status-only check ONLY when both fingerprints
 *    are strictly absent, and treats any OTHER partial/malformed shape as a
 *    conflict, never silently folded into either path;
 *  - logs a `mutation_conflict` event for a missing target, rather than a
 *    silent no-op;
 *  - performs the read and the write inside the SAME `withProjectLock`
 *    callback invocation, never through `handleIssueUpdate`'s own
 *    separately-locked path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
  gitUserEmail: vi.fn().mockResolvedValue("me@example.com"),
}));

const hoisted = vi.hoisted(() => ({
  failLock: false,
  lockCallCount: 0,
  currentLockInvocation: null as number | null,
  writeIssueCalls: [] as Array<{ lockInvocation: number | null }>,
  issueUpdateCalls: 0,
  injectInprogressError: false,
}));

// T-481: the pen's replay test needs a project that loads strictly and still
// fails post-write validation. No shipped rule turns on an issue's status, so
// an extra error finding is added while the switch is on, only for a project
// in which ISS-001 is inprogress: the pre-write state passes, the candidate
// fails.
vi.mock("../../src/core/validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/validation.js")>();
  return {
    ...actual,
    validateProject: (...args: Parameters<typeof actual.validateProject>) => {
      const result = actual.validateProject(...args);
      if (!hoisted.injectInprogressError) return result;
      const target = args[0].issues.find((i) => i.id === "ISS-001");
      if (target?.status !== "inprogress") return result;
      return {
        ...result,
        findings: [...result.findings, { level: "error", code: "t481_injected", message: "Injected post-write failure.", entity: "ISS-001" }],
      } as typeof result;
    },
  };
});

vi.mock("../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/project-loader.js")>();
  return {
    ...actual,
    withProjectLock: async (...args: Parameters<typeof actual.withProjectLock>) => {
      if (hoisted.failLock) throw new Error("simulated lock/read/write failure");
      hoisted.lockCallCount++;
      const myInvocation = hoisted.lockCallCount;
      const prevInvocation = hoisted.currentLockInvocation;
      hoisted.currentLockInvocation = myInvocation;
      try {
        return await actual.withProjectLock(...args);
      } finally {
        hoisted.currentLockInvocation = prevInvocation;
      }
    },
    writeIssueUnlocked: async (...args: Parameters<typeof actual.writeIssueUnlocked>) => {
      hoisted.writeIssueCalls.push({ lockInvocation: hoisted.currentLockInvocation });
      return actual.writeIssueUnlocked(...args);
    },
  };
});

vi.mock("../../src/cli/commands/issue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/commands/issue.js")>();
  return {
    ...actual,
    handleIssueUpdate: async (...args: Parameters<typeof actual.handleIssueUpdate>) => {
      hoisted.issueUpdateCalls++;
      return actual.handleIssueUpdate(...args);
    },
  };
});

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import { entityFingerprint } from "../../src/autonomous/pending-artifacts.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { PickTicketStage } from "../../src/autonomous/stages/pick-ticket.js";
import { todayISO } from "../../src/cli/helpers.js";

const NOW = new Date().toISOString();

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
    title: "test", date: "2026-08-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
}

function writeTicket(root: string, id: string, extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: `Ticket ${id}`, description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-08-30",
    completedDate: null, blockedBy: [],
    ...extra,
  }));
}

function issueRecord(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-08-30",
    resolvedDate: null, relatedTickets: [],
    ...extra,
  };
}

function writeIssue(root: string, id: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify(issueRecord(id, extra)));
}

function readIssue(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "issues", `${id}.json`), "utf-8"));
}

function readState(sessDir: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
}

function eventsOfType(sessDir: string, type: string): Array<Record<string, unknown>> {
  const logPath = join(sessDir, "events.log");
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === type);
}

/**
 * Computes an issue's fingerprint the same way `entityFingerprint` sees it in
 * production: through the SAME loader/schema pass (`loadProject`), not from
 * a hand-rolled literal -- the loader normalizes fields (defaults, ordering)
 * that a raw JSON literal does not carry, so a fingerprint computed off the
 * raw literal would not match the one guide.ts computes off the loaded issue.
 */
async function loadedIssueFingerprint(root: string, id: string, overrides: Record<string, unknown> = {}): Promise<string | null> {
  const { loadProject } = await import("../../src/core/project-loader.js");
  const { state } = await loadProject(root);
  const issue = state.issues.find((i) => i.id === id);
  if (!issue) throw new Error(`fixture issue ${id} not found`);
  return entityFingerprint({ ...issue, ...overrides });
}

/**
 * A genuinely NON-terminal session (WRITE_TESTS, ticket "inprogress" with a
 * matching claim) driven via `action: "start"` -- per iss913-recovery-
 * ownership.test.ts's own established reachability note, `report`/`resume`
 * are gated by `claimPreflightBlock` AHEAD of `recoverPendingMutation`, so
 * they never reach the issue_update branch's own classification logic for an
 * ordinary active session. `start` recovers first, then separately refuses
 * with "already exists" (an active session exists) -- that refusal is
 * expected and orthogonal to what recovery itself did; the assertions below
 * are on-disk effects (session state, issue file, events.log), not on
 * `result.isError`. A "complete" ticket (as iss965's own fixture uses) would
 * instead take the completed-consistent DISCARD shortcut ahead of recovery
 * entirely, never exercising this branch's logic at all.
 */
function plantSession(root: string, mutation: Record<string, unknown> | null): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const epoch = {
    ticketId: "T-001", sessionId: session.sessionId, user: "me@example.com",
    branch: "main", since: NOW, establishedAt: NOW,
  };
  writeSessionSync(sessDir, {
    ...session,
    state: "WRITE_TESTS",
    previousState: "PLAN_REVIEW",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    claimEpoch: epoch,
    pendingProjectMutation: mutation,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

async function driveRecovery(root: string) {
  return handleAutonomousGuide(root, { action: "start" });
}

let root: string;

beforeEach(() => {
  hoisted.failLock = false;
  hoisted.lockCallCount = 0;
  hoisted.currentLockInvocation = null;
  hoisted.writeIssueCalls = [];
  hoisted.issueUpdateCalls = 0;
  hoisted.injectInprogressError = false;
  root = mkdtempSync(join(tmpdir(), "guide-recover-issue-"));
  setupProject(root);
});

afterEach(() => {
  killSidecarsInRoot(root);
  rmSync(root, { recursive: true, force: true });
});

describe("recoverPendingMutation issue_update branch (ISS-1052)", () => {
  it("a thrown lock/IO error leaves the marker SET (matches the ticket_update branch's existing behavior)", async () => {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001");
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-lock-fail",
    });

    hoisted.failLock = true;
    const before = readIssue(root, "ISS-001");
    await driveRecovery(root);
    hoisted.failLock = false;

    // Whatever the overall report call does with a lock failure, the marker
    // itself must survive untouched for the next attempt to retry.
    const after = readState(sessDir);
    expect(after.pendingProjectMutation).not.toBeNull();
    expect((after.pendingProjectMutation as Record<string, unknown>).type).toBe("issue_update");
    expect(readIssue(root, "ISS-001")).toEqual(before);
  });

  it("postimageFingerprint matching the current issue is 'already applied': marker cleared, no replay write", async () => {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { status: "inprogress" });
    const postimageFingerprint = await loadedIssueFingerprint(root, "ISS-001");
    const preimageFingerprint = await loadedIssueFingerprint(root, "ISS-001", { status: "open" });
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-already-applied",
      preimageFingerprint,
      postimageFingerprint,
    });

    await driveRecovery(root);

    expect(readState(sessDir).pendingProjectMutation).toBeNull();
    expect(hoisted.writeIssueCalls.length).toBe(0);
    expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(0);
  });

  it("preimageFingerprint matching is 'safe to replay': writes the target value", async () => {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { status: "open" });
    const preimageFingerprint = await loadedIssueFingerprint(root, "ISS-001");
    const postimageFingerprint = await loadedIssueFingerprint(root, "ISS-001", { status: "inprogress" });
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-replay",
      preimageFingerprint,
      postimageFingerprint,
    });

    await driveRecovery(root);

    expect(readState(sessDir).pendingProjectMutation).toBeNull();
    expect(readIssue(root, "ISS-001").status).toBe("inprogress");
    expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(0);
  });

  it("AM3 (T-478, codex round-1): a preimage match with an internally inconsistent value/postimage pair is a CONFLICT (reason: inconsistent-marker), never a replay of the wrong status", async () => {
    // preimageFingerprint genuinely matches the current issue ("open"), so
    // the naive status-only/preimage check alone would call this safe to
    // replay -- but the marker's own `value` ("resolved") does not match
    // what its own `postimageFingerprint` actually describes ("inprogress").
    // A malformed/corrupted/tampered marker exactly like this must never
    // authorize a write of `value`, since the marker cannot prove `value` is
    // what it claims the post-write state will be.
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { status: "open" });
    const preimageFingerprint = await loadedIssueFingerprint(root, "ISS-001");
    const postimageFingerprint = await loadedIssueFingerprint(root, "ISS-001", { status: "inprogress" });
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "resolved", expectedCurrent: "open",
      transitionId: "txn-inconsistent-marker",
      preimageFingerprint,
      postimageFingerprint, // describes "inprogress", not "resolved" -- inconsistent with `value` above
    });

    await driveRecovery(root);

    expect(readState(sessDir).pendingProjectMutation).toBeNull();
    // Not replayed: status must be untouched (still "open"), never "resolved" or "inprogress".
    expect(readIssue(root, "ISS-001").status).toBe("open");
    expect(hoisted.writeIssueCalls.length).toBe(0);
    const conflicts = eventsOfType(sessDir, "mutation_conflict");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.data).toMatchObject({ targetId: "ISS-001", reason: "inconsistent-marker" });
  });

  it("a status-only match with a preimage MISMATCH (foreign drift in another field) is a CONFLICT, not a silent replay", async () => {
    // The issue's status still reads "open" (what expectedCurrent asks for),
    // but a foreign edit changed `impact` after the fingerprints were
    // captured -- a status-only check would say "safe to replay" here; the
    // fingerprint check must not. Fingerprints are captured from the loaded
    // issue BEFORE the drift, exactly as pick-ticket.ts captures them
    // together at pick time, so the mismatch below is caused specifically by
    // the drift, not by an incidental loader-normalization difference.
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { status: "open", impact: "original impact" });
    const preimageFingerprint = await loadedIssueFingerprint(root, "ISS-001");
    const postimageFingerprint = await loadedIssueFingerprint(root, "ISS-001", { status: "inprogress" });
    // The foreign drift, landing AFTER the fingerprints above were captured.
    writeIssue(root, "ISS-001", { status: "open", impact: "DRIFTED impact from a foreign edit" });
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-drift-conflict",
      preimageFingerprint,
      postimageFingerprint,
    });

    await driveRecovery(root);

    expect(readState(sessDir).pendingProjectMutation).toBeNull();
    // Not replayed: status must be untouched (still "open"), not overwritten to "inprogress".
    expect(readIssue(root, "ISS-001").status).toBe("open");
    expect(readIssue(root, "ISS-001").impact).toBe("DRIFTED impact from a foreign edit");
    expect(hoisted.writeIssueCalls.length).toBe(0);
    const conflicts = eventsOfType(sessDir, "mutation_conflict");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.data).toMatchObject({ targetId: "ISS-001" });
  });

  it("a legacy marker with BOTH fingerprints strictly absent falls back to the status-only check unchanged", async () => {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { status: "open" });
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-legacy",
      // preimageFingerprint / postimageFingerprint deliberately absent.
    });

    await driveRecovery(root);

    expect(readState(sessDir).pendingProjectMutation).toBeNull();
    expect(readIssue(root, "ISS-001").status).toBe("inprogress");
    expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(0);
  });

  describe("malformed-marker shapes (round 3): neither the modern nor the legacy path may claim these", () => {
    const cases: Array<{ name: string; overrides: Record<string, unknown> }> = [
      { name: "preimage present and valid, postimage absent", overrides: { preimageFingerprint: "fp-a" } },
      { name: "postimage present and valid, preimage absent", overrides: { postimageFingerprint: "fp-b" } },
      { name: "preimage non-string (number)", overrides: { preimageFingerprint: 12345, postimageFingerprint: "fp-b" } },
      { name: "postimage empty string", overrides: { preimageFingerprint: "fp-a", postimageFingerprint: "" } },
    ];

    for (const { name, overrides } of cases) {
      it(`${name} -> mutation_conflict with reason "malformed-marker", no replay write`, async () => {
        writeTicket(root, "T-001", { status: "inprogress" });
        writeIssue(root, "ISS-001", { status: "open" });
        const { sessDir } = plantSession(root, {
          type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
          transitionId: `txn-malformed-${name}`,
          ...overrides,
        });

        await driveRecovery(root);

        expect(readState(sessDir).pendingProjectMutation).toBeNull();
        expect(readIssue(root, "ISS-001").status).toBe("open"); // untouched
        expect(hoisted.writeIssueCalls.length).toBe(0);
        const conflicts = eventsOfType(sessDir, "mutation_conflict");
        expect(conflicts.length).toBe(1);
        expect(conflicts[0]?.data).toMatchObject({ targetId: "ISS-001", reason: "malformed-marker" });
      });
    }
  });

  it("a missing target logs a mutation_conflict event (previously a silent no-op)", async () => {
    writeTicket(root, "T-001", { status: "inprogress" });
    // ISS-999 deliberately never written to disk.
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-999", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-missing-target",
    });

    await driveRecovery(root);

    expect(readState(sessDir).pendingProjectMutation).toBeNull();
    const conflicts = eventsOfType(sessDir, "mutation_conflict");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]?.data).toMatchObject({ targetId: "ISS-999", reason: "target-missing" });
  });

  it("atomicity: the read and the write happen inside the SAME withProjectLock callback invocation, and handleIssueUpdate is never called from this branch", async () => {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { status: "open" });
    const preimageFingerprint = await loadedIssueFingerprint(root, "ISS-001");
    const postimageFingerprint = await loadedIssueFingerprint(root, "ISS-001", { status: "inprogress" });
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-atomic",
      preimageFingerprint,
      postimageFingerprint,
    });

    await driveRecovery(root);

    expect(readIssue(root, "ISS-001").status).toBe("inprogress");
    // handleIssueUpdate (the separately-locked path) is NEVER called from
    // this branch post-fix -- proves the two-separately-locked-calls shape
    // round 2 removed is actually gone from the production call graph, not
    // merely absent from this test's own fixture.
    expect(hoisted.issueUpdateCalls).toBe(0);
    // Exactly one writeIssueUnlocked call, and it happened DURING a
    // withProjectLock invocation (non-null lockInvocation) -- i.e. inside
    // the lock's own callback, not after it returned.
    expect(hoisted.writeIssueCalls.length).toBe(1);
    expect(hoisted.writeIssueCalls[0]?.lockInvocation).not.toBeNull();
  });
});

// T-481 B5: a marker written before T-481 carries no stampDate. Its
// fingerprints describe an unstamped image, so its replay must write that
// image exactly: status changed, updatedDate left as it was.
describe("T-481 B5: a pre-T-481 issue_update marker replays unstamped", () => {
  it("preimage match replays the status and leaves an old updatedDate untouched", async () => {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { status: "open", updatedDate: "2020-01-01" });
    const preimageFingerprint = await loadedIssueFingerprint(root, "ISS-001");
    const postimageFingerprint = await loadedIssueFingerprint(root, "ISS-001", { status: "inprogress" });
    const { sessDir } = plantSession(root, {
      type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
      transitionId: "txn-legacy-replay", preimageFingerprint, postimageFingerprint,
    });
    await driveRecovery(root);
    expect(readState(sessDir).pendingProjectMutation).toBeNull();
    const after = readIssue(root, "ISS-001");
    expect(after.status).toBe("inprogress");
    expect(after.updatedDate).toBe("2020-01-01");
    expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(0);
  });
});

// T-481 B6 (guide level): the issue-pick marker as pick-ticket.ts:609-610
// builds it at 440397eb, fingerprinted over the snapshot read BEFORE the
// earmark conversion and over `{ ...issue, status: "inprogress" }`, while the
// ledger holds what the pick actually wrote. Characterises what recovery does
// today; T13c inverts it.
describe("T-481 B6: guide recovery of the issue-pick marker at base", () => {
  const reserved = {
    stage: "reserved", reservedBy: { client: "claude", id: "pen-task" },
    arrangementId: "a-0000000000000001", since: "2020-01-01T00:00:00.000Z",
    holderRole: "worker", holderSession: null,
  };
  const staleKind = { kind: "fixed", closedOn: "2020-01-01", resolutionDigest: "0".repeat(64) };

  async function planted(snapshot: Record<string, unknown>) {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", snapshot);
    const preimageFingerprint = await loadedIssueFingerprint(root, "ISS-001");
    const postimageFingerprint = await loadedIssueFingerprint(root, "ISS-001", { status: "inprogress" });
    return { preimageFingerprint, postimageFingerprint };
  }

  const cases: Array<[string, Record<string, unknown>, (sessionId: string) => Record<string, unknown>]> = [
    ["(a) reserved earmark converted, crash before the status write", { status: "open", earmark: reserved },
      (sid) => ({ status: "open", earmark: { ...reserved, stage: "assigned", holderSession: sid } })],
    ["(b) reserved earmark converted, crash after the status write", { status: "open", earmark: reserved },
      (sid) => ({ status: "inprogress", earmark: { ...reserved, stage: "assigned", holderSession: sid } })],
    ["(c) stale resolutionKind, crash after the status write", { status: "open", resolutionKind: staleKind },
      () => ({ status: "inprogress" })],
  ];
  for (const [name, snapshot, landed] of cases) {
    it(`${name}: recovery records a conflict and writes nothing`, async () => {
      const fps = await planted(snapshot);
      const { sessionId, sessDir } = plantSession(root, {
        type: "issue_update", target: "ISS-001", value: "inprogress", expectedCurrent: "open",
        transitionId: "txn-b6", ...fps,
      });
      writeIssue(root, "ISS-001", landed(sessionId));
      const before = readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf-8");
      await driveRecovery(root);
      expect(eventsOfType(sessDir, "mutation_conflict").length).toBe(1);
      expect(readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf-8")).toBe(before);
    });
  }
});

// T-481 T13c, T13e and the strict-load-passes, validation-fails replay: the
// issue pick records a stamped marker whose postimage is the image the live
// write produces; recovery replays exactly that image under the live write's
// checks, or recognises it as applied, and never writes on a refusal.
describe("T-481 T13c/T13e: the stamped issue-pick marker and its recovery", () => {
  const reserved = {
    stage: "reserved", reservedBy: { client: "claude", id: "pen-task" },
    arrangementId: "a-0000000000000001", since: "2020-01-01T00:00:00.000Z",
    holderRole: "worker", holderSession: null,
  };
  const staleKind = { kind: "fixed", closedOn: "2020-01-01", resolutionDigest: "0".repeat(64) };
  const issuePath = () => join(root, ".story", "issues", "ISS-001.json");
  const issueBytes = () => readFileSync(issuePath(), "utf-8");
  const corruptTicket = () => join(root, ".story", "tickets", "T-999.json");

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function makeRecipe(): ResolvedRecipe {
    return {
      id: "coding",
      pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
      postComplete: [], stages: {}, dirtyFileHandling: "block",
      branchStrategy: "current" as ResolvedRecipe["branchStrategy"],
      reviewEffort: {
        level: "standard", source: "default",
        explicitKnobs: { codeReviewMaxRounds: false, planReviewBackends: false, codeReviewBackends: false },
      },
      defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    };
  }

  type Pick = {
    sessionId: string; sessDir: string; planted: FullSessionState; ctx: StageContext;
    marker: Record<string, unknown> | null; atMarker: string | null; final: string;
  };

  /** Runs the real issue pick in a planted session; `onMarker` runs right after the marker is written. */
  async function livePick(snapshot: Record<string, unknown>, onMarker?: () => void): Promise<Pick> {
    writeTicket(root, "T-001", { status: "inprogress" });
    writeIssue(root, "ISS-001", { updatedDate: "2020-01-01", ...snapshot });
    const { sessionId, sessDir } = plantSession(root, null);
    const planted = readState(sessDir);
    const ctx = new StageContext(root, sessDir, {
      ...planted, state: "PICK_TICKET", ticket: undefined, claimEpoch: undefined,
    } as unknown as FullSessionState, makeRecipe());
    vi.spyOn(PickTicketStage.prototype as unknown as { applyStrategy: () => Promise<unknown> }, "applyStrategy")
      .mockResolvedValue(null);
    const out: Pick = { sessionId, sessDir, planted, ctx, marker: null, atMarker: null, final: "" };
    const original = ctx.writeState.bind(ctx);
    vi.spyOn(ctx, "writeState").mockImplementation(((patch: Record<string, unknown>) => {
      const written = original(patch as never);
      if (patch && patch.pendingProjectMutation) {
        out.marker = JSON.parse(JSON.stringify(patch.pendingProjectMutation)) as Record<string, unknown>;
        out.atMarker = issueBytes();
        onMarker?.();
      }
      return written;
    }) as never);
    const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(result.action, JSON.stringify(result)).not.toBe("retry");
    vi.mocked(ctx.writeState).mockRestore();
    out.final = issueBytes();
    return out;
  }

  /** Puts the planted session back with the pick's marker, as a crash would leave it. */
  function replant(pick: Pick): void {
    writeSessionSync(pick.sessDir, { ...pick.planted, pendingProjectMutation: pick.marker } as FullSessionState);
  }

  /** Moves the clock past the next local midnight and refreshes the lease. */
  function nextLocalDay(sessDir: string): void {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 5, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(d);
    const now = new Date();
    const s = readState(sessDir) as unknown as Record<string, unknown>;
    writeSessionSync(sessDir, {
      ...s,
      lease: { ...(s.lease as Record<string, unknown>), lastHeartbeat: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString() },
    } as unknown as FullSessionState);
  }

  const cases: Array<[string, Record<string, unknown>]> = [
    ["no earmark", { status: "open" }],
    ["a reserved earmark converted at pick", { status: "open", earmark: reserved }],
    ["a stale resolutionKind", { status: "open", resolutionKind: staleKind }],
    ["both", { status: "open", earmark: reserved, resolutionKind: staleKind }],
  ];

  for (const [name, snapshot] of cases) {
    it(`${name}: the live pick writes the stamped postimage the marker records`, async () => {
      const day = todayISO();
      const pick = await livePick(snapshot);
      expect(pick.marker?.stampDate).toBe(day);
      const after = JSON.parse(pick.final) as Record<string, unknown>;
      expect(after.status).toBe("inprogress");
      expect(after.updatedDate).toBe(day);
      expect(after.resolutionKind).toBeUndefined();
      if ("earmark" in snapshot) expect(after.earmark).toMatchObject({ stage: "assigned", holderSession: pick.sessionId });
      expect(await loadedIssueFingerprint(root, "ISS-001")).toBe(pick.marker?.postimageFingerprint);
    });

    for (const nextDay of [false, true]) {
      it(`${name}: a crash before the status write is replayed to the recorded postimage${nextDay ? " on the next local day" : ""}`, async () => {
        const day = todayISO();
        const pick = await livePick(snapshot);
        expect(pick.marker?.stampDate).toBe(day);
        writeFileSync(issuePath(), pick.atMarker!);
        replant(pick);
        if (nextDay) nextLocalDay(pick.sessDir);
        await driveRecovery(root);
        expect(readState(pick.sessDir).pendingProjectMutation).toBeNull();
        expect(eventsOfType(pick.sessDir, "mutation_conflict").length).toBe(0);
        expect(JSON.parse(issueBytes())).toEqual(JSON.parse(pick.final));
        expect(readIssue(root, "ISS-001").updatedDate).toBe(day);
        expect(await loadedIssueFingerprint(root, "ISS-001")).toBe(pick.marker?.postimageFingerprint);
      });
    }

    it(`${name}: a crash after the status write is recognised as applied and nothing is written`, async () => {
      const pick = await livePick(snapshot);
      expect(pick.marker?.stampDate).toBe(todayISO());
      replant(pick);
      hoisted.writeIssueCalls = [];
      await driveRecovery(root);
      expect(readState(pick.sessDir).pendingProjectMutation).toBeNull();
      expect(eventsOfType(pick.sessDir, "mutation_conflict").length).toBe(0);
      expect(hoisted.writeIssueCalls.length).toBe(0);
      expect(issueBytes()).toBe(pick.final);
    });
  }

  it("an issue changed between the marker and the status write is not written, and the marker stays", async () => {
    let changed = "";
    const pick = await livePick({ status: "open" }, () => {
      writeIssue(root, "ISS-001", { status: "open", updatedDate: "2020-01-01", title: "Edited by someone else" });
      changed = issueBytes();
    });
    expect(pick.final).toBe(changed);
    expect(pick.ctx.state.pendingProjectMutation).not.toBeNull();
  });

  it("T13e live: another ticket made unreadable after the marker refuses the status write, and the marker stays", async () => {
    const pick = await livePick({ status: "open" }, () => { writeFileSync(corruptTicket(), "{ not json"); });
    expect(pick.final).toBe(pick.atMarker);
    expect(pick.ctx.state.pendingProjectMutation).not.toBeNull();
  });

  it("T13e recovery: at the preimage with an unreadable ticket it refuses and keeps the marker; once repaired it replays", async () => {
    const pick = await livePick({ status: "open", earmark: reserved });
    writeFileSync(issuePath(), pick.atMarker!);
    replant(pick);
    writeFileSync(corruptTicket(), "{ not json");
    await driveRecovery(root);
    expect(issueBytes()).toBe(pick.atMarker);
    expect(readState(pick.sessDir).pendingProjectMutation).not.toBeNull();

    rmSync(corruptTicket());
    await driveRecovery(root);
    expect(readState(pick.sessDir).pendingProjectMutation).toBeNull();
    expect(JSON.parse(issueBytes())).toEqual(JSON.parse(pick.final));
    expect(await loadedIssueFingerprint(root, "ISS-001")).toBe(pick.marker?.postimageFingerprint);
  });

  it("T13e recovery: at the postimage with an unreadable ticket it recognises the write and writes nothing", async () => {
    const pick = await livePick({ status: "open", earmark: reserved });
    replant(pick);
    writeFileSync(corruptTicket(), "{ not json");
    hoisted.writeIssueCalls = [];
    await driveRecovery(root);
    expect(readState(pick.sessDir).pendingProjectMutation).toBeNull();
    expect(hoisted.writeIssueCalls.length).toBe(0);
    expect(issueBytes()).toBe(pick.final);
  });

  for (const bad of ["2026-02-30", "20261017", 20261017] as const) {
    it(`T13d: a marker whose stampDate is ${JSON.stringify(bad)} is malformed: no replay, nothing written`, async () => {
      const pick = await livePick({ status: "open", earmark: reserved });
      expect(typeof pick.marker?.stampDate).toBe("string");
      writeFileSync(issuePath(), pick.atMarker!);
      pick.marker = { ...pick.marker!, stampDate: bad };
      replant(pick);
      hoisted.writeIssueCalls = [];
      await driveRecovery(root);
      expect(issueBytes()).toBe(pick.atMarker);
      expect(hoisted.writeIssueCalls.length).toBe(0);
      expect(eventsOfType(pick.sessDir, "mutation_conflict").length).toBe(1);
    });
  }

  it("a replay that passes the strict load but fails post-write validation writes nothing and keeps the marker", async () => {
    const pick = await livePick({ status: "open", earmark: reserved });
    expect(pick.marker?.stampDate).toBe(todayISO());
    writeFileSync(issuePath(), pick.atMarker!);
    replant(pick);
    hoisted.injectInprogressError = true;
    hoisted.writeIssueCalls = [];
    await driveRecovery(root);
    expect(issueBytes()).toBe(pick.atMarker);
    expect(hoisted.writeIssueCalls.length).toBe(0);
    expect(readState(pick.sessDir).pendingProjectMutation).not.toBeNull();
  });
});
