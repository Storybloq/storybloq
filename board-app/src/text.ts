/** Clip presentation text without changing the canonical identity behind it. */
export const clip = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + "…" : s;
