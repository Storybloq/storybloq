import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";

const PARTIES = [
  { role: "pen", client: "claude", identityAnchor: "pen-task-1" },
  { role: "worker", client: "claude", identityAnchor: "worker-task-1" },
];

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>;
}

// Arrangement write tools render markdown ("Created arrangement a-xxx."), not
// JSON -- runMcpWriteTool always calls its handler with format: "md" (T-474
// binding: write tools are terminal-facing, not agent-JSON-facing). Extract
// the id from that text instead of JSON.parse-ing it.
function extractArrangementId(text: string): string {
  const match = /\b(a-[0-9a-z]{16})\b/.exec(text);
  if (!match) throw new Error(`No arrangement id found in: ${text}`);
  return match[1]!;
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

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function createOrchestratorProject(nodes: Record<string, { path: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fed-parity-orch-"));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });
  const nodesConfig: Record<string, Record<string, unknown>> = {};
  for (const [name, node] of Object.entries(nodes)) {
    nodesConfig[name] = { path: node.path, health: "grey", dependsOn: [], stack: "", role: "", summary: "" };
  }
  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: "orchestrator", type: "orchestrator", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      nodes: nodesConfig,
      federation: { allowNodeWrites: true },
    }),
  );
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({
    version: 2, title: "Orchestrator Roadmap", date: "2026-01-01",
    phases: [{ id: "p0", label: "Phase 0", name: "Phase 0", description: "" }], blockers: [],
  }));
  return dir;
}

async function createNodeProject(name: string, phaseId = "p0"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-parity-${name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });
  await writeFile(
    join(storyDir, "config.json"),
    JSON.stringify({
      version: 2, schemaVersion: 2, project: name, type: "npm", language: "typescript",
      features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    }),
  );
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({
    version: 2, title: `${name} Roadmap`, date: "2026-01-01",
    phases: [{ id: phaseId, label: "Phase 0", name: "Phase 0", description: "" }], blockers: [],
  }));
  return dir;
}

