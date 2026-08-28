import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { handleArrangementCreate } from "../../src/cli/commands/arrangement.js";
import type { Arrangement } from "../../src/models/arrangement.js";

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

const PARTIES = [
  { role: "pen", client: "claude", identityAnchor: "pen-session" },
  { role: "worker", client: "claude", identityAnchor: "worker-session" },
];

async function newProjectWithGatedArrangement(gateNames: string[]): Promise<{ root: string; arrangementId: string }> {
  const root = await mkdtemp(join(tmpdir(), "mcp-gate-ack-"));
  tempDirs.push(root);
  await initProject(root, { name: "test" });
  await handleTicketCreate(
    { title: "Duet ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
    "md",
    root,
  );
  const created = await handleArrangementCreate(
    { bounds: ["T-001"], parties: PARTIES as never, onIrreversibleWork: "hold" },
    "json",
    root,
  );
  const arrangementId = JSON.parse(created.output).data.id as string;
  const path = join(root, ".story", "arrangements", `${arrangementId}.json`);
  const raw = JSON.parse(await readFile(path, "utf-8")) as Arrangement;
  raw.gates = gateNames.map((name) => ({ name, ackRole: "pen" as const }));
  await writeFile(path, JSON.stringify(raw));
  return { root, arrangementId };
}

describe("gate-ack MCP tools (T-474)", () => {
  it("registers storybloq_gate_ack_get, _create, and _contest", async () => {
    const { root } = await newProjectWithGatedArrangement(["plan-ack"]);
    const tools = captureTools(root);
    expect(tools.has("storybloq_gate_ack_get")).toBe(true);
    expect(tools.has("storybloq_gate_ack_create")).toBe(true);
    expect(tools.has("storybloq_gate_ack_contest")).toBe(true);
  });

  it("does NOT register storybloq_gate_ack_list (list stays CLI-only, same ruling as T-473)", async () => {
    const { root } = await newProjectWithGatedArrangement(["plan-ack"]);
    const tools = captureTools(root);
    expect(tools.has("storybloq_gate_ack_list")).toBe(false);
  });

  it("create -> get round-trips through the registered handlers (plan-hash pin)", async () => {
    const { root, arrangementId } = await newProjectWithGatedArrangement(["plan-ack"]);
    const planFile = join(root, "plan.md");
    await writeFile(planFile, "# plan content");
    const tools = captureTools(root);

    const createResult = await tools.get("storybloq_gate_ack_create")!.handler({
      arrangement: arrangementId,
      gate: "plan-ack",
      ticket: "T-001",
      planFile,
    });
    expect(createResult.isError).toBeFalsy();
    // MCP write tools always render "md" (runMcpWriteTool pins format to
    // "md"), so the id is extracted from the sentence, not parsed as JSON.
    const createdMatch = createResult.content[0]!.text.match(/Created gate-ack (g-[0-9a-f]+)/);
    expect(createdMatch).not.toBeNull();
    const id = createdMatch![1]!;

    const getResult = await tools.get("storybloq_gate_ack_get")!.handler({ id });
    expect(getResult.isError).toBeFalsy();
    expect(getResult.content[0]!.text).toContain(id);
  });

  it("create with fromStaged computes a tree-digest pin against a real git repo", async () => {
    const { root, arrangementId } = await newProjectWithGatedArrangement(["pre-commit-ack"]);
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root });
    await writeFile(join(root, "staged.txt"), "staged content");
    execFileSync("git", ["add", "staged.txt"], { cwd: root });

    const tools = captureTools(root);
    const createResult = await tools.get("storybloq_gate_ack_create")!.handler({
      arrangement: arrangementId,
      gate: "pre-commit-ack",
      ticket: "T-001",
      fromStaged: true,
    });
    expect(createResult.isError).toBeFalsy();
    expect(createResult.content[0]!.text).toMatch(/Created gate-ack g-[0-9a-f]+/);
  });

  it("create rejects when neither planFile nor fromStaged is given", async () => {
    const { root, arrangementId } = await newProjectWithGatedArrangement(["plan-ack"]);
    const tools = captureTools(root);
    const result = await tools.get("storybloq_gate_ack_create")!.handler({
      arrangement: arrangementId,
      gate: "plan-ack",
      ticket: "T-001",
    });
    expect(result.isError).toBe(true);
  });

  it("contest marks an existing gate-ack contested", async () => {
    const { root, arrangementId } = await newProjectWithGatedArrangement(["plan-ack"]);
    const planFile = join(root, "plan.md");
    await writeFile(planFile, "# plan content");
    const tools = captureTools(root);

    const createResult = await tools.get("storybloq_gate_ack_create")!.handler({
      arrangement: arrangementId,
      gate: "plan-ack",
      ticket: "T-001",
      planFile,
    });
    const id = createResult.content[0]!.text.match(/Created gate-ack (g-[0-9a-f]+)/)![1]!;

    const contestResult = await tools.get("storybloq_gate_ack_contest")!.handler({ id, reason: "pin was wrong" });
    expect(contestResult.isError).toBeFalsy();
    expect(contestResult.content[0]!.text).toContain("contested");
  });

  it("contest rejects an empty reason", async () => {
    const { root } = await newProjectWithGatedArrangement(["plan-ack"]);
    const tools = captureTools(root);
    const result = await tools.get("storybloq_gate_ack_contest")!.handler({ id: "g-0000000000000000", reason: "" });
    expect(result.isError).toBe(true);
  });
});
