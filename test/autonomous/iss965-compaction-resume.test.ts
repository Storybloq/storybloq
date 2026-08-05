/**
 * ISS-965 T4 (round-4 blocker-1 pin): a terminalized session (state HANDOVER,
 * terminalDisposition.kind "completion-observed") must land back at HANDOVER
 * after EITHER parking mechanism -- pre_compact (prepareForCompact) or a
 * usage-limit stop (prepareForLimitStop) -- never rewritten to PICK_TICKET.
 *
 * D2 (round-4 disposition) extended scope to session.ts's two resumeTarget
 * computations. iss965-terminal-routing.test.ts's T3 already drives the
 * prepareForCompact site end to end via handleAutonomousGuide; this file
 * covers prepareForLimitStop directly (session.ts unit level, matching how
 * limit-stop-session.test.ts exercises it) so BOTH D2 sites are pinned, not
 * just one.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  writeSessionSync,
  prepareForCompact,
  prepareForLimitStop,
} from "../../src/autonomous/session.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

let root: string;
let sessDir: string;

function terminalizedState(root: string): FullSessionState {
  const session = createSession(root, "coding", "test-workspace");
  const dir = join(root, ".story", "sessions", session.sessionId);
  const written = writeSessionSync(dir, {
    ...session,
    state: "HANDOVER",
    previousState: "WRITE_TESTS",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    terminalDisposition: {
      kind: "completion-observed",
      ticketId: "T-001",
      observedAt: new Date().toISOString(),
    },
    pendingProjectMutation: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
    reviews: { plan: [], code: [] },
  } as unknown as FullSessionState);
  sessDir = dir;
  return written;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iss965-compact-"));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ISS-965 T4: terminalized session survives BOTH parking mechanisms", () => {
  it("prepareForCompact preserves HANDOVER as the resume target, not PICK_TICKET", () => {
    const state = terminalizedState(root);
    const result = prepareForCompact(sessDir, state, { expectedHead: "abc123" });
    expect(result.preCompactState).toBe("HANDOVER");

    const onDisk = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(onDisk.state).toBe("COMPACT");
    expect(onDisk.preCompactState).toBe("HANDOVER");
    // The old working stage (previousState going INTO terminalization) must not
    // resurface as where a resume would land.
    expect(onDisk.preCompactState).not.toBe("WRITE_TESTS");
    expect(onDisk.preCompactState).not.toBe("PICK_TICKET");
  });

  it("prepareForLimitStop ALSO preserves HANDOVER as the resume target (the second D2 site)", () => {
    const state = terminalizedState(root);
    const result = prepareForLimitStop(sessDir, state, {
      resumeAt: Date.now() + 3600_000,
      limitEventId: "limit-evt-1",
    });
    expect(result.preCompactState).toBe("HANDOVER");

    const onDisk = JSON.parse(readFileSync(join(sessDir, "state.json"), "utf-8")) as FullSessionState;
    expect(onDisk.state).toBe("COMPACT");
    expect(onDisk.preCompactState).toBe("HANDOVER");
    expect(onDisk.preCompactState).not.toBe("WRITE_TESTS");
    expect(onDisk.preCompactState).not.toBe("PICK_TICKET");
  });

  it("an ORDINARY (non-terminalized) HANDOVER still rewrites to PICK_TICKET -- the pre-existing behavior is unchanged", () => {
    // Negative control: without terminalDisposition, resolveCompactResumeTarget
    // must fall through to the ordinary HANDOVER -> PICK_TICKET rewrite. If this
    // ever passed while the two tests above ALSO passed by some over-broad
    // "always preserve HANDOVER" mutant, this is the one that would catch it.
    const session = createSession(root, "coding", "test-workspace");
    const dir = join(root, ".story", "sessions", session.sessionId);
    const state = writeSessionSync(dir, {
      ...session,
      state: "HANDOVER",
      previousState: "ISSUE_SWEEP",
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123" },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    const result = prepareForCompact(dir, state, { expectedHead: "abc123" });
    expect(result.preCompactState).toBe("PICK_TICKET");
  });
});
