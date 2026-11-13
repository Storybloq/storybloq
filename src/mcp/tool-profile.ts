import { z } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getParseErrorMessage } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

/**
 * 1.20 commit 0 (ISS-1433/1435 plan v4.1, section 9): the MCP tool profile.
 *
 * Every byte of `tools/list` is paid in every session. 1.20 adds tools, and
 * the listed payload has a 99,000-byte ceiling that is never raised. So five
 * groups of write tools are listed as one tool each, a "write family" that
 * takes an `action` (the list lives in core/write-families.ts):
 *
 * - storybloq_ruling_write: create, supersede, propose, accept, withdraw
 * - storybloq_earmark_write: reserve, assign, release
 * - storybloq_checkpoint_write: attach, change, create, reopen, resolve, retire
 * - storybloq_capability_write: add, update (amendment 1)
 * - storybloq_term_write: add, update (amendment 1)
 *
 * The eighteen former tools stay REGISTERED exactly as they were (same strict
 * schema, handler, authority checks, refusal codes, transaction and board
 * write classification), so a call by an old name runs the original code. They
 * are only HIDDEN from `tools/list` (see `hideLegacyTools`, applied by the same
 * list decoration that strips `$schema`).
 *
 * A family does not reimplement anything. Its handler takes the action, parses
 * the remaining arguments with the former tool's OWN registered strict schema,
 * and calls the former tool's OWN registered handler. So required fields,
 * unknown-key refusals, authority, revision checks and `commit` are the
 * legacy ones by construction.
 */

export { HIDDEN_LEGACY_TOOLS, WRITE_FAMILIES, type WriteFamily } from "../core/write-families.js";
import { HIDDEN_LEGACY_TOOLS, type WriteFamily } from "../core/write-families.js";

/** Removes the hidden former names from a `tools/list` result, without mutating it. */
export function hideLegacyTools(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return result;
  const kept = tools.filter((t) => !(t && typeof t === "object" && HIDDEN_LEGACY_TOOLS.has((t as { name?: unknown }).name as string)));
  if (kept.length === tools.length) return result;
  return { ...(result as Record<string, unknown>), tools: kept };
}

/** One former tool, as `registerWriteTool` recorded it. */
export interface FamilyMember {
  readonly description?: string;
  /** The strict object the former tool validates with. */
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  /** The exact function registered as the former tool's handler. */
  readonly handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

type Members = ReadonlyMap<string, FamilyMember>;

function memberOf(family: WriteFamily, members: Members, action: string): FamilyMember {
  const tool = members.get(family.prefix + action);
  if (!tool) throw new Error(`${family.name}: ${family.prefix}${action} is not registered`);
  return tool;
}

function shapeOf(tool: FamilyMember): z.ZodRawShape {
  return tool.inputSchema.shape;
}

/** The JSON a client sees for one property, without its description. */
function typeKey(type: z.ZodTypeAny): string {
  const json = toJsonSchemaCompat(z.object({ k: type }) as never, { strictUnions: true, pipeStrategy: "input" }) as {
    properties?: Record<string, Record<string, unknown>>;
  };
  const { description: _d, ...rest } = json.properties?.k ?? {};
  return JSON.stringify(rest);
}

/**
 * The family's listed input shape: `action`, then every member property in
 * first-seen order, all optional (each action's own required fields are
 * enforced by its own schema at dispatch).
 *
 * Where members disagree on a property's schema, the family lists the UNION
 * of their distinct schemas (deduplicated by the JSON a client sees), so any
 * value some member accepts passes the family's own parse; the member's own
 * schema then applies its constraint at dispatch. Where they agree, the one
 * shared schema is listed as is. The longest member description is listed,
 * prefixed with the actions that use the property when not all of them do.
 */
export function familyInputShape(family: WriteFamily, members: Members): z.ZodRawShape {
  const seen = new Map<string, { action: string; type: z.ZodTypeAny }[]>();
  for (const action of family.actions) {
    for (const [key, type] of Object.entries(shapeOf(memberOf(family, members, action)))) {
      const list = seen.get(key) ?? [];
      list.push({ action, type: type as z.ZodTypeAny });
      seen.set(key, list);
    }
  }
  const shape: z.ZodRawShape = {
    action: z.enum(family.actions as [string, ...string[]]),
  };
  for (const [key, uses] of seen) {
    const distinct = new Map<string, z.ZodTypeAny>();
    for (const u of uses) {
      const k = typeKey(u.type);
      if (!distinct.has(k)) distinct.set(k, u.type instanceof z.ZodOptional ? (u.type.unwrap() as z.ZodTypeAny) : u.type);
    }
    const types = [...distinct.values()];
    const accepted: z.ZodTypeAny = types.length === 1 ? types[0]! : z.union(types as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    const description = uses
      .map((u) => u.type.description ?? "")
      .sort((a, b) => b.length - a.length)[0]!;
    const prefix = uses.length < family.actions.length ? `${uses.map((u) => u.action).join("/")}: ` : "";
    const text = prefix + description;
    const optional = accepted.isOptional() ? accepted : accepted.optional();
    shape[key] = text.length > 0 ? optional.describe(text) : optional;
  }
  return shape;
}

/** Every member description is carried verbatim, so no contract cue is lost. */
export function familyDescription(family: WriteFamily, members: Members): string {
  const parts = family.actions.map((a) => `${a}: ${memberOf(family, members, a).description ?? ""}`);
  return `${family.head}: action ${family.actions.join("|")}; the former ${family.prefix}<action> names still work. ${parts.join(" ")}`;
}

/**
 * Runs one family call through the former tool: its own strict schema, then
 * its own handler. A validation failure carries the same text the former name
 * gives (the SDK's own wording, naming the former tool).
 */
export async function dispatchWriteFamily(
  family: WriteFamily,
  members: Members,
  args: Record<string, unknown>,
  extra: unknown,
): Promise<unknown> {
  const { action, ...rest } = args;
  if (typeof action !== "string" || !family.actions.includes(action)) {
    throw new McpError(ErrorCode.InvalidParams, `${family.name}: unknown action ${JSON.stringify(action)}`);
  }
  const name = family.prefix + action;
  const member = memberOf(family, members, action);
  const parsed = await member.inputSchema.safeParseAsync(rest);
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Input validation error: Invalid arguments for tool ${name}: ${getParseErrorMessage(parsed.error)}`,
    );
  }
  return member.handler(parsed.data, extra);
}
