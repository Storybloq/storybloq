/**
 * T-538 commit 4 (plan v5 7.3, Addendum D ruling 2): the runner's structured result. With `--result <file>`, the
 * runner writes one JSON file on every terminal path, including a thrown error, so the driver never infers what
 * happened from an exit code. The file is written to a temporary name beside it, fsynced, renamed into place and
 * the folder fsynced, so a reader sees the whole file or none.
 */
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProbeTurnFacts } from "./onboarding-eval-probe.js";

/** Where a run was when it ended: the parts of `main`, in order, then the two follow-up modes. */
export const RUNNER_STAGES = ["args", "preflight", "provision", "turns", "collect", "record", "scan", "finalize", "regrade"] as const;
export type RunnerStage = (typeof RUNNER_STAGES)[number];
export type RunnerMode = "run" | "finalize" | "regrade";

/** One turn's structured findings, from every turn the run made: its infrastructure failure and its process group's cleanup. */
export interface TurnFinding { readonly turn: number; readonly infraFailure: string | null; readonly cleanup: "confirmed" | "unconfirmed"; readonly cleanupDetail: string | null }

export type RunnerResult =
  | { readonly ok: true; readonly mode: RunnerMode; readonly stage: "done"; readonly exitCode: number; readonly runId: string | null; readonly recordDir: string | null; readonly rawDir: string | null; readonly verdict: string | null; readonly probe?: ProbeTurnFacts; readonly turns?: readonly TurnFinding[] }
  | { readonly ok: false; readonly mode: RunnerMode; readonly stage: RunnerStage; readonly message: string; readonly turns?: readonly TurnFinding[] };

/** What the run has reached so far; `main` moves `stage` forward as it goes and fills the rest when it knows them. */
/** `probe` is the `--probe-turn` mode's facts (T-538 commit 4, section 8 step 3), null for every other run. */
/** `turns` holds every turn's findings as it ends; a result carries them when there are any. */
export interface RunnerProgress { stage: RunnerStage; runId: string | null; recordDir: string | null; rawDir: string | null; verdict: string | null; refusal: string | null; probe: ProbeTurnFacts | null; turns: TurnFinding[] }
export const newProgress = (stage: RunnerStage): RunnerProgress => ({ stage, runId: null, recordDir: null, rawDir: null, verdict: null, refusal: null, probe: null, turns: [] });

/** The `--result` path, absolute, or null when the caller asked for none. A flag with no value is an error. */
export function resultPathOf(argv: readonly string[]): string | null {
  const i = argv.indexOf("--result");
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error("--result needs a file path");
  return resolve(v);
}

/** Writes `r` to `path` through a temporary name and a rename, fsyncing the file and its folder. */
export function writeRunnerResult(path: string, r: RunnerResult): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(r, null, 2)}\n`, "utf-8");
    for (let off = 0; off < bytes.length;) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* the write failure is what is reported */ }
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/**
 * Runs one runner mode and writes its result when `path` is set. A thrown error is reported on stderr with exit 2,
 * as before, and its result names the stage `progress` had reached. A refusal the mode records (`progress.refusal`)
 * is a result with ok false. A failure to write the result is itself reported and exits 2.
 */
export async function withRunnerResult(path: string | null, mode: RunnerMode, progress: RunnerProgress, run: () => Promise<void>): Promise<void> {
  let result: RunnerResult;
  const turns = (): { turns?: readonly TurnFinding[] } => (progress.turns.length > 0 ? { turns: [...progress.turns] } : {});
  try {
    await run();
    result = progress.refusal !== null
      ? { ok: false, mode, stage: progress.stage, message: progress.refusal, ...turns() }
      : { ok: true, mode, stage: "done", exitCode: typeof process.exitCode === "number" ? process.exitCode : 0, runId: progress.runId, recordDir: progress.recordDir, rawDir: progress.rawDir, verdict: progress.verdict, ...turns(), ...(progress.probe !== null ? { probe: progress.probe } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    result = { ok: false, mode, stage: progress.stage, message, ...turns() };
  }
  if (path === null) return;
  try {
    writeRunnerResult(path, result);
  } catch (err) {
    process.stderr.write(`onboarding-eval: the runner result ${path} could not be written: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
