import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";

/**
 * T-328 / D2: `branchStrategy: "main"`.
 *
 * These run against real temporary repositories on purpose. A mocked
 * gitCheckoutBranch would let an implementation that never actually switched
 * branches pass every assertion here, which is precisely the failure mode
 * (ISS-892) this stage is supposed to stop making: reporting success while
 * doing nothing.
 *
 * The negative cases carry as much weight as the positive one. "main" must
 * never move the repository when the pick is ineligible, and it must never
 * move it under `current` / legacy `none`.
 */

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

function currentBranch(root: string): string {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function branchNames(root: string): string[] {
  return git(root, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean);
}

/**
 * A repo whose default branch is `defaultBranch`, with an extra feature branch
 * checked out so every test starts somewhere that is NOT the target.
 */
function buildRepo(options?: {
  defaultBranch?: string;
  alsoCreate?: string[];
  startOn?: string;
}): string {
  const defaultBranch = options?.defaultBranch ?? "main";
  const root = mkdtempSync(join(tmpdir(), "t328-main-"));
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "t328-main", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "t328", date: "2026-07-28",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(root, "README.md"), "fixture\n");

  git(root, ["init", "-q", "-b", defaultBranch]);
  git(root, ["config", "user.email", "test@test.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture"]);

  for (const extra of options?.alsoCreate ?? []) git(root, ["branch", extra]);
  git(root, ["checkout", "-q", "-b", options?.startOn ?? "feature/unrelated"]);
  return root;
}

function writeTicket(root: string, id: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: `Ticket ${id}`, type: "task", status: "open", phase: "p1",
    order: 10, description: "", createdDate: "2026-07-28", completedDate: null,
    blockedBy: [], parentTicket: null, ...overrides,
  }));
}

function writeIssue(root: string, id: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-07-28",
    resolvedDate: null, relatedTickets: [], order: 10, ...overrides,
  }));
}

function makeState(root: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-00000000t328",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: currentBranch(root), mergeBase: null, expectedHead: undefined },
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
  } as FullSessionState;
}

function makeRecipe(branchStrategy: string): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    branchStrategy: branchStrategy as ResolvedRecipe["branchStrategy"],
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

function contextFor(root: string, branchStrategy: string, stateOverrides: Partial<FullSessionState> = {}): StageContext {
  const state = makeState(root, {
    resolvedBranchStrategy: branchStrategy,
    ...stateOverrides,
  } as Partial<FullSessionState>);
  const dir = join(root, ".story", "sessions", state.sessionId);
  mkdirSync(dir, { recursive: true });
  return new StageContext(root, dir, state, makeRecipe(branchStrategy));
}

const roots: string[] = [];
function track(root: string): string { roots.push(root); return root; }

beforeEach(() => { /* fixtures are per-test */ });
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Resolution contract: main-preferred, master fallback, local-only
// ---------------------------------------------------------------------------

