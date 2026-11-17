/**
 * ISS-1499 slice B: the per-call machinery every handover reader shares
 * (plan section 3). `TailReader` caches slice A's single-file tail result
 * for one command run and counts the uncached reads; its `observation` is
 * the command's one `lineageObserved` flag. `readHandoverBody` is the one
 * body reader. `selectHandovers` is the one selection every reader uses
 * (section 7), and the notice builders give section 9's fixed texts.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { scanHandoverFile } from "./handover-lineage-scan.js";
import type { BrokenReason, ScannedFile } from "./handover-lineage.js";
import type { MemoResolution } from "./handover-line-memo.js";
import type { StructuredEntry } from "./handover-brief.js";
import { handoverFilenameDate } from "./handover-filename.js";

/**
 * Set to true by exactly three events: the `TailReader` returns a `linked`
 * state; the raw fill classifies a body as linked; the caller's memo file
 * exists and decodes. Nothing else decides compatibility.
 */
export interface LineageObservation { seen: boolean }

export class TailReader {
  readonly observation: LineageObservation = { seen: false };
  /** Uncached tail reads made so far. */
  reads = 0;
  /** Whether any tail read so far returned `linked` (the selection's fill rule). */
  linkedSeen = false;
  private readonly cache = new Map<string, ScannedFile>();
  private readonly listed: ReadonlySet<string>;

  constructor(readonly handoversDir: string, listing: readonly string[]) {
    this.listed = new Set(listing);
  }

  /** Whether `name` is in the listing this reader was made with. */
  has(name: string): boolean {
    return this.listed.has(name);
  }

  /** Whether `name` was already read in this command run. */
  isCached(name: string): boolean {
    return this.cache.has(name);
  }

  /** Slice A's single-file result for `name`, read once per command run. */
  state(name: string): ScannedFile {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const result = scanHandoverFile(this.handoversDir, name);
    this.reads++;
    this.cache.set(name, result);
    if (result.state === "linked") {
      this.observation.seen = true;
      this.linkedSeen = true;
    }
    return result;
  }
}

/** Test seam: runs after `fstatSync` and before the read. */
export const bodyReaderSeams: { afterOpen: ((path: string) => void) | null } = { afterOpen: null };

const O_NONBLOCK = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

/**
 * The one body reader. Opens the path once (following a symlink exactly as
 * `readFile` does; `O_NONBLOCK` makes opening a FIFO return at once) and
 * reads through that descriptor only:
 * - a regular file: its `fstat` size, decoded as UTF-8;
 * - a directory: read through the same descriptor, which raises the
 *   `EISDIR` error `readFile` raises;
 * - anything else (FIFO, device): fails fast with "not a regular file".
 * An `open` error is rethrown unchanged. This is the one place slice B
 * departs from main on a project with no lineage: main blocks on a FIFO.
 */
