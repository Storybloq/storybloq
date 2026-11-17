/**
 * T-499: the session-intel subtree of a presence record.
 *
 * Zero-dependency on purpose: this file sits on the slim presence binary's
 * import graph (test/presence/presence-wiring.test.ts is the gate), because
 * `record.ts` must PRESERVE this subtree across the hook events it handles
 * and cannot preserve what it cannot parse. Nothing in here computes
 * pressure; the heavy path (`src/core/session-intel/`) does that and writes
 * the result here through `applyPresenceEnrichment`. The hook only carries it.
 *
 * Every field is validated on READ with the same caps the writer applies, so
 * a hand-edited file cannot smuggle an oversized value through parsing and
 * back out through a later legitimate write -- the T-477 rule, applied again.
 */

import { capString } from "./redaction.js";

/**
 * Ceiling on the SERIALIZED subtree, JSON escaping included. Enforced by the
 * parser (an over-cap subtree is shed, then refused) and by the heavy writer,
 * so a record can never carry more than this on session intel's behalf.
 */
export const MAX_SESSION_INTEL_BYTES = 4096;

export const MAX_ERA_BYTES = 64;
export const MAX_TRANSCRIPT_PATH_BYTES = 1024;
export const MAX_INCARNATION_BYTES = 64;
const MAX_ISO_BYTES = 40;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type CaptureKind = "startup" | "late" | "absent";
export type AutoCompactWindowSource = "local" | "project" | "user";
export type CeilingSource = "measured-session" | "measured-project" | "setting" | "model" | "unknown";
export type CeilingConfidence = "high" | "medium" | "low";
/**
 * ISS-1197 commit 2: `compact-needed` is a STATE MEMBER, not a flag on
 * `imperative`. Past `compactNeededPct` a handover no longer buys anything --
 * the session is close enough to the auto-compact point that the only useful
 * act is the user's `/compact` -- so every surface has to be able to say
 * something different, and a boolean beside `imperative` would leave each of
 * them free to keep saying "write a handover".
 */
export type TokenPressureState = "ok" | "advisory" | "imperative" | "compact-needed" | "unknown";
export type SampledBy = "stop-hook" | "prompt-hook" | "session-start" | "query" | "mcp-refresh";

/**
 * The compaction epoch a sample belongs to. `observed.at` is always a
 * transcript `compact_boundary` timestamp; `assumed.at` is the `at` of a
 * pending file that expired with its boundary out of reach; `unobserved`
 * means no scan has seen a boundary yet -- never that none occurred.
 */
export type Epoch =
  | { readonly kind: "observed"; readonly at: string }
  | { readonly kind: "assumed"; readonly at: string }
  | { readonly kind: "unobserved" };

export interface SessionIntelAnchor {
  readonly offset: number;
  readonly sha256: string;
}

/** What one transcript scan proved about the file it read. */
export interface SessionIntelObservation {
  readonly era: string | null;
  readonly incarnation: string;
  readonly sizeAtOpen: number;
  readonly consumedOffset: number;
  readonly anchor: SessionIntelAnchor;
  readonly authoritative: boolean;
  readonly revisionSeen: number | null;
  readonly lastRecordTimestamp: string | null;
  readonly epoch: Epoch;
}

/**
 * T-501: the advisory's INPUTS as the record keeps them -- never the decision.
 * Eligibility is recomputed from the current config at render time, so raising,
 * lowering or zeroing `recommendedWindowMax` changes the outcome without
 * waiting for a new sample.
 */
export interface SessionIntelUsageInput {
  readonly window: number | null;
  readonly source: AutoCompactWindowSource | null;
  readonly oneMillionFlag: boolean | null;
}

/** The compact form of a pressure sample that the presence record retains. */
export interface SessionIntelSample {
  readonly sampledAt: string;
  readonly sampledBy: SampledBy;
  readonly state: TokenPressureState;
  readonly rawState: TokenPressureState;
  readonly pct: number | null;
  readonly contextTokens: number | null;
  readonly ceiling: number | null;
  readonly ceilingSource: CeilingSource;
  readonly ceilingConfidence: CeilingConfidence | null;
  readonly observation: SessionIntelObservation;
  readonly imperativeSince: string | null;
  /**
   * ISS-1428: "handover" when a covering handover holds an imperative at
   * advisory, "rule" when the session's own handover rule does. "rate-limit"
   * is no longer produced and is still decoded, so an older stored sample
   * keeps parsing.
   */
  readonly suppressedBy: "handover" | "rule" | "rate-limit" | null;
  /** T-501: null on an older record, or when a malformed value was refused. */
  readonly usageInput: SessionIntelUsageInput | null;
}

