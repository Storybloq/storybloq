/**
 * T-499: `computeSample`, the PURE half of the sampler. Given a scan, a
 * ceiling and the presence record as it stands, it decides the state:
 *
 *   advisory    contextTokens >= advisoryPct x ceiling, or the ceiling
 *               carries a conflict;
 *   imperative  ceiling - contextTokens <= imperativeHeadroomTokens AND
 *               contextTokens >= imperativePct x ceiling, so the later of
 *               the two lines (T-533, owner ruling r-awey8xrtwqf1r005);
 *               jumpAllowance is reported only and no longer widens the
 *               rule; jumpAllowance = clamp(p90 of
 *               per-assistant deltas since the epoch, floor, cap), floor
 *               when fewer than 5 deltas;
 *   compact-needed
 *               contextTokens >= compactNeededPct x ceiling, decided before
 *               the imperative rule and without the jump allowance, and never
 *               suppressed by a handover (ISS-1197 commit 2);
 *   suppressed  ISS-1428: an imperative raw state reads advisory when the
 *               era is covered (`eraCovered`: a stamp for this compaction
 *               written no more than the headroom before the imperative line),
 *               and an imperative or compact-needed one reads advisory under
 *               the record's own handover rule. The re-arm gates and the rate
 *               limit are gone: the notice is shown once per band per era.
 *
 * `imperativeSince` is informational only and takes no part in suppression.
 * The I/O half (locate, scan, reconcile, persist) lives with the presence
 * bridge; this file has no file access at all.
 */

import type { SessionIntelPresence, TokenPressureState } from "../../presence/session-intel-fields.js";
import type { SessionIntelConfig } from "./config.js";
import { effectiveThresholds, emptyBandReason, eraCovered } from "./policy.js";
import type { CeilingResolution, SampledBy, ScanResult, TokenPressureSample, UsageAdvisory, UsageAdvisoryInput } from "./types.js";

export interface ComputeSampleInput {
  readonly scan: ScanResult;
  readonly ceiling: CeilingResolution;
  readonly cfg: SessionIntelConfig;
  readonly sampledBy: SampledBy;
  readonly sampledAt: string;
  /** The target's presence subtree as it is NOW (null when none). */
  readonly record: SessionIntelPresence | null;
  /** T-501: resolved by the caller (query.ts) from the TARGET's capture; this file reads no settings file. */
  readonly usage: UsageAdvisoryInput;
}

export const MIN_DELTAS_FOR_P90 = 5;

export function p90(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1);
  return s[Math.max(0, idx)]!;
}

export function jumpAllowanceFor(deltas: readonly number[], cfg: SessionIntelConfig): { value: number; basis: string } {
  const floor = cfg.jumpAllowanceFloorTokens;
  const cap = cfg.jumpAllowanceCapTokens;
  if (deltas.length < MIN_DELTAS_FOR_P90) {
    return { value: floor, basis: `floor ${floor} (${deltas.length} deltas since epoch, fewer than ${MIN_DELTAS_FOR_P90})` };
  }
  const p = p90(deltas)!;
  const value = Math.min(cap, Math.max(floor, p));
  const clamped = value === p ? "" : value === floor ? ", raised to floor" : ", capped";
  return { value, basis: `p90 of ${deltas.length} per-turn deltas since epoch = ${p}${clamped}` };
}

/**
 * T-501: the usage-cost advisory as a pure function of the resolved inputs
 * and the CURRENT config, so raising, lowering or zeroing
 * `recommendedWindowMax` changes the outcome without a new sample.
 *
 * An observed window decides on its own: above the max it is the advisory,
 * at or under it there is nothing to say -- including for a 1M-context model,
 * which compacts at the window, not at its native capacity. The model kind is
 * therefore reserved for the case where NO window was observed and nothing
 * bounds the context below 1,000,000.
 */
export function usageAdvisoryFrom(
  input: Pick<UsageAdvisoryInput, "window" | "source">,
  oneMillionFlag: boolean | null,
  cfg: SessionIntelConfig,
): UsageAdvisory | null {
  const recommendedMax = cfg.recommendedWindowMax;
  if (recommendedMax === 0) return null;
  if (input.window !== null) {
    return input.window > recommendedMax
      ? { kind: "window", observed: input.window, source: input.source, recommendedMax }
      : null;
  }
  return oneMillionFlag === true ? { kind: "model", nativeWindow: 1_000_000, recommendedMax } : null;
}

