import type { NoteEditor } from "./notes-types.js";
import type { EditableValue } from "./editor-types.js";
import { textElement, type Call, type Result } from "./view-utils.js";

const keys = ["title", "content", "tags", "status"] as const;
export function checkedNoteEditor(result: Result, id: string): NoteEditor {
  const e = result._meta?.editor as NoteEditor,
    f = e?.fields;
  if (
    result.isError ||
    !e ||
    e.kind !== "notes" ||
    e.id !== id ||
    typeof e.displayId !== "string" ||
    e.displayId.length > 80 ||
    !/^[a-f0-9]{64}$/.test(e.revision) ||
    !Array.isArray(e.limitedFields) ||
    e.limitedFields.some(
      (key) => !keys.includes(key as (typeof keys)[number]),
    ) ||
    !f ||
    !(
      f.title === null ||
      (typeof f.title === "string" && f.title.length <= 2000)
    ) ||
    typeof f.content !== "string" ||
    f.content.length > 48000 ||
    !Array.isArray(f.tags) ||
    f.tags.length > 200 ||
    f.tags.some((tag) => typeof tag !== "string" || tag.length > 64) ||
    !["active", "archived"].includes(f.status as string)
  )
    throw new Error("Invalid note editor result");
  return e;
}
export function noteEditMessage(
  result?: Result,
  fallback = "The save could not be confirmed. Your draft is preserved. Reload before retrying.",
) {
  const message = result?._meta?.editError?.message;
  return typeof message === "string" && message.length <= 500
    ? message
    : fallback;
}

