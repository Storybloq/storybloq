/**
 * ISS-1107: every MCP registration and every CLI route is classified, so a new
 * board write cannot skip the git report by accident. Also the commit
 * argument's plumbing (A3), compact status spawning no git (S4), and an exempt
 * tool staying silent (W14).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";

const spawned = vi.hoisted(() => ({ git: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (args[0] === "git") spawned.git++;
      return actual.spawn(...args);
    }) as typeof actual.spawn,
  };
});

import {
  AST_REVIEWED_FORMS, BOARD_WRITE_TOOLS, COMMIT_PARAM_DESCRIPTION, MCP_COMMIT_PARAM_DESCRIPTION, MCP_CUSTOM_HANDLERS,
  WRITE_ENVELOPE_EXEMPT, registerWriteTool,
} from "../../src/mcp/board-write-tools.js";
import { CLI_NON_BOARD_HANDLERS, CLI_REPORTING_RUNNERS } from "../../src/cli/board-write-routes.js";
import { activeBoardWriteContext } from "../../src/core/board-write-recorder.js";
import { atomicWrite } from "../../src/core/project-loader.js";
import { runMcpWriteTool } from "../../src/mcp/tools.js";
import { captureTools, cleanupTempDirs, gitLines, isolateGit, makeProjectRepo } from "./board-git-fixtures.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

const calleeName = (e: ts.Expression): string | null =>
  ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;

function callsIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name) names.add(name);
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return names;
}

interface McpLists {
  board: readonly string[];
  exempt: Readonly<Record<string, string>>;
  custom: Readonly<Record<string, string>>;
  reviewed: Readonly<Record<string, string>>;
}

/**
 * The MCP rule: returns one violation string per unclassified registration.
 * A form the rule cannot read statically (a computed tool name, a registration
 * function taken as a value rather than called) is unsupported unless it is
 * listed in AST_REVIEWED_FORMS by its source text.
 */
