/**
 * MCP tool registration and shared pipeline for claudestory tools.
 *
 * 32 tools (20 read + 12 write). Read tools use a shared pipeline:
 *   loadProject(root) → build CommandContext → call handler → classify result
 */
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TARGET_WORK_ID_REGEX } from "../autonomous/session-types.js";
import { findActiveSessionMinimal, readSession, sessionDir, isLeaseExpired } from "../autonomous/session.js";
import { touchLastMcpCallFile } from "../autonomous/liveness.js";

// ISS-407: Cache active session dir to avoid O(n) directory scan on every MCP call.
// Expires after 30s -- long enough to amortize hot-path calls, short enough
// to detect session transitions within a reasonable window.
const _SESSION_CACHE_TTL_MS = 30_000;
let _cachedSessionDir: string | null = null;
let _cachedSessionAt = 0;

function touchMcpLiveness(pinnedRoot: string): void {
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
import { handlePrepare, handleSynthesize, handleJudge } from "../autonomous/review-lenses/mcp-handlers.js";
import { validateCachedFindings } from "../autonomous/review-lenses/schema-validator.js";
import type { LensFinding } from "../autonomous/review-lenses/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadProject } from "../core/project-loader.js";
import { ProjectLoaderError, INTEGRITY_WARNING_TYPES } from "../core/errors.js";
import { CliValidationError } from "../cli/helpers.js";
import {
  TICKET_ID_REGEX,
  ISSUE_ID_REGEX,
  NOTE_ID_REGEX,
  LESSON_ID_REGEX,
  TICKET_STATUSES,
  TICKET_TYPES,
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
  NOTE_STATUSES,
  LESSON_STATUSES,
  LESSON_SOURCES,
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
  handleTicketCreate,
  handleTicketUpdate,
} from "../cli/commands/ticket.js";
import {
  handleIssueList,
  handleIssueGet,
  handleIssueCreate,
  handleIssueUpdate,
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
  try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
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
  try { touchMcpLiveness(pinnedRoot); } catch { /* best-effort */ }
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
    description: "Highest-priority unblocked ticket(s) with unblock impact and umbrella progress",
    inputSchema: {
      count: z.number().int().min(1).max(10).optional()
        .describe("Number of candidates to return (default: 1)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleTicketNext(ctx, args.count ?? 1),
  ));

  server.registerTool("claudestory_ticket_blocked", {
    description: "All blocked tickets with their blocking dependencies",
  }, () => runMcpReadTool(pinnedRoot, handleTicketBlocked));

  server.registerTool("claudestory_handover_list", {
    description: "List handover filenames (newest first)",
  }, () => runMcpReadTool(pinnedRoot, handleHandoverList));

  server.registerTool("claudestory_handover_latest", {
    description: "Content of the most recent handover document(s)",
    inputSchema: {
      count: z.number().int().min(1).max(10).optional().describe("Number of recent handovers to return (default: 1)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleHandoverLatest(ctx, args.count ?? 1),
  ));

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
      component: z.string().optional().describe("Filter by component name"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleIssueList({ status: args.status, severity: args.severity, component: args.component }, ctx),
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

  server.registerTool("claudestory_recommend", {
    description: "Context-aware ranked work suggestions mixing tickets and issues",
    inputSchema: {
      count: z.number().int().min(1).max(10).optional()
        .describe("Number of recommendations (default: 5)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleRecommend(ctx, args.count ?? 5),
  ));

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

  server.registerTool("claudestory_handover_create", {
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

  server.registerTool("claudestory_ticket_create", {
    description: "Create a new ticket",
    inputSchema: {
      title: z.string().describe("Ticket title"),
      type: z.enum(TICKET_TYPES).describe("Ticket type: task, feature, chore"),
      phase: z.string().optional().describe("Phase ID"),
      description: z.string().optional().describe("Ticket description"),
      blockedBy: z.array(z.string().regex(TICKET_ID_REGEX)).optional().describe("IDs of blocking tickets"),
      parentTicket: z.string().regex(TICKET_ID_REGEX).optional().describe("Parent ticket ID (makes this a sub-ticket)"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
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
    ),
  ));

  server.registerTool("claudestory_ticket_update", {
    description: "Update an existing ticket",
    inputSchema: {
      id: z.string().regex(TICKET_ID_REGEX).describe("Ticket ID (e.g. T-001)"),
      status: z.enum(TICKET_STATUSES).optional().describe("New status: open, inprogress, complete"),
      title: z.string().optional().describe("New title"),
      type: z.enum(TICKET_TYPES).optional().describe("New type: task, feature, chore"),
      order: z.number().int().optional().describe("New sort order"),
      description: z.string().optional().describe("New description"),
      phase: z.string().nullable().optional().describe("New phase ID (null to clear)"),
      parentTicket: z.string().regex(TICKET_ID_REGEX).nullable().optional().describe("Parent ticket ID (null to clear)"),
      blockedBy: z.array(z.string().regex(TICKET_ID_REGEX)).optional().describe("IDs of blocking tickets"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
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
      },
      format,
      root,
    ),
  ));

  // --- Issue write tools ---

  server.registerTool("claudestory_issue_create", {
    description: "Create a new issue",
    inputSchema: {
      title: z.string().describe("Issue title"),
      severity: z.enum(ISSUE_SEVERITIES).describe("Issue severity: critical, high, medium, low"),
      impact: z.string().describe("Impact description"),
      components: z.array(z.string()).optional().describe("Affected components"),
      relatedTickets: z.array(z.string().regex(TICKET_ID_REGEX)).optional().describe("Related ticket IDs"),
      location: z.array(z.string()).optional().describe("File locations"),
      phase: z.string().optional().describe("Phase ID"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleIssueCreate(
      {
        title: args.title,
        severity: args.severity,
        impact: args.impact,
        components: args.components ?? [],
        relatedTickets: args.relatedTickets ?? [],
        location: args.location ?? [],
        phase: args.phase,
      },
      format,
      root,
    ),
  ));

  server.registerTool("claudestory_issue_update", {
    description: "Update an existing issue",
    inputSchema: {
      id: z.string().regex(ISSUE_ID_REGEX).describe("Issue ID (e.g. ISS-001)"),
      status: z.enum(ISSUE_STATUSES).optional().describe("New status: open, inprogress, resolved"),
      title: z.string().optional().describe("New title"),
      severity: z.enum(ISSUE_SEVERITIES).optional().describe("New severity"),
      impact: z.string().optional().describe("New impact description"),
      resolution: z.string().nullable().optional().describe("Resolution description (null to clear)"),
      components: z.array(z.string()).optional().describe("Affected components"),
      relatedTickets: z.array(z.string().regex(TICKET_ID_REGEX)).optional().describe("Related ticket IDs"),
      location: z.array(z.string()).optional().describe("File locations"),
      order: z.number().int().optional().describe("New sort order"),
      phase: z.string().nullable().optional().describe("New phase ID (null to clear)"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
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
        order: args.order,
        phase: args.phase,
      },
      format,
      root,
    ),
  ));

  // --- Note tools ---

  server.registerTool("claudestory_note_list", {
    description: "List notes with optional status/tag filters",
    inputSchema: {
      status: z.enum(NOTE_STATUSES).optional().describe("Filter by status: active, archived"),
      tag: z.string().optional().describe("Filter by tag"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleNoteList({ status: args.status, tag: args.tag }, ctx),
  ));

  server.registerTool("claudestory_note_get", {
    description: "Get a note by ID",
    inputSchema: {
      id: z.string().regex(NOTE_ID_REGEX).describe("Note ID (e.g. N-001)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleNoteGet(args.id, ctx)));

  server.registerTool("claudestory_note_create", {
    description: "Create a new note",
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

  server.registerTool("claudestory_note_update", {
    description: "Update an existing note",
    inputSchema: {
      id: z.string().regex(NOTE_ID_REGEX).describe("Note ID (e.g. N-001)"),
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

  server.registerTool("claudestory_lesson_list", {
    description: "List lessons with optional status/tag/source filters",
    inputSchema: {
      status: z.enum(LESSON_STATUSES).optional().describe("Filter by status: active, deprecated, superseded"),
      tag: z.string().optional().describe("Filter by tag"),
      source: z.enum(LESSON_SOURCES).optional().describe("Filter by source: review, correction, postmortem, manual"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) =>
    handleLessonList({ status: args.status, tag: args.tag, source: args.source }, ctx),
  ));

  server.registerTool("claudestory_lesson_get", {
    description: "Get a lesson by ID",
    inputSchema: {
      id: z.string().regex(LESSON_ID_REGEX).describe("Lesson ID (e.g. L-001)"),
    },
  }, (args) => runMcpReadTool(pinnedRoot, (ctx) => handleLessonGet(args.id, ctx)));

  server.registerTool("claudestory_lesson_digest", {
    description: "Compiled ranked digest of active lessons — primary read interface for context loading",
    inputSchema: {},
  }, () => runMcpReadTool(pinnedRoot, (ctx) => handleLessonDigest(ctx)));

  server.registerTool("claudestory_lesson_create", {
    description: "Create a new lesson",
    inputSchema: {
      title: z.string().describe("Lesson title — concise lesson name"),
      content: z.string().describe("The actionable rule (1-3 sentences)"),
      context: z.string().describe("What happened that produced this lesson (evidence, ticket/issue refs)"),
      source: z.enum(LESSON_SOURCES).describe("Lesson source: review, correction, postmortem, manual"),
      tags: z.array(z.string()).optional().describe("Tags for the lesson"),
      supersedes: z.string().regex(LESSON_ID_REGEX).optional().describe("ID of lesson this supersedes"),
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

  server.registerTool("claudestory_lesson_update", {
    description: "Update an existing lesson",
    inputSchema: {
      id: z.string().regex(LESSON_ID_REGEX).describe("Lesson ID (e.g. L-001)"),
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

  server.registerTool("claudestory_lesson_reinforce", {
    description: "Reinforce a lesson — increment reinforcement count and update lastValidated date",
    inputSchema: {
      id: z.string().regex(LESSON_ID_REGEX).describe("Lesson ID (e.g. L-001)"),
    },
  }, (args) => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleLessonReinforce(args.id, format, root),
  ));

  // --- Phase write tools ---

  server.registerTool("claudestory_phase_create", {
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

  // --- Selftest ---

  server.registerTool("claudestory_selftest", {
    description: "Integration smoke test — creates, updates, and deletes test entities to verify the full pipeline",
  }, () => runMcpWriteTool(pinnedRoot, (root, format) =>
    handleSelftest(root, format),
  ));

  // --- Session report ---

  server.registerTool("claudestory_session_report", {
    description: "Generate a structured analysis of an autonomous session — works even if project state is corrupted",
    inputSchema: {
      sessionId: z.string().uuid().describe("Session ID to analyze"),
    },
  }, async (args) => {
    try {
      const result = await handleSessionReport(args.sessionId, pinnedRoot);
      return {
        content: [{ type: "text" as const, text: result.output }],
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

  server.registerTool("claudestory_register_subprocess", {
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
      const session = readSession(sDir);
      if (!session) return { content: [{ type: "text" as const, text: "Error: session not found or corrupt" }], isError: true };
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

  server.registerTool("claudestory_unregister_subprocess", {
    description: "Unregister a subprocess after it completes. Idempotent -- no error if the PID was already unregistered. Relaxed validation: works even on expired/terminal sessions to allow cleanup.",
    inputSchema: {
      pid: z.number().int().positive().describe("Process ID to unregister"),
      sessionId: z.string().uuid().describe("Session ID the subprocess was registered against"),
    },
  }, (args) => {
    try {
      const sDir = sessionDir(pinnedRoot, args.sessionId);
      const session = readSession(sDir);
      if (!session) return { content: [{ type: "text" as const, text: "Error: session not found or corrupt" }], isError: true };

      unregisterSubprocess(sDir, args.pid);
      return { content: [{ type: "text" as const, text: `Unregistered subprocess ${args.pid} from session ${args.sessionId}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error unregistering subprocess: ${msg}` }], isError: true };
    }
  });

  // --- Autonomous guide ---

  server.registerTool("claudestory_autonomous_guide", {
    description: "Autonomous session orchestrator. Call at every decision point during autonomous mode. Supports tiered access: auto (full autonomous), review (code review only), plan (plan + review), guided (single ticket end-to-end).",
    inputSchema: {
      sessionId: z.string().uuid().nullable().describe("Session ID (null for start action)"),
      action: z.enum(["start", "report", "resume", "pre_compact", "cancel"]).describe("Action to perform"),
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
          id: z.string(),
          severity: z.string(),
          category: z.string(),
          description: z.string(),
          disposition: z.string(),
        })).optional().describe("Review findings"),
        reviewerSessionId: z.string().optional().describe("Codex session ID"),
        reviewer: z.string().optional().describe("Actual reviewer backend used (e.g. 'agent' when codex was unavailable)"),
        notes: z.string().optional().describe("Free-text notes"),
      }).optional().describe("Report data (required for report action)"),
    },
  }, (args) => {
    try { const sid = (args as Record<string, unknown>).sessionId as string | null; if (sid) touchLastMcpCallFile(sessionDir(pinnedRoot, sid)); } catch { /* best-effort */ }
    return handleAutonomousGuide(pinnedRoot, args as Parameters<typeof handleAutonomousGuide>[1]);
  });

  // ── T-189: Multi-lens review MCP tools ─────────────────────

  server.registerTool("claudestory_review_lenses_prepare", {
    description: "Prepare a multi-lens code/plan review. Returns lens prompts for the agent to spawn as parallel subagents. Handles activation, secrets gate, context packaging, and caching.",
    inputSchema: {
      stage: z.enum(["CODE_REVIEW", "PLAN_REVIEW"]).describe("Review stage"),
      diff: z.string().describe("The diff (code review) or plan text (plan review) to review"),
      changedFiles: z.array(z.string()).describe("List of changed file paths"),
      ticketDescription: z.string().optional().describe("Current ticket description for context"),
      reviewRound: z.number().int().min(1).optional().describe("Review round (1 = first, 2+ = subsequent)"),
      priorDeferrals: z.array(z.string()).optional().describe("issueKeys of findings the agent intentionally deferred from prior rounds"),
    },
  }, (args) => {
    try {
      const result = handlePrepare({ ...args, projectRoot: pinnedRoot });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/\/[^\s]+/g, "<path>") : "unknown error";
      return { content: [{ type: "text" as const, text: `Error preparing lens review: ${msg}` }], isError: true };
    }
  });

  server.registerTool("claudestory_review_lenses_synthesize", {
    description: "Synthesize lens results after parallel review. Validates findings, applies blocking policy, classifies origin (introduced vs pre-existing), auto-files pre-existing issues, generates merger prompt. Call after collecting all lens subagent results.",
    inputSchema: {
      stage: z.enum(["CODE_REVIEW", "PLAN_REVIEW"]).optional().describe("Review stage (defaults to CODE_REVIEW)"),
      lensResults: z.array(z.object({
        lens: z.string(),
        status: z.string(),
        findings: z.array(z.any()),
      })).describe("Results from each lens subagent"),
      activeLenses: z.array(z.string()).describe("Active lens names from prepare step"),
      skippedLenses: z.array(z.string()).describe("Skipped lens names from prepare step"),
      reviewRound: z.number().int().min(1).optional().describe("Current review round"),
      reviewId: z.string().optional().describe("Review ID from prepare step"),
      // T-192: Origin classification inputs
      diff: z.string().optional().describe("The diff being reviewed (for origin classification of findings into introduced vs pre-existing)"),
      changedFiles: z.array(z.string()).optional().describe("Changed file paths from prepare step (for origin classification)"),
      sessionId: z.string().uuid().optional().describe("Active session ID (for dedup of auto-filed pre-existing issues across review rounds)"),
    },
  }, async (args) => {
    try {
      const sessionDir = args.sessionId
        ? join(pinnedRoot, ".story", "sessions", args.sessionId)
        : undefined;
      const result = handleSynthesize({
        stage: args.stage,
        lensResults: args.lensResults,
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
      if (result.preExistingFindings.length > 0) {
        const sessionDir = args.sessionId
          ? join(pinnedRoot, ".story", "sessions", args.sessionId)
          : null;
        const alreadyFiled = sessionDir ? readFiledPreexisting(sessionDir) : new Set<string>();
        const sizeBeforeLoop = alreadyFiled.size;

        for (const f of result.preExistingFindings) {
          const dedupKey = f.issueKey ?? `${f.file ?? ""}:${f.line ?? 0}:${f.category}`;
          if (alreadyFiled.has(dedupKey)) continue;

          try {
            const { handleIssueCreate } = await import("../cli/commands/issue.js");
            const severityMap: Record<string, string> = { critical: "critical", major: "high", minor: "medium" };
            const severity = severityMap[f.severity] ?? "medium";
            const issueResult = await handleIssueCreate(
              {
                title: `[pre-existing] [${f.category}] ${f.description.slice(0, 60)}`,
                severity,
                impact: f.description,
                components: ["review-lenses"],
                relatedTickets: [],
                location: f.file && f.line != null ? [`${f.file}:${f.line}`] : [],
              },
              "json",
              pinnedRoot,
            );

            let issueId: string | undefined;
            try {
              const parsed = JSON.parse(issueResult.output ?? "");
              issueId = parsed?.data?.id;
            } catch {
              const match = issueResult.output?.match(/ISS-\d+/);
              issueId = match?.[0];
            }

            if (issueId) {
              filedIssues.push({ issueKey: dedupKey, issueId });
              alreadyFiled.add(dedupKey);
            }
          } catch {
            // Best-effort filing; finding still goes through review pipeline
          }
        }

        if (sessionDir && alreadyFiled.size > sizeBeforeLoop) {
          writeFiledPreexisting(sessionDir, alreadyFiled);
        }
      }

      const output = { ...result, filedIssues };
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/\/[^\s]+/g, "<path>") : "unknown error";
      return { content: [{ type: "text" as const, text: `Error synthesizing lens results: ${msg}` }], isError: true };
    }
  });

  server.registerTool("claudestory_review_lenses_judge", {
    description: "Prepare the judge prompt for final verdict after merger. Applies verdict calibration rules and convergence tracking. Call after running the merger agent.",
    inputSchema: {
      mergerResultRaw: z.string().describe("Raw JSON string output from the merger agent"),
      stage: z.enum(["CODE_REVIEW", "PLAN_REVIEW"]).optional().describe("Review stage (defaults to CODE_REVIEW)"),
      lensesCompleted: z.array(z.string()).describe("Lenses that completed successfully"),
      lensesFailed: z.array(z.string()).describe("Lenses that failed or timed out"),
      lensesInsufficientContext: z.array(z.string()).optional().describe("Lenses that returned insufficient-context"),
      lensesSkipped: z.array(z.string()).optional().describe("Lenses not activated for this review"),
      convergenceHistory: z.array(z.object({
        round: z.number(),
        verdict: z.string(),
        blocking: z.number(),
        important: z.number(),
        newCode: z.string(),
      })).optional().describe("Prior round verdicts for convergence tracking"),
      sourceFindings: z.array(z.unknown()).optional().describe(
        "Pre-merger validated findings from the synthesize step (`validatedFindings`). Used to restore validator-owned markers that were stripped from the merger LLM's output. CDX-13.",
      ),
    },
  }, (args) => {
    try {
      // CDX-R1-05: validate sourceFindings at the MCP boundary before
      // handing them to restoreSourceMarkers. Malformed caller input (null
      // entries, missing issueKey/evidence, wrong types) would otherwise
      // throw deep inside restoration and get swallowed by parseMergerResult's
      // outer try/catch, silently degrading the whole merger parse to the
      // null fallback path and disabling CDX-13 restoration. Invalid entries
      // are dropped; valid ones are passed through unchanged.
      const { valid: validatedSources } = validateCachedFindings(
        args.sourceFindings ?? [],
      );
      const result = handleJudge({
        mergerResultRaw: args.mergerResultRaw,
        stage: args.stage,
        lensesCompleted: args.lensesCompleted,
        lensesFailed: args.lensesFailed,
        lensesInsufficientContext: args.lensesInsufficientContext ?? [],
        lensesSkipped: args.lensesSkipped ?? [],
        convergenceHistory: args.convergenceHistory,
        sourceFindings: validatedSources as readonly LensFinding[],
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/\/[^\s]+/g, "<path>") : "unknown error";
      return { content: [{ type: "text" as const, text: `Error preparing judge: ${msg}` }], isError: true };
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
