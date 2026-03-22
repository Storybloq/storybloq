import {
  withProjectLock,
  writeNoteUnlocked,
  deleteNote,
} from "../../core/project-loader.js";
import { nextNoteID } from "../../core/id-allocation.js";
import {
  formatNoteList,
  formatNote,
  formatNoteCreateResult,
  formatNoteUpdateResult,
  formatNoteDeleteResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  NOTE_STATUSES,
  type NoteStatus,
  type OutputFormat,
} from "../../models/types.js";
import type { Note } from "../../models/note.js";
import {
  todayISO,
  normalizeTags,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

// Re-export for register.ts
export { NOTE_STATUSES };

// --- Read Handlers ---

export function handleNoteList(
  filters: { status?: string; tag?: string },
  ctx: CommandContext,
): CommandResult {
  let notes = [...ctx.state.notes];

  if (filters.status) {
    if (!NOTE_STATUSES.includes(filters.status as NoteStatus)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown note status "${filters.status}": must be one of ${NOTE_STATUSES.join(", ")}`,
      );
    }
    notes = notes.filter((n) => n.status === filters.status);
  }
  if (filters.tag) {
    const normalized = normalizeTags([filters.tag]);
    if (normalized.length === 0) {
      // Tag normalized to empty (e.g. "!!!") — no notes can match
      notes = [];
    } else {
      const tag = normalized[0]!;
      notes = notes.filter((n) => n.tags.includes(tag));
    }
  }

  // Sort by updatedDate desc, then id asc within same day
  notes.sort((a, b) => {
    const dateCmp = b.updatedDate.localeCompare(a.updatedDate);
    if (dateCmp !== 0) return dateCmp;
    return a.id.localeCompare(b.id);
  });

  return { output: formatNoteList(notes, ctx.format) };
}

export function handleNoteGet(
  id: string,
  ctx: CommandContext,
): CommandResult {
  const note = ctx.state.noteByID(id);
  if (!note) {
    return {
      output: formatError("not_found", `Note ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatNote(note, ctx.format) };
}

// --- Write Handlers ---

export async function handleNoteCreate(
  args: {
    content: string;
    title?: string | null;
    tags?: string[];
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (!args.content.trim()) {
    throw new CliValidationError("invalid_input", "Note content cannot be empty");
  }

  let createdNote: Note | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const id = nextNoteID(state.notes);
    const today = todayISO();
    const tags = args.tags ? normalizeTags(args.tags) : [];
    const note: Note = {
      id,
      title: args.title && args.title.trim() !== "" ? args.title : null,
      content: args.content,
      tags,
      status: "active",
      createdDate: today,
      updatedDate: today,
    };

    await writeNoteUnlocked(note, root);
    createdNote = note;
  });

  if (!createdNote) throw new Error("Note not created");
  return { output: formatNoteCreateResult(createdNote, format) };
}

export async function handleNoteUpdate(
  id: string,
  updates: {
    content?: string;
    title?: string | null;
    tags?: string[];
    clearTags?: boolean;
    status?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (updates.content !== undefined && !updates.content.trim()) {
    throw new CliValidationError("invalid_input", "Note content cannot be empty");
  }
  if (updates.status && !NOTE_STATUSES.includes(updates.status as NoteStatus)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown note status "${updates.status}": must be one of ${NOTE_STATUSES.join(", ")}`,
    );
  }

  let updatedNote: Note | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const existing = state.noteByID(id);
    if (!existing) {
      throw new CliValidationError("not_found", `Note ${id} not found`);
    }

    const note: Note = { ...existing };

    // Content
    if (updates.content !== undefined) {
      (note as Record<string, unknown>).content = updates.content;
    }

    // Title: explicitly "" → null, undefined → unchanged
    if (updates.title !== undefined) {
      const trimmed = updates.title?.trim();
      (note as Record<string, unknown>).title = !trimmed ? null : updates.title;
    }

    // Tags: --clear-tags → []. --tags with values → replace. neither → unchanged.
    if (updates.clearTags) {
      (note as Record<string, unknown>).tags = [];
    } else if (updates.tags !== undefined) {
      (note as Record<string, unknown>).tags = normalizeTags(updates.tags);
    }

    // Status
    if (updates.status !== undefined) {
      (note as Record<string, unknown>).status = updates.status;
    }

    // Always bump updatedDate
    (note as Record<string, unknown>).updatedDate = todayISO();

    await writeNoteUnlocked(note, root);
    updatedNote = note;
  });

  if (!updatedNote) throw new Error("Note not updated");
  return { output: formatNoteUpdateResult(updatedNote, format) };
}

export async function handleNoteDelete(
  id: string,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  await deleteNote(id, root);
  return { output: formatNoteDeleteResult(id, format) };
}
