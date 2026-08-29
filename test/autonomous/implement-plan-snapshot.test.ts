/**
 * ISS-1050 full fix: `ImplementStage.enter()`'s plan-source resolution --
 * content-embed from a snapshot when one is on record, D1's never-fail-open
 * on a missing/unreadable snapshot for a gated item, R2-FIX 2's no
 * gate-status branching once a ref is present, and the ungated fallback to a
 * fresh plan.md read (degrading further to the pre-fix pointer instruction
 * only when even that read fails).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StageContext, type ResolvedRecipe } from "../../src/autonomous/stages/types.js";
import { ImplementStage, IMPLEMENT_PROMPT_PLAN_MAX_BYTES } from "../../src/autonomous/stages/implement.js";
import type { FullSessionState } from "../../src/autonomous/session-types.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleArrangementCreate } from "../../src/cli/commands/arrangement.js";
import { writePlanSnapshot } from "../../src/core/plan-snapshot.js";

const PARTIES = [
  { role: "pen" as const, client: "claude" as const, identityAnchor: "pen-session" },
  { role: "worker" as const, client: "claude" as const, identityAnchor: "worker-session" },
];

async function newProjectWithGatedTicket(): Promise<{ root: string; ticketId: string; arrangementId: string }> {
  const root = mkdtempSync(join(tmpdir(), "implement-snapshot-gated-"));
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
  raw.gates = [{ name: "plan-ack", ackRole: "pen" }];
  await writeFile(path, JSON.stringify(raw));
  return { root, ticketId: "T-001", arrangementId };
}

function makeState(root: string, ticketId: string | undefined, overrides: Partial<FullSessionState> = {}): FullSessionState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, sessionId: "00000000-0000-0000-0000-000000001050",
    recipe: "coding", state: "IMPLEMENT", revision: 1, status: "active",
    reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123" },
    lease: { workspaceId: "test", lastHeartbeat: now, expiresAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null,
    compactPending: false, compactPreparedAt: null, resumeBlocked: false,
    terminationReason: null, waitingForRetry: false, lastGuideCall: now, startedAt: now, guideCallCount: 3,
    config: { maxTicketsPerSession: 0, compactThreshold: "high", reviewBackends: ["codex", "agent"] },
    ticket: ticketId ? { id: ticketId, title: "Duet ticket", claimed: true, risk: "low" } : undefined,
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

const stage = new ImplementStage();
const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newSessionDirIn(root: string): string {
  const dir = join(root, ".story", "sessions", "test-session");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("[ISS-1050 full fix] ImplementStage plan-source resolution", () => {
  it("ungated, no snapshot ref, plan.md present: content-embeds the current plan.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "implement-snapshot-ungated-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Ungated ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# Ungated plan\n\nDo the specific thing.\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, "T-001", { frozenGate: { status: "ungated" } }), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("Do the specific thing.");
    expect(result.instruction).not.toContain("Implement the approved plan at");
  });

  it("ungated, no snapshot ref, plan.md missing: degrades to the pointer instruction", async () => {
    const root = mkdtempSync(join(tmpdir(), "implement-snapshot-ungated-nopland-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Ungated ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const sessionDir = newSessionDirIn(root);
    // No plan.md written.

    const ctx = new StageContext(root, sessionDir, makeState(root, "T-001", { frozenGate: { status: "ungated" } }), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("Implement the approved plan at");
  });

  it("gated, valid snapshot ref: content-embeds the SNAPSHOT, not a since-edited plan.md (structural window closure)", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    const approvedText = "# Approved plan\n\nOnly touch file A.\n";
    writeFileSync(join(sessionDir, "plan.md"), approvedText);
    const snapshot = await writePlanSnapshot(sessionDir, Buffer.from(approvedText, "utf-8"));
    if (snapshot.status !== "ok") throw new Error("setup failed");

    // Simulate a post-landing edit to plan.md -- exactly the window this fix closes.
    writeFileSync(join(sessionDir, "plan.md"), "# Approved plan\n\nActually touch file B too.\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
      frozenGate: { status: "gated", arrangementId: "irrelevant", gates: [{ name: "plan-ack", ackRole: "pen" }] },
      approvedPlanSnapshot: snapshot.ref,
    }), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("Only touch file A.");
    expect(result.instruction).not.toContain("Actually touch file B too.");
  });

  it("[D1] gated, no snapshot ref: blocks rather than falling back to plan.md", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# A plan that was never snapshotted\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
      frozenGate: { status: "gated", arrangementId: "irrelevant", gates: [{ name: "plan-ack", ackRole: "pen" }] },
      approvedPlanSnapshot: null,
    }), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("no approved-plan snapshot is on record");
    expect(result.instruction).not.toContain("A plan that was never snapshotted");
  });

  it("[R2-FIX 2] ungated but a snapshot ref IS present and unreadable: blocks, never falls back to plan.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "implement-snapshot-broken-ref-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Ungated ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# A live, readable plan.md that must NOT be used\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, "T-001", {
      frozenGate: { status: "ungated" },
      // A ref pointing at a snapshot file that was never actually written.
      approvedPlanSnapshot: { filename: `plan-approved-${"a".repeat(64)}.md`, sha256: "a".repeat(64) },
    }), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("could not be read");
    expect(result.instruction).not.toContain("A live, readable plan.md that must NOT be used");
  });

  it("unresolved gate status: blocks with the unresolved-hold instruction", async () => {
    const root = mkdtempSync(join(tmpdir(), "implement-snapshot-unresolved-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    mkdirSync(join(root, ".story", "arrangements"), { recursive: true });
    writeFileSync(join(root, ".story", "arrangements", "a-brokenbrokenbrok.json"), "{not json");
    const sessionDir = newSessionDirIn(root);
    writeFileSync(join(sessionDir, "plan.md"), "# Plan\n");

    // frozenGate deliberately left undefined so resolveOrReadFrozenGateStatus scans fresh.
    const ctx = new StageContext(root, sessionDir, makeState(root, "T-001"), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).toContain("could not be resolved");
  });

  it("[R-A4-1] oversize plan, UNGATED with no snapshot ever recorded (unprotected path): degrades to the pointer instruction", async () => {
    const root = mkdtempSync(join(tmpdir(), "implement-snapshot-oversize-ungated-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Ungated ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const sessionDir = newSessionDirIn(root);
    const big = "a".repeat(IMPLEMENT_PROMPT_PLAN_MAX_BYTES + 1);
    writeFileSync(join(sessionDir, "plan.md"), big);

    const ctx = new StageContext(root, sessionDir, makeState(root, "T-001", { frozenGate: { status: "ungated" } }), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).not.toContain(big);
    expect(result.instruction).toContain("Implement the approved plan at");
  });

  it("[R-A4-1] oversize plan, GATED with a valid snapshot ref (protected path): BLOCKS rather than pointing at the mutable plan.md", async () => {
    const { root, ticketId } = await newProjectWithGatedTicket();
    tempDirs.push(root);
    const sessionDir = newSessionDirIn(root);
    const big = "a".repeat(IMPLEMENT_PROMPT_PLAN_MAX_BYTES + 1);
    const snapshot = await writePlanSnapshot(sessionDir, Buffer.from(big, "utf-8"));
    if (snapshot.status !== "ok") throw new Error("setup failed");
    // The mutable plan.md now differs from the snapshot -- exactly the
    // post-advance edit this fix exists to make irrelevant. If the oversize
    // branch ever falls back to pointing at THIS file, the edit reaches the
    // implementing agent regardless of the snapshot mechanism.
    writeFileSync(join(sessionDir, "plan.md"), "# EDITED after landing -- must never be read\n");

    const ctx = new StageContext(root, sessionDir, makeState(root, ticketId, {
      frozenGate: { status: "gated", arrangementId: "irrelevant", gates: [{ name: "plan-ack", ackRole: "pen" }] },
      approvedPlanSnapshot: snapshot.ref,
    }), makeRecipe());
    const result = await stage.enter(ctx);

    expect(result.instruction).not.toContain("EDITED after landing");
    expect(result.instruction).not.toContain("Implement the approved plan at");
    expect(result.instruction).toContain("too large to embed");
    expect(result.instruction).toContain("do not implement from a truncated read");
  });
});
