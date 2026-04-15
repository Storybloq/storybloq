/**
 * T-250: Auto-supersede verifiably-finished orphan sessions.
 *
 * Exercises handleAutonomousGuide with action: "start" against real on-disk
 * .story/ trees and real git repositories. git-inspector is NOT mocked — we
 * want real gitIsAncestor semantics because the orphan check is load-bearing.
 *
 * All 14 tests MUST fail before the production implementation lands. They
 * define the contract for the isFinishedOrphan / trySupersedeFinishedOrphan
 * helpers and their two call sites in handleStart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import {
  appendEvent,
  createSession,
  readEvents,
  readSession,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

interface CommitSpec {
  id: string;                 // T-X or ISS-X
  kind: "ticket" | "issue";
  reachable: boolean;         // commit on main (reachable) vs. side branch (not reachable)
}

interface OnDiskSpec {
  id: string;
  kind: "ticket" | "issue";
  status: "open" | "inprogress" | "resolved" | "complete";
}

interface FixtureOpts {
  targetWork: string[];
  leaseMinutesAgo: number;          // lease.expiresAt = now - this
  compactPending: boolean;          // route via findResumableSession when true
  onDisk: OnDiskSpec[];
  commits: CommitSpec[];
  invalidLeaseString?: string;      // if set, overrides lease.expiresAt
  skipCompletedTicketsEntry?: boolean; // for regression test #6
  mode?: "auto" | "review" | "plan" | "guided"; // default auto
  corruptEventsLog?: "garbage_line" | "invalid_commit_shape"; // for fail-closed tests
}

interface Fixture {
  root: string;
  sessionDir: string;
  sessionId: string;
  reachableCommitByTarget: Record<string, string>;
  unreachableCommitByTarget: Record<string, string>;
}

function setupProjectTree(root: string): void {
  const story = join(root, ".story");
  mkdirSync(story, { recursive: true });
  mkdirSync(join(story, "tickets"), { recursive: true });
  mkdirSync(join(story, "issues"), { recursive: true });
  mkdirSync(join(story, "notes"), { recursive: true });
  mkdirSync(join(story, "lessons"), { recursive: true });
  mkdirSync(join(story, "handovers"), { recursive: true });
  mkdirSync(join(story, "sessions"), { recursive: true });
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "t250-orphan-fixture",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: {
      stages: {
        WRITE_TESTS: { enabled: false },
        TEST: { enabled: false },
        BUILD: { enabled: false },
        VERIFY: { enabled: false },
      },
    },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "t250",
    date: "2026-04-10",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test phase" }],
    blockers: [],
  }));
}

function writeTicket(root: string, id: string, status: "open" | "inprogress" | "complete"): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id,
    title: `Ticket ${id}`,
    type: "task",
    status,
    phase: "p1",
    order: 10,
    description: "",
    createdDate: "2026-04-10",
    completedDate: status === "complete" ? "2026-04-10" : null,
    blockedBy: [],
    parentTicket: null,
  }));
}

function writeIssue(root: string, id: string, status: "open" | "inprogress" | "resolved"): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id,
    title: `Issue ${id}`,
    status,
    severity: "medium",
    components: [],
    impact: "test",
    resolution: status === "resolved" ? "fixed in test fixture" : null,
    location: [],
    discoveredDate: "2026-04-10",
    resolvedDate: status === "resolved" ? "2026-04-10" : null,
    relatedTickets: [],
    order: 10,
    phase: "p1",
  }));
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Initialise a real throwaway git repo and return the initial HEAD sha. */
function gitInit(root: string): string {
  run("git init -q -b main", root);
  run("git config user.email test@test.com", root);
  run("git config user.name Test", root);
  writeFileSync(join(root, "README.md"), "# test fixture\n");
  run("git add .", root);
  run("git commit -q -m initial", root);
  return run("git rev-parse HEAD", root);
}

function commitOnMain(root: string, marker: string): string {
  writeFileSync(join(root, `${marker}.txt`), `${marker}\n`);
  run(`git add ${marker}.txt`, root);
  run(`git commit -q -m "${marker}"`, root);
  return run("git rev-parse HEAD", root);
}

