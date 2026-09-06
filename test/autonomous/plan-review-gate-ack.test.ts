/**
 * T-474 section 8: PLAN_REVIEW's plan-ack gate -- the crash-atomic,
 * generation-aware polling branch and the restructured immediate-approval
 * path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { PlanReviewStage } from "../../src/autonomous/stages/plan-review.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleArrangementCreate } from "../../src/cli/commands/arrangement.js";
import { handleRulingCreate } from "../../src/cli/commands/ruling.js";
import { writeGateAckUnlocked } from "../../src/core/gate-ack-loader.js";
import { computeGateAckId, PLAN_ACK_GATE_NAME, type GateAck, type GateAckPin } from "../../src/models/gate-ack.js";
import { sha256Bytes } from "../../src/core/pin-utils.js";
import { SessionStateSchema } from "../../src/autonomous/session-types.js";
import * as planSnapshotModule from "../../src/core/plan-snapshot.js";
import * as planPinGuardModule from "../../src/autonomous/plan-pin-guard.js";
const { readPlanSnapshot } = planSnapshotModule;

const PARTIES = [
  { role: "pen" as const, client: "claude" as const, identityAnchor: "pen-session" },
  { role: "worker" as const, client: "claude" as const, identityAnchor: "worker-session" },
];

async function newProjectWithGatedTicket(gateNames: string[] = [PLAN_ACK_GATE_NAME]): Promise<{ root: string; ticketId: string; arrangementId: string }> {
  const root = mkdtempSync(join(tmpdir(), "plan-review-gate-ack-"));
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
  raw.gates = gateNames.map((name) => ({ name, ackRole: "pen" }));
  await writeFile(path, JSON.stringify(raw));
  return { root, ticketId: "T-001", arrangementId };
}

function makeState(root: string, ticketId: string, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000000474",
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
    ticket: { id: ticketId, title: "Duet ticket", claimed: true, risk: "low" },
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

const stage = new PlanReviewStage();
const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newSessionDirIn(root: string): string {
  const dir = join(root, ".story", "sessions", "test-session");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("PLAN_REVIEW plan-ack gate (T-474)", () => {
  it("A3: one real submission records bookkeeping once; N subsequent check_gate_ack polls change nothing", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# The plan\n\nDo the thing.\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
    const first = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });
    expect(first.action).toBe("retry"); // held: no gate-ack recorded yet
    expect(ctx.state.reviews.plan.length).toBe(1);
    expect(ctx.state.planReviewRoundCounter?.completedRounds).toBe(1);
    expect(ctx.state.pendingPlanAck?.ticketId).toBe(ticketId);

    const counterAfterSubmission = ctx.state.planReviewRoundCounter;
    const nonApprovalsAfterSubmission = ctx.state.planGateNonApprovals;
    const reviewsLengthAfterSubmission = ctx.state.reviews.plan.length;

    for (let i = 0; i < 5; i++) {
      const polled = await stage.report(ctx, { completedAction: "check_gate_ack" });
      expect(polled.action).toBe("retry"); // still absent -- no ack exists
      expect(ctx.state.planReviewRoundCounter).toEqual(counterAfterSubmission);
      expect(ctx.state.planGateNonApprovals).toBe(nonApprovalsAfterSubmission);
      expect(ctx.state.reviews.plan.length).toBe(reviewsLengthAfterSubmission);
    }
  });

  it("[R3-FIX 2] check_gate_ack: a plan.md edit landing during resolveOrReadFrozenGateStatus's await is caught, never advanced on the stale hash", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    const planPath = join(sessionDir, "plan.md");
    writeFileSync(planPath, "# Approved plan\n");
    const originalHash = sha256Bytes(readFileSync(planPath));
    const pin: GateAckPin = { kind: "plan-hash", sha256: originalHash };
    const ack: GateAck = {
      id: computeGateAckId(arrangementId, PLAN_ACK_GATE_NAME, ticketId, pin),
      arrangementId,
      gateName: PLAN_ACK_GATE_NAME,
      ackRole: "pen",
      ticketRef: ticketId,
      pin,
      decidedAt: new Date().toISOString(),
      reviewTrail: { present: false },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);

    // frozenGate deliberately left unset (legacy) so resolveOrReadFrozenGateStatus
    // takes the `ctx.loadProject()` path -- the ONE await in handleCheckGateAck,
    // and the exact site the fix moved ahead of the plan.md read.
    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
      pendingPlanAck: { ticketId, arrangementId, gateName: PLAN_ACK_GATE_NAME, pinSha256: originalHash },
    }), makeRecipe());

    const originalLoadProject = ctx.loadProject.bind(ctx);
    ctx.loadProject = (async (...args: Parameters<typeof originalLoadProject>) => {
      writeFileSync(planPath, "# Approved plan -- EDITED during the gate-status await\n");
      return originalLoadProject(...args);
    }) as typeof ctx.loadProject;

    const result = await stage.report(ctx, { completedAction: "check_gate_ack" });

    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("plan.md changed since this review passed");
    }
    expect(ctx.state.pendingPlanAck).toBeNull();
    expect(ctx.state.reviews.plan).toEqual([]);
  });

  it("a scan with warnings AND a positive match resolves unresolved, not gated", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# The plan\n");
    // A second, broken arrangement file makes the scan dirty even though the
    // first arrangement is a valid positive match for this ticket.
    writeFileSync(join(root, ".story", "arrangements", "a-brokenbrokenbrok.json"), "{not json");

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("could not be resolved");
    }
    // Bookkeeping still recorded in the same call, even though the gate itself is unresolved.
    expect(ctx.state.planReviewRoundCounter?.completedRounds).toBe(1);
  });

  it("[D1] a plan.md edit mid-hold resets generation state and clears pendingPlanAck in ONE write", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# Plan v1\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
    await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });
    expect(ctx.state.pendingPlanAck).not.toBeNull();
    expect(ctx.state.reviews.plan.length).toBe(1);

    writeFileSync(join(sessionDir, "plan.md"), "# Plan v2 -- rewritten\n");
    const polled = await stage.report(ctx, { completedAction: "check_gate_ack" });
    expect(polled.action).toBe("retry");
    if (polled.action === "retry") {
      expect(polled.instruction).toContain("plan.md changed since this review passed");
    }
    // Both effects of the reset are visible together after this ONE call --
    // never one without the other.
    expect(ctx.state.pendingPlanAck).toBeNull();
    expect(ctx.state.reviews.plan.length).toBe(0);
    expect(ctx.state.planReviewBaseline).toBeNull();
  });

  it("check_gate_ack with no pending record holds with a dedicated message", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, { pendingPlanAck: null }), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "check_gate_ack" });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("No matching pending gate-ack hold found");
    }
  });

  it("check_gate_ack whose gate no longer exists on the arrangement holds with a dedicated message, never renderGateAckHold with an undefined gate", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n");

    const planHash = sha256Bytes(readFileSync(join(sessionDir, "plan.md")));
    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
      pendingPlanAck: { ticketId, arrangementId, gateName: "plan-ack", pinSha256: planHash },
    }), makeRecipe());

    // Remove the gate from the arrangement entirely.
    const arrPath = join(root, ".story", "arrangements", `${arrangementId}.json`);
    const raw = JSON.parse(await readFile(arrPath, "utf-8"));
    raw.gates = [];
    await writeFile(arrPath, JSON.stringify(raw));

    const result = await stage.report(ctx, { completedAction: "check_gate_ack" });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toBe("The gate this hold was waiting on no longer exists on the arrangement; escalate.");
    }
  });

  it("approvedPlanAckDeltas is persisted atomically with the round's own bookkeeping on the FIRST submission when a valid ack already exists", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    const planPath = join(sessionDir, "plan.md");
    writeFileSync(planPath, "# Already-acked plan\n");
    const pin: GateAckPin = { kind: "plan-hash", sha256: sha256Bytes(readFileSync(planPath)) };
    const ack: GateAck = {
      id: computeGateAckId(arrangementId, PLAN_ACK_GATE_NAME, ticketId, pin),
      arrangementId,
      gateName: PLAN_ACK_GATE_NAME,
      ackRole: "pen",
      ticketRef: ticketId,
      pin,
      decidedAt: new Date().toISOString(),
      deltas: "Ship it, but file a follow-up for the caching layer.",
      reviewTrail: { present: false },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });
    expect(result.action).toBe("advance");
    expect(ctx.state.approvedPlanAckDeltas).toBe("Ship it, but file a follow-up for the caching layer.");
    expect(ctx.state.planReviewRoundCounter?.completedRounds).toBe(1);
    expect(ctx.state.pendingPlanAck).toBeNull();
  });

  it("[R1-FIX 2, TOCTOU] a plan.md edit racing the intervening await between pin-check and IMPLEMENT holds instead of advancing", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    const planPath = join(sessionDir, "plan.md");
    writeFileSync(planPath, "# Approved plan\n");
    const originalHash = sha256Bytes(readFileSync(planPath));
    const pin: GateAckPin = { kind: "plan-hash", sha256: originalHash };
    const ack: GateAck = {
      id: computeGateAckId(arrangementId, PLAN_ACK_GATE_NAME, ticketId, pin),
      arrangementId,
      gateName: PLAN_ACK_GATE_NAME,
      ackRole: "pen",
      ticketRef: ticketId,
      pin,
      decidedAt: new Date().toISOString(),
      reviewTrail: { present: false },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
    // Simulate the edit landing INSIDE the window between the pin check
    // (synchronous, above) and the IMPLEMENT-transition return (below) by
    // mutating plan.md as a side effect of the one real intervening await
    // on that path, `ctx.fileDeferredFindings`.
    const originalFileDeferredFindings = ctx.fileDeferredFindings.bind(ctx);
    ctx.fileDeferredFindings = (async (...args: Parameters<typeof originalFileDeferredFindings>) => {
      writeFileSync(planPath, "# Approved plan -- EDITED after the ack passed\n");
      return originalFileDeferredFindings(...args);
    }) as typeof ctx.fileDeferredFindings;

    const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });

    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.instruction).toContain("plan.md changed after this review's gate-ack passed");
      expect(result.instruction).toContain("Submit a fresh PLAN_REVIEW report");
    }
    // Codex round 2 #2: the edited content never went through a review
    // round -- so the corrective write does a FULL generation reset (same
    // as [D1]'s mid-hold path), never a fresh pending hold for the new
    // hash. A coincidentally matching future ack must not be able to
    // advance content that was never actually reviewed.
    const newHash = sha256Bytes(readFileSync(planPath));
    expect(newHash).not.toBe(originalHash);
    expect(ctx.state.pendingPlanAck).toBeNull();
    expect(ctx.state.approvedPlanAckDeltas).toBeNull();
    expect(ctx.state.reviews.plan).toEqual([]);
    expect(ctx.state.planReviewBaseline).toBeNull();
  });

  it("an ungated ticket (no arrangement) lands at IMPLEMENT on approve exactly like today", async () => {
    const root = mkdtempSync(join(tmpdir(), "plan-review-ungated-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Ungated ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, "T-001"), makeRecipe());
    const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });
    expect(result.action).toBe("advance");
    expect(ctx.state.frozenGate).toEqual({ status: "ungated" });
  });

  describe("T-478: ISS-1050 interim -- plan-ack-without-pre-commit-ack risk warning", () => {
    it("surfaces the gate-risk warning in the report()-path hold instruction (no ack recorded yet)", async () => {
      // Default gateNames is [PLAN_ACK_GATE_NAME] alone -- the risky shape.
      const { root, ticketId } = await newProjectWithGatedTicket();
      tempDirs.push(root);
      const sessionDir = newSessionDirIn(root);
      writeFileSync(join(sessionDir, "plan.md"), "# The plan\n\nDo the thing.\n");

      const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
      const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });
      expect(result.action).toBe("retry");
      if (result.action === "retry") {
        expect(result.instruction).toContain("plan-ack");
        expect(result.instruction).toContain("pre-commit-ack");
        expect(result.instruction).toContain("ISS-1050");
      }
    });

    it("surfaces the gate-risk warning in the check_gate_ack-path hold instruction (renderGateAckHold branch)", async () => {
      const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
      tempDirs.push(root);
      const sessionDir = newSessionDirIn(root);
      writeFileSync(join(sessionDir, "plan.md"), "# Plan\n");
      const planHash = sha256Bytes(readFileSync(join(sessionDir, "plan.md")));

      const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
        pendingPlanAck: { ticketId, arrangementId, gateName: PLAN_ACK_GATE_NAME, pinSha256: planHash },
      }), makeRecipe());
      // No gate-ack has been recorded for this pin -- handleCheckGateAck's
      // final `lookup.status !== "valid"` branch, the OTHER renderGateAckHold
      // call site (distinct from the report()-path one above).
      const result = await stage.report(ctx, { completedAction: "check_gate_ack" });
      expect(result.action).toBe("retry");
      if (result.action === "retry") {
        expect(result.instruction).toContain("plan-ack");
        expect(result.instruction).toContain("pre-commit-ack");
        expect(result.instruction).toContain("ISS-1050");
      }
    });

    it("does not warn when the arrangement pairs plan-ack with pre-commit-ack", async () => {
      const { root, ticketId } = await newProjectWithGatedTicket([PLAN_ACK_GATE_NAME, "pre-commit-ack"]);
      tempDirs.push(root);
      const sessionDir = newSessionDirIn(root);
      writeFileSync(join(sessionDir, "plan.md"), "# The plan\n");

      const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
      const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });
      expect(result.action).toBe("retry");
      if (result.action === "retry") {
        expect(result.instruction).not.toContain("ISS-1050");
      }
    });

    it("frozenGate's persisted session-state shape is unaffected -- round-trips through the real Zod schema with no extra or stripped fields", async () => {
      const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
      tempDirs.push(root);
      const sessionDir = newSessionDirIn(root);
      writeFileSync(join(sessionDir, "plan.md"), "# The plan\n");

      const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
      await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });

      const frozenGate = ctx.state.frozenGate;
      expect(frozenGate).toEqual({ status: "gated", arrangementId, gates: [{ name: PLAN_ACK_GATE_NAME, ackRole: "pen" }] });
      // Guards against a future edit that (re-)attaches the warning onto
      // `frozenGate` without a matching Zod schema change (codex round 2's
      // finding): such a field would survive the `toEqual` above but be
      // silently stripped by this parse, which is the actual persistence
      // path every session reload goes through.
      const roundTripped = SessionStateSchema.shape.frozenGate.parse(frozenGate);
      expect(roundTripped).toEqual(frozenGate);
    });
  });

  describe("[ISS-1050 full fix] approvedPlanSnapshot writes", () => {
    it("SITE 2 (ungated landing): writes a content-addressed snapshot of the landed plan.md", async () => {
      const root = mkdtempSync(join(tmpdir(), "plan-review-snapshot-ungated-"));
      tempDirs.push(root);
      await initProject(root, { name: "test" });
      await handleTicketCreate(
        { title: "Ungated ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
        "md",
        root,
      );
      const sessionDir = newSessionDirIn(root);
      const planPath = join(sessionDir, "plan.md");
      writeFileSync(planPath, "# Ungated plan\n\nDo the thing.\n");
      const expectedBytes = readFileSync(planPath);

      const ctx = new StageContext(root, sessionDir, makeState(root, "T-001"), makeRecipe());
      const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });

      expect(result.action).toBe("advance");
      const ref = ctx.state.approvedPlanSnapshot;
      expect(ref).toBeTruthy();
      expect(ref?.sha256).toBe(sha256Bytes(expectedBytes));
      const read = readPlanSnapshot(sessionDir, ref!);
      expect(read).toEqual({ status: "ok", text: expectedBytes.toString("utf-8") });
    });

    it("SITE 1 (gated recheck): writes a content-addressed snapshot when landing via a pre-existing valid ack", async () => {
      const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
      tempDirs.push(root);
      const sessionDir = newSessionDirIn(root);
      const planPath = join(sessionDir, "plan.md");
      writeFileSync(planPath, "# Already-acked plan\n");
      const expectedBytes = readFileSync(planPath);
      const pin: GateAckPin = { kind: "plan-hash", sha256: sha256Bytes(expectedBytes) };
      const ack: GateAck = {
        id: computeGateAckId(arrangementId, PLAN_ACK_GATE_NAME, ticketId, pin),
        arrangementId,
        gateName: PLAN_ACK_GATE_NAME,
        ackRole: "pen",
        ticketRef: ticketId,
        pin,
        decidedAt: new Date().toISOString(),
        reviewTrail: { present: false },
        contested: false,
      };
      await writeGateAckUnlocked(ack, root);

      const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
      const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });

      expect(result.action).toBe("advance");
      const ref = ctx.state.approvedPlanSnapshot;
      expect(ref).toBeTruthy();
      expect(ref?.sha256).toBe(sha256Bytes(expectedBytes));
      const read = readPlanSnapshot(sessionDir, ref!);
      expect(read).toEqual({ status: "ok", text: expectedBytes.toString("utf-8") });
    });

    it("SITE 3 (check_gate_ack poll): writes a content-addressed snapshot when the poll discovers a newly-valid ack", async () => {
      const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
      tempDirs.push(root);
      const sessionDir = newSessionDirIn(root);
      const planPath = join(sessionDir, "plan.md");
      writeFileSync(planPath, "# Polled plan\n");
      const expectedBytes = readFileSync(planPath);
      const planHash = sha256Bytes(expectedBytes);

      const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
        pendingPlanAck: { ticketId, arrangementId, gateName: PLAN_ACK_GATE_NAME, pinSha256: planHash },
      }), makeRecipe());

      // No ack exists yet -- first poll holds.
      const firstPoll = await stage.report(ctx, { completedAction: "check_gate_ack" });
      expect(firstPoll.action).toBe("retry");
      expect(ctx.state.approvedPlanSnapshot).toBeFalsy();

      // Now the pen records the ack; the next poll discovers it valid.
      const pin: GateAckPin = { kind: "plan-hash", sha256: planHash };
      const ack: GateAck = {
        id: computeGateAckId(arrangementId, PLAN_ACK_GATE_NAME, ticketId, pin),
        arrangementId,
        gateName: PLAN_ACK_GATE_NAME,
        ackRole: "pen",
        ticketRef: ticketId,
        pin,
        decidedAt: new Date().toISOString(),
        reviewTrail: { present: false },
        contested: false,
      };
      await writeGateAckUnlocked(ack, root);

      const result = await stage.report(ctx, { completedAction: "check_gate_ack" });
      expect(result.action).toBe("advance");
      const ref = ctx.state.approvedPlanSnapshot;
      expect(ref).toBeTruthy();
      expect(ref?.sha256).toBe(planHash);
      const read = readPlanSnapshot(sessionDir, ref!);
      expect(read).toEqual({ status: "ok", text: expectedBytes.toString("utf-8") });
    });

    it("[D1] SITE 1 gated recheck: a snapshot write failure blocks the transition rather than advancing without a pin", async () => {
      const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
      tempDirs.push(root);
      const sessionDir = newSessionDirIn(root);
      const planPath = join(sessionDir, "plan.md");
      writeFileSync(planPath, "# Blocked-write plan\n");
      const expectedBytes = readFileSync(planPath);
      const planHash = sha256Bytes(expectedBytes);
      const pin: GateAckPin = { kind: "plan-hash", sha256: planHash };
      const ack: GateAck = {
        id: computeGateAckId(arrangementId, PLAN_ACK_GATE_NAME, ticketId, pin),
        arrangementId,
        gateName: PLAN_ACK_GATE_NAME,
        ackRole: "pen",
        ticketRef: ticketId,
        pin,
        decidedAt: new Date().toISOString(),
        reviewTrail: { present: false },
        contested: false,
      };
      await writeGateAckUnlocked(ack, root);

      // Force a genuine, non-idempotent write failure: a pre-occupied target
      // path would hit atomicCreate's EEXIST branch, which plan-snapshot.ts
      // treats as an idempotent success (by design) -- not the failure this
      // test needs to exercise.
      const spy = vi.spyOn(planSnapshotModule, "writePlanSnapshot")
        .mockResolvedValueOnce({ status: "unreadable", reason: "simulated write failure" });
      try {
        const ctx = new StageContext(root, sessionDir, makeState(root, ticketId), makeRecipe());
        const result = await stage.report(ctx, { completedAction: "plan_review_round", verdict: "approve", findings: [] });

        expect(result.action).toBe("retry");
        expect(ctx.state.approvedPlanSnapshot).toBeFalsy();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

/**
 * T-494 SITE A: the gate-ack pin, which both PINS a plan and, in plan mode,
 * completes on it. The other two acceptance points live in
 * `plan-pin-guard.test.ts`; this one belongs here because it needs the whole
 * arrangement-plus-ack fixture above.
 */
