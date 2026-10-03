import type {
  NoteCard,
  NotePreview,
  NoteEditor,
  NotesPage,
} from "./notes-types.js";
import { mountNoteEditor, noteEditMessage } from "./note-editor-view.js";
import {
  markdown,
  textElement,
  ViewError,
  viewMessage,
  type Call,
} from "./view-utils.js";

function checkedPreview(
  value: unknown,
  id: string,
  offset: number,
): NotePreview {
  const p = value as NotePreview;
  if (
    !p ||
    p.id !== id ||
    p.offset !== offset ||
    typeof p.content !== "string" ||
    p.content.length > 16000 ||
    !/^[a-f0-9]{64}$/.test(p.revision) ||
    typeof p.displayId !== "string" ||
    p.displayId.length > 80 ||
    !(
      p.title === null ||
      (typeof p.title === "string" && p.title.length <= 2000)
    ) ||
    !["active", "archived"].includes(p.status) ||
    !Array.isArray(p.tags) ||
    p.tags.length > 6 ||
    p.tags.some((tag) => typeof tag !== "string" || tag.length > 64) ||
    (p.nextOffset !== null &&
      (!Number.isSafeInteger(p.nextOffset) ||
        p.nextOffset <= offset ||
        p.nextOffset > 1048576 ||
        p.nextOffset !== offset + p.content.length))
  )
    throw new ViewError(
      "Note changed or could not load. Reload Notes and select it again.",
    );
  return p;
}
function checkedPage(page: NotesPage) {
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 24 ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 24
  )
    throw new ViewError("Notes could not load. Refresh to try again.");
}
export function mountNotes(d: Document, call: Call) {
  const el = (id: string) => d.getElementById(id)!;
  const button = (id: string) => el(id) as HTMLButtonElement;
  const statusFilter = el("notes-status") as HTMLSelectElement;
  const search = el("notes-search") as HTMLInputElement;
  const window = d.defaultView!;
  let searchTimer: number | undefined;
  function cancelSearch() {
    if (searchTimer !== undefined) {
      window.clearTimeout(searchTimer);
      searchTimer = undefined;
    }
  }
  function disableCards() {
    el("notes-list")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
  }
  let active = false,
    disposed = false,
    ready = false,
    busy = false,
    queued = false,
    generation = 0,
    detailGeneration = 0,
    detailBusy = false;
  let q: {
    status: "all" | "active" | "archived";
    query: string;
    offset: number;
    limit: number;
  } = { status: "active", query: "", offset: 0, limit: 24 };
  let selected: string | undefined, full: NotePreview | undefined;
  let retryNote: NoteCard | undefined;
  const announce = (message: string) => {
    el("notes-live-status").textContent = message;
  };
  const renderContent = (content: string) =>
    el("note-preview").replaceChildren(markdown(d, content));
  const title = (note: { title: string | null; displayId: string }) =>
    note.title?.trim() || note.displayId;
  const editor = mountNoteEditor(d, call, {
    async prepare(e) {
      if (!full || full.revision !== e.revision) {
        const current = detailGeneration;
        const preview = await readFull(e.id, e.revision, current);
        if (!active || disposed || current !== detailGeneration)
          throw new Error("Note selection changed");
        full = preview;
        showFull(full);
      }
    },
    saved(e) {
      if (!active || disposed || !full || selected !== e.id) return;
      const fields = e.fields;
      full = {
        ...full,
        revision: e.revision,
        title: fields.title as string | null,
        status: fields.status as "active" | "archived",
        tags: (fields.tags as string[]).slice(0, 6),
        hiddenTags: Math.max(0, (fields.tags as string[]).length - 6),
        content: e.limitedFields.includes("content")
          ? full.content
          : (fields.content as string),
        updatedDate: e.updatedDate ?? full.updatedDate,
      };
      if (q.status !== "all" && q.status !== full.status) {
        const message = "Saved " + e.displayId + " as " + full.status + ".";
        close();
        statusFilter.focus();
        void refresh(message);
      } else {
        showFull(full);
        el("note-detail-title").focus();
        void refresh("Saved " + e.displayId + ".");
      }
    },
    preview(fields, limited) {
      renderContent(
        limited.includes("content")
          ? (full?.content ?? "")
          : (fields.content as string),
      );
    },
  });
  function close(restore = false) {
    const id = selected;
    detailGeneration++;
    detailBusy = false;
    selected = undefined;
    retryNote = undefined;
    el("note-retry").hidden = true;
    full = undefined;
    editor.reset();
    el("note-detail").hidden = true;
    el("notes-layout").classList.remove("detail-open");
    for (const card of el("notes-list").querySelectorAll<HTMLButtonElement>(
      "[data-note-id]",
    )) {
      card.setAttribute("aria-pressed", "false");
      if (restore && card.dataset.noteId === id && !card.disabled) card.focus();
    }
    if (restore && !(d.activeElement as HTMLElement)?.dataset.noteId)
      statusFilter.focus();
  }
  function showFull(note: NotePreview) {
    el("note-detail-title").textContent = title(note);
    el("note-detail-meta").textContent =
      `${note.displayId} · ${note.status === "active" ? "Active" : "Archived"} · Updated ${note.updatedDate}`;
    renderContent(note.content);
    editor.ready();
  }
  async function readFull(
    id: string,
    expected: string | undefined,
    current: number,
    firstPage?: (page: NotePreview) => void,
  ): Promise<NotePreview> {
    let offset = 0,
      revision = expected,
      first: NotePreview | undefined,
      length = 0;
    const chunks: string[] = [];
    for (let count = 0; count < 128; count++) {
      const result = await call("storybloq_note_detail", {
        id,
        offset,
        ...(revision ? { revision } : {}),
      });
      if (!active || disposed || current !== detailGeneration)
        throw new Error("Note selection changed");
      if (result.isError)
        throw new ViewError(
          noteEditMessage(result, "Note could not load. Try again."),
        );
      const page = checkedPreview(result._meta?.note, id, offset);
      if (revision && page.revision !== revision)
        throw new ViewError(
          "This note changed while reading. Reload to read the current content.",
        );
      if (!first) {
        first = page;
        firstPage?.(page);
      }
      revision ??= page.revision;
      length += page.content.length;
      if (length > 1048576)
        throw new ViewError(
          "Note preview exceeds the read limit. Open it in your project.",
        );
      chunks.push(page.content);
      if (page.nextOffset === null)
        return {
          ...first,
          content: chunks.join(""),
          offset: 0,
          nextOffset: null,
        };
      offset = page.nextOffset;
    }
    throw new ViewError("Note preview could not finish. Reload to try again.");
  }
  async function open(note: NoteCard) {
    if (!active || disposed || busy) return;
    close();
    selected = note.id;
    editor.select(note.id);
    const current = ++detailGeneration;
    detailBusy = true;
    el("note-detail").hidden = false;
    el("notes-layout").classList.add("detail-open");
    el("note-detail-title").textContent = title(note);
    el("note-detail-meta").textContent = note.displayId;
    el("note-preview").textContent = "Loading note…";
    el("note-detail-title").focus();
    for (const card of el("notes-list").querySelectorAll<HTMLButtonElement>(
      "[data-note-id]",
    ))
      card.setAttribute(
        "aria-pressed",
        String(card.dataset.noteId === note.id),
      );
    try {
      const preview = await readFull(note.id, undefined, current, (page) => {
        renderContent(page.content);
        if (page.nextOffset !== null) {
          el("note-preview").append(
            textElement(d, "p", "Loading remaining note content…", "muted"),
          );
          announce("Note preview loaded. Loading remaining content.");
        }
      });
      if (!active || disposed || current !== detailGeneration) return;
      full = preview;
      showFull(preview);
      announce("Note loaded: " + title(preview));
    } catch (error) {
      if (active && !disposed && current === detailGeneration) {
        el("note-preview").textContent = viewMessage(
          error,
          "Note could not load. Reload Notes and select it again.",
        );
        retryNote = note;
        el("note-retry").hidden = false;
        announce("Note could not load. Use Retry note to try again.");
      }
    } finally {
      if (current === detailGeneration) detailBusy = false;
    }
  }
  function makeCard(note: NoteCard) {
    const b = textElement(d, "button", "", "item note-card");
    b.type = "button";
    b.dataset.noteId = note.id;
    b.setAttribute("aria-pressed", String(note.id === selected));
    const heading = textElement(d, "span", "", "card-heading");
    heading.append(
      textElement(d, "span", title(note), "title"),
      textElement(d, "span", note.displayId, "meta"),
    );
    b.append(
      heading,
      textElement(d, "span", note.preview, "note-card-preview"),
    );
    const tags = textElement(d, "span", "", "tags");
    for (const tag of note.tags)
      tags.append(textElement(d, "span", tag, "tag"));
    if (note.hiddenTags)
      tags.append(
        textElement(d, "span", "+" + note.hiddenTags + " more tags", "muted"),
      );
    b.append(
      tags,
      textElement(
        d,
        "span",
        `Updated ${note.updatedDate}${note.status === "archived" ? " · Archived" : ""}`,
        "muted note-card-date",
      ),
    );
    b.onclick = () => editor.guard(() => void open(note));
    return b;
  }
  function render(page: NotesPage, previous: HTMLElement) {
    checkedPage(page);
    q.offset = page.offset;
    el("notes-list").replaceChildren(...page.items.map(makeCard));
    if (!page.total)
      el("notes-list").append(
        textElement(
          d,
          "p",
          q.query
            ? "No notes match your search."
            : "No " + (q.status === "all" ? "" : q.status + " ") + "notes yet.",
          "empty",
        ),
      );
    button("notes-previous").disabled = page.offset === 0;
    button("notes-next").disabled = page.offset + page.limit >= page.total;
    el("notes-position").textContent = page.total
      ? `${page.offset + 1}-${page.offset + page.items.length} of ${page.total} notes`
      : "0 notes";
    if (
      previous.dataset.noteId &&
      (d.activeElement === d.body || d.activeElement === previous)
    ) {
      const replacement = [
        ...el("notes-list").querySelectorAll<HTMLButtonElement>(
          "[data-note-id]",
        ),
      ].find((card) => card.dataset.noteId === previous.dataset.noteId);
      (replacement ?? statusFilter).focus();
    }
    ready = true;
  }
  async function refresh(message?: string) {
    if (!active || disposed) return;
    if (editor.editing || editor.loading) {
      announce(
        "Your draft is preserved. Finish editing before refreshing Notes.",
      );
      return;
    }
    cancelSearch();
    if (busy) {
      queued = true;
      generation++;
      return;
    }
    busy = true;
    const current = ++generation,
      previous = d.activeElement as HTMLElement,
      query = { ...q };
    el("notes-error").textContent = "";
    disableCards();
    try {
      const result = await call("storybloq_notes", query);
      if (!active || disposed || current !== generation) return;
      if (result.isError)
        throw new ViewError(
          noteEditMessage(
            result,
            "Notes could not load. Refresh to try again.",
          ),
        );
      render(result._meta?.notes, previous);
      announce(message ?? "Notes updated.");
    } catch (error) {
      if (active && !disposed && current === generation) {
        el("notes-error").textContent = viewMessage(
          error,
          "Notes could not load. Refresh to try again.",
        );
        announce(
          "Previously displayed notes may be out of date. Refresh to try again.",
        );
      }
    } finally {
      busy = false;
      if (queued) {
        queued = false;
        if (active && !disposed) void refresh();
      }
    }
  }
  statusFilter.onchange = () => {
    const status = statusFilter.value as typeof q.status;
    statusFilter.value = q.status;
    editor.guard(() => {
      if (disposed || !active) return;
      close();
      q = { ...q, status, offset: 0 };
      statusFilter.value = status;
      statusFilter.focus();
      void refresh();
    });
  };
  search.oninput = () => {
    const query = search.value;
    search.value = q.query;
    editor.guard(() => {
      if (disposed || !active) return;
      close();
      q = { ...q, query, offset: 0 };
      search.value = query;
      search.focus();
      cancelSearch();
      // A response for earlier text must not render during the typing delay.
      generation++;
      queued = false;
      disableCards();
      const timer = window.setTimeout(() => {
        if (searchTimer !== timer) return;
        searchTimer = undefined;
        void refresh();
      }, 250);
      searchTimer = timer;
    });
  };
  for (const [id, direction] of [
    ["notes-previous", -1],
    ["notes-next", 1],
  ] as const)
    button(id).onclick = () =>
      editor.guard(() => {
        if (disposed || !active) return;
        close();
        q.offset = Math.max(0, q.offset + direction * q.limit);
        el("notes-title").focus();
        void refresh();
      });
  button("note-retry").onclick = () => {
    const note = retryNote;
    if (note && selected === note.id) editor.guard(() => void open(note));
  };
  button("note-close").onclick = () => editor.guard(() => close(true));
  el("note-detail").onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      editor.guard(() => close(true));
    }
  };
  return {
    refresh,
    guardLeave: editor.guard,
    autoRefresh() {
      if (
        ready &&
        searchTimer === undefined &&
        !busy &&
        !detailBusy &&
        !editor.loading &&
        !editor.editing &&
        el("note-detail").hidden
      )
        void refresh();
    },
    setActive(value: boolean) {
      cancelSearch();
      active = value;
      generation++;
      queued = false;
      close();
    },
    dispose() {
      cancelSearch();
      disposed = true;
      active = false;
      generation++;
      detailGeneration++;
      queued = false;
      editor.dispose();
    },
  };
}
