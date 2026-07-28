import {
  withProjectLock,
  writeNoteUnlocked,
  deleteNote,
} from "../../core/project-loader.js";
import { nextNoteID, allocateTeamNoteId } from "../../core/id-allocation.js";
import { reserveDisplayId } from "../../core/remote-refs.js";
import { resolveAndNormalizeNoteRef, RefResolutionError } from "../../core/ref-normalization.js";
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
  assertUpdateHasFields,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

export const NOTE_CORE_METADATA_KEYS = new Set([
  "id",
  "title",
  "content",
  "tags",
  "status",
  "createdDate",
  "updatedDate",
  "displayId",
  "previousDisplayIds",
  "rank",
  "lifecycle",
  "_conflicts",
  "createdAt",
  "deletedAt",
  "deletedBy",
]);

// Re-export for register.ts
export { NOTE_STATUSES };

// --- Read Handlers ---

export function handleNoteList(
  filters: { status?: string; tag?: string },
  ctx: CommandContext,
): CommandResult {
  let notes = [...ctx.state.activeNotes];

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
  let resolvedId: string;
  try {
    resolvedId = resolveAndNormalizeNoteRef(ctx.state, id);
  } catch (err) {
    // ISS-805: an ambiguous ref is caller input, not a missing item; classify
    // it invalid_input so consumers can distinguish it from a genuine not_found.
    if (err instanceof RefResolutionError && err.reason === "ambiguous") {
      return {
        output: formatError("invalid_input", err.message, ctx.format),
        exitCode: ExitCode.USER_ERROR,
        errorCode: "invalid_input",
      };
    }
    return {
      output: formatError("not_found", `Note ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  const note = ctx.state.noteByID(resolvedId);
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
    const isTeam = state.config.team?.enabled === true;
    let id: string;
    let displayId: string | undefined;
    if (isTeam) {
      const alloc = allocateTeamNoteId(state.notes);
      id = alloc.id;
      displayId = state.config.team?.idAllocator === "git-refs"
        ? (await reserveDisplayId(root, "note", state, id)).displayId
        : alloc.displayId;
    } else {
      id = nextNoteID(state.notes);
      displayId = undefined;
    }
    const createdAt = new Date().toISOString();
    const today = createdAt.slice(0, 10);
    const tags = args.tags ? normalizeTags(args.tags) : [];
    const note: Note = {
      id,
      ...(displayId != null && { displayId }),
      title: args.title && args.title.trim() !== "" ? args.title : null,
      content: args.content,
      tags,
      status: "active",
      createdDate: today,
      ...(isTeam && { createdAt }),
      updatedDate: today,
    };

    await writeNoteUnlocked(note, root, { createOnly: true });
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
  assertUpdateHasFields(updates, "note", "content, title, tags, clearTags, status");
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
    const resolvedId = resolveAndNormalizeNoteRef(state, id);
    const existing = state.noteByID(resolvedId);
    if (!existing) {
      throw new CliValidationError("not_found", `Note ${id} not found`);
    }

    // Tags: --clear-tags → []. --tags with values → replace. neither → unchanged.
    const tagsUpdate: Partial<Note> = {};
    if (updates.clearTags) {
      tagsUpdate.tags = [];
    } else if (updates.tags !== undefined) {
      tagsUpdate.tags = normalizeTags(updates.tags);
    }

    const note: Note = {
      ...existing,
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.title !== undefined && {
        title: !updates.title?.trim() ? null : updates.title,
      }),
      ...tagsUpdate,
      ...(updates.status !== undefined && { status: updates.status as NoteStatus }),
      updatedDate: todayISO(),
    };

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
  hard?: boolean,
  displayLabel?: string,
): Promise<CommandResult> {
  const result = await deleteNote(id, root, { hard });
  return { output: formatNoteDeleteResult(format === "json" ? id : displayLabel ?? id, format, result.alreadyDeleted) };
}
