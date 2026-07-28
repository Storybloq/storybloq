import { displayIdOf } from "./resolver.js";
import type { OutputFormat, ErrorCode } from "../models/types.js";
import type { FederationState, FederationNodeEntry } from "../federation/state.js";
import type { Config } from "../models/config.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { Roadmap } from "../models/roadmap.js";
import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import type { ValidationResult } from "./validation.js";
import type { LedgerIntegrityResult } from "./ledger-integrity.js";
import type { NextTicketOutcome, NextTicketsOutcome } from "./queries.js";
import type { RecommendResult } from "./recommend.js";
import type { ReconcileResult } from "./reconcile.js";
import type { DoctorResult } from "./team-doctor.js";
import type { ActiveSessionSummary } from "./session-scan.js";
import type { SelftestResult } from "../cli/commands/selftest.js";
import type { BusSummary } from "../bus/schemas.js";
import { describeDeliveryTiers } from "../bus/schemas.js";

type BusStatusInput =
  | BusSummary
  | { readonly enabled: true; readonly error: { readonly code: string; readonly message: string } }
  | undefined;

// Bus line(s) for the Markdown status views. D7: stays quiet until the Bus is
// enabled. T-428 adds the runtime_lost line and, for a disabled-but-evidenced
// checkout, surfaces the config-revert diagnostic (carried in nextActions) instead
// of staying silent, so a reverted `features.bus` is visible outside JSON.
function busStatusLines(bus: BusStatusInput): string[] {
  if (!bus) return [];
  if ("error" in bus) {
    return [`Bus: unavailable [${bus.error.code}] ${escapeMarkdownInline(bus.error.message)}`];
  }
  if (bus.setupState === "disabled") {
    const revert = bus.nextActions.find((action) => action.includes("config.features.bus"));
    return revert ? [`Bus: ${revert}`] : [];
  }
  if (bus.setupState === "ready") {
    // T-427: honest per-tier wording; never the raw `deliveryMode` enum (which can
    // read "live delivery" and oversell a notify-on-boundary channel as push).
    return [`Bus: ready; ${bus.endpoints} connected; delivery: ${describeDeliveryTiers(bus.deliveryCapabilities)}`];
  }
  if (bus.setupState === "waiting_for_peer") {
    return ["Bus: waiting for peer; run `storybloq bus setup` in the other task"];
  }
  if (bus.setupState === "runtime_lost") {
    // Neutral wording: runtime_lost covers both an absent runtime and one whose
    // instance no longer matches this checkout's evidence. BusSummary does not carry
    // the loss reason, so avoid asserting "deleted" for the mismatch case.
    return ["Bus: runtime lost; `.story/bus/` is absent or no longer matches this checkout's deletion-evidence; run `storybloq bus setup` to re-establish it"];
  }
  if (bus.setupState === "invalid") {
    // A present-but-broken runtime: corrupt layout or unreadable deletion-evidence.
    // Never fall through to the "not set up" line, which would misdescribe it.
    return ["Bus: invalid; the runtime or its deletion-evidence is corrupt; run `storybloq bus doctor`"];
  }
  return bus.initialized
    ? [`Bus: ${bus.setupState}`]
    : ["Bus: enabled, not set up in this checkout; run `storybloq bus setup`"];
}
import type { LimitStopSummary } from "./limit-ledger.js";
import { phasesWithStatus, isBlockerCleared } from "./queries.js";

function resolveTicketRefDisplay(ref: string, state: ProjectState): string {
  const result = state.resolveTicketRef(ref);
  if (result.kind === "found") {
    return displayIdOf(result.item);
  }
  return ref;
}

function resolveLessonRefDisplay(ref: string, state: ProjectState): string {
  const result = state.resolveLessonRef(ref);
  if (result.kind === "found") {
    return displayIdOf(result.item);
  }
  return ref;
}

/** SKILL PROTOCOL: SKILL.md Step 2b matches this literal string. Do not change without updating SKILL.md. */
export const EMPTY_SCAFFOLD_HEADING = "## Getting Started";

// --- Exit Codes ---

