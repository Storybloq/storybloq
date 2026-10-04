/**
 * ISS-958 S3: the start path's own creations and supersedes when a state
 * write is published but its durability is unproven.
 *
 *   - createSession (policy OC): the session it created is removed, because
 *     no caller ever learns it exists; the message says whether removal
 *     succeeded.
 *   - TP6 trySupersedeFinishedOrphan and TP7 the stale-supersede loop
 *     (policy TC): the superseded state WAS published and nothing revisits a
 *     superseded session, so its shutdown marker is written before the error
 *     propagates.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const { wrapFs } = await import("./_state-write-fault.js");
  return wrapFs(actual);
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { telemetryDirPath } from "../../src/autonomous/liveness.js";
import {
  StateWriteUndurableError,
  appendEvent,
  createSession,
  readSession,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../src/autonomous/session-types.js";
import { fixtureShell } from "../helpers/git-fixture.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import { armFail, armUndurable, disarm, faultFired } from "./_state-write-fault.js";

const roots: string[] = [];

afterEach(() => {
  disarm();
  while (roots.length) {
    const root = roots.pop()!;
    try { chmodSync(join(root, ".story", "sessions"), 0o755); } catch { /* ignore */ }
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function armTyped(opts: { dir?: string; onPublish?: () => void } = {}): void {
  armUndurable(
    (published) => {
      opts.onPublish?.();
      return new StateWriteUndurableError(published as FullSessionState, new Error("EIO: injected dir fsync failure"));
    },
    (d) => readSession(d),
    opts.dir ? { dir: opts.dir } : {},
  );
}

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iss958-s3-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss958-s3", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: {
      stages: { WRITE_TESTS: { enabled: false }, TEST: { enabled: false }, BUILD: { enabled: false }, VERIFY: { enabled: false } },
    },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "iss958", date: "2026-10-04",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  return root;
}

function writeIssue(root: string, id: string, status: "open" | "resolved"): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status, severity: "medium", components: [], impact: "test",
    resolution: status === "resolved" ? "fixed in fixture" : null, location: [],
    discoveredDate: "2026-10-04", resolvedDate: status === "resolved" ? "2026-10-04" : null,
    relatedTickets: [], order: 10, phase: "p1",
  }));
}

function deadPid(): number {
  for (let candidate = 900_000; candidate < 900_200; candidate++) {
    try { process.kill(candidate, 0); } catch (e: any) {
      if (e?.code === "ESRCH") return candidate;
    }
  }
  throw new Error("could not find a dead pid for the fixture");
}

function sessionEntries(root: string): string[] {
  return readdirSync(join(root, ".story", "sessions"));
}

function shutdownMarked(dir: string): boolean {
  const p = join(telemetryDirPath(dir), "shutdown");
  return existsSync(p) && readFileSync(p, "utf-8") === "1";
}

