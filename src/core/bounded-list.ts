/**
 * Bounding each VALUE does not bound the OUTPUT (ISS-897).
 *
 * Every cap added so far applies to one name, one serialization, one reason.
 * The prose these sit in joins an untrusted, unbounded COLLECTION of them: a
 * `.story/sessions` directory a workspace controls can hold any number of
 * entries, and a caller-supplied scan result can carry any number of
 * diagnostics. Forty entries at four hundred characters each is sixteen
 * thousand characters of a sentence, in an MCP response an operator is reading
 * during an incident to find out whether another agent is running. That is the
 * same denial of service the per-value caps were added to close, reached one
 * level up.
 *
 * So: a budget for the LIST, and the count kept whatever the budget does. What
 * a reader loses when the list is cut is which specific names were dropped;
 * what they must not lose is that there were more, and how many -- otherwise a
 * truncated list reads as a complete one, which is worse than either.
 *
 * Entries are included WHOLE. A list cut mid-name hands the operator a name
 * that does not exist, and this output exists to be compared against a
 * filesystem.
 */

/**
 * Room for a useful handful of names without letting one sentence take the
 * screen. Individual values are capped well below this by their own renderers.
 */
export const MAX_LIST_BUDGET = 1200;

/** Never emit an empty list where entries exist: one entry always survives. */
export function boundedList(
  items: readonly string[],
  options: { budget?: number; separator?: string; noun?: string } = {},
): string {
  const budget = options.budget ?? MAX_LIST_BUDGET;
  const separator = options.separator ?? ", ";
  const noun = options.noun ?? "entries";
  if (items.length === 0) return "";

  const shown: string[] = [];
  let used = 0;
  for (const item of items) {
    const cost = shown.length === 0 ? item.length : item.length + separator.length;
    // The first entry is admitted whatever it costs. Its own renderer bounded
    // it, and a list of nothing followed by "showing 0 of 12" is a worse
    // answer than one over-long name.
    if (shown.length > 0 && used + cost > budget) break;
    shown.push(item);
    used += cost;
  }

  const text = shown.join(separator);
  if (shown.length === items.length) return text;
  // The TOTAL, not just the fact of cutting. "showing 3 of 47" tells an
  // operator the shape of what they are looking at; "..." does not.
  return `${text} ... (showing ${shown.length} of ${items.length} ${noun})`;
}

/**
 * The same bound for whole LINES rather than one joined sentence.
 *
 * Returns the lines to emit plus, when it cut, one line saying how many were
 * left out and where the complete set is. The pointer matters: the structured
 * payload always carries everything, so the remedy for a cut list is a format
 * change rather than a lost finding.
 */
export function boundedLines(
  lines: readonly string[],
  options: { maxLines: number; noun: string; fullSetHint: string },
): string[] {
  if (lines.length <= options.maxLines) return [...lines];
  const shown = lines.slice(0, options.maxLines);
  return [
    ...shown,
    `- ... and ${lines.length - options.maxLines} more ${options.noun} (${lines.length} total). ${options.fullSetHint}`,
  ];
}
