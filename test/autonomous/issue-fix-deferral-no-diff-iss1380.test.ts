/**
 * ISS-1380 (plan 2h, v2 notes): a deferral that leaves its issue file
 * byte-identical to HEAD, driven end to end through the guide in a real git
 * repository. No git mocks.
 *
 * - Path A: nothing else changed, so the item completes without a commit, but
 *   only on a repo-wide clean tree.
 * - Path B: other changes are committed without the issue file.
 * - Both waivers need git proof that the issue file is unchanged AND a fresh
 *   classification that still reads as the recorded deferral.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { localDateOf } from "../../src/core/local-date.js";
import { git } from "../helpers/git-fixture.js";
import { serializeJSON } from "../../src/core/project-loader.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { deferralLeftIssueUnchanged } from "../../src/autonomous/stages/finalize.js";
import { resolvedAs } from "./_issue-sweep-harness.js";
import { STORY_GITIGNORE_ENTRIES } from "../../src/core/init.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";
import * as session from "../../src/autonomous/session.js";

const TODAY = localDateOf(new Date());
const EARLIER = "2026-01-02";
const TASK = "iss1380-task";
const ISSUE = ".story/issues/ISS-001.json";

const DEFERRAL = {
  disposition: "owner_gated",
  dispositionReason: "Needs the owner's call on pricing.",
  dispositionRef: "N-001",
  dispositionFor: "owner_gated",
};

function issue(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "ISS-001", title: "Pricing question", status: "open", severity: "high", components: [],
    impact: "Pricing is unclear.", resolution: null, location: [], discoveredDate: EARLIER,
    resolvedDate: null, relatedTickets: [], updatedDate: TODAY,
    ...extra,
  };
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) {
    const r = roots.pop()!;
    killSidecarsInRoot(r);
    rmSync(r, { recursive: true, force: true });
  }
});

/** A committed project whose only open item is ISS-001 with `issueExtra`. */
function buildRepo(issueExtra: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "iss1380-e2e-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  // What a set-up project already ignores, so the start changes nothing tracked.
  writeFileSync(join(story, ".gitignore"), STORY_GITIGNORE_ENTRIES.join("\n") + "\n");
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss1380-e2e", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    recipeOverrides: { stages: { BUILD: { enabled: false }, VERIFY: { enabled: false }, TEST: { enabled: false }, WRITE_TESTS: { enabled: false } } },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "iss1380", date: EARLIER,
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(story, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Done", description: "A test.", type: "task", status: "complete",
    phase: "p1", order: 10, createdDate: EARLIER, completedDate: EARLIER, blockedBy: [], parentTicket: null,
  }));
  writeFileSync(join(story, "notes", "N-001.json"), JSON.stringify({
    id: "N-001", title: "Pricing", content: "The owner decides pricing.", tags: [], status: "active",
    createdDate: EARLIER, updatedDate: EARLIER, updatedAt: `${EARLIER}T00:00:00.000Z`,
  }, null, 2) + "\n");
  // The ledger's own serializer, so a release that restores the same record
  // restores the same bytes.
  writeFileSync(join(story, "issues", "ISS-001.json"), serializeJSON({ ...issue(issueExtra), displayId: "ISS-001" }));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t.t"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

type Call = { text: string; isError: boolean };

async function guide(root: string, input: Parameters<typeof handleAutonomousGuide>[1]): Promise<Call> {
  const r = await handleAutonomousGuide(root, { clientTaskId: TASK, ...input } as Parameters<typeof handleAutonomousGuide>[1]);
  return { text: (r.content ?? []).map((c) => ("text" in c ? String(c.text) : "")).join("\n"), isError: Boolean(r.isError) };
}

function sessionDir(root: string): string {
  const base = join(root, ".story", "sessions");
  const dirs = readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory());
  if (dirs.length !== 1) throw new Error(`expected one session, found ${dirs.join(", ")}`);
  return join(base, dirs[0]!);
}

function state(root: string): FullSessionState {
  return JSON.parse(readFileSync(join(sessionDir(root), "state.json"), "utf-8")) as FullSessionState;
}

