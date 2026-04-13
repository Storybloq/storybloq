/**
 * T-251: `claudestory session` CLI — list, show, repair, delete.
 *
 * Exercises the four new CLI handlers against real on-disk .story/ trees.
 * Real git only in tests that need finished-orphan classification.
 *
 * These tests MUST fail before session.ts ships.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  handleSessionList,
  handleSessionShow,
  handleSessionRepair,
  handleSessionDelete,
} from "../../../src/cli/commands/session.js";
import {
  appendEvent,
  readSession,
  writeSessionSync,
} from "../../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../../src/autonomous/session-types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function setupRoot(opts: { initGit?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "t251-cli-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  mkdirSync(join(root, ".story", "tickets"), { recursive: true });
  mkdirSync(join(root, ".story", "issues"), { recursive: true });
  mkdirSync(join(root, ".story", "notes"), { recursive: true });
  mkdirSync(join(root, ".story", "lessons"), { recursive: true });
  mkdirSync(join(root, ".story", "handovers"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "t251-cli-fixture",
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
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "t251",
    date: "2026-04-10",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  if (opts.initGit) {
    gitInit(root);
  }
  createdRoots.push(root);
  return root;
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitInit(root: string): string {
  run("git init -q -b main", root);
  run("git config user.email test@test.com", root);
  run("git config user.name Test", root);
  writeFileSync(join(root, "README.md"), "# fixture\n");
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
    resolution: status === "resolved" ? "fixed" : null,
    location: [],
    discoveredDate: "2026-04-10",
    resolvedDate: status === "resolved" ? "2026-04-10" : null,
    relatedTickets: [],
    order: 10,
    phase: "p1",
  }));
}

interface PlantOpts {
  sessionId: string;
  status?: "active" | "completed" | "superseded";
  state?: string;
  leaseMinutesAgo?: number; // positive = expired, negative = fresh
  mode?: "auto" | "review" | "plan" | "guided";
  targetWork?: string[];
  compactPending?: boolean;
  workspaceId?: string;
  completedTickets?: FullSessionState["completedTickets"];
}

function plantSession(root: string, opts: PlantOpts): string {
  const dir = join(root, ".story", "sessions", opts.sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const leaseMs = (opts.leaseMinutesAgo ?? -30) * 60 * 1000;
  const expiresAt = new Date(Date.now() - leaseMs).toISOString();
  const state: FullSessionState = {
    schemaVersion: 1,
    sessionId: opts.sessionId,
    recipe: "coding",
    state: (opts.state ?? "IMPLEMENT") as FullSessionState["state"],
    revision: 3,
    status: opts.status ?? "active",
    mode: opts.mode ?? "auto",
    reviews: { plan: [], code: [] },
    completedTickets: opts.completedTickets ?? [],
    finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: {
      workspaceId: opts.workspaceId ?? deriveWorkspaceId(root),
      lastHeartbeat: now,
      expiresAt,
    },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: opts.compactPending ?? false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    targetWork: opts.targetWork,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
  } as FullSessionState;
  writeSessionSync(dir, state);
  return dir;
}

/**
 * Plant a finished-orphan fixture: resolved issue + reachable commit recorded
 * in events.log, expired lease, mode=auto, matching targetWork.
 */
function plantFinishedOrphan(root: string, sessionId: string): { dir: string; commitHash: string; issueId: string } {
  const issueId = "ISS-999";
  writeIssue(root, issueId, "resolved");
  const commitHash = commitOnMain(root, "fix_iss_999");
  const dir = plantSession(root, {
    sessionId,
    leaseMinutesAgo: 180, // 3 hours ago — past the 60-minute orphan buffer
    mode: "auto",
    targetWork: [issueId],
  });
  appendEvent(dir, {
    rev: 1,
    type: "commit",
    timestamp: new Date().toISOString(),
    data: { commitHash, issueId },
  });
  return { dir, commitHash, issueId };
}

