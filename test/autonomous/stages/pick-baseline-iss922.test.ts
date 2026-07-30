/**
 * ISS-922, pick side: PICK_TICKET establishes the item's finalization baseline
 * from a FRESH head, and refuses the pick when it cannot resolve one.
 *
 * The baseline cannot come from the cached `git.expectedHead`. That field
 * records the last OBSERVED head and has no updater for ordinary
 * active-session drift, so HEAD can move between COMPLETE and the next pick
 * while branch strategy "current" refreshes nothing. A stale baseline makes a
 * pre-existing commit read as this item's work -- the same class of failure
 * this issue exists to close, arriving from the other direction.
 *
 * Real temporary repositories throughout: a mocked gitHead would let an
 * implementation that reads the cached value pass every assertion here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { handleAutonomousGuide } from "../../../src/autonomous/guide.js";
import { createSession, writeSessionSync } from "../../../src/autonomous/session.js";
import { killSidecarsInRoot } from "../_sidecar-cleanup.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}
const head = (root: string): string => git(root, ["rev-parse", "HEAD"]);
const branchOf = (root: string): string => git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "iss922-pick-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss922", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "iss922", date: "2026-07-30",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

function writeTicket(root: string, id: string): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: `Ticket ${id}`, type: "task", status: "open", phase: "p1",
    order: 10, description: "", createdDate: "2026-07-30", completedDate: null,
    blockedBy: [], parentTicket: null,
  }));
}

function writeIssue(root: string, id: string): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-07-30",
    resolvedDate: null, relatedTickets: [], order: 10,
  }));
}

/** Advance HEAD behind the session's back, as another process or the operator would. */
function driftHead(root: string): string {
  writeFileSync(join(root, `drift-${Date.now()}.txt`), "x\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "external drift"]);
  return head(root);
}

function makeState(root: string, staleHead: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-00000000922b",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    // Deliberately stale: this is what a cached-baseline implementation would use.
    git: { branch: branchOf(root), mergeBase: staleHead, expectedHead: staleHead, initHead: staleHead, autoStash: null },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ...overrides,
  } as unknown as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "IMPLEMENT", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "current",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  } as unknown as ResolvedRecipe;
}

const stage = new PickTicketStage();

const staleHeadOf = (root: string): string => head(root);

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

/** The state the stage staged, whether it went through updateDraft or writeState. */
function draftedGit(ctx: StageContext): Record<string, unknown> {
  const s = ctx.state as unknown as { git: Record<string, unknown> };
  const d = (ctx as unknown as { draft?: Partial<FullSessionState> }).draft;
  return (d?.git as Record<string, unknown> | undefined) ?? s.git;
}

describe("ISS-922: the pick baseline is a fresh head, not the cached one", () => {
  let root: string;
  let staleHead: string;

  beforeEach(() => {
    root = buildRepo();
    staleHead = head(root);
    mkdirSync(join(root, ".story", "sessions", "s"), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a ticket pick takes the CURRENT head after external drift, not the cached value", async () => {
    writeTicket(root, "T-001");
    const drifted = driftHead(root);
    expect(drifted).not.toBe(staleHead);

    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(root, staleHead), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action, "the pick should have advanced").toBe("advance");
    expect(draftedGit(ctx).itemBaseHead, "baseline is stale -- a pre-existing commit would read as this item's work")
      .toBe(drifted);
  });

  it("an issue pick takes the CURRENT head after external drift", async () => {
    writeIssue(root, "ISS-001");
    const drifted = driftHead(root);

    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(root, staleHead), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(result.action).toBe("goto");
    expect(draftedGit(ctx).itemBaseHead).toBe(drifted);
  });
});

