/**
 * T-486 U3: `storybloq triage`. Selects issues by a conjunction of selectors,
 * classifies every match under one lock, and prints the whole set. Every
 * refusal that needs no state is raised before the lock, so a refused run
 * takes no lock and writes nothing.
 */
import { withProjectLockForIssueTriage } from "../../core/project-loader.js";
import type { ProjectState } from "../../core/project-state.js";
import { isDeleted } from "../../core/project-state.js";
import { resolveAndNormalizeIssueRef, RefResolutionError } from "../../core/ref-normalization.js";
import {
  assertTriagePattern,
  formatTriagePlan,
  planTriage,
  type TriageAction,
  type TriagePlan,
  type TriageSelectors,
} from "../../core/triage.js";
import { ISSUE_RESOLUTION_KINDS } from "../../core/resolution-kind.js";
import { ISSUE_DISPOSITIONS } from "../../models/issue.js";
import { ISSUE_SEVERITIES, ISSUE_STATUSES } from "../../models/types.js";
import { CliValidationError, todayISO } from "../helpers.js";
import type { CommandResult } from "../types.js";
import { assertDispositionInput, resolveDispositionRef, validateAndResolveRelatedTickets } from "./issue.js";

/** The command's flags, as the parser hands them over. */
export interface TriageFlags {
  olderThan?: number;
  severity?: string[];
  component?: string[];
  status?: string[];
  orphan?: boolean;
  unphased?: boolean;
  disposition?: string;
  titleMatches?: string;
  resolutionMatches?: string;
  ids?: string[];
  resolve?: boolean;
  reason?: string;
  kind?: string;
  setDisposition?: string;
  ref?: string;
  relate?: string;
  setPhase?: string;
  setResolutionKind?: string;
}

/** Bulk resolve records one of these; fixed and duplicate are per issue. */
const BULK_RESOLVE_KINDS = ["wontfix", "superseded", "not_reproducible"] as const;

function refuse(message: string): never {
  throw new CliValidationError("invalid_input", message);
}

function assertValues(flag: string, values: readonly string[] | undefined, allowed: readonly string[]): void {
  for (const v of values ?? []) {
    if (!allowed.includes(v)) refuse(`Unknown ${flag} "${v}": must be one of ${allowed.join(", ")}`);
  }
}

/** The selectors, checked before the lock. `--ids` is resolved under it. */
function parseSelectors(flags: TriageFlags): Omit<TriageSelectors, "ids"> {
  const given = [
    flags.olderThan !== undefined,
    flags.severity !== undefined,
    flags.component !== undefined,
    flags.status !== undefined,
    flags.orphan === true,
    flags.unphased === true,
    flags.disposition !== undefined,
    flags.titleMatches !== undefined,
    flags.resolutionMatches !== undefined,
    flags.ids !== undefined,
  ];
  if (!given.some(Boolean)) {
    refuse("triage needs at least one selector (--older-than, --severity, --component, --status, --orphan, --unphased, --disposition, --title-matches, --resolution-matches or --ids)");
  }
  if (flags.olderThan !== undefined && (!Number.isInteger(flags.olderThan) || flags.olderThan < 0)) {
    refuse(`--older-than takes a whole number of days, not "${flags.olderThan}"`);
  }
  assertValues("--severity", flags.severity, ISSUE_SEVERITIES);
  assertValues("--status", flags.status, ISSUE_STATUSES);
  if (flags.disposition !== undefined) assertValues("--disposition", [flags.disposition], [...ISSUE_DISPOSITIONS, "none"]);
  if (flags.titleMatches !== undefined) assertTriagePattern("--title-matches", flags.titleMatches);
  if (flags.resolutionMatches !== undefined) assertTriagePattern("--resolution-matches", flags.resolutionMatches);
  if (flags.ids !== undefined && flags.ids.length === 0) refuse("--ids needs at least one id");
  return {
    status: flags.status ?? ["open"],
    ...(flags.olderThan !== undefined && { olderThan: flags.olderThan }),
    ...(flags.severity !== undefined && { severity: flags.severity }),
    ...(flags.component !== undefined && { component: flags.component }),
    ...(flags.orphan === true && { orphan: true }),
    ...(flags.unphased === true && { unphased: true }),
    ...(flags.disposition !== undefined && { disposition: flags.disposition }),
    ...(flags.titleMatches !== undefined && { titleMatches: flags.titleMatches }),
    ...(flags.resolutionMatches !== undefined && { resolutionMatches: flags.resolutionMatches }),
  };
}

