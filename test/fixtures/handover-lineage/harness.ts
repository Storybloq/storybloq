/**
 * ISS-1499 slice A: drives the real registered surfaces in-process, the CLI
 * yargs commands and the MCP tools, with an isolated environment, so the
 * lineage tests can pin bytes on disk and replies on both surfaces.
 */
import yargs from "yargs";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHandoverCommand, registerValidateCommand } from "../../../src/cli/register.js";
import { registerAllTools } from "../../../src/mcp/tools.js";

/** Variables that would bind a caller identity or reach the real machine. */
const ISOLATED_VARS = [
  "HOME", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "STORYBLOQ_CLIENT", "CLAUDE_PID",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "STORYBLOQ_GLOBAL_DIR", "XDG_CONFIG_HOME",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL", "EMAIL",
] as const;

export interface IsolatedEnv {
  readonly base: string;
  readonly home: string;
  /** The controlled global git config file. */
  readonly gitGlobal: string;
  restore(): void;
}

/**
 * Points HOME and every identity variable at a scratch folder. Git reads
 * only the files named here: an empty system config and a global one the
 * test controls.
 */
export function isolateEnv(): IsolatedEnv {
  const saved = new Map<string, string | undefined>();
  for (const k of ISOLATED_VARS) saved.set(k, process.env[k]);
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lineage-env-")));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const gitGlobal = join(base, "gitconfig-global");
  const gitSystem = join(base, "gitconfig-system");
  writeFileSync(gitGlobal, "");
  writeFileSync(gitSystem, "");
  for (const k of ISOLATED_VARS) delete process.env[k];
  process.env.HOME = home;
  process.env.STORYBLOQ_GLOBAL_DIR = join(base, "global");
  process.env.CODEX_HOME = join(base, "codex-home");
  process.env.XDG_CONFIG_HOME = join(base, "xdg");
  process.env.GIT_CONFIG_GLOBAL = gitGlobal;
  process.env.GIT_CONFIG_SYSTEM = gitSystem;
  return {
    base,
    home,
    gitGlobal,
    restore() {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export interface CliRun {
  readonly stdout: string;
  readonly exitCode: number | undefined;
}

/** Runs `storybloq <args>` through the registered yargs commands, in `cwd`. */
export async function runCli(cwd: string, args: readonly string[]): Promise<CliRun> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write;
  const origCwd = process.cwd();
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  let exitCode: number | undefined;
  try {
    process.chdir(cwd);
    process.exitCode = undefined;
    let y = yargs([...args]);
    y = registerHandoverCommand(y);
    y = registerValidateCommand(y);
    await y.exitProcess(false).fail(false).strict().parseAsync();
    exitCode = process.exitCode as number | undefined;
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
    process.exitCode = origExit;
  }
  return { stdout: chunks.join(""), exitCode };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

/** The registered MCP tools of a server pinned to `root`. */
export function mcpTools(root: string): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, root);
  return tools;
}

/** Calls one registered MCP tool and returns its text and error flag. */
export async function callMcp(root: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const handler = mcpTools(root).get(tool);
  if (!handler) throw new Error(`no MCP tool ${tool}`);
  const r = await handler(args);
  return { text: r.content.map((c) => c.text).join(""), isError: r.isError === true };
}
