import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isValidTransition } from "../../../src/autonomous/state-machine.js";
import type { WorkflowState } from "../../../src/autonomous/session-types.js";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import { buildTicketBranchName, SLUG_BUDGET_WITH_SUFFIX } from "../../../src/autonomous/branch-affinity.js";

/**
 * T-328 / D3: the branch-mismatch offer.
 *
 * The filed ticket asked for three choices at the point of a mismatch -- switch
 * to main and branch fresh, skip the item, or cancel. What shipped only ever did
 * the third, and did it implicitly by ending the session. These tests define all
 * three as things a caller can actually report.
 *
 * The bulk of the file is about the ways an escape can go wrong rather than the
 * happy path, because that is where the design decisions live: an offer that
 * cannot be retried, a "fresh" branch that silently adopts a contaminated one,
 * or an episode that becomes a trap are each worse than the dead end this
 * replaces.
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

/** True when `commit` is reachable from `ref`. */
function contains(root: string, ref: string, commit: string): boolean {
  try {
    git(root, ["merge-base", "--is-ancestor", commit, ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A repo sitting on `story/T-100-branch-ticket` -- a branch scoped to T-100 --
 * carrying one commit that exists nowhere else. Any branch that is supposed to
 * be "fresh from main" must not contain that commit, which is what makes the
 * isolation assertions real rather than name-matching.
 */
function buildMismatchRepo(): { root: string; strayCommit: string; mainHead: string } {
  const root = mkdtempSync(join(tmpdir(), "t328-mismatch-"));
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "t328-mismatch", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "t328", date: "2026-07-28",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(root, "README.md"), "fixture\n");

  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@test.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  const mainHead = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "-q", "-b", "story/T-100-branch-ticket"]);
  writeFileSync(join(root, "t100-only.txt"), "work that belongs to T-100 alone\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "T-100 work"]);
  const strayCommit = git(root, ["rev-parse", "HEAD"]);

  return { root, strayCommit, mainHead };
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

function makeRecipe(branchStrategy = "current"): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    branchStrategy: branchStrategy as ResolvedRecipe["branchStrategy"],
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  };
}

function contextFor(
  root: string,
  overrides: Partial<FullSessionState> = {},
  branchStrategy = "current",
): StageContext {
  const now = new Date().toISOString();
  const head = git(root, ["rev-parse", "HEAD"]);
  const state = {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-00000000t328",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: currentBranch(root), mergeBase: null, expectedHead: head, initHead: head },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now,
    guideCallCount: 0, stuckRetryCount: 0,
    resolvedBranchStrategy: branchStrategy,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ...overrides,
  } as unknown as FullSessionState;
  const dir = join(root, ".story", "sessions", state.sessionId);
  mkdirSync(dir, { recursive: true });
  return new StageContext(root, dir, state, makeRecipe(branchStrategy));
}

/** The pending record the stage persists while an episode is open. */
function pending(ctx: StageContext): Record<string, unknown> | null {
  return (ctx.state as unknown as { pendingMismatch?: Record<string, unknown> | null })
    .pendingMismatch ?? null;
}

/** Read a session's state.json exactly as a fresh process would. */
function readStateFile(root: string, sessionId: string): {
  pendingMismatch?: { attempt?: { name?: string; baseOid?: string; status?: string } | null } | null;
} {
  return JSON.parse(readFileSync(join(root, ".story", "sessions", sessionId, "state.json"), "utf-8"));
}

/**
 * A `git` shim that copies `statePath` to `snapshotPath` the first time it sees
 * `checkout -b`, then delegates to the real git. Used to observe what was
 * durable at the instant git ran.
 */
function installGitShim(root: string, statePath: string, snapshotPath: string): string {
  const realGit = execFileSync("which", ["git"]).toString().trim();
  const dir = join(root, ".git-shim");
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "git");
  writeFileSync(shim,
    "#!/bin/sh\n" +
    'if [ "$1" = "checkout" ] && [ "$2" = "-b" ] && [ ! -f "' + snapshotPath + '" ]; then\n' +
    '  cp "' + statePath + '" "' + snapshotPath + '" 2>/dev/null || true\n' +
    "fi\n" +
    'exec "' + realGit + '" "$@"\n');
  chmodSync(shim, 0o755);
  return dir;
}

const roots: string[] = [];
function track(root: string): string { roots.push(root); return root; }
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Drive the first mismatch and return the stage, context, and its result.
 *
 * Callers that go on to test what happens INSIDE an open episode must use
 * `openEpisodeOrFail`, which asserts the episode actually opened. Without that
 * check those tests pass vacuously today: an unrecognized action falls through
 * to "ticketId is required", which is also a retry, and a never-created pending
 * record is also null.
 */
async function openEpisode(root: string, overrides: Partial<FullSessionState> = {}) {
  const stage = new PickTicketStage();
  const ctx = contextFor(root, overrides);
  const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" });
  return { stage, ctx, result };
}

