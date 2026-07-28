import { describe, it, expect } from "vitest";
import { z } from "zod";
import { strictInputSchema, withStrictToolSchemas } from "../../src/mcp/strict-schemas.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * ISS-892, unknown-argument half.
 *
 * `registerTool` takes a raw zod shape, which the SDK turns into a plain
 * `z.object(shape)`. Zod strips unrecognized keys by default, so a caller writing
 * `appendDescription` instead of `description` reached the handler with nothing
 * but an id and was told the update succeeded.
 */

const parse = (schema: unknown, value: unknown) =>
  (schema as z.ZodTypeAny).safeParse(value);

describe("strictInputSchema", () => {
  it("turns a raw shape into a schema that names the unrecognized key", () => {
    const schema = strictInputSchema({ id: z.string(), description: z.string().optional() });
    const result = parse(schema, { id: "T-001", appendDescription: "x" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("appendDescription");
  });

  it("still accepts the arguments the tool does implement", () => {
    const schema = strictInputSchema({ id: z.string(), description: z.string().optional() });
    expect(parse(schema, { id: "T-001", description: "x" }).success).toBe(true);
    expect(parse(schema, { id: "T-001" }).success).toBe(true);
  });

  it("guards a no-argument tool, which previously validated nothing at all", () => {
    // storybloq_snapshot took no inputSchema, so the SDK skipped validation and a
    // stray argument was accepted and ignored.
    for (const declared of [undefined, null, {}]) {
      const schema = strictInputSchema(declared);
      expect(parse(schema, { label: "x" }).success, `declared=${JSON.stringify(declared)}`).toBe(false);
    }
  });

  it("lets a no-argument tool still be called with no arguments at all", () => {
    // The compatibility constraint: a tool with no inputSchema was not validated
    // before, and a client may omit `arguments` entirely. Requiring an object
    // would break a call that worked.
    for (const declared of [undefined, null, {}]) {
      const schema = strictInputSchema(declared);
      expect(parse(schema, undefined).success, `declared=${JSON.stringify(declared)}`).toBe(true);
      expect(parse(schema, {}).success, `declared=${JSON.stringify(declared)}`).toBe(true);
    }
  });

  it("returns an already-built schema untouched", () => {
    // A registration that built its own schema chose its own unknown-key policy;
    // silently overriding it would be its own kind of surprise.
    const built = z.object({ a: z.string() });
    expect(strictInputSchema(built)).toBe(built);
    expect(parse(strictInputSchema(built), { a: "x", b: 1 }).success).toBe(true);
  });
});

describe("withStrictToolSchemas", () => {
  const fakeServer = () => {
    const calls: Array<{ name: string; config: Record<string, unknown> }> = [];
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        calls.push({ name, config });
        return { name };
      },
      sendToolListChanged() {
        return "passed through";
      },
      marker: "untouched",
    };
    return { server, calls };
  };

  it("rewrites the inputSchema of every registration that goes through it", () => {
    const { server, calls } = fakeServer();
    const shimmed = withStrictToolSchemas(server as unknown as McpServer);
    shimmed.registerTool("t", { inputSchema: { id: z.string() } } as never, (() => undefined) as never);

    expect(calls).toHaveLength(1);
    expect(parse(calls[0]!.config.inputSchema, { id: "x", nope: 1 }).success).toBe(false);
    expect(parse(calls[0]!.config.inputSchema, { id: "x" }).success).toBe(true);
  });

  it("leaves the rest of the config alone", () => {
    const { server, calls } = fakeServer();
    const shimmed = withStrictToolSchemas(server as unknown as McpServer);
    shimmed.registerTool(
      "t",
      { description: "d", annotations: { a: 1 }, inputSchema: { id: z.string() } } as never,
      (() => undefined) as never,
    );
    expect(calls[0]!.config.description).toBe("d");
    expect(calls[0]!.config.annotations).toEqual({ a: 1 });
  });

  it("passes every other member through, so it is a shim and not a replacement", () => {
    const { server } = fakeServer();
    const shimmed = withStrictToolSchemas(server as unknown as McpServer) as unknown as {
      sendToolListChanged: () => string;
      marker: string;
    };
    expect(shimmed.sendToolListChanged()).toBe("passed through");
    expect(shimmed.marker).toBe("untouched");
  });

  it("returns whatever registerTool returned, so callers can still hold the handle", () => {
    // registerAllTools keeps the returned RegisteredTool for later enable/disable.
    const { server } = fakeServer();
    const shimmed = withStrictToolSchemas(server as unknown as McpServer);
    const handle = shimmed.registerTool("t", { inputSchema: {} } as never, (() => undefined) as never);
    expect(handle).toEqual({ name: "t" });
  });
});
