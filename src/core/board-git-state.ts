import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import type { BoardTargetKind, BoardWriteContext } from "./board-write-recorder.js";

/**
 * ISS-1107: whether a board write is committed, and which board files are not.
 *
 * Two surfaces share this module. The write side reads the git state of each
 * file a write call recorded (and, on request, commits exactly those files).
 * The read side (`boardUncommitted`) lists the `.story/` files a status or
 * recap reader would otherwise assume were committed.
 *
 * Nothing here throws: a missing git binary, a non-repository, a timeout or a
 * failing command all degrade to a stated reason.
 */

/** The one wording of the commit option, shared by the MCP param, the CLI flag and the reference. */
export const COMMIT_PARAM_DESCRIPTION =
  "Commit exactly the board file(s) this call wrote: path-scoped add and `git commit --only`, refused if any of those files already has a staged change, and verified to contain only those files. Default false. Leave it false in a worker seat: the pen commits ledger files (N-109), and with one pen per repo the pen decides when. A writer in another process between this write and the commit is not serialized.";

/**
 * The MCP schema's short form: it repeats on every board write tool, so it
 * carries only what a caller cannot infer from the name (scope, the refusal,
 * the seat rule). The long form above is the CLI --help wording.
 */
export const MCP_COMMIT_PARAM_DESCRIPTION =
  "Commit only the file(s) this call wrote; refused if one is already staged. Pen only; worker seats leave it unset.";

// --- The single source of every reply string ---

export const BOARD_GIT_TEXT = {
  stateLine: (path: string, state: string) => `Git: ${path} ${state}`,
  noGit: (path: string, reason: string) => `Git: ${path} no git (${reason})`,
  notARepository: "not a repository",
  gitUnavailable: "git unavailable",
  /** A repository lookup that failed for any reason other than "not a repository". */
  unavailableAt: (path: string, detail: string) => `Git: ${path} unavailable (${detail})`,
  unavailableState: (detail: string) => `unavailable (${detail})`,
  unavailableReason: (detail: string) => `unavailable: ${detail}`,
  timedOut: "timed out",
  commitSkipped: (reason: string) => `Git: commit skipped (${reason})`,
  nothingToCommit: "nothing to commit",
  detachedHead: "detached HEAD",
  alreadyStaged: (path: string) => `${path} already staged by another change`,
  commitFailed: (firstLine: string) => `commit failed: ${firstLine}`,
  verificationFailed: (list: string) => `Git: commit verification failed (HEAD changed ${list})`,
  shaLookupFailed: (detail: string) => `commit created; SHA lookup failed: ${detail}`,
  verificationFailedReason: (reason: string) => `Git: commit verification failed (${reason})`,
  committed: (sha: string) => `Git: committed ${sha}`,
  sectionHeading: "## Board not committed",
  untrackedLine: (count: string, ids: string) => `Untracked (${count}): ${ids}`,
  modifiedLine: (count: string, ids: string) => `Modified (${count}): ${ids}`,
  differsLine: (head: string, base: string, count: string, ids: string) =>
    `On ${head}, differs from origin/${base} (${count})${ids ? `: ${ids}` : ""}`,
  branchSkipped: (reason: string) => `Branch comparison skipped: ${reason}`,
  partialScan: (names: string) => `Partial scan: ${names}`,
  unavailable: (reason: string) => `Board git state unavailable: ${reason}`,
} as const;

/**
 * The commit verb for each tool or command suffix. `snapshot` is absent on
 * purpose: it writes only ignored paths, so it can never commit.
 */
export const COMMIT_VERBS: Readonly<Record<string, string>> = {
  create: "created",
  update: "updated",
  add: "added",
  set: "set",
  unset: "unset",
  reinforce: "reinforced",
  accept: "accepted",
  propose: "proposed",
  supersede: "superseded",
  withdraw: "withdrawn",
  reserve: "reserved",
  assign: "assigned",
  release: "released",
  attach: "attached",
  change: "changed",
  reopen: "reopened",
  resolve: "resolved",
  retire: "retired",
  coordinate: "coordinated",
  rebind: "rebound",
  contest: "contested",
  write: "written",
  init: "initialized",
  delete: "deleted",
  move: "moved",
  rename: "renamed",
  clear: "cleared",
  start: "started",
  unclaim: "unclaimed",
  link: "linked",
  remove: "removed",
  defer: "deferred",
  restore: "restored",
  enable: "enabled",
  rotate: "rotated",
  compact: "compacted",
  rebase: "rebased",
  // CLI command leaves whose last token is not a verb.
  meta: "updated",
  brief: "rebased",
};

