/**
 * T-432: review-efficiency metrics over review verdict artifacts.
 *
 * PURE. Nothing here touches disk; the scanner hands it parsed records. That is
 * what lets the honesty properties be tested on the structured result with no
 * fixture tree, and it is why `computeP1` can take a type that admits only P1.
 *
 * See review-stats-types.ts for the contract these functions implement.
 */
import {
  metric,
  type Metric,
  type P1Artifact,
  type P1Input,
  type ScanFailure,
  type PopulationId,
  type P2Input,
  type RecordCounts,
  type ScanState,
  type SegmentCounts,
} from "./review-stats-types.js";

// ---------------------------------------------------------------------------
// Backend normalization
// ---------------------------------------------------------------------------

export type Backend =
  | "codex"
  | "agent"
  | "lenses"
  | "gemini"
  | "manual"
  | "composite"
  | "other";

/**
 * The reviewer field is free text: 82 distinct values across the fleet.
 *
 * TOKEN-BASED, and the count of distinct tokens is what decides. One token is
 * that backend; more than one is `composite`; none is `other`. The alternative,
 * matching whole strings, cannot cope with 82 values and silently drops the
 * ones nobody thought of.
 *
 * `composite` IS NOT A FAILURE BUCKET. It means more than one backend appears
 * in one round's reviewer field, so the round cannot enter any single backend's
 * denominator without an arbitrary assignment. It is reported with its own
 * count and share, never folded in. `other` is the different case of one
 * backend we have no bucket for.
 *
 * The conservative call is `codex-bridge (gemini)`: that is plausibly one
 * reviewer (gemini, reached through the codex bridge), but the string alone
 * cannot establish it, so two tokens means composite and the ambiguity is
 * reported rather than resolved by guess.
 */
const BACKEND_TOKENS: readonly (readonly [Backend, RegExp])[] = [
  ["lenses", /lens/i],
  ["codex", /codex/i],
  ["gemini", /gemini/i],
  ["agent", /(\bagent\b|code-reviewer|feature-dev)/i],
  ["manual", /\bmanual\b/i],
];

/**
 * COMPOSITE IS A CLASSIFICATION, NOT A JUDGEMENT that two backends ran.
 *
 * Worth stating where a reader will look for it, because it makes at least one
 * real bucket read low: `codex-bridge (gemini)` and `codex-bridge (published)
 * via gemini` both match the `codex` token and the `gemini` token, so both land
 * in `composite`, though they are in fact ONE backend -- gemini reached through
 * the bridge. Their rounds therefore never enter gemini's own count or rate.
 *
 * Left as is on purpose. Never-folded is the conservative direction: a round
 * counted under a backend that did not produce it is a fabricated attribution,
 * while a round held out of every single-backend bucket is a visible gap that
 * the composite row reports. Adding a rule that reads `X via Y` would fix these
 * two strings and start guessing at the next reviewer string nobody has written
 * yet.
 */
export function normalizeBackend(raw: string): Backend {
  const found = new Set<Backend>();
  for (const [backend, pattern] of BACKEND_TOKENS) {
    if (pattern.test(raw)) found.add(backend);
  }
  if (found.size === 0) return "other";
  if (found.size > 1) return "composite";
  return [...found][0]!;
}

/** Backends a per-backend rate may be reported for. Never `composite`. */
export const SINGLE_BACKENDS: readonly Backend[] = [
  "codex",
  "agent",
  "lenses",
  "gemini",
  "manual",
  "other",
];

// ---------------------------------------------------------------------------
// Ordering eligibility, decided BEFORE segmentation
// ---------------------------------------------------------------------------

/** The grouping key. Session is part of it, so interleaved sessions cannot split a run. */
export function groupKey(a: P1Artifact): string {
  // NUL separator, written as an escape rather than a literal: a root path or a
  // target can contain a space, so a space-joined key can collide across
  // different tuples, and a literal NUL in the source makes the file binary to
  // grep and diff, which hides it from exactly the review that should catch it.
  return [a.root, a.sessionId, a.target, a.stage].join("\u0000");
}

/**
 * Can this group be ordered from its own records?
 *
 * WHOLE GROUP, BEFORE SEGMENTATION. Deciding this per segment is too late:
 * assigning an undated record to a segment has already assumed the order in
 * question, and its true position could move other boundaries.
 *
 * A TIE IS AS DISQUALIFYING AS A MISSING TIMESTAMP, which an earlier draft
 * missed by checking only whether a tie changed the last verdict. Two tied
 * rounds with IDENTICAL verdicts still yield one segment in one ordering and
 * two in the reverse, so a tie can change the segment count and the first
 * surviving round while leaving the last verdict untouched.
 */
export function isOrderIndeterminate(group: readonly P1Artifact[]): boolean {
  const seen = new Set<number>();
  for (const a of group) {
    // THE INSTANT, not the string. `...T00:00:00Z` and `...T00:00:00.000Z` are
    // the same moment and unequal as text, so a string tie check would miss a
    // real tie and hand an order-dependent group to segmentation.
    if (a.epochMs === null) return true;
    if (seen.has(a.epochMs)) return true;
    seen.add(a.epochMs);
    // A MISSING ROUND IS AS DISQUALIFYING AS A MISSING TIMESTAMP, because the
    // break rule is defined on rounds. Without this the sentinel decides: a
    // null round sorts as -Infinity, which never breaks after it and ALWAYS
    // breaks before it, so the segment count would be an artifact of the
    // sentinel rather than of the data.
    if (a.round === null) return true;
  }
  return false;
}

