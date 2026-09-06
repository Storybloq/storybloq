/**
 * T-432: the shape of a review-stats result.
 *
 * THIS FILE IS THE HONESTY CONTRACT, and it is a separate file because the
 * contract has to be readable without reading the computation. Four rounds of
 * plan review removed, in order, a false lower bound on a reconstructed count,
 * a completion claim, a backlog-change claim, a reopen claim, an inverted
 * denominator invariant and a units conflation. Every one of them would have
 * shipped as a number that looked authoritative. The types below exist so the
 * next such mistake fails to compile rather than fails to be noticed.
 *
 * THREE RULES, encoded rather than documented:
 *
 *  1. Populations do not mix. `computeP1` accepts `P1Input` and nothing else,
 *     so a P1 metric CANNOT read a state array or an event even by accident. A
 *     provenance label is a claim; an input type is a guarantee.
 *  2. Records and segments are different units and share no denominator. A
 *     segment-denominated metric carries `segments` as well as `records`, and
 *     the two are never added.
 *  3. Absence is never zero. `rate` is `null` whenever the denominator is null
 *     or zero, and the renderer prints "-" for null. There is no code path that
 *     turns an empty denominator into `0`.
 */

/** How a number was arrived at. Declared per metric, never inferred. */
export type Provenance =
  /** Read from a field on a record. */
  | "observed"
  /** Computed from observed fields by a stated rule. */
  | "derived"
  /** Depends on a reconstructed grouping or ordering. */
  | "reconstructed";

/** Fixed namespaces. A metric belongs to exactly one. */
export type PopulationId = "p1" | "p2" | "p3" | "ledger";

/**
 * What the scan managed to see, per population per root.
 *
 * `PARTIAL` and `UNAVAILABLE` are not degrees of the same thing. UNAVAILABLE
 * means nothing was read; PARTIAL means some was. Both make the population
 * TOTAL unknown, which is why `RecordCounts.total` is nullable: a partial scan
 * can supply a valid numerator over what it read and still cannot say how many
 * records exist.
 */
export type ScanState = "COMPLETE" | "EMPTY" | "UNAVAILABLE" | "PARTIAL";

/**
 * How far a read failure's uncertainty reaches.
 *
 * Classified by SCOPE, not by which operation failed. Failing to list one known
 * session's artifact directory hides no other session and must not be treated
 * like a failure to list the root, which can hide whole sessions.
 */
export type FailureScope =
  /** One file failed to read. Its owning session is known. */
  | "record"
  /** Confined to a session whose existence is established. */
  | "known-session"
  /** The root's session listing failed, or an entry could not be classified. */
  | "root-discovery";

export type MetricUnit = "round" | "finding" | "segment" | "session" | "issue";

/**
 * Whether the quotient is a SHARE OF a denominator or a MEAN PER one.
 *
 * Required, because rendering cannot infer it and getting it wrong produces a
 * number that is not merely mislabelled but impossible: "rounds per segment"
 * printed as a proportion reads `126.5%`, and a share above 100% tells a reader
 * the tool is broken while a mean of 1.27 tells them what actually happened.
 * Caught by running the command against the live ledger, not by the type.
 */
export type MetricKind = "proportion" | "mean";

/**
 * Source-record accounting. On every metric.
 *
 * `missing` and `invalid` are counted ONLY among readable records. A read
 * failure is neither: it is counted in `readFailures` on the scan report, so a
 * file that could not be opened can never be reported as a record whose field
 * was absent.
 */
export interface RecordCounts {
  /** Population size. NULL whenever discovery was incomplete. */
  readonly total: number | null;
  /** Records actually read. */
  readonly readable: number;
  /** Readable records whose field is absent. */
  readonly missing: number;
  /** Readable records whose field is present and unusable. */
  readonly invalid: number;
}

