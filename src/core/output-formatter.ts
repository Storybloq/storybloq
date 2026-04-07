import type { OutputFormat, ErrorCode } from "../models/types.js";
import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { Roadmap } from "../models/roadmap.js";
import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import type { ValidationResult } from "./validation.js";
import type { NextTicketOutcome, NextTicketsOutcome } from "./queries.js";
import type { RecommendResult } from "./recommend.js";
import type { ActiveSessionSummary } from "./session-scan.js";
import type { SelftestResult } from "../cli/commands/selftest.js";
import { phasesWithStatus, isBlockerCleared } from "./queries.js";

/** SKILL PROTOCOL: SKILL.md Step 2b matches this literal string. Do not change without updating SKILL.md. */
export const EMPTY_SCAFFOLD_HEADING = "## Getting Started";

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
  activeSessions: readonly ActiveSessionSummary[] = [],
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
    "",
    "## Phases",
    "",
  ];
  for (const p of phases) {
    const indicator = p.status === "complete" ? "[x]" : p.status === "inprogress" ? "[~]" : "[ ]";
    const summary = p.phase.summary ?? truncate(p.phase.description, 80);
    lines.push(`${indicator} **${escapeMarkdownInline(p.phase.name)}** (${p.leafCount} tickets) — ${escapeMarkdownInline(summary)}`);
  }

  if (activeSessions.length > 0) {
    lines.push("");
    lines.push("## Active Sessions");
    lines.push("");
    for (const s of activeSessions) {
      const ticket = s.ticketId ? `${s.ticketId}: ${escapeMarkdownInline(s.ticketTitle ?? "")}` : "no ticket";
      lines.push(`- ${s.sessionId.slice(0, 8)}: ${s.state} -- ${ticket} (${s.mode} mode)`);
    }
  }

  if (state.isEmptyScaffold) {
    lines.push("");
    lines.push(EMPTY_SCAFFOLD_HEADING);
    lines.push("");
    lines.push("This project has been initialized but has no tickets, issues, or handovers yet.");
    lines.push("Run the /story setup flow to analyze your project and create an initial roadmap.");
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
        if (candidates.length === 1) {
          lines.push(`# Next: ${escapeMarkdownInline(t.id)} — ${escapeMarkdownInline(t.title)}`);
        } else {
          lines.push(`# ${i + 1}. ${escapeMarkdownInline(t.id)} — ${escapeMarkdownInline(t.title)}`);
        }
        lines.push("", `Phase: ${t.phase ?? "none"} | Order: ${t.order} | Type: ${t.type}`);

        if (c.unblockImpact.wouldUnblock.length > 0) {
          const ids = c.unblockImpact.wouldUnblock.map((u) => u.id).join(", ");
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

export function formatNote(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }

  const title = note.title ?? `${note.createdDate} — ${note.id}`;
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
    const title = n.title ?? n.id;
    const status = n.status === "archived" ? "[x]" : "[ ]";
    const tagInfo = n.status === "archived"
      ? " (archived)"
      : n.tags.length > 0
        ? ` (${n.tags.join(", ")})`
        : "";
    lines.push(`${status} ${n.id}: ${escapeMarkdownInline(title)}${tagInfo}`);
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
  return `Created note ${note.id}: ${note.title ?? note.id}`;
}

export function formatNoteUpdateResult(
  note: Note,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(note), null, 2);
  }
  return `Updated note ${note.id}: ${note.title ?? note.id}`;
}

export function formatNoteDeleteResult(
  id: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ id, deleted: true }), null, 2);
  }
  return `Deleted note ${id}.`;
}

// --- Lesson formatters ---

export function formatLesson(
  lesson: Lesson,
  format: OutputFormat,
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
    lines.push(`Supersedes: ${lesson.supersedes}`);
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
    lines.push(`${status} ${l.id}: ${escapeMarkdownInline(l.title)}${reinforced}${tagInfo}`);
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
  return `Created lesson ${lesson.id}: ${lesson.title}`;
}

