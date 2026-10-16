/**
 * ISS-1113 consumers: the two stages that treat "an open issue exists" as
 * "there is work to do".
 *
 * ISSUE_SWEEP had NO disposition awareness at all before this change -- not
 * even ISS-1154's `escalate_only` / `owner_gated` / `duplicate`. It selected
 * on `status === "open"` alone, set the issue it picked to `inprogress`, and
 * then refused to advance until that issue reached `resolved`. Handing it an
 * issue whose whole point is that nobody is going to fix it is therefore not a
 * cosmetic wrong ranking: it is a stage that cannot finish.
 *
 * COMPLETE is here because it is the other half of the same fact. It routes
 * back to PICK_TICKET whenever any open issue remains, so once the sweep
 * started skipping non-actionable issues a project whose only open issues are
 * non-actionable would bounce to PICK_TICKET with nothing to pick.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext } from "../../src/autonomous/stages/types.js";
import { IssueSweepStage } from "../../src/autonomous/stages/issue-sweep.js";
import { NON_ACTIONABLE_DISPOSITIONS } from "../../src/core/issue-disposition.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../src/autonomous/recipes/loader.js";

/**
 * Spelled out rather than only iterated. A test that loops over the very list
 * it is checking shrinks silently when the list does: drop a value from
 * NON_ACTIONABLE_DISPOSITIONS and a loop-only suite stays green while the
 * sweep starts handing that value out as work again.
 */
const EVERY_NON_ACTIONABLE = [
  "escalate_only", "owner_gated", "duplicate",
  "pre_existing", "accepted_out_of_scope", "forced_landing",
] as const;

const TICKET = "t-5w33p00000000001";

function setupProject(root: string): void {
  const storyDir = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(storyDir, sub), { recursive: true });
  }
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-09-18",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(storyDir, "tickets", `${TICKET}.json`), JSON.stringify({
    id: TICKET, displayId: "T-903", title: "Sweep", description: "A test.",
    type: "task", status: "complete", phase: "p1", order: 10,
    createdDate: "2026-09-18", completedDate: "2026-09-18", blockedBy: [],
  }));
}

function writeIssue(
  root: string,
  id: string,
  over: Record<string, unknown> = {},
): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id,
    title: `Issue ${id}`,
    status: "open",
    severity: "high",
    components: [],
    impact: `Impact of ${id}`,
    resolution: null,
    location: [],
    discoveredDate: "2026-09-18",
    resolvedDate: null,
    relatedTickets: [],
    phase: "p1",
    ...over,
  }));
}

function makeRecipe(sweepEnabled: boolean): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: ["ISSUE_SWEEP", "HANDOVER"],
    stages: { ISSUE_SWEEP: { enabled: sweepEnabled } },
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
  } as unknown as ResolvedRecipe;
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-0000000000e1",
    recipe: "coding", state: "ISSUE_SWEEP", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [TICKET],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    ticket: null,
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null,
    codeReviewRoundCounter: null, pendingCeilingEscalation: null,
    issueSweepState: null,
    ...overrides,
  } as FullSessionState;
}

describe("ISSUE_SWEEP does not demand a fix for a non-actionable issue (ISS-1113)", () => {
  let root: string;
  let sDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iss1113-sweep-"));
    setupProject(root);
    sDir = join(root, ".story", "sessions", "s1");
    mkdirSync(sDir, { recursive: true });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  function ctx(): StageContext {
    return new StageContext(root, sDir, makeState(), makeRecipe(true));
  }

  /**
   * All six values, not just the three this slice adds: the filter is written
   * once against the shared list, and a filter that happened to name only the
   * new three would leave the ISS-1154 values still being handed out as work.
   */
  it("covers every value the shared list carries", () => {
    expect([...NON_ACTIONABLE_DISPOSITIONS].sort()).toEqual([...EVERY_NON_ACTIONABLE].sort());
  });

  it("goes straight to HANDOVER when every open issue is non-actionable", async () => {
    EVERY_NON_ACTIONABLE.forEach((disposition, i) => {
      writeIssue(root, `ISS-${String(100 + i)}`, { disposition });
    });
    const advance = await new IssueSweepStage().enter(ctx());
    expect(advance).toMatchObject({ action: "goto", target: "HANDOVER" });
  });

  it("acquires the one actionable issue sitting behind six non-actionable ones", async () => {
    EVERY_NON_ACTIONABLE.forEach((disposition, i) => {
      // Higher severity AND an earlier date, so the sort would put every one of
      // them ahead of the real work if the filter were not there.
      writeIssue(root, `ISS-${String(100 + i)}`, {
        disposition, severity: "critical", discoveredDate: "2026-01-01",
      });
    });
    writeIssue(root, "ISS-200", { severity: "low", discoveredDate: "2026-09-18" });

    const c = ctx();
    const result = await new IssueSweepStage().enter(c);
    expect(result).not.toMatchObject({ action: "goto" });
    expect(c.state.issueSweepState?.current).toBe("ISS-200");
    // Nothing non-actionable was even queued behind it.
    expect(c.state.issueSweepState?.remaining ?? []).toEqual([]);
  });

  /**
   * T-486 U4 A1. enter() filters on a read taken before the acquisition lock,
   * so a disposition set between that read and the lock must be caught on the
   * locked read the write acts on. The injection lands right after enter's
   * read returns.
   */
  it("does not acquire an issue whose disposition was set after enter's filter (T-486 U4 A1)", async () => {
    writeIssue(root, "ISS-200", { severity: "critical" });
    writeIssue(root, "ISS-201", { severity: "low" });
    const c = ctx();
    const original = c.loadProject.bind(c);
    vi.spyOn(c, "loadProject").mockImplementation(async () => {
      const loaded = await original();
      writeIssue(root, "ISS-200", { severity: "critical", disposition: "owner_gated" });
      return loaded;
    });

    const result = await new IssueSweepStage().enter(c);

    expect(result).not.toMatchObject({ action: "goto" });
    expect(c.state.issueSweepState?.current).toBe("ISS-201");
    const skipped = JSON.parse(readFileSync(join(root, ".story", "issues", "ISS-200.json"), "utf-8"));
    expect(skipped.status).toBe("open");
    expect(skipped.disposition).toBe("owner_gated");
  });

  it("still sweeps an issue that carries no disposition at all", async () => {
    writeIssue(root, "ISS-200");
    const c = ctx();
    const result = await new IssueSweepStage().enter(c);
    expect(result).not.toMatchObject({ action: "goto" });
    expect(c.state.issueSweepState?.current).toBe("ISS-200");
  });
});
