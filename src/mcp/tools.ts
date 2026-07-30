/**
 * MCP tool registration and shared pipeline for storybloq tools.
 *
 * Storybloq tools use a shared read/write pipeline:
 *   loadProject(root) → build CommandContext → call handler → classify result
 */
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { NODE_NAME_REGEX } from "../models/federation-config.js";
import { CROSS_NODE_REF_REGEX } from "../models/ticket.js";
import { resolveNodeRoot, checkNodeWritePermission, readOrchestratorConfig, type McpToolResult } from "./node-resolution.js";
import { initProject } from "../core/init.js";
import { handleNodeList } from "../cli/commands/node.js";
import { resolveNodePath } from "../federation/resolver.js";
import { TARGET_WORK_ID_REGEX, LENS_FINDING_DISPOSITIONS } from "../autonomous/session-types.js";
import { CLIENT_TASK_ID_PATTERN } from "../autonomous/client-profile.js";
import { evaluateSessionGuard } from "../core/session-guard.js";
import { findActiveSessionMinimal, readSessionResilient, sessionDir, isLeaseExpired } from "../autonomous/session.js";
import { withStalenessNote } from "../autonomous/binary-staleness.js";
import { touchLastMcpCallFile } from "../autonomous/liveness.js";
import { registerBusTools } from "./bus-tools.js";
import { withStrictToolSchemas } from "./strict-schemas.js";

// ISS-407: Cache active session dir to avoid O(n) directory scan on every MCP call.
// Expires after 30s -- long enough to amortize hot-path calls, short enough
// to detect session transitions within a reasonable window.
const _SESSION_CACHE_TTL_MS = 30_000;
let _cachedSessionDir: string | null = null;
let _cachedSessionAt = 0;

export function touchMcpLiveness(pinnedRoot: string): void {
  const now = Date.now();
  if (_cachedSessionDir && now - _cachedSessionAt < _SESSION_CACHE_TTL_MS) {
    touchLastMcpCallFile(_cachedSessionDir);
    return;
  }
  const s = findActiveSessionMinimal(pinnedRoot);
  if (s) {
    _cachedSessionDir = sessionDir(pinnedRoot, s.sessionId);
    _cachedSessionAt = now;
    touchLastMcpCallFile(_cachedSessionDir);
  } else {
    _cachedSessionDir = null;
  }
}
import {
  SUBPROCESS_CATEGORIES,
  sanitizeCmd,
  registerSubprocess,
  unregisterSubprocess,
} from "../autonomous/subprocess-registry.js";
import { handlePrepare, handleSynthesize, handleJudge, generateIssueKey, generateReviewFilingKey } from "../autonomous/lens-harness/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadProject } from "../core/project-loader.js";
import { ProjectLoaderError, INTEGRITY_WARNING_TYPES } from "../core/errors.js";
import { scanLedgerIntegrity } from "../core/ledger-integrity.js";
import { formatLedgerIntegrity } from "../core/output-formatter.js";
import { CliValidationError } from "../cli/helpers.js";
import {
  TICKET_ID_REGEX,
  TICKET_CANONICAL_ID_REGEX,
  NOTE_ID_REGEX,
  LESSON_ID_REGEX,
  NoteIdSchema,
  LessonIdSchema,
  TicketRefSchema,
  IssueRefSchema,
  TICKET_STATUSES,
  TICKET_TYPES,
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
  NOTE_STATUSES,
  LESSON_STATUSES,
  LESSON_SOURCES,
  type OutputFormat,
} from "../models/types.js";
import type { CommandContext, CommandResult } from "../cli/types.js";
import {
  IssueDedupeKeySchema,
  IssueSourceRefInputSchema,
} from "../models/issue.js";

import { withProjectLock } from "../core/project-loader.js";

// Handler imports — pure functions, no run.ts side effects
import { handleStatus } from "../cli/commands/status.js";
import { handleValidateWithSourceRefs } from "../cli/commands/validate.js";
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
  handleTicketCreate,
  handleTicketUpdate,
  handleTicketMetaGet,
  handleTicketMetaSet,
  handleTicketMetaUnset,
} from "../cli/commands/ticket.js";
import {
  handleIssueList,
  handleIssueGet,
  handleIssueCreate,
  handleIssueUpdate,
  handleIssueMetaGet,
  handleIssueMetaSet,
  handleIssueMetaUnset,
} from "../cli/commands/issue.js";
import { handleRecap } from "../cli/commands/recap.js";
import {
  handleNoteList,
  handleNoteGet,
  handleNoteCreate,
  handleNoteUpdate,
} from "../cli/commands/note.js";
import {
  handleLessonList,
  handleLessonGet,
  handleLessonDigest,
  handleLessonCreate,
  handleLessonUpdate,
  handleLessonReinforce,
} from "../cli/commands/lesson.js";
import { handleRecommend } from "../cli/commands/recommend.js";
import { handleSnapshot } from "../cli/commands/snapshot.js";
import { handleExport } from "../cli/commands/export.js";
import { handleSelftest } from "../cli/commands/selftest.js";
import { handleHandoverCreate } from "../cli/commands/handover.js";
import { handleAutonomousGuide } from "../autonomous/guide.js";
import { handleSessionReport } from "../cli/commands/session-report.js";
import {
  handlePhaseList,
  handlePhaseCurrent,
  handlePhaseTickets,
  handlePhaseCreate,
} from "../cli/commands/phase.js";

// --- Error classification ---

/** Infrastructure error codes that warrant isError: true on MCP results. */
const INFRASTRUCTURE_ERROR_CODES: readonly string[] = [
  "io_error",
  "project_corrupt",
  "version_mismatch",
];


/** Consistent error format for all isError: true MCP read responses. */
function formatMcpError(code: string, message: string, format: OutputFormat = "md"): string {
  if (format === "json") {
    return JSON.stringify({ version: 1, error: { code, message } }, null, 2);
  }
  return `[${code}] ${message}`;
}

/**
 * Shared pipeline for all MCP read tools.
 *
 * 1. Load project (permissive mode)
 * 2. Build CommandContext with the requested format (default: "md")
 * 3. Call handler
 * 4. Classify result via errorCode + INFRASTRUCTURE_ERROR_CODES
 * 5. Prepend integrity warning notice if warnings present
 */
