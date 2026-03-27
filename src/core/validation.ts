import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";

// --- Types ---

export type ValidationLevel = "error" | "warning" | "info";

export interface ValidationFinding {
  readonly level: ValidationLevel;
  readonly code: string;
  readonly message: string;
  readonly entity: string | null;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly findings: readonly ValidationFinding[];
}

// --- Main Validation ---

/**
 * Validates a fully loaded ProjectState for reference integrity.
 * Pure function — no I/O. Returns structured findings, never throws.
 */
export function validateProject(state: ProjectState): ValidationResult {
  const findings: ValidationFinding[] = [];
  const phaseIDs = new Set(state.roadmap.phases.map((p) => p.id));
  const ticketIDs = new Set<string>();
  const issueIDs = new Set<string>();

  // Duplicate ticket IDs
  const ticketIDCounts = new Map<string, number>();
  for (const t of state.tickets) {
    ticketIDCounts.set(t.id, (ticketIDCounts.get(t.id) ?? 0) + 1);
    ticketIDs.add(t.id);
  }
  for (const [id, count] of ticketIDCounts) {
    if (count > 1) {
      findings.push({
        level: "error",
        code: "duplicate_ticket_id",
        message: `Duplicate ticket ID: ${id} appears ${count} times.`,
        entity: id,
      });
    }
  }

  // Duplicate issue IDs
  const issueIDCounts = new Map<string, number>();
  for (const i of state.issues) {
    issueIDCounts.set(i.id, (issueIDCounts.get(i.id) ?? 0) + 1);
    issueIDs.add(i.id);
  }
  for (const [id, count] of issueIDCounts) {
    if (count > 1) {
      findings.push({
        level: "error",
        code: "duplicate_issue_id",
        message: `Duplicate issue ID: ${id} appears ${count} times.`,
        entity: id,
      });
    }
  }

  // Duplicate note IDs
  const noteIDCounts = new Map<string, number>();
  for (const n of state.notes) {
    noteIDCounts.set(n.id, (noteIDCounts.get(n.id) ?? 0) + 1);
  }
  for (const [id, count] of noteIDCounts) {
    if (count > 1) {
      findings.push({
        level: "error",
        code: "duplicate_note_id",
        message: `Duplicate note ID: ${id} appears ${count} times.`,
        entity: id,
      });
    }
  }

  // Duplicate lesson IDs
  const lessonIDCounts = new Map<string, number>();
  for (const l of state.lessons) {
    lessonIDCounts.set(l.id, (lessonIDCounts.get(l.id) ?? 0) + 1);
  }
  for (const [id, count] of lessonIDCounts) {
    if (count > 1) {
      findings.push({
        level: "error",
        code: "duplicate_lesson_id",
        message: `Duplicate lesson ID: ${id} appears ${count} times.`,
        entity: id,
      });
    }
  }

  // Lesson reference checks
  const lessonIDs = new Set(state.lessons.map((l) => l.id));
  for (const l of state.lessons) {
    // supersedes ref
    if (l.supersedes != null) {
      if (l.supersedes === l.id) {
        findings.push({
          level: "error",
          code: "self_ref_supersedes",
          message: `Lesson ${l.id} references itself in supersedes.`,
          entity: l.id,
        });
      } else if (!lessonIDs.has(l.supersedes)) {
        findings.push({
          level: "error",
          code: "invalid_supersedes_ref",
          message: `Lesson ${l.id} supersedes nonexistent lesson ${l.supersedes}.`,
          entity: l.id,
        });
      }
    }
  }

  // Duplicate roadmap phase IDs
  const phaseIDCounts = new Map<string, number>();
  for (const p of state.roadmap.phases) {
    phaseIDCounts.set(p.id, (phaseIDCounts.get(p.id) ?? 0) + 1);
  }
  for (const [id, count] of phaseIDCounts) {
    if (count > 1) {
      findings.push({
        level: "error",
        code: "duplicate_phase_id",
        message: `Duplicate phase ID: ${id} appears ${count} times.`,
        entity: id,
      });
    }
  }

  // Ticket reference checks
  for (const t of state.tickets) {
    // Phase ref (null is valid — unphased)
    if (t.phase !== null && !phaseIDs.has(t.phase)) {
      findings.push({
        level: "error",
        code: "invalid_phase_ref",
        message: `Ticket ${t.id} references unknown phase "${t.phase}".`,
        entity: t.id,
      });
    }

    // blockedBy refs
    for (const bid of t.blockedBy) {
      if (bid === t.id) {
        findings.push({
          level: "error",
          code: "self_ref_blocked_by",
          message: `Ticket ${t.id} references itself in blockedBy.`,
          entity: t.id,
        });
      } else if (!ticketIDs.has(bid)) {
        findings.push({
          level: "error",
          code: "invalid_blocked_by_ref",
          message: `Ticket ${t.id} blockedBy references nonexistent ticket ${bid}.`,
          entity: t.id,
        });
      } else if (state.umbrellaIDs.has(bid)) {
        findings.push({
          level: "error",
          code: "blocked_by_umbrella",
          message: `Ticket ${t.id} blockedBy references umbrella ticket ${bid}. Use leaf tickets instead.`,
          entity: t.id,
        });
      }
    }

    // parentTicket ref
    if (t.parentTicket != null) {
      if (t.parentTicket === t.id) {
        findings.push({
          level: "error",
          code: "self_ref_parent",
          message: `Ticket ${t.id} references itself as parentTicket.`,
          entity: t.id,
        });
      } else if (!ticketIDs.has(t.parentTicket)) {
        findings.push({
          level: "error",
          code: "invalid_parent_ref",
          message: `Ticket ${t.id} parentTicket references nonexistent ticket ${t.parentTicket}.`,
          entity: t.id,
        });
      }
    }
  }

  // parentTicket cycle detection (DFS)
  detectParentCycles(state, findings);

  // blockedBy cycle detection (DFS)
  detectBlockedByCycles(state, findings);

  // Issue reference checks
  for (const i of state.issues) {
    for (const tref of i.relatedTickets) {
      if (!ticketIDs.has(tref)) {
        findings.push({
          level: "error",
          code: "invalid_related_ticket_ref",
          message: `Issue ${i.id} relatedTickets references nonexistent ticket ${tref}.`,
          entity: i.id,
        });
      }
    }

    // Issue phase ref (null/undefined is valid — unphased)
    if (i.phase != null && !phaseIDs.has(i.phase)) {
      findings.push({
        level: "error",
        code: "invalid_phase_ref",
        message: `Issue ${i.id} references unknown phase "${i.phase}".`,
        entity: i.id,
      });
    }

    // Orphan open issue
    if (i.relatedTickets.length === 0 && i.status === "open") {
      findings.push({
        level: "warning",
        code: "orphan_issue",
        message: `Issue ${i.id} is open with no related tickets.`,
        entity: i.id,
      });
    }
  }

  // Duplicate leaf order within same phase (info)
  const orderByPhase = new Map<string | null, Map<number, string[]>>();
  for (const t of state.leafTickets) {
    const phase = t.phase;
    if (!orderByPhase.has(phase)) orderByPhase.set(phase, new Map());
    const orders = orderByPhase.get(phase)!;
    if (!orders.has(t.order)) orders.set(t.order, []);
    orders.get(t.order)!.push(t.id);
  }
  for (const [phase, orders] of orderByPhase) {
    for (const [order, ids] of orders) {
      if (ids.length > 1) {
        findings.push({
          level: "info",
          code: "duplicate_order",
          message: `Phase "${phase ?? "null"}": tickets ${ids.join(", ")} share order ${order}.`,
          entity: null,
        });
      }
    }
  }

  const errorCount = findings.filter((f) => f.level === "error").length;
  const warningCount = findings.filter((f) => f.level === "warning").length;
  const infoCount = findings.filter((f) => f.level === "info").length;

  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    findings,
  };
}

