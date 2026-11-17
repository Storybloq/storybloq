/**
 * T-575 commit 2: the opening stage at the function level (plan sections 4
 * to 7, acceptance C12 rows 1 to 13), with injected seams. Not wired into
 * `duet spawn` yet; the launcher rows are commit 3's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { continueLineUnlocked } from "../../src/cli/commands/handover.js";
import { initProject } from "../../src/core/init.js";
import { digestBytes, memoFileName, readLineMemo, resolveLineMemoStrict, serializeLineMemo, verifyHandoverDigest } from "../../src/core/handover-line-memo.js";
import { splitLineage } from "../../src/core/handover-lineage.js";
import { TailReader } from "../../src/core/handover-selection.js";
import { createMemoSeams, handleHandoverCreate } from "../../src/cli/commands/handover.js";
import {
  composeOpeningHandover, decodeOpeningPlan, decodeOpeningRecord, openWorkerLine, OpeningStopped, readOpeningRecord, serializeOpeningRecord,
  type OpeningDeps, type OpeningInput, type OpeningPlan, type OpeningRecord,
} from "../../src/core/duet-spawn-line.js";
import { isolateEnv, type IsolatedEnv } from "../fixtures/handover-lineage/harness.js";

// A rename onto the armed memo path fails with EACCES `remaining` times.
const failMemo: { path: string | null; remaining: number } = { path: null, remaining: 0 };
vi.mock("node:fs", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:fs") & { default: typeof import("node:fs") }>();
  const renameSync = (from: import("node:fs").PathLike, to: import("node:fs").PathLike): void => {
    if (failMemo.path !== null && String(to) === failMemo.path && failMemo.remaining > 0) {
      failMemo.remaining--;
      throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
    }
    m.renameSync(from, to);
  };
  return { ...m, renameSync, default: { ...m.default, renameSync } };
});

// The team filename generator, scripted while `forced` holds names.
const forced: { names: string[] } = { names: [] };
vi.mock("../../src/core/handover-filename.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/core/handover-filename.js")>();
  return { ...m, generateTeamHandoverFilename: (slug: string) => forced.names.shift() ?? m.generateTeamHandoverFilename(slug) };
});

const W = "0b0b0b0b-1111-4222-8333-444444444444";
const PEN_TASK = "pen-task.1";
let env: IsolatedEnv;
const chmodded: string[] = [];
beforeEach(() => { env = isolateEnv(); forced.names = []; failMemo.path = null; failMemo.remaining = 0; });
afterEach(() => {
  for (const p of chmodded.splice(0)) { try { chmodSync(p, 0o700); } catch { /* gone */ } }
  createMemoSeams.afterIntent = null;
  createMemoSeams.beforeFinalMemo = null;
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

class Crash extends Error {}
const crash = (): never => { throw new Crash("simulated crash"); };

interface Rig {
  board: string;
  penRoot: string;
  hdir: string;
  memo: string;
  recordPath: string;
  journalPath: string;
  input: (over?: Partial<OpeningInput>) => OpeningInput;
}

