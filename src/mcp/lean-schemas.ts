import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Drops the `$schema` header the SDK stamps onto every advertised tool schema.
 *
 * Every byte of `tools/list` is paid by the user, in every session, before any
 * work happens, on any client that loads tool schemas upfront. The SDK converts
 * our zod shapes with hardcoded options that always emit
 * `"$schema":"http://json-schema.org/draft-07/schema#"` -- 52 bytes on each of
 * the ~53 tools that declare arguments, about 2.8KB of context that tells a
 * client nothing it did not already know from the surrounding JSON Schema.
 * `ToolSchema` in the SDK's own types declares `inputSchema` with `.catchall`,
 * so the key is permitted extra, never required, and removing it changes no
 * client's ability to validate a call.
 *
 * The seam is narrow. McpServer installs its `tools/list` handler LAZILY, on the
 * first `registerTool`, and guards that install with `assertCanSetRequestHandler`
 * -- so pre-installing a competing handler does not work: it throws, and it
 * throws even earlier because tool capabilities are not registered until that
 * same lazy install runs. What does work is wrapping the METHOD, so the SDK's
 * own handler is decorated at the moment it is registered. That reads only
 * public API (`server.server`, `setRequestHandler`, `assertCanSetRequestHandler`)
 * and no private field.
 *
 * Failure is always "the 2.8KB comes back", never a broken server: if the
 * handler is already installed the shim declines, and if a future SDK stops
 * emitting the key the strip simply finds nothing to remove.
 */
const APPLIED = Symbol.for("storybloq.leanToolSchemas");

interface LowLevelServer {
  [APPLIED]?: boolean;
  setRequestHandler: (schema: unknown, handler: (req: unknown, extra: unknown) => unknown) => void;
  assertCanSetRequestHandler: (method: string) => void;
}

export function withLeanToolSchemas(server: McpServer): void {
  const low = (server as { server?: unknown }).server as LowLevelServer | undefined;

  // A stand-in server (test doubles hold registerTool and nothing else) has no
  // low-level handle to wrap. Nothing to trim, and nothing worth failing over.
  if (!low || typeof low !== "object") return;
  if (typeof low.setRequestHandler !== "function" || typeof low.assertCanSetRequestHandler !== "function") return;

  // Idempotent: the degraded surface applies the shim, then storybloq_init
  // swaps in the full tool set and applies it again over the same server.
  if (low[APPLIED] === true) return;

  try {
    low.assertCanSetRequestHandler("tools/list");
  } catch {
    // A tool was registered before this ran, so the SDK's handler is already
    // in place and the wrap can no longer reach it. Say so and carry on.
    process.stderr.write("storybloq: tool schema trim skipped (tools/list handler already installed)\n");
    return;
  }

  const original = low.setRequestHandler.bind(low) as LowLevelServer["setRequestHandler"];
  low.setRequestHandler = (schema, handler) => {
    if (schema !== ListToolsRequestSchema) {
      // Everything else passes through untouched, including the result
      // validation Server installs around tools/call.
      original(schema, handler);
      return;
    }
    original(schema, async (req, extra) => stripSchemaHeaders(await handler(req, extra)));
  };
  low[APPLIED] = true;
}

/**
 * Removes `$schema` from each advertised tool schema, without mutating the
 * objects the SDK just built.
 *
 * The strip is root-only by design: zod-to-json-schema sets the header once, on
 * the root of the converted schema, so walking nested subschemas would cost
 * work on every list call to find nothing.
 */
export function stripSchemaHeaders(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return result;

  return {
    ...(result as Record<string, unknown>),
    tools: tools.map((tool) => {
      if (!tool || typeof tool !== "object") return tool;
      const source = tool as Record<string, unknown>;
      let next: Record<string, unknown> | undefined;
      for (const key of ["inputSchema", "outputSchema"] as const) {
        const schema = source[key];
        if (!schema || typeof schema !== "object" || !("$schema" in schema)) continue;
        const { $schema: _header, ...rest } = schema as Record<string, unknown>;
        next ??= { ...source };
        next[key] = rest;
      }
      return next ?? tool;
    }),
  };
}