async function createTicketOn(root: string, title = "collision test ticket"): Promise<string> {
  const result = await handleTicketCreate(
    { title, type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "json",
    root,
  );
  return (JSON.parse(result.output).data as { id: string }).id;
}

/**
 * A live autonomous-mode session record, written directly into `root`'s own
 * `.story/sessions/` -- the same shape `resolveSessionSelector` expects.
 * Node-scoped `storybloq_earmark_assign` looks up the target session on the
 * ITEM's own board (`itemRoot`, not the orchestrator), so a node-scoped
 * assign test needs this written into the NODE directory.
 */
async function writeLiveSessionOn(root: string, sessionId: string, ownerTaskId: string): Promise<void> {
  const sessDir = join(root, ".story", "sessions", sessionId);
  await mkdir(sessDir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    schemaVersion: 1, sessionId, recipe: "coding", state: "PICK_TICKET", revision: 1,
    status: "active", mode: "auto", reviews: { plan: [], code: [] }, completedTickets: [],
    finalizeCheckpoint: null, git: { branch: null, mergeBase: null },
    lease: { workspaceId: "test-ws", lastHeartbeat: now, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
    ownerTask: { client: "claude", id: ownerTaskId, boundAt: now },
    contextPressure: { level: "low", guideCallCount: 0, ticketsCompleted: 0, compactionCount: 0, eventsLogBytes: 0 },
    pendingProjectMutation: null, resumeFromRevision: null, preCompactState: null, compactPending: false,
    compactPreparedAt: null, resumeBlocked: false, terminationReason: null, waitingForRetry: false,
    lastGuideCall: now, startedAt: now, guideCallCount: 0,
    config: { maxTicketsPerSession: 5, compactThreshold: "high", reviewBackends: ["agent"], handoverInterval: 3 },
  };
  await writeFile(join(sessDir, "state.json"), JSON.stringify(state, null, 2));
}

describe("ISS-1074: omitted-node collision refusal (MCP tools)", () => {
  it("refuses storybloq_ticket_update when the id collides and node is omitted, naming both boards", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ engine: { path: nodeDir } });
    const orchId = await createTicketOn(orchDir);
    const nodeId = await createTicketOn(nodeDir);
    expect(orchId).toBe(nodeId);

    const tools = captureTools(orchDir);
    const result = await tools.get("storybloq_ticket_update")!.handler({ id: orchId, title: "renamed" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(orchId);
    expect(result.content[0]!.text).toContain("engine");
    expect(result.content[0]!.text).toContain("node=");

    // codex round-1: a refused collision must not have mutated EITHER board
    // -- confirm both the orchestrator's and the node's copy still hold their
    // original title, not the rejected write.
    const orchCopy = await tools.get("storybloq_ticket_get")!.handler({ id: orchId });
    expect(orchCopy.content[0]!.text).not.toContain("renamed");
    const nodeCopy = await tools.get("storybloq_ticket_get")!.handler({ id: nodeId, node: "engine" });
    expect(nodeCopy.content[0]!.text).not.toContain("renamed");
  });

  it("succeeds when node= disambiguates a colliding id, writing to the named board", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ engine: { path: nodeDir } });
    const orchId = await createTicketOn(orchDir);
    const nodeId = await createTicketOn(nodeDir);
    expect(orchId).toBe(nodeId);

    const tools = captureTools(orchDir);
    const result = await tools.get("storybloq_ticket_update")!.handler({ id: nodeId, title: "renamed on node", node: "engine" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("Board: engine");

    // codex round-2: the response label alone doesn't prove which board was
    // actually mutated -- a regression that writes the orchestrator ticket
    // while printing "Board: engine" would still pass the assertions above.
    // Read both tickets' own files directly.
    const nodeTicket = JSON.parse(await readFile(join(nodeDir, ".story", "tickets", `${nodeId}.json`), "utf-8"));
    expect(nodeTicket.title).toBe("renamed on node");
    const orchTicket = JSON.parse(await readFile(join(orchDir, ".story", "tickets", `${orchId}.json`), "utf-8"));
    expect(orchTicket.title).not.toBe("renamed on node");
  });

  it("does not refuse a non-colliding id with node omitted (zero added friction)", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ engine: { path: nodeDir } });
    const orchId = await createTicketOn(orchDir);

    const tools = captureTools(orchDir);
    const result = await tools.get("storybloq_ticket_update")!.handler({ id: orchId, title: "renamed" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("Board: the orchestrator board");
  });

  it("refuses as indeterminate when a configured node cannot be loaded, even for a non-colliding id", async () => {
    const orchDir = await createOrchestratorProject({
      broken: { path: join(tmpdir(), "fed-parity-does-not-exist-" + Date.now()) },
    });
    const orchId = await createTicketOn(orchDir);

    const tools = captureTools(orchDir);
    const result = await tools.get("storybloq_ticket_update")!.handler({ id: orchId, title: "renamed" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("broken");
  });

  it("refuses storybloq_issue_update the same way, on the issue-shaped collision", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ engine: { path: nodeDir } });
    const { handleIssueCreate } = await import("../../src/cli/commands/issue.js");
    const orchIssue = await handleIssueCreate({ title: "t", severity: "low", impact: "i", components: [], relatedTickets: [], location: [] }, "json", orchDir);
    const orchIssueId = (JSON.parse(orchIssue.output).data as { id: string }).id;
    const nodeIssue = await handleIssueCreate({ title: "t", severity: "low", impact: "i", components: [], relatedTickets: [], location: [] }, "json", nodeDir);
    const nodeIssueId = (JSON.parse(nodeIssue.output).data as { id: string }).id;
    expect(orchIssueId).toBe(nodeIssueId);

    const tools = captureTools(orchDir);
    const result = await tools.get("storybloq_issue_update")!.handler({ id: orchIssueId, title: "renamed" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("engine");

    // codex round-1: same neither-board-mutated guarantee as the ticket case.
    const orchCopy = await tools.get("storybloq_issue_get")!.handler({ id: orchIssueId });
    expect(orchCopy.content[0]!.text).not.toContain("renamed");
    const nodeCopy = await tools.get("storybloq_issue_get")!.handler({ id: nodeIssueId, node: "engine" });
    expect(nodeCopy.content[0]!.text).not.toContain("renamed");
  });

  it("labels the board on storybloq_ticket_create/issue_create success output on an orchestrator", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ engine: { path: nodeDir } });
    const tools = captureTools(orchDir);

    const created = await tools.get("storybloq_ticket_create")!.handler({ title: "x", type: "task", phase: "p0", node: "engine" });
    expect(created.content[0]!.text).toContain("Board: engine");

    const createdOnOrch = await tools.get("storybloq_ticket_create")!.handler({ title: "y", type: "task", phase: "p0" });
    expect(createdOnOrch.content[0]!.text).toContain("Board: the orchestrator board");

    // codex round-2: this test's own name claims issue_create coverage too,
    // but only ever invoked ticket_create -- issue-create board labeling
    // could regress unnoticed.
    const createdIssue = await tools.get("storybloq_issue_create")!.handler({ title: "x", severity: "low", impact: "i", node: "engine" });
    expect(createdIssue.content[0]!.text).toContain("Board: engine");

    const createdIssueOnOrch = await tools.get("storybloq_issue_create")!.handler({ title: "y", severity: "low", impact: "i" });
    expect(createdIssueOnOrch.content[0]!.text).toContain("Board: the orchestrator board");
  });

  it("adds no board label on a plain (non-orchestrator) project", async () => {
    const nodeDir = await createNodeProject("engine");
    const tools = captureTools(nodeDir);
    const created = await tools.get("storybloq_ticket_create")!.handler({ title: "x", type: "task", phase: "p0" });
    expect(created.content[0]!.text).not.toContain("Board:");
  });
});