export interface Segment {
  readonly root: string;
  readonly sessionId: string;
  readonly target: string;
  readonly stage: string;
  readonly artifacts: readonly P1Artifact[];
}

/**
 * Split an orderable group into segments.
 *
 * A NON-INCREASING ROUND IS A SEGMENTATION CONVENTION, not evidence that a
 * redirect or a new attempt occurred. A PLAN redirect restarting round numbers
 * and an overwrite artefact both produce a break here and the records do not
 * distinguish them.
 *
 * Ordering by (timestamp, round, fileName) is deterministic for reproducibility.
 * It is not observed chronology, which is why only groups that passed
 * `isOrderIndeterminate` reach this function.
 */
export function segmentGroup(group: readonly P1Artifact[]): Segment[] {
  const ordered = [...group].sort((x, y) =>
    // Numeric, not lexical: a timestamp written with a timezone offset can sort
    // lexically in the opposite order to the instant it names.
    (x.epochMs ?? 0) - (y.epochMs ?? 0)
    || (x.round ?? 0) - (y.round ?? 0)
    || x.fileName.localeCompare(y.fileName),
  );
  const out: Segment[] = [];
  let current: P1Artifact[] = [];
  let lastRound = -Infinity;
  for (const a of ordered) {
    const r = a.round ?? -Infinity;
    if (current.length > 0 && !(r > lastRound)) {
      out.push(toSegment(current));
      current = [];
    }
    current.push(a);
    lastRound = r;
  }
  if (current.length > 0) out.push(toSegment(current));
  return out;
}

function toSegment(artifacts: P1Artifact[]): Segment {
  const first = artifacts[0]!;
  return {
    root: first.root,
    sessionId: first.sessionId,
    target: first.target,
    stage: first.stage,
    artifacts: [...artifacts],
  };
}

/** Groups that can be ordered, and the count of those that cannot. */
export interface Segmentation {
  readonly segments: readonly Segment[];
  readonly excludedGroups: number;
  /** Artifacts inside excluded groups. Still readable, still counted as records. */
  readonly excludedArtifacts: number;
}

/**
 * Which artifacts may enter a RECONSTRUCTION, and what the failures hide.
 *
 * TWO DIFFERENT DEFECTS, and an earlier cut treated them alike.
 *
 * A P1 READ FAILURE INSIDE A SESSION disqualifies that session. The missing
 * record has an unknown round and an unknown timestamp, so it can move the
 * boundaries of the artifacts around it and change which verdict is last: a
 * defect in the RECONSTRUCTION, not a reduction in its coverage.
 *
 * A ROOT-DISCOVERY FAILURE DOES NOT. It means additional sessions may be
 * invisible, and an invisible session cannot alter a group keyed on a DIFFERENT
 * session id -- session identity is part of the grouping key, so a fully
 * enumerated session's segmentation stands on its own. What such a failure
 * costs is the POPULATION: we no longer know how many segments exist. So it
 * makes `segmentTotal` unknown and the result conditional, and suppresses
 * nothing. Suppressing those sessions discarded valid measurements and could
 * turn a supported rate into null.
 *
 * SUPPRESSED SESSIONS ARE COUNTED FROM THE FAILURES, not from the surviving
 * artifacts. A session whose ONLY artifact was unreadable has no surviving
 * record to count, and counting from survivors reported it as zero -- letting
 * `segmentTotal` be published as complete while a failure hid an unknown number
 * of segments.
 *
 * The order-INDEPENDENT metrics keep every readable record throughout.
 * Suppressing those too would discard good evidence over a defect that does not
 * touch them.
 */
export interface ReconstructionEligibility {
  readonly eligible: P1Artifact[];
  readonly suppressedSessions: number;
  readonly suppressedArtifacts: number;
  /** A P1 root-discovery failure: whole sessions may be invisible. */
  readonly discoveryIncomplete: boolean;
}

export function reconstructionEligible(
  artifacts: readonly P1Artifact[],
  failures: readonly ScanFailure[],
): ReconstructionEligibility {
  const blockedSessions = new Set<string>();
  let discoveryIncomplete = false;
  for (const f of failures) {
    if (!f.affects.includes("p1")) continue;
    if (f.scope === "root-discovery") discoveryIncomplete = true;
    else if (f.sessionId !== undefined) blockedSessions.add(`${f.root}\u0000${f.sessionId}`);
  }
  if (blockedSessions.size === 0) {
    return {
      eligible: [...artifacts],
      suppressedSessions: 0,
      suppressedArtifacts: 0,
      discoveryIncomplete,
    };
  }
  const eligible: P1Artifact[] = [];
  let suppressedArtifacts = 0;
  for (const a of artifacts) {
    if (blockedSessions.has(`${a.root}\u0000${a.sessionId}`)) {
      suppressedArtifacts += 1;
      continue;
    }
    eligible.push(a);
  }
  return {
    eligible,
    // FROM THE FAILURES. A session with no surviving artifact is still a
    // session whose segments are hidden.
    suppressedSessions: blockedSessions.size,
    suppressedArtifacts,
    discoveryIncomplete,
  };
}

