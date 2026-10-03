/**
 * ISS-1112: a ticket created without a phase defaults to the current phase
 * when the project has phases, and says so; an explicit null stays legal.
 * C1-C3 drive the real CLI parser (registerTicketCommand on yargs), so the
 * register.ts mapping is under test, not just the handler.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";

import { initProject } from "../../../src/core/init.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { registerTicketCommand } from "../../../src/cli/register.js";
import { PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR } from "../../../src/core/project-root-shared.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { toolSchema } from "../../mcp/tool-schema-helpers.js";
import type { Phase } from "../../../src/models/roadmap.js";

const DEFAULT_NOTE = ` (phase p1: defaulted to the current phase; pass phase null / --phase "" to leave it unphased)`;
const NO_CURRENT_NOTE = " (no current phase: ticket left unphased; assign a phase to schedule it)";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const phase = (id: string): Phase => ({ id, label: id.toUpperCase(), name: id, description: id });

async function project(phaseIds: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "iss1112-create-"));
  roots.push(dir);
  await initProject(dir, { name: "iss1112", phases: phaseIds.length > 0 ? phaseIds.map(phase) : undefined });
  if (phaseIds.length === 0) {
    const path = join(dir, ".story", "roadmap.json");
    const roadmap = JSON.parse(readFileSync(path, "utf-8")) as { phases: unknown[] };
    roadmap.phases = [];
    writeFileSync(path, JSON.stringify(roadmap, null, 2));
  }
  return dir;
}

const seed = (dir: string, phaseId: string | null, status?: "complete") =>
  handleTicketCreate({ title: "seed", type: "task", phase: phaseId, description: "", blockedBy: [], parentTicket: null }, "json", dir)
    .then((r) => {
      const id = (JSON.parse(r.output) as { data: { id: string } }).data.id;
      if (status) {
        const path = join(dir, ".story", "tickets", `${id}.json`);
        const t = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
        writeFileSync(path, JSON.stringify({ ...t, status, completedDate: "2026-10-01" }, null, 2));
      }
      return id;
    });

const persisted = (dir: string, id: string) =>
  (JSON.parse(readFileSync(join(dir, ".story", "tickets", `${id}.json`), "utf-8")) as { phase: string | null }).phase;

/** Runs `storybloq ticket create` through the real parser; returns stdout. */
async function cli(dir: string, extra: string[]): Promise<string> {
  vi.stubEnv(PROJECT_ROOT_ENV_VAR, dir);
  vi.stubEnv(LEGACY_PROJECT_ROOT_ENV_VAR, "");
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  try {
    await registerTicketCommand(yargs(["ticket", "create", "--title", "made", "--type", "task", ...extra]).scriptName("storybloq"))
      .exitProcess(false)
      .parseAsync();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe("ISS-1112: ticket create defaults the phase (CLI parser)", () => {
  it("C1: omitted --phase gets the current phase and the reply says so", async () => {
    const dir = await project(["p1", "p2"]);
    await seed(dir, "p1");
    const out = await cli(dir, []);
    expect(out).toContain(`Created ticket T-002: made${DEFAULT_NOTE}`);
    expect(persisted(dir, "T-002")).toBe("p1");
  });

  it("C2: --phase \"\" is a deliberate unphased choice", async () => {
    const dir = await project(["p1", "p2"]);
    await seed(dir, "p1");
    const out = await cli(dir, ["--phase", ""]);
    expect(out).toContain("Created ticket T-002: made");
    expect(out).not.toContain("defaulted");
    expect(persisted(dir, "T-002")).toBeNull();
  });

  it("C3: an explicit phase is kept", async () => {
    const dir = await project(["p1", "p2"]);
    await seed(dir, "p1");
    const out = await cli(dir, ["--phase", "p2"]);
    expect(out).not.toContain("defaulted");
    expect(persisted(dir, "T-002")).toBe("p2");
  });
});

describe("ISS-1112: default resolution (handler)", () => {
  const create = (dir: string) =>
    handleTicketCreate({ title: "made", type: "task", phase: undefined, description: "", blockedBy: [], parentTicket: null }, "md", dir);

  it("C4: a fresh roadmap with no tickets defaults to the first empty phase", async () => {
    const dir = await project(["p1", "p2"]);
    const result = await create(dir);
    expect(result.output).toBe(`Created ticket T-001: made${DEFAULT_NOTE}`);
    expect(persisted(dir, "T-001")).toBe("p1");
  });

  it("C5: when every phase is complete the ticket stays unphased and the reply says so", async () => {
    const dir = await project(["p1"]);
    await seed(dir, "p1", "complete");
    const result = await create(dir);
    expect(result.output).toBe(`Created ticket T-002: made${NO_CURRENT_NOTE}`);
    expect(persisted(dir, "T-002")).toBeNull();
  });

  it("C6: a project with no phases creates unphased with no note", async () => {
    const dir = await project([]);
    const result = await create(dir);
    expect(result.output).toBe("Created ticket T-001: made");
    expect(persisted(dir, "T-001")).toBeNull();
  });
});

describe("ISS-1112: storybloq_ticket_create defaults the phase (MCP)", () => {
  type Tool = { config: { inputSchema?: unknown }; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };
  function tool(root: string): Tool {
    const tools = new Map<string, Tool>();
    const server = {
      registerTool: (name: string, config: Tool["config"], handler: Tool["handler"]) => tools.set(name, { config, handler }),
    } as unknown as Parameters<typeof registerAllTools>[0];
    registerAllTools(server, root);
    return tools.get("storybloq_ticket_create")!;
  }
  async function call(root: string, body: Record<string, unknown>): Promise<string> {
    const t = tool(root);
    const args = toolSchema(t.config.inputSchema).parse({ title: "made", type: "task", ...body });
    return (await t.handler(args as Record<string, unknown>)).content.map((c) => c.text).join("\n");
  }

  it("C7: an omitted phase defaults and an explicit null parks the ticket unphased", async () => {
    const dir = await project(["p1", "p2"]);
    await seed(dir, "p1");
    const omitted = await call(dir, {});
    expect(omitted).toContain(`Created ticket T-002: made${DEFAULT_NOTE}`);
    expect(persisted(dir, "T-002")).toBe("p1");
    const parked = await call(dir, { phase: null });
    expect(parked).toContain("Created ticket T-003: made");
    expect(parked).not.toContain("defaulted");
    expect(persisted(dir, "T-003")).toBeNull();
  });
});
