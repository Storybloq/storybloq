/**
 * T-499: the `sessionIntel` block of `.story/config.json`, read the hot-path
 * way (raw JSON, bounded read, clamp, never throw) -- the `limit-config.ts`
 * pattern. The zod `SessionIntelConfigSchema` in models/config.ts carries the
 * same bounds for validation and documentation; the two must agree, and a
 * test pins that they do on every rule.
 *
 * Cross-field rules are applied HERE, per pair, with the fallback reported:
 * a config whose imperative threshold sits below its advisory one, or whose
 * jump-allowance floor exceeds its cap, gets the DEFAULT pair and a note in
 * `notes`, which the resolver surfaces in `basis`. Throwing would cost the
 * project every command; silently clamping would hide the mistake.
 */

import { join } from "node:path";
import { readBoundedFile } from "../bounded-read.js";

export interface SessionIntelConfig {
  readonly enabled: boolean;
  readonly advisoryPct: number;
  readonly imperativePct: number;
  /**
   * T-533: the imperative also fires once the headroom (ceiling minus tokens)
   * is at or below the larger of this and the next-turn jump allowance,
   * whichever of that and `imperativePct` comes first. It joins no pair rule:
   * a token count has no ordering against the percentages.
   */
  readonly imperativeHeadroomTokens: number;
  readonly ceilingFraction: number;
  readonly boundarySampleCount: number;
  readonly jumpAllowanceFloorTokens: number;
  readonly jumpAllowanceCapTokens: number;
  readonly maxSampleAgeMs: number;
  readonly compactPendingTtlMs: number;
  readonly stepPct: number;
  /**
   * ISS-1197: the three handover re-arm gates. A handover holds the
   * imperative at advisory while ANY of them is still closed, so an agent
   * that has just written one is not told to write another on the next
   * prompt. The growth gate is `min(stepPct x ceiling, this cap)`: on a large
   * ceiling a percentage step alone is wider than the jump allowance that
   * raised the imperative in the first place.
   */
  readonly handoverRearmStepCapTokens: number;
  /** Wall time since the later of the handover and the last imperative. */
  readonly handoverRearmIntervalMs: number;
  /** Prompts seen since the handover (a bus message and an idle notice each count as one). */
  readonly handoverRearmPrompts: number;
  /**
   * ISS-1197 commit 2: the fraction of the ceiling past which a handover no
   * longer helps and only the user's `/compact` does. Must exceed
   * `imperativePct` -- a compact-needed line at or below the imperative one
   * would swallow the imperative state entirely -- and the pair falls back to
   * the defaults together when it does not, the way advisory/imperative does.
   */
  readonly compactNeededPct: number;
  /**
   * T-501: the auto-compact window at or below which no usage advisory is
   * shown. A THRESHOLD, never a sentinel by magnitude: 0 disables the
   * advisory outright, and any other value is compared as written (a
   * 2,000,000 window against a 1,000,000 max still fires).
   */
  readonly recommendedWindowMax: number;
  readonly banner: boolean;
  readonly promptHook: boolean;
  readonly guideDirective: boolean;
  /** Human-readable record of every fallback applied while reading. Empty when the config was taken as written. */
  readonly notes: readonly string[];
}

export const DEFAULT_SESSION_INTEL_CONFIG: Omit<SessionIntelConfig, "notes"> = {
  enabled: true,
  advisoryPct: 0.7,
  imperativePct: 0.95,
  imperativeHeadroomTokens: 60_000,
  ceilingFraction: 0.925,
  boundarySampleCount: 20,
  jumpAllowanceFloorTokens: 25_000,
  jumpAllowanceCapTokens: 150_000,
  maxSampleAgeMs: 30_000,
  compactPendingTtlMs: 300_000,
  stepPct: 0.05,
  handoverRearmStepCapTokens: 25_000,
  handoverRearmIntervalMs: 600_000,
  handoverRearmPrompts: 3,
  compactNeededPct: 0.98,
  recommendedWindowMax: 450_000,
  banner: true,
  promptHook: true,
  guideDirective: true,
};

