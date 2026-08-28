/**
 * T-475 round-3 binding requirement: every NEW Layer-1 (earmark) lock
 * transaction fails closed on a thrown error -- never a silent
 * pass-through. Distinct from ISS-1051 (the PRE-EXISTING plan.ts
 * claim-acquisition fail-open, deliberately out of this ticket's scope):
 * this suite proves the earmark choke point does NOT repeat that failure
 * shape at its own three call sites (ticket pick, issue pick, sweep
 * selection).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({ failLock: false }));
vi.mock("../../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/project-loader.js")>();
  return {
    ...actual,
    withProjectLock: async (...args: Parameters<typeof actual.withProjectLock>) => {
      if (hoisted.failLock) throw new Error("simulated lock/read/write failure");
      return actual.withProjectLock(...args);
    },
  };
});

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import { IssueSweepStage } from "../../../src/autonomous/stages/issue-sweep.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "earmark-fail-closed-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "earmark-fail-closed", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "earmark-fail-closed", date: "2026-08-30",
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
    order: 10, description: "", createdDate: "2026-08-30", completedDate: null,
    blockedBy: [], parentTicket: null, earmark: null,
  }));
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
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000475",
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
    postComplete: ["ISSUE_SWEEP"], stages: { ISSUE_SWEEP: { enabled: true } },
    dirtyFileHandling: "block", branchStrategy: "current",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  } as unknown as ResolvedRecipe;
}

describe("earmark choke point fails closed on a lock/read/write error (T-475, round-3 binding)", () => {
  let root: string;
  beforeEach(() => { root = buildRepo(); mkdirSync(join(root, ".story", "sessions", "s"), { recursive: true }); });
  afterEach(() => { hoisted.failLock = false; rmSync(root, { recursive: true, force: true }); });

  it("PICK_TICKET ticket path: refuses the pick and leaves the ticket untouched", async () => {
    writeTicket(root, "T-001");
    hoisted.failLock = true;
    const stage = new PickTicketStage();
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.instruction).toContain("lock or read error");
    const raw = JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(raw.status).toBe("open");
    expect(raw.earmark ?? null).toBeNull();
    // No advance to PLAN happened.
    expect(ctx.state.ticket ?? undefined).toBeUndefined();
  });

  it("PICK_TICKET issue path: refuses the pick and leaves the issue untouched", async () => {
    writeIssue(root, "ISS-001");
    hoisted.failLock = true;
    const stage = new PickTicketStage();
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.instruction).toContain("lock or read error");
    const raw = JSON.parse(readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf-8"));
    expect(raw.status).toBe("open");
    expect(raw.earmark ?? null).toBeNull();
  });

  it("ISSUE_SWEEP enter(): a lock failure ends the sweep (goto HANDOVER) rather than handing out an instruction under uncertainty", async () => {
    writeIssue(root, "ISS-001");
    hoisted.failLock = true;
    const stage = new IssueSweepStage();
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState({ state: "ISSUE_SWEEP" }), makeRecipe());

    const result = await stage.enter(ctx);

    expect(result).toEqual({ action: "goto", target: "HANDOVER" });
    const raw = JSON.parse(readFileSync(join(root, ".story", "issues", "ISS-001.json"), "utf-8"));
    expect(raw.status).toBe("open");
  });

  it("ISSUE_SWEEP report()'s advance-to-next: a lock failure on the next acquisition ends the sweep rather than handing out a bad instruction", async () => {
    writeIssue(root, "ISS-001");
    writeIssue(root, "ISS-002");
    const stage = new IssueSweepStage();
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState({ state: "ISSUE_SWEEP" }), makeRecipe());

    // Acquire the first issue normally (lock working).
    await stage.enter(ctx);
    const currentId = ctx.state.issueSweepState?.current;
    expect(currentId).toBeTruthy();

    // Resolve it, then force the lock to fail for the NEXT acquisition.
    const raw = JSON.parse(readFileSync(join(root, ".story", "issues", `${currentId}.json`), "utf-8"));
    writeFileSync(join(root, ".story", "issues", `${currentId}.json`), JSON.stringify({ ...raw, status: "resolved", resolvedDate: "2026-08-30", resolution: "fixed" }));

    hoisted.failLock = true;
    const result = await stage.report(ctx, { completedAction: "issue_fixed" });

    expect(result).toEqual({ action: "goto", target: "HANDOVER" });
    // The second issue must never have been silently acquired under the error.
    const otherId = currentId === "ISS-001" ? "ISS-002" : "ISS-001";
    const other = JSON.parse(readFileSync(join(root, ".story", "issues", `${otherId}.json`), "utf-8"));
    expect(other.status).toBe("open");
  });
});
