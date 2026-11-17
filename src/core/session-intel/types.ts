/**
 * T-499: shapes shared by the session-intel heavy path. The presence-side
 * (zero-dep) shapes live in `presence/session-intel-fields.ts` and are
 * re-exported here so core code has one import for both.
 */

import type {
  AutoCompactWindowSource,
  CaptureKind,
  CeilingConfidence,
  CeilingSource,
  Epoch,
  SampledBy,
  SessionIntelObservation,
  TokenPressureState,
} from "../../presence/session-intel-fields.js";

export type {
  AutoCompactWindowSource,
  CaptureKind,
  CeilingConfidence,
  CeilingSource,
  Epoch,
  SampledBy,
  SessionIntelObservation,
  TokenPressureState,
} from "../../presence/session-intel-fields.js";

/** Only a literal `"auto"` is measurement-eligible; anything unrecognised is `"unknown"` and serves invalidation only. */
export type CompactionTrigger = "auto" | "manual" | "unknown";

/** One `compact_boundary` record as read from a transcript. */
export interface TranscriptBoundary {
  readonly timestamp: string;
  readonly trigger: CompactionTrigger;
  readonly preTokens: number | null;
  readonly postTokens: number | null;
}

export type ModelEvidence = "tail" | "full" | "none";
export type ScanCoverage = "tail" | "full" | "partial";

export interface ObservedModel {
  readonly model: string;
  readonly firstSeenAt: string | null;
}

/** Session facts a scan observed. Every field is null until seen. */
export interface ScannedSessionFacts {
  readonly startedAt: string | null;
  readonly version: string | null;
  readonly entrypoint: string | null;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly permissionMode: string | null;
  readonly aiTitle: string | null;
  readonly slug: string | null;
  readonly bridgeSessionId: string | null;
  readonly effort: string | null;
  readonly models: readonly ObservedModel[];
  readonly turns: { readonly assistant: number; readonly user: number; readonly userIncludesPeerMessages: true; readonly observed: true } | null;
  readonly compactions: { readonly autoObserved: number; readonly manualObserved: number; readonly unknownObserved: number; readonly last: TranscriptBoundary | null };
}

/** Everything one scan proved. Pure data; the sampler turns it into pressure. */
export interface ScanResult {
  readonly observation: SessionIntelObservation;
  readonly coverage: ScanCoverage;
  readonly scannedBytes: number;
  readonly truncationReason: string | null;
  readonly contextTokens: number | null;
  readonly lastAssistantAt: string | null;
  readonly lastAssistantModel: string | null;
  readonly oneMillionFlag: boolean | null;
  readonly modelEvidence: ModelEvidence;
  /** Boundaries seen in the window, ascending by timestamp. */
  readonly boundaries: readonly TranscriptBoundary[];
  /** Positive per-assistant context deltas after the epoch, in order. */
  readonly deltas: readonly number[];
  readonly highWaterMark: number | null;
  readonly session: ScannedSessionFacts;
}

export interface TargetCapture {
  readonly captureKind: CaptureKind;
  readonly autoCompactWindowAtStart: number | null;
  readonly autoCompactWindowSource: AutoCompactWindowSource | null;
  readonly capturedAt: string | null;
}

/**
 * T-501: the inputs the usage-cost advisory is decided from, resolved for the
 * TARGET session (never the caller's live environment when a capture exists).
 *
 *   capture  a capture object was present: `window` is what the process saw at
 *            start, and a captured null (`captureKind: "absent"`) STAYS null --
 *            re-reading the file mid-session would report a window this
 *            process is not running under;
 *   live     no capture object at all: the setting is read now;
 *   none     neither -- nothing is claimed.
 */
export interface UsageAdvisoryInput {
  readonly window: number | null;
  readonly source: AutoCompactWindowSource | null;
  readonly provenance: "capture" | "live" | "none";
}

/**
 * T-501: what the advisory says, as data. The message is rendered from this at
 * push time and never stored, so wording changes need no new sample.
 *
 *   window  a window above `recommendedMax` was observed;
 *   model   the session runs a 1M-context model and NO window was observed, so
 *           nothing bounds the context below the model's own capacity. A
 *           configured window at or under the max gives no advisory at all.
 */
export type UsageAdvisory =
  | { readonly kind: "window"; readonly observed: number; readonly source: AutoCompactWindowSource | null; readonly recommendedMax: number }
  | { readonly kind: "model"; readonly nativeWindow: 1_000_000; readonly recommendedMax: number };

/** Provenance resolved for the TARGET session, never the caller. */
export interface TargetProvenance {
  readonly era: string | null;
  readonly capture: TargetCapture | null;
}

export interface CeilingResolution {
  readonly ceiling: number | null;
  readonly source: CeilingSource;
  readonly confidence: CeilingConfidence | null;
  readonly sampleCount: number;
  readonly independentSessions: number;
  readonly effectiveSampleWindow: number;
  readonly basis: string;
  readonly conflict: string | null;
  readonly autoCompactWindowAtStart: number | null;
  readonly captureKind: CaptureKind;
  readonly nativeWindow: number | null;
  readonly highWaterMark: number | null;
}

export interface TokenPressureSample {
  readonly sampledAt: string;
  readonly sampledBy: SampledBy;
  readonly observation: SessionIntelObservation;
  readonly contextTokens: number | null;
  readonly lastAssistantAt: string | null;
  readonly lastAssistantModel: string | null;
  readonly oneMillionFlag: boolean | null;
  readonly modelEvidence: ModelEvidence;
  readonly ceiling: CeilingResolution;
  readonly pct: number | null;
  readonly headroom: number | null;
  readonly jumpAllowance: number | null;
  readonly jumpAllowanceBasis: string;
  readonly state: TokenPressureState;
  readonly rawState: TokenPressureState;
  /**
   * Why the state is held below the raw band: "handover" when a stamp covers
   * this compaction, "rule" when this session's record carries a handover
   * rule (ISS-1428). "rate-limit" is no longer produced; it stays decodable
   * on records written by older versions.
   */
  readonly suppressedBy: "handover" | "rule" | "rate-limit" | null;
  readonly imperativeSince: string | null;
  readonly reason: string | null;
  /** T-501: the advisory's inputs, kept so the record can store them and the decision can be recomputed under the current config. */
  readonly usageInput: UsageAdvisoryInput;
  /** T-501: the decision under the config this sample was computed with. Never persisted. */
  readonly usageAdvisory: UsageAdvisory | null;
}

/** The unobserved epoch, for callers that have no record yet. */
export const UNOBSERVED_EPOCH: Epoch = { kind: "unobserved" };
