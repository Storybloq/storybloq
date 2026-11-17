/**
 * ISS-1428 (handover lines slice C): the context notice, decided and worded in
 * one place. Every surface that pushes text into the model's context (the
 * UserPromptSubmit hook, the MCP and CLI banners, the autonomous guide) calls
 * these and nothing else decides or words a notice.
 *
 *   band      the sampler's raw state: advisory, imperative, compact-needed.
 *   era       the span between two compaction boundaries (`lastBoundaryAt`).
 *   notice    one per band per era, on whichever surface carries it first.
 *   covered   a stamp for this era whose tokens are no more than the headroom
 *             before the imperative line (or anywhere after it).
 *
 * Pure: no file access. The claim that makes a notice "delivered" lives with
 * the presence bridge (`claimNotice`) and runs `decideFromRecord` again on the
 * locked record.
 */

import type { CeilingConfidence, CeilingSource, SessionIntelPresence, SessionIntelSample } from "../../presence/session-intel-fields.js";
import type { SessionIntelConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface EffectiveThresholds {
  readonly advisoryPct: number;
  readonly imperativePct: number;
  readonly imperativeHeadroomTokens: number;
  readonly compactNeededPct: number;
  /** Null when the expected point is unknown. */
  readonly point: number | null;
  /**
   * The token count at which the imperative band starts: the later of the
   * share and the headroom lines (owner ruling r-awey8xrtwqf1r005). Never
   * relaxed.
   */
  readonly imperativeLine: number | null;
  readonly compactLine: number | null;
  /** The imperative line is at or past the compact line, so the band holds no token count at all. */
  readonly bandEmpty: boolean;
}

/**
 * The thresholds one session is held to, for every reader alike (the sampler,
 * coverage, the notice and `session alert`).
 */
export function effectiveThresholds(cfg: SessionIntelConfig, _intel: SessionIntelPresence | null, point: number | null): EffectiveThresholds {
  const imperativePct = cfg.imperativePct;
  const imperativeHeadroomTokens = cfg.imperativeHeadroomTokens;
  const known = point !== null && Number.isFinite(point) && point > 0;
  const imperativeLine = known ? Math.max(imperativePct * point, point - imperativeHeadroomTokens) : null;
  const compactLine = known ? cfg.compactNeededPct * point : null;
  return {
    advisoryPct: cfg.advisoryPct,
    imperativePct,
    imperativeHeadroomTokens,
    compactNeededPct: cfg.compactNeededPct,
    point: known ? point : null,
    imperativeLine,
    compactLine,
    bandEmpty: imperativeLine !== null && compactLine !== null && imperativeLine >= compactLine,
  };
}

/** The reason line's clause for an empty imperative band, or null. */
export function emptyBandReason(th: EffectiveThresholds): string | null {
  if (!th.bandEmpty || th.imperativeLine === null || th.compactLine === null) return null;
  return `the imperative band is empty: its line (${Math.round(th.imperativeLine)}, the later of ${th.imperativePct} x ${Math.round(th.point!)} and ${th.imperativeHeadroomTokens} tokens of headroom) is at or past the compact line (${Math.round(th.compactLine)}), so the state goes from advisory straight to compact-needed`;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** A stamp exists for the record's current era. */
export function stampedThisEra(intel: SessionIntelPresence): boolean {
  return intel.handoverWrittenAt !== null && intel.handoverBoundaryAt === intel.lastBoundaryAt;
}

/**
 * Whether the era's stamp answers the notice. It does not depend on the
 * current token count, so once it holds it holds until the boundary. A stamp
 * with unknown tokens never covers.
 */
export function eraCovered(intel: SessionIntelPresence, th: EffectiveThresholds): boolean {
  if (!stampedThisEra(intel)) return false;
  if (intel.tokensAtHandover === null || th.imperativeLine === null) return false;
  return intel.tokensAtHandover >= th.imperativeLine - th.imperativeHeadroomTokens;
}

/** The thresholds for the record's own last sample. */
export function thresholdsForRecord(intel: SessionIntelPresence, cfg: SessionIntelConfig): EffectiveThresholds {
  return effectiveThresholds(cfg, intel, intel.lastSample?.ceiling ?? null);
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** What the record alone says. */
export type NoticeCandidate = "none" | "covered" | "rule" | "ask" | "uncovered" | "catch-up";
/** The five texts. */
export type NoticeKind = "covered" | "rule" | "ask" | "uncovered" | "catch-up";
/** What a call does once the arrangement rule is known: emit a kind, settle `owed` silently, or nothing. */
export type FinalAction = NoticeKind | "settle" | null;

/**
 * The candidate from the record and its own `lastSample`. The claim runs this
 * again under the lock, on the locked record, and refuses when it differs.
 */
export function decideFromRecord(intel: SessionIntelPresence, cfg: SessionIntelConfig): NoticeCandidate {
  const s = intel.lastSample;
  if (!s) return "none";
  const raw = s.rawState;
  if (raw === "ok" || raw === "advisory") return intel.owed !== null ? "catch-up" : "none";
  if (raw !== "imperative" && raw !== "compact-needed") return "none";
  const covered = eraCovered(intel, thresholdsForRecord(intel, cfg));
  if (raw === "imperative") {
    if (intel.lastImperativeEmittedAt !== null) return "none";
    if (intel.rule !== null) return "rule";
    return covered ? "covered" : "ask";
  }
  if (intel.compactNeededEmittedAt !== null || intel.rule !== null || covered) return "none";
  return "uncovered";
}

/** A rule found on an arrangement party at notice time. */
export interface ArrangementRuleInForce {
  readonly arrangementId: string;
  readonly where: string | null;
}

/** Only these candidates look the arrangement rule up. */
export function needsArrangementRule(candidate: NoticeCandidate): boolean {
  return candidate === "ask" || candidate === "uncovered" || candidate === "catch-up";
}

export function resolveFinal(candidate: NoticeCandidate, arrangementRule: ArrangementRuleInForce | null): FinalAction {
  switch (candidate) {
    case "none": return null;
    case "covered": return "covered";
    case "rule": return "rule";
    case "ask": return arrangementRule ? "rule" : "ask";
    case "uncovered": return arrangementRule ? null : "uncovered";
    case "catch-up": return arrangementRule ? "settle" : "catch-up";
  }
}

/** The fixed table a claim checks: exactly the pairs `resolveFinal` can produce with a non-null action. */
export function finalAllowed(candidate: NoticeCandidate, final: FinalAction): boolean {
  switch (candidate) {
    case "covered": return final === "covered";
    case "rule": return final === "rule";
    case "ask": return final === "ask" || final === "rule";
    case "uncovered": return final === "uncovered";
    case "catch-up": return final === "catch-up" || final === "settle";
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

export type NoticeSurface = "hook" | "mcp" | "cli" | "guide";

export interface NoticeFacts {
  readonly used: number;
  readonly point: number;
  readonly source: CeilingSource;
  readonly confidence: CeilingConfidence | null;
}

/** The numbers of a sample, or null when either is unknown (no notice is possible then). */
export function noticeFactsOf(sample: SessionIntelSample): NoticeFacts | null {
  if (sample.contextTokens === null || sample.ceiling === null) return null;
  return { used: sample.contextTokens, point: sample.ceiling, source: sample.ceilingSource, confidence: sample.ceilingConfidence };
}

const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** `H`: the numbers first, before the percentage. */
export function noticeHead(f: NoticeFacts): string {
  const pct = Math.round((f.used / f.point) * 100);
  const where = `auto-compaction is expected near ${n(f.point)} (${f.source}${f.confidence ? `, ${f.confidence} confidence` : ""})`;
  const tail = f.used >= f.point
    ? `${n(f.used - f.point)} past the expected point (${pct}%)`
    : `about ${n(f.point - f.used)} left (${pct}%)`;
  return `Context: ${n(f.used)} tokens in use; ${where}; ${tail}.`;
}

export interface NoticeDetail {
  /** `covered`: the stamp's file, or the `--covered-by` text. */
  readonly file?: string | null;
  readonly coveredBy?: string | null;
  /** `rule`: where the rule says handovers live. */
  readonly where?: string | null;
  /** `ask` and `catch-up`: the tip of the line this session is on (commit 3). */
  readonly tip?: string | null;
}

export function renderNotice(kind: NoticeKind, facts: NoticeFacts, surface: NoticeSurface, detail: NoticeDetail = {}): string {
  const tool = surface === "cli" ? "storybloq handover create" : "storybloq_handover_create";
  const line = detail.tip ? ` It continues the line this session is on (${detail.tip}).` : "";
  const H = noticeHead(facts);
  let text: string;
  switch (kind) {
    case "ask": {
      const keep = surface === "guide" ? "keep driving the state machine" : "keep working";
      text = `${H} Write a handover now with ${tool}, then ${keep} in this same turn.${line} \`storybloq handover template\` gives the scaffold. One handover covers this compaction and this notice does not repeat before it. Do not stop and do not ask the user whether to continue: the session continues through auto-compaction.`;
      break;
    }
    case "covered":
      text = detail.coveredBy
        ? `${H} This compaction is covered by ${detail.coveredBy}: nothing to write. Keep working.`
        : `${H} Your handover ${detail.file ? `${detail.file} ` : ""}covers this compaction: nothing to write. Keep working.`;
      break;
    case "rule":
      text = `${H} No handover is asked for here: handover suppressed by session rule (${detail.where ?? "set for this session"}). Keep working.`;
      break;
    case "uncovered":
      text = `${H} No handover that covers this compaction is recorded for this session. If you already wrote one, nothing more is needed. Otherwise, if one short handover fits in a single step, write it now with ${tool}; if not, keep working and write it first thing after the compaction, from the summary. This notice is for this compaction only.`;
      break;
    case "catch-up":
      text = `No handover is recorded for this session for the auto-compaction that just happened. If you wrote one, nothing more is needed. Otherwise write one now with ${tool}, from the summary above, before new work; then keep working.${line}`;
      break;
  }
  return surface === "hook" ? `[storybloq] ${text}` : text;
}

/** The detail a kind needs, read from the record (and the arrangement rule, when that decided it). */
export function noticeDetailFor(kind: NoticeKind, intel: SessionIntelPresence, arrangementRule: ArrangementRuleInForce | null): NoticeDetail {
  if (kind === "covered") return { file: intel.handoverFile, coveredBy: intel.coveredBy };
  if (kind === "rule") {
    if (intel.rule !== null) return { where: intel.rule.where };
    if (arrangementRule !== null) return { where: arrangementRule.where ?? `set on arrangement ${arrangementRule.arrangementId}` };
  }
  return {};
}
