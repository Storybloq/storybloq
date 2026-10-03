/**
 * ISS-1112: COMPLETE once phases are exhausted. An open unphased leaf is work
 * (route to PICK_TICKET), a blocked-only one is not, and a skipped target is
 * excluded at both nextTickets call sites the way PICK_TICKET excludes it.
 * The verbatim instructions go to ISS1112_REC when set (receipt capture only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, isStageAdvance } from "../../../src/autonomous/stages/types.js";
import { CompleteStage } from "../../../src/autonomous/stages/complete.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import type { ResolvedRecipe } from "../../../src/autonomous/stages/types.js";

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "COMPLETE", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [{ id: "T-001" }],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 1, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 5,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"], handoverInterval: 5 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

const SKIPPED = { id: "t-aaaaaaaaaaaaaaaa", displayId: "T-501" };
const KEPT = { id: "t-bbbbbbbbbbbbbbbb", displayId: "T-502" };

describe("ISS-1112: COMPLETE with phases exhausted", () => {
  let testRoot: string;
  let sessionDir: string;
  const stage = new CompleteStage();

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "complete-unphased-"));
    sessionDir = join(testRoot, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    for (const sub of ["tickets", "issues", "notes", "handovers", "lessons"]) {
      mkdirSync(join(testRoot, ".story", sub), { recursive: true });
    }
    writeFileSync(join(testRoot, ".story", "config.json"), JSON.stringify({
      version: 1, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }));
    writeFileSync(join(testRoot, ".story", "roadmap.json"), JSON.stringify({
      title: "test", date: "2026-01-01",
      phases: [{ id: "p1", label: "P1", name: "P1", description: "p1" }], blockers: [],
    }));
    writeTicket({ id: "T-001", phase: "p1", status: "complete", completedDate: "2026-01-02" });
  });

  afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

  function writeTicket(t: { id: string; displayId?: string; phase: string | null; status?: string; order?: number; blockedBy?: string[]; completedDate?: string }): void {
    writeFileSync(join(testRoot, ".story", "tickets", `${t.id}.json`), JSON.stringify({
      id: t.id, ...(t.displayId ? { displayId: t.displayId } : {}), title: `Ticket ${t.displayId ?? t.id}`,
      description: "d", type: "task", status: t.status ?? "open", phase: t.phase, order: t.order ?? 10,
      createdDate: "2026-01-01", completedDate: t.completedDate ?? null, blockedBy: t.blockedBy ?? [],
    }));
  }

  async function enter(overrides: Partial<FullSessionState> = {}) {
    const ctx = new StageContext(testRoot, sessionDir, makeState(overrides), makeRecipe());
    const result = await stage.enter(ctx);
    expect(isStageAdvance(result)).toBe(true);
    const r = result as { target?: string; result?: { instruction?: string } };
    if (process.env.ISS1112_REC) {
      appendFileSync(process.env.ISS1112_REC, `== ${expect.getState().currentTestName}\n${JSON.stringify({ target: r.target, instruction: r.result?.instruction ?? null })}\n`);
    }
    return { target: r.target, instruction: r.result?.instruction ?? "" };
  }

  it("K1: an open unphased leaf routes COMPLETE to PICK_TICKET and is offered", async () => {
    writeTicket({ id: "T-002", phase: null });
    const { target, instruction } = await enter();
    expect(target).toBe("PICK_TICKET");
    expect(instruction).toContain("**T-002: Ticket T-002**");
  });

  it("K1: a blocked-only unphased leaf still routes COMPLETE to HANDOVER", async () => {
    writeTicket({ id: "T-002", phase: null, blockedBy: ["T-003"] });
    writeTicket({ id: "T-003", phase: null, blockedBy: ["T-002"] });
    const { target } = await enter();
    expect(target).toBe("HANDOVER");
  });

  it.each([["canonical id", SKIPPED.id], ["displayId", SKIPPED.displayId]])(
    "K2: the only open leaf, an unphased skipped target (by %s), routes to HANDOVER",
    async (_label, skippedRef) => {
      writeTicket({ ...SKIPPED, phase: null });
      const { target } = await enter({ skippedTargets: [skippedRef] } as Partial<FullSessionState>);
      expect(target).toBe("HANDOVER");
    },
  );

  it.each([["canonical id", SKIPPED.id], ["displayId", SKIPPED.displayId]])(
    "K3: the pick list omits a higher-ranked skipped unphased leaf (by %s) and offers the other",
    async (_label, skippedRef) => {
      writeTicket({ ...SKIPPED, phase: null, order: 10 });
      writeTicket({ ...KEPT, phase: null, order: 20 });
      const { target, instruction } = await enter({ skippedTargets: [skippedRef] } as Partial<FullSessionState>);
      expect(target).toBe("PICK_TICKET");
      expect(instruction).toContain(`**${KEPT.displayId}: Ticket ${KEPT.displayId}**`);
      expect(instruction).not.toContain(SKIPPED.displayId);
      expect(instruction).not.toContain(SKIPPED.id);
    },
  );
});
