/**
 * ISS-958 5d: crash images built directly. A terminal tail effect is written,
 * then state.json is restored to its preimage bytes, which is what survives a
 * power loss that lost the state write but kept the effect.
 *
 * Reachability: at this head, ordinary writes have no durability barrier, so
 * every image here is exactly as reachable as at base 84f45034 (no reduction
 * is claimed before the writer switch). The tests characterise what each
 * entry point the preimage class permits does with the image.
 *
 *   - COMPACT preimages (TP8, and TP9/TP6/TP7 from COMPACT), with the shutdown
 *     marker: the same owner's resume heals the marker in the owner directory
 *     (legacy and generation-backed layouts; the legacy copy stays beside a
 *     generation); a foreign task is pointed at the candidate flow while the
 *     lease is live; session stop, clear-compact and cancel complete.
 *   - The released ticket (TP9, D5): the four rows of plan 5b's table. The
 *     claim preflight catches the lost claim only for an epoch-bearing session
 *     in a reconciled state whose ticket matches the epoch; every other row is
 *     silent today. Characterisation for the pen's follow-up, no fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/autonomous/git-inspector.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    gitHead: vi.fn().mockResolvedValue({ ok: true, data: { hash: "abc123", branch: "main" } }),
    gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { clean: true, trackedDirty: [], untrackedPaths: [] } }),
    gitMergeBase: vi.fn().mockResolvedValue({ ok: true, data: "abc123" }),
    gitIsAncestor: vi.fn().mockResolvedValue({ ok: true, data: false }),
    gitStash: vi.fn().mockResolvedValue({ ok: true }),
    gitStashPop: vi.fn().mockResolvedValue({ ok: true }),
  };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleAutonomousGuide } from "../../src/autonomous/guide.js";
import { reconcileSessionReality, type ClaimPreflightResult } from "../../src/autonomous/claim-preflight.js";
import { collectProbes } from "../../src/autonomous/health-model.js";
import { newHeartbeatGenerationId, telemetryDirPath, writeShutdownMarker } from "../../src/autonomous/liveness.js";
import { createSession, readSession, writeSessionSync } from "../../src/autonomous/session.js";
import { deriveWorkspaceId, type FullSessionState, type SessionState } from "../../src/autonomous/session-types.js";
import { evaluateSessionGuard } from "../../src/core/session-guard.js";
import { handleSessionClearCompact, handleSessionStop } from "../../src/cli/commands/session-compact.js";
import type { Ticket } from "../../src/models/ticket.js";
import { killSidecarsInRoot } from "./_sidecar-cleanup.js";

const OWNER = { client: "claude" as const, id: "owner-task-958b", boundAt: "2026-10-01T00:00:00.000Z" };
const FOREIGN = "foreign-task-958b";
const ENV_KEYS = ["STORYBLOQ_GLOBAL_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "STORYBLOQ_CLIENT"];
const SINCE = "2026-10-01T00:00:00.000Z";

const roots: string[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const global = mkdtempSync(join(tmpdir(), "iss958-s5b-global-"));
  roots.push(global);
  process.env.STORYBLOQ_GLOBAL_DIR = global;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.STORYBLOQ_CLIENT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (roots.length) {
    const root = roots.pop()!;
    killSidecarsInRoot(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iss958-s5b-")));
  roots.push(root);
  const story = join(root, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers", "sessions"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeFileSync(join(story, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 1, project: "iss958-s5b", type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  writeFileSync(join(story, "roadmap.json"), JSON.stringify({
    title: "iss958", date: "2026-10-04",
    phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "Test" }],
    blockers: [],
  }));
  return root;
}

function writeTicket(root: string, fields: Record<string, unknown>): void {
  writeFileSync(join(root, ".story", "tickets", "T-001.json"), JSON.stringify({
    id: "T-001", title: "Test ticket", type: "task", status: "inprogress",
    phase: "p1", order: 10, description: "", createdDate: "2026-10-01",
    completedDate: null, blockedBy: [], parentTicket: null, ...fields,
  }, null, 2));
}

const ticketOnDisk = (root: string) =>
  JSON.parse(readFileSync(join(root, ".story", "tickets", "T-001.json"), "utf-8")) as Record<string, unknown>;

function plant(root: string, fields: Partial<FullSessionState> & Record<string, unknown>, leaseLive: boolean): { id: string; dir: string } {
  const session = createSession(root, "coding", deriveWorkspaceId(root));
  const dir = join(root, ".story", "sessions", session.sessionId);
  const now = Date.now();
  writeSessionSync(dir, {
    ...session,
    status: "active",
    ownerTask: OWNER,
    git: { branch: "main", mergeBase: "abc123", expectedHead: "abc123", initHead: "abc123", itemBaseHead: "abc123" },
    lease: {
      ...session.lease,
      lastHeartbeat: new Date(leaseLive ? now : now - 2 * 3_600_000).toISOString(),
      expiresAt: new Date(leaseLive ? now + 30 * 60_000 : now - 75 * 60_000).toISOString(),
    },
    ...fields,
  } as FullSessionState);
  return { id: session.sessionId, dir };
}

const compactFields = {
  state: "COMPACT",
  compactPending: true,
  preCompactState: "IMPLEMENT",
  compactPreparedAt: SINCE,
  ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
} as const;

/** The reverted image: the effect stays, state.json goes back to its preimage bytes. */
function revertAfter(dir: string, effect: () => unknown): void {
  const preimage = readFileSync(join(dir, "state.json"));
  try { effect(); } finally { writeFileSync(join(dir, "state.json"), preimage); }
}