/**
 * Create a non-TTY ReadableStream emitting the given input, plus a writable sink.
 * Used for interactive-confirmation tests.
 */
function makeTtyStdin(input: string): NodeJS.ReadableStream {
  const s = new PassThrough();
  (s as unknown as { isTTY: boolean }).isTTY = true;
  s.end(input);
  return s;
}

function makeNonTtyStdin(input: string = ""): NodeJS.ReadableStream {
  const s = new PassThrough();
  (s as unknown as { isTTY: boolean }).isTTY = false;
  s.end(input);
  return s;
}

function makeStdoutSink(): NodeJS.WritableStream & { captured: string[] } {
  const sink = new PassThrough();
  const captured: string[] = [];
  sink.on("data", (chunk) => captured.push(chunk.toString()));
  Object.assign(sink, { captured });
  return sink as NodeJS.WritableStream & { captured: string[] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-251 session list", () => {
  // Test 1
  it("listShowsAllSessions: prints full UUIDs for every session across statuses", async () => {
    const root = setupRoot();
    const ids = [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
    ];
    plantSession(root, { sessionId: ids[0], status: "active", leaseMinutesAgo: -30 });
    plantSession(root, { sessionId: ids[1], status: "active", leaseMinutesAgo: 120 });
    plantSession(root, { sessionId: ids[2], status: "completed" });
    plantSession(root, { sessionId: ids[3], status: "superseded" });

    const out = await handleSessionList(root, { status: "all", format: "text" });

    for (const id of ids) {
      expect(out).toContain(id);
    }
  });

  // Test 2
  it("listFiltersByStatusActive: only active sessions appear", async () => {
    const root = setupRoot();
    const active1 = "aaaa1111-0000-0000-0000-000000000001";
    const active2 = "aaaa2222-0000-0000-0000-000000000001";
    const completed = "cccc3333-0000-0000-0000-000000000001";
    const superseded = "ssss4444-0000-0000-0000-000000000001";
    plantSession(root, { sessionId: active1, status: "active", leaseMinutesAgo: -30 });
    plantSession(root, { sessionId: active2, status: "active", leaseMinutesAgo: 120 });
    plantSession(root, { sessionId: completed, status: "completed" });
    plantSession(root, { sessionId: superseded, status: "superseded" });

    const out = await handleSessionList(root, { status: "active", format: "text" });

    expect(out).toContain(active1);
    expect(out).toContain(active2);
    expect(out).not.toContain(completed);
    expect(out).not.toContain(superseded);
  });

  // Test 3
  it("listJsonFormatMatchesContract: json output has sessions array with expected fields", async () => {
    const root = setupRoot();
    const id = "55555555-5555-5555-5555-555555555555";
    plantSession(root, { sessionId: id, status: "active", leaseMinutesAgo: -30 });

    const out = await handleSessionList(root, { status: "all", format: "json" });
    const parsed = JSON.parse(out);

    expect(parsed).toHaveProperty("sessions");
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.length).toBeGreaterThanOrEqual(1);
    const first = parsed.sessions.find((s: { sessionId: string }) => s.sessionId === id);
    expect(first).toBeTruthy();
    expect(first).toHaveProperty("sessionId", id);
    expect(first).toHaveProperty("status");
    expect(first).toHaveProperty("state");
    expect(first).toHaveProperty("leaseExpiresAt");
    expect(first).toHaveProperty("mode");
  });

  // Test 4 — bulk discovery containment
  it("listIgnoresSymlinkEscape: UUID-named symlink outside sessionsRoot is not surfaced by list", async () => {
    const root = setupRoot();
    const real = "66666666-6666-6666-6666-666666666666";
    const symlinked = "77777777-7777-7777-7777-777777777777";
    plantSession(root, { sessionId: real, status: "active", leaseMinutesAgo: -30 });

    // Plant outside directory containing a plausible state.json for symlinked UUID.
    const outside = join(root, "outside-target");
    mkdirSync(outside, { recursive: true });
    const plantedDir = plantSession(root, { sessionId: "temp-for-copy", status: "active", leaseMinutesAgo: -30 });
    const copiedState = readFileSync(join(plantedDir, "state.json"), "utf-8")
      .replace(/temp-for-copy/g, symlinked);
    writeFileSync(join(outside, "state.json"), copiedState);
    rmSync(plantedDir, { recursive: true, force: true });
    const targetBefore = readFileSync(join(outside, "state.json"), "utf-8");

    symlinkSync(outside, join(root, ".story", "sessions", symlinked), "dir");

    const out = await handleSessionList(root, { status: "all", format: "json" });
    const parsed = JSON.parse(out);
    const ids = parsed.sessions.map((s: { sessionId: string }) => s.sessionId);

    expect(ids).toContain(real);
    expect(ids).not.toContain(symlinked);

    // Target byte-unchanged.
    const targetAfter = readFileSync(join(outside, "state.json"), "utf-8");
    expect(targetAfter).toBe(targetBefore);
  });
});