export function segmentAll(artifacts: readonly P1Artifact[]): Segmentation {
  const groups = new Map<string, P1Artifact[]>();
  for (const a of artifacts) {
    const k = groupKey(a);
    const g = groups.get(k);
    if (g) g.push(a);
    else groups.set(k, [a]);
  }
  const segments: Segment[] = [];
  let excludedGroups = 0;
  let excludedArtifacts = 0;
  for (const g of groups.values()) {
    if (isOrderIndeterminate(g)) {
      excludedGroups += 1;
      excludedArtifacts += g.length;
      continue;
    }
    segments.push(...segmentGroup(g));
  }
  return { segments, excludedGroups, excludedArtifacts };
}

// ---------------------------------------------------------------------------
// Provenance labels
// ---------------------------------------------------------------------------

/**
 * The closed set. An unrecognised value is INVALID, not a non-re-raise.
 *
 * Both exclusions matter to metric 4's denominator: an absent label must not
 * dilute the rate (adding unlabelled findings would otherwise lower it while
 * adding no evidence), and an unreadable label must not be silently counted as
 * evidence that the finding was not a re-raise.
 */
export const RECOGNISED_ORIGIN_CLASSES: ReadonlySet<string> = new Set([
  "new",
  "reintroduced",
  "unchanged",
  "introduced-by-fix",
]);

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface P1Result {
  readonly metrics: readonly Metric[];
  readonly backends: Readonly<Record<string, number>>;
  readonly segmentation: {
    readonly segments: number;
    readonly excludedGroups: number;
    readonly distinctKeys: number;
    readonly distinctSessions: number;
    readonly artifacts: number;
  };
  /** Printed verbatim, so a reader never has to infer the rule from the number. */
  readonly reconstructionRule: string;
}

export const RECONSTRUCTION_RULE =
  "A reconstructed review segment is a maximal run of artifacts sharing "
  + "(root, target, stage, session), ordered by (timestamp, round, filename), "
  + "broken where the round number fails to increase. A non-increasing round is "
  + "a segmentation convention, not evidence that a redirect or new attempt "
  + "occurred. Groups with a missing or tied timestamp cannot be ordered from "
  + "their own records and are excluded from every order-dependent metric; "
  + "their segment count is unknown, so the segment total is reported as absent.";

function recordCounts(input: {
  total: number | null;
  readable: number;
  missing: number;
  invalid: number;
}): RecordCounts {
  return input;
}

function segmentCounts(
  seg: Segmentation,
  eligible: number,
  suppression: ReconstructionEligibility,
): SegmentCounts {
  return {
    eligibleSegments: eligible,
    excludedGroups: seg.excludedGroups,
    suppressedSessions: suppression.suppressedSessions,
    suppressedArtifacts: suppression.suppressedArtifacts,
    // The POPULATION, not `eligible`: every metric here has its own
    // eligibility, so reporting the eligible subset would give a different
    // population size per metric over identical data.
    //
    // NULL whenever anything was excluded OR suppressed, because both hide an
    // unknown number of segments. An excluded group has no determinable
    // segmentation by construction, and a suppressed session's boundaries
    // cannot be drawn at all. The exclusion case can arise on a COMPLETELY
    // READABLE scan: unreadability and indeterminate chronology are different
    // defects and only the first is a scan problem.
    // Also null when DISCOVERY was incomplete: sessions we never saw hold an
    // unknown number of segments, even though the sessions we did read
    // reconstruct correctly.
    segmentTotal:
      seg.excludedGroups > 0
      || suppression.suppressedSessions > 0
      || suppression.discoveryIncomplete
        ? null
        : seg.segments.length,
  };
}

/**
 * Compute the P1 metrics.
 *
 * TAKES `P1Input` AND NOTHING ELSE. There is no parameter through which a state
 * array or an event could arrive, so a P1 metric cannot pool across populations
 * even by mistake. A provenance label is a claim; this signature is a guarantee.
 */