function classifyMcp(source: string, lists: McpLists): string[] {
  const sf = ts.createSourceFile("tools.ts", source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const seenBoard = new Set<string>();
  for (const tool of lists.board) {
    if (tool in lists.exempt) violations.push(`${tool}: listed as a board write and as exempt`);
    if (tool in lists.custom) violations.push(`${tool}: listed as a board write and as a custom handler`);
  }
  const isRegistrationRef = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) && n.text === "registerWriteTool"
      && !ts.isImportSpecifier(n.parent) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n)
      && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n))
    || (ts.isPropertyAccessExpression(n) && n.name.text === "registerTool");
  const visit = (n: ts.Node): void => {
    if (isRegistrationRef(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
      const text = n.getText(sf);
      if (!(text in lists.reviewed)) violations.push(`${text}: registration function used as a value (aliased or delegated)`);
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      const viaWrite = name === "registerWriteTool" && ts.isIdentifier(n.expression);
      const viaServer = name === "registerTool" && ts.isPropertyAccessExpression(n.expression);
      if (viaWrite || viaServer) {
        const nameArg = n.arguments[viaWrite ? 1 : 0];
        const handler = n.arguments[viaWrite ? 3 : 2];
        if (nameArg && !ts.isStringLiteral(nameArg)) {
          const text = nameArg.getText(sf);
          if (!(text in lists.reviewed)) violations.push(`${text}: tool name is not a string literal`);
        }
        if (nameArg && ts.isStringLiteral(nameArg) && handler) {
          const tool = nameArg.text;
          const inline = ts.isArrowFunction(handler) || ts.isFunctionExpression(handler);
          if (!inline && !(tool in lists.reviewed)) violations.push(`${tool}: handler is not inline and not reviewed`);
          const calls = callsIn(handler);
          const writes = calls.has("runMcpWriteTool");
          const reads = calls.has("runMcpReadTool");
          if (viaWrite) {
            seenBoard.add(tool);
            if (!lists.board.includes(tool)) violations.push(`${tool}: registered as a board write but not listed`);
            if (!writes) violations.push(`${tool}: board write handler does not call runMcpWriteTool`);
          } else if (lists.board.includes(tool)) {
            violations.push(`${tool}: listed as a board write but registered without registerWriteTool`);
          } else if (writes && !(tool in lists.exempt)) {
            violations.push(`${tool}: calls runMcpWriteTool without registerWriteTool or an exemption`);
          } else if (!writes && !reads && !(tool in lists.custom)) {
            violations.push(`${tool}: custom handler not classified`);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const tool of lists.board) if (!seenBoard.has(tool)) violations.push(`${tool}: listed but never registered`);
  return violations;
}

/** The CLI rule: every handler call is inside a reporting runner or classified as not a board write. */
function classifyCli(source: string, runners: readonly string[], nonBoard: Readonly<Record<string, string>>): string[] {
  const sf = ts.createSourceFile("register.ts", source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const walk = (n: ts.Node, inRunner: boolean): void => {
    let inside = inRunner;
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name && /^handle[A-Z]/.test(name) && !inRunner && !(name in nonBoard)) {
        violations.push(`${name}: not inside a reporting runner and not classified`);
      }
      if (name && runners.includes(name)) inside = true;
    }
    ts.forEachChild(n, (c) => walk(c, inside));
  };
  walk(sf, false);
  return violations;
}

const LISTS: McpLists = { board: BOARD_WRITE_TOOLS, exempt: WRITE_ENVELOPE_EXEMPT, custom: MCP_CUSTOM_HANDLERS, reviewed: AST_REVIEWED_FORMS };

describe("board write classification (ISS-1107)", () => {
  it("A1: every MCP registration in tools.ts is classified", () => {
    const source = readFileSync(join(srcDir, "mcp", "tools.ts"), "utf-8");
    expect(classifyMcp(source, LISTS)).toEqual([]);
  });

  it("A1: the MCP rule flags each unclassified form", () => {
    const fixture = `
      server.registerTool("storybloq_sneaky_write", {}, async () => runMcpWriteTool(root, h));
      server.registerTool("storybloq_unlisted_custom", {}, async () => ({ content: [] }));
      server.registerTool("storybloq_named_handler", {}, namedHandler);
      registerWriteTool(server, "storybloq_unlisted_board", {}, async () => runMcpWriteTool(root, h));
      registerWriteTool(server, "storybloq_ticket_create", {}, async () => ({ content: [] }));
      server.registerTool(TOOL_NAME, {}, async () => runMcpReadTool(root, h));
      const reg = server.registerTool.bind(server);
      reg("storybloq_hidden_write", {}, async () => runMcpWriteTool(root, h));
      const write = registerWriteTool;
      server.registerTool("storybloq_delegated", {}, delegate);
    `;
    expect(classifyMcp(fixture, {
      ...LISTS,
      board: ["storybloq_ticket_create", "storybloq_both"],
      exempt: { ...LISTS.exempt, storybloq_both: "listed twice" },
    })).toEqual([
      "storybloq_both: listed as a board write and as exempt",
      "storybloq_sneaky_write: calls runMcpWriteTool without registerWriteTool or an exemption",
      "storybloq_unlisted_custom: custom handler not classified",
      "storybloq_named_handler: handler is not inline and not reviewed",
      "storybloq_named_handler: custom handler not classified",
      "storybloq_unlisted_board: registered as a board write but not listed",
      "storybloq_ticket_create: board write handler does not call runMcpWriteTool",
      "TOOL_NAME: tool name is not a string literal",
      "server.registerTool: registration function used as a value (aliased or delegated)",
      "registerWriteTool: registration function used as a value (aliased or delegated)",
      "storybloq_delegated: handler is not inline and not reviewed",
      "storybloq_delegated: custom handler not classified",
      "storybloq_both: listed but never registered",
    ]);
  });

  it("A1: the lists are disjoint, and only board writes carry commit in the registered schema", async () => {
    const board = new Set(BOARD_WRITE_TOOLS);
    for (const tool of [...Object.keys(WRITE_ENVELOPE_EXEMPT), ...Object.keys(MCP_CUSTOM_HANDLERS)]) {
      expect(board.has(tool), `${tool} is both a board write and exempt or custom`).toBe(false);
    }
    const { root } = await makeProjectRepo();
    const { configs, names } = captureTools(root);
    for (const name of names) {
      // The strict-schema wrapper turns a raw shape into a z.object; read its shape either way.
      const schema = (configs.get(name)?.inputSchema ?? {}) as { shape?: Record<string, unknown> };
      const hasCommit = Object.keys(schema.shape ?? schema).includes("commit");
      expect(hasCommit, `${name}: commit in schema`).toBe(board.has(name));
    }
    for (const tool of Object.keys(WRITE_ENVELOPE_EXEMPT)) expect(names).toContain(tool);
  });

  it("A2: every CLI handler call in register.ts is reported or classified", () => {
    const source = readFileSync(join(srcDir, "cli", "register.ts"), "utf-8");
    expect(classifyCli(source, CLI_REPORTING_RUNNERS, CLI_NON_BOARD_HANDLERS)).toEqual([]);
    for (const name of Object.keys(CLI_NON_BOARD_HANDLERS)) expect(source, `${name} is classified but never called`).toContain(`${name}(`);
  });

  it("A2: the CLI rule flags an unwrapped handler", () => {
    const fixture = `
      .command("ticket relabel", "", (y) => y, async (argv) => { await handleTicketRelabel(argv.id); })
      .command("ticket create", "", (y) => y, async (argv) => { await runBoardWrite(argv, format, async () => handleTicketCreate(argv)); })
      .command("ticket get", "", (y) => y, async (argv) => { await runReadCommand(format, (ctx) => handleTicketGet(argv.id, ctx)); })
    `;
    expect(classifyCli(fixture, CLI_REPORTING_RUNNERS, { handleTicketGet: "read" })).toEqual([
      "handleTicketRelabel: not inside a reporting runner and not classified",
    ]);
  });

  it("A3: registerWriteTool adds commit, strips it, and returns the handler's result unchanged", async () => {
    const registered = new Map<string, { config: { inputSchema: Record<string, z.ZodTypeAny> }; callback: (...a: unknown[]) => Promise<unknown> }>();
    const server = {
      registerTool: (name: string, config: { inputSchema: Record<string, z.ZodTypeAny> }, callback: (...a: unknown[]) => Promise<unknown>) => {
        registered.set(name, { config, callback });
        return {};
      },
    } as unknown as Parameters<typeof registerWriteTool>[0];
    const result = { content: [{ type: "text" as const, text: "ok" }] };
    const seen: unknown[][] = [];
    let commitSeen: boolean | undefined;
    registerWriteTool(server, "with_schema", { inputSchema: { x: z.number() } }, (...args: unknown[]) => {
      seen.push(args);
      commitSeen = activeBoardWriteContext()?.commit;
      return result;
    });
    registerWriteTool(server, "without_schema", {}, (...args: unknown[]) => {
      seen.push(args);
      return result;
    });
    const withSchema = registered.get("with_schema")!;
    expect(Object.keys(withSchema.config.inputSchema).sort()).toEqual(["commit", "x"]);
    expect(withSchema.config.inputSchema.commit!.description).toBe(MCP_COMMIT_PARAM_DESCRIPTION);
    // Two wordings, one contract: both name the staged refusal and the pen-only rule.
    for (const text of [MCP_COMMIT_PARAM_DESCRIPTION, COMMIT_PARAM_DESCRIPTION]) {
      expect(text).toMatch(/staged/);
      expect(text).toMatch(/pen/i);
    }
    expect(MCP_COMMIT_PARAM_DESCRIPTION.length).toBeLessThan(COMMIT_PARAM_DESCRIPTION.length);
    expect(withSchema.config.inputSchema.commit!.safeParse(undefined).success).toBe(true);
    expect(withSchema.config.inputSchema.commit!.safeParse("yes").success).toBe(false);
    const extra = { signal: "extra" };
    expect(await withSchema.callback({ x: 1, commit: true }, extra)).toBe(result);
    expect(seen[0]).toEqual([{ x: 1 }, extra]);
    expect(commitSeen).toBe(true);
    const withoutSchema = registered.get("without_schema")!;
    expect(Object.keys(withoutSchema.config.inputSchema)).toEqual(["commit"]);
    expect(await withoutSchema.callback({ commit: false }, extra)).toBe(result);
    expect(seen[1]).toEqual([extra]);
  });

  it("S4: compact status spawns no git; full status does", async () => {
    const { root } = await makeProjectRepo();
    const tools = captureTools(root);
    spawned.git = 0;
    const compact = await tools.call("storybloq_status", { format: "json", compact: true });
    expect(compact.isError).toBe(false);
    expect(spawned.git).toBe(0);
    await tools.call("storybloq_status", { format: "json" });
    expect(spawned.git).toBeGreaterThan(0);
  });

  it("W14: a tool on the exempt path emits no Git line for a recorded write", async () => {
    const { root } = await makeProjectRepo();
    const target = join(root, ".story", "notes", "N-900.json");
    const reply = await runMcpWriteTool(root, async () => {
      await atomicWrite(target, "{}\n");
      return { output: "wrote it" };
    });
    const text = reply.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text).toContain("wrote it");
    expect(gitLines(text)).toEqual([]);
  });
});
