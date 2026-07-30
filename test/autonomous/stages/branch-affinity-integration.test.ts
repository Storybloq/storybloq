/**
 * T-328: Branch affinity integration tests.
 * Tests mismatch blocking in report(), targeted mode bypass,
 * annotation injection in enter(), and config propagation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import { resolveRecipe } from "../../../src/autonomous/recipes/loader.js";
import { gitCheckRefFormat } from "../../../src/autonomous/git-inspector.js";

/**
 * ISS-922: PICK_TICKET now establishes the item's finalization baseline from a
 * FRESH head and fails closed if it cannot, because a cached value is exactly
 * what cannot establish a baseline after unobserved drift. Session start
 * already refuses a project without git (guide.ts), so a real gitHead failure
 * is an anomaly, not a supported mode -- these fixtures previously relied on
 * it failing in a non-repository tmpdir. Partial mock: only gitHead is
 * replaced, everything else in the module stays real.
 */
vi.mock("../../../src/autonomous/git-inspector.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/autonomous/git-inspector.js")>()),
  gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } }),
  // "abc123" is this file's own baseline, so PICK gets a resolvable head
  // while FINALIZE still sees HEAD === baseline and behaves as before.
}));


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000001",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ...overrides,
  } as FullSessionState;
}

function makeRecipe(overrides?: Partial<ResolvedRecipe>): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    branchStrategy: "current",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"] },
    ...overrides,
  };
}

function setupProject(root: string, options?: {
  tickets?: Array<{ id: string; title: string; status: string; phase: string; blockedBy?: string[]; displayId?: string; previousDisplayIds?: string[]; lifecycle?: string }>;
  issues?: Array<{ id: string; title: string; status: string; severity: string; displayId?: string; previousDisplayIds?: string[]; lifecycle?: string }>;
}): void {
  const storyDir = join(root, ".story");
  mkdirSync(join(storyDir, "tickets"), { recursive: true });
  mkdirSync(join(storyDir, "issues"), { recursive: true });
  mkdirSync(join(storyDir, "notes"), { recursive: true });
  mkdirSync(join(storyDir, "lessons"), { recursive: true });
  mkdirSync(join(storyDir, "handovers"), { recursive: true });
  writeFileSync(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "test", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(storyDir, "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-04-03",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));

  for (const t of options?.tickets ?? []) {
    writeFileSync(join(storyDir, "tickets", `${t.id}.json`), JSON.stringify({
      id: t.id, title: t.title, type: "task", status: t.status, phase: t.phase,
      order: 10, description: "", createdDate: "2026-04-03", completedDate: null,
      blockedBy: t.blockedBy ?? [], parentTicket: null,
      ...(t.displayId ? { displayId: t.displayId } : {}),
      ...(t.previousDisplayIds ? { previousDisplayIds: t.previousDisplayIds } : {}),
      ...(t.lifecycle ? { lifecycle: t.lifecycle, deletedAt: "2026-06-01T00:00:00Z", deletedBy: "test" } : {}),
    }));
  }
  for (const i of options?.issues ?? []) {
    writeFileSync(join(storyDir, "issues", `${i.id}.json`), JSON.stringify({
      id: i.id, title: i.title, status: i.status, severity: i.severity,
      components: [], impact: "test", resolution: null, location: [],
      discoveredDate: "2026-04-03", resolvedDate: null, relatedTickets: [], order: 10,
      ...(i.displayId ? { displayId: i.displayId } : {}),
      ...(i.previousDisplayIds ? { previousDisplayIds: i.previousDisplayIds } : {}),
      ...(i.lifecycle ? { lifecycle: i.lifecycle, deletedAt: "2026-06-01T00:00:00Z", deletedBy: "test" } : {}),
    }));
  }
}

