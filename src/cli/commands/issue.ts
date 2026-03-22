import { validateProject } from "../../core/validation.js";
import { ProjectState } from "../../core/project-state.js";
import {
  withProjectLock,
  writeIssueUnlocked,
  deleteIssue,
} from "../../core/project-loader.js";
import { nextIssueID } from "../../core/id-allocation.js";
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
import type { Issue } from "../../models/issue.js";
import {
  todayISO,
  normalizeArrayOption,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

// Re-export for register.ts
export { ISSUE_STATUSES, ISSUE_SEVERITIES };

// --- Read Handlers ---

export function handleIssueList(
  filters: { status?: string; severity?: string; component?: string },
  ctx: CommandContext,
): CommandResult {
  let issues = [...ctx.state.issues];

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

  return { output: formatIssueList(issues, ctx.format) };
}

export function handleIssueGet(
  id: string,
  ctx: CommandContext,
): CommandResult {
  const issue = ctx.state.issueByID(id);
  if (!issue) {
    return {
      output: formatError("not_found", `Issue ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatIssue(issue, ctx.format) };
}

// --- Write Handlers ---

function validateRelatedTickets(ids: string[], state: ProjectState): void {
  for (const tid of ids) {
    if (!state.ticketByID(tid)) {
      throw new CliValidationError("invalid_input", `Related ticket ${tid} not found`);
    }
  }
}

function validatePostWriteIssueState(
  candidate: Issue,
  state: ProjectState,
  isCreate: boolean,
): void {
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
  const result = validateProject(postState);
  if (!result.valid) {
    const errors = result.findings.filter((f) => f.level === "error");
    const msg = errors.map((f) => f.message).join("; ");
    throw new CliValidationError("validation_failed", `Write would create invalid state: ${msg}`);
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

  let createdIssue: Issue | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    if (args.relatedTickets.length > 0) {
      validateRelatedTickets(args.relatedTickets, state);
    }

    const id = nextIssueID(state.issues);
    const issue: Issue = {
      id,
      title: args.title,
      status: "open",
      severity: args.severity as IssueSeverity,
      components: args.components,
      impact: args.impact,
      resolution: null,
      location: args.location,
      discoveredDate: todayISO(),
      resolvedDate: null,
      relatedTickets: args.relatedTickets,
      phase: args.phase ?? null,
    };

    validatePostWriteIssueState(issue, state, true);
    await writeIssueUnlocked(issue, root);
    createdIssue = issue;
  });

  if (!createdIssue) throw new Error("Issue not created");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(createdIssue), null, 2) };
  }
  return { output: `Created issue ${createdIssue.id}: ${createdIssue.title}` };
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
    const existing = state.issueByID(id);
    if (!existing) {
      throw new CliValidationError("not_found", `Issue ${id} not found`);
    }

    if (updates.relatedTickets) {
      validateRelatedTickets(updates.relatedTickets, state);
    }

    // Merge updates
    const issue: Issue = { ...existing };
    if (updates.title !== undefined) (issue as Record<string, unknown>).title = updates.title;
    if (updates.severity !== undefined) (issue as Record<string, unknown>).severity = updates.severity;
    if (updates.impact !== undefined) (issue as Record<string, unknown>).impact = updates.impact;
    if (updates.resolution !== undefined) (issue as Record<string, unknown>).resolution = updates.resolution;
    if (updates.components !== undefined) (issue as Record<string, unknown>).components = updates.components;
    if (updates.relatedTickets !== undefined) (issue as Record<string, unknown>).relatedTickets = updates.relatedTickets;
    if (updates.location !== undefined) (issue as Record<string, unknown>).location = updates.location;

    // Status transition with date management
    if (updates.status !== undefined && updates.status !== existing.status) {
      (issue as Record<string, unknown>).status = updates.status;
      if (updates.status === "resolved" && existing.status !== "resolved") {
        (issue as Record<string, unknown>).resolvedDate = todayISO();
      } else if (updates.status !== "resolved" && existing.status === "resolved") {
        (issue as Record<string, unknown>).resolvedDate = null;
      }
    }

    validatePostWriteIssueState(issue, state, false);
    await writeIssueUnlocked(issue, root);
    updatedIssue = issue;
  });

  if (!updatedIssue) throw new Error("Issue not updated");
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope(updatedIssue), null, 2) };
  }
  return { output: `Updated issue ${updatedIssue.id}: ${updatedIssue.title}` };
}

export async function handleIssueDelete(
  id: string,
  format: string,
  root: string,
): Promise<CommandResult> {
  await deleteIssue(id, root);
  if (format === "json") {
    return { output: JSON.stringify(successEnvelope({ id, deleted: true }), null, 2) };
  }
  return { output: `Deleted issue ${id}.` };
}