async function openEpisodeOrFail(root: string, overrides: Partial<FullSessionState> = {}) {
  const opened = await openEpisode(root, overrides);
  expect(opened.result.action, "precondition: the mismatch did not open an episode").toBe("retry");
  expect(pending(opened.ctx), "precondition: no pending record was persisted").not.toBeNull();
  return opened;
}

// ---------------------------------------------------------------------------
// The offer itself
// ---------------------------------------------------------------------------

describe("the first mismatch offers, it does not end the session", () => {
  it("retries instead of routing straight to HANDOVER", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { result } = await openEpisode(root);

    expect(result.action, "the first mismatch still ends the session").toBe("retry");
  });

  it("names all three escapes with the exact action each one reports", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { result } = await openEpisode(root);
    const instruction = (result as { instruction: string }).instruction;

    expect(instruction).toContain("new_branch_from_main");
    expect(instruction).toContain("skip_ticket");
    expect(instruction).toContain("end_session");
  });

  it("persists the episode against the resolved canonical id", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { ctx } = await openEpisode(root);

    expect(pending(ctx)).toMatchObject({
      targetId: "T-200",
      targetKind: "ticket",
      branch: "story/T-100-branch-ticket",
    });
  });

  it.each([
    ["blocked ticket", (root: string) => {
      writeTicket(root, "T-050");
      writeTicket(root, "T-200", { blockedBy: ["T-050"] });
    }],
    ["non-open ticket", (root: string) => {
      writeTicket(root, "T-200", { status: "complete", completedDate: "2026-07-01" });
    }],
    ["ticket claimed by another user", (root: string) => {
      writeTicket(root, "T-200", {
        claim: { user: "other@example.com", branch: "story/T-200", claimedAt: "2026-07-01T00:00:00Z" },
      });
    }],
    ["tombstoned ticket", (root: string) => {
      writeTicket(root, "T-200", {
        lifecycle: "deleted", deletedAt: "2026-07-01T00:00:00Z", deletedBy: "test",
      });
    }],
  ])("does not open an episode for an ineligible pick: %s", async (_label, setup) => {
    // Ordering guard. Affinity persists state and offers a branch-creating
    // escape, so it must run AFTER the eligibility gates. If it ran first, one
    // blocked or foreign-claimed pick could open an episode -- and while an
    // episode is open, the next genuine mismatch is terminal.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    setup(root);

    const ctx = contextFor(root);
    const result = await new PickTicketStage().report(ctx, {
      completedAction: "ticket_picked", ticketId: "T-200",
    });

    expect(result.action).toBe("retry");
    expect(pending(ctx), "an ineligible pick opened a mismatch episode").toBeNull();
    // And the retry must name the real reason, not the branch.
    expect((result as { instruction: string }).instruction).not.toContain("Branch Mismatch");
  });

  it("does not open an episode when the strategy already decides the branch", async () => {
    // Under "main" and "per-ticket" the affinity question is moot.
    for (const strategy of ["main", "per-ticket"]) {
      const { root } = buildMismatchRepo();
      track(root);
      writeTicket(root, "T-100");
      writeTicket(root, "T-200");
      const ctx = contextFor(root, {}, strategy);

      await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" });

      expect(pending(ctx), `${strategy} opened a mismatch episode`).toBeNull();
      // Proves the strategy actually ran. Without this the assertion above is
      // satisfied by a stage that did nothing at all.
      expect(currentBranch(root), `${strategy} did not move off the mismatched branch`)
        .not.toBe("story/T-100-branch-ticket");
    }
  });
});

// ---------------------------------------------------------------------------
// Escape 1: new_branch_from_main
// ---------------------------------------------------------------------------

describe("new_branch_from_main", () => {
  it("roots the new branch at main, excluding the mismatched branch's commit", async () => {
    const { root, strayCommit } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(result.action, JSON.stringify(result)).toBe("advance");
    const branch = currentBranch(root);
    expect(branch).toMatch(/^story\/T-200/);
    expect(
      contains(root, branch, strayCommit),
      "the fresh branch carried the mismatched branch's commit",
    ).toBe(false);
  });

  it("proceeds with the pending pick, not some other item", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(ctx.state.ticket?.id).toBe("T-200");
    expect(pending(ctx), "the episode outlived its resolution").toBeNull();
  });

  it("differs from per-ticket, which still roots at session-start state", async () => {
    // Pins the deliberate asymmetry while the per-ticket base change is
    // unratified. If a later change collapses the two, this fails loudly rather
    // than silently altering where existing users' work lands.
    const { root, strayCommit } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-300");

    const perTicketCtx = contextFor(root, {}, "per-ticket");
    await new PickTicketStage().report(perTicketCtx, { completedAction: "ticket_picked", ticketId: "T-300" });
    const perTicketBranch = currentBranch(root);

    expect(perTicketBranch).toMatch(/^story\/T-300/);
    expect(
      contains(root, perTicketBranch, strayCommit),
      "per-ticket unexpectedly stopped rooting at session-start state",
    ).toBe(true);
  });
});

