import { z } from "zod";

// --- ID format regexes ---

/** Matches T-001, T-077a, T-079b */
export const TICKET_ID_REGEX = /^T-\d+[a-z]?$/;

/** Matches ISS-001, ISS-009 */
export const ISSUE_ID_REGEX = /^ISS-\d+$/;

// --- Ticket enums ---

export const TICKET_STATUSES = ["open", "inprogress", "complete"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_TYPES = ["task", "feature", "chore"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

// --- Issue enums ---

export const ISSUE_STATUSES = ["open", "inprogress", "resolved"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

// --- Note enums ---

export const NOTE_STATUSES = ["active", "archived"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const NOTE_ID_REGEX = /^N-\d+$/;
export const NoteIdSchema = z
  .string()
  .regex(NOTE_ID_REGEX, "Note ID must match N-NNN");

// --- Lesson enums ---

export const LESSON_STATUSES = ["active", "deprecated", "superseded"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
export const LESSON_SOURCES = ["review", "correction", "postmortem", "manual"] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];
export const LESSON_ID_REGEX = /^L-\d+$/;
export const LessonIdSchema = z
  .string()
  .regex(LESSON_ID_REGEX, "Lesson ID must match L-NNN");

// --- Output/error types ---

export const OUTPUT_FORMATS = ["json", "md"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const ERROR_CODES = [
  "not_found",
  "validation_failed",
  "io_error",
  "project_corrupt",
  "invalid_input",
  "conflict",
  "version_mismatch",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// --- Date validation ---

export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Regex check + calendar validity. The `startsWith` check catches Date constructor
// rollover (e.g. "2026-02-29" rolls to "2026-03-01", so toISOString won't match).
export const DateSchema = z
  .string()
  .regex(DATE_REGEX, "Date must be YYYY-MM-DD")
  .refine(
    (val) => {
      const d = new Date(val + "T00:00:00Z");
      return !isNaN(d.getTime()) && d.toISOString().startsWith(val);
    },
    { message: "Invalid calendar date" },
  );

// --- Reusable ID schemas ---

export const TicketIdSchema = z
  .string()
  .regex(TICKET_ID_REGEX, "Ticket ID must match T-NNN or T-NNNx");

export const IssueIdSchema = z
  .string()
  .regex(ISSUE_ID_REGEX, "Issue ID must match ISS-NNN");
