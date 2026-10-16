/**
 * T-486 U3: the core of `storybloq triage`, the bulk disposition surface.
 *
 * Everything here runs on the one state the triage lock hands its callback
 * (project-loader.ts `withProjectLockForIssueTriage`): selection, the
 * classification of each matched issue, and the rendering of the full set.
 * A dry run and an apply compute the set the same way, so what a run prints
 * is what that run writes.
 */
import { Worker } from "node:worker_threads";
import type { Issue } from "../models/issue.js";
import type { ProjectState } from "./project-state.js";
import { isDeleted } from "./project-state.js";
import { triageEarmarkHold } from "./earmarks.js";
import { effectiveResolutionKind } from "./resolution-kind.js";
import { displayIdOf } from "./resolver.js";
import { escapeMarkdownInline, successEnvelope } from "./output-formatter.js";
import { CliValidationError } from "../cli/helpers.js";

/** More writable matches than this needs --force (R0-3). */
export const TRIAGE_CAP = 50;
/** A pattern longer than this is refused before the lock. */
export const TRIAGE_PATTERN_MAX = 256;
/** Each title or resolution is matched on at most this many characters. */
export const TRIAGE_TEXT_MAX = 4096;
/** The matching worker is terminated after this long. */
export const TRIAGE_REGEX_DEADLINE_MS = 2000;
/** Patterns are matched case-insensitively. */
export const TRIAGE_PATTERN_FLAGS = "i";

export interface TriageSelectors {
  olderThan?: number;
  severity?: readonly string[];
  component?: readonly string[];
  status: readonly string[];
  orphan?: boolean;
  unphased?: boolean;
  /** A disposition value, or "none" for an issue without one. */
  disposition?: string;
  titleMatches?: string;
  resolutionMatches?: string;
  /** Canonical ids, already resolved and de-duplicated. */
  ids?: ReadonlySet<string>;
}

export type TriageAction =
  | { kind: "resolve"; reason: string; resolutionKind: string }
  | { kind: "set-disposition"; disposition: string | null; reason?: string; ref?: string }
  | { kind: "relate"; ticket: string }
  | { kind: "set-phase"; phase: string | null }
  | { kind: "set-resolution-kind"; resolutionKind: string };

export interface TriageEntry {
  id: string;
  displayId: string;
  ageDays: number;
  severity: string;
  title: string;
  reason?: string;
}

export interface TriageTruncation {
  id: string;
  displayId: string;
  field: "title" | "resolution";
}

export interface TriagePlan {
  writable: TriageEntry[];
  protected: TriageEntry[];
  notApplicable: TriageEntry[];
  truncatedInputs: TriageTruncation[];
  /** The writable issues themselves, for the apply path. */
  writableIssues: Issue[];
}

/**
 * Whole days from `discovered` to `today`, both YYYY-MM-DD. `today` is the
 * local date `todayISO` returns, the clock every issue date is written with;
 * the day count is recommend.ts's floor over 86,400,000 ms, taken between UTC
 * midnights so a daylight-saving change cannot move it.
 */