describe("new_branch_from_main: collisions never adopt an existing branch", () => {
  it("picks a suffixed name rather than reusing a branch of the same name", async () => {
    const { root, strayCommit } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    // A pre-existing branch of exactly the name we would choose, contaminated
    // in precisely the way this escape exists to avoid.
    const { stage, ctx } = await openEpisodeOrFail(root);
    const wanted = branchNames(root).find((b) => b.startsWith("story/T-200"));
    expect(wanted, "fixture precondition").toBeUndefined();
    git(root, ["branch", "story/T-200-ticket-t-200", "story/T-100-branch-ticket"]);

    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(result.action).toBe("advance");
    const branch = currentBranch(root);
    expect(branch).not.toBe("story/T-200-ticket-t-200");
    expect(contains(root, branch, strayCommit), "adopted the contaminated branch").toBe(false);
  });

  it("keeps the suffixed name a valid git ref for a maximum-length title", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    const longTitle = "x".repeat(300);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200", { title: longTitle });

    const { stage, ctx } = await openEpisodeOrFail(root);

    // Derive the base from the production builder at the suffixed-name budget,
    // rather than hand-writing a guess. A hand-written base that stopped
    // matching would silently make this test create irrelevant branches and
    // then assert against an uncollided name.
    const base = buildTicketBranchName("T-200", longTitle, "story", SLUG_BUDGET_WITH_SUFFIX);
    expect(base.length).toBeLessThan("story/T-200-".length + SLUG_BUDGET_WITH_SUFFIX + 1);

    // Occupy the base and every suffix through -12, so the only free name is
    // -13 and a two-digit suffix is genuinely forced.
    git(root, ["branch", base, "main"]);
    for (let suffix = 2; suffix <= 12; suffix += 1) {
      git(root, ["branch", `${base}-${suffix}`, "main"]);
    }

    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(result.action, JSON.stringify(result)).toBe("advance");
    const chosen = currentBranch(root);
    expect(chosen, "did not skip past the occupied names").toBe(`${base}-13`);
    // git's own validator, not ours: the suffix must not have pushed the name
    // past what git will accept.
    expect(() => git(root, ["check-ref-format", "--branch", chosen])).not.toThrow();
    expect(branchNames(root)).toContain(chosen);
  });
});

describe("new_branch_from_main: eligibility is revalidated before touching git", () => {
  it.each([
    ["became blocked", () => ({ blockedBy: ["T-050"] })],
    ["became complete", () => ({ status: "complete", completedDate: "2026-07-01" })],
    ["was tombstoned", () => ({ lifecycle: "deleted", deletedAt: "2026-07-01T00:00:00Z", deletedBy: "t" })],
    ["was claimed by another user", () => ({
      claim: { user: "other@example.com", branch: "story/T-200", claimedAt: "2026-07-01T00:00:00Z" },
    })],
  ])("refuses and leaves the branch alone when the target %s between offer and acceptance", async (_label, mutate) => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-050");
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const branchBefore = currentBranch(root);

    // The ledger is shared; the world moved while the offer was outstanding.
    writeTicket(root, "T-200", mutate() as Record<string, unknown>);

    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(result.action).not.toBe("advance");
    expect(currentBranch(root), "a stale offer changed the branch").toBe(branchBefore);
    expect(pending(ctx), "the stale episode was left open").toBeNull();
  });
});

