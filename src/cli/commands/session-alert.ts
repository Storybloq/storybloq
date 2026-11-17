/**
 * ISS-1428 (handover lines slice C, plan section 7): `storybloq session alert`,
 * telling the context alert about THIS session.
 *
 * Claude sessions only, bound caller only (the same binding `handover create`
 * stamps under), CLI only (no MCP tool). Every write is one locked
 * `applyPresenceEnrichment` on the caller's record: each flag group is
 * validated before anything is written, and one write applies them all.
 *
 *   no flags               this session's alert state (md or json)
 *   --handovers elsewhere  sets the session rule (`--where`, optional); `here` clears it
 *   --covered-by <text>    stamps this compaction as covered, through the stamp's own write path
 *   --imperative-pct / --imperative-headroom   set this session's threshold override
 *   --reset-thresholds     clears it
 */

import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { applyPresenceEnrichment, LIFECYCLE_LOCK_BUDGET_MS } from "../../core/presence-enrichment.js";
import { arrangementRuleInForce } from "../../core/session-intel/arrangement-rule.js";
import { readSessionIntelConfig, SESSION_INTEL_BOUNDS, type SessionIntelConfig } from "../../core/session-intel/config.js";
import { effectiveThresholds, emptyBandReason, eraCovered, ignoredOverrideReason, imperativePctFits, stampedThisEra, type EffectiveThresholds } from "../../core/session-intel/policy.js";
import { readPresenceRecord, resolveCallerBinding, revalidateCandidateIdentity, stampIntoRecord, type HandoverStampObservation } from "../../core/session-intel/presence-bridge.js";
import { stampModeFor } from "../../core/session-intel/push.js";
import { decideBand } from "../../core/session-intel/sampler.js";
import { isPresenceEnabled } from "../../presence/handler.js";
import { MAX_COVERED_BY_BYTES, MAX_RULE_WHERE_BYTES, oneLineOrNull, type SessionIntelOverride, type SessionIntelOwed, type SessionIntelPresence } from "../../presence/session-intel-fields.js";
import type { SessionPresence } from "../../presence/types.js";

export interface SessionAlertOptions {
  readonly format?: "md" | "json";
  readonly clientTaskId?: string;
  readonly handovers?: string;
  readonly where?: string;
  readonly coveredBy?: string;
  readonly imperativePct?: number;
  readonly imperativeHeadroom?: number;
  readonly resetThresholds?: boolean;
  /** Test seams. */
  readonly root?: string | null;
  readonly now?: number;
  /** Test seam: runs after the caller is bound, before the locked write. */
  readonly afterBinding?: () => void;
}

export interface SessionAlertResult {
  readonly output: string;
  /** Null on success; `invalid_input`, `not_bound` or `write_failed` otherwise. */
  readonly errorCode: string | null;
}

const n = (v: number) => Math.round(v).toLocaleString("en-US");

function fail(format: "md" | "json", code: string, message: string): SessionAlertResult {
  return { output: format === "json" ? JSON.stringify({ ok: false, error: { code, message } }, null, 2) : `Error: ${message}`, errorCode: code };
}

interface Plan {
  rule?: { set: false } | { set: true; where: string | null };
  coveredBy?: string;
  override?: SessionIntelOverride | null;
}