describe("ISS-1077: node-qualified arrangement bounds + earmark enforcement (C1-C5)", () => {
  async function setup() {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ engine: { path: nodeDir } });
    const nodeTicketId = await createTicketOn(nodeDir, "node ticket");
    const tools = captureTools(orchDir);
    return { orchDir, nodeDir, nodeTicketId, tools };
  }

  // codex round-1: renamed from "...normalized to canonical form" -- per
  // Amendment A4, a non-team-mode node's ticket has no canonical form to
  // normalize to at all; this test actually proves the bound is preserved
  // verbatim in the item's own (here, display-form) id.
  it("C1: records a node-qualified bound, preserved in the item's own id form", async () => {
    const { nodeTicketId, tools } = await setup();
    const created = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${nodeTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    expect(created.isError).toBeFalsy();
    const arrangementId = extractArrangementId(created.content[0]!.text);
    const got = await tools.get("storybloq_arrangement_get")!.handler({ id: arrangementId });
    expect(got.content[0]!.text).toContain(`Bounds: engine:${nodeTicketId}`);
  });

  it("C4: a node-bounds arrangement authorizes an earmark reservation on that node's item", async () => {
    const { nodeTicketId, tools } = await setup();
    const created = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${nodeTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    expect(created.isError).toBeFalsy();

    const reserved = await tools.get("storybloq_earmark_reserve")!.handler({
      ref: nodeTicketId,
      role: "worker",
      clientTaskId: "worker-task-1",
      node: "engine",
    });
    expect(reserved.isError).toBeFalsy();

    const got = await tools.get("storybloq_earmark_get")!.handler({ ref: nodeTicketId, node: "engine" });
    expect(got.content[0]!.text).toContain("worker-task-1");
  });

  // codex round-1: only `storybloq_earmark_reserve` had a node-scoped
  // MCP-level test above -- assign and release went through the CLI-level
  // handler tests only (test/cli/commands/earmark.test.ts), never through the
  // MCP tool registration + node routing layer itself.
  it("C4: a node-bounds arrangement authorizes an earmark ASSIGN on that node's item, targeting a live session on the node's own board", async () => {
    const { nodeDir, nodeTicketId, tools } = await setup();
    await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${nodeTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    const sessionId = "66666666-6666-4666-8666-666666666666";
    await writeLiveSessionOn(nodeDir, sessionId, "worker-task-1");

    const assigned = await tools.get("storybloq_earmark_assign")!.handler({
      ref: nodeTicketId, to: sessionId, role: "worker", clientTaskId: "pen-task-1", node: "engine",
    });
    expect(assigned.isError).toBeFalsy();

    const got = await tools.get("storybloq_earmark_get")!.handler({ ref: nodeTicketId, node: "engine" });
    expect(got.content[0]!.text).toContain(sessionId);
  });

  it("C4: a node-bounds arrangement authorizes an earmark RELEASE on that node's item", async () => {
    const { nodeTicketId, tools } = await setup();
    await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${nodeTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: nodeTicketId, role: "worker", clientTaskId: "worker-task-1", node: "engine",
    });

    const released = await tools.get("storybloq_earmark_release")!.handler({
      ref: nodeTicketId, clientTaskId: "worker-task-1", node: "engine",
    });
    expect(released.isError).toBeFalsy();

    const got = await tools.get("storybloq_earmark_get")!.handler({ ref: nodeTicketId, node: "engine" });
    expect(got.content[0]!.text).not.toContain("worker-task-1");
  });

  it("C4: a second reservation on the same node item is a CAS conflict, exactly like the local case", async () => {
    const { nodeTicketId, tools } = await setup();
    await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${nodeTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    const first = await tools.get("storybloq_earmark_reserve")!.handler({
      ref: nodeTicketId, role: "worker", clientTaskId: "worker-task-1", node: "engine",
    });
    expect(first.isError).toBeFalsy();

    const second = await tools.get("storybloq_earmark_reserve")!.handler({
      ref: nodeTicketId, role: "pen", clientTaskId: "pen-task-1", node: "engine",
    });
    expect(second.isError).toBe(true);
  });

  it("C4: refuses an earmark reservation on a node item with no covering arrangement", async () => {
    const { nodeTicketId, tools } = await setup();
    const result = await tools.get("storybloq_earmark_reserve")!.handler({
      ref: nodeTicketId, role: "worker", clientTaskId: "worker-task-1", node: "engine",
    });
    expect(result.isError).toBe(true);
  });

  it("C5: closing a node-bounds arrangement retracts the node-side earmark", async () => {
    const { nodeTicketId, tools } = await setup();
    const created = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${nodeTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    const arrangementId = extractArrangementId(created.content[0]!.text);

    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: nodeTicketId, role: "worker", clientTaskId: "worker-task-1", node: "engine",
    });
    const beforeClose = await tools.get("storybloq_earmark_get")!.handler({ ref: nodeTicketId, node: "engine" });
    expect(beforeClose.content[0]!.text).toContain("worker-task-1");

    const closed = await tools.get("storybloq_arrangement_update")!.handler({ id: arrangementId, lifecycle: "closed" });
    expect(closed.isError).toBeFalsy();

    const afterClose = await tools.get("storybloq_earmark_get")!.handler({ ref: nodeTicketId, node: "engine" });
    expect(afterClose.content[0]!.text).not.toContain("worker-task-1");
  });

  it("C5: closing retracts a node earmark even after its SPECIFIC bound id was merge-edited away, as long as the node itself is still referenced (codex round 1: full-scan-by-arrangementId, not id-keyed lookup)", async () => {
    const { orchDir, nodeDir, tools } = await setup();
    const firstTicketId = await createTicketOn(nodeDir, "first node ticket");
    const secondTicketId = await createTicketOn(nodeDir, "second node ticket");
    const created = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${firstTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    const arrangementId = extractArrangementId(created.content[0]!.text);

    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: firstTicketId, role: "worker", clientTaskId: "worker-task-1", node: "engine",
    });
    const beforeClose = await tools.get("storybloq_earmark_get")!.handler({ ref: firstTicketId, node: "engine" });
    expect(beforeClose.content[0]!.text).toContain("worker-task-1");

    // Simulate a merge-driver edit that swapped the arrangement's bound to a
    // DIFFERENT ticket on the SAME node -- the id-keyed lookup this fixed
    // (looking up only `secondTicketId`) would never find `firstTicketId`'s
    // stranded earmark; a full scan of the node's own tickets by
    // arrangementId finds and clears it regardless.
    const { loadArrangementsSafe, writeArrangementUnlocked } = await import("../../src/core/arrangement-loader.js");
    const { arrangements } = loadArrangementsSafe(orchDir);
    const arrangement = arrangements.find((a) => a.id === arrangementId)!;
    await writeArrangementUnlocked({ ...arrangement, bounds: [`engine:${secondTicketId}`] }, orchDir);

    const closed = await tools.get("storybloq_arrangement_update")!.handler({ id: arrangementId, lifecycle: "closed" });
    expect(closed.isError).toBeFalsy();

    const afterClose = await tools.get("storybloq_earmark_get")!.handler({ ref: firstTicketId, node: "engine" });
    expect(afterClose.content[0]!.text).not.toContain("worker-task-1");
  });

  it("C5: refuses to close an arrangement bound to an unresolvable node, leaving the arrangement active and the node's earmark intact", async () => {
    const nodeDir = await createNodeProject("engine");
    const orchDir = await createOrchestratorProject({ engine: { path: nodeDir } });
    const nodeTicketId = await createTicketOn(nodeDir, "node ticket");
    const tools = captureTools(orchDir);

    const created = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine:${nodeTicketId}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    const arrangementId = extractArrangementId(created.content[0]!.text);
    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: nodeTicketId, role: "worker", clientTaskId: "worker-task-1", node: "engine",
    });

    // Break the ORCHESTRATOR's pointer to "engine" (not the node directory
    // itself, which stays intact and inspectable) so resolution fails while
    // the node's own data survives untouched -- codex round-1: the original
    // version deleted nodeDir entirely, which proved the close refused but
    // made "node data untouched" unverifiable since there was no node data
    // left to inspect.
    const configPath = join(orchDir, ".story", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    config.nodes.engine.path = join(tmpdir(), "fed-parity-does-not-exist-" + Date.now());
    await writeFile(configPath, JSON.stringify(config));

    const closed = await tools.get("storybloq_arrangement_update")!.handler({ id: arrangementId, lifecycle: "closed" });
    expect(closed.isError).toBe(true);

    // The arrangement itself must still be active, not partially closed.
    const got = await tools.get("storybloq_arrangement_get")!.handler({ id: arrangementId });
    expect(got.content[0]!.text).toContain("[active]");

    // The node's own data, read directly (bypassing the now-broken
    // orchestrator config), still shows the earmark exactly as placed.
    const nodeTicketRaw = JSON.parse(
      await readFile(join(nodeDir, ".story", "tickets", `${nodeTicketId}.json`), "utf-8"),
    ) as { earmark?: { stage?: string; reservedBy?: { id?: string } } };
    expect(nodeTicketRaw.earmark?.stage).toBe("reserved");
    expect(nodeTicketRaw.earmark?.reservedBy?.id).toBe("worker-task-1");
  });

  it("C5 codex round-2: a multi-root close failing partway leaves the arrangement CLOSED (beforeItems already committed) with only the unreached root's earmark stranded -- releasable via its own stored arrangementId", async () => {
    const node1Dir = await createNodeProject("engine1");
    const node2Dir = await createNodeProject("engine2");
    const orchDir = await createOrchestratorProject({ engine1: { path: node1Dir }, engine2: { path: node2Dir } });
    const ticket1Id = await createTicketOn(node1Dir, "root1 ticket");
    const ticket2Id = await createTicketOn(node2Dir, "root2 ticket");
    const tools = captureTools(orchDir);

    const created = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: [`engine1:${ticket1Id}`, `engine2:${ticket2Id}`],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    const arrangementId = extractArrangementId(created.content[0]!.text);

    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: ticket1Id, role: "worker", clientTaskId: "worker-task-1", node: "engine1",
    });
    await tools.get("storybloq_earmark_reserve")!.handler({
      ref: ticket2Id, role: "worker", clientTaskId: "worker-task-1", node: "engine2",
    });

    // Corrupt root2's own ticket file so its project fails STRICT-MODE
    // loading when the close's item-root loop reaches it -- a real
    // production failure (parse_error), not a mocked lock. Bounds list
    // engine1 before engine2, so root1 is processed first and should already
    // be retracted by the time root2's load throws.
    const ticket2Path = join(node2Dir, ".story", "tickets", `${ticket2Id}.json`);
    const ticket2Original = await readFile(ticket2Path, "utf-8");
    await writeFile(ticket2Path, "{not json");

    const { handleArrangementUpdate } = await import("../../src/cli/commands/arrangement.js");
    await expect(
      handleArrangementUpdate(arrangementId, { lifecycle: "closed" }, "json", orchDir),
    ).rejects.toThrow();

    // The arrangement's own write commits under `beforeItems`, BEFORE the
    // item-root loop -- closed on disk despite the overall call rejecting.
    const { loadArrangementsSafe } = await import("../../src/core/arrangement-loader.js");
    const { arrangements } = loadArrangementsSafe(orchDir);
    const arrangement = arrangements.find((a) => a.id === arrangementId)!;
    expect(arrangement.lifecycle).toBe("closed");

    // Root1 (processed before root2's failure) had its earmark retracted.
    const root1Ticket = JSON.parse(await readFile(join(node1Dir, ".story", "tickets", `${ticket1Id}.json`), "utf-8"));
    expect(root1Ticket.earmark ?? null).toBeNull();

    // Restore root2's ticket file (undoing only the injected file
    // corruption -- the earmark data itself, saved before corrupting, was
    // never touched by the failed close) and confirm it is untouched:
    // stranded, not cleared, since its retraction never ran.
    await writeFile(ticket2Path, ticket2Original);
    const root2TicketBefore = JSON.parse(await readFile(ticket2Path, "utf-8"));
    expect(root2TicketBefore.earmark?.stage).toBe("reserved");
    expect(root2TicketBefore.earmark?.reservedBy?.id).toBe("worker-task-1");

    // Stranded but releasable: the arrangement is closed and its bounds are
    // irrelevant to this check (codex round-2 fix #2) -- the reserver's own
    // identity is enough, with no dependency on the arrangement at all.
    const released = await tools.get("storybloq_earmark_release")!.handler({
      ref: ticket2Id, clientTaskId: "worker-task-1", node: "engine2",
    });
    expect(released.isError).toBeFalsy();
    const root2TicketAfter = JSON.parse(await readFile(ticket2Path, "utf-8"));
    expect(root2TicketAfter.earmark ?? null).toBeNull();
  });
});