describe("new_branch_from_main: recovery is decided by the recorded attempt", () => {
  it("retries the same attempt when the checkout never happened", async () => {
    // The ordinary recoverable failure: git refused, so no ref exists. Treating
    // that as a conflict would make a dirty working tree unrecoverable.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    // Diverge a file so the checkout is rejected, then clear it and retry.
    writeFileSync(join(root, "README.md"), "diverged on the feature branch\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "diverge"]);
    writeFileSync(join(root, "README.md"), "uncommitted\n");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const first = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(first.action).toBe("retry");
    expect(pending(ctx), "the episode was dropped on a recoverable failure").not.toBeNull();
    const firstAttemptName = (pending(ctx)?.attempt as { name?: string } | null)?.name;
    expect(firstAttemptName).toBeTruthy();

    git(root, ["checkout", "-q", "--", "README.md"]);
    const second = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(second.action, "the cleared failure could not be retried").toBe("advance");
    expect(currentBranch(root)).toBe(firstAttemptName);
  });

  it("persists the planned attempt to disk before touching git", async () => {
    // The whole write-ahead design rests on this. If the attempt lives only in
    // the in-memory context, a crash between planning and checkout loses the
    // record, and the next run cannot tell "we never created it" from
    // "someone else's branch happens to have this name". Asserting through
    // ctx.state cannot detect that: updateDraft mutates the same object
    // writeState would have persisted.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    // Make branch creation fail: a diverged, dirty file git will not carry over.
    writeFileSync(join(root, "README.md"), "diverged on the feature branch\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "diverge"]);
    writeFileSync(join(root, "README.md"), "uncommitted\n");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const branchesBefore = branchNames(root);

    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });
    expect(result.action, "fixture did not force a failure").toBe("retry");

    // Nothing was created, which is the state a crash would leave behind.
    expect(branchNames(root)).toEqual(branchesBefore);

    // Read the file itself, exactly as a fresh process after a crash would.
    const onDisk = readStateFile(root, ctx.state.sessionId);
    const attempt = onDisk.pendingMismatch?.attempt;
    expect(attempt, "the planned attempt never reached disk").toBeTruthy();
    expect(attempt!.status).toBe("planned");
    expect(attempt!.name).toBe((pending(ctx)?.attempt as { name?: string }).name);
    // baseOid must be a real commit, since recovery compares a ref against it.
    expect(attempt!.baseOid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(root, ["rev-parse", `${attempt!.baseOid}^{commit}`])).toBe(attempt!.baseOid);
  });

  it("has the attempt on disk at the moment git is invoked, not merely afterwards", async () => {
    // Ordering, not just durability. The test above passes even if the attempt
    // is written only on the failure path AFTER git ran -- which is exactly the
    // bug write-ahead exists to prevent, because a crash DURING the checkout
    // would then leave a branch no record can identify.
    //
    // Rather than mocking the git layer (which this suite avoids on purpose,
    // since a mock cannot prove a real branch was created), put a shim named
    // `git` ahead of the real one on PATH. It snapshots state.json at the
    // instant `git checkout -b` is invoked, then delegates to the real git.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const statePath = join(root, ".story", "sessions", ctx.state.sessionId, "state.json");
    const snapshotPath = join(root, "state-at-checkout.json");
    const shimDir = installGitShim(root, statePath, snapshotPath);

    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    let result: Awaited<ReturnType<PickTicketStage["report"]>>;
    try {
      result = await stage.report(ctx, { completedAction: "new_branch_from_main" });
    } finally {
      process.env.PATH = realPath;
    }

    expect(result.action, JSON.stringify(result)).toBe("advance");
    expect(existsSync(snapshotPath), "the shim never saw a `git checkout -b`").toBe(true);

    // What was durable at the moment git ran.
    const atCheckout = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
      pendingMismatch?: { attempt?: { name?: string; baseOid?: string; status?: string } | null } | null;
    };
    const planned = atCheckout.pendingMismatch?.attempt;
    expect(planned, "git ran before the attempt was durable").toBeTruthy();
    expect(planned!.status).toBe("planned");
    // And it names the branch that actually got created.
    expect(planned!.name).toBe(currentBranch(root));
    expect(planned!.baseOid).toBe(git(root, ["rev-parse", "main"]));
  });

  it("adopts the recorded branch when its tip is still the recorded base", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });
    expect(result.action).toBe("advance");
    const adopted = currentBranch(root);

    // Replay the same action; nothing was committed, so it must land on the
    // same branch rather than minting a suffix.
    const replayCtx = contextFor(root, {
      pendingMismatch: {
        targetId: "T-200", targetKind: "ticket", branch: "story/T-100-branch-ticket",
        controlFailures: 0,
        attempt: { name: adopted, baseOid: git(root, ["rev-parse", adopted]), status: "planned" },
      },
    } as unknown as Partial<FullSessionState>);
    const replay = await stage.report(replayCtx, { completedAction: "new_branch_from_main" });

    expect(replay.action).toBe("advance");
    expect(currentBranch(root)).toBe(adopted);
  });

  it("refuses to adopt a recorded branch whose tip has moved", async () => {
    const { root, mainHead } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    // A branch at the recorded name that someone has since committed onto: its
    // provenance can no longer be proven, so adoption would be a guess.
    git(root, ["branch", "story/T-200-ticket-t-200", "main"]);
    git(root, ["checkout", "-q", "story/T-200-ticket-t-200"]);
    writeFileSync(join(root, "someone-elses-work.txt"), "not ours\n");
    // Add only this file: `git add .` would sweep the untracked .story ticket
    // fixtures onto this branch, and checking back out would delete them.
    git(root, ["add", "someone-elses-work.txt"]);
    git(root, ["commit", "-q", "-m", "someone else"]);
    git(root, ["checkout", "-q", "story/T-100-branch-ticket"]);

    const stage = new PickTicketStage();
    const ctx = contextFor(root, {
      pendingMismatch: {
        targetId: "T-200", targetKind: "ticket", branch: "story/T-100-branch-ticket",
        controlFailures: 0,
        attempt: { name: "story/T-200-ticket-t-200", baseOid: mainHead, status: "planned" },
      },
    } as unknown as Partial<FullSessionState>);

    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(result.action).not.toBe("advance");
    expect((result as { instruction: string }).instruction).toMatch(/conflict|moved|differs/i);
  });

  it("recovers a recorded attempt after main is deleted", async () => {
    // Recovery deliberately does NOT resolve main: the recorded attempt already
    // carries a frozen name and baseOid, so a main that has since been deleted
    // or renamed must not block it. With resolution back at the top of the
    // function, this fails.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    // Force the first attempt to fail so a record exists with no ref created.
    writeFileSync(join(root, "README.md"), "diverged\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "diverge"]);
    writeFileSync(join(root, "README.md"), "uncommitted\n");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const first = await stage.report(ctx, { completedAction: "new_branch_from_main" });
    expect(first.action, "fixture did not force a failure").toBe("retry");
    const recorded = pending(ctx)?.attempt as { name: string; baseOid: string };
    expect(recorded?.name).toBeTruthy();
    expect(branchNames(root)).not.toContain(recorded.name);

    // Main disappears while the attempt is outstanding, and no master exists
    // either, so a fresh resolution would have nothing to fall back to.
    git(root, ["checkout", "-q", "--", "README.md"]);
    git(root, ["branch", "-D", "main"]);
    expect(branchNames(root)).not.toContain("main");
    expect(branchNames(root)).not.toContain("master");

    const second = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(second.action, JSON.stringify(second)).toBe("advance");
    expect(currentBranch(root)).toBe(recorded.name);
    // Rooted at the commit recorded before main went away.
    expect(git(root, ["rev-parse", "HEAD"])).toBe(recorded.baseOid);
  });

  it("keeps baseOid frozen when main advances mid-episode", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    writeFileSync(join(root, "README.md"), "diverged\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "diverge"]);
    writeFileSync(join(root, "README.md"), "uncommitted\n");

    const { stage, ctx } = await openEpisodeOrFail(root);
    await stage.report(ctx, { completedAction: "new_branch_from_main" });
    const recordedBase = (pending(ctx)?.attempt as { baseOid?: string } | null)?.baseOid;
    expect(recordedBase).toBeTruthy();

    // main moves underneath the outstanding attempt. Clear the dirty file
    // first: git will not switch branches while it diverges.
    git(root, ["checkout", "-q", "--", "README.md"]);
    git(root, ["checkout", "-q", "main"]);
    writeFileSync(join(root, "main-moved.txt"), "advanced\n");
    git(root, ["add", "main-moved.txt"]);
    git(root, ["commit", "-q", "-m", "main advances"]);
    git(root, ["checkout", "-q", "story/T-100-branch-ticket"]);

    await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(git(root, ["rev-parse", currentBranch(root)])).toBe(recordedBase);
  });
});