describe("T-251 session show", () => {
  // Test 5
  it("showDisplaysStateFields: text output contains ID, state, ticket, events", async () => {
    const root = setupRoot();
    const id = "88888888-8888-8888-8888-888888888888";
    const dir = plantSession(root, {
      sessionId: id,
      status: "active",
      state: "IMPLEMENT",
      leaseMinutesAgo: -30,
    });
    appendEvent(dir, {
      rev: 1,
      type: "ticket_picked",
      timestamp: new Date().toISOString(),
      data: { ticketId: "T-100" },
    });

    const out = await handleSessionShow(root, id, { format: "text", events: 10 });

    expect(out).toContain(id);
    expect(out).toContain("IMPLEMENT");
    expect(out).toContain("ticket_picked");
  });

  // Test 6
  it("showErrorsOnUnknownSession: random UUID throws 'not found'", async () => {
    const root = setupRoot();
    const bogus = "99999999-9999-9999-9999-999999999999";
    await expect(handleSessionShow(root, bogus, { format: "text", events: 10 }))
      .rejects.toThrow(/not found/i);
  });

  // Test 7
  it("showErrorsOnCorruptSession: garbage state.json throws with corruption hint", async () => {
    const root = setupRoot();
    const id = "aaaa0000-0000-0000-0000-000000000001";
    const dir = join(root, ".story", "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{ this is not valid json");

    await expect(handleSessionShow(root, id, { format: "text", events: 10 }))
      .rejects.toThrow(/corrupt|unreadable|session delete/i);
  });
});

