import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../models/ticket.js";
import { hasConflicts } from "./conflicts.js";
import { displayIdOf } from "./resolver.js";
import { isTeamModeConfig } from "./team-capabilities.js";

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
 * Pure function -- no I/O. Returns structured findings, never throws.
 */
export function validateProject(state: ProjectState): ValidationResult {
  const findings: ValidationFinding[] = [];
  const phaseIDs = new Set(state.roadmap.phases.map((p) => p.id));
  const deletedTicketIDs = new Set<string>();
  for (const t of state.tickets) {
    if ((t as Record<string, unknown>).lifecycle === "deleted") {
      deletedTicketIDs.add(t.id);
    }
  }

  // Duplicate ticket IDs
  const ticketIDCounts = new Map<string, number>();
  for (const t of state.tickets) {
    ticketIDCounts.set(t.id, (ticketIDCounts.get(t.id) ?? 0) + 1);
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

  // Dedupe keys are idempotency identities, so two issues may never share one.
  const issueDedupeKeys = new Map<string, string[]>();
  for (const issue of state.activeIssues) {
    if (!issue.dedupeKey) continue;
    const ids = issueDedupeKeys.get(issue.dedupeKey) ?? [];
    ids.push(displayIdOf(issue));
    issueDedupeKeys.set(issue.dedupeKey, ids);
  }
  for (const [key, ids] of issueDedupeKeys) {
    if (ids.length < 2) continue;
    findings.push({
      level: "error",
      code: "duplicate_issue_dedupe_key",
      message: `Issue dedupe key "${key}" is shared by ${ids.join(", ")}.`,
      entity: null,
    });
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

  // Duplicate displayIds (team mode only) -- ISS-729.
  // In team mode the default "local" allocator assigns a PROVISIONAL sequential
  // displayId (max+1) per branch while the canonical id stays a unique entropy
  // id, so two branches can independently mint the same "T-042"; git sees no
  // conflict (canonical ids and filenames differ), cross-references never break,
  // and reconcile renames the losers on merge. `validate` is the natural
  // pre-merge sanity command, so surface the same duplicate-displayId signal
  // that `storybloq team doctor` and reconcile already provide, rather than
  // leaving it to be discovered only at merge/reconcile time. Two deliberate
  // choices: (1) group over ACTIVE items only -- a displayId still held by a
  // tombstone is not a reconcile-actionable duplicate (ISS-689), and flagging it
  // would be a false positive reconcile will not resolve; (2) level "warning",
  // not "error" -- a provisional displayId collision is a by-design-transient
  // state that leaves the project fully functional (canonical ids are unique)
  // until reconcile runs, so it should surface without failing validate. In
  // non-team mode displayId === canonical id, so any collision is already
  // reported as duplicate_<entity>_id; gating on team mode avoids double-counting.
  if (isTeamModeConfig(state.config)) {
    const displayIdGroups: ReadonlyArray<{ type: string; items: readonly { id: string; displayId?: string | null }[] }> = [
      { type: "ticket", items: state.tickets },
      { type: "issue", items: state.issues },
      { type: "note", items: state.notes },
      { type: "lesson", items: state.lessons },
    ];
    for (const { type, items } of displayIdGroups) {
      const idsByDisplay = new Map<string, string[]>();
      for (const item of items) {
        if ((item as Record<string, unknown>).lifecycle === "deleted") continue;
        const did = displayIdOf(item);
        const ids = idsByDisplay.get(did) ?? [];
        ids.push(item.id);
        idsByDisplay.set(did, ids);
      }
      for (const [displayId, ids] of idsByDisplay) {
        if (ids.length > 1) {
          findings.push({
            level: "warning",
            code: "duplicate_display_id",
            message: `Duplicate ${type} displayId ${displayId}: ${ids.join(", ")}. Run \`storybloq reconcile\` to assign unique displayIds.`,
            entity: displayId,
          });
        }
      }
    }
  }

  // Lesson reference checks
  for (const l of state.lessons) {
    // supersedes ref
    if (l.supersedes != null) {
      const resolved = state.resolveLessonRef(l.supersedes);
      if (resolved.kind === "found" && resolved.item.id === l.id) {
        findings.push({
          level: "error",
          code: "self_ref_supersedes",
          message: `Lesson ${l.id} references itself in supersedes.`,
          entity: l.id,
        });
      } else if (resolved.kind === "missing") {
        findings.push({
          level: "error",
          code: "invalid_supersedes_ref",
          message: `Lesson ${l.id} supersedes nonexistent lesson ${l.supersedes}.`,
          entity: l.id,
        });
      } else if (resolved.kind === "ambiguous") {
        findings.push({
          level: "error",
          code: "ambiguous_supersedes_ref",
          message: `Lesson ${l.id} supersedes ambiguous lesson reference ${l.supersedes}.`,
          entity: l.id,
        });
      }
    }
  }

  // Supersedes cycle detection (DFS)
  detectSupersedesCycles(state, findings);

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
    // Phase ref (null is valid -- unphased)
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
      const resolved = state.resolveTicketRef(bid);
      if (resolved.kind === "found" && resolved.item.id === t.id) {
        findings.push({
          level: "error",
          code: "self_ref_blocked_by",
          message: `Ticket ${t.id} references itself in blockedBy.`,
          entity: t.id,
        });
      } else if (resolved.kind === "missing") {
        findings.push({
          level: "error",
          code: "invalid_blocked_by_ref",
          message: `Ticket ${t.id} blockedBy references nonexistent ticket ${bid}.`,
          entity: t.id,
        });
      } else if (resolved.kind === "ambiguous") {
        findings.push({
          level: "error",
          code: "ambiguous_blocked_by_ref",
          message: `Ticket ${t.id} blockedBy references ambiguous ticket ${bid}.`,
          entity: t.id,
        });
      } else if (deletedTicketIDs.has(resolved.item.id)) {
        findings.push({
          level: "warning",
          code: "blocked_by_deleted",
          message: `Ticket ${t.id} blockedBy references deleted ticket ${bid}.`,
          entity: t.id,
        });
      } else if (state.umbrellaIDs.has(resolved.item.id)) {
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
      const resolvedParent = state.resolveTicketRef(t.parentTicket);
      if (resolvedParent.kind === "found" && resolvedParent.item.id === t.id) {
        findings.push({
          level: "error",
          code: "self_ref_parent",
          message: `Ticket ${t.id} references itself as parentTicket.`,
          entity: t.id,
        });
      } else if (resolvedParent.kind === "missing") {
        findings.push({
          level: "error",
          code: "invalid_parent_ref",
          message: `Ticket ${t.id} parentTicket references nonexistent ticket ${t.parentTicket}.`,
          entity: t.id,
        });
      } else if (resolvedParent.kind === "ambiguous") {
        findings.push({
          level: "error",
          code: "ambiguous_parent_ref",
          message: `Ticket ${t.id} parentTicket references ambiguous ticket ${t.parentTicket}.`,
          entity: t.id,
        });
      } else if (deletedTicketIDs.has(resolvedParent.item.id)) {
        findings.push({
          level: "warning",
          code: "parent_deleted",
          message: `Ticket ${t.id} parentTicket references deleted ticket ${t.parentTicket}.`,
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
      const resolved = state.resolveTicketRef(tref);
      if (resolved.kind === "missing") {
        findings.push({
          level: "error",
          code: "invalid_related_ticket_ref",
          message: `Issue ${i.id} relatedTickets references nonexistent ticket ${tref}.`,
          entity: i.id,
        });
      } else if (resolved.kind === "ambiguous") {
        findings.push({
          level: "error",
          code: "ambiguous_related_ticket_ref",
          message: `Issue ${i.id} relatedTickets references ambiguous ticket ${tref}.`,
          entity: i.id,
        });
      } else if (deletedTicketIDs.has(resolved.item.id)) {
        findings.push({
          level: "warning",
          code: "related_ticket_deleted",
          message: `Issue ${i.id} relatedTickets references deleted ticket ${tref}.`,
          entity: i.id,
        });
      }
    }

    // Issue phase ref (null/undefined is valid -- unphased)
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

  // Cross-node ref validation (orchestrator only)
  if (
    state.config.type === "orchestrator" &&
    state.config.nodes != null &&
    typeof state.config.nodes === "object"
  ) {
    const nodeNames = new Set(Object.keys(state.config.nodes));
    for (const ticket of state.tickets) {
      const refs = ticket.crossNodeBlockedBy;
      if (!refs) continue;
      for (const ref of refs) {
        if (typeof ref !== "string") continue;
        const match = CROSS_NODE_REF_CAPTURE_REGEX.exec(ref);
        if (!match) continue;
        const nodeName = match[1]!;
        if (!nodeNames.has(nodeName)) {
          findings.push({
            level: "warning",
            code: "unknown_cross_node_ref",
            message: `${ticket.id}: crossNodeBlockedBy references unknown node "${nodeName}" in "${ref}".`,
            entity: ticket.id,
          });
        }
      }
    }
  }

  const conflicts = hasConflicts(state);
  for (const item of conflicts.items) {
    findings.push({
      level: "error",
      code: "unresolved_conflicts",
      message: `${item.id} has ${item.conflictCount} unresolved conflict(s). Run \`storybloq conflicts show ${item.id}\`, then \`storybloq resolve <id> --use ours|theirs\` (for config.json/roadmap.json use \`storybloq resolve config\` or \`storybloq resolve roadmap\`).`,
      entity: item.id,
    });
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
  // ISS-730: drop "cross_reference" loader warnings here. They are produced by
  // the opt-in validateOnLoad pass, which runs the SAME validateProject the
  // validate command already runs against ctx.state -- merging them would
  // double-report every cross-reference finding. They remain in the raw load
  // warning stream for consumers (read commands) that do not run validateProject.
  const merged = loaderWarnings.filter((w) => w.type !== "cross_reference");
  if (merged.length === 0) return result;

  const extra: ValidationFinding[] = merged.map((w) => ({
    level:
      w.type === "naming_convention"
        ? ("info" as const)
        : w.type === "filename_id_mismatch"
          ? ("warning" as const)
          : ("error" as const),
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

/** Add validation findings from an I/O-backed validation pass. */
export function appendValidationFindings(
  result: ValidationResult,
  extra: readonly ValidationFinding[],
): ValidationResult {
  if (extra.length === 0) return result;
  const findings = [...result.findings, ...extra];
  const errorCount = findings.filter((finding) => finding.level === "error").length;
  const warningCount = findings.filter((finding) => finding.level === "warning").length;
  const infoCount = findings.filter((finding) => finding.level === "info").length;
  return {
    valid: errorCount === 0,
    errorCount,
    warningCount,
    infoCount,
    findings,
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
    const resolved = state.resolveTicketRef(ticket.parentTicket);
    if (resolved.kind === "found" && resolved.item.id !== id) {
      dfsParent(resolved.item.id, state, visited, inStack, findings);
    }
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
      const resolved = state.resolveTicketRef(bid);
      if (resolved.kind === "found" && resolved.item.id !== id) {
        dfsBlocked(resolved.item.id, state, visited, inStack, findings);
      }
    }
  }
  inStack.delete(id);
  visited.add(id);
}

function detectSupersedesCycles(
  state: ProjectState,
  findings: ValidationFinding[],
): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();

  for (const l of state.lessons) {
    if (l.supersedes == null || visited.has(l.id)) continue;
    dfsSupersedesChain(l.id, state, visited, inStack, findings);
  }
}

function dfsSupersedesChain(
  id: string,
  state: ProjectState,
  visited: Set<string>,
  inStack: Set<string>,
  findings: ValidationFinding[],
): void {
  if (inStack.has(id)) {
    findings.push({
      level: "error",
      code: "supersedes_cycle",
      message: `Cycle detected in supersedes chain involving ${id}.`,
      entity: id,
    });
    return;
  }
  if (visited.has(id)) return;

  inStack.add(id);
  const lesson = state.lessonByID(id);
  if (lesson?.supersedes && lesson.supersedes !== id) {
    const resolved = state.resolveLessonRef(lesson.supersedes);
    if (resolved.kind === "found" && resolved.item.id !== id) {
      dfsSupersedesChain(resolved.item.id, state, visited, inStack, findings);
    }
  }
  inStack.delete(id);
  visited.add(id);
}
