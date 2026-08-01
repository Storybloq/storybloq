/**
 * T-450 step 5, commit B: the best-effort calls really are best-effort.
 *
 * WHY THIS EXISTS. The cancellation tail wraps two calls in bare catches:
 *
 *     try { killSidecar(session.state.sidecarPid); } catch { }
 *     try { writeShutdownMarker(session.dir); } catch { }
 *
 * Mutation testing removed each catch in turn and every test stayed green. My
 * first instinct was to record both as equivalent, on the reasoning that neither
 * callee throws in practice: `killSidecar` guards its own `process.kill`, and
 * `writeShutdownMarker` swallows its own write errors.
 *
 * That reasoning is exactly what L-039 forbids. It is a claim about the internals
 * of DIFFERENT modules (`liveness.ts`), and reading their source to confirm it is
 * still a single source -- the same mistake that made the PA114b equivalence
 * claim wrong. A claim about another module has to be EXECUTED against it.
 *
 * Executing it also makes the claim worth more than it was. Whether the callees
 * happen to throw today is an implementation detail of theirs that can change
 * without anyone touching this file; what the tail actually promises is that a
 * throw from either one cannot stop the session from being published as
 * cancelled. These tests inject that throw directly and pin the promise, which
 * holds no matter what the callees do later.
 *
 * These are DEFENSIVE CONTRACT-VIOLATION INJECTIONS. Neither callee documents
 * that it throws; the injection deliberately breaks that to prove the caller's
 * isolation is real rather than incidental.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Which best-effort call is made to throw. `off` for the control. */
const BREAK: { call: "off" | "killSidecar" | "writeShutdownMarker" } = { call: "off" };

vi.mock("../../src/autonomous/liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/autonomous/liveness.js")>();
  return {
    ...actual,
    killSidecar: vi.fn((...args: Parameters<typeof actual.killSidecar>) => {
      if (BREAK.call === "killSidecar") throw new Error("injected: killSidecar threw");
      return actual.killSidecar(...args);
    }),
    writeShutdownMarker: vi.fn((...args: Parameters<typeof actual.writeShutdownMarker>) => {
      if (BREAK.call === "writeShutdownMarker") throw new Error("injected: writeShutdownMarker threw");
      return actual.writeShutdownMarker(...args);
    }),
  };
});

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

function setupProject(dir: string): void {
  const storyDir = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-01",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(storyDir, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", description: "A test.", type: "task",
    status: "inprogress", phase: "p1", order: 10, createdDate: "2026-08-01",
    completedDate: null, blockedBy: [],
  }));
}

function plantSession(root: string): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

function cancelledEvents(sessDir: string): Record<string, unknown>[] {
  let raw = "";
  try { raw = readFileSync(join(sessDir, "events.log"), "utf-8"); } catch { return []; }
  return raw.split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } })
    .filter((e) => e.type === "cancelled");
}

function hasCancelledTelemetry(sessDir: string): boolean {
  for (const name of ["events.jsonl", "telemetry.jsonl"]) {
    let raw = "";
    try { raw = readFileSync(join(sessDir, "telemetry", name), "utf-8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        if ((JSON.parse(line) as Record<string, unknown>).type === "session_cancelled") return true;
      } catch { /* skip */ }
    }
  }
  return false;
}

/**
 * Evidence of two different kinds, and worth keeping straight because only one
 * of them is load-bearing here.
 *
 * UPSTREAM of the injected calls: the terminal state write and the ticket
 * release. These happen before `killSidecar` and `writeShutdownMarker`, so they
 * would survive an escaping throw. They confirm the run reached the tail, and
 * nothing more.
 *
 * DOWNSTREAM: the audit event, the telemetry record, and the call returning
 * without error. These are what an escaping throw would destroy, so these are
 * what actually prove the catch did its job.
 */
function expectTailCompleted(root: string, sessDir: string): void {
  const state = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
  expect(state.state, "session published as ended").toBe("SESSION_END");
  expect(state.status).toBe("completed");
  expect(state.terminationReason).toBe("cancelled");
  expect(cancelledEvents(sessDir), "the audit event still landed").toHaveLength(1);
  expect(hasCancelledTelemetry(sessDir), "telemetry still recorded the cancellation").toBe(true);
  expect(
    (JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8")) as Record<string, unknown>).status,
    "the ticket was still released",
  ).toBe("open");
}

describe("T-450: a throwing best-effort call cannot abort the cancellation tail", () => {
  let root: string;

  beforeEach(() => {
    BREAK.call = "off";
    root = mkdtempSync(join(tmpdir(), "sb-besteffort-"));
    setupProject(root);
  });

  afterEach(() => {
    BREAK.call = "off";
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("control: with nothing injected the whole tail runs", async () => {
    // Proves the fixture reaches the tail at all. Without it, the two tests
    // below could pass because cancellation never got that far.
    const { sessionId, sessDir } = plantSession(root);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expectTailCompleted(root, sessDir);
    // The real marker path, read off `writeShutdownMarker` rather than guessed:
    // it writes `shutdown` and `alive` into the session's telemetry directory.
    // A guessed path would make this assertion vacuous in the failing direction.
    expect(existsSync(join(sessDir, "telemetry", "shutdown")), "the control wrote a shutdown marker").toBe(true);
    expect(readFileSync(join(sessDir, "telemetry", "alive"), "utf-8")).toBe("0");
  });

  it("a throwing killSidecar does not stop the tail", async () => {
    // COMPATIBILITY INVARIANT: signalling the sidecar is best-effort. The
    // session must still be published as cancelled and the ticket still
    // released, because a failure to signal a possibly-dead pid says nothing
    // about whether the cancellation itself should stand.
    BREAK.call = "killSidecar";
    const { sessionId, sessDir } = plantSession(root);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expectTailCompleted(root, sessDir);
  });

  it("a throwing writeShutdownMarker does not stop the tail", async () => {
    // COMPATIBILITY INVARIANT, and the stronger of the two: the shutdown marker
    // is how other processes learn the session is over, so losing it is a real
    // degradation. It still must not prevent the cancellation from being
    // recorded, because an unrecorded cancellation is strictly worse.
    //
    // DOCUMENTED CURRENT HAZARD: nothing retries the marker and nothing reports
    // that it is missing. Step 6 is where that gets a durable protocol; this
    // records today's behavior so a change to it is visible.
    BREAK.call = "writeShutdownMarker";
    const { sessionId, sessDir } = plantSession(root);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();
    expectTailCompleted(root, sessDir);
  });
});
