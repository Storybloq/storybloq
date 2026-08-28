/**
 * T-475: PICK_TICKET's earmark choke point (Layer 1, binding). R5 (the
 * gate-1 acceptor's ruling): CAS-convert a matching reservation into an
 * assignment, never clear it -- so a rival pick sees the (still-present)
 * earmark and refuses.
 *
 * Real temporary git repositories throughout, matching this test suite's
 * existing pick-path convention (pick-baseline-iss922.test.ts) -- the ticket
 * path does real branch-strategy/HEAD work the choke point sits alongside.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import type { Earmark } from "../../../src/models/types.js";

const SESSION_ID = "00000000-0000-0000-0000-000000000475";
const OTHER_SESSION = "00000000-0000-0000-0000-000000009999";
const ARRANGEMENT_ID = "a-0123456789abcdef";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pick-ticket-earmark-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "pick-ticket-earmark", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "pick-ticket-earmark", date: "2026-08-30",
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

function reservedFor(role: "pen" | "worker"): Earmark {
  return {
    stage: "reserved",
    reservedBy: { client: "claude", id: "pen-task" },
    arrangementId: ARRANGEMENT_ID,
    since: new Date().toISOString(),
    holderRole: role,
    holderSession: null,
  } as Earmark;
}

function assignedTo(holderSession: string): Earmark {
  return {
    stage: "assigned",
    reservedBy: { client: "claude", id: "pen-task" },
    arrangementId: ARRANGEMENT_ID,
    since: new Date().toISOString(),
    holderRole: "worker",
    holderSession,
  } as Earmark;
}

function writeTicket(root: string, id: string, earmark: Earmark | null = null): void {
  writeFileSync(join(root, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: `Ticket ${id}`, type: "task", status: "open", phase: "p1",
    order: 10, description: "", createdDate: "2026-08-30", completedDate: null,
    blockedBy: [], parentTicket: null, earmark,
  }));
}

function writeIssue(root: string, id: string, earmark: Earmark | null = null): void {
  writeFileSync(join(root, ".story", "issues", `${id}.json`), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-08-30",
    resolvedDate: null, relatedTickets: [], order: 10, earmark,
  }));
}

function readTicket(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "tickets", `${id}.json`), "utf-8"));
}

function readIssue(root: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, ".story", "issues", `${id}.json`), "utf-8"));
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: SESSION_ID,
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

const stage = new PickTicketStage();

describe("PICK_TICKET earmark choke point -- ticket path (T-475)", () => {
  let root: string;
  beforeEach(() => { root = buildRepo(); mkdirSync(join(root, ".story", "sessions", "s"), { recursive: true }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a pick on a ticket assigned to another session, naming the holder", async () => {
    writeTicket(root, "T-001", assignedTo(OTHER_SESSION));
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.instruction).toContain(OTHER_SESSION);
    // Refused pick must never mutate the ticket.
    expect(readTicket(root, "T-001").status).toBe("open");
    expect((readTicket(root, "T-001").earmark as Record<string, unknown>).holderSession).toBe(OTHER_SESSION);
  });

  it("refuses a pick on a ticket reserved for a role this session does not hold", async () => {
    writeTicket(root, "T-001", reservedFor("pen"));
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action).toBe("retry");
    expect(readTicket(root, "T-001").status).toBe("open");
    expect((readTicket(root, "T-001").earmark as Record<string, unknown>).stage).toBe("reserved");
  });

  it("converts a worker-reserved ticket into an assignment to this session and advances (R5 convert, not clear)", async () => {
    writeTicket(root, "T-001", reservedFor("worker"));
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action).toBe("advance");
    const persisted = readTicket(root, "T-001");
    const earmark = persisted.earmark as Record<string, unknown>;
    expect(earmark).not.toBeNull();
    expect(earmark.stage).toBe("assigned");
    expect(earmark.holderSession).toBe(SESSION_ID);
  });

  it("passes with no earmark mutation when the ticket is already assigned to this session", async () => {
    writeTicket(root, "T-001", assignedTo(SESSION_ID));
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action).toBe("advance");
    const earmark = readTicket(root, "T-001").earmark as Record<string, unknown>;
    expect(earmark.stage).toBe("assigned");
    expect(earmark.holderSession).toBe(SESSION_ID);
  });

  it("picks an unearmarked ticket exactly as before -- the choke point does not act at all", async () => {
    writeTicket(root, "T-001", null);
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "ticket_picked", ticketId: "T-001" });

    expect(result.action).toBe("advance");
    expect(readTicket(root, "T-001").earmark ?? null).toBeNull();
  });
});

describe("PICK_TICKET earmark choke point -- issue path (T-475)", () => {
  let root: string;
  beforeEach(() => { root = buildRepo(); mkdirSync(join(root, ".story", "sessions", "s"), { recursive: true }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a pick on an issue assigned to another session", async () => {
    writeIssue(root, "ISS-001", assignedTo(OTHER_SESSION));
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.instruction).toContain(OTHER_SESSION);
    expect(readIssue(root, "ISS-001").status).toBe("open");
  });

  it("converts a worker-reserved issue into an assignment and sets it inprogress atomically", async () => {
    writeIssue(root, "ISS-001", reservedFor("worker"));
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(result.action).toBe("goto");
    const persisted = readIssue(root, "ISS-001");
    expect(persisted.status).toBe("inprogress");
    const earmark = persisted.earmark as Record<string, unknown>;
    expect(earmark.stage).toBe("assigned");
    expect(earmark.holderSession).toBe(SESSION_ID);
  });

  it("picks an unearmarked issue exactly as before", async () => {
    writeIssue(root, "ISS-001", null);
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(result.action).toBe("goto");
    expect(readIssue(root, "ISS-001").status).toBe("inprogress");
    expect(readIssue(root, "ISS-001").earmark ?? null).toBeNull();
  });
});

describe("PICK_TICKET Layer 2 (advisory) -- own open-issues listing (T-475 section 5)", () => {
  let root: string;
  beforeEach(() => { root = buildRepo(); mkdirSync(join(root, ".story", "sessions", "s"), { recursive: true }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("omits an OPEN issue earmarked to anyone from the candidates instruction", async () => {
    writeIssue(root, "ISS-001", assignedTo(OTHER_SESSION));
    writeIssue(root, "ISS-002", null);
    const ctx = new StageContext(root, join(root, ".story", "sessions", "s"), makeState(), makeRecipe());

    const result = await stage.enter(ctx);
    const instruction = "action" in result ? "" : result.instruction;
    expect(instruction).not.toContain("ISS-001");
    expect(instruction).toContain("ISS-002");
  });
});