export const ExitCode = {
  OK: 0,
  USER_ERROR: 1,
  VALIDATION_ERROR: 2,
  PARTIAL: 3,
  // T-427 rendezvous long-poll: distinct codes so a background `bus poll --wait`
  // consumer can tell a timeout (nothing arrived) and a contended waiter (another
  // --wait already owns this endpoint) apart from a delivered message (OK) or a
  // usage/validation error. Signals (SIGINT=130, SIGTERM=143) are set directly by
  // the wait runner and are intentionally not enum members.
  TIMEOUT: 4,
  WAITER_ACTIVE: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

// --- JSON Envelopes ---

export interface SuccessEnvelope<T> {
  readonly version: 1;
  readonly data: T;
}

export interface ErrorEnvelope {
  readonly version: 1;
  readonly error: { readonly code: ErrorCode; readonly message: string };
}

export interface PartialEnvelope<T> {
  readonly version: 1;
  readonly data: T;
  readonly warnings: readonly { type: string; file: string; message: string }[];
  readonly partial: true;
}

export function successEnvelope<T>(data: T): SuccessEnvelope<T> {
  return { version: 1, data };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
): ErrorEnvelope {
  return { version: 1, error: { code, message } };
}

export function partialEnvelope<T>(
  data: T,
  warnings: readonly LoadWarning[],
): PartialEnvelope<T> {
  return {
    version: 1,
    data,
    warnings: warnings.map((w) => ({
      type: w.type,
      file: w.file,
      message: w.message,
    })),
    partial: true,
  };
}

// --- Markdown Safety ---

/**
 * Escapes only heading and list markers at the start of a line (unordered and
 * ordered) so an embedded field cannot start a new Markdown block inside the
 * formatter's own `md` output.
 *
 * This is NOT a Markdown or HTML sanitizer. Inline-structural, HTML-entity, and
 * backslash escaping were intentionally removed: the only consumers of formatter
 * output are plain-text sinks (CLI stdout and MCP `text` results to the model),
 * neither of which decodes entities or renders Markdown, so that escaping never
 * got decoded and instead leaked as visible noise like `&amp;`, `\(`, `\[`.
 * Blockquotes (`>`) and inline characters are passed through for plain-text
 * readability. Do not reintroduce inline/HTML escaping unless a real
 * Markdown/HTML renderer is added downstream.
 */
export function escapeMarkdownInline(text: string): string {
  return text
    .replace(/(^|\n)([#\-+*])/g, "$1\\$2")
    .replace(/(^|\n)(\d+)\./g, "$1$2\\.");
}

/**
 * Full Markdown + HTML escaping for content embedded in a rendered, shareable
 * document (the `storybloq export` output). Unlike escapeMarkdownInline (which
 * only guards line-start markers for plain-text sinks), this also neutralizes
 * inline structure, HTML, and link injection, because the export document is
 * meant to be opened in a Markdown viewer where an unescaped title could inject
 * a link or raw HTML.
 */
export function escapeMarkdownDocument(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_~\[\]()|])/g, "\\$1")
    .replace(/(^|\n)([#\-+*])/g, "$1\\$2")
    .replace(/(^|\n)(\d+)\./g, "$1$2\\.");
}

/**
 * Wraps multi-line content in a fenced code block.
 * Uses a fence length longer than any backtick sequence in the content.
 */
export function fencedBlock(content: string, lang?: string): string {
  let maxTicks = 2;
  const matches = content.match(/`+/g);
  if (matches) {
    for (const m of matches) {
      if (m.length > maxTicks) maxTicks = m.length;
    }
  }
  const fence = "`".repeat(maxTicks + 1);
  return `${fence}${lang ?? ""}\n${content}\n${fence}`;
}

function formatConfigHints(state: ProjectState): string[] {
  const overrides = state.config.recipeOverrides as Record<string, unknown> | undefined;
  const backends = overrides?.reviewBackends as string[] | undefined;
  const lines: string[] = [];
  if (backends && backends.length > 0) {
    lines.push(`Review backends: ${backends.join(", ")}`);
  } else {
    lines.push("Review backends: codex, agent (default). Change with `/story settings` or `storybloq config set-overrides --json '{\"reviewBackends\": [\"codex\", \"agent\"]}'`");
  }
  lines.push("");
  return lines;
}

// --- Format Functions ---

/** T-424: md lines for the limit-stopped section (shared by both status formatters). */
function limitStopsSection(limitStops: readonly LimitStopSummary[]): string[] {
  if (limitStops.length === 0) return [];
  // Neutral heading: the section mixes SCHEDULED records (stopped/deferred) with
  // in-progress and stood-down ones, so "auto-resume pending" would mislabel the
  // manual/cancelling/resuming rows.
  const lines = ["", "## Limit-stop records", ""];
  for (const s of limitStops) {
    const when = new Date(s.nextAttemptAt).toLocaleString();
    const target = s.sessionType === "autonomous" && s.storybloqSessionId
      ? `session ${s.storybloqSessionId.slice(0, 8)}`
      : `plain session ${s.clientTaskId.slice(0, 8)}`;
    // Action text follows STATUS, not just mode: only stopped/deferred are
    // actually SCHEDULED; manual is stood down, resuming/interactive are
    // in-progress, and cancelling/preparing are transitions.
    const action = s.status === "manual"
      ? (s.reasonCode === "cancellation_blocked"
          ? "cancellation blocked on a live wake child"
          : `stood down -- requeue: storybloq limit-status --requeue ${s.key}`)
      : s.status === "cancelling"
        ? "cancellation in progress"
        : s.status === "preparing"
          ? "detection in progress"
          : s.status === "resuming"
            ? "auto-resume in progress"
            : s.status === "interactive"
              ? "interactive resume in progress"
              : s.mode === "headless" ? `auto-resumes ~${when}` : `notifies ~${when}`;
    const reason = s.reasonCode ? ` [${s.reasonCode}]` : "";
    lines.push(`- ${target} -- ${s.status}${reason}, ${s.limitType} limit, ${action} (attempts ${s.wakeAttempts})`);
  }
  lines.push("", "Manage with: storybloq limit-status [--cancel <key>] [--requeue <key>]");
  return lines;
}

export function formatStatus(
  state: ProjectState,
  format: OutputFormat,
  activeSessions: readonly ActiveSessionSummary[] = [],
  resumableSessions: readonly ActiveSessionSummary[] = [],
  bus?: BusSummary | { readonly enabled: true; readonly error: { readonly code: string; readonly message: string } },
  limitStops: readonly LimitStopSummary[] = [],
): string {
  const phases = phasesWithStatus(state);
  const data = {
    project: state.config.project,
    totalTickets: state.leafTicketCount,
    completeTickets: state.completeLeafTicketCount,
    openTickets: state.leafTicketCount - state.completeLeafTicketCount,
    blockedTickets: state.blockedCount,
    openIssues: state.activeIssueCount,
    activeNotes: state.activeNoteCount,
    archivedNotes: state.archivedNoteCount,
    activeLessons: state.activeLessonCount,
    deprecatedLessons: state.deprecatedLessonCount,
    handovers: state.handoverFilenames.length,
    isEmptyScaffold: state.isEmptyScaffold,
    phases: phases.map((p) => ({
      id: p.phase.id,
      name: p.phase.name,
      status: p.status,
      leafCount: p.leafCount,
    })),
    ...(activeSessions.length > 0 ? { activeSessions } : {}),
    ...(resumableSessions.length > 0 ? { resumableSessions } : {}),
    ...(bus ? { bus } : {}),
    ...(limitStops.length > 0 ? { limitStops } : {}),
  };

  if (format === "json") {
    return JSON.stringify(successEnvelope(data), null, 2);
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(state.config.project)}`,
    "",
    `Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete, ${state.blockedCount} blocked`,
    `Issues: ${state.activeIssueCount} open`,
    `Notes: ${state.activeNoteCount} active, ${state.archivedNoteCount} archived`,
    `Lessons: ${state.activeLessonCount} active, ${state.deprecatedLessonCount} deprecated`,
    `Handovers: ${state.handoverFilenames.length}`,
    ...busStatusLines(bus),
    "",
    ...formatConfigHints(state),
    "## Phases",
    "",
  ];
  for (const p of phases) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    const summary = p.phase.summary ?? truncate(p.phase.description, 80);
    lines.push(`${indicator} **${escapeMarkdownInline(p.phase.name)}** (${p.leafCount} tickets) — ${escapeMarkdownInline(summary)}`);
  }

  const resumableIds = new Set(resumableSessions.map((session) => session.sessionId));
  const ordinaryActiveSessions = activeSessions.filter((session) => !resumableIds.has(session.sessionId));
  if (ordinaryActiveSessions.length > 0) {
    lines.push("");
    lines.push("## Active Sessions");
    lines.push("");
    for (const s of ordinaryActiveSessions) {
      const ticket = s.ticketId ? `${s.ticketId}: ${escapeMarkdownInline(s.ticketTitle ?? "")}` : "no ticket";
      const owner = s.ownerTask ? ` in a ${s.ownerTask.client === "codex" ? "Codex" : "Claude Code"} task` : "";
      lines.push(`- ${ticket} -- ${s.state}${owner} (${s.mode} mode)`);
    }
  }

  if (resumableSessions.length > 0) {
    lines.push("");
    lines.push("## Resumable Sessions");
    lines.push("");
    for (const s of resumableSessions) {
      const ticket = s.ticketId ? `${s.ticketId}: ${escapeMarkdownInline(s.ticketTitle ?? "")}` : `session ${s.sessionId.slice(0, 8)}`;
      const lease = s.leaseState === "expired" ? "expired lease" : `${s.leaseState ?? "unknown"} lease`;
      lines.push(`- ${ticket} -- COMPACT recovery available (${lease})`);
    }
  }

  lines.push(...limitStopsSection(limitStops));

  if (state.isEmptyScaffold) {
    lines.push("");
    lines.push(EMPTY_SCAFFOLD_HEADING);
    lines.push("");
    lines.push("This project has been initialized but has no tickets, issues, or handovers yet.");
    lines.push("Run the /story setup flow to analyze your project and create an initial roadmap.");
  }

  return lines.join("\n");
}

export function formatFederatedStatus(
  fedState: FederationState,
  config: Config,
  format: OutputFormat,
  activeSessions: readonly ActiveSessionSummary[] = [],
  resumableSessions: readonly ActiveSessionSummary[] = [],
  bus?: BusSummary | { readonly enabled: true; readonly error: { readonly code: string; readonly message: string } },
  limitStops: readonly LimitStopSummary[] = [],
): string {
  const sanitizedNodes = fedState.nodes.map((node) => ({
    name: node.name,
    rawPath: node.rawPath,
    health: node.health,
    role: node.role,
    summary: node.summary,
    dependsOn: node.dependsOn,
    reachable: node.reachable,
    scanSummary: node.scanSummary,
  }));
  const data = {
    federation: { ...fedState, nodes: sanitizedNodes },
    project: config.project,
    type: config.type,
    ...(activeSessions.length > 0 ? { activeSessions } : {}),
    ...(resumableSessions.length > 0 ? { resumableSessions } : {}),
    ...(bus ? { bus } : {}),
    ...(limitStops.length > 0 ? { limitStops } : {}),
  };

  if (format === "json") {
    return JSON.stringify(successEnvelope(data), null, 2);
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(fedState.orchestratorProject)} (orchestrator)`,
    "",
    `Federation: ${fedState.nodeCount} nodes (${fedState.reachableCount} reachable${fedState.unreachableCount > 0 ? `, ${fedState.unreachableCount} unreachable` : ""})`,
    `Tickets: ${fedState.totalCompleteTickets}/${fedState.totalTickets} across all nodes | Issues: ${fedState.totalOpenIssues} open`,
    ...busStatusLines(bus),
    "",
  ];

  const overrides = config.recipeOverrides as Record<string, unknown> | undefined;
  const backends = overrides?.reviewBackends as string[] | undefined;
  if (backends && backends.length > 0) {
    lines.push(`Review backends: ${backends.join(", ")}`);
    lines.push("");
  }

  lines.push("## Nodes");
  lines.push("");
  lines.push("| Node | Health | Tickets | Issues | Last Activity | Role |");
  lines.push("|------|--------|---------|--------|---------------|------|");

  for (const node of fedState.nodes) {
    if (node.reachable && node.scanSummary) {
      const s = node.scanSummary;
      lines.push(
        `| ${escapeMarkdownInline(node.name)} | ${escapeMarkdownInline(node.health)} | ${s.completeTickets}/${s.ticketCount} | ${s.openIssues} open | ${escapeMarkdownInline(s.lastHandoverDate ?? "none")} | ${escapeMarkdownInline(node.role)} |`,
      );
    } else {
      lines.push(
        `| ${escapeMarkdownInline(node.name)} | ${escapeMarkdownInline(node.health)} | -- | -- | unreachable | ${escapeMarkdownInline(node.role)} |`,
      );
    }
  }

  const resumableIds = new Set(resumableSessions.map((session) => session.sessionId));
  const ordinaryActiveSessions = activeSessions.filter((session) => !resumableIds.has(session.sessionId));
  if (ordinaryActiveSessions.length > 0) {
    lines.push("");
    lines.push("## Active Sessions");
    lines.push("");
    for (const s of ordinaryActiveSessions) {
      const ticket = s.ticketId ? `${s.ticketId}: ${escapeMarkdownInline(s.ticketTitle ?? "")}` : "no ticket";
      lines.push(`- ${ticket} -- ${s.state} (${s.mode} mode)`);
    }
  }

  if (resumableSessions.length > 0) {
    lines.push("");
    lines.push("## Resumable Sessions");
    lines.push("");
    for (const s of resumableSessions) {
      const ticket = s.ticketId ? `${s.ticketId}: ${escapeMarkdownInline(s.ticketTitle ?? "")}` : `session ${s.sessionId.slice(0, 8)}`;
      lines.push(`- ${ticket} -- COMPACT recovery available (${s.leaseState ?? "unknown"} lease)`);
    }
  }

  lines.push(...limitStopsSection(limitStops));

  return lines.join("\n");
}

export function formatPhaseList(
  state: ProjectState,
  format: OutputFormat,
): string {
  const phases = phasesWithStatus(state);
  const data = phases.map((p) => ({
    id: p.phase.id,
    label: p.phase.label,
    name: p.phase.name,
    description: p.phase.summary ?? p.phase.description,
    status: p.status,
    leafCount: p.leafCount,
  }));

  if (format === "json") {
    return JSON.stringify(successEnvelope(data), null, 2);
  }

  const lines: string[] = [];
  for (const p of data) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    lines.push(`${indicator} **${escapeMarkdownInline(p.name)}** (${p.id}) — ${p.leafCount} tickets — ${escapeMarkdownInline(truncate(p.description, 80))}`);
  }
  return lines.join("\n");
}

export function formatPhaseTickets(
  phaseId: string,
  state: ProjectState,
  format: OutputFormat,
): string {
  const tickets = state.phaseTickets(phaseId);
  if (format === "json") {
    return JSON.stringify(successEnvelope(tickets), null, 2);
  }
  if (tickets.length === 0) return "No tickets in this phase.";
  return tickets.map((t) => formatTicketOneLiner(t, state)).join("\n");
}

export function formatTicket(
  ticket: Ticket,
  state: ProjectState,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(ticket), null, 2);
  }

  const blocked = state.isBlocked(ticket) ? " [BLOCKED]" : "";
  const lines: string[] = [
    `# ${escapeMarkdownInline(displayIdOf(ticket))}: ${escapeMarkdownInline(ticket.title)}${blocked}`,
    "",
    `Status: ${ticket.status} | Type: ${ticket.type} | Phase: ${ticket.phase ?? "none"} | Order: ${ticket.order}`,
    `Created: ${ticket.createdDate}${ticket.completedDate ? ` | Completed: ${ticket.completedDate}` : ""}`,
  ];
  if (ticket.blockedBy.length > 0) {
    lines.push(`Blocked by: ${ticket.blockedBy.map((ref) => resolveTicketRefDisplay(ref, state)).join(", ")}`);
  }
  if (ticket.crossNodeBlockedBy && ticket.crossNodeBlockedBy.length > 0) {
    lines.push(`Cross-node blocked by: ${ticket.crossNodeBlockedBy.join(", ")}`);
  }
  if (ticket.parentTicket) {
    lines.push(`Parent: ${resolveTicketRefDisplay(ticket.parentTicket, state)}`);
  }
  if (ticket.description) {
    lines.push("", "## Description", "", fencedBlock(ticket.description));
  }
  return lines.join("\n");
}

export function formatNextTicketOutcome(
  outcome: NextTicketOutcome,
  state: ProjectState,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(outcome), null, 2);
  }

  switch (outcome.kind) {
    case "empty_project":
      return "No phased tickets found.";

    case "all_complete":
      return "All phases complete.";

    case "all_blocked": {
      return `All ${outcome.blockedCount} incomplete tickets in phase "${escapeMarkdownInline(outcome.phaseId)}" are blocked.`;
    }

    case "found": {
      const t = outcome.ticket;
      const lines: string[] = [
        `# Next: ${escapeMarkdownInline(displayIdOf(t))} — ${escapeMarkdownInline(t.title)}`,
        "",
        `Phase: ${t.phase ?? "none"} | Order: ${t.order} | Type: ${t.type}`,
      ];

      if (outcome.unblockImpact.wouldUnblock.length > 0) {
        const ids = outcome.unblockImpact.wouldUnblock.map((u) => displayIdOf(u)).join(", ");
        lines.push(`Completing this unblocks: ${ids}`);
      }

      if (outcome.umbrellaProgress) {
        const p = outcome.umbrellaProgress;
        lines.push(`Parent progress: ${p.complete}/${p.total} complete (${p.status})`);
      }

      if (t.description) {
        lines.push("", fencedBlock(t.description));
      }

      return lines.join("\n");
    }
  }
}

