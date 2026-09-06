/**
 * T-494 cite-on-create wiring: `--cites` must reach the ledger from the surfaces
 * a recorder actually uses.
 *
 * The T-489 lesson this file exists to apply: a whole tier once shipped as a
 * function with zero call sites, behind a green suite and four review rounds.
 * A unit test on `handleRulingCreate` cannot see that, because it calls the
 * helper directly. So both tests here drive a REAL surface -- the yargs command
 * tree that `storybloq ruling create` runs, and the registered MCP tool handler
 * -- and assert on the item file a reader would actually load.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { registerRulingCommand } from "../../src/cli/register.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProjectWithTicket(): Promise<{ root: string; ticketPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "ruling-wiring-"));
  tmpDirs.push(root);
  await initProject(root, { name: "test" });
  await mkdir(join(root, ".story", "tickets"), { recursive: true });
  const ticketPath = join(root, ".story", "tickets", "T-001.json");
  await writeFile(
    ticketPath,
    `${JSON.stringify(
      {
        id: "T-001",
        title: "Test T-001",
        description: "Test ticket.",
        type: "task",
        status: "open",
        phase: "p1",
        order: 10,
        createdDate: "2026-03-11",
        completedDate: null,
        blockedBy: [],
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return { root, ticketPath };
}

/**
 * An ISS-001 alongside the ticket, for the split-list case. Created through the
 * real handler rather than hand-written JSON: a hand-written issue silently
 * failed IssueSchema and was dropped at load, which surfaced as an unrelated
 * "project_corrupt" rather than as the citation assertion this test is about.
 */
async function newIssueIn(root: string): Promise<string> {
  await handleIssueCreate(
    { title: "Test ISS-001", severity: "low", impact: "x", components: [], relatedTickets: [], location: [] },
    "json",
    root,
  );
  return join(root, ".story", "issues", "ISS-001.json");
}

async function citesRulingsOf(path: string): Promise<unknown> {
  return (JSON.parse(await readFile(path, "utf-8")) as { citesRulings?: unknown }).citesRulings;
}

/** Drives the real `ruling` yargs tree in-process, exactly as the CLI does. */
async function runRulingCli(root: string, args: string[]): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write;
  const origCwd = process.cwd();
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return (origWrite as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  };
  try {
    process.chdir(root);
    process.exitCode = undefined;
    const parser = registerRulingCommand(yargs(args)).exitProcess(false).fail(false);
    await parser.parseAsync();
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
    process.exitCode = origExit;
  }
  return chunks.join("");
}

type McpHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/** Returns the REAL registered `storybloq_ruling_create` handler. */
function registeredRulingCreate(root: string): McpHandler {
  const tools = new Map<string, McpHandler>();
  const server = {
    registerTool: (name: string, _schema: unknown, handler: McpHandler) => {
      tools.set(name, handler);
    },
  };
  registerAllTools(server as never, root);
  const handler = tools.get("storybloq_ruling_create");
  if (!handler) throw new Error("storybloq_ruling_create was never registered");
  return handler;
}

describe("cite-on-create is reachable from the surfaces a recorder uses", () => {
  it("lands the citation through the real `ruling create --cites` yargs tree", async () => {
    const { root, ticketPath } = await newProjectWithTicket();

    const stdout = await runRulingCli(root, [
      "ruling",
      "create",
      "--text",
      "Cited from the CLI.",
      "--attribution",
      "owner-direct",
      "--date",
      "2026-09-06",
      "--cites",
      "T-001",
      "--client-task-id",
      "test-session-cli",
      "--format",
      "json",
    ]);

    const rulingId = JSON.parse(stdout).data.id as string;
    expect(rulingId).toMatch(/^r-[0-9a-hjkmnp-tv-z]{16}$/);
    expect(await citesRulingsOf(ticketPath)).toEqual([rulingId]);
  });

  it("SPLITS a comma-joined --cites into separate citations, at the yargs layer", async () => {
    // `--cites` is registered with SPLIT_LIST, so "T-001,ISS-001" is two refs
    // and not one unresolvable one. Proven here, through the real yargs tree
    // and from SOURCE, because the e2e coverage matrix that also asserts this
    // runs `dist/cli.js` and therefore cannot see a flag until the package is
    // rebuilt.
    const { root, ticketPath } = await newProjectWithTicket();
    const issuePath = await newIssueIn(root);

    const stdout = await runRulingCli(root, [
      "ruling", "create",
      "--text", "Binds a ticket and an issue.",
      "--attribution", "owner-direct",
      "--date", "2026-09-06",
      "--cites", "T-001,ISS-001",
      "--client-task-id", "test-session-cli",
      "--format", "json",
    ]);

    const rulingId = JSON.parse(stdout).data.id as string;
    expect(await citesRulingsOf(ticketPath)).toEqual([rulingId]);
    expect(await citesRulingsOf(issuePath)).toEqual([rulingId]);
  });

  it("lands the citation through the real registered storybloq_ruling_create MCP handler", async () => {
    const { root, ticketPath } = await newProjectWithTicket();

    const out = await registeredRulingCreate(root)({
      text: "Cited from MCP.",
      attribution: "owner-direct",
      date: "2026-09-06",
      cites: ["T-001"],
      clientTaskId: "test-session-mcp",
    });

    // This surface renders Markdown, not JSON, so the id is read from the item
    // the citation landed on and then checked against what the caller was told.
    // Asserting only the item would pass even if the handler reported a
    // different ruling; asserting only the text would not prove anything landed.
    const cited = (await citesRulingsOf(ticketPath)) as string[];
    expect(cited).toHaveLength(1);
    expect(cited[0]).toMatch(/^r-[0-9a-hjkmnp-tv-z]{16}$/);
    expect(out.content[0]!.text).toContain(cited[0]!);
  });
});