export async function runMcpReadTool(
  pinnedRoot: string,
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult,
  effectiveRoot?: string,
  format: OutputFormat = "md",
): Promise<McpToolResult> {
  // Liveness is always anchored to pinnedRoot (the orchestrator), not the effective node root.
  try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
  const loadRoot = effectiveRoot ?? pinnedRoot;
  try {
    const { state, warnings } = await loadProject(loadRoot);
    const handoversDir = join(loadRoot, ".story", "handovers");
    const ctx: CommandContext = { state, warnings, root: loadRoot, handoversDir, format };

    const result = await handler(ctx);

    // Classify: infrastructure errorCode → isError: true
    if (result.errorCode && INFRASTRUCTURE_ERROR_CODES.includes(result.errorCode)) {
      return {
        content: [{ type: "text", text: formatMcpError(result.errorCode, result.output, format) }],
        isError: true,
      };
    }

    // Build output with optional integrity warning prefix. Surface the
    // specific offenders (file path + message) so the user or agent can
    // investigate immediately instead of having to re-run
    // storybloq_validate. C3 phantom-ticket cases (e.g. a stray T-052
    // file from an interrupted session) will name themselves here.
    let text = result.output;
    const integrityWarnings = warnings.filter((w) =>
      (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
    );
    if (integrityWarnings.length > 0) {
      if (format === "json") {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        text = JSON.stringify({
          ...parsed,
          warnings: integrityWarnings.map((warning) => ({
            type: warning.type,
            file: warning.file,
            message: warning.message,
          })),
          partial: true,
        }, null, 2);
      } else {
        const details = integrityWarnings
          .slice(0, 5)
          .map((w) => `  - ${w.file}: ${w.message}`)
          .join("\n");
        const more = integrityWarnings.length > 5
          ? `\n  ... and ${integrityWarnings.length - 5} more. Run storybloq_validate for the full list.`
          : "";
        text = `Warning: ${integrityWarnings.length} item(s) skipped due to data integrity issues:\n${details}${more}\n\n${text}`;
      }
    }

    return { content: [{ type: "text", text }] };
  } catch (err: unknown) {
    if (err instanceof ProjectLoaderError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message, format) }], isError: true };
    }
    if (err instanceof CliValidationError) {
      return { content: [{ type: "text", text: formatMcpError(err.code, err.message, format) }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: formatMcpError("io_error", message, format) }], isError: true };
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
  effectiveRoot?: string,
): Promise<McpToolResult> {
  try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
  const writeRoot = effectiveRoot ?? pinnedRoot;
  try {
    const result = await handler(writeRoot, "md");

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

const nodeParam = z.string().regex(NODE_NAME_REGEX).optional().describe("Node name (orchestrator only). When provided, operates on that node's .story/ instead of the orchestrator's.");

function resolveEffectiveRoot(pinnedRoot: string, nodeName?: string): { root: string } | McpToolResult {
  if (!nodeName) return { root: pinnedRoot };
  const resolved = resolveNodeRoot(pinnedRoot, nodeName);
  if (!resolved.ok) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }
  return { root: resolved.root };
}

function resolveEffectiveRootForWrite(pinnedRoot: string, nodeName?: string): { root: string } | McpToolResult {
  if (!nodeName) return { root: pinnedRoot };
  const config = readOrchestratorConfig(pinnedRoot);
  if (!config) {
    return { content: [{ type: "text" as const, text: "Cannot read orchestrator config" }], isError: true };
  }
  if (!checkNodeWritePermission(pinnedRoot, config)) {
    return {
      content: [{ type: "text" as const, text: "Node writes disabled. Set `federation.allowNodeWrites: true` in .story/config.json to enable cross-node writes from this orchestrator." }],
      isError: true,
    };
  }
  const resolved = resolveNodeRoot(pinnedRoot, nodeName, config);
  if (!resolved.ok) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }
  return { root: resolved.root };
}

