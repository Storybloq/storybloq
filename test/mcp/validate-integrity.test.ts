import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { toolArgumentNames } from "./tool-schema-helpers.js";

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

describe("storybloq_validate integrity preflight through MCP", () => {
  it("reports all canonical corruption without calling loadProject", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-integrity-"));
    tempDirs.push(root);
    await initProject(root, { name: "integrity" });
    await writeFile(join(root, ".story", "config.json"), "{ bad", "utf8");
    await writeFile(join(root, ".story", "roadmap.json"), "[", "utf8");

    const tool = captureTools(root).get("storybloq_validate");
    if (!tool) throw new Error("storybloq_validate was not registered");
    expect(toolArgumentNames(tool.config.inputSchema)).toContain("integrityOnly");

    const result = await tool.handler({ format: "json" });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBe(true);
    expect(parsed.data).toMatchObject({
      valid: false,
      criticalErrorCount: 2,
    });
    expect(parsed.data.findings).toHaveLength(2);
  });

  it("includes auxiliary JSON only when integrityOnly is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-integrity-"));
    tempDirs.push(root);
    await initProject(root, { name: "integrity" });
    const sessionDir = join(root, ".story", "sessions", "fixture");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "state.json"), "not json", "utf8");

    const tool = captureTools(root).get("storybloq_validate");
    if (!tool) throw new Error("storybloq_validate was not registered");
    const result = await tool.handler({ format: "json", integrityOnly: true });
    const parsed = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBeUndefined();
    expect(parsed.data.findings).toContainEqual(expect.objectContaining({
      file: ".story/sessions/fixture/state.json",
      classification: "auxiliary",
    }));
  });
});
