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

export async function isFinishedOrphan(
  state: FullSessionState,
  dir: string,
  root: string,
): Promise<boolean> {
  if (state.mode !== "auto") return false;
  if (!state.targetWork || state.targetWork.length === 0) return false;

  const expiresAtRaw = state.lease?.expiresAt;
  const expiresAtMs = expiresAtRaw ? new Date(expiresAtRaw).getTime() : NaN;
  if (!Number.isFinite(expiresAtMs)) return false;
  if (Date.now() - expiresAtMs < ORPHAN_LEASE_BUFFER_MS) return false;

  let projectState: Awaited<ReturnType<typeof loadProject>>["state"];
  try {
    ({ state: projectState } = await loadProject(root));
  } catch {
    return false;
  }

  const headResult = await gitHeadHash(root);
  if (!headResult.ok) return false;
  const headSha = headResult.data;

  const issueCommits = new Map<string, string[]>();
  const { events, malformedCount } = readEvents(dir);
  if (malformedCount > 0) return false;
  for (const ev of events) {
    if (ev.type !== "commit") continue;
    if (!ev.data || typeof ev.data !== "object") return false;
    const data = ev.data as { commitHash?: unknown; issueId?: unknown; ticketId?: unknown };
    const hasIssue = "issueId" in data && data.issueId !== undefined;
    const hasTicket = "ticketId" in data && data.ticketId !== undefined;
    if (hasIssue) {
      if (typeof data.commitHash !== "string" || typeof data.issueId !== "string") return false;
      const list = issueCommits.get(data.issueId) ?? [];
      list.push(data.commitHash);
      issueCommits.set(data.issueId, list);
    } else if (hasTicket) {
      if (typeof data.commitHash !== "string" || typeof data.ticketId !== "string") return false;
    }
  }

  for (const id of state.targetWork) {
    if (ISSUE_ID_REGEX.test(id)) {
      const issue = projectState.issues.find((i) => i.id === id);
      if (!issue || issue.status !== "resolved") return false;
      const hashes = issueCommits.get(id) ?? [];
      if (hashes.length === 0) return false;
      for (const hash of hashes) {
        const anc = await gitIsAncestor(root, hash, headSha);
        if (!anc.ok || !anc.data) return false;
      }
    } else if (TICKET_ID_REGEX.test(id)) {
      const ticket = projectState.ticketByID(id);
      if (!ticket || ticket.status !== "complete") return false;
      const entry = state.completedTickets.find((t) => t.id === id);
      if (!entry || !entry.commitHash) return false;
      const anc = await gitIsAncestor(root, entry.commitHash, headSha);
      if (!anc.ok || !anc.data) return false;
    } else {
      return false;
    }
  }

  return true;
}
