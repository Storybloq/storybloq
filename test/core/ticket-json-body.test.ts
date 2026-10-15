import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import {
  handleTicketCreate,
  handleTicketGet,
  handleTicketList,
  handleTicketNext,
  handleTicketBlocked,
  handleTicketUpdate,
  handleTicketMetaSet,
  handleTicketMetaUnset,
  handleTicketUnclaim,
  handleTicketStart,
} from "../../src/cli/commands/ticket.js";
import { handlePhaseTickets } from "../../src/cli/commands/phase.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { formatTicket, formatExport } from "../../src/core/output-formatter.js";
import type { CommandContext } from "../../src/cli/run.js";
import { makeState, makeTicket, makeRoadmap, makePhase } from "./test-factories.js";

/**
 * T-486 U2-5: every ticket JSON surface reports the ticket's withdrawal from
 * one derivation, `effective`, beside the loaded record. The expected values
 * are written out here rather than computed with the helper under test, so a
 * surface that skips the helper (killer J1) fails by name.
 */

const EFFECTIVE = { resolutionKind: "withdrawn", resolutionKindState: "effective", reason: "Superseded by T-009" };
const STALE = { resolutionKind: null, resolutionKindState: "stale", reason: null };
const ABSENT = { resolutionKind: null, resolutionKindState: "absent", reason: null };

function ticketFile(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: `Ticket ${String(over.id)}`,
    type: "task",
    status: "open",
    phase: "p0",
    order: 10,
    description: "",
    createdDate: "2026-03-01",
    completedDate: null,
    blockedBy: [],
    parentTicket: null,
    ...over,
  };
}

/** T-001 withdrawn (effective), T-002 withdrawn but reopened and re-closed later (stale), T-003 open, T-004 open and blocked by T-003. */
async function writeFixture(root: string): Promise<void> {
  const files: Record<string, Record<string, unknown>> = {
    "T-001.json": ticketFile({
      id: "T-001", status: "complete", completedDate: "2026-03-05", order: 10,
      resolutionKind: { kind: "withdrawn", closedOn: "2026-03-05", reason: "Superseded by T-009" },
    }),
    "T-002.json": ticketFile({
      id: "T-002", status: "complete", completedDate: "2026-03-07", order: 20,
      resolutionKind: { kind: "withdrawn", closedOn: "2026-03-02", reason: "Old withdrawal" },
    }),
    "T-003.json": ticketFile({ id: "T-003", order: 30 }),
    "T-004.json": ticketFile({ id: "T-004", order: 40, blockedBy: ["T-003"] }),
  };
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, ".story", "tickets", name), JSON.stringify(body, null, 2) + "\n");
  }
}

async function ctxFor(root: string, format: "json" | "md" = "json"): Promise<CommandContext> {
  const loaded = await loadProject(root);
  return { state: loaded.state, warnings: [], root, handoversDir: join(root, ".story", "handovers"), format };
}

interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function captureTools(root: string): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: RegisteredTool["handler"]) => tools.set(name, { handler }),
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

const byId = (rows: Array<Record<string, unknown>>, id: string) => rows.find((r) => r.id === id)!;

