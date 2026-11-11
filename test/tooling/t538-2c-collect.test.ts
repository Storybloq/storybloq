/**
 * T-538 commit 2c, plan 5.8: the collector is the only reader of a model-writable tree. It copies under each
 * purpose's limits, names every entry it did not take, and is stopped at its deadline; the runner's own
 * reads go through it.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, ftruncateSync, openSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectTree, digestTree, PURPOSE_BYTES, PURPOSES } from "../../scripts/onboarding-eval-collect.js";
import { treeDigest } from "../../scripts/onboarding-eval-lib.js";
import { Collector } from "../../scripts/onboarding-eval-run.js";
import { parseTreeSnap, preservationFindings, treeSnapshot, type PreserveInputs } from "../../scripts/onboarding-eval-preserve.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "t538col-"))); dirs.push(d); return d; };

function tree(): { src: string; dest: string; outside: string } {
  const d = scratch();
  const src = join(d, "src");
  const outside = join(d, "outside");
  mkdirSync(join(src, "a", "b"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret"), "outside bytes\n");
  writeFileSync(join(src, "top.json"), "{}\n");
  writeFileSync(join(src, "a", "b", "deep.txt"), "deep\n");
  return { src, dest: join(d, "collected", "1", "src"), outside };
}
const problems = (c: ReturnType<typeof collectTree>): [string, string][] => c.entries.filter((e) => e.problem !== null).map((e) => [e.path, e.problem!]);

describe("the collector's copy (5.8)", () => {
  it("copies every regular file with its size and sha256 and nothing else", () => {
    const t = tree();
    const c = collectTree("ledger", t.src, t.dest);
    expect(c).toEqual({ missing: false, entries: [
      { path: join("a", "b", "deep.txt"), size: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), problem: null },
      { path: "top.json", size: 3, sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356", problem: null },
    ] });
    expect(readFileSync(join(t.dest, "a", "b", "deep.txt"), "utf-8")).toBe("deep\n");
  });

  it("a missing source is missing, and nothing is made at the destination", () => {
    const t = tree();
    expect(collectTree("events", join(t.src, "none"), t.dest)).toEqual({ missing: true, entries: [] });
    expect(existsSync(t.dest)).toBe(false);
  });

  it.each(PURPOSES)("%s: an outside link and a link cycle are named and never followed", (purpose) => {
    const t = tree();
    symlinkSync(join(t.outside, "secret"), join(t.src, "out"));
    symlinkSync("..", join(t.src, "a", "loop"));
    const c = collectTree(purpose, t.src, t.dest);
    expect(problems(c)).toEqual([[join("a", "loop"), "a link"], ["out", "a link"]]);
    expect(existsSync(join(t.dest, "out"))).toBe(false);
    expect(JSON.stringify(c)).not.toContain("outside bytes");
  });

  it.each(PURPOSES)("%s: a FIFO is named and never opened", (purpose) => {
    const t = tree();
    execFileSync("/usr/bin/mkfifo", [join(t.src, "a", "pipe")]);
    expect(problems(collectTree(purpose, t.src, t.dest))).toEqual([[join("a", "pipe"), "a special file (fifo)"]]);
  });

  it.each(PURPOSES)("%s: a file past the limit is named and not copied; the others are", (purpose) => {
    const t = tree();
    writeFileSync(join(t.src, "big"), Buffer.alloc(64));
    const c = collectTree(purpose, t.src, t.dest, { bytes: 40 });
    expect(problems(c)).toEqual([["big", "past the " + purpose + " limit of 40 bytes"]]);
    expect(existsSync(join(t.dest, "big"))).toBe(false);
    expect(existsSync(join(t.dest, "top.json"))).toBe(true);
  });

  it("each purpose's byte limit is the plan's", () => {
    const MIB = 1024 * 1024;
    expect(PURPOSE_BYTES).toEqual({ rollouts: 256 * MIB, project: 64 * MIB, store: 64 * MIB, ledger: 16 * MIB, events: 64 * MIB });
  });

  it("an entry past the entry limit stops the copy there, named once", () => {
    const t = tree();
    for (let i = 0; i < 6; i++) writeFileSync(join(t.src, `f${i}`), "x");
    const c = collectTree("project", t.src, t.dest, { entries: 5 });
    expect(problems(c)).toHaveLength(1);
    expect(problems(c)[0]![1]).toBe("past the 5 entry limit; nothing from here on is collected");
    expect(c.entries.filter((e) => e.problem === null).length).toBeLessThanOrEqual(5);
  });

  it("20001 entries pass the default limit", () => {
    const t = tree();
    for (let i = 0; i < 20001; i++) writeFileSync(join(t.src, `f${i}`), "");
    const c = collectTree("project", t.src, t.dest);
    expect(problems(c)).toEqual([[expect.any(String), "past the 20000 entry limit; nothing from here on is collected"]]);
  }, 60_000);

  it("depth 33 is past the depth limit; depth 32 is kept", () => {
    const t = tree();
    const parts = Array.from({ length: 32 }, (_, i) => `d${i}`);
    mkdirSync(join(t.src, ...parts), { recursive: true });
    writeFileSync(join(t.src, ...parts.slice(0, 31), "at32"), "k");
    writeFileSync(join(t.src, ...parts, "at33"), "x");
    const c = collectTree("project", t.src, t.dest);
    expect(problems(c)).toEqual([[join(...parts, "at33"), "past the depth limit of 32"]]);
    expect(existsSync(join(t.dest, ...parts.slice(0, 31), "at32"))).toBe(true);
  });

  it("an entry that disappears as it is read is named and not copied", () => {
    const t = tree();
    const c = collectTree("store", t.src, t.dest);
    expect(problems(c)).toEqual([]);
    // The walk's own row set (onboarding-eval-walk) proves the vanishing and swapped cases on the primitive; here the
    // collector keeps a walk finding on its entry.
    chmodSync(join(t.src, "a"), 0o000);
    try {
      const d = join(dirname(t.dest), "again");
      expect(problems(collectTree("store", t.src, d))).toEqual([["a", "could not be read"]]);
    } finally { chmodSync(join(t.src, "a"), 0o755); }
  });

  it("the no-follow digest is lib's treeDigest form on an ordinary tree, and names a FIFO without opening it", () => {
    const t = tree();
    symlinkSync("top.json", join(t.src, "ln"));
    expect(digestTree(t.src)).toEqual({ digest: treeDigest(t.src), problems: [] });
    execFileSync("/usr/bin/mkfifo", [join(t.src, "pipe")]);
    expect(digestTree(t.src).digest.pipe).toBe("fifo");
  });
});

describe("the runner's collector client (5.8)", () => {
  it("copies through the collector process; a ledger problem ends the attempt as evidence; a project problem is named", async () => {
    const t = tree();
    const work = dirname(dirname(dirname(t.dest)));
    const c = new Collector(work, { execArgv: ["--import", pathToFileURL(join(PKG, "node_modules", "tsx", "dist", "loader.mjs")).href] });
    const copy = await c.copy("project", t.src);
    expect(readFileSync(join(copy, "top.json"), "utf-8")).toBe("{}\n");
    symlinkSync(join(t.outside, "secret"), join(t.src, "out"));
    await c.copy("project", t.src);
    expect(c.named).toEqual([`evidence: ${join(t.src, "out")}: a link`]);
    await expect(c.copy("ledger", t.src)).rejects.toThrow(`onboarding-eval: evidence: ${join(t.src, "out")}: a link`);
  }, 60_000);

  it("a collector that hangs is stopped at its deadline and the attempt ends as infrastructure", async () => {
    const d = scratch();
    const hang = join(d, "hang.mjs");
    writeFileSync(hang, "setInterval(() => {}, 1000);\n");
    const c = new Collector(d, { deadlineMs: 1000, script: hang });
    // Raced against 10 s, so a collector left running fails this assertion rather than the row's own timeout.
    const settled = await Promise.race([
      c.copy("events", d).then(() => "copied", (e: Error) => e.message),
      new Promise<string>((r) => { const t = setTimeout(() => r("still running after 10 s"), 10_000); t.unref(); }),
    ]);
    expect(settled).toBe(`onboarding-eval: evidence: ${d}: the collector passed its 1000 ms deadline and was stopped`);
  }, 30_000);
});

describe("no read of a root outside the collector (5.8)", () => {
  it("the runner and its session module name no root path in a direct read", () => {
    const roots = /\b(?:project|story|eventsFile|snapshotFile|setupReviewStore|codexHome|CODEX_HOME|host\.events|reviewRequests|attemptTmp|globalDir)\b/;
    const hits: string[] = [];
    for (const f of ["onboarding-eval-run.ts", "onboarding-eval-sessions.ts"]) {
      for (const line of readFileSync(join(PKG, "scripts", f), "utf-8").split("\n")) {
        for (const m of line.matchAll(/\b(?:readFileSync|readdirSync|cpSync|statSync)\(([^)]*)\)/g)) if (roots.test(m[1]!)) hits.push(`${f}: ${m[0]}`);
      }
    }
    // Each remaining name is a fixture path or a collected copy: diskStoryBytes and diskReader are only handed copies,
    // and `story` in main is the collector's ledger copy.
    expect(hits).toEqual([
      'onboarding-eval-run.ts: cpSync(join(FIXTURES, fixture, "project")',
      "onboarding-eval-run.ts: readFileSync(join(story, rel)",
      "onboarding-eval-run.ts: readdirSync(join(story, rel)",
      "onboarding-eval-run.ts: readFileSync(join(story, rel)",
      "onboarding-eval-run.ts: readdirSync(join(story, rel)",
      'onboarding-eval-run.ts: readFileSync(join(story, "config.json")',
      'onboarding-eval-run.ts: readFileSync(join(fixtureDir, "project", ".story", "config.json")',
      "onboarding-eval-run.ts: readdirSync(join(story, rel)",
    ]);
    // `story` is bound to the collector's copy wherever main reads the ledger after the turns.
    const run = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    expect(run.match(/const story = storyCopy;/g)).toHaveLength(2);
    expect(run).not.toMatch(/const story = join\(project, "\.story"\);/);
  });

  it("the collected copies live outside every root", () => {
    expect(readdirSync(join(PKG, "scripts")).includes("onboarding-eval-collect.ts")).toBe(true);
    expect(readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8")).toContain('join(this.work, "collected", String(++this.n), basename(src))');
  });
});

describe("Codex round 1 P4: the edited and end snapshots come from the collector's own snapshot operation", () => {
  const loader = (): string[] => ["--import", pathToFileURL(join(PKG, "node_modules", "tsx", "dist", "loader.mjs")).href];
  const noLog = { events: [], attempts: [], fired: [] } as unknown as PreserveInputs["log"];
  it("an unchanged link in the project compares equal to the kill snapshot, and the preservation check holds", async () => {
    const d = scratch();
    const project = join(d, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "app.ts"), "export {};\n");
    mkdirSync(join(d, "outside"));
    symlinkSync(join(d, "outside"), join(project, "docs"));
    const kill = parseTreeSnap(treeSnapshot(project));
    const end = parseTreeSnap(await new Collector(join(d, "work"), { execArgv: loader() }).snapshot(project));
    expect(end).toEqual(kill);
    expect(end.links).toEqual(["docs"]);
    // This synthetic tree holds no setup state, so only the link and protected-content rules are asked about here.
    const found = preservationFindings("v", { baseline: kill, end, protectedPaths: ["src/app.ts"], selector: "step:config", firedLine: Number.POSITIVE_INFINITY, log: noLog });
    expect(found).not.toContain("v: the project's links changed after the baseline");
    expect(found).not.toContain("v: src/app.ts changed after the baseline");
    expect(found.filter((f) => f.includes("snapshot"))).toEqual([]);
  }, 60_000);
  it("a node_modules larger than the project copy's bound does not push the project's own files out of the snapshot", async () => {
    const d = scratch();
    const project = join(d, "project");
    mkdirSync(join(project, "node_modules", "big"), { recursive: true });
    // Sparse files: their bytes are zero and cost no disk, but a copy charges them all.
    const n = Math.ceil(PURPOSE_BYTES.project / (8 * 1024 * 1024)) + 1;
    for (let i = 0; i < n; i++) { const fd = openSync(join(project, "node_modules", "big", `f${i}.bin`), "w"); ftruncateSync(fd, 8 * 1024 * 1024); closeSync(fd); }
    mkdirSync(join(project, "src"));
    writeFileSync(join(project, "src", "app.ts"), "export {};\n");
    const c = new Collector(join(d, "work"), { execArgv: loader() });
    const end = parseTreeSnap(await c.snapshot(project));
    expect(end.truncated).toBe(false);
    expect(end.problems).toEqual([]);
    expect(Object.keys(end.files)).toEqual(["src/app.ts"]);
    expect(c.named).toEqual([]);
  }, 120_000);
  it("a problem the walk meets is carried in the snapshot, where the preservation check fails on it", async () => {
    const d = scratch();
    const project = join(d, "project");
    mkdirSync(project);
    writeFileSync(join(project, "locked.txt"), "x");
    chmodSync(join(project, "locked.txt"), 0o000);
    try {
      const end = parseTreeSnap(await new Collector(join(d, "work"), { execArgv: loader() }).snapshot(project));
      expect(end.problems).toEqual(["project/locked.txt could not be read (EACCES)"]);
      expect(preservationFindings("v", { baseline: end, end, protectedPaths: [], selector: "step:config", firedLine: Number.POSITIVE_INFINITY, log: noLog })).toContain("v: the end snapshot: project/locked.txt could not be read (EACCES)");
    } finally {
      chmodSync(join(project, "locked.txt"), 0o600);
    }
  }, 60_000);
  it("the runner takes the edited and the end snapshot with the collector's snapshot operation, never a project copy", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-run.ts"), "utf-8");
    expect(src).toContain("editedSnapshot = await collector.snapshot(project);");
    expect(src).toContain("named.set(END_RAW, await collector.snapshot(project));");
    expect(src).not.toContain('treeSnapshot(await collector.copy("project"');
  });
});
