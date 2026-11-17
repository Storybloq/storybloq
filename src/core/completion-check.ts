/**
 * C-v4.1 commit 6, ISS-1433 (4) with pen ruling Q2: the opt-in completion
 * check. With `gitState.requireCommitOnComplete: true`, completing a ticket
 * refuses while no commit names it (gitState `none`) and while git cannot say
 * (`unknown`: absence is not proven, so it fails closed with the reason). It
 * never refuses at built, landed or released. Items on `proof.nonCodeItems`
 * are exempt. The escape is `--no-git-check` (MCP `noGitCheck`). Tickets only:
 * issue resolve is unchanged.
 */
import { canonicalRef, readBoardId } from "./board-id.js";
import { readGitFacts } from "./git-facts/facts.js";
import type { ProjectState } from "./project-state.js";
import { nonCodeRefs } from "./proof.js";

const KEY = "gitState.requireCommitOnComplete";

/** Only a literal `true` turns the check on. */
export function completionCheckEnabled(config: unknown): boolean {
  return (config as { gitState?: { requireCommitOnComplete?: unknown } } | undefined)?.gitState?.requireCommitOnComplete === true;
}

/** The refusal text, or null when completing may go ahead. */
export async function completionCheckRefusal(root: string, state: ProjectState, ticketId: string, displayId: string): Promise<string | null> {
  const config = (state as unknown as { config?: unknown }).config;
  if (!completionCheckEnabled(config)) return null;
  const board = readBoardId(root);
  if (board !== undefined && nonCodeRefs(config).has(canonicalRef(board, ticketId))) return null;
  const view = await readGitFacts(root, state);
  const s = view.stateOf(ticketId);
  const escape = `Pass --no-git-check (MCP noGitCheck) to complete it anyway, or turn off ${KEY}.`;
  if (s.state === "none") return `git_check: no commit names ${displayId}, and ${KEY} is on. ${escape}`;
  if (s.state === "unknown") return `git_check: git cannot say whether a commit names ${displayId} (${s.reason}${s.detail !== undefined ? `: ${s.detail}` : ""}), and ${KEY} is on. ${escape}`;
  return null;
}
