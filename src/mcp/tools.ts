/**
 * MCP tool registration and shared pipeline for claudestory read tools.
 *
 * All 15 tools are read-only and use the same pipeline:
 *   loadProject(root) → build CommandContext → call handler → classify result
 */
import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadProject } from "../core/project-loader.js";
import { ProjectLoaderError, INTEGRITY_WARNING_TYPES } from "../core/errors.js";
import { CliValidationError } from "../cli/helpers.js";
import {
  TICKET_ID_REGEX,
  ISSUE_ID_REGEX,
  TICKET_STATUSES,
  TICKET_TYPES,
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
} from "../models/types.js";
import type { CommandContext, CommandResult } from "../cli/types.js";

import { withProjectLock } from "../core/project-loader.js";

// Handler imports — pure functions, no run.ts side effects
import { handleStatus } from "../cli/commands/status.js";
import { handleValidate } from "../cli/commands/validate.js";
import {
  handleHandoverList,
  handleHandoverLatest,
  handleHandoverGet,
} from "../cli/commands/handover.js";
import { handleBlockerList } from "../cli/commands/blocker.js";
import {
  handleTicketList,
  handleTicketGet,
  handleTicketNext,
  handleTicketBlocked,
} from "../cli/commands/ticket.js";
import {
  handleIssueList,
  handleIssueGet,
} from "../cli/commands/issue.js";
import { handleRecap } from "../cli/commands/recap.js";
import { handleSnapshot } from "../cli/commands/snapshot.js";
import { handleExport } from "../cli/commands/export.js";
import {
  handlePhaseList,
  handlePhaseCurrent,
  handlePhaseTickets,
} from "../cli/commands/phase.js";

// --- Error classification ---

/** Infrastructure error codes that warrant isError: true on MCP results. */
const INFRASTRUCTURE_ERROR_CODES: readonly string[] = [
  "io_error",
  "project_corrupt",
  "version_mismatch",
];

/** MCP tool result shape. */
interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Consistent error text format for all isError: true MCP responses. */
function formatMcpError(code: string, message: string): string {
  return `[${code}] ${message}`;
}

/**
 * Shared pipeline for all MCP read tools.
 *
 * 1. Load project (permissive mode)
 * 2. Build CommandContext with format: "md"
 * 3. Call handler
 * 4. Classify result via errorCode + INFRASTRUCTURE_ERROR_CODES
 * 5. Prepend integrity warning notice if warnings present
 */
export async function runMcpReadTool(
  pinnedRoot: string,
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult,
): Promise<McpToolResult> {
  try {
    const { state, warnings } = await loadProject(pinnedRoot);
    const handoversDir = join(pinnedRoot, ".story", "handovers");
    const ctx: CommandContext = { state, warnings, root: pinnedRoot, handoversDir, format: "md" };

    const result = await handler(ctx);

    // Classify: infrastructure errorCode → isError: true
    if (result.errorCode && INFRASTRUCTURE_ERROR_CODES.includes(result.errorCode)) {
      return {
        content: [{ type: "text", text: formatMcpError(result.errorCode, result.output) }],
        isError: true,
      };
    }

    // Build output with optional integrity warning prefix
    let text = result.output;
    const integrityWarnings = warnings.filter((w) =>
      (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
    );
    if (integrityWarnings.length > 0) {
      text = `Warning: ${integrityWarnings.length} item(s) skipped due to data integrity issues. Run claudestory_validate for details.\n\n${text}`;
    }

    return { content: [{ type: "text", text }] };
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    if (err instanceof CliValidationError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: formatMcpError("io_error", message) }], isError: true };
  }
}

/**
 * Shared pipeline for MCP write tools.
 * Mirrors runMcpReadTool but uses pinnedRoot with withProjectLock for atomicity.
 * The handler receives (root, format) and manages locking internally.
 */
export async function runMcpWriteTool(
  pinnedRoot: string,
  handler: (root: string, format: "md") => Promise<CommandResult>,
): Promise<McpToolResult> {
  try {
    const result = await handler(pinnedRoot, "md");

    if (result.errorCode && INFRASTRUCTURE_ERROR_CODES.includes(result.errorCode)) {
      return {
        content: [{ type: "text", text: formatMcpError(result.errorCode, result.output) }],
        isError: true,
      };
    }

    return { content: [{ type: "text", text: result.output }] };
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    if (err instanceof CliValidationError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message) }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: formatMcpError("io_error", message) }], isError: true };
  }
}

// --- Tool registration ---