/** Mirrors `SessionIntelConfigSchema` exactly; the schema-agreement test enumerates these. */
export const SESSION_INTEL_BOUNDS = {
  advisoryPct: { min: 0.5, max: 0.95, integer: false },
  imperativePct: { min: 0.6, max: 0.99, integer: false },
  imperativeHeadroomTokens: { min: 10_000, max: 500_000, integer: true },
  ceilingFraction: { min: 0.8, max: 1, integer: false },
  boundarySampleCount: { min: 1, max: 50, integer: true },
  jumpAllowanceFloorTokens: { min: 0, max: 10_000_000, integer: true },
  jumpAllowanceCapTokens: { min: 0, max: 10_000_000, integer: true },
  maxSampleAgeMs: { min: 0, max: 600_000, integer: true },
  compactPendingTtlMs: { min: 10_000, max: 3_600_000, integer: true },
  stepPct: { min: 0.01, max: 0.5, integer: false },
  handoverRearmStepCapTokens: { min: 1_000, max: 1_000_000, integer: true },
  handoverRearmIntervalMs: { min: 0, max: 3_600_000, integer: true },
  handoverRearmPrompts: { min: 0, max: 50, integer: true },
  compactNeededPct: { min: 0.85, max: 1, integer: false },
  // T-501: 0 is a legal DISABLE value outside the live range, so it is named
  // here rather than widening the range (a 1-token max is not a threshold).
  recommendedWindowMax: { min: 100_000, max: 1_000_000, integer: true, allowZero: true },
} as const;

type NumericKey = keyof typeof SESSION_INTEL_BOUNDS;

function numberOr(
  raw: Record<string, unknown>,
  key: NumericKey,
  notes: string[],
): number {
  const value = raw[key];
  const fallback = DEFAULT_SESSION_INTEL_CONFIG[key];
  if (value === undefined) return fallback;
  const b = SESSION_INTEL_BOUNDS[key];
  if ("allowZero" in b && b.allowZero && value === 0) return 0;
  const ok =
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!b.integer || Number.isSafeInteger(value)) &&
    value >= b.min &&
    value <= b.max;
  if (ok) return value;
  notes.push(`sessionIntel.${key} ignored (${String(value)} is outside ${b.min}..${b.max}${b.integer ? ", integer" : ""}); default ${fallback} used`);
  return fallback;
}

function boolOr(raw: Record<string, unknown>, key: "enabled" | "banner" | "promptHook" | "guideDirective"): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : DEFAULT_SESSION_INTEL_CONFIG[key];
}

/**
 * Applies the block as an already-parsed object. Pure; the file read is the
 * only I/O and lives in `readSessionIntelConfig`. Anything that is not an
 * object is the defaults with no notes -- an absent block is not a mistake.
 */
