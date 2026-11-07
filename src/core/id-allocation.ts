import type { Ticket } from "../models/ticket.js";
import type { Issue } from "../models/issue.js";
import type { Note } from "../models/note.js";
import type { Lesson } from "../models/lesson.js";
import type { ProjectState } from "./project-state.js";
import { TICKET_ID_REGEX, ISSUE_ID_REGEX, NOTE_ID_REGEX, LESSON_ID_REGEX } from "../models/types.js";
import { generateCanonicalId, type CanonicalPrefix } from "./canonical-id.js";
import { ProjectLoaderError } from "./errors.js";

// ISS-709: single source for the anchored numeric display-ID regexes, shared by
// the reconcile core + CLI. (remote-refs.ts intentionally uses looser,
// prefix-only variants and is not consolidated here.)
export const TICKET_NUMERIC_REGEX = /^T-(\d+)[a-z]?$/;
export const ISSUE_NUMERIC_REGEX = /^ISS-(\d+)$/;
export const NOTE_NUMERIC_REGEX = /^N-(\d+)$/;
export const LESSON_NUMERIC_REGEX = /^L-(\d+)$/;

/**
 * ISS-1452: reads an id's number. A number at or past MAX_SAFE_INTEGER has no
 * safe next number, and past it the parse rounds through a double, so the next
 * id would bear no relation to its predecessor. Refuses instead of minting one.
 */
export function readIdNumber(digits: string, holder: string): number {
  const number = parseInt(digits, 10);
  if (number >= Number.MAX_SAFE_INTEGER) {
    throw new ProjectLoaderError("conflict", `Cannot allocate an id: ${holder} holds an id whose number is too large`);
  }
  return number;
}

/** ISS-1452: for a number reached by adding to a read one. The limit itself is a usable id. */
export function assertAllocatableIdNumber(number: number): void {
  if (!Number.isSafeInteger(number)) {
    throw new ProjectLoaderError("conflict", "Cannot allocate an id: the highest existing number is too large");
  }
}

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
      const num = readIdNumber(match[1], t.id);
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
      const num = readIdNumber(match[1], i.id);
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
      const num = readIdNumber(match[1], n.id);
      if (num > max) max = num;
    }
  }
  return `N-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Next lesson ID: scan existing IDs, find max numeric part, return L-(max+1).
 * Zero-padded to 3 digits minimum.
 */
export function nextLessonID(lessons: readonly Lesson[]): string {
  let max = 0;
  for (const l of lessons) {
    if (!LESSON_ID_REGEX.test(l.id)) continue;
    const match = l.id.match(LESSON_NUMERIC_REGEX);
    if (match?.[1]) {
      const num = readIdNumber(match[1], l.id);
      if (num > max) max = num;
    }
  }
  return `L-${String(max + 1).padStart(3, "0")}`;
}

// --- Team-mode allocators ---

interface Resolvable {
  id: string;
  displayId?: string | null;
  previousDisplayIds?: string[] | null;
}

const MAX_COLLISION_RETRIES = 10;

export function maxSequentialNumber(
  items: readonly Resolvable[],
  numericRegex: RegExp,
): number {
  let max = 0;
  const extract = (s: string) => {
    const m = s.match(numericRegex);
    if (m?.[1]) {
      const n = readIdNumber(m[1], s);
      if (n > max) max = n;
    }
  };
  for (const item of items) {
    extract(item.id);
    if (item.displayId) extract(item.displayId);
    if (item.previousDisplayIds) {
      for (const prev of item.previousDisplayIds) extract(prev);
    }
  }
  return max;
}

function allocateTeamId(
  prefix: CanonicalPrefix,
  displayPrefix: string,
  items: readonly Resolvable[],
  numericRegex: RegExp,
  genFn?: () => string,
): { id: string; displayId: string } {
  const gen = genFn ?? (() => generateCanonicalId(prefix));
  const existingIds = new Set(items.map((i) => i.id));
  let id: string | undefined;
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const candidate = gen();
    if (!existingIds.has(candidate)) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    throw new Error(`allocation_failed: could not generate unique ${prefix}- ID after ${MAX_COLLISION_RETRIES} attempts`);
  }
  const max = maxSequentialNumber(items, numericRegex);
  const displayId = `${displayPrefix}${String(max + 1).padStart(3, "0")}`;
  return { id, displayId };
}

export function allocateTeamTicketId(
  items: readonly Ticket[],
  genFn?: () => string,
): { id: string; displayId: string } {
  return allocateTeamId("t", "T-", items, TICKET_NUMERIC_REGEX, genFn);
}

export function allocateTeamIssueId(
  items: readonly Issue[],
  genFn?: () => string,
): { id: string; displayId: string } {
  return allocateTeamId("i", "ISS-", items, ISSUE_NUMERIC_REGEX, genFn);
}

export function allocateTeamNoteId(
  items: readonly Note[],
  genFn?: () => string,
): { id: string; displayId: string } {
  return allocateTeamId("n", "N-", items, NOTE_NUMERIC_REGEX, genFn);
}

export function allocateTeamLessonId(
  items: readonly Lesson[],
  genFn?: () => string,
): { id: string; displayId: string } {
  return allocateTeamId("l", "L-", items, LESSON_NUMERIC_REGEX, genFn);
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
