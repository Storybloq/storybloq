/**
 * T-474 section 6: FINALIZE's pre-commit-ack gate -- the load-bearing check
 * inside `handleCommit` (the single convergence point every commit-
 * acceptance path funnels through), and the non-load-bearing courtesy check
 * at the "Now commit" instruction sites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/autonomous/git-inspector.js", () => ({
  gitHead: vi.fn(),
  gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
  gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
  gitDiffStat: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffCachedNames: vi.fn().mockResolvedValue({ ok: false }),
  gitDiffTreeNames: vi.fn(),
  gitBlobHash: vi.fn().mockResolvedValue({ ok: false }),
  gitStash: vi.fn().mockResolvedValue({ ok: true }),
  gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  gitResolveCommit: vi.fn(),
  gitRevListAncestryPath: vi.fn(),
  gitCommitterEmail: vi.fn(),
  gitUserEmail: vi.fn(),
  gitParentOf: vi.fn(),
  gitTreeOf: vi.fn(),
  gitWriteTree: vi.fn(),
}));

import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { FinalizeStage } from "../../src/autonomous/stages/finalize.js";
import {
  gitHead, gitDiffTreeNames, gitDiffCachedNames, gitResolveCommit, gitRevListAncestryPath,
  gitCommitterEmail, gitUserEmail, gitParentOf, gitTreeOf, gitWriteTree,
} from "../../src/autonomous/git-inspector.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleArrangementCreate } from "../../src/cli/commands/arrangement.js";
import { writeGateAckUnlocked } from "../../src/core/gate-ack-loader.js";
import { computeGateAckId, PRECOMMIT_ACK_GATE_NAME, PLAN_ACK_GATE_NAME, type GateAck, type GateAckPin } from "../../src/models/gate-ack.js";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";

const mockedGitHead = vi.mocked(gitHead);
const mockedGitDiffTreeNames = vi.mocked(gitDiffTreeNames);
const mockedGitDiffCachedNames = vi.mocked(gitDiffCachedNames);
const mockedGitResolveCommit = vi.mocked(gitResolveCommit);
const mockedGitRevListAncestryPath = vi.mocked(gitRevListAncestryPath);
const mockedGitCommitterEmail = vi.mocked(gitCommitterEmail);
const mockedGitUserEmail = vi.mocked(gitUserEmail);
const mockedGitParentOf = vi.mocked(gitParentOf);
const mockedGitTreeOf = vi.mocked(gitTreeOf);
const mockedGitWriteTree = vi.mocked(gitWriteTree);

const A40 = "a".repeat(40);
const B40 = "b".repeat(40);
const PARENT40 = "c".repeat(40);
const TREE40 = "d".repeat(40);

const CLAIM_EMAIL = "claimant@example.com";
const SESSION_ID = "00000000-0000-0000-0000-000000000474";

const PARTIES = [
  { role: "pen" as const, client: "claude" as const, identityAnchor: "pen-session" },
  { role: "worker" as const, client: "claude" as const, identityAnchor: "worker-session" },
];

async function newProjectWithGatedTicket(): Promise<{ root: string; ticketId: string; arrangementId: string }> {
  const root = mkdtempSync(join(tmpdir(), "finalize-gate-ack-"));
  await initProject(root, { name: "test" });
  await handleTicketCreate(
    { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    root,
  );
  const created = await handleArrangementCreate(
    { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
    "json",
    root,
  );
  const arrangementId = JSON.parse(created.output).data.id as string;
  const path = join(root, ".story", "arrangements", `${arrangementId}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8"));
  raw.gates = [{ name: PRECOMMIT_ACK_GATE_NAME, ackRole: "pen" }];
  await writeFile(path, JSON.stringify(raw));
  return { root, ticketId: "T-001", arrangementId };
}

/** T-478 (ISS-1050 interim): plan-ack configured with NO paired pre-commit-ack -- the risky shape. */
async function newProjectWithPlanAckOnlyGatedTicket(): Promise<{ root: string; ticketId: string; arrangementId: string }> {
  const root = mkdtempSync(join(tmpdir(), "finalize-gate-risk-"));
  await initProject(root, { name: "test" });
  await handleTicketCreate(
    { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    root,
  );
  const created = await handleArrangementCreate(
    { bounds: ["T-001"], parties: PARTIES, onIrreversibleWork: "hold" },
    "json",
    root,
  );
  const arrangementId = JSON.parse(created.output).data.id as string;
  const path = join(root, ".story", "arrangements", `${arrangementId}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8"));
  raw.gates = [{ name: PLAN_ACK_GATE_NAME, ackRole: "pen" }];
  await writeFile(path, JSON.stringify(raw));
  return { root, ticketId: "T-001", arrangementId };
}

function makeEpoch(ticketId: string) {
  return {
    ticketId,
    sessionId: SESSION_ID,
    user: CLAIM_EMAIL,
    branch: "main",
    since: "2026-01-01T00:00:00.000Z",
    establishedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeState(ticketId: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    recipe: "coding",
    state: "FINALIZE",
    revision: 1,
    status: "active",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    commitAttributionAudits: [],
    finalizeCheckpoint: "precommit_passed",
    git: {
      branch: "main",
      mergeBase: B40,
      expectedHead: B40,
      initHead: B40,
      itemBaseHead: B40,
      baseline: { porcelain: [], dirtyTrackedFiles: {}, untrackedPaths: [] },
    },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null,
    resumeFromRevision: null,
    preCompactState: null,
    compactPending: false,
    compactPreparedAt: null,
    resumeBlocked: false,
    terminationReason: null,
    waitingForRetry: false,
    lastGuideCall: now,
    startedAt: now,
    guideCallCount: 5,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: { id: ticketId, title: "Duet ticket", claimed: true },
    claimEpoch: makeEpoch(ticketId),
    filedDeferrals: [],
    pendingDeferrals: [],
    deferralsUnfiled: false,
    ...overrides,
  } as unknown as FullSessionState;
}

function makeRecipe(): ResolvedRecipe {
  return {
    id: "coding",
    pipeline: ["PICK_TICKET", "PLAN", "PLAN_REVIEW", "IMPLEMENT", "CODE_REVIEW", "FINALIZE", "COMPLETE"],
    postComplete: [],
    stages: {},
    dirtyFileHandling: "block",
    defaults: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
  };
}

const tempDirs: string[] = [];

describe("FINALIZE pre-commit-ack gate (T-474)", () => {
  const stage = new FinalizeStage();
  let sessionDir: string;

  beforeEach(() => {
    mockedGitHead.mockReset();
    mockedGitDiffTreeNames.mockReset();
    mockedGitDiffCachedNames.mockReset();
    mockedGitResolveCommit.mockReset();
    mockedGitRevListAncestryPath.mockReset();
    mockedGitCommitterEmail.mockReset();
    mockedGitUserEmail.mockReset();
    mockedGitParentOf.mockReset();
    mockedGitTreeOf.mockReset();
    mockedGitWriteTree.mockReset();
    mockedGitCommitterEmail.mockResolvedValue({ ok: true, data: CLAIM_EMAIL });
  });

  afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function newFixture(): { root: string } {
    const root = mkdtempSync(join(tmpdir(), "finalize-gate-ack-session-"));
    tempDirs.push(root);
    sessionDir = join(root, ".story", "sessions", "test-session");
    mkdirSync(sessionDir, { recursive: true });
    return { root };
  }

  it("holds commit_done when no gate-ack has been recorded for this commit's pin", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitParentOf.mockResolvedValue({ ok: true, data: PARENT40 });
    mockedGitTreeOf.mockResolvedValue({ ok: true, data: TREE40 });

    const ctx = new StageContext(root, sessionDir, makeState(ticketId), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain(`requires a gate-ack from pen`);
    }
    expect(ctx.state.finalizeCheckpoint).not.toBe("committed");
  });

  it("accepts commit_done once a valid gate-ack matches the commit's exact tree-digest pin", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitParentOf.mockResolvedValue({ ok: true, data: PARENT40 });
    mockedGitTreeOf.mockResolvedValue({ ok: true, data: TREE40 });

    const pin: GateAckPin = { kind: "tree-digest", parentSha: PARENT40, treeId: TREE40 };
    const ack: GateAck = {
      id: computeGateAckId(arrangementId, PRECOMMIT_ACK_GATE_NAME, ticketId, pin),
      arrangementId,
      gateName: PRECOMMIT_ACK_GATE_NAME,
      ackRole: "pen",
      ticketRef: ticketId,
      pin,
      decidedAt: new Date().toISOString(),
      reviewTrail: { present: false },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);

    const ctx = new StageContext(root, sessionDir, makeState(ticketId), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });
    expect(result.action).toBe("advance");
    expect(ctx.state.finalizeCheckpoint).toBe("committed");
  });

  it("fires identically via enter()'s auto-detect fast-forward as it does via a reported commit_done", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    // itemBaseHead (B40) differs from current HEAD (A40) -- enter() detects
    // the advance and validates the ticket file is in the commit tree before
    // fast-forwarding to handleCommit.
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitDiffTreeNames.mockResolvedValue({ ok: true, data: [`.story/tickets/${ticketId}.json`] });
    mockedGitParentOf.mockResolvedValue({ ok: true, data: PARENT40 });
    mockedGitTreeOf.mockResolvedValue({ ok: true, data: TREE40 });

    const ctx = new StageContext(root, sessionDir, makeState(ticketId, { finalizeCheckpoint: null }), makeRecipe());
    const result = await stage.enter(ctx);
    expect((result as { action?: string }).action).toBe("retry");
    if ("action" in result && result.action === "retry") {
      expect(result.instruction).toContain(`requires a gate-ack from pen`);
    }
    expect(ctx.state.finalizeCheckpoint).not.toBe("committed");
  });

  it("blocks with a named reason when the commit's parent cannot be determined", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitParentOf.mockResolvedValue({ ok: false, reason: "git_error", message: "unknown revision or path not in the working tree" });

    const ctx = new StageContext(root, sessionDir, makeState(ticketId), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("Cannot determine");
      expect(result.instruction).toContain("parent");
    }
    expect(ctx.state.finalizeCheckpoint).not.toBe("committed");
  });

  it("blocks with the sha256-repo refusal message when gitTreeOf reports an unsupported object format", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitParentOf.mockResolvedValue({ ok: true, data: PARENT40 });
    mockedGitTreeOf.mockResolvedValue({ ok: false, reason: "unsupported_object_format", message: "gate-ack v1 only supports SHA-1 git repositories (found: sha256)" });

    const ctx = new StageContext(root, sessionDir, makeState(ticketId), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("only supports SHA-1");
    }
    expect(ctx.state.finalizeCheckpoint).not.toBe("committed");
  });

  it("courtesy check: a valid ack's deltas appear in the 'Now commit' instruction, never expected from handleCommit's own response", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitWriteTree.mockResolvedValue({ ok: true, data: TREE40 });
    mockedGitDiffCachedNames.mockResolvedValue({ ok: true, data: [`.story/tickets/${ticketId}.json`, "src/thing.ts"] });

    const pin: GateAckPin = { kind: "tree-digest", parentSha: A40, treeId: TREE40 };
    const ack: GateAck = {
      id: computeGateAckId(arrangementId, PRECOMMIT_ACK_GATE_NAME, ticketId, pin),
      arrangementId,
      gateName: PRECOMMIT_ACK_GATE_NAME,
      ackRole: "pen",
      ticketRef: ticketId,
      pin,
      decidedAt: new Date().toISOString(),
      deltas: "Non-mutating note: the follow-up caching ticket is filed separately.",
      reviewTrail: { present: false },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);

    const ctx = new StageContext(root, sessionDir, makeState(ticketId, { finalizeCheckpoint: null }), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "files_staged" });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("Non-mutating note: the follow-up caching ticket is filed separately.");
    }
  });

  it("courtesy check withholds 'Now commit' when the gate is unresolved rather than sending the agent to commit blind", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    mockedGitDiffCachedNames.mockResolvedValue({ ok: true, data: [`.story/tickets/${ticketId}.json`, "src/thing.ts"] });
    // A second, broken arrangement file makes the scan dirty.
    await writeFile(join(root, ".story", "arrangements", "a-brokenbrokenbrok.json"), "{not json");

    const ctx = new StageContext(root, sessionDir, makeState(ticketId, { finalizeCheckpoint: null }), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "files_staged" });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("could not be resolved");
      expect(result.instruction).not.toContain("Now commit");
    }
  });

  it("an issue-fix session with no arrangement bounding IT is ungated, even when a DIFFERENT item is gated", async () => {
    const { root } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });
    mockedGitUserEmail.mockResolvedValue(CLAIM_EMAIL);

    const state = makeState("unused", {
      ticket: undefined,
      claimEpoch: undefined,
      currentIssue: { id: "ISS-1", displayId: "ISS-1", title: "An issue", severity: "medium" },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });
    // Never held by the gate-ack check -- may still fail/succeed on other
    // grounds, but never on a gate-ack hold (mockedGitParentOf/gitTreeOf were
    // never even configured, so a call into them would throw/return undefined).
    if (result.action === "retry") {
      expect(result.instruction).not.toContain("gate-ack");
    }
  });

  it("[ISS-1049] an issue-fix session bound by an arrangement IS gated: holds commit_done with no ack", async () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-gate-ack-issue-"));
    await initProject(root, { name: "test" });
    const { handleIssueCreate } = await import("../../src/cli/commands/issue.js");
    await handleIssueCreate(
      { title: "Duet issue", severity: "medium", impact: "test", components: [], relatedTickets: [], location: [] },
      "json",
      root,
    );
    const created = await handleArrangementCreate(
      { bounds: ["ISS-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      root,
    );
    const arrangementId = JSON.parse(created.output).data.id as string;
    const arrPath = join(root, ".story", "arrangements", `${arrangementId}.json`);
    const raw = JSON.parse(await readFile(arrPath, "utf-8"));
    raw.gates = [{ name: PRECOMMIT_ACK_GATE_NAME, ackRole: "pen" }];
    await writeFile(arrPath, JSON.stringify(raw));
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });
    mockedGitUserEmail.mockResolvedValue(CLAIM_EMAIL);
    mockedGitParentOf.mockResolvedValue({ ok: true, data: PARENT40 });
    mockedGitTreeOf.mockResolvedValue({ ok: true, data: TREE40 });

    const state = makeState("unused", {
      ticket: undefined,
      claimEpoch: undefined,
      currentIssue: { id: "ISS-001", displayId: "ISS-001", title: "Duet issue", severity: "medium" },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain(`requires a gate-ack from pen`);
    }
    expect(ctx.state.finalizeCheckpoint).not.toBe("committed");
  });

  it("[ISS-1049] an issue-fix session bound by an arrangement: accepts commit_done once a valid gate-ack matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "finalize-gate-ack-issue-ok-"));
    await initProject(root, { name: "test" });
    const { handleIssueCreate } = await import("../../src/cli/commands/issue.js");
    await handleIssueCreate(
      { title: "Duet issue", severity: "medium", impact: "test", components: [], relatedTickets: [], location: [] },
      "json",
      root,
    );
    const created = await handleArrangementCreate(
      { bounds: ["ISS-001"], parties: PARTIES, onIrreversibleWork: "hold" },
      "json",
      root,
    );
    const arrangementId = JSON.parse(created.output).data.id as string;
    const arrPath = join(root, ".story", "arrangements", `${arrangementId}.json`);
    const raw = JSON.parse(await readFile(arrPath, "utf-8"));
    raw.gates = [{ name: PRECOMMIT_ACK_GATE_NAME, ackRole: "pen" }];
    await writeFile(arrPath, JSON.stringify(raw));
    tempDirs.push(root);
    newFixture();
    mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
    mockedGitResolveCommit.mockResolvedValue({ ok: true, data: A40 });
    mockedGitUserEmail.mockResolvedValue(CLAIM_EMAIL);
    mockedGitParentOf.mockResolvedValue({ ok: true, data: PARENT40 });
    mockedGitTreeOf.mockResolvedValue({ ok: true, data: TREE40 });

    const pin: GateAckPin = { kind: "tree-digest", parentSha: PARENT40, treeId: TREE40 };
    const ack: GateAck = {
      id: computeGateAckId(arrangementId, PRECOMMIT_ACK_GATE_NAME, "ISS-001", pin),
      arrangementId,
      gateName: PRECOMMIT_ACK_GATE_NAME,
      ackRole: "pen",
      ticketRef: "ISS-001",
      pin,
      decidedAt: new Date().toISOString(),
      reviewTrail: { present: false },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);

    const state = makeState("unused", {
      ticket: undefined,
      claimEpoch: undefined,
      currentIssue: { id: "ISS-001", displayId: "ISS-001", title: "Duet issue", severity: "medium" },
    } as Partial<FullSessionState>);
    const ctx = new StageContext(root, sessionDir, state, makeRecipe());
    const result = await stage.report(ctx, { completedAction: "commit_done", commitHash: A40 });
    // Issue-fix mode's own routing (ISS-084, unrelated to the gate) always
    // returns goto/COMPLETE rather than a bare advance -- the point here is
    // only that the gate did NOT hold (contrast with the previous test).
    expect(result.action).toBe("goto");
    if (result.action === "goto") expect(result.target).toBe("COMPLETE");
    expect(ctx.state.finalizeCheckpoint).toBe("committed");
  });

  describe("T-478: ISS-1050 interim -- plan-ack-without-pre-commit-ack risk warning", () => {
    it("surfaces the gate-risk warning in the 'Now commit' instruction, with no gate-ack hold at all (no pre-commit-ack gate exists to hold on)", async () => {
      const { root, ticketId } = await newProjectWithPlanAckOnlyGatedTicket();
      tempDirs.push(root);
      newFixture();
      mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
      mockedGitDiffCachedNames.mockResolvedValue({ ok: true, data: [`.story/tickets/${ticketId}.json`, "src/thing.ts"] });

      const ctx = new StageContext(root, sessionDir, makeState(ticketId, { finalizeCheckpoint: null }), makeRecipe());
      const result = await stage.report(ctx, { completedAction: "files_staged" });
      expect(result.action).toBe("retry");
      if (result.action === "retry") {
        expect(result.instruction).toContain("Now commit");
        expect(result.instruction).toContain("plan-ack");
        expect(result.instruction).toContain("pre-commit-ack");
        expect(result.instruction).toContain("ISS-1050");
      }
    });

    it("frozenGate's persisted session-state shape is unaffected -- round-trips through the real Zod schema with no extra or stripped fields", async () => {
      const { root, ticketId, arrangementId } = await newProjectWithPlanAckOnlyGatedTicket();
      tempDirs.push(root);
      newFixture();
      mockedGitHead.mockResolvedValue({ ok: true, data: { hash: A40, branch: "main" } });
      mockedGitDiffCachedNames.mockResolvedValue({ ok: true, data: [`.story/tickets/${ticketId}.json`, "src/thing.ts"] });

      const ctx = new StageContext(root, sessionDir, makeState(ticketId, { finalizeCheckpoint: null }), makeRecipe());
      await stage.report(ctx, { completedAction: "files_staged" });

      const frozenGate = ctx.state.frozenGate;
      expect(frozenGate).toEqual({ status: "gated", arrangementId, gates: [{ name: PLAN_ACK_GATE_NAME, ackRole: "pen" }] });
      // The load-bearing check named by codex round 2: a future edit that
      // (re-)attaches the warning onto `frozenGate` without a matching Zod
      // schema change would pass the `toEqual` above (the in-memory object
      // still has the extra field going INTO the parse) but get silently
      // stripped coming back OUT of it -- exactly the strip-on-reload bug
      // this test exists to catch.
      const roundTripped = SessionStateSchema.shape.frozenGate.parse(frozenGate);
      expect(roundTripped).toEqual(frozenGate);
    });
  });
});
