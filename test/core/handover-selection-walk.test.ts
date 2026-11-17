/**
 * ISS-1499 slice B, commit 4: `selectHandovers` (plan section 7) and the
 * notice texts (section 9). B4 with its read counts: the default selection
 * reads exactly `min(count, 200)` tails on a project with no lineage; a
 * mixed listing makes at most `maxReads` uncached reads; a linked first file
 * with an unlinked second at count 1 takes exactly two.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TailReader,
  selectHandovers,
  selectionNotices,
  clipNoticeFile,
  LIMIT_NOTICE,
  type HandoverSelection,
} from "../../src/core/handover-selection.js";
import type { MemoResolution } from "../../src/core/handover-line-memo.js";

let hdir: string;
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "selwalk-")));
  hdir = join(base, "handovers");
  mkdirSync(hdir);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const plain = "# Handover\n\nwork\n";
const linked = (attrs = ""): string => `# Handover\n\nwork\n\n<!-- storybloq-lineage v1${attrs ? " " + attrs : ""} -->\n`;
const put = (name: string, body: string): void => writeFileSync(join(hdir, name), body);
const name = (i: number): string => `2026-01-01-${String(i).padStart(4, "0")}-h.md`;
/** Newest first, as the readers list. */
const listingOf = (names: string[]): string[] => [...names].sort().reverse();
const NONE: MemoResolution = { kind: "none" };

function select(listing: string[], count: number, memo: MemoResolution = NONE, maxReads = 200): { sel: HandoverSelection; tails: TailReader } {
  const tails = new TailReader(hdir, listing);
  const sel = selectHandovers({ listing, tails, memo, count, maxReads });
  return { sel, tails };
}

describe("B4 default selection and its read counts", () => {
  it("no lineage: the listing's own slice, reading exactly min(count, 200) tails", () => {
    for (let i = 1; i <= 12; i++) put(name(i), plain);
    const listing = listingOf(Array.from({ length: 12 }, (_, i) => name(i + 1)));
    for (const count of [1, 3, 10]) {
      const { sel, tails } = select(listing, count);
      expect(sel.files).toEqual(listing.slice(0, count));
      expect(tails.reads).toBe(count);
      expect(tails.observation.seen).toBe(false);
      expect(sel.fill).toBeNull();
    }
  });

  it("no lineage at count 500 over 260 names: 200 reads, then a fill of the open positions", () => {
    const names = Array.from({ length: 260 }, (_, i) => name(i + 1));
    for (const n of names) put(n, plain);
    const listing = listingOf(names);
    const { sel, tails } = select(listing, 500);
    expect(tails.reads).toBe(200);
    expect(sel.files).toEqual(listing.slice(0, 200));
    expect(sel.fill).toEqual({ from: 200, open: 300 });
    expect(sel.limited).toBe(false);
  });

  it("a linked first file and an unlinked second at count 1: exactly two reads, the second selected", () => {
    put(name(2), linked('role="pen"'));
    put(name(1), plain);
    const listing = listingOf([name(1), name(2)]);
    const { sel, tails } = select(listing, 1);
    expect(sel.files).toEqual([name(1)]);
    expect(tails.reads).toBe(2);
    expect(tails.observation.seen).toBe(true);
  });

  it("the read limit with lineage seen stops with limited, never a fill", () => {
    const names = Array.from({ length: 300 }, (_, i) => name(i + 1));
    names.forEach((n, i) => put(n, i === 299 ? linked() : plain));
    const listing = listingOf(names);
    const { sel, tails } = select(listing, 500);
    expect(tails.reads).toBe(200);
    expect(sel.files).toEqual(listing.slice(1, 200));
    expect(sel.fill).toBeNull();
    expect(sel.limited).toBe(true);
  });

  it("a mixed listing makes at most maxReads uncached reads", () => {
    const names = Array.from({ length: 40 }, (_, i) => name(i + 1));
    names.forEach((n, i) => put(n, i % 2 === 0 ? linked() : plain));
    const listing = listingOf(names);
    const { tails } = select(listing, 30, NONE, 25);
    expect(tails.reads).toBe(25);
  });

  it("an unknown name consumes a position at the count boundary and beside the limit", () => {
    put(name(3), linked());
    mkdirSync(join(hdir, name(2)));
    put(name(1), plain);
    const listing = listingOf([name(1), name(2), name(3)]);
    const { sel } = select(listing, 1);
    expect(sel.files).toEqual([name(2)]);
    // At the limit: the unknown name was selected, so the empty wording never appears.
    const { sel: limited } = select(listing, 3, NONE, 2);
    expect(limited.files).toEqual([name(2)]);
    expect(limited.limited).toBe(true);
    expect(selectionNotices(NONE, limited, true, limited.files.length === 0, 3)).toEqual([LIMIT_NOTICE]);
  });

  it("an empty default: both wordings, and never N3 beside N4", () => {
    const all = Array.from({ length: 5 }, (_, i) => name(i + 1));
    for (const n of all) put(n, linked());
    const { sel } = select(listingOf(all), 3);
    expect(sel.files).toEqual([]);
    expect(sel.endReached).toBe(true);
    expect(selectionNotices(NONE, sel, sel.limited, true, 5)).toEqual([
      "No handover on the default line. 5 handover files are on other lines: `storybloq handover lines --all`.",
    ]);

    const many = Array.from({ length: 250 }, (_, i) => name(100 + i));
    for (const n of many) put(n, linked());
    const listing = listingOf([...all, ...many]);
    const r = select(listing, 1);
    expect(r.sel.files).toEqual([]);
    expect(r.sel.limited).toBe(true);
    expect(r.tails.reads).toBe(200);
    expect(selectionNotices(NONE, r.sel, r.sel.limited, true, listing.length)).toEqual([
      "No handover on the default line among the newest 200 handover files: `storybloq handover lines --all`.",
    ]);
  });
});

