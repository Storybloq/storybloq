/**
 * T-538 commit 4 (plan v5 7.1 to 7.5, Addendum D): the matrix driver against sentinel clients on a three-cell
 * manifest. A kill is a throw from the crash seam straight after the named journal write, which leaves the
 * journal exactly as a killed process would; a judge still alive is a real process group of its own.
 */
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ackGate, acquireLock, budgetOf, cellRunArgs, cli, closeAttempt, dispositionOf, judgeFlags, listAttempts, MANIFEST_PATH, operationDeadline, parseManifest, preflightProblems,
  journalFs, mkdirDurable, pinRecord, pinSeams, rawDirOf, SCAN_PIN, readAttempt, realExecutor, readCheckout, realGit, realPreflightProbe, releaseLock, renderResults, replaceCell, runArm, runnerFlags, unlock,
  type Arm, type DriverDeps, type Executor, type Flag, type Manifest, type Phase, type PhaseContext, type PhaseResult, type PreflightProbe,
} from "../../scripts/onboarding-eval-driver.js";
import { PROBE_SHA256 } from "../../scripts/onboarding-eval-probe.js";
import { identityOf, readGroups, recordDone, recordIntent, recordLaunch, startOf, sweepGroups, type Identity } from "../../scripts/onboarding-eval-groups.js";

const PKG = join(__dirname, "..", "..");
const MIN = 60_000;
const HOUR = 60 * MIN;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };

const COMMIT = "a".repeat(40);
function manifest(cells: Partial<Manifest["cells"][number]>[] = [{}, {}, {}]): Manifest {
  return parseManifest(JSON.stringify({
    id: "t538-host-1", commit: COMMIT, evalBundleDigest: "e".repeat(64), toolListSha256: "f".repeat(64), probeSha256: PROBE_SHA256,
    clients: { codex: { version: "0.153.4", model: "gpt-6-astra", judgeModel: "gpt-6-astra", isolation: "fresh" }, claude: { version: "2.9.0", model: "opus", judgeModel: "gpt-6-astra", isolation: "signed-in" } },
    limits: { turnMs: 40 * MIN, attemptMs: 210 * MIN, armMs: 10 * HOUR },
    cells: cells.map((c, i) => ({ id: ["c1", "c2", "c3", "c4"][i], case: "x", fixture: "empty-idea", variant: "none", checkSet: 7, ...c })),
  }));
}

class Crash extends Error {}
interface Script { flags?: Flag[]; advanceMs?: number; usageLimit?: boolean; cleanup?: "confirmed" | "unconfirmed"; crashAfterResult?: boolean; verdict?: string }

/** Sentinel clients: each phase records its call, may advance the clock, and spawns nothing real. */
function rig(opts: { crashAt?: string; script?: Record<string, Script>; alive?: Set<number>; leftover?: boolean; attemptBudgetMs?: number; armBudgetMs?: number } = {}) {
  const root = tmp("t538drv-");
  const clock = { t: Date.UTC(2026, 10, 10, 12) };
  const calls: string[] = [];
  const published = new Set<string>();
  let pg = 50_000;
  const key = (ctx: { attempt: { cell: string }; phase: Phase }) => `${ctx.attempt.cell}:${ctx.phase}`;
  const executor: Executor = {
    artifactsOf: () => [],
    run: async (ctx: PhaseContext): Promise<PhaseResult> => {
      calls.push(`${ctx.attempt.id}:${ctx.phase}`);
      const s = opts.script?.[key(ctx)] ?? {};
      if (["run", "judge", "finalize", "regrade"].includes(ctx.phase)) { pg += 1; ctx.onSpawn(pg, pg); }
      clock.t += s.advanceMs ?? MIN;
      if (ctx.phase === "judge" || ctx.phase === "regrade") published.add(`${ctx.attempt.id}:${ctx.phase}`);
      if (s.crashAfterResult) throw new Crash(`${ctx.phase} result`);
      return { cleanup: s.cleanup ?? "confirmed", flags: s.flags ?? [], artifacts: {}, usageLimit: s.usageLimit, verdict: ctx.phase === "finalize" ? (s.verdict ?? "PASS") : null, observedModels: ctx.phase === "judge" ? ["gpt-6-astra"] : [] };
    },
    adoptJudge: (ctx) => published.has(`${ctx.attempt.id}:judge`) ? { cleanup: "confirmed", flags: [], artifacts: {}, observedModels: ["gpt-6-astra"] } : null,
    regradeReservation: () => ({ revision: 1, inputs: "h" }),
    adoptRegrade: (ctx, res) => published.has(`${ctx.attempt.id}:regrade`) ? ((res as { inputs?: string })?.inputs === "h" ? { cleanup: "confirmed", flags: [], artifacts: {} } : "mismatch") : null,
  };
  const deps = (crashAt?: string): DriverDeps => ({
    now: () => clock.t,
    groupAlive: (pgid) => opts.alive?.has(pgid) ?? false,
    leftoverClean: () => !(opts.leftover ?? false),
    executor,
    crashAt: (b) => { if (crashAt !== undefined && b === crashAt) throw new Crash(b); },
    attemptBudgetMs: opts.attemptBudgetMs, armBudgetMs: opts.armBudgetMs,
  });
  const m = manifest();
  const go = async (arm: Arm = "codex", crashAt?: string, man: Manifest = m, sha = "m1") => {
    try { return await runArm(root, man, sha, arm, deps(crashAt)); } catch (e) { if (e instanceof Crash) return { kind: "crashed" as const, at: e.message }; throw e; }
  };
  return { root, clock, calls, go, m, published };
}

const outcomes = (root: string) => Object.fromEntries(listAttempts(root).map((a) => [a.id, a.outcome?.disposition ?? "unfinished"]));