export function formatLessonUpdateResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Updated lesson ${lesson.id}: ${lesson.title}`;
}

export function formatLessonReinforceResult(
  lesson: Lesson,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(lesson), null, 2);
  }
  return `Reinforced lesson ${lesson.id}: ${lesson.title} (×${lesson.reinforcements})`;
}

export function formatLessonDeleteResult(
  id: string,
  format: OutputFormat,
): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope({ id, deleted: true }), null, 2);
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
    lines.push("", `Warning: ${result.warnings.length} corrupt file(s) found. Run \`claudestory validate\` to inspect.`);
  }
  lines.push("", "Tip: Run `claudestory setup-skill` to install the /story skill for Claude Code.");
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
    lines.push("No snapshot found. Run `claudestory snapshot` to enable session diffs.");
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
        lines.push("**Warning:** Snapshot commit is not an ancestor of current HEAD (history diverged; possible rebase, force-push, or branch switch).");
      } else if (recap.staleness.status === "behind" && recap.staleness.commitsBehind) {
        lines.push(`**Warning:** Snapshot is ${recap.staleness.commitsBehind} commit(s) behind HEAD -- context may be stale.`);
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
          lines.push(`- ${t.id}: ${escapeMarkdownInline(t.title)} — ${t.from} → ${t.to}`);
        }
        for (const t of ticketChanges.added) {
          lines.push(`- ${t.id}: ${escapeMarkdownInline(t.title)} — **new**`);
        }
        for (const t of ticketChanges.removed) {
          lines.push(`- ${t.id}: ${escapeMarkdownInline(t.title)} — **removed**`);
        }
        for (const t of ticketChanges.descriptionChanged) {
          lines.push(`- ${t.id}: description updated`);
        }
      }

      // Issue changes
      const issueChanges = changes.issues;
      if (issueChanges.added.length > 0 || issueChanges.resolved.length > 0 || issueChanges.statusChanged.length > 0 || issueChanges.impactChanged.length > 0) {
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
        for (const i of issueChanges.impactChanged) {
          lines.push(`- ${i.id}: impact updated`);
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
          lines.push(`- ${n.id}: added`);
        }
        for (const n of changes.notes.removed) {
          lines.push(`- ${n.id}: removed`);
        }
        for (const n of changes.notes.updated) {
          lines.push(`- ${n.id}: updated (${n.changedFields.join(", ")})`);
        }
      }

      // Lesson changes
      if (changes.lessons && (changes.lessons.added.length > 0 || changes.lessons.removed.length > 0 || changes.lessons.updated.length > 0 || changes.lessons.reinforced.length > 0)) {
        lines.push("");
        lines.push("## Lessons");
        for (const l of changes.lessons.added) {
          lines.push(`- ${l.id}: ${escapeMarkdownInline(l.title)} — **new**`);
        }
        for (const l of changes.lessons.removed) {
          lines.push(`- ${l.id}: ${escapeMarkdownInline(l.title)} — removed`);
        }
        for (const l of changes.lessons.updated) {
          lines.push(`- ${l.id}: updated (${l.changedFields.join(", ")})`);
        }
        for (const l of changes.lessons.reinforced) {
          lines.push(`- ${l.id}: ${escapeMarkdownInline(l.title)} — reinforced (${l.from} → ${l.to})`);
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
        notes: state.notes.map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          tags: n.tags,
        })),
        lessons: state.lessons.filter((l) => l.status === "active").map((l) => ({
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
  lines.push(`# ${escapeMarkdownInline(state.config.project)} — Full Export`);
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

  const activeNotes = state.notes.filter((n) => n.status === "active");
  if (activeNotes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    for (const n of activeNotes) {
      const title = n.title ?? n.id;
      const tagInfo = n.tags.length > 0 ? ` (${n.tags.join(", ")})` : "";
      lines.push(`- ${n.id}: ${escapeMarkdownInline(title)}${tagInfo}`);
    }
  }

  const activeLessons = state.lessons.filter((l) => l.status === "active");
  if (activeLessons.length > 0) {
    lines.push("");
    lines.push("## Lessons");
    for (const l of activeLessons) {
      const reinforced = l.reinforcements > 0 ? ` (×${l.reinforcements})` : "";
      const tagInfo = l.tags.length > 0 ? ` [${l.tags.join(", ")}]` : "";
      lines.push(`- ${l.id}: ${escapeMarkdownInline(l.title)}${reinforced}${tagInfo}`);
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
  const entities: Array<"ticket" | "issue" | "note"> = ["ticket", "issue", "note"];
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
  return `${status} ${t.id}: ${escapeMarkdownInline(t.title)}${blocked}`;
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
  lines.push("# claudestory Reference");
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
  for (const tool of mcpTools) {
    const params = tool.params?.length ? ` (${tool.params.join(", ")})` : "";
    lines.push(`- **${tool.name}**${params} — ${tool.description}`);
  }

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
  lines.push("Creates issues automatically when claudestory MCP tools or CLI are available. Checks for existing design issues to avoid duplicates on repeated runs. Outputs markdown checklist as fallback when neither MCP nor CLI is available.");
  lines.push("");
  lines.push("## Common Workflows");
  lines.push("");
  lines.push("### Session Start");
  lines.push("1. `claudestory status` — project overview");
  lines.push("2. `claudestory recap` — what changed since last snapshot");
  lines.push("3. `claudestory handover latest` — last session context");
  lines.push("4. `claudestory ticket next` — what to work on");
  lines.push("");
  lines.push("### Session End");
  lines.push("1. `claudestory snapshot` — save state for diffs");
  lines.push("2. `claudestory handover create --content <md>` — write session handover");
  lines.push("");
  lines.push("### Project Setup");
  lines.push("1. `npm install -g @anthropologies/claudestory` — install CLI");
  lines.push("2. `claudestory setup-skill` — install /story skill for Claude Code");
  lines.push("3. `claudestory init --name my-project` — initialize .story/ in your project");
  lines.push("");
  lines.push("## Troubleshooting");
  lines.push("");
  lines.push("- **MCP not connected:** Run `claude mcp add claudestory -s user -- claudestory --mcp`");
  lines.push("- **CLI not found:** Run `npm install -g @anthropologies/claudestory`");
  lines.push("- **Stale data:** Run `claudestory validate` to check integrity");
  lines.push("- **/story not available:** Run `claudestory setup-skill` to install the skill");

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
    return "No recommendations — all work is complete or blocked.";
  }

  const lines: string[] = ["# Recommendations", ""];

  for (let i = 0; i < result.recommendations.length; i++) {
    const rec = result.recommendations[i]!;
    lines.push(
      `${i + 1}. **${escapeMarkdownInline(rec.id)}** (${rec.kind}) — ${escapeMarkdownInline(rec.title)}`,
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
