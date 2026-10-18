/**
 * ISS-1278, end to end against the BUILT bundle (`npm run build` first): each
 * registration form starts the right server, proven by a real initialize
 * exchange, and `--mcp` as another flag's value runs the command instead.
 *
 * Every server is spawned as its own process group (the board server is a
 * grandchild), and is stopped by group signals with a bounded wait.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { E2ECliFixture, CLI_PATH } from "../helpers/e2e-cli.js";
import { initProject } from "../../src/core/init.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: E2ECliFixture;
let project: string;
const groups = new Set<number>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}

async function goneWithin(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
  return true;
}

/** SIGTERM to the group, then SIGKILL, each waited for up to 3 s. Throws if it survives. */
async function stopGroup(pgid: number): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!groupAlive(pgid)) break;
    try {
      process.kill(-pgid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    if (await goneWithin(pgid, 3_000)) break;
  }
  if (groupAlive(pgid)) throw new Error(`server group ${pgid} survived SIGKILL`);
  groups.delete(pgid);
}

beforeAll(async () => {
  fixture = await E2ECliFixture.create();
  project = join(fixture.root, "project");
  await mkdir(project);
  await initProject(project, { name: "iss1278" });
});

afterAll(async () => {
  const survivors: number[] = [];
  for (const pgid of groups) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ }
    if (!(await goneWithin(pgid, 3_000))) survivors.push(pgid);
  }
  await fixture.cleanup();
  if (survivors.length > 0) throw new Error(`server groups survived: ${survivors.join(", ")}`);
});

interface Exchange {
  readonly serverName: string | undefined;
  readonly stderr: string;
}

/** Spawns the CLI with `args`, sends one initialize request and returns the server's name. */
async function initializeExchange(args: string[], env: Record<string, string> = {}): Promise<Exchange> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd: project,
    env: fixture.env(env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const pgid = child.pid as number;
  groups.add(pgid);
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const serverName = await new Promise<string | undefined>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error(`no initialize response within 20 s; stderr:\n${stderr}`)), 20_000);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`exited ${code} before answering; stderr:\n${stderr}`)); });
      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          let message: { id?: number; result?: { serverInfo?: { name?: string } } };
          try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) {
            clearTimeout(timer);
            resolve(message.result?.serverInfo?.name);
          }
        }
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "iss1278", version: "1" } },
      })}\n`);
    });
    return { serverName, stderr };
  } finally {
    child.stdin.end();
    await stopGroup(pgid);
  }
}

describe("ISS-1278: the entry mode end to end", () => {
  it("storybloq --mcp starts the MCP server", async () => {
    expect((await initializeExchange(["--mcp"])).serverName).toBe("storybloq");
  });

  it("the Codex registration form starts the MCP server", async () => {
    expect((await initializeExchange(["--mcp"], { STORYBLOQ_CLIENT: "codex" })).serverName).toBe("storybloq");
  });

  it("storybloq --board-mcp starts the board server", async () => {
    expect((await initializeExchange(["--board-mcp"])).serverName).toBe("Storybloq board");
  });

  it("an allowlisted prefix still starts the MCP server, with a deprecation line", async () => {
    const result = await initializeExchange(["--version", "--mcp"]);
    expect(result.serverName).toBe("storybloq");
    expect(result.stderr).toContain("storybloq: put --mcp first; the arguments before it (--version) are deprecated");
  });

  it("the first selector wins: --mcp --board-mcp starts the MCP server", async () => {
    expect((await initializeExchange(["--mcp", "--board-mcp"])).serverName).toBe("storybloq");
  });

  it("--mcp as another flag's value runs the command", () => {
    const result = spawnSync(process.execPath, [CLI_PATH, "note", "create", "--content", "--mcp"], {
      cwd: project,
      env: fixture.env(),
      input: "",
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain("MCP server running");
    // The CLI's own answer, probed on the sniff-free entry: yargs refuses the
    // flag, and no note is written.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown argument: mcp");
    expect(readdirSync(join(project, ".story", "notes")).filter((n) => n.endsWith(".json"))).toEqual([]);
  });
});
