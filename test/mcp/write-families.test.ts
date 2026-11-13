import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { registeredBoardWriteTools } from "../../src/mcp/board-write-tools.js";
import { HIDDEN_LEGACY_TOOLS, WRITE_FAMILIES, dispatchWriteFamily, familyInputShape, type FamilyMember, type WriteFamily } from "../../src/mcp/tool-profile.js";
import { initProject } from "../../src/core/init.js";
import { handleCheckpointEnable } from "../../src/cli/commands/checkpoint.js";
import { referenceSurfaceNames, unknownSurfaces } from "../../src/core/capability.js";
import { MCP_TOOLS } from "../../src/cli/commands/reference.js";

/**
 * 1.20 commit 0 (ISS-1433/1435 plan v4.1 section 9.3, amendment 1): five write
 * families are listed in place of eighteen write tools. The eighteen stay
 * registered and callable; a family action runs the former tool's own strict
 * schema and its own handler, so the two names give the same result.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BEFORE = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "tool-names-before-commit0.json"), "utf-8"),
) as { names: string[] };
const SKILL_BEFORE = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "skill-tool-names-before-commit0.json"), "utf-8"),
) as { names: string[] };
const skillDir = join(here, "..", "..", "src", "skill");

/** Every skill markdown file, by path relative to src/skill. */
function skillFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(skillDir, rel), { withFileTypes: true })) {
      const next = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".md")) out.push({ path: next, text: readFileSync(join(skillDir, next), "utf-8") });
    }
  };
  walk("");
  return out;
}

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A committed project with fixed git dates, so two of them are byte-identical. Standalone temp repo (ISS-1220). */
async function newProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcp-families-"));
  tempDirs.push(root);
  await initProject(root, { name: "fixture" });
  // C-v4.1 2.1: init mints a random board id; a fixed one keeps the two projects byte-identical.
  const configPath = join(root, ".story", "config.json");
  writeFileSync(configPath, readFileSync(configPath, "utf-8").replace(/"boardId": "b-[0-9a-z]{16}"/, '"boardId": "b-0000000000000000"'));
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf-8", env });
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

interface Connected {
  root: string;
  server: McpServer;
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

async function connect(root: string): Promise<Connected> {
  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  registerAllTools(server, root);
  const client = new Client({ name: "families-test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    root,
    server,
    client,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as Array<{ text?: string }>;
      return { text: content.map((p) => p.text ?? "").join("\n"), isError: result.isError === true };
    },
  };
}

/** The SDK's own record of a registered tool. */
function sdkTool(server: McpServer, name: string): { handler: unknown } | undefined {
  return (server as unknown as { _registeredTools: Record<string, { handler: unknown }> })._registeredTools[name];
}

/** Every ledger byte except the per-call liveness touch, keyed by path. */
function ledger(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = join(rel, entry.name);
      if (/^\.story[\\/]sessions[\\/][^\\/]+[\\/]telemetry[\\/]lastMcpCall$/.test(next)) continue;
      if (entry.isDirectory()) walk(next);
      else out[next] = readFileSync(join(root, next), "utf-8");
    }
  };
  walk(".story");
  return out;
}

/** Inlines every `#/...` JSON pointer $ref against the listed input schema. */
function deref(node: unknown, root: unknown, depth = 0): unknown {
  if (depth > 32 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => deref(n, root, depth + 1));
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) target = (target as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    // A shared node keeps its own description; the referring one has none.
    const { description: _d, ...shared } = deref(target, root, depth + 1) as Record<string, unknown>;
    return shared;
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, root, depth + 1)]));
}

const familyOf = (legacy: string) => WRITE_FAMILIES.find((f) => legacy.startsWith(f.prefix) && f.actions.includes(legacy.slice(f.prefix.length)))!;

/**
 * Calls `legacy` on one project and its family action on an identical twin,
 * with the clock fixed, and returns both replies and ledgers with each
 * project's path replaced.
 */
