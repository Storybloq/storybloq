import { displayIdOf } from "../../core/resolver.js";
import {
  type IssueCreateInput,
  validateIssueCreateSeverity,
  validateIssueCreateDedupeKey,
  validateIssueCreateDisposition,
  validateIssueCreateMetadata,
  validateIssueCreatePhase,
} from "../../core/issue-create-input.js";
import { inferIssuePhase } from "../../autonomous/issue-create-preparation.js";
import { validateProject } from "../../core/validation.js";
import { resolveAndNormalizeTicketRef, resolveAndNormalizeIssueRef, RefResolutionError } from "../../core/ref-normalization.js";
import { ProjectState } from "../../core/project-state.js";
import {
  withProjectLock,
  writeIssueUnlocked,
  deleteIssue,
} from "../../core/project-loader.js";
import { clearSameSessionEarmark } from "../../core/earmarks.js";
import { isNonActionableDisposition } from "../../core/issue-disposition.js";
import { ISSUE_RESOLUTION_KINDS, effectiveResolutionKind, issueJsonBody } from "../../core/resolution-kind.js";
import { nextIssueID, allocateTeamIssueId } from "../../core/id-allocation.js";
import { reserveDisplayId } from "../../core/remote-refs.js";
import { checkBranchAllocationWarning } from "../../core/branch-allocation-warning.js";
import { loadCitationContext } from "../../core/ruling-loader.js";
import { computeTargetedActionability } from "../../core/classification-context.js";
import { citationMapFor, resolveEntityCitations, resolveCitesRulingsInput } from "../../core/ruling.js";
import {
  formatIssueList,
  formatIssue,
  formatError,
  successEnvelope,
  ExitCode,
  stripRenderFence,
} from "../../core/output-formatter.js";
import {
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
  type IssueStatus,
  type IssueSeverity,
} from "../../models/types.js";
import { ISSUE_DISPOSITIONS,
  type Issue,
  type IssueDisposition,
  type IssueSourceRefInput,
} from "../../models/issue.js";
import {
  IssueSourceRefError,
  normalizeIssueSourceRefs,
} from "../../core/issue-source-ref.js";
import {
  todayISO,
  CliValidationError,
  assertUpdateHasFields,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import {
  formatMetadataValue,
  getMetadata,
  setMetadata,
  unsetMetadata,
} from "./metadata.js";

export type { IssueCreateInput };

// Re-export for register.ts
export { ISSUE_STATUSES, ISSUE_SEVERITIES };

const ISSUE_CORE_METADATA_KEYS = new Set([
  "id",
  "title",
  "status",
  "severity",
  "components",
  "impact",
  "resolution",
  "location",
  "sourceRefs",
  "dedupeKey",
  "discoveredDate",
  "resolvedDate",
  "relatedTickets",
  "order",
  "phase",
  "createdBy",
  "assignedTo",
  "lastModifiedBy",
  "displayId",
  "previousDisplayIds",
  "rank",
  "lifecycle",
  "_conflicts",
  "createdAt",
  "deletedAt",
  "deletedBy",
  "citesRulings",
  // T-486: set through `issue update`, which checks them together.
  "disposition",
  "dispositionReason",
  "dispositionRef",
  "dispositionFor",
  "duplicateOf",
  "resolutionKind",
  // T-486 A6: reserved for derived values in JSON output.
  "effective",
  "stored",
]);

function rethrowIssueResolutionError(err: unknown, fallbackMsg: string): never {
  if (err instanceof RefResolutionError) {
    const code = err.reason === "ambiguous" ? "invalid_input" : "not_found";
    throw new CliValidationError(code, err.message);
  }
  throw new CliValidationError("not_found", err instanceof Error ? err.message : fallbackMsg);
}

// --- Read Handlers ---

export function handleIssueList(
  filters: {
    status?: string;
    severity?: string;
    component?: string;
    phase?: string;
    /** T-486: a disposition value, or "none" for issues with no disposition. */
    disposition?: string;
    /** T-486: true keeps actionable issues, false keeps non-actionable ones. */
    actionable?: boolean;
    /** T-486: keeps issues whose resolution kind is effective and equal. */
    resolutionKind?: string;
  },
  ctx: CommandContext,
): CommandResult {
  let issues = [...ctx.state.activeIssues];

  if (filters.disposition !== undefined) {
    const wanted = filters.disposition;
    if (wanted !== "none" && !(ISSUE_DISPOSITIONS as readonly string[]).includes(wanted)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown disposition "${wanted}": must be one of ${ISSUE_DISPOSITIONS.join(", ")}, or none`,
      );
    }
    issues = issues.filter((i) => (wanted === "none" ? i.disposition === undefined : i.disposition === wanted));
  }
  if (filters.actionable !== undefined) {
    const wantActionable = filters.actionable;
    issues = issues.filter((i) => isNonActionableDisposition(i.disposition) !== wantActionable);
  }
  if (filters.resolutionKind !== undefined) {
    const wanted = filters.resolutionKind;
    if (!(ISSUE_RESOLUTION_KINDS as readonly string[]).includes(wanted)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown resolution kind "${wanted}": must be one of ${ISSUE_RESOLUTION_KINDS.join(", ")}`,
      );
    }
    issues = issues.filter((i) => effectiveResolutionKind(i) === wanted);
  }

  if (filters.status) {
    if (!ISSUE_STATUSES.includes(filters.status as IssueStatus)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown issue status "${filters.status}": must be one of ${ISSUE_STATUSES.join(", ")}`,
      );
    }
    issues = issues.filter((i) => i.status === filters.status);
  }
  if (filters.severity) {
    if (!ISSUE_SEVERITIES.includes(filters.severity as IssueSeverity)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown issue severity "${filters.severity}": must be one of ${ISSUE_SEVERITIES.join(", ")}`,
      );
    }
    issues = issues.filter((i) => i.severity === filters.severity);
  }
  if (filters.component) {
    issues = issues.filter((i) => i.components.includes(filters.component!));
  }
  // ISS-739: no roadmap validation here, matching handleTicketList; unknown
  // phase yields an empty list; the MCP tool closure validates like ticket_list.
  if (filters.phase) {
    issues = issues.filter((i) => i.phase === filters.phase);
  }

  return { output: formatIssueList(issues, ctx.format, citationMapFor(issues, loadCitationContext(ctx.root))) };
}

