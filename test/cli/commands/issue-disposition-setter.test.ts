/**
 * T-486 S0 (RED characterisation, ISS-1113 remainder G3): there is no
 * first-class way to set or clear an issue's disposition. The only operator
 * path today is the undocumented `issue meta set <id> disposition <v>`, which
 * works only because `disposition` is missing from ISSUE_CORE_METADATA_KEYS.
 *
 * Positive cases only. The CLI parser is strict, so a negative case ("refused
 * without --reason") passes today for the wrong reason: the option itself is
 * unknown. Those cases land with the setter.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";

import { initProject } from "../../../src/core/init.js";
import { handleIssueCreate } from "../../../src/cli/commands/issue.js";
import { registerIssueCommand } from "../../../src/cli/register.js";
import { PROJECT_ROOT_ENV_VAR, LEGACY_PROJECT_ROOT_ENV_VAR } from "../../../src/core/project-root-shared.js";
import { registerAllTools } from "../../../src/mcp/tools.js";
import { toolSchema } from "../../mcp/tool-schema-helpers.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "t486-s0-setter-"));
  roots.push(dir);
  await initProject(dir, { name: "t486" });
  return dir;
}

async function createIssue(dir: string, title: string): Promise<string> {
  const r = await handleIssueCreate(
    { title, severity: "medium", impact: "", components: [], relatedTickets: [], location: [] },
    "json",
    dir,
  );
  return (JSON.parse(r.output) as { data: { id: string } }).data.id;
}

const raw = (dir: string, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, ".story", "issues", `${id}.json`), "utf-8")) as Record<string, unknown>;

/** Runs `storybloq issue ...` through the real parser. */
async function cli(dir: string, args: string[]): Promise<void> {
  vi.stubEnv(PROJECT_ROOT_ENV_VAR, dir);
  vi.stubEnv(LEGACY_PROJECT_ROOT_ENV_VAR, "");
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await registerIssueCommand(yargs(["issue", ...args]).scriptName("storybloq"))
      .exitProcess(false)
      .fail(false)
      .parseAsync()
      .catch(() => undefined);
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe("T-486 S0: issue disposition has a first-class setter (CLI)", () => {
  it("issue update --disposition --reason --ref writes the three keys together", async () => {
    const dir = await project();
    const evidence = await createIssue(dir, "the decision record");
    const id = await createIssue(dir, "needs an owner call");
    await cli(dir, ["update", id, "--disposition", "owner_gated", "--reason", "pricing is the owner's call", "--ref", evidence]);
    const after = raw(dir, id);
    expect(after.disposition).toBe("owner_gated");
    expect(after.dispositionReason).toBe("pricing is the owner's call");
    expect(after.dispositionRef).toBe(evidence);
  });

  it("issue update --clear-disposition deletes the key rather than writing null", async () => {
    const dir = await project();
    const id = await createIssue(dir, "was parked");
    const path = join(dir, ".story", "issues", `${id}.json`);
    writeFileSync(path, JSON.stringify({ ...raw(dir, id), disposition: "owner_gated" }, null, 2));
    await cli(dir, ["update", id, "--clear-disposition"]);
    expect("disposition" in raw(dir, id)).toBe(false);
  });
});

describe("T-486 S0: issue disposition has a first-class setter (MCP)", () => {
  type Tool = { config: { inputSchema?: unknown }; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };
  function tool(root: string, name: string): Tool {
    const tools = new Map<string, Tool>();
    const server = {
      registerTool: (n: string, config: Tool["config"], handler: Tool["handler"]) => tools.set(n, { config, handler }),
    } as unknown as Parameters<typeof registerAllTools>[0];
    registerAllTools(server, root);
    return tools.get(name)!;
  }

  it("storybloq_issue_update accepts disposition, dispositionReason and dispositionRef and persists them", async () => {
    const dir = await project();
    const evidence = await createIssue(dir, "the decision record");
    const id = await createIssue(dir, "needs an owner call");
    const t = tool(dir, "storybloq_issue_update");
    const parsed = toolSchema(t.config.inputSchema).safeParse({
      id, disposition: "owner_gated", dispositionReason: "pricing is the owner's call", dispositionRef: evidence,
    });
    expect(parsed.success, "the tool schema must declare the three disposition arguments").toBe(true);
    if (!parsed.success) return;
    await t.handler(parsed.data as Record<string, unknown>);
    const after = raw(dir, id);
    expect(after.disposition).toBe("owner_gated");
    expect(after.dispositionReason).toBe("pricing is the owner's call");
    expect(after.dispositionRef).toBe(evidence);
  });
});
