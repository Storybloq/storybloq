/**
 * ISS-1032: `parkCurrentIssue` (park.ts), the CODE_REVIEW ceiling's
 * issue-shaped park target. Ratified plan-run6.md B5, hash
 * fae15038ecfb022e94e5578db98bc265b1e9d5fed3a6ec5ff692e4fced2730ef.
 *
 * Structurally mirrors `parkCurrentTicket`'s resumability contract, but has
 * no claim analogue: ownership is proven by `current.status === "resolved"`
 * (the state THIS session itself established leaving ISSUE_FIX) plus the
 * earmark checks -- for a LEGACY issue (no stamped `resolutionEpoch`). A
 * post-Amendment-A5 issue additionally requires an exact `resolutionEpoch`
 * match between the issue and this session's mirrored copy (see
 * `issue-resolution-epoch.ts`); see the "[Amendment A5]" tests below. These
 * tests drive `parkCurrentIssue` directly
 * (mirroring `code-review-ceiling.test.ts`'s "end to end through the stage"
 * pattern) rather than through the agent-facing `park_item` action, since
 * CODE_REVIEW is deliberately excluded from `PARK_STAGES` -- this park is
 * only ever pipeline-invoked, from `escalateCeiling`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parkCurrentIssue } from "../../../src/autonomous/stages/park.js";
import { StageContext } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState, GuideReportInput } from "../../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../../src/autonomous/recipes/loader.js";
import * as projectLoader from "../../../src/core/project-loader.js";

const SESSION_ID = "00000000-0000-0000-0000-0000000000c7";
const OTHER_SESSION_ID = "ffffffff-0000-0000-0000-000000000009";
const ISSUE_ID = "i-abc1230000000001";

function setupProject(root: string): void {
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-08-28",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
}

function writeIssue(root: string, over: Record<string, unknown> = {}): void {
  writeFileSync(join(root, ".story", "issues", `${ISSUE_ID}.json`), JSON.stringify({
    id: ISSUE_ID, title: "Non-converging fix", status: "resolved", severity: "high",
    components: [], impact: "test", resolution: "fixed in this session", location: [],
    discoveredDate: "2026-08-28", resolvedDate: "2026-08-28", relatedTickets: [],
    order: 10, phase: "p1",
    ...over,
  }));
}

function readIssue(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "issues", `${ISSUE_ID}.json`), "utf-8"));
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
  } as unknown as ResolvedRecipe;
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: SESSION_ID,
    recipe: "coding", state: "CODE_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["lenses"] },
    ticket: undefined,
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [],
    currentIssue: { id: ISSUE_ID, displayId: "ISS-901", title: "Non-converging fix", severity: "high" },
    codeReviewRoundCounter: null, pendingCeilingEscalation: null,
    ...overrides,
  } as FullSessionState;
}

let root: string;
let sDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "park-issue-"));
  setupProject(root);
  sDir = join(root, ".story", "sessions", "s1");
  mkdirSync(sDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function ctxWith(overrides: Partial<FullSessionState> = {}): StageContext {
  return new StageContext(root, sDir, makeState(overrides), makeRecipe());
}

async function park(ctx: StageContext, reason = "Review would not converge.") {
  return parkCurrentIssue(
    ctx,
    { notes: reason } as GuideReportInput,
    "CODE_REVIEW",
    { reason, target: "HANDOVER" },
  );
}

/**
 * Amendment A3 (pen ack): every terminal park -- parked or not-ours -- carries
 * a `result` mirroring `parkCurrentTicket`'s HANDOVER shape: the reason, and
 * the ceiling-specific reminder trio without which a driving agent can bounce
 * straight back into the loop the ceiling just stopped.
 */
function expectParkedHandover(advance: unknown, reason: string): void {
  const a = advance as { action: string; target: string; result: { instruction: string; reminders: string[] } };
  expect(a.action).toBe("goto");
  expect(a.target).toBe("HANDOVER");
  expect(a.result.instruction).toContain(reason);
  expect(a.result.reminders).toContain("Do NOT re-pick the parked item.");
  expect(a.result.reminders).toContain("Do NOT keep reviewing -- the round ceiling was reached.");
  expect(a.result.reminders).toContain("Write the handover, then stop.");
}