export function formatNextTicketsOutcome(
  outcome: NextTicketsOutcome,
  state: ProjectState,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(outcome), null, 2);
  }

  switch (outcome.kind) {
    case "empty_project":
      return "No phased tickets found.";

    case "all_complete":
      return "All phases complete.";

    case "all_blocked": {
      const details = outcome.phases
        .map((p) => `${escapeMarkdownInline(p.phaseId)} (${p.blockedCount} blocked)`)
        .join(", ");
      return `All incomplete tickets are blocked across ${outcome.phases.length} phase${outcome.phases.length === 1 ? "" : "s"}: ${details}`;
    }

    case "found": {
      const { candidates, skippedBlockedPhases } = outcome;
      const lines: string[] = [];

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const t = c.ticket;

        if (i > 0) lines.push("", "---", "");

        // Single candidate: use # Next: format; multiple: use numbered format
        const tLabel = displayIdOf(t);
        if (candidates.length === 1) {
          lines.push(`# Next: ${escapeMarkdownInline(tLabel)} — ${escapeMarkdownInline(t.title)}`);
        } else {
          lines.push(`# ${i + 1}. ${escapeMarkdownInline(tLabel)} — ${escapeMarkdownInline(t.title)}`);
        }
        lines.push("", `Phase: ${t.phase ?? "none"} | Order: ${t.order} | Type: ${t.type}`);

        if (c.unblockImpact.wouldUnblock.length > 0) {
          const ids = c.unblockImpact.wouldUnblock.map((u) => displayIdOf(u)).join(", ");
          lines.push(`Completing this unblocks: ${ids}`);
        }

        if (c.umbrellaProgress) {
          const p = c.umbrellaProgress;
          lines.push(`Parent progress: ${p.complete}/${p.total} complete (${p.status})`);
        }

        if (t.description) {
          lines.push("", fencedBlock(t.description));
        }
      }

      if (skippedBlockedPhases.length > 0) {
        const details = skippedBlockedPhases
          .map((p) => `${escapeMarkdownInline(p.phaseId)} (${p.blockedCount} blocked)`)
          .join(", ");
        lines.push("", "---", "", `Skipped blocked phases: ${details}`);
      }

      return lines.join("\n");
    }
  }
}

