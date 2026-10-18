/**
 * T-538 S2a: nested_lock refuses a locked handler that takes its own
 * project's lock again. Separate MCP requests in one server process are not
 * nested: each runs in its own request context, so they still queue on the
 * project lock and all complete.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initProject } from "../../src/core/init.js";
import { loadProject, outsideProjectLock, withProjectLock } from "../../src/core/project-loader.js";
import { registerAllTools } from "../../src/mcp/tools.js";

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-mcp-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function serve(): Promise<{ root: string; client: Client }> {
  const root = await mkdtemp(join(tmpdir(), "t538-mcp-"));
  dirs.push(root);
  await initProject(root, { name: "t538" });
  const server = new McpServer({ name: "storybloq-test", version: "0.0.0" });
  registerAllTools(server, root);
  const client = new Client({ name: "t538", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { root, client };
}

const text = (r: unknown) => JSON.stringify((r as { content?: unknown }).content ?? r);

describe("separate MCP requests in one server process", () => {
  it("concurrent writes queue on the project lock and all complete", async () => {
    const { root, client } = await serve();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.callTool({ name: "storybloq_note_create", arguments: { content: `note ${i}` } })),
    );
    for (const r of results) {
      expect(r.isError ?? false).toBe(false);
      expect(text(r)).not.toMatch(/nested_lock/);
    }
    expect((await loadProject(root)).state.notes).toHaveLength(6);
  });

  it("a request made while another holder has the lock waits for it, then completes", async () => {
    const { root, client } = await serve();
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    // The holder stands in for another request or process: its own context, not this one.
    const holder = outsideProjectLock(() => withProjectLock(root, { strict: true }, async () => { holding(); await released; }));
    await held;
    const request = client.callTool({ name: "storybloq_note_create", arguments: { content: "waited" } });
    await new Promise((r) => setTimeout(r, 100));
    expect((await loadProject(root)).state.notes).toHaveLength(0);
    release();
    await holder;
    const result = await request;
    expect(result.isError ?? false).toBe(false);
    expect(text(result)).not.toMatch(/nested_lock/);
    expect((await loadProject(root)).state.notes).toHaveLength(1);
  });
});
