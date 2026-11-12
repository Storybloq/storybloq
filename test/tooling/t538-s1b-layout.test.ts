/**
 * T-538 signed-in note section 12, S1b: the attempt layout is a parameter of the provenance stop scan, the transcript
 * lister and recovery. Continuity's layout is the default and its behaviour is unchanged (its own suites pin it).
 * These rows drive a deeper, nested layout and show the traversal never follows a link at any level.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRegularFile } from "../../scripts/headless-common.js";
import {
  CONTINUITY_LAYOUT, layoutProblem, listRunTranscripts, PROVENANCE_INTENT_FILE, PROVENANCE_STOP_FILE, provenanceStops, recoverAttempt,
  unsafeSegment, type AttemptLayout, type ListingFs, type RecoveryFs, type StopScanFs,
} from "../../scripts/signed-in-attempt.js";
import * as viaContinuity from "../../scripts/continuity-run.js";
import type { RunOptions } from "../../scripts/continuity-run.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "t538s1b-"))); dirs.push(d); return d; };

/** A four-level layout with a fixed-name level in the middle, shaped like a driver's attempt tree. */
const NESTED: AttemptLayout = {
  levels: [{ name: "cell", pattern: /^c\d+$/ }, { name: "attempt", pattern: /^a-\d{3}$/ }, { name: "raw", pattern: /^raw$/ }, { name: "turn", pattern: /^turn-\d+$/ }],
  skipTop: ["shared"],
  accepts: () => true,
  describe: "<cell>/a-<nnn>/raw/turn-<n>",
};
const SID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const EXP = "abcdef012345";
const intent = (state: string): string => JSON.stringify({ state, schema: 1, sessionId: SID, expectedSha256: "e".repeat(64) });

function mk(root: string, rel: string, files: Record<string, string> = {}): string {
  const d = join(root, rel);
  mkdirSync(d, { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
  return d;
}

/** Real reads, each path recorded first: a row checks that nothing under a link's target was touched. */
function recordingStopFs(): { fs: StopScanFs; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    fs: {
      lstatSync: (p) => { seen.push(`lstat ${p}`); return lstatSync(p); },
      readdirSync: (p) => { seen.push(`readdir ${p}`); return readdirSync(p); },
      readIntent: (p) => { seen.push(`read ${p}`); return readRegularFile(p, 4096); },
    },
  };
}
function recordingListFs(): { fs: ListingFs; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    fs: {
      lstat: (p) => { seen.push(`lstat ${p}`); return lstatSync(p); },
      readdir: (p) => { seen.push(`readdir ${p}`); return readdirSync(p); },
      realpath: (p) => realpathSync(p),
      readIntent: (p, max) => { seen.push(`read ${p}`); return readRegularFile(p, max); },
    },
  };
}

describe("S1b: the layout parameter", () => {
  it("continuity's layout is the default, describes the existing tree, and is the one continuity-run re-exports", () => {
    expect(CONTINUITY_LAYOUT.levels.map((l) => l.name)).toEqual(["task", "repeat", "attempt"]);
    expect(CONTINUITY_LAYOUT.skipTop).toEqual(["pilot"]);
    expect(CONTINUITY_LAYOUT.describe).toBe("<task>/repeat-<n>/attempt-<nnn>");
    expect(viaContinuity.provenanceStops).toBe(provenanceStops);
    expect(viaContinuity.listRunTranscripts).toBe(listRunTranscripts);
    expect(viaContinuity.recoverAttempt).toBe(recoverAttempt);
  });

  it("the default and the explicit continuity layout scan a continuity tree the same way", () => {
    const root = tmp();
    mk(root, "T-4/repeat-1/attempt-001", { [PROVENANCE_STOP_FILE]: "{}" });
    mk(root, "T-4/repeat-1/attempt-002", { [PROVENANCE_INTENT_FILE]: intent("unresolved") });
    mk(root, "pilot/anything");
    expect(provenanceStops(root)).toEqual(["T-4/repeat-1/attempt-001", "T-4/repeat-1/attempt-002"]);
    expect(provenanceStops(root, undefined, CONTINUITY_LAYOUT)).toEqual(provenanceStops(root));
  });
});

