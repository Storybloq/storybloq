/**
 * T-450 step 5, commit B: the auto-stash restore runs BEFORE publication.
 *
 * WHY THIS EXISTS. The stash restore is the only effect in the cancellation tail
 * that happens before the session is written out as ended. Everything else is
 * post-publication. That ordering is load-bearing: the restore is the step that
 * puts the operator's stashed work back in the tree, and the published record is
 * what says the session is over and not resumable. Restore first, and a crash in
 * between leaves a session that still looks live, which is recoverable. Publish
 * first, and the same crash leaves a terminal session with no recovery route
 * that consumes the stash ref.
 *
 * To be precise about what is and is not lost, because an earlier draft of this
 * comment overstated it: the terminal write spreads `...session.state` and does
 * not override `git`, so `git.autoStash` IS still recorded on the ended session.
 * The reference survives. What does not survive is anything that would act on
 * it, since the session is now terminal.
 *
 * HOW THIS WAS FOUND, because it is the more useful half of the story. A mutation
 * harness carried a mutant labelled "stash restore moved AFTER publication" that
 * had been recorded as killed. A code review pointed out the mutant did not do
 * what its label said: its replacement text only DELETED the restore, which made
 * it a duplicate of a different mutant that was already killed for a different
 * reason. Rewriting it to genuinely reorder the two steps turned it from killed
 * to surviving. The kill had been real; it was just a kill of the wrong thing,
 * and it had been standing in for a property no test actually checked.
 *
 * HOW IT IS ASSERTED. Not by call-order bookkeeping, which only proves the order
 * of two mocks. The `gitStashPop` mock reads the session's `state.json` off disk
 * at the moment it is called, so the assertion is about what the REST OF THE
 * SYSTEM could observe at that instant -- an independent source, not a second
 * reading of the same test's own instrumentation (L-038).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What `state.json` said at the instant the stash restore was invoked. */
const OBSERVED: { atPop: string | null; popCalls: number } = { atPop: null, popCalls: 0 };

function readStateDuringPop(root: string): string | null {
  try {
    const sessionsDir = join(root, ".story", "sessions");
    const entries = readdirSync(sessionsDir);
    for (const entry of entries) {
      try {
        const raw = readFileSync(join(sessionsDir, entry, "state.json"), "utf-8");
        return (JSON.parse(raw) as { state?: string }).state ?? null;
      } catch { /* not this one */ }
    }
  } catch { /* no sessions dir yet */ }
  return null;
}

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123" } }),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn(async (root: string) => {
    OBSERVED.popCalls += 1;
    OBSERVED.atPop = readStateDuringPop(root);
    return { ok: true };
  }),
  gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
}));

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const NOW = new Date().toISOString();

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

function plantSession(root: string, withStash: boolean): { sessionId: string; sessDir: string } {
  const session = createSession(root, "coding", "test-workspace");
  const sessDir = join(root, ".story", "sessions", session.sessionId);
  writeSessionSync(sessDir, {
    ...session,
    state: "IMPLEMENT",
    previousState: "PICK_TICKET",
    mode: "guided",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    git: {
      branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123",
      ...(withStash ? { autoStash: { ref: "stash@{0}", stashedAt: NOW } } : {}),
    },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  return { sessionId: session.sessionId, sessDir };
}

describe("T-450: the auto-stash restore precedes publication", () => {
  let root: string;

  beforeEach(() => {
    OBSERVED.atPop = null;
    OBSERVED.popCalls = 0;
    root = mkdtempSync(join(tmpdir(), "sb-stashorder-"));
    setupProject(root);
  });

  afterEach(() => {
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("COMPATIBILITY INVARIANT: at restore time the session is not yet published as ended", async () => {
    const { sessionId, sessDir } = plantSession(root, true);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    // Non-vacuous first: the restore has to have actually happened, or the
    // assertion below would pass on a null that means "never called".
    expect(OBSERVED.popCalls, "the stash restore ran").toBe(1);
    expect(OBSERVED.atPop, "the session was still live when the stash was restored").toBe("IMPLEMENT");

    // And publication did land afterwards, so this is an ordering assertion
    // rather than an assertion that publication never happened.
    const final = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(final.state).toBe("SESSION_END");
    expect(final.terminationReason).toBe("cancelled");
  });

  it("no auto-stash means no restore attempt", async () => {
    // This pins the no-autoStash branch: no stash recorded means no restore is
    // attempted, so a mutant that popped unconditionally would fail here. It is
    // not what makes a skipped-restore mutant detectable, which an earlier
    // version of this comment claimed; the test above already requires exactly
    // one pop, and that is the assertion doing that work.
    const { sessionId, sessDir } = plantSession(root, false);
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId });
    expect(result.isError).toBeFalsy();

    expect(OBSERVED.popCalls, "nothing to restore, so nothing was attempted").toBe(0);
    const final = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(final.state).toBe("SESSION_END");
  });
});