export function handleIssueGet(
  id: string,
  ctx: CommandContext,
  withActionability = false,
): CommandResult {
  const result = ctx.state.resolveIssueRef(id);
  if (result.kind === "ambiguous") {
    const ids = result.matches.map((m) => m.id).join(", ");
    return {
      output: formatError("invalid_input", `Ref "${id}" is ambiguous (matches: ${ids})`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "invalid_input",
    };
  }
  if (result.kind === "missing") {
    return {
      output: formatError("not_found", `Issue ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  const rulingCtx = loadCitationContext(ctx.root);
  const extraJsonFields = withActionability ? computeTargetedActionability(ctx, "issue", result.item) : undefined;
  return {
    output: formatIssue(result.item, ctx.format, ctx.state, resolveEntityCitations(result.item, rulingCtx), extraJsonFields),
  };
}

export function handleIssueMetaGet(
  id: string,
  path: string | undefined,
  ctx: CommandContext,
): CommandResult {
  const result = ctx.state.resolveIssueRef(id);
  if (result.kind === "ambiguous") {
    const ids = result.matches.map((m) => m.id).join(", ");
    return {
      output: formatError("invalid_input", `Ref "${id}" is ambiguous (matches: ${ids})`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "invalid_input",
    };
  }
  if (result.kind === "missing") {
    return {
      output: formatError("not_found", `Issue ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  const issue = result.item;
  const metaResult = getMetadata(issue as Record<string, unknown>, path, ISSUE_CORE_METADATA_KEYS);
  if (!metaResult.found) {
    const displayLabel = displayIdOf(issue);
    return {
      output: formatError("not_found", `Metadata path "${path}" not found on issue ${displayLabel}`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatMetadataValue(metaResult.value, ctx.format) };
}

// --- Write Handlers ---

function validateAndResolveRelatedTickets(ids: string[], state: ProjectState): string[] {
  const resolved: string[] = [];
  for (const tid of ids) {
    try {
      resolved.push(resolveAndNormalizeTicketRef(state, tid));
    } catch (err) {
      if (err instanceof RefResolutionError) {
        const code = err.reason === "ambiguous" ? "invalid_input" : "not_found";
        throw new CliValidationError(code, err.message);
      }
      throw new CliValidationError("not_found", err instanceof Error ? err.message : `Related ticket ${tid} not found`);
    }
  }
  return resolved;
}

/** Build a multiset of error findings keyed by code|entity|message, with message lookup. */
function buildErrorMultiset(findings: readonly { level: string; code: string; entity: string | null; message: string }[]): { counts: Map<string, number>; messages: Map<string, string> } {
  const counts = new Map<string, number>();
  const messages = new Map<string, string>();
  for (const f of findings) {
    if (f.level !== "error") continue;
    const key = `${f.code}|${f.entity ?? ""}|${f.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    messages.set(key, f.message);
  }
  return { counts, messages };
}

/** ISS-065: Only block writes that make the project WORSE. Pre-existing errors pass through. */
function validatePostWriteIssueState(
  candidate: Issue,
  state: ProjectState,
  isCreate: boolean,
): void {
  // Pre-write validation
  const preResult = validateProject(state);
  const { counts: preErrors } = buildErrorMultiset(preResult.findings);

  // Post-write validation
  const existingIssues = [...state.issues];
  if (isCreate) {
    existingIssues.push(candidate);
  } else {
    const idx = existingIssues.findIndex((i) => i.id === candidate.id);
    if (idx >= 0) existingIssues[idx] = candidate;
    else existingIssues.push(candidate);
  }
  const postState = new ProjectState({
    tickets: [...state.tickets],
    issues: existingIssues,
    notes: [...state.notes],
    roadmap: state.roadmap,
    config: state.config,
    handoverFilenames: [...state.handoverFilenames],
  });
  const postResult = validateProject(postState);
  const { counts: postErrors, messages: postMessages } = buildErrorMultiset(postResult.findings);

  // Block only if new errors were introduced
  const newErrors: string[] = [];
  for (const [key, postCount] of postErrors) {
    const preCount = preErrors.get(key) ?? 0;
    if (postCount > preCount) {
      newErrors.push(postMessages.get(key) ?? key);
    }
  }
  if (newErrors.length > 0) {
    throw new CliValidationError("validation_failed", `Write would create invalid state: ${newErrors.join("; ")}`);
  }
}

export async function handleIssueCreate(
  args: IssueCreateInput,
  format: string,
  root: string,
): Promise<CommandResult> {
  // ISS-1221: the three input checks below are shared with the recovery-record
  // preparer (core/issue-create-input.ts) and stay in this order: severity,
  // the citation check, the dedupe key; the phase once the ledger is locked.
  const severityRefusal = validateIssueCreateSeverity(args);
  if (severityRefusal) throw new CliValidationError("invalid_input", severityRefusal.message);
  const citesRulingsResolution = resolveCitesRulingsInput(args.citesRuling, undefined);
  if (!citesRulingsResolution.ok) {
    throw new CliValidationError("invalid_input", citesRulingsResolution.message);
  }

  const dedupeRefusal = validateIssueCreateDedupeKey(args);
  if (dedupeRefusal) throw new CliValidationError("invalid_input", dedupeRefusal.message);

  // ISS-1113: also pre-lock, and through the shared validator, for the same
  // reason as severity -- a disposition the schema would refuse must never
  // reach the write.
  const dispositionRefusal = validateIssueCreateDisposition(args);
  if (dispositionRefusal) throw new CliValidationError("invalid_input", dispositionRefusal.message);

  const metadataRefusal = validateIssueCreateMetadata(args);
  if (metadataRefusal) throw new CliValidationError("invalid_input", metadataRefusal.message);

  let createdIssue: Issue | undefined;
  let deduplicated = false;
  let createdInState: ProjectState | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    if (args.dedupeKey) {
      const existing = state.activeIssues.find((issue) => issue.dedupeKey === args.dedupeKey);
      if (existing) {
        createdIssue = existing;
        deduplicated = true;
        return;
      }
    }

    let sourceRefs;
    try {
      sourceRefs = args.sourceRefs
        ? await normalizeIssueSourceRefs(root, args.sourceRefs)
        : undefined;
    } catch (err) {
      if (err instanceof IssueSourceRefError) {
        throw new CliValidationError("invalid_input", err.message);
      }
      throw err;
    }

    const phaseRefusal = validateIssueCreatePhase(state, args.phase);
    if (phaseRefusal) throw new CliValidationError("invalid_input", phaseRefusal.message);
    const resolvedRelated = args.relatedTickets.length > 0
      ? validateAndResolveRelatedTickets(args.relatedTickets, state)
      : [];
    // ISS-1203 default, ISS-1221 contract: undefined means infer; an explicit
    // null was resolved by a preparer and is written as is. See inferIssuePhase.
    const effectivePhase = args.phase !== undefined ? args.phase : await inferIssuePhase(state, resolvedRelated, root);

    createdInState = state;
    const isTeam = state.config.team?.enabled === true;
    let id: string;
    let displayId: string | undefined;
    if (isTeam) {
      const alloc = allocateTeamIssueId(state.issues);
      id = alloc.id;
      displayId = state.config.team?.idAllocator === "git-refs"
        ? (await reserveDisplayId(root, "issue", state, id)).displayId
        : alloc.displayId;
    } else {
      id = nextIssueID(state.issues);
      displayId = undefined;
    }
    const createdAt = new Date().toISOString();
    const issue: Issue = {
      id,
      ...(displayId != null && { displayId }),
      title: args.title,
      status: "open",
      severity: args.severity as IssueSeverity,
      components: args.components,
      impact: args.impact,
      resolution: null,
      location: args.location,
      ...(sourceRefs && sourceRefs.length > 0 ? { sourceRefs } : {}),
      ...(args.dedupeKey ? { dedupeKey: args.dedupeKey } : {}),
      discoveredDate: createdAt.slice(0, 10),
      ...(isTeam && { createdAt }),
      ...(args.createdBy ? { createdBy: args.createdBy } : {}),
      resolvedDate: null,
      relatedTickets: resolvedRelated,
      phase: effectivePhase,
      ...(citesRulingsResolution.citesRulings !== undefined && citesRulingsResolution.citesRulings.length > 0
        && { citesRulings: citesRulingsResolution.citesRulings }),
      // ISS-1113: written ONLY when supplied. A create that says nothing about
      // either must produce the record it produced before this field existed,
      // so neither key appears rather than appearing as null or {}.
      ...(args.disposition !== undefined && { disposition: args.disposition as IssueDisposition }),
      ...(args.metadata !== undefined && { metadata: args.metadata }),
    };

    validatePostWriteIssueState(issue, state, true);
    await writeIssueUnlocked(issue, root, { createOnly: true });
    createdIssue = issue;
  });

  if (!createdIssue) throw new Error("Issue not created");
  const branchWarning = !deduplicated && createdInState
    ? checkBranchAllocationWarning(root, "issue", createdInState, displayIdOf(createdIssue))
    : null;
  const warnings = branchWarning ? [branchWarning] : undefined;
  if (format === "json") {
    const envelope = successEnvelope(issueJsonBody(createdIssue)) as unknown as Record<string, unknown>;
    return {
      output: JSON.stringify(
        deduplicated ? { ...envelope, meta: { deduplicated: true } } : envelope,
        null,
        2,
      ),
      ...(warnings && { warnings }),
    };
  }
  if (deduplicated) {
    return { output: `Issue ${displayIdOf(createdIssue)} already exists for dedupe key ${args.dedupeKey}.` };
  }
  return { output: `Created issue ${displayIdOf(createdIssue)}: ${createdIssue.title}`, ...(warnings && { warnings }) };
}

export async function handleIssueUpdate(
  id: string,
  updates: {
    status?: string;
    title?: string;
    severity?: string;
    impact?: string;
    resolution?: string | null;
    components?: string[];
    relatedTickets?: string[];
    location?: string[];
    sourceRefs?: IssueSourceRefInput[];
    order?: number;
    phase?: string | null;
    citesRuling?: string[];
    clearCitesRulings?: boolean;
  },
  format: string,
  root: string,
  opts?: { clearEarmarkForSession?: string },
): Promise<CommandResult> {
  assertUpdateHasFields(
    updates,
    "issue",
    "status, title, severity, impact, resolution, components, relatedTickets, location, sourceRefs, order, phase, citesRuling, clearCitesRulings",
  );
  // ISS-1192: same round-trip-growth fix as ticket.ts's description -- an
  // agent that reads the md-rendered impact back and writes it verbatim
  // carries the render fence into storage. Shared by CLI and MCP.
  let impactFenceStripped = false;
  if (updates.impact !== undefined) {
    const stripped = stripRenderFence(updates.impact);
    updates.impact = stripped.text;
    impactFenceStripped = stripped.stripped;
  }
  if (updates.status && !ISSUE_STATUSES.includes(updates.status as IssueStatus)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown issue status "${updates.status}": must be one of ${ISSUE_STATUSES.join(", ")}`,
    );
  }
  if (updates.severity && !ISSUE_SEVERITIES.includes(updates.severity as IssueSeverity)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown issue severity "${updates.severity}": must be one of ${ISSUE_SEVERITIES.join(", ")}`,
    );
  }
  const citesRulingsResolution = resolveCitesRulingsInput(updates.citesRuling, updates.clearCitesRulings);
  if (!citesRulingsResolution.ok) {
    throw new CliValidationError("invalid_input", citesRulingsResolution.message);
  }

  let updatedIssue: Issue | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    let resolvedId: string;
    try {
      resolvedId = resolveAndNormalizeIssueRef(state, id);
    } catch (err) {
      rethrowIssueResolutionError(err, `Issue ${id} not found`);
    }
    const existing = state.issueByID(resolvedId);
    if (!existing) {
      throw new CliValidationError("not_found", `Issue ${id} not found`);
    }

    let sourceRefs;
    try {
      sourceRefs = updates.sourceRefs
        ? await normalizeIssueSourceRefs(root, updates.sourceRefs)
        : undefined;
    } catch (err) {
      if (err instanceof IssueSourceRefError) {
        throw new CliValidationError("invalid_input", err.message);
      }
      throw err;
    }

    if (updates.phase !== undefined && updates.phase !== null) {
      if (!state.roadmap.phases.some((p) => p.id === updates.phase)) {
        throw new CliValidationError("invalid_input", `Phase "${updates.phase}" not found in roadmap`);
      }
    }
    const resolvedRelated = updates.relatedTickets
      ? validateAndResolveRelatedTickets(updates.relatedTickets, state)
      : undefined;

    // Status transition with date management
    const statusChanges: Partial<Issue> = {};
    if (updates.status !== undefined && updates.status !== existing.status) {
      statusChanges.status = updates.status as IssueStatus;
      if (updates.status === "resolved" && existing.status !== "resolved") {
        statusChanges.resolvedDate = todayISO();
      } else if (updates.status !== "resolved" && existing.status === "resolved") {
        statusChanges.resolvedDate = null;
      }
    }

    let issue: Issue = {
      ...existing,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.severity !== undefined && { severity: updates.severity as IssueSeverity }),
      ...(updates.impact !== undefined && { impact: updates.impact }),
      ...(updates.resolution !== undefined && { resolution: updates.resolution }),
      ...(updates.components !== undefined && { components: updates.components }),
      ...(resolvedRelated !== undefined && { relatedTickets: resolvedRelated }),
      ...(updates.location !== undefined && { location: updates.location }),
      ...(sourceRefs !== undefined && { sourceRefs }),
      ...(updates.order !== undefined && { order: updates.order }),
      ...(updates.phase !== undefined && { phase: updates.phase }),
      ...(citesRulingsResolution.citesRulings !== undefined && { citesRulings: citesRulingsResolution.citesRulings }),
      ...statusChanges,
    };

    if (opts?.clearEarmarkForSession) {
      const { item: next } = clearSameSessionEarmark(issue, opts.clearEarmarkForSession);
      issue = next;
    }

    validatePostWriteIssueState(issue, state, false);
    await writeIssueUnlocked(issue, root);
    updatedIssue = issue;
  });

  if (!updatedIssue) throw new Error("Issue not updated");
  const warnings = impactFenceStripped
    ? ["outer render fence removed; use --format json for round trips"]
    : undefined;
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(issueJsonBody(updatedIssue)), null, 2), ...(warnings && { warnings }) };
  }
  return { output: `Updated issue ${displayIdOf(updatedIssue)}: ${updatedIssue.title}`, ...(warnings && { warnings }) };
}

export async function handleIssueMetaSet(
  id: string,
  path: string,
  value: unknown,
  format: string,
  root: string,
): Promise<CommandResult> {
  let updatedIssue: Issue | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    let resolvedId: string;
    try {
      resolvedId = resolveAndNormalizeIssueRef(state, id);
    } catch (err) {
      rethrowIssueResolutionError(err, `Issue ${id} not found`);
    }
    const existing = state.issueByID(resolvedId);
    if (!existing) {
      throw new CliValidationError("not_found", `Issue ${id} not found`);
    }
    const issue = setMetadata(
      existing as Record<string, unknown>,
      path,
      value,
      ISSUE_CORE_METADATA_KEYS,
    ) as Issue;
    validatePostWriteIssueState(issue, state, false);
    await writeIssueUnlocked(issue, root);
    updatedIssue = issue;
  });

  if (!updatedIssue) throw new Error("Issue metadata not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(issueJsonBody(updatedIssue)), null, 2) };
  }
  return { output: `Updated metadata ${path} on issue ${displayIdOf(updatedIssue)}` };
}

export async function handleIssueMetaUnset(
  id: string,
  path: string,
  format: string,
  root: string,
): Promise<CommandResult> {
  let updatedIssue: Issue | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    let resolvedId: string;
    try {
      resolvedId = resolveAndNormalizeIssueRef(state, id);
    } catch (err) {
      rethrowIssueResolutionError(err, `Issue ${id} not found`);
    }
    const existing = state.issueByID(resolvedId);
    if (!existing) {
      throw new CliValidationError("not_found", `Issue ${id} not found`);
    }
    const issue = unsetMetadata(
      existing as Record<string, unknown>,
      path,
      ISSUE_CORE_METADATA_KEYS,
    ) as Issue;
    validatePostWriteIssueState(issue, state, false);
    await writeIssueUnlocked(issue, root);
    updatedIssue = issue;
  });

  if (!updatedIssue) throw new Error("Issue metadata not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(issueJsonBody(updatedIssue)), null, 2) };
  }
  return { output: `Unset metadata ${path} on issue ${displayIdOf(updatedIssue)}` };
}

export async function handleIssueDelete(
  id: string,
  format: string,
  root: string,
  hard?: boolean,
  displayLabel?: string,
): Promise<CommandResult> {
  const result = await deleteIssue(id, root, { hard });
  // ISS-757: team-mode re-delete of a tombstoned issue is a silent success
  // (exit 0) that preserves the existing tombstone; surface it distinctly.
  if (result.alreadyDeleted) {
    if (format === "json") {
      return { output: JSON.stringify(successEnvelope({ id, deleted: true, alreadyDeleted: true }), null, 2) };
    }
    return { output: `Issue ${displayLabel ?? id} is already deleted; existing tombstone preserved.` };
  }
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ id, deleted: true }), null, 2) };
  }
  return { output: `Deleted issue ${displayLabel ?? id}.` };
}
