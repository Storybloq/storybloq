import type { OutputFormat, ErrorCode } from "../models/types.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Roadmap } from "../models/roadmap.js";
import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import type { ValidationResult } from "./validation.js";
import type { NextTicketOutcome } from "./queries.js";
import { phasesWithStatus, isBlockerCleared } from "./queries.js";

// --- Exit Codes ---

export const ExitCode = {
  OK: 0,
  USER_ERROR: 1,
  VALIDATION_ERROR: 2,
  PARTIAL: 3,
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
 * Escapes characters that would create Markdown structure in inline text.
 * Handles heading, list, blockquote, ordered list at line start.
 * Handles inline structural characters.
 */
export function escapeMarkdownInline(text: string): string {
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

// --- Format Functions ---

export function formatStatus(
  state: ProjectState,
  format: OutputFormat,
): string {
  const phases = phasesWithStatus(state);
  const data = {
    project: state.config.project,
    totalTickets: state.leafTicketCount,
    completeTickets: state.completeLeafTicketCount,
    openTickets: state.leafTicketCount - state.completeLeafTicketCount,
    blockedTickets: state.blockedCount,
    openIssues: state.openIssueCount,
    handovers: state.handoverFilenames.length,
    phases: phases.map((p) => ({
      id: p.phase.id,
      name: p.phase.name,
      status: p.status,
      leafCount: p.leafCount,
    })),
  };

  if (format === "json") {
    return JSON.stringify(successEnvelope(data), null, 2);
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(state.config.project)}`,
    "",
    `Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete, ${state.blockedCount} blocked`,
    `Issues: ${state.openIssueCount} open`,
    `Handovers: ${state.handoverFilenames.length}`,
    "",
    "## Phases",
    "",
  ];
  for (const p of phases) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    const summary = p.phase.summary ?? truncate(p.phase.description, 80);
    lines.push(`${indicator} **${escapeMarkdownInline(p.phase.name)}** (${p.leafCount} tickets) — ${escapeMarkdownInline(summary)}`);
  }

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
    `# ${escapeMarkdownInline(ticket.id)}: ${escapeMarkdownInline(ticket.title)}${blocked}`,
    "",
    `Status: ${ticket.status} | Type: ${ticket.type} | Phase: ${ticket.phase ?? "none"} | Order: ${ticket.order}`,
    `Created: ${ticket.createdDate}${ticket.completedDate ? ` | Completed: ${ticket.completedDate}` : ""}`,
  ];
  if (ticket.blockedBy.length > 0) {
    lines.push(`Blocked by: ${ticket.blockedBy.join(", ")}`);
  }
  if (ticket.parentTicket) {
    lines.push(`Parent: ${ticket.parentTicket}`);
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
        `# Next: ${escapeMarkdownInline(t.id)} — ${escapeMarkdownInline(t.title)}`,
        "",
        `Phase: ${t.phase ?? "none"} | Order: ${t.order} | Type: ${t.type}`,
      ];

      if (outcome.unblockImpact.wouldUnblock.length > 0) {
        const ids = outcome.unblockImpact.wouldUnblock.map((u) => u.id).join(", ");
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
    lines.push(`${status} ${t.id}: ${escapeMarkdownInline(t.title)} (${t.phase ?? "none"})`);
  }
  return lines.join("\n");
}

export function formatIssue(
  issue: Issue,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(issue), null, 2);
  }

  const lines: string[] = [
    `# ${escapeMarkdownInline(issue.id)}: ${escapeMarkdownInline(issue.title)}`,
    "",
    `Status: ${issue.status} | Severity: ${issue.severity}`,
    `Components: ${issue.components.join(", ") || "none"}`,
    `Discovered: ${issue.discoveredDate}${issue.resolvedDate ? ` | Resolved: ${issue.resolvedDate}` : ""}`,
  ];
  if (issue.relatedTickets.length > 0) {
    lines.push(`Related: ${issue.relatedTickets.join(", ")}`);
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
    lines.push(`${status} ${i.id} [${i.severity}]: ${escapeMarkdownInline(i.title)}`);
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
        const b = state.ticketByID(bid);
        return b ? `${bid} (${b.status})` : `${bid} (unknown)`;
      })
      .join(", ");
    lines.push(`${t.id}: ${escapeMarkdownInline(t.title)} — blocked by: ${blockerInfo}`);
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
    lines.push("", `Warning: ${result.warnings.length} corrupt file(s) found. Run \`claudestory validate\` to inspect.`);
  }
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
    lines.push("No snapshot found. Run `claudestory snapshot` to enable session diffs.");
    lines.push("");
    lines.push(`Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete, ${state.blockedCount} blocked`);
    lines.push(`Issues: ${state.openIssueCount} open`);
  } else {
    lines.push(`# ${escapeMarkdownInline(state.config.project)} — Recap`);
    lines.push("");
    lines.push(`Since snapshot: ${recap.snapshot.createdAt}`);
    if (recap.partial) {
      lines.push("**Note:** Snapshot was taken from a project with integrity warnings. Diff may be incomplete.");
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
      if (ticketChanges.added.length > 0 || ticketChanges.removed.length > 0 || ticketChanges.statusChanged.length > 0) {
        lines.push("");
        lines.push("## Tickets");
        for (const t of ticketChanges.statusChanged) {
          lines.push(`- ${t.id}: ${escapeMarkdownInline(t.title)} — ${t.from} → ${t.to}`);
        }
        for (const t of ticketChanges.added) {
          lines.push(`- ${t.id}: ${escapeMarkdownInline(t.title)} — **new**`);
        }
        for (const t of ticketChanges.removed) {
          lines.push(`- ${t.id}: ${escapeMarkdownInline(t.title)} — **removed**`);
        }
      }

      // Issue changes
      const issueChanges = changes.issues;
      if (issueChanges.added.length > 0 || issueChanges.resolved.length > 0 || issueChanges.statusChanged.length > 0) {
        lines.push("");
        lines.push("## Issues");
        for (const i of issueChanges.resolved) {
          lines.push(`- ${i.id}: ${escapeMarkdownInline(i.title)} — **resolved**`);
        }
        for (const i of issueChanges.statusChanged) {
          lines.push(`- ${i.id}: ${escapeMarkdownInline(i.title)} — ${i.from} → ${i.to}`);
        }
        for (const i of issueChanges.added) {
          lines.push(`- ${i.id}: ${escapeMarkdownInline(i.title)} — **new**`);
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
    }
  }

  // Suggested actions (always shown)
  const actions = recap.suggestedActions;
  lines.push("");
  lines.push("## Suggested Actions");

  if (actions.nextTicket) {
    lines.push(`- **Next:** ${actions.nextTicket.id} — ${escapeMarkdownInline(actions.nextTicket.title)}${actions.nextTicket.phase ? ` (${actions.nextTicket.phase})` : ""}`);
  }

  if (actions.highSeverityIssues.length > 0) {
    for (const i of actions.highSeverityIssues) {
      lines.push(`- **${i.severity} issue:** ${i.id} — ${escapeMarkdownInline(i.title)}`);
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
  const relatedIssues = state.issues.filter(
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
  lines.push(`# ${escapeMarkdownInline(phase.name)} (${phase.id})`);
  lines.push("");
  lines.push(`Status: ${phaseStatus}`);
  if (phase.description) {
    lines.push(`Description: ${escapeMarkdownInline(phase.description)}`);
  }

  if (leaves.length > 0) {
    lines.push("");
    lines.push("## Tickets");
    for (const t of leaves) {
      const indicator = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
      const parentNote = t.parentTicket && umbrellaAncestors.has(t.parentTicket) ? ` (under ${t.parentTicket})` : "";
      lines.push(`${indicator} ${t.id}: ${escapeMarkdownInline(t.title)}${parentNote}`);
    }
  }

  if (crossPhaseDeps.size > 0) {
    lines.push("");
    lines.push("## Cross-Phase Dependencies");
    for (const [, dep] of crossPhaseDeps) {
      lines.push(`- ${dep.id}: ${escapeMarkdownInline(dep.title)} [${dep.status}] (${dep.phase ?? "unphased"})`);
    }
  }

  if (relatedIssues.length > 0) {
    lines.push("");
    lines.push("## Open Issues");
    for (const i of relatedIssues) {
      lines.push(`- ${i.id} [${i.severity}]: ${escapeMarkdownInline(i.title)}`);
    }
  }

  if (activeBlockers.length > 0) {
    lines.push("");
    lines.push("## Active Blockers");
    for (const b of activeBlockers) {
      lines.push(`- ${escapeMarkdownInline(b.name)}${b.note ? ` — ${escapeMarkdownInline(b.note)}` : ""}`);
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
        issues: state.issues.map((i) => ({
          id: i.id,
          title: i.title,
          severity: i.severity,
          status: i.status,
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
  lines.push(`# ${escapeMarkdownInline(state.config.project)} — Full Export`);
  lines.push("");
  lines.push(`Tickets: ${state.completeLeafTicketCount}/${state.leafTicketCount} complete`);
  lines.push(`Issues: ${state.openIssueCount} open`);

  lines.push("");
  lines.push("## Phases");
  for (const p of phases) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    lines.push("");
    lines.push(`### ${indicator} ${escapeMarkdownInline(p.phase.name)} (${p.phase.id})`);
    if (p.phase.description) {
      lines.push(escapeMarkdownInline(p.phase.description));
    }
    const tickets = state.phaseTickets(p.phase.id);
    if (tickets.length > 0) {
      lines.push("");
      for (const t of tickets) {
        const ti = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
        lines.push(`${ti} ${t.id}: ${escapeMarkdownInline(t.title)}`);
      }
    }
  }

  if (state.issues.length > 0) {
    lines.push("");
    lines.push("## Issues");
    for (const i of state.issues) {
      const resolved = i.status === "resolved" ? " ✓" : "";
      lines.push(`- ${i.id} [${i.severity}]: ${escapeMarkdownInline(i.title)}${resolved}`);
    }
  }

  const blockers = state.roadmap.blockers;
  if (blockers.length > 0) {
    lines.push("");
    lines.push("## Blockers");
    for (const b of blockers) {
      const cleared = isBlockerCleared(b) ? "[x]" : "[ ]";
      lines.push(`${cleared} ${escapeMarkdownInline(b.name)}${b.note ? ` — ${escapeMarkdownInline(b.note)}` : ""}`);
    }
  }

  return lines.join("\n");
}

function hasAnyChanges(diff: SnapshotDiff): boolean {
  return (
    diff.tickets.added.length > 0 ||
    diff.tickets.removed.length > 0 ||
    diff.tickets.statusChanged.length > 0 ||
    diff.issues.added.length > 0 ||
    diff.issues.resolved.length > 0 ||
    diff.issues.statusChanged.length > 0 ||
    diff.blockers.added.length > 0 ||
    diff.blockers.cleared.length > 0 ||
    diff.phases.added.length > 0 ||
    diff.phases.removed.length > 0 ||
    diff.phases.statusChanged.length > 0
  );
}

// --- Private Helpers ---

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function formatTicketOneLiner(t: Ticket, state: ProjectState): string {
  const status = t.status === "complete" ? "[x]" : t.status === "inprogress" ? "[~]" : "[ ]";
  const blocked = state.isBlocked(t) ? " [BLOCKED]" : "";
  return `${status} ${t.id}: ${escapeMarkdownInline(t.title)}${blocked}`;
}