/** Each group validated on its own, before any write. Throws a message on the first refusal. */
function validate(o: SessionAlertOptions, cfg: SessionIntelConfig): Plan {
  const plan: Plan = {};
  if (o.handovers !== undefined) {
    if (o.handovers !== "elsewhere" && o.handovers !== "here") throw new Error(`--handovers must be elsewhere or here, not "${o.handovers}"`);
    if (o.handovers === "here") {
      if (o.where !== undefined) throw new Error("--where goes with --handovers elsewhere only");
      plan.rule = { set: false };
    } else {
      const where = o.where === undefined ? null : oneLineOrNull(o.where, MAX_RULE_WHERE_BYTES);
      if (o.where !== undefined && where === null) throw new Error(`--where must be one line of 1 to ${MAX_RULE_WHERE_BYTES} bytes`);
      plan.rule = { set: true, where };
    }
  } else if (o.where !== undefined) {
    throw new Error("--where goes with --handovers elsewhere");
  }
  if (o.coveredBy !== undefined) {
    const text = oneLineOrNull(o.coveredBy, MAX_COVERED_BY_BYTES);
    if (text === null) throw new Error(`--covered-by must be one line of 1 to ${MAX_COVERED_BY_BYTES} bytes`);
    plan.coveredBy = text;
  }
  const setting = o.imperativePct !== undefined || o.imperativeHeadroom !== undefined;
  if (o.resetThresholds && setting) throw new Error("--reset-thresholds cannot be combined with --imperative-pct or --imperative-headroom");
  if (o.resetThresholds) plan.override = null;
  if (setting) {
    let pct: number | null = null;
    let headroom: number | null = null;
    if (o.imperativePct !== undefined) {
      const b = SESSION_INTEL_BOUNDS.imperativePct;
      if (typeof o.imperativePct !== "number" || !Number.isFinite(o.imperativePct) || o.imperativePct < b.min || o.imperativePct > b.max) {
        throw new Error(`--imperative-pct must be a number from ${b.min} to ${b.max}`);
      }
      if (!imperativePctFits(cfg, o.imperativePct)) {
        throw new Error(`--imperative-pct must be above this project's advisoryPct (${cfg.advisoryPct}) and below its compactNeededPct (${cfg.compactNeededPct})`);
      }
      pct = o.imperativePct;
    }
    if (o.imperativeHeadroom !== undefined) {
      const b = SESSION_INTEL_BOUNDS.imperativeHeadroomTokens;
      if (typeof o.imperativeHeadroom !== "number" || !Number.isInteger(o.imperativeHeadroom) || o.imperativeHeadroom < b.min || o.imperativeHeadroom > b.max) {
        throw new Error(`--imperative-headroom must be a whole number of tokens from ${n(b.min)} to ${n(b.max)}`);
      }
      headroom = o.imperativeHeadroom;
    }
    plan.override = { imperativePct: pct, imperativeHeadroomTokens: headroom };
  }
  return plan;
}

function planIsEmpty(p: Plan): boolean {
  return p.rule === undefined && p.coveredBy === undefined && p.override === undefined;
}

export function handleSessionAlert(o: SessionAlertOptions = {}): SessionAlertResult {
  const format = o.format ?? "md";
  const root = o.root === undefined ? discoverProjectRoot() : o.root;
  if (!root) return fail(format, "not_found", "No .story/ project found.");
  const cfg = readSessionIntelConfig(root);
  if (!cfg.enabled) return fail(format, "not_bound", "sessionIntel is disabled for this project");
  if (!isPresenceEnabled(root)) return fail(format, "not_bound", "presence is disabled for this project");
  let plan: Plan;
  try {
    plan = validate(o, cfg);
  } catch (err) {
    return fail(format, "invalid_input", err instanceof Error ? err.message : String(err));
  }
  const binding = resolveCallerBinding(root, o.clientTaskId, undefined, {});
  const mode = stampModeFor(binding);
  if (mode === null || !binding.sessionId) return fail(format, "not_bound", `session alert works only for the calling Claude session: ${binding.reason}`);
  const sessionId = binding.sessionId;
  const recordRoot = binding.recordRoot ?? root;
  if (binding.recordRootIdentity && !revalidateCandidateIdentity(recordRoot, binding.recordRootIdentity)) {
    return fail(format, "not_bound", "the session's record root changed since it was found");
  }
  const now = o.now ?? Date.now();

  if (planIsEmpty(plan)) {
    const record = readPresenceRecord(recordRoot, sessionId);
    if (!record?.sessionIntel) return fail(format, "not_bound", "no session intel on this session's record yet");
    return { output: renderState(record, recordRoot, cfg, format), errorCode: null };
  }

  o.afterBinding?.();
  const observed: HandoverStampObservation = { state: null };
  const expectedEra = mode === "bound" ? binding.era : null;
  let pointBefore: number | null = null as number | null;
  let refused: string | null = null as string | null;
  let written: SessionIntelPresence | null = null as SessionIntelPresence | null;
  const outcome = applyPresenceEnrichment(recordRoot, sessionId, LIFECYCLE_LOCK_BUDGET_MS, "session-intel", (base, nowIso) => {
    const intel = base.sessionIntel;
    if (!intel) { refused = "no session intel on this session's record yet"; return base; }
    if (base.endedAt !== null) { refused = "this session has ended"; return base; }
    // The same era check stampIntoRecord makes, for every flag group: a
    // startup era swap between the binding and this lock writes nothing.
    if (mode === "bound" && (expectedEra === null || intel.era === null || intel.era !== expectedEra)) { refused = "record era differs from the caller's live era"; return base; }
    pointBefore = intel.lastSample?.ceiling ?? null;
    let next: SessionIntelPresence = intel;
    if (plan.rule !== undefined) next = { ...next, rule: plan.rule.set ? { handovers: "elsewhere", where: plan.rule.where, setAt: nowIso } : null };
    if (plan.override !== undefined) next = { ...next, override: plan.override };
    // A rule or threshold change re-decides any notice already in flight:
    // a claim decided before it sees a different generation and is refused.
    if (next !== intel) next = { ...next, policyGen: next.policyGen + 1 };
    let rec: SessionPresence = { ...base, sessionIntel: next };
    if (plan.coveredBy !== undefined) {
      const r = stampIntoRecord(recordRoot, sessionId, rec, nowIso, now, expectedEra, null, { out: observed, cfg }, mode, { handoverFile: null, coveredBy: plan.coveredBy });
      if (r.refused !== null) { refused = r.refused; return base; }
      rec = r.next;
    }
    // An override change re-decides the stored sample in place under the
    // new thresholds (decideBand, the sampler's own step): every measured
    // fact is kept, only the bands change, so a claim made from it before
    // the next sample sees the band the new thresholds give.
    if (plan.override !== undefined && rec.sessionIntel) rec = { ...rec, sessionIntel: redecideStoredSample(rec.sessionIntel, cfg) };
    written = rec.sessionIntel;
    return rec;
  }, () => new Date(now));
  if (refused !== null) return fail(format, "not_bound", refused);
  const after = written;
  if (outcome.status !== "written" || after === null) return fail(format, "write_failed", `nothing was written (${outcome.status}); run it again`);

  const lines: string[] = [];
  if (plan.rule !== undefined) {
    lines.push(plan.rule.set
      ? `Recorded: handovers for this session live elsewhere${plan.rule.where ? ` (${plan.rule.where})` : ""}; the context notice reports instead of asking until this session ends.`
      : "Cleared: this session's handover rule. The context notice asks for handovers again.");
  }
  if (plan.override !== undefined) {
    if (plan.override === null) {
      lines.push("Cleared: this session's threshold override. The project's thresholds apply.");
    } else {
      const parts = [plan.override.imperativePct !== null ? `imperativePct ${plan.override.imperativePct}` : null, plan.override.imperativeHeadroomTokens !== null ? `imperativeHeadroomTokens ${n(plan.override.imperativeHeadroomTokens)}` : null].filter(Boolean);
      lines.push(`Recorded for this session only: ${parts.join(", ")}.`);
      const th = effectiveThresholds(cfg, after, pointBefore);
      const empty = emptyBandReason(th);
      if (empty) lines.push(`Warning: on the current expected point ${empty}.`);
    }
  }
  if (plan.coveredBy !== undefined) lines.push(coverReply(plan.coveredBy, observed));
  return { output: format === "json" ? JSON.stringify({ ok: true, lines, state: stateData(after, recordRoot, readPresenceRecord(recordRoot, sessionId), cfg) }, null, 2) : lines.join("\n"), errorCode: null };
}