describe("S1b: the stop scan on a nested layout", () => {
  it("walks every level and reports stops and open intents at the deepest one, skipping the layout's top-level folders", () => {
    const root = tmp();
    mk(root, "c1/a-001/raw/turn-1", { [PROVENANCE_INTENT_FILE]: intent("resolved") });
    mk(root, "c1/a-001/raw/turn-2", { [PROVENANCE_INTENT_FILE]: intent("unresolved") });
    mk(root, "c2/a-003/raw/turn-1", { [PROVENANCE_STOP_FILE]: "{}" });
    mk(root, "shared/not/an/attempt", { [PROVENANCE_STOP_FILE]: "{}" });
    expect(provenanceStops(root, undefined, NESTED)).toEqual(["c1/a-001/raw/turn-2", "c2/a-003/raw/turn-1"]);
    // The same tree under continuity's three levels: its "attempts" are the raw folders, which hold no records.
    expect(provenanceStops(root)).toEqual([]);
  });

  it.each([
    ["the second level", "c1/a-001", "c1"],
    ["the third (fixed-name) level", "c1/a-001/raw", "c1/a-001"],
    ["the deepest level", "c1/a-001/raw/turn-1", "c1/a-001/raw"],
  ])("never follows a link at %s: the scan refuses it and nothing under its target is read", (_n, linkRel, parentRel) => {
    const root = tmp();
    const target = tmp();
    mk(target, "", { [PROVENANCE_STOP_FILE]: "{}", [PROVENANCE_INTENT_FILE]: intent("unresolved") });
    mk(target, "raw/turn-1", { [PROVENANCE_STOP_FILE]: "{}" });
    mk(target, "a-001/raw/turn-1", { [PROVENANCE_STOP_FILE]: "{}" });
    mk(root, parentRel);
    symlinkSync(target, join(root, linkRel));
    const { fs, seen } = recordingStopFs();
    expect(() => provenanceStops(root, fs, NESTED)).toThrow(`continuity-run: an unexpected entry in the experiment's raw tree: ${join(root, linkRel)}`);
    expect(seen.filter((s) => s.includes(target) || s.startsWith(`readdir ${join(root, linkRel)}`) || s.startsWith(`read ${join(root, linkRel)}`))).toEqual([]);
  });

  it("an intent that is a link is a stop and is never opened, at the nested depth too", () => {
    const root = tmp();
    const target = join(tmp(), "elsewhere.json");
    writeFileSync(target, intent("resolved"));
    const d = mk(root, "c1/a-001/raw/turn-1");
    symlinkSync(target, join(d, PROVENANCE_INTENT_FILE));
    const { fs, seen } = recordingStopFs();
    expect(provenanceStops(root, fs, NESTED)).toEqual(["c1/a-001/raw/turn-1"]);
    expect(seen.filter((s) => s.startsWith("read "))).toEqual([]);
  });
});

describe("S1b: the transcript lister on a nested layout", () => {
  function home(): string {
    const h = tmp();
    mk(h, ".claude/projects/p1");
    writeFileSync(join(h, ".claude", "projects", "p1", `${SID}.jsonl`), "{}\n");
    return h;
  }

  it("lists each deepest-level attempt with its full nested label and finds its transcript by lstat", () => {
    const raw = tmp();
    mk(raw, `${EXP}/c1/a-001/raw/turn-1`, { [PROVENANCE_INTENT_FILE]: intent("resolved") });
    mk(raw, `${EXP}/c1/a-001/raw/turn-2`);
    mk(raw, `${EXP}/shared/x/raw/turn-1`, { [PROVENANCE_INTENT_FILE]: intent("resolved") });
    mk(raw, `${EXP}/c1/a-001/notraw/turn-1`, { [PROVENANCE_INTENT_FILE]: intent("resolved") });
    const h = home();
    const out = listRunTranscripts(raw, EXP, h, undefined, NESTED);
    expect(out.map((o) => [o.attempt, o.intent, o.sessionId])).toEqual([["c1/a-001/raw/turn-1", "resolved", SID], ["c1/a-001/raw/turn-2", "missing", null]]);
    expect(out[0]!.transcripts).toEqual([{ path: join(h, ".claude", "projects", "p1", `${SID}.jsonl`), size: 3 }]);
  });

  it.each([
    ["the second level", "c1/a-001", "c1"],
    ["the fixed-name level", "c1/a-001/raw", "c1/a-001"],
    ["the deepest level", "c1/a-001/raw/turn-1", "c1/a-001/raw"],
  ])("names a link at %s, never enters it and never reads beneath it", (_n, linkRel, parentRel) => {
    const raw = tmp();
    const target = tmp();
    mk(target, "", { [PROVENANCE_INTENT_FILE]: intent("unresolved") });
    mk(target, "raw/turn-1", { [PROVENANCE_INTENT_FILE]: intent("unresolved") });
    mk(target, "a-001/raw/turn-1", { [PROVENANCE_INTENT_FILE]: intent("unresolved") });
    mk(raw, `${EXP}/${parentRel}`);
    symlinkSync(target, join(raw, EXP, linkRel));
    const { fs, seen } = recordingListFs();
    const out = listRunTranscripts(raw, EXP, home(), fs, NESTED);
    expect(out).toHaveLength(1);
    expect(out[0]!.attempt).toBe(linkRel);
    expect(out[0]!.problems).toContain(`${join(raw, EXP, linkRel)} is not a real directory (a link, not followed)`);
    expect(seen.filter((s) => s.includes(target) || s.startsWith(`readdir ${join(raw, EXP, linkRel)}`) || s.startsWith(`read ${join(raw, EXP, linkRel)}`))).toEqual([]);
  });
});

