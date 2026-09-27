/**
 * T-537 S5: the checkpoint surfaces. The six MCP tools run the CLI's own
 * handlers, so the same call answers and refuses the same way on both: a
 * stale expected state is refused, a retire without a reason is refused, and
 * a success writes the same record. enable, resolve-conflict and list stay
 * CLI-only. ticket get, ticket list and status show a checkpoint distinctly,
 * with the expected state a change must name.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { formatPhaseTickets, formatStatus, formatTicket, formatTicketList } from "../../src/core/output-formatter.js";
import {
  handleCheckpointCreate,
  handleCheckpointEnable,
  handleCheckpointList,
  handleCheckpointResolve,
  handleCheckpointResolveConflict,
  handleCheckpointRetire,
} from "../../src/cli/commands/checkpoint.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";

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

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "t537-surface-"));
  dirs.push(root);
  await initProject(root, { name: "t537" });
  await handleCheckpointEnable("md", root);
  return root;
}

const CONTENT = { title: "Pick a store", owner: "owner", kind: "decision", question: "sqlite or pg?", evidenceRefs: ["docs/store.md"] };

async function createdVia(surface: "cli" | "mcp", root: string): Promise<{ id: string; expected: { generation: number; revision: number; digest: string } }> {
  if (surface === "cli") {
    const r = await handleCheckpointCreate({ ...CONTENT, phase: "p0" }, "json", root);
    return JSON.parse(r.output).data;
  }
  // MCP write tools answer in markdown only (runMcpWriteTool); read the
  // created checkpoint back through the CLI's own list.
  const r = await captureTools(root).get("storybloq_checkpoint_create")!.handler({ ...CONTENT, phase: "p0" });
  expect(r.isError, r.content[0]!.text).toBeFalsy();
  const id = /Created checkpoint (\S+?)[:.]/.exec(r.content[0]!.text)?.[1];
  const listed = JSON.parse((await handleCheckpointList("json", root)).output).data as Array<{ id: string; expected: { generation: number; revision: number; digest: string } }>;
  const created = listed.find((s) => s.id === id);
  expect(created, r.content[0]!.text).toBeDefined();
  return created!;
}

async function ticketFile(root: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, ".story", "tickets", `${id}.json`), "utf-8"));
}

/** A record with its clock and actor fields removed, so two surfaces' writes compare. */
function timeless(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(timeless);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !["at", "respondedAt", "createdDate", "completedDate", "by", "respondedBy"].includes(k)).map(([k, x]) => [k, timeless(x)]));
  }
  return v;
}