function events(root: string, type: string): Array<Record<string, unknown>> {
  return readFileSync(join(sessionDir(root), "events.log"), "utf-8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.type === type);
}

const report = (root: string, rep: Record<string, unknown>): Promise<Call> =>
  guide(root, { action: "report", sessionId: state(root).sessionId, report: rep } as unknown as Parameters<typeof handleAutonomousGuide>[1]);

/**
 * Start targeted at ISS-001, pick it, let `agent` edit the issue as the agent
 * would, and report it finished. Ends at FINALIZE.
 */
async function toFinalize(root: string, agent: (rec: Record<string, unknown>) => Record<string, unknown> | null = () => null): Promise<Call> {
  const s = await guide(root, { action: "start", sessionId: null, mode: "auto", targetWork: ["ISS-001"] } as Parameters<typeof handleAutonomousGuide>[1]);
  expect(s.isError, s.text).toBe(false);
  if (state(root).state === "PICK_TICKET") {
    const p = await report(root, { completedAction: "issue_picked", issueId: "ISS-001" });
    expect(p.isError, p.text).toBe(false);
  }
  expect(state(root).state, JSON.stringify(state(root))).toBe("ISSUE_FIX");
  const edited = agent(JSON.parse(readFileSync(join(root, ISSUE), "utf-8")) as Record<string, unknown>);
  if (edited) writeFileSync(join(root, ISSUE), serializeJSON(edited));
  const r = await report(root, { completedAction: "issue_fixed" });
  expect(state(root).state, r.text).toBe("FINALIZE");
  return r;
}

const head = (root: string): string => git(root, ["rev-parse", "HEAD"]);
/** The issue file's blob on disk equals HEAD's. */
const issueMatchesHead = (root: string): boolean =>
  git(root, ["hash-object", ISSUE]) === git(root, ["rev-parse", `HEAD:${ISSUE}`]);
const porcelain = (root: string): string => git(root, ["status", "--porcelain", "--untracked-files=all"]);
const editSource = (root: string, body = "export const a = 2;\n"): void => writeFileSync(join(root, "src", "a.ts"), body);
const commitAll = (root: string, paths: string[], msg = "work"): string => {
  git(root, ["add", "--", ...paths]);
  git(root, ["commit", "-qm", msg]);
  return head(root);
};
/** Answers the knowledge review a real commit owes; nothing here touches knowledge. */
async function knowledge(root: string, hash: string): Promise<Call> {
  expect(state(root).state).toBe("KNOWLEDGE_REVIEW");
  const r = await report(root, {
    completedAction: "knowledge_reviewed",
    knowledgeImpact: { implementationCommit: hash, maintenanceCommits: [], checked: ["N-001"], outcome: "none", reason: "The fixture has no knowledge records." },
  });
  expect(r.isError, r.text).toBe(false);
  return r;
}
const handover = (root: string): Promise<Call> =>
  report(root, { completedAction: "handover_written", handoverContent: "# Handover\n\nDone." });


/**
 * Every state the session writes, so the committed write itself can be read:
 * COMPLETE clears finalizedItem in the same guide call.
 */
function recordWrites(): FullSessionState[] {
  const writes: FullSessionState[] = [];
  const real = session.writeSessionSync;
  vi.spyOn(session, "writeSessionSync").mockImplementation(((...args: Parameters<typeof real>) => {
    writes.push(JSON.parse(JSON.stringify(args[1])) as FullSessionState);
    return real(...args);
  }) as typeof real);
  return writes;
}
const committedWrite = (writes: FullSessionState[]): FullSessionState | undefined =>
  writes.find((w) => w.finalizeCheckpoint === "committed");

const NOT_STAGED = `Issue file ${ISSUE} is not staged.`;
const NOTHING_STAGED = "No files are staged.";
const DEFERRED_EXIT = { exit: "deferred", disposition: "owner_gated", reason: DEFERRAL.dispositionReason, ref: "N-001" };

describe("ISS-1380 path A: a deferral with nothing else changed (real git)", { timeout: 60000 }, () => {
  it("E19: completes without a commit and the handover says so", async () => {
    const root = buildRepo(DEFERRAL);
    const before = head(root);
    await toFinalize(root);
    expect(issueMatchesHead(root)).toBe(true);
    git(root, ["reset", "-q"]);
    const r = await report(root, { completedAction: "files_staged" });
    expect(r.isError, r.text).toBe(false);
    expect(head(root)).toBe(before);
    expect(issueMatchesHead(root)).toBe(true);
    const s = state(root);
    expect(s.state, r.text).toBe("HANDOVER");
    expect(s.deferredIssues).toEqual(["ISS-001"]);
    expect(s.resolvedIssues).toEqual([]);
    expect(s.issueExits).toEqual([{ id: "ISS-001", ...DEFERRED_EXIT, commitHash: null }]);
    expect(s.currentIssue).toBeNull();
    expect(s.currentIssueExit).toBeNull();
    const ev = events(root, "issue_fix_no_commit");
    expect(ev.length).toBe(1);
    expect(ev[0]!.data).toEqual({ issueId: "ISS-001", ...DEFERRED_EXIT });
    expect(events(root, "commit")).toEqual([]);
    const h = await handover(root);
    expect(h.text).toContain("- ISS-001 (deferred: owner decision requested, Needs the owner's call on pricing.; evidence N-001, no commit)");
    expect(h.text).toContain("0 ticket(s) and 1 issue(s) completed.");
  });

  it("E19: the committed write itself carries the exit on finalizedItem, with no commit", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    const writes = recordWrites();
    await report(root, { completedAction: "files_staged" });
    const w = committedWrite(writes);
    expect(w, "no committed write").toBeDefined();
    expect(w!.finalizedItem).toEqual({ kind: "issue", id: "ISS-001", commitHash: null, exit: DEFERRED_EXIT });
    expect(w!.currentIssue ?? null).toBeNull();
    expect(w!.currentIssueExit ?? null).toBeNull();
    expect(w!.knowledgeReview ?? null).toBeNull();
  });

  it("E19u: an unstaged tracked edit keeps it from completing without a commit", async () => {
    const root = buildRepo(DEFERRAL);
    const before = head(root);
    await toFinalize(root);
    editSource(root);
    const r = await report(root, { completedAction: "files_staged" });
    expect(r.text).toContain("the working tree is not clean");
    expect(r.text).toContain("M src/a.ts");
    expect(state(root).state).toBe("FINALIZE");
    expect(state(root).finalizeCheckpoint ?? null).not.toBe("committed");
    expect(events(root, "issue_fix_no_commit")).toEqual([]);
    expect(head(root)).toBe(before);
  });

  it("E19n: an untracked source or test file keeps it from completing without a commit", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "b.test.ts"), "// new\n");
    const r = await report(root, { completedAction: "files_staged" });
    expect(r.text).toContain("the working tree is not clean");
    expect(r.text).toContain("?? test/b.test.ts");
    expect(state(root).state).toBe("FINALIZE");
    expect(events(root, "issue_fix_no_commit")).toEqual([]);
  });

  it("E19s: an untracked file stays visible when the repository hides untracked files", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    git(root, ["config", "status.showUntrackedFiles", "no"]);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    const r = await report(root, { completedAction: "files_staged" });
    expect(r.text).toContain("the working tree is not clean");
    expect(r.text).toContain("?? src/b.ts");
    expect(state(root).state).toBe("FINALIZE");
    expect(events(root, "issue_fix_no_commit")).toEqual([]);
  });
});