describe("7.1 / Addendum D: the manifest from HEAD and the checkout", () => {
  function repo() {
    const top = tmp("t538git-");
    const g = (...a: string[]) => { const r = spawnSync("git", a, { cwd: top, encoding: "utf-8", env: { PATH: "/usr/bin:/bin", HOME: top, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    g("init", "-q", "-b", "main");
    mkdirSync(join(top, "storybloq", "scripts"), { recursive: true });
    writeFileSync(join(top, "storybloq", "code.ts"), "one\n");
    g("add", "."); g("commit", "-qm", "code");
    const code = g("rev-parse", "HEAD");
    const put = (c: string) => writeFileSync(join(top, "storybloq", MANIFEST_PATH), JSON.stringify({ ...JSON.parse(JSON.stringify(manifest())), commit: c }));
    return { top, g, code, put, git: realGit(join(top, "storybloq")) };
  }

  it("HEAD equal to the manifest's commit passes, and the manifest is read from HEAD's blob", () => {
    // A blob cannot name the commit that holds it, so HEAD == commit is shown through git's answers.
    const blob = JSON.stringify(manifest());
    const asked: string[][] = [];
    const git = (args: readonly string[]) => {
      asked.push([...args]);
      if (args[0] === "rev-parse" && args[1] === "--show-prefix") return { ok: true, out: "storybloq/\n" };
      if (args[0] === "cat-file") return { ok: true, out: blob };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { ok: true, out: `${COMMIT}\n` };
      if (args[0] === "status") return { ok: true, out: "" };
      return { ok: false, out: "" };
    };
    const c = readCheckout(git);
    expect(c.problems).toEqual([]);
    expect(c.manifest.commit).toBe(COMMIT);
    expect(asked).toContainEqual(["cat-file", "blob", `HEAD:storybloq/${MANIFEST_PATH}`]);
    expect(asked.some((a) => a[0] === "diff" || a[0] === "merge-base")).toBe(false);
  });

  it.each([
    ["rev-parse HEAD", (a: readonly string[]) => a[0] === "rev-parse" && a[1] === "HEAD"],
    ["merge-base", (a: readonly string[]) => a[0] === "merge-base"],
    ["diff", (a: readonly string[]) => a[0] === "diff"],
    ["status", (a: readonly string[]) => a[0] === "status"],
  ] as const)("git %s failing is refused with the operation named, never read as an answer", (op, fails) => {
    // HEAD is a descendant, so every one of the four calls is asked; the named one fails as git does (status 128).
    const blob = JSON.stringify(manifest());
    const git = (args: readonly string[]) => {
      if (fails(args)) return { ok: false, out: "", status: 128 };
      if (args[0] === "rev-parse" && args[1] === "--show-prefix") return { ok: true, out: "storybloq/\n" };
      if (args[0] === "cat-file") return { ok: true, out: blob };
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { ok: true, out: `${"d".repeat(40)}\n` };
      if (args[0] === "merge-base") return { ok: true, out: "", status: 0 };
      if (args[0] === "diff") return { ok: true, out: `storybloq/${MANIFEST_PATH}\n` };
      if (args[0] === "status") return { ok: true, out: "" };
      return { ok: false, out: "", status: 128 };
    };
    expect(() => readCheckout(git)).toThrow(`preflight refused: git ${op} failed`);
  });

  it("real git failing (a manifest commit git does not know) is refused, not read as \"not an ancestor\"", () => {
    const r = repo();
    r.put("e".repeat(40)); r.g("add", "."); r.g("commit", "-qm", "manifest");
    expect(() => readCheckout(r.git)).toThrow("preflight refused: git merge-base failed");
  });

  it("the generator refuses when git status fails, and writes nothing", async () => {
    const git = (args: readonly string[]) => (args[0] === "status" ? { ok: false, out: "", status: 128 } : { ok: true, out: args[1] === "--show-prefix" ? "storybloq/\n" : `${COMMIT}\n` });
    const pkg = tmp("t538s5-");
    await expect(cli(["--write-manifest", "--id", "x", "--codex-version", "c", "--claude-version", "d"], { pkg, git, now: () => 0, alive: () => false, out: () => {}, preflight: async () => [], arm: async () => ({ kind: "done" }) } as unknown as Parameters<typeof cli>[1])).rejects.toThrow("preflight refused: git status failed");
    expect(existsSync(join(pkg, MANIFEST_PATH))).toBe(false);
  });

  it("the working tree's manifest is never read; an uncommitted change under the package is refused", () => {
    const r = repo();
    r.put(r.code); r.g("add", "."); r.g("commit", "-qm", "manifest");
    r.put("c".repeat(40));
    const c = readCheckout(r.git);
    expect(c.manifest.commit).toBe(r.code);
    expect(c.problems).toEqual([expect.stringMatching(/^uncommitted changes under storybloq\//)]);
  });

  it("a manifest-only descendant passes; one that also changes another file is refused", () => {
    const r = repo();
    r.put(r.code); r.g("add", "."); r.g("commit", "-qm", "manifest");
    expect(readCheckout(r.git).problems).toEqual([]);
    writeFileSync(join(r.top, "storybloq", "code.ts"), "two\n");
    r.g("add", "."); r.g("commit", "-qm", "code change");
    expect(readCheckout(r.git).problems.join()).toMatch(/in more than the manifest: storybloq\/code\.ts/);
  });

  it("a manifest whose commit is not an ancestor of HEAD is refused", () => {
    const r = repo();
    // A commit git knows that is not on HEAD's line: a parentless commit of the same tree.
    const side = r.g("commit-tree", "HEAD^{tree}", "-m", "side");
    r.put(side); r.g("add", "."); r.g("commit", "-qm", "manifest");
    expect(readCheckout(r.git).problems.join()).toMatch(/is not an ancestor of HEAD/);
  });
});

describe("7.3: run to regrade with the runner's real folder layout", () => {
  /**
   * A stand-in runner behind a node shim that drops `--import tsx <script>`: in run mode it lays out what the
   * runner does (`<raw-out>/<runId>/` with the turn files, `<out>/<runId>/` as the record) and reports both in
   * its result; in regrade mode it records the argv it was given.
   */
  function rigReal() {
    const base = tmp("t538s1-");
    const stub = join(base, "runner.mjs");
    writeFileSync(stub, [
      'import { mkdirSync, writeFileSync } from "node:fs"; import { join, dirname } from "node:path";',
      "const a = process.argv.slice(2); const get = (k) => a[a.indexOf(`--${k}`) + 1];",
      'const result = get("result");',
      'if (a.includes("--regrade")) {',
      '  writeFileSync(join(dirname(result), "regrade.argv.json"), JSON.stringify(a));',
      '  writeFileSync(result, JSON.stringify({ ok: true, mode: "regrade", stage: "done", exitCode: 0, runId: null, recordDir: get("regrade"), rawDir: null, verdict: "PASS" }));',
      "} else {",
      '  const runId = "codex-x1"; const raw = join(get("raw-out"), runId); const rec = join(get("out"), runId);',
      '  mkdirSync(raw, { recursive: true }); writeFileSync(join(raw, "turn-01-setup.jsonl"), "{}\\n"); mkdirSync(rec, { recursive: true });',
      '  writeFileSync(result, JSON.stringify({ ok: true, mode: "run", stage: "done", exitCode: 0, runId, recordDir: rec, rawDir: process.env.T538_RAW ?? raw, verdict: "PASS", ...(process.env.T538_TURNS ? { turns: JSON.parse(process.env.T538_TURNS) } : {}) }));',
      "}",
    ].join("\n"));
    const shim = join(base, "node-shim");
    writeFileSync(shim, `#!/bin/sh\nshift 3\nexec '${process.execPath}' '${stub}' "$@"\n`, { mode: 0o755 });
    const dir = join(base, "attempts", "c1-codex-1");
    mkdirSync(dir, { recursive: true });
    const m = manifest();
    const ctx = (phase: Phase) => ({ attempt: readAttempt(dir), cell: m.cells[0]!, arm: "codex" as const, manifest: m, phase, deadlineMs: 60_000, onSpawn: () => {} });
    return { base, dir, shim, ctx, ex: (env: NodeJS.ProcessEnv = {}) => realExecutor({ pkg: base, node: shim, env: { PATH: "/usr/bin:/bin", ...env } }) };
  }

  it("the regrade is given the run's own raw folder, <attempt>/raw/<runId>, where the turn files are", async () => {
    const r = rigReal();
    const ex = r.ex();
    expect((await ex.run(r.ctx("run"))).flags).toEqual([]);
    const raw = join(r.dir, "raw", "codex-x1");
    expect(rawDirOf(r.ctx("run").attempt)).toEqual({ dir: raw });
    expect((await ex.run(r.ctx("regrade"))).flags).toEqual([]);
    const argv = JSON.parse(readFileSync(join(r.dir, "regrade.argv.json"), "utf-8")) as string[];
    expect(argv[argv.indexOf("--raw") + 1]).toBe(raw);
    expect(existsSync(join(argv[argv.indexOf("--raw") + 1]!, "turn-01-setup.jsonl"))).toBe(true);
  });

  it("an unconfirmed turn cleanup followed by finished evidence collection is quarantined, not scored", async () => {
    const r = rigReal();
    const turns = [{ turn: 1, infraFailure: null, cleanup: "confirmed", cleanupDetail: null }, { turn: 2, infraFailure: "cleanup: unconfirmed: pgid 4242", cleanup: "unconfirmed", cleanupDetail: "pgid 4242" }];
    const g = await r.ex({ T538_TURNS: JSON.stringify(turns) }).run(r.ctx("run"));
    // The run itself finished: a record folder and a PASS verdict were reported.
    expect(g.verdict).toBe("PASS");
    expect(dispositionOf(g.flags)).toEqual({ disposition: "quarantined", cause: "run: turn 2: its process group was not confirmed gone: pgid 4242" });
  });

  it.each([
    ["outside the attempt's raw folder", (r: { base: string }) => join(r.base, "elsewhere")],
    ["the raw folder itself, not a run's folder in it", (r: { dir: string }) => join(r.dir, "raw")],
    ["a path that climbs out", (r: { dir: string }) => join(r.dir, "raw", "..", "out")],
  ] as const)("a reported raw folder %s is a harness defect, and no regrade runs", async (_n, where) => {
    const r = rigReal();
    const ex = r.ex({ T538_RAW: where(r as { base: string; dir: string }) });
    await ex.run(r.ctx("run"));
    const g = await ex.run(r.ctx("regrade"));
    expect(g.flags).toEqual([{ kind: "harness-defect", cause: expect.stringMatching(/^regrade: the run's raw folder .* is not inside /) }]);
    expect(existsSync(join(r.dir, "regrade.argv.json"))).toBe(false);
  });
});

describe("7.4: nested process groups the runner records are stopped by the driver", { timeout: 60_000 }, () => {
  const gone = (pid: number): boolean => { try { process.kill(-pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } };
  /**
   * A stand-in runner that starts a detached grandchild in a process group of its own, records it in the driver's
   * groups file the way the runner does, then hangs until the phase's deadline stops it.
   */
  function rigNested() {
    const base = tmp("t538s3-");
    const stub = join(base, "runner.mjs");
    writeFileSync(stub, [
      'import { spawn, execFileSync } from "node:child_process"; import { appendFileSync, writeFileSync } from "node:fs";',
      'const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
      'const start = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(gc.pid)], { encoding: "utf-8" }).trim();',
      'appendFileSync(process.env.ONBOARDING_EVAL_GROUPS_FILE, JSON.stringify({ id: "g1" }) + "\\n" + JSON.stringify({ id: "g1", pgid: gc.pid, start }) + "\\n");',
      'writeFileSync(process.env.T538_GC, String(gc.pid));',
      "setInterval(() => {}, 1000);",
    ].join("\n"));
    const shim = join(base, "node-shim");
    writeFileSync(shim, `#!/bin/sh\nshift 3\nexec '${process.execPath}' '${stub}' "$@"\n`, { mode: 0o755 });
    const dir = join(base, "attempts", "c1-codex-1");
    mkdirSync(dir, { recursive: true });
    const m = manifest();
    const gcFile = join(base, "gc.pid");
    const ctx = { attempt: readAttempt(dir), cell: m.cells[0]!, arm: "codex" as const, manifest: m, phase: "run" as Phase, deadlineMs: 1500, onSpawn: () => {} };
    const gc = (): number => Number(readFileSync(gcFile, "utf-8"));
    return { dir, ctx, gc, ex: (o: Partial<Parameters<typeof realExecutor>[0]> = {}) => realExecutor({ pkg: base, node: shim, env: { PATH: "/usr/bin:/bin", T538_GC: gcFile }, ...o }) };
  }

  it("an outer deadline with a live detached grandchild ends with no survivor and a confirmed cleanup", async () => {
    const r = rigNested();
    let pid = 0;
    try {
      const res = await r.ex().run(r.ctx);
      pid = r.gc();
      const lines = readFileSync(join(r.dir, "run.groups.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as { pgid?: number; done?: boolean });
      expect(lines.filter((l) => l.pgid !== undefined).map((l) => l.pgid)).toEqual([pid]);
      // Confirmed gone by the sweep, so recorded done and never signalled again.
      expect(lines.at(-1)).toMatchObject({ done: true });
      expect(readGroups(join(r.dir, "run.groups.jsonl"))).toEqual({ groups: [], unresolved: [], problems: [] });
      expect(gone(pid)).toBe(true);
      expect(res.cleanup).toBe("confirmed");
    } finally { if (pid > 0 && !gone(pid)) process.kill(-pid, "SIGKILL"); }
  });

  it("a grandchild group that cannot be confirmed gone makes the phase's cleanup unconfirmed, naming the group", async () => {
    const r = rigNested();
    let pid = 0;
    try {
      const res = await r.ex({ sweep: { signal: () => {}, identityOf }, sweepGraceMs: 200 }).run(r.ctx);
      pid = r.gc();
      expect(res.cleanup).toBe("unconfirmed");
      expect(res.cleanupDetail).toBe(`the recorded group ${pid} was not confirmed gone`);
    } finally { if (pid > 0 && !gone(pid)) process.kill(-pid, "SIGKILL"); }
  });

  // A present group under every id; signals other than the probe are recorded.
  const present = (sent: string[]) => (g: number, s: NodeJS.Signals | 0) => { if (s !== 0) sent.push(`${g}:${s}`); };
  const launched = (dir: string, start: string | null, pgid = 4242): string => {
    const f = join(dir, "g.jsonl");
    writeFileSync(f, `${JSON.stringify({ id: "a" })}\n${JSON.stringify({ id: "a", pgid, start })}\n`);
    return f;
  };

  it("a recorded group whose id now names a process with another start time is left alone, and ours counts as gone", async () => {
    const f = launched(tmp("t538s3r-"), "Mon Jan  1 00:00:00 2001");
    const sent: string[] = [];
    expect(await sweepGroups(f, 100, { signal: present(sent), identityOf: () => ({ kind: "start", value: "Tue Nov 10 12:00:00 2026" }) })).toEqual([]);
    expect(sent).toEqual([]);
    expect(readGroups(f).groups).toEqual([]);
  });

  it.each([
    ["no recorded start time", null, { kind: "start", value: "Tue Nov 10 12:00:00 2026" }, /has no recorded start time, so it is not signalled/],
    ["a failed identity query", "Tue Nov 10 12:00:00 2026", { kind: "failed", reason: "ps exited 2" }, /could not be identified \(ps exited 2\), so it is not signalled/],
    ["no leader to identify", "Tue Nov 10 12:00:00 2026", { kind: "absent" }, /has no leader to identify, so it is not signalled/],
  ] as const)("a present group with %s is never signalled and the cleanup is unconfirmed", async (_n, start, now, re) => {
    const f = launched(tmp("t538s3u-"), start);
    const sent: string[] = [];
    const left = await sweepGroups(f, 100, { signal: present(sent), identityOf: () => now as Identity });
    expect(sent).toEqual([]);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(re);
  });

  it("a group the probe finds gone is recorded done and never signalled again", async () => {
    const f = launched(tmp("t538s3g-"), "Tue Nov 10 12:00:00 2026");
    const sent: string[] = [];
    expect(await sweepGroups(f, 100, { signal: (g, s) => { sent.push(`${g}:${s}`); throw Object.assign(new Error("x"), { code: "ESRCH" }); }, identityOf: () => ({ kind: "failed", reason: "unused" }) })).toEqual([]);
    expect(await sweepGroups(f, 100, { signal: (g, s) => { sent.push(`${g}:${s}`); }, identityOf: () => ({ kind: "start", value: "Tue Nov 10 12:00:00 2026" }) })).toEqual([]);
    expect(sent).toEqual(["4242:0"]);
  });

  it("a launch intent with no recorded group is unconfirmed, and a done intent is not", async () => {
    const d = tmp("t538s3i-");
    const f = join(d, "g.jsonl");
    const id = recordIntent(f);
    expect(await sweepGroups(f, 100, { signal: present([]), identityOf: () => ({ kind: "absent" }) })).toEqual([`the launch ${id} recorded no process group, so it cannot be confirmed gone`]);
    recordDone(f, id);
    expect(await sweepGroups(f, 100, { signal: present([]), identityOf: () => ({ kind: "absent" }) })).toEqual([]);
  });

  it("a planted foreign group under a recorded number is untouched by the real sweep", async () => {
    const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const pgid = child.pid!;
    try {
      const f = launched(tmp("t538s3p-"), "Mon Jan  1 00:00:00 2001", pgid);
      expect(await sweepGroups(f, 200)).toEqual([]);
      expect(gone(pgid)).toBe(false);
    } finally { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  });

  it("a wrapper killed between the spawn and the registration leaves an unresolved intent, so the cleanup is unconfirmed", async () => {
    const d = tmp("t538s3k-");
    const f = join(d, "g.jsonl");
    const pidf = join(d, "pgid");
    const script = join(d, "wrap.mts");
    writeFileSync(script, [
      `import { writeFileSync } from "node:fs";`,
      `import { groupsSeams, runInGroup } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts", "onboarding-eval-groups.ts")).href)};`,
      `groupsSeams.afterSpawn = (pgid) => { writeFileSync(${JSON.stringify(pidf)}, String(pgid)); process.kill(process.pid, "SIGKILL"); };`,
      `await runInGroup({ command: "/bin/sleep", args: ["30"], cwd: ${JSON.stringify(d)}, timeoutMs: 60_000 });`,
    ].join("\n"));
    let pgid = 0;
    try {
      const r = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), env: { ...process.env, ONBOARDING_EVAL_GROUPS_FILE: f }, timeout: 30_000 });
      expect(r.signal).toBe("SIGKILL");
      pgid = Number(readFileSync(pidf, "utf-8"));
      expect(gone(pgid)).toBe(false);
      const reg = readGroups(f);
      expect(reg.groups).toEqual([]);
      expect(reg.unresolved).toHaveLength(1);
      expect(await sweepGroups(f, 100)).toEqual([`the launch ${reg.unresolved[0]} recorded no process group, so it cannot be confirmed gone`]);
    } finally { if (pgid > 0) try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
  });

  it("at a restart, a launch intent with no recorded group quarantines the attempt", async () => {
    const r = rig();
    expect((await r.go("codex", "c1-codex-1:judge.spawn")).kind).toBe("crashed");
    writeFileSync(join(r.root, "attempts", "c1-codex-1", "judge.groups.jsonl"), `${JSON.stringify({ id: "lost" })}\n`);
    expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "quarantined", cause: "judge: the launch lost recorded no process group" });
  });

  it("identityOf tells a running leader, a missing one and a failed query apart", () => {
    expect(identityOf(process.pid)).toEqual({ kind: "start", value: startOf(process.pid) });
    expect(identityOf(2 ** 22 + 12345)).toEqual({ kind: "absent" });
  });

  it("a groups file with an unreadable line is a problem, never skipped", async () => {
    const f = join(tmp("t538s3b-"), "g.jsonl");
    writeFileSync(f, "{oops\n");
    expect(await sweepGroups(f, 100, { signal: () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); }, identityOf: () => ({ kind: "absent" }) })).toEqual(["groups file line 1 is not a recorded group"]);
  });

  it("the intent, the launch with the leader's start time and the done line are recorded in order", () => {
    const f = join(tmp("t538s3c-"), "g.jsonl");
    const id = recordIntent(f);
    expect(readGroups(f)).toEqual({ groups: [], unresolved: [id], problems: [] });
    recordLaunch(f, id, process.pid);
    expect(readGroups(f)).toEqual({ groups: [{ id, pgid: process.pid, start: startOf(process.pid) }], unresolved: [], problems: [] });
    recordDone(f, id);
    expect(readGroups(f)).toEqual({ groups: [], unresolved: [], problems: [] });
  });

  it("at a restart, a recorded child group still alive quarantines the attempt", async () => {
    const r = rig({ alive: { has: (g: number) => g === 4242 } as unknown as Set<number> });
    expect((await r.go("codex", "c1-codex-1:judge.spawn")).kind).toBe("crashed");
    writeFileSync(join(r.root, "attempts", "c1-codex-1", "judge.groups.jsonl"), `${JSON.stringify({ id: "a" })}\n${JSON.stringify({ id: "a", pgid: 4242, start: null })}\n`);
    expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "quarantined", cause: "judge: the recorded child group 4242 still exists" });
  });
});

describe("7.4: a restart after finalize, with the runner's real record rewrite", { timeout: 120_000 }, () => {
  /**
   * The real executor behind a node shim and a stand-in runner and judge that keep the real layout: run writes
   * record.json and the packet; the judge publishes judge.json for that packet; finalize rewrites record.json,
   * as the runner's finalize does; regrade publishes nothing.
   */
  function rigArm() {
    const base = tmp("t538s2-");
    const stub = join(base, "stub.mjs");
    writeFileSync(stub, [
      'import { createHash } from "node:crypto"; import { mkdirSync, readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path";',
      "const a = process.argv.slice(2); const get = (k) => a[a.indexOf(`--${k}`) + 1]; const result = get(\"result\");",
      'const done = (mode, rec, extra = {}) => writeFileSync(result, JSON.stringify({ ok: true, mode, stage: "done", exitCode: 0, runId: null, recordDir: rec, rawDir: null, verdict: "PASS", ...extra }));',
      'if (a.includes("--record")) {',
      '  const rec = get("record"); const packet = createHash("sha256").update(readFileSync(join(rec, "grading-packet.json"))).digest("hex");',
      '  writeFileSync(join(rec, "judge.json"), JSON.stringify({ packetSha256: packet })); mkdirSync(join(rec, "judge-attempt"), { recursive: true });',
      '  writeFileSync(join(rec, "judge-attempt", "meta.json"), JSON.stringify({ outcome: "published", observedModels: ["gpt-6-astra"] }));',
      '} else if (a.includes("--finalize")) { const rec = get("finalize"); writeFileSync(join(rec, "record.json"), JSON.stringify({ v: 2, verdict: "PASS" })); done("finalize", rec); }',
      'else if (a.includes("--regrade")) done("regrade", get("regrade"));',
      "else {",
      '  const runId = "codex-x1"; const raw = join(get("raw-out"), runId); const rec = join(get("out"), runId);',
      '  mkdirSync(raw, { recursive: true }); mkdirSync(rec, { recursive: true });',
      '  writeFileSync(join(rec, "record.json"), JSON.stringify({ v: 1 })); writeFileSync(join(rec, "grading-packet.json"), "{}");',
      '  done("run", rec, { runId, rawDir: raw });',
      "}",
    ].join("\n"));
    const shim = join(base, "node-shim");
    writeFileSync(shim, `#!/bin/sh\nshift 3\nexec '${process.execPath}' '${stub}' "$@"\n`, { mode: 0o755 });
    const root = join(base, "root");
    mkdirSync(root);
    const m = manifest([{}]);
    const calls: string[] = [];
    const real = realExecutor({ pkg: base, node: shim, env: { PATH: "/usr/bin:/bin" } });
    const executor: Executor = { ...real, run: async (ctx) => { calls.push(ctx.phase); return real.run(ctx); } };
    let t = Date.UTC(2026, 10, 10, 12);
    const go = async (crashAt?: string) => {
      const deps: DriverDeps = { now: () => (t += 1000), groupAlive: () => false, leftoverClean: () => true, executor, crashAt: (b) => { if (b === crashAt) throw new Crash(b); } };
      try { return await runArm(root, m, "m1", "codex", deps); } catch (e) { if (e instanceof Crash) return { kind: "crashed" as const, at: e.message }; throw e; }
    };
    return { root, go, calls, id: `${m.cells[0]!.id}-codex-1` };
  }

  it.each(["finalize.ended", "finalize.done"])("a crash at %s resumes to a scored attempt; the judge is adopted, not asked again", async (boundary) => {
    const r = rigArm();
    expect((await r.go(`${r.id.replace(/-codex-1$/, "")}-codex-1:${boundary}`)).kind).toBe("crashed");
    const before = r.calls.length;
    expect(await r.go()).toEqual({ kind: "done" });
    const a = readAttempt(join(r.root, "attempts", r.id));
    expect(a.outcome).toMatchObject({ disposition: "scored", verdict: "PASS" });
    expect(r.calls.slice(before)).not.toContain("judge");
    expect(r.calls.slice(before)).not.toContain("run");
  });

  it("a death after the pin is written but before it is published leaves no pin; the rerun scan pins and passes", () => {
    const rec = tmp("t538pin2-");
    writeFileSync(join(rec, "record.json"), "one");
    pinSeams.beforePublish = () => { throw new Crash("pin"); };
    try { expect(() => pinRecord(rec)).toThrow(Crash); } finally { pinSeams.beforePublish = () => {}; }
    expect(existsSync(join(rec, SCAN_PIN))).toBe(false);
    expect(pinRecord(rec)).toBeNull();
    expect(readFileSync(join(rec, SCAN_PIN), "utf-8")).toBe("one");
    expect(readdirSync(rec).sort()).toEqual(["record.json", SCAN_PIN]);
  });

  it("the scan's pin is written once; a record.json changed before a rerun scan is refused", () => {
    const rec = tmp("t538pin-");
    writeFileSync(join(rec, "record.json"), "one");
    expect(pinRecord(rec)).toBeNull();
    expect(readFileSync(join(rec, SCAN_PIN), "utf-8")).toBe("one");
    expect(pinRecord(rec)).toBeNull();
    writeFileSync(join(rec, "record.json"), "two");
    expect(pinRecord(rec)).toBe("record.json changed since the scan pinned it");
    expect(readFileSync(join(rec, SCAN_PIN), "utf-8")).toBe("one");
  });
});

describe("7.4: new journal folders are fsynced into their parents", () => {
  it("attempts/ and the attempt folder are fsynced into their parents before intent is written", async () => {
    const r = rig();
    const seen: string[] = [];
    const real = journalFs.fsyncDir;
    journalFs.fsyncDir = (dir) => { seen.push(`${dir.slice(r.root.length) || "/"}${existsSync(join(dir, "intent.json")) ? " +intent" : ""}`); real(dir); };
    try { expect((await r.go("codex", "c1-codex-1:intent")).kind).toBe("crashed"); } finally { journalFs.fsyncDir = real; }
    // budget.json's own fsync comes first; then the root gains attempts/, attempts/ gains the attempt folder, and only then does intent.json land.
    expect(seen).toEqual(["/", "/", "/attempts", "/attempts/c1-codex-1 +intent"]);
  });

  it("mkdirDurable fsyncs the parent of every folder it creates, and refuses an existing folder when exclusive", () => {
    const base = tmp("t538mk-");
    const seen: string[] = [];
    const real = journalFs.fsyncDir;
    journalFs.fsyncDir = (dir) => { seen.push(dir.slice(base.length) || "/"); real(dir); };
    try {
      mkdirDurable(join(base, "a", "b", "c"));
      expect(seen).toEqual(["/", "/a", "/a/b"]);
      expect(() => mkdirDurable(join(base, "a", "b"), true)).toThrow(/already exists/);
      mkdirDurable(join(base, "a", "b"));
      expect(seen).toHaveLength(3);
    } finally { journalFs.fsyncDir = real; }
  });
});

describe("7.3 / 7.4: the driver against sentinel clients", { timeout: 60_000 }, () => {
  it("a three-cell arm runs every phase in order, writes the journal, and ends done", async () => {
    const r = rig();
    expect(await r.go()).toEqual({ kind: "done" });
    expect(outcomes(r.root)).toEqual({ "c1-codex-1": "scored", "c2-codex-1": "scored", "c3-codex-1": "scored" });
    const files = readdirSync(join(r.root, "attempts", "c1-codex-1")).sort();
    expect(files).toEqual(["finalize.done.json", "finalize.spawn.json", "finalize.start.json", "intent.json", "judge.done.json", "judge.spawn.json", "judge.start.json", "outcome.json", "regrade.done.json", "regrade.spawn.json", "regrade.start.json", "run.done.json", "run.spawn.json", "run.start.json", "scan-judge.done.json", "scan-judge.start.json", "scan.done.json", "scan.start.json"]);
    expect(r.calls.filter((c) => c.startsWith("c1-"))).toEqual(["run", "scan", "judge", "scan-judge", "finalize", "regrade"].map((p) => `c1-codex-1:${p}`));
    expect(readAttempt(join(r.root, "attempts", "c1-codex-1")).outcome).toMatchObject({ verdict: "PASS", observedModels: ["gpt-6-astra"], manifestSha256: "m1" });
  });

  // Killed straight after each journal write, then resumed: what is done is not repeated, run is never rerun.
  const boundaries: [string, string][] = [
    ["c2-codex-1:intent", "scored"], ["c2-codex-1:run.start", "quarantined"], ["c2-codex-1:run.spawn", "quarantined"], ["c2-codex-1:run.done", "scored"],
    ["c2-codex-1:scan.start", "scored"], ["c2-codex-1:scan.done", "scored"], ["c2-codex-1:judge.start", "quarantined"], ["c2-codex-1:judge.spawn", "quarantined"],
    ["c2-codex-1:judge.done", "scored"], ["c2-codex-1:scan-judge.start", "scored"], ["c2-codex-1:finalize.start", "quarantined"], ["c2-codex-1:finalize.spawn", "scored"],
    ["c2-codex-1:finalize.done", "scored"], ["c2-codex-1:regrade.start", "quarantined"], ["c2-codex-1:regrade.spawn", "scored"], ["c2-codex-1:regrade.done", "scored"], ["c2-codex-1:outcome", "scored"],
  ];
  it.each(boundaries)("7.5 kill and resume after %s: the attempt ends %s and nothing finished runs twice", async (boundary, want) => {
    const r = rig();
    expect(await r.go("codex", boundary)).toEqual({ kind: "crashed", at: boundary });
    const before = [...r.calls];
    const stop = await r.go();
    expect(outcomes(r.root)["c2-codex-1"]).toBe(want);
    const again = r.calls.slice(before.length);
    // Every phase that had a done file before the kill is not called again.
    const a = readAttempt(join(r.root, "attempts", "c2-codex-1"));
    for (const c of again.filter((x) => x.startsWith("c2-"))) {
      const ph = c.split(":")[1] as Phase;
      expect(before.filter((b) => b === c).length === 0 || !boundary.endsWith(`${ph}.done`), `${ph} rerun after its done`).toBe(true);
    }
    if (!boundary.endsWith(":intent")) expect(again).not.toContain("c2-codex-1:run");
    expect(again.some((c) => c.startsWith("c1-"))).toBe(false);
    if (want === "quarantined") {
      expect(stop).toMatchObject({ kind: "stopped", attempt: "c2-codex-1", disposition: "quarantined", lift: "--close" });
      expect(a.outcome!.cutoff).toBe("recovered-1.json");
      expect(a.outcome!.at).toBe(a.recoveries[0]!.at);
    } else expect(stop).toEqual({ kind: "done" });
  });

  it("7.5: a judge result that exists before judge.done.json is adopted, and the judge is not asked again", async () => {
    const r = rig({ script: { "c1:judge": { crashAfterResult: true } } });
    expect((await r.go()).kind).toBe("crashed");
    expect(await r.go()).toEqual({ kind: "done" });
    expect(r.calls.filter((c) => c === "c1-codex-1:judge")).toHaveLength(1);
    expect(readAttempt(join(r.root, "attempts", "c1-codex-1")).phases.judge.done).toMatchObject({ adopted: true });
  });

  it("7.5: no judge result to adopt quarantines, and the judge is not asked a second time", async () => {
    const r = rig();
    expect((await r.go("codex", "c1-codex-1:judge.spawn")).kind).toBe("crashed");
    r.published.delete("c1-codex-1:judge");
    expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "quarantined", cause: expect.stringContaining("the judge is not asked a second time") });
    expect(r.calls.filter((c) => c === "c1-codex-1:judge")).toHaveLength(1);
  });

  it("7.5: a regrade revision published before regrade.done.json is adopted against its reservation", async () => {
    const r = rig({ script: { "c1:regrade": { crashAfterResult: true } } });
    expect((await r.go()).kind).toBe("crashed");
    expect(await r.go()).toEqual({ kind: "done" });
    expect(r.calls.filter((c) => c === "c1-codex-1:regrade")).toHaveLength(1);
    expect(readAttempt(join(r.root, "attempts", "c1-codex-1")).phases.regrade.start?.reservation).toEqual({ revision: 1, inputs: "h" });
  });

  it("7.5: a judge sentinel still alive in its recorded group quarantines (a real process group)", async () => {
    const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      const pgid = child.pid!;
      const alive = (g: number) => { try { process.kill(-g, 0); return true; } catch { return false; } };
      const r = rig({ alive: { has: (g: number) => (g === 50_002 ? alive(pgid) : false) } as unknown as Set<number> });
      expect((await r.go("codex", "c1-codex-1:judge.spawn")).kind).toBe("crashed");
      expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "quarantined", cause: expect.stringContaining("still exists") });
    } finally { child.kill("SIGKILL"); }
  });

  it("7.5: between a spawn and its spawn file (a child holding no file under the attempt) the attempt quarantines", async () => {
    const r = rig();
    expect((await r.go("codex", "c1-codex-1:run.start")).kind).toBe("crashed");
    expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "quarantined", cause: expect.stringContaining("no spawn record") });
  });

  it("7.5: a leftover after the group is gone quarantines", async () => {
    const r = rig({ leftover: true });
    expect((await r.go("codex", "c1-codex-1:finalize.spawn")).kind).toBe("crashed");
    expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "quarantined", cause: expect.stringContaining("leftover") });
  });

  it("7.4: budget.json deleted or stale is rebuilt to the same numbers from the journal", async () => {
    const r = rig();
    await r.go("codex", "c2-codex-1:scan.done");
    const first = await r.go();
    expect(first).toEqual({ kind: "done" });
    const b = JSON.parse(readFileSync(join(r.root, "budget.json"), "utf-8"));
    unlinkSync(join(r.root, "budget.json"));
    await r.go();
    expect(JSON.parse(readFileSync(join(r.root, "budget.json"), "utf-8"))).toEqual(b);
    writeFileSync(join(r.root, "budget.json"), JSON.stringify({ ...b, usedMs: 1 }));
    await r.go();
    expect(JSON.parse(readFileSync(join(r.root, "budget.json"), "utf-8"))).toEqual(b);
    expect(b.usedMs).toBe(budgetOf(listAttempts(r.root), "codex", r.clock.t).usedMs);
  });

  it("7.4: a restart after the clock advanced three hours charges those hours to the arm once", async () => {
    const r = rig();
    await r.go("codex", "c1-codex-1:scan.done");
    const atCrash = r.clock.t;
    const intent = readAttempt(join(r.root, "attempts", "c1-codex-1")).intent!.at;
    r.clock.t += 3 * HOUR;
    await r.go("codex", "c1-codex-1:judge.spawn");
    r.published.delete("c1-codex-1:judge");
    await r.go();
    const a = readAttempt(join(r.root, "attempts", "c1-codex-1"));
    expect(a.recoveries.map((x) => x.at)).toEqual([atCrash + 3 * HOUR, a.recoveries[1]!.at]);
    expect(budgetOf(listAttempts(r.root), "codex", r.clock.t + 5 * HOUR).attempts["c1-codex-1"]).toBe(a.recoveries[1]!.at - intent);
    expect(a.recoveries[1]!.at - intent).toBeLessThan(3 * HOUR + 10 * MIN);
    expect(a.recoveries[1]!.at - intent).toBeGreaterThanOrEqual(3 * HOUR);
  });

  it("7.4: two crashes, the first recovery continuing a scan and the second quarantining, charge the attempt to the second recovery's time", async () => {
    const r = rig();
    await r.go("codex", "c1-codex-1:scan.start");
    r.clock.t += 10 * MIN;
    expect((await r.go("codex", "c1-codex-1:judge.spawn")).kind).toBe("crashed");
    // The first recovery found scan started and not done, and ran it (it had not run before the kill).
    expect(r.calls.filter((c) => c === "c1-codex-1:scan")).toHaveLength(1);
    expect(readAttempt(join(r.root, "attempts", "c1-codex-1")).phases.scan.done).not.toBeNull();
    r.published.delete("c1-codex-1:judge");
    r.clock.t += 20 * MIN;
    expect(await r.go()).toMatchObject({ disposition: "quarantined" });
    const a = readAttempt(join(r.root, "attempts", "c1-codex-1"));
    expect(a.recoveries).toHaveLength(2);
    expect(a.outcome!.cutoff).toBe("recovered-2.json");
    expect(a.outcome!.at).toBe(a.recoveries[1]!.at);
    r.clock.t += 9 * HOUR;
    expect(budgetOf(listAttempts(r.root), "codex", r.clock.t).attempts["c1-codex-1"]).toBe(a.recoveries[1]!.at - a.intent!.at);
  });

  it("7.4: an operation under its floor does not start, and the attempt is infrastructure with the cause budget", async () => {
    const r = rig({ armBudgetMs: 4 * MIN });
    expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "infrastructure", cause: "budget: turn", lift: "--replace or --close" });
    expect(r.calls).toEqual([]);
    expect(operationDeadline("judge", 9 * MIN + CLEANUP(), HOUR)).toEqual({ ok: false, cause: "budget: judge" });
    expect(operationDeadline("lsof", HOUR, HOUR)).toEqual({ ok: true, ms: MIN, clampedBy: "cap" });
  });

  it("7.4: a deadline clamped by the attempt's remainder, less the cleanup reserve", async () => {
    const r = rig({ attemptBudgetMs: 25 * MIN, script: { "c1:run": { advanceMs: 5 * MIN } } });
    await r.go();
    const a = readAttempt(join(r.root, "attempts", "c1-codex-1"));
    // run 5 min, scan 1 min: 19 minutes left, less the 60 second reserve.
    expect(a.phases.judge.start!.deadlineMs).toBe(18 * MIN);
    expect(operationDeadline("judge", 19 * MIN, HOUR)).toEqual({ ok: true, ms: 18 * MIN, clampedBy: "attempt" });
    expect(operationDeadline("judge", 3 * HOUR, 12 * MIN)).toEqual({ ok: true, ms: 12 * MIN, clampedBy: "arm" });
  });

  it("7.4: the budget stops a phase that runs past its deadline", async () => {
    const r = rig({ script: { "c1:judge": { advanceMs: 31 * MIN } } });
    expect(await r.go()).toMatchObject({ kind: "stopped", disposition: "infrastructure", cause: "deadline: judge" });
    expect(r.calls).not.toContain("c1-codex-1:scan-judge");
  });

  it("7.2: a second driver is refused by the lock; --unlock refuses while the holder lives and clears once it is gone", () => {
    const root = tmp("t538lock-");
    acquireLock(root, 4242, 0);
    expect(() => acquireLock(root, 4343, 0)).toThrow(/locked by pid 4242/);
    expect(() => unlock(root, "stale", () => true, 1)).toThrow(/still running/);
    unlock(root, "the old driver died", () => false, 2);
    expect(existsSync(join(root, "lock"))).toBe(false);
    expect(readdirSync(join(root, "unlocks"))).toEqual(["2.json"]);
    acquireLock(root, 4343, 3);
    releaseLock(root, 4343);
    expect(existsSync(join(root, "lock"))).toBe(false);
  });

  it("7.1: a manifest that differs from the journal's refuses to run", async () => {
    const r = rig();
    await r.go("codex", "c1-codex-1:scan.done");
    await expect(runArm(r.root, r.m, "m2", "codex", { now: () => 0, groupAlive: () => false, leftoverClean: () => true, executor: {} as Executor })).rejects.toThrow(/differs from the journal's/);
    expect(readAttempt(join(r.root, "attempts", "c1-codex-1")).recoveries).toEqual([]);
  });

  it.each([
    ["quarantined", { cleanup: "unconfirmed" } as Script, "--close"],
    ["invalid", { flags: [{ kind: "invalid", cause: "scan hit" }] } as Script, "--close"],
    ["harness-defect", { flags: [{ kind: "harness-defect", cause: "refusal" }] } as Script, "--close"],
    ["infrastructure", { flags: [{ kind: "infrastructure", cause: "launch" }] } as Script, "--replace or --close"],
  ])("7.3 / 7.4: %s stops the arm until %s", async (disposition, script, _lift) => {
    const r = rig({ script: { "c2:run": script } });
    const stop = await r.go();
    expect(stop).toMatchObject({ kind: "stopped", attempt: "c2-codex-1", disposition });
    expect(r.calls.some((c) => c.startsWith("c3-"))).toBe(false);
    expect(await r.go()).toMatchObject({ kind: "stopped", attempt: "c2-codex-1" });
    closeAttempt(r.root, "c2-codex-1", "pen ruling: closed", r.clock.t);
    expect(await r.go()).toEqual({ kind: "done" });
    expect(outcomes(r.root)["c3-codex-1"]).toBe("scored");
  });

  it("7.4: a usage limit stops the arm; a behavioural failure is scored and never stops", async () => {
    const r = rig({ script: { "c1:finalize": { verdict: "FAIL" }, "c2:judge": { usageLimit: true } } });
    expect(await r.go()).toMatchObject({ kind: "stopped", attempt: "c2-codex-1", disposition: "infrastructure", cause: "usage limit", lift: "usage limit: the arm stops" });
    expect(readAttempt(join(r.root, "attempts", "c1-codex-1")).outcome).toMatchObject({ disposition: "scored", verdict: "FAIL" });
  });

  it("7.3: disposition precedence is quarantined, invalid, harness-defect, infrastructure, scored", () => {
    const f = (kind: Flag["kind"]): Flag => ({ kind, cause: kind });
    expect(dispositionOf([f("infrastructure"), f("harness-defect"), f("invalid"), f("quarantined")]).disposition).toBe("quarantined");
    expect(dispositionOf([f("infrastructure"), f("harness-defect"), f("invalid")]).disposition).toBe("invalid");
    expect(dispositionOf([f("infrastructure"), f("harness-defect")]).disposition).toBe("harness-defect");
    expect(dispositionOf([f("infrastructure")]).disposition).toBe("infrastructure");
    expect(dispositionOf([]).disposition).toBe("scored");
  });

  it("7.4: a replacement creates attempt n+1; one per cell, three per arm, never for a scored attempt", async () => {
    const r = rig({ script: { "c1:run": { flags: [{ kind: "infrastructure", cause: "launch" }] } } });
    await r.go();
    expect(() => replaceCell(r.root, "c2", "codex", "x", 0)).toThrow(/no finished attempt/);
    expect(replaceCell(r.root, "c1", "codex", "launch failure", r.clock.t)).toBe("c1-codex-2");
    expect(() => replaceCell(r.root, "c1", "codex", "again", 0)).toThrow(/is scored|replacement/);
    expect(await r.go()).toMatchObject({ kind: "stopped", attempt: "c1-codex-2" });
    expect(() => replaceCell(r.root, "c1", "codex", "again", 0)).toThrow(/has had its 1 replacement/);
    expect(readAttempt(join(r.root, "attempts", "c1-codex-1")).replaced).toMatchObject({ reason: "launch failure" });
  });

  it("7.4: three replacements per arm, the fourth refused", async () => {
    const fail = { flags: [{ kind: "infrastructure", cause: "launch" }] as Flag[] };
    const r = rig({ script: { "c1:run": fail, "c2:run": fail, "c3:run": fail } });
    const m4 = manifest([{}, {}, {}, {}]);
    const go = () => runArm(r.root, m4, "m4", "codex", { now: () => r.clock.t++, groupAlive: () => false, leftoverClean: () => true, executor: rigExecutor(fail) });
    for (const c of ["c1", "c2", "c3"]) { await go(); replaceCell(r.root, c, "codex", "r", 0); await go(); closeAttempt(r.root, `${c}-codex-2`, "closed", 0); }
    await go();
    expect(() => replaceCell(r.root, "c4", "codex", "r", 0)).toThrow(/has had its 3 replacements/);
  });

  it("7.4: a gate cell holds the driver after its outcome until acked", async () => {
    const r = rig();
    const m = manifest([{ gateAfter: true }, {}, {}]);
    expect(await r.go("codex", undefined, m, "mg")).toMatchObject({ kind: "gate", cell: "c1" });
    expect(await r.go("codex", undefined, m, "mg")).toMatchObject({ kind: "gate", cell: "c1" });
    expect(r.calls.some((c) => c.startsWith("c2-"))).toBe(false);
    ackGate(r.root, "c1", "codex", "pen look: pilot fine", r.clock.t);
    expect(await r.go("codex", undefined, m, "mg")).toEqual({ kind: "done" });
    expect(await r.go("claude", undefined, m, "mg")).toMatchObject({ kind: "gate", cell: "c1" });
  });
});

