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

import { findResumableSession, probePath, listAllSessionsDetailed } from "../../src/autonomous/session.js";
import { probeContainment } from "../../src/autonomous/session-selector.js";
import { deriveWorkspaceId } from "../../src/autonomous/session-types.js";
import { scanActiveSessions, scanSessionSummaries } from "../../src/core/session-scan.js";
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

/**
 * `lstat` declines to follow the FINAL component and follows every one before
 * it (ISS-897).
 *
 * So an ENOENT from `lstat(parent/child)` is raised by two different worlds: the
 * child is gone under a parent that is fine, or the PARENT stopped resolving.
 * Every caller here reads `absent` as proof, and two of them SKIP on it -- so
 * treating the second world as the first drops entries in silence over a
 * sessions root that no longer resolves, and reports the result as clean.
 */
describe("a probe cannot prove absence without asking the parent", () => {
  it("separates a missing child from an unresolvable ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-probe-parent-"));
    createdRoots.push(root);
    mkdirSync(join(root, "real"), { recursive: true });
    symlinkSync("/nonexistent-target", join(root, "dangling"));

    // A parent that is a real directory: the child's ENOENT is about the child.
    expect(probePath(join(root, "real", "kid"))).toBe("absent");
    // A parent that is itself absent proves it too -- a project with no
    // `.story/sessions` yet is exactly this shape, and calling it unprovable
    // would turn every ordinary not-found into "could not be read".
    expect(probePath(join(root, "gone", "kid"))).toBe("absent");
    // A parent that EXISTS and is not a directory proves nothing. This is the
    // case the errno hides: the dangling link lstats successfully, so only
    // asking about it separates this from the two above.
    expect(probePath(join(root, "dangling", "kid"))).toBe("probe-failed");
    // ...and the unresolvable ancestor does not have to be the IMMEDIATE
    // parent. This is what defeated the first version of the walk: for
    // `dangling/mid/kid`, `lstat` on `dangling/mid` raises ENOENT too, so a
    // check that stopped after one level accepted the same ambiguity it was
    // written to resolve and answered `absent`. The climb has to continue
    // through absent ancestors until one exists.
    expect(probePath(join(root, "dangling", "mid", "kid"))).toBe("probe-failed");
    expect(probePath(join(root, "dangling", "a", "b", "c", "kid"))).toBe("probe-failed");
    // The mirror case, so the walk cannot simply answer `probe-failed` for
    // everything deep: several genuinely absent levels are still an absence.
    expect(probePath(join(root, "gone", "deep", "deeper", "kid"))).toBe("absent");
    // ...and the ordinary present answer is unchanged.
    expect(probePath(join(root, "real"))).toBe("present");
  });
});

/**
 * Containment has THREE answers and the predicate returned two (ISS-897).
 *
 * A proven escape and a probe that could not look are opposites: the first is
 * the guard working, the second establishes nothing. `listAllSessionsDetailed`
 * skipped on both, so an entry it could not check disappeared from a listing
 * this command presents as the whole inventory.
 */
describe("an unprovable directory is reported, not skipped", () => {
  it("keeps a directory whose containment could not be established", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-contain-probe-"));
    createdRoots.push(root);
    const sessions = join(root, ".story", "sessions");
    mkdirSync(sessions, { recursive: true });
    // A symlink LOOP, which is the portable way to make `realpath` fail with
    // something other than ENOENT. A merely dangling link would not do: it
    // raises ENOENT, which the lexical branch answers `contained` for, because
    // a session directory that does not exist yet looks exactly like that.
    // ELOOP is different -- something is genuinely there and cannot be
    // resolved, so containment is UNKNOWN rather than refused.
    const a = join(sessions, "aaaa1111-2222-4333-8444-555555555555");
    const b = join(sessions, "bbbb2222-2222-4333-8444-555555555555");
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(probeContainment(root, a)).toBe("probe-failed");

    // What follows pins the PROBE and the fact that the entry is reported at
    // all. It does NOT pin the containment routing inside the enumerator: a
    // symlink is a link rather than a directory to `readdirSync`, so this entry
    // takes the non-directory branch before containment is consulted, and the
    // assertions below would hold with that routing reverted. The routing has
    // its own file, `session-containment-routing.test.ts`, where the probe is
    // stubbed because no portable filesystem shape produces `probe-failed` for
    // a real directory without racing the code under test.
    const all = listAllSessionsDetailed(root);
    const named = all.unavailable.map((u) => u.sourceDir);
    expect(named, JSON.stringify(all)).toContain("aaaa1111-2222-4333-8444-555555555555");
    // Reported as present-but-unread, with no damage claimed: nothing here
    // opened anything.
    const row = all.unavailable.find((u) => u.sourceDir === "aaaa1111-2222-4333-8444-555555555555")!;
    expect(row.failure.kind).toBe("unreadable");
    expect(all.damaged).toEqual([]);
  });

  it("REPORTS an escaping symlink instead of dropping it, matching the scanner", () => {
    // Shape is classified before containment, and the order is observable. A
    // symlink whose target resolves outside the sessions root is `escaped` to
    // the containment probe and `entry-not-a-directory` to the scanner --
    // running containment first dropped it in silence, and the guard tells an
    // operator to run `storybloq session list` precisely BECAUSE that command
    // surfaces every symlink. So the guard named a fault and sent them to a
    // command that showed nothing, which is the concealment moved one surface
    // downstream rather than removed.
    //
    // Reporting is not following: the row says an entry is there and unread,
    // and nothing here opened the target or offered it as a session.
    const root = mkdtempSync(join(tmpdir(), "storybloq-contain-escape-"));
    createdRoots.push(root);
    const sessions = join(root, ".story", "sessions");
    mkdirSync(sessions, { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "state.json"), JSON.stringify({ schemaVersion: 1 }));
    symlinkSync(outside, join(sessions, "cccc3333-2222-4333-8444-555555555555"));

    const all = listAllSessionsDetailed(root);
    expect(all.unavailable.map((u) => u.sourceDir)).toContain(
      "cccc3333-2222-4333-8444-555555555555",
    );
    // NOT admitted as a session, and not called damaged: the target was never
    // read, so no claim about its contents is available.
    expect(all.sessions).toEqual([]);
    expect(all.damaged).toEqual([]);

    // ...and the scanner says the same thing about the same path, which is the
    // agreement that makes the guard's advice true.
    const scanned = scanSessionSummaries(root);
    expect(scanned.diagnostics.map((d) => d.kind)).toContain("entry-not-a-directory");
  });
});
