import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { HIDDEN_LEGACY_TOOLS, WRITE_FAMILIES } from "../../src/core/write-families.js";
import { allowList, restrictTools } from "../../scripts/eval-fault-mcp.js";
import { TOOL_SETS_FILE } from "../../scripts/onboarding-eval-run.js";
import { CONTINUITY_TOOLS_FILE, ONBOARDING_TOOLS_FILE, continuityTools, withheldTools } from "../../scripts/continuity-run.js";

/**
 * 1.20 commit 0 (C-v4.1 amendment 1, pen ruling on evaluation provenance):
 * runs on and after commit 0 use versioned tool lists, a changed tool
 * configuration. The lists earlier T-538 evidence recorded stay byte-unchanged.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

interface Inventory { about: string; degraded: string[]; full: string[]; withheld: Record<string, string>; hidden: Record<string, string> }
const inventory = JSON.parse(readFileSync(TOOL_SETS_FILE, "utf-8")) as Inventory;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "commit0-lists-"));
  dirs.push(root);
  await initProject(root, { name: "lists" });
  return root;
}

/** A server over `root`, optionally behind the evaluation's registration filter. */
async function serve(root: string, restricted: boolean) {
  const withheld: string[] = [];
  const restore = restricted ? restrictTools(allowList(TOOL_SETS_FILE).names, (n) => withheld.push(n)) : () => {};
  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  try {
    registerAllTools(server, root);
  } finally {
    restore();
  }
  const client = new Client({ name: "lists-test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  const listed = (await client.listTools()).tools.map((t) => t.name);
  return { client, registered, listed, withheld };
}

describe("evaluation tool lists across 1.20 commit 0", () => {
  it("keeps the lists earlier evidence recorded byte-unchanged", () => {
    expect(sha(join(PKG, "scripts", "continuity-tools.json"))).toBe("efc9bf9d8d55d51a30bb90516b46bc4d143a881a3ff4e407037d05fdf941361f");
    expect(sha(join(PKG, "scripts", "onboarding-eval-tools.json"))).toBe("c535c718fba8b8cf0e537b3d74e62560a1e38934886fba3718232b1cc27a5da3");
  });

  it("points every runner at the versioned lists, which say they are a changed tool configuration", () => {
    const dir = join(PKG, "scripts", "tool-lists", "1.20-commit0");
    expect(TOOL_SETS_FILE).toBe(join(dir, "onboarding-eval-tools.json"));
    expect(ONBOARDING_TOOLS_FILE).toBe(join(dir, "onboarding-eval-tools.json"));
    expect(CONTINUITY_TOOLS_FILE).toBe(join(dir, "continuity-tools.json"));
    const continuity = JSON.parse(readFileSync(CONTINUITY_TOOLS_FILE, "utf-8")) as { about: string };
    for (const about of [inventory.about, continuity.about]) {
      expect(about).toContain("CHANGED TOOL CONFIGURATION");
      expect(about).toContain("not digest-comparable");
    }
    expect(Object.keys(inventory.hidden).sort()).toEqual([...HIDDEN_LEGACY_TOOLS].sort());
    for (const family of WRITE_FAMILIES) expect(inventory.full).toContain(family.name);
    // The continuity list is the full list less nothing but the withheld map, so it equals `full`.
    expect([...continuityTools()].sort()).toEqual([...inventory.full].sort());
    expect(withheldTools()).toEqual(inventory.withheld);
  });

  it("matches the server: full is its advertised list, full plus hidden its registered set", async () => {
    const root = await project();
    const open = await serve(root, false);
    await open.client.close();
    const withheld = Object.keys(inventory.withheld);
    expect([...open.listed].filter((n) => !withheld.includes(n)).sort()).toEqual([...inventory.full].sort());
    const restricted = await serve(root, true);
    await restricted.client.close();
    expect([...restricted.registered].sort()).toEqual([...inventory.full, ...Object.keys(inventory.hidden)].sort());
    expect([...restricted.listed].sort()).toEqual([...inventory.full].sort());
  });

  it("under the evaluation filter, a hidden name is callable and never listed; a name outside every list is refused", async () => {
    const root = await project();
    const s = await serve(root, true);
    try {
      for (const hidden of HIDDEN_LEGACY_TOOLS) expect(s.listed).not.toContain(hidden);
      const viaHidden = await s.client.callTool({ name: "storybloq_term_add", arguments: { id: "term-a", term: "alpha", definition: "The first." } });
      expect(viaHidden.isError, JSON.stringify(viaHidden.content)).not.toBe(true);
      const viaFamily = await s.client.callTool({ name: "storybloq_term_write", arguments: { action: "add", id: "term-b", term: "beta", definition: "The second." } });
      expect(viaFamily.isError, JSON.stringify(viaFamily.content)).not.toBe(true);
      const outside = await s.client.callTool({ name: "storybloq_export", arguments: { all: true } })
        .then((r) => ({ isError: r.isError === true, text: JSON.stringify(r.content) }), (e: unknown) => ({ isError: true, text: String(e) }));
      expect(outside.isError).toBe(true);
      expect(outside.text).toContain("storybloq_export");
      expect([...s.withheld].sort()).toEqual(Object.keys(inventory.withheld).sort());
    } finally {
      await s.client.close();
    }
  });
});
