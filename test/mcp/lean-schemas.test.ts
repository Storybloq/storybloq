import { describe, it, expect } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withStrictToolSchemas } from "../../src/mcp/strict-schemas.js";
import { stripSchemaHeaders, withLeanToolSchemas } from "../../src/mcp/lean-schemas.js";

/**
 * T-460, tools/list footprint.
 *
 * The SDK stamps `"$schema":"http://json-schema.org/draft-07/schema#"` onto
 * every converted tool schema, 52 bytes each, on a payload every upfront-loading
 * client pays for in every session. These assert on the EMITTED payload rather
 * than on the SDK's handler map, so they keep meaning across an SDK minor bump:
 * the dependency is pinned with a caret, and the failure mode we care about is
 * "the bytes came back", which only a payload assertion can see.
 */

/** Drives a real client/server pair over an in-memory transport. */
async function listTools(register: (server: McpServer) => void): Promise<Record<string, unknown>[]> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  register(server);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.listTools();
  await client.close();
  return result.tools as unknown as Record<string, unknown>[];
}

const schemaOf = (tool: Record<string, unknown> | undefined) =>
  (tool?.inputSchema ?? {}) as Record<string, unknown>;

describe("tools/list schema trim", () => {
  it("emits $schema on every arg-bearing tool without the shim, which is the cost being removed", async () => {
    const tools = await listTools((server) => {
      server.registerTool("plain", {
        description: "d",
        inputSchema: { id: z.string() },
      }, () => Promise.resolve({ content: [] }));
    });

    expect(schemaOf(tools[0])).toHaveProperty("$schema");
  });

  it("drops $schema while leaving the schema a client actually validates against intact", async () => {
    const tools = await listTools((raw) => {
      const server = withStrictToolSchemas(raw);
      server.registerTool("trimmed", {
        description: "d",
        inputSchema: { id: z.string(), note: z.string().optional() },
      }, () => Promise.resolve({ content: [] }));
    });

    const schema = schemaOf(tools[0]);
    expect(schema).not.toHaveProperty("$schema");
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toEqual(["id", "note"]);
    expect(schema.required).toEqual(["id"]);
    // The strict shim publishes this and relies on it staying published.
    expect(schema.additionalProperties).toBe(false);
  });

  it("trims tools registered LATE, after the degraded surface is swapped out", async () => {
    // storybloq_init removes the degraded tools and registers the full set over
    // the same server. The SDK installs its tools/list handler once, on the
    // first registration, so a shim that only saw the first burst would leave
    // every post-init tool carrying the header.
    const tools = await listTools((raw) => {
      const server = withStrictToolSchemas(raw);
      const degraded = server.registerTool("degraded", {
        description: "d",
        inputSchema: { format: z.string().optional() },
      }, () => Promise.resolve({ content: [] }));

      degraded.remove();

      // Re-applying over the same server is what the real init path does.
      withStrictToolSchemas(raw).registerTool("full", {
        description: "d",
        inputSchema: { id: z.string() },
      }, () => Promise.resolve({ content: [] }));
    });

    expect(tools.map((t) => t.name)).toEqual(["full"]);
    expect(schemaOf(tools[0])).not.toHaveProperty("$schema");
  });

  it("leaves a zero-argument tool listable", async () => {
    const tools = await listTools((raw) => {
      withStrictToolSchemas(raw).registerTool("bare", {
        description: "d",
      }, () => Promise.resolve({ content: [] }));
    });

    expect(tools).toHaveLength(1);
    expect(schemaOf(tools[0])).not.toHaveProperty("$schema");
  });

  it("declines rather than throwing when a tool was already registered", () => {
    // Failure has to degrade to "the bytes come back", never to a dead server.
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool("early", {
      description: "d",
      inputSchema: { id: z.string() },
    }, () => Promise.resolve({ content: [] }));

    expect(() => withLeanToolSchemas(server)).not.toThrow();
  });
});

describe("stripSchemaHeaders", () => {
  it("does not mutate the result it was handed", () => {
    const original = { tools: [{ name: "t", inputSchema: { type: "object", $schema: "x" } }] };
    const stripped = stripSchemaHeaders(original) as { tools: { inputSchema: object }[] };

    expect(original.tools[0].inputSchema).toHaveProperty("$schema");
    expect(stripped.tools[0].inputSchema).not.toHaveProperty("$schema");
  });

  it("strips outputSchema too, which we do not register today but the SDK supports", () => {
    const stripped = stripSchemaHeaders({
      tools: [{ name: "t", inputSchema: { $schema: "x", type: "object" }, outputSchema: { $schema: "x", type: "object" } }],
    }) as { tools: Record<string, Record<string, unknown>>[] };

    expect(stripped.tools[0].inputSchema).not.toHaveProperty("$schema");
    expect(stripped.tools[0].outputSchema).not.toHaveProperty("$schema");
  });

  it("passes through a payload that is not a tool list", () => {
    for (const value of [undefined, null, "text", 42, {}, { tools: "not-an-array" }]) {
      expect(() => stripSchemaHeaders(value)).not.toThrow();
    }
    expect(stripSchemaHeaders({ nextCursor: "c" })).toEqual({ nextCursor: "c" });
  });

  it("leaves a nested $schema alone, because the emitter only sets it at the root", () => {
    const stripped = stripSchemaHeaders({
      tools: [{ name: "t", inputSchema: { $schema: "x", properties: { inner: { $schema: "keep" } } } }],
    }) as { tools: { inputSchema: { properties: { inner: object } } }[] };

    expect(stripped.tools[0].inputSchema).not.toHaveProperty("$schema");
    expect(stripped.tools[0].inputSchema.properties.inner).toHaveProperty("$schema");
  });
});
