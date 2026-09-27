/**
 * T-534: what landed while a FINALIZE session was away. The evidence is read
 * once, as separate fields, and each caller applies its own rule to it:
 *
 * - `finalizeEnterRoute` is FinalizeStage.enter()'s rule, unchanged from
 *   before the extraction (it never consults ancestry).
 * - `classifyLandedCommit` is the stricter rule the usage-limit retirement
 *   uses to decide whether a legacy FINALIZE park may keep FINALIZE.
 *
 * Read-only: nothing here writes session state or touches the index.
 */
import type { FullSessionState } from "./session-types.js";
import { gitDiffTreeNames, gitHead, gitIsAncestor } from "./git-inspector.js";

/**
 * The commit from which the CURRENT item must produce a new, validated commit
 * (ISS-922). Initialized at item pick; reset when drift invalidates the epoch.
 *
 * NOT expectedHead: that records the last OBSERVED head, and park,
 * resume-drift and checkout all legitimately advance it -- onto the very
 * commit FINALIZE has not yet seen. That is what closed all three exits from
 * this stage and stranded a session with no supported recovery.
 *
 * NOT mergeBase either: it is the fork point from main for the first item, so
 * on a feature branch it sits behind HEAD before any work exists, which would
 * fire the already-committed shortcut against a pre-existing branch commit.
 *
 * The fallback chain covers session state written by an older CLI, which
 * carries no itemBaseHead. diagnoseStrandedCommit() (stages/finalize.ts) makes the refusal
 * actionable when that older state is itself already poisoned.
 */
export function itemBaseline(state: FullSessionState): string | undefined {
  return state.git.itemBaseHead ?? state.git.expectedHead ?? state.git.initHead;
}

export type LandedTree = "hasItem" | "lacksItem" | "unavailable" | "noItem";
export type LandedAncestry = "descendant" | "divergent" | "unknown";

export interface LandedCommitEvidence {
  /** finalizeCheckpoint === "committed": the commit was already acknowledged. */
  readonly checkpoint: boolean;
  readonly baseline: string | null;
  /** HEAD hash, or null when HEAD could not be read. */
  readonly head: string | null;
  /** HEAD differs from the baseline (false when either is unknown). */
  readonly headMoved: boolean;
  /** Only read when HEAD moved. */
  readonly tree: LandedTree | null;
  /** Only read when HEAD moved and asked for. */
  readonly ancestry: LandedAncestry | null;
}

/** The ledger files a commit for this item may carry. */
export function itemLedgerPaths(state: FullSessionState): string[] {
  const paths: string[] = [];
  if (state.ticket?.id) paths.push(`.story/tickets/${state.ticket.id}.json`);
  if (state.currentIssue?.id) paths.push(`.story/issues/${state.currentIssue.id}.json`);
  return paths;
}

export async function inspectLandedCommit(
  root: string,
  state: FullSessionState,
  baseline: string | null,
  opts: { readonly ancestry: boolean },
): Promise<LandedCommitEvidence> {
  const checkpoint = state.finalizeCheckpoint === "committed";
  const empty = { checkpoint, baseline, head: null, headMoved: false, tree: null, ancestry: null } as const;
  if (checkpoint || !baseline) return empty;
  const headResult = await gitHead(root);
  if (!headResult.ok) return empty;
  const head = headResult.data.hash;
  if (head === baseline) return { ...empty, head };
  const treeResult = await gitDiffTreeNames(root, head);
  const paths = itemLedgerPaths(state);
  const tree: LandedTree = !treeResult.ok
    ? (paths.length === 0 ? "noItem" : "unavailable")
    : paths.length === 0
      ? "noItem"
      : paths.some((p) => treeResult.data.includes(p)) ? "hasItem" : "lacksItem";
  let ancestry: LandedAncestry | null = null;
  if (opts.ancestry) {
    const anc = await gitIsAncestor(root, baseline, head);
    ancestry = !anc.ok ? "unknown" : anc.data ? "descendant" : "divergent";
  }
  return { checkpoint, baseline, head, headMoved: true, tree, ancestry };
}

/**
 * FinalizeStage.enter()'s rule: a committed checkpoint routes on; a moved HEAD
 * whose commit carries the item's ledger file, or a session with no item at
 * all, takes the commit fast path; everything else stages.
 */
export function finalizeEnterRoute(e: LandedCommitEvidence): "committed" | "fast-path" | "staging" {
  if (e.checkpoint) return "committed";
  if (!e.headMoved) return "staging";
  return e.tree === "hasItem" || e.tree === "noItem" ? "fast-path" : "staging";
}

export type LandedCommitClass =
  | "committed"
  | "nothing-landed"
  | "verified"
  | "unrelated"
  | "unattributed"
  | "unavailable";

/**
 * The retirement's rule. `verified` needs all three: HEAD moved, it descends
 * from the baseline, and its commit carries the item's ledger file. A failed
 * read of any of them is `unavailable`, never a guess.
 */
export function classifyLandedCommit(e: LandedCommitEvidence): LandedCommitClass {
  if (e.checkpoint) return "committed";
  if (e.baseline === null || e.head === null) return "unavailable";
  if (!e.headMoved) return "nothing-landed";
  if (e.tree === "noItem") return "unattributed";
  if (e.tree === "unavailable" || e.ancestry === "unknown" || e.ancestry === null) return "unavailable";
  if (e.ancestry === "divergent" || e.tree === "lacksItem") return "unrelated";
  return "verified";
}