describe("branchStrategy 'main': which branch it resolves to", () => {
  it("switches from a feature branch to main", async () => {
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    const ctx = contextFor(root, "main");

    const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(result.action, JSON.stringify(result)).toBe("advance");
    expect(currentBranch(root)).toBe("main");
  });

  it("refreshes the recorded git state after the switch", async () => {
    // A checkout that leaves session state pointing at the old branch is worse
    // than no checkout: every later stage reasons from a branch it is not on.
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    // Something dirty and something untracked, so the refreshed baseline has
    // observable content rather than three empty containers that any stale or
    // missing refresh would also produce.
    git(root, ["checkout", "-q", "main"]);
    writeFileSync(join(root, "tracked-dirty.txt"), "v1\n");
    git(root, ["add", "tracked-dirty.txt"]);
    git(root, ["commit", "-q", "-m", "add tracked file"]);
    git(root, ["checkout", "-q", "feature/unrelated"]);
    git(root, ["merge", "-q", "main"]);
    writeFileSync(join(root, "tracked-dirty.txt"), "locally modified\n");
    writeFileSync(join(root, "untracked.txt"), "new\n");

    const ctx = contextFor(root, "main");

    await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(ctx.state.git?.branch).toBe("main");
    expect(ctx.state.git?.expectedHead).toBe(git(root, ["rev-parse", "HEAD"]));

    // The dirty-file gates in later stages compare against this baseline. If it
    // is not recaptured after the switch, they diff post-checkout reality
    // against pre-checkout bookkeeping.
    const baseline = (ctx.state.git as { baseline?: {
      porcelain: string[];
      dirtyTrackedFiles: Record<string, { blobHash: string }>;
      untrackedPaths: string[];
    } }).baseline;
    expect(baseline, "the checkout did not recapture the working-tree baseline").toBeDefined();
    expect(baseline!.untrackedPaths).toContain("untracked.txt");
    expect(Object.keys(baseline!.dirtyTrackedFiles)).toContain("tracked-dirty.txt");
    expect(baseline!.dirtyTrackedFiles["tracked-dirty.txt"]!.blobHash)
      .toBe(git(root, ["hash-object", "tracked-dirty.txt"]));
    expect(baseline!.porcelain.some((l) => l.includes("tracked-dirty.txt"))).toBe(true);
  });

  it("falls back to master when main does not exist", async () => {
    const root = track(buildRepo({ defaultBranch: "master" }));
    writeTicket(root, "T-100");
    const ctx = contextFor(root, "main");

    await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(currentBranch(root)).toBe("master");
  });

  it("prefers main when both main and master exist", async () => {
    // The documented contract is main-PREFERRED, not default-branch-aware. A
    // repo can keep a vestigial main while master is its real default; this
    // pins that we take main and do not silently start detecting trunk.
    const root = track(buildRepo({ defaultBranch: "master", alsoCreate: ["main"] }));
    writeTicket(root, "T-100");
    const ctx = contextFor(root, "main");

    await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(currentBranch(root)).toBe("main");
  });

  it("uses the local ref even when the remote is ahead, and does not fetch", async () => {
    // Resolution is local-only by contract. This pins that no future change
    // quietly introduces network access or history mutation.
    const root = track(buildRepo());
    const remote = track(mkdtempSync(join(tmpdir(), "t328-remote-")));
    git(remote, ["init", "-q", "--bare", "-b", "main"]);
    git(root, ["remote", "add", "origin", remote]);
    git(root, ["push", "-q", "origin", "main"]);

    // Advance origin/main beyond local main, from a throwaway clone.
    const clone = track(mkdtempSync(join(tmpdir(), "t328-clone-")));
    git(clone, ["clone", "-q", remote, "."]);
    git(clone, ["config", "user.email", "test@test.com"]);
    git(clone, ["config", "user.name", "Test"]);
    writeFileSync(join(clone, "remote-only.txt"), "ahead\n");
    git(clone, ["add", "."]);
    git(clone, ["commit", "-q", "-m", "remote ahead"]);
    git(clone, ["push", "-q", "origin", "main"]);

    const localMainBefore = git(root, ["rev-parse", "main"]);
    // Captured BEFORE the stage runs: a fetch would advance this ref while
    // leaving local main alone, so local main by itself cannot detect one.
    const trackingBefore = git(root, ["rev-parse", "refs/remotes/origin/main"]);
    writeTicket(root, "T-100");
    // The bare repo really is ahead. If the stage fetched, root's tracking ref
    // would move to this hash.
    const remoteHead = git(remote, ["rev-parse", "refs/heads/main"]);
    expect(remoteHead, "fixture failed to advance the remote").not.toBe(localMainBefore);
    const ctx = contextFor(root, "main");

    await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(currentBranch(root)).toBe("main");
    expect(git(root, ["rev-parse", "main"]), "local main moved").toBe(localMainBefore);
    expect(git(root, ["rev-parse", "refs/remotes/origin/main"]), "the stage fetched")
      .toBe(trackingBefore);
    expect(git(root, ["rev-parse", "refs/remotes/origin/main"])).not.toBe(remoteHead);
  });
});

// ---------------------------------------------------------------------------
// Failures are loud. None of these may advance.
// ---------------------------------------------------------------------------

describe("branchStrategy 'main': failures are explicit, never silent", () => {
  it("retries with a named cause when neither main nor master exists", async () => {
    const root = track(buildRepo({ defaultBranch: "trunk" }));
    writeTicket(root, "T-100");
    const ctx = contextFor(root, "main");

    const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(result.action).toBe("retry");
    expect((result as { instruction: string }).instruction).toMatch(/main|master/i);
    expect(currentBranch(root)).toBe("feature/unrelated");
  });

  it("retries on detached HEAD rather than guessing", async () => {
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    git(root, ["checkout", "-q", "--detach"]);
    const ctx = contextFor(root, "main", { git: { branch: null, mergeBase: null } } as Partial<FullSessionState>);

    const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(result.action).toBe("retry");
    expect((result as { instruction: string }).instruction).toMatch(/detached/i);
  });

  it("relays git's own message when the checkout is rejected, and does not advance", async () => {
    // A file that differs between the two branches makes git refuse the switch
    // rather than carrying the change across.
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    writeFileSync(join(root, "README.md"), "feature branch content\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "diverge readme"]);
    writeFileSync(join(root, "README.md"), "uncommitted local edit\n");

    const ctx = contextFor(root, "main");
    const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(result.action).toBe("retry");
    expect(currentBranch(root)).toBe("feature/unrelated");
    // Relaying git's own text is the point: a generic "checkout failed" leaves
    // the operator with nothing to act on. Pin a fragment only git produces.
    const instruction = (result as { instruction: string }).instruction;
    expect(instruction).toMatch(/README\.md/);
    expect(instruction).toMatch(/overwritten|would be overwritten|local changes/i);
  });

  it("retries with the reason when git itself cannot be run", async () => {
    // The other failures are git saying no. This is git never answering, which
    // takes a different path through the result plumbing and must not be
    // mistaken for "already on main".
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    const ctx = contextFor(root, "main");

    const emptyPath = track(mkdtempSync(join(tmpdir(), "t328-nopath-")));
    const realPath = process.env.PATH;
    process.env.PATH = emptyPath;
    let result: Awaited<ReturnType<PickTicketStage["report"]>>;
    try {
      result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });
    } finally {
      process.env.PATH = realPath;
    }

    expect(result.action, JSON.stringify(result)).toBe("retry");
    // The contract is that every failure names its cause. A generic "could not
    // switch branches" would satisfy the retry-and-do-not-move assertions while
    // leaving the operator nothing to act on.
    const instruction = (result as { instruction: string }).instruction;
    expect(instruction).toMatch(/git (?:is )?unavailable|ENOENT|spawn git/i);
    // And it must not be mistaken for the "no main branch here" failure, which
    // has a completely different remedy.
    expect(instruction).not.toMatch(/neither .*main.* nor .*master.* exists/i);
    expect(currentBranch(root), "the repository moved despite git being unavailable")
      .toBe("feature/unrelated");
  });
});