export function computeP1(input: P1Input): P1Result {
  const { artifacts, scan } = input;
  const scanState = populationScanState(scan.state, "p1");
  const totalKnown = scanState === "COMPLETE" || scanState === "EMPTY";
  // Population size is unknown whenever discovery was incomplete. A partial
  // scan can supply a valid numerator over what it read and still cannot say
  // how many records exist, so this is null rather than `artifacts.length`.
  const total = totalKnown ? artifacts.length : null;
  const readable = artifacts.length;
  // SEGMENTATION RUNS OVER THE ELIGIBLE SUBSET ONLY. The order-independent
  // metrics below still use every readable record.
  const suppression = reconstructionEligible(artifacts, scan.failures);
  const seg = segmentAll(suppression.eligible);
  const conditional = !totalKnown;

  const backends: Record<string, number> = {};
  for (const a of artifacts) {
    const b = normalizeBackend(a.reviewerRaw);
    backends[b] = (backends[b] ?? 0) + 1;
  }

  const metrics: Metric[] = [];

  // 2. zero-critical rounds. Observed, per round, order-independent.
  const withCritical = artifacts.filter((a) => a.criticalCount !== null);
  metrics.push(metric({
    id: "zero-critical-rounds",
    kind: "proportion",
    label: "Rounds with zero criticals",
    unit: "round",
    provenance: "observed",
    population: "p1",
    scanState,
    numerator: withCritical.filter((a) => a.criticalCount === 0).length,
    denominator: withCritical.length,
    conditional,
    records: recordCounts({
      total,
      readable,
      missing: artifacts.length - withCritical.length,
      invalid: 0,
    }),
  }));

  // 3. zero-finding rounds that still said revise. Observed, per round.
  const changeRequest = new Set(["revise", "request_changes"]);
  const withFindings = artifacts.filter((a) => a.findingsCount !== null);
  const revising = withFindings.filter((a) => changeRequest.has(a.verdict));
  metrics.push(metric({
    id: "zero-finding-revise-rounds",
    kind: "proportion",
    label: "Change-request rounds with zero findings",
    unit: "round",
    provenance: "observed",
    population: "p1",
    scanState,
    numerator: revising.filter((a) => a.findingsCount === 0).length,
    denominator: revising.length,
    conditional,
    records: recordCounts({
      total,
      readable,
      missing: artifacts.length - withFindings.length,
      invalid: 0,
    }),
  }));

  // 1. rounds per segment. RECONSTRUCTED: depends on the grouping and ordering.
  const roundsInSegments = seg.segments.reduce((n, s) => n + s.artifacts.length, 0);
  metrics.push(metric({
    id: "rounds-per-segment",
    kind: "mean",
    label: "Rounds per reconstructed segment",
    unit: "segment",
    provenance: "reconstructed",
    population: "p1",
    scanState,
    numerator: roundsInSegments,
    denominator: seg.segments.length,
    conditional,
    records: recordCounts({
      total,
      readable,
      missing: 0,
      invalid: 0,
    }),
    segments: segmentCounts(seg, seg.segments.length, suppression),
    note: seg.excludedGroups > 0
      ? `${seg.excludedGroups} group(s) excluded for indeterminate order; segment total unknown`
      : undefined,
  }));

  // 4. re-raise rate. Per FINDING, and the denominator is RECOGNISED labels only.
  const originValues = artifacts.flatMap((a) => a.originClasses);
  const recognised = originValues.filter(
    (v) => typeof v === "string" && RECOGNISED_ORIGIN_CLASSES.has(v),
  );
  const unrecognised = originValues.filter(
    (v) => !(typeof v === "string" && RECOGNISED_ORIGIN_CLASSES.has(v)) && v !== undefined && v !== null,
  );
  metrics.push(metric({
    id: "re-raise-rate",
    kind: "proportion",
    label: "Re-raise rate (findings labelled reintroduced)",
    unit: "finding",
    provenance: "observed",
    population: "p1",
    scanState,
    numerator: recognised.filter((v) => v === "reintroduced").length,
    // Recognised labels ONLY. An unlabelled finding cannot dilute the rate and
    // an unreadable label cannot be counted as a non-re-raise.
    denominator: recognised.length,
    conditional,
    // DENOMINATED IN FINDINGS, this metric's own unit. Every other metric here
    // has one record per artifact, so `readable` is the artifact count; this one
    // has one record per FINDING, and reporting 6,408 readable beside 24,182
    // missing would put two units in one accounting -- the same mixing that put
    // excluded groups under a record-level `invalid` in an earlier draft.
    records: recordCounts({
      total: totalKnown ? originValues.length : null,
      readable: originValues.length,
      missing: originValues.filter((v) => v === undefined || v === null).length,
      invalid: unrecognised.length,
    }),
  }));

  // 4b. re-raise rate PER BACKEND, which is what ISS-1115 line 4 actually asks
  // for. The fleet-wide rate above cannot answer it: it pools every backend into
  // one number, so a backend that re-raises constantly and one that never does
  // are indistinguishable in it, and the whole point of the acceptance line is
  // to tell them apart.
  //
  // ONE ROW PER SINGLE BACKEND, and `composite` gets a row of its own that never
  // enters any of them. A round whose reviewer field names two backends cannot
  // be assigned to either without inventing the attribution, so it is reported
  // separately rather than dropped (which would hide its findings) or split
  // (which would fabricate them).
  //
  // A BACKEND WITH NO RECOGNISED LABELS RENDERS "-", not 0%. Its row is still
  // emitted, because the absence of labels on a backend is itself the finding
  // ISS-1115 is about, and a missing row reads as a backend with no rounds.
  for (const b of [...SINGLE_BACKENDS, "composite" as const]) {
    const own = artifacts.filter((a) => normalizeBackend(a.reviewerRaw) === b);
    if (own.length === 0) continue;
    const values = own.flatMap((a) => a.originClasses);
    const ok = values.filter((v) => typeof v === "string" && RECOGNISED_ORIGIN_CLASSES.has(v));
    const bad = values.filter(
      (v) => !(typeof v === "string" && RECOGNISED_ORIGIN_CLASSES.has(v)) && v !== undefined && v !== null,
    );
    metrics.push(metric({
      id: `re-raise-rate-${b}`,
      kind: "proportion",
      label: b === "composite"
        // Named for what it is. A reader scanning the column must not take this
        // for a seventh backend: it is the rounds no single backend can claim.
        ? "Re-raise rate, composite rounds (more than one backend named; in NO single-backend rate above)"
        : `Re-raise rate, ${b} rounds`,
      unit: "finding",
      provenance: "observed",
      population: "p1",
      scanState,
      numerator: ok.filter((v) => v === "reintroduced").length,
      denominator: ok.length,
      conditional,
      records: recordCounts({
        // Scoped to THIS backend's findings. `total` stays conditional on the
        // scan the same way the fleet-wide row is: an incomplete scan cannot
        // establish a backend's finding total any more than the whole fleet's.
        total: totalKnown ? values.length : null,
        readable: values.length,
        missing: values.filter((v) => v === undefined || v === null).length,
        invalid: bad.length,
      }),
      note: ok.length === 0
        ? `${own.length} round(s) read for this backend and NO finding carries a `
          + "recognised origin label, so no rate exists. This is absence of "
          + "labelling, never evidence of no re-raises."
        : undefined,
    }));
  }

  // 5a. Segments whose last surviving verdict is not approve.
  // DERIVED, and named for exactly what it measures: nothing available
  // establishes that a reviewed item LANDED, so "forced landing" is not claimed.
  const determinate = seg.segments.filter((s) => lastVerdict(s) !== null);
  metrics.push(metric({
    id: "segments-last-verdict-not-approve",
    kind: "proportion",
    label: "Segments whose last surviving verdict is not approve (as of scan)",
    unit: "segment",
    // RECONSTRUCTED, not derived. "not approve" is observed, but WHICH record is
    // last is a product of the segmentation, and a metric's provenance takes its
    // weakest input. Calling this derived would present a reconstruction as a
    // computation over observed fields.
    provenance: "reconstructed",
    population: "p1",
    scanState,
    numerator: determinate.filter((s) => lastVerdict(s) !== "approve").length,
    denominator: determinate.length,
    conditional,
    records: recordCounts({ total, readable, missing: 0, invalid: 0 }),
    segments: segmentCounts(seg, determinate.length, suppression),
    note: `As of scan ${scan.finishedAt}. No completion is established; a segment `
      + "ending is compatible with an abandoned or redirected review.",
  }));

  // 7. diff lines at FIRST SURVIVING review.
  const firstRoundSegments = seg.segments.filter(
    (s) => (s.artifacts[0]?.round ?? null) === 1,
  );
  const withDiff = firstRoundSegments.filter((s) => s.artifacts[0]?.diffLines != null);
  metrics.push(metric({
    id: "diff-lines-first-surviving-review",
    kind: "mean",
    label: "Diff lines at first surviving review",
    unit: "segment",
    // The diff line count IS observed; which artifact is "first" is not. Same
    // weakest-input rule as 5a.
    provenance: "reconstructed",
    population: "p1",
    scanState,
    numerator: withDiff.reduce((n, s) => n + (s.artifacts[0]!.diffLines ?? 0), 0),
    denominator: withDiff.length,
    conditional,
    records: recordCounts({
      total,
      readable,
      // RECORDS lacking the field, over the readable population. The earlier
      // cut put `firstRoundSegments.length - withDiff.length` here, which is a
      // count of SEGMENTS in a record-level field: exactly the unit conflation
      // that made records and segments share a denominator.
      missing: artifacts.filter((a) => a.diffLines === null).length,
      invalid: 0,
    }),
    // `withDiff`, NOT `firstRoundSegments`. Advertising a segment as eligible
    // while excluding it from the denominator says the measurement covers more
    // than it does: eligibility here needs BOTH a surviving round 1 AND a
    // usable diffLines value on it.
    segments: segmentCounts(seg, withDiff.length, suppression),
    note: "Eligibility requires BOTH that the segment's LOWEST SURVIVING round "
      + "is 1 and that that round carries a usable diffLines value; a "
      + "first-review measurement needs evidence that round 1 survived. "
      + `${firstRoundSegments.length} segment(s) have a surviving round 1, of `
      + `which ${withDiff.length} carry the measurement.`,
  }));

  return {
    metrics,
    backends,
    segmentation: {
      segments: seg.segments.length,
      excludedGroups: seg.excludedGroups,
      distinctKeys: new Set(
        artifacts.map((a) => [a.root, a.target, a.stage].join("\u0000")),
      ).size,
      distinctSessions: new Set(artifacts.map((a) => a.sessionId)).size,
      artifacts: artifacts.length,
    },
    reconstructionRule: RECONSTRUCTION_RULE,
  };
}