/** Plan 7.2: the reply from `eraCovered` on the record the stamp was written into, under the same lock. */
export function coverReply(text: string, obs: HandoverStampObservation): string {
  if (obs.covers === true) return `Recorded: this compaction is covered by ${text}.`;
  if (obs.tokens === null || obs.tokens === undefined || obs.point === null || obs.point === undefined) {
    return `Recorded ${text}, but the context size is not known yet, so the notice may still ask near the compaction point.`;
  }
  return `Recorded ${text}, but it was given well before the compaction point (${n(obs.tokens)} of about ${n(obs.point)} tokens in use), so the notice may still ask near it. Give it again nearer the point.`;
}

interface StateData {
  readonly point: number | null;
  readonly used: number | null;
  readonly thresholds: {
    readonly imperativePct: number;
    readonly imperativeHeadroomTokens: number;
    readonly compactNeededPct: number;
    readonly imperativeLine: number | null;
    readonly compactLine: number | null;
    readonly bandEmpty: boolean;
    readonly override: SessionIntelOverride | null;
    readonly overrideStatus: EffectiveThresholds["override"];
    readonly notes: readonly string[];
  };
  readonly bands: { readonly imperative: string | null; readonly compactNeeded: string | null };
  readonly coverage: { readonly stamped: boolean; readonly covers: boolean; readonly tokens: number | null; readonly handoverFile: string | null; readonly coveredBy: string | null };
  readonly owed: SessionIntelOwed | null;
  readonly rule: { readonly where: string | null; readonly source: "session" | "arrangement"; readonly arrangementId: string | null } | null;
}