export function triageAgeDays(discovered: string, today: string): number {
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${discovered}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

type Predicate = (issue: Issue) => boolean;

function selectorPredicates(selectors: TriageSelectors, today: string): Predicate[] {
  const predicates: Predicate[] = [(i) => selectors.status.includes(i.status)];
  if (selectors.olderThan !== undefined) {
    const days = selectors.olderThan;
    predicates.push((i) => triageAgeDays(i.discoveredDate, today) > days);
  }
  if (selectors.severity) {
    const severity = selectors.severity;
    predicates.push((i) => severity.includes(i.severity));
  }
  if (selectors.component) {
    const component = selectors.component;
    predicates.push((i) => i.components.some((c) => component.includes(c)));
  }
  if (selectors.orphan) predicates.push((i) => i.relatedTickets.length === 0);
  if (selectors.unphased) predicates.push((i) => i.phase == null);
  if (selectors.disposition !== undefined) {
    const want = selectors.disposition;
    predicates.push((i) => (want === "none" ? i.disposition === undefined : i.disposition === want));
  }
  if (selectors.ids) {
    const ids = selectors.ids;
    predicates.push((i) => ids.has(i.id));
  }
  return predicates;
}

/**
 * The matching worker. A fixed constant: the pattern, its flags and the texts
 * reach it only through workerData, so no input is ever part of the source.
 */
const REGEX_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.pattern, workerData.flags);
const hits = [];
for (const [id, text] of workerData.texts) {
  if (re.test(text)) hits.push(id);
}
parentPort.postMessage(hits);
`;

/**
 * Matches `pattern` against each text off the main thread. A pattern that
 * does not finish inside the deadline terminates the worker and refuses the
 * run; nothing has been written at that point.
 */
export function matchInWorker(
  pattern: string,
  texts: ReadonlyArray<readonly [string, string]>,
  deadlineMs: number = TRIAGE_REGEX_DEADLINE_MS,
): Promise<Set<string>> {
  if (texts.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags: TRIAGE_PATTERN_FLAGS, texts },
    });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new CliValidationError("invalid_input", `--title-matches/--resolution-matches pattern exceeded the ${deadlineMs} ms matching deadline; simplify it`)));
    }, deadlineMs);
    worker.once("message", (hits: string[]) => settle(() => resolve(new Set(hits))));
    worker.once("error", (err) => settle(() => reject(err)));
    worker.once("exit", (code) => settle(() => reject(new Error(`pattern worker exited with code ${code} before answering`))));
  });
}

/** Refuses a pattern that is too long or does not compile. */
export function assertTriagePattern(flag: string, pattern: string): void {
  if (pattern.length > TRIAGE_PATTERN_MAX) {
    throw new CliValidationError("invalid_input", `${flag} is ${pattern.length} characters; the limit is ${TRIAGE_PATTERN_MAX}`);
  }
  try {
    new RegExp(pattern, TRIAGE_PATTERN_FLAGS);
  } catch (err) {
    throw new CliValidationError("invalid_input", `${flag} does not compile: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Why triage never writes this issue, or null. `--force` does not override. */
export function triageProtection(issue: Issue): string | null {
  if (isDeleted(issue)) return "deleted";
  const conflicts = (issue as Record<string, unknown>)._conflicts;
  if (Array.isArray(conflicts) && conflicts.length > 0) return "has unresolved merge conflicts";
  if (triageEarmarkHold(issue)) return `earmarked (${issue.earmark!.stage})`;
  if (issue.status === "inprogress") return "in progress";
  return null;
}

/** Why the action has no effect or is illegal for this issue, or null. */
export function triageNotApplicable(issue: Issue, action: TriageAction | null): string | null {
  if (!action) return null;
  switch (action.kind) {
    case "resolve":
      return issue.status === "resolved" ? "already resolved" : null;
    case "set-resolution-kind":
      if (issue.status !== "resolved") return `not resolved (${issue.status})`;
      return effectiveResolutionKind(issue as unknown as Record<string, unknown>) === action.resolutionKind
        ? `resolution kind is already ${action.resolutionKind}`
        : null;
    case "relate":
      return issue.relatedTickets.includes(action.ticket) ? `already related to ${action.ticket}` : null;
    case "set-phase":
      return (issue.phase ?? null) === action.phase ? `already in phase ${action.phase ?? "none"}` : null;
    case "set-disposition": {
      const record = issue as Record<string, unknown>;
      if (action.disposition === null) {
        const keys = ["disposition", "dispositionReason", "dispositionRef", "dispositionFor"];
        return keys.some((k) => record[k] !== undefined) ? null : "has no disposition";
      }
      return record.disposition === action.disposition &&
        record.dispositionReason === action.reason &&
        record.dispositionRef === action.ref
        ? `disposition is already ${action.disposition} with this reason and ref`
        : null;
    }
  }
}

function entryOf(issue: Issue, today: string, reason?: string): TriageEntry {
  return {
    id: issue.id,
    displayId: displayIdOf(issue),
    ageDays: triageAgeDays(issue.discoveredDate, today),
    severity: issue.severity,
    title: issue.title,
    ...(reason !== undefined && { reason }),
  };
}

function byDisplayId(a: Issue, b: Issue): number {
  return displayIdOf(a).localeCompare(displayIdOf(b), "en", { numeric: true });
}

/**
 * Selects and classifies issues from one locked state. The non-pattern
 * selectors run first; each pattern then runs once, in the worker, over the
 * issues that passed them.
 */