export interface SessionIntelPresence {
  /** Process era (`<pid>:<epochSeconds>`) this capture belongs to; null when unproven. */
  readonly era: string | null;
  /** Bumped by a detected truncation, a compaction reset, or an era change. Samples carry the revision they saw. */
  readonly revision: number;
  readonly captureKind: CaptureKind;
  readonly autoCompactWindowAtStart: number | null;
  readonly autoCompactWindowSource: AutoCompactWindowSource | null;
  readonly capturedAt: string | null;
  readonly transcriptPath: string | null;
  readonly epoch: Epoch;
  /** The newest transcript boundary applied to this record. The identity of the current compaction. */
  readonly lastBoundaryAt: string | null;
  readonly consumedOffset: number;
  readonly incarnation: string | null;
  readonly baselineAnchor: SessionIntelAnchor | null;
  readonly lastSample: SessionIntelSample | null;
  readonly handoverWrittenAt: string | null;
  readonly tokensAtHandover: number | null;
  readonly handoverBoundaryAt: string | null;
  // ISS-1428: `promptsSinceHandover` and `lastImperativeAt` (the ISS-1197
  // re-arm counters) are no longer kept. They are dropped on read and never
  // written; storybloq 1.16.0 reads their absence as 0 and null, the values
  // it would otherwise have been given.
  /**
   * ISS-1263: how the handover stamp was bound. "unbound-era" is a stamp the
   * MCP server wrote without proving its process era (unknown, or unverifiable
   * under load) on a live record for the same session id; it holds the
   * imperative exactly like a bound one. ISS-1316: "derived" is a stamp the
   * prompt hook wrote from a handover file on disk, because a server that
   * predates the build could not stamp. Null is a stamp written before the
   * field existed, or none.
   */
  readonly handoverStampBinding: "bound" | "unbound-era" | "derived" | null;
  /**
   * ISS-1263: when a surface last DELIVERED the imperative line to the model,
   * claimed under the record lock by `claimImperativeEmission`. The hard rate
   * limit reads it: the line is delivered at most once per
   * `handoverRearmIntervalMs`, whether or not any stamp lands. A stamp never
   * clears it; a new compaction does. Never shed: shedding it would let the
   * line fire again at once.
   */
  readonly lastImperativeEmittedAt: string | null;
  /**
   * T-501: when the usage-cost advisory was shown for this session. Written
   * once, inside the record lock, and never shed: shedding it would show the
   * advisory again on the next priming call.
   */
  readonly usageAdvisoryShownAt: string | null;
  /**
   * ISS-1428: the compact-needed band's notice was delivered in this era.
   * `lastImperativeEmittedAt` is the imperative band's mark. Both are cleared
   * by a compaction reset and by the heal (a fall in tokens).
   */
  readonly compactNeededEmittedAt: string | null;
  /** ISS-1428: context tokens of the sample the latest notice was claimed on; the heal compares against it. */
  readonly noticeTokens: number | null;
  /** ISS-1428: the handover file name the stamp was made for; null for an older stamp or none. */
  readonly handoverFile: string | null;
  /** ISS-1428: the text given to `session alert --covered-by`; null when the stamp is a handover or there is none. */
  readonly coveredBy: string | null;
  /**
   * ISS-1428: the era that ended at `boundaryAt` reached the imperative line
   * with no stamp. The catch-up notice is owed until a stamp lands, a rule
   * settles it, the catch-up is claimed, or the next reset decides again.
   */
  readonly owed: SessionIntelOwed | null;
  /** ISS-1428: this session's handovers live elsewhere; set by `session alert --handovers elsewhere`. */
  readonly rule: SessionIntelRule | null;
  /**
   * ISS-1428: this session's own threshold override, set by `session alert
   * --imperative-pct / --imperative-headroom`; cleared by `--reset-thresholds`
   * and SessionEnd. Read by `effectiveThresholds`, which ignores it whole when
   * its pct no longer sits between the project's advisory and compact values.
   */
  readonly override: SessionIntelOverride | null;
  /**
   * ISS-1428: advanced by every write that can change a notice decision (a
   * claim, a stamp, a heal, a reset, a rule write). A notice claim must see the
   * generation it decided on.
   */
  readonly policyGen: number;
}

export interface SessionIntelOwed {
  readonly boundaryAt: string;
  readonly eraStartAt: string | null;
}