export function formatTicketList(
  tickets: readonly Ticket[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(tickets), null, 2);
  }
  if (tickets.length === 0) return "No tickets found.";
  const lines: string[] = [];
  for (const t of tickets) {
    const status = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
    lines.push(`${status} ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} (${t.phase ?? "none"})`);
  }
  return lines.join("\n");
}

export function formatIssue(
  issue: Issue,
  format: OutputFormat,
  state?: ProjectState,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(issue), null, 2);
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(displayIdOf(issue))}: ${escapeMarkdownInline(issue.title)}`,
    "",
    `Status: ${issue.status} | Severity: ${issue.severity} | Phase: ${issue.phase ?? "none"} | Order: ${issue.order ?? "none"}`,
    `Components: ${issue.components.join(", ") || "none"}`,
    `Discovered: ${issue.discoveredDate}${issue.resolvedDate ? ` | Resolved: ${issue.resolvedDate}` : ""}`,
  ];
  if (issue.location.length > 0) {
    lines.push(`Location: ${issue.location.join(", ")}`);
  }
  if (issue.sourceRefs && issue.sourceRefs.length > 0) {
    const refs = issue.sourceRefs.map((ref) => {
      const end = ref.endLine ?? ref.startLine;
      const revision = ref.revision ? ` @ ${ref.revision.slice(0, 12)}` : "";
      const review = ref.reviewId ? ` [${ref.reviewId}]` : "";
      return `${ref.path}:${ref.startLine}-${end}${revision}${review}`;
    });
    lines.push(`Source evidence: ${refs.join(", ")}`);
  }
  if (issue.relatedTickets.length > 0) {
    const display = state
      ? issue.relatedTickets.map((ref) => resolveTicketRefDisplay(ref, state)).join(", ")
      : issue.relatedTickets.join(", ");
    lines.push(`Related: ${display}`);
  }
  lines.push("", "## Impact", "", fencedBlock(issue.impact));
  if (issue.resolution) {
    lines.push("", "## Resolution", "", fencedBlock(issue.resolution));
  }
  return lines.join("\n");
}

export function formatIssueList(
  issues: readonly Issue[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(issues), null, 2);
  }
  if (issues.length === 0) return "No issues found.";
  const lines: string[] = [];
  for (const i of issues) {
    const status = i.status === "resolved" ? "[x]" : "[ ]";
    lines.push(`${status} ${displayIdOf(i)} [${i.severity}]: ${escapeMarkdownInline(i.title)} (${i.phase ?? "none"})`);
  }
  return lines.join("\n");
}

export function formatBlockedTickets(
  tickets: readonly Ticket[],
  state: ProjectState,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        tickets.map((t) => ({
          ...t,
          blockers: t.blockedBy.map((bid) => ({
            id: bid,
            status: state.ticketByID(bid)?.status ?? "unknown",
          })),
        })),
      ),
      null,
      2,
    );
  }
  if (tickets.length === 0) return "No blocked tickets.";
  const lines: string[] = [];
  for (const t of tickets) {
    const blockerInfo = t.blockedBy
      .map((bid) => {
        const resolved = state.resolveTicketRef(bid);
        if (resolved.kind === "found") {
          return `${displayIdOf(resolved.item)} (${resolved.item.status})`;
        }
        return `${bid} (unknown)`;
      })
      .join(", ");
    lines.push(`${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} — blocked by: ${blockerInfo}`);
  }
  return lines.join("\n");
}

export function formatValidation(
  result: ValidationResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }

  const lines: string[] = [
    result.valid ? "Validation passed." : "Validation failed.",
    `Errors: ${result.errorCount} | Warnings: ${result.warningCount} | Info: ${result.infoCount}`,
  ];

  if (result.findings.length > 0) {
    lines.push("");
    for (const f of result.findings) {
      const prefix = f.level === "error" ? "ERROR" : f.level === "warning" ? "WARN" : "INFO";
      const entity = f.entity ? `[${escapeMarkdownInline(f.entity)}] ` : "";
      lines.push(`${prefix}: ${entity}${escapeMarkdownInline(f.message)}`);
    }
  }

  return lines.join("\n");
}

export function formatLedgerIntegrity(
  result: LedgerIntegrityResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }

  const lines = [
    result.valid ? "Ledger integrity passed." : "Ledger integrity failed.",
    `Scanned: ${result.scannedFiles} JSON file(s) | Errors: ${result.errorCount}`,
    `Critical: ${result.criticalErrorCount} | Items: ${result.itemErrorCount} | Auxiliary: ${result.auxiliaryErrorCount}`,
  ];
  if (result.skippedSymlinks > 0) {
    lines.push(`Skipped symlinks: ${result.skippedSymlinks}`);
  }
  if (result.findings.length > 0) {
    lines.push("");
    for (const finding of result.findings) {
      const position = finding.line
        ? ` at line ${finding.line}${finding.column ? `, column ${finding.column}` : ""}`
        : "";
      lines.push(
        `ERROR [${finding.classification}] ${escapeMarkdownInline(finding.file)}${position}: ${escapeMarkdownInline(finding.message)}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatBlockerList(
  roadmap: Roadmap,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(
      successEnvelope(
        roadmap.blockers.map((b) => ({
          name: b.name,
          cleared: isBlockerCleared(b),
          note: b.note ?? null,
          createdDate: b.createdDate ?? null,
          clearedDate: b.clearedDate ?? null,
        })),
      ),
      null,
      2,
    );
  }

  if (roadmap.blockers.length === 0) return "No blockers.";
  const lines: string[] = [];
  for (const b of roadmap.blockers) {
    const status = isBlockerCleared(b) ? "[x]" : "[ ]";
    const note = b.note ? ` — ${escapeMarkdownInline(b.note)}` : "";
    lines.push(`${status} ${escapeMarkdownInline(b.name)}${note}`);
  }
  return lines.join("\n");
}

export function formatNote(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }

  const title = note.title ?? `${note.createdDate} — ${displayIdOf(note)}`;
  const statusBadge = note.status === "archived" ? " (archived)" : "";
  const lines: string[] = [
    `# ${escapeMarkdownInline(title)}${statusBadge}`,
    "",
    `Status: ${note.status}`,
  ];
  if (note.tags.length > 0) {
    lines.push(`Tags: ${note.tags.join(", ")}`);
  }
  lines.push(`Created: ${note.createdDate} | Updated: ${note.updatedDate}`);
  lines.push("", fencedBlock(note.content));
  return lines.join("\n");
}

export function formatNoteList(
  notes: readonly Note[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(notes), null, 2);
  }
  if (notes.length === 0) return "No notes found.";
  const lines: string[] = [];
  for (const n of notes) {
    const title = n.title ?? displayIdOf(n);
    const status = n.status === "archived" ? "[x]" : "[ ]";
    const tagInfo = n.status === "archived"
      ? " (archived)"
      : n.tags.length > 0
        ? ` (${n.tags.join(", ")})`
        : "";
    lines.push(`${status} ${displayIdOf(n)}: ${escapeMarkdownInline(title)}${tagInfo}`);
  }
  return lines.join("\n");
}

export function formatNoteCreateResult(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }
  const displayId = displayIdOf(note);
  return `Created note ${displayId}: ${note.title ?? displayId}`;
}

export function formatNoteUpdateResult(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }
  const displayId = displayIdOf(note);
  return `Updated note ${displayId}: ${note.title ?? displayId}`;
}

export function formatNoteDeleteResult(
  id: string,
  format: OutputFormat,
  alreadyDeleted = false,
): string {
  // ISS-757: team-mode re-delete of a tombstoned note is a silent success
  // (exit 0) that preserves the existing tombstone; surface it distinctly.
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ id, deleted: true, ...(alreadyDeleted ? { alreadyDeleted: true } : {}) }),
      null,
      2,
    );
  }
  if (alreadyDeleted) {
    return `Note ${id} is already deleted; existing tombstone preserved.`;
  }
  return `Deleted note ${id}.`;
}