/**
 * Merges LoadResult.warnings into a ValidationResult.
 * parse_error/schema_error → error level. naming_convention → info level.
 */
export function mergeValidation(
  result: ValidationResult,
  loaderWarnings: readonly LoadWarning[],
): ValidationResult {
  if (loaderWarnings.length === 0) return result;

  const extra: ValidationFinding[] = loaderWarnings.map((w) => ({
    level:
      w.type === "naming_convention" ? ("info" as const) : ("error" as const),
    code: `loader_${w.type}`,
    message: `${w.file}: ${w.message}`,
    entity: null,
  }));

  const allFindings = [...result.findings, ...extra];
  const errorCount = allFindings.filter((f) => f.level === "error").length;
  const warningCount = allFindings.filter((f) => f.level === "warning").length;
  const infoCount = allFindings.filter((f) => f.level === "info").length;

  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    findings: allFindings,
  };
}

// --- Cycle Detection ---

function detectParentCycles(
  state: ProjectState,
  findings: ValidationFinding[],
): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  for (const t of state.tickets) {
    if (t.parentTicket == null || visited.has(t.id)) continue;
    dfsParent(t.id, state, visited, inStack, findings);
  }
}

function dfsParent(
  id: string,
  state: ProjectState,
  visited: Set<string>,
  inStack: Set<string>,
  findings: ValidationFinding[],
): void {
  if (inStack.has(id)) {
    findings.push({
      level: "error",
      code: "parent_cycle",
      message: `Cycle detected in parentTicket chain involving ${id}.`,
      entity: id,
    });
    return;
  }
  if (visited.has(id)) return;

  inStack.add(id);
  const ticket = state.ticketByID(id);
  if (ticket?.parentTicket && ticket.parentTicket !== id) {
    dfsParent(ticket.parentTicket, state, visited, inStack, findings);
  }
  inStack.delete(id);
  visited.add(id);
}

function detectBlockedByCycles(
  state: ProjectState,
  findings: ValidationFinding[],
): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  for (const t of state.tickets) {
    if (t.blockedBy.length === 0 || visited.has(t.id)) continue;
    dfsBlocked(t.id, state, visited, inStack, findings);
  }
}

function dfsBlocked(
  id: string,
  state: ProjectState,
  visited: Set<string>,
  inStack: Set<string>,
  findings: ValidationFinding[],
): void {
  if (inStack.has(id)) {
    findings.push({
      level: "error",
      code: "blocked_by_cycle",
      message: `Cycle detected in blockedBy chain involving ${id}.`,
      entity: id,
    });
    return;
  }
  if (visited.has(id)) return;

  inStack.add(id);
  const ticket = state.ticketByID(id);
  if (ticket) {
    for (const bid of ticket.blockedBy) {
      if (bid !== id) {
        dfsBlocked(bid, state, visited, inStack, findings);
      }
    }
  }
  inStack.delete(id);
  visited.add(id);
}