export function resolveSessionIntelConfig(rawBlock: unknown): SessionIntelConfig {
  const d = DEFAULT_SESSION_INTEL_CONFIG;
  if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) return { ...d, notes: [] };
  const raw = rawBlock as Record<string, unknown>;
  const notes: string[] = [];

  let advisoryPct = numberOr(raw, "advisoryPct", notes);
  let imperativePct = numberOr(raw, "imperativePct", notes);
  let compactNeededPct = numberOr(raw, "compactNeededPct", notes);
  // ISS-1197 commit 2: the chain is advisory < imperative < compactNeeded, and
  // the two pair rules below can each MOVE imperativePct, so neither one alone
  // establishes it. The compact rule runs first (it can lower imperativePct to
  // the default, which the advisory rule then judges); the advisory rule can
  // RAISE imperativePct to the default 0.95, which is inside compactNeededPct's
  // legal range, so a third check repairs that case afterwards. The defaults
  // (0.7 / 0.95 / 0.98) satisfy the chain, so the repair always terminates.
  if (compactNeededPct <= imperativePct) {
    notes.push(`sessionIntel.compactNeededPct (${compactNeededPct}) must exceed imperativePct (${imperativePct}); defaults ${d.imperativePct}/${d.compactNeededPct} used for the pair`);
    imperativePct = d.imperativePct;
    compactNeededPct = d.compactNeededPct;
  }
  if (imperativePct <= advisoryPct) {
    notes.push(`sessionIntel.imperativePct (${imperativePct}) must exceed advisoryPct (${advisoryPct}); defaults ${d.advisoryPct}/${d.imperativePct} used for the pair`);
    advisoryPct = d.advisoryPct;
    imperativePct = d.imperativePct;
  }
  // Only imperativePct moved above, so only compactNeededPct is restored here:
  // resetting the pair would undo an advisory fallback that has already been
  // reported and is correct as it stands.
  if (compactNeededPct <= imperativePct) {
    notes.push(`sessionIntel.compactNeededPct (${compactNeededPct}) no longer exceeds imperativePct (${imperativePct}) after the advisoryPct fallback; default ${d.compactNeededPct} used`);
    compactNeededPct = d.compactNeededPct;
  }

  let jumpAllowanceFloorTokens = numberOr(raw, "jumpAllowanceFloorTokens", notes);
  let jumpAllowanceCapTokens = numberOr(raw, "jumpAllowanceCapTokens", notes);
  if (jumpAllowanceFloorTokens > jumpAllowanceCapTokens) {
    notes.push(`sessionIntel.jumpAllowanceFloorTokens (${jumpAllowanceFloorTokens}) exceeds jumpAllowanceCapTokens (${jumpAllowanceCapTokens}); defaults ${d.jumpAllowanceFloorTokens}/${d.jumpAllowanceCapTokens} used for the pair`);
    jumpAllowanceFloorTokens = d.jumpAllowanceFloorTokens;
    jumpAllowanceCapTokens = d.jumpAllowanceCapTokens;
  }

  return {
    enabled: boolOr(raw, "enabled"),
    advisoryPct,
    imperativePct,
    imperativeHeadroomTokens: numberOr(raw, "imperativeHeadroomTokens", notes),
    ceilingFraction: numberOr(raw, "ceilingFraction", notes),
    boundarySampleCount: numberOr(raw, "boundarySampleCount", notes),
    jumpAllowanceFloorTokens,
    jumpAllowanceCapTokens,
    maxSampleAgeMs: numberOr(raw, "maxSampleAgeMs", notes),
    compactPendingTtlMs: numberOr(raw, "compactPendingTtlMs", notes),
    stepPct: numberOr(raw, "stepPct", notes),
    handoverRearmStepCapTokens: numberOr(raw, "handoverRearmStepCapTokens", notes),
    handoverRearmIntervalMs: numberOr(raw, "handoverRearmIntervalMs", notes),
    handoverRearmPrompts: numberOr(raw, "handoverRearmPrompts", notes),
    compactNeededPct,
    recommendedWindowMax: numberOr(raw, "recommendedWindowMax", notes),
    banner: boolOr(raw, "banner"),
    promptHook: boolOr(raw, "promptHook"),
    guideDirective: boolOr(raw, "guideDirective"),
    notes,
  };
}

/**
 * Reads `.story/config.json` the hot-path way. Absent, unreadable or
 * malformed config is the defaults: a broken config must never blind a hook
 * (and never crash one). Symlink policy is `readBoundedFile`'s -- config is
 * user input and a legitimately symlinked one is honoured.
 */
export function readSessionIntelConfig(projectRoot: string): SessionIntelConfig {
  try {
    const body = readBoundedFile(join(projectRoot, ".story", "config.json"));
    if (body === null) return resolveSessionIntelConfig(null);
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    return resolveSessionIntelConfig(parsed?.sessionIntel);
  } catch {
    return resolveSessionIntelConfig(null);
  }
}
