/**
 * ISS-1432: fixtures for the `storybloq land` tests. Every fixture is a fresh
 * temp directory holding a bare origin, a working clone with `main` pushed,
 * and a board with one ticket and one issue. Git runs under `isolateGit()`
 * for fixture commands, and every land call gets an explicit `baseEnv` with a
 * scratch HOME and a controlled PATH. gitleaks is a fake script; the real one
 * is never run.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProjectNoRecover, issueFilePath, ticketFilePath } from "../../src/core/project-loader.js";
import { handleIssueCreate } from "../../src/cli/commands/issue.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { defaultRunner, land, landExitCode, type LandOptions, type LandResult, type RunRequest, type RunResult, type Runner } from "../../src/core/land.js";
import { writeLandingReceipt } from "../../src/cli/commands/land.js";
import { git, headSha, tempDir } from "../mcp/board-git-fixtures.js";

export const GIT_BIN_DIR = dirname(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim());
export const CLOCK = new Date("2026-11-09T12:00:00.000Z");

/** A home path, built by concatenation so this file never carries one. */
export const HOME_PREFIX = "/Us" + "ers/";

export interface ItemRef {
  readonly display: string;
  readonly id: string;
  readonly path: string;
}

export interface Fx {
  readonly base: string;
  readonly origin: string;
  readonly repo: string;
  readonly board: string;
  readonly home: string;
  readonly fake: string;
  readonly gitleaks: string;
  readonly env: NodeJS.ProcessEnv;
  /** The remote tip after the fixture's own pushes (the land's T). */
  T: string;
  readonly ticket: ItemRef;
  readonly issue: ItemRef;
}

const FAKE_GITLEAKS = `#!/bin/sh
d="\${0%/*}"
printf '%s\\n' "$*" >> "$d/calls.log"
if [ "$1" = "git" ] && [ "$2" = "--help" ]; then
  if [ -f "$d/nohelp" ]; then exit 1; fi
  exit 0
fi
code=0
if [ -f "$d/scan-exit" ]; then read code < "$d/scan-exit"; fi
if [ "$code" = "1" ]; then echo "RuleID: generic-api-key"; fi
if [ "$code" = "2" ]; then echo "boom" >&2; fi
exit "$code"
`;

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function bytes(path: string): string {
  return readFileSync(path).toString("base64");
}

/** Runs a fixture git command in `cwd` with extra args; never under landEnv. */
export function g(cwd: string, ...args: string[]): string {
  return git(cwd, ...args);
}

export function remoteTip(fx: Fx, branch = "main"): string | null {
  try {
    return git(fx.origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).trim();
  } catch {
    return null;
  }
}

export function refsAndCount(dir: string): string {
  return `${git(dir, "for-each-ref")}\n${git(dir, "count-objects", "-v")}`;
}

/** Writes (or, with null, deletes) files in the repo, then commits. */
export function commit(fx: Fx, files: Record<string, string | null>, message = "change"): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(fx.repo, rel);
    if (content === null) {
      rmSync(abs, { force: true });
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  git(fx.repo, "add", "-A");
  git(fx.repo, "commit", "-q", "--allow-empty", "--cleanup=verbatim", "-m", message);
  return headSha(fx.repo);
}

/** Pushes HEAD to origin main directly (fixture setup, not land) and moves T. */
export function pushFixture(fx: Fx): string {
  git(fx.repo, "push", "-q", fx.origin, "HEAD:refs/heads/main");
  fx.T = headSha(fx.repo);
  return fx.T;
}

async function itemRef(board: string, display: string, kind: "ticket" | "issue"): Promise<ItemRef> {
  const { state } = await loadProjectNoRecover(board);
  const resolved = kind === "ticket" ? state.resolveTicketRef(display) : state.resolveIssueRef(display);
  if (resolved.kind !== "found") throw new Error(`fixture: ${display} not found`);
  const id = resolved.item.id;
  return { display, id, path: kind === "ticket" ? ticketFilePath(board, id) : issueFilePath(board, id) };
}