describe("checkpoint MCP tools (T-537 S5)", () => {
  it("registers the six lifecycle writes and keeps enable, resolve-conflict and list CLI-only", async () => {
    const tools = captureTools(await project());
    for (const verb of ["create", "attach", "resolve", "change", "reopen", "retire"]) {
      expect(tools.has(`storybloq_checkpoint_${verb}`), verb).toBe(true);
    }
    for (const verb of ["enable", "resolve_conflict", "list"]) {
      expect(tools.has(`storybloq_checkpoint_${verb}`), verb).toBe(false);
    }
  });

  it("writes the same record through the CLI handler and the MCP tool", async () => {
    const cli = await project();
    const mcp = await project();
    const a = await createdVia("cli", cli);
    const b = await createdVia("mcp", mcp);
    expect(b.expected).toEqual(a.expected);
    await handleCheckpointResolve(a.id, { ...a.expected, response: "pg" }, "json", cli);
    const r = await captureTools(mcp).get("storybloq_checkpoint_resolve")!.handler({ id: b.id, ...b.expected, response: "pg" });
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    expect(timeless(await ticketFile(mcp, b.id))).toEqual(timeless(await ticketFile(cli, a.id)));
  });

  it("refuses a stale expected state on both surfaces with the same message, and writes nothing", async () => {
    const cli = await project();
    const mcp = await project();
    const a = await createdVia("cli", cli);
    const b = await createdVia("mcp", mcp);
    const beforeCli = await ticketFile(cli, a.id);
    const beforeMcp = await ticketFile(mcp, b.id);
    const stale = { ...a.expected, digest: "0".repeat(64) };
    const cliError = await handleCheckpointResolve(a.id, { ...stale, response: "pg" }, "md", cli).then(() => null, (e: Error) => e.message);
    const r = await captureTools(mcp).get("storybloq_checkpoint_resolve")!.handler({ id: b.id, ...stale, response: "pg" });
    expect(cliError).toMatch(/changed since you read it/);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(cliError!);
    expect(await ticketFile(cli, a.id)).toEqual(beforeCli);
    expect(await ticketFile(mcp, b.id)).toEqual(beforeMcp);
  });

  it("refuses a retire without a reason on both surfaces, and writes nothing", async () => {
    const cli = await project();
    const mcp = await project();
    const a = await createdVia("cli", cli);
    const b = await createdVia("mcp", mcp);
    const before = await ticketFile(cli, a.id);
    await expect(handleCheckpointRetire(a.id, { ...a.expected, reason: "  " }, "md", cli)).rejects.toThrow(/needs a reason/);
    expect(await ticketFile(cli, a.id)).toEqual(before);
    const r = await captureTools(mcp).get("storybloq_checkpoint_retire")!.handler({ id: b.id, ...b.expected });
    expect(r.isError).toBe(true);
  });

  it("records the response as an attributed ruling in the same write, on both surfaces", async () => {
    const cli = await project();
    const mcp = await project();
    const a = await createdVia("cli", cli);
    const b = await createdVia("mcp", mcp);
    const ruling = { rulingAttribution: "owner-direct", rulingScopeTags: ["T-537"], clientTaskId: "surface-test" };
    const viaCli = JSON.parse((await handleCheckpointResolve(a.id, { ...a.expected, response: "pg", ...ruling }, "json", cli)).output).data;
    const r = await captureTools(mcp).get("storybloq_checkpoint_resolve")!.handler({ id: b.id, ...b.expected, response: "pg", ...ruling });
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    const viaMcp = { rulingId: /\(ruling (r-[^)]+)\)/.exec(r.content[0]!.text)?.[1] };
    for (const [root, out] of [[cli, viaCli], [mcp, viaMcp]] as const) {
      expect(out.rulingId).toMatch(/^r-/);
      const recorded = JSON.parse(await readFile(join(root, ".story", "rulings", `${out.rulingId}.json`), "utf-8"));
      expect(recorded).toMatchObject({ text: "pg", attribution: "owner-direct", scopeTags: ["T-537"] });
    }
  });

  it("resolve-conflict refuses a ticket that is not a checkpoint", async () => {
    const root = await project();
    await handleTicketCreate({ title: "plain", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", root);
    await expect(handleCheckpointResolveConflict("T-001", { use: "ours" }, "md", root)).rejects.toThrow(/not an owner checkpoint/);
  });
});

describe("checkpoints on ticket get, ticket list and status (T-537 S5)", () => {
  it("shows the state, the question and the expected state a change must name, and counts by state", async () => {
    const root = await project();
    await handleTicketCreate({ title: "plain", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", root);
    const pending = await createdVia("cli", root);
    const approved = await createdVia("cli", root);
    await handleCheckpointResolve(approved.id, { ...approved.expected, response: "pg" }, "md", root);
    const { state } = await loadProject(root);
    const ticket = state.tickets.find((t) => t.id === pending.id)!;
    const plain = state.tickets.find((t) => t.id === "T-001")!;

    const md = formatTicket(ticket, state, "md");
    expect(md).toContain("## Owner checkpoint");
    expect(md).toContain("State: pending | Kind: decision | Owner: owner");
    expect(md).toContain("Question: sqlite or pg?");
    expect(md).toContain(`Expected state: --generation ${pending.expected.generation} --revision ${pending.expected.revision} --digest ${pending.expected.digest}`);
    expect(formatTicket(plain, state, "md")).not.toContain("Owner checkpoint");
    expect(JSON.parse(formatTicket(ticket, state, "json")).data.checkpoint).toMatchObject({ state: "pending", expected: pending.expected });
    expect(JSON.parse(formatTicket(plain, state, "json")).data).not.toHaveProperty("checkpoint");

    const list = formatTicketList(state.tickets, "md");
    expect(list).toContain(`${pending.id}: Pick a store [checkpoint pending]`);
    expect(list).toContain(`${approved.id}: Pick a store [checkpoint approved]`);
    expect(list).toMatch(/T-001: plain \(p0\)/);

    expect(formatStatus(state, "md")).toContain("Checkpoints: 1 pending, 1 approved, 0 retired");
    expect(JSON.parse(formatStatus(state, "json")).data.checkpoints).toEqual({ pending: 1, approved: 1, retired: 0, unrecognized: 0 });

    const listed = JSON.parse((await handleCheckpointList("json", root, { state: "pending" })).output).data;
    expect(listed.map((s: { id: string }) => s.id)).toEqual([pending.id]);
  });

  it("marks each checkpoint's derived state in phase tickets, in text and JSON", async () => {
    const root = await project();
    await handleTicketCreate({ title: "plain", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", root);
    const pending = await createdVia("cli", root);
    const approved = await createdVia("cli", root);
    const retired = await createdVia("cli", root);
    await handleCheckpointResolve(approved.id, { ...approved.expected, response: "pg" }, "md", root);
    await handleCheckpointRetire(retired.id, { ...retired.expected, reason: "no longer asked" }, "md", root);
    const { state } = await loadProject(root);

    const text = formatPhaseTickets("p0", state, "md");
    expect(text).toContain(`${pending.id}: Pick a store [checkpoint pending]`);
    expect(text).toContain(`${approved.id}: Pick a store [checkpoint approved]`);
    expect(text).toContain(`${retired.id}: Pick a store [checkpoint retired]`);
    expect(text).toMatch(/T-001: plain$/m);

    const json = JSON.parse(formatPhaseTickets("p0", state, "json")).data as Array<{ id: string; checkpoint?: { state: string } }>;
    const stateOf = (id: string) => json.find((t) => t.id === id)?.checkpoint?.state;
    expect([stateOf(pending.id), stateOf(approved.id), stateOf(retired.id)]).toEqual(["pending", "approved", "retired"]);
    expect(json.find((t) => t.id === "T-001")).not.toHaveProperty("checkpoint");
  });

  it("prints no checkpoint line in status when there are none, and zeros in its JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "t537-surface-"));
    dirs.push(root);
    await initProject(root, { name: "t537" });
    const { state } = await loadProject(root);
    expect(formatStatus(state, "md")).not.toContain("Checkpoints:");
    expect(JSON.parse(formatStatus(state, "json")).data.checkpoints).toEqual({ pending: 0, approved: 0, retired: 0, unrecognized: 0 });
  });
});