describe("B4 memo walk", () => {
  it("walks into an unlinked ancestor and on to the next unlinked name after it, never a newer one", () => {
    put("2026-11-15-01-new.md", plain); // newer unlinked, sorts before the ancestor
    put("2026-11-14-01-l2.md", linked('continues="2026-11-13-01-l1.md"'));
    put("2026-11-13-01-l1.md", linked('continues="2026-11-12-01-u.md"'));
    put("2026-11-12-01-u.md", plain);
    put("2026-11-11-01-other.md", linked());
    put("2026-11-10-01-old.md", plain);
    const listing = listingOf(["2026-11-15-01-new.md", "2026-11-14-01-l2.md", "2026-11-13-01-l1.md", "2026-11-12-01-u.md", "2026-11-11-01-other.md", "2026-11-10-01-old.md"]);
    const { sel } = select(listing, 10, { kind: "active", tip: "2026-11-14-01-l2.md" });
    expect(sel.source).toBe("memo");
    expect(sel.files).toEqual(["2026-11-14-01-l2.md", "2026-11-13-01-l1.md", "2026-11-12-01-u.md", "2026-11-10-01-old.md"]);
    expect(sel.broken).toBeNull();
  });

  it("the search for an unlinked parent never restarts at the top of the listing", () => {
    put("2026-11-15-01-a.md", plain);
    put("2026-11-14-01-b.md", plain);
    put("2026-11-13-01-tip.md", plain);
    put("2026-11-12-01-l.md", linked());
    const listing = listingOf(["2026-11-15-01-a.md", "2026-11-14-01-b.md", "2026-11-13-01-tip.md", "2026-11-12-01-l.md"]);
    const { sel } = select(listing, 10, { kind: "active", tip: "2026-11-13-01-tip.md" });
    expect(sel.files).toEqual(["2026-11-13-01-tip.md"]);
  });

  it("a broken link is disclosed once with each reason", () => {
    const tip = "2026-11-14-01-tip.md";
    const cases: Array<[string, () => void, string]> = [
      ["missing", () => put(tip, linked('continues="2026-11-01-01-gone.md"')), `The line stops at ${tip}: its parent 2026-11-01-01-gone.md is missing.`],
      ["itself", () => put(tip, linked(`continues="${tip}"`)), `The line stops at ${tip}: its parent ${tip} is itself.`],
      ["unreadable", () => { put(tip, linked('continues="2026-11-13-01-dir.md"')); mkdirSync(join(hdir, "2026-11-13-01-dir.md")); }, `The line stops at ${tip}: its parent 2026-11-13-01-dir.md is unreadable.`],
      ["invalid", () => put(tip, linked('continues="../x.md"')), `The line stops at ${tip}: its parent link is invalid.`],
      ["repeated", () => { put(tip, linked('continues="2026-11-13-01-b.md"')); put("2026-11-13-01-b.md", linked(`continues="${tip}"`)); }, `The line stops at 2026-11-13-01-b.md: its parent ${tip} is repeated.`],
    ];
    for (const [label, seed, text] of cases) {
      rmSync(hdir, { recursive: true, force: true });
      mkdirSync(hdir);
      seed();
      const listing = listingOf(["2026-11-14-01-tip.md", "2026-11-13-01-b.md", "2026-11-13-01-dir.md"].filter((n) => existsSync(join(hdir, n))));
      const { sel } = select(listing, 10, { kind: "active", tip });
      const notices = selectionNotices({ kind: "active", tip }, sel, sel.limited, false, listing.length);
      expect(notices, label).toEqual([text]);
    }
  });

  it("the walk stops at the read limit with limited", () => {
    const names = Array.from({ length: 30 }, (_, i) => name(i + 1));
    names.forEach((n, i) => put(n, i === 0 ? plain : linked(`continues="${names[i - 1]}"`)));
    const listing = listingOf(names);
    const { sel, tails } = select(listing, 30, { kind: "active", tip: names[29]! }, 10);
    expect(sel.limited).toBe(true);
    expect(tails.reads).toBeLessThanOrEqual(10);
    expect(selectionNotices({ kind: "active", tip: names[29]! }, sel, true, false, 30)).toEqual([LIMIT_NOTICE]);
  });

  it("a stale memo gives the default selection and N1", () => {
    put(name(1), plain);
    const listing = [name(1)];
    const memo: MemoResolution = { kind: "stale", tip: "2026-11-01-01-gone.md", reason: "missing" };
    const { sel } = select(listing, 1, memo);
    expect(sel.source).toBe("default");
    expect(sel.files).toEqual([name(1)]);
    expect(selectionNotices(memo, sel, false, false, 1)).toEqual([
      "This session's handover line could not be found (2026-11-01-01-gone.md: missing). Showing the default line. To pick a line: `storybloq handover lines`, then `storybloq handover continue <file>`.",
    ]);
  });
});

describe("notice clipping", () => {
  it("clips a filename to 120 bytes on a character boundary, plus ...", () => {
    expect(clipNoticeFile("a".repeat(120))).toBe("a".repeat(120));
    expect(clipNoticeFile("a".repeat(121))).toBe(`${"a".repeat(120)}...`);
    expect(clipNoticeFile(`${"a".repeat(119)}é.md`)).toBe(`${"a".repeat(119)}...`);
  });
});