export function readHandoverBody(handoversDir: string, name: string): string {
  const path = join(handoversDir, name);
  const fd = openSync(path, constants.O_RDONLY | O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    bodyReaderSeams.afterOpen?.(path);
    if (st.isDirectory()) return readFileSync(fd, "utf-8");
    if (!st.isFile()) throw new Error(`Cannot read handover ${name}: not a regular file`);
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Selection (plan section 7)
// ---------------------------------------------------------------------------

export interface SelectionBroken {
  /** The last file of the line that was reached. */
  readonly at: string;
  /** Its `continues` target, or null when the value was invalid. */
  readonly target: string | null;
  readonly reason: BrokenReason | "self" | "repeat";
}

export interface HandoverSelection {
  readonly files: readonly string[];
  readonly source: "memo" | "default";
  readonly broken: SelectionBroken | null;
  readonly limited: boolean;
  /** Default selection only: the read limit stopped it with positions open and no linked state seen. */
  readonly fill: { readonly from: number; readonly open: number } | null;
  /** Default selection only: the walk reached the end of the listing. */
  readonly endReached: boolean;
  /** Default selection only: how many listing names it walked. */
  readonly walked: number;
  /** Every name the walk visited, in order (the memo walk's line; the default walk's selected names). */
  readonly visited: readonly string[];
}

export interface SelectOptions {
  /** The caller's own order (newest first). */
  readonly listing: readonly string[];
  readonly tails: TailReader;
  readonly memo: MemoResolution;
  readonly count: number;
  /** Uncached tail reads allowed, counted from this call's start. */
  readonly maxReads: number;
}

/**
 * The one selection every reader uses. A memo that is `active` walks its
 * line from the tip; otherwise the default selection walks the listing,
 * skipping only names positively read as `linked`, so with no linked state
 * the result is exactly `listing.slice(0, count)`.
 */
export function selectHandovers(o: SelectOptions): HandoverSelection {
  const start = o.tails.reads;
  const overLimit = (name: string): boolean => !o.tails.isCached(name) && o.tails.reads - start >= o.maxReads;
  return o.memo.kind === "active" ? memoWalk(o, o.memo.tip, overLimit) : defaultWalk(o, overLimit);
}

type ParentStep =
  | { readonly kind: "next"; readonly name: string }
  | { readonly kind: "end" }
  | { readonly kind: "limit" }
  | { readonly kind: "broken"; readonly broken: SelectionBroken };

function positionsOf(listing: readonly string[]): Map<string, number> {
  const position = new Map<string, number>();
  listing.forEach((n, i) => { if (!position.has(n)) position.set(n, i); });
  return position;
}

/**
 * Section 7's Parent of `cur`, shared by the memo walk and the recent-lines
 * marking walk. `visited` holds the names already on the walk.
 */
function parentStep(
  listing: readonly string[],
  position: ReadonlyMap<string, number>,
  tails: TailReader,
  cur: string,
  visited: ReadonlySet<string>,
  overLimit: (name: string) => boolean,
): ParentStep {
  if (overLimit(cur)) return { kind: "limit" };
  const st = tails.state(cur);
  if (st.state === "linked") {
    const c = st.lineage!.lineage.continues;
    if (c.state === "absent") return { kind: "end" };
    if (c.state === "invalid") return { kind: "broken", broken: { at: cur, target: null, reason: "invalid" } };
    const t = c.file;
    if (t === cur) return { kind: "broken", broken: { at: cur, target: t, reason: "self" } };
    if (!position.has(t)) return { kind: "broken", broken: { at: cur, target: t, reason: "missing" } };
    if (visited.has(t)) return { kind: "broken", broken: { at: cur, target: t, reason: "repeat" } };
    if (overLimit(t)) return { kind: "limit" };
    if (tails.state(t).state === "unknown") return { kind: "broken", broken: { at: cur, target: t, reason: "unreadable" } };
    return { kind: "next", name: t };
  }
  // An unlinked file's parent is the next unlinked name after it; the
  // search never restarts from the top of the listing.
  for (let j = (position.get(cur) ?? listing.length) + 1; j < listing.length; j++) {
    const n = listing[j]!;
    if (overLimit(n)) return { kind: "limit" };
    if (tails.state(n).state === "unlinked") {
      return visited.has(n) ? { kind: "broken", broken: { at: cur, target: n, reason: "repeat" } } : { kind: "next", name: n };
    }
  }
  return { kind: "end" };
}

function memoWalk(o: SelectOptions, tip: string, overLimit: (name: string) => boolean): HandoverSelection {
  const position = positionsOf(o.listing);
  const files = [tip];
  const visited = new Set<string>([tip]);
  let broken: SelectionBroken | null = null;
  let limited = false;
  let cur = tip;
  while (files.length < o.count) {
    const step = parentStep(o.listing, position, o.tails, cur, visited, overLimit);
    if (step.kind === "limit") { limited = true; break; }
    if (step.kind === "broken") { broken = step.broken; break; }
    if (step.kind === "end") break;
    files.push(step.name);
    visited.add(step.name);
    cur = step.name;
  }
  return { files, source: "memo", broken, limited, fill: null, endReached: false, walked: 0, visited: [...files] };
}

function defaultWalk(o: SelectOptions, overLimit: (name: string) => boolean): HandoverSelection {
  const files: string[] = [];
  let i = 0;
  for (; i < o.listing.length && files.length < o.count; i++) {
    const n = o.listing[i]!;
    if (overLimit(n)) {
      const open = o.count - files.length;
      if (o.tails.linkedSeen) {
        return { files, source: "default", broken: null, limited: true, fill: null, endReached: false, walked: i, visited: [...files] };
      }
      return { files, source: "default", broken: null, limited: false, fill: { from: i, open }, endReached: false, walked: i, visited: [...files] };
    }
    if (o.tails.state(n).state !== "linked") files.push(n);
  }
  return { files, source: "default", broken: null, limited: false, fill: null, endReached: i >= o.listing.length, walked: i, visited: [...files] };
}

// ---------------------------------------------------------------------------
// Recent lines (plan section 8; `handover latest` only)
// ---------------------------------------------------------------------------

const RECENT_WINDOW_DAYS = 14;
/** Tails the recent scan reads at most. */
export const RECENT_SCAN_MAX = 500;
const RECENT_SHOWN = 5;
const RECENT_LABEL_MAX_BYTES = 40;
/** The marking walk ends after this many consecutive names outside the window. */
const MARKING_OUTSIDE_MAX = 10;
const MARKING_MAX_READS = 200;
const DATED = /^\d{4}-\d{2}-\d{2}$/;

/** The window's first date: the date `handover create` would name a file with, 14 days before `now`. */
export function recentCutoff(now: Date, team: boolean): string {
  return handoverFilenameDate(new Date(now.getTime() - RECENT_WINDOW_DAYS * 86_400_000), team);
}

/** In the window: a dated name whose date is at or after the cutoff. Undated names never are. */
export function inRecentWindow(name: string, cutoff: string): boolean {
  const d = name.slice(0, 10);
  return DATED.test(d) && d >= cutoff;
}

export interface RecentScan {
  /** The window's names in listing order, at most 500. */
  readonly window: readonly string[];
  /** More than 500 names were in the window. */
  readonly limited: boolean;
}

/** Steps 1 and 2: the window, and every tail in it read (before the selection, so the cache is warm). */
export function scanRecentTails(o: { readonly listing: readonly string[]; readonly tails: TailReader; readonly cutoff: string }): RecentScan {
  const inWindow = o.listing.filter((n) => inRecentWindow(n, o.cutoff));
  const window = inWindow.slice(0, RECENT_SCAN_MAX);
  for (const n of window) o.tails.state(n);
  return { window, limited: inWindow.length > RECENT_SCAN_MAX };
}

export interface RecentLine {
  readonly file: string;
  readonly role: string | null;
  readonly by: string | null;
}

export interface RecentLines {
  /** The first five candidates, in listing order. */
  readonly recent: readonly RecentLine[];
  /** More than five candidates were found. */
  readonly more: boolean;
  /** The scan or the marking walk stopped at a limit. */
  readonly limited: boolean;
}

function clipBytes(value: string | null, max: number): string | null {
  if (value === null) return null;
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= max) return value;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Steps 3 to 5, after the selection (and the raw fill). `selected` is every
 * name the caller is shown as its own; `admitted` is the brief's filename
 * admission, applied to the candidates.
 */
export function finaliseRecentLines(o: {
  readonly listing: readonly string[];
  readonly tails: TailReader;
  readonly scan: RecentScan;
  readonly selection: HandoverSelection;
  readonly selected: readonly string[];
  readonly memo: MemoResolution;
  readonly admitted: (name: string) => boolean;
}): RecentLines {
  const own = new Set<string>([...o.selected, ...o.selection.files, ...o.selection.visited]);
  const windowSet = new Set(o.scan.window);
  let limited = o.scan.limited;
  const position = positionsOf(o.listing);
  const start = o.tails.reads;
  const overLimit = (name: string): boolean => !o.tails.isCached(name) && o.tails.reads - start >= MARKING_MAX_READS;

  if (o.memo.kind === "active") {
    // The marking walk: the caller's line past `count`. Ten consecutive
    // names outside the window end it normally (further ancestors are
    // older); the read limit leaves membership undetermined.
    let cur = o.memo.tip;
    const visited = new Set<string>([cur]);
    own.add(cur);
    let outside = windowSet.has(cur) ? 0 : 1;
    while (outside < MARKING_OUTSIDE_MAX) {
      const step = parentStep(o.listing, position, o.tails, cur, visited, overLimit);
      if (step.kind === "limit") { limited = true; break; }
      if (step.kind !== "next") break;
      own.add(step.name);
      visited.add(step.name);
      outside = windowSet.has(step.name) ? 0 : outside + 1;
      cur = step.name;
    }
  } else {
    for (const n of o.scan.window) if (o.tails.state(n).state === "unlinked") own.add(n);
  }

  const claimed = new Set<string>();
  for (const n of o.scan.window) {
    const st = o.tails.state(n);
    if (st.state !== "linked") continue;
    const l = st.lineage!.lineage;
    if (l.continues.state === "valid") claimed.add(l.continues.file);
    for (const a of l.absorbs) claimed.add(a);
  }

  let head: string | null = null;
  if (o.memo.kind === "active") {
    for (const n of o.listing) {
      if (overLimit(n)) { limited = true; break; }
      if (o.tails.state(n).state === "unlinked") { head = n; break; }
    }
  }

  const candidates: RecentLine[] = [];
  for (const n of o.scan.window) {
    if (own.has(n) || !o.admitted(n)) continue;
    const st = o.tails.state(n);
    if (st.state === "linked") {
      if (claimed.has(n)) continue;
      const l = st.lineage!.lineage;
      candidates.push({ file: n, role: clipBytes(l.role, RECENT_LABEL_MAX_BYTES), by: clipBytes(l.by, RECENT_LABEL_MAX_BYTES) });
    } else if (n === head) {
      candidates.push({ file: n, role: null, by: null });
    }
  }
  return { recent: candidates.slice(0, RECENT_SHOWN), more: candidates.length > RECENT_SHOWN, limited };
}

// ---------------------------------------------------------------------------
// Notices and the `lines` addition (plan section 9)
// ---------------------------------------------------------------------------

/** One recent line in the block; `entry` only in a brief, when its full entry fit. */
export interface OtherLinesItem extends RecentLine {
  readonly entry?: StructuredEntry;
}

/** Recent activity on other lines (plan section 9). */
export interface OtherLines {
  readonly pointer: true;
  readonly recent: readonly OtherLinesItem[];
  readonly more: boolean;
}

/** The optional `lines` object a reader result carries. */
export interface HandoverLinesAddition {
  readonly notices: readonly string[];
  readonly otherLines?: OtherLines;
}

const NOTICE_FILE_MAX_BYTES = 120;

/** A filename for a notice: at most 120 bytes, cut on a character boundary, plus `...` when cut. */
export function clipNoticeFile(name: string): string {
  const buf = Buffer.from(name, "utf8");
  if (buf.length <= NOTICE_FILE_MAX_BYTES) return name;
  let end = NOTICE_FILE_MAX_BYTES;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString("utf8")}...`;
}

/** N1: the memo names a line that cannot be found. */
export function staleMemoNotice(tip: string, reason: "missing" | "unreadable"): string {
  return `This session's handover line could not be found (${clipNoticeFile(tip)}: ${reason}). Showing the default line. To pick a line: \`storybloq handover lines\`, then \`storybloq handover continue <file>\`.`;
}

const BROKEN_WORDS: Record<SelectionBroken["reason"], string> = {
  missing: "missing", unreadable: "unreadable", invalid: "invalid", self: "itself", repeat: "repeated",
};

/** N2: the memo walk stopped at a broken link. An invalid value has no target to name. */
export function brokenLinkNotice(b: SelectionBroken): string {
  const parent = b.target === null ? "its parent link" : `its parent ${clipNoticeFile(b.target)}`;
  return `The line stops at ${clipNoticeFile(b.at)}: ${parent} is ${BROKEN_WORDS[b.reason]}.`;
}

/** N3: a scan stopped at its read limit. */
export const LIMIT_NOTICE = "A scan stopped at its limit; `storybloq handover lines` gives the exact view.";

/** N4: the default selection is empty. `walked` is the names it read when the limit stopped it. */
export function emptyDefaultNotice(sel: HandoverSelection, listingLength: number): string {
  if (sel.endReached) {
    return `No handover on the default line. ${listingLength} handover files are on other lines: \`storybloq handover lines --all\`.`;
  }
  return `No handover on the default line among the newest ${sel.walked} handover files: \`storybloq handover lines --all\`.`;
}

/**
 * The notices for one reader result, in order N1, N2, N3, N4. An empty
 * default carries N4 and not N3: its limit wording already says the scan
 * stopped. `limited` is the selection's or the raw fill's.
 */
export function selectionNotices(memo: MemoResolution, sel: HandoverSelection, limited: boolean, empty: boolean, listingLength: number): string[] {
  const out: string[] = [];
  if (memo.kind === "stale") out.push(staleMemoNotice(memo.tip, memo.reason));
  if (sel.broken !== null) out.push(brokenLinkNotice(sel.broken));
  if (empty && sel.source === "default") out.push(emptyDefaultNotice(sel, listingLength));
  else if (limited) out.push(LIMIT_NOTICE);
  return out;
}