function CLEANUP(): number { return 60_000; }
function rigExecutor(fail: { flags: Flag[] }): Executor {
  let pg = 90_000;
  return {
    artifactsOf: () => [],
    run: async (ctx) => { if (["run", "judge", "finalize", "regrade"].includes(ctx.phase)) { pg += 1; ctx.onSpawn(pg, pg); } return { cleanup: "confirmed", flags: ctx.phase === "run" ? fail.flags : [], artifacts: {} }; },
    adoptJudge: () => null, regradeReservation: () => ({}), adoptRegrade: () => null,
  };
}

describe("7.3: the real executor's mapping of results to dispositions", () => {
  it("7.3: every turn's findings rank ahead of the grading verdict, on an ok result and on a failed one", () => {
    const base = { mode: "run", stage: "done", exitCode: 0, runId: "r", recordDir: "/x", rawDir: null, verdict: "PASS" } as const;
    const t = (turn: number, infraFailure: string | null, cleanup: "confirmed" | "unconfirmed") => ({ turn, infraFailure, cleanup, cleanupDetail: null });
    expect(runnerFlags("run", { ok: true, ...base, turns: [t(1, null, "confirmed")] }, null)).toEqual({ flags: [], usageLimit: false });
    const infra = runnerFlags("run", { ok: true, ...base, turns: [t(1, null, "confirmed"), t(2, "turn 2 timed out after 600000ms", "confirmed")] }, null);
    expect(infra.flags).toEqual([{ kind: "infrastructure", cause: "run: turn 2: turn 2 timed out after 600000ms" }]);
    expect(dispositionOf(infra.flags).disposition).toBe("infrastructure");
    const both = runnerFlags("run", { ok: true, ...base, turns: [t(1, "turn 1 timed out", "unconfirmed")] }, null);
    expect(dispositionOf(both.flags)).toEqual({ disposition: "quarantined", cause: "run: turn 1: its process group was not confirmed gone" });
    expect(runnerFlags("run", { ok: true, ...base, turns: [t(1, "You've hit your usage limit", "confirmed")] }, null)).toEqual({ flags: [{ kind: "infrastructure", cause: "usage limit" }], usageLimit: true });
    const failed = runnerFlags("run", { ok: false, mode: "run", stage: "record", message: "finalize refused: x", turns: [t(1, null, "unconfirmed")] }, null);
    expect(dispositionOf(failed.flags).disposition).toBe("quarantined");
  });

  it("the runner's result: ok is clean; a refusal is harness-defect; a usage limit, a deadline, an invalid scan", () => {
    expect(runnerFlags("run", { ok: true, mode: "run", stage: "done", exitCode: 3, runId: "r", recordDir: "/x", rawDir: null, verdict: "FAIL" }, null)).toEqual({ flags: [], usageLimit: false });
    expect(runnerFlags("run", null, null).flags[0]!.kind).toBe("harness-defect");
    expect(runnerFlags("run", { ok: false, mode: "run", stage: "preflight", message: "finalize refused: x" }, null).flags[0]!.kind).toBe("harness-defect");
    expect(runnerFlags("run", { ok: false, mode: "run", stage: "turns", message: "You've hit your usage limit" }, null)).toEqual({ flags: [{ kind: "infrastructure", cause: "usage limit" }], usageLimit: true });
    expect(runnerFlags("run", { ok: false, mode: "run", stage: "turns", message: "turn 3 timed out" }, null).flags[0]!.kind).toBe("infrastructure");
    expect(runnerFlags("run", { ok: false, mode: "run", stage: "scan", message: "onboarding-eval: invalid: a credential form" }, null).flags[0]!.kind).toBe("invalid");
  });

  it("the judge's meta: published is clean; cleanup-unconfirmed quarantines; limits are infrastructure", () => {
    expect(judgeFlags({ outcome: "published" }).flags).toEqual([]);
    expect(judgeFlags({ outcome: "cleanup-unconfirmed" }).flags[0]!.kind).toBe("quarantined");
    expect(judgeFlags({ outcome: "timed-out" }).flags[0]!.kind).toBe("infrastructure");
    expect(judgeFlags({ outcome: "credential-in-output" }).flags[0]!.kind).toBe("invalid");
    expect(judgeFlags({ outcome: "schema-invalid" }).flags[0]!.kind).toBe("harness-defect");
    expect(judgeFlags(null).flags[0]!.kind).toBe("harness-defect");
  });
});