export interface SessionIntelOverride {
  readonly imperativePct: number | null;
  readonly imperativeHeadroomTokens: number | null;
}

export interface SessionIntelRule {
  readonly handovers: "elsewhere";
  readonly where: string | null;
  readonly setAt: string;
}

/** ISS-1428: a handover file name the stamp may record: a bare `.md` name, never a path. */
export const MAX_HANDOVER_FILE_BYTES = 128;
const HANDOVER_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
/** ISS-1428: `session alert --covered-by` text, one line. */
export const MAX_COVERED_BY_BYTES = 300;
/** ISS-1428: `session alert --where` text, one line. */
export const MAX_RULE_WHERE_BYTES = 200;

const CAPTURE_KINDS: ReadonlySet<string> = new Set(["startup", "late", "absent"]);
const WINDOW_SOURCES: ReadonlySet<string> = new Set(["local", "project", "user"]);
const CEILING_SOURCES: ReadonlySet<string> = new Set(["measured-session", "measured-project", "setting", "model", "unknown"]);
const CONFIDENCES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
const STATES: ReadonlySet<string> = new Set(["ok", "advisory", "imperative", "compact-needed", "unknown"]);
const SAMPLED_BY: ReadonlySet<string> = new Set(["stop-hook", "prompt-hook", "session-start", "query", "mcp-refresh"]);

/** A brand-new subtree with nothing proven yet. */
export function emptySessionIntel(): SessionIntelPresence {
  return {
    era: null,
    revision: 0,
    captureKind: "absent",
    autoCompactWindowAtStart: null,
    autoCompactWindowSource: null,
    capturedAt: null,
    transcriptPath: null,
    epoch: { kind: "unobserved" },
    lastBoundaryAt: null,
    consumedOffset: 0,
    incarnation: null,
    baselineAnchor: null,
    lastSample: null,
    handoverWrittenAt: null,
    tokensAtHandover: null,
    handoverBoundaryAt: null,
    handoverStampBinding: null,
    lastImperativeEmittedAt: null,
    usageAdvisoryShownAt: null,
    compactNeededEmittedAt: null,
    noticeTokens: null,
    handoverFile: null,
    coveredBy: null,
    owed: null,
    rule: null,
    override: null,
    policyGen: 0,
  };
}

/**
 * Lenient parse. Structurally wrong -> null (the record carries no intel);
 * a malformed OPTIONAL part (a sample, an anchor) is dropped rather than
 * failing the whole subtree, so one bad sample never erases a capture.
 * An over-cap subtree is shed (`SESSION_INTEL_SHED_STEPS`) and refused if it
 * still does not fit.
 */
export function parseSessionIntel(value: unknown): SessionIntelPresence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const captureKind = typeof v.captureKind === "string" && CAPTURE_KINDS.has(v.captureKind) ? (v.captureKind as CaptureKind) : "absent";
  const parsed: SessionIntelPresence = {
    era: identityOrNull(v.era, MAX_ERA_BYTES),
    revision: safeInt(v.revision, 0),
    captureKind,
    autoCompactWindowAtStart: positiveIntOrNull(v.autoCompactWindowAtStart),
    autoCompactWindowSource:
      typeof v.autoCompactWindowSource === "string" && WINDOW_SOURCES.has(v.autoCompactWindowSource)
        ? (v.autoCompactWindowSource as AutoCompactWindowSource)
        : null,
    capturedAt: isoOrNull(v.capturedAt),
    transcriptPath: capString(v.transcriptPath, MAX_TRANSCRIPT_PATH_BYTES),
    epoch: parseEpoch(v.epoch),
    lastBoundaryAt: isoOrNull(v.lastBoundaryAt),
    consumedOffset: safeInt(v.consumedOffset, 0),
    incarnation: identityOrNull(v.incarnation, MAX_INCARNATION_BYTES),
    baselineAnchor: parseAnchor(v.baselineAnchor),
    lastSample: parseSample(v.lastSample),
    handoverWrittenAt: isoOrNull(v.handoverWrittenAt),
    tokensAtHandover: nonNegativeIntOrNull(v.tokensAtHandover),
    handoverBoundaryAt: isoOrNull(v.handoverBoundaryAt),
    handoverStampBinding: v.handoverStampBinding === "bound" || v.handoverStampBinding === "unbound-era" || v.handoverStampBinding === "derived" ? v.handoverStampBinding : null,
    lastImperativeEmittedAt: isoOrNull(v.lastImperativeEmittedAt),
    usageAdvisoryShownAt: isoOrNull(v.usageAdvisoryShownAt),
    compactNeededEmittedAt: isoOrNull(v.compactNeededEmittedAt),
    noticeTokens: nonNegativeIntOrNull(v.noticeTokens),
    handoverFile: handoverFileOrNull(v.handoverFile),
    coveredBy: oneLineOrNull(v.coveredBy, MAX_COVERED_BY_BYTES),
    owed: parseOwed(v.owed),
    rule: parseRule(v.rule),
    override: parseOverride(v.override),
    policyGen: safeInt(v.policyGen, 0),
  };
  return fitSessionIntel(parsed);
}