// ---------------------------------------------------------------------------
// Escape 2: skip_ticket
// ---------------------------------------------------------------------------

describe("skip_ticket at PICK_TICKET", () => {
  it("records the skipped item and returns to the pick stage", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: "skip_ticket" });

    expect(result.action, JSON.stringify(result)).toBe("goto");
    expect((result as { target: string }).target).toBe("PICK_TICKET");
    expect((ctx.state as unknown as { skippedTargets?: string[] }).skippedTargets).toContain("T-200");
    expect(pending(ctx)).toBeNull();
  });

  /**
   * Targeted mode is exempt from affinity (targetWork already constrains the
   * pick), so a targeted session never opens a mismatch episode and skip is not
   * reachable there through this route. What still has to hold is that a
   * recorded skip retires the target rather than leaving the queue spinning on
   * it, so that is asserted against the queue directly.
   */
  it("retires a skipped target from a targeted queue, reaching COMPLETE when it was the only one", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const ctx = contextFor(root, {
      targetWork: ["T-200"],
      skippedTargets: ["T-200"],
    } as unknown as Partial<FullSessionState>);

    const next = await new PickTicketStage().enter(ctx);

    expect((next as { action?: string; target?: string }).target).toBe("COMPLETE");
  });

  it("offers the remaining target when one of several is skipped", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const ctx = contextFor(root, {
      targetWork: ["T-200", "T-300"],
      skippedTargets: ["T-200"],
    } as unknown as Partial<FullSessionState>);

    const next = await new PickTicketStage().enter(ctx);
    const instruction = (next as { instruction?: string }).instruction ?? "";

    expect(instruction).toContain("T-300");
    expect(instruction).not.toContain("T-200");
  });

  it("drops the skipped item from an untargeted candidate list", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const { stage, ctx } = await openEpisodeOrFail(root);
    await stage.report(ctx, { completedAction: "skip_ticket" });
    const next = await stage.enter(ctx);

    const instruction = (next as { instruction?: string }).instruction ?? "";
    expect(instruction).not.toContain("T-200");
    expect(instruction).toContain("T-300");
  });

  it("still surfaces lower-ranked work after the whole visible list is skipped", async () => {
    // The candidate list is ranked and truncated. Excluding skipped ids AFTER
    // that truncation would make a session look finished while eligible tickets
    // remained below the cut.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    for (let i = 1; i <= 8; i += 1) {
      writeTicket(root, `T-${200 + i}`, { order: i * 10 });
    }

    const stage = new PickTicketStage();
    const ctx = contextFor(root, {
      skippedTargets: ["T-201", "T-202", "T-203", "T-204", "T-205"],
    } as unknown as Partial<FullSessionState>);

    const next = await stage.enter(ctx);
    const instruction = (next as { instruction?: string }).instruction ?? "";

    for (const skipped of ["T-201", "T-202", "T-203", "T-204", "T-205"]) {
      expect(instruction, `${skipped} was offered after being skipped`).not.toContain(skipped);
    }
    expect(instruction).toMatch(/T-20[678]/);
  });
});

