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

function memoWalk(o: SelectOptions, tip: string, overLimit: (name: string) => boolean): HandoverSelection {
  const position = new Map<string, number>();
  o.listing.forEach((n, i) => { if (!position.has(n)) position.set(n, i); });
  const files = [tip];
  const visited = new Set<string>([tip]);
  let broken: SelectionBroken | null = null;
  let limited = false;
  let cur = tip;
  const done = (): HandoverSelection => ({
    files, source: "memo", broken, limited, fill: null, endReached: false, walked: 0, visited: [...files],
  });
  while (files.length < o.count) {
    if (overLimit(cur)) { limited = true; return done(); }
    const st = o.tails.state(cur);
    let next: string | null = null;
    if (st.state === "linked") {
      const c = st.lineage!.lineage.continues;
      if (c.state === "absent") return done();
      if (c.state === "invalid") { broken = { at: cur, target: null, reason: "invalid" }; return done(); }
      const t = c.file;
      if (t === cur) { broken = { at: cur, target: t, reason: "self" }; return done(); }
      if (!position.has(t)) { broken = { at: cur, target: t, reason: "missing" }; return done(); }
      if (visited.has(t)) { broken = { at: cur, target: t, reason: "repeat" }; return done(); }
      if (overLimit(t)) { limited = true; return done(); }
      if (o.tails.state(t).state === "unknown") { broken = { at: cur, target: t, reason: "unreadable" }; return done(); }
      next = t;
    } else {
      // An unlinked file's parent is the next unlinked name after it; the
      // search never restarts from the top of the listing.
      for (let j = (position.get(cur) ?? o.listing.length) + 1; j < o.listing.length; j++) {
        const n = o.listing[j]!;
        if (overLimit(n)) { limited = true; return done(); }
        if (o.tails.state(n).state === "unlinked") { next = n; break; }
      }
      if (next === null) return done();
      if (visited.has(next)) { broken = { at: cur, target: next, reason: "repeat" }; return done(); }
    }
    files.push(next);
    visited.add(next);
    cur = next;
  }
  return done();
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
// Notices and the `lines` addition (plan section 9)
// ---------------------------------------------------------------------------

/** The optional `lines` object a reader result carries. `otherLines` arrives with the recent-lines scan. */
export interface HandoverLinesAddition {
  readonly notices: readonly string[];
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
