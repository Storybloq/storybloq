/**
 * ISS-1380: ISSUE_FIX finishes an issue through the issue sweep's own
 * classifier, on any of its three exits: fixed, a reasoned closure
 * (disposed), or an evidenced deferral. The exit is captured under the lock,
 * carried through FINALIZE, and reported from the captured record.
 *
 * Stage-level cases. The real-git end-to-end cases (no-commit completion,
 * the issue-file waiver, the helper) live in
 * test/autonomous/issue-fix-deferral-no-diff-iss1380.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState, GuideReportInput, IssueExit } from "../../../src/autonomous/session-types.js";
import * as projectLoader from "../../../src/core/project-loader.js";
import { localDateOf } from "../../../src/core/local-date.js";
import { resolvedAs, deferredAs } from "../_issue-sweep-harness.js";

vi.mock("../../../src/autonomous/git-inspector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/autonomous/git-inspector.js")>()),
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } }),
}));

const SESSION = "00000000-0000-0000-0000-000000000001";
const OTHER = "ffffffff-0000-0000-0000-000000000009";
const TODAY = localDateOf(new Date());
const EARLIER = "2026-01-02";
const ISSUE_PATH = (root: string) => join(root, ".story", "issues", "ISS-001.json");

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: SESSION,
    recipe: "coding", state: "ISSUE_FIX", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: {
      branch: "main", mergeBase: "abc123", expectedHead: "abc123",
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: undefined,
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], deferredIssues: [], issueExits: [],
    currentIssue: { id: "ISS-001", title: "Pricing question", severity: "high" },
    currentIssueExit: null,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 3 },
  } as unknown as ResolvedRecipe;
}

function setupProject(root: string): void {
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) mkdirSync(join(story, sub), { recursive: true });
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "test", date: EARLIER,
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
  writeFileSync(join(story, "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Done", type: "task", status: "complete",
    phase: "p1", order: 10, description: "", createdDate: EARLIER, completedDate: EARLIER,
    blockedBy: [], parentTicket: null,
  }));
  writeFileSync(join(story, "issues", "ISS-002.json"), JSON.stringify(issue("ISS-002", {})));
}

function issue(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id, title: "Pricing question", status: "inprogress", severity: "high", components: [],
    impact: "Pricing is unclear.", resolution: null, location: [], discoveredDate: EARLIER,
    resolvedDate: null, relatedTickets: [], updatedDate: EARLIER,
    ...extra,
  };
}

function writeIssue(extra: Record<string, unknown>): void {
  writeFileSync(ISSUE_PATH(testRoot), JSON.stringify(issue("ISS-001", extra), null, 2) + "\n");
}
const issueText = (): string => readFileSync(ISSUE_PATH(testRoot), "utf-8");
const readIssue = (): Record<string, unknown> => JSON.parse(issueText()) as Record<string, unknown>;

const mine = (): Record<string, unknown> => ({
  stage: "assigned", reservedBy: { client: "claude", id: "pen-task-1" }, arrangementId: "a-0123456789abcdef",
  since: `${EARLIER}T00:00:00.000Z`, holderRole: "worker", holderSession: SESSION,
});
const OWNER_GATED = deferredAs("owner_gated", "Needs the owner's call on pricing.", "T-001");

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-iss1380-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
  setupProject(testRoot);
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fix(state: FullSessionState = makeState()) {
  const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
  const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
  const advance = await new IssueFixStage().report(ctx, { completedAction: "issue_fixed" });
  return { ctx, advance: advance as { action: string; target?: string; instruction?: string; reminders?: string[]; result?: { instruction: string } } };
}

function events(type: string): Array<Record<string, unknown>> {
  let text = "";
  try { text = readFileSync(join(sessionDir, "events.log"), "utf-8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.type === type);
}

const draft = (ctx: StageContext) => ctx.state as unknown as Record<string, unknown>;

const EXIT_LINES = [
  "Fix it and set it resolved; or resolve it with a kind (`wontfix`, `superseded`, `not_reproducible`, or `duplicate` with `duplicateOf`) and a reason; or set a non-actionable disposition with a reason and an evidence reference.",
  "Verify the issue's premise against the code before acting on it.",
  "`owner_gated` requests an owner decision; it does not record one.",
];

describe("ISS-1380: ISSUE_FIX exits", () => {
  it("E1: resolved with no kind finishes as fixed and stamps the epoch", async () => {
    writeIssue({ status: "resolved", resolution: "Fixed it.", resolvedDate: TODAY, earmark: mine() });
    const { ctx, advance } = await fix();
    expect(advance.action).toBe("goto");
    expect(advance.target).toBe("FINALIZE");
    const after = readIssue();
    expect(after.earmark).toBeNull();
    expect(after.resolutionEpoch).toMatchObject({ issueId: "ISS-001", sessionId: SESSION });
    expect(draft(ctx).issueResolutionEpoch).toEqual(after.resolutionEpoch);
    expect(draft(ctx).currentIssueExit).toEqual({ exit: "fixed" });
    expect(advance.result?.instruction).toContain("Issue ISS-001 resolved (fixed).");
  });

  it("E2: a stale stored kind counts as fixed", async () => {
    const stale = resolvedAs("wontfix", "An older reason.");
    writeIssue({ ...stale, resolution: "Fixed after all." });
    const { ctx, advance } = await fix();
    expect(advance.target).toBe("FINALIZE");
    expect(draft(ctx).currentIssueExit).toEqual({ exit: "fixed" });
  });

  it("E3: resolved as wontfix with a reason is a disposed exit carrying the trimmed reason", async () => {
    writeIssue({ ...resolvedAs("wontfix", "  Not worth the risk.  ") });
    const { ctx, advance } = await fix();
    expect(advance.target).toBe("FINALIZE");
    expect(draft(ctx).currentIssueExit).toEqual({ exit: "disposed", kind: "wontfix", reason: "Not worth the risk." });
    expect(readIssue().resolutionEpoch).toMatchObject({ issueId: "ISS-001" });
    expect(advance.result?.instruction).toContain("Issue ISS-001 closed as wontfix: Not worth the risk.");
    expect(events("issue_fix_exit")).toEqual([expect.objectContaining({ data: expect.objectContaining({ id: "ISS-001", exit: "disposed", kind: "wontfix" }) })]);
  });

  it("E3b: wontfix with a blank resolution retries with the three exits and writes nothing", async () => {
    writeIssue({ ...resolvedAs("wontfix", "   ") });
    const before = issueText();
    const spy = vi.spyOn(projectLoader, "writeIssueUnlocked");
    const { advance } = await fix();
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("without a resolution");
    expect(advance.reminders).toEqual(expect.arrayContaining(EXIT_LINES));
    expect(spy).not.toHaveBeenCalled();
    expect(issueText()).toBe(before);
  });

  it("E4: resolved as a duplicate of an existing item is disposed", async () => {
    writeIssue({ ...resolvedAs("duplicate", "Same as ISS-002.", { duplicateOf: "ISS-002" }) });
    const { ctx, advance } = await fix();
    expect(advance.target).toBe("FINALIZE");
    expect(draft(ctx).currentIssueExit).toEqual({ exit: "disposed", kind: "duplicate", reason: "Same as ISS-002." });
  });

  it.each([
    ["no duplicateOf", {}, /without duplicateOf/],
    ["a missing target", { duplicateOf: "ISS-404" }, /duplicateOf: --duplicate-of ISS-404 names no ticket or issue/],
  ])("E4b: a duplicate with %s retries and writes nothing", async (_n, extra, pattern) => {
    writeIssue({ ...resolvedAs("duplicate", "Dup.", extra) });
    const before = issueText();
    const spy = vi.spyOn(projectLoader, "writeIssueUnlocked");
    const { advance } = await fix();
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toMatch(pattern);
    expect(spy).not.toHaveBeenCalled();
    expect(issueText()).toBe(before);
  });

  it("E5: an evidenced deferral releases the issue open, keeps its evidence, stamps today and mints no epoch", async () => {
    writeIssue({ earmark: mine(), ...OWNER_GATED });
    const { ctx, advance } = await fix();
    expect(advance.action).toBe("goto");
    expect(advance.target).toBe("FINALIZE");
    const after = readIssue();
    expect(after.status).toBe("open");
    expect(after.earmark ?? null).toBeNull();
    expect(after.disposition).toBe("owner_gated");
    expect(after.dispositionReason).toBe("Needs the owner's call on pricing.");
    expect(after.dispositionRef).toBe("T-001");
    expect(after.updatedDate).toBe(TODAY);
    expect("resolutionEpoch" in after).toBe(false);
    expect(draft(ctx).issueResolutionEpoch).toBeNull();
    expect(draft(ctx).currentIssueExit).toEqual({ exit: "deferred", disposition: "owner_gated", reason: "Needs the owner's call on pricing.", ref: "T-001" });
    expect(advance.result?.instruction).toContain("Issue ISS-001 deferred (owner decision requested): Needs the owner's call on pricing. (evidence T-001)");
    expect(advance.result?.instruction).toContain('call me with completedAction: "files_staged" and nothing staged');
  });

  it.each([
    ["no reason", deferredAs("owner_gated", undefined, "T-001"), /without a valid dispositionReason/],
    ["no ref", deferredAs("owner_gated", "A reason.", undefined), /without a valid dispositionRef/],
    ["a ref naming nothing", deferredAs("owner_gated", "A reason.", "ISS-404"), /dispositionRef: --ref ISS-404 names no ticket, issue, note, lesson or ruling/],
    ["evidence bound to another disposition", deferredAs("owner_gated", "A reason.", "T-001", "escalate_only"), /the evidence was written for disposition escalate_only, not owner_gated/],
  ])("E5n: a deferral with %s retries and writes nothing", async (_n, extra, pattern) => {
    writeIssue({ earmark: mine(), ...extra });
    const before = issueText();
    const spy = vi.spyOn(projectLoader, "writeIssueUnlocked");
    const { ctx, advance } = await fix();
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toMatch(pattern);
    expect(spy).not.toHaveBeenCalled();
    expect(issueText()).toBe(before);
    expect(draft(ctx).currentIssueExit ?? null).toBeNull();
  });

  it("E6: an issue still in progress with no disposition retries, naming all three exits", async () => {
    writeIssue({ earmark: mine() });
    const { advance } = await fix();
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("still inprogress");
    expect(advance.reminders).toEqual(expect.arrayContaining(EXIT_LINES));
  });

  it("E6: the enter text names the three exits instead of 'resolved' only", async () => {
    writeIssue({ earmark: mine() });
    const { IssueFixStage } = await import("../../../src/autonomous/stages/issue-fix.js");
    const ctx = new StageContext(testRoot, sessionDir, makeState(), makeRecipe());
    const result = await new IssueFixStage().enter(ctx);
    if ("action" in result) throw new Error("expected a StageResult");
    for (const line of EXIT_LINES) expect(result.instruction).toContain(line);
    expect(result.reminders).toEqual(expect.arrayContaining(EXIT_LINES));
  });

  it("E7: an issue earmarked for another session retries naming the holder and writes nothing", async () => {
    writeIssue({ ...OWNER_GATED, earmark: { ...mine(), holderSession: OTHER } });
    const before = issueText();
    const spy = vi.spyOn(projectLoader, "writeIssueUnlocked");
    const { advance } = await fix();
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("Could not confirm ISS-001 is still owned by this session (earmarked for");
    expect(spy).not.toHaveBeenCalled();
    expect(issueText()).toBe(before);
  });

  it("E8: a deferral that reads resolved inside the lock is not written", async () => {
    // Disk holds the resolved issue; the unlocked pass sees the deferral.
    writeIssue({ status: "resolved", resolution: "Fixed it.", resolvedDate: TODAY });
    const before = issueText();
    const { loadProject } = await import("../../../src/core/project-loader.js");
    const real = await loadProject(testRoot);
    const stale = real.state.issues.find((i) => i.id === "ISS-001")!;
    Object.assign(stale, { status: "inprogress", resolution: null, resolvedDate: null, ...OWNER_GATED });
    vi.spyOn(projectLoader, "loadProject").mockResolvedValueOnce(real);
    const spy = vi.spyOn(projectLoader, "writeIssueUnlocked");
    const { ctx, advance } = await fix();
    expect(advance.action).toBe("retry");
    expect(advance.instruction).toContain("Could not confirm ISS-001 is still finished and owned by this session");
    expect(spy).not.toHaveBeenCalled();
    expect(issueText()).toBe(before);
    expect(draft(ctx).currentIssueExit ?? null).toBeNull();
  });

  it("E9: repeating the report after the deferred write lands is idempotent", async () => {
    writeIssue({ earmark: mine(), ...OWNER_GATED });
    const first = await fix();
    expect(first.advance.target).toBe("FINALIZE");
    const landed = issueText();
    const second = await fix();
    expect(second.advance.action).toBe("goto");
    expect(second.advance.target).toBe("FINALIZE");
    expect(issueText()).toBe(landed);
    expect(draft(second.ctx).currentIssueExit).toEqual(draft(first.ctx).currentIssueExit);
  });
});

describe("ISS-1380: what a deferral counts as", () => {
  it("E11: a deferred target is done, so a targeted run does not re-pick it", async () => {
    const { getRemainingTargets } = await import("../../../src/autonomous/target-work.js");
    const s = makeState({ targetWork: ["ISS-001"], deferredIssues: ["ISS-001"], currentIssue: null } as unknown as Partial<FullSessionState>);
    expect(getRemainingTargets(s)).toEqual([]);
    expect(getRemainingTargets(makeState({ targetWork: ["ISS-001"], currentIssue: null } as Partial<FullSessionState>))).toEqual(["ISS-001"]);
  });

  it("E15: an issue-only session with cap 2, one fix and one deferral, reaches the cap", async () => {
    writeIssue({ status: "open" });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const s = makeState({
      state: "COMPLETE", currentIssue: null,
      resolvedIssues: ["ISS-003"], deferredIssues: ["ISS-004"],
      config: { maxTicketsPerSession: 2, compactThreshold: "high", reviewBackends: [], handoverInterval: 3 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, s, makeRecipe());
    const advance = await new CompleteStage().enter(ctx);
    expect((advance as { target?: string }).target).toBe("HANDOVER");
    const { issuesFinished } = await import("../../../src/autonomous/session-types.js");
    expect(issuesFinished(s)).toBe(2);
  });

  it("E15: the same session without the deferral is under the cap and picks again", async () => {
    writeIssue({ status: "open" });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const s = makeState({
      state: "COMPLETE", currentIssue: null,
      resolvedIssues: ["ISS-003"],
      config: { maxTicketsPerSession: 2, compactThreshold: "high", reviewBackends: [], handoverInterval: 3 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, s, makeRecipe());
    const advance = await new CompleteStage().enter(ctx);
    expect((advance as { target?: string }).target).toBe("PICK_TICKET");
  });
});

describe("ISS-1380: takeover in the FINALIZE window", () => {
  const DEFERRED: IssueExit = { exit: "deferred", disposition: "owner_gated", reason: "r", ref: "T-001" };

  async function decide(s: FullSessionState, view: Record<string, unknown>) {
    const { decideTakeoverAuthority } = await import("../../../src/autonomous/candidate-authority.js");
    return decideTakeoverAuthority({
      state: s,
      ticket: { kind: "absent" },
      issue: { kind: "found", value: view as never },
      reconciliation: "not-checked",
    });
  }

  const fin = (over: Partial<FullSessionState>) => makeState({
    state: "FINALIZE", finalizeCheckpoint: "staged", claimEpoch: undefined,
    git: { branch: "main", mergeBase: "abc123", itemBaseHead: "abc123" },
    ...over,
  } as unknown as Partial<FullSessionState>);

  it("E12: before committed, a recorded deferral on an open issue with its disposition is permitted", async () => {
    const d = await decide(fin({ currentIssueExit: DEFERRED }), { id: "ISS-001", status: "open", disposition: "owner_gated" });
    expect(d.kind).toBe("permitted");
  });

  it("E12: with no recorded exit the same issue is refused", async () => {
    const d = await decide(fin({ currentIssueExit: null }), { id: "ISS-001", status: "open", disposition: "owner_gated" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-shape-inconsistent");
  });

  it("E12: a recorded deferral on an issue with no non-actionable disposition is refused", async () => {
    const d = await decide(fin({ currentIssueExit: DEFERRED }), { id: "ISS-001", status: "open" });
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") expect(d.reason).toBe("finalize-shape-inconsistent");
  });

  it("E17: the crash window after the commit reads the exit from finalizedItem", async () => {
    const committed = (exit?: IssueExit) => fin({
      finalizeCheckpoint: "committed", currentIssue: null, currentIssueExit: null,
      finalizedItem: { kind: "issue", id: "ISS-001", commitHash: "beef", ...(exit ? { exit } : {}) },
      deferredIssues: ["ISS-001"],
    } as unknown as Partial<FullSessionState>);
    const view = { id: "ISS-001", status: "open", disposition: "owner_gated" };
    expect((await decide(committed(DEFERRED), view)).kind).toBe("permitted");
    const legacy = await decide(committed(), view);
    expect(legacy.kind).toBe("refused");
    if (legacy.kind === "refused") expect(legacy.reason).toBe("finalize-shape-inconsistent");
  });

  it("E23: a malformed recorded exit is refused even on a resolved issue, before and after the commit", async () => {
    const malformed = { exit: "malformed" } as unknown as IssueExit;
    const resolved = { id: "ISS-001", status: "resolved" };
    const before = await decide(fin({ currentIssueExit: malformed }), resolved);
    expect(before.kind).toBe("refused");
    if (before.kind === "refused") expect(before.reason).toBe("finalize-shape-inconsistent");
    const after = await decide(fin({
      finalizeCheckpoint: "committed", currentIssue: null, currentIssueExit: null,
      finalizedItem: { kind: "issue", id: "ISS-001", commitHash: "beef", exit: malformed },
    } as unknown as Partial<FullSessionState>), resolved);
    expect(after.kind).toBe("refused");
  });
});

describe("ISS-1380: a malformed exit at COMPLETE", () => {
  it("E23: COMPLETE refuses a malformed finalizedItem.exit by name and completes nothing", async () => {
    writeIssue({ status: "open" });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const s = makeState({
      state: "COMPLETE", currentIssue: null, finalizeCheckpoint: "committed",
      finalizedItem: { kind: "issue", id: "ISS-001", commitHash: "abc123", exit: { exit: "malformed" } },
      resolvedIssues: ["ISS-001"],
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, s, makeRecipe());
    const advance = await new CompleteStage().enter(ctx);
    expect(advance.action).toBe("retry");
    expect((advance as { instruction?: string }).instruction).toContain("`finalizedItem.exit`");
    expect((advance as { instruction?: string }).instruction).toContain("is malformed");
    expect(ctx.state.finalizedItem).not.toBeNull();
  });
});

describe("ISS-1380: park after an exit", () => {
  async function park(exit: IssueExit, over: Partial<FullSessionState> = {}) {
    const { parkCurrentIssue } = await import("../../../src/autonomous/stages/park.js");
    const ctx = new StageContext(testRoot, sessionDir, makeState({ state: "CODE_REVIEW", currentIssueExit: exit, ...over }), makeRecipe());
    const reason = "Review would not converge.";
    const advance = await parkCurrentIssue(ctx, { notes: reason } as GuideReportInput, "CODE_REVIEW", { reason, target: "HANDOVER" });
    return { ctx, advance: advance as { action: string; target: string; result: { instruction: string } } };
  }

  it("E13: after a deferral the issue is already released, so park writes nothing", async () => {
    writeIssue({ status: "open", ...OWNER_GATED, updatedDate: TODAY });
    const before = issueText();
    const spy = vi.spyOn(projectLoader, "writeIssueUnlocked");
    const { ctx, advance } = await park({ exit: "deferred", disposition: "owner_gated", reason: "Needs the owner's call on pricing.", ref: "T-001" });
    expect(advance.target).toBe("HANDOVER");
    expect(advance.result.instruction).toContain("# Parked: ISS-001");
    expect(spy).not.toHaveBeenCalled();
    expect(issueText()).toBe(before);
    expect(draft(ctx).currentIssueExit).toBeNull();
  });

  it("E13: after a disposed exit park still reopens the issue", async () => {
    const epoch = { issueId: "ISS-001", sessionId: SESSION, establishedAt: new Date().toISOString() };
    writeIssue({ ...resolvedAs("wontfix", "Not worth it."), resolutionEpoch: epoch });
    const { advance } = await park({ exit: "disposed", kind: "wontfix", reason: "Not worth it." }, { issueResolutionEpoch: epoch } as unknown as Partial<FullSessionState>);
    expect(advance.result.instruction).toContain("# Parked: ISS-001");
    expect(readIssue().status).toBe("open");
  });
});

describe("ISS-1380: reports name the exit", () => {
  it("E14: the handover lines name each exit from the captured record", async () => {
    const { finishedIssueLines } = await import("../../../src/autonomous/stages/issue-fix.js");
    const lines = finishedIssueLines({
      resolvedIssues: ["ISS-1", "ISS-2"], deferredIssues: ["ISS-3", "ISS-4"],
      resolvedIssueDisplayIds: { "ISS-1": "ISS-101" },
      issueExits: [
        { id: "ISS-1", exit: "fixed", commitHash: "a" },
        { id: "ISS-2", exit: "disposed", kind: "wontfix", reason: "Not worth [it].", commitHash: "b" },
        { id: "ISS-3", exit: "deferred", disposition: "owner_gated", reason: "Owner decides.", ref: "N-001", commitHash: "c" },
        { id: "ISS-4", exit: "deferred", disposition: "owner_gated", reason: "Owner decides.", ref: "N-001", commitHash: null },
      ],
    } as never);
    expect(lines).toEqual([
      "- ISS-101 (resolved)",
      "- ISS-2 (closed as wontfix: Not worth \\[it\\].)",
      "- ISS-3 (deferred: owner decision requested, Owner decides.; evidence N-001)",
      "- ISS-4 (deferred: owner decision requested, Owner decides.; evidence N-001, no commit)",
    ]);
  });

  it("E14: a session with no exit records keeps '(resolved)'", async () => {
    const { finishedIssueLines } = await import("../../../src/autonomous/stages/issue-fix.js");
    expect(finishedIssueLines({ resolvedIssues: ["ISS-9"] } as never)).toEqual(["- ISS-9 (resolved)"]);
  });

  it("E14: a deferral with no exit record says its details are unavailable, never resolved", async () => {
    const { finishedIssueLines } = await import("../../../src/autonomous/stages/issue-fix.js");
    expect(finishedIssueLines({ resolvedIssues: ["ISS-9"], deferredIssues: ["ISS-4"], issueExits: [] } as never))
      .toEqual(["- ISS-9 (resolved)", "- ISS-4 (deferred; details unavailable)"]);
  });

  it("E14: the checkpoint labels closures by kind and lists deferrals on their own line", async () => {
    writeIssue({ status: "open" });
    const created: string[] = [];
    const handover = await import("../../../src/cli/commands/handover.js");
    vi.spyOn(handover, "handleHandoverCreate").mockImplementation(async (content: string) => { created.push(content); return {} as never; });
    const { CompleteStage } = await import("../../../src/autonomous/stages/complete.js");
    const s = makeState({
      state: "COMPLETE", currentIssue: null,
      resolvedIssues: ["ISS-3", "ISS-5"], deferredIssues: ["ISS-4"],
      issueExits: [
        { id: "ISS-3", exit: "disposed", kind: "wontfix", reason: "r", commitHash: "a" },
        { id: "ISS-5", exit: "fixed", commitHash: "c" },
        { id: "ISS-4", exit: "deferred", disposition: "owner_gated", reason: "r", ref: "T-001", commitHash: "b" },
      ],
      config: { maxTicketsPerSession: 10, compactThreshold: "high", reviewBackends: [], handoverInterval: 3 },
    } as unknown as Partial<FullSessionState>);
    const ctx = new StageContext(testRoot, sessionDir, s, makeRecipe());
    await new CompleteStage().enter(ctx);
    expect(created.length).toBe(1);
    expect(created[0]).toContain("**Issues resolved:** ISS-3 (wontfix), ISS-5");
    expect(created[0]).toContain("**Issues deferred:** ISS-4 (owner decision requested)");
  });

  it("E16: the sweep and ISSUE_FIX share the exit lines, byte for byte", async () => {
    const { ISSUE_EXIT_LINES } = await import("../../../src/autonomous/stages/issue-sweep.js");
    expect([...ISSUE_EXIT_LINES]).toEqual(EXIT_LINES);
  });
});
