/**
 * T-432: `storybloq review-stats`.
 *
 * RENDERING READS. It does not compute, sum, or derive. Every number printed
 * here already exists as a field on a `Metric`, which is what lets the honesty
 * properties be tested on the structured result: a renderer that computed its
 * own totals could print a disclosure beside a number the disclosure does not
 * describe.
 */
import {
  computeMonthly,
  computeP1,
  computeP2,
  SINGLE_BACKENDS,
  type MonthlyRollup,
  type P1Result,
  type P2Result,
} from "../../core/review-stats.js";
import {
  classifyLandingReason,
  discoverFleetRoots,
  scanRoots,
  type ScanResult,
  type SessionOverlap,
} from "../../core/review-stats-scan.js";
import type { Metric, ScanReport, ScanState } from "../../core/review-stats-types.js";
import type { CommandContext, CommandResult } from "../types.js";

export interface ReviewStatsOptions {
  /** Scan every `.story/` root under this directory instead of just the project. */
  readonly fleet?: string;
}

/**
 * Render one number.
 *
 * A ZERO DENOMINATOR RENDERS "-", NEVER "0%". That is the whole deliverable in
 * one function: a 0% re-raise rate over no labelled findings would read as
 * evidence that this backend never re-raises, when it is evidence of nothing.
 *
 * AND A MEAN IS NEVER RENDERED AS A PERCENTAGE. Rounds per segment came out of
 * the first live run as `126.5%`, a share above 100%, which tells a reader the
 * tool is broken; `1.27 per segment` tells them what happened. `kind` is on the
 * metric because rendering cannot infer this and guessing it produces an
 * impossible number rather than a merely mislabelled one.
 */
export function renderValue(m: Metric): string {
  if (m.value === null) return "-";
  return m.kind === "proportion"
    ? `${(m.value * 100).toFixed(1)}%`
    : `${m.value.toFixed(2)} per ${m.unit}`;
}

export function renderCoverage(m: Metric): string {
  // NULL TOTAL MEANS NO PERCENTAGE. A percentage of an unknown total overclaims,
  // so an incomplete scan prints the readable count and stops there.
  if (m.records.total === null) return `${m.records.readable} readable / total unknown`;
  if (m.records.total === 0) return "0 records";
  return `${m.records.readable} of ${m.records.total}`;
}

export function metricRows(metrics: readonly Metric[]): string[] {
  return metrics.map((m) => {
    const num = m.numerator === null ? "-" : String(m.numerator);
    const den = m.denominator === null ? "-" : String(m.denominator);
    const flags = [
      m.provenance,
      m.scanState !== "COMPLETE" ? m.scanState : null,
      m.conditional ? "conditional" : null,
    ].filter((x): x is string => x !== null).join(", ");
    return `| ${m.label} | ${m.unit} | ${num} / ${den} | ${renderValue(m)} | ${renderCoverage(m)} | ${flags} |`;
  });
}

function renderScan(scan: ScanReport): string[] {
  const lines: string[] = ["", "## Scan", ""];
  lines.push(`Started ${scan.startedAt}, finished ${scan.finishedAt}. NOT ATOMIC: sessions may be written while the scan runs, so every count is as-of-scan.`);
  lines.push("");
  lines.push(`Roots scanned: ${scan.roots.length}`);
  for (const [key, state] of Object.entries(scan.state)) {
    if (state !== "COMPLETE") lines.push(`- ${key}: ${state}`);
  }
  if (scan.failures.length === 0) {
    lines.push("- no read failures");
    return lines;
  }
  lines.push("", `Read failures: ${scan.readFailures}, by SCOPE (how far the uncertainty reaches, not which call failed):`);
  const byScope = new Map<string, number>();
  for (const f of scan.failures) byScope.set(f.scope, (byScope.get(f.scope) ?? 0) + 1);
  for (const [scope, n] of byScope) lines.push(`- ${scope}: ${n}`);
  for (const f of scan.failures.slice(0, 10)) {
    lines.push(`  - [${f.scope}] ${f.path}: ${f.reason}`);
  }
  if (scan.failures.length > 10) lines.push(`  - ... ${scan.failures.length - 10} more`);
  return lines;
}