describe("T-494 site A: the citation guard on the gate-ack pin", () => {
  async function gatedAckFixture(planText: string): Promise<{
    root: string; sessionDir: string; ctx: StageContext; rulingId: string;
  }> {
    const { root, ticketId, arrangementId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const created = await handleRulingCreate(
      {
        text: "Rulings reach agents by citation, not by paste.",
        attribution: "owner-direct",
        date: "2026-09-06",
        scopeTags: [],
        cites: [ticketId],
        clientTaskId: "test-task",
      },
      "json",
      root,
    );
    const rulingId = JSON.parse(created.output).data.id as string;

    const sessionDir = newSessionDirIn(root);
    const planPath = join(sessionDir, "plan.md");
    writeFileSync(planPath, planText.replace("<RULING>", rulingId));
    const hash = sha256Bytes(readFileSync(planPath));
    const pin: GateAckPin = { kind: "plan-hash", sha256: hash };
    const ack: GateAck = {
      id: computeGateAckId(arrangementId, PLAN_ACK_GATE_NAME, ticketId, pin),
      arrangementId,
      gateName: PLAN_ACK_GATE_NAME,
      ackRole: "pen",
      ticketRef: ticketId,
      pin,
      decidedAt: new Date().toISOString(),
      reviewTrail: { present: false },
      contested: false,
    };
    await writeGateAckUnlocked(ack, root);

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
      pendingPlanAck: { ticketId, arrangementId, gateName: PLAN_ACK_GATE_NAME, pinSha256: hash },
    }), makeRecipe());
    return { root, sessionDir, ctx, rulingId };
  }

  it("refuses the pin when the plan omits a cited ruling, consuming no ack", async () => {
    const { sessionDir, ctx, rulingId } = await gatedAckFixture("# Approved plan\n");

    const result = await stage.report(ctx, { completedAction: "check_gate_ack" });

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.instruction).toContain(rulingId);
    // Nothing is written on a refusal. The gate-ack lookup is a read, so the
    // ack is still there to be used once the plan names what it owes, and the
    // hold survives for the same reason.
    expect(ctx.state.approvedPlanSnapshot ?? null).toBeNull();
    expect(ctx.state.pendingPlanAck).not.toBeNull();
    expect(readdirSync(sessionDir).filter((f) => f.startsWith("plan-approved-"))).toHaveLength(0);
  });

  it("pins once the plan names the ruling", async () => {
    const { sessionDir, ctx } = await gatedAckFixture("# Approved plan\n\nPer <RULING>, do the thing.\n");

    const result = await stage.report(ctx, { completedAction: "check_gate_ack" });

    expect(result.action).toBe("advance");
    expect(ctx.state.pendingPlanAck).toBeNull();
    expect(readdirSync(sessionDir).filter((f) => f.startsWith("plan-approved-"))).toHaveLength(1);
  });

  it("refuses, and resets, when plan.md changes while its citations are being checked", async () => {
    // The window T-494 reopens and closes again. The guard awaits -- it loads
    // the ledger and resolves the citation chain -- so the reasoning that
    // originally justified pinning `planRead.bytes` (only a synchronous
    // findGateAck stood between the read and the snapshot) no longer holds.
    // The edit is injected INSIDE the guard, which is exactly the race the
    // re-read exists to catch. Spied at the module rather than through
    // `ctx.loadProject`, because the guard loads the ledger directly and never
    // touches the stage context's loader.
    const { sessionDir, ctx } = await gatedAckFixture("# Approved plan\n\nPer <RULING>.\n");
    const planPath = join(sessionDir, "plan.md");

    const spy = vi
      .spyOn(planPinGuardModule, "guardPlanNamesCitedRulings")
      .mockImplementation(async () => {
        writeFileSync(planPath, "# Approved plan -- EDITED mid-guard\n");
        return { ok: true } as const;
      });

    const result = await stage.report(ctx, { completedAction: "check_gate_ack" });
    spy.mockRestore();

    expect(result.action).toBe("retry");
    if (result.action === "retry") expect(result.instruction).toContain("plan.md changed");
    expect(readdirSync(sessionDir).filter((f) => f.startsWith("plan-approved-"))).toHaveLength(0);
  });
});
