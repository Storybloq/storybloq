/**
 * T-475: ISSUE_SWEEP's choke-point wiring (confirmed at round 2 to bypass
 * acquisition entirely) and the round-3 report() status-check regression fix.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { IssueSweepStage } from "../../src/autonomous/stages/issue-sweep.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { initProject } from "../../src/core/init.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { writeIssueUnlocked } from "../../src/core/project-loader.js";
import type { Earmark } from "../../src/models/types.js";

const SESSION_ID = "00000000-0000-0000-0000-000000000475";
const OTHER_SESSION = "00000000-0000-0000-0000-000000009999";
const ARRANGEMENT_ID = "a-0123456789abcdef";

async function newProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-earmark-"));
  await initProject(root, { name: "test" });
  return root;
}

async function createIssue(root: string, title: string, severity = "medium"): Promise<string> {
  const result = await handleIssueCreate(
    { title, severity, impact: "", components: [], relatedTickets: [], location: [] },
    "json",
    root,
  );
  return JSON.parse(result.output).data.id as string;
}

function assignedEarmark(holderSession: string): Earmark {
  return {
    stage: "assigned",
    reservedBy: { client: "claude", id: "some-task" },
    arrangementId: ARRANGEMENT_ID,
    since: new Date().toISOString(),
    holderRole: "worker",
    holderSession,
  } as Earmark;
}

async function setIssueEarmark(root: string, issueId: string, earmark: Earmark | null): Promise<void> {
  const path = join(root, ".story", "issues", `${issueId}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8"));
  await writeIssueUnlocked({ ...raw, earmark }, root);
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: SESSION_ID,
    recipe: "coding", state: "ISSUE_SWEEP", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: [],
    postComplete: ["ISSUE_SWEEP"],
    stages: { ISSUE_SWEEP: { enabled: true } },
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  } as unknown as ResolvedRecipe;
}

const stage = new IssueSweepStage();
const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newSessionDirIn(root: string): string {
  const dir = join(root, ".story", "sessions", "test-session");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("ISSUE_SWEEP earmark choke point (T-475)", () => {
  it("enter() skips an issue earmarked to another session and acquires the next eligible one", async () => {
    const root = await newProject();
    tempDirs.push(root);
    const earmarked = await createIssue(root, "earmarked to someone else", "critical");
    const eligible = await createIssue(root, "eligible", "high");
    await setIssueEarmark(root, earmarked, assignedEarmark(OTHER_SESSION));

    const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
    const result = await stage.enter(ctx);

    expect("action" in result).toBe(false);
    if (!("action" in result)) {
      expect(result.instruction).toContain(eligible);
    }
    expect(ctx.state.issueSweepState?.current).toBe(eligible);

    // The skipped, earmarked-to-someone-else issue must still be earmarked
    // to the OTHER session, never touched by this session's acquisition.
    const earmarkedRaw = JSON.parse(await readFile(join(root, ".story", "issues", `${earmarked}.json`), "utf-8"));
    expect(earmarkedRaw.status).toBe("open");
    expect(earmarkedRaw.earmark.holderSession).toBe(OTHER_SESSION);

    // The acquired issue is now genuinely locked-in: inprogress.
    const eligibleRaw = JSON.parse(await readFile(join(root, ".story", "issues", `${eligible}.json`), "utf-8"));
    expect(eligibleRaw.status).toBe("inprogress");
  });

  it("enter() goes to HANDOVER when every open issue is earmarked to another session", async () => {
    const root = await newProject();
    tempDirs.push(root);
    const onlyIssue = await createIssue(root, "earmarked", "high");
    await setIssueEarmark(root, onlyIssue, assignedEarmark(OTHER_SESSION));

    const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result).toEqual({ action: "goto", target: "HANDOVER" });
    // Refused entirely -- the earmarked issue must be untouched.
    const raw = JSON.parse(await readFile(join(root, ".story", "issues", `${onlyIssue}.json`), "utf-8"));
    expect(raw.status).toBe("open");
  });

  it("acquires a reserved-for-worker issue by converting it to assigned(this session), never clearing it", async () => {
    const root = await newProject();
    tempDirs.push(root);
    const issueId = await createIssue(root, "reserved for worker");
    await setIssueEarmark(root, issueId, {
      stage: "reserved",
      reservedBy: { client: "claude", id: "pen-task" },
      arrangementId: ARRANGEMENT_ID,
      since: new Date().toISOString(),
      holderRole: "worker",
      holderSession: null,
    } as Earmark);

    const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
    await stage.enter(ctx);

    const raw = JSON.parse(await readFile(join(root, ".story", "issues", `${issueId}.json`), "utf-8"));
    expect(raw.status).toBe("inprogress");
    expect(raw.earmark).not.toBeNull();
    expect(raw.earmark.stage).toBe("assigned");
    expect(raw.earmark.holderSession).toBe(SESSION_ID);
  });

  describe("report() status-check fix (round-3 regression)", () => {
    it("retries on the same issue when it is inprogress but not yet resolved, instead of advancing", async () => {
      const root = await newProject();
      tempDirs.push(root);
      const issueId = await createIssue(root, "needs a real fix");

      const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
      await stage.enter(ctx); // acquires issueId, sets it inprogress

      // Simulate the worker calling report() without actually resolving --
      // the issue is still "inprogress" (acquisition set it, never "open").
      // The pre-fix bug treated "not open" as "resolved" and advanced anyway.
      const result = await stage.report(ctx, { completedAction: "issue_fixed" });

      expect(result.action).toBe("retry");
      if (result.action === "retry") {
        expect(result.instruction).toContain("inprogress");
      }
      expect(ctx.state.issueSweepState?.current).toBe(issueId);
      expect(ctx.state.issueSweepState?.resolved).toEqual([]);
    });

    it("advances to HANDOVER once the current issue is genuinely resolved", async () => {
      const root = await newProject();
      tempDirs.push(root);
      const issueId = await createIssue(root, "will be fixed");

      const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
      await stage.enter(ctx);

      const raw = JSON.parse(await readFile(join(root, ".story", "issues", `${issueId}.json`), "utf-8"));
      await writeIssueUnlocked({ ...raw, status: "resolved", resolvedDate: "2026-08-30", resolution: "fixed" }, root);

      const result = await stage.report(ctx, { completedAction: "issue_fixed" });
      expect(result).toEqual({ action: "goto", target: "HANDOVER" });
      expect(ctx.state.issueSweepState?.resolved).toEqual([issueId]);
    });

    it("acquires the next eligible issue after the current one resolves, skipping an earmarked one", async () => {
      const root = await newProject();
      tempDirs.push(root);
      const first = await createIssue(root, "first", "critical");
      const earmarkedSecond = await createIssue(root, "earmarked", "high");
      const thirdEligible = await createIssue(root, "third", "medium");
      await setIssueEarmark(root, earmarkedSecond, assignedEarmark(OTHER_SESSION));

      const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
      await stage.enter(ctx);
      expect(ctx.state.issueSweepState?.current).toBe(first);

      const firstRaw = JSON.parse(await readFile(join(root, ".story", "issues", `${first}.json`), "utf-8"));
      await writeIssueUnlocked({ ...firstRaw, status: "resolved", resolvedDate: "2026-08-30", resolution: "fixed" }, root);

      const result = await stage.report(ctx, { completedAction: "issue_fixed" });
      expect(result.action).toBe("retry");
      expect(ctx.state.issueSweepState?.current).toBe(thirdEligible);

      const thirdRaw = JSON.parse(await readFile(join(root, ".story", "issues", `${thirdEligible}.json`), "utf-8"));
      expect(thirdRaw.status).toBe("inprogress");
    });
  });

  describe("completion clears the same-session earmark (T-475 section 5, new seam)", () => {
    it("clears this session's assigned earmark once report() confirms the issue resolved", async () => {
      const root = await newProject();
      tempDirs.push(root);
      const issueId = await createIssue(root, "reserved for worker");
      await setIssueEarmark(root, issueId, {
        stage: "reserved",
        reservedBy: { client: "claude", id: "pen-task" },
        arrangementId: ARRANGEMENT_ID,
        since: new Date().toISOString(),
        holderRole: "worker",
        holderSession: null,
      } as Earmark);

      const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
      await stage.enter(ctx); // converts reserved -> assigned(SESSION_ID)

      const acquired = JSON.parse(await readFile(join(root, ".story", "issues", `${issueId}.json`), "utf-8"));
      expect(acquired.earmark.holderSession).toBe(SESSION_ID);

      await writeIssueUnlocked({ ...acquired, status: "resolved", resolvedDate: "2026-08-30", resolution: "fixed" }, root);

      const result = await stage.report(ctx, { completedAction: "issue_fixed" });
      expect(result).toEqual({ action: "goto", target: "HANDOVER" });

      const after = JSON.parse(await readFile(join(root, ".story", "issues", `${issueId}.json`), "utf-8"));
      expect(after.earmark).toBeNull();
      expect(after.status).toBe("resolved");
    });

    it("does not clear a DIFFERENT session's earmark left behind by a corrupted acquisition record", async () => {
      const root = await newProject();
      tempDirs.push(root);
      const issueId = await createIssue(root, "will be fixed");

      const ctx = new StageContext(root, newSessionDirIn(root), makeState(), makeRecipe());
      await stage.enter(ctx);

      const raw = JSON.parse(await readFile(join(root, ".story", "issues", `${issueId}.json`), "utf-8"));
      const foreignEarmark = assignedEarmark(OTHER_SESSION);
      await writeIssueUnlocked(
        { ...raw, status: "resolved", resolvedDate: "2026-08-30", resolution: "fixed", earmark: foreignEarmark },
        root,
      );

      await stage.report(ctx, { completedAction: "issue_fixed" });

      const after = JSON.parse(await readFile(join(root, ".story", "issues", `${issueId}.json`), "utf-8"));
      expect(after.earmark).toEqual(foreignEarmark);
    });
  });
});
