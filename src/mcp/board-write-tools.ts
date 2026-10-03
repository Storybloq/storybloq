import { z } from "zod";
import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { runWithBoardWriteContext } from "../core/board-write-recorder.js";
import { COMMIT_PARAM_DESCRIPTION, MCP_COMMIT_PARAM_DESCRIPTION } from "../core/board-git-state.js";

export { COMMIT_PARAM_DESCRIPTION, MCP_COMMIT_PARAM_DESCRIPTION };

/**
 * ISS-1107: the authoritative classification of MCP tools that write the board.
 *
 * A board write tool is registered through `registerWriteTool`, which adds the
 * optional `commit` argument, strips it before the handler sees it, and runs
 * the handler inside a per-call recorder so `runMcpWriteTool` can report the
 * git state of exactly the files written. A test parses tools.ts and fails on
 * any registration this file does not classify.
 */

/** Tools registered through `registerWriteTool`. */
export const BOARD_WRITE_TOOLS: readonly string[] = [
  "storybloq_snapshot",
  "storybloq_handover_create",
  "storybloq_ticket_create",
  "storybloq_ticket_update",
  "storybloq_ticket_meta_set",
  "storybloq_ticket_meta_unset",
  "storybloq_issue_create",
  "storybloq_issue_update",
  "storybloq_issue_meta_set",
  "storybloq_issue_meta_unset",
  "storybloq_note_create",
  "storybloq_note_update",
  "storybloq_arrangement_coordinate",
  "storybloq_arrangement_create",
  "storybloq_arrangement_update",
  "storybloq_arrangement_rebind",
  "storybloq_ruling_create",
  "storybloq_ruling_supersede",
  "storybloq_ruling_propose",
  "storybloq_ruling_accept",
  "storybloq_ruling_withdraw",
  "storybloq_capability_add",
  "storybloq_capability_update",
  "storybloq_projection_write",
  "storybloq_term_add",
  "storybloq_term_update",
  "storybloq_gate_ack_create",
  "storybloq_gate_ack_contest",
  "storybloq_checkpoint_create",
  "storybloq_checkpoint_attach",
  "storybloq_checkpoint_resolve",
  "storybloq_checkpoint_change",
  "storybloq_checkpoint_reopen",
  "storybloq_checkpoint_retire",
  "storybloq_earmark_reserve",
  "storybloq_earmark_assign",
  "storybloq_earmark_release",
  "storybloq_lesson_create",
  "storybloq_lesson_update",
  "storybloq_lesson_reinforce",
  "storybloq_phase_create",
  "storybloq_node_init",
  "storybloq_node_add",
  "storybloq_node_update",
];

/**
 * Tools that call `runMcpWriteTool` for its envelope only. They get no
 * `commit` argument and never a Git line (no recorder is active for them).
 */
export const WRITE_ENVELOPE_EXEMPT: Readonly<Record<string, string>> = {
  storybloq_selftest: "integration smoke test: creates and deletes throwaway entities; reporting them would describe files that no longer exist",
};

/**
 * Inline handlers that call neither `runMcpReadTool` nor `runMcpWriteTool`,
 * each reviewed: none writes a board item file.
 */
export const MCP_CUSTOM_HANDLERS: Readonly<Record<string, string>> = {
  storybloq_session_report: "reads autonomous session state",
  storybloq_register_subprocess: "writes session-scoped subprocess state (gitignored sessions/)",
  storybloq_unregister_subprocess: "writes session-scoped subprocess state (gitignored sessions/)",
  storybloq_autonomous_guide: "drives the autonomous state machine; session state is gitignored, and its ledger writes are its own FINALIZE commit",
  storybloq_review_lenses_prepare: "prepares a review run under gitignored session state",
  storybloq_review_lenses_synthesize: "synthesizes a review run under gitignored session state",
  storybloq_review_lenses_judge: "judges a review run under gitignored session state",
  storybloq_session_guard: "read-only ownership verdict",
  storybloq_session_intel: "session intelligence read and presence state (gitignored)",
  storybloq_health: "read-only tooling check",
  storybloq_session_milestone: "records a milestone in gitignored session state",
};

/**
 * Registrations whose handler is not an inline arrow or function expression,
 * each with a reason. Empty at ISS-1107: every registration is inline.
 */
export const AST_REVIEWED_FORMS: Readonly<Record<string, string>> = {};

/**
 * Registers a board write tool. The SDK calls a schema-less tool's callback
 * with `(extra)` and a schema tool's with `(args, extra)`; adding `commit`
 * gives every write tool a schema, so a handler that was registered without
 * one is still called with `(extra)` alone.
 */
export function registerWriteTool<InputArgs extends undefined | z.ZodRawShape = undefined>(
  server: McpServer,
  name: string,
  config: { title?: string; description?: string; inputSchema?: InputArgs; annotations?: ToolAnnotations },
  // The SDK callback parameters, with the result left to runMcpWriteTool's own type.
  handler: (...args: Parameters<ToolCallback<InputArgs>>) => unknown,
): RegisteredTool {
  const hadSchema = config.inputSchema !== undefined;
  const inputSchema = {
    ...(config.inputSchema ?? {}),
    commit: z.boolean().optional().describe(MCP_COMMIT_PARAM_DESCRIPTION),
  };
  const call = handler as unknown as (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
  return server.registerTool(name, { ...config, inputSchema }, async (args, extra) => {
    const { commit, ...rest } = (args ?? {}) as Record<string, unknown>;
    const { value } = await runWithBoardWriteContext(name, commit === true, async () =>
      hadSchema ? call(rest, extra) : call(extra));
    return value;
  });
}
