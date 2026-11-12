/**
 * T-525 Addendum E5: the run's transcripts are listed for the owner after the matrix, metadata only. The lister walks
 * the raw dirs for each attempt's intent session id and looks for that id's transcript under a home's projects folder
 * by lstat alone: it never opens a transcript, never follows a link, never deletes. Fake raw dirs and a fake home only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliListTranscripts, listRunTranscripts, readRegularFile, PROVENANCE_INTENT_FILE, type ListingFs } from "../../scripts/continuity-run.js";

const EXP = "0123456789ab";
const SID1 = "11111111-2222-4333-8444-555555555555";
const SID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let root: string; let raw: string; let home: string;
const seen: { lstat: string[]; readdir: string[]; realpath: string[]; read: string[] } = { lstat: [], readdir: [], realpath: [], read: [] };
type Hooks = { afterReaddir?: (p: string) => void; afterLstat?: (p: string) => void; beforeRead?: (p: string) => void };
const recording = (fail: (op: "lstat" | "read", p: string) => string | null = () => null, h: Hooks = {}): ListingFs => ({
  lstat: (p) => { seen.lstat.push(p); const e = fail("lstat", p); if (e) throw Object.assign(new Error(e), { code: e }); const st = lstatSync(p); h.afterLstat?.(p); return st; },
  readdir: (p) => { seen.readdir.push(p); const n = readdirSync(p); h.afterReaddir?.(p); return n; },
  realpath: (p) => { seen.realpath.push(p); return realpathSync(p); },
  readIntent: (p, max) => { seen.read.push(p); h.beforeRead?.(p); const e = fail("read", p); if (e) throw Object.assign(new Error(e), { code: e }); return readRegularFile(p, max); },
});
// A folder swapped for a link to `target`, once, as a racing writer would.
const swap = (p: string, target: string): void => { renameSync(p, `${p}.was`); symlinkSync(target, p); };
const touched = (prefix: string): string[] => [...seen.lstat, ...seen.readdir, ...seen.realpath, ...seen.read].filter((p) => p.startsWith(prefix));
const attempt = (label: string, intent?: unknown): string => {
  const d = join(raw, EXP, ...label.split("/")); mkdirSync(d, { recursive: true });
  if (intent !== undefined) writeFileSync(join(d, PROVENANCE_INTENT_FILE), typeof intent === "string" ? intent : `${JSON.stringify(intent)}\n`);
  return d;
};
const transcript = (project: string, sid: string, text: string): string => {
  const d = join(home, ".claude", "projects", project); mkdirSync(d, { recursive: true });
  const p = join(d, `${sid}.jsonl`); writeFileSync(p, text); return p;
};
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); const st = lstatSync(p); out[p] = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : `${st.size}:${st.mtimeMs}`; if (st.isDirectory()) walk(p); } };
  walk(dir); return out;
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "e5-list-"))); raw = join(root, "raw"); home = join(root, "home");
  mkdirSync(raw); mkdirSync(home); seen.lstat = []; seen.readdir = []; seen.realpath = []; seen.read = [];
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("E5 the transcript lister, metadata only", () => {
  it("lists each attempt's intent session id and its transcripts with their sizes, in order", () => {
    attempt("T-4/repeat-1/attempt-001", { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) });
    attempt("T-4/repeat-1/attempt-002", { state: "resolved", schema: 1, sessionId: SID2, expectedSha256: "a".repeat(64) });
    attempt("T-5/repeat-1/attempt-001");
    const t1 = transcript("-w-one", SID1, "x".repeat(17));
    const t1b = transcript("-w-two", SID1, "yy");
    expect(listRunTranscripts(raw, EXP, home, recording())).toEqual([
      { attempt: "T-4/repeat-1/attempt-001", intent: "unresolved", sessionId: SID1, transcripts: [{ path: t1, size: 17 }, { path: t1b, size: 2 }], runtimeDirectories: [], problems: [] },
      { attempt: "T-4/repeat-1/attempt-002", intent: "resolved", sessionId: SID2, transcripts: [], runtimeDirectories: [], problems: [] },
      { attempt: "T-5/repeat-1/attempt-001", intent: "missing", sessionId: null, transcripts: [], runtimeDirectories: [], problems: [] },
    ]);
  });
  it("never opens a transcript and never deletes or changes anything", () => {
    attempt("T-4/repeat-1/attempt-001", { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) });
    transcript("-w", SID1, "secret transcript text");
    const before = { raw: tree(raw), home: tree(home) };
    listRunTranscripts(raw, EXP, home, recording());
    expect(seen.read.every((p) => p.endsWith(`/${PROVENANCE_INTENT_FILE}`))).toBe(true);
    expect(seen.read).toHaveLength(1);
    expect({ raw: tree(raw), home: tree(home) }).toEqual(before);
  });
  it("a transcript that is a link is named, not followed and not listed", () => {
    attempt("T-4/repeat-1/attempt-001", { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) });
    const target = join(root, "elsewhere.jsonl"); writeFileSync(target, "t");
    mkdirSync(join(home, ".claude", "projects", "-w"), { recursive: true });
    symlinkSync(target, join(home, ".claude", "projects", "-w", `${SID1}.jsonl`));
    const [r] = listRunTranscripts(raw, EXP, home, recording());
    expect(r!.transcripts).toEqual([]);
    expect(r!.problems).toEqual([`${join(home, ".claude", "projects", "-w", `${SID1}.jsonl`)} is a link, not followed`]);
  });
  it("a projects entry that is a link is never entered, and the projects folder as a link is never entered", () => {
    attempt("T-4/repeat-1/attempt-001", { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) });
    const outside = join(root, "outside-project"); mkdirSync(outside); writeFileSync(join(outside, `${SID1}.jsonl`), "t");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    symlinkSync(outside, join(home, ".claude", "projects", "-linked"));
    let [r] = listRunTranscripts(raw, EXP, home, recording());
    expect(r!.transcripts).toEqual([]);
    expect(r!.problems).toEqual([`${join(home, ".claude", "projects", "-linked")} is a link, not followed`]);
    expect(seen.lstat.some((p) => p.startsWith(outside) || p.startsWith(join(home, ".claude", "projects", "-linked") + "/"))).toBe(false);
    rmSync(join(home, ".claude", "projects"), { recursive: true }); symlinkSync(join(root, "outside-project"), join(home, ".claude", "projects"));
    seen.readdir = [];
    [r] = listRunTranscripts(raw, EXP, home, recording());
    expect(r!.transcripts).toEqual([]);
    expect(r!.problems).toEqual([`${join(home, ".claude", "projects")} is a link, not followed`]);
    expect(seen.readdir.includes(join(home, ".claude", "projects"))).toBe(false);
  });
  it.each(["EACCES", "EIO"])("%s checking a transcript is named as a problem, never read as absent", (errno) => {
    attempt("T-4/repeat-1/attempt-001", { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) });
    const t = transcript("-w", SID1, "t");
    const [r] = listRunTranscripts(raw, EXP, home, recording((op, p) => (op === "lstat" && p === t ? errno : null)));
    expect(r!.transcripts).toEqual([]);
    expect(r!.problems).toEqual([`${t} cannot be checked (${errno})`]);
  });
  it.each(["EACCES", "EIO"])("%s reading the intent is named as unreadable", (errno) => {
    const d = attempt("T-4/repeat-1/attempt-001", { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) });
    transcript("-w", SID1, "t");
    const [r] = listRunTranscripts(raw, EXP, home, recording((op, p) => (op === "read" && p === join(d, PROVENANCE_INTENT_FILE) ? errno : null)));
    expect(r).toMatchObject({ intent: "unreadable", sessionId: null, transcripts: [], problems: [`the intent is unreadable (${errno})`] });
  });
  it("an intent that is a link is not followed", () => {
    const d = attempt("T-4/repeat-1/attempt-001");
    const target = join(root, "intent.json"); writeFileSync(target, JSON.stringify({ state: "unresolved", sessionId: SID1 }));
    symlinkSync(target, join(d, PROVENANCE_INTENT_FILE));
    transcript("-w", SID1, "t");
    const [r] = listRunTranscripts(raw, EXP, home, recording());
    expect(r).toMatchObject({ intent: "unreadable", sessionId: null, transcripts: [], problems: ["the intent is a link, not followed"] });
    expect(seen.read).toEqual([]);
  });
  it.each([
    ["no session id", { state: "unresolved", schema: 1 }],
    ["an invalid session id", { state: "unresolved", sessionId: "../../etc" }],
    ["an unknown state", { state: "odd", sessionId: SID1 }],
  ])("an intent with %s is malformed, and nothing is looked up for it", (_n, intent) => {
    attempt("T-4/repeat-1/attempt-001", intent);
    transcript("-w", SID1, "t");
    const [r] = listRunTranscripts(raw, EXP, home, recording());
    expect(r).toMatchObject({ intent: "malformed", sessionId: null, transcripts: [] });
  });
  it("a raw chain entry that is a link is named, not entered", () => {
    mkdirSync(join(raw, EXP, "T-4"), { recursive: true });
    const real = join(root, "realrepeat"); mkdirSync(join(real, "attempt-001"), { recursive: true });
    writeFileSync(join(real, "attempt-001", PROVENANCE_INTENT_FILE), JSON.stringify({ state: "unresolved", sessionId: SID1 }));
    symlinkSync(real, join(raw, EXP, "T-4", "repeat-1"));
    expect(listRunTranscripts(raw, EXP, home, recording())).toEqual([
      { attempt: "T-4/repeat-1", intent: "missing", sessionId: null, transcripts: [], runtimeDirectories: [], problems: [`${join(raw, EXP, "T-4", "repeat-1")} is not a real directory (a link, not followed)`] },
    ]);
    expect(seen.readdir.some((p) => p.startsWith(join(raw, EXP, "T-4", "repeat-1")))).toBe(false);
    expect(seen.read).toEqual([]);
  });
  it("a missing experiment folder or a non-hex experiment refuses", () => {
    expect(() => listRunTranscripts(raw, EXP, home, recording())).toThrow(/is not a real directory \(absent\)/);
    expect(() => listRunTranscripts(raw, "../x", home, recording())).toThrow(/hex id/);
  });
  it("the CLI needs --home named explicitly, is never combined with a run or a recovery, and prints one JSON line per attempt", () => {
    attempt("T-4/repeat-1/attempt-001", { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) });
    const t = transcript("-w", SID1, "abc");
    const lines: string[] = [];
    expect(cliListTranscripts(["--run"], (s) => lines.push(s))).toBe(false);
    expect(() => cliListTranscripts(["--list-transcripts", "--experiment", EXP, "--raw-out", raw], (s) => lines.push(s))).toThrow(/needs --home/);
    expect(() => cliListTranscripts(["--list-transcripts", "--experiment", EXP, "--raw-out", raw, "--home", "--tasks"], (s) => lines.push(s))).toThrow(/not combined|needs --home/);
    for (const f of ["--recover", "--tasks", "--pilot", "--repeats"]) expect(() => cliListTranscripts(["--list-transcripts", f, "x", "--home", home], (s) => lines.push(s))).toThrow(/not combined/);
    expect(cliListTranscripts(["--list-transcripts", "--experiment", EXP, "--raw-out", raw, "--home", home], (s) => lines.push(s))).toBe(true);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ attempt: "T-4/repeat-1/attempt-001", intent: "unresolved", sessionId: SID1, transcripts: [{ path: t, size: 3 }], runtimeDirectories: [], problems: [] }]);
    expect(readFileSync(t, "utf-8")).toBe("abc");
  });
});

describe("E5 fix round: links on the way and folders swapped while they are used", () => {
  const INTENT = { state: "unresolved", schema: 1, sessionId: SID1, expectedSha256: "a".repeat(64) };
  it("E-F1: a linked raw folder refuses the whole listing before anything beneath it is touched", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    const linked = join(root, "raw-link"); symlinkSync(raw, linked);
    expect(() => listRunTranscripts(linked, EXP, home, recording())).toThrow(/the raw folder .* is not a real directory \(a link, not followed\); nothing listed/);
    expect(touched(`${linked}/`)).toEqual([]);
    expect(touched(`${raw}/`)).toEqual([]);
  });
  it("E-F1: a raw folder under a linked ancestor refuses (its real path is not the path given)", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    const up = join(root, "up-link"); symlinkSync(root, up);
    expect(() => listRunTranscripts(join(up, "raw"), EXP, home, recording())).toThrow(/is not its own real path .*a component is a link/);
    expect(touched(`${join(up, "raw")}/`)).toEqual([]);
  });
  it("E-F1: a linked experiment folder refuses, and nothing beneath it is touched", () => {
    const real = join(root, "exp-real"); mkdirSync(join(real, "T-4", "repeat-1", "attempt-001"), { recursive: true });
    symlinkSync(real, join(raw, EXP));
    expect(() => listRunTranscripts(raw, EXP, home, recording())).toThrow(/the experiment folder .* is not a real directory \(a link, not followed\)/);
    expect(touched(`${join(raw, EXP)}/`)).toEqual([]);
    expect(touched(real)).toEqual([]);
  });
  it("E-F1: a linked home refuses the whole listing, and nothing beneath it or the raw folder is touched", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    const realHome = join(root, "home-real"); mkdirSync(join(realHome, ".claude", "projects", "-w"), { recursive: true });
    writeFileSync(join(realHome, ".claude", "projects", "-w", `${SID1}.jsonl`), "t");
    const linked = join(root, "home-link"); symlinkSync(realHome, linked);
    expect(() => listRunTranscripts(raw, EXP, linked, recording())).toThrow(/the home .* is not a real directory \(a link, not followed\); nothing listed/);
    expect(touched(`${linked}/`)).toEqual([]);
    expect(touched(realHome)).toEqual([]);
    expect(touched(`${raw}/`)).toEqual([]);
  });
  it("E-F1: a linked home/.claude is named and never entered", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    const realClaude = join(root, "claude-real"); mkdirSync(join(realClaude, "projects", "-w"), { recursive: true });
    writeFileSync(join(realClaude, "projects", "-w", `${SID1}.jsonl`), "t");
    symlinkSync(realClaude, join(home, ".claude"));
    const [r] = listRunTranscripts(raw, EXP, home, recording());
    expect(r).toEqual({ attempt: "T-4/repeat-1/attempt-001", intent: "unresolved", sessionId: SID1, transcripts: [], runtimeDirectories: [], problems: [`${join(home, ".claude")} is a link, not followed`] });
    expect(touched(`${join(home, ".claude")}/`)).toEqual([]);
    expect(touched(realClaude)).toEqual([]);
  });
  it("E-F2: a task folder swapped for a link after it was listed loses its entries, named", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    const decoy = join(root, "decoy"); mkdirSync(join(decoy, "repeat-1", "attempt-001"), { recursive: true });
    writeFileSync(join(decoy, "repeat-1", "attempt-001", PROVENANCE_INTENT_FILE), JSON.stringify({ state: "unresolved", sessionId: SID2 }));
    const task = join(raw, EXP, "T-4"); let done = false;
    const rows = listRunTranscripts(raw, EXP, home, recording(undefined, { afterReaddir: (p) => { if (p === task && !done) { done = true; swap(task, decoy); } } }));
    expect(rows).toEqual([{ attempt: "T-4", intent: "missing", sessionId: null, transcripts: [], runtimeDirectories: [], problems: [`${task} changed while it was listed (its real path is now ${decoy}); its entries are discarded`] }]);
    expect(seen.read).toEqual([]);
  });
  it("E-F2: a project folder swapped for a link during its lookups loses its results, named", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    const t = transcript("-w", SID1, "abc");
    const proj = join(home, ".claude", "projects", "-w");
    const decoy = join(root, "decoy-project"); mkdirSync(join(decoy, SID1), { recursive: true }); writeFileSync(join(decoy, `${SID1}.jsonl`), "decoy text");
    let done = false;
    const [r] = listRunTranscripts(raw, EXP, home, recording(undefined, { afterLstat: (p) => { if (p === t && !done) { done = true; swap(proj, decoy); } } }));
    expect(r).toEqual({ attempt: "T-4/repeat-1/attempt-001", intent: "unresolved", sessionId: SID1, transcripts: [], runtimeDirectories: [], problems: [`${proj} changed while it was checked (its real path is now ${decoy}); its results are discarded`] });
  });
  it("E-F2: the projects folder swapped for a link after it was listed loses every project, named once", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    transcript("-w", SID1, "abc");
    const projects = join(home, ".claude", "projects");
    const decoy = join(root, "decoy-projects"); mkdirSync(join(decoy, "-w"), { recursive: true }); writeFileSync(join(decoy, "-w", `${SID1}.jsonl`), "decoy");
    let done = false;
    const [r] = listRunTranscripts(raw, EXP, home, recording(undefined, { afterReaddir: (p) => { if (p === projects && !done) { done = true; swap(projects, decoy); } } }));
    expect(r).toEqual({ attempt: "T-4/repeat-1/attempt-001", intent: "unresolved", sessionId: SID1, transcripts: [], runtimeDirectories: [], problems: [`${projects} changed while it was listed (its real path is now ${decoy}); its entries are discarded`] });
    expect(touched(`${decoy}/`)).toEqual([]);
  });
  it("E-F2: an attempt folder swapped for a link before the intent read loses the content, named", () => {
    const d = attempt("T-4/repeat-1/attempt-001", INTENT);
    transcript("-w", SID2, "t");
    const decoy = join(root, "decoy-attempt"); mkdirSync(decoy);
    writeFileSync(join(decoy, PROVENANCE_INTENT_FILE), JSON.stringify({ state: "unresolved", sessionId: SID2 }));
    let done = false;
    const [r] = listRunTranscripts(raw, EXP, home, recording(undefined, { beforeRead: (p) => { if (p === join(d, PROVENANCE_INTENT_FILE) && !done) { done = true; swap(d, decoy); } } }));
    expect(r).toEqual({ attempt: "T-4/repeat-1/attempt-001", intent: "unreadable", sessionId: null, transcripts: [], runtimeDirectories: [], problems: [`${d} changed while the intent was read (its real path is now ${decoy}); the content is discarded`] });
  });
  it("E-F3: a session's runtime folder alone is listed by path, never entered; a linked one is named", () => {
    attempt("T-4/repeat-1/attempt-001", INTENT);
    const rd = join(home, ".claude", "projects", "-w", SID1); mkdirSync(rd, { recursive: true }); writeFileSync(join(rd, "inside.txt"), "x");
    const other = join(root, "elsewhere-dir"); mkdirSync(other);
    mkdirSync(join(home, ".claude", "projects", "-v"), { recursive: true }); symlinkSync(other, join(home, ".claude", "projects", "-v", SID1));
    const [r] = listRunTranscripts(raw, EXP, home, recording());
    expect(r).toEqual({ attempt: "T-4/repeat-1/attempt-001", intent: "unresolved", sessionId: SID1, transcripts: [], runtimeDirectories: [rd], problems: [`${join(home, ".claude", "projects", "-v", SID1)} is a link, not followed`] });
    expect(touched(`${rd}/`)).toEqual([]);
    expect(seen.readdir.includes(rd)).toBe(false);
    expect(touched(other)).toEqual([]);
  });
});