/** Tools that never commit, whatever `commit` says. */
export const COMMIT_INELIGIBLE_TOOLS: readonly string[] = ["storybloq_snapshot", "snapshot"];

/** The verb key of a tool (`storybloq_ticket_meta_set`) or CLI command (`set-overrides`). */
export function commitVerbKey(tool: string): string {
  const last = tool.split(/[_ ]/).pop() ?? tool;
  return last.split("-")[0] ?? last;
}

// --- Git runner ---

export interface GitRawResult {
  readonly ok: boolean;
  readonly code: number | null;
  /** Untrimmed: porcelain's leading space is data. */
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  /** stdout reached `maxBytes` and was cut there. */
  readonly truncated: boolean;
}

export interface GitRawOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly input?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Runs git with raw output. Every call uses literal pathspecs, so a path is
 * never read as a glob or magic signature. Optional index locks are off, so a
 * read never contends with a concurrent writer for `index.lock`.
 */
export function runGitRaw(cwd: string, args: readonly string[], opts: GitRawOptions = {}): Promise<GitRawResult> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolvePromise) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    let timedOut = false;
    const finish = (result: Omit<GitRawResult, "stdout" | "stderr" | "truncated" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, stdout: Buffer.concat(chunks).toString("utf-8"), stderr, truncated, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["--literal-pathspecs", ...args], {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolvePromise({ ok: false, code: null, stdout: "", stderr: "", timedOut: false, truncated: false, spawnError: (err as NodeJS.ErrnoException).code ?? String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish({ ok: false, code: null, spawnError: null });
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (truncated) return;
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => finish({ ok: false, code: null, spawnError: err.code ?? err.message }));
    child.on("close", (code) => finish({ ok: !truncated && code === 0, code: truncated ? null : code, spawnError: null }));
    child.stdin!.on("error", () => { /* git exited before reading its input */ });
    child.stdin!.end(opts.input ?? "");
  });
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "unknown error";
}

/** A failed command's first stderr line, or why it produced none. */
function failureDetail(result: GitRawResult): string {
  if (result.timedOut) return BOARD_GIT_TEXT.timedOut;
  if (result.spawnError) return BOARD_GIT_TEXT.gitUnavailable;
  return firstLine(result.stderr);
}

// --- Porcelain parsing and the state table ---

export interface StatusEntry {
  readonly xy: string;
  readonly path: string;
  readonly origPath?: string;
}

/**
 * Parses `status --porcelain=v1 -z` into complete logical entries. A rename or
 * copy needs both of its NUL-terminated fields; when output was cut at the cap,
 * an entry missing a field (or an unterminated trailing record) is discarded
 * whole and `incomplete` is set.
 */
export function parseStatusZ(stdout: string, truncated: boolean): { entries: StatusEntry[]; incomplete: boolean } {
  const fields = stdout.split("\0");
  // A complete output ends with NUL, leaving one empty trailing field. When cut,
  // the trailing field is unterminated (or the empty one after a cut at a NUL).
  const trailing = fields.pop() ?? "";
  let incomplete = truncated && trailing.length > 0;
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) {
      incomplete = true;
      continue;
    }
    const xy = field.slice(0, 2);
    const path = field.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      if (i + 1 >= fields.length) {
        incomplete = true;
        break;
      }
      entries.push({ xy, path, origPath: fields[++i]! });
      continue;
    }
    entries.push({ xy, path });
  }
  return { entries, incomplete };
}

/** Parses NUL-separated names (`diff --name-only -z`), dropping an unterminated tail when cut. */
export function parseNamesZ(stdout: string, truncated: boolean): { names: string[]; incomplete: boolean } {
  const fields = stdout.split("\0");
  const trailing = fields.pop() ?? "";
  return { names: fields.filter((name) => name.length > 0), incomplete: truncated && trailing.length > 0 };
}

