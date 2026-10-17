/**
 * T-486 U4 A3 and A4: PICK_TICKET's issue path refuses an issue whose
 * disposition says nobody will act on it, on every read the pick acts on,
 * unless the run named it.
 *
 * The disposition is injected at `applyStrategy`, which runs after the first
 * check and before the locked earmark transaction, so the locked read is the
 * only one that can see it. The mismatch revalidation (A2) is pinned beside
 * the other escapes in branch-mismatch-escapes.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import { todayISO } from "../../../src/cli/helpers.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "t486-u4-pick-"));
  roots.push(root);
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "t486-u4", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "t486", date: "2026-10-16",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@test.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

function issuePath(root: string, id: string): string {
  return join(root, ".story", "issues", `${id}.json`);
}

function writeIssue(root: string, id: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(issuePath(root, id), JSON.stringify({
    id, title: `Issue ${id}`, status: "open", severity: "medium", components: [],
    impact: "test", resolution: null, location: [], discoveredDate: "2026-10-16",
    resolvedDate: null, relatedTickets: [], order: 10, ...overrides,
  }));
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [], stages: {}, dirtyFileHandling: "block",
    branchStrategy: "current" as ResolvedRecipe["branchStrategy"],
    reviewEffort: {
      level: "standard",
      source: "default",
      explicitKnobs: { codeReviewMaxRounds: false, planReviewBackends: false, codeReviewBackends: false },
    },
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
  };
}

function contextFor(root: string, overrides: Partial<FullSessionState> = {}): StageContext {
  const now = new Date().toISOString();
  const head = git(root, ["rev-parse", "HEAD"]);
  const state = {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-00000000a403",
    recipe: "coding", state: "PICK_TICKET", revision: 1, status: "active", mode: "auto",
    reviews: { plan: [], code: [] }, completedTickets: [], finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: null, expectedHead: head, initHead: head },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now,
    guideCallCount: 0, stuckRetryCount: 0,
    resolvedBranchStrategy: "current",
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
    filedDeferrals: [], pendingDeferrals: [], deferralsUnfiled: false,
    resolvedIssues: [], currentIssue: null, targetWork: [],
    ...overrides,
  } as unknown as FullSessionState;
  const dir = join(root, ".story", "sessions", state.sessionId);
  mkdirSync(dir, { recursive: true });
  return new StageContext(root, dir, state, makeRecipe());
}

type StrategySpy = { applyStrategy: (...args: unknown[]) => Promise<unknown> };

/**
 * Sets the disposition after the first check, before the locked transaction,
 * and keeps the bytes it wrote: anything the refused pick writes afterwards
 * shows up as a difference from them.
 */
function injectDispositionAtStrategy(root: string, id: string): { bytes: string | null } {
  const injected = { bytes: null as string | null };
  vi.spyOn(PickTicketStage.prototype as unknown as StrategySpy, "applyStrategy")
    .mockImplementation(async () => {
      writeIssue(root, id, { disposition: "owner_gated" });
      injected.bytes = readFileSync(issuePath(root, id), "utf-8");
      return null;
    });
  return injected;
}

describe("PICK_TICKET refuses a non-actionable issue (T-486 U4)", () => {
  it("A3: a disposition set before the locked pick is refused there, and nothing is written", async () => {
    const root = buildRepo();
    writeIssue(root, "ISS-200");
    const injected = injectDispositionAtStrategy(root, "ISS-200");
    const ctx = contextFor(root);

    const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-200" });

    expect(result.action).toBe("retry");
    expect((result as { instruction: string }).instruction)
      .toBe("Issue ISS-200 has disposition owner_gated and is not actionable. Pick a different issue, or clear its disposition first.");
    expect(injected.bytes).not.toBeNull();
    expect(readFileSync(issuePath(root, "ISS-200"), "utf-8")).toBe(injected.bytes);
    expect(JSON.parse(injected.bytes!).status).toBe("open");
    expect(ctx.state.pendingProjectMutation ?? null).toBeNull();
    expect((ctx.state as unknown as { currentIssue?: unknown }).currentIssue ?? null).toBeNull();
  });

  it("the first check refuses an issue already non-actionable, before any branch strategy runs", async () => {
    const root = buildRepo();
    writeIssue(root, "ISS-200", { disposition: "escalate_only" });
    const before = readFileSync(issuePath(root, "ISS-200"), "utf-8");
    const strategy = vi.spyOn(PickTicketStage.prototype as unknown as StrategySpy, "applyStrategy");

    const result = await new PickTicketStage().report(contextFor(root), { completedAction: "issue_picked", issueId: "ISS-200" });

    expect(result.action).toBe("retry");
    expect((result as { instruction: string }).instruction).toContain("has disposition escalate_only and is not actionable");
    expect(strategy).not.toHaveBeenCalled();
    expect(readFileSync(issuePath(root, "ISS-200"), "utf-8")).toBe(before);
  });

  it("A4: targeted mode picks a named non-actionable issue at the first check and the locked pick", async () => {
    const root = buildRepo();
    writeIssue(root, "ISS-200", { disposition: "owner_gated" });
    const ctx = contextFor(root, { targetWork: ["ISS-200"] } as Partial<FullSessionState>);

    const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-200" });

    expect(result.action, JSON.stringify(result)).toBe("goto");
    expect((result as { target: string }).target).toBe("ISSUE_FIX");
    expect(JSON.parse(readFileSync(issuePath(root, "ISS-200"), "utf-8")).status).toBe("inprogress");
  });

  it("an issue with no disposition is still picked", async () => {
    const root = buildRepo();
    writeIssue(root, "ISS-200");
    const ctx = contextFor(root);

    const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-200" });

    expect(result.action, JSON.stringify(result)).toBe("goto");
    expect((result as { target: string }).target).toBe("ISSUE_FIX");
  });
});

