/**
 * ISS-654: end-to-end coverage of handleStart's targetWork canonicalization +
 * persistence path (guide.ts:686-746, 896-897). The constituent units
 * (resolveWorkId, event builders) are unit-tested, but the start-action glue
 * that validates raw targetWork input, maps display<->canonical, filters
 * already-done targets, and persists targetWork / targetWorkDisplayIds into
 * session state was never exercised end-to-end (all existing start tests pass
 * no targetWork).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { readSession } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const CANONICAL_ISSUE_ID = "i-0123456789abcdef";
const CANONICAL_ISSUE_DISPLAY = "ISS-077";

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function setupProject(root: string): void {
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "iss654-canonical-fixture",
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
    title: "iss654",
    date: "2026-06-02",
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
    createdDate: "2026-06-02",
    completedDate: status === "complete" ? "2026-06-02" : null,
    blockedBy: [],
    parentTicket: null,
  }));
}

function writeLegacyIssue(root: string, id: string, status: "open" | "inprogress" | "resolved"): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id,
    title: `Issue ${id}`,
    status,
    severity: "medium",
    components: [],
    impact: "test",
    resolution: status === "resolved" ? "fixed in fixture" : null,
    location: [],
    discoveredDate: "2026-06-02",
    resolvedDate: status === "resolved" ? "2026-06-02" : null,
    relatedTickets: [],
    order: 10,
    phase: "p1",
  }));
}

/** Canonical-id issue (file id = crockford, displayId = ISS-NNN) so the
 * display<->canonical mapping in handleStart is non-trivial. */
function writeCanonicalIssue(root: string, id: string, displayId: string, status: "open" | "resolved"): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id,
    displayId,
    title: `Canonical issue ${displayId}`,
    status,
    severity: "medium",
    components: [],
    impact: "test",
    resolution: status === "resolved" ? "fixed in fixture" : null,
    location: [],
    discoveredDate: "2026-06-02",
    createdAt: "2026-06-02T00:00:00.000Z",
    resolvedDate: status === "resolved" ? "2026-06-02" : null,
    relatedTickets: [],
    phase: null,
  }));
}

/** Build a clean fixture project: open ticket T-001, canonical open issue
 * (ISS-077), a resolved legacy issue ISS-200, and a complete ticket T-300. */
function buildProject(): string {
  const root = mkdtempSync(join(tmpdir(), "iss654-canonical-"));
  setupProject(root);
  writeTicket(root, "T-001", "open");
  writeTicket(root, "T-300", "complete");
  writeCanonicalIssue(root, CANONICAL_ISSUE_ID, CANONICAL_ISSUE_DISPLAY, "open");
  writeLegacyIssue(root, "ISS-200", "resolved");
  run("git init -q -b main", root);
  run("git config user.email test@test.com", root);
  run("git config user.name Test", root);
  run("git add .", root);
  run('git commit -q -m fixture', root);
  return root;
}

/** Collect every readable session under .story/sessions (filters out any
 * non-session subdirectory a sidecar might create, rather than asserting on a
 * raw directory count). */
function readableSessions(root: string): FullSessionState[] {
  const sessionsDir = join(root, ".story", "sessions");
  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readSession(join(sessionsDir, d.name)))
    .filter((s): s is FullSessionState => s !== null);
}

function startedSession(root: string): FullSessionState {
  const sessions = readableSessions(root);
  expect(sessions.length).toBe(1);
  return sessions[0]!;
}

function sessionCount(root: string): number {
  return readableSessions(root).length;
}

const createdRoots: string[] = [];
function track(root: string): string {
  createdRoots.push(root);
  return root;
}