describe("S1b: recovery's path on a nested layout", () => {
  const o = (rawOut: string): RunOptions => ({ isolation: "fresh", rawOut } as unknown as RunOptions);

  it("accepts a path of the layout's depth and walks it to the attempt folder", async () => {
    const raw = tmp();
    mk(raw, `${EXP}/c1/a-001/raw/turn-1`);
    await expect(recoverAttempt(o(raw), { experiment: EXP }, "c1/a-001/raw/turn-1", { layout: NESTED, homeRoot: tmp() })).rejects.toThrow(/no unresolved intent: nothing to recover/);
  });

  it.each([
    ["too shallow", "c1/a-001/raw"],
    ["too deep", "c1/a-001/raw/turn-1/x"],
    ["a level that does not match", "c1/a-001/notraw/turn-1"],
    ["a continuity path", "T-4/repeat-1/attempt-001"],
  ])("refuses a path that is %s, naming the layout's shape", async (_n, path) => {
    await expect(recoverAttempt(o(tmp()), { experiment: EXP }, path, { layout: NESTED })).rejects.toThrow(`continuity-run: --recover ${path} refused: the attempt must be <cell>/a-<nnn>/raw/turn-<n>`);
  });

  it("keeps continuity's refusal by default, including its task check", async () => {
    await expect(recoverAttempt(o(tmp()), { experiment: EXP }, "T-999999/repeat-1/attempt-001")).rejects.toThrow("refused: the attempt must be <task>/repeat-<n>/attempt-<nnn>");
    await expect(recoverAttempt(o(tmp()), { experiment: EXP }, "c1/a-001/raw/turn-1")).rejects.toThrow("refused: the attempt must be <task>/repeat-<n>/attempt-<nnn>");
  });

  it("never follows a link on the way: a linked level is refused as not a real directory", async () => {
    const raw = tmp();
    const target = tmp();
    mk(target, "turn-1");
    mk(raw, `${EXP}/c1/a-001`);
    symlinkSync(target, join(raw, EXP, "c1", "a-001", "raw"));
    await expect(recoverAttempt(o(raw), { experiment: EXP }, "c1/a-001/raw/turn-1", { layout: NESTED, homeRoot: tmp() })).rejects.toThrow(`${join(raw, EXP, "c1", "a-001", "raw")} is not a real directory`);
  });
});

/** Recovery reads, each recorded first: a refused path must show zero calls. */
function recordingRecoveryFs(): { fs: RecoveryFs; seen: string[] } {
  const seen: string[] = [];
  return { seen, fs: { lstat: (p) => { seen.push(`lstat ${p}`); return lstatSync(p); }, read: (p, max) => { seen.push(`read ${p}`); return readRegularFile(p, max); } } };
}
/** Deliberately permissive: every level would accept "..", "." and (for the second) an empty segment. */
const PERMISSIVE: AttemptLayout = {
  levels: [{ name: "a", pattern: /^.+$/ }, { name: "b", pattern: /.*/ }, { name: "c", pattern: /.*/ }, { name: "d", pattern: /^.+$/ }],
  skipTop: [],
  accepts: () => true,
  describe: "<a>/<b>/<c>/<d>",
};