async function effectAsync(dir: string, effect: () => Promise<unknown>): Promise<void> {
  const preimage = readFileSync(join(dir, "state.json"));
  try { await effect(); } finally { writeFileSync(join(dir, "state.json"), preimage); }
}

const shutdownIn = (tDir: string) => existsSync(join(tDir, "shutdown"));
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

async function aliveSoon(dir: string): Promise<void> {
  await vi.waitFor(() => {
    const state = readSession(dir) as unknown as Record<string, unknown>;
    expect(collectProbes(dir, Date.now(), state).alive).toBe(true);
  }, { timeout: 5_000, interval: 50 });
}

// ---------------------------------------------------------------------------
// COMPACT preimage with the shutdown marker
// ---------------------------------------------------------------------------

describe("ISS-958 5d: COMPACT preimage beside a shutdown marker", () => {
  it("legacy layout: the owner's resume heals the marker and the owner heartbeats again", async () => {
    const root = project();
    writeTicket(root, {});
    const { id, dir } = plant(root, { ...compactFields }, false);
    revertAfter(dir, () => writeShutdownMarker(dir));
    expect(shutdownIn(telemetryDirPath(dir))).toBe(true);

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id, clientTaskId: OWNER.id });
    expect(result.isError).toBeFalsy();
    const after = readSession(dir)!;
    expect(after.state).toBe("IMPLEMENT");
    expect(after.compactPending).toBe(false);
    expect(shutdownIn(telemetryDirPath(dir))).toBe(false);
    await aliveSoon(dir);
  });

  it("generation-backed layout: the owner's generation is healed and the legacy copy stays", async () => {
    const root = project();
    writeTicket(root, {});
    const generation = newHeartbeatGenerationId();
    const { id, dir } = plant(root, { ...compactFields, heartbeatGeneration: generation }, false);
    const genDir = join(telemetryDirPath(dir), "generations", generation);
    mkdirSync(genDir, { recursive: true });
    revertAfter(dir, () => writeShutdownMarker(dir));
    expect(shutdownIn(genDir)).toBe(true);
    expect(shutdownIn(telemetryDirPath(dir))).toBe(true);

    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id, clientTaskId: OWNER.id });
    expect(result.isError).toBeFalsy();
    expect(shutdownIn(genDir)).toBe(false);
    // The legacy directory holds the displaced owner's leftovers; nothing reads it as the owner.
    expect(shutdownIn(telemetryDirPath(dir))).toBe(true);
    await aliveSoon(dir);
  });

  it("a foreign task on a live lease is pointed at the candidate flow, with or without the marker", async () => {
    const texts: string[] = [];
    for (const withMarker of [true, false]) {
      const root = project();
      writeTicket(root, {});
      const { id, dir } = plant(root, { ...compactFields }, true);
      if (withMarker) revertAfter(dir, () => writeShutdownMarker(dir));
      const before = readSession(dir)!;
      const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id, clientTaskId: FOREIGN });
      expect(result.isError).toBe(true);
      texts.push(textOf(result).replace(id, "<id>"));
      expect(readSession(dir)!.revision).toBe(before.revision);
    }
    expect(texts[0]).toContain("explicit owner-gone-candidate confirmation flow");
    expect(texts[0]).toBe(texts[1]);
  });

  it("the guard verdicts for owner and foreign are the same with and without the marker", () => {
    const cells: Array<Record<string, unknown>> = [];
    for (const withMarker of [true, false]) {
      const root = project();
      writeTicket(root, {});
      const { dir } = plant(root, { ...compactFields }, false);
      if (withMarker) revertAfter(dir, () => writeShutdownMarker(dir));
      cells.push({
        owner: evaluateSessionGuard(root, { clientTaskId: OWNER.id, client: "claude" }).overallAction,
        foreign: evaluateSessionGuard(root, { clientTaskId: FOREIGN, client: "claude" }).overallAction,
      });
    }
    expect(cells[0]).toEqual(cells[1]);
  });

  it("session stop completes on the image", async () => {
    const root = project();
    writeTicket(root, {});
    const { id, dir } = plant(root, { ...compactFields }, false);
    revertAfter(dir, () => writeShutdownMarker(dir));
    await handleSessionStop(root, id);
    const after = readSession(dir)!;
    expect(after.state).toBe("SESSION_END");
    expect(after.status).toBe("completed");
  });

  it("clear-compact repairs the marker on the image and the owner's resume then completes", async () => {
    const root = project();
    writeTicket(root, {});
    const { id, dir } = plant(root, { ...compactFields }, false);
    revertAfter(dir, () => writeShutdownMarker(dir));
    await handleSessionClearCompact(root, id);
    expect(readSession(dir)!.compactPending).toBe(true);
    const result = await handleAutonomousGuide(root, { action: "resume", sessionId: id, clientTaskId: OWNER.id });
    expect(result.isError).toBeFalsy();
    expect(readSession(dir)!.state).toBe("IMPLEMENT");
  });

  it("the owner's cancel completes on the image", async () => {
    const root = project();
    writeTicket(root, {});
    const { id, dir } = plant(root, { ...compactFields }, false);
    revertAfter(dir, () => writeShutdownMarker(dir));
    const result = await handleAutonomousGuide(root, { action: "cancel", sessionId: id, clientTaskId: OWNER.id });
    expect(result.isError).toBeFalsy();
    const after = readSession(dir)!;
    expect(after.state).toBe("SESSION_END");
    expect(after.status).not.toBe("active");
  });
});