// --- Lesson formatters ---

export function formatLesson(
  lesson: Lesson,
  format: OutputFormat,
  state?: ProjectState,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }

  const statusBadge = lesson.status !== "active" ? ` (${lesson.status})` : "";
  const lines: string[] = [
    `# ${escapeMarkdownInline(lesson.title)}${statusBadge}`,
    "",
    `Status: ${lesson.status} | Source: ${lesson.source} | Reinforcements: ${lesson.reinforcements}`,
  ];
  if (lesson.tags.length > 0) {
    lines.push(`Tags: ${lesson.tags.join(", ")}`);
  }
  lines.push(`Created: ${lesson.createdDate} | Updated: ${lesson.updatedDate} | Last validated: ${lesson.lastValidated}`);
  if (lesson.supersedes) {
    lines.push(`Supersedes: ${state ? resolveLessonRefDisplay(lesson.supersedes, state) : lesson.supersedes}`);
  }
  lines.push("", "## Content", "", lesson.content);
  if (lesson.context) {
    lines.push("", "## Context", "", lesson.context);
  }
  return lines.join("\n");
}

export function formatLessonList(
  lessons: readonly Lesson[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lessons), null, 2);
  }
  if (lessons.length === 0) return "No lessons found.";
  const lines: string[] = [];
  for (const l of lessons) {
    const status = l.status === "active" ? "[ ]" : "[x]";
    const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements})` : "";
    const tagInfo = l.tags.length > 0 ? ` [${l.tags.join(", ")}]` : "";
    lines.push(`${status} ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)}${reinforced}${tagInfo}`);
  }
  return lines.join("\n");
}

export function formatLessonDigest(
  digest: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ digest }), null, 2);
  }
  if (!digest) return "No active lessons.";
  return digest;
}

export function formatLessonCreateResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Created lesson ${displayIdOf(lesson)}: ${lesson.title}`;
}

export function formatLessonUpdateResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Updated lesson ${displayIdOf(lesson)}: ${lesson.title}`;
}

export function formatLessonReinforceResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Reinforced lesson ${displayIdOf(lesson)}: ${lesson.title} (×${lesson.reinforcements})`;
}

export function formatLessonDeleteResult(
  id: string,
  format: OutputFormat,
  alreadyDeleted = false,
): string {
  // ISS-757: team-mode re-delete of a tombstoned lesson is a silent success
  // (exit 0) that preserves the existing tombstone; surface it distinctly.
  if (format === "json") {
    return JSON.stringify(
      successEnvelope({ id, deleted: true, ...(alreadyDeleted ? { alreadyDeleted: true } : {}) }),
      null,
      2,
    );
  }
  if (alreadyDeleted) {
    return `Lesson ${id} is already deleted; existing tombstone preserved.`;
  }
  return `Deleted lesson ${id}.`;
}

export function formatError(
  code: ErrorCode,
  message: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(errorEnvelope(code, message), null, 2);
  }
  return `Error [${code}]: ${escapeMarkdownInline(message)}`;
}

export function formatInitResult(
  result: { root: string; created: readonly string[]; warnings: readonly string[] },
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  const lines = [`Initialized .story/ at ${escapeMarkdownInline(result.root)}`, "", ...result.created.map((f) => `  ${f}`)];
  if (result.warnings.length > 0) {
    lines.push("", `Warning: ${result.warnings.length} corrupt file(s) found. Run \`storybloq validate\` to inspect.`);
  }
  lines.push("", "Tip: Run `storybloq setup --client all` to install the Storybloq skill, MCP, and hooks.");
  return lines.join("\n");
}

export function formatHandoverList(
  filenames: readonly string[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(filenames), null, 2);
  }
  if (filenames.length === 0) return "No handovers found.";
  return filenames.join("\n");
}

export function formatHandoverContent(
  filename: string,
  content: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ filename, content }), null, 2);
  }
  // MD mode: raw content as-is (it's already markdown)
  return content;
}

export function formatHandoverCreateResult(
  filename: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ filename }), null, 2);
  }
  return `Created handover: ${filename}`;
}

// --- Snapshot / Recap / Export ---

import type { RecapResult, SnapshotDiff } from "./snapshot.js";

export function formatSnapshotResult(
  result: { filename: string; retained: number; pruned: number },
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  let line = `Snapshot saved: ${result.filename} (${result.retained} retained`;
  if (result.pruned > 0) line += `, ${result.pruned} pruned`;
  line += ")";
  return line;
}

