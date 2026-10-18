import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { toolSchema } from "./tool-schema-helpers.js";

/**
 * ISS-1286 through the registered MCP tools: a catalog refusal is an error
 * result, and it leaves the catalog and every durable ledger file unchanged.
 * MCP liveness telemetry under `.story/sessions` is a documented exception:
 * every MCP call may touch it, so the comparison leaves that directory out.
 */

interface RegisteredTool {
  config: { inputSchema?: unknown };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

/**
 * Arguments pass through the tool's declared (strict) schema before the
 * handler, as the SDK does, so a parameter missing from the schema fails here.
 */
function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, config: RegisteredTool["config"], handler: RegisteredTool["handler"]) =>
      tools.set(name, { config, handler: (args) => handler(toolSchema(config.inputSchema).parse(args) as Record<string, unknown>) }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcp-catalog-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "thing.ts"), "export const a = 1;\n");
  // A capability add stamps its checkpoint at HEAD, so the project needs a
  // commit. Standalone temp repo only (ISS-1220).
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

/** Every durable byte under `.story/`: everything except the session telemetry directory. */
function durableBytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = join(rel, entry.name);
      if (next === join(".story", "sessions")) continue;
      if (entry.isDirectory()) walk(next);
      else out[next] = readFileSync(join(root, next), "utf-8");
    }
  };
  walk(".story");
  return out;
}

function catalogPath(root: string): string {
  return join(root, ".story", "capabilities.json");
}

const CAP = {
  id: "cap-thing",
  name: "The thing",
  summary: "Does the thing.",
  entryPoints: ["src/thing.ts"],
  contract: "Returns the thing.",
};

/** The registered add, then the stored file rewritten compact so a rewrite would show. */
async function compactInventory(tools: Map<string, RegisteredTool>, root: string): Promise<void> {
  const added = await tools.get("storybloq_capability_add")!.handler({ ...CAP });
  expect(added.isError).toBeFalsy();
  writeFileSync(catalogPath(root), JSON.stringify(JSON.parse(readFileSync(catalogPath(root), "utf-8"))));
}

function writeLiveSession(root: string, sessionId: string): void {
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
    ownerTask: { client: "claude", id: "owner-task-1", boundAt: now },
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

describe("catalog refusals through the registered MCP tools (ISS-1286)", () => {
  it("capability_update of a missing id is an error and creates no inventory file", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    const before = durableBytes(root);
    const res = await tools.get("storybloq_capability_update")!.handler({ id: "cap-nope", summary: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("not found");
    expect(existsSync(catalogPath(root))).toBe(false);
    expect(durableBytes(root)).toEqual(before);
  });

  it("capability_add of a duplicate id is an error and leaves the inventory unchanged", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    await compactInventory(tools, root);
    const before = durableBytes(root);
    const res = await tools.get("storybloq_capability_add")!.handler({ ...CAP, name: "Another name" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("already exists");
    expect(durableBytes(root)).toEqual(before);
  });

  it("with an active session, a refusal leaves the catalog and ledger files unchanged while telemetry may move", async () => {
    const root = await newProject();
    writeLiveSession(root, "11111111-1111-4111-8111-111111111111");
    const tools = captureTools(root);
    await compactInventory(tools, root);
    const before = durableBytes(root);
    const catalogBefore = readFileSync(catalogPath(root), "utf-8");
    const res = await tools.get("storybloq_capability_update")!.handler({ id: "cap-nope", summary: "x" });
    expect(res.isError).toBe(true);
    expect(readFileSync(catalogPath(root), "utf-8")).toBe(catalogBefore);
    expect(durableBytes(root)).toEqual(before);
  });

  it("a successful write is still a success", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    const res = await tools.get("storybloq_capability_add")!.handler({ ...CAP });
    expect(res.isError).toBeFalsy();
    const upd = await tools.get("storybloq_capability_update")!.handler({ id: "cap-thing", summary: "Rewritten." });
    expect(upd.isError).toBeFalsy();
    expect(JSON.parse(readFileSync(catalogPath(root), "utf-8")).capabilities[0].summary).toBe("Rewritten.");
  });
});

describe("capability surfaces through the registered MCP tools (ISS-1301)", () => {
  it("an unknown surface is an error and leaves the inventory unchanged", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    await compactInventory(tools, root);
    const before = durableBytes(root);
    const res = await tools.get("storybloq_capability_update")!.handler({ id: "cap-thing", mcp: ["ruling_list"] });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("no such MCP tool in storybloq reference: ruling_list");
    expect(durableBytes(root)).toEqual(before);
  });

  it("skipCheck writes an unlisted name through MCP", async () => {
    const root = await newProject();
    const tools = captureTools(root);
    const res = await tools.get("storybloq_capability_add")!.handler({ ...CAP, cli: ["ruling"], skipCheck: true });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(readFileSync(catalogPath(root), "utf-8")).capabilities[0].surfaces.cli).toEqual(["ruling"]);
  });
});
