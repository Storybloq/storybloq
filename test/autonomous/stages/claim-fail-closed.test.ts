/**
 * ISS-1051: `PlanStage.report`'s claim-acquisition block used to swallow a
 * thrown lock/IO error silently (an empty catch, "best-effort, don't block
 * plan review if ticket update fails"), continuing PAST the claim block as
 * if nothing happened -- a session could advance to PLAN_REVIEW believing it
 * held a ticket it never actually claimed. This suite proves a thrown error
 * now routes through the SAME `claimFailed`/"Claim Lost" redirect to
 * PICK_TICKET that a legitimate CAS refusal already used, per the ratified
 * T-478 plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { PlanStage } from "../../../src/autonomous/stages/plan.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000001051",
    recipe: "coding", state: "PLAN", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now,
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    ticket: { id: "T-001", title: "Test ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as unknown as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
  } as unknown as ResolvedRecipe;
}

describe("PlanStage claim acquisition fails closed on a lock/IO error (ISS-1051)", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claim-fail-closed-"));
    for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
      mkdirSync(join(root, ".story", sub), { recursive: true });
    }
    writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
      version: 2, schemaVersion: 1, project: "claim-fail-closed", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
      title: "claim-fail-closed", date: "2026-08-30",
      phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
    }));
    sessionDir = join(root, ".story", "sessions", "s");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n\nSome content.\n");
    writeFileSync(
      join(root, ".story", "tickets", "T-001.json"),
      JSON.stringify({
        id: "T-001", title: "Test ticket", type: "task", status: "open", phase: "p1",
        order: 10, description: "", createdDate: "2026-08-30", completedDate: null,
        blockedBy: [], parentTicket: null,
      }),
    );
  });

  afterEach(() => {
    hoisted.failLock = false;
    rmSync(root, { recursive: true, force: true });
  });

  it("redirects to PICK_TICKET with a 'Claim Lost' instruction, not a silent advance to PLAN_REVIEW", async () => {
    hoisted.failLock = true;
    const stage = new PlanStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "plan_written" });

    expect(result.action).toBe("goto");
    if (result.action === "goto") {
      expect(result.target).toBe("PICK_TICKET");
      expect(result.result?.instruction).toContain("Claim Lost");
    }
  });

  it("does not advance the ticket to inprogress on disk when the claim lock throws", async () => {
    hoisted.failLock = true;
    const stage = new PlanStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());

    await stage.report(ctx, { completedAction: "plan_written" });

    const raw = JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8"));
    expect(raw.status).toBe("open");
  });

  it("RED-proof control: with the lock working normally, the same report() call advances past the claim block (goto PLAN_REVIEW)", async () => {
    hoisted.failLock = false;
    const stage = new PlanStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "plan_written" });

    expect(result.action).not.toBe("goto");
  });
});
