#!/usr/bin/env node
/**
 * claudestory MCP server entry point.
 *
 * Provides 30 tools for querying and modifying .story/ project state.
 * Uses direct handler imports — no subprocess spawning.
 * Stdio transport: reads JSON-RPC from stdin, writes to stdout.
 * All diagnostic output goes to stderr.
 *
 * Project root discovery:
 * - CLAUDESTORY_PROJECT_ROOT env var (explicit, highest priority)
 * - Walk-up from cwd to find .story/config.json
 * - If neither found, server starts in degraded mode with claudestory_init + error status
 */
import { realpathSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { discoverProjectRoot } from "../core/project-root-discovery.js";
import { registerAllTools } from "./tools.js";
import { initProject } from "../core/init.js";

const ENV_VAR = "CLAUDESTORY_PROJECT_ROOT";
const CONFIG_PATH = ".story/config.json";

// Version injected at build time by tsup define
const version = process.env.CLAUDESTORY_VERSION ?? "0.0.0-dev";

/**
 * Try to discover project root. Returns the root path or null.
 * Never exits — the server stays alive even without a project.
 */
function tryDiscoverRoot(): string | null {
  const envRoot = process.env[ENV_VAR];
  if (envRoot) {
    if (!isAbsolute(envRoot)) {
      process.stderr.write(`Warning: ${ENV_VAR} must be an absolute path, got: ${envRoot}\n`);
      return null;
    }
    const resolved = resolve(envRoot);
    try {
      const canonical = realpathSync(resolved);
      if (existsSync(join(canonical, CONFIG_PATH))) {
        return canonical;
      }
      process.stderr.write(`Warning: No .story/config.json at ${canonical}\n`);
    } catch {
      process.stderr.write(`Warning: ${ENV_VAR} path does not exist: ${resolved}\n`);
    }
    return null;
  }

  try {
    const root = discoverProjectRoot();
    return root ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

/**
 * Degraded-mode tools: registered when no .story/ project is found.
 * Provides claudestory_init to bootstrap a project, then dynamically
 * swaps to the full tool set via registerAllTools.
 */
function registerDegradedTools(server: McpServer): void {
  const degradedStatus = server.registerTool("claudestory_status", {
    description: "Project summary — returns guidance if no .story/ project found",
  }, () => Promise.resolve({
    content: [{ type: "text" as const, text: "No .story/ project found. Use claudestory_init to create one, or navigate to a directory with .story/." }],
    isError: true,
  }));

  const degradedInit = server.registerTool("claudestory_init", {
    description: "Initialize a new .story/ project in the current directory",
    inputSchema: {
      name: z.string().describe("Project name"),
      type: z.string().optional().describe("Project type (e.g. npm, macapp, cargo, generic)"),
      language: z.string().optional().describe("Primary language (e.g. typescript, swift, rust)"),
    },
  }, async (args) => {
    let result;
    try {
      const projectRoot = realpathSync(process.cwd());
      result = await initProject(projectRoot, {
        name: args.name,
        type: args.type,
        language: args.language,
        phases: [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `[init_error] ${msg}` }], isError: true };
    }

    // Swap degraded tools for full tool set. Separate try/catch so a swap
    // failure doesn't mask the successful init or strand the server toolless.
    try {
      degradedStatus.remove();
      degradedInit.remove();
      registerAllTools(server, result.root);
    } catch (swapErr: unknown) {
      process.stderr.write(`claudestory: tool-swap failed after init: ${swapErr instanceof Error ? swapErr.message : String(swapErr)}\n`);
      // Re-register degraded tools so the server isn't completely toolless.
      // The project was created — user can restart for full access.
      try { registerDegradedTools(server); } catch { /* best effort */ }
      return { content: [{ type: "text" as const, text: `Initialized .story/ project "${args.name}" at ${result.root}\n\nWarning: tool registration failed. Restart the MCP server for full tool access.` }] };
    }

    process.stderr.write(`claudestory: initialized at ${result.root}\n`);

    const lines = [
      `Initialized .story/ project "${args.name}" at ${result.root}`,
      `Created: ${result.created.join(", ")}`,
    ];
    if (result.warnings.length > 0) {
      lines.push(`Warnings: ${result.warnings.join("; ")}`);
    }
    lines.push("", "All claudestory tools are now available. Use claudestory_phase_create to add phases and claudestory_ticket_create to add tickets.");
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });
}

async function main(): Promise<void> {
  const root = tryDiscoverRoot();

  const server = new McpServer(
    { name: "claudestory", version },
    {
      instructions: root
        ? "Start with claudestory_status for a project overview, then claudestory_ticket_next for the highest-priority work, then claudestory_handover_latest for session context."
        : "No .story/ project found. Use claudestory_init to initialize a new project, or navigate to a directory with .story/.",
    },
  );

  if (root) {
    registerAllTools(server, root);
    process.stderr.write(`claudestory MCP server running (root: ${root})\n`);
  } else {
    registerDegradedTools(server);
    process.stderr.write("claudestory MCP server running (no project — claudestory_init available)\n");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