export function mountNoteEditor(
  d: Document,
  call: Call,
  callbacks: {
    prepare(record: NoteEditor): Promise<void>;
    saved(record: NoteEditor): void;
    preview(fields: Record<string, EditableValue>, limited: string[]): void;
  },
) {
  const el = (id: string) => d.getElementById(id)!;
  const button = (id: string) => el(id) as HTMLButtonElement;
  const form = el("note-editor") as HTMLFormElement;
  const fields = new Map<
    string,
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >();
  let selection: string | undefined,
    record: NoteEditor | undefined,
    generation = 0,
    disposed = false,
    pending = false,
    deferred: (() => void) | undefined,
    origin: HTMLElement | undefined,
    // Replace consent covers only the exact draft the refusal reported.
    consent:
      | {
          patch: Record<string, EditableValue>;
          revision: string;
          draftDigest: string;
        }
      | undefined;
  const announce = (message: string) => {
    el("note-edit-status").textContent = message;
  };
  const focusField = () =>
    [...fields.values()].find((f) => !f.disabled)?.focus();
  function values() {
    const patch: Record<string, EditableValue> = {};
    if (!record) return patch;
    for (const [key, input] of fields) {
      if (record.limitedFields.includes(key)) continue;
      const value =
        key === "tags"
          ? input.value
              .split("\n")
              .map((v) => v.trim())
              .filter(Boolean)
          : key === "title"
            ? input.value || null
            : input.value;
      if (JSON.stringify(value) !== JSON.stringify(record.fields[key]))
        patch[key] = value;
    }
    return patch;
  }
  function busy(value: boolean) {
    pending = value;
    for (const id of [
      "edit-note",
      "save-note",
      "cancel-note",
      "note-preview-draft",
      "note-edit-draft",
      "note-reload-current",
      "note-back-to-draft",
      "note-keep-editing",
      "note-discard-edits",
      "note-confirm-replace-save",
      "note-confirm-replace-cancel",
    ])
      button(id).disabled = value;
    for (const [key, input] of fields)
      input.disabled = value || record?.limitedFields.includes(key) === true;
  }
  function voidConsent() {
    consent = undefined;
    el("note-confirm-replace").hidden = true;
  }
  function reset() {
    generation++;
    record = undefined;
    deferred = undefined;
    voidConsent();
    fields.clear();
    form.hidden = true;
    el("edit-note").hidden = false;
    el("note-preview").hidden = false;
    for (const id of ["note-discard", "note-conflict", "note-edit-draft"])
      el(id).hidden = true;
    announce("");
    busy(false);
  }
  function field(key: string, value: EditableValue, e: NoteEditor) {
    const label = d.createElement("label");
    label.append(textElement(d, "span", key[0].toUpperCase() + key.slice(1)));
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (key === "status") {
      input = d.createElement("select");
      for (const status of ["active", "archived"]) {
        const option = textElement(
          d,
          "option",
          status === "active" ? "Active" : "Archived",
        );
        option.value = status;
        input.append(option);
      }
    } else if (key === "title") {
      input = d.createElement("input");
      input.maxLength = 2000;
    } else {
      input = d.createElement("textarea");
      input.rows = key === "tags" ? 3 : 12;
      input.maxLength = key === "tags" ? 12999 : 48000;
      input.required = key === "content";
    }
    input.id = "note-" + key;
    input.value = Array.isArray(value) ? value.join("\n") : (value ?? "");
    fields.set(key, input);
    label.append(input);
    if (key === "tags")
      label.append(
        textElement(
          d,
          "small",
          "One tag per line. Up to 200 tags, 64 characters each.",
        ),
      );
    if (e.limitedFields.includes(key)) {
      const hint = textElement(
        d,
        "small",
        "This field exceeds the editor limit. Its full value is preserved when you save other fields.",
      );
      hint.id = input.id + "-hint";
      input.setAttribute("aria-describedby", hint.id);
      label.append(hint);
    }
    return label;
  }
  function show(e: NoteEditor) {
    record = e;
    voidConsent();
    fields.clear();
    el("note-editor-fields").replaceChildren(
      ...keys.map((key) => field(key, e.fields[key], e)),
    );
    form.hidden = false;
    el("note-preview").hidden = true;
    el("edit-note").hidden = true;
    for (const id of ["note-discard", "note-conflict", "note-edit-draft"])
      el(id).hidden = true;
    busy(false);
    announce("Editing " + e.displayId + ".");
    focusField();
  }
  async function edit() {
    if (disposed || pending || !selection) return;
    const id = selection,
      current = ++generation;
    busy(true);
    announce("Loading complete note fields…");
    try {
      const result = await call("storybloq_note_editor", { id });
      if (disposed || current !== generation) return;
      if (result.isError) {
        announce(
          noteEditMessage(
            result,
            "Note fields could not load. Try Edit note again.",
          ),
        );
        return;
      }
      const e = checkedNoteEditor(result, id);
      await callbacks.prepare(e);
      if (!disposed && current === generation) show(e);
    } catch {
      if (!disposed && current === generation)
        announce("Note fields could not load. Reload the note before editing.");
    } finally {
      if (!disposed && current === generation) busy(false);
    }
  }
  async function conflict(current: number, id: string) {
    el("note-conflict").hidden = false;
    el("note-current-values").textContent = "Loading current values…";
    el("note-conflict-title").focus();
    try {
      const result = await call("storybloq_note_editor", { id });
      if (disposed || current !== generation) return;
      const fresh = checkedNoteEditor(result, id);
      el("note-current-values").textContent = keys
        .map((key) => {
          const value = fresh.fields[key];
          return (
            key +
            ":\n" +
            (Array.isArray(value) ? value.join("\n") : (value ?? "")) +
            (fresh.limitedFields.includes(key)
              ? "\n(Preview shortened; full value remains in the project.)"
              : "")
          );
        })
        .join("\n\n");
    } catch {
      if (!disposed && current === generation)
        el("note-current-values").textContent =
          "Current values could not load. Your draft is still preserved.";
    }
  }
  async function save(confirmed?: NonNullable<typeof consent>) {
    if (disposed || pending || !record || !selection) return;
    const draft = values();
    voidConsent();
    if (!Object.keys(draft).length) {
      announce("There are no changes to save.");
      return;
    }
    const id = selection,
      revision = record.revision,
      current = ++generation,
      patch = confirmed
        ? {
            ...draft,
            confirmReplace: true,
            confirmDraftDigest: confirmed.draftDigest,
          }
        : draft;
    busy(true);
    announce("Saving changes…");
    try {
      const result = await call("storybloq_note_save", { id, revision, patch });
      if (disposed || current !== generation) return;
      if (result.isError) {
        announce(noteEditMessage(result));
        const error = result._meta?.editError;
        if (error?.code === "conflict") await conflict(current, id);
        else if (
          !confirmed &&
          error?.code === "confirm_replace_required" &&
          error.revision === revision &&
          typeof error.draftDigest === "string" &&
          /^[a-f0-9]{64}$/.test(error.draftDigest) &&
          typeof draft.content === "string"
        ) {
          consent = { patch: draft, revision, draftDigest: error.draftDigest };
          el("note-confirm-replace").hidden = false;
          el("note-confirm-replace-title").focus();
        }
      } else {
        const saved = checkedNoteEditor(result, id);
        reset();
        callbacks.saved(saved);
        announce("Saved " + saved.displayId + ".");
      }
    } catch {
      if (!disposed && current === generation) announce(noteEditMessage());
    } finally {
      if (!disposed && current === generation) busy(false);
    }
  }
  function guard(action: () => void) {
    if (disposed) return;
    if (pending) {
      announce(
        "Wait for the current save or load to finish. Your draft is preserved.",
      );
      return;
    }
    if (!Object.keys(values()).length) {
      action();
      return;
    }
    deferred = action;
    origin = d.activeElement as HTMLElement;
    el("note-discard").hidden = false;
    el("note-discard-title").focus();
  }
  button("edit-note").onclick = () => void edit();
  // Any change to the draft voids a pending replace confirmation.
  form.addEventListener("input", () => {
    if (consent) voidConsent();
  });
  button("note-confirm-replace-save").onclick = () => {
    if (disposed || pending || !record || !consent) return;
    const confirmed = consent;
    if (
      confirmed.revision !== record.revision ||
      JSON.stringify(values()) !== JSON.stringify(confirmed.patch)
    ) {
      voidConsent();
      return;
    }
    void save(confirmed);
  };
  button("note-confirm-replace-cancel").onclick = () => {
    if (disposed || pending) return;
    voidConsent();
    focusField();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void save();
  };
  button("save-note").onclick = (event) => {
    event.preventDefault();
    void save();
  };
  button("cancel-note").onclick = () => {
    if (disposed || pending) return;
    if (record) callbacks.preview(record.fields, record.limitedFields);
    reset();
    button("edit-note").focus();
  };
  button("note-keep-editing").onclick = () => {
    if (disposed || pending) return;
    deferred = undefined;
    el("note-discard").hidden = true;
    if (origin?.isConnected) origin.focus();
    else focusField();
  };
  button("note-discard-edits").onclick = () => {
    if (disposed || pending) return;
    const action = deferred;
    if (record) callbacks.preview(record.fields, record.limitedFields);
    reset();
    action?.();
  };
  button("note-back-to-draft").onclick = () => {
    if (disposed || pending) return;
    el("note-conflict").hidden = true;
    form.hidden = false;
    el("note-preview").hidden = true;
    el("note-edit-draft").hidden = true;
    focusField();
  };
  button("note-reload-current").onclick = () =>
    guard(() => {
      el("note-detail-title").focus();
      void edit();
    });
  button("note-preview-draft").onclick = () => {
    if (disposed || pending || !record) return;
    const draft = { ...record.fields, ...values() };
    callbacks.preview(draft, record.limitedFields);
    form.hidden = true;
    el("note-preview").hidden = false;
    el("note-edit-draft").hidden = false;
    el("note-detail-title").focus();
  };
  button("note-edit-draft").onclick = () => {
    if (disposed || pending || !record) return;
    form.hidden = false;
    el("note-preview").hidden = true;
    el("note-edit-draft").hidden = true;
    focusField();
  };
  return {
    guard,
    get editing() {
      return record !== undefined;
    },
    get loading() {
      return pending;
    },
    select(id: string) {
      reset();
      selection = id;
      button("edit-note").disabled = true;
    },
    ready() {
      if (!disposed) button("edit-note").disabled = false;
    },
    reset() {
      reset();
      selection = undefined;
    },
    dispose() {
      disposed = true;
      generation++;
      deferred = undefined;
    },
  };
}