// ---------------------------------------------------------------------------
// Escape 3: end_session
// ---------------------------------------------------------------------------

describe("end_session", () => {
  it("routes to HANDOVER while an episode is open", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: "end_session" });

    expect(result.action).toBe("goto");
    expect((result as { target: string }).target).toBe("HANDOVER");
  });

  it("is rejected when no episode is open", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    const ctx = contextFor(root);

    const result = await new PickTicketStage().report(ctx, { completedAction: "end_session" });

    expect(result.action).toBe("retry");
  });
});

// ---------------------------------------------------------------------------
// Identity validation, uniform across all three pending actions
// ---------------------------------------------------------------------------

describe("pending actions validate which item they are acting on", () => {
  const actions = ["new_branch_from_main", "skip_ticket", "end_session"] as const;

  /**
   * Each action's own success shape. Asserting merely "not a retry" would be
   * satisfied by the pre-T-328 behavior, where an unrecognized action falls
   * through to an ordinary pick and the mismatch routes to HANDOVER.
   */
  const accepted: Record<(typeof actions)[number], (r: { action: string; target?: string }) => void> = {
    new_branch_from_main: (r) => expect(r.action).toBe("advance"),
    skip_ticket: (r) => {
      // Not "retry or goto": skip re-enters the pick stage, which is why
      // PICK_TICKET needed a self-transition. Accepting a retry here would let
      // a regression that records the skip but never re-picks pass.
      expect(r.action).toBe("goto");
      expect(r.target).toBe("PICK_TICKET");
    },
    end_session: (r) => {
      expect(r.action).toBe("goto");
      expect(r.target).toBe("HANDOVER");
    },
  };

  it.each(actions)("%s accepts a report carrying no id", async (action) => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: action });

    accepted[action](result as { action: string; target?: string });
    expect(pending(ctx), "an accepted action left the episode open").toBeNull();
  });

  it.each(actions)("%s accepts the matching id", async (action) => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: action, ticketId: "T-200" });

    accepted[action](result as { action: string; target?: string });
  });

  it.each(actions)("%s rejects a different id", async (action) => {
    // Silently ignoring a mismatched id would let a confused caller believe it
    // had skipped or rebranched something it had not.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: action, ticketId: "T-300" });

    expect(result.action).toBe("retry");
    expect(pending(ctx)).not.toBeNull();
  });

  it.each(actions)("%s rejects the wrong-kind id field", async (action) => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeIssue(root, "ISS-900");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: action, issueId: "ISS-900" });

    expect(result.action).toBe("retry");
  });

  it.each(actions)("%s rejects both id fields at once", async (action) => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeIssue(root, "ISS-900");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, {
      completedAction: action, ticketId: "T-200", issueId: "ISS-900",
    });

    expect(result.action).toBe("retry");
  });
});

// ---------------------------------------------------------------------------
// Termination
// ---------------------------------------------------------------------------