/** Rewrites currentIssueExit in state.json by hand, as damage would. */
function setRecordedExit(root: string, exit: unknown): void {
  const file = join(sessionDir(root), "state.json");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  if (exit === undefined) delete raw.currentIssueExit;
  else raw.currentIssueExit = exit;
  writeFileSync(file, JSON.stringify(raw, null, 2));
}
const NO_REF_DEFERRAL = { exit: "deferred", disposition: "owner_gated", reason: DEFERRAL.dispositionReason };

describe("ISS-1380: a malformed recorded exit fails closed (real git)", { timeout: 60000 }, () => {
  it("E23: an absent exit still loads as null; a malformed one loads, and never as null", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    setRecordedExit(root, undefined);
    expect(session.readSession(sessionDir(root))?.currentIssueExit).toBeNull();
    setRecordedExit(root, NO_REF_DEFERRAL);
    const loaded = session.readSession(sessionDir(root));
    expect(loaded).not.toBeNull();
    expect(loaded!.currentIssueExit).not.toBeNull();
    expect(loaded!.currentIssueExit?.exit).not.toBe("deferred");
  });

  it("E23: FINALIZE refuses a deferral with no ref by name and never books the open issue as resolved", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    setRecordedExit(root, NO_REF_DEFERRAL);
    editSource(root);
    const hash = commitAll(root, ["src/a.ts"]);
    const r = await report(root, { completedAction: "commit_done", commitHash: hash });
    expect(r.text).toContain("`currentIssueExit`");
    expect(r.text).toContain("is malformed");
    const s = state(root);
    expect(s.state).toBe("FINALIZE");
    expect(s.finalizeCheckpoint).not.toBe("committed");
    expect(s.resolvedIssues ?? []).not.toContain("ISS-001");
    expect(s.deferredIssues ?? []).not.toContain("ISS-001");
  });
});

