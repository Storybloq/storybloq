/**
 * ISS-958 S1, R1 exception (i): writeSessionWithEvent must not truncate the
 * event it appended when the state write throws StateWriteUndurableError,
 * because that error means the rename already PUBLISHED the state the event
 * describes. A pre-rename failure still rolls the event back.
 *
 * The typed error is injected by publishing state.json for real and then
 * throwing (see _state-write-fault.ts), which is the published-but-undurable
 * outcome as every reader observes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { wrapFs } = await import("./_state-write-fault.js");
  return wrapFs(actual);
});

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  StateWriteUndurableError,
  appendEvent,
  readSession,
  writeSessionSync,
  writeSessionWithEvent,
} from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { handleSessionRepair } from "../../src/cli/commands/session.js";
import { armFail, armUndurable, disarm, faultFired } from "./_state-write-fault.js";

const roots: string[] = [];

afterEach(() => {
  disarm();
  while (roots.length) {
    try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function armTyped(dir?: string): void {
  armUndurable(
    (published) => new StateWriteUndurableError(published as FullSessionState, new Error("EIO: injected dir fsync failure")),
    (d) => readSession(d),
    dir ? { dir } : {},
  );
}

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iss958-s1-"));
  roots.push(root);
  for (const sub of ["sessions", "tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss958-s1", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "iss958", date: "2026-10-04",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  return root;
}

function plantSession(root: string, sessionId: string, extra: Partial<FullSessionState> = {}, leaseMinutesAgo = -30): string {
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    sessionId,
    recipe: "coding",
    state: "IMPLEMENT",
    revision: 3,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: {
      workspaceId: deriveWorkspaceId(root),
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() - leaseMinutesAgo * 60_000).toISOString(),
    },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
    ...extra,
  } as FullSessionState;
  writeSessionSync(dir, state);
  return dir;
}

function eventLines(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, "events.log");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function eventSize(dir: string): number {
  const p = join(dir, "events.log");
  return existsSync(p) ? statSync(p).size : 0;
}

describe("ISS-958 S1: writeSessionWithEvent keeps the event of a published-but-undurable write", () => {
  it("(a) typed error after publication: line kept, state is the postimage, error typed, revisions agree", () => {
    const root = setupRoot();
    const dir = plantSession(root, "aaaa0001-0000-4000-8000-000000000001");
    appendEvent(dir, { rev: 4, type: "earlier", timestamp: "2026-10-04T00:00:00.000Z", data: {} });
    const before = readSession(dir)!;
    const sizeBefore = eventSize(dir);
    const event = { rev: before.revision + 1, type: "probe_event", timestamp: new Date().toISOString(), data: { n: 1 } };
    const line = JSON.stringify(event) + "\n";

    armTyped(dir);
    let caught: unknown;
    try {
      writeSessionWithEvent(dir, { ...before, state: "PLAN" } as FullSessionState, event);
    } catch (err) {
      caught = err;
    }

    expect(faultFired()).toBe(true);
    expect(caught).toBeInstanceOf(StateWriteUndurableError);
    const published = (caught as StateWriteUndurableError).published;
    expect(published.revision).toBe(event.rev);
    expect(eventSize(dir)).toBe(sizeBefore + Buffer.byteLength(line));
    const lines = eventLines(dir);
    expect(lines.filter((e) => e.type === "probe_event")).toHaveLength(1);
    expect(lines.at(-1)).toEqual(event);
    const onDisk = readSession(dir)!;
    expect(onDisk.revision).toBe(before.revision + 1);
    expect(onDisk.state).toBe("PLAN");
  });

  it("(c) plain pre-rename failure: event truncated to its prior size, state byte-identical, error plain", () => {
    const root = setupRoot();
    const dir = plantSession(root, "aaaa0002-0000-4000-8000-000000000001");
    appendEvent(dir, { rev: 4, type: "earlier", timestamp: "2026-10-04T00:00:00.000Z", data: {} });
    const stateBytes = readFileSync(join(dir, "state.json"));
    const sizeBefore = eventSize(dir);
    const before = readSession(dir)!;

    armFail({ dir });
    let caught: unknown;
    try {
      writeSessionWithEvent(dir, { ...before, state: "PLAN" } as FullSessionState, {
        rev: before.revision + 1, type: "probe_event", timestamp: new Date().toISOString(), data: {},
      });
    } catch (err) {
      caught = err;
    }

    expect(faultFired()).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StateWriteUndurableError);
    expect(eventSize(dir)).toBe(sizeBefore);
    expect(eventLines(dir).some((e) => e.type === "probe_event")).toBe(false);
    expect(readFileSync(join(dir, "state.json")).equals(stateBytes)).toBe(true);
  });

  it("(c) also truncates when events.log did not exist before the append", () => {
    const root = setupRoot();
    const dir = plantSession(root, "aaaa0003-0000-4000-8000-000000000001");
    expect(existsSync(join(dir, "events.log"))).toBe(false);
    const before = readSession(dir)!;

    armFail({ dir });
    expect(() => writeSessionWithEvent(dir, before, {
      rev: before.revision + 1, type: "probe_event", timestamp: new Date().toISOString(), data: {},
    })).toThrow(/injected rename failure/);
    expect(eventSize(dir)).toBe(0);
  });
});

describe("ISS-958 S1: the repair CLI (TP10, policy P) through the real caller", () => {
  function git(cwd: string, cmd: string): string {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  }

  function plantFinishedOrphan(root: string, sessionId: string): string {
    git(root, "git init -q -b main");
    git(root, "git -c user.email=t@example.com -c user.name=T commit -q --allow-empty -m initial");
    const issueId = "ISS-999";
    writeFileSync(join(root, ".story", "issues", `${issueId}.json`), JSON.stringify({
      id: issueId, title: "Issue", status: "resolved", severity: "medium", components: [], impact: "test",
      resolution: "fixed", location: [], discoveredDate: "2026-10-04", resolvedDate: "2026-10-04",
      relatedTickets: [], order: 10, phase: "p1",
    }));
    writeFileSync(join(root, "fix.txt"), "fix\n");
    git(root, "git add fix.txt");
    git(root, "git -c user.email=t@example.com -c user.name=T commit -q -m fix");
    const commitHash = git(root, "git rev-parse HEAD");
    const dir = plantSession(root, sessionId, { targetWork: [issueId] } as Partial<FullSessionState>, 180);
    appendEvent(dir, { rev: 1, type: "commit", timestamp: new Date().toISOString(), data: { commitHash, issueId } });
    return dir;
  }

  it("an undurable supersede propagates the typed error, keeps exactly one manual_repair event, and a rerun adds none", async () => {
    const root = setupRoot();
    const dir = plantFinishedOrphan(root, "aaaa0004-0000-4000-8000-000000000001");

    armTyped(dir);
    await expect(handleSessionRepair(root, { dryRun: false, all: false, yes: true }))
      .rejects.toBeInstanceOf(StateWriteUndurableError);
    expect(faultFired()).toBe(true);
    expect(readSession(dir)!.status).toBe("superseded");
    expect(eventLines(dir).filter((e) => e.type === "manual_repair")).toHaveLength(1);

    disarm();
    await handleSessionRepair(root, { dryRun: false, all: false, yes: true });
    expect(eventLines(dir).filter((e) => e.type === "manual_repair")).toHaveLength(1);
  });

  it("a pre-rename failure rolls the manual_repair event back and leaves the session active", async () => {
    const root = setupRoot();
    const dir = plantFinishedOrphan(root, "aaaa0005-0000-4000-8000-000000000001");

    armFail({ dir });
    await expect(handleSessionRepair(root, { dryRun: false, all: false, yes: true })).rejects.toThrow(/injected rename failure/);
    expect(readSession(dir)!.status).toBe("active");
    expect(eventLines(dir).filter((e) => e.type === "manual_repair")).toHaveLength(0);
  });
});
