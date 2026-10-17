/**
 * T-481: how long an item has gone without a content change. Age is whole
 * local calendar days since `updatedDate`, falling back to the birth date
 * (`createdDate` for a ticket, `discoveredDate` for an issue), floored at 0.
 * The thresholds are `recipeOverrides` keys; no consumer uses them yet.
 */
import type { Config } from "../models/config.js";
import { localDateOf } from "./local-date.js";

export interface AgingConfig {
  readonly staleInProgressDays: number;
  readonly staleCriticalIssueDays: number;
  readonly agingIssueDays: number;
  readonly agingIssueBoostPerMonth: number;
  readonly agingStaleInProgressPenalty: number;
}

export const AGING_DEFAULTS: AgingConfig = {
  staleInProgressDays: 14,
  staleCriticalIssueDays: 30,
  agingIssueDays: 90,
  agingIssueBoostPerMonth: 20,
  agingStaleInProgressPenalty: 150,
};

const DAY_MS = 86_400_000;

/** Days since the epoch of a YYYY-MM-DD date, counted on the calendar, so a DST shift never moves it. */
function calendarDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS : null;
}

/** Whole local days since the item last changed, or since its birth when it never has; 0 when unknown or in the future. */
export function ageDays(
  item: { readonly updatedDate?: unknown; readonly createdDate?: unknown; readonly discoveredDate?: unknown },
  now: Date = new Date(),
): number {
  const since = [item.updatedDate, item.createdDate, item.discoveredDate].find((d): d is string => typeof d === "string");
  const from = since === undefined ? null : calendarDay(since);
  const today = calendarDay(localDateOf(now));
  if (from === null || today === null) return 0;
  return Math.max(0, today - from);
}

/** The aging thresholds: the defaults with any `recipeOverrides` keys applied. */
export function agingConfig(config: Pick<Config, "recipeOverrides">): AgingConfig {
  const overrides = (config.recipeOverrides ?? {}) as Partial<Record<keyof AgingConfig, unknown>>;
  const out: Record<string, number> = { ...AGING_DEFAULTS };
  for (const key of Object.keys(AGING_DEFAULTS) as Array<keyof AgingConfig>) {
    const value = overrides[key];
    if (typeof value === "number") out[key] = value;
  }
  return out as unknown as AgingConfig;
}
