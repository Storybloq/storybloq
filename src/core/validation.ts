import type { ProjectState } from "./project-state.js";
import type { LoadWarning } from "./errors.js";
import { CROSS_NODE_REF_CAPTURE_REGEX } from "../models/ticket.js";
import { hasConflicts, type ConflictedItem } from "./conflicts.js";
import { displayIdOf } from "./resolver.js";
import { openUnphasedLeaves } from "./queries.js";
import { isTeamModeConfig } from "./team-capabilities.js";
import { isTicketEarmarkStale, isIssueEarmarkStale } from "./earmarks.js";
import type { Ruling } from "../models/ruling.js";
import type { RulingScanCompleteness } from "./ruling-loader.js";
import { buildSuccessorIndex, buildCitationResolutionContext, lifecycleMapFor, resolveCitation, type UpwardBoard } from "./ruling.js";
import { classifyLifecycle, isEffectivelyAccepted } from "./ruling-lifecycle.js";
import { RESERVED_RESPONSE_KEYS, dispositionEvidenceView, resolutionKindView } from "./resolution-kind.js";

const DEFAULT_EARMARK_STALE_THRESHOLD_HOURS = 48;

// --- Types ---

export type ValidationLevel = "error" | "warning" | "info";

export interface ValidationFinding {
  readonly level: ValidationLevel;
  readonly code: string;
  readonly message: string;
  readonly entity: string | null;
  /**
   * T-520: which board the cited ruling was found on. Present only on citation
   * findings that had to leave this project, absent everywhere else, so
   * `--format json` gains a key rather than changing one.
   */
  readonly board?: "orchestrator";
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  readonly findings: readonly ValidationFinding[];
}

/**
 * T-476: optional ruling side-store input. Absent (the default) means
 * exactly the pre-T-476 behavior -- ruling checks are skipped entirely, not
 * run against an empty set, so a caller that has not yet loaded rulings sees
 * no new findings at all. The `validate` command boundary is the one caller
 * that populates this.
 */
export interface ValidationAux {
  /**
   * T-520: the ORCHESTRATOR's board, when this project records a pointer to
   * one and something is actually cited. Supplied BY THE CALLER, never loaded
   * here: this function is pure and synchronous and runs on every ticket and
   * issue write, so the decision to pay for another board's read belongs to
   * whoever is calling. A caller that passes nothing gets exactly today's
   * behaviour, which is what every non-federated call site relies on.
   */
  readonly upwardBoard?: UpwardBoard;
  readonly rulings?: readonly Ruling[];
  readonly unavailableRulingIds?: ReadonlySet<string>;
  readonly rulingScanCompleteness?: RulingScanCompleteness;
  readonly rulingHasUnrecoverableEntries?: boolean;
  /**
   * T-494: whether the TICKET AND ISSUE load dropped nothing.
   *
   * A complete ruling scan does not make a complete citation scan.
   * `loadProjectUnlocked` treats tickets and issues as best-effort and skips
   * corrupt entries with warnings, and this function only ever sees the
   * survivors, so a ruling whose sole citation lives in a skipped item would
   * look cited by nothing. Reachability needs BOTH halves.
   *
   * Absent means UNKNOWN, never complete: a caller that does not assert this
   * has not established it, and defaulting to `true` would be exactly the
   * fail-open the reachability check exists to close.
   */
  readonly citingEntityLoadComplete?: boolean;
  /**
   * T-498: whether the NEWEST handover file carries the
   * `<!-- storybloq-handover v1 -->` marker but has no `Carried forward`
   * heading. Pre-computed by the CLI/MCP boundary (the one file read this
   * check needs) -- `validateProject` itself does no I/O, same shape as the
   * ruling side-store fields above. A legacy handover with no marker at all
   * never sets this, regardless of its heading content.
   */
  readonly handoverNewestMarkedWithoutCarriedForward?: boolean;
}

/**
 * The one `unresolved_conflicts` finding, shared by the ledger scan below and
 * the catalog findings the async `validate` entry point adds (T-529), so a
 * conflicted catalog is reported in the same words as a conflicted ticket.
 */