describe("S1b fix P1: recovery stays inside the experiment folder whatever the layout accepts", () => {
  const o = (rawOut: string): RunOptions => ({ isolation: "fresh", rawOut } as unknown as RunOptions);
  const SEGMENT = 'the attempt path has an empty, "." or ".." segment, or a separator or NUL inside one';

  it.each([
    ["a traversal", "c1/../x/turn-1"],
    ["a traversal out of the experiment", "../../outside/turn-1"],
    ["a doubled separator", "c1//a-001/raw"],
    ["a trailing separator", "c1/a-001/raw/"],
    ["a leading separator", "/c1/a-001/raw"],
    ["a dot segment", "c1/./raw/turn-1"],
    ["a backslash inside a segment", "c1/a\\..\\b/raw/turn-1"],
    ["a NUL inside a segment", "c1/a\u0000b/raw/turn-1"],
  ])("refuses %s before any filesystem access, under a permissive layout", async (_n, path) => {
    const raw = tmp();
    mk(raw, `${EXP}/x/turn-1`);
    mk(raw, "outside/turn-1");
    const { fs, seen } = recordingRecoveryFs();
    await expect(recoverAttempt(o(raw), { experiment: EXP }, path, { layout: PERMISSIVE, recoveryFs: fs, homeRoot: tmp() })).rejects.toThrow(`refused: ${SEGMENT}`);
    expect(seen).toEqual([]);
  });

  it("the same paths are refused under continuity's default layout too, with zero calls", async () => {
    const { fs, seen } = recordingRecoveryFs();
    await expect(recoverAttempt(o(tmp()), { experiment: EXP }, "T-4/../attempt-001", { recoveryFs: fs })).rejects.toThrow(SEGMENT);
    await expect(recoverAttempt(o(tmp()), { experiment: EXP }, "T-4//attempt-001", { recoveryFs: fs })).rejects.toThrow(SEGMENT);
    expect(seen).toEqual([]);
  });

  it("names the unsafe segments, independently of any layout", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\u0000b"]) expect(unsafeSegment(bad)).toBe(true);
    for (const ok of ["c1", "a-001", "...", "..a", "a..", ".hidden"]) expect(unsafeSegment(ok)).toBe(false);
  });

  it("a safe path under the permissive layout still reaches the attempt folder", async () => {
    const raw = tmp();
    mk(raw, `${EXP}/c1/a-001/raw/turn-1`);
    const { fs, seen } = recordingRecoveryFs();
    await expect(recoverAttempt(o(raw), { experiment: EXP }, "c1/a-001/raw/turn-1", { layout: PERMISSIVE, recoveryFs: fs, homeRoot: tmp() })).rejects.toThrow(/no unresolved intent: nothing to recover/);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("S1b fix P2: the layout is validated at every entry point", () => {
  const o = (rawOut: string): RunOptions => ({ isolation: "fresh", rawOut } as unknown as RunOptions);
  const EMPTY: AttemptLayout = { levels: [], skipTop: [], accepts: () => true, describe: "<nothing>" };
  const flagged = (flags: string): AttemptLayout => ({ ...NESTED, levels: NESTED.levels.map((l, i) => (i === 1 ? { name: l.name, pattern: new RegExp(l.pattern.source, flags) } : l)) });

  it.each([
    ["an empty layout", EMPTY, /it has no levels/],
    ["a g-flag pattern", flagged("g"), /carries the g or y flag/],
    ["a y-flag pattern", flagged("y"), /carries the g or y flag/],
  ])("refuses %s at the stop scan, the lister and recovery, before any filesystem access", async (_n, layout, why) => {
    const raw = tmp();
    mk(raw, `${EXP}/c1/a-001/raw/turn-1`, { [PROVENANCE_STOP_FILE]: "{}" });
    const stop = recordingStopFs();
    expect(() => provenanceStops(join(raw, EXP), stop.fs, layout)).toThrow(why);
    expect(stop.seen).toEqual([]);
    const list = recordingListFs();
    expect(() => listRunTranscripts(raw, EXP, tmp(), list.fs, layout)).toThrow(why);
    expect(list.seen).toEqual([]);
    const rec = recordingRecoveryFs();
    await expect(recoverAttempt(o(raw), { experiment: EXP }, "c1/a-001/raw/turn-1", { layout, recoveryFs: rec.fs, homeRoot: tmp() })).rejects.toThrow(why);
    expect(rec.seen).toEqual([]);
  });

  it("accepts the continuity and nested layouts", () => {
    expect(layoutProblem(CONTINUITY_LAYOUT)).toBeNull();
    expect(layoutProblem(NESTED)).toBeNull();
  });

  it("a repeated call gives the same answer at each entry point", async () => {
    const raw = tmp();
    mk(raw, `${EXP}/c1/a-001/raw/turn-1`, { [PROVENANCE_STOP_FILE]: "{}" });
    mk(raw, `${EXP}/c2/a-002/raw/turn-3`);
    const first = provenanceStops(join(raw, EXP), undefined, NESTED);
    expect(first.length).toBeGreaterThan(0);
    expect(provenanceStops(join(raw, EXP), undefined, NESTED)).toEqual(first);
    const home = tmp();
    const l1 = listRunTranscripts(raw, EXP, home, undefined, NESTED);
    expect(l1.map((x) => x.attempt)).toEqual(["c1/a-001/raw/turn-1", "c2/a-002/raw/turn-3"]);
    expect(listRunTranscripts(raw, EXP, home, undefined, NESTED)).toEqual(l1);
    for (let i = 0; i < 3; i++) await expect(recoverAttempt(o(raw), { experiment: EXP }, "c2/a-002/raw/turn-3", { layout: NESTED, homeRoot: home })).rejects.toThrow(/no unresolved intent: nothing to recover/);
  });
});
