/**
 * T-251: Bulk discovery containment — the five session enumerators must drop
 * UUID-named symlinks that escape sessionsRoot before any filesystem write.
 *
 * Covers:
 *  - findActiveSessionFull → handleSessionStop (write path)     [test 23]
 *  - scanActiveSessions    → status display (read only)         [test 24]
 *  - findResumableSession  → handleSessionClearCompact (write)  [test 25]
 *
 * These tests MUST fail before the hardening ships.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findResumableSession } from "../../src/autonomous/session.js";
import { deriveWorkspaceId } from "../../src/autonomous/session-types.js";
import { scanActiveSessions } from "../../src/core/session-scan.js";
import { handleSessionStop, handleSessionClearCompact } from "../../src/cli/commands/session-compact.js";

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

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "t251-containment-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  mkdirSync(join(root, ".story", "tickets"), { recursive: true });
  mkdirSync(join(root, ".story", "issues"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "t251-containment-fixture",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "t251", date: "2026-04-10", phases: [], blockers: [],
  }));
  createdRoots.push(root);
  return root;
}

interface SymlinkActiveOpts {
  compactPending?: boolean;
  sessionId?: string;
}

/**
 * Create a sibling directory outside sessionsRoot that contains a plausible
 * state.json, then plant a UUID-named symlink inside .story/sessions/ pointing
 * at it. Returns (outsideDir, sessionId, linkPath).
 */
function plantSymlinkSession(root: string, opts: SymlinkActiveOpts = {}): {
  outside: string;
  sessionId: string;
  linkPath: string;
} {
  const sessionId = opts.sessionId ?? "c0decafe-0000-0000-0000-000000000001";
  const outside = join(root, "outside-target");
  mkdirSync(outside, { recursive: true });

  const workspaceId = deriveWorkspaceId(root);
  const now = new Date().toISOString();
  const lease = {
    workspaceId,
    lastHeartbeat: now,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  const state: Record<string, unknown> = {
    schemaVersion: 1,
    sessionId,
    recipe: "coding",
    state: opts.compactPending ? "COMPACT" : "IMPLEMENT",
    revision: 3,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: null },
    lease,
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: opts.compactPending ? 3 : null,
    preCompactState: opts.compactPending ? "IMPLEMENT" : null,
    compactPending: !!opts.compactPending,
    compactPreparedAt: opts.compactPending ? now : null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
  };
  writeFileSync(join(outside, "state.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(outside, "events.log"), ""); // canonical empty events log

  const linkPath = join(root, ".story", "sessions", sessionId);
  symlinkSync(outside, linkPath, "dir");

  return { outside, sessionId, linkPath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-251 bulk discovery containment", () => {
  // Test 23
  it("stopIgnoresSymlinkActiveSession: findActiveSessionFull drops symlink escape before handleSessionStop write", async () => {
    const root = setupRoot();
    const { outside, sessionId, linkPath } = plantSymlinkSession(root, {});

    // Snapshot sibling state.json bytes to prove no write.
    const targetStateBefore = readFileSync(join(outside, "state.json"), "utf-8");
    const targetEventsBefore = readFileSync(join(outside, "events.log"), "utf-8");

    // handleSessionStop(root) with no sessionId — routes through findActiveSessionFull.
    await expect(handleSessionStop(root)).rejects.toThrow(/No active session found/);

    // Byte-for-byte unchanged.
    const targetStateAfter = readFileSync(join(outside, "state.json"), "utf-8");
    const targetEventsAfter = readFileSync(join(outside, "events.log"), "utf-8");
    expect(targetStateAfter).toBe(targetStateBefore);
    expect(targetEventsAfter).toBe(targetEventsBefore);

    // Reference the unused locals to keep linters happy.
    expect(sessionId.length).toBe(36);
    expect(linkPath.length).toBeGreaterThan(0);
  });

  // Test 24
  it("scanActiveSessionsIgnoresSymlinkEscape: status scanner drops symlink escape", () => {
    const root = setupRoot();
    const { sessionId } = plantSymlinkSession(root, {});

    const summaries = scanActiveSessions(root);
    const ids = summaries.map((s) => s.sessionId);
    expect(ids).not.toContain(sessionId);
  });

  // Test 25
  it("clearCompactIgnoresSymlinkResumableSession: findResumableSession + handleSessionClearCompact drop symlink escape", async () => {
    const root = setupRoot();
    const { outside, sessionId, linkPath } = plantSymlinkSession(root, { compactPending: true });

    // Direct resumable scan.
    const resumable = findResumableSession(root);
    expect(resumable).toBeNull();

    // Snapshot sibling state.json bytes to prove no write.
    const targetStateBefore = readFileSync(join(outside, "state.json"), "utf-8");

    // handleSessionClearCompact(root) with no sessionId — routes through findResumableSession.
    await expect(handleSessionClearCompact(root)).rejects.toThrow(/No compactPending session found/);

    // Target state byte-for-byte unchanged.
    const targetStateAfter = readFileSync(join(outside, "state.json"), "utf-8");
    expect(targetStateAfter).toBe(targetStateBefore);

    // Reference unused locals.
    expect(sessionId.length).toBe(36);
    expect(linkPath.length).toBeGreaterThan(0);
  });
});