export function formatRecap(
  recap: RecapResult,
  state: ProjectState,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(recap), null, 2);
  }

  const lines: string[] = [];

  if (!recap.snapshot) {
    // No snapshot fallback — show status + note
    lines.push(`# ${escapeMarkdownInline(state.config.project)} — Recap`);
    lines.push("");
    lines.push("No snapshot found. Run `storybloq snapshot` to enable session diffs.");
    lines.push("");
    lines.push(`Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete, ${state.blockedCount} blocked`);
    lines.push(`Issues: ${state.activeIssueCount} open`);
  } else {
    lines.push(`# ${escapeMarkdownInline(state.config.project)} — Recap`);
    lines.push("");
    lines.push(`Since snapshot: ${recap.snapshot.createdAt}`);
    if (recap.partial) {
      lines.push("**Note:** Snapshot was taken from a project with integrity warnings. Diff may be incomplete.");
    }
    if (recap.staleness) {
      if (recap.staleness.status === "diverged") {
        // Genuinely anomalous: the snapshot's commit is no longer in history, so
        // the diff below may compare against work that no longer exists. Keeps the
        // Warning prefix.
        lines.push("**Warning:** Snapshot commit is not an ancestor of current HEAD (history diverged; possible rebase, force-push, or branch switch).");
      } else if (recap.staleness.status === "behind" && (recap.staleness.commitsBehind ?? 0) > 0) {
        // ISS-889: being behind HEAD is the ORDINARY state of a snapshot -- you
        // take one, then you keep working. Labelling routine progress a warning
        // teaches readers to skip the prefix, which costs the diverged case above
        // the attention it actually needs. Stated as the plain fact it is; the
        // count is there for anyone who wants to judge how stale that is.
        const commits = recap.staleness.commitsBehind ?? 0;
        lines.push(`Snapshot is ${commits} commit${commits === 1 ? "" : "s"} behind HEAD.`);
      }
    }

    const changes = recap.changes!;
    const hasChanges = hasAnyChanges(changes);

    if (!hasChanges) {
      lines.push("");
      lines.push("No changes since last snapshot.");
    } else {
      // Phase transitions
      if (changes.phases.statusChanged.length > 0) {
        lines.push("");
        lines.push("## Phase Transitions");
        for (const p of changes.phases.statusChanged) {
          lines.push(`- **${escapeMarkdownInline(p.name)}** (${p.id}): ${p.from} → ${p.to}`);
        }
      }

      // Ticket changes
      const ticketChanges = changes.tickets;
      if (ticketChanges.added.length > 0 || ticketChanges.removed.length > 0 || ticketChanges.statusChanged.length > 0 || ticketChanges.descriptionChanged.length > 0) {
        lines.push("");
        lines.push("## Tickets");
        for (const t of ticketChanges.statusChanged) {
          lines.push(`- ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} — ${t.from} → ${t.to}`);
        }
        for (const t of ticketChanges.added) {
          lines.push(`- ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} — **new**`);
        }
        for (const t of ticketChanges.removed) {
          lines.push(`- ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)} — **removed**`);
        }
        for (const t of ticketChanges.descriptionChanged) {
          lines.push(`- ${displayIdOf(t)}: description updated`);
        }
      }

      // Issue changes
      const issueChanges = changes.issues;
      if (issueChanges.added.length > 0 || issueChanges.resolved.length > 0 || issueChanges.statusChanged.length > 0 || issueChanges.impactChanged.length > 0) {
        lines.push("");
        lines.push("## Issues");
        for (const i of issueChanges.resolved) {
          lines.push(`- ${displayIdOf(i)}: ${escapeMarkdownInline(i.title)} — **resolved**`);
        }
        for (const i of issueChanges.statusChanged) {
          lines.push(`- ${displayIdOf(i)}: ${escapeMarkdownInline(i.title)} — ${i.from} → ${i.to}`);
        }
        for (const i of issueChanges.added) {
          lines.push(`- ${displayIdOf(i)}: ${escapeMarkdownInline(i.title)} — **new**`);
        }
        for (const i of issueChanges.impactChanged) {
          lines.push(`- ${displayIdOf(i)}: impact updated`);
        }
      }

      // Blocker changes
      if (changes.blockers.added.length > 0 || changes.blockers.cleared.length > 0) {
        lines.push("");
        lines.push("## Blockers");
        for (const name of changes.blockers.cleared) {
          lines.push(`- ${escapeMarkdownInline(name)} — **cleared**`);
        }
        for (const name of changes.blockers.added) {
          lines.push(`- ${escapeMarkdownInline(name)} — **new**`);
        }
      }

      // Handover changes
      if (changes.handovers && (changes.handovers.added.length > 0 || changes.handovers.removed.length > 0)) {
        lines.push("");
        lines.push("## Handovers");
        for (const h of changes.handovers.added) {
          lines.push(`- ${h} — **new**`);
        }
        for (const h of changes.handovers.removed) {
          lines.push(`- ${h} — removed`);
        }
      }

      // Note changes
      if (changes.notes && (changes.notes.added.length > 0 || changes.notes.removed.length > 0 || changes.notes.updated.length > 0)) {
        lines.push("");
        lines.push("## Notes");
        for (const n of changes.notes.added) {
          lines.push(`- ${displayIdOf(n)}: added`);
        }
        for (const n of changes.notes.removed) {
          lines.push(`- ${displayIdOf(n)}: removed`);
        }
        for (const n of changes.notes.updated) {
          lines.push(`- ${displayIdOf(n)}: updated (${n.changedFields.join(", ")})`);
        }
      }

      // Lesson changes
      if (changes.lessons && (changes.lessons.added.length > 0 || changes.lessons.removed.length > 0 || changes.lessons.updated.length > 0 || changes.lessons.reinforced.length > 0)) {
        lines.push("");
        lines.push("## Lessons");
        for (const l of changes.lessons.added) {
          lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)} — **new**`);
        }
        for (const l of changes.lessons.removed) {
          lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)} — removed`);
        }
        for (const l of changes.lessons.updated) {
          lines.push(`- ${displayIdOf(l)}: updated (${l.changedFields.join(", ")})`);
        }
        for (const l of changes.lessons.reinforced) {
          lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownInline(l.title)} — reinforced (${l.from} → ${l.to})`);
        }
      }
    }
  }

  // Suggested actions (always shown)
  const actions = recap.suggestedActions;
  lines.push("");
  lines.push("## Suggested Actions");

  if (actions.nextTicket) {
    lines.push(`- **Next:** ${displayIdOf(actions.nextTicket)} — ${escapeMarkdownInline(actions.nextTicket.title)}${actions.nextTicket.phase ? ` (${actions.nextTicket.phase})` : ""}`);
  }

  if (actions.highSeverityIssues.length > 0) {
    for (const i of actions.highSeverityIssues) {
      lines.push(`- **${i.severity} issue:** ${displayIdOf(i)} — ${escapeMarkdownInline(i.title)}`);
    }
  }

  if (actions.recentlyClearedBlockers.length > 0) {
    lines.push(`- **Recently cleared:** ${actions.recentlyClearedBlockers.map(escapeMarkdownInline).join(", ")}`);
  }

  if (!actions.nextTicket && actions.highSeverityIssues.length === 0 && actions.recentlyClearedBlockers.length === 0) {
    lines.push("- No urgent actions.");
  }

  return lines.join("\n");
}

export function formatExport(
  state: ProjectState,
  mode: "all" | "phase",
  phaseId: string | null,
  format: OutputFormat,
): string {
  if (mode === "phase" && phaseId) {
    return formatPhaseExport(state, phaseId, format);
  }
  return formatFullExport(state, format);
}

function formatPhaseExport(
  state: ProjectState,
  phaseId: string,
  format: OutputFormat,
): string {
  const phase = state.roadmap.phases.find((p) => p.id === phaseId);
  if (!phase) {
    // Should be caught upstream, but defensive
    return formatError("not_found", `Phase "${phaseId}" not found`, format);
  }

  const phaseStatus = state.phaseStatus(phaseId);
  const leaves = state.phaseTickets(phaseId);

  // Collect umbrella ancestors
  const umbrellaAncestors = new Map<string, Ticket>();
  for (const leaf of leaves) {
    if (leaf.parentTicket) {
      const parent = state.ticketByID(leaf.parentTicket);
      if (parent && !umbrellaAncestors.has(parent.id)) {
        umbrellaAncestors.set(parent.id, parent);
      }
    }
  }

  // Cross-phase dependencies
  const crossPhaseDeps = new Map<string, Ticket>();
  for (const leaf of leaves) {
    for (const blockerId of leaf.blockedBy) {
      const blocker = state.ticketByID(blockerId);
      if (blocker && blocker.phase !== phaseId && !crossPhaseDeps.has(blocker.id)) {
        crossPhaseDeps.set(blocker.id, blocker);
      }
    }
  }

  // Related issues
  const relatedIssues = state.activeIssues.filter(
    (i) =>
      i.status !== "resolved" &&
      (i.phase === phaseId ||
        i.relatedTickets.some((tid) => {
          const t = state.ticketByID(tid);
          return t && t.phase === phaseId;
        })),
  );

  // Active blockers
  const activeBlockers = state.roadmap.blockers.filter(
    (b) => !isBlockerCleared(b),
  );

  if (format === "json") {
    return JSON.stringify(
      successEnvelope({
        phase: { id: phase.id, name: phase.name, description: phase.description, status: phaseStatus },
        tickets: leaves.map((t) => ({ id: t.id, title: t.title, status: t.status, type: t.type, order: t.order })),
        umbrellaAncestors: [...umbrellaAncestors.values()].map((t) => ({ id: t.id, title: t.title })),
        crossPhaseDependencies: [...crossPhaseDeps.values()].map((t) => ({ id: t.id, title: t.title, status: t.status, phase: t.phase })),
        issues: relatedIssues.map((i) => ({ id: i.id, title: i.title, severity: i.severity, status: i.status })),
        blockers: activeBlockers.map((b) => ({ name: b.name, note: b.note ?? null })),
      }),
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`# ${escapeMarkdownDocument(phase.name)} (${phase.id})`);
  lines.push("");
  lines.push(`Status: ${phaseStatus}`);
  if (phase.description) {
    lines.push(`Description: ${escapeMarkdownDocument(phase.description)}`);
  }

  if (leaves.length > 0) {
    lines.push("");
    lines.push("## Tickets");
    for (const t of leaves) {
      const indicator = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
      const parentLabel = t.parentTicket && umbrellaAncestors.has(t.parentTicket) ? ` (under ${resolveTicketRefDisplay(t.parentTicket, state)})` : "";
      lines.push(`${indicator} ${displayIdOf(t)}: ${escapeMarkdownDocument(t.title)}${parentLabel}`);
    }
  }

  if (crossPhaseDeps.size > 0) {
    lines.push("");
    lines.push("## Cross-Phase Dependencies");
    for (const [, dep] of crossPhaseDeps) {
      lines.push(`- ${displayIdOf(dep)}: ${escapeMarkdownDocument(dep.title)} [${dep.status}] (${dep.phase ?? "unphased"})`);
    }
  }

  if (relatedIssues.length > 0) {
    lines.push("");
    lines.push("## Open Issues");
    for (const i of relatedIssues) {
      lines.push(`- ${displayIdOf(i)} [${i.severity}]: ${escapeMarkdownDocument(i.title)}`);
    }
  }

  if (activeBlockers.length > 0) {
    lines.push("");
    lines.push("## Active Blockers");
    for (const b of activeBlockers) {
      lines.push(`- ${escapeMarkdownDocument(b.name)}${b.note ? ` — ${escapeMarkdownDocument(b.note)}` : ""}`);
    }
  }

  return lines.join("\n");
}

