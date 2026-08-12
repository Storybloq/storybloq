import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withLeanToolSchemas } from "./lean-schemas.js";

/**
 * Makes every tool registration reject arguments it does not implement (ISS-892).
 *
 * `registerTool` takes a raw zod shape, which the MCP SDK turns into a plain
 * `z.object(shape)`. Zod objects are non-strict by default, so an unrecognized
 * key is STRIPPED and validation succeeds. A caller that wrote `appendDescription`
 * instead of `description` therefore reached the handler with nothing but an id,
 * and got back "Updated ticket T-XXX" over a file that never changed.
 *
 * Wrapping the shape in `.strict()` turns that into an invalid_params error
 * naming the key. Note this is the server catching up to what it already
 * published: the SDK renders `additionalProperties: false` into the advertised
 * JSON Schema from the shape alone, regardless of strictness, so the server was
 * contradicting its own declared contract. A client validating locally already
 * rejected these calls; only the server let them through.
 *
 * Applied as a server-level shim rather than per registration, for the same
 * reason the CLI attaches array policy at registration (ISS-886): a rule that has
 * to be remembered at ~58 call sites is a rule that will be missed at one of them.
 *
 * This covers read tools as well as write tools. The reported harm was a write
 * claiming an update it did not make, but a read that silently ignores a
 * misspelled filter answers a question the caller did not ask, and the shim
 * cannot tell the two apart without a per-registration marker that would itself
 * be forgettable.
 */
export function withStrictToolSchemas(server: McpServer): McpServer {
  // T-460: both registration entry points run through here before their first
  // registerTool call, which is exactly the window the tools/list wrap needs.
  // Same argument as above: a rule enforced at one choke point is a rule that
  // survives; one enforced at every call site is one that gets missed.
  withLeanToolSchemas(server);

  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    handler: unknown,
  ) => unknown;

  return new Proxy(server, {
    get(target, prop, receiver): unknown {
      if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
      return (name: string, config: Record<string, unknown>, handler: unknown) =>
        registerTool(name, { ...config, inputSchema: strictInputSchema(config.inputSchema) }, handler);
    },
  });
}

/**
 * Wraps a raw shape into a strict object, and leaves anything else alone.
 *
 * A registration that already passes a built schema is returned untouched: it
 * chose its own unknown-key policy, and silently overriding that would be its own
 * kind of surprise.
 *
 * A tool declaring NO arguments still needs the guard -- `storybloq_snapshot`
 * called with a stray `label` would otherwise be ignored and reported as done --
 * but it gets `.optional()`, because a tool with no inputSchema was previously
 * not validated at all and a client is allowed to omit `arguments` entirely.
 * Requiring an object there would break a call that worked before. Tools that DO
 * declare arguments are already unable to accept a missing `arguments` (a plain
 * `z.object(...)` rejects undefined too), so nothing changes for them.
 */
export function strictInputSchema(inputSchema: unknown): unknown {
  const noArguments = z.object({}).strict().optional();
  if (inputSchema === undefined || inputSchema === null) return noArguments;
  if (typeof inputSchema !== "object") return inputSchema;
  // A built schema (v3 exposes _def, v4 exposes _zod); a raw shape has neither.
  const asSchema = inputSchema as { _def?: unknown; _zod?: unknown };
  if (asSchema._def !== undefined || asSchema._zod !== undefined) return inputSchema;
  const shape = inputSchema as z.ZodRawShape;
  if (Object.keys(shape).length === 0) return noArguments;
  return z.object(shape).strict();
}