describe("parkCurrentIssue outcomes [R1-FIX 6, R2-FIX 1, R3-FIX 1]", () => {
  it("requires a reason", async () => {
    writeIssue(root);
    const ctx = ctxWith();
    const advance = await parkCurrentIssue(ctx, { notes: "" } as GuideReportInput, "CODE_REVIEW", {});
    expect(advance.action).toBe("retry");
    expect((advance as { instruction: string }).instruction).toContain("requires a reason");
  });

  it("[missing issue] retries when the session holds no current issue", async () => {
    const ctx = ctxWith({ currentIssue: null });
    const advance = await park(ctx);
    expect(advance.action).toBe("retry");
    expect((advance as { instruction: string }).instruction).toContain("holds no current issue");
  });

  it("[externally reopened] a status drifted off \"resolved\" is not-ours: goto HANDOVER, issue left structurally unchanged", async () => {
    writeIssue(root, { status: "open", resolution: null, resolvedDate: null });
    const before = readIssue(root);
    const ctx = ctxWith();
    const advance = await park(ctx);
    expectParkedHandover(advance, "Review would not converge.");
    expect(ctx.state.currentIssue).toBeNull();
    expect(readIssue(root)).toEqual(before);
  });

  it("[foreign assigned earmark] not-ours: goto HANDOVER, issue left structurally unchanged (status included, not merely the earmark)", async () => {
    writeIssue(root, {
      earmark: {
        stage: "assigned", holderRole: "worker", holderSession: OTHER_SESSION_ID,
        reservedBy: { client: "claude", id: "pen-task-1" }, arrangementId: "a-0123456789abcdef",
        since: new Date().toISOString(),
      },
    });
    const before = readIssue(root);
    const ctx = ctxWith();
    const advance = await park(ctx);
    expectParkedHandover(advance, "Review would not converge.");
    expect(readIssue(root)).toEqual(before);
  });

  it("[write failure] retries and retains currentIssue", async () => {
    writeIssue(root);
    const before = readIssue(root);
    vi.spyOn(projectLoader, "writeIssueUnlocked").mockRejectedValueOnce(new Error("disk full"));
    const ctx = ctxWith();
    const advance = await park(ctx);
    expect(advance.action).toBe("retry");
    expect((advance as { instruction: string }).instruction).toContain("Failed to reopen issue");
    expect(ctx.state.currentIssue).not.toBeNull();
    // The failed write must not have landed partway.
    expect(readIssue(root)).toEqual(before);
  });

  it("[idempotent resume] parks once, and a resumed call over the now-reopened issue still lands on the same terminal action", async () => {
    writeIssue(root);
    const first = await park(ctxWith());
    expectParkedHandover(first, "Review would not converge.");
    const afterFirst = readIssue(root);
    expect(afterFirst.status).toBe("open");

    // A fresh call, as `resumeCeilingEscalation` would make on the next guide
    // call if the transition itself did not complete durably -- the issue is
    // now "open" (already parked), so this reads as not-ours rather than
    // re-parking, but the terminal action is identical either way.
    const second = await park(ctxWith());
    expectParkedHandover(second, "Review would not converge.");
    expect(readIssue(root)).toEqual(afterFirst);
  });

  it("[happy path] parks: status flips to open, a same-session assigned earmark is cleared", async () => {
    writeIssue(root, {
      earmark: {
        stage: "assigned", holderRole: "worker", holderSession: SESSION_ID,
        reservedBy: { client: "claude", id: "pen-task-1" }, arrangementId: "a-0123456789abcdef",
        since: new Date().toISOString(),
      },
    });
    const ctx = ctxWith();
    const advance = await park(ctx);
    expectParkedHandover(advance, "Review would not converge.");
    expect(ctx.state.currentIssue).toBeNull();
    const after = readIssue(root);
    expect(after.status).toBe("open");
    expect(after.earmark).toBeNull();
  });

  /**
   * Amendment A1 (pen, gate-1 ack): a `reserved` earmark names no session to
   * match against -- `clearSameSessionEarmark` never touches it (earmarks.ts)
   * -- so it must survive BYTE-IDENTICAL through a park that still flips
   * status to `open`, exactly like `clearSameSessionEarmark`'s own documented
   * contract for a `reserved` stage.
   */
  it("[Amendment A1] a reserved-stage earmark survives byte-identical while status still flips to open", async () => {
    const reservedEarmark = {
      stage: "reserved", holderRole: "pen", holderSession: null,
      reservedBy: { client: "claude", id: "pen-task-1" }, arrangementId: "a-0123456789abcdef",
      since: new Date().toISOString(),
    };
    writeIssue(root, { earmark: reservedEarmark });
    const ctx = ctxWith();
    const advance = await park(ctx);
    expectParkedHandover(advance, "Review would not converge.");
    const after = readIssue(root);
    expect(after.status).toBe("open");
    expect(after.earmark).toEqual(reservedEarmark);
  });

  /**
   * Amendment A5 (pen ruling, codex round-1 finding #2): the ABA hazard that
   * `status === "resolved"` alone cannot detect. A FOREIGN session resolves,
   * reopens, and re-resolves the same issue -- minting its OWN resolution
   * epoch on the second resolve -- entirely between this session's earlier
   * ISSUE_FIX write and its later park call. `status` reads "resolved"
   * throughout, byte-identical to this session's own success case, but the
   * epoch now belongs to the other session. The park must refuse: not-ours,
   * issue left exactly as the foreign session last wrote it.
   */
  it("[Amendment A5, ABA hazard] a foreign resolve-reopen-resolve cycle between this session's writes and its park is not-ours, even though status still reads resolved", async () => {
    const myEpoch = {
      issueId: ISSUE_ID, sessionId: SESSION_ID,
      establishedAt: "2026-08-28T00:00:00.000Z",
    };
    // This session's own ISSUE_FIX write, as issue-fix.ts would have left it.
    writeIssue(root, { resolutionEpoch: myEpoch });

    // A foreign session's ABA cycle: reopen, then re-resolve with a NEW epoch.
    const foreignEpoch = {
      issueId: ISSUE_ID, sessionId: OTHER_SESSION_ID,
      establishedAt: "2026-08-28T01:00:00.000Z",
    };
    writeIssue(root, { resolutionEpoch: foreignEpoch });
    const before = readIssue(root);

    // This session's session state still carries only ITS OWN epoch -- it
    // never observed the foreign cycle.
    const ctx = ctxWith({ issueResolutionEpoch: myEpoch } as Partial<FullSessionState>);
    const advance = await park(ctx);

    expectParkedHandover(advance, "Review would not converge.");
    expect(readIssue(root)).toEqual(before);
  });

  /**
   * [codex round-2 finding #7] the exact-match SUCCESS path was previously
   * unexercised end-to-end: unit tests covered `issueEpochProvesOwnership`
   * in isolation, and the ABA test covers a MISMATCH, but nothing proved
   * `parkCurrentIssue` reads the right passthrough keys off the right
   * objects and actually parks when a genuinely matching epoch is present on
   * both sides. A wiring regression (e.g. reading the wrong key name) could
   * make every post-A5 issue read not-ours while the rest of this suite
   * stayed green.
   */
  it("[Amendment A5, exact match] a stamped epoch that exactly matches the session's mirrored copy parks normally", async () => {
    const myEpoch = {
      issueId: ISSUE_ID, sessionId: SESSION_ID,
      establishedAt: "2026-08-28T00:00:00.000Z",
    };
    writeIssue(root, { resolutionEpoch: myEpoch });
    const ctx = ctxWith({ issueResolutionEpoch: myEpoch } as Partial<FullSessionState>);
    const advance = await park(ctx);
    expectParkedHandover(advance, "Review would not converge.");
    expect(ctx.state.currentIssue).toBeNull();
    const after = readIssue(root);
    expect(after.status).toBe("open");
    expect(after.resolutionEpoch).toEqual(myEpoch);
  });

  it("[Amendment A5, legacy match] an issue with no stamped epoch still parks on status alone, unaffected by A5", async () => {
    writeIssue(root); // no resolutionEpoch field at all
    const ctx = ctxWith(); // no issueResolutionEpoch on session state either
    const advance = await park(ctx);
    expectParkedHandover(advance, "Review would not converge.");
    const after = readIssue(root);
    expect(after.status).toBe("open");
  });
});