describe("T-251 session repair", () => {
  // Test 8
  it("repairDryRunDoesNotMutate: finished-orphan fixture preserved under dry-run", async () => {
    const root = setupRoot({ initGit: true });
    const id = "cccc0001-0000-0000-0000-000000000001";
    const { dir } = plantFinishedOrphan(root, id);
    const stateBefore = readFileSync(join(dir, "state.json"), "utf-8");

    await handleSessionRepair(root, { dryRun: true, all: false, yes: true });

    const stateAfter = readFileSync(join(dir, "state.json"), "utf-8");
    expect(stateAfter).toBe(stateBefore);
    const parsed = readSession(dir)!;
    expect(parsed.status).toBe("active");
  });

  // Test 9
  it("repairSupersedesFinishedOrphan: marks superseded with auto_superseded_finished_orphan", async () => {
    const root = setupRoot({ initGit: true });
    const id = "cccc0002-0000-0000-0000-000000000001";
    const { dir } = plantFinishedOrphan(root, id);

    await handleSessionRepair(root, { dryRun: false, all: false, yes: true });

    const after = readSession(dir)!;
    expect(after.status).toBe("superseded");
    expect(after.terminationReason).toBe("auto_superseded_finished_orphan");

    const events = readFileSync(join(dir, "events.log"), "utf-8");
    expect(events).toContain("manual_repair");
    expect(events).toContain("finished_orphan");
  });

  // Test 10
  it("repairLeavesStaleOtherAloneWithoutAllFlag: non-orphan stale session needs --all", async () => {
    const root = setupRoot();
    const id = "cccc0003-0000-0000-0000-000000000001";
    writeTicket(root, "T-500", "open"); // not complete → not an orphan
    const dir = plantSession(root, {
      sessionId: id,
      status: "active",
      leaseMinutesAgo: 120,
      mode: "auto",
      targetWork: ["T-500"],
    });
    const revBefore = readSession(dir)!.revision;

    // Without --all: no mutation.
    await handleSessionRepair(root, { dryRun: false, all: false, yes: true });
    const afterNoAll = readSession(dir)!;
    expect(afterNoAll.status).toBe("active");
    expect(afterNoAll.revision).toBe(revBefore);

    // With --all: superseded with admin_recovery.
    await handleSessionRepair(root, { dryRun: false, all: true, yes: true });
    const afterAll = readSession(dir)!;
    expect(afterAll.status).toBe("superseded");
    expect(afterAll.terminationReason).toBe("admin_recovery");
  });

  // Test 11
  it("repairRefusesLiveSessionWithoutPositional: fresh active session untouched", async () => {
    const root = setupRoot();
    const id = "cccc0004-0000-0000-0000-000000000001";
    const dir = plantSession(root, {
      sessionId: id,
      status: "active",
      leaseMinutesAgo: -30, // fresh — lease not expired
    });
    const stateBefore = readFileSync(join(dir, "state.json"), "utf-8");

    await handleSessionRepair(root, { dryRun: false, all: true, yes: true });

    const stateAfter = readFileSync(join(dir, "state.json"), "utf-8");
    expect(stateAfter).toBe(stateBefore);
  });

  // Test 12
  it("repairSkipsOnRevisionDrift: external revision bump after scan aborts that entry", async () => {
    const root = setupRoot({ initGit: true });
    const id = "cccc0005-0000-0000-0000-000000000001";
    const { dir } = plantFinishedOrphan(root, id);

    // Simulate revision drift: before calling repair, bump the revision out of band
    // such that the under-lock re-read sees a newer revision than any pre-scan value.
    // We use the handler's own captured revision comparison path. To test: mutate the
    // state.json so revision > what repair will re-read. Simplest: call repair with
    // a pre-capture by running it once in dry-run to surface the candidate, then
    // writeSessionSync with an untouched no-op that still bumps revision.
    await handleSessionRepair(root, { dryRun: true, all: false, yes: true });
    const current = readSession(dir)!;
    // No-op write to bump revision.
    writeSessionSync(dir, { ...current });

    // Now the under-lock revision mismatch path should fire — but because candidate
    // collection re-reads outside the lock, the new write is seen before mutation.
    // The handler must detect that the current revision doesn't match the previously
    // scanned revision and skip. We assert by comparing state remains active OR by
    // checking the returned summary; easiest: re-capture revision, then call again,
    // and assert that status transitions still happen on fresh re-scan (to prove
    // the drift check doesn't brick repair). Use an injection via an exported
    // testing hook `__t251RepairInject` that forces a stale scannedRevision.
    const { __t251RepairInject } = await import("../../../src/cli/commands/session.js");
    const staleRevision = current.revision - 1;
    __t251RepairInject({ scannedRevisionFor: { [id]: staleRevision } });
    try {
      await handleSessionRepair(root, { dryRun: false, all: false, yes: true });
      const afterDrift = readSession(dir)!;
      expect(afterDrift.status).toBe("active");
    } finally {
      __t251RepairInject({ scannedRevisionFor: null });
    }
  });

  // Test 13
  it("repairNonTTYRefusesWithoutYes: fail closed when stdin is not a TTY", async () => {
    const root = setupRoot({ initGit: true });
    const id = "cccc0006-0000-0000-0000-000000000001";
    plantFinishedOrphan(root, id);

    const stdin = makeNonTtyStdin();
    const stdout = makeStdoutSink();

    await expect(handleSessionRepair(root, {
      dryRun: false,
      all: false,
      yes: false,
      stdin,
      stdout,
    })).rejects.toThrow(/requires --yes/i);
  });

  // Test 14
  it("repairPositionalStaleOtherRequiresAll: positional does not bypass bucket gate", async () => {
    const root = setupRoot();
    const id = "cccc0007-0000-0000-0000-000000000001";
    writeTicket(root, "T-501", "open");
    const dir = plantSession(root, {
      sessionId: id,
      status: "active",
      leaseMinutesAgo: 120,
      mode: "auto",
      targetWork: ["T-501"],
    });
    const revBefore = readSession(dir)!.revision;

    // Positional, without --all: must NOT supersede.
    const out1 = await handleSessionRepair(root, {
      selector: id,
      dryRun: false,
      all: false,
      yes: true,
    });
    const after1 = readSession(dir)!;
    expect(after1.status).toBe("active");
    expect(after1.revision).toBe(revBefore);
    expect(out1.toLowerCase()).toContain("requires_--all");

    // Positional + --all: supersedes.
    await handleSessionRepair(root, {
      selector: id,
      dryRun: false,
      all: true,
      yes: true,
    });
    const after2 = readSession(dir)!;
    expect(after2.status).toBe("superseded");
    expect(after2.terminationReason).toBe("admin_recovery");
  });

  // Test 15 — bulk discovery containment
  it("repairAllSkipsSymlinkEscape: repair --all drops symlink-escape candidates before write", async () => {
    const root = setupRoot();
    writeTicket(root, "T-502", "open");
    const legitId = "cccc0008-0000-0000-0000-000000000001";
    const legitDir = plantSession(root, {
      sessionId: legitId,
      status: "active",
      leaseMinutesAgo: 120,
      mode: "auto",
      targetWork: ["T-502"],
    });

    // Plant an outside session directory with a plausible state.
    const outside = join(root, "outside-target");
    mkdirSync(outside, { recursive: true });
    const linkedId = "dddd0001-0000-0000-0000-000000000001";
    const legitState = readFileSync(join(legitDir, "state.json"), "utf-8")
      .replace(/cccc0008-0000-0000-0000-000000000001/g, linkedId);
    writeFileSync(join(outside, "state.json"), legitState);
    writeFileSync(join(outside, "events.log"), "");
    const outsideStateBefore = readFileSync(join(outside, "state.json"), "utf-8");
    const outsideEventsBefore = readFileSync(join(outside, "events.log"), "utf-8");

    symlinkSync(outside, join(root, ".story", "sessions", linkedId), "dir");

    const out = await handleSessionRepair(root, { dryRun: false, all: true, yes: true });

    // Legit session superseded.
    const afterLegit = readSession(legitDir)!;
    expect(afterLegit.status).toBe("superseded");
    expect(afterLegit.terminationReason).toBe("admin_recovery");

    // Summary does not mention symlinked UUID.
    expect(out).not.toContain(linkedId);

    // Outside target byte-for-byte unchanged.
    const outsideStateAfter = readFileSync(join(outside, "state.json"), "utf-8");
    const outsideEventsAfter = readFileSync(join(outside, "events.log"), "utf-8");
    expect(outsideStateAfter).toBe(outsideStateBefore);
    expect(outsideEventsAfter).toBe(outsideEventsBefore);
  });
});

