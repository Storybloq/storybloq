/**
 * ISS-1499 slice B: the recent-activity block on other lines (plan section
 * 9). Outside the brief it is amendment M1's block, at most 3,000 bytes;
 * in a brief it is design 4.5's, built from what the caller's own window
 * left of the structured budget. Neither ever changes the caller's window.
 */
import type { OutputFormat } from "../models/types.js";
import { structuredEntryFor } from "./handover-brief.js";
import type { OtherLines, OtherLinesItem, RecentLines } from "./handover-selection.js";
import { otherLinesBytes } from "./output-formatter.js";

/** The ceiling of the recent-activity block outside the brief (plan section 9). */
export const OTHER_LINES_BLOCK_MAX_BYTES = 3_000;

/** Amendment M1's block: at most 3,000 bytes in either format, entries dropped from the end. */
export function buildRawOtherLines(rl: RecentLines): OtherLines | undefined {
  let recent = [...rl.recent];
  let more = rl.more;
  const size = (o: OtherLines): number => Math.max(otherLinesBytes(o, [], "json"), otherLinesBytes(o, [], "md"));
  while (recent.length > 0 && size({ pointer: true, recent, more }) > OTHER_LINES_BLOCK_MAX_BYTES) {
    recent = recent.slice(0, -1);
    more = true;
  }
  return recent.length > 0 ? { pointer: true, recent, more } : undefined;
}

/**
 * Design 4.5: the brief's block, built from what the caller's window left
 * of the budget, measured on the rendered addition in the format returned.
 * Pointer only first; then per line its full entry, else its one-line form,
 * else stop. `more` is the scan's own, or any returned line left out.
 */
export function buildBriefOtherLines(
  rl: RecentLines,
  notices: readonly string[],
  left: number,
  format: OutputFormat,
  handoversDir: string,
): OtherLines | undefined {
  if (rl.recent.length === 0) return undefined;
  const fits = (recent: readonly OtherLinesItem[]): boolean => otherLinesBytes({ pointer: true, recent, more: true }, notices, format) <= left;
  if (!fits([])) return undefined;
  const items: OtherLinesItem[] = [];
  for (const r of rl.recent) {
    const entry = structuredEntryFor(handoversDir, r.file);
    if (entry !== null && fits([...items, { ...r, entry }])) items.push({ ...r, entry });
    else if (fits([...items, r])) items.push(r);
    else break;
  }
  return { pointer: true, recent: items, more: rl.more || items.length < rl.recent.length };
}