/** The one action, checked before the lock. References are resolved under it. */
function parseAction(flags: TriageFlags): TriageAction | null {
  const chosen = [
    flags.resolve === true ? "--resolve" : null,
    flags.setDisposition !== undefined ? "--set-disposition" : null,
    flags.relate !== undefined ? "--relate" : null,
    flags.setPhase !== undefined ? "--set-phase" : null,
    flags.setResolutionKind !== undefined ? "--set-resolution-kind" : null,
  ].filter((a): a is string => a !== null);
  if (chosen.length > 1) refuse(`triage takes one action per run; got ${chosen.join(" and ")}`);
  const action = chosen[0];
  if (flags.kind !== undefined && action !== "--resolve") refuse("--kind goes with --resolve");
  if (flags.ref !== undefined && action !== "--set-disposition") refuse("--ref goes with --set-disposition");
  if (flags.reason !== undefined && action !== "--resolve" && action !== "--set-disposition") {
    refuse("--reason goes with --resolve or --set-disposition");
  }
  switch (action) {
    case undefined:
      return null;
    case "--resolve": {
      if (flags.reason === undefined || flags.reason.trim() === "") {
        refuse("--resolve needs --reason: a bulk resolve records why on every issue it closes");
      }
      const kind = flags.kind ?? "wontfix";
      if (!(BULK_RESOLVE_KINDS as readonly string[]).includes(kind)) {
        refuse(`--kind ${kind} is not a bulk resolution: use ${BULK_RESOLVE_KINDS.join(", ")}; fixed and duplicate are set one issue at a time with issue update`);
      }
      return { kind: "resolve", reason: flags.reason, resolutionKind: kind };
    }
    case "--set-disposition": {
      const value = flags.setDisposition!;
      if (value === "duplicate") {
        refuse("--set-disposition duplicate names a target per issue; set it one issue at a time with issue update --disposition duplicate --duplicate-of");
      }
      const disposition = value === "none" ? null : value;
      assertDispositionInput({ disposition, dispositionReason: flags.reason, dispositionRef: flags.ref });
      return disposition === null
        ? { kind: "set-disposition", disposition: null }
        : { kind: "set-disposition", disposition, reason: flags.reason!, ref: flags.ref! };
    }
    case "--relate":
      if (flags.relate!.trim() === "") refuse("--relate needs a ticket id");
      return { kind: "relate", ticket: flags.relate! };
    case "--set-phase":
      if (flags.setPhase!.trim() === "") refuse("--set-phase needs a phase id, or none");
      return { kind: "set-phase", phase: flags.setPhase === "none" ? null : flags.setPhase! };
    case "--set-resolution-kind": {
      const kind = flags.setResolutionKind!;
      if (!(ISSUE_RESOLUTION_KINDS as readonly string[]).includes(kind)) {
        refuse(`Unknown resolution kind "${kind}": must be one of ${ISSUE_RESOLUTION_KINDS.join(", ")}`);
      }
      if (kind === "duplicate") refuse("--set-resolution-kind duplicate names a target per issue; set it one issue at a time with issue update");
      return { kind: "set-resolution-kind", resolutionKind: kind };
    }
    default:
      throw new Error(`unhandled triage action ${action}`);
  }
}

/** Resolves every --ids entry; one that names no issue refuses the run. */
function resolveIds(state: ProjectState, ids: readonly string[]): Set<string> {
  const resolved = new Set<string>();
  for (const ref of ids) {
    try {
      resolved.add(resolveAndNormalizeIssueRef(state, ref));
    } catch (err) {
      if (err instanceof RefResolutionError && err.reason === "ambiguous") {
        throw new CliValidationError("invalid_input", `--ids ${ref} is ambiguous; use the canonical id`);
      }
      throw new CliValidationError("not_found", `--ids ${ref} names no issue`);
    }
  }
  return resolved;
}

/** Resolves the action's references against the locked state. */
function resolveActionRefs(state: ProjectState, root: string, action: TriageAction | null): TriageAction | null {
  if (!action) return null;
  switch (action.kind) {
    case "relate": {
      const [ticket] = validateAndResolveRelatedTickets([action.ticket], state);
      if (isDeleted(state.ticketByID(ticket!) ?? {})) refuse(`--relate ${action.ticket} is deleted`);
      return { ...action, ticket: ticket! };
    }
    case "set-phase":
      if (action.phase !== null && !state.roadmap.phases.some((p) => p.id === action.phase)) {
        throw new CliValidationError("not_found", `--set-phase ${action.phase} is not a phase in the roadmap`);
      }
      return action;
    case "set-disposition":
      return action.disposition === null ? action : { ...action, ref: resolveDispositionRef(state, root, action.ref!.trim()) };
    default:
      return action;
  }
}

export async function handleTriage(
  flags: TriageFlags,
  format: "json" | "md",
  root: string,
  opts: { today?: string } = {},
): Promise<CommandResult> {
  const selectors = parseSelectors(flags);
  const parsedAction = parseAction(flags);
  const today = opts.today ?? todayISO();

  let plan: TriagePlan | undefined;
  let action: TriageAction | null | undefined;
  await withProjectLockForIssueTriage(root, async ({ state }) => {
    const ids = flags.ids !== undefined ? resolveIds(state, flags.ids) : undefined;
    action = resolveActionRefs(state, root, parsedAction);
    plan = await planTriage(state, { ...selectors, ...(ids && { ids }) }, action, today);
  });
  if (!plan) throw new Error("triage computed no plan");
  return { output: formatTriagePlan(plan, action ?? null, "none", true, format) };
}
