import type { CommandContext, CommandResult } from "../run.js";
import { validateProject } from "../../core/validation.js";
import { INTEGRITY_WARNING_TYPES, type LoadWarning } from "../../core/errors.js";
import type { ProjectState } from "../../core/project-state.js";
import type { Ticket } from "../../models/ticket.js";
import type { Issue } from "../../models/issue.js";

interface RepairFix {
  entity: string;
  field: string;
  description: string;
}

export interface RepairResult {
  fixes: RepairFix[];
  error?: string;
  tickets: Ticket[];
  issues: Issue[];
}

/**
 * Compute repairs needed for stale references.
 * Returns the list of fixes and the modified entities ready to write.
 */
export function computeRepairs(
  state: ProjectState,
  warnings: readonly LoadWarning[],
): RepairResult {
  // Refuse when load has integrity warnings (partial load could cause false positives)
  const integrityWarning = warnings.find((w) =>
    (INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type),
  );
  if (integrityWarning) {
    return {
      fixes: [],
      error: `Cannot repair: data integrity issue in ${integrityWarning.file}: ${integrityWarning.message}. Fix the corrupt file first, then retry.`,
      tickets: [],
      issues: [],
    };
  }

  const fixes: RepairFix[] = [];
  const modifiedTickets: Ticket[] = [];
  const modifiedIssues: Issue[] = [];

  const ticketIDs = new Set(state.tickets.map((t) => t.id));
  const phaseIDs = new Set(state.roadmap.phases.map((p) => {
    const id = p.id;
    return typeof id === "object" && id !== null ? (id as { rawValue?: string }).rawValue ?? String(id) : String(id);
  }));

  // Fix stale ticket references
  for (const ticket of state.tickets) {
    let modified = false;
    let blockedBy = [...ticket.blockedBy];
    let parentTicket = ticket.parentTicket;
    let phase = ticket.phase;

    // Stale blockedBy
    const validBlockedBy = blockedBy.filter((ref) => ticketIDs.has(ref));
    if (validBlockedBy.length < blockedBy.length) {
      const removed = blockedBy.filter((ref) => !ticketIDs.has(ref));
      blockedBy = validBlockedBy;
      modified = true;
      fixes.push({ entity: ticket.id, field: "blockedBy", description: `Removed stale refs: ${removed.join(", ")}` });
    }

    // Stale parentTicket
    if (parentTicket && !ticketIDs.has(parentTicket)) {
      fixes.push({ entity: ticket.id, field: "parentTicket", description: `Cleared stale ref: ${parentTicket}` });
      parentTicket = null;
      modified = true;
    }

    // Stale phase
    const phaseRaw = typeof phase === "object" && phase !== null
      ? (phase as { rawValue?: string }).rawValue ?? String(phase)
      : phase != null ? String(phase) : null;
    if (phaseRaw && !phaseIDs.has(phaseRaw)) {
      fixes.push({ entity: ticket.id, field: "phase", description: `Cleared stale phase: ${phaseRaw}` });
      phase = null;
      modified = true;
    }

    if (modified) {
      modifiedTickets.push({ ...ticket, blockedBy, parentTicket, phase } as Ticket);
    }
  }

  // Fix stale issue references
  for (const issue of state.issues) {
    let modified = false;
    let relatedTickets = [...issue.relatedTickets];
    let phase = issue.phase;

    // Stale relatedTickets
    const validRelated = relatedTickets.filter((ref) => ticketIDs.has(ref));
    if (validRelated.length < relatedTickets.length) {
      const removed = relatedTickets.filter((ref) => !ticketIDs.has(ref));
      relatedTickets = validRelated;
      modified = true;
      fixes.push({ entity: issue.id, field: "relatedTickets", description: `Removed stale refs: ${removed.join(", ")}` });
    }

    // Stale phase
    const issuePhaseRaw = typeof phase === "object" && phase !== null
      ? (phase as { rawValue?: string }).rawValue ?? String(phase)
      : phase != null ? String(phase) : null;
    if (issuePhaseRaw && !phaseIDs.has(issuePhaseRaw)) {
      fixes.push({ entity: issue.id, field: "phase", description: `Cleared stale phase: ${issuePhaseRaw}` });
      phase = null;
      modified = true;
    }

    if (modified) {
      modifiedIssues.push({ ...issue, relatedTickets, phase } as Issue);
    }
  }

  return { fixes, tickets: modifiedTickets, issues: modifiedIssues };
}

export function handleRepair(ctx: CommandContext, dryRun: boolean): CommandResult {
  const { fixes, error } = computeRepairs(ctx.state, ctx.warnings);

  if (error) {
    return { output: error, errorCode: "project_corrupt" };
  }

  if (fixes.length === 0) {
    return { output: "No stale references found. Project is clean." };
  }

  const lines = [`Found ${fixes.length} stale reference(s)${dryRun ? " (dry run)" : ""}:`, ""];
  for (const fix of fixes) {
    lines.push(`- ${fix.entity}.${fix.field}: ${fix.description}`);
  }

  if (dryRun) {
    lines.push("", "Run without --dry-run to apply fixes.");
  }

  return { output: lines.join("\n") };
}