describe("ISS-1380 path B: a deferral with other changes (real git)", { timeout: 60000 }, () => {
  it("E20: a commit without the issue file is accepted through commit_done", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    editSource(root);
    const hash = commitAll(root, ["src/a.ts"]);
    const writes = recordWrites();
    const r = await report(root, { completedAction: "commit_done", commitHash: hash });
    // E10/E17: the exit rides on finalizedItem in the committed write.
    const w = committedWrite(writes);
    expect(w, "no committed write").toBeDefined();
    expect(w!.finalizedItem).toEqual({ kind: "issue", id: "ISS-001", commitHash: hash, exit: DEFERRED_EXIT });
    expect(w!.currentIssueExit ?? null).toBeNull();
    expect(r.isError, r.text).toBe(false);
    const k = await knowledge(root, hash);
    const s = state(root);
    expect(s.state, k.text).toBe("HANDOVER");
    expect(s.deferredIssues).toEqual(["ISS-001"]);
    expect(s.resolvedIssues).toEqual([]);
    expect(s.issueExits).toEqual([{ id: "ISS-001", ...DEFERRED_EXIT, commitHash: hash }]);
    const commit = events(root, "commit");
    expect(commit.length).toBe(1);
    expect(commit[0]!.data).toMatchObject({ commitHash: hash, issueId: "ISS-001", issueExit: DEFERRED_EXIT });
    expect(events(root, "issue_fix_no_commit")).toEqual([]);
  });

  it("E20: the same change through files_staged, then the commit, is accepted", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    editSource(root);
    git(root, ["add", "src/a.ts"]);
    const staged = await report(root, { completedAction: "files_staged" });
    expect(staged.text).not.toContain(NOT_STAGED);
    expect(staged.isError, staged.text).toBe(false);
    git(root, ["commit", "-qm", "work"]);
    const hash = head(root);
    const r = await report(root, { completedAction: "commit_done", commitHash: hash });
    expect(r.isError, r.text).toBe(false);
    const k = await knowledge(root, hash);
    expect(state(root).state, k.text).toBe("HANDOVER");
    expect(state(root).issueExits).toEqual([{ id: "ISS-001", ...DEFERRED_EXIT, commitHash: hash }]);
  });
});

describe("ISS-1380 path B through the moved-HEAD check (real git)", { timeout: 60000 }, () => {
  it("E20: a commit made first, then files_staged, is accepted without the issue file", async () => {
    const root = buildRepo(DEFERRAL);
    await toFinalize(root);
    editSource(root);
    const hash = commitAll(root, ["src/a.ts"]);
    const r = await report(root, { completedAction: "files_staged" });
    expect(r.text).not.toContain("is not in the commit");
    expect(r.isError, r.text).toBe(false);
    const k = await knowledge(root, hash);
    expect(state(root).state, k.text).toBe("HANDOVER");
    expect(state(root).issueExits).toEqual([{ id: "ISS-001", ...DEFERRED_EXIT, commitHash: hash }]);
  });
});

