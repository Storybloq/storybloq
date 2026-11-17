/**
 * C-v4.1 commit 7: the ledger-state line. Where a ledger record stands in git
 * (untracked, added, modified, deleted, renamed, conflicted or committed) and,
 * for a known last commit, how that commit relates to the default branch.
 *
 * One request reads every requested file with a fixed set of git calls:
 * one identity call (toplevel and shallow state), one status over the whole
 * `.story/` directory (not the requested paths, so rename detection sees both
 * endpoints), at most one ls-files over the requested paths, the default-ref
 * resolution the git facts snapshot uses, one last-commit log per file, and
 * one left-right count per distinct sha.
 */
import { isAbsolute, join, relative, sep } from "node:path";
import { parseStatusZ, type StatusEntry } from "./board-git-state.js";
import { runGitFacts } from "./git-facts/runner.js";
import { resolveDefaultRef } from "./git-facts/snapshot.js";

/** The last commit that touched a path (repo- or root-relative), or null. Shared by lastChanged and the ledger-state line. */
export async function lastCommitOf(cwd: string, rel: string): Promise<{ readonly sha: string; readonly committedAt: string } | null> {
  const log = await runGitFacts({ cwd, args: ["log", "-1", "--format=%H%x00%cI", "--", `:(literal)${rel}`] });
  if (log.kind !== "ok") return null;
  const [sha = "", at = ""] = log.stdout.toString("utf8").trim().split("\0");
  if (sha.length === 0) return null;
  return { sha, committedAt: at };
}

export type LedgerLocalState = "untracked" | "added" | "modified" | "deleted" | "renamed" | "copied" | "conflicted" | "committed";

export interface LedgerRemote {
  readonly ref: string;
  readonly relation: "contains" | "ahead" | "diverged" | "unknown";
  readonly ahead?: number;
  readonly behind?: number;
  readonly reason?: string;
}

export interface LedgerState {
  readonly state: LedgerLocalState;
  readonly sha?: string;
  readonly committedAt?: string;
  /** Rename or copy source (destination side), or the source a deleted file was renamed from. */
  readonly from?: string;
  /** Rename destination, on a requested rename source. */
  readonly to?: string;
  /** Renamed or copied, then changed again in the worktree or index. */
  readonly modified?: boolean;
  /** Added, then deleted, never committed (AD). */
  readonly neverCommitted?: boolean;
  /** Present only when there is a sha. */
  readonly remote?: LedgerRemote;
}

const UNMERGED = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);

function git(cwd: string, args: string[]) {
  return runGitFacts({ cwd, args });
}

function out(r: Awaited<ReturnType<typeof git>>): string | null {
  return r.kind === "ok" ? r.stdout.toString("utf8") : null;
}

/** Repo-relative, forward-slash form of an absolute record path. */
function repoRel(top: string, abs: string): string {
  return relative(top, abs).split(sep).join("/");
}

interface Pending {
  readonly state: LedgerLocalState;
  /** Path whose history gives the sha (the rename source for a destination); null = no sha by construction. */
  readonly shaFrom: string | null;
  readonly from?: string;
  readonly to?: string;
  readonly modified?: boolean;
  readonly neverCommitted?: boolean;
}

/** The plan's classification table, first match wins. `inIndex` is consulted only for a path with no entry. */
export function classify(path: string, entry: StatusEntry | undefined, renamedAway: StatusEntry | undefined, inIndex: boolean): Pending {
  if (entry === undefined) {
    if (renamedAway !== undefined) return { state: "deleted", shaFrom: path, to: renamedAway.path };
    return inIndex ? { state: "committed", shaFrom: path } : { state: "untracked", shaFrom: null };
  }
  const { xy } = entry;
  const x = xy[0]!;
  const y = xy[1]!;
  const renameish = x === "R" || x === "C" || y === "R" || y === "C";
  if (UNMERGED.has(xy)) return { state: "conflicted", shaFrom: path };
  if (xy === "??") return { state: "untracked", shaFrom: null };
  if (xy === "AD") return { state: "deleted", shaFrom: null, neverCommitted: true };
  if (y === "D") {
    return renameish && entry.origPath !== undefined
      ? { state: "deleted", shaFrom: entry.origPath, from: entry.origPath }
      : { state: "deleted", shaFrom: path };
  }
  if (renameish && entry.origPath !== undefined) {
    const state: LedgerLocalState = x === "C" || y === "C" ? "copied" : "renamed";
    const modified = x === "M" || y === "M";
    return { state, shaFrom: entry.origPath, from: entry.origPath, ...(modified ? { modified: true } : {}) };
  }
  if (x === "A") return { state: "added", shaFrom: null };
  if (x === "M" || y === "M") return { state: "modified", shaFrom: path };
  if (x === "D") return { state: "deleted", shaFrom: path };
  // Any other code (T, a type change) is a change against the last commit.
  return { state: "modified", shaFrom: path };
}