async function rig(opts: { team?: boolean; separatePen?: boolean; mode?: OpeningPlan["mode"]; continueFile?: string; files?: Record<string, string> } = {}): Promise<Rig> {
  const board = realpathSync(mkdtempSync(join(env.base, "board-")));
  await initProject(board, { name: "board" });
  if (opts.team) {
    const cfgPath = join(board, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.team = { enabled: true };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  }
  let penRoot = board;
  if (opts.separatePen) {
    penRoot = realpathSync(mkdtempSync(join(env.base, "pen-")));
    await initProject(penRoot, { name: "pen" });
  }
  const hdir = join(board, ".story", "handovers");
  mkdirSync(hdir, { recursive: true });
  for (const [n, c] of Object.entries(opts.files ?? {})) writeFileSync(join(hdir, n), c);
  const spawnDir = join(penRoot, ".story", "spawn", "w1.abcd");
  mkdirSync(spawnDir, { recursive: true });
  const plan: OpeningPlan = { mode: opts.mode ?? "new-line", board, continueFile: opts.continueFile ?? null };
  const r: Rig = {
    board, penRoot, hdir,
    memo: join(board, ".story", "telemetry", "handover-lines", memoFileName(W)),
    recordPath: join(spawnDir, "w1.opening"),
    journalPath: join(spawnDir, "w1.json"),
    input: (over = {}) => ({
      penRoot, journalPath: r.journalPath, recordPath: r.recordPath, plan, name: "w1", pen: "pen-1", penTaskId: PEN_TASK,
      workerTaskId: W, arrangementId: "a-0123456789abcdef", bounds: ["T-1", "ISS-2"], now: () => new Date(2026, 10, 17, 9, 0, 0), ...over,
    }),
  };
  return r;
}

const mdFiles = (r: Rig): string[] => readdirSync(r.hdir).filter((n) => n.endsWith(".md")).sort();
const record = (r: Rig): OpeningRecord | null => {
  if (!existsSync(r.recordPath)) return null;
  const read = readOpeningRecord(r.recordPath, W);
  return read.kind === "ok" ? read.record : null;
};
const strict = (r: Rig) => resolveLineMemoStrict(r.board, W, new TailReader(r.hdir, mdFiles(r)));
const open = (r: Rig, deps: OpeningDeps = {}, over: Partial<OpeningInput> = {}) => openWorkerLine(r.input(over), deps);
async function stopped(p: Promise<unknown>): Promise<OpeningStopped> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OpeningStopped);
  return err as OpeningStopped;
}
const body = (id: string): string => `# Handover ${id}\n\n## Next steps\n\n- **${id}** carry on with ${id}\n`;
const seedMemo = (r: Rig, tip: string | null): void => {
  mkdirSync(join(r.board, ".story", "telemetry", "handover-lines"), { recursive: true });
  writeFileSync(r.memo, serializeLineMemo({ v: 1, task: W, tip, writing: null }));
};

describe("T-575 composeOpeningHandover and the decoders", () => {
  it("composes the fixed text; the origin board appears only when the boards differ", () => {
    const base = { name: "w1", pen: "pen-1", penTaskId: null, workerTaskId: W, arrangementId: null, bounds: [], now: new Date(2026, 10, 17), penBoard: null };
    expect(composeOpeningHandover(base)).toBe([
      "# Worker line opened: w1", "",
      "- Dispatched by: pen-1 (task not recorded)",
      `- Worker: w1 (task ${W})`,
      "- Date: 2026-11-17",
      "- Arrangement: none", "",
      "## Assignment", "",
      "- (none given)", "",
    ].join("\n"));
    const other = composeOpeningHandover({ ...base, penTaskId: PEN_TASK, arrangementId: "a-1", bounds: ["T-1"], penBoard: "/x/pen" });
    expect(other).toContain(`- Dispatched by: pen-1 (task ${PEN_TASK}), from the board at /x/pen\n`);
    expect(other).toContain("## Assignment\n\n- T-1\n");
  });

  it("decodeOpeningRecord accepts exactly the record shape for its task", () => {
    const ok: OpeningRecord = { v: 1, task: W, intent: { file: "2026-11-17-01-w1-line-opened.md", sha256: "a".repeat(64) }, attempt: null, outcome: null, file: null };
    expect(decodeOpeningRecord(serializeOpeningRecord(ok), W)).toEqual(ok);
    expect(decodeOpeningRecord(serializeOpeningRecord(ok), "other")).toBeNull();
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, intent: { file: "../x.md", sha256: "a".repeat(64) } },
      { ...ok, intent: { file: "2026-11-17-01-a.md", sha256: "A".repeat(64) } },
      { ...ok, attempt: { file: "2026-11-17-01-a.md", defaultLine: "yes" } },
      { ...ok, outcome: "launched" },
      { ...ok, file: "a/b.md" },
    ]) expect(decodeOpeningRecord(JSON.stringify(bad), W)).toBeNull();
    expect(decodeOpeningRecord("not json", W)).toBeNull();
  });

  it("decodeOpeningPlan validates every field the opening uses", async () => {
    const r = await rig();
    const entry = { name: "w1", workerDir: r.board, workerTaskId: W, opening: { mode: "new-line", board: r.board, continueFile: null } };
    expect(decodeOpeningPlan(entry)).toMatchObject({ name: "w1", plan: { mode: "new-line", board: r.board } });
    const link = join(env.base, "link-to-board");
    symlinkSync(r.board, link);
    expect(decodeOpeningPlan({ ...entry, workerDir: link })).not.toBeNull();
    for (const bad of [
      { ...entry, name: "w/1" },
      { ...entry, workerDir: "relative/dir" },
      { ...entry, workerDir: join(env.base, "missing") },
      { ...entry, workerDir: join(r.board, ".story", "config.json") },
      { ...entry, workerTaskId: "not a task id" },
      { ...entry, opening: { ...entry.opening, mode: "sideways" } },
      { ...entry, opening: { ...entry.opening, board: link } },
      { ...entry, opening: { ...entry.opening, board: env.base } },
      { ...entry, opening: { ...entry.opening, continueFile: "2026-11-17-01-a.md" } },
      { ...entry, opening: { mode: "continue", board: r.board, continueFile: null } },
      { ...entry, opening: { ...entry.opening, extra: 1 } },
    ]) expect(decodeOpeningPlan(bad)).toBeNull();
  });

  it("verifyHandoverDigest tells match, differs, absent and unknown apart", async () => {
    const r = await rig({ files: { "2026-11-17-01-a.md": body("A") } });
    const sha = digestBytes(Buffer.from(body("A")));
    expect(verifyHandoverDigest(r.hdir, "2026-11-17-01-a.md", sha)).toBe("match");
    expect(verifyHandoverDigest(r.hdir, "2026-11-17-01-a.md", "b".repeat(64))).toBe("differs");
    expect(verifyHandoverDigest(r.hdir, "2026-11-17-02-z.md", sha)).toBe("absent");
    chmodSync(r.hdir, 0o000); chmodded.push(r.hdir);
    expect(verifyHandoverDigest(r.hdir, "2026-11-17-01-a.md", sha)).toBe("unknown");
  });
});

