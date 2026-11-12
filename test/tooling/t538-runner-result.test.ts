/**
 * T-538 commit 4 (plan v5 7.3, Addendum D ruling 2): the runner writes runner-result.json on every terminal path,
 * a thrown error included, through a temporary name and a rename. The rows run the real runner as a child for
 * every stage a no-model run can reach, and the shared wrapper for the stages only a live run reaches; a source
 * row pins that `main` moves through those stages in order.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { newProgress, RUNNER_STAGES, withRunnerResult, writeRunnerResult, type RunnerResult } from "../../scripts/onboarding-eval-runner-result.js";
import { turnCleanup } from "../../scripts/onboarding-eval-run.js";

const PKG = join(__dirname, "..", "..");
const RUNNER = join(PKG, "scripts", "onboarding-eval-run.ts");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Runs the runner under a bare environment (no codex on PATH, no credentials) with `--result`, and reads the file. */
function runner(dir: string, args: readonly string[]): { status: number | null; stderr: string; result: RunnerResult | null; left: string[] } {
  const path = join(dir, "runner-result.json");
  const r = spawnSync(process.execPath, ["--import", "tsx", RUNNER, ...args, "--result", path], {
    cwd: PKG, encoding: "utf-8", timeout: 120_000, env: { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: tmpdir() },
  });
  return { status: r.status, stderr: r.stderr, result: existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) as RunnerResult : null, left: readdirSync(dir).filter((f) => f.includes(".tmp-")) };
}

function withDir<T>(f: (d: string) => T): T {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "t538rr-")));
  const done = (): void => rmSync(d, { recursive: true, force: true });
  let out: T;
  try { out = f(d); } catch (e) { done(); throw e; }
  if (out instanceof Promise) return out.finally(done) as T;
  done();
  return out;
}

describe("7.3: runner-result.json from the real runner", () => {
  it("a thrown error while reading the arguments is a result at stage args, and exit 2", () => withDir((d) => {
    const r = runner(d, ["--client", "nobody"]);
    expect(r.status).toBe(2);
    expect(r.result).toEqual({ ok: false, mode: "run", stage: "args", message: "--client must be claude or codex" });
    expect(r.left).toEqual([]);
  }), 120_000);

  it("a thrown error in the preflight is a result at stage preflight", () => withDir((d) => {
    const r = runner(d, ["--client", "codex", "--fixture", "empty-idea", "--out", join(d, "out"), "--raw-out", join(d, "raw")]);
    expect(r.status).toBe(2);
    expect(r.result).toEqual({ ok: false, mode: "run", stage: "preflight", message: "onboarding-eval: codex is not on PATH; the tool server runs under its sandbox wrapper" });
  }), 120_000);

  it("a finalize that refuses is a result at stage finalize; one that passes is a done result with its verdict", () => withDir((d) => {
    const packet = JSON.stringify({ runId: "run-a", semanticLines: ["q"] });
    const record = { runId: "run-a", failures: [], semanticLines: ["q"], bound: {}, packetSha256: sha256(packet) };
    writeFileSync(join(d, "record.json"), JSON.stringify(record));
    writeFileSync(join(d, "grading-packet.json"), JSON.stringify({ runId: "run-b", semanticLines: ["q"] }));
    const judge = { packetSha256: sha256(packet), observedModel: "gpt-6-astra", lines: [{ line: "q", verdict: "pass", reason: "" }] };
    writeFileSync(join(d, "judge.json"), JSON.stringify(judge));
    const refused = runner(d, ["--finalize", d, "--judge", join(d, "judge.json")]);
    expect(refused.status).toBe(2);
    expect(refused.result).toMatchObject({ ok: false, mode: "finalize", stage: "finalize" });
    expect((refused.result as { message: string }).message).toContain("finalize refused");
    writeFileSync(join(d, "grading-packet.json"), packet);
    const done = runner(d, ["--finalize", d, "--judge", join(d, "judge.json")]);
    expect(done.status).toBe(0);
    expect(done.result).toEqual({ ok: true, mode: "finalize", stage: "done", exitCode: 0, runId: "run-a", recordDir: d, rawDir: null, verdict: "PASS" });
    expect(done.left).toEqual([]);
  }), 120_000);

  it("a regrade with missing arguments is a result at stage regrade", () => withDir((d) => {
    const r = runner(d, ["--regrade", d]);
    expect(r.status).toBe(2);
    expect(r.result).toEqual({ ok: false, mode: "regrade", stage: "regrade", message: "--regrade <recordDir> --raw <rawDir> [--judge <judge.json>]" });
  }), 120_000);

  it("without --result nothing is written, and the error still exits 2", () => withDir((d) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", RUNNER, "--client", "nobody"], { cwd: PKG, encoding: "utf-8", timeout: 120_000, env: { PATH: "/usr/bin:/bin", HOME: d, TMPDIR: tmpdir() } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--client must be claude or codex");
    expect(readdirSync(d)).toEqual([]);
  }), 120_000);
});

