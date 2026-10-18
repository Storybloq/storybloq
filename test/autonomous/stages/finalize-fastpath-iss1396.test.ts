/**
 * ISS-1396: a commit reported as HEAD (handleCommit's fast path) must carry
 * the item's ledger file, exactly as the moved-HEAD route already requires.
 *
 * Real temporary git repositories, no git-inspector mocks: the defect is that
 * a code-only commit was accepted, which only a real tree can show.
 *
 * Also pinned here, because the same shared check carries them:
 * - a ledger record the loader found under a name other than its id fails
 *   closed with a repair diagnostic, before any exemption;
 * - a merge commit is refused by its parent count, before any exemption and
 *   for an itemless session too;
 * - ISS-922's "No new commit detected" refusal keeps precedence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { FinalizeStage, deferralLeftIssueUnchanged } from "../../../src/autonomous/stages/finalize.js";
import * as gitInspector from "../../../src/autonomous/git-inspector.js";
import type { FullSessionState, GuideReportInput } from "../../../src/autonomous/session-types.js";
import { serializeJSON } from "../../../src/core/project-loader.js";
import { git } from "../../helpers/git-fixture.js";

const SESSION_ID = "00000000-0000-0000-0000-000000001396";
const EARLIER = "2026-01-02";
const HASHED_TICKET = "t-1111111111111111";
const HASHED_ISSUE = "i-1111111111111111";
const DEFERRAL = {
  disposition: "owner_gated",
  dispositionReason: "Needs the owner's call on pricing.",
  dispositionRef: "N-001",
  dispositionFor: "owner_gated",
};

function ticket(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: "Work", description: "A test.", type: "task", status: "inprogress",
    phase: "p1", order: 10, createdDate: EARLIER, completedDate: null, blockedBy: [], parentTicket: null,
    ...extra,
  };
}

function issue(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: "A problem", status: "open", severity: "high", components: [],
    impact: "It breaks.", resolution: null, location: [], discoveredDate: EARLIER,
    resolvedDate: null, relatedTickets: [], updatedDate: EARLIER,
    ...extra,
  };
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A committed project. `files` maps a path under .story/ to its record. */
function buildRepo(files: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "iss1396-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, ".gitignore"), "sessions/\nsnapshots/\n");
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss1396", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "iss1396", date: EARLIER,
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(story, "notes", "N-001.json"), JSON.stringify({
    id: "N-001", title: "Pricing", content: "The owner decides pricing.", tags: [], status: "active",
    createdDate: EARLIER, updatedDate: EARLIER, updatedAt: `${EARLIER}T00:00:00.000Z`,
  }, null, 2) + "\n");
  for (const [path, record] of Object.entries(files)) writeFileSync(join(story, path), serializeJSON(record));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

const head = (root: string): string => git(root, ["rev-parse", "HEAD"]);
let counter = 0;
const editSource = (root: string): void => writeFileSync(join(root, "src", "a.ts"), `export const a = ${++counter + 1};\n`);
function edit(root: string, storyPath: string, record: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", storyPath), serializeJSON(record));
}
function commit(root: string, paths: string[], msg = "work"): string {
  git(root, ["add", "--", ...paths]);
  git(root, ["commit", "-qm", msg]);
  return head(root);
}
/** A merge commit at HEAD: a side branch and a mainline commit, merged with --no-ff. */
function mergeAtHead(root: string, mainlinePaths: string[]): string {
  git(root, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(root, "src", "side.ts"), "export const side = 1;\n");
  commit(root, ["src/side.ts"], "side");
  git(root, ["checkout", "-q", "main"]);
  commit(root, mainlinePaths, "mainline");
  git(root, ["merge", "-q", "--no-ff", "side", "-m", "merge"]);
  return head(root);
}

type Item =
  | { kind: "ticket"; id: string; displayId?: string }
  | { kind: "issue"; id: string; displayId?: string; exit?: Record<string, unknown> }
  | { kind: "none" };

