/**
 * T-188: Targeted auto mode helpers.
 *
 * Shared by guide.ts, pick-ticket.ts, and complete.ts.
 * Derives remaining targets from session state and builds
 * candidate display text for targeted sessions.
 */

import type { FullSessionState } from "./session-types.js";
import type { ProjectState } from "../core/project-state.js";

// ---------------------------------------------------------------------------
// Mode check
// ---------------------------------------------------------------------------

export function isTargetedMode(state: Pick<FullSessionState, "targetWork">): boolean {
  return (state.targetWork?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Remaining targets
// ---------------------------------------------------------------------------

/**
 * Returns target IDs not yet completed or resolved, preserving targetWork order.
 *
 * Type asymmetry: completedTickets is {id, title, ...}[] but resolvedIssues is string[].
 */
export function getRemainingTargets(state: FullSessionState): string[] {
  if ((state.targetWork?.length ?? 0) === 0) return [];
  const doneTickets = new Set((state.completedTickets ?? []).map(t => t.id));
  const doneIssues = new Set(state.resolvedIssues ?? []);
  return (state.targetWork ?? []).filter(id => !doneTickets.has(id) && !doneIssues.has(id));
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

const ISSUE_STATUS_LABELS: Record<string, string> = {
  open: "ready",
  inprogress: "ready (resume)",
  resolved: "already resolved",
};

function issueStatusLabel(status: string): string {
  return ISSUE_STATUS_LABELS[status] ?? status;
}

// ---------------------------------------------------------------------------
// Candidate display
// ---------------------------------------------------------------------------

/**
 * Builds numbered candidate text showing type, severity (for issues), and blocked status.
 *
 * Example output:
 *   1. **T-183: Compaction resume marker** (task) -- ready
 *   2. **T-184: HEAD drift tolerance** (task) -- blocked by T-183
 *   3. **ISS-077: Sentry dSYMs** (issue, high) -- ready
 */
export function buildTargetedCandidatesText(
  remaining: string[],
  projectState: ProjectState,
): { text: string; firstReady: { id: string; kind: "ticket" | "issue" } | null } {
  const lines: string[] = [];
  let firstReady: { id: string; kind: "ticket" | "issue" } | null = null;

  for (let i = 0; i < remaining.length; i++) {
    const id = remaining[i]!;

    if (id.startsWith("ISS-")) {
      const issue = projectState.issues.find(iss => iss.id === id);
      if (!issue) {
        lines.push(`${i + 1}. **${id}** -- not found`);
        continue;
      }
      lines.push(`${i + 1}. **${issue.id}: ${issue.title}** (issue, ${issue.severity}) -- ${issueStatusLabel(issue.status)}`);
      if (!firstReady && (issue.status === "open" || issue.status === "inprogress")) {
        firstReady = { id: issue.id, kind: "issue" };
      }
    } else {
      const ticket = projectState.ticketByID(id);
      if (!ticket) {
        lines.push(`${i + 1}. **${id}** -- not found`);
        continue;
      }
      const blocked = projectState.isBlocked(ticket);
      const complete = ticket.status === "complete";
      const status = complete ? "already complete" : blocked ? `blocked by ${ticket.blockedBy.join(", ")}` : "ready";
      lines.push(`${i + 1}. **${ticket.id}: ${ticket.title}** (${ticket.type}) -- ${status}`);
      if (!firstReady && !blocked && !complete && (ticket.status === "open" || ticket.status === "inprogress")) {
        firstReady = { id: ticket.id, kind: "ticket" };
      }
    }
  }

  return { text: lines.join("\n"), firstReady };
}

/**
 * Builds the full PICK_TICKET instruction block for targeted mode.
 * Accepts optional pre-computed candidates to avoid double iteration.
 */
export function buildTargetedPickInstruction(
  remaining: string[],
  projectState: ProjectState,
  sessionId: string,
  precomputed?: { text: string; firstReady: { id: string; kind: "ticket" | "issue" } | null },
): string {
  const { text, firstReady } = precomputed ?? buildTargetedCandidatesText(remaining, projectState);

  const pickExample = firstReady
    ? firstReady.kind === "ticket"
      ? `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "${firstReady.id}" } }`
      : `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "issue_picked", "issueId": "${firstReady.id}" } }`
    : `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "ticket_picked", "ticketId": "T-XXX" } }`;

  const pickPrompt = firstReady
    ? `Pick **${firstReady.id}** (next target) by calling \`claudestory_autonomous_guide\` now:`
    : "Pick a target by calling `claudestory_autonomous_guide` now:";

  return [
    "## Targeted Work Items",
    "",
    text,
    "",
    pickPrompt,
    "```json",
    pickExample,
    "```",
  ].join("\n");
}

/**
 * Builds a HANDOVER result instruction for stuck targeted sessions.
 * Includes both the stuck explanation AND handover-writing instructions
 * so the agent produces a handover documenting why the session ended.
 */
export function buildTargetedStuckHandover(
  candidatesText: string,
  sessionId: string,
): string {
  return [
    "# Targeted Session Ending -- No Workable Targets Remain",
    "",
    "Cannot continue -- none of the remaining target items can be picked:",
    "",
    candidatesText,
    "",
    "Write a session handover documenting what was accomplished and why the remaining targets could not be worked.",
    "",
    'Call `claudestory_autonomous_guide` with:',
    "```json",
    `{ "sessionId": "${sessionId}", "action": "report", "report": { "completedAction": "handover_written", "handoverContent": "..." } }`,
    "```",
  ].join("\n");
}