// ---------------------------------------------------------------------------
// The released ticket (TP9): plan 5b's four rows
// ---------------------------------------------------------------------------

async function preflight(root: string, dir: string): Promise<ClaimPreflightResult> {
  return reconcileSessionReality(readSession(dir) as unknown as SessionState, {
    loadTicket: async (ticketId) => {
      const p = join(root, ".story", "tickets", `${ticketId}.json`);
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) as Ticket : null;
    },
  });
}

/** Stop releases the ticket, then the SESSION_END write is lost: the reverted image. */
async function releasedImage(
  ticketFields: Record<string, unknown>,
  sessionFields: Record<string, unknown>,
  epochBeforeStop: boolean = false,
): Promise<{ root: string; id: string; dir: string }> {
  const root = project();
  const { id, dir } = plant(root, {
    state: "IMPLEMENT",
    ticket: { id: "T-001", title: "Test ticket", risk: "low", claimed: true },
    ...sessionFields,
  } as Partial<FullSessionState> & Record<string, unknown>, false);
  writeTicket(root, typeof ticketFields.claimedBySession === "function"
    ? { ...ticketFields, claimedBySession: (ticketFields.claimedBySession as (s: string) => string)(id) }
    : ticketFields);
  if (epochBeforeStop) {
    writeSessionSync(dir, { ...readSession(dir)!, claimEpoch: epochFor(dir) } as FullSessionState);
  }
  await effectAsync(dir, () => handleSessionStop(root, id));
  expect(readSession(dir)!.status).toBe("active");
  const ticket = ticketOnDisk(root);
  expect(ticket.status).toBe("open");
  expect("claimedBySession" in ticket).toBe(false);
  expect("claim" in ticket).toBe(false);
  return { root, id, dir };
}