export async function fixture(opts: { board?: "repo" | "separate" } = {}): Promise<Fx> {
  const base = tempDir("land");
  const origin = join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  const board = opts.board === "separate" ? join(base, "board") : repo;
  mkdirSync(board, { recursive: true });
  await initProject(board, { name: "fixture" });
  const t = await handleTicketCreate({ title: "Land me", type: "task", phase: null, description: "", blockedBy: [], parentTicket: null }, "md", board);
  const i = await handleIssueCreate({ title: "Land here", severity: "medium", impact: "x", components: [], relatedTickets: [], location: [] }, "md", board);
  const ticketDisplay = /Created ticket (\S+?):/.exec(t.output)?.[1];
  const issueDisplay = /Created issue (\S+?):/.exec(i.output)?.[1];
  if (!ticketDisplay || !issueDisplay) throw new Error(`fixture: create output ${t.output} / ${i.output}`);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  const home = join(base, "home");
  mkdirSync(home);
  const fake = join(base, "fakebin");
  mkdirSync(fake);
  const gitleaks = join(fake, "gitleaks");
  writeFileSync(gitleaks, FAKE_GITLEAKS);
  chmodSync(gitleaks, 0o755);
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${fake}:${GIT_BIN_DIR}:/usr/bin:/bin` };
  return {
    base, origin, repo, board, home, fake, gitleaks, env,
    T: headSha(repo),
    ticket: await itemRef(board, ticketDisplay, "ticket"),
    issue: await itemRef(board, issueDisplay, "issue"),
  };
}

/** A second clone of origin, for racing pushes. */
export function otherClone(fx: Fx, name = "other"): string {
  const dir = join(fx.base, name);
  git(fx.base, "clone", "-q", fx.origin, dir);
  return dir;
}

export interface Call {
  readonly cmd: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  result?: RunResult;
}

export type Intercept = (req: RunRequest, calls: Call[]) => RunResult | undefined | Promise<RunResult | undefined>;

export interface LandRun {
  readonly result: LandResult;
  readonly calls: Call[];
  readonly exit: number;
}

/** The git subcommand of a recorded call (after the --git-dir/--work-tree prefix). */
export function sub(call: Call): string | undefined {
  if (call.cmd !== "git") return undefined;
  for (let i = 0; i < call.args.length; i++) {
    const a = call.args[i]!;
    if (a === "--git-dir" || a === "--work-tree") { i++; continue; }
    if (a.startsWith("--")) continue;
    return a;
  }
  return undefined;
}

/** The args after the subcommand's leading options prefix (from the subcommand on). */
export function subArgs(call: Call): string[] {
  const s = sub(call);
  return s === undefined ? [] : call.args.slice(call.args.indexOf(s));
}

export const pushes = (calls: Call[]) => calls.filter((c) => sub(c) === "push");
export const lsRemotes = (calls: Call[]) => calls.filter((c) => sub(c) === "ls-remote");
export const network = (calls: Call[]) => calls.filter((c) => sub(c) === "push" || sub(c) === "ls-remote");
export const gitleaksCalls = (fx: Fx, calls: Call[]) => calls.filter((c) => c.cmd === fx.gitleaks);

/** The porcelain record flag of the push call's real output, or "none". */
export function pushRecordClass(calls: Call[]): string {
  const p = pushes(calls)[0];
  if (!p?.result || p.result.kind !== "exit") return "none";
  const rec = p.result.stdout.toString("utf-8").split("\n").find((l) => /^.\t[^\t]*:refs\/heads\//.test(l));
  return rec ? rec[0]! : "none";
}

export async function runLand(
  fx: Fx,
  o: Partial<LandOptions> & { intercept?: Intercept } = {},
): Promise<LandRun> {
  const calls: Call[] = [];
  const { intercept, ...rest } = o;
  const runner: Runner = async (req) => {
    const call: Call = { cmd: req.cmd, args: [...req.args], env: req.env };
    calls.push(call);
    const injected = intercept ? await intercept(req, calls) : undefined;
    const r = injected ?? (await defaultRunner(req));
    call.result = r;
    return r;
  };
  const result = await land({
    sha: "HEAD",
    repo: fx.repo,
    remote: "origin",
    branch: "main",
    boardRoot: fx.board,
    secretsScan: true,
    gitleaksPath: fx.gitleaks,
    baseEnv: fx.env,
    clock: () => CLOCK,
    runner,
    writeReceipt: writeLandingReceipt,
    ...rest,
  });
  return { result, calls, exit: landExitCode(result) };
}

export function landingsOf(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>).landings;
}

/** Every file under a directory, relative, sorted (lock and temp leftovers show up here). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push(relative(dir, abs));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Writes a valid pending transaction journal that would rewrite `target`
 * (recovery renames the temp file over it). Returns the journal path.
 */
export function writePendingJournal(board: string, target: string): string {
  const tempPath = `${target}.4242.tmp`;
  const current = JSON.parse(readFileSync(target, "utf-8")) as Record<string, unknown>;
  writeFileSync(tempPath, JSON.stringify({ ...current, title: "Recovered by someone else" }, null, 2));
  const journal = join(board, ".story", ".txn.json");
  writeFileSync(journal, JSON.stringify({ entries: [{ op: "write", target, tempPath }], commitStarted: true }));
  return journal;
}

export function exitResult(code: number, stdout = "", stderr = ""): RunResult {
  return { kind: "exit", code, stdout: Buffer.from(stdout, "utf-8"), stderr };
}