// ---------------------------------------------------------------------------
// P2: session-denominated metrics. Its own input type, its own function.
// ---------------------------------------------------------------------------

export interface P2Result {
  readonly metrics: readonly Metric[];
}

/**
 * Compute the P2 metrics.
 *
 * TAKES `P2Input` AND NOTHING ELSE, for the same reason `computeP1` takes only
 * P1: the populations have different item identity and different denominators,
 * and a type is what stops one filling the other. 5a (P1, segments) and 5b (P2,
 * sessions) print side by side and are NEVER merged, because a segment and a
 * session are different things and a rate over one says nothing about the other.
 */
export function computeP2(input: P2Input, classifyLanding: (reason: string | null) => string | null): P2Result {
  const { sessions, scan } = input;
  const scanState = populationScanState(scan.state, "p2");
  const totalKnown = scanState === "COMPLETE" || scanState === "EMPTY";
  const total = totalKnown ? sessions.length : null;
  const readable = sessions.length;
  const conditional = !totalKnown;

  // 5b. Sessions with a recorded landing decision.
  //
  // ABSENT IS UNKNOWN, NOT NO-LANDING. The field is transient: it is cleared on
  // ceiling escalation, so a session that landed can end with nothing recorded.
  // Counting absence as a non-landing would turn a gap in the record into
  // evidence about the run.
  // `present` and `malformed` both mean a decision IS recorded, so both belong
  // in the denominator: what differs is whether we can classify it. Only
  // `absent` is unknown, and only `absent` stays out.
  const recorded = sessions.filter((x) => x.landingField !== "absent");
  const recognised = recorded.filter(
    (x) => x.landingField === "present" && classifyLanding(x.landingReason) !== null,
  );
  const metrics: Metric[] = [
    metric({
      id: "sessions-with-recorded-landing",
    kind: "proportion",
      label: "Sessions with a recognised landing decision (of those recording one)",
      unit: "session",
      provenance: "observed",
      population: "p2",
      scanState,
      numerator: recognised.length,
      // SESSIONS CARRYING THE FIELD, not all sessions. Denominating this in
      // every session would count 650 unknowns as non-landings, which is the
      // exact thing the note beneath it says the metric does not do. The note
      // and the denominator disagreed until the fleet run made the 0.0% over
      // 660 visible.
      denominator: recorded.length,
      conditional,
      records: {
        total,
        readable,
        // Absent, reported as unknown rather than as a no-landing.
        missing: sessions.length - recorded.length,
        // Recorded but unclassifiable: a malformed field, or a reason no writer
        // we know produces. Both are invalid; neither is evidence of anything.
        invalid: recorded.length - recognised.length,
      },
      note: "Absence is UNKNOWN, not no-landing: the field is cleared on ceiling "
        + "escalation. Never merged with the segment-level last-verdict metric.",
    }),
  ];

  // 6. Realized risk differing from filed risk. Denominator is sessions
  // carrying BOTH, because a session missing either cannot disagree with itself.
  const withBoth = sessions.filter((x) => x.risk !== null && x.realizedRisk !== null);
  metrics.push(metric({
    id: "realized-risk-differs",
    kind: "proportion",
    label: "Sessions whose realized risk differs from filed risk",
    unit: "session",
    provenance: "observed",
    population: "p2",
    scanState,
    numerator: withBoth.filter((x) => x.risk !== x.realizedRisk).length,
    denominator: withBoth.length,
    conditional,
    records: {
      total,
      readable,
      missing: sessions.length - withBoth.length,
      invalid: 0,
    },
  }));

  return { metrics };
}

