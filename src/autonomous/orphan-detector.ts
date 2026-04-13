/**
 * T-251: Extracted from guide.ts. The predicate that classifies whether a
 * session describes a targeted auto session whose work is verifiably finished
 * on disk AND whose recorded commits are reachable from the current HEAD.
 *
 * Fails closed on any uncertainty — used by both guide.ts (auto-supersede) and
 * cli/commands/session.ts (manual repair).
 */
import { readEvents } from "./session.js";
import type { FullSessionState } from "./session-types.js";
import { loadProject } from "../core/project-loader.js";
import { gitIsAncestor, gitHeadHash } from "./git-inspector.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX } from "../models/types.js";

const ORPHAN_LEASE_BUFFER_MS = 60 * 60 * 1000; // 60-minute debris buffer

type LoadedProjectState = Awaited<ReturnType<typeof loadProject>>["state"];

/**
 * ISS-383: pre-loaded project state + git HEAD hash that callers can hoist out
 * of a per-session loop to avoid re-running loadProject + git rev-parse on
 * every iteration. Optional — when omitted, isFinishedOrphan loads on demand
 * for backward compatibility with single-call sites.
 */
export interface OrphanCheckContext {
  projectState: LoadedProjectState;
  headSha: string;
}

/**
 * Cheap, IO-free precheck. Returns true when this session's metadata SHAPE
 * (mode, targetWork, lease) is consistent with a finished-orphan candidate.
 * Use this to filter a stale-session list before paying the loadProject +
 * git rev-parse cost once for the whole batch.
 */
export function isOrphanCandidate(state: FullSessionState): boolean {
  if (state.mode !== "auto") return false;
  if (!state.targetWork || state.targetWork.length === 0) return false;
  const expiresAtRaw = state.lease?.expiresAt;
  const expiresAtMs = expiresAtRaw ? new Date(expiresAtRaw).getTime() : NaN;
  if (!Number.isFinite(expiresAtMs)) return false;
  if (Date.now() - expiresAtMs < ORPHAN_LEASE_BUFFER_MS) return false;
  return true;
}

/**
 * Build a map of issueId → recorded commit hashes from a session's event log,
 * validating every commit-event payload along the way. Returns null when any
 * event is malformed or has the wrong shape — fails closed so the caller
 * treats the session as not-finished rather than silently dropping commits.
 */
function buildIssueCommitMap(dir: string): Map<string, string[]> | null {
  const { events, malformedCount } = readEvents(dir);
  if (malformedCount > 0) return null;
  const issueCommits = new Map<string, string[]>();
  for (const ev of events) {
    if (ev.type !== "commit") continue;
    if (!ev.data || typeof ev.data !== "object") return null;
    const data = ev.data as { commitHash?: unknown; issueId?: unknown; ticketId?: unknown };
    const hasIssue = "issueId" in data && data.issueId !== undefined;
    const hasTicket = "ticketId" in data && data.ticketId !== undefined;
    if (hasIssue) {
      if (typeof data.commitHash !== "string" || typeof data.issueId !== "string") return null;
      const list = issueCommits.get(data.issueId) ?? [];
      list.push(data.commitHash);
      issueCommits.set(data.issueId, list);
    } else if (hasTicket) {
      if (typeof data.commitHash !== "string" || typeof data.ticketId !== "string") return null;
    }
  }
  return issueCommits;
}

/**
 * Verify a single target work item (issue or ticket) is finished AND every
 * recorded commit for it is reachable from headSha. Returns false on any
 * uncertainty: unknown ID format, missing record, wrong status, or
 * unreachable commit.
 */
async function isTargetFinished(
  id: string,
  state: FullSessionState,
  projectState: LoadedProjectState,
  issueCommits: Map<string, string[]>,
  root: string,
  headSha: string,
): Promise<boolean> {
  if (ISSUE_ID_REGEX.test(id)) {
    const issue = projectState.issues.find((i) => i.id === id);
    if (!issue || issue.status !== "resolved") return false;
    const hashes = issueCommits.get(id) ?? [];
    if (hashes.length === 0) return false;
    for (const hash of hashes) {
      const anc = await gitIsAncestor(root, hash, headSha);
      if (!anc.ok || !anc.data) return false;
    }
    return true;
  }
  if (TICKET_ID_REGEX.test(id)) {
    const ticket = projectState.ticketByID(id);
    if (!ticket || ticket.status !== "complete") return false;
    const entry = state.completedTickets.find((t) => t.id === id);
    if (!entry || !entry.commitHash) return false;
    const anc = await gitIsAncestor(root, entry.commitHash, headSha);
    return anc.ok && anc.data;
  }
  return false;
}

export async function isFinishedOrphan(
  state: FullSessionState,
  dir: string,
  root: string,
  ctx?: OrphanCheckContext,
): Promise<boolean> {
  if (!isOrphanCandidate(state)) return false;

  let projectState: LoadedProjectState;
  if (ctx) {
    projectState = ctx.projectState;
  } else {
    try {
      ({ state: projectState } = await loadProject(root));
    } catch {
      return false;
    }
  }

  let headSha: string;
  if (ctx) {
    headSha = ctx.headSha;
  } else {
    const headResult = await gitHeadHash(root);
    if (!headResult.ok) return false;
    headSha = headResult.data;
  }

  const issueCommits = buildIssueCommitMap(dir);
  if (!issueCommits) return false;

  for (const id of state.targetWork) {
    if (!(await isTargetFinished(id, state, projectState, issueCommits, root, headSha))) {
      return false;
    }
  }
  return true;
}