describe("T-575 C11 at the function level: a new line on the worker's board", () => {
  it("opens one linked worker handover, the memo on it, from the default head on the shared board", async () => {
    const U = "2026-11-16-01-u.md";
    const r = await rig({ files: { [U]: body("U") } });
    const out = await open(r);
    expect(out).toMatchObject({ outcome: "opened", from: U, note: null });
    expect(mdFiles(r)).toEqual([U, out.file].sort());
    const lin = splitLineage(readFileSync(join(r.hdir, out.file!), "utf8")).lineage?.lineage;
    expect(lin).toMatchObject({ role: "worker", from: U });
    expect(readLineMemo(r.board, W)).toEqual({ v: 1, task: W, tip: out.file, writing: null });
    expect(record(r)).toMatchObject({ outcome: "opened", file: out.file, intent: { file: out.file } });
    expect(existsSync(join(r.board, ".story", "telemetry", "handover-lines", memoFileName(PEN_TASK)))).toBe(false);
  });

  it("an empty folder has no from; a different board has no from and names the pen's board in prose", async () => {
    const a = await rig();
    expect((await open(a)).from).toBeNull();
    const b = await rig({ separatePen: true, files: { "2026-11-16-01-u.md": body("U") } });
    const out = await open(b);
    expect(out.from).toBeNull();
    const text = readFileSync(join(b.hdir, out.file!), "utf8");
    expect(text).toContain(`, from the board at ${b.penRoot}\n`);
    expect(splitLineage(text).lineage?.lineage.from ?? null).toBeNull();
  });

  it("from is the manager's active tip when its memo resolves", async () => {
    const T = "2026-11-16-01-t.md";
    const r = await rig({ files: { [T]: body("T"), "2026-11-16-02-u.md": body("U") } });
    mkdirSync(join(r.board, ".story", "telemetry", "handover-lines"), { recursive: true });
    const penMemo = join(r.board, ".story", "telemetry", "handover-lines", memoFileName(PEN_TASK));
    writeFileSync(penMemo, serializeLineMemo({ v: 1, task: PEN_TASK, tip: T, writing: null }));
    const before = readFileSync(penMemo, "utf8");
    expect((await open(r)).from).toBe(T);
    expect(readFileSync(penMemo, "utf8")).toBe(before);
  });
});