describe("7.2: preflight", () => {
  const ok: PreflightProbe = {
    version: (a) => (a === "codex" ? "codex-cli 0.153.4" : "2.9.0 (Claude Code)"), managedSettings: () => [], freeBytes: () => 30 * 1024 ** 3,
    counts: () => ({ vitest: 1, jest: 0 }), codexCredential: () => true, claudeTokenLength: () => 100,
    evalInputDigest: () => "e".repeat(64), toolListSha256: () => "f".repeat(64), distProblems: () => [], capabilityProbe: async () => [],
  };
  it("passes with every check holding, and records the counts only", async () => {
    const root = tmp("t538pf-");
    expect(await preflightProblems(manifest(), root, "codex", ok, 0)).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "preflight.json"), "utf-8"))).toMatchObject({ counts: { vitest: 1, jest: 0 }, problems: [] });
  });
  it.each([
    ["version", { version: () => "codex-cli 0.150.0" }, /not the pinned/],
    ["managed settings", { managedSettings: () => ["/Library/Application Support/ClaudeCode"] }, /managed settings/],
    ["free space", { freeBytes: () => 19 * 1024 ** 3 }, /under the 20 GiB floor/],
    ["credential", { codexCredential: () => false }, /no Codex credential/],
    ["bundle", { evalInputDigest: () => "0".repeat(64) }, /input digest/],
    ["tool list", { toolListSha256: () => "0".repeat(64) }, /tool list/],
    ["dist", { distProblems: () => ["dist/mcp.js differs"] }, /dist\/mcp\.js differs/],
    ["capability probe", { capabilityProbe: async () => ["probe: the outside write succeeded"] }, /outside write/],
  ] as const)("refuses on %s", async (_n, change, re) => {
    expect((await preflightProblems(manifest(), tmp("t538pf-"), "codex", { ...ok, ...change } as PreflightProbe, 0)).join("\n")).toMatch(re);
  });
  it("refuses with an open quarantine, until it is closed", async () => {
    const r = rig({ script: { "c1:run": { cleanup: "unconfirmed" } } });
    await r.go();
    expect((await preflightProblems(manifest(), r.root, "codex", ok, 0)).join()).toMatch(/open quarantine: c1-codex-1/);
    closeAttempt(r.root, "c1-codex-1", "closed", 0);
    expect(await preflightProblems(manifest(), r.root, "codex", ok, 0)).toEqual([]);
  });
});

