/**
 * ISS-1405: skip_ticket at each stage gives back this session's claim and
 * earmark past a record that does not parse, and its reply names that record
 * or says the release failed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { PlanStage } from "../../src/autonomous/stages/plan.js";
import { PlanReviewStage } from "../../src/autonomous/stages/plan-review.js";
import { CodeReviewStage } from "../../src/autonomous/stages/code-review.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";

const SID = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-0000-0000-000000000002";
const own = { claimedBySession: SID };
const EARMARK_OWNER = { client: "claude", id: "task-1" };
const earmarkOf = (holderSession: string) => ({ stage: "assigned", holderRole: "worker", holderSession, reservedBy: EARMARK_OWNER, arrangementId: "a-0000000000000000", since: "2026-07-02T00:00:00.000Z" });

let root: string;
const ticketPath = (name = "T-001") => join(root, ".story", "tickets", `${name}.json`);
const readTicket = () => JSON.parse(readFileSync(ticketPath(), "utf-8")) as Record<string, unknown>;
const ticketJson = (extra: Record<string, unknown>) => JSON.stringify({
  id: "T-001", title: "Test ticket", description: "A test.", type: "task", status: "inprogress",
  phase: "p1", order: 10, createdDate: "2026-07-02", completedDate: null, blockedBy: [], ...extra,
});
const breakSibling = () => writeFileSync(ticketPath("T-009"), "{not json");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "own-claim-release-"));
  mkdirSync(join(root, ".story", "tickets"), { recursive: true });
  mkdirSync(join(root, ".story", "issues"), { recursive: true });
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "t", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "t", date: "2026-07-02", phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }], blockers: [],
  }));
});
afterEach(() => {
  try { chmodSync(ticketPath("T-009"), 0o644); } catch { /* not every case made it */ }
  rmSync(root, { recursive: true, force: true });
});

function sessionState(state: string): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: SID, recipe: "coding", state, revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null, compactPending: false,
    compactPreparedAt: null, resumeBlocked: false, terminationReason: null, waitingForRetry: false,
    lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false, resolvedIssues: [], currentIssue: null, targetWork: [],
    ticket: { id: "T-001", title: "Test ticket", claimed: true },
  } as unknown as FullSessionState;
}
const recipe: ResolvedRecipe = {
  id: "coding", pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
  postComplete: [], stages: {}, dirtyFileHandling: "block", branchStrategy: "none",
  defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
} as unknown as ResolvedRecipe;

describe.each([
  ["PLAN", () => new PlanStage()],
  ["PLAN_REVIEW", () => new PlanReviewStage()],
  ["CODE_REVIEW", () => new CodeReviewStage()],
])("skip_ticket at %s", (state, make) => {
  async function skip(): Promise<string> {
    const sessionDir = join(root, ".story", "sessions", SID);
    mkdirSync(join(sessionDir, "telemetry", "reviews"), { recursive: true });
    const ctx = new StageContext(root, sessionDir, sessionState(state), recipe);
    const result = await make().report(ctx, { completedAction: "skip_ticket", notes: "no" } as never);
    return (result as unknown as { result: { instruction: string } }).result.instruction;
  }

  it("releases the claim and this session's earmark past a broken record, and the reply names it", async () => {
    writeFileSync(ticketPath(), ticketJson({ ...own, earmark: earmarkOf(SID) }));
    breakSibling();
    const instruction = await skip();
    expect(readTicket().claimedBySession).toBeUndefined();
    expect(readTicket().earmark).toBeNull();
    expect(instruction).toContain(".story/tickets/T-009.json");
    expect(instruction).toContain("repair");
  });

  it("leaves another session's earmark alone", async () => {
    writeFileSync(ticketPath(), ticketJson({ ...own, earmark: earmarkOf(OTHER) }));
    breakSibling();
    await skip();
    expect(readTicket().claimedBySession).toBeUndefined();
    expect(readTicket().earmark).toEqual(earmarkOf(OTHER));
  });

  it("says so when the release fails", async () => {
    writeFileSync(ticketPath(), ticketJson(own));
    writeFileSync(ticketPath("T-050"), ticketJson(own));
    breakSibling();
    const instruction = await skip();
    expect(readTicket().claimedBySession).toBe(SID);
    expect(instruction).toContain("NOT released");
    expect(instruction).toContain("T-050.json");
  });
});