function formatFullExport(
  state: ProjectState,
  format: OutputFormat,
): string {
  const phases = phasesWithStatus(state);

  if (format === "json") {
    return JSON.stringify(
      successEnvelope({
        project: state.config.project,
        phases: phases.map((p) => ({
          id: p.phase.id,
          name: p.phase.name,
          description: p.phase.description,
          status: p.status,
          tickets: state.phaseTickets(p.phase.id).map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            type: t.type,
          })),
        })),
        issues: state.activeIssues.map((i) => ({
          id: i.id,
          title: i.title,
          severity: i.severity,
          status: i.status,
        })),
        notes: state.activeNotes.map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          tags: n.tags,
        })),
        lessons: state.activeLessons.filter((l) => l.status === "active").map((l) => ({
          id: l.id,
          title: l.title,
          content: l.content,
          tags: l.tags,
          reinforcements: l.reinforcements,
        })),
        blockers: state.roadmap.blockers.map((b) => ({
          name: b.name,
          cleared: isBlockerCleared(b),
          note: b.note ?? null,
        })),
      }),
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(`# ${escapeMarkdownDocument(state.config.project)} — Full Export`);
  lines.push("");
  lines.push(`Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete`);
  lines.push(`Issues: ${state.activeIssueCount} open`);
  lines.push(`Notes: ${state.activeNoteCount} active, ${state.archivedNoteCount} archived`);
  lines.push(`Lessons: ${state.activeLessonCount} active, ${state.deprecatedLessonCount} deprecated`);

  lines.push("");
  lines.push("## Phases");
  for (const p of phases) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    lines.push("");
    lines.push(`### ${indicator} ${escapeMarkdownDocument(p.phase.name)} (${p.phase.id})`);
    if (p.phase.description) {
      lines.push(escapeMarkdownDocument(p.phase.description));
    }
    const tickets = state.phaseTickets(p.phase.id);
    if (tickets.length > 0) {
      lines.push("");
      for (const t of tickets) {
        const ti = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
        lines.push(`${ti} ${displayIdOf(t)}: ${escapeMarkdownDocument(t.title)}`);
      }
    }
  }

  if (state.activeIssues.length > 0) {
    lines.push("");
    lines.push("## Issues");
    for (const i of state.activeIssues) {
      const resolved = i.status === "resolved" ? " ✓" : "";
      lines.push(`- ${displayIdOf(i)} [${i.severity}]: ${escapeMarkdownDocument(i.title)}${resolved}`);
    }
  }

  const activeNotes = state.activeNotes.filter((n) => n.status === "active");
  if (activeNotes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    for (const n of activeNotes) {
      const title = n.title ?? displayIdOf(n);
      const tagInfo = n.tags.length > 0 ? ` (${n.tags.map(escapeMarkdownDocument).join(", ")})` : "";
      lines.push(`- ${displayIdOf(n)}: ${escapeMarkdownDocument(title)}${tagInfo}`);
    }
  }

  const activeLessons = state.activeLessons.filter((l) => l.status === "active");
  if (activeLessons.length > 0) {
    lines.push("");
    lines.push("## Lessons");
    for (const l of activeLessons) {
      const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements})` : "";
      const tagInfo = l.tags.length > 0 ? ` [${l.tags.map(escapeMarkdownDocument).join(", ")}]` : "";
      lines.push(`- ${displayIdOf(l)}: ${escapeMarkdownDocument(l.title)}${reinforced}${tagInfo}`);
    }
  }

  const blockers = state.roadmap.blockers;
  if (blockers.length > 0) {
    lines.push("");
    lines.push("## Blockers");
    for (const b of blockers) {
      const cleared = isBlockerCleared(b) ? "[x]" : "[ ]";
      lines.push(`${cleared} ${escapeMarkdownDocument(b.name)}${b.note ? ` — ${escapeMarkdownDocument(b.note)}` : ""}`);
    }
  }

  return lines.join("\n");
}

function hasAnyChanges(diff: SnapshotDiff): boolean {
  return (
    diff.tickets.added.length > 0 ||
    diff.tickets.removed.length > 0 ||
    diff.tickets.statusChanged.length > 0 ||
    diff.tickets.descriptionChanged.length > 0 ||
    diff.issues.added.length > 0 ||
    diff.issues.resolved.length > 0 ||
    diff.issues.statusChanged.length > 0 ||
    diff.issues.impactChanged.length > 0 ||
    diff.blockers.added.length > 0 ||
    diff.blockers.cleared.length > 0 ||
    diff.phases.added.length > 0 ||
    diff.phases.removed.length > 0 ||
    diff.phases.statusChanged.length > 0 ||
    (diff.notes?.added.length ?? 0) > 0 ||
    (diff.notes?.removed.length ?? 0) > 0 ||
    (diff.notes?.updated.length ?? 0) > 0 ||
    (diff.handovers?.added.length ?? 0) > 0 ||
    (diff.handovers?.removed.length ?? 0) > 0 ||
    (diff.lessons?.added.length ?? 0) > 0 ||
    (diff.lessons?.removed.length ?? 0) > 0 ||
    (diff.lessons?.updated.length ?? 0) > 0 ||
    (diff.lessons?.reinforced.length ?? 0) > 0
  );
}

// --- Selftest ---

export function formatSelftestResult(
  result: SelftestResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }

  const lines: string[] = ["# Self-test Report", ""];

  // Group results by entity
  const entities: Array<"ticket" | "issue" | "note" | "lesson"> = ["ticket", "issue", "note", "lesson"];
  for (const entity of entities) {
    const checks = result.results.filter((r) => r.entity === entity);
    if (checks.length === 0) continue;
    lines.push(`## ${entity.charAt(0).toUpperCase() + entity.slice(1)}`);
    for (const check of checks) {
      const mark = check.passed ? "[x]" : "[ ]";
      const suffix = check.passed ? "" : ` — ${check.detail}`;
      lines.push(`- ${mark} ${check.step}${suffix}`);
    }
    lines.push("");
  }

  if (result.cleanupErrors.length > 0) {
    lines.push("## Cleanup Warnings");
    lines.push("");
    for (const err of result.cleanupErrors) {
      lines.push(`- ${err}`);
    }
    lines.push("");
  }

  if (result.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push(`Result: ${result.passed}/${result.total} passed`);
  return lines.join("\n");
}

// --- Private Helpers ---

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function formatTicketOneLiner(t: Ticket, state: ProjectState): string {
  const status = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
  const blocked = state.isBlocked(t) ? " [BLOCKED]" : "";
  return `${status} ${displayIdOf(t)}: ${escapeMarkdownInline(t.title)}${blocked}`;
}

// --- Reference ---

export interface CommandEntry {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly flags?: readonly string[];
}

export interface McpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly params?: readonly string[];
}