export function registerAllTools(rawServer: McpServer, pinnedRoot: string): void {
  // ISS-892: every registration below goes through the strict shim, so an
  // argument the tool does not implement is an error naming the key rather than a
  // silently dropped one. Shadowing the parameter is deliberate: there is no
  // unshimmed `server` left in scope to reach for by accident.
  const server = withStrictToolSchemas(rawServer);

  // D6: the five Bus tools always register for a full project (degraded no-project
  // mode keeps its two-tool surface elsewhere). When Bus is disabled or the
  // runtime is not initialized, the handlers return setup guidance pointing at
  // `storybloq bus setup`, so a CLI `bus setup` makes the already-running server
  // usable with no restart and no tool-list change.
  registerBusTools(server, pinnedRoot, () => touchMcpLiveness(pinnedRoot));

  // --- No-arg tools ---

  server.registerTool("storybloq_status", {
    description: "Project summary: phase statuses, ticket/issue counts, blockers, current phase",
    inputSchema: {
      format: z.enum(["md", "json"]).optional().describe("Output format (default: md)"),
    },
  }, async (args) => {
    const format = args.format ?? "md";
    const result = await runMcpReadTool(pinnedRoot, handleStatus, undefined, format);
    // ISS-570 G2: prepend update-available notice so /story's first MCP
    // call surfaces 'newer storybloq available' proactively. Synchronous
    // cache read; a background refresh is kicked off so the NEXT status
    // call has fresh data. Dev builds skip the check.
    try {
      const { readUpdateCacheSync, refreshUpdateCacheInBackground } = await import("../core/update-check.js");
      const running = process.env.STORYBLOQ_VERSION ?? "0.0.0-dev";
      const info = readUpdateCacheSync(running);
      refreshUpdateCacheInBackground();
      if (format === "md" && info?.updateAvailable && result.content[0]?.type === "text") {
        const banner = `A newer storybloq is available (v${info.latestVersion}). Run \`npm install -g @storybloq/storybloq@latest\` -- the CLI will auto-refresh the /story skill on next invocation.\n\n`;
        return {
          ...result,
          content: [{ type: "text" as const, text: banner + (result.content[0] as { text: string }).text }],
        };
      }
    } catch {
      // Update check is best-effort; never block status output.
    }
    return result;
  });

  server.registerTool("storybloq_phase_list", {
    description: "All phases with derived status (complete/inprogress/notstarted)",
  }, () => runMcpReadTool(pinnedRoot, handlePhaseList));

  server.registerTool("storybloq_phase_current", {
    description: "First non-complete phase with its description",
  }, () => runMcpReadTool(pinnedRoot, handlePhaseCurrent));

  server.registerTool("storybloq_ticket_next", {
    description: "Highest-priority unblocked ticket(s) with unblock impact and umbrella progress",
    inputSchema: {
      count: z.number().int().min(1).max(10).optional()
        .describe("Number of candidates to return (default: 1)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleTicketNext(ctx, args.count ?? 1),
  ));

  server.registerTool("storybloq_ticket_blocked", {
    description: "All blocked tickets with their blocking dependencies",
  }, () => runMcpReadTool(pinnedRoot, handleTicketBlocked));

  server.registerTool("storybloq_handover_list", {
    description: "List handover filenames (newest first)",
  }, () => runMcpReadTool(pinnedRoot, handleHandoverList));

  server.registerTool("storybloq_handover_latest", {
    description: "Content of the most recent handover document(s)",
    inputSchema: {
      count: z.number().int().min(1).max(10).optional().describe("Number of recent handovers to return (default: 1)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleHandoverLatest(ctx, args.count ?? 1),
  ));

  server.registerTool("storybloq_blocker_list", {
    description: "All roadmap blockers with dates and status",
  }, () => runMcpReadTool(pinnedRoot, handleBlockerList));

  registerSessionGuardTool(server, pinnedRoot);

  server.registerTool("storybloq_validate", {
    description: "Reference integrity + schema checks. The integrity preflight works even when critical JSON prevents normal project loading.",
    inputSchema: {
      format: z.enum(["md", "json"]).optional().describe("Output format (default: md)"),
      integrityOnly: z.boolean().optional().describe("Scan all .story JSON without loading project state"),
    },
  }, async (args) => {
    const format = args.format ?? "md";
    const integrity = await scanLedgerIntegrity(pinnedRoot, {
      includeAuxiliary: args.integrityOnly === true,
    });
    if (args.integrityOnly || !integrity.valid) {
      try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
      return {
        content: [{ type: "text" as const, text: formatLedgerIntegrity(integrity, format) }],
        ...(integrity.criticalErrorCount > 0 ? { isError: true } : {}),
      };
    }
    return runMcpReadTool(pinnedRoot, handleValidateWithSourceRefs, undefined, format);
  });

  // --- Parameterized tools ---

  server.registerTool("storybloq_phase_tickets", {
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

  server.registerTool("storybloq_ticket_list", {
    description: "List leaf tickets with optional filters",
    inputSchema: {
      status: z.enum(TICKET_STATUSES).optional().describe("Filter by status: open, inprogress, complete"),
      phase: z.string().optional().describe("Filter by phase ID"),
      type: z.enum(TICKET_TYPES).optional().describe("Filter by type: task, feature, chore"),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRoot(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpReadTool(pinnedRoot, (ctx) => {
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
    }, eff.root);
  });

  server.registerTool("storybloq_ticket_get", {
    description: "Get a ticket by ID (includes umbrella tickets)",
    inputSchema: {
      id: z.string().refine((v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v), "Ticket ID").describe("Ticket ID (e.g. T-001, T-079b, t-[canonical])"),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRoot(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpReadTool(pinnedRoot, (ctx) => handleTicketGet(args.id, ctx), eff.root);
  });

  server.registerTool("storybloq_ticket_meta_get", {
    description: "Get custom passthrough metadata for a ticket. Omitting path returns all custom metadata.",
    inputSchema: {
      id: z.string().refine((v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v), "Ticket ID").describe("Ticket ID (e.g. T-001, T-079b, t-[canonical])"),
      path: z.string().optional().describe("Custom metadata path, using dot notation for nested values"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleTicketMetaGet(args.id, args.path, ctx)));

  server.registerTool("storybloq_issue_list", {
    description: "List issues with optional filters",
    inputSchema: {
      status: z.enum(ISSUE_STATUSES).optional().describe("Filter by status: open, inprogress, resolved"),
      severity: z.enum(ISSUE_SEVERITIES).optional().describe("Filter by severity: critical, high, medium, low"),
      component: z.string().optional().describe("Filter by component name"),
      phase: z.string().optional().describe("Filter by phase ID"),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRoot(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpReadTool(pinnedRoot, (ctx) => {
      // ISS-739: validate phase at the tool layer like storybloq_ticket_list;
      // the CLI handler itself stays unvalidated for parity with ticket list.
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
      return handleIssueList(
        { status: args.status, severity: args.severity, component: args.component, phase: args.phase },
        ctx,
      );
    }, eff.root);
  });

  server.registerTool("storybloq_issue_get", {
    description: "Get an issue by ID",
    inputSchema: {
      id: IssueRefSchema.describe("Issue ID (e.g. ISS-001, i-[canonical])"),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRoot(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpReadTool(pinnedRoot, (ctx) => handleIssueGet(args.id, ctx), eff.root);
  });

  server.registerTool("storybloq_issue_meta_get", {
    description: "Get custom passthrough metadata for an issue. Omitting path returns all custom metadata.",
    inputSchema: {
      id: IssueRefSchema.describe("Issue ID (e.g. ISS-001, i-[canonical])"),
      path: z.string().optional().describe("Custom metadata path, using dot notation for nested values"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleIssueMetaGet(args.id, args.path, ctx)));

  server.registerTool("storybloq_handover_get", {
    description: "Content of a specific handover document by filename",
    inputSchema: {
      filename: z.string().describe("Handover filename (e.g. 2026-03-20-session.md)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleHandoverGet(args.filename, ctx)));

  // --- T-084: Recap + Snapshot + Export ---

  server.registerTool("storybloq_recap", {
    description: "Session diff — changes since last snapshot + suggested next actions. Shows what changed and what to work on.",
  }, () => runMcpReadTool(pinnedRoot, handleRecap));

  server.registerTool("storybloq_recommend", {
    description: "Context-aware ranked work suggestions mixing tickets and issues",
    inputSchema: {
      count: z.number().int().min(1).max(10).optional()
        .describe("Number of recommendations (default: 5)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleRecommend(ctx, args.count ?? 5),
  ));

  server.registerTool("storybloq_snapshot", {
    description: "Save current project state for session diffs. Creates a snapshot in .story/snapshots/.",
  }, () => runMcpWriteTool(pinnedRoot, handleSnapshot));

  server.registerTool("storybloq_export", {
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

  server.registerTool("storybloq_handover_create", {
    description: "Create a handover document from markdown content",
    inputSchema: {
      content: z.string().describe("Markdown content of the handover"),
      slug: z.string().optional().describe("Slug for filename (e.g. phase5b-wrapup). Default: session"),
    },
  }, (args) => {
    if (!args.content?.trim()) {
      return Promise.resolve({
        content: [{ type: "text" as const, text: formatMcpError("invalid_input", "Handover content is empty") }],
        isError: true,
      });
    }
    return runMcpWriteTool(pinnedRoot, (root) =>
      handleHandoverCreate(args.content, args.slug ?? "session", "md", root),
    );
  });

  // --- Ticket write tools ---

  server.registerTool("storybloq_ticket_create", {
    description: "Create a new ticket. ID assignment is serialized under the project lock, so concurrent creates that acquire the lock receive distinct sequential IDs.",
    inputSchema: {
      title: z.string().describe("Ticket title"),
      type: z.enum(TICKET_TYPES).describe("Ticket type: task, feature, chore"),
      phase: z.string().optional().describe("Phase ID"),
      description: z.string().optional().describe("Ticket description"),
      blockedBy: z.array(TicketRefSchema).optional().describe("IDs of blocking tickets"),
      parentTicket: TicketRefSchema.optional().describe("Parent ticket ID (makes this a sub-ticket)"),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRootForWrite(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpWriteTool(pinnedRoot, (root, format) =>
    handleTicketCreate(
      {
        title: args.title,
        type: args.type,
        phase: args.phase ?? null,
        description: args.description ?? "",
        blockedBy: args.blockedBy ?? [],
        parentTicket: args.parentTicket ?? null,
      },
      format,
      root,
    ), eff.root);
  });

  server.registerTool("storybloq_ticket_update", {
    description: "Update an existing ticket",
    inputSchema: {
      id: z.string().refine((v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v), "Ticket ID").describe("Ticket ID (e.g. T-001, t-[canonical])"),
      status: z.enum(TICKET_STATUSES).optional().describe("New status: open, inprogress, complete"),
      title: z.string().optional().describe("New title"),
      type: z.enum(TICKET_TYPES).optional().describe("New type: task, feature, chore"),
      order: z.number().int().optional().describe("New sort order"),
      description: z.string().optional().describe("New description"),
      phase: z.string().nullable().optional().describe("New phase ID (null to clear)"),
      parentTicket: TicketRefSchema.nullable().optional().describe("Parent ticket ID (null to clear)"),
      blockedBy: z.array(TicketRefSchema).optional().describe("IDs of blocking tickets"),
      crossNodeBlockedBy: z.array(z.string().regex(CROSS_NODE_REF_REGEX)).nullable().optional().describe("Cross-node blocking refs (e.g. engine:T-061). Null to clear."),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRootForWrite(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpWriteTool(pinnedRoot, (root, format) =>
      handleTicketUpdate(
        args.id,
        {
          status: args.status,
          title: args.title,
          type: args.type,
          order: args.order,
          description: args.description,
          phase: args.phase,
          parentTicket: args.parentTicket,
          blockedBy: args.blockedBy,
          crossNodeBlockedBy: args.crossNodeBlockedBy,
        },
        format,
        root,
      ),
    eff.root);
  });

  server.registerTool("storybloq_ticket_meta_set", {
    description: "Set custom passthrough metadata on a ticket. Core ticket fields are protected.",
    inputSchema: {
      id: z.string().refine((v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v), "Ticket ID").describe("Ticket ID (e.g. T-001, t-[canonical])"),
      path: z.string().describe("Custom metadata path, using dot notation for nested values"),
      value: z.unknown().describe("JSON-compatible metadata value"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleTicketMetaSet(args.id, args.path, args.value, format, root),
  ));

  server.registerTool("storybloq_ticket_meta_unset", {
    description: "Unset custom passthrough metadata on a ticket. Core ticket fields are protected.",
    inputSchema: {
      id: z.string().refine((v) => TICKET_ID_REGEX.test(v) || TICKET_CANONICAL_ID_REGEX.test(v), "Ticket ID").describe("Ticket ID (e.g. T-001, t-[canonical])"),
      path: z.string().describe("Custom metadata path, using dot notation for nested values"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleTicketMetaUnset(args.id, args.path, format, root),
  ));

  // --- Issue write tools ---

  server.registerTool("storybloq_issue_create", {
    description: "Create a new issue. ID assignment is serialized under the project lock, so concurrent creates that acquire the lock receive distinct sequential IDs.",
    inputSchema: {
      title: z.string().describe("Issue title"),
      severity: z.enum(ISSUE_SEVERITIES).describe("Issue severity: critical, high, medium, low"),
      impact: z.string().describe("Impact description"),
      components: z.array(z.string()).optional().describe("Affected components"),
      relatedTickets: z.array(TicketRefSchema).optional().describe("Related ticket IDs"),
      location: z.array(z.string()).optional().describe("File locations"),
      sourceRefs: z.array(IssueSourceRefInputSchema).optional().describe("Structured source provenance. Missing hashes are captured from the reviewed revision or working tree."),
      dedupeKey: IssueDedupeKeySchema.optional().describe("Idempotency key. A repeated create returns the existing issue."),
      createdBy: z.string().min(1).max(256).optional().describe("Reviewer or agent attribution"),
      phase: z.string().optional().describe("Phase ID"),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRootForWrite(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpWriteTool(pinnedRoot, (root, format) =>
      handleIssueCreate(
        {
          title: args.title,
          severity: args.severity,
          impact: args.impact,
          components: args.components ?? [],
          relatedTickets: args.relatedTickets ?? [],
          location: args.location ?? [],
          sourceRefs: args.sourceRefs,
          dedupeKey: args.dedupeKey,
          createdBy: args.createdBy,
          phase: args.phase,
        },
        format,
        root,
      ),
    eff.root);
  });

  server.registerTool("storybloq_issue_update", {
    description: "Update an existing issue",
    inputSchema: {
      id: IssueRefSchema.describe("Issue ID (e.g. ISS-001, i-[canonical])"),
      status: z.enum(ISSUE_STATUSES).optional().describe("New status: open, inprogress, resolved"),
      title: z.string().optional().describe("New title"),
      severity: z.enum(ISSUE_SEVERITIES).optional().describe("New severity"),
      impact: z.string().optional().describe("New impact description"),
      resolution: z.string().nullable().optional().describe("Resolution description (null to clear)"),
      components: z.array(z.string()).optional().describe("Affected components"),
      relatedTickets: z.array(TicketRefSchema).optional().describe("Related ticket IDs"),
      location: z.array(z.string()).optional().describe("File locations"),
      sourceRefs: z.array(IssueSourceRefInputSchema).optional().describe("Replacement structured source provenance"),
      order: z.number().int().optional().describe("New sort order"),
      phase: z.string().nullable().optional().describe("New phase ID (null to clear)"),
      node: nodeParam,
    },
  }, (args) => {
    const eff = resolveEffectiveRootForWrite(pinnedRoot, args.node);
    if ("content" in eff) return eff;
    return runMcpWriteTool(pinnedRoot, (root, format) =>
      handleIssueUpdate(
        args.id,
        {
          status: args.status,
          title: args.title,
          severity: args.severity,
          impact: args.impact,
          resolution: args.resolution,
          components: args.components,
          relatedTickets: args.relatedTickets,
          location: args.location,
          sourceRefs: args.sourceRefs,
          order: args.order,
          phase: args.phase,
        },
        format,
        root,
      ),
    eff.root);
  });

  server.registerTool("storybloq_issue_meta_set", {
    description: "Set custom passthrough metadata on an issue. Core issue fields are protected.",
    inputSchema: {
      id: IssueRefSchema.describe("Issue ID (e.g. ISS-001, i-[canonical])"),
      path: z.string().describe("Custom metadata path, using dot notation for nested values"),
      value: z.unknown().describe("JSON-compatible metadata value"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleIssueMetaSet(args.id, args.path, args.value, format, root),
  ));

  server.registerTool("storybloq_issue_meta_unset", {
    description: "Unset custom passthrough metadata on an issue. Core issue fields are protected.",
    inputSchema: {
      id: IssueRefSchema.describe("Issue ID (e.g. ISS-001, i-[canonical])"),
      path: z.string().describe("Custom metadata path, using dot notation for nested values"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleIssueMetaUnset(args.id, args.path, format, root),
  ));

  // --- Note tools ---

  server.registerTool("storybloq_note_list", {
    description: "List notes with optional status/tag filters",
    inputSchema: {
      status: z.enum(NOTE_STATUSES).optional().describe("Filter by status: active, archived"),
      tag: z.string().optional().describe("Filter by tag"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleNoteList({ status: args.status, tag: args.tag }, ctx),
  ));

  server.registerTool("storybloq_note_get", {
    description: "Get a note by ID",
    inputSchema: {
      id: NoteIdSchema.describe("Note ID (e.g. N-001 or n-[canonical])"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleNoteGet(args.id, ctx)));

  server.registerTool("storybloq_note_create", {
    description: "Create a new note. ID assignment is serialized under the project lock, so concurrent creates that acquire the lock receive distinct sequential IDs.",
    inputSchema: {
      content: z.string().describe("Note content"),
      title: z.string().optional().describe("Note title"),
      tags: z.array(z.string()).optional().describe("Tags for the note"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleNoteCreate(
      {
        content: args.content,
        title: args.title ?? null,
        tags: args.tags ?? [],
      },
      format,
      root,
    ),
  ));

  server.registerTool("storybloq_note_update", {
    description: "Update an existing note",
    inputSchema: {
      id: NoteIdSchema.describe("Note ID (e.g. N-001 or n-[canonical])"),
      content: z.string().optional().describe("New content"),
      title: z.string().nullable().optional().describe("New title (null to clear)"),
      tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
      status: z.enum(NOTE_STATUSES).optional().describe("New status: active, archived"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleNoteUpdate(
      args.id,
      {
        content: args.content,
        title: args.title,
        tags: args.tags,
        clearTags: args.tags !== undefined && args.tags.length === 0,
        status: args.status,
      },
      format,
      root,
    ),
  ));

  // --- Lesson tools ---

  server.registerTool("storybloq_lesson_list", {
    description: "List lessons with optional status/tag/source filters",
    inputSchema: {
      status: z.enum(LESSON_STATUSES).optional().describe("Filter by status: active, deprecated, superseded"),
      tag: z.string().optional().describe("Filter by tag"),
      source: z.enum(LESSON_SOURCES).optional().describe("Filter by source: review, correction, postmortem, manual"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleLessonList({ status: args.status, tag: args.tag, source: args.source }, ctx),
  ));

  server.registerTool("storybloq_lesson_get", {
    description: "Get a lesson by ID",
    inputSchema: {
      id: LessonIdSchema.describe("Lesson ID (e.g. L-001 or l-[canonical])"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleLessonGet(args.id, ctx)));

  server.registerTool("storybloq_lesson_digest", {
    description: "Compiled ranked digest of active lessons — primary read interface for context loading",
    inputSchema: {},
  }, () => runMcpReadTool(pinnedRoot, (ctx) => handleLessonDigest(ctx)));

  server.registerTool("storybloq_lesson_create", {
    description: "Create a new lesson. ID assignment is serialized under the project lock, so concurrent creates that acquire the lock receive distinct sequential IDs.",
    inputSchema: {
      title: z.string().describe("Lesson title — concise lesson name"),
      content: z.string().describe("The actionable rule (1-3 sentences)"),
      context: z.string().describe("What happened that produced this lesson (evidence, ticket/issue refs)"),
      source: z.enum(LESSON_SOURCES).describe("Lesson source: review, correction, postmortem, manual"),
      tags: z.array(z.string()).optional().describe("Tags for the lesson"),
      supersedes: LessonIdSchema.optional().describe("ID of lesson this supersedes"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleLessonCreate(
      {
        title: args.title,
        content: args.content,
        context: args.context,
        source: args.source,
        tags: args.tags ?? [],
        supersedes: args.supersedes ?? null,
      },
      format,
      root,
    ),
  ));

  server.registerTool("storybloq_lesson_update", {
    description: "Update an existing lesson",
    inputSchema: {
      id: LessonIdSchema.describe("Lesson ID (e.g. L-001 or l-[canonical])"),
      title: z.string().optional().describe("New title"),
      content: z.string().optional().describe("New content"),
      context: z.string().optional().describe("New context"),
      tags: z.array(z.string()).optional().describe("New tags (replaces existing)"),
      status: z.enum(LESSON_STATUSES).optional().describe("New status: active, deprecated, superseded"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleLessonUpdate(
      args.id,
      {
        title: args.title,
        content: args.content,
        context: args.context,
        tags: args.tags,
        clearTags: args.tags !== undefined && args.tags.length === 0,
        status: args.status,
      },
      format,
      root,
    ),
  ));

  server.registerTool("storybloq_lesson_reinforce", {
    description: "Reinforce a lesson — increment reinforcement count and update lastValidated date",
    inputSchema: {
      id: LessonIdSchema.describe("Lesson ID (e.g. L-001 or l-[canonical])"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleLessonReinforce(args.id, format, root),
  ));

  // --- Phase write tools ---

  server.registerTool("storybloq_phase_create", {
    description: "Create a new phase in the roadmap. Exactly one of after or atStart is required for positioning.",
    inputSchema: {
      id: z.string().describe("Phase ID — lowercase alphanumeric with hyphens (e.g. 'my-phase')"),
      name: z.string().describe("Phase display name"),
      label: z.string().describe("Phase label (e.g. 'PHASE 1')"),
      description: z.string().describe("Phase description"),
      summary: z.string().optional().describe("One-line summary for compact display"),
      after: z.string().optional().describe("Insert after this phase ID"),
      atStart: z.boolean().optional().describe("Insert at beginning of roadmap"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handlePhaseCreate(
      {
        id: args.id,
        name: args.name,
        label: args.label,
        description: args.description,
        summary: args.summary,
        after: args.after,
        atStart: args.atStart ?? false,
      },
      format,
      root,
    ),
  ));

  // No MCP delete tools for any entity — deletion is destructive and stays CLI-only (human-gated).

  // --- Federation bootstrap ---

  server.registerTool("storybloq_node_init", {
    description: "Initialize .story/ in a federation child node from the orchestrator. Does not require allowNodeWrites.",
    inputSchema: {
      node: z.string().regex(NODE_NAME_REGEX).describe("Node name from orchestrator config"),
      type: z.string().optional().describe("Project type (e.g. npm, macapp, swift-spm)"),
      language: z.string().optional().describe("Primary language"),
      force: z.boolean().optional().describe("Overwrite existing config if .story/ already exists"),
    },
  }, async (args) => {
    try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
    try {
      const config = readOrchestratorConfig(pinnedRoot);
      if (!config) {
        return { content: [{ type: "text" as const, text: "Cannot read orchestrator config." }], isError: true };
      }
      if (config.type !== "orchestrator") {
        return { content: [{ type: "text" as const, text: "storybloq_node_init is only available on orchestrator projects." }], isError: true };
      }
      const rawNodes = config.nodes;
      if (!rawNodes || typeof rawNodes !== "object" || Array.isArray(rawNodes) || !(args.node in (rawNodes as Record<string, unknown>))) {
        return { content: [{ type: "text" as const, text: `Node "${args.node}" not found in orchestrator config.` }], isError: true };
      }
      const nodeConf = (rawNodes as Record<string, Record<string, unknown>>)[args.node]!;
      const rawPath = typeof nodeConf.path === "string" ? nodeConf.path : "";
      if (!rawPath) {
        return { content: [{ type: "text" as const, text: `Node "${args.node}" has no path configured.` }], isError: true };
      }
      const resolved = resolveNodePath(rawPath, pinnedRoot);
      if (!resolved.resolved) {
        if (resolved.reason === "no .story/config.json found" && resolved.absolutePath) {
          const result = await initProject(resolved.absolutePath, {
            name: args.node,
            force: args.force,
            type: args.type ?? (typeof nodeConf.stack === "string" ? nodeConf.stack : undefined),
            language: args.language,
          });
          return { content: [{ type: "text" as const, text: `Initialized .story/ in ${args.node} (${resolved.absolutePath}).\nCreated: ${result.created.join(", ")}` }] };
        }
        return { content: [{ type: "text" as const, text: `Cannot resolve node "${args.node}": ${resolved.reason}` }], isError: true };
      }
      // Node already has .story/ -- init with force if requested
      if (!args.force) {
        return { content: [{ type: "text" as const, text: `Node "${args.node}" already has .story/. Use force: true to reinitialize.` }], isError: true };
      }
      const result = await initProject(resolved.absolutePath, {
        name: args.node,
        force: true,
        type: args.type ?? (typeof nodeConf.stack === "string" ? nodeConf.stack : undefined),
        language: args.language,
      });
      return { content: [{ type: "text" as const, text: `Reinitialized .story/ in ${args.node} (${resolved.absolutePath}).\nCreated: ${result.created.join(", ")}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  });

  // --- Node add ---

  server.registerTool("storybloq_node_add", {
    description: "Add a federation node to an orchestrator project's config. The node directory must exist. Absolute paths outside the orchestrator workspace are allowed (federation spans repos).",
    inputSchema: {
      name: z.string().regex(NODE_NAME_REGEX).describe("Node name (lowercase alphanumeric, hyphens, underscores)"),
      path: z.string().min(1).describe("Path to node directory (absolute or ~/relative). Must exist."),
      stack: z.string().max(40).optional().describe("Tech stack (e.g. npm, swift-spm, cargo)"),
      role: z.string().max(120).optional().describe("Human-readable role description"),
      kind: z.string().max(32).optional().describe("Node kind (e.g. library, service, app)"),
      summary: z.string().max(200).optional().describe("One-line status summary"),
      dependsOn: z.array(z.string().regex(NODE_NAME_REGEX)).optional().describe("Node names this depends on (validated for cycles)"),
      links: z.array(z.object({
        to: z.string().regex(NODE_NAME_REGEX),
        via: z.string().max(60).optional(),
      })).optional().describe("Runtime links to other nodes"),
    },
  }, async (args) => {
    const { handleNodeAdd } = await import("../cli/commands/node.js");
    return runMcpWriteTool(pinnedRoot, (root, format) =>
      handleNodeAdd(
        {
          name: args.name,
          path: args.path,
          stack: args.stack,
          role: args.role,
          kind: args.kind,
          summary: args.summary,
          dependsOn: args.dependsOn,
          links: args.links,
        },
        format,
        root,
      ),
    );
  });

  // --- Node list ---

  server.registerTool("storybloq_node_list", {
    description: "List configured federation nodes in an orchestrator project",
  }, () => runMcpReadTool(pinnedRoot, handleNodeList));

  // --- Node update ---

  server.registerTool("storybloq_node_update", {
    description: "Update an existing federation node's metadata. Shallow-merges provided fields onto the existing node entry, preserving health and passthrough fields.",
    inputSchema: {
      name: z.string().regex(NODE_NAME_REGEX).describe("Node name to update"),
      path: z.string().min(1).optional().describe("New path to node directory"),
      stack: z.string().max(40).optional().describe("New tech stack"),
      role: z.string().max(120).optional().describe("New role description"),
      kind: z.string().max(32).optional().describe("New node kind"),
      summary: z.string().max(200).optional().describe("New status summary"),
      dependsOn: z.array(z.string().regex(NODE_NAME_REGEX)).optional().describe("Replace dependsOn list (validated for cycles)"),
      clearDependsOn: z.boolean().optional().describe("Clear all dependencies"),
      links: z.array(z.object({
        to: z.string().regex(NODE_NAME_REGEX),
        via: z.string().max(60).optional(),
      })).optional().describe("Replace runtime links"),
      clearLinks: z.boolean().optional().describe("Clear all runtime links"),
    },
  }, async (args) => {
    const { handleNodeUpdate } = await import("../cli/commands/node.js");
    return runMcpWriteTool(pinnedRoot, (root, format) =>
      handleNodeUpdate(
        args.name,
        {
          path: args.path,
          stack: args.stack,
          role: args.role,
          kind: args.kind,
          summary: args.summary,
          dependsOn: args.dependsOn,
          clearDependsOn: args.clearDependsOn,
          links: args.links,
          clearLinks: args.clearLinks,
        },
        format,
        root,
      ),
    );
  });

  // --- Selftest ---

  server.registerTool("storybloq_selftest", {
    description: "Integration smoke test — creates, updates, and deletes test entities to verify the full pipeline",
  }, () => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleSelftest(root, format),
  ));

  // --- Session report ---

  server.registerTool("storybloq_session_report", {
    description: "Generate a structured analysis of an autonomous session — works even if project state is corrupted",
    inputSchema: {
      sessionId: z.string().uuid().describe("Session ID to analyze"),
    },
  }, async (args) => {
    try {
      const result = await handleSessionReport(args.sessionId, pinnedRoot);
      // ISS-906: session_report builds its own lookup-failure texts (ISS-897's
      // per-shape framing), so the staleness note is appended here at the MCP
      // boundary. The CLI path through handleSessionReport stays untouched.
      // invalid_input is excluded: a malformed UUID is caller error, not skew.
      const lookupFailed =
        result.isError === true &&
        (result.errorCode === "not_found" ||
          result.errorCode === "version_mismatch" ||
          result.errorCode === "project_corrupt" ||
          result.errorCode === "io_error");
      return {
        content: [{ type: "text" as const, text: lookupFailed ? withStalenessNote(result.output) : result.output }],
        isError: result.isError ?? false,
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // --- Subprocess registry (T-261) ---

  server.registerTool("storybloq_register_subprocess", {
    description: "Register a running subprocess so monitors can distinguish slow builds from hung agents. Writes a per-PID file under the session's telemetry directory.",
    inputSchema: {
      pid: z.number().int().positive().describe("Process ID of the subprocess"),
      cmd: z.string().describe("Command that was run (will be sanitized to executable basename)"),
      category: z.enum(SUBPROCESS_CATEGORIES).describe("Subprocess category"),
      sessionId: z.string().uuid().describe("Session ID to register against"),
    },
  }, (args) => {
    try {
      const sDir = sessionDir(pinnedRoot, args.sessionId);
      // ISS-556: resilient read — subprocess registration must not be wedged
      // by historical lensReviewHistory disposition corruption.
      const session = readSessionResilient(sDir);
      if (!session) return { content: [{ type: "text" as const, text: withStalenessNote("Error: session not found or corrupt") }], isError: true };
      if (session.status !== "active") return { content: [{ type: "text" as const, text: `Error: session status is "${session.status}", not "active"` }], isError: true };
      if (isLeaseExpired(session)) return { content: [{ type: "text" as const, text: "Error: session lease has expired" }], isError: true };
      if (session.state === "SESSION_END") return { content: [{ type: "text" as const, text: "Error: session is in terminal SESSION_END state" }], isError: true };

      const stage = session.state ?? "unknown";
      registerSubprocess(sDir, {
        pid: args.pid,
        cmd: sanitizeCmd(args.cmd),
        category: args.category,
        startedAt: new Date().toISOString(),
        stage,
      });
      return { content: [{ type: "text" as const, text: `Registered subprocess ${args.pid} (${args.category}) for session ${args.sessionId}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error registering subprocess: ${msg}` }], isError: true };
    }
  });

  server.registerTool("storybloq_unregister_subprocess", {
    description: "Unregister a subprocess after it completes. Idempotent -- no error if the PID was already unregistered. Relaxed validation: works even on expired/terminal sessions to allow cleanup.",
    inputSchema: {
      pid: z.number().int().positive().describe("Process ID to unregister"),
      sessionId: z.string().uuid().describe("Session ID the subprocess was registered against"),
    },
  }, (args) => {
    try {
      const sDir = sessionDir(pinnedRoot, args.sessionId);
      // ISS-556: resilient read — cleanup must work even when the session's
      // lensReviewHistory has historical disposition corruption.
      const session = readSessionResilient(sDir);
      if (!session) return { content: [{ type: "text" as const, text: withStalenessNote("Error: session not found or corrupt") }], isError: true };

      unregisterSubprocess(sDir, args.pid);
      return { content: [{ type: "text" as const, text: `Unregistered subprocess ${args.pid} from session ${args.sessionId}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error unregistering subprocess: ${msg}` }], isError: true };
    }
  });

  // --- Autonomous guide ---

  server.registerTool("storybloq_autonomous_guide", {
    description: "Autonomous session orchestrator. Call at every decision point during autonomous mode. Supports tiered access: auto (full autonomous), review (code review only), plan (plan + review), guided (single ticket end-to-end). Note: a review finding reported with disposition 'deferred' (and severity above 'suggestion') auto-files a storybloq issue, so use 'deferred' only for work you genuinely want tracked as a new issue. See the report.findings[].disposition field for the full per-value semantics.",
    inputSchema: {
      sessionId: z.string().uuid().nullable().describe("Session ID (null for start action)"),
      action: z.enum(["start", "report", "resume", "pre_compact", "cancel"]).describe("Action to perform"),
      clientTaskId: z.string().min(1).max(128).regex(CLIENT_TASK_ID_PATTERN).optional()
        .describe("Current AI-client task/thread id. Codex passes CODEX_THREAD_ID; Claude is detected automatically."),
      takeover: z.boolean().optional()
        .describe("Resume only: recover a COMPACT session after explicitly confirming its recorded owner task is gone."),
      mode: z.enum(["auto", "review", "plan", "guided"]).optional().describe("Execution tier (start action only): auto=full autonomous, review=code review only, plan=plan+review, guided=single ticket"),
      ticketId: z.string().optional().describe("Ticket ID for tiered modes (review, plan, guided). Required for non-auto modes."),
      targetWork: z.array(z.string().regex(TARGET_WORK_ID_REGEX)).max(150).optional().describe("For start action only: array of T-XXX and ISS-XXX IDs to work on in order. Empty or omitted = standard auto mode."),
      report: z.object({
        completedAction: z.string().describe("What was completed"),
        ticketId: z.string().optional().describe("Ticket ID (for ticket_picked)"),
        issueId: z.string().optional().describe("Issue ID (for issue_picked) — T-153"),
        commitHash: z.string().optional().describe("Git commit hash (for commit_done)"),
        handoverContent: z.string().optional().describe("Handover markdown content"),
        verdict: z.string().optional().describe("Review verdict: approve|revise|request_changes|reject"),
        findings: z.array(z.object({
          // ISS-717: id is optional and disposition defaults to "open" so a
          // synthesized lens-shaped finding (which carries severity, category,
          // and description but no id/disposition) validates here instead of
          // being rejected with -32602 before the contradiction guard in the
          // review stage can run. Unknown lens-only fields (lens, evidence,
          // confidence, issueKey, recommendedImpact) are stripped by zod.
          id: z.string().optional(),
          severity: z.string(),
          category: z.string(),
          description: z.string(),
          // ISS-724: declare the synthesized finding's lens identifier so it
          // survives the report boundary. Without it zod strips the field (the
          // object has no .passthrough()), so buildLensHistoryUpdate sees no
          // lens and records every per-lens finding under lens:'unknown',
          // collapsing what should be distinct security/clean-code/error-handling
          // history entries (dedup key is ticketId:stage:lens:category). The
          // other lens-only fields (evidence, issueKey, recommendedImpact) are
          // unused downstream of the report boundary, so they stay stripped.
          // Observability fidelity only -- no behavioral effect on the review.
          lens: z.string().optional(),
          // ISS-556: stays constrained to the enum persisted by
          // SessionStateSchema (a default of "open" can never violate it).
          disposition: z.enum(LENS_FINDING_DISPOSITIONS).default("open").describe(
            "Finding disposition (defaults to 'open' if omitted). 'open' = unresolved this round; " +
            "'addressed' = fixed in this round; 'contested' = false positive (feeds the false-positive " +
            "learning loop, files no issue; do NOT use it to park a valid finding, that pollutes the signal); " +
            "'deferred' = valid but out of scope, which AUTO-FILES a storybloq issue (severity 'suggestion' is exempt).",
          ),
          // ISS-717: previously omitted from this schema, so the SDK stripped it
          // and the PLAN-redirect guard in the review stages was unreachable.
          recommendedNextState: z.enum(["PLAN", "IMPLEMENT"]).optional().describe(
            "Set to 'PLAN' when the review concludes the implementation approach must be replanned; on a " +
            "non-approve verdict this routes the session back to PLAN. Leave unset for ordinary findings.",
          ),
        })).optional().describe("Review findings"),
        reviewerSessionId: z.string().optional().describe("Codex session ID"),
        reviewer: z.string().optional().describe("Actual reviewer backend used (e.g. 'agent' when codex was unavailable)"),
        reviewId: z.string().optional().describe("ISS-720: lens reviewId returned by review_lenses_prepare/synthesize. Pass it on a lens-backed review_round report so the recorded verdict reflects whether the lens verification gate actually ran (lenses-verified) or was skipped/degraded (lenses-unverified)."),
        notes: z.string().optional().describe("Free-text notes"),
      }).optional().describe("Report data (required for report action)"),
    },
  }, (args) => {
    try { const sid = (args as Record<string, unknown>).sessionId as string | null; if (sid) touchLastMcpCallFile(sessionDir(pinnedRoot, sid)); } catch { /* best-effort */ }
    return handleAutonomousGuide(pinnedRoot, args as Parameters<typeof handleAutonomousGuide>[1]);
  });

  // ── T-189: Multi-lens review MCP tools ─────────────────────

  server.registerTool("storybloq_review_lenses_prepare", {
    description: "Prepare a multi-lens code/plan review on the @storybloq/lenses registry. Activates lenses via the package surface rules, runs the secrets gate (redacting before content leaves the process), packages per-lens context, checks the round cache, and returns complete lens prompts for the agent to spawn as parallel subagents, with per-lens activation statuses disclosed.",
    inputSchema: {
      stage: z.enum(["CODE_REVIEW", "PLAN_REVIEW"]).describe("Review stage"),
      diff: z.string().describe("The diff (code review) or plan text (plan review) to review"),
      changedFiles: z.array(z.string()).describe("List of changed file paths"),
      ticketDescription: z.string().optional().describe("Current ticket description for context"),
      reviewRound: z.number().int().min(1).optional().describe("Review round (1 = first, 2+ = subsequent)"),
      priorDeferrals: z.array(z.string()).optional().describe("issueKeys of findings the agent intentionally deferred from prior rounds"),
      sessionId: z.string().uuid().optional().describe("Active session ID. Pass it so prepare can persist the round's cache keys and anchoring artifact for synthesize. Use the same reviewRound and the returned reviewId when you call synthesize."),
    },
  }, (args) => {
    try {
      const sessionDir = args.sessionId
        ? join(pinnedRoot, ".story", "sessions", args.sessionId)
        : undefined;
      const result = handlePrepare({ ...args, projectRoot: pinnedRoot, sessionDir });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/\/[^\s]+/g, "<path>") : "unknown error";
      return { content: [{ type: "text" as const, text: `Error preparing lens review: ${msg}` }], isError: true };
    }
  });

  server.registerTool("storybloq_review_lenses_synthesize", {
    description: "Synthesize lens results after parallel review by running the @storybloq/lenses merger pipeline programmatically: per-lens schema parsing, evidence anchoring against the reviewed artifact, dedup, blocking policy, tension detection, coverage caps, and verdict computation. Returns the package ReviewVerdict envelope directly (no merger prompt, no merger agent). Also classifies origin (introduced vs pre-existing) and auto-files pre-existing issues. Call after collecting all lens subagent outputs, then pass reviewVerdict to storybloq_review_lenses_judge.",
    inputSchema: {
      stage: z.enum(["CODE_REVIEW", "PLAN_REVIEW"]).optional().describe("Review stage (defaults to CODE_REVIEW)"),
      lensResults: z.array(z.object({
        lens: z.string().describe("Lens id from prepare's activeLenses"),
        output: z.unknown().describe("The lens subagent's raw output: the single JSON object ({status, findings, error, notes}) the lens prompt instructs it to emit, as an object or JSON string"),
        cached: z.boolean().optional().describe("True when this entry echoes cachedFindings returned by prepare"),
      })).describe("One entry per active lens with its raw output"),
      activeLenses: z.array(z.string()).describe("Active lens names from prepare step"),
      skippedLenses: z.array(z.string()).describe("Skipped lens names from prepare step"),
      reviewRound: z.number().int().min(1).optional().describe("Current review round"),
      reviewId: z.string().optional().describe("Review ID from prepare step"),
      // T-192: Origin classification inputs
      diff: z.string().optional().describe("The diff being reviewed (for evidence anchoring and origin classification of findings into introduced vs pre-existing)"),
      changedFiles: z.array(z.string()).optional().describe("Changed file paths from prepare step"),
      sessionId: z.string().uuid().optional().describe("Active session ID (enables anchoring against prepare's redacted artifact, cache write-back, telemetry, and dedup of auto-filed pre-existing issues across review rounds)"),
    },
  }, async (args) => {
    try {
      const sessionDir = args.sessionId
        ? join(pinnedRoot, ".story", "sessions", args.sessionId)
        : undefined;
      const result = handleSynthesize({
        stage: args.stage,
        // Re-shape at the wire boundary: z.unknown() infers `output` as an
        // optional property; the harness contract requires it present.
        lensResults: args.lensResults.map((r) => ({
          lens: r.lens,
          // Defensive: prepare returns cache hits as a bare cachedFindings
          // array. If the agent echoes that array directly instead of wrapping
          // it in a LensOutput envelope, wrap it here so the cached lens is
          // reused rather than rejected by LensOutputSchema as parse_failed.
          output:
            r.cached && Array.isArray(r.output)
              ? { status: "ok", findings: r.output, error: null, notes: "cache" }
              : r.output,
          ...(r.cached !== undefined ? { cached: r.cached } : {}),
        })),
        metadata: {
          activeLenses: args.activeLenses,
          skippedLenses: args.skippedLenses,
          reviewRound: args.reviewRound ?? 1,
          reviewId: args.reviewId ?? "unknown",
        },
        projectRoot: pinnedRoot,
        sessionId: args.sessionId,
        sessionDir,
        diff: args.diff,
        changedFiles: args.changedFiles,
      });

      // T-192: Auto-file pre-existing findings as issues
      const filedIssues: { issueKey: string; issueId: string }[] = [];
      const filingWarnings: { issueKey: string; code: string; message: string }[] = [];
      const filingErrors: { issueKey: string; code: string; message: string }[] = [];
      if (result.preExistingFindings.length > 0) {
        const sessionDir = args.sessionId
          ? join(pinnedRoot, ".story", "sessions", args.sessionId)
          : null;
        const alreadyFiled = sessionDir ? readFiledPreexisting(sessionDir) : new Set<string>();
        const sizeBeforeLoop = alreadyFiled.size;

        for (const f of result.preExistingFindings) {
          const issueKey = generateIssueKey(f);
          if (alreadyFiled.has(issueKey)) continue;

          try {
            const { handleIssueCreate } = await import("../cli/commands/issue.js");
            const severityMap: Record<string, string> = { blocking: "critical", major: "high", minor: "medium" };
            const severity = severityMap[f.severity] ?? "medium";
            const quote = f.snippet?.quote.replace(/\r\n?/g, "\n");
            const quoteLines = quote
              ? quote.endsWith("\n") ? quote.slice(0, -1).split("\n").length : quote.split("\n").length
              : 1;
            const sourceRefs = f.file && f.line != null
              ? [{
                  path: f.file,
                  startLine: f.line,
                  ...(quoteLines > 1
                    ? { endLine: f.line + quoteLines - 1 }
                    : {}),
                  reviewId: args.reviewId ?? "unknown",
                }]
              : undefined;
            const createArgs = {
              title: `[pre-existing] [${f.category}] ${f.description.slice(0, 60)}`,
              severity,
              impact: f.description,
              components: ["review-lenses"],
              relatedTickets: [],
              location: f.file && f.line != null ? [`${f.file}:${f.line}`] : [],
              sourceRefs,
              dedupeKey: generateReviewFilingKey(args.reviewId ?? "unknown", f),
              createdBy: `review-lenses:${f.contributingLenses.join(",")}`,
            };
            let issueResult;
            try {
              issueResult = await handleIssueCreate(createArgs, "json", pinnedRoot);
            } catch (err) {
              if (!(sourceRefs && err instanceof CliValidationError && err.code === "invalid_input")) {
                throw err;
              }
              filingWarnings.push({
                issueKey,
                code: "source_provenance_omitted",
                message: "The finding was filed without structured source provenance because the source reference could not be normalized.",
              });
              issueResult = await handleIssueCreate(
                { ...createArgs, sourceRefs: undefined },
                "json",
                pinnedRoot,
              );
            }

            let issueId: string | undefined;
            try {
              const parsed = JSON.parse(issueResult.output ?? "");
              issueId = parsed?.data?.id;
            } catch {
              const match = issueResult.output?.match(/ISS-\d+/);
              issueId = match?.[0];
            }

            if (issueId) {
              filedIssues.push({ issueKey, issueId });
              alreadyFiled.add(issueKey);
            }
          } catch (err) {
            const message = err instanceof Error
              ? err.message.replace(/\/[^\s]+/g, "<path>")
              : "unknown error";
            filingErrors.push({ issueKey, code: "issue_filing_failed", message });
          }
        }

        if (sessionDir && alreadyFiled.size > sizeBeforeLoop) {
          writeFiledPreexisting(sessionDir, alreadyFiled);
        }
      }

      const output = { ...result, filedIssues, filingWarnings, filingErrors };
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/\/[^\s]+/g, "<path>") : "unknown error";
      return { content: [{ type: "text" as const, text: `Error synthesizing lens results: ${msg}` }], isError: true };
    }
  });

  server.registerTool("storybloq_review_lenses_judge", {
    description: "Deterministic final verdict mapping over the ReviewVerdict returned by synthesize. No judge agent: pipeline reject stays reject, revise stays revise, and an approve carrying major findings or partial lens coverage becomes approve with recommendFixRound true (the three-value verdict). Convergence history damps repeated majors-only recommendations once rounds stabilize; coverage gaps are never damped. Call after synthesize and report the returned verdict.",
    inputSchema: {
      reviewVerdict: z.unknown().describe("The reviewVerdict object returned by storybloq_review_lenses_synthesize (or a JSON string of it)"),
      convergenceHistory: z.array(z.object({
        round: z.number(),
        verdict: z.string(),
        blocking: z.number(),
        important: z.number(),
        newCode: z.string(),
      })).optional().describe("Prior round verdicts for convergence damping"),
    },
  }, (args) => {
    try {
      let verdictInput = args.reviewVerdict;
      if (typeof verdictInput === "string") {
        try { verdictInput = JSON.parse(verdictInput); } catch { /* schema parse reports it */ }
      }
      const result = handleJudge({
        reviewVerdict: verdictInput,
        convergenceHistory: args.convergenceHistory,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/\/[^\s]+/g, "<path>") : "unknown error";
      return { content: [{ type: "text" as const, text: `Error judging lens verdict: ${msg}` }], isError: true };
    }
  });
}

// ── T-192: Pre-existing finding dedup helpers ─────────────────

const FILED_PREEXISTING_FILE = "filed-preexisting.json";

function readFiledPreexisting(sessionDir: string): Set<string> {
  try {
    const raw = readFileSync(join(sessionDir, FILED_PREEXISTING_FILE), "utf-8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writeFiledPreexisting(sessionDir: string, keys: Set<string>): void {
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, FILED_PREEXISTING_FILE), JSON.stringify([...keys], null, 2));
  } catch {
    // Best-effort; dedup may miss on next round but no data loss
  }
}


/**
 * `storybloq_session_guard` (T-446).
 *
 * Registered in BOTH the full tool set and degraded mode. Degraded mode is the
 * no-project case, which is exactly where the skill runs its Step 0.5 guard
 * first; a tools.ts-only registration would leave it unavailable there.
 *
 * Read-only: it reads each session's `state.json` under `.story/sessions/` and
 * nothing else. It never loads the ledger, which is the point -- this replaces a
 * full `storybloq_status` payload on every invocation.
 */
export function registerSessionGuardTool(server: McpServer, root: string) {
  return server.registerTool("storybloq_session_guard", {
    description:
      "Session ownership verdict: is anything running, and may I write? Reads only .story/sessions/ (no ledger load). Returns a per-session verdict plus an overallAction, which is null when more than one session bears: the source procedure supplies a rule per session and none for combining them, so every verdict is returned and no aggregate action is defined (ISS-898).",
    inputSchema: {
      // Deliberately looser than `storybloq_autonomous_guide`, which pins the
      // same field to CLIENT_TASK_ID_PATTERN. A schema regex rejects the CALL,
      // and the sentence this tool transcribes says the opposite: "Missing or
      // malformed identity never blocks the legacy workflow, but it cannot
      // prove same-task ownership." A malformed id must therefore produce a
      // verdict with `identityUnavailable: true`, not an argument error that
      // leaves the caller with no verdict at all. `normalizeClientTaskId`
      // already applies the pattern and yields null, so the check moves inward
      // rather than disappearing. The guide keeps the strict schema because it
      // MUTATES ownership; this tool only advises.
      clientTaskId: z
        .string()
        .optional()
        .describe("The caller's client task id. Omit it to inherit the client's environment identity (CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID); the verdict reports identityUnavailable only when nothing supplies an id, environment included. A malformed id is treated as no identity rather than rejected, because missing or malformed identity never blocks the legacy workflow."),
    },
  }, (args) => {
    // Forwarded unchanged. The evaluator resolves `explicit ?? environment`,
    // matching `currentClientTaskId`, so an MCP caller CANNOT assert
    // "identity unavailable" over a populated environment variable -- omission
    // inherits it. That is deliberate: the guide the tool transcribes resolves
    // its caller the same way ("Claude's inherited session id remains supported
    // when the field is omitted"), and a boundary that could force the identity
    // off would be a new capability, not a transcription of Step 0.5.
    const verdict = evaluateSessionGuard(root, {
      clientTaskId: args.clientTaskId,
    });
    return Promise.resolve({
      content: [{ type: "text" as const, text: JSON.stringify(verdict, null, 2) }],
    });
  });
}
