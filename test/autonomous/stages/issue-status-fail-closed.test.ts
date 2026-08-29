/**
 * ISS-1052 (origin side): `PickTicketStage.handleIssuePick` writes a
 * `pendingProjectMutation` marker BEFORE attempting the issue status update,
 * then used to clear that marker unconditionally regardless of whether the
 * update actually succeeded. This suite proves the marker now stays SET when
 * `handleIssueUpdate` throws -- the marker is what lets
 * `recoverPendingMutation` (guide.ts) recognize and recover the write on the
 * next entry point; clearing it under an error would silently drop that
 * recovery path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({ failUpdate: false }));
vi.mock("../../../src/cli/commands/issue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/cli/commands/issue.js")>();
  return {
    ...actual,
    handleIssueUpdate: async (...args: Parameters<typeof actual.handleIssueUpdate>) => {
      if (hoisted.failUpdate) throw new Error("simulated issue-update failure");
      return actual.handleIssueUpdate(...args);
    },
  };
});

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "issue-status-fail-closed-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "issue-status-fail-closed", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "issue-status-fail-closed", date: "2026-08-30",
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

function writeIssue(root: string, id: string): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-08-30",
    resolvedDate: null, relatedTickets: [], order: 10, earmark: null,
  }));
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000001052",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main" },
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

describe("PickTicketStage.handleIssuePick leaves pendingProjectMutation set on a status-write error (ISS-1052)", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    root = buildRepo();
    sessionDir = join(root, ".story", "sessions", "s");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    hoisted.failUpdate = false;
    rmSync(root, { recursive: true, force: true });
  });

  it("marker stays SET in the written session state when handleIssueUpdate throws", async () => {
    writeIssue(root, "ISS-001");
    hoisted.failUpdate = true;
    const stage = new PickTicketStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());

    await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(ctx.state.pendingProjectMutation).not.toBeNull();
    expect((ctx.state.pendingProjectMutation as Record<string, unknown> | null)?.type).toBe("issue_update");
  });

  it("control: with the update succeeding normally, the marker IS cleared", async () => {
    writeIssue(root, "ISS-002");
    hoisted.failUpdate = false;
    const stage = new PickTicketStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());

    await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-002" });

    expect(ctx.state.pendingProjectMutation).toBeNull();
    const raw = JSON.parse(readFileSync(join(root, ".story", "issues", "ISS-002.json"), "utf-8"));
    expect(raw.status).toBe("inprogress");
  });
});