describe("T-575 C12: crash and replay rows", () => {
  it("row 1: two concurrent calls on one journal write one file; one opened, one repaired", async () => {
    const r = await rig();
    const res = await Promise.all([open(r), open(r)]);
    expect(res.map((x) => x.outcome).sort()).toEqual(["opened", "repaired"]);
    expect(mdFiles(r)).toHaveLength(1);
    expect(res[0]!.file).toBe(res[1]!.file);
    expect(readLineMemo(r.board, W)?.tip).toBe(res[0]!.file);
  });

  it("row 2: a call paused before the lock reads the first's record after it, verifies the file, writes the memo: repaired", async () => {
    const r = await rig();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let reached!: () => void;
    const paused = new Promise<void>((res) => { reached = res; });
    const second = open(r, { seams: { beforeLock: async () => { reached(); await gate; } } });
    await paused;
    failMemo.path = r.memo; failMemo.remaining = Number.POSITIVE_INFINITY;
    const first = await stopped(open(r));
    expect(first.reason).toBe("memo");
    const intent = record(r)?.intent;
    expect(intent).not.toBeNull();
    expect(mdFiles(r)).toEqual([intent!.file]);
    failMemo.remaining = 0;
    release();
    const out = await second;
    expect(out).toMatchObject({ outcome: "repaired", file: intent!.file });
    expect(mdFiles(r)).toEqual([intent!.file]);
    expect(readLineMemo(r.board, W)?.tip).toBe(intent!.file);
    expect(record(r)?.intent).toEqual(intent);
  });

  it("row 3: a crash before the intent is persisted writes nothing; the replay opens", async () => {
    const r = await rig();
    await stopped(open(r, { seams: { beforeIntentRecord: crash } }));
    expect(mdFiles(r)).toEqual([]);
    expect(existsSync(r.memo)).toBe(false);
    expect(record(r)?.intent ?? null).toBeNull();
    const out = await open(r);
    expect(out.outcome).toBe("opened");
    expect(mdFiles(r)).toEqual([out.file]);
  });

  it("row 4: a crash after the intent and before the file: the replay voids the intent and writes once with a fresh intent", async () => {
    const r = await rig();
    await stopped(open(r, { seams: { afterIntentRecord: crash } }));
    const stale = record(r)!.intent!;
    expect(mdFiles(r)).toEqual([]);
    expect(existsSync(r.memo)).toBe(false);
    const out = await open(r);
    expect(out.outcome).toBe("opened");
    expect(mdFiles(r)).toEqual([out.file]);
    expect(record(r)?.intent).toEqual({ file: out.file, sha256: digestBytes(readFileSync(join(r.hdir, out.file!))) });
    expect(stale.file).toBe(out.file);
  });

  it("row 4b: the intent's name taken by other bytes is not a committed opening (the check is by digest)", async () => {
    const r = await rig();
    await stopped(open(r, { seams: { afterIntentRecord: crash } }));
    const stale = record(r)!.intent!;
    writeFileSync(join(r.hdir, stale.file), body("someone else"));
    const out = await open(r);
    expect(out.outcome).toBe("opened");
    expect(out.file).not.toBe(stale.file);
    expect(readFileSync(join(r.hdir, stale.file), "utf8")).toBe(body("someone else"));
    expect(mdFiles(r)).toEqual([stale.file, out.file].sort());
    expect(readLineMemo(r.board, W)?.tip).toBe(out.file);
  });

  it("row 5: a crash after the file and before the memo: the replay repairs, one file, the memo on the file", async () => {
    const r = await rig();
    createMemoSeams.beforeFinalMemo = crash;
    await stopped(open(r));
    createMemoSeams.beforeFinalMemo = null;
    const files = mdFiles(r);
    expect(files).toHaveLength(1);
    const out = await open(r);
    expect(out).toMatchObject({ outcome: "repaired", file: files[0] });
    expect(mdFiles(r)).toEqual(files);
    expect(strict(r)).toEqual({ kind: "active", tip: files[0] });
  });

  it("row 6: a crash after the memo and before the record's outcome: the replay repairs, the memo untouched", async () => {
    const r = await rig();
    await stopped(open(r, { seams: { beforeOutcome: crash } }));
    expect(record(r)?.outcome).toBeNull();
    const memoBytes = readFileSync(r.memo, "utf8");
    const out = await open(r);
    expect(out.outcome).toBe("repaired");
    expect(readFileSync(r.memo, "utf8")).toBe(memoBytes);
    expect(mdFiles(r)).toHaveLength(1);
  });

  it("row 7: both of the create's memo writes fail once: the stage writes the memo and returns opened", async () => {
    const r = await rig();
    failMemo.path = r.memo; failMemo.remaining = 2;
    const out = await open(r);
    expect(out.outcome).toBe("opened");
    expect(failMemo.remaining).toBe(0);
    expect(readLineMemo(r.board, W)).toEqual({ v: 1, task: W, tip: out.file, writing: null });
  });

  it("row 8: a memo that cannot be written at all stops; after the fault clears the replay repairs", async () => {
    const r = await rig();
    failMemo.path = r.memo; failMemo.remaining = Number.POSITIVE_INFINITY;
    const err = await stopped(open(r));
    expect(err.reason).toBe("memo");
    expect(err.message).toContain(`could not be established on ${r.board} for worker ${W}`);
    expect(existsSync(r.memo)).toBe(false);
    const files = mdFiles(r);
    expect(files).toHaveLength(1);
    failMemo.remaining = 0;
    const out = await open(r);
    expect(out).toMatchObject({ outcome: "repaired", file: files[0] });
    expect(readLineMemo(r.board, W)?.tip).toBe(files[0]);
  });

  it("row 9: a replay after the worker wrote a second handover repairs and keeps the advanced tip", async () => {
    const r = await rig();
    const first = await open(r);
    await handleHandoverCreate(body("next"), "next", "json", r.board, { stamp: false }, { as: W });
    const advanced = readLineMemo(r.board, W)!.tip!;
    expect(advanced).not.toBe(first.file);
    const out = await open(r);
    expect(out).toMatchObject({ outcome: "repaired", file: first.file });
    expect(readLineMemo(r.board, W)?.tip).toBe(advanced);
    expect(mdFiles(r)).toHaveLength(2);
  });

  it("row 10: an intent that cannot be persisted gives default-line, no file, no memo", async () => {
    const r = await rig();
    const out = await open(r, { writeRecord: () => { throw new Error("EROFS"); } });
    expect(out).toEqual({ outcome: "default-line", file: null, from: null, note: "the opening intent could not be recorded" });
    expect(mdFiles(r)).toEqual([]);
    expect(existsSync(r.memo)).toBe(false);
  });

  it("row 10b: with the default-line outcome recorded, a replay returns default-line again and writes nothing", async () => {
    const r = await rig();
    let calls = 0;
    const flaky: OpeningDeps = { writeRecord: (p, rec) => { if (calls++ === 0) throw new Error("EIO"); writeFileSync(p, serializeOpeningRecord(rec)); } };
    expect((await open(r, flaky)).outcome).toBe("default-line");
    expect(record(r)?.outcome).toBe("default-line");
    const bytes = readFileSync(r.recordPath, "utf8");
    expect((await open(r)).outcome).toBe("default-line");
    expect(readFileSync(r.recordPath, "utf8")).toBe(bytes);
    expect(mdFiles(r)).toEqual([]);
  });

  it("row 11: team mode with the first candidate forced to EEXIST: the hook ran twice, the intent names the committed file, one file", async () => {
    const taken = "2026-11-17-090000-aaaaaaaa-w1-line-opened.md";
    const fresh = "2026-11-17-090000-bbbbbbbb-w1-line-opened.md";
    const r = await rig({ team: true, files: { [taken]: body("someone else") } });
    forced.names = [taken, fresh];
    let hooks = 0;
    const out = await open(r, { seams: { beforeIntentRecord: () => { hooks++; } } });
    expect(hooks).toBe(2);
    expect(out).toMatchObject({ outcome: "opened", file: fresh });
    expect(record(r)?.intent).toEqual({ file: fresh, sha256: digestBytes(readFileSync(join(r.hdir, fresh))) });
    expect(readFileSync(join(r.hdir, taken), "utf8")).toBe(body("someone else"));
    expect(mdFiles(r)).toEqual([taken, fresh]);
  });

  it("row 12: a memo whose tip is deleted or unreadable stops, with and without a matching opening intent", async () => {
    const gone = "2026-11-16-09-gone.md";
    const bare = await rig();
    seedMemo(bare, gone);
    const e1 = await stopped(open(bare));
    expect(e1.reason).toBe("memo");
    expect(e1.diagnostic).toContain(`its tip ${gone} is missing`);
    expect(e1.diagnostic).toContain(`storybloq handover continue <file> --as ${W}`);
    expect(mdFiles(bare)).toEqual([]);

    const withIntent = await rig();
    const first = await open(withIntent);
    seedMemo(withIntent, gone);
    expect((await stopped(open(withIntent))).diagnostic).toContain(`its tip ${gone} is missing`);

    const unreadable = await rig({ files: { "2026-11-16-01-locked.md": body("L") } });
    seedMemo(unreadable, "2026-11-16-01-locked.md");
    chmodSync(join(unreadable.hdir, "2026-11-16-01-locked.md"), 0o000); chmodded.push(join(unreadable.hdir, "2026-11-16-01-locked.md"));
    expect((await stopped(open(unreadable))).diagnostic).toContain("its tip 2026-11-16-01-locked.md is unreadable");
    expect(mdFiles(unreadable)).toEqual(["2026-11-16-01-locked.md"]);

    seedMemo(withIntent, first.file);
    const p = join(withIntent.hdir, first.file!);
    chmodSync(p, 0o000); chmodded.push(p);
    expect((await stopped(open(withIntent))).diagnostic).toContain(`its tip ${first.file} is unreadable`);
    expect(mdFiles(withIntent)).toEqual([first.file]);
  });

  it("row 12b: a recorded default-line with no memo returns default-line and writes nothing; with a memo it is already-on-line", async () => {
    const T = "2026-11-16-01-t.md";
    const r = await rig({ files: { [T]: body("T") } });
    writeFileSync(r.recordPath, serializeOpeningRecord({ v: 1, task: W, intent: null, attempt: null, outcome: "default-line", file: null }));
    const bytes = readFileSync(r.recordPath, "utf8");
    expect((await open(r)).outcome).toBe("default-line");
    expect(readFileSync(r.recordPath, "utf8")).toBe(bytes);
    expect(mdFiles(r)).toEqual([T]);
    seedMemo(r, T);
    expect(await open(r)).toMatchObject({ outcome: "already-on-line", file: T });
    expect(mdFiles(r)).toEqual([T]);
  });

  it("row 12c: a recorded opened whose file and memo are both gone stops", async () => {
    const r = await rig();
    const first = await open(r);
    unlinkSync(join(r.hdir, first.file!));
    unlinkSync(r.memo);
    const err = await stopped(open(r));
    expect(err.reason).toBe("memo");
    expect(err.diagnostic).toContain(`recorded line ${first.file}`);
    expect(mdFiles(r)).toEqual([]);
  });

  it("row 13: an unreadable record, an unsafe memo folder, an unreadable memo, a lock not taken, an intent file not readable: each stops and changes nothing", async () => {
    const a = await rig();
    writeFileSync(a.recordPath, "{ not a record");
    const ea = await stopped(open(a));
    expect(ea.reason).toBe("record");
    expect(ea.diagnostic).toContain(a.recordPath);
    expect(readFileSync(a.recordPath, "utf8")).toBe("{ not a record");
    expect(mdFiles(a)).toEqual([]);

    const b = await rig();
    const tele = join(b.board, ".story", "telemetry");
    rmSync(tele, { recursive: true, force: true });
    mkdirSync(join(env.base, "elsewhere"), { recursive: true });
    symlinkSync(join(env.base, "elsewhere"), tele);
    expect((await stopped(open(b))).reason).toBe("memo");
    expect(mdFiles(b)).toEqual([]);
    expect(existsSync(b.recordPath)).toBe(false);

    const c = await rig();
    seedMemo(c, null);
    chmodSync(c.memo, 0o000); chmodded.push(c.memo);
    const ec = await stopped(open(c));
    expect(ec.reason).toBe("memo");
    expect(ec.diagnostic).toContain("the memo cannot be read");
    expect(mdFiles(c)).toEqual([]);

    const d = await rig();
    const ed = await stopped(open(d, { lock: async () => { throw new Error("lock timeout"); } }));
    expect(ed.reason).toBe("lock");
    expect(ed.diagnostic).toContain("lock timeout");
    expect(existsSync(d.recordPath)).toBe(false);

    const e = await rig();
    failMemo.path = e.memo; failMemo.remaining = Number.POSITIVE_INFINITY;
    await stopped(open(e));
    failMemo.remaining = 0;
    const [file] = mdFiles(e);
    const recBytes = readFileSync(e.recordPath, "utf8");
    chmodSync(join(e.hdir, file!), 0o000); chmodded.push(join(e.hdir, file!));
    const ee = await stopped(open(e));
    expect(ee.reason).toBe("file");
    expect(ee.diagnostic).toContain(file!);
    expect(mdFiles(e)).toEqual([file]);
    expect(readFileSync(e.recordPath, "utf8")).toBe(recBytes);
    expect(existsSync(e.memo)).toBe(false);
  });
});