describe("T-251 session repair (interactive confirmation)", () => {
  // Test 16
  it("repairInteractiveConfirmAccepts: TTY stdin 'y\\n' triggers supersede", async () => {
    const root = setupRoot({ initGit: true });
    const id = "cccc0009-0000-0000-0000-000000000001";
    const { dir } = plantFinishedOrphan(root, id);

    const stdin = makeTtyStdin("y\n");
    const stdout = makeStdoutSink();

    await handleSessionRepair(root, {
      dryRun: false,
      all: false,
      yes: false,
      stdin,
      stdout,
    });

    const after = readSession(dir)!;
    expect(after.status).toBe("superseded");
  });

  // Test 17
  it("repairInteractiveConfirmDeclines: TTY stdin 'n\\n' aborts", async () => {
    const root = setupRoot({ initGit: true });
    const id = "cccc000a-0000-0000-0000-000000000001";
    const { dir } = plantFinishedOrphan(root, id);
    const stateBefore = readFileSync(join(dir, "state.json"), "utf-8");

    const stdin = makeTtyStdin("n\n");
    const stdout = makeStdoutSink();

    const out = await handleSessionRepair(root, {
      dryRun: false,
      all: false,
      yes: false,
      stdin,
      stdout,
    });

    expect(out.toLowerCase()).toContain("aborted");
    const stateAfter = readFileSync(join(dir, "state.json"), "utf-8");
    expect(stateAfter).toBe(stateBefore);
  });
});

