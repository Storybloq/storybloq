import type { ItemEditor, EditableValue, ItemKind } from "./editor-types.js";
import type { Call, Result } from "./view-utils.js";

type Selection = { kind: ItemKind; id: string; displayId: string };
const labels: Record<string, string> = {
  title: "Title",
  description: "Description",
  type: "Type",
  status: "Status",
  phase: "Phase",
  blockedBy: "Blocked by",
  crossNodeBlockedBy: "Dependencies in other projects",
  impact: "Impact",
  resolution: "Resolution",
  severity: "Severity",
};
type Choice = { value: string; label: string };
function fieldChoices(key: string, e: ItemEditor): Choice[] | undefined {
  if (key === "phase")
    return [
      { value: "", label: "Unphased" },
      ...e.phases.map((p) => ({ value: p.key, label: p.name })),
    ];
  if (key === "status") {
    const captions: Record<string, string> = {
      open: "Open",
      inprogress: "In progress",
      complete: "Complete",
      resolved: "Resolved",
    };
    return (
      e.kind === "tickets"
        ? ["open", "inprogress", "complete"]
        : ["open", "inprogress", "resolved"]
    ).map((value) => ({ value, label: captions[value] }));
  }
  if (key === "type" || key === "severity")
    return (
      key === "type"
        ? ["task", "feature", "chore"]
        : ["critical", "high", "medium", "low"]
    ).map((value) => ({
      value,
      label: value[0].toUpperCase() + value.slice(1),
    }));
}
function fieldControl(
  d: Document,
  key: string,
  value: EditableValue,
  choices?: Choice[],
) {
  if (choices) {
    const input = d.createElement("select");
    for (const choice of choices) {
      const option = d.createElement("option");
      option.value = choice.value;
      option.textContent = choice.label;
      input.append(option);
    }
    return input;
  }
  if (key === "title") {
    const input = d.createElement("input");
    input.maxLength = 2000;
    input.required = true;
    return input;
  }
  const input = d.createElement("textarea");
  input.maxLength = 48000;
  input.rows = Array.isArray(value) ? 3 : key === "resolution" ? 5 : 10;
  return input;
}
export function mountEditor(
  d: Document,
  call: Call,
  saved: (item: ItemEditor) => void,
) {
  const el = (id: string) => d.getElementById(id)!;
  const button = (id: string) => el(id) as HTMLButtonElement;
  const form = el("item-editor") as HTMLFormElement;
  const fields = new Map<
    string,
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >();
  let selection: Selection | undefined, record: ItemEditor | undefined;
  let generation = 0,
    pending = false,
    disposed = false;
  let deferred: (() => void) | undefined, origin: HTMLElement | undefined;
  function announce(value: string) {
    el("edit-status").textContent = value;
  }
  function focusField() {
    [...fields.values()].find((f) => !f.disabled)?.focus();
  }
  function values() {
    const patch: Record<string, EditableValue> = {};
    if (!record) return patch;
    for (const [key, input] of fields) {
      if (record.limitedFields.includes(key) || input.disabled) continue;
      const original = record.fields[key];
      const value = Array.isArray(original)
        ? input.value
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean)
        : key === "phase" || key === "resolution"
          ? input.value || null
          : input.value;
      if (JSON.stringify(value) !== JSON.stringify(original))
        patch[key] = value;
    }
    return patch;
  }
  const dirty = () => !form.hidden && Object.keys(values()).length > 0;
  function busy(value: boolean) {
    pending = value;
    for (const id of [
      "edit-item",
      "save-item",
      "cancel-item",
      "reopen-item",
      "confirm-reopen",
      "cancel-reopen",
      "reload-item",
      "back-to-draft",
      "discard-edits",
      "keep-editing",
    ])
      button(id).disabled = value;
    for (const [key, input] of fields)
      input.disabled =
        value ||
        record?.limitedFields.includes(key) === true ||
        (key === "status" &&
          record?.kind === "tickets" &&
          record.fields.status === "complete");
  }
  function reset() {
    generation++;
    pending = false;
    record = undefined;
    fields.clear();
    deferred = undefined;
    form.hidden = true;
    for (const id of ["edit-discard", "edit-conflict", "reopen-confirmation"])
      el(id).hidden = true;
    el("edit-item").hidden = false;
    el("reopen-item").hidden = true;
    el("detail-body").hidden = false;
    announce("");
    busy(false);
  }
  function checked(result: Result): ItemEditor {
    const e = result._meta?.editor as ItemEditor;
    if (
      result.isError ||
      !e ||
      !selection ||
      e.kind !== selection.kind ||
      e.id !== selection.id ||
      !/^[a-f0-9]{64}$/.test(e.revision) ||
      !e.fields ||
      !Array.isArray(e.limitedFields) ||
      !Array.isArray(e.phases)
    )
      throw Error("Invalid editor result");
    return e;
  }
  function failure(result?: Result) {
    const message = result?._meta?.editError?.message;
    return typeof message === "string" && message.length <= 500
      ? message
      : "The save could not be confirmed. Your draft is preserved. Reload before retrying.";
  }
  function field(key: string, value: EditableValue, e: ItemEditor) {
    const label = d.createElement("label"),
      caption = d.createElement("span");
    caption.textContent = labels[key] ?? key;
    const input = fieldControl(d, key, value, fieldChoices(key, e));
    input.id = key === "status" ? "edit-status-field" : "edit-" + key;
    input.value = Array.isArray(value) ? value.join("\n") : (value ?? "");
    fields.set(key, input);
    label.append(caption, input);
    if (Array.isArray(value)) {
      const hint = d.createElement("small");
      hint.textContent = "One identifier per line";
      label.append(hint);
    }
    if (e.limitedFields.includes(key)) {
      const hint = d.createElement("small");
      hint.id = input.id + "-hint";
      hint.textContent =
        "This field exceeds the editor limit. The full value will be preserved when you save other fields.";
      input.setAttribute("aria-describedby", hint.id);
      label.append(hint);
    } else if (
      key === "status" &&
      e.kind === "tickets" &&
      value === "complete"
    ) {
      const hint = d.createElement("small");
      hint.textContent =
        "Use Reopen ticket to begin working on a completed ticket again.";
      label.append(hint);
    }
    return label;
  }
  function show(e: ItemEditor) {
    record = e;
    fields.clear();
    el("editor-fields").replaceChildren(
      ...Object.entries(e.fields).map(([k, v]) => field(k, v, e)),
    );
    form.hidden = false;
    el("detail-body").hidden = true;
    el("edit-item").hidden = true;
    el("reopen-item").hidden = !e.canReopen;
    for (const id of ["edit-discard", "edit-conflict", "reopen-confirmation"])
      el(id).hidden = true;
    busy(false);
    announce("Editing " + e.displayId + ".");
    focusField();
  }
  async function edit() {
    if (disposed || pending || !selection) return;
    const current = ++generation,
      selected = { ...selection };
    busy(true);
    announce("Loading the full item…");
    try {
      const r = await call("storybloq_item_editor", {
        kind: selected.kind,
        id: selected.id,
      });
      if (disposed || current !== generation) return;
      if (r.isError) {
        announce(failure(r));
        return;
      }
      show(checked(r));
    } catch {
      if (!disposed && current === generation)
        announce("The item could not load. Try Edit again.");
    } finally {
      if (!disposed && current === generation) busy(false);
    }
  }
  function finish(e: ItemEditor) {
    reset();
    record = e;
    el("detail-title").textContent = e.displayId + ": " + e.fields.title;
    el("detail-body").textContent = String(
      e.fields.description ?? e.fields.impact ?? "",
    );
    el("reopen-item").hidden = !e.canReopen;
    announce("Saved " + e.displayId + ".");
    saved(e);
    el("detail-title").focus();
  }
  async function conflict(current: number) {
    el("edit-conflict").hidden = false;
    el("current-values").textContent = "Loading current values…";
    el("edit-conflict-title").focus();
    if (!selection) return;
    try {
      const r = await call("storybloq_item_editor", {
        kind: selection.kind,
        id: selection.id,
      });
      if (disposed || current !== generation) return;
      const e = checked(r);
      const comparisonFields = {
        ...e.fields,
        phase:
          e.fields.phase === null
            ? "Unphased"
            : (e.phases.find((p) => p.key === e.fields.phase)?.name ??
              "Phase unavailable"),
      };
      el("current-values").textContent = Object.entries(comparisonFields)
        .map(
          ([k, v]) =>
            `${labels[k] ?? k}: ${Array.isArray(v) ? v.join(", ") : (v ?? "Unphased")}`,
        )
        .join("\n\n");
    } catch {
      if (!disposed && current === generation)
        el("current-values").textContent =
          "Current values are unavailable. Your draft is preserved.";
    }
  }
  async function save(reopen = false) {
    if (disposed || pending || !selection || !record) return;
    const patch = values();
    if (!reopen && !Object.keys(patch).length) {
      announce("There are no changes to save.");
      return;
    }
    const current = ++generation;
    busy(true);
    announce(reopen ? "Reopening ticket…" : "Saving changes…");
    try {
      const r = await call(
        reopen ? "storybloq_ticket_reopen" : "storybloq_item_save",
        reopen
          ? { id: selection.id, revision: record.revision }
          : {
              kind: selection.kind,
              id: selection.id,
              revision: record.revision,
              patch,
            },
      );
      if (disposed || current !== generation) return;
      if (!r.isError) {
        finish(checked(r));
        return;
      }
      announce(failure(r));
      if (r._meta?.editError?.code === "conflict") await conflict(current);
    } catch {
      if (!disposed && current === generation) announce(failure());
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
    if (!dirty()) {
      action();
      return;
    }
    deferred = action;
    origin = d.activeElement as HTMLElement;
    el("edit-discard").hidden = false;
    el("edit-discard-title").focus();
  }
  button("edit-item").onclick = () => void edit();
  form.onsubmit = (e) => {
    e.preventDefault();
    void save();
  };
  button("cancel-item").onclick = () => {
    if (pending) return;
    reset();
    button("edit-item").focus();
  };
  button("keep-editing").onclick = () => {
    deferred = undefined;
    el("edit-discard").hidden = true;
    if (origin?.isConnected) origin.focus();
    else focusField();
  };
  button("discard-edits").onclick = () => {
    if (disposed || pending) return;
    const action = deferred;
    if (record) show(record);
    else reset();
    deferred = undefined;
    action?.();
  };
  button("reopen-item").onclick = () =>
    guard(() => {
      el("reopen-confirmation").hidden = false;
      button("confirm-reopen").focus();
    });
  button("confirm-reopen").onclick = () => {
    if (disposed || pending) return;
    if (dirty()) {
      el("reopen-confirmation").hidden = true;
      guard(() => {
        el("reopen-confirmation").hidden = false;
        button("confirm-reopen").focus();
      });
      return;
    }
    void save(true);
  };
  button("cancel-reopen").onclick = () => {
    el("reopen-confirmation").hidden = true;
    button("reopen-item").focus();
  };
  button("reload-item").onclick = () => guard(() => void edit());
  button("back-to-draft").onclick = () => {
    el("edit-conflict").hidden = true;
    focusField();
  };
  return {
    select(item: Selection) {
      reset();
      selection = item;
      button("edit-item").disabled = true;
    },
    ready() {
      button("edit-item").disabled = false;
    },
    reset() {
      reset();
      selection = undefined;
    },
    get editing() {
      return !form.hidden;
    },
    guard,
    dispose() {
      disposed = true;
      generation++;
      deferred = undefined;
    },
  };
}