const STAGED_CODES = "MARC";

/** The state of one porcelain row (the "XY" pair). */
export function stateOf(xy: string): string {
  const x = xy[0] ?? " ";
  const y = xy[1] ?? " ";
  if (xy === "??") return "untracked";
  if (xy === "!!") return "ignored";
  if (x === "U" || y === "U" || xy === "AA" || xy === "DD") return "conflict";
  if (x === "D" || y === "D") return "deleted";
  if (x === "T" || y === "T") return "modified";
  if (STAGED_CODES.includes(x) && y === "M") return "staged, modified";
  if (STAGED_CODES.includes(x) && y === " ") return "staged";
  if (x === " " && y === "M") return "modified";
  return `unknown (${xy})`;
}

// --- Write side ---

export interface BoardGitEntry {
  readonly path: string;
  readonly state: string;
}

export interface BoardGitCommitOutcome {
  readonly repo: string;
  readonly outcome: "committed" | "skipped" | "verification_failed";
  readonly sha?: string;
  readonly reason?: string;
  readonly paths: string[];
}

export interface BoardWriteReport {
  /** Markdown lines, in order. */
  readonly lines: string[];
  readonly git: BoardGitEntry[];
  readonly gitCommit?: BoardGitCommitOutcome[];
  readonly gitUnavailable?: { reason: string };
}

interface Target {
  readonly abs: string;
  readonly kind: BoardTargetKind;
  /** Repo-relative path, set once the repository is known. */
  rel: string;
  /** Project-relative fallback for a path outside any repository. */
  readonly display: string;
}

interface RepoGroup {
  readonly top: string;
  readonly targets: Target[];
}

/** `.story/...` relative to the project, for a path git cannot place. */
function projectRelative(abs: string): string {
  const marker = `${sep}.story${sep}`;
  const at = abs.lastIndexOf(marker);
  return at >= 0 ? abs.slice(at + 1).split(sep).join("/") : abs;
}

function realPathOf(abs: string): string {
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

/** Exit 128 naming a non-repository; any other failure (ownership, permissions) is not "no repository". */
function isNotARepository(result: GitRawResult): boolean {
  return result.code === 128 && /not a git repository/i.test(result.stderr);
}

/** The no-git reason, or null when the lookup failed for another reason (reported as unavailable). */
function noGitReason(result: GitRawResult): string | null {
  if (result.timedOut) return BOARD_GIT_TEXT.timedOut;
  if (result.spawnError) return BOARD_GIT_TEXT.gitUnavailable;
  return isNotARepository(result) ? BOARD_GIT_TEXT.notARepository : null;
}

async function readStates(top: string, targets: Target[]): Promise<Map<string, string>> {
  const states = new Map<string, string>();
  const status = await runGitRaw(top, ["status", "--porcelain=v1", "-z", "-uall", "--ignored=matching", "--", ...targets.map((t) => t.rel)]);
  const rows = new Map<string, string>();
  if (status.ok) {
    for (const entry of parseStatusZ(status.stdout, status.truncated).entries) rows.set(entry.path, entry.xy);
  }
  // An ignored directory is one `!!` row for the directory (even with -uall),
  // so a path with no row of its own takes its enclosing directory row.
  const dirRows = [...rows.entries()].filter(([path]) => path.endsWith("/"));
  for (const target of targets) {
    const xy = rows.get(target.rel) ?? dirRows.find(([dir]) => target.rel.startsWith(dir))?.[1];
    if (!status.ok) {
      states.set(target.rel, `unknown (${firstLine(status.stderr)})`);
    } else if (xy !== undefined) {
      states.set(target.rel, stateOf(xy));
    } else if ((await runGitRaw(top, ["cat-file", "-e", `HEAD:${target.rel}`])).ok) {
      states.set(target.rel, "committed");
    } else {
      states.set(target.rel, target.kind === "delete" ? "removed (was untracked)" : "unknown (no status row)");
    }
  }
  return states;
}

function idFromJsonText(text: string, rel: string): string {
  const stem = basename(rel, extname(rel));
  if (extname(rel) !== ".json") return stem;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const id = typeof parsed.displayId === "string" && parsed.displayId ? parsed.displayId
      : typeof parsed.id === "string" && parsed.id ? parsed.id : null;
    return id ?? stem;
  } catch {
    return stem;
  }
}