describe("T-251 session delete", () => {
  // Test 18
  it("deleteRemovesDirectory: stale session, yes=true, directory gone", async () => {
    const root = setupRoot();
    const id = "eeee0001-0000-0000-0000-000000000001";
    const dir = plantSession(root, {
      sessionId: id,
      status: "active",
      leaseMinutesAgo: 120, // expired → allowed to delete
    });
    expect(existsSync(dir)).toBe(true);

    await handleSessionDelete(root, id, { yes: true });

    expect(existsSync(dir)).toBe(false);
  });

  // Test 19
  it("deleteRequiresExplicitYes: throws without yes, directory intact", async () => {
    const root = setupRoot();
    const id = "eeee0002-0000-0000-0000-000000000001";
    const dir = plantSession(root, {
      sessionId: id,
      status: "active",
      leaseMinutesAgo: 120,
    });

    await expect(handleSessionDelete(root, id, { yes: false }))
      .rejects.toThrow(/--yes/);

    expect(existsSync(dir)).toBe(true);
  });

  // Test 20
  it("deleteRefusesActiveFreshSession: live non-expired session throws even with --yes", async () => {
    const root = setupRoot();
    const id = "eeee0003-0000-0000-0000-000000000001";
    const dir = plantSession(root, {
      sessionId: id,
      status: "active",
      leaseMinutesAgo: -30, // fresh
    });

    await expect(handleSessionDelete(root, id, { yes: true }))
      .rejects.toThrow(/active|session stop/i);

    expect(existsSync(dir)).toBe(true);
  });

  // Test 21
  it("deleteRejectsPathTraversalSelector: '../../evil' throws invalid; sibling untouched", async () => {
    const root = setupRoot();
    // Plant a sibling directory that would be the escape target.
    const sibling = join(root, "sibling-dir");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "canary.txt"), "DO NOT DELETE");
    const canaryBefore = readFileSync(join(sibling, "canary.txt"), "utf-8");

    await expect(handleSessionDelete(root, "../../sibling-dir", { yes: true }))
      .rejects.toThrow(/invalid|not found/i);

    expect(existsSync(sibling)).toBe(true);
    const canaryAfter = readFileSync(join(sibling, "canary.txt"), "utf-8");
    expect(canaryAfter).toBe(canaryBefore);
  });

  // Test 22
  it("deleteAllowsCorruptSession: garbage state.json still removes directory cleanly", async () => {
    const root = setupRoot();
    const id = "eeee0005-0000-0000-0000-000000000001";
    const dir = join(root, ".story", "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "this is not valid json\x00\xff");
    expect(existsSync(dir)).toBe(true);

    // Should not throw from parse attempts.
    await handleSessionDelete(root, id, { yes: true });
    expect(existsSync(dir)).toBe(false);
  });
});