// T-481 T7a and T7b: PICK_TICKET never picks an item that waits on the owner
// or an external party, at the first read and at the locked re-check, and a
// run that names the item does not exempt it.
describe("T-481 T7a/T7b: PICK_TICKET refuses waiting items", () => {
  function ticketPath(root: string, id: string): string {
    return join(root, ".story", "tickets", `${id}.json`);
  }
  function writeTicket(root: string, id: string, overrides: Record<string, unknown> = {}): void {
    writeFileSync(ticketPath(root, id), JSON.stringify({
      id, title: `Ticket ${id}`, description: "", type: "task", status: "open", phase: "p1", order: 10,
      createdDate: "2026-10-16", completedDate: null, blockedBy: [], parentTicket: null, ...overrides,
    }));
  }
  function injectAtStrategy(write: () => void, read: () => string): { bytes: string | null } {
    const injected = { bytes: null as string | null };
    vi.spyOn(PickTicketStage.prototype as unknown as StrategySpy, "applyStrategy")
      .mockImplementation(async () => { write(); injected.bytes = read(); return null; });
    return injected;
  }

  for (const wait of ["owner", "external"] as const) {
    for (const targeted of [false, true]) {
      const mode = targeted ? "targeted" : "untargeted";

      it(`ticket, ${mode}, waiting on ${wait}: refused at the first read and nothing is written`, async () => {
        const root = buildRepo();
        writeTicket(root, "T-100", { waitingOn: wait });
        const before = readFileSync(ticketPath(root, "T-100"), "utf-8");
        const ctx = contextFor(root, targeted ? { targetWork: ["T-100"] } as Partial<FullSessionState> : {});
        const strategy = vi.spyOn(PickTicketStage.prototype as unknown as StrategySpy, "applyStrategy");
        const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });
        expect(result.action).toBe("retry");
        expect((result as { instruction: string }).instruction).toContain("waitingOn");
        expect(readFileSync(ticketPath(root, "T-100"), "utf-8")).toBe(before);
        // Refused before the branch strategy touches git, not only under the lock.
        expect(strategy).not.toHaveBeenCalled();
      });

      it(`ticket, ${mode}, a wait on ${wait} added after the first read is refused under the lock`, async () => {
        const root = buildRepo();
        writeTicket(root, "T-100");
        const injected = injectAtStrategy(
          () => writeTicket(root, "T-100", { waitingOn: wait }),
          () => readFileSync(ticketPath(root, "T-100"), "utf-8"),
        );
        const ctx = contextFor(root, targeted ? { targetWork: ["T-100"] } as Partial<FullSessionState> : {});
        const result = await new PickTicketStage().report(ctx, { completedAction: "ticket_picked", ticketId: "T-100" });
        expect(result.action).toBe("retry");
        expect((result as { instruction: string }).instruction).toContain("waitingOn");
        expect(readFileSync(ticketPath(root, "T-100"), "utf-8")).toBe(injected.bytes);
      });

      it(`issue, ${mode}, waiting on ${wait} with no disposition: refused at the first read and nothing is written`, async () => {
        const root = buildRepo();
        writeIssue(root, "ISS-200", { waitingOn: wait });
        const before = readFileSync(issuePath(root, "ISS-200"), "utf-8");
        const ctx = contextFor(root, targeted ? { targetWork: ["ISS-200"] } as Partial<FullSessionState> : {});
        const strategy = vi.spyOn(PickTicketStage.prototype as unknown as StrategySpy, "applyStrategy");
        const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-200" });
        expect(result.action).toBe("retry");
        expect((result as { instruction: string }).instruction).toContain("waitingOn");
        expect(readFileSync(issuePath(root, "ISS-200"), "utf-8")).toBe(before);
        expect(ctx.state.pendingProjectMutation ?? null).toBeNull();
        expect(strategy).not.toHaveBeenCalled();
      });

      it(`issue, ${mode}, a wait on ${wait} added after the first read is refused under the lock`, async () => {
        const root = buildRepo();
        writeIssue(root, "ISS-200");
        const injected = injectAtStrategy(
          () => writeIssue(root, "ISS-200", { waitingOn: wait }),
          () => readFileSync(issuePath(root, "ISS-200"), "utf-8"),
        );
        const ctx = contextFor(root, targeted ? { targetWork: ["ISS-200"] } as Partial<FullSessionState> : {});
        const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-200" });
        expect(result.action).toBe("retry");
        expect((result as { instruction: string }).instruction).toContain("waitingOn");
        expect(readFileSync(issuePath(root, "ISS-200"), "utf-8")).toBe(injected.bytes);
        expect(ctx.state.pendingProjectMutation ?? null).toBeNull();
      });
    }
  }

  it("ticket: the waiting check lifts once the field is cleared", async () => {
    const root = buildRepo();
    writeTicket(root, "T-100", { waitingOn: "none" });
    const result = await new PickTicketStage().report(contextFor(root), { completedAction: "ticket_picked", ticketId: "T-100" });
    expect(result.action, JSON.stringify(result)).not.toBe("retry");
  });
});