async function commitMessageId(top: string, target: Target): Promise<string> {
  if (target.kind === "delete") {
    const shown = await runGitRaw(top, ["show", `HEAD:${target.rel}`], { maxBytes: 256 * 1024 });
    return idFromJsonText(shown.ok ? shown.stdout : "", target.rel);
  }
  try {
    return idFromJsonText(readFileSync(target.abs, "utf-8"), target.rel);
  } catch {
    return basename(target.rel, extname(target.rel));
  }
}

async function commitGroup(group: RepoGroup, tool: string, states: Map<string, string>): Promise<{ outcome: BoardGitCommitOutcome; lines: string[] }> {
  const { top } = group;
  const repo = top;
  const skip = (reason: string, paths: string[]) => ({
    outcome: { repo, outcome: "skipped" as const, reason, paths },
    lines: [BOARD_GIT_TEXT.commitSkipped(reason)],
  });
  const eligible = COMMIT_INELIGIBLE_TOOLS.includes(tool)
    ? []
    : group.targets.filter((t) => {
      const state = states.get(t.rel);
      return state !== "ignored" && state !== "removed (was untracked)";
    });
  if (eligible.length === 0) return skip(BOARD_GIT_TEXT.nothingToCommit, []);

  const symbolic = await runGitRaw(top, ["symbolic-ref", "-q", "HEAD"]);
  if (!symbolic.ok) {
    return skip(symbolic.code === 1 ? BOARD_GIT_TEXT.detachedHead : BOARD_GIT_TEXT.commitFailed(firstLine(symbolic.stderr)), eligible.map((t) => t.rel));
  }
  // Unborn only on the quiet "no such ref" exit; any other failure is not a
  // reason to commit as a root commit.
  const headRef = await runGitRaw(top, ["rev-parse", "--verify", "-q", "HEAD"]);
  const unborn = !headRef.ok && headRef.code === 1 && !headRef.timedOut && !headRef.spawnError;
  if (!headRef.ok && !unborn) return skip(BOARD_GIT_TEXT.commitFailed(failureDetail(headRef)), eligible.map((t) => t.rel));

  // Step 0: only files that differ from HEAD commit; a byte-identical rewrite is already committed.
  const changed: Target[] = [];
  for (const target of eligible) {
    if (unborn) { changed.push(target); continue; }
    const state = states.get(target.rel);
    if (state === "untracked") { changed.push(target); continue; }
    const diff = await runGitRaw(top, ["diff", "--quiet", "HEAD", "--", target.rel]);
    if (diff.code === 1) changed.push(target);
    else if (diff.code !== 0) return skip(BOARD_GIT_TEXT.commitFailed(firstLine(diff.stderr)), eligible.map((t) => t.rel));
  }
  if (changed.length === 0) return skip(BOARD_GIT_TEXT.nothingToCommit, []);
  const paths = changed.map((t) => t.rel);

  // Step 2: never ship or clobber a staged change that is not ours.
  for (const path of paths) {
    const cached = await runGitRaw(top, ["diff", "--cached", "--quiet", "--", path]);
    if (cached.code === 1) return skip(BOARD_GIT_TEXT.alreadyStaged(path), paths);
    if (cached.code !== 0) return skip(BOARD_GIT_TEXT.commitFailed(firstLine(cached.stderr)), paths);
  }

  let parent: string | null = null;
  if (!unborn) {
    const parentRef = await runGitRaw(top, ["rev-parse", "HEAD"]);
    if (!parentRef.ok || !parentRef.stdout.trim()) return skip(BOARD_GIT_TEXT.commitFailed(failureDetail(parentRef)), paths);
    parent = parentRef.stdout.trim();
  }
  const add = await runGitRaw(top, ["add", "--", ...paths]);
  if (!add.ok) return skip(BOARD_GIT_TEXT.commitFailed(firstLine(add.stderr)), paths);
  const verb = COMMIT_VERBS[commitVerbKey(tool)] ?? "updated";
  const message = `docs(story): ${await commitMessageId(top, changed[0]!)} ${verb}`;
  const commit = await runGitRaw(top, ["commit", "--only", "-m", message, "--", ...paths], { timeoutMs: 120_000 });
  if (!commit.ok) {
    const detail = commit.timedOut ? BOARD_GIT_TEXT.timedOut : firstLine(commit.stderr || commit.stdout);
    return skip(BOARD_GIT_TEXT.commitFailed(detail), paths);
  }

  const verify = unborn
    ? await runGitRaw(top, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-z", "--no-renames", "-r", "HEAD"])
    : await runGitRaw(top, ["diff", "--name-only", "-z", "--no-renames", parent!, "HEAD"]);
  const shortRef = await runGitRaw(top, ["rev-parse", "--short", "HEAD"]);
  const sha = shortRef.stdout.trim();
  // The commit exists by now, so a failed lookup is never "skipped"; without a
  // sha there is no committed outcome either.
  const shaKnown = shortRef.ok && sha.length > 0;
  const inHead = parseNamesZ(verify.stdout, verify.truncated).names;
  const expected = [...paths].sort();
  const actual = [...inHead].sort();
  if (!verify.ok || expected.length !== actual.length || expected.some((p, i) => p !== actual[i])) {
    return {
      outcome: { repo, outcome: "verification_failed", ...(shaKnown ? { sha } : {}), reason: `HEAD changed ${actual.join(", ")}`, paths },
      lines: [BOARD_GIT_TEXT.verificationFailed(actual.join(", "))],
    };
  }
  if (!shaKnown) {
    const reason = BOARD_GIT_TEXT.shaLookupFailed(shortRef.ok ? "empty output" : failureDetail(shortRef));
    return { outcome: { repo, outcome: "verification_failed", reason, paths }, lines: [BOARD_GIT_TEXT.verificationFailedReason(reason)] };
  }
  return { outcome: { repo, outcome: "committed", sha, paths }, lines: [BOARD_GIT_TEXT.committed(sha)] };
}

/**
 * The git report for one write call: a state line per recorded board file and,
 * when the caller asked, a path-scoped commit per repository. Called only after
 * an explicitly successful result. Never throws.
 */
export async function reportBoardWrite(context: BoardWriteContext): Promise<BoardWriteReport> {
  const targets: Target[] = [...context.targets.entries()].map(([abs, kind]) => ({ abs: realPathOf(abs), kind, rel: "", display: projectRelative(abs) }));
  const lines: string[] = [];
  const git: BoardGitEntry[] = [];
  const gitCommit: BoardGitCommitOutcome[] = [];
  let gitUnavailable: { reason: string } | undefined;
  if (targets.length === 0) return { lines, git };

  const groups: RepoGroup[] = [];
  const topByDir = new Map<string, GitRawResult>();
  for (const target of targets) {
    let dir = dirname(target.abs);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    let top = topByDir.get(dir);
    if (!top) {
      top = await runGitRaw(dir, ["rev-parse", "--show-toplevel"]);
      topByDir.set(dir, top);
    }
    if (!top.ok) {
      const reason = noGitReason(top);
      if (reason !== null) {
        gitUnavailable ??= { reason };
        lines.push(BOARD_GIT_TEXT.noGit(target.display, reason));
        git.push({ path: target.display, state: `no git (${reason})` });
      } else {
        const detail = firstLine(top.stderr);
        gitUnavailable ??= { reason: BOARD_GIT_TEXT.unavailableReason(detail) };
        lines.push(BOARD_GIT_TEXT.unavailableAt(target.display, detail));
        git.push({ path: target.display, state: BOARD_GIT_TEXT.unavailableState(detail) });
      }
      continue;
    }
    const topPath = top.stdout.replace(/\n$/, "");
    target.rel = relative(topPath, target.abs).split(sep).join("/");
    let group = groups.find((g) => g.top === topPath);
    if (!group) {
      group = { top: topPath, targets: [] };
      groups.push(group);
    }
    group.targets.push(target);
  }

  for (const group of groups) {
    let states = await readStates(group.top, group.targets);
    let commitLines: string[] = [];
    if (context.commit) {
      const result = await commitGroup(group, context.tool, states);
      gitCommit.push(result.outcome);
      commitLines = result.lines;
      states = await readStates(group.top, group.targets);
      // A deletion the commit just took is in neither the worktree nor HEAD,
      // which reads like a file that was never tracked; it is committed.
      if (result.outcome.outcome !== "skipped") {
        for (const path of result.outcome.paths) {
          if (states.get(path) === "removed (was untracked)") states.set(path, "committed");
        }
      }
    }
    for (const target of group.targets) {
      const state = states.get(target.rel) ?? "unknown (no status row)";
      lines.push(BOARD_GIT_TEXT.stateLine(target.rel, state));
      git.push({ path: target.rel, state });
    }
    lines.push(...commitLines);
  }
  return {
    lines,
    git,
    ...(context.commit ? { gitCommit } : {}),
    ...(gitUnavailable ? { gitUnavailable } : {}),
  };
}

// --- Read side ---

export interface BoardIdList {
  readonly count: number;
  readonly ids: string[];
  readonly truncated: boolean;
}

export type BoardBranchState =
  | { readonly head: string; readonly base: string; readonly differing: BoardIdList }
  | { readonly skipped: string };

export type BoardUncommitted =
  | { readonly available: false; readonly reason: string }
  | {
    readonly available: true;
    readonly untracked: BoardIdList;
    readonly modified: BoardIdList;
    readonly branch: BoardBranchState;
    readonly partial?: string[];
  };

export const BOARD_ID_JSON_CAP = 200;
export const BOARD_ID_MARKDOWN_CAP = 20;
const WORKTREE_READ_BYTES = 64 * 1024;

interface BoardUncommittedOptions {
  readonly deadlineMs?: number;
  readonly maxBytes?: number;
}

class Budget {
  private readonly end: number;
  constructor(ms: number) { this.end = Date.now() + ms; }
  remaining(): number { return this.end - Date.now(); }
  expired(): boolean { return this.remaining() <= 0; }
}

function lexists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a worktree board file for its id, at most WORKTREE_READ_BYTES and only
 * while the deadline lasts. A symlink or anything but a regular file is never
 * opened (a FIFO would block the read), and the descriptor is opened without
 * following links and re-checked, so a swap between the check and the open
 * cannot redirect it. `rejected` marks a file the scan could not read; an
 * oversized file just falls back to its stem.
 */
function readBoundedRegularFile(abs: string, budget: Budget): { text: string | null; rejected: boolean } {
  let fd: number | undefined;
  try {
    if (!lstatSync(abs).isFile()) return { text: null, rejected: true };
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: null, rejected: true };
    if (stat.size > WORKTREE_READ_BYTES) return { text: null, rejected: false };
    const buffer = Buffer.alloc(WORKTREE_READ_BYTES);
    let length = 0;
    while (length < buffer.length) {
      if (budget.expired()) return { text: null, rejected: true };
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    return { text: buffer.subarray(0, length).toString("utf-8"), rejected: false };
  } catch {
    return { text: null, rejected: true };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** Parses `cat-file --batch` output for the given specs, in order. */
function parseCatFileBatch(stdout: string, specs: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  const buffer = Buffer.from(stdout, "utf-8");
  let offset = 0;
  for (const spec of specs) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = buffer.subarray(offset, newline).toString("utf-8");
    offset = newline + 1;
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) continue;
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    found.set(spec, buffer.subarray(offset, offset + size).toString("utf-8"));
    offset += size + 1;
  }
  return found;
}

/**
 * The `.story/` files that are not committed, and on a non-default branch the
 * board files that differ from `origin/<default>`. Async, bounded by one
 * aggregate deadline, never throws.
 */
export async function boardUncommitted(root: string, opts: BoardUncommittedOptions = {}): Promise<BoardUncommitted> {
  const budget = new Budget(opts.deadlineMs ?? 2000);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const git = (cwd: string, args: readonly string[], input?: string) =>
    budget.expired()
      ? Promise.resolve<GitRawResult>({ ok: false, code: null, stdout: "", stderr: "", timedOut: true, spawnError: null, truncated: false })
      : runGitRaw(cwd, args, { timeoutMs: budget.remaining(), maxBytes, input });

  const where = await git(root, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (!where.ok) {
    if (where.timedOut) return { available: false, reason: "timed out" };
    if (where.spawnError) return { available: false, reason: "no git" };
    if (isNotARepository(where)) return { available: false, reason: "not a repository" };
    return { available: false, reason: BOARD_GIT_TEXT.unavailableReason(firstLine(where.stderr)) };
  }
  const [topLine = "", prefixLine = ""] = where.stdout.split("\n");
  const top = topLine;
  const storySpec = `${prefixLine}.story/`;
  const partial: string[] = [];

  const status = await git(top, ["status", "--porcelain=v1", "-z", "-uall", "--", storySpec]);
  if (!status.ok && !status.truncated) {
    if (status.timedOut) return { available: false, reason: "timed out" };
    return { available: false, reason: `status failed: ${firstLine(status.stderr)}` };
  }
  const parsed = parseStatusZ(status.stdout, status.truncated);
  if (parsed.incomplete || status.truncated) partial.push("local");
  const untrackedPaths = parsed.entries.filter((e) => e.xy === "??").map((e) => e.path).sort();
  const modifiedEntries = parsed.entries.filter((e) => e.xy !== "??" && e.xy !== "!!");
  const modifiedPaths = modifiedEntries.map((e) => e.path).sort();

  let branch: BoardBranchState;
  let base: string | null = null;
  let differingPaths: string[] = [];
  let branchIncomplete = false;
  const symbolic = await git(top, ["symbolic-ref", "-q", "HEAD"]);
  if (!symbolic.ok) {
    branch = { skipped: symbolic.timedOut ? "timed out" : symbolic.code === 1 ? "detached HEAD" : "symbolic-ref failed" };
  } else {
    const head = symbolic.stdout.trim().replace(/^refs\/heads\//, "");
    const verified = await git(top, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (!verified.ok) {
      branch = { skipped: verified.timedOut ? "timed out" : "unborn HEAD" };
    } else {
      const remoteHead = await git(top, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
      const remoteName = remoteHead.ok ? remoteHead.stdout.trim() : "";
      if (remoteName) {
        base = remoteName.startsWith("origin/") ? remoteName.slice("origin/".length) : remoteName;
      } else {
        const configured = await git(top, ["config", "init.defaultBranch"]);
        base = configured.ok && configured.stdout.trim() ? configured.stdout.trim() : null;
      }
      if (budget.expired()) {
        branch = { skipped: "timed out" };
      } else if (base === null) {
        branch = { skipped: "no default branch" };
      } else if (head === base) {
        branch = { skipped: "default branch" };
      } else if (!(await git(top, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`])).ok) {
        branch = budget.expired() ? { skipped: "timed out" } : { skipped: `no origin/${base}` };
      } else {
        const diff = await git(top, ["diff", "--name-only", "-z", "--no-renames", `refs/remotes/origin/${base}`, "HEAD", "--", storySpec]);
        if (diff.timedOut) {
          branch = { skipped: "timed out" };
        } else {
          const names = parseNamesZ(diff.stdout, diff.truncated);
          differingPaths = names.names.sort();
          branchIncomplete = !diff.ok || names.incomplete || diff.truncated;
          if (branchIncomplete) partial.push("branch");
          branch = { head, base, differing: { count: 0, ids: [], truncated: false } };
        }
      }
    }
  }

  // Ids: the worktree file first; for a local deletion the index then HEAD; for a
  // branch difference HEAD then the compared tree. One batched object read.
  const idByPath = new Map<string, string>();
  const stem = (path: string) => basename(path, extname(path));
  const needsObject: Array<{ path: string; specs: string[] }> = [];
  let reads = 0;
  const wanted = [...new Set([...untrackedPaths, ...modifiedPaths].slice(0, BOARD_ID_JSON_CAP * 2))];
  for (const path of wanted) {
    if (path.includes("\n") || extname(path) !== ".json") { idByPath.set(path, stem(path)); continue; }
    const abs = join(top, path);
    if (lexists(abs)) {
      if (reads >= BOARD_ID_JSON_CAP || budget.expired()) { idByPath.set(path, stem(path)); continue; }
      reads++;
      const read = readBoundedRegularFile(abs, budget);
      if (read.rejected && !partial.includes("ids")) partial.push("ids");
      idByPath.set(path, read.text !== null ? idFromJsonText(read.text, path) : stem(path));
    } else {
      needsObject.push({ path, specs: [`:${path}`, `HEAD:${path}`] });
    }
  }
  if ("head" in branch) {
    for (const path of differingPaths.slice(0, BOARD_ID_JSON_CAP)) {
      if (idByPath.has(path)) continue;
      if (path.includes("\n") || extname(path) !== ".json") { idByPath.set(path, stem(path)); continue; }
      needsObject.push({ path, specs: [`HEAD:${path}`, `refs/remotes/origin/${branch.base}:${path}`] });
    }
  }
  if (needsObject.length > 0) {
    const specs = needsObject.flatMap((n) => n.specs);
    const batch = await git(top, ["cat-file", "--batch"], specs.map((s) => `${s}\n`).join(""));
    if (!batch.ok) partial.push("ids");
    const objects = parseCatFileBatch(batch.stdout, specs);
    for (const { path, specs: own } of needsObject) {
      const text = own.map((spec) => objects.get(spec)).find((value) => value !== undefined);
      idByPath.set(path, text !== undefined ? idFromJsonText(text, path) : stem(path));
    }
  }

  const list = (paths: string[], incomplete: boolean): BoardIdList => ({
    count: paths.length,
    ids: paths.slice(0, BOARD_ID_JSON_CAP).map((path) => idByPath.get(path) ?? stem(path)),
    truncated: incomplete || paths.length > BOARD_ID_JSON_CAP,
  });
  const localIncomplete = partial.includes("local");
  if ("head" in branch) branch = { head: branch.head, base: branch.base, differing: list(differingPaths, branchIncomplete) };
  return {
    available: true,
    untracked: list(untrackedPaths, localIncomplete),
    modified: list(modifiedPaths, localIncomplete),
    branch,
    ...(partial.length > 0 ? { partial } : {}),
  };
}

function markdownIds(list: BoardIdList): string {
  const shown = list.ids.slice(0, BOARD_ID_MARKDOWN_CAP);
  const more = list.count - shown.length;
  return more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ");
}

/** The Markdown section, or "" when there is nothing to say. */
export function renderBoardUncommitted(state: BoardUncommitted): string {
  if (!state.available) {
    if (state.reason === "not a repository") return "";
    const detail = state.reason.startsWith(BOARD_GIT_TEXT.unavailableReason("")) ? state.reason.slice(BOARD_GIT_TEXT.unavailableReason("").length) : state.reason;
    return `${BOARD_GIT_TEXT.sectionHeading}\n\n${BOARD_GIT_TEXT.unavailable(detail)}`;
  }
  const partial = state.partial ?? [];
  const count = (list: BoardIdList, scan: string) => (partial.includes(scan) ? `at least ${list.count}` : String(list.count));
  const showBranch = !("skipped" in state.branch && state.branch.skipped === "default branch");
  if (state.untracked.count === 0 && state.modified.count === 0 && partial.length === 0 && !showBranch) return "";
  const lines: string[] = [BOARD_GIT_TEXT.sectionHeading, ""];
  if (state.untracked.count > 0) lines.push(BOARD_GIT_TEXT.untrackedLine(count(state.untracked, "local"), markdownIds(state.untracked)));
  if (state.modified.count > 0) lines.push(BOARD_GIT_TEXT.modifiedLine(count(state.modified, "local"), markdownIds(state.modified)));
  if (showBranch) {
    lines.push("skipped" in state.branch
      ? BOARD_GIT_TEXT.branchSkipped(state.branch.skipped)
      : BOARD_GIT_TEXT.differsLine(state.branch.head, state.branch.base, count(state.branch.differing, "branch"), markdownIds(state.branch.differing)));
  }
  if (partial.length > 0) lines.push(BOARD_GIT_TEXT.partialScan(partial.join(", ")));
  return lines.join("\n");
}