/**
 * Metric-unit accounting, on segment-denominated metrics ONLY.
 *
 * Kept apart from `RecordCounts` because artifacts, groups and segments are
 * three units. An earlier draft ran one model over all three and filed excluded
 * groups under the record-level `invalid`, which puts a quantity that is
 * unknown by construction inside one that is counted.
 */
export interface SegmentCounts {
  /** Segments whose chronology is determinate. The only valid denominator. */
  readonly eligibleSegments: number;
  /**
   * Groups excluded for indeterminate chronology. Their segment count is
   * unknown BY CONSTRUCTION: a group with tied or undated records has no
   * determinable segmentation, so this is a count of groups, never of segments.
   */
  readonly excludedGroups: number;
  /**
   * Sessions whose reconstruction was SUPPRESSED because a P1 read failed
   * inside them.
   *
   * A missing artifact does not merely reduce coverage of a segmentation: its
   * unknown round and timestamp can move the boundaries of the surviving
   * artifacts around it and change which verdict is last. So a session with an
   * unread artifact contributes nothing to any order-dependent metric, while
   * its readable records still count for the order-independent ones.
   */
  readonly suppressedSessions: number;
  /** Artifacts inside those sessions. Readable, but not reconstructable. */
  readonly suppressedArtifacts: number;
  /**
   * The SEGMENT POPULATION SIZE, not the eligible subset. NULL whenever
   * `excludedGroups > 0` or anything was suppressed.
   *
   * These are different numbers and an earlier cut set this to `eligible`,
   * which understates the population whenever a metric's eligibility is
   * narrower than "is a segment" -- and every metric here has its own
   * eligibility.
   *
   * This can be null on a COMPLETELY READABLE scan. Unreadability and
   * indeterminate chronology are different defects and only the first is a scan
   * problem.
   */
  readonly segmentTotal: number | null;
}

/**
 * One reported number, with everything needed to read it honestly.
 *
 * The renderer READS these fields. It does not compute, sum, or derive. That
 * separation is what makes the honesty properties testable on the structured
 * result rather than on rendered text, which can carry a disclosure while the
 * claim behind it is unjustified.
 */
interface MetricBase {
  readonly id: string;
  readonly label: string;
  readonly provenance: Provenance;
  readonly population: PopulationId;
  readonly scanState: ScanState;
  readonly kind: MetricKind;
  readonly numerator: number | null;
  readonly denominator: number | null;
  /**
   * The quotient, read according to `kind`. NULL whenever the denominator is
   * null or zero: never 0 for "no data".
   *
   * Named `value` rather than `rate` because half of these are means, and a
   * field called `rate` invites a renderer to append a percent sign to all of
   * them.
   */
  readonly value: number | null;
  /**
   * True when the value is computed over readable records while the population
   * total is unknown. Rendered as an explicit qualifier, never silently.
   */
  readonly conditional: boolean;
  readonly records: RecordCounts;
  /** Why a value is absent or qualified, when that needs saying. */
  readonly note?: string;
}

/**
 * A metric denominated in reconstructed segments.
 *
 * THE UNION IS THE ENFORCEMENT. A segment is a reconstruction, so a
 * segment-denominated metric MUST declare `reconstructed` and MUST carry its
 * segment accounting; both are required here rather than checked in a test,
 * because a test catches the mistake after it is written and a type refuses to
 * compile it. The previous shape permitted `unit: "segment"` beside
 * `provenance: "observed"` with no `segments` at all, which is exactly the
 * unsupported claim this file exists to prevent -- and two metrics in this very
 * module were written that way before a test caught them.
 */
export interface SegmentMetric extends MetricBase {
  readonly unit: "segment";
  readonly provenance: "reconstructed";
  readonly segments: SegmentCounts;
}

/** A metric denominated in anything else. It has no segment accounting. */
export interface NonSegmentMetric extends MetricBase {
  readonly unit: Exclude<MetricUnit, "segment">;
  readonly segments?: never;
}

export type Metric = SegmentMetric | NonSegmentMetric;

