import { displayIdOf } from "../../core/resolver.js";
import { validateProject } from "../../core/validation.js";
import { resolveAndNormalizeTicketRef, resolveAndNormalizeIssueRef, RefResolutionError } from "../../core/ref-normalization.js";
import { ProjectState } from "../../core/project-state.js";
import {
  withProjectLock,
  writeIssueUnlocked,
  deleteIssue,
} from "../../core/project-loader.js";
import { nextIssueID, allocateTeamIssueId } from "../../core/id-allocation.js";
import { reserveDisplayId } from "../../core/remote-refs.js";
import {
  formatIssueList,
  formatIssue,
  formatError,
  successEnvelope,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  ISSUE_STATUSES,
  ISSUE_SEVERITIES,
  type IssueStatus,
  type IssueSeverity,
} from "../../models/types.js";
import {
  IssueDedupeKeySchema,
  type Issue,
  type IssueSourceRefInput,
} from "../../models/issue.js";
import {
  IssueSourceRefError,
  normalizeIssueSourceRefs,
} from "../../core/issue-source-ref.js";
import {
  todayISO,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";
import {
  formatMetadataValue,
  getMetadata,
  setMetadata,
  unsetMetadata,
} from "./metadata.js";

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
  filters: { status?: string; severity?: string; component?: string; phase?: string },
  ctx: CommandContext,
): CommandResult {
  let issues = [...ctx.state.activeIssues];

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

  return { output: formatIssueList(issues, ctx.format) };
}

export function handleIssueGet(
  id: string,
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
  return { output: formatIssue(result.item, ctx.format, ctx.state) };
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
  args: {
    title: string;
    severity: string;
    impact: string;
    components: string[];
    relatedTickets: string[];
    location: string[];
    sourceRefs?: IssueSourceRefInput[];
    dedupeKey?: string;
    createdBy?: string;
    phase?: string;
  },
  format: string,
  root: string,
): Promise<CommandResult> {
  if (!ISSUE_SEVERITIES.includes(args.severity as IssueSeverity)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown issue severity "${args.severity}": must be one of ${ISSUE_SEVERITIES.join(", ")}`,
    );
  }

  const dedupeResult = args.dedupeKey === undefined
    ? null
    : IssueDedupeKeySchema.safeParse(args.dedupeKey);
  if (dedupeResult && !dedupeResult.success) {
    throw new CliValidationError(
      "invalid_input",
      dedupeResult.error.issues.map((issue) => issue.message).join("; "),
    );
  }

  let createdIssue: Issue | undefined;
  let deduplicated = false;

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

    if (args.phase && !state.roadmap.phases.some((p) => p.id === args.phase)) {
      throw new CliValidationError("invalid_input", `Phase "${args.phase}" not found in roadmap`);
    }
    const resolvedRelated = args.relatedTickets.length > 0
      ? validateAndResolveRelatedTickets(args.relatedTickets, state)
      : [];

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
      phase: args.phase ?? null,
    };

    validatePostWriteIssueState(issue, state, true);
    await writeIssueUnlocked(issue, root, { createOnly: true });
    createdIssue = issue;
  });

  if (!createdIssue) throw new Error("Issue not created");
  if (format === "json") {
    const envelope = successEnvelope(createdIssue) as unknown as Record<string, unknown>;
    return {
      output: JSON.stringify(
        deduplicated ? { ...envelope, meta: { deduplicated: true } } : envelope,
        null,
        2,
      ),
    };
  }
  if (deduplicated) {
    return { output: `Issue ${displayIdOf(createdIssue)} already exists for dedupe key ${args.dedupeKey}.` };
  }
  return { output: `Created issue ${displayIdOf(createdIssue)}: ${createdIssue.title}` };
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
  },
  format: string,
  root: string,
): Promise<CommandResult> {
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

    const issue: Issue = {
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
      ...statusChanges,
    };

    validatePostWriteIssueState(issue, state, false);
    await writeIssueUnlocked(issue, root);
    updatedIssue = issue;
  });

  if (!updatedIssue) throw new Error("Issue not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedIssue), null, 2) };
  }
  return { output: `Updated issue ${displayIdOf(updatedIssue)}: ${updatedIssue.title}` };
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
    return { output: JSON.stringify(successEnvelope(updatedIssue), null, 2) };
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
    return { output: JSON.stringify(successEnvelope(updatedIssue), null, 2) };
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
