/**
 * Measure the tools/list payload a client actually receives (T-460).
 *
 * Boots a real McpServer over an in-memory transport, registers the full tool
 * set exactly as `--mcp` does, and weighs the serialized response. Measuring
 * the EMITTED payload rather than summing source strings is the point: the SDK
 * converts zod to JSON Schema, and the conversion is where the bytes actually
 * come from.
 *
 * Run: npx tsx scripts/measure-tools-list.ts [--json] [--per-tool]
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../src/mcp/tools.js";

interface ToolMeasurement {
  readonly name: string;
  readonly total: number;
  readonly description: number;
  readonly schema: number;
  readonly describePolicy: number;
}

/** Bytes of every `description` string nested anywhere inside a schema. */
function describeBytes(node: unknown): number {
  if (Array.isArray(node)) return node.reduce<number>((sum, v) => sum + describeBytes(v), 0);
  if (node === null || typeof node !== "object") return 0;
  let total = 0;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "description" && typeof value === "string") total += Buffer.byteLength(value, "utf8");
    else total += describeBytes(value);
  }
  return total;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const server = new McpServer({ name: "storybloq", version: "0.0.0" });
  // registerAllTools already registers the Bus tools; registering them again
  // throws. Importing registerBusTools here anyway would be a lie about what
  // the payload contains, so the entry point is the single source.
  registerAllTools(server, root);

  const client = new Client({ name: "measure", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.listTools();
  await client.close();

  const tools = result.tools as unknown as Record<string, unknown>[];
  const measurements: ToolMeasurement[] = tools.map((tool) => {
    const description = typeof tool.description === "string" ? tool.description : "";
    const schema = tool.inputSchema ?? {};
    return {
      name: String(tool.name),
      total: Buffer.byteLength(JSON.stringify(tool), "utf8"),
      description: Buffer.byteLength(description, "utf8"),
      schema: Buffer.byteLength(JSON.stringify(schema), "utf8"),
      describePolicy: describeBytes(schema),
    };
  });

  const totalBytes = Buffer.byteLength(JSON.stringify({ tools }), "utf8");
  const sum = (pick: (m: ToolMeasurement) => number) => measurements.reduce((a, m) => a + pick(m), 0);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ totalBytes, toolCount: tools.length, measurements }, null, 2));
    return;
  }

  console.log(`tools/list payload : ${totalBytes} bytes (~${Math.round(totalBytes / 4)} tokens)`);
  console.log(`tools              : ${tools.length}`);
  console.log(`tool descriptions  : ${sum((m) => m.description)} bytes`);
  console.log(`input schemas      : ${sum((m) => m.schema)} bytes`);
  console.log(`  of which .describe(): ${sum((m) => m.describePolicy)} bytes`);

  if (process.argv.includes("--per-tool")) {
    console.log("\nlargest tools:");
    for (const m of [...measurements].sort((a, b) => b.total - a.total).slice(0, 15)) {
      console.log(`  ${String(m.total).padStart(6)}  ${m.name}  (desc ${m.description}, describe ${m.describePolicy})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
