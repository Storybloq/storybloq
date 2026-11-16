/**
 * C-v4.1 commit 4: the git facts every surface reads (get, status, ticket
 * list, recommend), for the board's own repository only. Federation repos and
 * the `unresolved repo` and `mismatched repo` reasons arrive with proof in
 * commit 5.
 */
import { statSync } from "node:fs";
import { relative } from "node:path";
import type { ProjectState } from "../project-state.js";
import { runGitFacts } from "./runner.js";
import { PatternTimeoutError } from "./pattern-sandbox.js";
import { compileBoundedPattern, takeGitSnapshot, type GitSnapshot, type UnknownReason } from "./snapshot.js";
import { attributedCommits, itemFacts, itemGitState, type ItemGitFacts, type ItemGitState } from "./attribution.js";

export interface GitFactsView {
  readonly snapshot: GitSnapshot;
  readonly items: Map<string, ItemGitFacts> | undefined;
  /** C-v4.1 commit 5: canonical id -> every attributed code commit; undefined when the facts are unknown. */
  readonly commits: Map<string, Set<string>> | undefined;
  stateOf(id: string): ItemGitState;
}

export interface GitCounts {
  /** Open or in-progress items with a commit landed or released. */
  readonly landedOpen: number;
  /** Complete or resolved items with attributed commits, none landed or released. */
  readonly completeUnlanded: number;
  /** Items whose facts are unknown (every item when the snapshot is unknown). */
  readonly unknown: number;
  readonly reason?: UnknownReason;
}

interface GitStateSettings {
  maxGraphCommits?: number;
  maxRefs?: number;
  subjectPattern?: string;
  releaseTagPattern?: string;
  defaultBranch?: string;
}

function settingsOf(state: ProjectState): GitStateSettings {
  const raw = (state.config as unknown as { gitState?: GitStateSettings }).gitState;
  return raw ?? {};
}

export async function readGitFacts(root: string, state: ProjectState): Promise<GitFactsView> {
  const s = settingsOf(state);
  const snapshot = await takeGitSnapshot(root, {
    ...(s.maxGraphCommits !== undefined ? { maxGraphCommits: s.maxGraphCommits } : {}),
    ...(s.maxRefs !== undefined ? { maxRefs: s.maxRefs } : {}),
    ...(s.defaultBranch !== undefined ? { defaultBranch: s.defaultBranch } : {}),
    ...(s.releaseTagPattern !== undefined ? { releaseTagPattern: s.releaseTagPattern } : {}),
  });
  const pattern = s.subjectPattern !== undefined ? compileBoundedPattern("gitState.subjectPattern", s.subjectPattern) : undefined;
  let view: GitSnapshot = snapshot;
  let items: Map<string, ItemGitFacts> | undefined;
  let commits: Map<string, Set<string>> | undefined;
  try {
    commits = snapshot.status === "ok" ? attributedCommits(snapshot, state, pattern) : undefined;
    items = snapshot.status === "ok" ? itemFacts(snapshot, state, pattern, commits) : undefined;
  } catch (e) {
    // Codex finding 1: a configured pattern that runs past its deadline makes the facts unknown, never a hang.
    if (!(e instanceof PatternTimeoutError)) throw e;
    view = { status: "unknown", reason: "pattern timeout", detail: e.field };
    commits = undefined;
  }
  return { snapshot: view, items, commits, stateOf: (id) => itemGitState(view, items, id) };
}

const OPEN = new Set(["open", "inprogress"]);
const DONE = new Set(["complete", "resolved"]);