describe("ISS-1380: the ordinary guards stay (real git)", { timeout: 60000 }, () => {
  it("E21: a fixed exit with its issue file unstaged is refused as today", async () => {
    const root = buildRepo({ updatedDate: EARLIER });
    await toFinalize(root, (rec) => ({ ...rec, status: "resolved", resolution: "Fixed it.", resolvedDate: TODAY }));
    editSource(root);
    git(root, ["add", "src/a.ts"]);
    const r = await report(root, { completedAction: "files_staged" });
    expect(r.text).toContain(NOT_STAGED);
  });

  it("E21b: a deferral whose issue file did change needs it staged, as today", async () => {
    const root = buildRepo({ ...DEFERRAL, updatedDate: EARLIER });
    await toFinalize(root);
    expect(issueMatchesHead(root)).toBe(false);
    editSource(root);
    git(root, ["add", "src/a.ts"]);
    const r = await report(root, { completedAction: "files_staged" });
    expect(r.text).toContain(NOT_STAGED);
    const none = buildRepo({ ...DEFERRAL, updatedDate: EARLIER });
    await toFinalize(none);
    const a = await report(none, { completedAction: "files_staged" });
    expect(a.text).toContain(NOTHING_STAGED);
    expect(events(none, "issue_fix_no_commit")).toEqual([]);
  });

  it("E22: restoring the actionable baseline after a deferral was reported refuses both paths", async () => {
    // The baseline holds an actionable issue; the agent writes a deferral.
    const root = buildRepo({});
    await toFinalize(root, (rec) => ({ ...rec, ...DEFERRAL }));
    expect(state(root).currentIssueExit).toEqual(DEFERRED_EXIT);
    git(root, ["checkout", "HEAD", "--", ISSUE]);
    expect(issueMatchesHead(root)).toBe(true);
    // Path A.
    const a = await report(root, { completedAction: "files_staged" });
    expect(a.text).toContain(NOTHING_STAGED);
    expect(events(root, "issue_fix_no_commit")).toEqual([]);
    // Path B, staged.
    editSource(root);
    git(root, ["add", "src/a.ts"]);
    const b = await report(root, { completedAction: "files_staged" });
    expect(b.text).toContain(NOT_STAGED);
    // Path B, committed, then reported through the moved-HEAD check.
    git(root, ["commit", "-qm", "work"]);
    const c = await report(root, { completedAction: "files_staged" });
    expect(c.text).toContain(`issue file ${ISSUE} is not in the commit`);
    expect(state(root).state).toBe("FINALIZE");
    expect(events(root, "commit")).toEqual([]);
  });

  it("E22 (ISS-1396): the same restored baseline committed and reported as HEAD through commit_done is refused", async () => {
    const root = buildRepo({});
    await toFinalize(root, (rec) => ({ ...rec, ...DEFERRAL }));
    git(root, ["checkout", "HEAD", "--", ISSUE]);
    editSource(root);
    git(root, ["add", "src/a.ts"]);
    git(root, ["commit", "-qm", "work"]);
    const r = await report(root, { completedAction: "commit_done", commitHash: git(root, ["rev-parse", "HEAD"]) });
    expect(r.text).toContain(`issue file ${ISSUE} is not in the commit`);
    expect(state(root).state).toBe("FINALIZE");
    expect(events(root, "commit")).toEqual([]);
  });
});

