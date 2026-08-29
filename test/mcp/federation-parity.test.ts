import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";

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
