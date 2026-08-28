import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";

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

describe("ruling MCP tools (T-476)", () => {
  it("registers storybloq_ruling_get, _list, _create, and _supersede", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    expect(tools.has("storybloq_ruling_get")).toBe(true);
    expect(tools.has("storybloq_ruling_list")).toBe(true);
    expect(tools.has("storybloq_ruling_create")).toBe(true);
    expect(tools.has("storybloq_ruling_supersede")).toBe(true);
  });

  it("create -> get round-trips through the registered handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);

    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "Owner rules: duet mode is the name.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    expect(createResult.isError).toBeFalsy();
    // MCP write tools always render "md" (runMcpWriteTool pins format to
    // "md"), so the id is extracted from the sentence, not parsed as JSON.
    const createdMatch = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./);
    expect(createdMatch).not.toBeNull();
    const id = createdMatch![1]!;

    const getResult = await tools.get("storybloq_ruling_get")!.handler({ id });
    expect(getResult.isError).toBeFalsy();
    expect(getResult.content[0]!.text).toContain(id);
    expect(getResult.content[0]!.text).toContain("Owner rules: duet mode is the name.");
    // The anti-laundering caveat renders unconditionally.
    expect(getResult.content[0]!.text).toContain("not verified by storybloq");
  });

  it("create rejects an unknown attribution value", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const result = await tools.get("storybloq_ruling_create")!.handler({
      text: "text",
      attribution: "owner-implied",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    expect(result.isError).toBe(true);
  });

  it("list surfaces created rulings", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "First ruling.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    const id = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;
    const listResult = await tools.get("storybloq_ruling_list")!.handler({});
    expect(listResult.isError).toBeFalsy();
    expect(listResult.content[0]!.text).toContain(id);
  });

  it("supersede create-and-supersede mode links the new ruling to the old one", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "Old ruling.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    const oldId = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const supersedeResult = await tools.get("storybloq_ruling_supersede")!.handler({
      id: oldId,
      text: "New ruling.",
      attribution: "manager-delegated",
      date: "2026-08-28",
      clientTaskId: "mcp-test-session",
    });
    expect(supersedeResult.isError).toBeFalsy();
    expect(supersedeResult.content[0]!.text).toContain(`now supersedes ${oldId}`);
  });

  it("storybloq_ticket_create/_update wire citesRuling and clearCitesRulings (section 10)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);

    const rulingResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "cited by a ticket", attribution: "owner-direct", date: "2026-08-27", clientTaskId: "mcp-test-session",
    });
    const rulingId = rulingResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const createResult = await tools.get("storybloq_ticket_create")!.handler({
      title: "t", type: "task", citesRuling: [rulingId],
    });
    expect(createResult.isError).toBeFalsy();
    const ticketId = createResult.content[0]!.text.match(/Created ticket (T-\d+)/)![1]!;

    const getResult = await tools.get("storybloq_ticket_get")!.handler({ id: ticketId });
    expect(getResult.content[0]!.text).toContain("cited by a ticket");

    const clearResult = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, clearCitesRulings: true,
    });
    expect(clearResult.isError).toBeFalsy();
    const afterClear = await tools.get("storybloq_ticket_get")!.handler({ id: ticketId });
    expect(afterClear.content[0]!.text).not.toContain("cited by a ticket");

    const conflict = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, citesRuling: [rulingId], clearCitesRulings: true,
    });
    expect(conflict.isError).toBe(true);

    // Boundary cases the CLI has no equivalent path for: an empty array must
    // not become a silent, clearCitesRulings-free way to clear (or to sneak
    // past the mutex check by being "technically empty").
    const emptyPlusClear = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, citesRuling: [], clearCitesRulings: true,
    });
    expect(emptyPlusClear.isError).toBe(true);

    const emptyAlone = await tools.get("storybloq_ticket_update")!.handler({
      id: ticketId, citesRuling: [],
    });
    expect(emptyAlone.isError).toBe(true);
  });

  it("supersede refuses `with` combined with create-only fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const a = (await tools.get("storybloq_ruling_create")!.handler({
      text: "a", attribution: "owner-direct", date: "2026-08-27", clientTaskId: "mcp-test-session",
    })).content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;
    const b = (await tools.get("storybloq_ruling_create")!.handler({
      text: "b", attribution: "owner-direct", date: "2026-08-27", clientTaskId: "mcp-test-session",
    })).content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const result = await tools.get("storybloq_ruling_supersede")!.handler({
      id: a, with: b, text: "should not be accepted alongside with", clientTaskId: "mcp-test-session",
    });
    expect(result.isError).toBe(true);
  });

  it("supersede refuses a self-link", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-ruling-"));
    tempDirs.push(root);
    await initProject(root, { name: "test" });
    const tools = captureTools(root);
    const createResult = await tools.get("storybloq_ruling_create")!.handler({
      text: "Only ruling.",
      attribution: "owner-direct",
      date: "2026-08-27",
      clientTaskId: "mcp-test-session",
    });
    const id = createResult.content[0]!.text.match(/Created ruling (r-[0-9a-z]+)\./)![1]!;

    const result = await tools.get("storybloq_ruling_supersede")!.handler({
      id,
      with: id,
      clientTaskId: "mcp-test-session",
    });
    expect(result.isError).toBe(true);
  });
});
