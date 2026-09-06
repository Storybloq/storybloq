/**
 * T-432 section 4: the issue-flow line for `status` and `recap`.
 *
 *     Issues: 241 open (30d: +138 opened / -113 resolved, net +25)
 *
 * WHAT THIS IS NOT. It is not the change in the open backlog, and the difference
 * matters enough that the json carries it as an explicit `semantics` field. It
 * is a BALANCE OF RECORD DATES AMONG RETAINED ISSUE RECORDS:
 *
 *  - A single `resolvedDate` cannot represent a close-reopen-close cycle: the
 *    record keeps one date, so the second close is invisible to any window.
 *  - A deleted issue leaves no record at all, so whatever it contributed to a
 *    past window silently leaves every later reading of that same window.
 *
 * So the balance and the backlog can diverge, and the line says "opened" and
 * "resolved" rather than "grew" or "shrank". A nudge fired on this number is a
 * nudge about record dates.
 *
 * NO SCHEMA CHANGE and no new metering: every field read here is already
 * written, and the records are the ones the project load already parsed.
 */
import type { Issue } from "../models/issue.js";

export interface IssueFlow {
  /** `status !== "resolved"`, the existing `activeIssueCount` convention. */
  readonly open: number;
  readonly windowDays: number;
  readonly opened: number;
  readonly resolved: number;
  /** `opened - resolved`. A balance of record dates, not a backlog delta. */
  readonly net: number;
  /**
   * Records whose date is absent or unparseable. They fall OUTSIDE the window
   * rather than being assigned to it, and are printed beside the counts so the
   * window is never read as complete when it is not.
   */
  readonly missingDates: number;
  /**
   * DATE FIELDS after `now`, counting `discoveredDate` and `resolvedDate`
   * separately: one issue with both in the future increments this TWICE.
   *
   * Counted per field rather than per record because the anomaly is a date, and
   * a record can carry two of them. Named and documented as fields so a reader
   * cannot infer two anomalous records where there is one.
   */
  readonly futureDates: number;
  /**
   * Records carrying `resolvedDate` while not resolved, counted in the resolved
   * window and surfaced under this name.
   *
   * NOT CALLED "REOPENED". The field combination is what is observed; a reopen
   * is one explanation and an inconsistent or stale edit is another, and the
   * records cannot tell them apart.
   */
  readonly activeWithResolvedDate: number;
}

function parsed(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Compute the flow over already-loaded issue records.
 *
 * `now` is a parameter so the result is deterministic under test. Identity comes
 * from the record, never the filename: the ledger is permanently mixed, with
 * legacy `ISS-*.json` and hash `i-*.json` both present, and nothing here reads a
 * path at all.
 */
export function computeIssueFlow(
  issues: readonly Issue[],
  windowDays: number,
  now: Date,
): IssueFlow {
  const end = now.getTime();
  const cutoff = end - windowDays * 24 * 60 * 60 * 1000;
  // THE WINDOW IS CLOSED AT BOTH ENDS. With only a lower bound, a record dated
  // next year counts as activity "in the last 30 days" and moves the net
  // balance, which contradicts the semantics the json publishes beside it.
  const inWindow = (t: number): boolean => t >= cutoff && t <= end;

  let open = 0;
  let opened = 0;
  let resolved = 0;
  let missingDates = 0;
  let futureDates = 0;
  let activeWithResolvedDate = 0;

  for (const i of issues) {
    const isResolved = i.status === "resolved";
    if (!isResolved) open += 1;

    // `discoveredDate` is the opened signal: it is present on every record,
    // while `createdAt` is on about a third and would silently under-count.
    const discovered = parsed(i.discoveredDate);
    if (discovered === null) missingDates += 1;
    else {
      if (discovered > end) futureDates += 1;
      if (inWindow(discovered)) opened += 1;
    }

    const resolvedAt = parsed(i.resolvedDate);
    if (resolvedAt !== null) {
      if (!isResolved) activeWithResolvedDate += 1;
      if (resolvedAt > end) futureDates += 1;
      if (inWindow(resolvedAt)) resolved += 1;
    } else if (isResolved) {
      // Resolved with no usable date: it cannot be placed in a window, so it is
      // reported as a gap rather than dropped into the current one.
      missingDates += 1;
    }
  }

  return {
    open,
    windowDays,
    opened,
    resolved,
    net: opened - resolved,
    missingDates,
    futureDates,
    activeWithResolvedDate,
  };
}

/** The one-line form used by `status` and `recap`. */
export function formatIssueFlow(flow: IssueFlow): string {
  const sign = flow.net >= 0 ? "+" : "";
  const parts = [
    `Issues: ${flow.open} open (${flow.windowDays}d: +${flow.opened} opened / `
    + `-${flow.resolved} resolved, net ${sign}${flow.net})`,
  ];
  if (flow.missingDates > 0) parts.push(`${flow.missingDates} missing dates`);
  if (flow.futureDates > 0) parts.push(`${flow.futureDates} future date fields`);
  if (flow.activeWithResolvedDate > 0) {
    parts.push(`${flow.activeWithResolvedDate} activeWithResolvedDate`);
  }
  return parts.join(", ");
}

/** The `semantics` block the json carries beside the numbers. */
export const ISSUE_FLOW_SEMANTICS = {
  is: "balance of record dates among retained issue records",
  isNot: "change in the open backlog",
  why: "a single resolvedDate cannot represent a close-reopen-close cycle, and "
    + "deleted issues leave no record",
  opened: "discoveredDate within the window, which is closed at both ends",
  resolved: "resolvedDate within the window, which is closed at both ends",
  futureDates:
    "DATE FIELDS after now, counting discoveredDate and resolvedDate separately, "
    + "so one record with both in the future contributes two; outside the window "
    + "and reported, never counted as activity",
  open: "status !== resolved, matching activeIssueCount",
  activeWithResolvedDate:
    "records carrying resolvedDate while not resolved; the field combination is "
    + "observed, a reopen is only one possible explanation",
} as const;