export function gitCounts(view: GitFactsView, state: ProjectState): GitCounts {
  const all = [...state.tickets, ...state.issues] as ReadonlyArray<{ id: string; status: string }>;
  if (view.snapshot.status !== "ok") return { landedOpen: 0, completeUnlanded: 0, unknown: all.length, reason: view.snapshot.reason };
  let landedOpen = 0;
  let completeUnlanded = 0;
  for (const item of all) {
    const f = view.items?.get(item.id);
    if (f === undefined) continue;
    const landed = f.state === "released" || f.state === "landed";
    if (landed && OPEN.has(item.status)) landedOpen += 1;
    if (!landed && DONE.has(item.status)) completeUnlanded += 1;
  }
  return { landedOpen, completeUnlanded, unknown: 0 };
}

/** Open or in-progress items with a landed or released commit; undefined when the facts are unknown. */
export function landedOpenIds(view: GitFactsView, state: ProjectState): Set<string> | undefined {
  if (view.snapshot.status !== "ok") return undefined;
  const out = new Set<string>();
  for (const item of [...state.tickets, ...state.issues] as ReadonlyArray<{ id: string; status: string }>) {
    const f = view.items?.get(item.id);
    if (f !== undefined && (f.state === "landed" || f.state === "released") && OPEN.has(item.status)) out.add(item.id);
  }
  return out;
}

export type LastChanged =
  | { readonly sha: string; readonly committedAt: string }
  | { readonly uncommitted: true; readonly updatedAt: string }
  | null;

/**
 * v2 addendum: the last commit that touched the record's file, or
 * `{uncommitted: true, updatedAt}` (the file's modification time) when the
 * file has uncommitted changes; null when it cannot be determined.
 */
export async function lastChanged(root: string, recordPath: string): Promise<LastChanged> {
  const rel = relative(root, recordPath);
  const status = await runGitFacts({ cwd: root, args: ["status", "--porcelain", "--untracked-files=all", "--", rel] });
  if (status.kind !== "ok") return null;
  if (status.stdout.toString("utf8").trim().length > 0) {
    try {
      return { uncommitted: true, updatedAt: statSync(recordPath).mtime.toISOString() };
    } catch {
      return null;
    }
  }
  const log = await runGitFacts({ cwd: root, args: ["log", "-1", "--format=%H%x00%cI", "--", rel] });
  if (log.kind !== "ok") return null;
  const [sha = "", at = ""] = log.stdout.toString("utf8").trim().split("\0");
  if (sha.length === 0) return null;
  return { sha, committedAt: at };
}

/** C-v4.1 commit 4, Q4 ruling: the two fields every get carries, on both clients. */
export interface GitGetFields {
  readonly gitState: ItemGitState;
  readonly lastChanged: LastChanged;
}

export async function gitGetFields(root: string, state: ProjectState, id: string, recordPath: string): Promise<GitGetFields> {
  const view = await readGitFacts(root, state);
  return { gitState: view.stateOf(id), lastChanged: await lastChanged(root, recordPath) };
}

/** The one Markdown git line on get. */
export function gitMarkdownLine(f: GitGetFields): string {
  const g = f.gitState;
  let state: string;
  if (g.state === "unknown") state = `unknown (${g.reason})`;
  else {
    const n = g.counts.released + g.counts.landed + g.counts.built + g.counts.none;
    state = n === 0 ? "none (no attributed commits)" : `${g.state} (${n} commit${n === 1 ? "" : "s"}: ${g.counts.released} released, ${g.counts.landed} landed, ${g.counts.built} built, ${g.counts.none} none)`;
  }
  const lc = f.lastChanged;
  const changed = lc === null ? "unknown" : "uncommitted" in lc ? `uncommitted, ${lc.updatedAt}` : `${lc.sha.slice(0, 12)} at ${lc.committedAt}`;
  return `Git state: ${state}; record last changed ${changed}`;
}

/** One Markdown line for status and lists, or null when there is nothing to say. */
export function gitCountsLine(c: GitCounts): string | null {
  if (c.reason !== undefined) return `Git state: facts unknown (${c.reason})`;
  if (c.landedOpen === 0 && c.completeUnlanded === 0) return null;
  return `Git state: ${c.landedOpen} landed but still open, ${c.completeUnlanded} complete but not landed`;
}