describe("ISS-922: a pick that cannot resolve HEAD fails closed", () => {
  let root: string;
  let staleHead: string;

  beforeEach(() => {
    root = buildRepo();
    staleHead = head(root);
    mkdirSync(join(root, ".story", "sessions", "s"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Asserts the invariant that matters: NO ITEM TRANSITION AND NO LEDGER
   * MUTATION. Not "nothing persisted" -- processAdvance increments
   * stuckRetryCount on every retry, and a branch strategy that already
   * succeeded legitimately records its checkout, INCLUDING itemBaseHead, before
   * the baseline resolve runs. The strategy here is "current", so nothing moved
   * the repository and itemBaseHead must still be absent; the checkout case is
   * covered separately below, where persisting it is correct.
   */
  it("refuses the issue pick and leaves the ledger untouched", async () => {
    writeIssue(root, "ISS-001");
    const state = makeState(root, staleHead);
    // Break HEAD resolution the way a broken worktree would, without touching
    // the module under test: git itself starts failing.
    rmSync(join(root, ".git"), { recursive: true, force: true });

    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(result.action).toBe("retry");
    expect((result as { instruction?: string }).instruction).toContain("was NOT picked");
    expect((result as { instruction?: string }).instruction).toContain("git status");

    // No item picked...
    expect(ctx.state.state).toBe("PICK_TICKET");
    expect(ctx.state.currentIssue ?? null).toBeNull();
    expect(ctx.state.ticket ?? undefined).toBeUndefined();
    expect(ctx.state.finalizeCheckpoint ?? null).toBeNull();
    // Strategy "current" performs no checkout, so nothing may have set this.
    expect(ctx.state.git.itemBaseHead ?? null).toBeNull();

    // ...and the issue was NOT moved to inprogress, because the resolve sits
    // ahead of the ledger mutation.
    const issue = JSON.parse(
      execFileSync("cat", [join(root, ".story", "issues", "ISS-001.json")]).toString(),
    ) as { status: string };
    expect(issue.status).toBe("open");
  });

  it("refuses the ticket pick", async () => {
    writeTicket(root, "T-001");
    const state = makeState(root, staleHead);
    rmSync(join(root, ".git"), { recursive: true, force: true });

    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action).toBe("retry");
    expect((result as { instruction?: string }).instruction).toContain("was NOT picked");
    expect(ctx.state.ticket ?? undefined).toBeUndefined();
  });
});

/**
 * The case the invariant above deliberately excludes: branch strategy really
 * checked out a branch and recorded it -- including itemBaseHead -- and only
 * THEN did the baseline resolve fail. The recorded checkout is correct and must
 * survive on disk; the pick still must not happen.
 *
 * Driven through handleAutonomousGuide, not the stage: processAdvance is what
 * persists a retry state, so a stage-level assertion would prove the in-memory
 * draft and nothing about state.json.
 */
describe("ISS-922: a checkout that lands before the baseline resolve fails still refuses the pick", () => {
  let root: string;

  beforeEach(() => {
    root = buildRepo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  });

  it("persists the branch bookkeeping, picks nothing, and leaves the issue open", async () => {
    const inspector = await import("../../../src/autonomous/git-inspector.js");
    const realGitHead = inspector.gitHead;

    // Keyed on the real checkout rather than a raw call count, so calls the
    // guide makes before the stage cannot shift the trigger. Everything while
    // HEAD is still on main succeeds; the first read after the checkout is
    // refreshGitWorkingState's and must succeed too, or branch strategy fails
    // and we never reach the code under test; the next one is the ISS-922
    // baseline resolve, and that is the one failed here.
    let afterCheckout = 0;
    vi.spyOn(inspector, "gitHead").mockImplementation(async (cwd: string) => {
      const real = await realGitHead(cwd);
      if (real.ok && real.data.branch === "main") return real;
      afterCheckout += 1;
      if (afterCheckout === 1) return real;
      return { ok: false as const, reason: "git_error" as const, message: "simulated" };
    });

    writeIssue(root, "ISS-001");
    const session = createSession(root, "coding", "test-workspace");
    const sessDir = join(root, ".story", "sessions", session.sessionId);
    writeSessionSync(sessDir, {
      ...session,
      state: "PICK_TICKET",
      resolvedBranchStrategy: "per-ticket",
      git: { branch: "main", mergeBase: staleHeadOf(root), expectedHead: staleHeadOf(root), initHead: staleHeadOf(root), autoStash: null },
      reviews: { plan: [], code: [] },
    } as unknown as FullSessionState);

    const result = await handleAutonomousGuide(root, {
      action: "report",
      sessionId: session.sessionId,
      report: { completedAction: "issue_picked", issueId: "ISS-001" },
    } as never);

    expect(afterCheckout, "the baseline resolve was never reached").toBeGreaterThanOrEqual(2);
    expect(branchOf(root), "the checkout must really have happened before the failure").not.toBe("main");
    expect(textOf(result)).toContain("was NOT picked");

    const persisted = JSON.parse(
      readFileSync(join(sessDir, "state.json"), "utf8"),
    ) as FullSessionState;

    // The checkout's own bookkeeping is legitimate and DURABLE -- this is what
    // the "current"-strategy invariant above must not assert away.
    expect(persisted.git.branch, "the refreshed branch must survive the refusal").not.toBe("main");
    // The VALUE, not merely presence: a stale or arbitrary hash here would
    // recreate the stale-baseline failure from the other direction.
    expect(persisted.git.itemBaseHead, "the baseline must follow the relocated HEAD")
      .toBe(head(root));
    expect(persisted.git.expectedHead, "the observation must follow it too").toBe(head(root));

    // No item transition...
    expect(persisted.state).toBe("PICK_TICKET");
    expect(persisted.currentIssue ?? null).toBeNull();
    expect(persisted.ticket ?? null).toBeNull();

    // ...and no ledger mutation.
    const issue = JSON.parse(
      readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf8"),
    ) as { status: string };
    expect(issue.status).toBe("open");
  });
});