describe("ticket JSON bodies (T-486 U2-5)", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function setup(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "ticket-json-body-"));
    await initProject(root, { name: "json-body" });
    await writeFixture(root);
    return root;
  }

  it("every ticket JSON surface reports effective from ticketJsonBody", async () => {
    const dir = await setup();

    const get1 = JSON.parse(handleTicketGet("T-001", await ctxFor(dir)).output).data;
    expect(get1.effective).toEqual(EFFECTIVE);
    expect(get1.resolutionKind).toEqual({ kind: "withdrawn", closedOn: "2026-03-05", reason: "Superseded by T-009" });
    const get2 = JSON.parse(handleTicketGet("T-002", await ctxFor(dir)).output).data;
    expect(get2.effective).toEqual(STALE);

    const list = JSON.parse(handleTicketList({}, await ctxFor(dir)).output).data;
    expect(byId(list, "T-001").effective).toEqual(EFFECTIVE);
    expect(byId(list, "T-002").effective).toEqual(STALE);
    expect(byId(list, "T-003").effective).toEqual(ABSENT);

    const phase = JSON.parse(handlePhaseTickets("p0", await ctxFor(dir)).output).data;
    expect(byId(phase, "T-001").effective).toEqual(EFFECTIVE);
    expect(byId(phase, "T-002").effective).toEqual(STALE);

    const next1 = JSON.parse(handleTicketNext(await ctxFor(dir), 1).output).data;
    expect(next1.ticket.id).toBe("T-003");
    expect(next1.ticket.effective).toEqual(ABSENT);
    const nextN = JSON.parse(handleTicketNext(await ctxFor(dir), 3).output).data;
    expect(nextN.candidates.length).toBeGreaterThan(0);
    for (const c of nextN.candidates) expect(c.ticket.effective).toEqual(ABSENT);

    const blocked = JSON.parse((await handleTicketBlocked(await ctxFor(dir))).output).data;
    expect(byId(blocked, "T-004").effective).toEqual(ABSENT);

    const tools = captureTools(dir);
    const mcpGet = await tools.get("storybloq_ticket_get")!.handler({ id: "T-001", format: "json" });
    expect(JSON.parse(mcpGet.content[0]!.text).data.effective).toEqual(EFFECTIVE);
    // storybloq_ticket_list has no format input and always renders markdown, so
    // its proof is the withdrawn mark on the effective row and none on the stale one.
    const mcpList = (await tools.get("storybloq_ticket_list")!.handler({})).content[0]!.text.split("\n");
    expect(mcpList.find((l) => l.includes("T-001:"))).toMatch(/^\[x\] T-001: Ticket T-001 \(withdrawn\)/);
    expect(mcpList.find((l) => l.includes("T-002:"))).not.toContain("withdrawn");
  });

  it("every ticket write response reports effective", async () => {
    const dir = await setup();

    const created = JSON.parse((await handleTicketCreate(
      { title: "New", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "json", dir,
    )).output).data;
    expect(created.effective).toEqual(ABSENT);

    const updated = JSON.parse((await handleTicketUpdate("T-003", { title: "Renamed" }, "json", dir)).output).data;
    expect(updated.effective).toEqual(ABSENT);

    const metaSet = JSON.parse((await handleTicketMetaSet("T-001", "note", "kept", "json", dir)).output).data;
    expect(metaSet.effective).toEqual(EFFECTIVE);
    const metaUnset = JSON.parse((await handleTicketMetaUnset("T-001", "note", "json", dir)).output).data;
    expect(metaUnset.effective).toEqual(EFFECTIVE);

    const started = JSON.parse((await handleTicketStart("T-004", "json", dir, true)).output).data;
    expect(started.effective).toEqual(ABSENT);
    const unclaimed = JSON.parse((await handleTicketUnclaim("T-004", "json", dir)).output).data;
    expect(unclaimed.effective).toEqual(ABSENT);
  });

  it("a stored effective key returns the record under stored", () => {
    const ticket = makeTicket({
      id: "T-001", status: "complete", completedDate: "2026-03-05",
      ...({ effective: "hand-written", resolutionKind: { kind: "withdrawn", closedOn: "2026-03-05", reason: "Gone" } } as object),
    });
    const state = makeState({ tickets: [ticket], roadmap: makeRoadmap([makePhase({ id: "p1" })]) });
    const body = JSON.parse(formatTicket(ticket, state, "json")).data;
    expect(body.stored.effective).toBe("hand-written");
    expect(body.stored.id).toBe("T-001");
    expect(body.effective).toEqual({ resolutionKind: "withdrawn", resolutionKindState: "effective", reason: "Gone" });
    expect(body.id).toBeUndefined();
  });

  it("ticket get shows complete (withdrawn): reason, and the bare status otherwise", async () => {
    const dir = await setup();
    const md1 = handleTicketGet("T-001", await ctxFor(dir, "md")).output;
    expect(md1).toContain("Status: complete (withdrawn): Superseded by T-009 | Type: task");
    const md2 = handleTicketGet("T-002", await ctxFor(dir, "md")).output;
    expect(md2).toContain("Status: complete | Type: task");
    expect(md2).not.toContain("withdrawn");
  });

  it("ticket list and phase tickets keep [x] and append (withdrawn) only when effective", async () => {
    const dir = await setup();
    const list = handleTicketList({}, await ctxFor(dir, "md")).output.split("\n");
    expect(list.find((l) => l.includes("T-001:"))).toMatch(/^\[x\] T-001: Ticket T-001 \(withdrawn\)/);
    expect(list.find((l) => l.includes("T-002:"))).not.toContain("withdrawn");
    const phase = handlePhaseTickets("p0", await ctxFor(dir, "md")).output.split("\n");
    expect(phase.find((l) => l.includes("T-001:"))).toMatch(/^\[x\] T-001: Ticket T-001 \(withdrawn\)/);
    expect(phase.find((l) => l.includes("T-002:"))).not.toContain("withdrawn");
  });
  it("export rows carry displayId for legacy and hash files", async () => {
    const dir = await setup();
    await writeFile(
      join(dir, ".story", "tickets", "t-k7m2p9x3w4a5b6e8.json"),
      JSON.stringify(ticketFile({ id: "t-k7m2p9x3w4a5b6e8", displayId: "T-050", order: 50 }), null, 2) + "\n",
    );
    const { state } = await loadProject(dir);
    const phase = JSON.parse(formatExport(state, "phase", "p0", "json")).data;
    const full = JSON.parse(formatExport(state, "all", null, "json")).data;
    const fullRows = full.phases.flatMap((p: { tickets: unknown[] }) => p.tickets) as Array<Record<string, unknown>>;
    for (const rows of [phase.tickets as Array<Record<string, unknown>>, fullRows]) {
      expect(byId(rows, "T-001").displayId).toBe("T-001");
      expect(byId(rows, "t-k7m2p9x3w4a5b6e8").displayId).toBe("T-050");
    }
  });
});