export function computeSample(input: ComputeSampleInput): TokenPressureSample {
  const { scan, ceiling, cfg, record } = input;
  const common = {
    sampledAt: input.sampledAt,
    sampledBy: input.sampledBy,
    observation: scan.observation,
    contextTokens: scan.contextTokens,
    lastAssistantAt: scan.lastAssistantAt,
    lastAssistantModel: scan.lastAssistantModel,
    oneMillionFlag: scan.oneMillionFlag,
    modelEvidence: scan.modelEvidence,
    ceiling,
    usageInput: input.usage,
    usageAdvisory: usageAdvisoryFrom(input.usage, scan.oneMillionFlag, cfg),
  };
  const previousSince = record?.lastSample?.imperativeSince ?? null;

  if (scan.contextTokens === null) {
    return { ...common, pct: null, headroom: null, jumpAllowance: null, jumpAllowanceBasis: "no assistant usage record in the scanned window", state: "unknown", rawState: "unknown", suppressedBy: null, imperativeSince: null, reason: "no assistant usage record in the scanned window" };
  }
  if (ceiling.ceiling === null) {
    return { ...common, pct: null, headroom: null, jumpAllowance: null, jumpAllowanceBasis: "no ceiling", state: "unknown", rawState: "unknown", suppressedBy: null, imperativeSince: null, reason: `ceiling unknown: ${ceiling.basis}` };
  }

  const tokens = scan.contextTokens;
  const c = ceiling.ceiling;
  const jump = jumpAllowanceFor(scan.deltas, cfg);
  const pct = tokens / c;
  const headroom = Math.max(0, Math.round(c - tokens));

  // ISS-1428: the lines come from the one helper every reader shares. The
  // imperative line is the later of the share and the headroom lines (T-533,
  // owner ruling r-awey8xrtwqf1r005), never relaxed. compact-needed is decided
  // FIRST, on the measured tokens alone: the two bands overlap by construction
  // and imperative would otherwise win every time. When the imperative line is
  // at or past the compact line the imperative band is empty and the state
  // goes from advisory straight to compact-needed.
  const th = effectiveThresholds(cfg, record, c);
  const headroomLimit = th.imperativeHeadroomTokens;
  let rawState: TokenPressureState = "ok";
  if (tokens >= th.compactLine!) rawState = "compact-needed";
  else if (tokens >= th.imperativeLine!) rawState = "imperative";
  else if (tokens >= th.advisoryPct * c || ceiling.conflict !== null) rawState = "advisory";

  let state = rawState;
  let suppressedBy: "handover" | "rule" | null = null;
  const covered = record !== null && eraCovered(record, th);
  if (record?.rule && (rawState === "imperative" || rawState === "compact-needed")) {
    state = "advisory";
    suppressedBy = "rule";
  } else if (rawState === "imperative" && covered) {
    state = "advisory";
    suppressedBy = "handover";
  }
  // At compact-needed the imperative condition is satisfied too (the tokens
  // alone already clear the higher line), so the stamp continues rather than
  // being cleared and re-taken on the way past.
  const imperativeSince = rawState === "imperative" || rawState === "compact-needed" ? previousSince ?? input.sampledAt : null;
  // Both clauses hold at an imperative. The reason names the one whose line
  // is HIGHER in tokens: the one that was reached last and so decided it. It
  // depends on the ceiling and the config only, so it never flips.
  const pctDecides = th.imperativePct * c >= c - headroomLimit;
  const imperativeBasis = pctDecides
    ? `${tokens} >= ${th.imperativePct} x ${Math.round(c)} (${Math.round(c - tokens)} tokens left)`
    : `${tokens} leaves headroom ${Math.round(c - tokens)} <= imperativeHeadroomTokens ${headroomLimit} (and is past ${th.imperativePct} x ${Math.round(c)})`;
  const held = suppressedBy === "rule"
    ? "; held at advisory by this session's handover rule"
    : suppressedBy === "handover"
      ? "; held at advisory: a handover covers this compaction"
      : "";
  const empty = emptyBandReason(th);
  const base =
    rawState === "compact-needed"
      ? `${tokens} >= ${th.compactNeededPct} x ${Math.round(c)}; auto-compaction is close`
      : rawState === "imperative"
        ? imperativeBasis
        : rawState === "advisory"
          ? ceiling.conflict && tokens < th.advisoryPct * c
            ? `ceiling conflict: ${ceiling.conflict}`
            : `${tokens} >= ${th.advisoryPct} x ${Math.round(c)}`
          : null;
  const reason = base === null ? null : `${base}${held}${empty ? `; ${empty}` : ""}`;

  return { ...common, pct, headroom, jumpAllowance: jump.value, jumpAllowanceBasis: jump.basis, state, rawState, suppressedBy, imperativeSince, reason };
}