describe("7.3: the wrapper, for the stages only a live run reaches", () => {
  for (const stage of RUNNER_STAGES) {
    it(`a thrown error at stage ${stage} is written with that stage and its message`, async () => {
      await withDir(async (d) => {
        const path = join(d, "r.json");
        const p = newProgress("args");
        const before = process.exitCode;
        try {
          await withRunnerResult(path, "run", p, async () => { p.stage = stage; throw new Error(`boom at ${stage}`); });
          expect(process.exitCode).toBe(2);
        } finally {
          process.exitCode = before;
        }
        expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ ok: false, mode: "run", stage, message: `boom at ${stage}` });
        expect(readdirSync(d)).toEqual(["r.json"]);
      });
    });
  }

  it("a normal end is a done result carrying the exit code, the run id, the record folder and the verdict", async () => {
    await withDir(async (d) => {
      const path = join(d, "r.json");
      const p = newProgress("args");
      const before = process.exitCode;
      try {
        await withRunnerResult(path, "run", p, async () => { p.stage = "scan"; p.runId = "codex-x"; p.recordDir = "/out/codex-x"; p.rawDir = "/raw/codex-x"; p.verdict = "PENDING_SEMANTIC"; process.exitCode = 3; });
      } finally {
        process.exitCode = before;
      }
      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ ok: true, mode: "run", stage: "done", exitCode: 3, runId: "codex-x", recordDir: "/out/codex-x", rawDir: "/raw/codex-x", verdict: "PENDING_SEMANTIC" });
    });
  });

  it("every turn's findings are carried, on an ok result and on a thrown one", async () => {
    await withDir(async (d) => {
      const turn = { turn: 1, infraFailure: "cleanup: unconfirmed", cleanup: "unconfirmed" as const, cleanupDetail: "pgid 7" };
      const ok = newProgress("args");
      await withRunnerResult(join(d, "a.json"), "run", ok, async () => { ok.turns.push(turn); });
      expect(JSON.parse(readFileSync(join(d, "a.json"), "utf-8")).turns).toEqual([turn]);
      const thrown = newProgress("args");
      const before = process.exitCode;
      try {
        await withRunnerResult(join(d, "b.json"), "run", thrown, async () => { thrown.turns.push(turn); throw new Error("boom"); });
      } finally { process.exitCode = before; }
      expect(JSON.parse(readFileSync(join(d, "b.json"), "utf-8"))).toMatchObject({ ok: false, message: "boom", turns: [turn] });
    });
  });

  it("a write never leaves a partial file under the final name, and refuses a leftover temporary name", () => {
    withDir((d) => {
      const path = join(d, "r.json");
      writeFileSync(join(d, `.r.json.tmp-${process.pid}`), "stale");
      expect(() => writeRunnerResult(path, { ok: false, mode: "run", stage: "args", message: "x" })).toThrow(/EEXIST/);
      expect(existsSync(path)).toBe(false);
    });
  });

  it("main moves through the stages in order, and the entry writes the result on every mode", () => {
    const src = readFileSync(RUNNER, "utf-8");
    const at = (s: string): number => src.indexOf(`progress.stage = "${s}";`);
    const order = ["args", "preflight", "provision", "turns", "collect", "record", "scan"].map(at);
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(at("provision")).toBeGreaterThan(src.indexOf("const runId = `"));
    expect(at("turns")).toBeLessThan(src.indexOf("for (let step = flow.next(); !step.done;)"));
    expect(at("scan")).toBeLessThan(src.indexOf("await scanAndClear(collector, recordDir"));
    expect(src).toContain("void withRunnerResult(resultPath, mode, progress, () => (mode === \"regrade\" ? regradeCli(argv) : mode === \"finalize\" ? finalize(argv) : main()));");
  });
});

describe("T-538 commit 4 round 2 (T5): a turn's cleanup finding includes the leftover check", () => {
  const timedOut = { cleanup: "confirmed" as const, cleanupDetail: null };
  it.each([
    ["a leftover holder after a timeout", { status: "holders", reason: "leftover: 4242 node" }, /^leftover check holders: leftover: 4242 node$/],
    ["a failed leftover check after a timeout", { status: "failed", reason: "leftover check failed: killed by SIGKILL" }, /^leftover check failed: leftover check failed: killed by SIGKILL$/],
  ])("%s is an unconfirmed cleanup with its reason, though the group itself was confirmed gone", (_n, leftover, re) => {
    const c = turnCleanup(timedOut, leftover);
    expect(c.cleanup).toBe("unconfirmed");
    expect(c.cleanupDetail).toMatch(re);
  });

  it("an unconfirmed group end and a leftover both appear in the detail; a clean check with a confirmed end is confirmed", () => {
    expect(turnCleanup({ cleanup: "unconfirmed", cleanupDetail: "group 7 still exists" }, { status: "holders", reason: "leftover: 9 node" })).toEqual({ cleanup: "unconfirmed", cleanupDetail: "group 7 still exists; leftover check holders: leftover: 9 node" });
    expect(turnCleanup(timedOut, { status: "clean", reason: null })).toEqual({ cleanup: "confirmed", cleanupDetail: null });
  });
});
