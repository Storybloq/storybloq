import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleEarmarkGet,
  handleEarmarkReserve,
  handleEarmarkAssign,
  handleEarmarkRelease,
} from "../../../src/cli/commands/earmark.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { handleIssueCreate } from "../../../src/cli/commands/issue.js";
import { handleArrangementCreate } from "../../../src/cli/commands/arrangement.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { loadProject } from "../../../src/core/project-loader.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/types.js";

const RESERVER = "reserver-task-1";
const PEN_TASK = "pen-task-1";
const OTHER_TASK = "other-task-1";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProject(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "earmark-cli-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  return { dir };
}

async function createTicket(dir: string): Promise<string> {
  const result = await handleTicketCreate(
    { title: "Earmark ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    dir,
  );
  return JSON.parse(result.output).data.id as string;
}

async function createIssue(dir: string): Promise<string> {
  const result = await handleIssueCreate(
    { title: "Earmark issue", severity: "medium", impact: "test", components: [], relatedTickets: [], location: [] },
    "json",
    dir,
  );
  return JSON.parse(result.output).data.id as string;
}

async function createArrangement(dir: string, bound: string): Promise<string> {
  const result = await handleArrangementCreate(
    {
      bounds: [bound],
      parties: [
        { role: "pen", client: "claude", identityAnchor: PEN_TASK },
        { role: "worker", client: "claude", identityAnchor: RESERVER },
      ],
      onIrreversibleWork: "hold",
    },
    "json",
    dir,
  );
  return JSON.parse(result.output).data.id as string;
}

async function markArrangementConflicted(dir: string, arrangementId: string): Promise<void> {
  const filePath = join(dir, ".story", "arrangements", `${arrangementId}.json`);
  const raw = JSON.parse(await readFile(filePath, "utf-8"));
  writeFileSync(filePath, JSON.stringify({
    ...raw,
    _conflicts: [{ fieldPath: "lifecycle", kind: "field", base: "active", ours: "suspended", theirs: "closed" }],
  }, null, 2));
}

function writeLiveSession(dir: string, sessionId: string, ownerTaskId: string): void {
  const sessDir = join(dir, ".story", "sessions", sessionId);
  mkdirSync(sessDir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1,
    sessionId,
    recipe: "coding",
    state: "PICK_TICKET",
    revision: 1,
    status: "active",
    mode: "auto",
    reviews: { plan: [], code: [] },
    completedTickets: [],
    finalizeCheckpoint: null,
    git: { branch: null, mergeBase: null },
    lease: {
      workspaceId: "test-ws",
      lastHeartbeat: now,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    },
    ownerTask: { client: "claude", id: ownerTaskId, boundAt: now },
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
    guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
  };
  writeFileSync(join(sessDir, "state.json"), JSON.stringify(state, null, 2));
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

async function ctxFor(dir: string): Promise<CommandContext> {
  const { state, warnings } = await loadProject(dir);
  return makeCtx({ state, warnings, root: dir });
}

describe("handleEarmarkGet", () => {
  it("reports no earmark on a fresh ticket", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    const ctx = await ctxFor(dir);
    const result = handleEarmarkGet(ticketId, ctx);
    expect(result.output).toContain("no earmark");
  });

  it("rejects a ref that is neither a ticket nor an issue shape", () => {
    const ctx = makeCtx();
    expect(() => handleEarmarkGet("N-001", ctx)).toThrow(CliValidationError);
  });
});

describe("handleEarmarkReserve", () => {
  it("reserves an open ticket for a role", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    const result = await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    const earmark = JSON.parse(result.output).data.earmark;
    expect(earmark.stage).toBe("reserved");
    expect(earmark.holderRole).toBe("worker");
    expect(earmark.reservedBy).toEqual({ client: "claude", id: RESERVER });
  });

  it("infers the arrangement when exactly one active arrangement covers the item", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    const arrangementId = await createArrangement(dir, ticketId);
    const result = await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    const earmark = JSON.parse(result.output).data.earmark;
    expect(earmark.arrangementId).toBe(arrangementId);
  });

  it("requires --arrangement when more than one active arrangement covers the item", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await createArrangement(dir, ticketId);
    await expect(
      handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("refuses to reserve an already-reserved item, naming the holder (CAS conflict)", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    await expect(
      handleEarmarkReserve({ ref: ticketId, role: "pen", clientTaskId: PEN_TASK }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("requires a resolvable caller identity", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.STORYBLOQ_CLIENT;
    await expect(
      handleEarmarkReserve({ ref: ticketId, role: "worker" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("reserves an issue the same way as a ticket", async () => {
    const { dir } = await newProject();
    const issueId = await createIssue(dir);
    await createArrangement(dir, issueId);
    const result = await handleEarmarkReserve({ ref: issueId, role: "pen", clientTaskId: PEN_TASK }, "json", dir);
    expect(JSON.parse(result.output).data.earmark.stage).toBe("reserved");
  });

  describe("T-478: refuses to trust a conflicted arrangement's authority", () => {
    it("explicit --arrangement naming a conflicted arrangement is refused outright, before the bounds check", async () => {
      const { dir } = await newProject();
      const ticketId = await createTicket(dir);
      const arrangementId = await createArrangement(dir, ticketId);
      await markArrangementConflicted(dir, arrangementId);

      await expect(
        handleEarmarkReserve({ ref: ticketId, role: "worker", arrangement: arrangementId, clientTaskId: RESERVER }, "json", dir),
      ).rejects.toThrow(/unresolved merge conflicts/);
    });

    it("inferred-covering path refuses when ANY arrangement anywhere is conflicted, naming the specific conflicted id(s) (AM2)", async () => {
      const { dir } = await newProject();
      const ticketId = await createTicket(dir);
      await createArrangement(dir, ticketId);

      // A conflicted arrangement covering a DIFFERENT, unrelated ticket --
      // proves the inferred path's blanket refusal scans the FULL list, not
      // just arrangements that (per their own untrusted retained bounds)
      // appear to cover this ticket.
      const otherTicketId = await createTicket(dir);
      const conflictedId = await createArrangement(dir, otherTicketId);
      await markArrangementConflicted(dir, conflictedId);

      await expect(
        handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir),
      ).rejects.toThrow(CliValidationError);
      try {
        await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
        expect.fail("expected handleEarmarkReserve to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CliValidationError);
        expect((err as CliValidationError).message).toContain(conflictedId);
      }
    });

    it("codex round-2: inferred-covering path refuses when the arrangement scan is incomplete (an unreadable arrangement is hidden, not merely conflicted)", async () => {
      const { dir } = await newProject();
      const ticketId = await createTicket(dir);
      await createArrangement(dir, ticketId);

      // An unreadable arrangement file elsewhere in the directory: omitted
      // from `arrangements` entirely (not surfaced as `_conflicts`), so a
      // filter that only walks `arrangements` cannot see it at all -- the
      // exact gap the conflict filter above cannot close by itself.
      writeFileSync(join(dir, ".story", "arrangements", "a-brokenbrokenbrok.json"), "{not json");

      await expect(
        handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir),
      ).rejects.toThrow(/scan incomplete/);
      // Explicitly naming a KNOWN-GOOD arrangement still works -- the
      // incomplete-scan refusal is scoped to the inferred path only.
      const { arrangements } = await (async () => {
        const { loadArrangementsSafe } = await import("../../../src/core/arrangement-loader.js");
        return loadArrangementsSafe(dir);
      })();
      const goodId = arrangements[0]!.id;
      const result = await handleEarmarkReserve({ ref: ticketId, role: "worker", arrangement: goodId, clientTaskId: RESERVER }, "json", dir);
      expect(result.exitCode ?? 0).toBe(0);
    });
  });
});

describe("handleEarmarkRelease", () => {
  it("is a no-op when there is no earmark", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    const result = await handleEarmarkRelease({ ref: ticketId }, "md", dir);
    expect(result.output).toContain("Released");
  });

  it("lets the reserver release their own reservation", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    await handleEarmarkRelease({ ref: ticketId, clientTaskId: RESERVER }, "json", dir);
    const raw = JSON.parse(await readFile(join(dir, ".story", "tickets", `${ticketId}.json`), "utf-8"));
    expect(raw.earmark ?? null).toBeNull();
  });

  it("lets the arrangement's pen party release someone else's reservation", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    await handleEarmarkRelease({ ref: ticketId, clientTaskId: PEN_TASK }, "json", dir);
    const raw = JSON.parse(await readFile(join(dir, ".story", "tickets", `${ticketId}.json`), "utf-8"));
    expect(raw.earmark ?? null).toBeNull();
  });

  it("refuses release from neither the reserver nor a pen party", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    await expect(
      handleEarmarkRelease({ ref: ticketId, clientTaskId: OTHER_TASK }, "json", dir),
    ).rejects.toThrow(CliValidationError);
    const raw = JSON.parse(await readFile(join(dir, ".story", "tickets", `${ticketId}.json`), "utf-8"));
    expect(raw.earmark).toBeTruthy();
  });
});

describe("handleEarmarkAssign", () => {
  it("directly assigns an unearmarked ticket to a live session matching an arrangement party role", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeLiveSession(dir, sessionId, RESERVER);
    const result = await handleEarmarkAssign(
      { ref: ticketId, to: sessionId, role: "worker", clientTaskId: PEN_TASK },
      "json",
      dir,
    );
    const earmark = JSON.parse(result.output).data.earmark;
    expect(earmark.stage).toBe("assigned");
    expect(earmark.holderSession).toBe(sessionId);
  });

  it("converts a reserved earmark to assigned when the caller is the reserver", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    const sessionId = "22222222-2222-4222-8222-222222222222";
    writeLiveSession(dir, sessionId, RESERVER);
    const result = await handleEarmarkAssign(
      { ref: ticketId, to: sessionId, role: "worker", clientTaskId: RESERVER },
      "json",
      dir,
    );
    expect(JSON.parse(result.output).data.earmark.stage).toBe("assigned");
  });

  it("converts a reserved earmark to assigned when the caller is the arrangement's pen party", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    const sessionId = "33333333-3333-4333-8333-333333333333";
    writeLiveSession(dir, sessionId, RESERVER);
    const result = await handleEarmarkAssign(
      { ref: ticketId, to: sessionId, role: "worker", clientTaskId: PEN_TASK },
      "json",
      dir,
    );
    expect(JSON.parse(result.output).data.earmark.stage).toBe("assigned");
  });

  it("refuses a reserved -> assigned conversion from neither the reserver nor the pen party", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await handleEarmarkReserve({ ref: ticketId, role: "worker", clientTaskId: RESERVER }, "json", dir);
    const sessionId = "44444444-4444-4444-8444-444444444444";
    writeLiveSession(dir, sessionId, RESERVER);
    await expect(
      handleEarmarkAssign({ ref: ticketId, to: sessionId, role: "worker", clientTaskId: OTHER_TASK }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("refuses when the target session's identity does not match an arrangement party for the given role", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    const sessionId = "55555555-5555-4555-8555-555555555555";
    writeLiveSession(dir, sessionId, "unrelated-task");
    await expect(
      handleEarmarkAssign({ ref: ticketId, to: sessionId, role: "worker", clientTaskId: PEN_TASK }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("refuses when --to does not resolve to a session at all", async () => {
    const { dir } = await newProject();
    const ticketId = await createTicket(dir);
    await createArrangement(dir, ticketId);
    await expect(
      handleEarmarkAssign(
        { ref: ticketId, to: "00000000-0000-4000-8000-000000000000", role: "worker", clientTaskId: PEN_TASK },
        "json",
        dir,
      ),
    ).rejects.toThrow(CliValidationError);
  });
});