describe("ISS-1380: exits through a real commit (real git)", { timeout: 60000 }, () => {
  it("E10: a fixed exit records resolved, its exit and the commit", async () => {
    const root = buildRepo({ updatedDate: EARLIER });
    await toFinalize(root, (rec) => ({ ...rec, status: "resolved", resolution: "Fixed it.", resolvedDate: TODAY }));
    editSource(root);
    const hash = commitAll(root, ["src/a.ts", ISSUE]);
    const r = await report(root, { completedAction: "commit_done", commitHash: hash });
    expect(r.isError, r.text).toBe(false);
    await knowledge(root, hash);
    const s = state(root);
    expect(s.resolvedIssues).toEqual(["ISS-001"]);
    expect(s.deferredIssues).toEqual([]);
    expect(s.issueExits).toEqual([{ id: "ISS-001", exit: "fixed", commitHash: hash }]);
    expect(events(root, "commit")[0]!.data).toMatchObject({ issueExit: { exit: "fixed" } });
  });

  it("E10 + E14r: a wontfix closure keeps its captured reason after the issue is edited", async () => {
    const root = buildRepo({ updatedDate: EARLIER });
    await toFinalize(root, (rec) => ({ ...rec, ...resolvedAs("wontfix", "Not worth the risk.") }));
    const hash = commitAll(root, [ISSUE]);
    const r = await report(root, { completedAction: "commit_done", commitHash: hash });
    expect(r.isError, r.text).toBe(false);
    const k = await knowledge(root, hash);
    const s = state(root);
    expect(s.state, k.text).toBe("HANDOVER");
    expect(s.resolvedIssues).toEqual(["ISS-001"]);
    expect(s.issueExits).toEqual([{ id: "ISS-001", exit: "disposed", kind: "wontfix", reason: "Not worth the risk.", commitHash: hash }]);
    // Edited after the commit, before the handover.
    const rec = JSON.parse(readFileSync(join(root, ISSUE), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(root, ISSUE), serializeJSON({ ...rec, resolution: "Edited later." }));
    const h = await handover(root);
    expect(h.text).toContain("- ISS-001 (closed as wontfix: Not worth the risk.)");
    expect(h.text).not.toContain("Edited later.");
  });
});

describe("ISS-1380 E18: deferralLeftIssueUnchanged against a real repository", { timeout: 60000 }, () => {
  const recipe = { id: "coding", pipeline: [], postComplete: [], stages: {}, dirtyFileHandling: "block", defaults: {} } as unknown as ResolvedRecipe;

  function ctx(root: string, over: Record<string, unknown> = {}): StageContext {
    const sessionsDir = join(root, ".story", "sessions", "e18");
    mkdirSync(sessionsDir, { recursive: true });
    const s = {
      sessionId: "00000000-0000-0000-0000-0000000000e1",
      state: "FINALIZE",
      git: { branch: "main", mergeBase: head(root), itemBaseHead: head(root) },
      currentIssue: { id: "ISS-001", title: "Pricing question", severity: "high" },
      currentIssueExit: DEFERRED_EXIT,
      ...over,
    } as unknown as FullSessionState;
    return new StageContext(root, sessionsDir, s, recipe);
  }

  it("true only when the file is clean, unchanged since the baseline and still the recorded deferral", async () => {
    const root = buildRepo(DEFERRAL);
    expect(await deferralLeftIssueUnchanged(ctx(root))).toBe(true);
    // An ordinary exit never qualifies.
    expect(await deferralLeftIssueUnchanged(ctx(root, { currentIssueExit: { exit: "fixed" } }))).toBe(false);
    // A recorded deferral that differs from the issue's own.
    expect(await deferralLeftIssueUnchanged(ctx(root, { currentIssueExit: { ...DEFERRED_EXIT, reason: "Other." } }))).toBe(false);
    // A baseline that is not a commit.
    expect(await deferralLeftIssueUnchanged(ctx(root, { git: { branch: "main", itemBaseHead: "0".repeat(40) } }), "HEAD")).toBe(false);
  });

  it("false when the file is dirty in the work tree, staged, or untracked", async () => {
    const root = buildRepo(DEFERRAL);
    const original = readFileSync(join(root, ISSUE), "utf-8");
    writeFileSync(join(root, ISSUE), original.replace("pricing", "Pricing"));
    expect(await deferralLeftIssueUnchanged(ctx(root))).toBe(false);
    git(root, ["add", ISSUE]);
    expect(await deferralLeftIssueUnchanged(ctx(root))).toBe(false);
    git(root, ["reset", "-q"]);
    writeFileSync(join(root, ISSUE), original);
    git(root, ["rm", "-q", "--cached", ISSUE]);
    git(root, ["commit", "-qm", "untrack"]);
    expect(porcelain(root)).toContain(`?? ${ISSUE}`);
    expect(await deferralLeftIssueUnchanged(ctx(root))).toBe(false);
  });

  it("false when a commit since the baseline changed the file, true for one that did not", async () => {
    const root = buildRepo(DEFERRAL);
    const base = head(root);
    editSource(root);
    const other = commitAll(root, ["src/a.ts"]);
    expect(await deferralLeftIssueUnchanged(ctx(root, { git: { branch: "main", itemBaseHead: base } }), other)).toBe(true);
    const rec = JSON.parse(readFileSync(join(root, ISSUE), "utf-8")) as Record<string, unknown>;
    writeFileSync(join(root, ISSUE), serializeJSON({ ...rec, impact: "Changed." }));
    const touched = commitAll(root, [ISSUE]);
    expect(await deferralLeftIssueUnchanged(ctx(root, { git: { branch: "main", itemBaseHead: base } }), touched)).toBe(false);
  });
});