export function registerAllTools(server: McpServer, pinnedRoot: string): void {
  // --- No-arg tools ---

  server.registerTool("claudestory_status", {
    description: "Project summary: phase statuses, ticket/issue counts, blockers, current phase",
  }, () => runMcpReadTool(pinnedRoot, handleStatus));

  server.registerTool("claudestory_phase_list", {
    description: "All phases with derived status (complete/inprogress/notstarted)",
  }, () => runMcpReadTool(pinnedRoot, handlePhaseList));

  server.registerTool("claudestory_phase_current", {
    description: "First non-complete phase with its description",
  }, () => runMcpReadTool(pinnedRoot, handlePhaseCurrent));

  server.registerTool("claudestory_ticket_next", {
    description: "Highest-priority unblocked ticket with unblock impact and umbrella progress",
  }, () => runMcpReadTool(pinnedRoot, handleTicketNext));

  server.registerTool("claudestory_ticket_blocked", {
    description: "All blocked tickets with their blocking dependencies",
  }, () => runMcpReadTool(pinnedRoot, handleTicketBlocked));

  server.registerTool("claudestory_handover_list", {
    description: "List handover filenames (newest first)",
  }, () => runMcpReadTool(pinnedRoot, handleHandoverList));

  server.registerTool("claudestory_handover_latest", {
    description: "Content of the most recent handover document",
  }, () => runMcpReadTool(pinnedRoot, handleHandoverLatest));

  server.registerTool("claudestory_blocker_list", {
    description: "All roadmap blockers with dates and status",
  }, () => runMcpReadTool(pinnedRoot, handleBlockerList));

  server.registerTool("claudestory_validate", {
    description: "Reference integrity + schema checks on all .story/ files",
  }, () => runMcpReadTool(pinnedRoot, handleValidate));

  // --- Parameterized tools ---

  server.registerTool("claudestory_phase_tickets", {
    description: "Leaf tickets for a specific phase, sorted by order",
    inputSchema: {
      phaseId: z.string().describe("Phase ID (e.g. p5b, dogfood)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => {
    // Check phase existence — return not_found for unknown phase
    const phaseExists = ctx.state.roadmap.phases.some((p) => p.id === args.phaseId);
    if (!phaseExists) {
      return {
        output: `Phase "${args.phaseId}" not found in roadmap.`,
        exitCode: 1 as const,
        errorCode: "not_found" as const,
      };
    }
    return handlePhaseTickets(args.phaseId, ctx);
  }));

  server.registerTool("claudestory_ticket_list", {
    description: "List leaf tickets with optional filters",
    inputSchema: {
      status: z.enum(TICKET_STATUSES).optional().describe("Filter by status: open, inprogress, complete"),
      phase: z.string().optional().describe("Filter by phase ID"),
      type: z.enum(TICKET_TYPES).optional().describe("Filter by type: task, feature, chore"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => {
    // Check phase existence when filter is provided
    if (args.phase) {
      const phaseExists = ctx.state.roadmap.phases.some((p) => p.id === args.phase);
      if (!phaseExists) {
        return {
          output: `Phase "${args.phase}" not found in roadmap.`,
          exitCode: 1 as const,
          errorCode: "not_found" as const,
        };
      }
    }
    return handleTicketList(
      { status: args.status, phase: args.phase, type: args.type },
      ctx,
    );
  }));

  server.registerTool("claudestory_ticket_get", {
    description: "Get a ticket by ID (includes umbrella tickets)",
    inputSchema: {
      id: z.string().regex(TICKET_ID_REGEX).describe("Ticket ID (e.g. T-001, T-079b)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleTicketGet(args.id, ctx)));

  server.registerTool("claudestory_issue_list", {
    description: "List issues with optional filters",
    inputSchema: {
      status: z.enum(ISSUE_STATUSES).optional().describe("Filter by status: open, inprogress, resolved"),
      severity: z.enum(ISSUE_SEVERITIES).optional().describe("Filter by severity: critical, high, medium, low"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleIssueList({ status: args.status, severity: args.severity }, ctx),
  ));

  server.registerTool("claudestory_issue_get", {
    description: "Get an issue by ID",
    inputSchema: {
      id: z.string().regex(ISSUE_ID_REGEX).describe("Issue ID (e.g. ISS-001)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleIssueGet(args.id, ctx)));

  server.registerTool("claudestory_handover_get", {
    description: "Content of a specific handover document by filename",
    inputSchema: {
      filename: z.string().describe("Handover filename (e.g. 2026-03-20-session.md)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleHandoverGet(args.filename, ctx)));

  // --- T-084: Recap + Snapshot + Export ---

  server.registerTool("claudestory_recap", {
    description: "Session diff — changes since last snapshot + suggested next actions. Shows what changed and what to work on.",
  }, () => runMcpReadTool(pinnedRoot, handleRecap));

  server.registerTool("claudestory_snapshot", {
    description: "Save current project state for session diffs. Creates a snapshot in .story/snapshots/.",
  }, () => runMcpWriteTool(pinnedRoot, handleSnapshot));

  server.registerTool("claudestory_export", {
    description: "Self-contained project document for sharing",
    inputSchema: {
      phase: z.string().optional().describe("Export a single phase by ID"),
      all: z.boolean().optional().describe("Export entire project"),
    },
  }, (args) => {
    if (!args.phase && !args.all) {
      return Promise.resolve({
        content: [{ type: "text" as const, text: formatMcpError("invalid_input", "Specify either phase or all") }],
        isError: true,
      });
    }
    if (args.phase && args.all) {
      return Promise.resolve({
        content: [{ type: "text" as const, text: formatMcpError("invalid_input", "Arguments phase and all are mutually exclusive") }],
        isError: true,
      });
    }
    const mode = args.all ? "all" : "phase";
    const phaseId = args.phase ?? null;
    return runMcpReadTool(pinnedRoot, (ctx) => handleExport(ctx, mode as "all" | "phase", phaseId));
  });
}
