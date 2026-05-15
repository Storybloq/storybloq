#!/usr/bin/env node
/**
 * storybloq MCP server entry point.
 *
 * Provides MCP tools for querying and modifying .story/ project state.
 * Uses direct handler imports — no subprocess spawning.
 * Stdio transport: reads JSON-RPC from stdin, writes to stdout.
 * All diagnostic output goes to stderr.
 *
 * Project root discovery:
 * - STORYBLOQ_PROJECT_ROOT env var (explicit, highest priority)
 * - CLAUDESTORY_PROJECT_ROOT env var (deprecated fallback)
 * - Walk-up from cwd to find .story/config.json
 * - If neither found, server starts in degraded mode with storybloq_init + error status
 */
import { realpathSync, existsSync } from "node:fs";
import { resolve, join, isAbsolute } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { discoverProjectRoot } from "../core/project-root-discovery.js";
import { registerAllTools } from "./tools.js";
import { initProject } from "../core/init.js";
import { startInboxWatcher, stopInboxWatcher } from "../channel/inbox-watcher.js";

const ENV_VAR = "STORYBLOQ_PROJECT_ROOT";
const LEGACY_ENV_VAR = "CLAUDESTORY_PROJECT_ROOT";
const CONFIG_PATH = ".story/config.json";

// Version injected at build time by tsup define
const version = process.env.STORYBLOQ_VERSION ?? "0.0.0-dev";

/**
 * Try to discover project root. Returns the root path or null.
 * Never exits — the server stays alive even without a project.
 */
