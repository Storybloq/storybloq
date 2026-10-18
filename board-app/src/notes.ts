import { createHash } from "node:crypto";
import { z } from "zod";
import type { Note } from "../../src/models/note.js";
import type { ProjectState } from "../../src/core/project-state.js";
import { isActiveLifecycle } from "../../src/core/project-state.js";
import { displayIdOf } from "../../src/core/resolver.js";
import { CliValidationError } from "../../src/core/cli-validation-error.js";
import { handleNoteUpdate } from "./canonical-writes.mjs";
import { BoardError, readLedger, readLedgerSnapshot } from "./ledger-reader.js";
import {
  EditError,
  createRootCheck,
  recordRevision,
  validateEditSize,
} from "./edit-policy.js";
import type { RootAccess } from "./federation.js";
import type { EditableValue } from "./editor-types.js";
import type {
  NoteCard,
  NoteEditor,
  NotePreview,
  NotesPage,
} from "./notes-types.js";
import { clip } from "./text.js";

export const notePatch = z
  .object({
    title: z.string().max(2000).nullable().optional(),
    content: z.string().max(48000).optional(),
    tags: z.array(z.string().max(64)).max(200).optional(),
    status: z.enum(["active", "archived"]).optional(),
    // Explicit consent for main's destructive-replace guard, bound to the
    // digest of the exact content the refusal reported. Never set implicitly.
    confirmReplace: z.boolean().optional(),
    confirmDraftDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine(
    ({ confirmReplace, confirmDraftDigest, ...fields }) =>
      Object.keys(fields).length > 0,
  );
/** Board spelling of the canonical guard's escape hatches. */
const BOARD_NOTE_HATCHES = {
  confirm: "confirmReplace: true with the returned confirmDraftDigest",
  append: "a smaller edit that keeps the existing text",
};
const draftDigest = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

function find(state: ProjectState, id: string): Note {
  const resolved = state.resolveNoteRef(id);
  if (resolved.kind !== "found" || !isActiveLifecycle(resolved.item))
    throw new EditError(
      "unavailable",
      "This note is unavailable. Refresh Notes to try again.",
    );
  return resolved.item;
}
function card(note: Note): NoteCard {
  return {
    id: note.id,
    displayId: clip(displayIdOf(note), 79),
    title: note.title === null ? null : clip(note.title, 2000 - 1),
    preview: clip(note.content, 240 - 1),
    tags: note.tags.slice(0, 6).map((tag) => clip(tag, 64 - 1)),
    hiddenTags: Math.max(0, note.tags.length - 6),
    status: note.status,
    updatedDate: note.updatedDate,
  };
}
function editable(note: Note): NoteEditor {
  const fields: Record<string, EditableValue> = {
      title: note.title,
      content: note.content,
      tags: note.tags,
      status: note.status,
    },
    limitedFields: string[] = [];
  for (const key of ["title", "content"]) {
    const value = fields[key],
      limit = key === "title" ? 2000 : 48000;
    if (typeof value === "string" && value.length > limit) {
      fields[key] = clip(value, limit - 1);
      limitedFields.push(key);
    }
  }
  if (note.tags.length > 200 || note.tags.some((tag) => tag.length > 64)) {
    fields.tags = note.tags.slice(0, 200).map((tag) => clip(tag, 64 - 1));
    limitedFields.push("tags");
  }
  return {
    kind: "notes",
    id: note.id,
    displayId: clip(displayIdOf(note), 79),
    revision: recordRevision(note),
    fields,
    limitedFields,
    updatedDate: note.updatedDate,
  };
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function createNotes(root: string, access: Promise<RootAccess>) {
  const checkRoot = createRootCheck(root, access);
  type PreviewSnapshot = {
    note: Note;
    revision: string;
    revalidate: () => Promise<void>;
  };
  let previewSnapshot: PreviewSnapshot | undefined;
  async function read<T>(project: (state: ProjectState) => T) {
    await checkRoot();
    const result = await readLedger(root, project);
    await checkRoot();
    return result;
  }
  async function list(q: {
    status: "all" | "active" | "archived";
    query: string;
    offset: number;
    limit: number;
  }): Promise<NotesPage> {
    return read((state) => {
      const needle = q.query.toLowerCase();
      const notes = state.activeNotes
        .filter(
          (note) =>
            (q.status === "all" || q.status === note.status) &&
            [
              displayIdOf(note),
              note.title ?? "",
              note.content,
              ...note.tags,
            ].some((v) => v.toLowerCase().includes(needle)),
        )
        .sort(
          (a, b) =>
            compare(b.updatedDate, a.updatedDate) ||
            compare(displayIdOf(a), displayIdOf(b)) ||
            compare(a.id, b.id),
        );
      const offset = Math.min(
        q.offset,
        Math.max(0, Math.floor((notes.length - 1) / q.limit) * q.limit),
      );
      return {
        items: notes.slice(offset, offset + q.limit).map(card),
        total: notes.length,
        offset,
        limit: q.limit,
      };
    });
  }
  async function detail(
    id: string,
    offset: number,
    revision?: string,
  ): Promise<NotePreview> {
    await checkRoot();
    // Each request keeps its own entry across awaits, even if another note opens.
    const cached = previewSnapshot;
    if (
      offset > 0 &&
      revision &&
      cached?.note.id === id &&
      cached.revision === revision
    ) {
      try {
        await cached.revalidate();
        const page = projectPreview(
          cached.note,
          cached.revision,
          offset,
          revision,
        );
        await cached.revalidate();
        await checkRoot();
        return page;
      } catch (error) {
        if (previewSnapshot === cached) previewSnapshot = undefined;
        if (error instanceof EditError) throw error;
        // One fresh read repeats all guards; a continuous change fails that read.
      }
    }
    const fresh = await readLedgerSnapshot(root, (state) => {
      const note = find(state, id),
        current = recordRevision(note);
      return {
        note,
        revision: current,
        page: projectPreview(note, current, offset, revision),
      };
    });
    await checkRoot();
    previewSnapshot = {
      note: fresh.value.note,
      revision: fresh.value.revision,
      revalidate: fresh.revalidate,
    };
    return fresh.value.page;
  }
  function projectPreview(
    note: Note,
    current: string,
    offset: number,
    revision?: string,
  ): NotePreview {
    if (offset > 0 && !revision)
      throw new EditError(
        "invalid_input",
        "Later note pages require the original revision. Reload the note.",
      );
    if (revision && revision !== current)
      throw new EditError(
        "conflict",
        "This note changed while reading. Reload to read the current content.",
      );
    if (
      offset > note.content.length ||
      (offset > 0 &&
        /[\uD800-\uDBFF]/.test(note.content[offset - 1]) &&
        /[\uDC00-\uDFFF]/.test(note.content[offset]))
    )
      throw new EditError(
        "invalid_input",
        "This note page starts at an invalid boundary. Reload the note.",
      );
    let end = Math.min(offset + 16000, note.content.length);
    if (
      end < note.content.length &&
      /[\uD800-\uDBFF]/.test(note.content[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(note.content[end])
    )
      end--;
    return {
      ...card(note),
      revision: current,
      content: note.content.slice(offset, end),
      offset,
      nextOffset: end < note.content.length ? end : null,
    };
  }
  async function save(id: string, revision: string, patch: unknown) {
    await checkRoot();
    const parsed = notePatch.safeParse(patch);
    if (!parsed.success)
      throw new EditError(
        "invalid_input",
        "Check the editable note fields and their limits, then try again.",
      );
    const { confirmReplace, confirmDraftDigest, ...fields } = parsed.data;
    if (
      (confirmReplace !== undefined || confirmDraftDigest !== undefined) &&
      (confirmReplace !== true ||
        fields.content === undefined ||
        confirmDraftDigest !== draftDigest(fields.content))
    )
      throw new EditError(
        "invalid_input",
        "Replace confirmation does not match this draft. Save again to review the replacement. Your draft is preserved.",
      );
    await read((state) => editable(find(state, id)));
    let originalBytes = 0,
      totalBytes = 0;
    try {
      const result = await handleNoteUpdate(
        id,
        { ...fields, ...(confirmReplace === true && { confirmReplace }) },
        "json",
        root,
        BOARD_NOTE_HATCHES,
        {
          precondition: async (existing) => {
            await checkRoot();
            await readLedger(root, (state, scope) => {
              const current = find(state, id);
              if (
                recordRevision(existing) !== revision ||
                recordRevision(current) !== revision
              )
                throw new EditError(
                  "conflict",
                  "This note changed. Your draft is preserved. Reload to compare current values.",
                );
              originalBytes = scope.fileBytes("notes", current.id + ".json");
              totalBytes = scope.totalBytes();
            });
          },
          validatePreparedContent: async (content) => {
            await checkRoot();
            validateEditSize(content, originalBytes, totalBytes);
          },
        },
      );
      return editable(JSON.parse(result.output).data as Note);
    } catch (error) {
      if (error instanceof EditError || error instanceof BoardError)
        throw error;
      if (
        error instanceof CliValidationError &&
        error.reason === "note_destructive_replace" &&
        fields.content !== undefined
      )
        throw new EditError(
          "confirm_replace_required",
          "Saving would replace most of this long note. Confirm to replace it, or keep editing. Your draft is preserved.",
          { revision, draftDigest: draftDigest(fields.content) },
        );
      if (error instanceof CliValidationError)
        throw new EditError(
          error.code === "conflict" ? "conflict" : "invalid_input",
          "Storybloq refused this note edit. Check content, tags and status. Your draft is preserved.",
        );
      throw new EditError(
        "unavailable",
        "The save could not be confirmed. Your draft is preserved. Reload before retrying.",
      );
    }
  }
  return {
    list,
    detail,
    editor: (id: string) => read((state) => editable(find(state, id))),
    save,
  };
}
