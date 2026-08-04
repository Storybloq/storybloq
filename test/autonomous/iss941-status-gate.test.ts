/**
 * ISS-941 half 1: a session whose ON-DISK status has moved off "active" --
 * superseded by another session's start-path reclaim, or completed -- must
 * never be advanced by report, resume, or pre_compact. Before this fix,
 * handleReport/handleResume/handlePreCompact read the session once and never
 * re-checked `status`, so a session already marked superseded (or a corrupted
 * record whose current truth cannot even be read) still refreshed its lease
 * and advanced the pipeline. All tests in this file MUST fail against the
 * parent commit: the guard they exercise does not exist yet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The gate's own re-read (readSessionResilient) is the ONLY caller of that
// function in the report/resume/pre_compact path -- the initial lookup uses a
// separate reader (readSessionDetailed, via findSessionByIdDetailed). Mocking
// it null for a targeted directory therefore simulates "the gate's own
// observation could not read the current record" without disturbing the
// initial lookup that already succeeded moments earlier in the same call.
const rereadOverride: { failForDir: string | null } = { failForDir: null };

vi.mock("../../src/autonomous/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/session.js")>();
  return {
    ...actual,
    readSessionResilient: (dir: string) => {
      if (rereadOverride.failForDir && dir === rereadOverride.failForDir) return null;
      return actual.readSessionResilient(dir);
    },
  };
});

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import {
  createSession,
  readSession,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function setupProjectTree(root: string): void {
  const story = join(root, ".story");
  mkdirSync(story, { recursive: true });
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "iss941-status-gate-fixture",
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
    title: "iss941",
    date: "2026-08-04",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test phase" }],
    blockers: [],
  }));
  run("git init -q -b main", root);
  run("git config user.email test@test.com", root);
  run("git config user.name Test", root);
  writeFileSync(join(root, "README.md"), "# fixture\n");
  run("git add .", root);
  run("git commit -q -m initial", root);
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
    createdDate: "2026-08-04",
    completedDate: status === "complete" ? "2026-08-04" : null,
    blockedBy: [],
    parentTicket: null,
  }));
}

interface BuildOpts {
  state: string;
  status: "active" | "completed" | "superseded";
  terminationReason?: string | null;
  compactPending?: boolean;
  preCompactState?: string | null;
  targetWork?: string[];
}

interface Built {
  root: string;
  sessionDir: string;
  sessionId: string;
  before: FullSessionState;
}

const createdRoots: string[] = [];

function build(opts: BuildOpts): Built {
  const root = mkdtempSync(join(tmpdir(), "iss941-status-gate-"));
  createdRoots.push(root);
  setupProjectTree(root);

  const workspaceId = deriveWorkspaceId(root);
  const session = createSession(root, "coding", workspaceId);
  const sessDir = join(root, ".story", "sessions", session.sessionId);

  const written = writeSessionSync(sessDir, {
    ...session,
    state: opts.state as FullSessionState["state"],
    status: opts.status,
    terminationReason: (opts.terminationReason ?? null) as FullSessionState["terminationReason"],
    compactPending: opts.compactPending ?? false,
    preCompactState: (opts.preCompactState ?? null) as FullSessionState["preCompactState"],
    targetWork: opts.targetWork ?? [],
    ownerTask: null,
    claudeCodeSessionId: null,
    lease: {
      ...session.lease,
      // Live lease -- isolates the status gate from expiry/adoption behavior.
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
  });

  return { root, sessionDir: sessDir, sessionId: session.sessionId, before: written };
}

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    killSidecarsInRoot(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertRefusedUnchanged(built: Built, result: Awaited<ReturnType<typeof handleAutonomousGuide>>): void {
  expect(result.isError).toBe(true);
  const after = readSession(built.sessionDir);
  expect(after).not.toBeNull();
  // Zero lease refresh, zero recovery, zero claim, zero pipeline advance: the
  // record on disk must be byte-identical to what the fixture wrote.
  expect(after!.revision).toBe(built.before.revision);
  expect(after!.lease.expiresAt).toBe(built.before.lease.expiresAt);
  expect(after!.guideCallCount).toBe(built.before.guideCallCount);
  expect(after!.state).toBe(built.before.state);
}

describe("ISS-941 half 1: status gate refuses non-active sessions", () => {
  it("refuses report against a superseded session in FINALIZE", async () => {
    const built = build({ state: "FINALIZE", status: "superseded" });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "report",
      report: { completedAction: "commit_done" },
    });
    assertRefusedUnchanged(built, result);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/superseded/i);
  });

  it("refuses report against a superseded session in ISSUE_FIX", async () => {
    const built = build({ state: "ISSUE_FIX", status: "superseded" });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "report",
      report: { completedAction: "issue_fixed" },
    });
    assertRefusedUnchanged(built, result);
  });

  it("refuses report against a superseded session in PICK_TICKET", async () => {
    const built = build({ state: "PICK_TICKET", status: "superseded" });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "report",
      report: { completedAction: "ticket_picked", ticketId: "T-001" },
    });
    assertRefusedUnchanged(built, result);
  });

  it("names the auto-superseded-finished-orphan cause distinctly from a generic supersede", async () => {
    const built = build({
      state: "PICK_TICKET",
      status: "superseded",
      terminationReason: "auto_superseded_finished_orphan",
    });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "report",
      report: { completedAction: "ticket_picked", ticketId: "T-001" },
    });
    assertRefusedUnchanged(built, result);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/verified complete/i);
  });

  it("refuses resume against a session superseded while still COMPACT (T-250 gap)", async () => {
    // trySupersedeFinishedOrphan can mark a COMPACT session's status
    // "superseded" while leaving state.state === "COMPACT" untouched -- the
    // ordinary `state !== "COMPACT"` gate alone does not catch this.
    const built = build({
      state: "COMPACT",
      status: "superseded",
      terminationReason: "auto_superseded_finished_orphan",
      compactPending: true,
      preCompactState: "IMPLEMENT",
    });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "resume",
    });
    assertRefusedUnchanged(built, result);
  });

  it("refuses pre_compact against a superseded session, wording never claims 'report'", async () => {
    const built = build({ state: "IMPLEMENT", status: "superseded" });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "pre_compact",
    });
    assertRefusedUnchanged(built, result);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toMatch(/report was not applied/i);
  });

  it("refuses resume wording never claims 'report' either", async () => {
    const built = build({
      state: "COMPACT",
      status: "superseded",
      terminationReason: "auto_superseded_finished_orphan",
      compactPending: true,
      preCompactState: "IMPLEMENT",
    });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "resume",
    });
    assertRefusedUnchanged(built, result);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toMatch(/report was not applied/i);
  });

  it("refuses a completed session with its own wording, not 'superseded'", async () => {
    // status:"completed" paired with an ordinary in-flight state -- the field
    // being tested is `status`, independent of what `state` co-occurs with it.
    const built = build({ state: "IMPLEMENT", status: "completed" });
    const result = await handleAutonomousGuide(built.root, {
      sessionId: built.sessionId,
      action: "report",
      report: { completedAction: "noop" },
    });
    assertRefusedUnchanged(built, result);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/already ended/i);
    // Must not claim it WAS superseded (the wording may correctly say it was
    // NOT superseded by anything, which is the point of this test).
    expect(text).not.toMatch(/this session was superseded/i);
  });

  it("refuses when the gate's own re-read cannot observe the session, rather than trusting the earlier lookup (fail-closed, not fail-open)", async () => {
    const built = build({ state: "PICK_TICKET", status: "active" });
    rereadOverride.failForDir = built.sessionDir;
    try {
      const result = await handleAutonomousGuide(built.root, {
        sessionId: built.sessionId,
        action: "report",
        report: { completedAction: "ticket_picked", ticketId: "T-001" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/could not be re-read|unreadable|missing/i);
      // No mutation despite the initial lookup having succeeded.
      const after = readSession(built.sessionDir);
      expect(after!.revision).toBe(built.before.revision);
    } finally {
      rereadOverride.failForDir = null;
    }
  });

  it("pre-PLAN-stamp same-ticket window: a zombie in PICK_TICKET is refused even though claim-preflight would not yet fence the same ticket", async () => {
    // S2 already exists, holds ticket T-001, but has not reached PLAN (no
    // claim stamped yet) -- claim-preflight's fence does not apply pre-stamp.
    // S1 (superseded) picking the same ticket must still be refused, by the
    // status gate alone, before claim-preflight is ever reached.
    const root = mkdtempSync(join(tmpdir(), "iss941-status-gate-preplan-"));
    createdRoots.push(root);
    setupProjectTree(root);
    writeTicket(root, "T-001", "open");

    const workspaceId = deriveWorkspaceId(root);

    // S2: live, holds T-001, has NOT reached PLAN.
    const s2 = createSession(root, "coding", workspaceId);
    const s2Dir = join(root, ".story", "sessions", s2.sessionId);
    const s2Before = writeSessionSync(s2Dir, {
      ...s2,
      state: "PICK_TICKET",
      status: "active",
      ticket: { id: "T-001", displayId: null, title: "Ticket T-001", risk: null, realizedRisk: null, claimed: false, lastPlanHash: null },
      ownerTask: null,
      lease: { ...s2.lease, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
    } as FullSessionState);

    // S1: superseded zombie, also about to (re)pick T-001.
    const s1 = createSession(root, "coding", workspaceId);
    const s1Dir = join(root, ".story", "sessions", s1.sessionId);
    const s1Before = writeSessionSync(s1Dir, {
      ...s1,
      state: "PICK_TICKET",
      status: "superseded",
      ownerTask: null,
      lease: { ...s1.lease, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
    } as FullSessionState);

    const result = await handleAutonomousGuide(root, {
      sessionId: s1.sessionId,
      action: "report",
      report: { completedAction: "ticket_picked", ticketId: "T-001" },
    });

    expect(result.isError).toBe(true);
    const after = readSession(s1Dir);
    expect(after!.revision).toBe(s1Before.revision);
    // S2 must be entirely untouched by S1's refused call.
    const s2After = readSession(s2Dir);
    expect(s2After!.ticket?.id).toBe("T-001");
    expect(s2After!.revision).toBe(s2Before.revision);
  });
});
