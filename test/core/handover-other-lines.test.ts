/**
 * ISS-1499 slice B, commit 5: the recent-activity block builders and the
 * filename date rule the window shares with `handover create` (B7, M1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBriefOtherLines, buildRawOtherLines, OTHER_LINES_BLOCK_MAX_BYTES } from "../../src/core/handover-other-lines.js";
import { generateTeamHandoverFilename, handoverFilenameDate } from "../../src/core/handover-filename.js";
import { structuredEntryFor } from "../../src/core/handover-brief.js";
import { otherLinesBytes } from "../../src/core/output-formatter.js";
import { TailReader, finaliseRecentLines, scanRecentTails, type HandoverSelection, type RecentLines } from "../../src/core/handover-selection.js";
import { appendLineage, serializeLineage } from "../../src/core/handover-lineage.js";

let savedTz: string | undefined;
beforeAll(() => { savedTz = process.env.TZ; process.env.TZ = "America/Los_Angeles"; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

describe("handoverFilenameDate around midnight UTC", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("names the local date off team mode and the UTC date in it", () => {
    const at = new Date("2026-11-16T03:00:00Z");
    expect(handoverFilenameDate(at, false)).toBe("2026-11-15");
    expect(handoverFilenameDate(at, true)).toBe("2026-11-16");
    const before = new Date("2026-11-15T23:59:59Z");
    expect(handoverFilenameDate(before, false)).toBe("2026-11-15");
    expect(handoverFilenameDate(before, true)).toBe("2026-11-15");
  });
  it("the team filename carries the UTC date at the same clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T03:00:00Z"));
    expect(generateTeamHandoverFilename("edge")).toMatch(/^2026-11-16-030000-[0-9a-f]{8}-edge\.md$/);
  });
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "w14-ol-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const put = (name: string, id: string): void => {
  writeFileSync(join(dir, name), `# H\n\n## Next steps\n\n- **${id}** carry on with ${id} ${"words ".repeat(20)}\n`);
};
const rl = (n: number, more = false): RecentLines => ({
  recent: Array.from({ length: n }, (_, i) => ({ file: `2026-11-1${i}-01-o${i}.md`, role: "pen", by: null })),
  more,
  limited: false,
});

describe("buildBriefOtherLines (design 4.5)", () => {
  it("measures in the format it returns: a budget that fits the full entry in Markdown only", () => {
    const lines = rl(1);
    put(lines.recent[0]!.file, "T-1");
    const entry = structuredEntryFor(dir, lines.recent[0]!.file)!;
    const full = { pointer: true as const, recent: [{ ...lines.recent[0]!, entry }], more: true };
    const md = otherLinesBytes(full, [], "md");
    const js = otherLinesBytes(full, [], "json");
    expect(md).toBeLessThan(js);
    expect(buildBriefOtherLines(lines, [], md, "md", dir)!.recent[0]!.entry).toEqual(entry);
    const inJson = buildBriefOtherLines(lines, [], md, "json", dir)!;
    expect(inJson.recent).toEqual([lines.recent[0]]);
  });

  it("pointer only when nothing more fits, and nothing when the pointer does not", () => {
    const lines = rl(2);
    const pointer = otherLinesBytes({ pointer: true, recent: [], more: true }, [], "json");
    expect(buildBriefOtherLines(lines, [], pointer, "json", dir)).toEqual({ pointer: true, recent: [], more: true });
    expect(buildBriefOtherLines(lines, [], pointer - 1, "json", dir)).toBeUndefined();
  });

  it("more is the scan's own, or any returned line left out; never recomputed from the returned lines", () => {
    expect(buildBriefOtherLines(rl(5, true), [], 1_000_000, "json", dir)!.more).toBe(true);
    expect(buildBriefOtherLines(rl(5, false), [], 1_000_000, "json", dir)!.more).toBe(false);
    const oneLine = Math.max(...[true, false].map((more) => otherLinesBytes({ pointer: true, recent: rl(3).recent, more }, [], "json")));
    const cut = buildBriefOtherLines(rl(5, false), [], oneLine, "json", dir)!;
    expect(cut.recent).toHaveLength(3);
    expect(cut.more).toBe(true);
  });

  it("an exact fit with more false never overruns by the byte \"false\" adds", () => {
    const lines = rl(2, false);
    const exact = otherLinesBytes({ pointer: true, recent: lines.recent, more: false }, [], "json");
    const all = buildBriefOtherLines(lines, [], exact, "json", dir)!;
    expect(all).toEqual({ pointer: true, recent: lines.recent, more: false });
    const under = buildBriefOtherLines(lines, [], exact - 1, "json", dir)!;
    expect(otherLinesBytes(under, [], "json")).toBeLessThanOrEqual(exact - 1);
    expect(under).toEqual({ pointer: true, recent: [lines.recent[0]], more: true });
  });

  it("in Markdown, where \"and more\" is the longer form, a scan with more never overruns at the boundary", () => {
    const lines = rl(2, true);
    const exact = otherLinesBytes({ pointer: true, recent: lines.recent, more: true }, [], "md");
    expect(buildBriefOtherLines(lines, [], exact, "md", dir)).toEqual({ pointer: true, recent: lines.recent, more: true });
    const under = buildBriefOtherLines(lines, [], exact - 1, "md", dir)!;
    expect(otherLinesBytes(under, [], "md")).toBeLessThanOrEqual(exact - 1);
    expect(under.recent).toEqual([lines.recent[0]]);
  });

  it("the notices stand outside the block's measure", () => {
    const n = ["x".repeat(500)];
    const withN = otherLinesBytes({ pointer: true, recent: rl(1).recent, more: true }, n, "md");
    expect(buildBriefOtherLines(rl(1), n, withN, "md", dir)!.recent).toHaveLength(1);
  });
});

describe("buildRawOtherLines (amendment M1)", () => {
  const long = (k: number) => ({ file: `2026-11-1${k}-01-${"n".repeat(700)}.md`, role: "r".repeat(40), by: "b".repeat(40) });
  it("keeps the block within 3,000 bytes in both formats, dropping from the end and saying and more", () => {
    const lines: RecentLines = { recent: [0, 1, 2, 3, 4].map(long), more: false, limited: false };
    const got = buildRawOtherLines(lines)!;
    expect(got.recent.length).toBeLessThan(5);
    expect(got.recent).toEqual(lines.recent.slice(0, got.recent.length));
    expect(got.more).toBe(true);
    for (const f of ["json", "md"] as const) expect(otherLinesBytes(got, [], f)).toBeLessThanOrEqual(OTHER_LINES_BLOCK_MAX_BYTES);
    const one = { ...got, recent: lines.recent.slice(0, got.recent.length + 1) };
    expect(Math.max(otherLinesBytes(one, [], "json"), otherLinesBytes(one, [], "md"))).toBeGreaterThan(OTHER_LINES_BLOCK_MAX_BYTES);
  });
  it("no block without a recent line", () => {
    expect(buildRawOtherLines({ recent: [], more: true, limited: false })).toBeUndefined();
  });
});

describe("the scan and the finaliser", () => {
  const linkedBody = (role: string): string => appendLineage("# H\n", serializeLineage({ role }).line);
  const noSelection: HandoverSelection = { files: [], source: "default", broken: null, limited: false, fill: null, endReached: true, walked: 0, visited: [] };

  it("the window holds at most 500 names and says limited past them", () => {
    const listing = Array.from({ length: 501 }, (_, i) => `2026-11-10-${String(1000 - i).padStart(4, "0")}-x.md`);
    for (const n of listing) writeFileSync(join(dir, n), "# H\n");
    const tails = new TailReader(dir, listing);
    const scan = scanRecentTails({ listing, tails, cutoff: "2026-11-01" });
    expect(scan.window).toEqual(listing.slice(0, 500));
    expect(scan.limited).toBe(true);
    expect(tails.reads).toBe(500);
    const at500 = scanRecentTails({ listing: listing.slice(0, 500), tails: new TailReader(dir, listing), cutoff: "2026-11-01" });
    expect(at500.limited).toBe(false);
  });

  it("filename admission applies to candidates, and role and by are clipped to 40 bytes", () => {
    const listing = ["2026-11-12-01-b.md", "2026-11-11-01-a.md"];
    writeFileSync(join(dir, listing[0]!), linkedBody("r".repeat(50)));
    writeFileSync(join(dir, listing[1]!), linkedBody("pen"));
    const tails = new TailReader(dir, listing);
    const scan = scanRecentTails({ listing, tails, cutoff: "2026-11-01" });
    const got = finaliseRecentLines({ listing, tails, scan, selection: noSelection, selected: [], memo: { kind: "none" }, admitted: (n) => n !== listing[1] });
    expect(got.recent).toEqual([{ file: listing[0], role: "r".repeat(40), by: null }]);
  });
});
