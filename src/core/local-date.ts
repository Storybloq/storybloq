/**
 * ISS-1383: the one way the CLI turns an instant into a date-only field
 * (`YYYY-MM-DD`): the Gregorian calendar date in the process's local zone, as
 * the Mac app writes it. Full instants (`createdAt`, `deletedAt`) stay UTC ISO;
 * a date-only field derived from one is this function of the same `Date`, so
 * the two never straddle a tick.
 */
export function localDateOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