let testRoot: string;
let sessionDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "test-branch-affinity-"));
  sessionDir = join(testRoot, ".story", "sessions", "test-session");
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => { rmSync(testRoot, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Mismatch blocking in report()
// ---------------------------------------------------------------------------

describe("mismatch blocking in PickTicketStage.report()", () => {
  it("offers escapes on the first mismatch, then routes to HANDOVER on the second", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: "T-100", title: "Branch ticket", status: "open", phase: "p1" },
        { id: "T-200", title: "Other ticket", status: "open", phase: "p1" },
      ],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    // T-328: the first mismatch is an offer, not a dead end. The mismatch is
    // still surfaced with both ids; what changed is that the session survives it.
    const first = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    expect(first).toHaveProperty("action", "retry");
    expect((first as any).instruction).toContain("T-100");
    expect((first as any).instruction).toContain("T-200");

    // Ignoring the offer and re-reporting the same blocked pick lands on the
    // pre-T-328 behavior, so the terminal route stays covered.
    const second = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    expect(second).toHaveProperty("action", "goto");
    expect(second).toHaveProperty("target", "HANDOVER");
  });

  it("allows pick when it matches branch entity", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Branch ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" } as any);

    expect(result).toHaveProperty("action", "advance");
  });

  it("does not block when on main branch", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-200", title: "Any ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    expect(result).toHaveProperty("action", "advance");
  });

  it("does not block in targeted mode even with mismatched branch", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-200", title: "Target ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
      targetWork: ["T-200"],
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    expect(result).toHaveProperty("action", "advance");
  });

  it("does not block when branchStrategy is per-ticket", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-200", title: "Other ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
      resolvedBranchStrategy: "per-ticket",
    } as any);
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe({ branchStrategy: "per-ticket" }));
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-200" } as any);

    // Should NOT route to HANDOVER (per-ticket skips mismatch blocking)
    expect(result).not.toHaveProperty("target", "HANDOVER");
  });

  it("blocks issue pick that does not match branch entity", async () => {
    setupProject(testRoot, {
      issues: [{ id: "ISS-050", title: "Some issue", status: "open", severity: "high" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const first = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-050" } as any);
    expect(first).toHaveProperty("action", "retry");

    const second = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-050" } as any);
    expect(second).toHaveProperty("action", "goto");
    expect(second).toHaveProperty("target", "HANDOVER");
  });
});

// ---------------------------------------------------------------------------
// ISS-752 + ISS-759: team-shaped picks (canonical id + displayId) in report()
// ---------------------------------------------------------------------------

describe("team-shaped picks in PickTicketStage.report()", () => {
  const CANONICAL_A = "t-3fg59pn3sfeja1v1"; // displayId T-401
  const CANONICAL_B = "t-8kmn4qrs2tvw5xyz"; // displayId T-500

  function setupTeamTickets(): void {
    setupProject(testRoot, {
      tickets: [
        { id: CANONICAL_A, title: "Tidy slug", status: "open", phase: "p1", displayId: "T-401" },
        { id: CANONICAL_B, title: "Other work", status: "open", phase: "p1", displayId: "T-500" },
      ],
    });
  }

  function makeAffinityState(): FullSessionState {
    return makeSessionState({
      git: { branch: "story/T-401-tidy-slug", mergeBase: "abc123", expectedHead: "abc123" },
    });
  }

  it("(a) advances when the canonical id of the branch's ticket is reported", async () => {
    setupTeamTickets();
    const ctx = new StageContext(testRoot, sessionDir, makeAffinityState(), makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: CANONICAL_A } as any);

    expect(result).toHaveProperty("action", "advance");
    expect(ctx.state.ticket?.id).toBe(CANONICAL_A);
  });

  it("(b) resolves a displayId report to the canonical ticket and advances", async () => {
    setupTeamTickets();
    const ctx = new StageContext(testRoot, sessionDir, makeAffinityState(), makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-401" } as any);

    expect(result).toHaveProperty("action", "advance");
    expect(ctx.state.ticket?.id).toBe(CANONICAL_A);
    expect(ctx.state.ticket?.displayId).toBe("T-401");
  });

  it("(c) still blocks a DIFFERENT ticket's canonical id, reason uses its display label", async () => {
    setupTeamTickets();
    const ctx = new StageContext(testRoot, sessionDir, makeAffinityState(), makeRecipe());
    const stage = new PickTicketStage();

    const first = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: CANONICAL_B } as any);

    // ISS-752: the display labels must survive the move to an offer.
    expect(first).toHaveProperty("action", "retry");
    expect((first as any).instruction).toContain("T-500");
    expect((first as any).instruction).toContain("T-401");

    const second = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: CANONICAL_B } as any);
    expect(second).toHaveProperty("action", "goto");
    expect(second).toHaveProperty("target", "HANDOVER");
  });

  it("advances when a previousDisplayId matches the branch entity", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: CANONICAL_A, title: "Tidy slug", status: "open", phase: "p1", displayId: "T-402", previousDisplayIds: ["T-401"] },
      ],
    });
    const ctx = new StageContext(testRoot, sessionDir, makeAffinityState(), makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: CANONICAL_A } as any);

    expect(result).toHaveProperty("action", "advance");
  });

  it("(d) retries with canonical candidates when a displayId is ambiguous (reconcile-pending)", async () => {
    setupProject(testRoot, {
      tickets: [
        { id: CANONICAL_A, title: "Tidy slug", status: "open", phase: "p1", displayId: "T-401" },
        { id: CANONICAL_B, title: "Duplicate display", status: "open", phase: "p1", displayId: "T-401" },
      ],
    });
    const ctx = new StageContext(testRoot, sessionDir, makeAffinityState(), makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-401" } as any);

    expect(result).toHaveProperty("action", "retry");
    expect((result as any).instruction).toContain(CANONICAL_A);
    expect((result as any).instruction).toContain(CANONICAL_B);
  });

  const ISSUE_CANONICAL_A = "i-2abcdefg34hjkmnp"; // displayId ISS-050
  const ISSUE_CANONICAL_B = "i-9qrstvwx56yz7abc"; // displayId ISS-060

  function setupTeamIssues(): void {
    setupProject(testRoot, {
      issues: [
        { id: ISSUE_CANONICAL_A, title: "Crash on load", status: "open", severity: "high", displayId: "ISS-050" },
        { id: ISSUE_CANONICAL_B, title: "Other issue", status: "open", severity: "low", displayId: "ISS-060" },
      ],
    });
  }

  it("(e-a) routes to ISSUE_FIX when the canonical id of the branch's issue is reported", async () => {
    setupTeamIssues();
    const state = makeSessionState({
      git: { branch: "fix/ISS-050-crash", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: ISSUE_CANONICAL_A } as any);

    expect(result).toHaveProperty("action", "goto");
    expect(result).toHaveProperty("target", "ISSUE_FIX");
    expect(ctx.state.currentIssue?.id).toBe(ISSUE_CANONICAL_A);
    // ISS-759: the mutation must target the resolved canonical id
    const written = JSON.parse(readFileSync(join(testRoot, ".story", "issues", `${ISSUE_CANONICAL_A}.json`), "utf-8"));
    expect(written.status).toBe("inprogress");
  });

  it("(e-c) still blocks a DIFFERENT issue's canonical id, reason uses its display label", async () => {
    setupTeamIssues();
    const state = makeSessionState({
      git: { branch: "fix/ISS-050-crash", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const first = await stage.report(ctx, { completedAction: "issue_picked", issueId: ISSUE_CANONICAL_B } as any);

    expect(first).toHaveProperty("action", "retry");
    expect((first as any).instruction).toContain("ISS-060");
    expect((first as any).instruction).toContain("ISS-050");

    const second = await stage.report(ctx, { completedAction: "issue_picked", issueId: ISSUE_CANONICAL_B } as any);
    expect(second).toHaveProperty("action", "goto");
    expect(second).toHaveProperty("target", "HANDOVER");
  });
});

// ---------------------------------------------------------------------------
// Annotation in enter()
// ---------------------------------------------------------------------------

describe("annotation in PickTicketStage.enter()", () => {
  it("includes branch affinity annotation when on a feature branch", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Branch ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "story/T-100-branch-ticket", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.enter(ctx);
    const instruction = "instruction" in result ? (result as any).instruction : "";

    expect(instruction).toContain("[Branch affinity]");
    expect(instruction).toContain("T-100");
  });

  it("does not include annotation when on main", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Some ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.enter(ctx);
    const instruction = "instruction" in result ? (result as any).instruction : "";

    expect(instruction).not.toContain("[Branch affinity]");
  });

  it("includes ambiguous warning when branch has multiple IDs", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-100", title: "Ticket", status: "open", phase: "p1" }],
    });
    const state = makeSessionState({
      git: { branch: "feature/T-100-and-T-200", mergeBase: "abc123", expectedHead: "abc123" },
    });
    const ctx = new StageContext(testRoot, sessionDir, state, makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.enter(ctx);
    const instruction = "instruction" in result ? (result as any).instruction : "";

    expect(instruction).toContain("[Branch warning]");
  });
});

