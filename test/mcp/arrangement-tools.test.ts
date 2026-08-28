import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
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

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PARTIES = [
  { role: "pen", client: "claude", identityAnchor: "pen-session" },
  { role: "worker", client: "claude", identityAnchor: "worker-session" },
];

describe("arrangement MCP tools (T-473, amendment A3)", () => {
  it("registers storybloq_arrangement_get, _create, and _update", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    expect(tools.has("storybloq_arrangement_get")).toBe(true);
    expect(tools.has("storybloq_arrangement_create")).toBe(true);
    expect(tools.has("storybloq_arrangement_update")).toBe(true);
  });

  it("does NOT register storybloq_arrangement_list (amendment A3: status covers discovery)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    expect(tools.has("storybloq_arrangement_list")).toBe(false);
  });

  it("create -> get -> update round-trips through the registered handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const tools = captureTools(root);

    const createResult = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: ["T-001"],
      parties: PARTIES,
      onIrreversibleWork: "hold",
    });
    expect(createResult.isError).toBeFalsy();
    // MCP write tools always render "md" (runMcpWriteTool pins format to
    // "md"), so the id is extracted from the sentence, not parsed as JSON.
    const createdMatch = createResult.content[0]!.text.match(/Created arrangement (a-[0-9a-z]+)\./);
    expect(createdMatch).not.toBeNull();
    const id = createdMatch![1]!;

    const getResult = await tools.get("storybloq_arrangement_get")!.handler({ id });
    expect(getResult.isError).toBeFalsy();
    expect(getResult.content[0]!.text).toContain(id);

    const updateResult = await tools.get("storybloq_arrangement_update")!.handler({ id, lifecycle: "closed" });
    expect(updateResult.isError).toBeFalsy();
    expect(updateResult.content[0]!.text).toContain("[closed]");
  });

  it("create rejects a party topology that is not exactly one pen and one worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-arrangement-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    await handleTicketCreate(
      { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "md",
      root,
    );
    const tools = captureTools(root);
    const result = await tools.get("storybloq_arrangement_create")!.handler({
      bounds: ["T-001"],
      parties: [
        { role: "worker", client: "claude", identityAnchor: "a" },
        { role: "worker", client: "claude", identityAnchor: "b" },
      ],
      onIrreversibleWork: "hold",
    });
    expect(result.isError).toBe(true);
  });
});
