/**
 * T-477 section 3.4: the milestone staleness read-out. Presentation-only,
 * and deliberately never wired into any status/transition/paging/blocking
 * code path (per the ratified plan) -- the structured projection stays exact
 * raw facts, and the hedge phrase below is derived FROM those facts, never
 * computed independently, so it cannot appear without them.
 */

import type { MilestoneReadEvent } from "../presence/types.js";
import { computeElapsedWithClockSkew } from "./clock-skew.js";

export const MILESTONE_EXPECTED_CADENCE_SECONDS = 900;

export interface MilestoneStalenessProjection {
  readonly kind: string;
  readonly at: string;
  readonly elapsedSeconds: number;
  readonly expectedCadenceSeconds: 900;
  readonly selfReported: true;
  readonly clockAnomaly: boolean;
}

export function projectMilestoneStaleness(
  milestone: MilestoneReadEvent,
  now: number = Date.now(),
): MilestoneStalenessProjection {
  const { elapsedSeconds, clockAnomaly } = computeElapsedWithClockSkew(milestone.at, now);
  return {
    kind: milestone.kind,
    at: milestone.at,
    elapsedSeconds,
    expectedCadenceSeconds: MILESTONE_EXPECTED_CADENCE_SECONDS,
    selfReported: true,
    clockAnomaly,
  };
}

/**
 * The hedge phrase, appended only once `elapsedSeconds > expectedCadenceSeconds`
 * and never when `clockAnomaly` is set. Takes the PROJECTION, not raw inputs,
 * so it is structurally impossible to compute this without the raw fields
 * it is derived from sitting right alongside it in the caller's hands.
 */
export function milestoneHedgeNote(projection: MilestoneStalenessProjection): string | null {
  if (projection.clockAnomaly) return null;
  if (projection.elapsedSeconds <= projection.expectedCadenceSeconds) return null;
  return "may be worth checking";
}