function commitOnSideBranch(root: string, marker: string): string {
  const branch = `side-${marker}`;
  run(`git checkout -q -b ${branch}`, root);
  writeFileSync(join(root, `${marker}.txt`), `${marker}\n`);
  run(`git add ${marker}.txt`, root);
  run(`git commit -q -m "${marker}"`, root);
  const sha = run("git rev-parse HEAD", root);
  run("git checkout -q main", root);
  return sha;
}

function buildFixture(opts: FixtureOpts): Fixture {
  const root = mkdtempSync(join(tmpdir(), "t250-orphan-"));
  setupProjectTree(root);
  gitInit(root);

  // Write on-disk ticket/issue entries.
  for (const item of opts.onDisk) {
    if (item.kind === "ticket") writeTicket(root, item.id, item.status as "open" | "inprogress" | "complete");
    else writeIssue(root, item.id, item.status as "open" | "inprogress" | "resolved");
  }

  // Produce commits.
  const reachable: Record<string, string> = {};
  const unreachable: Record<string, string> = {};
  for (const c of opts.commits) {
    const marker = c.id.replace(/[^a-zA-Z0-9]/g, "_");
    if (c.reachable) reachable[c.id] = commitOnMain(root, marker);
    else unreachable[c.id] = commitOnSideBranch(root, marker);
  }

  // Create a session, move it to the desired lease/compact posture.
  const workspaceId = deriveWorkspaceId(root);
  const session = createSession(root, "coding", workspaceId);
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  const leaseExpiresAt = opts.invalidLeaseString
    ?? new Date(Date.now() - opts.leaseMinutesAgo * 60 * 1000).toISOString();

  const completedTickets: FullSessionState["completedTickets"] = [];
  if (!opts.skipCompletedTicketsEntry) {
    for (const c of opts.commits) {
      if (c.kind !== "ticket") continue;
      completedTickets.push({
        id: c.id,
        title: `Ticket ${c.id}`,
        commitHash: c.reachable ? reachable[c.id]! : unreachable[c.id]!,
        risk: "low",
        realizedRisk: "low",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }
  }

  const posture: Partial<FullSessionState> = opts.compactPending
    ? {
        state: "COMPACT",
        compactPending: true,
        compactPreparedAt: new Date(Date.now() - opts.leaseMinutesAgo * 60 * 1000).toISOString(),
        preCompactState: "IMPLEMENT",
      }
    : {
        state: "IMPLEMENT",
        compactPending: false,
      };

  writeSessionSync(sessDir, {
    ...session,
    ...posture,
    mode: opts.mode ?? "auto",
    lease: {
      ...session.lease,
      expiresAt: leaseExpiresAt,
    },
    targetWork: opts.targetWork,
    completedTickets,
  });

  // Append real `commit` events mirroring finalize.ts for every commit.
  for (const c of opts.commits) {
    const hash = c.reachable ? reachable[c.id] : unreachable[c.id];
    const data: Record<string, unknown> = c.kind === "issue"
      ? { commitHash: hash!, issueId: c.id }
      : { commitHash: hash!, ticketId: c.id };
    if (opts.corruptEventsLog === "invalid_commit_shape") {
      // Break the shape: commitHash present but not a string.
      data.commitHash = 42;
    }
    appendEvent(sessDir, {
      rev: 1,
      type: "commit",
      timestamp: new Date().toISOString(),
      data,
    });
  }

  if (opts.corruptEventsLog === "garbage_line") {
    appendFileSync(join(sessDir, "events.log"), "this is not json\n");
  }

  return {
    root,
    sessionDir: sessDir,
    sessionId: session.sessionId,
    reachableCommitByTarget: reachable,
    unreachableCommitByTarget: unreachable,
  };
}

// ---------------------------------------------------------------------------
// Shared state + cleanup
// ---------------------------------------------------------------------------

const createdRoots: string[] = [];
let stderrWrites: string[] = [];
let originalStderrWrite: typeof process.stderr.write;

function track(fixture: Fixture): Fixture {
  createdRoots.push(fixture.root);
  return fixture;
}

beforeEach(() => {
  stderrWrites = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  // Capture stderr for diagnostic-line assertions.
  (process.stderr.write as unknown as (chunk: unknown) => boolean) = ((chunk: unknown) => {
    stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    killSidecarsInRoot(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-250 auto-supersede finished orphan sessions", () => {
  // 1. Primary ISS-377/378 recovery path (compact + expired lease branch).
  it("autoSupersedesFinishedOrphan_issueTarget_expiredCompactPending", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-101"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-101", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-101", kind: "issue", reachable: true }],
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });

    // New session must be allowed to start, not blocked with a guide error
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("PICK_TICKET");

    // Orphan session file should be rewritten as superseded with the rich reason
    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("superseded");
    expect(orphanState!.terminationReason).toBe("auto_superseded_finished_orphan");

    // Structured audit event
    const { events } = readEvents(fix.sessionDir);
    const audit = events.find((e) => e.type === "auto_superseded");
    expect(audit).toBeDefined();
    expect(audit!.data).toMatchObject({ reason: "finished_orphan", targetWork: ["ISS-101"] });
    // ISS-389: typeof NaN === "number", so the previous assertion was weaker
    // than it looked. Use Number.isFinite to actually reject NaN/Infinity.
    expect(
      Number.isFinite((audit!.data as { leaseExpiredMinutesAgo?: unknown }).leaseExpiredMinutesAgo),
    ).toBe(true);

    // Stderr diagnostic line
    const all = stderrWrites.join("");
    expect(all).toContain("[T-250] auto-superseded finished-orphan session");
    expect(all).toContain(fix.sessionId);
    expect(all).toContain("targets=ISS-101");
  });

  // 2. Mixed targets via stale-loop branch.
  it("autoSupersedesFinishedOrphan_mixedTargets_staleLoopCase", async () => {
    const fix = track(buildFixture({
      targetWork: ["T-500", "ISS-500"],
      leaseMinutesAgo: 90,
      compactPending: false,
      onDisk: [
        { id: "T-500", kind: "ticket", status: "complete" },
        { id: "ISS-500", kind: "issue", status: "resolved" },
      ],
      commits: [
        { id: "T-500", kind: "ticket", reachable: true },
        { id: "ISS-500", kind: "issue", reachable: true },
      ],
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBeFalsy();

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("superseded");
    expect(orphanState!.terminationReason).toBe("auto_superseded_finished_orphan");
  });

  // 3. Regression: second pass of stale loop must not clobber the rich reason.
  it("doesNotClobberTerminationReason", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-600"],
      leaseMinutesAgo: 75,
      compactPending: false,
      onDisk: [{ id: "ISS-600", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-600", kind: "issue", reachable: true }],
    }));

    await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.terminationReason).toBe("auto_superseded_finished_orphan");
  });

  // 4. Negative: issue still open → compact branch keeps blocking.
  it("preservesUnfinishedSession_workNotDone_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-400"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-400", kind: "issue", status: "open" }],
      commits: [], // nothing committed
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
    expect(orphanState!.terminationReason).toBeNull();
  });

  // 5. Negative: ticket commit on side branch is not reachable.
  it("preservesSessionWithMissingCommit_ticket_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["T-700"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "T-700", kind: "ticket", status: "complete" }],
      commits: [{ id: "T-700", kind: "ticket", reachable: false }],
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
  });

  // 6. Regression: events.log fallback must NOT apply for tickets.
  it("preservesTicketSessionWithoutCompletedTicketsEntry_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["T-800"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "T-800", kind: "ticket", status: "complete" }],
      commits: [{ id: "T-800", kind: "ticket", reachable: true }],
      skipCompletedTicketsEntry: true,
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
  });

  // 7. Regression: issue must have a matching commit event.
  it("preservesSessionWithNoEventForIssueTarget_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-900"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-900", kind: "issue", status: "resolved" }],
      commits: [], // no commit event emitted
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
  });

  // 8. 60-minute lease buffer enforced.
  it("respectsLeaseBuffer_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1000"],
      leaseMinutesAgo: 30,
      compactPending: true,
      onDisk: [{ id: "ISS-1000", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-1000", kind: "issue", reachable: true }],
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
  });

  // 9. Invalid lease string fails closed.
  it("failsClosedOnInvalidLeaseTimestamp_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1100"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-1100", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-1100", kind: "issue", reachable: true }],
      invalidLeaseString: "not a date",
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
  });

  // 10. Untargeted sessions are out of scope.
  it("untargetedSessionNotEligible_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: [],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [],
      commits: [],
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
  });

  // 11. Structured event + stderr line appear on the happy path.
  it("supersedeWritesStderrAndEvent", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1200", "T-1200"],
      leaseMinutesAgo: 90,
      compactPending: true,
      onDisk: [
        { id: "ISS-1200", kind: "issue", status: "resolved" },
        { id: "T-1200", kind: "ticket", status: "complete" },
      ],
      commits: [
        { id: "ISS-1200", kind: "issue", reachable: true },
        { id: "T-1200", kind: "ticket", reachable: true },
      ],
    }));

    await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });

    const all = stderrWrites.join("");
    expect(all).toContain("[T-250] auto-superseded finished-orphan session");
    expect(all).toContain(fix.sessionId);
    expect(all).toContain("targets=ISS-1200,T-1200");
    expect(all).toMatch(/leaseExpiredMinutesAgo=\d+/);

    const { events } = readEvents(fix.sessionDir);
    const audit = events.find((e) => e.type === "auto_superseded");
    expect(audit).toBeDefined();
    const data = audit!.data as { reason: string; targetWork: string[]; leaseExpiredMinutesAgo: number };
    expect(data.reason).toBe("finished_orphan");
    expect(data.targetWork).toEqual(["ISS-1200", "T-1200"]);
    // ISS-389: Number.isFinite over typeof to actually reject NaN/Infinity.
    expect(Number.isFinite(data.leaseExpiredMinutesAgo)).toBe(true);
  });

  // 12. Schema round-trip: readSession parses the new enum cleanly.
  it("readSessionRoundTripsSupersededState", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1300"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-1300", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-1300", kind: "issue", reachable: true }],
    }));

    await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });

    // First round-trip via readSession directly (Zod parse).
    const parsed = readSession(fix.sessionDir);
    expect(parsed).not.toBeNull();
    expect(parsed!.terminationReason).toBe("auto_superseded_finished_orphan");

    // Second round-trip via raw JSON — schema must be expressible in JSON.
    const raw = JSON.parse(readFileSync(join(fix.sessionDir, "state.json"), "utf-8"));
    expect(raw.terminationReason).toBe("auto_superseded_finished_orphan");
    expect(raw.status).toBe("superseded");
  });

  // 13. Stale-loop branch: failing orphan check still triggers generic supersede.
  it("staleBranchFailingCheckStillGenericSupersedes", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1400"],
      leaseMinutesAgo: 90,
      compactPending: false,
      onDisk: [{ id: "ISS-1400", kind: "issue", status: "open" }],
      commits: [],
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });

    // Generic stale loop still allows the new session to start.
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("PICK_TICKET");

    // Orphan is superseded but with the GENERIC reason (null), not the rich one.
    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("superseded");
    expect(orphanState!.terminationReason).toBeNull();
  });

  // 14. Stale-loop branch: orphan pass wins over the generic pass.
  it("staleBranchFinishedOrphanUpgradesReason", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1500"],
      leaseMinutesAgo: 90,
      compactPending: false,
      onDisk: [{ id: "ISS-1500", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-1500", kind: "issue", reachable: true }],
    }));

    await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("superseded");
    expect(orphanState!.terminationReason).toBe("auto_superseded_finished_orphan");
  });

  // 15. Non-auto modes (review/plan/guided) must never be silently superseded.
  it("nonAutoModeNotEligible_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1600"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-1600", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-1600", kind: "issue", reachable: true }],
      mode: "guided",
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
    expect(orphanState!.terminationReason).toBeNull();
  });

  // 16. Garbage line in events.log → malformedCount > 0 → fail closed.
  it("failsClosedOnMalformedEventsLog_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1700"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-1700", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-1700", kind: "issue", reachable: true }],
      corruptEventsLog: "garbage_line",
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
    expect(orphanState!.terminationReason).toBeNull();
  });

  // 17. Commit event with non-string commitHash → fail closed.
  it("failsClosedOnInvalidCommitShape_compactBranch", async () => {
    const fix = track(buildFixture({
      targetWork: ["ISS-1800"],
      leaseMinutesAgo: 120,
      compactPending: true,
      onDisk: [{ id: "ISS-1800", kind: "issue", status: "resolved" }],
      commits: [{ id: "ISS-1800", kind: "issue", reachable: true }],
      corruptEventsLog: "invalid_commit_shape",
    }));

    const result = await handleAutonomousGuide(fix.root, { action: "start", sessionId: null });
    expect(result.isError).toBe(true);

    const orphanState = readSession(fix.sessionDir);
    expect(orphanState).not.toBeNull();
    expect(orphanState!.status).toBe("active");
    expect(orphanState!.terminationReason).toBeNull();
  });
});
