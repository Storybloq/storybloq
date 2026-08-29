/**
 * ISS-1049: an issue-fix session now resolves its own gate coverage at pick
 * time, same as a ticket pick -- closing the T-474 section 7 descope that
 * used to hardcode `frozenGate: { status: "ungated" }` for every issue pick
 * regardless of whether an arrangement actually bounds that issue.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StageContext, type ResolvedRecipe } from "../../../src/autonomous/stages/types.js";
import { PickTicketStage } from "../../../src/autonomous/stages/pick-ticket.js";
import type { FullSessionState } from "../../../src/autonomous/session-types.js";
import { handleArrangementCreate } from "../../../src/cli/commands/arrangement.js";

const PARTIES = [
  { role: "pen" as const, client: "claude" as const, identityAnchor: "pen-session" },
  { role: "worker" as const, client: "claude" as const, identityAnchor: "worker-session" },
];

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root }).toString().trim();
}

function buildRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pick-issue-gate-"));
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(root, ".story", sub), { recursive: true });
  }
  writeFileSync(join(root, ".story", "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "pick-issue-gate", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(root, ".story", "roadmap.json"), JSON.stringify({
    title: "pick-issue-gate", date: "2026-08-30",
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

async function gateIssue(root: string, issueId: string): Promise<string> {
  const created = await handleArrangementCreate(
    { bounds: [issueId], parties: PARTIES, onIrreversibleWork: "hold" },
    "json",
    root,
  );
  const arrangementId = JSON.parse(created.output).data.id as string;
  const path = join(root, ".story", "arrangements", `${arrangementId}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8"));
  raw.gates = [{ name: "pre-commit-ack", ackRole: "pen" }];
  await writeFile(path, JSON.stringify(raw));
  return arrangementId;
}

function makeState(overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000001049",
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

describe("[ISS-1049] PickTicketStage.handleIssuePick resolves real gate coverage", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(() => {
    root = buildRepo();
    sessionDir = join(root, ".story", "sessions", "s");
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("an issue bound by an active arrangement resolves gated, with that arrangement's id and gates", async () => {
    writeIssue(root, "ISS-001");
    const arrangementId = await gateIssue(root, "ISS-001");

    const stage = new PickTicketStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-001" });

    expect(ctx.state.frozenGate).toEqual({
      status: "gated",
      arrangementId,
      gates: [{ name: "pre-commit-ack", ackRole: "pen" }],
    });
  });

  it("an issue with no covering arrangement resolves ungated, same as before", async () => {
    writeIssue(root, "ISS-002");

    const stage = new PickTicketStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-002" });

    expect(ctx.state.frozenGate).toEqual({ status: "ungated" });
  });

  it("an arrangement gating a DIFFERENT issue does not gate this pick", async () => {
    writeIssue(root, "ISS-003");
    writeIssue(root, "ISS-004");
    await gateIssue(root, "ISS-004");

    const stage = new PickTicketStage();
    const ctx = new StageContext(root, sessionDir, makeState(), makeRecipe());
    await stage.report(ctx, { completedAction: "issue_picked", issueId: "ISS-003" });

    expect(ctx.state.frozenGate).toEqual({ status: "ungated" });
  });
});
