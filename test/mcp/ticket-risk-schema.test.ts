/**
 * Fork (Codex C1): TicketSchema.risk was read by the review pipeline but had no
 * write path. ticket_create / ticket_update now expose an optional `risk` enum.
 * These parse the REAL registered inputSchema (captured via a mock server) so a
 * bad value is rejected by zod rather than silently normalized, and an unset
 * value is accepted (optional).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerAllTools } from "../../src/mcp/tools.js";

function captureToolShape(toolName: string): z.ZodRawShape {
  const tools = new Map<string, { inputSchema: z.ZodRawShape }>();
  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }) => {
      tools.set(name, config);
    },
  } as unknown as Parameters<typeof registerAllTools>[0];
  registerAllTools(server, "/tmp/ticket-risk-schema-test-root");
  const tool = tools.get(toolName);
  if (!tool) throw new Error(`${toolName} was not registered`);
  return tool.inputSchema;
}

describe.each([
  ["storybloq_ticket_create"],
  ["storybloq_ticket_update"],
])("%s risk field schema", (toolName) => {
  const shape = captureToolShape(toolName);
  const riskSchema = shape.risk as z.ZodTypeAny;

  it("exposes an optional risk field", () => {
    expect(riskSchema).toBeDefined();
  });

  it("accepts the canonical risk levels", () => {
    for (const level of ["low", "medium", "high"]) {
      expect(riskSchema.safeParse(level).success).toBe(true);
    }
  });

  it("rejects a non-canonical risk value (not silently normalized)", () => {
    expect(riskSchema.safeParse("banana").success).toBe(false);
    expect(riskSchema.safeParse("HIGH").success).toBe(false);
    expect(riskSchema.safeParse("").success).toBe(false);
  });

  it("accepts an unset risk (optional)", () => {
    expect(riskSchema.safeParse(undefined).success).toBe(true);
  });
});
