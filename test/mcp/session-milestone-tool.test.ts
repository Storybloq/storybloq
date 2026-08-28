import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { readBoundedNoFollow } from "../../src/presence/io.js";
import { presenceFileBase, MAX_RECORD_BYTES } from "../../src/presence/types.js";
import { parsePresenceRecord } from "../../src/presence/record.js";

/**
 * T-477 section 3: `storybloq_session_milestone`, end to end through the
 * (captured) real MCP registration -- the same real Zod schemas
 * `registerAllTools` builds, not a hand-rolled stand-in.
 */

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
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

async function newProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcp-session-milestone-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  return root;
}

describe("storybloq_session_milestone MCP tool", () => {
  it("is registered on a full project", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    expect(tools.has("storybloq_session_milestone")).toBe(true);
  });

  it("writes a milestone through the real handler and returns ok:true", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    const tool = tools.get("storybloq_session_milestone")!;
    const result = await tool.handler({ kind: "implementing", note: "wiring the milestone tool", clientTaskId: "mcp-sess-1" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe("implementing");

    const dir = join(root, ".story", "telemetry", "presence");
    const text = readBoundedNoFollow(join(dir, `${presenceFileBase("mcp-sess-1")}.json`), MAX_RECORD_BYTES)!;
    const record = parsePresenceRecord(text, "mcp-sess-1")!;
    expect(record.milestone).toEqual({ kind: "implementing", at: parsed.at, note: "wiring the milestone tool" });
  });

  it("rejects an unknown kind at the schema boundary, without reaching the write path", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    const tool = tools.get("storybloq_session_milestone")!;
    const result = await tool.handler({ kind: "sleeping", clientTaskId: "mcp-sess-2" });
    expect(result.isError).toBe(true);
  });

  it("reports the identity-unresolved error verbatim when clientTaskId is omitted and no environment identity is set", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    const tool = tools.get("storybloq_session_milestone")!;
    const result = await tool.handler({ kind: "implementing" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe("identity-unresolved");
    expect(result.isError).toBe(true);
  });

  it("requires gateName for kind=gate-hold at the schema boundary", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    const tool = tools.get("storybloq_session_milestone")!;
    const missing = await tool.handler({ kind: "gate-hold", clientTaskId: "mcp-sess-3" });
    expect(missing.isError).toBe(true);

    const withGate = await tool.handler({ kind: "gate-hold", gateName: "CODE_REVIEW", clientTaskId: "mcp-sess-3" });
    expect(withGate.isError).toBeUndefined();
    const parsed = JSON.parse(withGate.content[0].text);
    expect(parsed.ok).toBe(true);
  });
});