// ---------------------------------------------------------------------------
// The strategies that must NOT touch git
// ---------------------------------------------------------------------------

describe("no checkout under current, legacy none, or an absent strategy", () => {
  it.each(["current", "none", undefined])("leaves the branch alone for %s", async (strategy) => {
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    const ctx = contextFor(root, (strategy ?? "current") as string,
      strategy === undefined ? ({ resolvedBranchStrategy: undefined } as Partial<FullSessionState>) : {});

    await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(currentBranch(root)).toBe("feature/unrelated");
    expect(branchNames(root).sort()).toEqual(["feature/unrelated", "main"]);
  });
});

// ---------------------------------------------------------------------------
// Ordering: an ineligible pick must never move the repository
// ---------------------------------------------------------------------------

describe("branchStrategy 'main': no checkout when an eligibility gate fails", () => {
  const cases: Array<{ name: string; setup: (root: string) => void; pick: string }> = [
    {
      name: "unresolvable id",
      setup: (root) => writeTicket(root, "T-100"),
      pick: "T-999",
    },
    {
      name: "tombstoned ticket",
      setup: (root) => writeTicket(root, "T-100", {
        lifecycle: "deleted", deletedAt: "2026-07-01T00:00:00Z", deletedBy: "test",
      }),
      pick: "T-100",
    },
    {
      name: "blocked ticket",
      setup: (root) => {
        writeTicket(root, "T-050");
        writeTicket(root, "T-100", { blockedBy: ["T-050"] });
      },
      pick: "T-100",
    },
    {
      name: "non-open ticket",
      setup: (root) => writeTicket(root, "T-100", { status: "complete", completedDate: "2026-07-01" }),
      pick: "T-100",
    },
    {
      name: "ticket claimed by another user",
      setup: (root) => writeTicket(root, "T-100", {
        claim: { user: "someone@else.com", branch: "story/T-100", claimedAt: "2026-07-01T00:00:00Z" },
      }),
      pick: "T-100",
    },
  ];

  it.each(cases)("does not checkout for $name", async ({ setup, pick }) => {
    const root = track(buildRepo());
    setup(root);
    const ctx = contextFor(root, "main");

    const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: pick });

    expect(result.action).not.toBe("advance");
    expect(currentBranch(root), "an ineligible pick moved the repository").toBe("feature/unrelated");
  });

  it("does not checkout for an out-of-scope pick in targeted mode", async () => {
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    const ctx = contextFor(root, "main", { targetWork: ["T-100"] } as Partial<FullSessionState>);

    const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" });

    expect(result.action).toBe("retry");
    expect(currentBranch(root)).toBe("feature/unrelated");
  });
});

// ---------------------------------------------------------------------------
// The issue path is a separate handler today, so it gets the same matrix.
// ---------------------------------------------------------------------------

describe("branchStrategy 'main': the issue path behaves identically", () => {
  it("switches to main when picking an issue", async () => {
    const root = track(buildRepo());
    writeIssue(root, "ISS-100");
    const ctx = contextFor(root, "main");

    await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-100" });

    expect(currentBranch(root)).toBe("main");
  });

  it("does not checkout when the issue is not open", async () => {
    const root = track(buildRepo());
    writeIssue(root, "ISS-100", { status: "resolved", resolvedDate: "2026-07-01", resolution: "done" });
    const ctx = contextFor(root, "main");

    const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-100" });

    expect(result.action).toBe("retry");
    expect(currentBranch(root)).toBe("feature/unrelated");
  });

  it("keeps the fix/ prefix for issues under per-ticket, unchanged by this ticket", async () => {
    // Regression pin: collapsing the two handlers into one helper must not
    // silently renamespace issue branches.
    const root = track(buildRepo());
    writeIssue(root, "ISS-100");
    const ctx = contextFor(root, "per-ticket");

    await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-100" });

    expect(currentBranch(root)).toMatch(/^fix\/ISS-100/);
  });

  it("keeps the story/ prefix for tickets under per-ticket, unchanged by this ticket", async () => {
    const root = track(buildRepo());
    writeTicket(root, "T-100");
    const ctx = contextFor(root, "per-ticket");

    await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });

    expect(currentBranch(root)).toMatch(/^story\/T-100/);
  });
});
