/**
 * T-494 scope 2 wiring: the rulings an item cites must reach a REVIEWER.
 *
 * The failure this file exists to prevent is the T-489 one: a delivery path
 * that is correct in isolation and wired nowhere, sitting behind a green suite.
 * `buildReviewContextPacket` accepting a `citedRulings` field proves nothing on
 * its own -- three call sites have to pass it. So the stage test below drives
 * the REAL `PlanReviewStage.enter()` and asserts on the instruction a reviewer
 * is actually handed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleRulingCreate } from "../../src/cli/commands/ruling.js";
import { citationsForReviewTarget } from "../../src/autonomous/cited-rulings.js";
import { PlanReviewStage } from "../../src/autonomous/stages/plan-review.js";
import { CodeReviewStage } from "../../src/autonomous/stages/code-review.js";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RULING_TEXT = "The pen rules: rulings reach agents by citation, not by paste.";

async function projectWithCitedRuling(): Promise<{ root: string; rulingId: string }> {
  const root = mkdtempSync(join(tmpdir(), "t494-wiring-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  await handleTicketCreate(
    { title: "Cited ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    root,
  );
  const created = await handleRulingCreate(
    {
      text: RULING_TEXT,
      attribution: "owner-direct",
      date: "2026-09-06",
      scopeTags: [],
      cites: ["T-001"],
      clientTaskId: "test-session-wiring",
    },
    "json",
    root,
  );
  return { root, rulingId: JSON.parse(created.output).data.id as string };
}

describe("citationsForReviewTarget", () => {
  it("resolves the citations of a ticket fresh from disk", async () => {
    const { root, rulingId } = await projectWithCitedRuling();
    const result = await citationsForReviewTarget(root, "T-001");
    expect(result.kind).toBe("resolved");
    if (result.kind !== "resolved") return;
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.status).toBe("resolved");
    if (result.citations[0]?.status === "resolved") {
      expect(result.citations[0].current.id).toBe(rulingId);
    }
  });

  it("reports UNAVAILABLE rather than an empty list when the target cannot be resolved", async () => {
    // "This item cites nothing" and "I could not find out what it cites" are
    // different claims. Collapsing the second into the first would show a
    // reviewer a packet with no rulings and no reason to doubt it.
    const { root } = await projectWithCitedRuling();
    const result = await citationsForReviewTarget(root, "T-404");
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.reason).toContain("T-404");
  });

  it("reports UNAVAILABLE for an unidentified target rather than claiming no citations", async () => {
    const { root } = await projectWithCitedRuling();
    const result = await citationsForReviewTarget(root, "unknown");
    expect(result.kind).toBe("unavailable");
  });

  it("resolves to an empty list for an item that genuinely cites nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "t494-nocite-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Uncited", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const result = await citationsForReviewTarget(root, "T-001");
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") expect(result.citations).toEqual([]);
  });
});

function makeState(ticketId: string): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000494",
    recipe: "coding", state: "PLAN_REVIEW", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: ticketId, title: "Cited ticket", claimed: true, risk: "low" },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
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

describe("the PLAN_REVIEW call site actually delivers the rulings", () => {
  it("puts the cited ruling's text in the instruction the reviewer is handed", async () => {
    const { root, rulingId } = await projectWithCitedRuling();
    const sessionDir = join(root, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "plan.md"), "# The plan\n\nDo the thing.\n");

    const ctx = new StageContext(root, sessionDir, makeState("T-001"), makeRecipe());
    const entered = await new PlanReviewStage().enter(ctx);
    const instruction = typeof entered === "string" ? entered : entered.instruction;

    expect(instruction).toContain("## Cited Rulings");
    expect(instruction).toContain(rulingId);
    expect(instruction).toContain(RULING_TEXT);
  });
});

describe("the CODE_REVIEW call site actually delivers the rulings", () => {
  it("puts the cited ruling's text in the instruction the reviewer is handed", async () => {
    // Wired identically to PLAN_REVIEW through the same helper, which is
    // exactly what T-489's dead tier looked like from the inside. Identical
    // wiring is not evidence; driving the real surface is.
    const { root, rulingId } = await projectWithCitedRuling();
    const sessionDir = join(root, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });

    const state = makeState("T-001");
    const ctx = new StageContext(
      root,
      sessionDir,
      { ...state, state: "CODE_REVIEW" } as FullSessionState,
      makeRecipe(),
    );
    const entered = await new CodeReviewStage().enter(ctx);
    const instruction = typeof entered === "string" ? entered : entered.instruction;

    expect(instruction).toContain("## Cited Rulings");
    expect(instruction).toContain(rulingId);
    expect(instruction).toContain(RULING_TEXT);
  });
});