export function formatReference(
  commands: readonly CommandEntry[],
  mcpTools: readonly McpToolEntry[],
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ commands, mcpTools }), null, 2);
  }

  const lines: string[] = [];
  lines.push("# storybloq Reference");
  lines.push("");
  lines.push("## CLI Commands");
  lines.push("");
  for (const cmd of commands) {
    lines.push(`### ${cmd.name}`);
    lines.push(cmd.description);
    lines.push("");
    lines.push("```");
    lines.push(cmd.usage);
    lines.push("```");
    lines.push("");
  }

  lines.push("## MCP Tools");
  lines.push("");
  lines.push("The base tools below are registered in full mode (inside a .story/ project). The five storybloq_bus_* tools are always registered in full mode; when the Bus is disabled or uninitialized they return setup guidance pointing at `storybloq bus setup`, with no MCP restart required.");
  lines.push("");
  for (const tool of mcpTools) {
    const params = tool.params?.length ? ` (${tool.params.join(", ")})` : "";
    lines.push(`- **${tool.name}**${params} - ${tool.description}`);
  }

  lines.push("");
  lines.push("### MCP Tools (degraded mode)");
  lines.push("");
  lines.push("With no .story/ project on the path, the MCP server starts degraded and registers only:");
  lines.push("");
  lines.push("- **storybloq_init** — bootstrap a .story/ project, then dynamically register the full tool set");
  lines.push("- **storybloq_status** — returns setup guidance instead of a project summary");
  lines.push("");
  lines.push("Destructive, admin, and git-integration workflows (delete, reconcile, conflicts, resolve, merge-driver, team, gc, repair, config, feedback) are CLI-only in both modes; see the CLI Commands section above.");

  lines.push("");
  lines.push("## /story design");
  lines.push("");
  lines.push("Evaluate frontend code against platform-specific design best practices.");
  lines.push("");
  lines.push("```");
  lines.push("/story design                    # Auto-detect platform, evaluate frontend");
  lines.push("/story design web                # Evaluate against web best practices");
  lines.push("/story design ios                # Evaluate against iOS HIG");
  lines.push("/story design macos              # Evaluate against macOS HIG");
  lines.push("/story design android            # Evaluate against Material Design");
  lines.push("```");
  lines.push("");
  lines.push("Creates issues automatically when storybloq MCP tools or CLI are available. Checks for existing design issues to avoid duplicates on repeated runs. Outputs markdown checklist as fallback when neither MCP nor CLI is available.");
  lines.push("");
  lines.push("## /story orchestrate");
  lines.push("");
  lines.push("Drive a multi-repo federation (or a large single-repo backlog) as an orchestrator: durable state in storybloq, implementation in background agents a tier below the session model when the client offers one, adversarial review gates on the session model.");
  lines.push("");
  lines.push("```");
  lines.push("/story orchestrate               # guard checks, explicit opt-in, then the wave loop");
  lines.push("```");
  lines.push("");
  lines.push("Requires explicit opt-in via AskUserQuestion before any agents are dispatched, and refuses to start while any federation node has an active autonomous session (one pen per repo; the per-node check reads each node's `.story/sessions/` directly because orchestrator status does not scan node repos). The full procedure -- enrichment template, sizing convention, 6-stage pipeline, workflow-script skeleton, critical rules -- is in `orchestrator-mode.md`. Needs a client with background dynamic workflows or subagents; Claude can also use the Agent View-backed `storybloq dispatch` path. Codex users can orchestrate when exact callable subagent tools are present; product-managed Codex dispatch remains unshipped.");
  lines.push("");
  lines.push("`/story` surfaces this option proactively at context load when the client is capable and the actionable backlog is orchestrate-sized, so you do not have to know the command exists; it stays a recommendation, and selecting it still routes through the explicit opt-in.");
  lines.push("");
  lines.push("## /story bus");
  lines.push("");
  lines.push("Poll or coordinate through the current task-bound local Bus endpoint. Peer content is advisory; confirmed review findings become canonical issues before an issue notice is sent.");
  lines.push("");
  lines.push("```");
  lines.push("/story bus");
  lines.push("```");
  lines.push("");
  lines.push("Read `bus-mode.md` for setup, endpoint binding, authority boundaries, acknowledgments, deterministic convergence, and the v1 no-wake boundary.");
  lines.push("");
  lines.push("## Common Workflows");
  lines.push("");
  lines.push("### Session Start");
  lines.push("1. `storybloq status` — project overview");
  lines.push("2. `storybloq recap` — what changed since last snapshot");
  lines.push("3. `storybloq handover latest` — last session context");
  lines.push("4. `storybloq ticket next` — what to work on");
  lines.push("");
  lines.push("### Session End");
  lines.push("1. `storybloq snapshot` — save state for diffs");
  lines.push("2. `storybloq handover create --content <md>` — write session handover");
  lines.push("");
  lines.push("### Project Setup");
  lines.push("1. `npm install -g @storybloq/storybloq` - install CLI");
  lines.push("2. `storybloq setup --client all` - install Storybloq skill, MCP, and hooks for Claude Code and Codex");
  lines.push("3. `storybloq init --name my-project` - initialize .story/ in your project");
  lines.push("");
  lines.push("## Troubleshooting");
  lines.push("");
  lines.push("- **MCP not connected:** Run `storybloq setup --client all`");
  lines.push("- **CLI not found:** Run `npm install -g @storybloq/storybloq`");
  lines.push("- **Stale data:** Run `storybloq validate` to check integrity");
  lines.push("- **Storybloq skill not available:** Run `storybloq setup --client all` to install the skill");

  return lines.join("\n");
}

export function formatRecommendations(
  result: RecommendResult,
  state: ProjectState,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ ...result, isEmptyScaffold: state.isEmptyScaffold }), null, 2);
  }

  if (result.recommendations.length === 0) {
    if (state.isEmptyScaffold) {
      return "No recommendations yet — this project needs tickets and phases. Run the /story setup flow to get started.";
    }
    if (state.config.type === "orchestrator") {
      return "No recommendations. Run storybloq status for federation overview.";
    }
    return "No recommendations -- all work is complete or blocked.";
  }

  const lines: string[] = ["# Recommendations", ""];

  for (let i = 0; i < result.recommendations.length; i++) {
    const rec = result.recommendations[i]!;
    lines.push(
      `${i + 1}. **${escapeMarkdownInline(displayIdOf(rec))}** (${rec.kind}) — ${escapeMarkdownInline(rec.title)}`,
    );
    lines.push(`   _${escapeMarkdownInline(rec.reason)}_`);
    lines.push("");
  }

  if (result.totalCandidates > result.recommendations.length) {
    lines.push(
      `Showing ${result.recommendations.length} of ${result.totalCandidates} candidates.`,
    );
  }

  return lines.join("\n");
}

export function formatReconcileResult(
  result: ReconcileResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(result.ok ? successEnvelope(result.plan) : { ok: false, errors: result.errors }, null, 2);
  }
  if (!result.ok) {
    const lines = ["# Reconcile Failed", ""];
    for (const err of result.errors) {
      lines.push(`- ${escapeMarkdownInline(err)}`);
    }
    return lines.join("\n");
  }
  const { plan } = result;
  if (plan.renames.length === 0) {
    return "No duplicate displayIds found. Project is clean.";
  }
  const lines = ["# Reconcile Plan", "", `${plan.renames.length} rename(s) needed:`, ""];
  lines.push("| Type | ID | Old DisplayId | New DisplayId | Reason |");
  lines.push("|------|----|---------------|---------------|--------|");
  for (const r of plan.renames) {
    lines.push(`| ${r.entityType} | ${escapeMarkdownInline(r.id)} | ${escapeMarkdownInline(r.oldDisplayId)} | ${escapeMarkdownInline(r.newDisplayId)} | ${escapeMarkdownInline(r.reason)} |`);
  }
  if (plan.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    for (const w of plan.warnings) {
      lines.push(`- ${escapeMarkdownInline(w.message)}`);
    }
  }
  return lines.join("\n");
}

export function formatDoctorResult(
  result: DoctorResult,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(result), null, 2);
  }
  if (result.findings.length === 0) {
    return "Team doctor: all checks passed.";
  }
  const lines = ["# Team Doctor", ""];
  lines.push(`${result.errorCount} error(s), ${result.warningCount} warning(s), ${result.infoCount} info`);
  lines.push("");

  const grouped: Record<string, typeof result.findings> = { error: [], warning: [], info: [] };
  for (const f of result.findings) {
    grouped[f.severity]!.push(f);
  }

  for (const severity of ["error", "warning", "info"] as const) {
    const group = grouped[severity]!;
    if (group.length === 0) continue;
    lines.push(`## ${severity.charAt(0).toUpperCase() + severity.slice(1)}s`, "");
    for (const f of group) {
      const entityPart = f.entity ? ` (${escapeMarkdownInline(f.entity)})` : "";
      lines.push(`- **${f.code}**${entityPart}: ${escapeMarkdownInline(f.message)}`);
      if (f.repair) {
        if ("command" in f.repair) {
          lines.push(`  Fix: \`${f.repair.command.map(shellQuote).join(" ")}\``);
        } else {
          for (const step of f.repair.manualSteps) {
            lines.push(`  Fix: ${escapeMarkdownInline(step)}`);
          }
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_./@:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
