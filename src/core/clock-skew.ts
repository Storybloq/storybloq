/**
 * T-477 section 3.2: the ONE clock-skew rule, stated once here and
 * implemented identically wherever a self-reported timestamp needs an
 * elapsed duration (the milestone staleness projection, `milestone-
 * staleness.ts`) -- and implemented again, deliberately, in Swift
 * (`MilestoneClockSkew.swift`), proven identical via a shared fixture
 * (`test/fixtures/clock-skew-cases.json`) rather than a shared import, since
 * the two read paths are in different languages.
 */

/** A local clock moved backward beyond this is not believed. */
export const CLOCK_SKEW_TOLERANCE_MS = 120_000;

export interface ClockSkewResult {
  readonly elapsedSeconds: number;
  readonly clockAnomaly: boolean;
}

/**
 * Exactly the ISO-8601 forms `MilestoneClockSkew.swift`'s two
 * `ISO8601DateFormatter`s (fractional-first, then bare fallback) actually
 * accept: full date, `T`, full time, optional fractional seconds, and a
 * MANDATORY `Z` or numeric `+HH:MM`/`-HH:MM` offset. `Date.parse` alone is far
 * more lenient than that -- it also accepts a date-only string, a timestamp
 * with no timezone (taken as local time, silently ambiguous across
 * machines), and locale-style prose dates -- so validating against this
 * pattern FIRST is what keeps the two languages' unparseable/malformed cases
 * identical rather than merely their well-formed ones (verified empirically,
 * not assumed: see the shared fixture's non-ISO cases).
 */
const STRICT_ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * `at` unparseable (including non-ISO-8601 forms `Date.parse` would otherwise
 * accept -- see `STRICT_ISO8601_RE`), or `now - at` negative by more than
 * `CLOCK_SKEW_TOLERANCE_MS`: elapsed clamps to 0 and `clockAnomaly` is set,
 * rather than reporting a negative or nonsensical duration.
 */
export function computeElapsedWithClockSkew(atIso: string, nowMs: number): ClockSkewResult {
  if (!STRICT_ISO8601_RE.test(atIso)) return { elapsedSeconds: 0, clockAnomaly: true };
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) return { elapsedSeconds: 0, clockAnomaly: true };
  const signedElapsedMs = nowMs - atMs;
  if (signedElapsedMs < -CLOCK_SKEW_TOLERANCE_MS) return { elapsedSeconds: 0, clockAnomaly: true };
  return { elapsedSeconds: Math.max(0, Math.floor(signedElapsedMs / 1000)), clockAnomaly: false };
}