/** Serialized size of the subtree as it would land inside the record. */
export function sessionIntelBytes(intel: SessionIntelPresence): number {
  return Buffer.byteLength(JSON.stringify(intel), "utf-8");
}

/**
 * The subtree's own shedding ladder. First the display text (ISS-1428): the
 * handover file name, the `--covered-by` text and the rule's `where` are read
 * by no decision, and every text that names them has a true fallback. Then
 * the transcript path, a locate HINT with two fallbacks; then, last, the
 * sample, which the notice is decided on (no legal input reaches this step:
 * pinned in test). Capture, epoch, revision, boundary,
 * baseline, handover, notice and rule fields are never shed -- losing any of
 * them changes a verdict, not a display.
 */
export function shedDisplayText(i: SessionIntelPresence): SessionIntelPresence {
  return { ...i, handoverFile: null, coveredBy: null, rule: i.rule === null ? null : { ...i.rule, where: null } };
}

export const SESSION_INTEL_SHED_STEPS: ReadonlyArray<(i: SessionIntelPresence) => SessionIntelPresence> = [
  shedDisplayText,
  (i) => ({ ...i, transcriptPath: null }),
  (i) => ({ ...i, lastSample: null }),
];

/**
 * Sheds until the subtree fits `cap` (the real cap by default; a parameter so
 * the ladder can be exercised deterministically, since the per-field caps keep
 * every legal subtree under the real one -- pinned in test). Null when it
 * cannot fit.
 */
export function fitSessionIntel(intel: SessionIntelPresence, cap = MAX_SESSION_INTEL_BYTES): SessionIntelPresence | null {
  let current = intel;
  for (let step = 0; ; step++) {
    if (sessionIntelBytes(current) <= cap) return current;
    const next = SESSION_INTEL_SHED_STEPS[step];
    if (!next) return null;
    current = next(current);
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers -- hand-rolled, matching record.ts's style (no schema library
// may reach the slim binary).
// ---------------------------------------------------------------------------

/**
 * IDENTITY strings (era, incarnation) are compared for exact equality, so an
 * oversized one is refused, never truncated: a truncation could turn an
 * invalid value into a different, apparently valid provenance (the same rule
 * `parseOwnerIdentity` applies to `clientTaskId`).
 */
function identityOrNull(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  return Buffer.byteLength(value, "utf-8") <= maxBytes ? value : null;
}

function finitePositiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ISO_BYTES) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function safeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseEpoch(value: unknown): Epoch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unobserved" };
  const v = value as Record<string, unknown>;
  if (v.kind === "observed" || v.kind === "assumed") {
    const at = isoOrNull(v.at);
    return at === null ? { kind: "unobserved" } : { kind: v.kind, at };
  }
  return { kind: "unobserved" };
}

function parseAnchor(value: unknown): SessionIntelAnchor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.offset !== "number" || !Number.isSafeInteger(v.offset) || v.offset < 0) return null;
  if (typeof v.sha256 !== "string" || !SHA256_HEX.test(v.sha256)) return null;
  return { offset: v.offset, sha256: v.sha256 };
}

function parseObservation(value: unknown): SessionIntelObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const incarnation = identityOrNull(v.incarnation, MAX_INCARNATION_BYTES);
  const anchor = parseAnchor(v.anchor);
  if (!incarnation || !anchor) return null;
  return {
    era: identityOrNull(v.era, MAX_ERA_BYTES),
    incarnation,
    sizeAtOpen: safeInt(v.sizeAtOpen, 0),
    consumedOffset: safeInt(v.consumedOffset, 0),
    anchor,
    authoritative: v.authoritative === true,
    revisionSeen: nonNegativeIntOrNull(v.revisionSeen),
    lastRecordTimestamp: isoOrNull(v.lastRecordTimestamp),
    epoch: parseEpoch(v.epoch),
  };
}