describe("7.5: results from the journal", () => {
  it("every attempt with its disposition, the manifest sha256, and plan sections 3, 9 and 10 in full", async () => {
    const r = rig({ script: { "c2:run": { flags: [{ kind: "infrastructure", cause: "launch" }] } } });
    await r.go();
    const plan = "# P\n\n## 3. Containment\n\nthree body\n\n## 4. Next\n\nno\n\n## 9. Claims\n\nnine body\n\n## 10. Acceptance\n\n| a | b |\n\n## 11. More\n";
    const md = renderResults(r.root, r.m, "m1", plan, "2026-11-10", r.clock.t);
    expect(md).toContain("manifest sha256 m1");
    expect(md).toMatch(/\| c1-codex-1 \| scored \|/);
    expect(md).toMatch(/\| c2-codex-1 \| infrastructure \| launch \|/);
    expect(md).toContain("## Plan 3. Containment\n\nthree body");
    expect(md).toContain("## Plan 9. Claims\n\nnine body");
    expect(md).toContain("## Plan 10. Acceptance\n\n| a | b |");
    expect(md).not.toContain("## 4. Next");
  });
});

describe("7.1: the manifest generator", { timeout: 120_000 }, () => {
  function pkgRepo() {
    const top = tmp("t538gen-");
    // The copied package is thousands of loose objects; with auto gc on, a background gc can still be writing them during cleanup.
    const env = { PATH: "/usr/bin:/bin", HOME: top, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "gc.auto", GIT_CONFIG_VALUE_0: "0", GIT_CONFIG_KEY_1: "maintenance.auto", GIT_CONFIG_VALUE_1: "false", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const g = (...a: string[]) => { const r = spawnSync("git", a, { cwd: top, encoding: "utf-8", env }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    const pkg = join(top, "storybloq");
    for (const p of ["src", "scripts", "tsup.config.ts", "package.json", "package-lock.json"]) cpSync(join(PKG, p), join(pkg, p), { recursive: true });
    rmSync(join(pkg, MANIFEST_PATH), { force: true });
    g("init", "-q", "-b", "main"); g("add", "."); g("commit", "-qm", "code");
    return { top, pkg, g, git: realGit(pkg) };
  }
  const deps = (pkg: string, git: ReturnType<typeof realGit>, out: string[]) => ({
    pkg, git, now: () => 0, alive: () => false, out: (s: string) => { out.push(s); },
    preflight: async () => [], arm: async () => ({ kind: "done" as const }),
  });

  it("writes the manifest for a clean HEAD; committed as a manifest-only descendant it passes the checkout check", async () => {
    const r = pkgRepo();
    const code = r.g("rev-parse", "HEAD");
    const out: string[] = [];
    expect(await cli(["--write-manifest", "--id", "t538-host-1", "--codex-version", "0.153.4", "--claude-version", "2.9.0"], deps(r.pkg, r.git, out))).toBe(0);
    const m = parseManifest(readFileSync(join(r.pkg, MANIFEST_PATH)));
    expect(m.commit).toBe(code);
    expect(m.cells.map((c) => c.id)).toEqual(["1a", "6c", "1b", "2", "3", "4", "5", "7", "10", "89", "6a", "6b", "6d"]);
    expect(m.cells.filter((c) => c.gateAfter).map((c) => c.id)).toEqual(["1a", "6c"]);
    expect(m.clients).toEqual({ codex: { version: "0.153.4", model: "gpt-6-astra", judgeModel: "gpt-6-astra", isolation: "fresh" }, claude: { version: "2.9.0", model: "opus", judgeModel: "gpt-6-astra", isolation: "signed-in" } });
    expect(m.probeSha256).toBe(PROBE_SHA256);
    expect(m.toolListSha256).toBe(createHash("sha256").update(readFileSync(join(r.pkg, "scripts", "onboarding-eval-tools.json"))).digest("hex"));
    r.g("add", "."); r.g("commit", "-qm", "manifest only");
    const c = readCheckout(r.git);
    expect(c.problems).toEqual([]);
    expect(c.manifest).toEqual(m);
  });

  it("refuses a dirty package, and its manifest is refused once HEAD no longer descends from its commit", async () => {
    const r = pkgRepo();
    writeFileSync(join(r.pkg, "scripts", "stray.ts"), "x\n");
    await expect(cli(["--write-manifest", "--id", "x", "--codex-version", "1", "--claude-version", "1"], deps(r.pkg, r.git, []))).rejects.toThrow(/uncommitted changes/);
    rmSync(join(r.pkg, "scripts", "stray.ts"));
    expect(await cli(["--write-manifest", "--id", "x", "--codex-version", "1", "--claude-version", "1"], deps(r.pkg, r.git, []))).toBe(0);
    const written = readFileSync(join(r.pkg, MANIFEST_PATH));
    // The same code reached by another history (as a patch onto main gives): the manifest's commit is not an ancestor.
    r.g("checkout", "-q", "--orphan", "other"); r.g("rm", "-rq", "--cached", "."); r.g("add", "storybloq/src"); r.g("commit", "-qm", "patched");
    r.g("add", "."); r.g("commit", "-qm", "rest, with the stale manifest");
    expect(readFileSync(join(r.pkg, MANIFEST_PATH))).toEqual(written);
    expect(readCheckout(r.git).problems.join()).toMatch(/is not an ancestor of HEAD/);
  });
});

describe("7.2: the real entry always wires the capability probe", () => {
  it("a cell can never reach the probe turn: arguments naming --probe-turn are refused", () => {
    const cell = manifest().cells[0]!;
    expect(cellRunArgs(cell, "claude", "opus", "/a", 1000, "/a/run.result.json")).not.toContain("--probe-turn");
    expect(() => cellRunArgs({ ...cell, variant: "--probe-turn" }, "claude", "opus", "/a", 1000, "/r")).toThrow(/may not name --probe-turn/);
    expect(() => cellRunArgs({ ...cell, schedule: "1=f1:x --probe-turn" }, "claude", "opus", "/a", 1000, "/r")).toThrow(/may not name --probe-turn/);
  });
  it("preflight refuses a manifest whose probe pin is not this program", async () => {
    const ok: PreflightProbe = { version: (a) => (a === "codex" ? "codex-cli 0.153.4" : "2.9.0 (Claude Code)"), managedSettings: () => [], freeBytes: () => 30 * 1024 ** 3, counts: () => ({ vitest: 0, jest: 0 }), codexCredential: () => true, claudeTokenLength: () => 1, evalInputDigest: () => "e".repeat(64), toolListSha256: () => "f".repeat(64), distProblems: () => [], capabilityProbe: async () => [] };
    expect((await preflightProblems({ ...manifest(), probeSha256: "0".repeat(64) }, tmp("t538pp-"), "codex", ok, 0)).join()).toMatch(/probe program's sha256/);
  });
  it("the real probes carry the capability probe, and preflight refuses to start without one", async () => {
    const real = realPreflightProbe(PKG, realGit(PKG), tmp("t538rp-"), {});
    expect(real.capabilityProbe).toBeTypeOf("function");
    const probe: PreflightProbe = { ...real, version: (a) => (a === "codex" ? "0.153.4" : "2.9.0"), managedSettings: () => [], freeBytes: () => 30 * 1024 ** 3, counts: () => ({ vitest: 0, jest: 0 }), codexCredential: () => true, claudeTokenLength: () => 1, evalInputDigest: () => "e".repeat(64), toolListSha256: () => "f".repeat(64), distProblems: () => [], capabilityProbe: undefined };
    expect(await preflightProblems(manifest(), tmp("t538rp-"), "codex", probe, 0)).toEqual(["no capability probe is wired; the driver does not start without one"]);
  });
  it("no option of the command line or the environment reaches the probe; the entry passes the real probes as they are", () => {
    const src = readFileSync(join(PKG, "scripts", "onboarding-eval-driver.ts"), "utf-8");
    const entrySrc = src.slice(src.indexOf("export async function entry("), src.indexOf("export function leftoverClean("));
    expect(entrySrc).toContain("preflightProblems(m, root, arm, realPreflightProbe(PKG, git, root, childEnv()), Date.now())");
    expect(src.slice(src.indexOf("export function realPreflightProbe("), src.indexOf("export async function entry("))).toContain("capabilityProbe: realCapabilityProbe(pkg, root, env),");
    expect(src).not.toMatch(/process\.env\.[A-Z_]*PROBE|argv\.includes\("--[a-z-]*probe|need\("[a-z-]*probe/);
  });
});