function makeState(root: string, item: Item, over: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  const h = head(root);
  return {
    schemaVersion: 1, sessionId: SESSION_ID, recipe: "coding", state: "FINALIZE", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: "precommit_passed",
    git: {
      branch: "main", mergeBase: h, expectedHead: h, initHead: h, itemBaseHead: h, autoStash: null,
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null, compactPending: false,
    compactPreparedAt: null, resumeBlocked: false, terminationReason: null, waitingForRetry: false,
    lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: [], handoverInterval: 3 },
    ticket: item.kind === "ticket" ? { id: item.id, displayId: item.displayId ?? item.id, title: "Work", claimed: true } : undefined,
    claimEpoch: item.kind === "ticket"
      ? { ticketId: item.id, sessionId: SESSION_ID, user: "t@t.t", branch: "main", since: now, establishedAt: now }
      : undefined,
    currentIssue: item.kind === "issue" ? { id: item.id, displayId: item.displayId ?? item.id, title: "A problem", severity: "high" } : null,
    currentIssueExit: item.kind === "issue" ? (item.exit ?? { exit: "fixed" }) : null,
    resolvedIssues: [], deferredIssues: [], filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    frozenGate: { status: "ungated" },
    ...over,
  } as unknown as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding", pipeline: ["PICK_TICKET", "IMPLEMENT", "FINALIZE", "COMPLETE"], postComplete: [], stages: {},
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: [], handoverInterval: 3 },
  } as unknown as ResolvedRecipe;
}

function context(root: string, state: FullSessionState): StageContext {
  const dir = join(root, ".story", "sessions", SESSION_ID);
  mkdirSync(dir, { recursive: true });
  return new StageContext(root, dir, state, makeRecipe());
}

const stage = new FinalizeStage();
const instructionOf = (a: unknown): string => (a as { instruction?: string }).instruction ?? "";
async function commitDone(ctx: StageContext, hash: string, extra: Partial<GuideReportInput> = {}) {
  return stage.report(ctx, { completedAction: "commit_done", commitHash: hash, ...extra } as GuideReportInput);
}
const committed = (ctx: StageContext): boolean => ctx.state.finalizeCheckpoint === "committed";