// ---------------------------------------------------------------------------
// Config propagation
// ---------------------------------------------------------------------------

describe("resolveRecipe branchStrategy propagation", () => {
  it("defaults to the canonical 'current' when not specified", () => {
    const recipe = resolveRecipe("coding");
    expect(recipe.branchStrategy).toBe("current");
  });

  it("project override wins over recipe default", () => {
    const recipe = resolveRecipe("coding", { branchStrategy: "per-ticket" });
    expect(recipe.branchStrategy).toBe("per-ticket");
  });

  it("resolves the recipe default to a canonical value, whatever coding.json spells it", () => {
    const recipe = resolveRecipe("coding", {});
    expect(recipe.branchStrategy).toBe("current");
  });
});

// ---------------------------------------------------------------------------
// gitCheckRefFormat
// ---------------------------------------------------------------------------

describe("gitCheckRefFormat", () => {
  it("returns true for valid branch names", async () => {
    const result = await gitCheckRefFormat("/tmp", "story/T-123-valid-name");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(true);
  });

  it("returns false for invalid branch names", async () => {
    const result = await gitCheckRefFormat("/tmp", "story/T-123..invalid");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(false);
  });

  it("returns false for branch names with spaces", async () => {
    const result = await gitCheckRefFormat("/tmp", "story/has space");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISS-756: tombstoned (soft-deleted) items must be unpickable
// ---------------------------------------------------------------------------

describe("ISS-756: PickTicketStage rejects tombstoned items", () => {
  it("rejects a tombstoned open ticket with a retry naming the state", async () => {
    setupProject(testRoot, {
      tickets: [{ id: "T-001", title: "Ghost", status: "open", phase: "p1", lifecycle: "deleted" }],
    });
    const ctx = new StageContext(testRoot, sessionDir, makeSessionState({}), makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" } as any);

    expect(result).toHaveProperty("action", "retry");
    expect((result as { instruction: string }).instruction).toMatch(/deleted \(tombstoned\)/);
  });

  it("rejects a tombstoned open issue with a retry naming the state", async () => {
    setupProject(testRoot, {
      issues: [{ id: "ISS-001", title: "Ghost issue", status: "open", severity: "high", lifecycle: "deleted" }],
    });
    const ctx = new StageContext(testRoot, sessionDir, makeSessionState({}), makeRecipe());
    const stage = new PickTicketStage();

    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" } as any);

    expect(result).toHaveProperty("action", "retry");
    expect((result as { instruction: string }).instruction).toMatch(/deleted \(tombstoned\)/);
  });
});