beforeEach(() => {
  // no-op; placeholder for symmetry with sibling suites
});

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    killSidecarsInRoot(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("ISS-654: handleStart targetWork canonicalization (end-to-end)", () => {
  it("persists the resolved client task owner without removing Claude compatibility fields", async () => {
    const oldClient = process.env.STORYBLOQ_CLIENT;
    const oldClaudeTask = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.STORYBLOQ_CLIENT = "codex";
    process.env.CLAUDE_CODE_SESSION_ID = "poisoned-ambient-claude-task";
    try {
      const root = track(buildProject());
      const result = await handleAutonomousGuide(root, {
        action: "start",
        sessionId: null,
        mode: "auto",
        clientTaskId: "codex-task-123",
      });
      expect(result.isError).toBeFalsy();
      const session = startedSession(root);
      expect(session.ownerTask).toMatchObject({ client: "codex", id: "codex-task-123" });
      expect(typeof session.ownerTask?.boundAt).toBe("string");
      expect("claudeCodeSessionId" in session).toBe(true);
      expect(session.claudeCodeSessionId).toBeNull();
    } finally {
      if (oldClient === undefined) delete process.env.STORYBLOQ_CLIENT;
      else process.env.STORYBLOQ_CLIENT = oldClient;
      if (oldClaudeTask === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = oldClaudeTask;
    }
  });

  it("persists ticket reviewRisk for tiered plan mode", async () => {
    const root = track(buildProject());
    const ticketPath = join(root, ".story", "tickets", "T-001.json");
    const ticket = JSON.parse(readFileSync(ticketPath, "utf-8"));
    writeFileSync(ticketPath, JSON.stringify({ ...ticket, reviewRisk: "high" }));
    run("git add .", root);
    run('git commit -q -m "add review risk"', root);

    const result = await handleAutonomousGuide(root, {
      action: "start",
      sessionId: null,
      mode: "plan",
      ticketId: "T-001",
    });

    expect(result.isError).toBeFalsy();
    const session = startedSession(root);
    expect(session.state).toBe("PLAN");
    expect(session.ticket?.risk).toBe("high");
  });

  it("display-id input is persisted as canonical ids with a display map", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["T-001", CANONICAL_ISSUE_DISPLAY],
    });
    expect(result.isError).toBeFalsy();
    const session = startedSession(root);
    expect(session.targetWork).toEqual(["T-001", CANONICAL_ISSUE_ID]);
    // Only the canonical-id issue maps (its displayId differs); legacy T-001 does not.
    expect(session.targetWorkDisplayIds).toEqual({ [CANONICAL_ISSUE_ID]: CANONICAL_ISSUE_DISPLAY });
  });

  it("canonical-id input resolves to the same canonical targetWork + display map", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["T-001", CANONICAL_ISSUE_ID],
    });
    expect(result.isError).toBeFalsy();
    const session = startedSession(root);
    expect(session.targetWork).toEqual(["T-001", CANONICAL_ISSUE_ID]);
    expect(session.targetWorkDisplayIds).toEqual({ [CANONICAL_ISSUE_ID]: CANONICAL_ISSUE_DISPLAY });
  });

  it("rejects an invalid target id without creating a session", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto", targetWork: ["T-999"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Invalid target IDs");
    expect(sessionCount(root)).toBe(0);
  });

  it("filters already-done targets and keeps the actionable ones", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["ISS-200", "T-001"], // ISS-200 is resolved
    });
    expect(result.isError).toBeFalsy();
    const session = startedSession(root);
    expect(session.targetWork).toEqual(["T-001"]);
  });

  it("errors when every target is already complete/resolved", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
      targetWork: ["ISS-200", "T-300"], // resolved issue + complete ticket
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("already complete");
    expect(sessionCount(root)).toBe(0);
  });

  it("rejects targetWork combined with a non-auto mode", async () => {
    const root = track(buildProject());
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "review", ticketId: "T-001",
      targetWork: ["T-001"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Targeted mode requires auto mode");
  });
});

/**
 * T-461: the project-config INGESTION seam for the review-effort dial.
 *
 * resolveRecipe's own fail-closed behavior is unit-tested, but handleStart is
 * what reads `.story/config.json` and decides what reaches it. A type filter
 * there would silently drop a written null before the resolver could fail it
 * closed, so the unit tests would pass while the shipped path size-mapped a
 * chore down to light. These start a real session and read the frozen field.
 */
describe("T-461: handleStart ingests the project review-effort override", () => {
  function setReviewEffortOverride(root: string, value: unknown): void {
    const configPath = join(root, ".story", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.recipeOverrides = { ...config.recipeOverrides, reviewEffort: value };
    writeFileSync(configPath, JSON.stringify(config));
    run("git add .", root);
    run('git commit -q -m "set review effort override"', root);
  }

  async function startAndRead(root: string): Promise<FullSessionState> {
    const result = await handleAutonomousGuide(root, {
      action: "start", sessionId: null, mode: "auto",
    });
    expect(result.isError).toBeFalsy();
    return startedSession(root);
  }

  it("carries a valid project level through to the frozen session field", async () => {
    const root = track(buildProject());
    setReviewEffortOverride(root, "light");
    const session = await startAndRead(root);
    expect(session.resolvedReviewEffort).toMatchObject({ level: "light", source: "project" });
  });

  it("fails a written null closed to standard instead of dropping it", async () => {
    // JSON.parse gives a real null here (`meta unset` deletes the key), so this
    // is a value someone wrote. Dropped, it would reach the resolver as absent
    // and let a low-risk chore size-map to LIGHT -- less review than today.
    const root = track(buildProject());
    setReviewEffortOverride(root, null);
    const session = await startAndRead(root);
    expect(session.resolvedReviewEffort).toMatchObject({ level: "standard", source: "project" });
  });

  it("fails a typo'd project level closed to standard, still attributed to the project", async () => {
    const root = track(buildProject());
    setReviewEffortOverride(root, "quick");
    const session = await startAndRead(root);
    expect(session.resolvedReviewEffort).toMatchObject({ level: "standard", source: "project" });
  });

  it("leaves a project that set nothing on the size-mapped default", async () => {
    // The negative control: without it, every assertion above would still pass
    // if ingestion pinned standard unconditionally and disabled the mapping.
    const root = track(buildProject());
    const session = await startAndRead(root);
    expect(session.resolvedReviewEffort).toMatchObject({ level: "size-mapped", source: "default" });
  });
});