/** A lease-expired IMPLEMENT session, written before any fault is armed. */
function plantStale(root: string, extra: Partial<FullSessionState>, leaseMinutesAgo: number): string {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(dir, {
    ...session,
    state: "IMPLEMENT",
    status: "active",
    compactPending: false,
    lease: { ...session.lease, expiresAt: new Date(Date.now() - leaseMinutesAgo * 60_000).toISOString() },
    ...extra,
  } as FullSessionState);
  return dir;
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe("ISS-958 S3: createSession owns its creation (policy OC, D1)", () => {
  it("removes the published session and says so when the initial write is undurable", () => {
    const root = setupRoot();
    armTyped();
    let caught: unknown;
    try {
      createSession(root, "coding", deriveWorkspaceId(root));
    } catch (err) {
      caught = err;
    }
    expect(faultFired()).toBe(true);
    expect(caught).toBeInstanceOf(StateWriteUndurableError);
    const msg = (caught as Error).message;
    const id = (caught as StateWriteUndurableError).published.sessionId;
    expect(msg).toContain(`created session ${id} removed; nothing to resume`);
    expect(sessionEntries(root)).toEqual([]);
  });

  it("names the directory when the removal itself fails", () => {
    const root = setupRoot();
    const sessions = join(root, ".story", "sessions");
    // Published first, then the parent goes read-only, so the rmdir fails.
    armTyped({ onPublish: () => chmodSync(sessions, 0o555) });
    let caught: unknown;
    try {
      createSession(root, "coding", deriveWorkspaceId(root));
    } catch (err) {
      caught = err;
    }
    chmodSync(sessions, 0o755);
    expect(caught).toBeInstanceOf(StateWriteUndurableError);
    const id = (caught as StateWriteUndurableError).published.sessionId;
    expect((caught as Error).message).toContain(`created session ${id} could NOT be removed: ${join(sessions, id)}`);
    expect(sessionEntries(root)).toEqual([id]);
  });

  it("a pre-rename failure is unchanged: plain error, message untouched", () => {
    const root = setupRoot();
    armFail();
    let caught: unknown;
    try {
      createSession(root, "coding", deriveWorkspaceId(root));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(StateWriteUndurableError);
    expect((caught as Error).message).not.toContain("created session");
  });
});

describe("ISS-958 S3: TP6 finished-orphan supersede completes its tail (policy TC)", () => {
  function plantFinishedOrphan(root: string): string {
    fixtureShell(root, "git init -q -b main");
    fixtureShell(root, "git config user.email test@test.com");
    fixtureShell(root, "git config user.name Test");
    writeFileSync(join(root, "README.md"), "# fixture\n");
    fixtureShell(root, "git add README.md");
    fixtureShell(root, "git commit -q -m initial");
    writeIssue(root, "ISS-101", "resolved");
    writeFileSync(join(root, "fix.txt"), "fix\n");
    fixtureShell(root, "git add fix.txt");
    fixtureShell(root, "git commit -q -m fix");
    const hash = fixtureShell(root, "git rev-parse HEAD");
    const dir = plantStale(root, { targetWork: ["ISS-101"] } as Partial<FullSessionState>, 120);
    appendEvent(dir, { rev: 1, type: "commit", timestamp: new Date().toISOString(), data: { commitHash: hash, issueId: "ISS-101" } });
    return dir;
  }

  it("undurable: published superseded, auto_superseded kept, shutdown marker written, error surfaced", async () => {
    const root = setupRoot();
    const dir = plantFinishedOrphan(root);
    armTyped({ dir });
    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null });
    expect(faultFired()).toBe(true);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("durability");
    const state = readSession(dir)!;
    expect(state.status).toBe("superseded");
    expect(state.terminationReason).toBe("auto_superseded_finished_orphan");
    expect(shutdownMarked(dir)).toBe(true);
  });

  it("a pre-rename failure is unchanged: no marker, the session stays active", async () => {
    const root = setupRoot();
    const dir = plantFinishedOrphan(root);
    armFail({ dir });
    await handleAutonomousGuide(root, { action: "start", sessionId: null });
    expect(faultFired()).toBe(true);
    expect(readSession(dir)!.status).toBe("active");
    expect(shutdownMarked(dir)).toBe(false);
  });
});

describe("ISS-958 S3: TP7 stale-supersede loop completes its tail (policy TC)", () => {
  it("undurable: published superseded, shutdown marker written, error surfaced", async () => {
    const root = setupRoot();
    writeIssue(root, "ISS-9001", "open");
    const dir = plantStale(root, { targetWork: ["ISS-9001"], mcpServerPid: deadPid(), mcpGuideCallAt: new Date().toISOString() } as Partial<FullSessionState>, 90);
    armTyped({ dir });
    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null });
    expect(faultFired()).toBe(true);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("durability");
    expect(readSession(dir)!.status).toBe("superseded");
    expect(shutdownMarked(dir)).toBe(true);
  });

  it("a pre-rename failure is unchanged: no marker, the session stays active", async () => {
    const root = setupRoot();
    writeIssue(root, "ISS-9002", "open");
    const dir = plantStale(root, { targetWork: ["ISS-9002"], mcpServerPid: deadPid(), mcpGuideCallAt: new Date().toISOString() } as Partial<FullSessionState>, 90);
    armFail({ dir });
    const result = await handleAutonomousGuide(root, { action: "start", sessionId: null });
    expect(faultFired()).toBe(true);
    expect(result.isError).toBe(true);
    expect(readSession(dir)!.status).toBe("active");
    expect(shutdownMarked(dir)).toBe(false);
  });
});
