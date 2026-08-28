/**
 * T-475 section 5: the three SKIP sites (PLAN, PLAN_REVIEW, CODE_REVIEW) each
 * additionally clear a same-session assigned earmark in the same locked
 * operation that already releases the claim -- this is how self-decline
 * works, there is no separate "decline an assignment" CLI verb.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PlanStage } from "../../../src/autonomous/stages/plan.js";
import { PlanReviewStage } from "../../../src/autonomous/stages/plan-review.js";
import { CodeReviewStage } from "../../../src/autonomous/stages/code-review.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_SESSION = "ffffffff-0000-0000-0000-000000000009";
const NOW = new Date().toISOString();
const ARRANGEMENT_ID = "a-0123456789abcdef";
const RESERVED_BY = { client: "claude" as const, id: "pen-task-1" };

function earmarkFor(holderSession: string): Record<string, unknown> {
  return {
    stage: "assigned",
    reservedBy: RESERVED_BY,
    arrangementId: ARRANGEMENT_ID,
    since: NOW,
    holderRole: "worker",
    holderSession,
  };
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "PLAN",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "story/T-001-test", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
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
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    resolvedBranchStrategy: "per-ticket",
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    branchStrategy: "per-ticket",
    defaults: { maxTicketsPerSession: 3, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

function writeStoryProject(testRoot: string, ticket: Record<string, unknown>, issue?: Record<string, unknown>): void {
  for (const dir of ["tickets", "issues", "notes", "handovers"]) {
    mkdirSync(join(testRoot, ".story", dir), { recursive: true });
  }
  writeFileSync(
    join(testRoot, ".story", "config.json"),
    JSON.stringify({
      version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
    "utf-8",
  );
  writeFileSync(
    join(testRoot, ".story", "roadmap.json"),
    JSON.stringify({
      title: "test", date: "2026-01-01",
      phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Desc." }],
      blockers: [],
    }),
    "utf-8",
  );
  writeFileSync(join(testRoot, ".story", "tickets", "T-001.json"), JSON.stringify(ticket, null, 2), "utf-8");
  if (issue) {
    writeFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), JSON.stringify(issue, null, 2), "utf-8");
  }
}

const baseTicket = {
  id: "T-001", title: "Test ticket", description: "A test.", type: "task",
  status: "inprogress", phase: "p1", order: 10,
  createdDate: "2026-01-01", completedDate: null, blockedBy: [],
};

const baseIssue = {
  id: "ISS-001", title: "Test issue", status: "inprogress", severity: "medium",
  components: [], impact: "impact", resolution: null, location: [],
  discoveredDate: "2026-01-01", resolvedDate: null, relatedTickets: [],
};

function readTicket(testRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(testRoot, ".story", "tickets", "T-001.json"), "utf-8"));
}

function readIssue(testRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(testRoot, ".story", "issues", "ISS-001.json"), "utf-8"));
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "skip-earmark-"));
  sessionDir = join(testRoot, ".story", "sessions", SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe.each([
  { name: "PLAN", Stage: PlanStage, state: "PLAN" as const },
  { name: "PLAN_REVIEW", Stage: PlanReviewStage, state: "PLAN_REVIEW" as const },
  { name: "CODE_REVIEW (ticket)", Stage: CodeReviewStage, state: "CODE_REVIEW" as const },
])("$name skip_ticket clears a same-session earmark (T-475 section 5)", ({ Stage, state: stageState }) => {
  it("clears this session's assigned earmark alongside the claim it releases", async () => {
    writeStoryProject(testRoot, {
      ...baseTicket,
      claimedBySession: SESSION_ID,
      claim: { user: "me@example.com", branch: "story/T-001-test", since: NOW },
      earmark: earmarkFor(SESSION_ID),
    });
    const state = makeState({ state: stageState, ticket: { id: "T-001", title: "Test ticket", claimed: true } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new Stage();

    await stage.report(ctx, { completedAction: "skip_ticket", notes: "cannot do" });

    const ticket = readTicket(testRoot);
    expect(ticket.status).toBe("open");
    expect(ticket.earmark).toBeNull();
  });

  it("clears a same-session earmark even when there is no claim yet to release", async () => {
    // The choke point can convert an earmark at PICK time, before PLAN's own
    // plan_written report ever lands a claim -- so skip_ticket must still
    // clear it even though releaseSessionClaim finds nothing to release.
    writeStoryProject(testRoot, { ...baseTicket, status: "open", earmark: earmarkFor(SESSION_ID) });
    const state = makeState({ state: stageState, ticket: { id: "T-001", title: "Test ticket", claimed: true } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new Stage();

    await stage.report(ctx, { completedAction: "skip_ticket", notes: "cannot do" });

    const ticket = readTicket(testRoot);
    expect(ticket.earmark).toBeNull();
  });

  it("does not clear a DIFFERENT session's earmark", async () => {
    const foreignEarmark = earmarkFor(OTHER_SESSION);
    writeStoryProject(testRoot, {
      ...baseTicket,
      claimedBySession: SESSION_ID,
      claim: { user: "me@example.com", branch: "story/T-001-test", since: NOW },
      earmark: foreignEarmark,
    });
    const state = makeState({ state: stageState, ticket: { id: "T-001", title: "Test ticket", claimed: true } });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new Stage();

    await stage.report(ctx, { completedAction: "skip_ticket", notes: "cannot do" });

    const ticket = readTicket(testRoot);
    expect(ticket.earmark).toEqual(foreignEarmark);
  });
});

describe("CODE_REVIEW skip_ticket (issue path) clears a same-session earmark (T-475 section 5)", () => {
  it("clears this session's assigned earmark on the current issue", async () => {
    writeStoryProject(testRoot, baseTicket, { ...baseIssue, earmark: earmarkFor(SESSION_ID) });
    const state = makeState({
      state: "CODE_REVIEW",
      ticket: null,
      currentIssue: { id: "ISS-001", title: "Test issue", severity: "medium" },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new CodeReviewStage();

    await stage.report(ctx, { completedAction: "skip_ticket", notes: "cannot do" });

    const issue = readIssue(testRoot);
    expect(issue.status).toBe("open");
    expect(issue.earmark).toBeNull();
  });

  it("does not clear a DIFFERENT session's earmark on the current issue", async () => {
    const foreignEarmark = earmarkFor(OTHER_SESSION);
    writeStoryProject(testRoot, baseTicket, { ...baseIssue, earmark: foreignEarmark });
    const state = makeState({
      state: "CODE_REVIEW",
      ticket: null,
      currentIssue: { id: "ISS-001", title: "Test issue", severity: "medium" },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new CodeReviewStage();

    await stage.report(ctx, { completedAction: "skip_ticket", notes: "cannot do" });

    const issue = readIssue(testRoot);
    expect(issue.earmark).toEqual(foreignEarmark);
  });
});
