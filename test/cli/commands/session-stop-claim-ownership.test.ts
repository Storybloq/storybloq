/**
 * ISS-778: `handleSessionStop` must release a ticket claim under STRICT
 * ownership. The legacy guard released a ticket iff `!claimedBySession ||
 * claimedBySession === sessionId`. The `!claimedBySession` escape hatch destroys
 * a FOREIGN CLI claim: `storybloq ticket start` writes claim{user,branch,since}
 * but never claimedBySession, so a teammate's in-flight ticket gets unclaimed
 * and reopened by an admin session stop.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleSessionStop } from "../../../src/cli/commands/session-compact.js";
import { writeSessionSync } from "../../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState } from "../../../src/autonomous/session-types.js";

const NOW = new Date().toISOString();
const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length) {
    const dir = createdRoots.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iss778-stop-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  mkdirSync(join(root, ".story", "tickets"), { recursive: true });
  mkdirSync(join(root, ".story", "issues"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2,
    schemaVersion: 1,
    project: "iss778-stop-fixture",
    type: "npm",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "iss778", date: "2026-07-02",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  createdRoots.push(root);
  return root;
}

/** Write T-001 (status inprogress) with the given extra claim material. */
function writeTicket(root: string, extra: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "inprogress",
    phase: "p1", order: 10, description: "", createdDate: "2026-07-02",
    completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  }));
}

/** Plant an active session that references T-001. */
function plantSession(root: string, sessionId: string): string {
  const dir = join(root, ".story", "sessions", sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const state: FullSessionState = {
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
    git: { branch: "main", mergeBase: null },
    lease: {
      workspaceId: deriveWorkspaceId(root),
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
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
  } as unknown as FullSessionState;
  writeSessionSync(dir, state);
  return dir;
}

function readTicket(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
}

describe("session stop claim-release ownership (ISS-778, handleSessionStop)", () => {
  it("(a) preserves a FOREIGN CLI claim (claimedBySession absent): no release", async () => {
    const root = setupRoot();
    const foreignClaim = { user: "teammate@example.com", branch: "main", since: NOW };
    writeTicket(root, { claim: foreignClaim });
    const sessionId = "c0decafe-0000-0000-0000-0000000000aa";
    plantSession(root, sessionId);

    await handleSessionStop(root, sessionId);

    const after = readTicket(root);
    expect(after.status).toBe("inprogress");
    expect(after.claim).toEqual(foreignClaim);
  });

  it("(b) releases when THIS session owns the claim (claimedBySession === sessionId)", async () => {
    const root = setupRoot();
    const sessionId = "c0decafe-0000-0000-0000-0000000000bb";
    writeTicket(root, {
      claimedBySession: sessionId,
      claim: { user: "me@example.com", branch: "main", since: NOW },
    });
    plantSession(root, sessionId);

    await handleSessionStop(root, sessionId);

    const after = readTicket(root);
    expect(after.status).toBe("open");
    expect(after.claimedBySession).toBeUndefined();
    expect(after.claim).toBeUndefined();
  });

  it("(c) releases a bare inprogress ticket (no claim, no claimedBySession)", async () => {
    const root = setupRoot();
    writeTicket(root, {});
    const sessionId = "c0decafe-0000-0000-0000-0000000000cc";
    plantSession(root, sessionId);

    await handleSessionStop(root, sessionId);

    const after = readTicket(root);
    expect(after.status).toBe("open");
    expect(after.claim).toBeUndefined();
    expect(after.claimedBySession).toBeUndefined();
  });

  it("ISS-1405: releases past a ticket file that does not parse and names it", async () => {
    const root = setupRoot();
    const sessionId = "c0decafe-0000-0000-0000-0000000000dd";
    writeTicket(root, { claimedBySession: sessionId });
    writeFileSync(join(root, ".story", "tickets", "T-009.json"), "{not json");
    plantSession(root, sessionId);

    const reply = await handleSessionStop(root, sessionId);

    expect(readTicket(root).claimedBySession).toBeUndefined();
    expect(reply).toContain("released to open");
    expect(reply).toContain(".story/tickets/T-009.json");
  });

  it("ISS-1405: says the claim was not released, and names the file, when the release fails", async () => {
    const root = setupRoot();
    const sessionId = "c0decafe-0000-0000-0000-0000000000ee";
    writeTicket(root, { claimedBySession: sessionId });
    writeFileSync(join(root, ".story", "tickets", "T-050.json"), readFileSync(join(root, ".story", "tickets", "T-001.json")));
    writeFileSync(join(root, ".story", "tickets", "T-009.json"), "{not json");
    plantSession(root, sessionId);

    const reply = await handleSessionStop(root, sessionId);

    expect(readTicket(root).claimedBySession).toBe(sessionId);
    expect(reply).toContain("NOT released");
    expect(reply).toContain("T-050.json");
  });
});