/** Omit that DISTRIBUTES over a union, so each branch keeps its own shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type MetricInput = DistributiveOmit<Metric, "value">;

/**
 * Build a metric, applying rule 3 in the one place it can be applied.
 *
 * Every metric goes through here so there is a single site where an empty
 * denominator becomes `null` rather than `0`. Callers cannot opt out: `value` is
 * not an input.
 */
export function metric(input: MetricInput): Metric {
  const { numerator, denominator } = input;
  const value =
    numerator === null || denominator === null || denominator === 0
      ? null
      : numerator / denominator;
  return { ...input, value } as Metric;
}

/** A read that failed, with the scope of what it makes uncertain. */
export interface ScanFailure {
  readonly root: string;
  readonly scope: FailureScope;
  readonly path: string;
  readonly reason: string;
  /** Known only for `record` and `known-session` scopes. */
  readonly sessionId?: string;
  /** Which populations this failure makes uncertain. */
  readonly affects: readonly PopulationId[];
}

export interface ScanReport {
  readonly roots: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Sessions may be written while the scan runs. Always true; stated anyway. */
  readonly atomic: false;
  readonly failures: readonly ScanFailure[];
  readonly readFailures: number;
  /** Per population per root. */
  readonly state: Readonly<Record<string, ScanState>>;
}

// ---------------------------------------------------------------------------
// P1: the only population with per-item identity
// ---------------------------------------------------------------------------

/** A parsed review verdict artifact. */
export interface P1Artifact {
  readonly root: string;
  readonly sessionId: string;
  readonly fileName: string;
  readonly target: string;
  readonly stage: string;
  readonly round: number | null;
  readonly verdict: string;
  readonly reviewerRaw: string;
  readonly findingsCount: number | null;
  readonly criticalCount: number | null;
  /** ISO string as written, kept for display only. Never compared. */
  readonly timestamp: string | null;
  /**
   * The instant, in epoch milliseconds. NULL when absent or unparseable.
   *
   * ORDERING AND TIE DETECTION USE THIS, NEVER THE STRING. Two spellings of one
   * instant (`...T00:00:00Z` and `...T00:00:00.000Z`) are unequal as strings, so
   * a string tie check misses a real tie; and a timestamp written with a
   * timezone offset can sort lexically in the opposite order to the instant it
   * names, which would move segment boundaries and last verdicts.
   */
  readonly epochMs: number | null;
  readonly contentHash: string | null;
  readonly originClasses: readonly unknown[];
  readonly diffLines: number | null;
}

/**
 * The ONLY input `computeP1` accepts.
 *
 * There is deliberately no field here through which a state array or an event
 * could arrive. Cross-population comparison lives in its own function with its
 * own input type, so pooling is a type error rather than a review finding.
 */
export interface P1Input {
  readonly artifacts: readonly P1Artifact[];
  readonly scan: ScanReport;
}

// ---------------------------------------------------------------------------
// P2: session state records
// ---------------------------------------------------------------------------

/** One session's state fields, for the session-denominated metrics. */
export interface P2Session {
  readonly root: string;
  readonly sessionId: string;
  /**
   * THREE STATES. `absent` is UNKNOWN (no decision recorded, and the field is
   * cleared on ceiling escalation), `malformed` is INVALID (something is there
   * and cannot be read), `present` is classifiable. Collapsing malformed into
   * absent would drop a record we know exists out of the accounting.
   */
  readonly landingField: "absent" | "malformed" | "present";
  readonly landingReason: string | null;
  readonly risk: string | null;
  readonly realizedRisk: string | null;
}

/**
 * The ONLY input `computeP2` accepts.
 *
 * Separate from `P1Input` for the same reason P1's is separate from it: the two
 * populations have different item identity and different denominators, and the
 * type is what stops one filling the other. P2 NEVER fills P1.
 */
export interface P2Input {
  readonly sessions: readonly P2Session[];
  readonly scan: ScanReport;
}