async function twin(legacy: string, args: Record<string, unknown>, setup?: (c: Connected) => Promise<void>) {
  const family = familyOf(legacy);
  const action = legacy.slice(family.prefix.length);
  const out: Array<{ text: string; isError: boolean; ledger: Record<string, string> }> = [];
  for (const [name, callArgs] of [[legacy, args], [family.name, { action, ...args }]] as const) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-02T02:02:02.000Z"));
    const root = await newProject();
    const conn = await connect(root);
    if (setup) await setup(conn);
    const reply = await conn.call(name, callArgs);
    await conn.client.close();
    vi.useRealTimers();
    const norm = (s: string) => s.split(root).join("<root>");
    const files = Object.fromEntries(Object.entries(ledger(root)).map(([k, v]) => [k, norm(v)]));
    out.push({ text: norm(reply.text), isError: reply.isError, ledger: files });
  }
  return { legacy: out[0]!, family: out[1]! };
}

describe("write families (1.20 commit 0)", () => {
  let conn: Connected;
  beforeEach(async () => {
    conn = await connect(await newProject());
  });
  afterEach(async () => {
    await conn.client.close();
  });

  it("lists the five families and none of the eighteen former names", async () => {
    const { tools } = await conn.client.listTools();
    const names = tools.map((t) => t.name);
    expect(HIDDEN_LEGACY_TOOLS.size).toBe(18);
    for (const family of WRITE_FAMILIES) expect(names).toContain(family.name);
    for (const hidden of HIDDEN_LEGACY_TOOLS) expect(names).not.toContain(hidden);
  });

  it("keeps every former name registered, with the very handler its family dispatches to", () => {
    const members = registeredBoardWriteTools(conn.server);
    for (const hidden of HIDDEN_LEGACY_TOOLS) {
      const sdk = sdkTool(conn.server, hidden);
      expect(sdk, `${hidden} is registered`).toBeDefined();
      expect(sdk!.handler, `${hidden}: the family dispatches to the registered handler, not a copy`).toBe(members.get(hidden)!.handler);
    }
  });

  it("names every former tool in its family description, so a 1.19 caller finds its tool", async () => {
    const { tools } = await conn.client.listTools();
    const listed = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    for (const name of BEFORE.names) {
      if (listed.has(name)) continue;
      expect(HIDDEN_LEGACY_TOOLS.has(name), `${name} was listed before commit 0 and is neither listed nor hidden`).toBe(true);
      const family = familyOf(name);
      const text = listed.get(family.name)!;
      expect(text).toContain(`the former ${family.prefix}<action> names still work`);
      expect(text).toContain(`${name.slice(family.prefix.length)}: `);
    }
  });

  it("serves every tool the skill before commit 0 names: listed, or hidden and named in its family description", async () => {
    const { tools } = await conn.client.listTools();
    const listed = new Map(tools.map((t) => [t.name, t.description ?? ""]));
    expect(SKILL_BEFORE.names.length).toBeGreaterThan(0);
    for (const name of SKILL_BEFORE.names) {
      if (listed.has(name)) continue;
      expect(HIDDEN_LEGACY_TOOLS.has(name), `${name}: named by the old skill, neither listed nor hidden`).toBe(true);
      expect(sdkTool(conn.server, name), `${name} stays callable`).toBeDefined();
      const family = familyOf(name);
      expect(listed.get(family.name)).toContain(`${name.slice(family.prefix.length)}: `);
    }
  });

  it("names, in the new skill, only tools an older server lists, or families with a fallback to the former names", () => {
    const families = new Map(WRITE_FAMILIES.map((f) => [f.name, f]));
    // Tools added after commit 0 with no former name to fall back to (C-v4.1 commit 3: `storybloq receipt add`).
    // An older server lacks them, so a skill line naming one names a new capability, not a renamed one.
    const before = new Set([...BEFORE.names, "storybloq_receipt_add"]);
    for (const { path, text } of skillFiles()) {
      for (const name of new Set(text.match(/storybloq_[a-z0-9_]*[a-z0-9]/g) ?? [])) {
        if (before.has(name)) continue;
        const family = families.get(name);
        if (!family) {
          // A name prefix (`storybloq_ruling_<action>`, `storybloq_bus_*`) or the degraded-mode init tool.
          const prefix = [...before, ...families.keys()].some((full) => full.startsWith(`${name}_`));
          expect(prefix || name === "storybloq_init", `${path} names ${name}, which no server lists`).toBe(true);
          continue;
        }
        const fallback = text.includes(`${family.prefix}<action>`)
          || family.actions.some((a) => before.has(family.prefix + a) && text.includes(family.prefix + a));
        expect(fallback, `${path} names ${name} with no line leading to the former names`).toBe(true);
      }
    }
  });

  it("lists each family property as the members' one shared schema, or the union of their distinct schemas", async () => {
    const { tools } = await conn.client.listTools();
    const members = registeredBoardWriteTools(conn.server);
    const jsonOf = (type: z.ZodTypeAny): string => {
      const json = toJsonSchemaCompat(z.object({ k: type }) as never, { strictUnions: true, pipeStrategy: "input" }) as {
        properties: Record<string, Record<string, unknown>>;
      };
      const { description: _d, ...rest } = json.properties.k ?? {};
      return JSON.stringify(rest);
    };
    const bare = (node: unknown): string => {
      const { description: _d, ...rest } = node as Record<string, unknown>;
      return JSON.stringify(rest);
    };
    let unions = 0;
    for (const family of WRITE_FAMILIES) {
      const listed = tools.find((t) => t.name === family.name)!.inputSchema as { properties: Record<string, Record<string, unknown>> };
      for (const [key, prop] of Object.entries(listed.properties)) {
        if (key === "action") continue;
        // The SDK lists a type object shared with an earlier one as a $ref to it.
        const shown = deref(prop, listed) as Record<string, unknown>;
        const distinct = [...new Set(family.actions
          .map((a) => members.get(family.prefix + a)!.inputSchema.shape[key] as z.ZodTypeAny | undefined)
          .filter((t): t is z.ZodTypeAny => t !== undefined)
          .map(jsonOf))].sort();
        if (distinct.length === 1) {
          expect(bare(shown), `${family.name}.${key} is the members' shared schema`).toBe(distinct[0]);
        } else {
          unions += 1;
          const options = (shown.anyOf as unknown[] | undefined) ?? [];
          expect(options.map(bare).sort(), `${family.name}.${key} is the union of the members' schemas`).toEqual(distinct);
        }
      }
    }
    // The case the rule exists for: checkpoint `reason` has no minimum on
    // reopen and a minimum of 1 on retire, so the family takes either.
    expect(unions).toBe(1);
  });

  it("accepts at the family every value some member accepts, even under incomparable constraints", async () => {
    const seen: Array<{ action: string; args: unknown }> = [];
    const member = (action: string, n: z.ZodTypeAny): FamilyMember => ({
      inputSchema: z.object({ n }).strict(),
      handler: async (args) => {
        seen.push({ action, args });
        return { content: [] };
      },
    });
    const family: WriteFamily = { name: "storybloq_probe_write", prefix: "storybloq_probe_", head: "Probe", actions: ["short", "long", "num"] };
    const members = new Map<string, FamilyMember>([
      ["storybloq_probe_short", member("short", z.string().max(3))],
      ["storybloq_probe_long", member("long", z.string().min(5))],
      ["storybloq_probe_num", member("num", z.number().int().optional())],
    ]);
    const parse = z.object(familyInputShape(family, members)).strict();
    for (const [action, n] of [["short", "ab"], ["long", "abcdef"], ["num", 7], ["num", undefined]] as const) {
      const args = n === undefined ? { action } : { action, n };
      expect(parse.safeParse(args).success, `${action} ${String(n)} passes the family parse`).toBe(true);
      await dispatchWriteFamily(family, members, parse.parse(args) as Record<string, unknown>, {});
    }
    expect(seen.map((s) => s.action)).toEqual(["short", "long", "num", "num"]);
    // Each member still applies its own constraint at dispatch.
    await expect(dispatchWriteFamily(family, members, { action: "short", n: "abcdef" }, {})).rejects.toThrow(/storybloq_probe_short/);
    await expect(dispatchWriteFamily(family, members, { action: "long", n: "ab" }, {})).rejects.toThrow(/storybloq_probe_long/);
    // A value no member accepts is refused at the family.
    expect(parse.safeParse({ action: "num", n: true }).success).toBe(false);

    // The real catalog: an empty reason is valid for reopen, so the family takes it.
    const real = registeredBoardWriteTools(conn.server);
    const checkpoint = WRITE_FAMILIES.find((f) => f.name === "storybloq_checkpoint_write")!;
    const realParse = z.object(familyInputShape(checkpoint, real)).strict();
    const reopen = { id: "T-001", generation: 1, revision: 1, digest: "d", reason: "" };
    expect(real.get("storybloq_checkpoint_reopen")!.inputSchema.safeParse(reopen).success).toBe(true);
    expect(realParse.safeParse({ action: "reopen", ...reopen }).success).toBe(true);
  });

  it("refuses a key another action takes with the former tool's own refusal text", async () => {
    // `clear` is a term update key, so the family schema accepts it and the
    // former term add schema must refuse it, exactly as the former name does.
    const args = { id: "term-x", term: "X", definition: "An x.", clear: ["distinction"] };
    const legacy = await conn.call("storybloq_term_add", args);
    const family = await conn.call("storybloq_term_write", { action: "add", ...args });
    expect(legacy.isError).toBe(true);
    expect(legacy.text).toContain("Invalid arguments for tool storybloq_term_add");
    expect(family).toEqual(legacy);
  });

  it("refuses a missing required field with the former tool's own refusal text", async () => {
    const legacy = await conn.call("storybloq_checkpoint_retire", { id: "T-001", generation: 1, revision: 1, digest: "d" });
    const family = await conn.call("storybloq_checkpoint_write", { action: "retire", id: "T-001", generation: 1, revision: 1, digest: "d" });
    expect(legacy.isError).toBe(true);
    expect(family).toEqual(legacy);
  });

  it("refuses an accept that does not carry the reviewed revision with the same code through both names", async () => {
    const proposed = await conn.call("storybloq_ruling_write", {
      action: "propose", text: "Ship on green.", attribution: "owner-direct", date: "2026-02-02", clientTaskId: "families-test",
    });
    expect(proposed.isError, proposed.text).toBe(false);
    const id = /\b(r-[0-9a-z]+)\b/.exec(proposed.text)?.[1];
    expect(id, proposed.text).toBeDefined();
    const args = { id, revision: "0".repeat(64), attribution: "owner-direct", date: "2026-02-02", clientTaskId: "families-test" };
    const before = ledger(conn.root);
    const legacy = await conn.call("storybloq_ruling_accept", args);
    const family = await conn.call("storybloq_ruling_write", { action: "accept", ...args });
    expect(legacy.isError).toBe(true);
    expect(legacy.text).toContain(`Cannot accept ${id}`);
    expect(family).toEqual(legacy);
    expect(ledger(conn.root)).toEqual(before);
  });

  it("refuses an unknown key at the family, naming the family tool (disclosed deviation)", async () => {
    const family = await conn.call("storybloq_term_write", { action: "add", id: "term-x", term: "X", definition: "An x.", bogus: 1 });
    expect(family.isError).toBe(true);
    expect(family.text).toContain("Invalid arguments for tool storybloq_term_write");
    expect(family.text).toContain("bogus");
  });

  it("refuses an unknown action", async () => {
    const family = await conn.call("storybloq_earmark_write", { action: "steal", ref: "T-001", role: "worker" });
    expect(family.isError).toBe(true);
    expect(family.text).toContain("storybloq_earmark_write");
  });
});

