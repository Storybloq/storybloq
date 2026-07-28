/**
 * ISS-739 (GitHub #13): the storybloq_issue_list MCP tool must declare a
 * phase arg, forward it to handleIssueList, and answer unknown phases with an
 * informational not_found (mirroring storybloq_ticket_list). These tests
 * invoke the REAL registered handler closure, captured via a mock server the
 * way test/mcp/report-findings-schema.test.ts captures schemas, so a
 * forgotten args.phase pass-through at the registration site fails here
 * (direct handler calls in integration.test.ts bypass that layer).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAllTools } from "../../src/mcp/tools.js";
import { toolArgumentNames } from "./tool-schema-helpers.js";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "valid", "basic");

interface RegisteredTool {
  config: { inputSchema: unknown };
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
    ) => {
      tools.set(name, { config, handler });
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

describe("storybloq_issue_list phase filter through the registered tool (ISS-739)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // The basic fixture ships ISS-002 in phase "alpha" and ISS-001 unphased.
  async function setupProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "iss739-"));
    tmpDirs.push(dir);
    await cp(FIXTURES_DIR, join(dir, ".story"), { recursive: true });
    return dir;
  }

  function issueListTool(root: string): RegisteredTool {
    const tool = captureTools(root).get("storybloq_issue_list");
    if (!tool) throw new Error("storybloq_issue_list was not registered");
    return tool;
  }

  it("declares phase in the inputSchema", async () => {
    const root = await setupProject();
    expect(toolArgumentNames(issueListTool(root).config.inputSchema)).toContain("phase");
  });

  it("forwards phase to the handler: only issues in that phase come back", async () => {
    const root = await setupProject();
    const result = await issueListTool(root).handler({ phase: "alpha" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("ISS-002");
    expect(text).not.toContain("ISS-001");
  });

  it("unknown phase answers informational not_found, not isError (ticket_list parity)", async () => {
    const root = await setupProject();
    const result = await issueListTool(root).handler({ phase: "bogus" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Phase "bogus" not found in roadmap');
  });

  it("no phase arg still returns all active issues", async () => {
    const root = await setupProject();
    const result = await issueListTool(root).handler({});
    const text = result.content[0].text;
    expect(text).toContain("ISS-001");
    expect(text).toContain("ISS-002");
  });
});
