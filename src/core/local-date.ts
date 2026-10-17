/**
 * ISS-1383 RED stub: the pre-fix behaviour (the UTC date of the instant).
 * Replaced by the local-calendar implementation in the CLI commit.
 */
export function localDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