function stateData(intel: SessionIntelPresence, root: string, record: SessionPresence | null, cfg: SessionIntelConfig): StateData {
  const th = effectiveThresholds(cfg, intel, intel.lastSample?.ceiling ?? null);
  const notes = [emptyBandReason(th), ignoredOverrideReason(th)].filter((x): x is string => x !== null);
  const arrangement = intel.rule === null ? arrangementRuleInForce(root, record) : null;
  const stamped = stampedThisEra(intel);
  return {
    point: th.point,
    used: intel.lastSample?.contextTokens ?? null,
    thresholds: {
      imperativePct: th.imperativePct,
      imperativeHeadroomTokens: th.imperativeHeadroomTokens,
      compactNeededPct: th.compactNeededPct,
      imperativeLine: th.imperativeLine === null ? null : Math.round(th.imperativeLine),
      compactLine: th.compactLine === null ? null : Math.round(th.compactLine),
      bandEmpty: th.bandEmpty,
      override: intel.override,
      overrideStatus: th.override,
      notes,
    },
    bands: { imperative: intel.lastImperativeEmittedAt, compactNeeded: intel.compactNeededEmittedAt },
    coverage: {
      stamped,
      covers: eraCovered(intel, th),
      tokens: stamped ? intel.tokensAtHandover : null,
      handoverFile: stamped ? intel.handoverFile : null,
      coveredBy: stamped ? intel.coveredBy : null,
    },
    owed: intel.owed,
    rule: intel.rule !== null
      ? { where: intel.rule.where, source: "session", arrangementId: null }
      : arrangement !== null
        ? { where: arrangement.where, source: "arrangement", arrangementId: arrangement.arrangementId }
        : null,
  };
}

function renderState(record: SessionPresence, root: string, cfg: SessionIntelConfig, format: "md" | "json"): string {
  const d = stateData(record.sessionIntel!, root, record, cfg);
  if (format === "json") return JSON.stringify({ ok: true, state: d }, null, 2);
  const t = d.thresholds;
  const lines = [
    "Context alert for this session",
    `- In use: ${d.used === null ? "unknown" : `${n(d.used)} tokens`}; expected auto-compaction point: ${d.point === null ? "unknown" : `about ${n(d.point)}`}`,
    `- Thresholds: imperativePct ${t.imperativePct}, imperativeHeadroomTokens ${n(t.imperativeHeadroomTokens)}, compactNeededPct ${t.compactNeededPct}${t.override ? ` (session override ${t.overrideStatus})` : " (project)"}`,
    `- Lines: imperative ${t.imperativeLine === null ? "unknown" : n(t.imperativeLine)}, compact ${t.compactLine === null ? "unknown" : n(t.compactLine)}${t.bandEmpty ? " (the imperative band is empty)" : ""}`,
    ...t.notes.map((x) => `- Note: ${x}`),
    `- Notices this compaction: imperative ${d.bands.imperative ? `delivered ${d.bands.imperative}` : "not yet"}; compact-needed ${d.bands.compactNeeded ? `delivered ${d.bands.compactNeeded}` : "not yet"}`,
    `- Coverage: ${!d.coverage.stamped ? "none recorded this compaction" : `${d.coverage.coveredBy ? `covered-by ${d.coverage.coveredBy}` : d.coverage.handoverFile ? `handover ${d.coverage.handoverFile}` : "a handover"} at ${d.coverage.tokens === null ? "unknown" : n(d.coverage.tokens)} tokens, ${d.coverage.covers ? "covers this compaction" : "does not cover this compaction"}`}`,
    `- Catch-up owed: ${d.owed ? `yes, for the compaction at ${d.owed.boundaryAt}` : "no"}`,
    `- Handover rule: ${d.rule === null ? "none" : `elsewhere${d.rule.where ? ` (${d.rule.where})` : ""}, set on ${d.rule.source === "session" ? "this session" : `arrangement ${d.rule.arrangementId}`}`}`,
  ];
  return lines.join("\n");
}

/**
 * ISS-1428: the stored sample re-decided under the record's current
 * thresholds. A sample without tokens or a ceiling has no band to re-decide
 * and is returned unchanged. The stored sample does not keep whether the
 * ceiling sources conflicted; a conflict is read back from an advisory band
 * below the advisory line, the only band it produces on its own.
 */
export function redecideStoredSample(intel: SessionIntelPresence, cfg: SessionIntelConfig): SessionIntelPresence {
  const sample = intel.lastSample;
  if (sample === null || sample.contextTokens === null || sample.ceiling === null) return intel;
  const th = effectiveThresholds(cfg, intel, sample.ceiling);
  const conflict = sample.rawState === "advisory" && sample.contextTokens < th.advisoryPct * sample.ceiling;
  const band = decideBand({ tokens: sample.contextTokens, ceiling: sample.ceiling, conflict, th, record: intel, previousSince: sample.imperativeSince, sampledAt: sample.sampledAt });
  return { ...intel, lastSample: { ...sample, ...band } };
}