export async function planTriage(
  state: ProjectState,
  selectors: TriageSelectors,
  action: TriageAction | null,
  today: string,
): Promise<TriagePlan> {
  const predicates = selectorPredicates(selectors, today);
  let matched = state.issues.filter((i) => predicates.every((p) => p(i)));
  const truncatedInputs: TriageTruncation[] = [];

  const patterns: Array<{ field: "title" | "resolution"; pattern: string }> = [];
  if (selectors.titleMatches !== undefined) patterns.push({ field: "title", pattern: selectors.titleMatches });
  if (selectors.resolutionMatches !== undefined) patterns.push({ field: "resolution", pattern: selectors.resolutionMatches });
  for (const { field, pattern } of patterns) {
    const texts: Array<[string, string]> = [];
    for (const issue of matched) {
      const text = issue[field] ?? "";
      if (text.length > TRIAGE_TEXT_MAX) truncatedInputs.push({ id: issue.id, displayId: displayIdOf(issue), field });
      texts.push([issue.id, text.slice(0, TRIAGE_TEXT_MAX)]);
    }
    const hits = await matchInWorker(pattern, texts);
    matched = matched.filter((i) => hits.has(i.id));
  }

  const plan: TriagePlan = { writable: [], protected: [], notApplicable: [], truncatedInputs, writableIssues: [] };
  for (const issue of [...matched].sort(byDisplayId)) {
    const protection = triageProtection(issue);
    if (protection) {
      plan.protected.push(entryOf(issue, today, protection));
      continue;
    }
    const notApplicable = triageNotApplicable(issue, action);
    if (notApplicable) {
      plan.notApplicable.push(entryOf(issue, today, notApplicable));
      continue;
    }
    plan.writable.push(entryOf(issue, today));
    plan.writableIssues.push(issue);
  }
  return plan;
}

/** True when an apply of this plan is over the cap and not forced. */
export function triageOverCap(plan: TriagePlan, force: boolean): boolean {
  return plan.writable.length > TRIAGE_CAP && !force;
}

export type TriageApplied = "all" | "none" | "recovery-pending";

function describeAction(action: TriageAction | null): string {
  if (!action) return "report only";
  switch (action.kind) {
    case "resolve":
      return `resolve as ${action.resolutionKind}: ${action.reason}`;
    case "set-disposition":
      return action.disposition === null ? "clear the disposition" : `set disposition ${action.disposition} (${action.ref}): ${action.reason}`;
    case "relate":
      return `relate to ${action.ticket}`;
    case "set-phase":
      return `set phase ${action.phase ?? "none"}`;
    case "set-resolution-kind":
      return `set resolution kind ${action.resolutionKind}`;
  }
}

function entryLine(e: TriageEntry): string {
  const reason = e.reason ? ` (${escapeMarkdownInline(e.reason)})` : "";
  return `- ${e.displayId}  ${e.ageDays}d  ${e.severity}  ${escapeMarkdownInline(e.title)}${reason}`;
}

/** Renders the whole matched set, never a summary of it. */
export function formatTriagePlan(
  plan: TriagePlan,
  action: TriageAction | null,
  applied: TriageApplied,
  dryRun: boolean,
  format: "json" | "md",
): string {
  const { writableIssues: _issues, truncatedInputs, ...lists } = plan;
  if (format === "json") {
    return JSON.stringify(successEnvelope({
      action,
      applied,
      ...lists,
      ...(truncatedInputs.length > 0 && { truncatedInputs }),
    }), null, 2);
  }
  const matched = plan.writable.length + plan.protected.length + plan.notApplicable.length;
  const lines = [
    `Triage${dryRun ? " (dry run)" : ""}: ${matched} matched; ${plan.writable.length} writable, ${plan.protected.length} protected, ${plan.notApplicable.length} not applicable.`,
    `Action: ${escapeMarkdownInline(describeAction(action))}.`,
  ];
  if (dryRun) lines.push("This set is computed now; --apply computes it again under the lock and writes that set.");
  const section = (title: string, entries: TriageEntry[]): void => {
    lines.push("", `${title} (${entries.length}):`);
    lines.push(...(entries.length > 0 ? entries.map(entryLine) : ["- none"]));
  };
  section("Writable", plan.writable);
  section("Protected", plan.protected);
  section("Not applicable", plan.notApplicable);
  if (truncatedInputs.length > 0) {
    lines.push("", `Matched on the first ${TRIAGE_TEXT_MAX} characters only:`);
    lines.push(...truncatedInputs.map((t) => `- ${t.displayId} ${t.field}`));
  }
  return lines.join("\n");
}