export function renderOverlaps(overlaps: readonly SessionOverlap[], rootCount: number): string[] {
  if (rootCount < 2) return [];
  const lines = ["", "## Session ids under more than one root", ""];
  if (overlaps.length === 0) {
    lines.push("None observed.");
    return lines;
  }
  lines.push(
    "Reported, never silently deduplicated inside an aggregate. `matching-stored-hashes`",
    "is a MATCHING CLAIM, not a confirmed copy: a stale or hand-edited record keeps its",
    "old hash, so equal stored hashes are weaker evidence than identical content.",
    "",
  );
  for (const o of overlaps) {
    // The unread count is on the LINE, not folded into the label. `unknown`
    // says the comparison did not settle; only this says a whole copy's
    // filenames were never enumerated, so `sharedFiles` is a lower bound.
    const unread = o.holdersWithUnreadListing > 0
      ? `, ${o.holdersWithUnreadListing} of them with an unread artifact listing`
      : "";
    lines.push(`- ${o.sessionId}: ${o.agreement} across ${o.roots.length} roots${unread}`);
  }
  return lines;
}

function renderMonthly(monthly: MonthlyRollup): string[] {
  if (monthly.rows.length === 0) return [];
  const lines = [
    "",
    "## By month",
    "",
    "| Month | Rounds | Zero-critical | Criticals unknown | Segments | Rounds/segment p50 | p90 | Last verdict not approve | Verdict unknown |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of monthly.rows) {
    // A `-` here is a WITHHELD percentile on a month below the minimum, not a
    // zero. The count beside it is what that month actually supports.
    const dash = (v: number | null) => (v === null ? "-" : String(v));
    lines.push(
      // `Criticals unknown` sits beside `Zero-critical` so the denominator is
      // readable off the row: zero-critical is out of `Rounds` MINUS this
      // column, not out of `Rounds`. Without it a reader subtracts and lands on
      // "rounds that had criticals", which counts every unreadable count as a
      // round that had them.
      `| ${r.month} | ${r.rounds} | ${r.zeroCriticalRounds} | ${r.criticalsUnknown} | ${r.segments} | `
      + `${dash(r.roundsPerSegmentP50)} | ${dash(r.roundsPerSegmentP90)} | `
      // Same reason as `Criticals unknown`: without it, subtracting the
      // not-approve count from `Segments` reads as established approvals, and
      // silently counts every unreadable verdict among them.
      + `${dash(r.lastVerdictNotApprove)} | ${r.lastVerdictUnknown} |`,
    );
  }
  lines.push(
    "",
    `Minimum eligible segments for percentiles: ${monthly.minEligible}. `
    + `Rounds with no usable timestamp: ${monthly.unassignableRounds}. `
    + `Groups excluded for indeterminate chronology: ${monthly.excludedGroups}. `
    + `Sessions suppressed for an unread artifact: ${monthly.suppressedSessions}. `
    // READ the structured field. Saying UNKNOWN on a complete scan with nothing
    // excluded is manufactured uncertainty: there, the hidden count is known,
    // and it is zero.
    + (monthly.segmentsHiddenByExclusion === null
      ? "Segments hidden by those: UNKNOWN."
      : `Segments hidden by those: ${monthly.segmentsHiddenByExclusion}.`),
    "",
    monthly.rules,
  );
  return lines;
}

