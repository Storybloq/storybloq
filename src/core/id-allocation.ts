import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { ProjectState } from "./project-state.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX, NOTE_ID_REGEX } from "../models/types.js";

const TICKET_NUMERIC_REGEX = /^T-(\d+)[a-z]?$/;
const ISSUE_NUMERIC_REGEX = /^ISS-(\d+)$/;
const NOTE_NUMERIC_REGEX = /^N-(\d+)$/;

/**
 * Next ticket ID: scan existing IDs, find max numeric part, return T-(max+1).
 * Zero-padded to 3 digits minimum. Handles suffixed IDs (T-077a → numeric 77).
 * Malformed IDs (not matching TICKET_ID_REGEX) are silently skipped.
 */
export function nextTicketID(tickets: readonly Ticket[]): string {
  let max = 0;
  for (const t of tickets) {
    if (!TICKET_ID_REGEX.test(t.id)) continue;
    const match = t.id.match(TICKET_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `T-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next issue ID: scan existing IDs, find max numeric part, return ISS-(max+1).
 * Zero-padded to 3 digits minimum.
 */
export function nextIssueID(issues: readonly Issue[]): string {
  let max = 0;
  for (const i of issues) {
    if (!ISSUE_ID_REGEX.test(i.id)) continue;
    const match = i.id.match(ISSUE_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `ISS-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next note ID: scan existing IDs, find max numeric part, return N-(max+1).
 * Zero-padded to 3 digits minimum.
 */
export function nextNoteID(notes: readonly Note[]): string {
  let max = 0;
  for (const n of notes) {
    if (!NOTE_ID_REGEX.test(n.id)) continue;
    const match = n.id.match(NOTE_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `N-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next order value for a phase: max leaf ticket order + 10, or 10 if empty.
 */
export function nextOrder(
  phaseId: string | null,
  state: ProjectState,
): number {
  const tickets = state.phaseTickets(phaseId);
  if (tickets.length === 0) return 10;
  return tickets[tickets.length - 1]!.order + 10;
}