describe("T-575 continue mode at the function level", () => {
  const A = "2026-11-10-01-a.md";
  const B = "2026-11-10-02-b.md";
  it("adopts a tip, then a replay with the memo on it returns continued without calling the continue core", async () => {
    const { appendLineage, serializeLineage } = await import("../../src/core/handover-lineage.js");
    const files = { [A]: appendLineage(body("A"), serializeLineage({ role: "pen" }).line), [B]: appendLineage(body("B"), serializeLineage({ continues: A }).line) };
    const r = await rig({ mode: "continue", continueFile: B, files });
    expect(await open(r)).toMatchObject({ outcome: "continued", file: B, note: null });
    expect(readLineMemo(r.board, W)?.tip).toBe(B);
    const spy = vi.fn();
    expect(await open(r, { continueLine: spy })).toMatchObject({ outcome: "continued", file: B });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a recorded continued is re-resolved: an advanced tip gives already-on-line and keeps the tip; a removed memo is adopted again; a target no longer a tip stops", async () => {
    const { appendLineage, serializeLineage } = await import("../../src/core/handover-lineage.js");
    const C = "2026-11-10-03-c.md";
    const files = { [A]: appendLineage(body("A"), serializeLineage({ role: "pen" }).line), [B]: appendLineage(body("B"), serializeLineage({ continues: A }).line) };
    const r = await rig({ mode: "continue", continueFile: B, files });
    expect(await open(r)).toMatchObject({ outcome: "continued", file: B });
    writeFileSync(join(r.hdir, C), appendLineage(body("C"), serializeLineage({ continues: B }).line));
    seedMemo(r, C);
    expect(await open(r)).toEqual({ outcome: "already-on-line", file: C, from: null, note: null });
    expect(readLineMemo(r.board, W)?.tip).toBe(C);
    rmSync(r.memo);
    const err = await stopped(open(r));
    expect(err.diagnostic).toContain(`descendant tips: ${C}`);
    rmSync(join(r.hdir, C));
    const spy = vi.fn(continueLineUnlocked);
    expect(await open(r, { continueLine: spy })).toMatchObject({ outcome: "continued", file: B });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readLineMemo(r.board, W)?.tip).toBe(B);
  });

  it("the default head as the target: no memo, continued on the default line; a crash before the outcome then a newer unlinked handover replays without adopting again", async () => {
    const U = "2026-11-11-01-u.md";
    const U2 = "2026-11-12-01-u2.md";
    const r = await rig({ mode: "continue", continueFile: U, files: { [U]: body("U") } });
    await stopped(open(r, { seams: { beforeOutcome: crash } }));
    expect(record(r)?.attempt).toEqual({ file: U, defaultLine: true });
    expect(record(r)?.outcome).toBeNull();
    expect(existsSync(r.memo)).toBe(false);
    writeFileSync(join(r.hdir, U2), body("U2"));
    const spy = vi.fn();
    expect(await open(r, { continueLine: spy })).toEqual({ outcome: "continued", file: U, from: null, note: "the default line" });
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(r.memo)).toBe(false);
    expect(record(r)?.outcome).toBe("continued");
  });

  it("a non-tip target stops with its descendant tips; nothing is written but the attempt", async () => {
    const { appendLineage, serializeLineage } = await import("../../src/core/handover-lineage.js");
    const files = { [A]: appendLineage(body("A"), serializeLineage({ role: "pen" }).line), [B]: appendLineage(body("B"), serializeLineage({ continues: A }).line) };
    const r = await rig({ mode: "continue", continueFile: A, files });
    const err = await stopped(open(r));
    expect(err.reason).toBe("continue");
    expect(err.diagnostic).toContain(`descendant tips: ${B}`);
    expect(existsSync(r.memo)).toBe(false);
  });
});
