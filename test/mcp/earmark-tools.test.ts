import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleArrangementCreate } from "../../src/cli/commands/arrangement.js";

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => tools.set(name, { config, handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

const RESERVER = "reserver-task-1";
const PEN_TASK = "pen-task-1";

const PARTIES = [
  { role: "pen", client: "claude", identityAnchor: PEN_TASK },
  { role: "worker", client: "claude", identityAnchor: RESERVER },
];

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newProjectWithTicket(): Promise<{ root: string; ticketId: string; arrangementId: string }> {
  const root = await mkdtemp(join(tmpdir(), "mcp-earmark-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  const created = await handleTicketCreate(
    { title: "Earmark ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    root,
  );
  const ticketId = JSON.parse(created.output).data.id as string;
  const arrangement = await handleArrangementCreate(
    { bounds: [ticketId], parties: PARTIES as never, onIrreversibleWork: "hold" },
    "json",
    root,
  );
  const arrangementId = JSON.parse(arrangement.output).data.id as string;
  return { root, ticketId, arrangementId };
}

function writeLiveSession(root: string, sessionId: string, ownerTaskId: string): void {
  const sessDir = join(root, ".story", "sessions", sessionId);
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
    lease: { workspaceId: "test-ws", lastHeartbeat: now, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
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

describe("earmark MCP tools (T-475)", () => {
  it("registers storybloq_earmark_get, _reserve, _assign, and _release", async () => {
    const { root } = await newProjectWithTicket();
    const tools = captureTools(root);
    expect(tools.has("storybloq_earmark_get")).toBe(true);
    expect(tools.has("storybloq_earmark_reserve")).toBe(true);
    expect(tools.has("storybloq_earmark_assign")).toBe(true);
    expect(tools.has("storybloq_earmark_release")).toBe(true);
  });

  it("does NOT register storybloq_earmark_list (earmarks are a field, not a standalone entity)", async () => {
    const { root } = await newProjectWithTicket();
    const tools = captureTools(root);
    expect(tools.has("storybloq_earmark_list")).toBe(false);
  });

  it("get reports no earmark before any reservation", async () => {
    const { root, ticketId } = await newProjectWithTicket();
    const tools = captureTools(root);
    const result = await tools.get("storybloq_earmark_get")!.handler({ ref: ticketId });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("has no earmark");
  });

  it("reserve -> get round-trips through the registered handlers", async () => {
    // MCP write tools always render "md" (runMcpWriteTool pins format to
    // "md"), same convention as gate-ack-tools.test.ts -- assert on the
    // rendered sentence, not a parsed JSON body.
    const { root, ticketId, arrangementId } = await newProjectWithTicket();
    const tools = captureTools(root);
    const reserveResult = await tools.get("storybloq_earmark_reserve")!.handler({
      ref: ticketId,
      role: "worker",
      arrangement: arrangementId,
      clientTaskId: RESERVER,
    });
    expect(reserveResult.isError).toBeFalsy();
    expect(reserveResult.content[0]!.text).toMatch(/Reserved .+: reserved for role worker/);

    const getResult = await tools.get("storybloq_earmark_get")!.handler({ ref: ticketId });
    expect(getResult.content[0]!.text).toMatch(/Earmark on .+: reserved for role worker/);
  });

  it("reserve twice on the same item surfaces a CAS conflict as an MCP error result, not a throw", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithTicket();
    const tools = captureTools(root);
    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: ticketId, role: "worker", arrangement: arrangementId, clientTaskId: RESERVER,
    });
    const second = await tools.get("storybloq_earmark_reserve")!.handler({
      ref: ticketId, role: "pen", arrangement: arrangementId, clientTaskId: PEN_TASK,
    });
    expect(second.isError).toBe(true);
  });

  it("assign converts a reservation to an assignment for a live matching session", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithTicket();
    const tools = captureTools(root);
    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: ticketId, role: "worker", arrangement: arrangementId, clientTaskId: RESERVER,
    });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeLiveSession(root, sessionId, RESERVER);
    const assignResult = await tools.get("storybloq_earmark_assign")!.handler({
      ref: ticketId, to: sessionId, role: "worker", arrangement: arrangementId, clientTaskId: RESERVER,
    });
    expect(assignResult.isError).toBeFalsy();
    expect(assignResult.content[0]!.text).toContain(`assigned to session ${sessionId}`);
  });

  it("release clears an earmark and is idempotent on a second call", async () => {
    const { root, ticketId, arrangementId } = await newProjectWithTicket();
    const tools = captureTools(root);
    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: ticketId, role: "worker", arrangement: arrangementId, clientTaskId: RESERVER,
    });
    const first = await tools.get("storybloq_earmark_release")!.handler({ ref: ticketId, clientTaskId: RESERVER });
    expect(first.isError).toBeFalsy();
    expect(first.content[0]!.text).toContain("Released");
    const second = await tools.get("storybloq_earmark_release")!.handler({ ref: ticketId, clientTaskId: RESERVER });
    expect(second.isError).toBeFalsy();
    const getResult = await tools.get("storybloq_earmark_get")!.handler({ ref: ticketId });
    expect(getResult.content[0]!.text).toContain("has no earmark");
  });
});