function tryDiscoverRoot(): string | null {
  const envRoot = process.env[ENV_VAR] ?? process.env[LEGACY_ENV_VAR];
  const envName = process.env[ENV_VAR] ? ENV_VAR : LEGACY_ENV_VAR;
  if (envRoot) {
    if (!isAbsolute(envRoot)) {
      process.stderr.write(`Warning: ${envName} must be an absolute path, got: ${envRoot}\n`);
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
      process.stderr.write(`Warning: ${envName} path does not exist: ${resolved}\n`);
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
 * Provides storybloq_init to bootstrap a project, then dynamically
 * swaps to the full tool set via registerAllTools.
 */
function registerDegradedTools(server: McpServer): void {
  const degradedStatus = server.registerTool("storybloq_status", {
    description: "Project summary — returns guidance if no .story/ project found",
  }, () => Promise.resolve({
    content: [{ type: "text" as const, text: "No .story/ project found. Use storybloq_init to create one, or navigate to a directory with .story/." }],
    isError: true,
  }));

  const degradedInit = server.registerTool("storybloq_init", {
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
      // Explicit tool-list-changed notification after the full swap. Each
      // underlying registerTool / remove call already emits its own
      // notification, but firing 49 notifications in rapid succession can
      // cause some MCP clients (notably Claude Code app) to miss the
      // coalesced final state. One final explicit notification is a
      // belt-and-suspenders signal that the tool list is now complete
      // so the client can do a single clean refetch.
      try {
        server.sendToolListChanged();
      } catch (notifyErr: unknown) {
        process.stderr.write(`storybloq: sendToolListChanged after init failed (non-fatal): ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}\n`);
      }
    } catch (swapErr: unknown) {
      process.stderr.write(`storybloq: tool-swap failed after init: ${swapErr instanceof Error ? swapErr.message : String(swapErr)}\n`);
      // Re-register degraded tools so the server isn't completely toolless.
      // The project was created — user can restart for full access.
      try { registerDegradedTools(server); } catch { /* best effort */ }
      return { content: [{ type: "text" as const, text: `Initialized .story/ project "${args.name}" at ${result.root}\n\nWarning: tool registration failed. Restart the MCP server for full tool access.` }] };
    }

    // Start inbox watcher separately -- failure here should not roll back tools.
    try {
      await startInboxWatcher(result.root, server);
    } catch (watchErr: unknown) {
      process.stderr.write(`storybloq: inbox watcher failed after init: ${watchErr instanceof Error ? watchErr.message : String(watchErr)}\n`);
    }

    process.stderr.write(`storybloq: initialized at ${result.root}\n`);

    const lines = [
      `Initialized .story/ project "${args.name}" at ${result.root}`,
      `Created: ${result.created.join(", ")}`,
    ];
    if (result.warnings.length > 0) {
      lines.push(`Warnings: ${result.warnings.join("; ")}`);
    }
    lines.push("", "All 49 storybloq tools are now registered. If your MCP client still only shows storybloq_init + storybloq_status, the tool-list-changed notification was missed -- either retry the first post-init tool call (some clients refetch on error) or restart the MCP client. Use storybloq_phase_create to add phases and storybloq_ticket_create to add tickets.");
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });
}

async function main(): Promise<void> {
  const root = tryDiscoverRoot();

  const server = new McpServer(
    { name: "storybloq", version },
    {
      instructions: root
        ? "Start with storybloq_status for a project overview, then storybloq_ticket_next for the highest-priority work, then storybloq_handover_latest for session context."
        : "No .story/ project found. Use storybloq_init to initialize a new project, or navigate to a directory with .story/.",
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
    },
  );

  if (root) {
    registerAllTools(server, root);
    await startInboxWatcher(root, server);
    process.stderr.write(`storybloq MCP server running (root: ${root})\n`);
  } else {
    registerDegradedTools(server);
    process.stderr.write("storybloq MCP server running (no project — storybloq_init available)\n");
  }

  // Graceful shutdown: stop inbox watcher on process exit
  process.on("SIGINT", () => { stopInboxWatcher(); process.exit(0); });
  process.on("SIGTERM", () => { stopInboxWatcher(); process.exit(0); });

  // ISS-563: Process-level error handlers to prevent silent crashes.
  // Tool handlers have their own try/catch; these catch everything else
  // (escaped async errors, stream errors, SDK internals).
  //
  // After an uncaught exception Node process state is not guaranteed to be
  // reliable, so we log and exit cleanly. Special-case EPIPE (broken pipe
  // from Claude Code closing stdout) as a normal shutdown path.
  process.on("uncaughtException", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPIPE") {
      try { process.stderr.write("storybloq: stdout pipe broken (EPIPE), shutting down\n"); } catch { /* stderr may also be closed */ }
      try { stopInboxWatcher(); } catch { /* best effort */ }
      process.exit(0);
    }
    try { process.stderr.write(`storybloq: uncaught exception: ${err.message}\n`); } catch { /* stderr may also be closed */ }
    try { stopInboxWatcher(); } catch { /* best effort */ }
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const code = reason instanceof Error ? (reason as NodeJS.ErrnoException).code : undefined;
    if (code === "EPIPE") {
      try { process.stderr.write("storybloq: stdout pipe broken (EPIPE), shutting down\n"); } catch { /* stderr may also be closed */ }
      try { stopInboxWatcher(); } catch { /* best effort */ }
      process.exit(0);
    }
    const msg = reason instanceof Error ? reason.message : String(reason);
    try { process.stderr.write(`storybloq: unhandled rejection: ${msg}\n`); } catch { /* stderr may also be closed */ }
    try { stopInboxWatcher(); } catch { /* best effort */ }
    process.exit(1);
  });

  // ISS-563: Silence stderr errors to prevent cascading crashes if the parent
  // closes stderr. process.stderr emits 'error' events that would otherwise
  // propagate as uncaught exceptions.
  process.stderr.on("error", () => { /* intentionally ignored */ });

  // ISS-563: Clean exit when Claude Code closes the stdio pipe.
  // Without this, the process zombies (kept alive by inbox watcher setInterval / FSWatcher)
  // and the next stdout.write() crashes with EPIPE.
  process.stdin.on("end", () => {
    try { process.stderr.write("storybloq: stdin closed, shutting down\n"); } catch { /* stderr may also be closed */ }
    try { stopInboxWatcher(); } catch { /* best effort */ }
    process.exit(0);
  });

  // ISS-563: Handle stdout errors gracefully.
  // When Claude Code closes its stdin (our stdout pipe), Node emits an 'error'
  // event on process.stdout. Without a handler, this becomes an uncaught exception.
  // Once stdout has errored the transport is unusable, so we always shut down.
  process.stdout.on("error", (err) => {
    const isEpipe = (err as NodeJS.ErrnoException).code === "EPIPE";
    try {
      process.stderr.write(
        isEpipe
          ? "storybloq: stdout pipe broken (EPIPE), shutting down\n"
          : `storybloq: stdout error: ${err.message}\n`,
      );
    } catch { /* stderr may also be closed */ }
    try { stopInboxWatcher(); } catch { /* best effort */ }
    process.exit(isEpipe ? 0 : 1);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
