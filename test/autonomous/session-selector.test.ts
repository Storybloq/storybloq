/**
 * T-251: resolveSessionSelector — tri-state session ID resolver.
 *
 * Exercises the new resolver helper in claudestory/src/autonomous/session-selector.ts
 * against real on-disk fixtures. No mocking — we want realpath + readdirSync
 * semantics tested end-to-end, including the symlink-escape guard.
 *
 * These tests MUST fail before session-selector.ts ships.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveSessionSelector,
  isContainedSessionDir,
} from "../../src/autonomous/session-selector.js";

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
  const root = mkdtempSync(join(tmpdir(), "t251-resolver-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  createdRoots.push(root);
  return root;
}

function writeMinimalState(dir: string, sessionId: string): void {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    sessionId,
    recipe: "coding",
    state: "INIT",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: {
      workspaceId: "test-ws",
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
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
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-251 resolveSessionSelector", () => {
  it("resolverAcceptsUniquePrefix: two sessions with distinct 4-char prefixes resolve by prefix", () => {
    const root = setupRoot();
    const a = "aaaaaaaa-0000-0000-0000-000000000001";
    const b = "bbbbbbbb-0000-0000-0000-000000000001";
    writeMinimalState(join(root, ".story", "sessions", a), a);
    writeMinimalState(join(root, ".story", "sessions", b), b);

    const ra = resolveSessionSelector(root, "aaaa");
    const rb = resolveSessionSelector(root, "bbbb");

    expect(ra.kind).toBe("resolved");
    if (ra.kind === "resolved") {
      expect(ra.sessionId).toBe(a);
      expect(ra.corrupt).toBe(false);
    }
    expect(rb.kind).toBe("resolved");
    if (rb.kind === "resolved") {
      expect(rb.sessionId).toBe(b);
      expect(rb.corrupt).toBe(false);
    }
  });

  it("resolverRejectsAmbiguousPrefix: shared 4-char prefix returns ambiguous with match list", () => {
    const root = setupRoot();
    const a = "aaaaaaaa-0000-0000-0000-000000000001";
    const b = "aaaaaaaa-0000-0000-0000-000000000002";
    writeMinimalState(join(root, ".story", "sessions", a), a);
    writeMinimalState(join(root, ".story", "sessions", b), b);

    const r = resolveSessionSelector(root, "aaaa");

    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.matches.length).toBeGreaterThanOrEqual(2);
      expect(r.matches).toContain(a);
      expect(r.matches).toContain(b);
    }
  });

  it("resolverRejectsSymlinkEscape: UUID-named symlink pointing outside sessionsRoot returns invalid", () => {
    const root = setupRoot();
    // Create a sibling directory outside .story/sessions/ but inside root.
    const outside = join(root, "outside-target");
    mkdirSync(outside, { recursive: true });
    const sessionId = "deadbeef-1111-1111-1111-111111111111";
    writeMinimalState(outside, sessionId); // plausible state.json target
    // Snapshot target state.json contents to verify no write.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const targetStateBefore = readFileSync(join(outside, "state.json"), "utf-8");

    // Plant a UUID-named symlink in .story/sessions/ pointing at the outside target.
    const linkPath = join(root, ".story", "sessions", sessionId);
    symlinkSync(outside, linkPath, "dir");

    const r = resolveSessionSelector(root, sessionId);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.reason.length).toBeGreaterThan(0);
    }

    // And the isContainedSessionDir guard should return false for the symlink directly.
    expect(isContainedSessionDir(root, linkPath)).toBe(false);

    // Target must be byte-identical — no accidental write.
    const targetStateAfter = readFileSync(join(outside, "state.json"), "utf-8");
    expect(targetStateAfter).toBe(targetStateBefore);
  });
});