// T-481 T12e: the pick's earmark conversion (reserved -> assigned) is a
// reference rewrite and never stamps updatedDate. The issue's later status
// write is a content change and does.
describe("T-481 T12e: an earmark-only conversion at pick keeps updatedDate", () => {
  const SESSION = "00000000-0000-0000-0000-00000000a403";
  const reserved = {
    stage: "reserved", reservedBy: { client: "claude", id: "pen-task-1" }, arrangementId: "a-0123456789abcdef",
    since: new Date().toISOString(), holderRole: "worker", holderSession: null,
  };

  it("ticket: the conversion changes the earmark and keeps 2020-01-01", async () => {
    const root = buildRepo();
    const path = join(root, ".story", "tickets", "T-100.json");
    writeFileSync(path, JSON.stringify({
      id: "T-100", title: "Ticket T-100", description: "", type: "task", status: "open", phase: "p1", order: 10,
      createdDate: "2020-01-01", updatedDate: "2020-01-01", completedDate: null, blockedBy: [], parentTicket: null,
      earmark: reserved,
    }));
    const result = await new PickTicketStage().report(contextFor(root), { completedAction: "ticket_picked", ticketId: "T-100" });
    expect(result.action, JSON.stringify(result)).not.toBe("retry");
    const after = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(after.earmark).toMatchObject({ stage: "assigned", holderSession: SESSION });
    expect(after.updatedDate).toBe("2020-01-01");
  });

  it("issue: the conversion keeps 2020-01-01 until the status write, which stamps", async () => {
    const root = buildRepo();
    writeIssue(root, "ISS-200", { updatedDate: "2020-01-01", earmark: reserved });
    const ctx = contextFor(root);
    const atMarker: Array<Record<string, unknown>> = [];
    const original = ctx.writeState.bind(ctx);
    vi.spyOn(ctx, "writeState").mockImplementation(((patch: Record<string, unknown>) => {
      if (patch && patch.pendingProjectMutation) {
        atMarker.push(JSON.parse(readFileSync(issuePath(root, "ISS-200"), "utf-8")) as Record<string, unknown>);
      }
      return original(patch as never);
    }) as never);
    const result = await new PickTicketStage().report(ctx, { completedAction: "issue_picked", issueId: "ISS-200" });
    expect(result.action, JSON.stringify(result)).not.toBe("retry");
    expect(atMarker).toHaveLength(1);
    expect(atMarker[0]!.earmark).toMatchObject({ stage: "assigned", holderSession: SESSION });
    expect(atMarker[0]!.updatedDate).toBe("2020-01-01");
    const after = JSON.parse(readFileSync(issuePath(root, "ISS-200"), "utf-8")) as Record<string, unknown>;
    expect(after.status).toBe("inprogress");
    expect(after.updatedDate).toBe(todayISO());
  });
});