function render(
  p1: P1Result,
  p2: P2Result,
  monthly: MonthlyRollup,
  scan: ScanResult,
  fleet: boolean,
): string {
  const lines: string[] = ["# Review stats", ""];

  if (fleet) {
    lines.push(
      "ROOT-LEVEL RESULTS ARE AUTHORITATIVE. Each root is labelled by PATH, never by",
      "\"project\": one repository can be checked out several times and some roots carry",
      "no git origin at all, so the cross-root figure below is a SUM OF ROOT",
      "OBSERVATIONS that may include duplicates. It is not a count of unique fleet",
      "activity.",
      "",
    );
  }

  lines.push(
    "| Metric | Unit | n / d | Value | Records | Provenance / flags |",
    "|---|---|---|---|---|---|",
    ...metricRows(p1.metrics),
    ...metricRows(p2.metrics),
    "",
  );

  lines.push("## Segment-denominated metrics", "");
  for (const m of [...p1.metrics, ...p2.metrics]) {
    if (m.segments === undefined) continue;
    const total = m.segments.segmentTotal === null ? "unknown" : String(m.segments.segmentTotal);
    lines.push(
      `- ${m.label}: ${m.segments.eligibleSegments} eligible segments, `
      + `${m.segments.excludedGroups} excluded groups, `
      + `${m.segments.suppressedSessions} suppressed sessions `
      + `(${m.segments.suppressedArtifacts} readable artifacts inside them), `
      + `segment total ${total}`,
    );
  }
  lines.push(
    "",
    "An excluded group's segment count is unknown BY CONSTRUCTION, so the segment",
    "total is absent whenever anything was excluded. This can happen on a completely",
    "readable scan: unreadability and indeterminate chronology are different defects",
    "and only the first is a scan problem.",
    "",
    "A SUPPRESSED SESSION is one where a P1 read failed. Its readable records still",
    "count for the order-independent metrics; they are kept out of every",
    "reconstruction because the missing record's unknown round and timestamp can",
    "move the boundaries around it and change which verdict is last. That is a",
    "defect in the reconstruction, not a reduction in its coverage.",
    "",
    "## Reconstruction rule",
    "",
    p1.reconstructionRule,
    "",
    "## Backends",
    "",
  );

  const totalRounds = Object.values(p1.backends).reduce((a, b) => a + b, 0);
  for (const b of SINGLE_BACKENDS) {
    const n = p1.backends[b] ?? 0;
    if (n > 0) lines.push(`- ${b}: ${n}`);
  }
  const composite = p1.backends.composite ?? 0;
  lines.push(
    `- composite: ${composite}`,
    "",
    "`composite` is more than one backend named in ONE round's reviewer field, so the",
    "round cannot enter any single backend's denominator without an arbitrary",
    "assignment. It is never folded in. `other` is the different case of one backend",
    `we have no bucket for. Rounds counted: ${totalRounds}.`,
  );

  for (const m of [...p1.metrics, ...p2.metrics]) {
    if (m.note) lines.push("", `> ${m.label}: ${m.note}`);
  }

  lines.push(...renderMonthly(monthly));
  lines.push(...renderOverlaps(scan.overlaps, scan.report.roots.length));
  lines.push(...renderScan(scan.report));
  return lines.join("\n");
}

export async function handleReviewStats(
  options: ReviewStatsOptions,
  ctx: CommandContext,
): Promise<CommandResult> {
  const discovery = options.fleet === undefined
    ? { roots: [ctx.root], failures: [] }
    : await discoverFleetRoots(options.fleet);

  const scan = await scanRoots(discovery.roots);
  // A FAILED DISCOVERY MUST NOT READ AS AN EMPTY ONE. With no roots there are
  // no per-root state entries, and an empty state reduces to EMPTY -- which is
  // "scanned, nothing there" and would let the command report a definitive
  // total of 0 over a directory it could not open. The failure is recorded as
  // UNAVAILABLE state for both populations so the total goes null instead.
  const discoveryState: Record<string, ScanState> = {};
  for (const f of discovery.failures) {
    for (const population of f.affects) discoveryState[`${population}:${f.root}`] = "UNAVAILABLE";
  }
  const report: ScanReport = {
    ...scan.report,
    failures: [...discovery.failures, ...scan.report.failures],
    readFailures: discovery.failures.length + scan.report.readFailures,
    state: { ...discoveryState, ...scan.report.state },
  };
  const p1 = computeP1({ artifacts: scan.p1, scan: report });
  const p2 = computeP2({ sessions: scan.p2, scan: report }, classifyLandingReason);
  const monthly = computeMonthly({ artifacts: scan.p1, scan: report });

  if (ctx.format === "json") {
    return {
      output: JSON.stringify(
        {
          p1: { metrics: p1.metrics, backends: p1.backends, segmentation: p1.segmentation },
          p2: { metrics: p2.metrics },
          monthly,
          reconstructionRule: p1.reconstructionRule,
          scan: report,
          overlaps: scan.overlaps,
          semantics: {
            rootsAreAuthoritative: true,
            crossRootFigureIs: "sumOfRootObservations",
            crossRootFigureIsNot: "unique fleet activity",
            nullRateMeans: "no eligible denominator; never zero",
            nullTotalMeans: "discovery incomplete; no coverage percentage is claimed",
          },
        },
        null,
        2,
      ),
      ...(report.readFailures > 0 && { warnings: [`${report.readFailures} read failure(s); see scan.failures`] }),
    };
  }

  return {
    output: render(p1, p2, monthly, { ...scan, report }, options.fleet !== undefined),
    ...(report.readFailures > 0 && { warnings: [`${report.readFailures} read failure(s); see the Scan section`] }),
  };
}