export function unresolvedConflictFinding(item: ConflictedItem): ValidationFinding {
  const next = item.type === "capabilities" || item.type === "glossary"
    ? `; ordinary writes to ${item.id} are refused until they are resolved.`
    : `, then \`storybloq resolve <id> --use ours|theirs\` (for config.json/roadmap.json use \`storybloq resolve config\` or \`storybloq resolve roadmap\`).`;
  return {
    level: "error",
    code: "unresolved_conflicts",
    message: `${item.id} has ${item.conflictCount} unresolved conflict(s). Run \`storybloq conflicts show ${item.id}\`${next}`,
    entity: item.id,
  };
}

// --- Main Validation ---

/**
 * Validates a fully loaded ProjectState for reference integrity.
 * Pure function -- no I/O. Returns structured findings, never throws.
 */
export function validateProject(
  state: ProjectState,
  now: string = new Date().toISOString(),
  aux: ValidationAux = {},
): ValidationResult {
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

  // ISS-1112: an open unphased leaf is legal but never ranked by roadmap
  // order, so it is warned rather than blessed. Leaves only: an umbrella may
  // be unphased while its children are phased.
  for (const t of openUnphasedLeaves(state)) {
    findings.push({
      level: "warning",
      code: "unphased_ticket",
      message: `Ticket ${displayIdOf(t)} has no phase; assign one to control its roadmap priority.`,
      entity: t.id,
    });
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

  // T-486: resolution kinds and disposition evidence that no longer count.
  // Readers already ignore them (src/core/resolution-kind.ts); this says why.
  for (const i of state.issues) {
    if ((i as Record<string, unknown>).lifecycle === "deleted") continue;
    const rec = i as Record<string, unknown>;
    const kind = resolutionKindView(rec);
    if (kind.state === "stale") {
      findings.push({
        level: "warning",
        code: "resolution_kind_stale",
        message: `Issue ${displayIdOf(i)} has a resolution kind that no longer matches its closure (status, resolved date or resolution text changed after it was written, for example by a client that does not know the field). It is ignored until set again.`,
        entity: i.id,
      });
    } else if (kind.state === "malformed") {
      findings.push({
        level: "warning",
        code: "resolution_kind_malformed",
        message: `Issue ${displayIdOf(i)} has a resolutionKind value that is not a valid resolution kind record. It is ignored.`,
        entity: i.id,
      });
    } else if (kind.state === "wrong-entity") {
      findings.push({
        level: "warning",
        code: "resolution_kind_wrong_entity",
        message: `Issue ${displayIdOf(i)} carries the ticket-only resolution kind "withdrawn". It is ignored.`,
        entity: i.id,
      });
    }
    const evidence = dispositionEvidenceView(rec);
    if (evidence.state === "unbound") {
      const now = typeof rec.disposition === "string" ? `the disposition is now ${rec.disposition}` : "the disposition has been cleared";
      findings.push({
        level: "warning",
        code: "disposition_evidence_unbound",
        message: `Issue ${displayIdOf(i)} has disposition evidence written for ${String(rec.dispositionFor)}, but ${now}. The evidence is ignored until set again.`,
        entity: i.id,
      });
    } else if (evidence.state === "malformed") {
      findings.push({
        level: "warning",
        code: "disposition_evidence_malformed",
        message: `Issue ${displayIdOf(i)} has dispositionReason, dispositionRef or dispositionFor values that do not form valid evidence. They are ignored.`,
        entity: i.id,
      });
    }
    for (const key of RESERVED_RESPONSE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(rec, key)) {
        findings.push({
          level: "warning",
          code: "reserved_key_collision",
          message: `Issue ${displayIdOf(i)} stores a custom "${key}" key, which collides with a reserved JSON response name.`,
          entity: i.id,
        });
      }
    }
  }

  // T-475: stale earmark check. Threshold from config, default 48h -- pure
  // over item-file fields plus the caller-supplied `now` (AM-a: `validate`
  // has no touch-recency signal of its own, so staleness must be checkable
  // from the earmark's own `since` and, for tickets, whether `claimedBySession`
  // still matches the earmark's holder). A stale ticket earmark is a stuck
  // reservation or an assignment whose claim moved on; a stale issue earmark
  // is always flagged past threshold once `assigned` (AM-b: issues carry no
  // claimedBySession, so an assigned issue earmark is definitionally
  // unmatchable and includes the dead-session sweep-strand case).
  const earmarkStaleThresholdHours =
    state.config.recipeOverrides?.earmarkStaleThresholdHours ?? DEFAULT_EARMARK_STALE_THRESHOLD_HOURS;
  for (const t of state.tickets) {
    if ((t as Record<string, unknown>).lifecycle === "deleted") continue;
    if (isTicketEarmarkStale(t, earmarkStaleThresholdHours, now)) {
      findings.push({
        level: "warning",
        code: "stale_earmark",
        message: `Ticket ${displayIdOf(t)} has a stale earmark (since ${t.earmark?.since}).`,
        entity: t.id,
      });
    }
  }
  for (const i of state.issues) {
    if ((i as Record<string, unknown>).lifecycle === "deleted") continue;
    if (isIssueEarmarkStale(i, earmarkStaleThresholdHours, now)) {
      findings.push({
        level: "warning",
        code: "stale_earmark",
        message: `Issue ${displayIdOf(i)} has a stale earmark (since ${i.earmark?.since}).`,
        entity: i.id,
      });
    }
  }

  // ISS-1203: an open issue with no phase is invisible on the Mac app's
  // phase-grouped board. Only worth flagging when the roadmap has phases to
  // sort into -- a phase-less roadmap makes the field moot for everyone.
  if (phaseIDs.size > 0) {
    for (const i of state.activeIssues) {
      if (i.status !== "open") continue;
      if (i.phase != null) continue;
      findings.push({
        level: "info",
        code: "issue_missing_phase",
        message: `Issue ${displayIdOf(i)} has no phase and will not appear on the phase-grouped board.`,
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

  // T-522: a conflicted ruling binds nothing until resolved; it is reported
  // here with every other unresolved conflict so one `validate` names them all.
  const conflicts = hasConflicts(state, undefined, aux.rulings);
  for (const item of conflicts.items) findings.push(unresolvedConflictFinding(item));

  if (aux.rulings !== undefined) {
    validateRulings(
      aux.rulings,
      aux.unavailableRulingIds ?? new Set(),
      aux.rulingScanCompleteness ?? "complete",
      aux.rulingHasUnrecoverableEntries ?? false,
      aux.citingEntityLoadComplete === true,
      state,
      findings,
      aux.upwardBoard,
    );
  }

  // T-498: a marked handover (opted into the v1 scaffold contract) is
  // expected to carry a Carried forward heading, even an empty one. An
  // unmarked/legacy handover makes no such promise and never fires this --
  // the aux flag is only ever true when the marker was actually found.
  if (aux.handoverNewestMarkedWithoutCarriedForward === true) {
    findings.push({
      level: "info",
      code: "handover_no_carried_forward",
      message:
        "The newest handover carries the storybloq-handover v1 marker but has no Carried forward section.",
      entity: null,
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

/**
 * T-476: shared supersedes-chain cycle walk, generalized behind a bar
 * (gate-0 ruling): factors out the identical visited/inStack bookkeeping
 * that lessons and rulings both need, while leaving each caller's own id
 * RESOLUTION semantics separate -- lessons resolve through
 * `state.resolveLessonRef` (dual legacy/canonical id forms), rulings through
 * a direct canonical-id map lookup (no legacy form exists). `next(id)`
 * returns the next id in the chain, or null to stop the walk. Zero behavior
 * change for the existing lesson path: same code, same message shape, same
 * entity id.
 */
function walkSupersedesChain(
  startId: string,
  next: (id: string) => string | null,
  visited: Set<string>,
  inStack: Set<string>,
  code: string,
  findings: ValidationFinding[],
): void {
  // Codex round-2 finding 4: iterative, not recursive -- a chain has no
  // branching (each id has exactly one `next`), so this is a linked-list
  // walk, not a graph traversal; a call-stack frame per link let a
  // sufficiently long ledger chain crash `storybloq validate` instead of
  // reporting a finding. `opened` records the walk order so the unwind loop
  // below finishes ids in the same order the old recursion's post-walk lines
  // (`inStack.delete`; `visited.add`) would have -- last-opened first.
  const opened: string[] = [];
  let id: string | null = startId;
  while (id !== null) {
    if (inStack.has(id)) {
      findings.push({
        level: "error",
        code,
        message: `Cycle detected in supersedes chain involving ${id}.`,
        entity: id,
      });
      break;
    }
    if (visited.has(id)) break;
    inStack.add(id);
    opened.push(id);
    id = next(id);
  }
  for (let i = opened.length - 1; i >= 0; i--) {
    inStack.delete(opened[i]!);
    visited.add(opened[i]!);
  }
}

function detectSupersedesCycles(
  state: ProjectState,
  findings: ValidationFinding[],
): void {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const nextLesson = (id: string): string | null => {
    const lesson = state.lessonByID(id);
    if (!lesson?.supersedes || lesson.supersedes === id) return null;
    const resolved = state.resolveLessonRef(lesson.supersedes);
    return resolved.kind === "found" && resolved.item.id !== id ? resolved.item.id : null;
  };

  for (const l of state.lessons) {
    if (l.supersedes == null || visited.has(l.id)) continue;
    walkSupersedesChain(l.id, nextLesson, visited, inStack, "supersedes_cycle", findings);
  }
}

/**
 * T-476 section 7: ruling-specific validation. Pure over `(rulings,
 * unavailableIds, scanCompleteness, state)` -- no I/O. Runs only when the
 * caller supplies `aux.rulings` (the `validate` command boundary is the one
 * caller that loads the side-store; every other `validateProject` call site
 * is unaffected).
 */
/**
 * T-520: " on the orchestrator board", or nothing at all when the resolution
 * never left this project -- so every message a single-project reader sees is
 * byte-identical to the one they saw before this ticket.
 */
function boardSuffix(board: "orchestrator" | undefined): string {
  return board === "orchestrator" ? " on the orchestrator board" : "";
}

/**
 * The entities whose `citesRulings` this file actually resolves.
 *
 * Arrangements ALSO carry a `citesRulings` field, and are deliberately not
 * here: they are off the strict `ProjectState` load path (T-473 binding item
 * 2) and `ProjectState` does not carry them at all, so their citations are not
 * checked by this function.
 *
 * Exported because T-520's read-gate (`loadUpwardBoardFor`) must ask about
 * EXACTLY this population. Two hand-maintained lists would drift, and the
 * failure mode of drift is silent and bad in both directions: a gate wider
 * than the loop reads another board for citations nobody checks, and a gate
 * narrower than the loop reports a resolvable citation as a dangling error.
 * If arrangements are ever brought into the loop, changing this one function
 * moves both.
 */
export function citingEntitiesOf(
  state: ProjectState,
): ReadonlyArray<{ id: string; citesRulings?: readonly string[] }> {
  return [...state.tickets, ...state.issues];
}

function validateRulings(
  rulings: readonly Ruling[],
  unavailableIds: ReadonlySet<string>,
  scanCompleteness: RulingScanCompleteness,
  hasUnrecoverableEntries: boolean,
  citingEntityLoadComplete: boolean,
  state: ProjectState,
  findings: ValidationFinding[],
  // T-520: the orchestrator's board, passed down from `aux` rather than read
  // here -- this file does no IO.
  upwardBoard: UpwardBoard | undefined,
): void {
  const rulingsById = new Map(rulings.map((r) => [r.id, r]));

  // T-522: lifecycle invariants. A record that claims a state its evidence
  // does not support is reported with the SAME code the classifier uses, so
  // `validate`'s output and the read-side quarantine can never disagree.
  const lifecycleIndex = buildSuccessorIndex(rulings);
  const lifecycleById = lifecycleMapFor(rulings, lifecycleIndex);
  const completedItemIds = new Set<string>([
    ...state.tickets.filter((t) => t.status === "complete").map((t) => t.id),
    ...state.issues.filter((i) => i.status === "resolved").map((i) => i.id),
  ]);
  for (const r of rulings) {
    for (const reason of classifyLifecycle(r).reasons) {
      findings.push({ level: "error", code: reason.code, message: `Ruling ${reason.detail}.`, entity: r.id });
    }
    const lifecycle = lifecycleById.get(r.id);
    if (lifecycle === "proposed") {
      for (const itemId of r.proposedFor ?? []) {
        if (completedItemIds.has(itemId)) {
          findings.push({
            level: "warning",
            code: "ruling_proposal_on_completed_item",
            message: `Ruling ${r.id} is proposed for ${itemId}, which is already complete; accept or withdraw it.`,
            entity: r.id,
          });
        }
      }
    }
    if (lifecycle !== undefined && isEffectivelyAccepted(lifecycle) && r.supersedes) {
      const targetLifecycle = lifecycleById.get(r.supersedes);
      if (targetLifecycle !== undefined && !isEffectivelyAccepted(targetLifecycle)) {
        findings.push({
          level: "error",
          code: "ruling_successor_of_nonaccepted",
          message: `Ruling ${r.id} supersedes ${r.supersedes}, which is ${targetLifecycle} and does not currently bind.`,
          entity: r.id,
        });
      }
    }
  }

  // Self-supersedes / dangling / unreadable supersedes-target invariants
  // (rulings #5-adjacent structural checks, distinct from the citation checks below).
  for (const r of rulings) {
    if (!r.supersedes) continue;
    if (r.supersedes === r.id) {
      findings.push({
        level: "error",
        code: "ruling_self_supersedes",
        message: `Ruling ${r.id} supersedes itself.`,
        entity: r.id,
      });
      continue;
    }
    if (unavailableIds.has(r.supersedes)) {
      findings.push({
        level: "error",
        code: "ruling_unreadable_supersedes_target",
        message: `Ruling ${r.id} supersedes ${r.supersedes}, which is currently unreadable.`,
        entity: r.id,
      });
    } else if (!rulingsById.has(r.supersedes)) {
      findings.push({
        level: "error",
        code: "ruling_missing_supersedes_target",
        message: `Ruling ${r.id} supersedes ${r.supersedes}, which does not exist.`,
        entity: r.id,
      });
    }
  }

  // Cycle detection: same shared walk and the SAME "supersedes_cycle" code
  // as lessons (generalized-behind-a-bar gate-0 ruling) -- a ruling's
  // `supersedes` is canonical-only, so resolution is a direct map lookup,
  // no legacy dual-form to resolve.
  {
    const cycleVisited = new Set<string>();
    const inStack = new Set<string>();
    const nextRuling = (id: string): string | null => {
      const r = rulingsById.get(id);
      if (!r?.supersedes || r.supersedes === id || !rulingsById.has(r.supersedes)) return null;
      return r.supersedes;
    };
    for (const r of rulings) {
      if (!r.supersedes || cycleVisited.has(r.id)) continue;
      walkSupersedesChain(r.id, nextRuling, cycleVisited, inStack, "supersedes_cycle", findings);
    }
  }

  // Branch detection: a predecessor with more than one successor.
  const index = buildSuccessorIndex(rulings);
  for (const target of index.branchedTargets) {
    const successors = index.successorsByTarget.get(target) ?? [];
    findings.push({
      level: "error",
      code: "ruling_supersedes_branch",
      message: `Ruling ${target} has competing successors: ${successors.join(", ")}.`,
      entity: target,
    });
  }

  // Citation checks: every ticket/issue citesRulings entry, resolved to its
  // current state. Arrangements are off the strict ProjectState load path
  // (T-473 binding item 2) and are not part of this pure function's input.
  const baseCtx = buildCitationResolutionContext(rulings, unavailableIds, scanCompleteness, hasUnrecoverableEntries);
  // T-520: attached rather than folded into the builder's signature, so every
  // other caller of `buildCitationResolutionContext` is untouched.
  const ctx = upwardBoard ? { ...baseCtx, upward: upwardBoard } : baseCtx;
  const reachedCurrentIds = new Set<string>();
  const citingEntities = citingEntitiesOf(state);
  for (const entity of citingEntities) {
    for (const citedId of entity.citesRulings ?? []) {
      const resolution = resolveCitation(citedId, ctx);
      if (resolution.status === "resolved" && resolution.stale) {
        findings.push({
          level: "warning",
          code: "superseded_ruling_citation",
          // T-520: the board is named only when the ruling is not this
          // project's, so a reader who sees no board is looking at a
          // single-project message that reads exactly as it did before.
          message: `${entity.id} cites ${citedId}, which has been superseded by ${resolution.current.id}${
            resolution.board === "orchestrator" ? " on the orchestrator board" : ""
          }.`,
          entity: entity.id,
          ...(resolution.board !== undefined && { board: resolution.board }),
        });
      } else if (resolution.status === "missing") {
        findings.push({
          level: "error",
          code: "dangling_ruling_citation",
          message: `${entity.id} cites ${citedId}, which does not exist.`,
          entity: entity.id,
        });
      } else if (resolution.status === "nonaccepted") {
        // T-522: the citation names a real, readable record that is not a
        // ruling. An ERROR, like a dangling citation: the item is bound to
        // nothing and a reader must not be shown the proposal as if it bound.
        findings.push({
          level: "error",
          code: "ruling_citation_of_nonaccepted",
          message: `${entity.id} cites ${citedId}, which is ${resolution.lifecycle} and binds nothing.`,
          entity: entity.id,
        });
      } else if (resolution.status === "unreadable") {
        findings.push({
          level: "warning",
          code: "unreadable_ruling_citation",
          // T-520: says WHOSE ledger, for the same reason the resolution
          // carries the board -- a reader told "unreadable" with no board goes
          // through their own `.story/rulings/`, which is the one directory
          // that is fine.
          message: `${entity.id} cites ${citedId}, which is currently unreadable${boardSuffix(resolution.board)}.`,
          entity: entity.id,
          ...(resolution.board !== undefined && { board: resolution.board }),
        });
      } else if (resolution.status === "indeterminate" && resolution.reason === "unreadable-orchestrator") {
        // T-520: this project records an orchestrator and that board could not
        // be read. A WARNING, never the `dangling_ruling_citation` error: the
        // id may well exist one board up, and calling it nonexistent is the
        // false claim this ticket exists to stop.
        findings.push({
          level: "warning",
          code: "citation_unresolved_upward",
          // The REASON comes off the board, never a hardcoded phrase. Two
          // different failures land here -- a recorded orchestrator whose
          // ledger could not be read, and this project's own config failing to
          // parse so we cannot even tell whether it records one -- and a fixed
          // message saying "this project records an orchestrator" would be a
          // confident false claim in the second case, on a plain project that
          // has no federation at all.
          message: `${entity.id} cites ${citedId}, which could not be checked: the federation context is unverifiable (${
            upwardBoard?.kind === "unreadable" ? upwardBoard.reason : "reason unavailable"
          }).`,
          entity: entity.id,
        });
      } else if (resolution.status === "indeterminate" && resolution.reason === "cross-board-supersession") {
        // T-520: both boards claim the chain. Reported rather than resolved --
        // picking one would invent an ordering neither board defines.
        findings.push({
          level: "warning",
          code: "cross_board_supersession",
          message: `${entity.id} cites ${citedId}, which is superseded on both this board and the orchestrator's. Neither claim is authoritative; reconcile them by hand.`,
          entity: entity.id,
        });
      } else if (
        (resolution.status === "branch" || resolution.status === "cycle")
        && resolution.board === "orchestrator"
      ) {
        // T-520: a branched or cyclic chain is normally reported ONCE from the
        // ruling graph above (`ruling_supersedes_branch`), not per citation --
        // which is why these two statuses were never handled here. That
        // reasoning holds only for THIS board's graph. Nothing validates the
        // ORCHESTRATOR's graph from here, so before this branch a citation
        // into a branched or cyclic root chain produced no finding at all: the
        // corruption was swallowed and the node was told nothing.
        //
        // Guarded on the board precisely so the local case keeps falling
        // through to the graph-level finding and is not reported twice.
        findings.push({
          level: "warning",
          code: resolution.status === "branch" ? "cross_board_branch_citation" : "cross_board_cycle_citation",
          message: resolution.status === "branch"
            ? `${entity.id} cites ${citedId}, whose supersedes chain branches${boardSuffix(resolution.board)}: ${resolution.competingSuccessors.join(", ")} each claim to supersede it. Reconcile it there.`
            : `${entity.id} cites ${citedId}, whose supersedes chain is cyclic${boardSuffix(resolution.board)}: ${resolution.chain.join(" -> ")}. Reconcile it there.`,
          entity: entity.id,
          board: resolution.board,
        });
      } else if (resolution.status === "indeterminate") {
        findings.push({
          level: "warning",
          code: "ruling_indeterminate_citation",
          message: `${entity.id} cites ${citedId}: chain state unverifiable (${resolution.reason})${boardSuffix(resolution.board)}.`,
          entity: entity.id,
          ...(resolution.board !== undefined && { board: resolution.board }),
        });
      }
      // "branch" and "cycle" resolutions are already reported once, keyed by
      // the ruling graph itself (ruling_supersedes_branch / supersedes_cycle
      // above) -- not duplicated per citing entity here.
      if (resolution.status === "resolved") reachedCurrentIds.add(resolution.current.id);
    }
  }

  // T-494 reachability. Deliberately computed by FOLLOWING each citation to its
  // tip (the `reachedCurrentIds` set above) rather than by set membership on
  // cited ids: an item citing a superseded ruling still reaches the current one
  // through the chain, and membership would report a live ruling as dark.
  //
  // The condition has TWO halves and needs both. The ruling scan must be
  // complete with nothing unreadable, AND the ticket/issue load must have
  // dropped nothing. Either false and no per-ruling claim is made at all,
  // because "nothing cites this" is a statement about everything that exists,
  // and a scan that could not see everything cannot support it.
  const rulingScanComplete =
    scanCompleteness === "complete" && unavailableIds.size === 0 && !hasUnrecoverableEntries;
  if (!rulingScanComplete || !citingEntityLoadComplete) {
    const incomplete: string[] = [];
    if (!rulingScanComplete) incomplete.push("the ruling scan was incomplete or a ruling was unreadable");
    if (!citingEntityLoadComplete) incomplete.push("the ticket and issue load dropped entries or did not report completeness");
    findings.push({
      level: "info",
      code: "ruling_reachability_unknown",
      message: `Ruling reachability was not computed: ${incomplete.join("; and ")}. No ruling is claimed cited or uncited.`,
      entity: null,
    });
    return;
  }

  for (const r of rulings) {
    // CURRENT means nothing supersedes it. A superseded ruling that nothing
    // cites is not reported: being uncited is the correct end state for
    // history, not a defect.
    if ((index.successorsByTarget.get(r.id) ?? []).length > 0) continue;
    if (reachedCurrentIds.has(r.id)) continue;
    findings.push({
      level: "info",
      code: "unreachable_ruling",
      // "no ticket or issue cites" rather than "unreachable": arrangements can
      // carry citesRulings but are off this function's input by T-473 binding
      // item 2, so a broader claim would overclaim what was actually checked.
      message: `Ruling ${r.id} is current, and no ticket or issue cites it. It will not reach an agent working an item.`,
      entity: r.id,
    });
  }
}