const ownStamp = (id: string) => id;
const epochFor = (dir: string, over: Record<string, unknown> = {}) => ({
  ticketId: "T-001", sessionId: readSession(dir)!.sessionId,
  user: "me@example.com", branch: "story/T-001", since: SINCE, establishedAt: SINCE, ...over,
});

describe("ISS-958 5d: the released ticket beside a reverted active session (TP9, D5)", () => {
  it("row 1, epoch-bearing, reconciled state, ticket matching the epoch: the preflight reports the release and report refuses", async () => {
    const { root, id, dir } = await releasedImage(
      { claimedBySession: ownStamp, claim: { user: "me@example.com", branch: "story/T-001", since: SINCE } },
      {},
      true,
    );
    expect(readSession(dir)!.claimEpoch).toBeTruthy();
    const r = await preflight(root, dir);
    expect(r.checked).toBe(true);
    expect(r.reconciliation).toEqual({
      status: "conflicted",
      detail: { kind: "released", sessionHolder: null, userHolder: null, since: null },
    });

    // The consequence: the owner's report is refused by the claim preflight and
    // the workflow does not advance on the released ticket.
    try {
      const reported = await handleAutonomousGuide(root, {
        action: "report", sessionId: id, clientTaskId: OWNER.id,
        report: { completedAction: "implementation_done" },
      } as never);
      expect(reported.isError).toBe(true);
      expect(textOf(reported)).toContain("Claim lost on T-001");
    } finally {
      killSidecarsInRoot(root);
    }
    const after = readSession(dir)!;
    expect(after.status).toBe("active");
    expect(after.state).toBe("IMPLEMENT");
    const ticket = ticketOnDisk(root);
    expect(ticket.status).toBe("open");
    expect("claimedBySession" in ticket).toBe(false);
    expect("claim" in ticket).toBe(false);
  });

  it("row 2, epochless: not checked, the session drives an open, unclaimed ticket", async () => {
    const { root, dir } = await releasedImage({ claimedBySession: ownStamp }, {});
    const r = await preflight(root, dir);
    expect(r.checked).toBe(false);
    expect(ticketOnDisk(root).status).toBe("open");
  });

  it("row 3, outside the reconciled states, or a ticket not matching the epoch: not checked", async () => {
    const outside = await releasedImage({ claimedBySession: ownStamp }, { state: "HANDOVER" });
    writeSessionSync(outside.dir, { ...readSession(outside.dir)!, claimEpoch: epochFor(outside.dir) } as FullSessionState);
    expect((await preflight(outside.root, outside.dir)).checked).toBe(false);

    const other = await releasedImage({ claimedBySession: ownStamp }, {});
    writeSessionSync(other.dir, { ...readSession(other.dir)!, claimEpoch: epochFor(other.dir, { ticketId: "T-002" }) } as FullSessionState);
    expect((await preflight(other.root, other.dir)).checked).toBe(false);
  });

  it("row 4, legacy claim shapes: released, then caught only through the epoch row they fall in", async () => {
    // Stop releases a ticket that carries no claim material (session-compact.ts
    // :947-954). Epochless, it falls in row 2: silent.
    const legacy = await releasedImage({}, {});
    expect((await preflight(legacy.root, legacy.dir)).checked).toBe(false);

    // A session stamp with no claim block, under the bare epoch that shape
    // mints (no claim key at acquisition), falls in row 1 and is caught.
    const bare = await releasedImage({ claimedBySession: ownStamp }, {});
    writeSessionSync(bare.dir, {
      ...readSession(bare.dir)!,
      claimEpoch: epochFor(bare.dir, { user: null, branch: null, since: null }),
    } as FullSessionState);
    const r = await preflight(bare.root, bare.dir);
    expect(r.checked).toBe(true);
    expect(r.reconciliation?.status).toBe("conflicted");
  });
});