describe("ISS-1396: the fast path requires the item's ledger file", { timeout: 60000 }, () => {
  it("F1: a ticket's code-only commit reported as HEAD is refused with the moved-HEAD route's text", async () => {
    const root = buildRepo({ "tickets/T-001.json": ticket("T-001") });
    const ctx = context(root, makeState(root, { kind: "ticket", id: "T-001" }));
    editSource(root);
    const hash = commit(root, ["src/a.ts"]);
    const r = await commitDone(ctx, hash);
    expect(r.action).toBe("retry");
    expect(instructionOf(r)).toBe(
      `Commit detected (${hash.slice(0, 7)}) but ticket file .story/tickets/T-001.json is not in the commit. ` +
      "Amend the commit to include it: `git add .story/tickets/T-001.json && git commit --amend --no-edit`, " +
      'then report completedAction: "commit_done" with the new hash.',
    );
    expect(committed(ctx)).toBe(false);
    expect(ctx.state.completedTickets).toEqual([]);
  });

  it("F2: an issue's code-only commit is refused, for a fixed exit too", async () => {
    const root = buildRepo({ "issues/ISS-001.json": issue("ISS-001") });
    const ctx = context(root, makeState(root, { kind: "issue", id: "ISS-001" }));
    edit(root, "issues/ISS-001.json", issue("ISS-001", { status: "resolved", resolution: "Fixed.", resolvedDate: EARLIER }));
    editSource(root);
    const hash = commit(root, ["src/a.ts"]);
    const r = await commitDone(ctx, hash);
    expect(r.action).toBe("retry");
    expect(instructionOf(r)).toContain("but issue file .story/issues/ISS-001.json is not in the commit");
    expect(committed(ctx)).toBe(false);
    expect(ctx.state.resolvedIssues ?? []).toEqual([]);
  });

  it("F3: a commit that carries the file is accepted, for a ticket and for an issue", async () => {
    const t = buildRepo({ "tickets/T-001.json": ticket("T-001") });
    const tctx = context(t, makeState(t, { kind: "ticket", id: "T-001" }));
    editSource(t);
    edit(t, "tickets/T-001.json", ticket("T-001", { status: "complete", completedDate: EARLIER }));
    const th = commit(t, ["src/a.ts", ".story/tickets/T-001.json"]);
    const tr = await commitDone(tctx, th);
    expect(committed(tctx), instructionOf(tr)).toBe(true);

    const i = buildRepo({ "issues/ISS-001.json": issue("ISS-001") });
    const ictx = context(i, makeState(i, { kind: "issue", id: "ISS-001" }));
    editSource(i);
    edit(i, "issues/ISS-001.json", issue("ISS-001", { status: "resolved", resolution: "Fixed.", resolvedDate: EARLIER }));
    const ih = commit(i, ["src/a.ts", ".story/issues/ISS-001.json"]);
    const ir = await commitDone(ictx, ih);
    expect(committed(ictx), instructionOf(ir)).toBe(true);
  });

  it("F4: a hash-named ticket's file is the one its id names, never its display id's", async () => {
    const root = buildRepo({ [`tickets/${HASHED_TICKET}.json`]: { ...ticket(HASHED_TICKET), displayId: "T-001" } });
    const ctx = context(root, makeState(root, { kind: "ticket", id: HASHED_TICKET, displayId: "T-001" }));
    editSource(root);
    edit(root, "tickets/T-001.json", ticket("T-001"));
    const wrong = commit(root, ["src/a.ts", ".story/tickets/T-001.json"]);
    const r = await commitDone(ctx, wrong);
    expect(instructionOf(r)).toContain(`ticket file .story/tickets/${HASHED_TICKET}.json is not in the commit`);
    expect(committed(ctx)).toBe(false);

    git(root, ["rm", "-q", ".story/tickets/T-001.json"]);
    edit(root, `tickets/${HASHED_TICKET}.json`, { ...ticket(HASHED_TICKET, { status: "complete", completedDate: EARLIER }), displayId: "T-001" });
    const right = commit(root, [`.story/tickets/${HASHED_TICKET}.json`]);
    const ctx2 = context(root, makeState(root, { kind: "ticket", id: HASHED_TICKET, displayId: "T-001" }, {
      git: { ...ctx.state.git, itemBaseHead: wrong, expectedHead: wrong },
    } as Partial<FullSessionState>));
    const r2 = await commitDone(ctx2, right);
    expect(committed(ctx2), instructionOf(r2)).toBe(true);
  });

  it("F4: a hash-named issue's file is the one its id names, never its display id's", async () => {
    const root = buildRepo({ [`issues/${HASHED_ISSUE}.json`]: { ...issue(HASHED_ISSUE), displayId: "ISS-001" } });
    const ctx = context(root, makeState(root, { kind: "issue", id: HASHED_ISSUE, displayId: "ISS-001" }));
    editSource(root);
    edit(root, "issues/ISS-001.json", issue("ISS-001"));
    const wrong = commit(root, ["src/a.ts", ".story/issues/ISS-001.json"]);
    const r = await commitDone(ctx, wrong);
    expect(instructionOf(r)).toContain(`issue file .story/issues/${HASHED_ISSUE}.json is not in the commit`);
    expect(committed(ctx)).toBe(false);
  });

  it("F5: a commit whose tree cannot be read is refused, not accepted", async () => {
    const root = buildRepo({ "tickets/T-001.json": ticket("T-001") });
    const ctx = context(root, makeState(root, { kind: "ticket", id: "T-001" }));
    editSource(root);
    edit(root, "tickets/T-001.json", ticket("T-001", { status: "complete", completedDate: EARLIER }));
    const hash = commit(root, ["src/a.ts", ".story/tickets/T-001.json"]);
    vi.spyOn(gitInspector, "gitDiffTreeNames").mockResolvedValue({ ok: false, reason: "git_error", message: "boom" } as never);
    const r = await commitDone(ctx, hash);
    expect(instructionOf(r)).toContain("its contents could not be verified (git error: boom)");
    expect(committed(ctx)).toBe(false);
  });

  it("F6: an itemless commit is accepted without loading the project", async () => {
    const root = buildRepo({});
    const ctx = context(root, makeState(root, { kind: "none" }));
    const load = vi.spyOn(ctx, "loadProject");
    editSource(root);
    const hash = commit(root, ["src/a.ts"]);
    const r = await commitDone(ctx, hash);
    expect(committed(ctx), instructionOf(r)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("F7: overrideAttribution does not get a code-only commit through", async () => {
    const root = buildRepo({ "tickets/T-001.json": ticket("T-001") });
    const ctx = context(root, makeState(root, { kind: "ticket", id: "T-001" }));
    editSource(root);
    const hash = commit(root, ["src/a.ts"]);
    const r = await commitDone(ctx, hash, { overrideAttribution: true } as Partial<GuideReportInput>);
    expect(instructionOf(r)).toContain("ticket file .story/tickets/T-001.json is not in the commit");
    expect(committed(ctx)).toBe(false);
  });
});

describe("ISS-1396: a ledger record under another name fails closed", { timeout: 60000 }, () => {
  it("F8: a ticket loaded from a misnamed file is refused naming both paths, at commit_done and at files_staged", async () => {
    const root = buildRepo({ "tickets/T-009.json": ticket("T-001") });
    const ctx = context(root, makeState(root, { kind: "ticket", id: "T-001" }));
    editSource(root);
    edit(root, "tickets/T-009.json", ticket("T-001", { status: "complete", completedDate: EARLIER }));
    const hash = commit(root, ["src/a.ts", ".story/tickets/T-009.json"]);
    const r = await commitDone(ctx, hash);
    const text = instructionOf(r);
    expect(text).toContain("was loaded from \".story/tickets/T-009.json\"");
    expect(text).toContain("\".story/tickets/T-001.json\"");
    expect(text).toContain("if it is tracked, commit the rename");
    expect(committed(ctx)).toBe(false);

    const root2 = buildRepo({ "tickets/T-009.json": ticket("T-001") });
    const ctx2 = context(root2, makeState(root2, { kind: "ticket", id: "T-001" }, { finalizeCheckpoint: null } as Partial<FullSessionState>));
    editSource(root2);
    edit(root2, "tickets/T-009.json", ticket("T-001", { status: "complete", completedDate: EARLIER }));
    git(root2, ["add", "--", "src/a.ts", ".story/tickets/T-009.json"]);
    const s = await stage.report(ctx2, { completedAction: "files_staged" } as GuideReportInput);
    expect(instructionOf(s)).toContain("was loaded from \".story/tickets/T-009.json\"");
  });

  it("F9: a deferred issue loaded from a misnamed file with uncommitted changes is never exempted", async () => {
    const root = buildRepo({ "issues/ISS-009.json": issue("ISS-001", DEFERRAL) });
    const exit = { exit: "deferred", disposition: "owner_gated", reason: DEFERRAL.dispositionReason, ref: "N-001" };
    const ctx = context(root, makeState(root, { kind: "issue", id: "ISS-001", exit }));
    // Still the same deferral, so only the misplaced-record guard can refuse
    // the exemption: the canonical path is absent, so git sees nothing there.
    edit(root, "issues/ISS-009.json", issue("ISS-001", { ...DEFERRAL, impact: "Changed after the fact." }));
    expect(await deferralLeftIssueUnchanged(ctx)).toBe(false);
    editSource(root);
    const hash = commit(root, ["src/a.ts"]);
    const r = await commitDone(ctx, hash);
    expect(instructionOf(r)).toContain("was loaded from \".story/issues/ISS-009.json\"");
    expect(committed(ctx)).toBe(false);
  });

  it("a canonical file plus a misnamed duplicate gets the reconcile diagnostic", async () => {
    const root = buildRepo({ "tickets/T-001.json": ticket("T-001"), "tickets/T-009.json": ticket("T-001") });
    const ctx = context(root, makeState(root, { kind: "ticket", id: "T-001" }));
    editSource(root);
    edit(root, "tickets/T-001.json", ticket("T-001", { status: "complete", completedDate: EARLIER }));
    const hash = commit(root, ["src/a.ts", ".story/tickets/T-001.json"]);
    const r = await commitDone(ctx, hash);
    const text = instructionOf(r);
    expect(text).toContain("has two ledger records");
    expect(text).toContain("\".story/tickets/T-001.json\"");
    expect(text).toContain("\".story/tickets/T-009.json\"");
    expect(text).toContain("without overwriting either");
    expect(committed(ctx)).toBe(false);
  });
});

describe("ISS-1396: a merge commit is refused before any exemption", { timeout: 60000 }, () => {
  it("F10: a merge at HEAD is refused for an ordinary ticket, an unchanged deferral and an itemless session", async () => {
    const t = buildRepo({ "tickets/T-001.json": ticket("T-001") });
    const tctx = context(t, makeState(t, { kind: "ticket", id: "T-001" }));
    editSource(t);
    edit(t, "tickets/T-001.json", ticket("T-001", { status: "complete", completedDate: EARLIER }));
    const tm = mergeAtHead(t, ["src/a.ts", ".story/tickets/T-001.json"]);
    expect(instructionOf(await commitDone(tctx, tm))).toContain(`Commit ${tm.slice(0, 7)} is a merge commit (2 parents)`);
    expect(committed(tctx)).toBe(false);

    const d = buildRepo({ "issues/ISS-001.json": issue("ISS-001", DEFERRAL) });
    const exit = { exit: "deferred", disposition: "owner_gated", reason: DEFERRAL.dispositionReason, ref: "N-001" };
    const dctx = context(d, makeState(d, { kind: "issue", id: "ISS-001", exit }));
    editSource(d);
    const dm = mergeAtHead(d, ["src/a.ts"]);
    expect(instructionOf(await commitDone(dctx, dm))).toContain("is a merge commit (2 parents)");
    expect(committed(dctx)).toBe(false);

    const n = buildRepo({});
    const nctx = context(n, makeState(n, { kind: "none" }));
    editSource(n);
    const nm = mergeAtHead(n, ["src/a.ts"]);
    expect(instructionOf(await commitDone(nctx, nm))).toContain("is a merge commit (2 parents)");
    expect(committed(nctx)).toBe(false);
  });

  it("F10: the moved-HEAD route at files_staged refuses the same merge", async () => {
    const root = buildRepo({ "tickets/T-001.json": ticket("T-001") });
    const ctx = context(root, makeState(root, { kind: "ticket", id: "T-001" }, { finalizeCheckpoint: null } as Partial<FullSessionState>));
    editSource(root);
    edit(root, "tickets/T-001.json", ticket("T-001", { status: "complete", completedDate: EARLIER }));
    mergeAtHead(root, ["src/a.ts", ".story/tickets/T-001.json"]);
    const r = await stage.report(ctx, { completedAction: "files_staged" } as GuideReportInput);
    expect(instructionOf(r)).toContain("is a merge commit (2 parents)");
    expect(committed(ctx)).toBe(false);
  });

  it("an ordinary code-only commit for an unchanged deferral is still accepted (the ISS-1380 exemption)", async () => {
    const root = buildRepo({ "issues/ISS-001.json": issue("ISS-001", DEFERRAL) });
    const exit = { exit: "deferred", disposition: "owner_gated", reason: DEFERRAL.dispositionReason, ref: "N-001" };
    const ctx = context(root, makeState(root, { kind: "issue", id: "ISS-001", exit }));
    editSource(root);
    const hash = commit(root, ["src/a.ts"]);
    const r = await commitDone(ctx, hash);
    expect(committed(ctx), instructionOf(r)).toBe(true);
  });
});

describe("ISS-1396: ISS-922's refusal keeps precedence", { timeout: 60000 }, () => {
  it("reporting the baseline with a misnamed ledger file still says no new commit was detected", async () => {
    const root = buildRepo({ "tickets/T-009.json": ticket("T-001") });
    const ctx = context(root, makeState(root, { kind: "ticket", id: "T-001" }));
    const r = await commitDone(ctx, head(root));
    expect(instructionOf(r)).toContain("No new commit detected");
    expect(instructionOf(r)).not.toContain("was loaded from");
  });

  it("reporting the baseline with a loader that throws still says no new commit was detected", async () => {
    // An issue: a ticket's T-537 checkpoint check loads the project before ISS-922.
    const root = buildRepo({ "issues/ISS-001.json": issue("ISS-001") });
    const ctx = context(root, makeState(root, { kind: "issue", id: "ISS-001" }));
    vi.spyOn(ctx, "loadProject").mockRejectedValue(new Error("loader exploded"));
    const r = await commitDone(ctx, head(root));
    expect(instructionOf(r)).toContain("No new commit detected");
  });
});