describe("an open episode bounds itself", () => {
  it("does not hand out a second offer for a different mismatched id", async () => {
    // A pair key would mint a fresh offer here forever.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const second = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-300" });

    expect(second.action).toBe("goto");
    expect((second as { target: string }).target).toBe("HANDOVER");
  });

  it("does not hand out a second offer after the branch is renamed", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-400");

    const { stage, ctx } = await openEpisodeOrFail(root);
    git(root, ["branch", "-m", "story/T-400-renamed"]);
    ctx.updateDraft({
      git: { ...ctx.state.git, branch: "story/T-400-renamed" },
    } as Partial<FullSessionState>);

    const second = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" });

    expect(second.action).toBe("goto");
    expect((second as { target: string }).target).toBe("HANDOVER");
  });

  it("survives a compaction boundary as persisted state", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const { ctx } = await openEpisodeOrFail(root);
    const carried = pending(ctx);
    expect(carried).not.toBeNull();

    // A fresh context built from the persisted record, as resume would.
    const resumed = contextFor(root, { pendingMismatch: carried } as unknown as Partial<FullSessionState>);
    const after = await new PickTicketStage().report(resumed, {
      completedAction: "ticket_picked", ticketId: "T-300",
    });

    expect(after.action).toBe("goto");
    expect((after as { target: string }).target).toBe("HANDOVER");
  });

  it("gives a genuinely new mismatch its own offer once the first is resolved", async () => {
    // A session-lifetime bound would silently deny this, ending a long session
    // on its second unrelated mismatch.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const { stage, ctx } = await openEpisodeOrFail(root);
    await stage.report(ctx, { completedAction: "skip_ticket" });
    expect(pending(ctx)).toBeNull();

    // Back on a branch scoped to something else, a different pick mismatches.
    git(root, ["checkout", "-q", "story/T-100-branch-ticket"]);
    ctx.updateDraft({
      git: { ...ctx.state.git, branch: "story/T-100-branch-ticket" },
    } as Partial<FullSessionState>);
    const second = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-300" });

    expect(second.action, "a later unrelated mismatch got no offer").toBe("retry");
    expect(pending(ctx)).toMatchObject({ targetId: "T-300" });
  });

  it("terminalizes on repeated control failures before the generic stuck threshold", async () => {
    // Every recoverable control failure costs a retry. Left unbounded these
    // reach stuckRetryCount's threshold of 5, which bypasses the cancel gate --
    // ending the episode through a path nobody designed for it.
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    // Permanently un-checkout-able: a diverged file that is never cleaned.
    writeFileSync(join(root, "README.md"), "diverged\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-q", "-m", "diverge"]);
    writeFileSync(join(root, "README.md"), "uncommitted forever\n");

    const { stage, ctx } = await openEpisodeOrFail(root);

    // Failure 1 and 2 stay in the episode and increment the counter.
    for (const expectedCount of [1, 2]) {
      const r = await stage.report(ctx, { completedAction: "new_branch_from_main" });
      expect(r.action, `failure ${expectedCount} did not retry`).toBe("retry");
      expect(pending(ctx), `failure ${expectedCount} dropped the episode`).not.toBeNull();
      expect(pending(ctx)!.controlFailures, "controlFailures is not being counted")
        .toBe(expectedCount);
      expect(ctx.state.stuckRetryCount ?? 0).toBeLessThan(5);
    }

    // Failure 3 is terminal, and terminal means the episode is closed, not
    // merely that a goto came back.
    const third = await stage.report(ctx, { completedAction: "new_branch_from_main" });
    expect(third.action, JSON.stringify(third)).toBe("goto");
    expect((third as { target: string }).target).toBe("HANDOVER");
    expect(pending(ctx), "the terminal route left the episode open").toBeNull();
    expect(ctx.state.stuckRetryCount ?? 0,
      "the generic stuck threshold was reached, bypassing the designed exit")
      .toBeLessThan(5);
  });

  it("bounds the moved-tip conflict the same way", async () => {
    // The other repeatable control failure. A conflict that is retried forever
    // is the same unbounded loop wearing a different message, so it has to hit
    // the same ceiling.
    const { root, mainHead } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    // A branch at the recorded name carrying a commit we cannot account for.
    git(root, ["branch", "story/T-200-ticket-t-200", "main"]);
    git(root, ["checkout", "-q", "story/T-200-ticket-t-200"]);
    writeFileSync(join(root, "someone-elses-work.txt"), "not ours\n");
    git(root, ["add", "someone-elses-work.txt"]);
    git(root, ["commit", "-q", "-m", "someone else"]);
    git(root, ["checkout", "-q", "story/T-100-branch-ticket"]);

    const stage = new PickTicketStage();
    const ctx = contextFor(root, {
      pendingMismatch: {
        targetId: "T-200", targetKind: "ticket", branch: "story/T-100-branch-ticket",
        controlFailures: 0,
        attempt: { name: "story/T-200-ticket-t-200", baseOid: mainHead, status: "planned" },
      },
    } as unknown as Partial<FullSessionState>);

    for (const expectedCount of [1, 2]) {
      const r = await stage.report(ctx, { completedAction: "new_branch_from_main" });
      expect(r.action, `conflict ${expectedCount} did not retry`).toBe("retry");
      expect(pending(ctx)!.controlFailures).toBe(expectedCount);
      expect(ctx.state.stuckRetryCount ?? 0).toBeLessThan(5);
    }

    const third = await stage.report(ctx, { completedAction: "new_branch_from_main" });
    expect(third.action, JSON.stringify(third)).toBe("goto");
    expect((third as { target: string }).target).toBe("HANDOVER");
    expect(pending(ctx)).toBeNull();
    expect(ctx.state.stuckRetryCount ?? 0).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// The issue path runs through the same escapes
// ---------------------------------------------------------------------------

/**
 * Issues take a separate handler inside the stage. Every escape above is proven
 * only for tickets, so an issue-shaped regression -- a `story/` prefix on a fix
 * branch, a skip recorded under the wrong id, an episode left open -- would not
 * be caught anywhere. This is the same matrix against an issue episode.
 */
describe("mismatch escapes on the issue path", () => {
  async function openIssueEpisodeOrFail(root: string) {
    const stage = new PickTicketStage();
    const ctx = contextFor(root);
    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-200" });
    expect(result.action, "precondition: the issue mismatch did not open an episode").toBe("retry");
    const record = pending(ctx);
    expect(record, "precondition: no pending record was persisted").not.toBeNull();
    // The episode must be filed as an issue, or the escapes will revalidate it
    // against the ticket ledger.
    expect(record!.targetKind).toBe("issue");
    expect(record!.targetId).toBe("ISS-200");
    return { stage, ctx };
  }

  it("branches from main under the fix/ prefix and selects the issue", async () => {
    const { root, strayCommit } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeIssue(root, "ISS-200");

    const { stage, ctx } = await openIssueEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    // The issue path hands off to ISSUE_FIX rather than falling through the
    // ticket pipeline, and that hand-off must itself be a legal transition.
    expect(result.action, JSON.stringify(result)).toBe("goto");
    expect((result as { target: string }).target).toBe("ISSUE_FIX");
    expect(isValidTransition("PICK_TICKET", "ISSUE_FIX" as WorkflowState)).toBe(true);
    const branch = currentBranch(root);
    expect(branch, "an issue got a ticket-namespaced branch").toMatch(/^fix\/ISS-200/);
    // Fresh from main means the mismatched branch's commit is not reachable.
    expect(contains(root, branch, strayCommit), "the new branch carried T-100's commit").toBe(false);
    expect(git(root, ["rev-parse", `${branch}^{commit}`])).toBe(git(root, ["rev-parse", "main"]));

    const selected = (ctx.state as unknown as { currentIssue?: { displayId?: string; id?: string } | null }).currentIssue;
    expect(selected, "the issue was not selected").toBeTruthy();
    expect(selected!.displayId ?? selected!.id).toBe("ISS-200");
    expect(pending(ctx), "the episode was left open after it resolved").toBeNull();
  });

  it("records a skipped issue under its canonical id", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeIssue(root, "ISS-200");
    const branchBefore = currentBranch(root);

    const { stage, ctx } = await openIssueEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: "skip_ticket" });

    expect(result.action).not.toBe("advance");
    expect((ctx.state as unknown as { skippedTargets?: string[] }).skippedTargets)
      .toContain("ISS-200");
    expect(pending(ctx)).toBeNull();
    expect(currentBranch(root), "skipping moved the repository").toBe(branchBefore);
    expect((ctx.state as unknown as { currentIssue?: unknown }).currentIssue ?? null,
      "a skipped issue was still selected").toBeNull();
  });

  it("ends the session from an open issue episode", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeIssue(root, "ISS-200");
    const branchBefore = currentBranch(root);

    const { stage, ctx } = await openIssueEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: "end_session" });

    expect(result.action).toBe("goto");
    expect((result as { target: string }).target).toBe("HANDOVER");
    expect(currentBranch(root), "ending the session moved the repository").toBe(branchBefore);
  });

  it("refuses a stale issue offer when the issue was resolved meanwhile", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeIssue(root, "ISS-200");

    const { stage, ctx } = await openIssueEpisodeOrFail(root);
    const branchBefore = currentBranch(root);
    writeIssue(root, "ISS-200", { status: "resolved", resolvedDate: "2026-07-01", resolution: "done" });

    const result = await stage.report(ctx, { completedAction: "new_branch_from_main" });

    expect(result.action).not.toBe("advance");
    expect(currentBranch(root), "a stale issue offer changed the branch").toBe(branchBefore);
    expect(pending(ctx), "the stale episode was left open").toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transition legality
// ---------------------------------------------------------------------------

/**
 * These tests drive PickTicketStage directly, which bypasses the guide's
 * `assertTransition` check. That check THROWS on an illegal target, so a stage
 * can return a `goto` that every test here accepts and that blows up the moment
 * a real session takes it. This suite closes that gap by asserting every goto
 * target the escapes can produce is actually reachable from PICK_TICKET.
 *
 * It is not hypothetical: `skip_ticket` returns `goto PICK_TICKET`, and
 * PICK_TICKET had no self-transition until this ticket added one.
 */
describe("every goto target the escapes produce is a legal transition", () => {
  /** Returns the goto target, failing if the action did not produce one. */
  async function gotoTargetOf(action: string): Promise<string> {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");
    writeTicket(root, "T-300");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const result = await stage.report(ctx, { completedAction: action });
    // Both of these actions are contractually gotos. Returning null and
    // skipping the check would make this suite silently stop testing the very
    // transition it exists to guard.
    expect(result.action, `${action} did not produce a goto: ${JSON.stringify(result)}`).toBe("goto");
    return (result as { target: string }).target;
  }

  const expectedTarget: Record<string, string> = {
    skip_ticket: "PICK_TICKET",
    end_session: "HANDOVER",
  };

  it.each(["skip_ticket", "end_session"])("%s", async (action) => {
    const target = await gotoTargetOf(action);
    expect(target, `${action} changed which state it routes to`).toBe(expectedTarget[action]);
    expect(
      isValidTransition("PICK_TICKET" as WorkflowState, target as WorkflowState),
      `PICK_TICKET -> ${target} is not a legal transition, so the guide would throw`,
    ).toBe(true);
  });

  it("the terminal route from a repeated mismatch is legal", async () => {
    const { root } = buildMismatchRepo();
    track(root);
    writeTicket(root, "T-100");
    writeTicket(root, "T-200");

    const { stage, ctx } = await openEpisodeOrFail(root);
    const second = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" });

    expect(second.action).toBe("goto");
    const target = (second as { target: string }).target;
    expect(isValidTransition("PICK_TICKET" as WorkflowState, target as WorkflowState)).toBe(true);
  });
});
