import { z } from "zod";

/**
 * Reads a registered tool's declared arguments.
 *
 * These harnesses capture the config handed to `registerTool` and then simulate
 * what the SDK does with it. That used to mean `z.object(config.inputSchema)`,
 * which assumed the value is always a raw shape. Since ISS-892 it is a strict
 * ZodObject (the shim in src/mcp/strict-schemas.ts), so the assumption no longer
 * holds and the harness has to normalize the same way the SDK does.
 *
 * Keeping this in one place means a future change to how schemas are registered
 * updates every harness at once instead of breaking five of them.
 */

/** The parseable schema for a tool's arguments, from a shape or a built schema. */
export function toolSchema(inputSchema: unknown): z.ZodTypeAny {
  if (inputSchema === undefined || inputSchema === null) return z.object({});
  if (inputSchema instanceof z.ZodType) return inputSchema;
  return z.object(inputSchema as z.ZodRawShape);
}

/** The declared argument names, from a shape or a built schema. */
export function toolArgumentNames(inputSchema: unknown): string[] {
  if (inputSchema === undefined || inputSchema === null) return [];
  if (inputSchema instanceof z.ZodObject) return Object.keys(inputSchema.shape as object);
  if (inputSchema instanceof z.ZodType) {
    // An optional/wrapped schema: unwrap one level, which is all the shim adds.
    const inner = (inputSchema as unknown as { _def?: { innerType?: unknown } })._def?.innerType;
    return inner === undefined ? [] : toolArgumentNames(inner);
  }
  return Object.keys(inputSchema as Record<string, unknown>);
}