function parseSample(value: unknown): SessionIntelSample | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const sampledAt = isoOrNull(v.sampledAt);
  const observation = parseObservation(v.observation);
  if (!sampledAt || !observation) return null;
  if (typeof v.sampledBy !== "string" || !SAMPLED_BY.has(v.sampledBy)) return null;
  if (typeof v.state !== "string" || !STATES.has(v.state)) return null;
  if (typeof v.ceilingSource !== "string" || !CEILING_SOURCES.has(v.ceilingSource)) return null;
  const rawState = typeof v.rawState === "string" && STATES.has(v.rawState) ? (v.rawState as TokenPressureState) : (v.state as TokenPressureState);
  const pct = typeof v.pct === "number" && Number.isFinite(v.pct) && v.pct >= 0 ? v.pct : null;
  return {
    sampledAt,
    sampledBy: v.sampledBy as SampledBy,
    state: v.state as TokenPressureState,
    rawState,
    pct,
    contextTokens: nonNegativeIntOrNull(v.contextTokens),
    // Ceilings are fractional by construction (ceilingFraction x window, or a
    // median of an even-sized boundary set), so an integer rule here would
    // silently null a valid ceiling on every read.
    ceiling: finitePositiveOrNull(v.ceiling),
    ceilingSource: v.ceilingSource as CeilingSource,
    ceilingConfidence: typeof v.ceilingConfidence === "string" && CONFIDENCES.has(v.ceilingConfidence) ? (v.ceilingConfidence as CeilingConfidence) : null,
    observation,
    imperativeSince: isoOrNull(v.imperativeSince),
    suppressedBy: v.suppressedBy === "handover" || v.suppressedBy === "rule" || v.suppressedBy === "rate-limit" ? v.suppressedBy : null,
    // A malformed input is refused on its own; it must never cost the record
    // the sample around it (the same rule the sample gets inside the subtree).
    usageInput: parseUsageInput(v.usageInput),
  };
}

export function handoverFileOrNull(value: unknown): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf-8") > MAX_HANDOVER_FILE_BYTES) return null;
  return HANDOVER_FILE.test(value) ? value : null;
}

/**
 * One line of user text, refused (never truncated) when over the cap, empty,
 * or carrying a control character. Refusing control characters also bounds
 * the JSON escaping of the field to twice its bytes.
 */
export function oneLineOrNull(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (Buffer.byteLength(value, "utf-8") > maxBytes) return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f\u2028\u2029]/.test(value) ? null : value;
}

function parseOwed(value: unknown): SessionIntelOwed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const boundaryAt = isoOrNull(v.boundaryAt);
  if (boundaryAt === null) return null;
  return { boundaryAt, eraStartAt: isoOrNull(v.eraStartAt) };
}

function parseOverride(value: unknown): SessionIntelOverride | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const pct = typeof v.imperativePct === "number" && Number.isFinite(v.imperativePct) && v.imperativePct > 0 && v.imperativePct < 1 ? v.imperativePct : null;
  const headroom = positiveIntOrNull(v.imperativeHeadroomTokens);
  if (pct === null && headroom === null) return null;
  return { imperativePct: pct, imperativeHeadroomTokens: headroom };
}

function parseRule(value: unknown): SessionIntelRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.handovers !== "elsewhere") return null;
  const setAt = isoOrNull(v.setAt);
  if (setAt === null) return null;
  const where = v.where === undefined || v.where === null ? null : oneLineOrNull(v.where, MAX_RULE_WHERE_BYTES);
  if (where === null && v.where !== undefined && v.where !== null) return null;
  return { handovers: "elsewhere", where, setAt };
}

function parseUsageInput(value: unknown): SessionIntelUsageInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const window = v.window === undefined || v.window === null ? null : positiveIntOrNull(v.window);
  if (window === null && v.window !== undefined && v.window !== null) return null;
  const source = v.source === undefined || v.source === null
    ? null
    : typeof v.source === "string" && WINDOW_SOURCES.has(v.source)
      ? (v.source as AutoCompactWindowSource)
      : undefined;
  if (source === undefined) return null;
  const oneMillionFlag = v.oneMillionFlag === undefined || v.oneMillionFlag === null ? null : v.oneMillionFlag === true ? true : v.oneMillionFlag === false ? false : undefined;
  if (oneMillionFlag === undefined) return null;
  if (window === null && source === null && oneMillionFlag === null) return null;
  return { window, source, oneMillionFlag };
}