// ---------------------------------------------------------------------------
// P2 session-stage summary: the rounds table on a session report
// ---------------------------------------------------------------------------

/**
 * One round as the SESSION STATE records it.
 *
 * This is the P2 shape, and it is deliberately NOT `P1Artifact`. A state array
 * row and a verdict artifact are different records with different identity: the
 * artifact has a `target`, the row does not, which is why P2 can summarise a
 * session and a stage and can never fill a per-item population.
 */
export interface SessionRound {
  readonly round: number;
  readonly verdict: string;
  readonly findingCount: number;
  readonly criticalCount: number;
}

export interface SessionRoundsInput {
  readonly stage: string;
  readonly rounds: readonly SessionRound[];
}

/**
 * Summarise ONE SESSION's own recorded rounds for one stage.
 *
 * SCOPE IS THE SESSION, and the labels say so. These numbers are not the fleet
 * statistics `review-stats` reports and must never be read as a sample of them:
 * a session is one session, and its arrays are cleared when an item is parked at
 * a ceiling, so even within the session an empty array is not evidence that no
 * review ran.
 *
 * `scanState` is COMPLETE because the records are in hand: this reads a loaded
 * state object, not a directory, so there is no discovery that could have been
 * incomplete.
 */
export function computeSessionRounds(input: SessionRoundsInput): Metric[] {
  const { stage, rounds } = input;
  const changeRequest = new Set(["revise", "request_changes"]);
  const revising = rounds.filter((r) => changeRequest.has(r.verdict));
  const common = {
    unit: "round" as const,
    kind: "proportion" as const,
    provenance: "observed" as const,
    population: "p2" as const,
    scanState: "COMPLETE" as const,
    conditional: false,
    records: { total: rounds.length, readable: rounds.length, missing: 0, invalid: 0 },
  };
  return [
    metric({
      ...common,
      id: `session-${stage}-zero-critical`,
      label: `${stage} rounds with zero criticals (this session)`,
      numerator: rounds.filter((r) => r.criticalCount === 0).length,
      denominator: rounds.length,
    }),
    metric({
      ...common,
      id: `session-${stage}-zero-finding-revise`,
      label: `${stage} change-request rounds naming no finding (this session)`,
      numerator: revising.filter((r) => r.findingCount === 0).length,
      denominator: revising.length,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Monthly rollups
// ---------------------------------------------------------------------------

export interface MonthlyRow {
  readonly month: string;
  readonly rounds: number;
  /**
   * Rounds whose `severityCounts.critical` is 0.
   *
   * DENOMINATED IN `rounds - criticalsUnknown`, never in `rounds`. Counting an
   * unknown critical count as a round WITH criticals is rule 3 of the types
   * file -- absence is never zero -- violated in the direction that reads worse
   * than the truth, and `computeP1`'s own zero-critical metric already excludes
   * nulls from its denominator, so the rollup was contradicting the headline
   * table over identical records.
   */
  readonly zeroCriticalRounds: number;
  /** Rounds in this month with NO readable critical count. Never a zero. */
  readonly criticalsUnknown: number;
  readonly segments: number;
  /** Nearest-rank percentiles of rounds per segment. NULL below the minimum. */
  readonly roundsPerSegmentP50: number | null;
  readonly roundsPerSegmentP90: number | null;
  readonly lastVerdictNotApprove: number | null;
  /**
   * Segments in this month whose last surviving verdict could not be read.
   *
   * THE SAME DEFECT AS THE ZERO-CRITICAL COLUMN, one column over, and returning
   * null only when EVERY verdict is unknown does not cover it: with two
   * segments, one ending `approve` and one with no readable verdict, the row
   * printed Segments 2 and Last-verdict-not-approve 0, and a reader subtracting
   * lands on two established approvals where only one exists. The denominator is
   * segments MINUS this count.
   */
  readonly lastVerdictUnknown: number;
  /** True when the month is below `minEligible` and percentiles are withheld. */
  readonly belowMinimum: boolean;
}

export interface MonthlyRollup {
  readonly rows: readonly MonthlyRow[];
  /** Rounds with no usable timestamp. Reported, never dropped into a month. */
  readonly unassignableRounds: number;
  /**
   * Groups excluded for indeterminate chronology, and sessions suppressed for
   * an unread artifact.
   *
   * THE SEGMENTS THESE HIDE ARE AN UNKNOWN NUMBER, not zero. An earlier cut
   * reported `unassignableSegments` computed over segments that had ALREADY
   * passed eligibility, so it was 0 by construction while the rules text
   * claimed segments without determinable timestamps were counted separately.
   * That is a fabricated zero dressed as a disclosure, so the count of hidden
   * segments is not reported at all: what is reported is what hid them.
   */
  readonly excludedGroups: number;
  readonly suppressedSessions: number;
  /**
   * Segments hidden by an exclusion or a suppression. NULL when that number is
   * unknown, and 0 when it is DETERMINATELY zero.
   *
   * Always-null was itself manufactured uncertainty: on a complete scan with
   * nothing excluded and nothing suppressed, the count of hidden segments is
   * known, and it is zero. Saying UNKNOWN there is the same defect as saying
   * zero when it is unknown, mirrored.
   */
  readonly segmentsHiddenByExclusion: number | null;
  readonly minEligible: number;
  /** Printed with the table, so the assignment rules are never inferred. */
  readonly rules: string;
}

/**
 * Nearest-rank percentile, stated because the choice changes the number.
 *
 * Nearest-rank returns an OBSERVED VALUE from the data. Linear interpolation
 * would return a value no segment had, which for a count of rounds is a
 * quantity that cannot exist.
 */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

const MONTHLY_RULES =
  "A ROUND is assigned to a month by its own UTC timestamp. A SEGMENT is "
  + "assigned by its LAST determinable artifact timestamp, one rule for every "
  + "segment metric. ZERO-CRITICAL is denominated in rounds MINUS the "
  + "criticals-unknown column, never in the round count: a round whose critical "
  + "count could not be read is not a round that had criticals, and the "
  + "last-verdict column is denominated the same way in segments MINUS the "
  + "unknown-verdict count. Percentiles are "
  + "NEAREST-RANK, so each is a value some "
  + "segment actually had. A month below the stated minimum reports its count "
  + "and withholds percentiles rather than publishing one over a handful of "
  // Rounds ONLY. Segments were claimed here too, and they are not counted
  // separately: an indeterminate group is excluded, and how many segments that
  // hid is exactly the number the next sentence says is unknown. The two
  // sentences contradicted each other, and the wrong one was the reassuring one.
  + "segments. Rounds with no determinable timestamp are counted "
  + "separately and never assigned to a month. Groups with an indeterminate "
  + "chronology and sessions with an unread artifact are excluded from the "
  + "segment columns entirely; where anything was excluded, suppressed, or left "
  + "undiscovered, the number of segments hidden is UNKNOWN rather than zero.";

function monthOf(epochMs: number | null): string | null {
  if (epochMs === null) return null;
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function computeMonthly(input: P1Input, minEligible = 5): MonthlyRollup {
  const { artifacts, scan } = input;
  // The SAME eligibility filter computeP1 applies. A rollup reconstructed from
  // sessions with unread artifacts would carry boundaries the artifacts cannot
  // support, and would disagree with the headline table over the same data.
  const suppression = reconstructionEligible(artifacts, scan.failures);
  const seg = segmentAll(suppression.eligible);

  const rounds = new Map<string, P1Artifact[]>();
  let unassignableRounds = 0;
  for (const a of artifacts) {
    const m = monthOf(a.epochMs);
    if (m === null) { unassignableRounds += 1; continue; }
    rounds.set(m, [...(rounds.get(m) ?? []), a]);
  }

  const segments = new Map<string, Segment[]>();
  for (const sg of seg.segments) {
    // The LAST determinable timestamp, not the first and not the session's:
    // one rule, applied to every segment metric, so two rows in the same
    // column are always assigned the same way.
    const last = [...sg.artifacts].reverse().find((a) => a.epochMs !== null);
    // Every eligible segment has a determinable timestamp by construction:
    // groups without one never reach segmentation. So there is no
    // "unassignable segment" bucket to fill here, and inventing one to report
    // as 0 would be the fabricated zero this rollup is meant to avoid.
    const m = last === undefined ? null : monthOf(last.epochMs);
    if (m === null) continue;
    segments.set(m, [...(segments.get(m) ?? []), sg]);
  }

  const months = [...new Set([...rounds.keys(), ...segments.keys()])].sort();
  const rows = months.map((month): MonthlyRow => {
    const r = rounds.get(month) ?? [];
    const sgs = segments.get(month) ?? [];
    const belowMinimum = sgs.length < minEligible;
    const perSegment = sgs.map((x) => x.artifacts.length).sort((a, b) => a - b);
    const determinate = sgs.filter((x) => lastVerdict(x) !== null);
    return {
      month,
      rounds: r.length,
      zeroCriticalRounds: r.filter((a) => a.criticalCount === 0).length,
      criticalsUnknown: r.filter((a) => a.criticalCount === null).length,
      segments: sgs.length,
      // WITHHELD, not zero: a percentile over three segments is a number about
      // three segments, and printing it beside months of hundreds invites a
      // comparison the data does not support.
      roundsPerSegmentP50: belowMinimum ? null : nearestRank(perSegment, 50),
      roundsPerSegmentP90: belowMinimum ? null : nearestRank(perSegment, 90),
      lastVerdictNotApprove: determinate.length === 0
        ? null
        : determinate.filter((x) => lastVerdict(x) !== "approve").length,
      lastVerdictUnknown: sgs.length - determinate.length,
      belowMinimum,
    };
  });

  return {
    rows,
    unassignableRounds,
    excludedGroups: seg.excludedGroups,
    suppressedSessions: suppression.suppressedSessions,
    segmentsHiddenByExclusion:
      seg.excludedGroups === 0
      && suppression.suppressedSessions === 0
      && !suppression.discoveryIncomplete
        ? 0
        : null,
    minEligible,
    rules: MONTHLY_RULES,
  };
}

/** The last verdict of a segment, or null when it cannot be determined. */
export function lastVerdict(s: Segment): string | null {
  const last = s.artifacts[s.artifacts.length - 1];
  return last && last.verdict ? last.verdict : null;
}

/**
 * The worst state for ONE population, across roots.
 *
 * SCOPED TO THE POPULATION, and that scoping is the whole point. The scan
 * report keys its states `p1:<root>` and `p2:<root>` together, so reducing over
 * every key would let a failed `state.json` read mark a COMPLETE artifact
 * reconstruction PARTIAL -- discarding good evidence over an unrelated defect,
 * which is exactly what classifying failures by affected population exists to
 * prevent. Within a population it takes the WORST: an aggregate is only as
 * complete as its least complete input, so incompleteness propagates across
 * roots and never averages.
 *
 * A population with no keys at all is EMPTY: nothing was scanned for it.
 */
export function populationScanState(
  state: Readonly<Record<string, ScanState>>,
  population: PopulationId,
): ScanState {
  return worstScanState(
    Object.fromEntries(
      Object.entries(state).filter(([k]) => k === population || k.startsWith(`${population}:`)),
    ),
  );
}

/**
 * The worst state across whatever is passed in. Prefer `populationScanState`;
 * this is the reduction it uses, exported for the aggregate case where every
 * key genuinely belongs to the same population.
 */
export function worstScanState(state: Readonly<Record<string, ScanState>>): ScanState {
  const values = Object.values(state);
  if (values.length === 0) return "EMPTY";
  // UNAVAILABLE means NOTHING was read, so it only survives aggregation when
  // that is true of every input. One unreadable root beside a readable one is
  // PARTIAL: something WAS read, and the aggregate can still publish a
  // numerator over it. Returning UNAVAILABLE there would discard a whole
  // readable root's evidence because a different root failed.
  if (values.every((v) => v === "UNAVAILABLE")) return "UNAVAILABLE";
  if (values.includes("UNAVAILABLE") || values.includes("PARTIAL")) return "PARTIAL";
  if (values.every((v) => v === "EMPTY")) return "EMPTY";
  return "COMPLETE";
}