describe("the capability check after commit 0", () => {
  it("knows the catalog plus the hidden former names, and nothing else", () => {
    const known = referenceSurfaceNames();
    expect(unknownSurfaces({ mcp: ["storybloq_ruling_create", "storybloq_term_add", "storybloq_ruling_write", "storybloq_no_such_tool"] }, known))
      .toEqual([{ kind: "mcp", name: "storybloq_no_such_tool" }]);
    expect([...known.mcpNames].sort()).toEqual([...MCP_TOOLS.map((t) => t.name), ...HIDDEN_LEGACY_TOOLS].sort());
    for (const hidden of HIDDEN_LEGACY_TOOLS) expect(MCP_TOOLS.map((t) => t.name), `${hidden} is not in the reference catalog`).not.toContain(hidden);
  });
});

describe("a family action and its former name give the same result", () => {
  it("term add: same reply, same ledger bytes", async () => {
    const { legacy, family } = await twin("storybloq_term_add", { id: "term-widget", term: "widget", definition: "A thing on the board.", aliases: ["gizmo"] });
    expect(legacy.isError).toBe(false);
    expect(family).toEqual(legacy);
  });

  it("term update: same reply, same ledger bytes", async () => {
    const setup = async (c: Connected) => {
      await c.call("storybloq_term_add", { id: "term-widget", term: "widget", definition: "A thing on the board.", distinction: "Not a gadget." });
    };
    const { legacy, family } = await twin("storybloq_term_update", { id: "term-widget", definition: "A thing.", clear: ["distinction"] }, setup);
    expect(legacy.isError).toBe(false);
    expect(family).toEqual(legacy);
  });

  it("capability add: same reply, same ledger bytes", async () => {
    const { legacy, family } = await twin("storybloq_capability_add", {
      id: "cap-widgets", name: "Widgets", summary: "Makes widgets.", entryPoints: [".story"], contract: "A widget per call.",
    });
    expect(legacy.isError).toBe(false);
    expect(family).toEqual(legacy);
  });

  it("capability update refusal: same code and text", async () => {
    const { legacy, family } = await twin("storybloq_capability_update", { id: "cap-missing", summary: "x" });
    expect(legacy.isError).toBe(true);
    expect(family).toEqual(legacy);
  });

  it("ruling create refusal on an unresolvable citation: same code and text, nothing written", async () => {
    const { legacy, family } = await twin("storybloq_ruling_create", {
      text: "Ship it.", attribution: "owner-direct", date: "2026-02-02", cites: ["T-999"],
    });
    expect(legacy.isError).toBe(true);
    expect(family).toEqual(legacy);
  });

  it("earmark reserve refusal on a missing item: same code and text", async () => {
    const { legacy, family } = await twin("storybloq_earmark_reserve", { ref: "T-999", role: "worker" });
    expect(legacy.isError).toBe(true);
    expect(family).toEqual(legacy);
  });

  it("checkpoint create with keys create does not take (an invalid-schema refusal): same code and text", async () => {
    const { legacy, family } = await twin("storybloq_checkpoint_create", {
      id: "T-999", generation: 0, revision: 0, digest: "d", kind: "decision", question: "Which?",
    });
    expect(legacy.isError).toBe(true);
    expect(legacy.text).toContain("Invalid arguments for tool storybloq_checkpoint_create");
    expect(family).toEqual(legacy);
  });

  it("checkpoint attach to a missing ticket (a handler-level refusal): same code and text, nothing written", async () => {
    const enable = async (c: Connected) => {
      await handleCheckpointEnable("md", c.root);
    };
    const { legacy, family } = await twin("storybloq_checkpoint_attach", {
      id: "T-999", owner: "owner", kind: "decision", question: "Which store?",
    }, enable);
    expect(legacy.isError).toBe(true);
    expect(legacy.text).not.toContain("Invalid arguments");
    expect(legacy.text).toContain("T-999");
    expect(family).toEqual(legacy);
  });
});