export interface LedgerStateOptions {
  readonly defaultBranch?: string;
}

/**
 * Ledger state for each requested absolute record path, keyed by that path.
 * Every value is null when git is unavailable (not a repository, or the
 * identity or status call fails): absent, never guessed.
 */
export async function ledgerStates(root: string, recordPaths: readonly string[], opts: LedgerStateOptions = {}): Promise<Map<string, LedgerState | null>> {
  const result = new Map<string, LedgerState | null>();
  const none = () => { for (const p of recordPaths) result.set(p, null); return result; };
  if (recordPaths.length === 0) return result;

  const id = out(await git(root, ["rev-parse", "--show-toplevel", "--is-shallow-repository"]));
  if (id === null) return none();
  const [top = "", shallowRaw = ""] = id.split("\n");
  if (top.length === 0) return none();
  const shallow = shallowRaw.trim() === "true";

  const storyRel = repoRel(top, join(root, ".story"));
  const status = await runGitFacts({ cwd: top, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", `${storyRel}/`] });
  const statusOut = out(status);
  if (statusOut === null) return none();
  const { entries } = parseStatusZ(statusOut, false);
  const byPath = new Map<string, StatusEntry>();
  const bySource = new Map<string, StatusEntry>();
  for (const e of entries) {
    byPath.set(e.path, e);
    // Only a rename takes its source away; a copy source is classified by its own entry.
    if (e.origPath !== undefined && (e.xy[0] === "R" || e.xy[1] === "R")) bySource.set(e.origPath, e);
  }

  const rels = recordPaths.map((p) => repoRel(top, isAbsolute(p) ? p : join(root, p)));
  const noEntry = rels.filter((r) => !byPath.has(r) && !bySource.has(r));
  const indexed = new Set<string>();
  if (noEntry.length > 0) {
    const ls = out(await runGitFacts({ cwd: top, args: ["ls-files", "-z", "--", ...noEntry.map((r) => `:(literal)${r}`)] }));
    if (ls !== null) for (const name of ls.split("\0")) if (name.length > 0) indexed.add(name);
  }

  // The default ref, resolved once per request the way the git facts snapshot resolves it.
  const pending = rels.map((r) => classify(r, byPath.get(r), bySource.get(r), indexed.has(r)));
  let refName: string | null = null;
  let refReason: string | null = null;
  if (pending.some((p) => p.shaFrom !== null)) {
    if (shallow) refReason = "shallow repository";
    else {
      const ref = await resolveDefaultRef(top, opts.defaultBranch);
      if ("ref" in ref) refName = ref.ref;
      else refReason = ref.reason;
    }
  }

  const counts = new Map<string, LedgerRemote>();
  const remoteFor = async (sha: string): Promise<LedgerRemote> => {
    const display = refName === null ? "default branch" : refName.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
    if (refName === null) return { ref: display, relation: "unknown", reason: refReason ?? "missing default" };
    const cached = counts.get(sha);
    if (cached !== undefined) return cached;
    const r = out(await git(top, ["rev-list", "--left-right", "--count", `${refName}...${sha}`]));
    const [behindRaw = "", aheadRaw = ""] = (r ?? "").trim().split(/\s+/);
    const behind = Number.parseInt(behindRaw, 10);
    const ahead = Number.parseInt(aheadRaw, 10);
    let remote: LedgerRemote;
    if (r === null || !Number.isInteger(behind) || !Number.isInteger(ahead)) remote = { ref: display, relation: "unknown", reason: "count failed" };
    else if (ahead === 0) remote = { ref: display, relation: "contains" };
    else if (behind === 0) remote = { ref: display, relation: "ahead", ahead };
    else remote = { ref: display, relation: "diverged", ahead, behind };
    counts.set(sha, remote);
    return remote;
  };

  for (let i = 0; i < recordPaths.length; i += 1) {
    const p = pending[i]!;
    const last = p.shaFrom === null ? null : await lastCommitOf(top, p.shaFrom);
    const base: LedgerState = {
      state: p.state,
      ...(p.from !== undefined ? { from: p.from } : {}),
      ...(p.to !== undefined ? { to: p.to } : {}),
      ...(p.modified ? { modified: true } : {}),
      ...(p.neverCommitted ? { neverCommitted: true } : {}),
    };
    result.set(recordPaths[i]!, last === null ? base : { ...base, sha: last.sha, committedAt: last.committedAt, remote: await remoteFor(last.sha) });
  }
  return result;
}

/** One record's ledger state; null when git is unavailable. */
export async function ledgerState(root: string, recordPath: string, opts: LedgerStateOptions = {}): Promise<LedgerState | null> {
  return (await ledgerStates(root, [recordPath], opts)).get(recordPath) ?? null;
}

function remoteText(r: LedgerRemote): string {
  switch (r.relation) {
    case "contains": return `on ${r.ref}`;
    case "ahead": return `ahead of ${r.ref} by ${r.ahead}`;
    case "diverged": return `diverged from ${r.ref} (ahead ${r.ahead}, behind ${r.behind})`;
    default: return `${r.ref} unknown (${r.reason})`;
  }
}

/** The one Markdown line. */
export function ledgerStateLine(s: LedgerState | null): string {
  if (s === null) return "Ledger: unknown (git unavailable)";
  const at = s.sha !== undefined ? `, last at ${s.sha}` : "";
  const remote = s.remote !== undefined ? `, ${remoteText(s.remote)}` : "";
  const unknownSha = ", last commit unknown";
  switch (s.state) {
    case "untracked": return "Ledger: untracked";
    case "added": return "Ledger: added, not committed";
    case "conflicted": return s.sha !== undefined ? `Ledger: conflicted${at}${remote}` : "Ledger: conflicted, never committed";
    case "renamed":
    case "copied": {
      const mod = s.modified ? ", modified" : "";
      return s.sha !== undefined ? `Ledger: ${s.state} from ${s.from}${mod}${at}${remote}` : `Ledger: ${s.state} from ${s.from}${mod}, never committed`;
    }
    case "deleted": {
      if (s.neverCommitted) return "Ledger: added, then deleted, never committed";
      const why = s.to !== undefined ? ` (renamed to ${s.to})` : s.from !== undefined ? ` (was renamed from ${s.from})` : "";
      return s.sha !== undefined ? `Ledger: deleted${why}${at}${remote}` : `Ledger: deleted${why}${unknownSha}`;
    }
    case "modified": return s.sha !== undefined ? `Ledger: modified since ${s.sha}${remote}` : `Ledger: modified${unknownSha}`;
    case "committed": return s.sha !== undefined ? `Ledger: committed at ${s.sha}${remote}` : `Ledger: committed${unknownSha}`;
  }
}

/** The configured default branch (gitState.defaultBranch), as ledgerStates takes it. */
export function ledgerOptions(config: unknown): LedgerStateOptions {
  const b = (config as { gitState?: { defaultBranch?: unknown } } | undefined)?.gitState?.defaultBranch;
  return typeof b === "string" ? { defaultBranch: b } : {};
}

/**
 * Adds the ledger state to one rendered record: `data.ledgerState` on a JSON
 * envelope, or the line under the first Markdown heading (on top when there is
 * none). Any other output is returned unchanged.
 */
export function withLedgerState(output: string, format: "json" | "md", state: LedgerState | null): string {
  if (format === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { return output; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return output;
    const env = parsed as Record<string, unknown>;
    const data = env.data;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return output;
    return JSON.stringify({ ...env, data: { ...(data as Record<string, unknown>), ledgerState: state } }, null, 2);
  }
  const line = ledgerStateLine(state);
  const lines = output.split("\n");
  const h = lines.findIndex((l) => /^#{1,6} /.test(l));
  if (h === -1) return `${line}\n\n${output}`;
  lines.splice(h + 1, 0, "", line);
  return lines.join("\n");
}
