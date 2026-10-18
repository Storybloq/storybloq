// Exercises the shipped workspace markup and controller through app-tool calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { mountWorkspace } from "../src/workspace-view.js";
import type { Call } from "../src/view-utils.js";

const revision = "b".repeat(64);
const content =
  "# Decision\n\n**Preserve context**\n\n<img src=x onerror=alert(1)>";
const card = {
  id: "N-001",
  displayId: "N-001",
  title: "Decision",
  preview: "Short preview",
  tags: ["design"],
  hiddenTags: 0,
  status: "active",
  updatedDate: "2026-10-01",
};
const editor = {
  kind: "notes",
  id: card.id,
  displayId: card.displayId,
  revision,
  fields: { title: card.title, content, tags: card.tags, status: card.status },
  limitedFields: [],
};
const overview = {
  project: "Demo",
  loadedAt: "2026-10-01T12:00:00Z",
  currentPhase: null,
  phases: [],
  hasUnphased: false,
  summary: { total: 0, complete: 0, blocked: 0, openIssues: 0, severity: {} },
  limit: 6,
  columns: Object.fromEntries(
    ["open", "inProgress", "done"].map((k) => [
      k,
      { items: [], total: 0, offset: 0 },
    ]),
  ),
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const basic: Call = async (name) => {
  if (name === "storybloq_notes")
    return {
      _meta: { notes: { items: [card], total: 1, offset: 0, limit: 24 } },
    };
  if (name === "storybloq_note_detail")
    return {
      _meta: {
        note: { ...card, revision, content, offset: 0, nextOffset: null },
      },
    };
  if (name === "storybloq_note_editor") return { _meta: { editor } };
  if (name === "storybloq_board_overview") return { _meta: { overview } };
  throw new Error("Unexpected test call: " + name);
};
async function setup(call: Call = basic) {
  const dom = new JSDOM(await readFile("src/app.html", "utf8")),
    d = dom.window.document,
    view = mountWorkspace(d, call);
  view.receive({ _meta: { overview } });
  function click(id: string) {
    const button = d.getElementById(id) as HTMLButtonElement | null;
    assert.ok(button, id + " exists");
    button.click();
  }
  function change(id: string, value: string) {
    const input = d.getElementById(id) as HTMLInputElement | null;
    assert.ok(input, id + " exists");
    input.value = value;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  async function open() {
    click("nav-notes");
    await tick();
    const button = d.querySelector<HTMLButtonElement>('[data-note-id="N-001"]');
    assert.ok(button, "canonical note card exists");
    button.click();
    await tick();
  }
  return {
    dom,
    d,
    view,
    click,
    change,
    open,
    close: () => {
      view.dispose();
      dom.window.close();
    },
  };
}

test("Notes opens an inert rendered preview before loading full editable values", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    return basic(name, args);
  });
  try {
    await s.open();
    const preview = s.d.getElementById("note-preview")!;
    assert.ok(preview);
    assert.equal(s.d.activeElement!.id, "note-detail-title");
    assert.equal(s.d.activeElement!.isConnected, true);
    assert.equal(
      preview.querySelector("strong")!.textContent,
      "Preserve context",
    );
    assert.equal(preview.querySelector("img, script, iframe"), null);
    assert.ok(preview.textContent!.includes("<img"));
    assert.equal(
      calls.some((c) => c.name === "storybloq_note_editor"),
      false,
    );
    assert.equal(
      calls.some((c) => c.name === "storybloq_note_save"),
      false,
    );
    s.click("edit-note");
    await tick();
    const input = s.d.getElementById("note-content") as HTMLTextAreaElement;
    assert.equal(input.value, content);
    assert.ok(input.labels!.length > 0);
    assert.equal(s.d.activeElement!.id, "note-title");
  } finally {
    s.close();
  }
});

test("note Save submits only changed fields, waits for acknowledgement and Cancel never writes", async () => {
  let acknowledge: ((value: any) => void) | undefined;
  const saves: Record<string, unknown>[] = [];
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_save") {
      saves.push(args);
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
    }
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-title", "Changed");
    s.click("save-note");
    assert.equal(
      (s.d.getElementById("save-note") as HTMLButtonElement).disabled,
      true,
    );
    assert.deepEqual(saves, [
      { id: "N-001", revision, patch: { title: "Changed" } },
    ]);
    s.click("save-note");
    assert.equal(saves.length, 1);
    assert.ok(acknowledge);
    acknowledge({
      _meta: {
        editor: {
          ...editor,
          revision: "c".repeat(64),
          fields: { ...editor.fields, title: "Changed" },
        },
      },
    });
    await tick();
    assert.equal(s.d.activeElement!.id, "note-detail-title");
    assert.match(
      s.d.getElementById("note-detail-title")!.textContent!,
      /Changed/,
    );
    s.click("edit-note");
    await tick();
    s.change("note-title", "Cancelled");
    s.click("cancel-note");
    assert.equal(saves.length, 1);
    assert.equal(s.d.activeElement!.id, "edit-note");
    assert.equal(s.d.activeElement!.isConnected, true);
  } finally {
    s.close();
  }
});

test("note conflict retains the draft and dirty navigation requires explicit discard", async () => {
  const s = await setup(async (name, args) =>
    name === "storybloq_note_save"
      ? {
          isError: true,
          _meta: {
            editError: {
              code: "conflict",
              message: "Changed elsewhere. Your draft is preserved.",
            },
          },
        }
      : basic(name, args),
  );
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-content", "Unsaved authored content");
    s.click("save-note");
    await tick();
    assert.equal(
      (s.d.getElementById("note-content") as HTMLTextAreaElement).value,
      "Unsaved authored content",
    );
    assert.equal(s.d.activeElement!.id, "note-conflict-title");
    assert.equal(s.d.activeElement!.isConnected, true);
    const announcement = [
      ...s.d.querySelectorAll<HTMLElement>('[aria-live="polite"]'),
    ].find((element) => /Changed elsewhere/.test(element.textContent ?? ""));
    assert.ok(announcement, "conflict has a polite live announcement");
    assert.equal(announcement.isConnected, true);
    assert.equal(announcement.closest("[hidden]"), null);
    s.click("note-back-to-draft");
    s.click("refresh");
    await tick();
    assert.equal(
      (s.d.getElementById("note-content") as HTMLTextAreaElement).value,
      "Unsaved authored content",
    );
    s.click("nav-board");
    assert.equal(s.d.getElementById("notes-screen")!.hidden, false);
    assert.equal(s.d.getElementById("note-discard")!.hidden, false);
    s.click("note-keep-editing");
    assert.equal(s.d.getElementById("notes-screen")!.hidden, false);
    s.click("nav-board");
    s.click("note-discard-edits");
    assert.equal(s.d.getElementById("board-screen")!.hidden, false);
    assert.equal(s.d.activeElement!.id, "nav-board");
  } finally {
    s.close();
  }
});

test("acknowledged archive leaves the Active list with focus on its stable filter", async () => {
  let archived = false;
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_save") {
      assert.deepEqual(args, {
        id: "N-001",
        revision,
        patch: { status: "archived" },
      });
      archived = true;
      return {
        _meta: {
          editor: {
            ...editor,
            revision: "c".repeat(64),
            fields: { ...editor.fields, status: "archived" },
          },
        },
      };
    }
    if (name === "storybloq_notes" && archived)
      return {
        _meta: { notes: { items: [], total: 0, offset: 0, limit: 24 } },
      };
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    const status = s.d.getElementById("note-status") as HTMLSelectElement;
    assert.ok(status);
    status.value = "archived";
    status.dispatchEvent(new s.dom.window.Event("change", { bubbles: true }));
    s.click("save-note");
    await tick();
    assert.equal(archived, true);
    assert.equal(s.d.getElementById("note-detail")!.hidden, true);
    assert.equal(s.d.activeElement!.id, "notes-status");
    assert.equal(s.d.activeElement!.isConnected, true);
    assert.equal(s.d.querySelector('[data-note-id="N-001"]'), null);
  } finally {
    s.close();
  }
});

test("a departed or disposed Notes screen ignores late list and detail responses", async () => {
  for (const departure of ["navigate", "dispose"]) {
    for (const stage of ["list", "detail"] as const) {
      let finish: ((value: any) => void) | undefined;
      const s = await setup(async (name, args) => {
        if (
          name ===
          (stage === "list" ? "storybloq_notes" : "storybloq_note_detail")
        )
          return new Promise((resolve) => {
            finish = resolve;
          });
        return basic(name, args);
      });
      try {
        s.click("nav-notes");
        await tick();
        if (stage === "detail") {
          s.d
            .querySelector<HTMLButtonElement>('[data-note-id="N-001"]')!
            .click();
          await tick();
        }
        assert.ok(finish);
        if (departure === "navigate") s.click("nav-board");
        else s.view.dispose();
        const before = s.d.getElementById("notes-screen")!.innerHTML;
        const focusBefore = s.d.activeElement;
        finish(
          await basic(
            stage === "list" ? "storybloq_notes" : "storybloq_note_detail",
            {},
          ),
        );
        await tick();
        assert.equal(s.d.getElementById("notes-screen")!.innerHTML, before);
        assert.equal(s.d.activeElement, focusBefore);
        if (departure === "navigate") {
          assert.equal(s.d.getElementById("board-screen")!.hidden, false);
          assert.equal(s.d.activeElement!.id, "nav-board");
        }
      } finally {
        s.close();
      }
    }
  }
});

test("disposed notes ignore a delayed save acknowledgment without stealing focus", async () => {
  let finish: ((value: any) => void) | undefined;
  const s = await setup(async (name, args) =>
    name === "storybloq_note_save"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : basic(name, args),
  );
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-title", "Delayed save");
    s.click("save-note");
    assert.ok(finish);
    s.view.dispose();
    s.d.getElementById("refresh")!.focus();
    const before = s.d.getElementById("notes-screen")!.innerHTML;
    finish({
      _meta: {
        editor: {
          ...editor,
          fields: { ...editor.fields, title: "Delayed save" },
        },
      },
    });
    await tick();
    assert.equal(s.d.getElementById("notes-screen")!.innerHTML, before);
    assert.equal(s.d.activeElement!.id, "refresh");
  } finally {
    s.close();
  }
});

test("draft Markdown preview renders changed content safely and Edit restores exact unsaved values", async () => {
  let saves = 0;
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_save") saves++;
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    const draft =
      "# Unsaved decision\n\n**New context**\n\n<script>alert(1)</script>";
    s.change("note-content", draft);
    s.click("note-preview-draft");
    const preview = s.d.getElementById("note-preview")!;
    assert.equal(preview.querySelector("strong")!.textContent, "New context");
    assert.equal(preview.querySelector("script, img, iframe"), null);
    assert.ok(preview.textContent!.includes("<script>"));
    s.click("note-edit-draft");
    assert.equal(
      (s.d.getElementById("note-content") as HTMLTextAreaElement).value,
      draft,
    );
    assert.equal(saves, 0);
  } finally {
    s.close();
  }
});

test("note preview reconstructs revision-bound pages and refuses changed pages", async () => {
  for (const changed of [false, true]) {
    const calls: Record<string, unknown>[] = [];
    const s = await setup(async (name, args) => {
      if (name !== "storybloq_note_detail") return basic(name, args);
      calls.push(args);
      if (args.offset === 0)
        return {
          _meta: {
            note: {
              ...card,
              revision,
              content: "a".repeat(15999),
              offset: 0,
              nextOffset: 15999,
            },
          },
        };
      assert.deepEqual(args, { id: card.id, offset: 15999, revision });
      return changed
        ? {
            isError: true,
            _meta: {
              editError: {
                code: "conflict",
                message: "Note changed. Reload to read it.",
              },
            },
          }
        : {
            _meta: {
              note: {
                ...card,
                revision,
                content: "😀 tail",
                offset: 15999,
                nextOffset: null,
              },
            },
          };
    });
    try {
      await s.open();
      await tick();
      assert.equal(calls.length, 2);
      const preview = s.d.getElementById("note-preview")!;
      if (changed) {
        assert.ok(!preview.textContent!.includes("a".repeat(100)));
        assert.match(
          s.d.getElementById("notes-screen")!.textContent!,
          /changed|reload/i,
        );
      } else assert.equal(preview.textContent, "a".repeat(15999) + "😀 tail");
    } finally {
      s.close();
    }
  }
});

test("note preview refuses mismatched revisions and nonadvancing page responses", async () => {
  for (const mode of ["revision", "offset"]) {
    let calls = 0;
    const s = await setup(async (name, args) => {
      if (name !== "storybloq_note_detail") return basic(name, args);
      calls++;
      if (calls === 1)
        return {
          _meta: {
            note: {
              ...card,
              revision,
              content: "first page",
              offset: 0,
              nextOffset: 10,
            },
          },
        };
      assert.equal(calls, 2, "invalid pages must not cause another request");
      return {
        _meta: {
          note: {
            ...card,
            revision: mode === "revision" ? "c".repeat(64) : revision,
            content: "untrusted second page",
            offset: 10,
            nextOffset: mode === "offset" ? 10 : null,
          },
        },
      };
    });
    try {
      await s.open();
      await tick();
      assert.equal(calls, 2);
      assert.ok(
        !s.d
          .getElementById("note-preview")!
          .textContent!.includes("untrusted second page"),
      );
      assert.match(
        s.d.getElementById("notes-screen")!.textContent!,
        /reload|could not|changed/i,
      );
    } finally {
      s.close();
    }
  }
});

test("note refresh preserves canonical card focus, falls back to the filter, and never overlaps polling", async () => {
  let hold = false,
    removed = false,
    calls = 0,
    finish: ((value: any) => void) | undefined;
  const s = await setup(async (name, args) => {
    if (name !== "storybloq_notes") return basic(name, args);
    calls++;
    if (hold)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return {
      _meta: {
        notes: {
          items: removed ? [] : [card],
          total: removed ? 0 : 1,
          offset: 0,
          limit: 24,
        },
      },
    };
  });
  try {
    s.click("nav-notes");
    await tick();
    const button = s.d.querySelector<HTMLButtonElement>(
      '[data-note-id="N-001"]',
    )!;
    button.focus();
    s.click("refresh");
    await tick();
    assert.equal((s.d.activeElement as HTMLElement).dataset.noteId, card.id);
    assert.equal(s.d.activeElement!.isConnected, true);
    hold = true;
    s.view.autoRefresh();
    const before = calls;
    s.view.autoRefresh();
    assert.equal(calls, before);
    assert.ok(finish);
    finish({ _meta: { notes: { items: [], total: 0, offset: 0, limit: 24 } } });
    await tick();
    assert.equal(s.d.activeElement!.id, "notes-status");
    s.click("nav-board");
    const finalCalls = calls;
    s.view.autoRefresh();
    assert.equal(calls, finalCalls);
  } finally {
    s.close();
  }
});

test("note save failure and Preview/Edit toggles retain the draft and disabled oversized fields", async () => {
  const limited = {
    ...editor,
    limitedFields: ["content"],
    fields: { ...editor.fields, content: "Bounded read-only preview" },
  };
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_editor") return { _meta: { editor: limited } };
    if (name === "storybloq_note_save")
      return {
        isError: true,
        _meta: {
          editError: {
            code: "unavailable",
            message:
              "The save could not be confirmed. Your draft is preserved.",
          },
        },
      };
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    assert.equal(
      (s.d.getElementById("note-content") as HTMLTextAreaElement).disabled,
      true,
    );
    s.change("note-title", "Kept draft");
    s.click("note-preview-draft");
    assert.match(s.d.getElementById("note-preview")!.textContent!, /Decision/);
    s.click("note-edit-draft");
    assert.equal(
      (s.d.getElementById("note-title") as HTMLInputElement).value,
      "Kept draft",
    );
    s.click("save-note");
    await tick();
    assert.equal(
      (s.d.getElementById("note-title") as HTMLInputElement).value,
      "Kept draft",
    );
    assert.equal(
      (s.d.getElementById("save-note") as HTMLButtonElement).disabled,
      false,
    );
    assert.match(
      s.d.getElementById("notes-screen")!.textContent!,
      /could not be confirmed/,
    );
  } finally {
    s.close();
  }
});

test("confirmed dirty filter, search and paging changes restore visible connected focus", async () => {
  for (const action of ["status", "search", "page"] as const) {
    const s = await setup(async (name, args) =>
      name === "storybloq_notes"
        ? {
            _meta: {
              notes: {
                items: [card],
                total: 50,
                offset: args.offset ?? 0,
                limit: 24,
              },
            },
          }
        : basic(name, args),
    );
    try {
      await s.open();
      s.click("edit-note");
      await tick();
      s.change("note-title", "Dirty draft");
      if (action === "status") {
        const filter = s.d.getElementById("notes-status") as HTMLSelectElement;
        filter.focus();
        filter.value = "all";
        filter.dispatchEvent(
          new s.dom.window.Event("change", { bubbles: true }),
        );
      } else if (action === "search") {
        s.d.getElementById("notes-search")!.focus();
        s.change("notes-search", "Decision");
      } else {
        s.d.getElementById("notes-next")!.focus();
        s.click("notes-next");
      }
      assert.equal(s.d.activeElement!.id, "note-discard-title");
      s.click("note-discard-edits");
      await tick();
      const focus = s.d.activeElement as HTMLElement;
      assert.equal(focus.isConnected, true);
      assert.equal(focus.closest("[hidden]"), null);
      assert.equal(
        focus.id,
        action === "status"
          ? "notes-status"
          : action === "search"
            ? "notes-search"
            : "notes-title",
      );
    } finally {
      s.close();
    }
  }
});

test("long note renders its first bounded page promptly and clears it if a later page changes", async () => {
  let finish: ((value: any) => void) | undefined;
  const s = await setup(async (name, args) => {
    if (name !== "storybloq_note_detail") return basic(name, args);
    if (args.offset === 0)
      return {
        _meta: {
          note: {
            ...card,
            revision,
            content: "First bounded page",
            offset: 0,
            nextOffset: 18,
          },
        },
      };
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    await s.open();
    assert.ok(finish, "the second page remains pending");
    assert.match(
      s.d.getElementById("note-preview")!.textContent!,
      /First bounded page/,
    );
    assert.equal(
      (s.d.getElementById("edit-note") as HTMLButtonElement).disabled,
      true,
    );
    finish({
      isError: true,
      _meta: {
        editError: {
          code: "conflict",
          message: "Note changed. Reload to read it.",
        },
      },
    });
    await tick();
    assert.ok(
      !s.d
        .getElementById("note-preview")!
        .textContent!.includes("First bounded page"),
    );
    assert.match(
      s.d.getElementById("notes-screen")!.textContent!,
      /changed|reload/i,
    );
  } finally {
    s.close();
  }
});

test("confirmed conflict reload keeps visible focus during and after a failed load", async () => {
  let editorCalls = 0,
    finish: ((value: any) => void) | undefined;
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_save")
      return {
        isError: true,
        _meta: {
          editError: {
            code: "conflict",
            message: "Changed elsewhere. Your draft is preserved.",
          },
        },
      };
    if (name === "storybloq_note_editor" && ++editorCalls >= 3)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-title", "Unsaved decision");
    s.click("save-note");
    await tick();
    assert.equal(s.d.getElementById("note-conflict")!.hidden, false);
    s.click("note-reload-current");
    assert.equal(s.d.getElementById("note-discard")!.hidden, false);
    s.d.getElementById("note-discard-edits")!.focus();
    s.click("note-discard-edits");
    assert.ok(finish, "the confirmed reload must be pending");
    assert.equal(s.d.activeElement!.id, "note-detail-title");
    assert.equal(s.d.activeElement!.isConnected, true);
    assert.equal(s.d.activeElement!.closest("[hidden]"), null);
    finish({
      isError: true,
      _meta: {
        editError: {
          code: "unavailable",
          message: "Current note could not load. Try again.",
        },
      },
    });
    await tick();
    assert.equal(s.d.activeElement!.id, "note-detail-title");
    assert.equal(s.d.activeElement!.closest("[hidden]"), null);
    assert.match(
      s.d.getElementById("note-edit-status")!.textContent!,
      /could not load/,
    );
    assert.equal(
      (s.d.getElementById("edit-note") as HTMLButtonElement).disabled,
      false,
    );
  } finally {
    s.close();
  }
});

// Control the window's owned timers without sleeps or timing-sensitive assertions.
function searchClock(window: JSDOM["window"]) {
  let now = 0,
    next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  const callbacks: (() => void)[] = [];
  window.setTimeout = (callback: TimerHandler, delay = 0) => {
    assert.equal(typeof callback, "function");
    const run = callback as () => void,
      id = ++next;
    callbacks.push(run);
    pending.set(id, { at: now + delay, run });
    return id;
  };
  window.clearTimeout = (id?: number) => {
    if (id !== undefined) pending.delete(id);
  };
  return {
    advance(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...pending].sort(
        (a, b) => a[1].at - b[1].at,
      )) {
        if (timer.at <= now && pending.delete(id)) timer.run();
      }
    },
    callbacks,
    pending: () => pending.size,
  };
}

test("note search coalesces a typing burst and polling cannot bypass the delay", async () => {
  const calls: Record<string, unknown>[] = [];
  const s = await setup(async (name, args) => {
    if (name === "storybloq_notes") calls.push({ ...args });
    return basic(name, args);
  });
  const clock = searchClock(s.dom.window);
  try {
    s.click("nav-notes");
    await tick();
    calls.length = 0;
    for (const query of ["c", "co", "con", "cont", "context"]) {
      s.change("notes-search", query);
      clock.advance(35);
    }
    for (const run of clock.callbacks.slice(0, -1)) run();
    s.view.autoRefresh();
    assert.equal(calls.length, 0, "typing and polling must not read early");
    assert.equal(clock.pending(), 1);
    assert.equal(
      (s.d.getElementById("notes-search") as HTMLInputElement).value,
      "context",
    );
    assert.equal(
      s.d.querySelector<HTMLButtonElement>("[data-note-id]")!.disabled,
      true,
    );
    clock.advance(214);
    assert.equal(calls.length, 0);
    clock.advance(1);
    await tick();
    assert.deepEqual(
      calls.map((c) => [c.query, c.offset]),
      [["context", 0]],
    );
    assert.equal(clock.pending(), 0);
    assert.equal(
      s.d.querySelector<HTMLButtonElement>("[data-note-id]")!.disabled,
      false,
    );
    assert.equal(s.d.activeElement!.id, "notes-search");
  } finally {
    s.close();
  }
});

test("typing immediately invalidates stale results and replaces queued work during a slow read", async () => {
  const pending: ((value: Awaited<ReturnType<Call>>) => void)[] = [];
  const calls: Record<string, unknown>[] = [];
  const s = await setup(async (name, args) => {
    if (name !== "storybloq_notes") return basic(name, args);
    calls.push({ ...args });
    return new Promise((resolve) => pending.push(resolve));
  });
  const clock = searchClock(s.dom.window);
  const response = (title: string) => ({
    _meta: {
      notes: { items: [{ ...card, title }], total: 1, offset: 0, limit: 24 },
    },
  });
  try {
    s.click("nav-notes");
    s.change("notes-search", "c");
    pending.shift()!(response("Stale initial result"));
    await tick();
    assert.doesNotMatch(
      s.d.getElementById("notes-list")!.textContent!,
      /Stale initial/,
    );
    clock.advance(250);
    assert.deepEqual(
      calls.map((c) => c.query),
      ["", "c"],
    );
    s.change("notes-search", "co");
    clock.advance(250);
    assert.equal(calls.length, 2, "only one read may be in flight");
    s.change("notes-search", "context");
    pending.shift()!(response("Stale partial search"));
    await tick();
    assert.equal(
      calls.length,
      2,
      "superseded queued query must not bypass the new delay",
    );
    assert.doesNotMatch(
      s.d.getElementById("notes-list")!.textContent!,
      /Stale/,
    );
    clock.advance(250);
    assert.deepEqual(
      calls.map((c) => c.query),
      ["", "c", "context"],
    );
    pending.shift()!(response("Latest result"));
    await tick();
    assert.match(
      s.d.getElementById("notes-list")!.textContent!,
      /Latest result/,
    );
  } finally {
    s.close();
  }
});

test("manual refresh, filters and paging flush note search exactly once", async () => {
  for (const action of ["refresh", "filter", "page"] as const) {
    const calls: Record<string, unknown>[] = [];
    const s = await setup(async (name, args) => {
      if (name !== "storybloq_notes") return basic(name, args);
      calls.push({ ...args });
      return {
        _meta: {
          notes: { items: [card], total: 50, offset: args.offset, limit: 24 },
        },
      };
    });
    const clock = searchClock(s.dom.window);
    try {
      s.click("nav-notes");
      await tick();
      calls.length = 0;
      s.change("notes-search", "context");
      if (action === "filter") {
        const input = s.d.getElementById("notes-status") as HTMLSelectElement;
        input.value = "all";
        input.dispatchEvent(new s.dom.window.Event("change"));
      } else s.click(action === "page" ? "notes-next" : "refresh");
      assert.equal(calls.length, 1, `${action} must dispatch without waiting`);
      assert.equal(calls[0].query, "context");
      assert.equal(calls[0].status, action === "filter" ? "all" : "active");
      assert.equal(calls[0].offset, action === "page" ? 24 : 0);
      assert.equal(clock.pending(), 0, `${action} must cancel the delay`);
      await tick();
      for (const run of clock.callbacks) run();
      clock.advance(250);
      await tick();
      assert.equal(calls.length, 1, action);
      assert.equal(calls[0].query, "context");
      assert.equal(calls[0].status, action === "filter" ? "all" : "active");
      assert.equal(calls[0].offset, action === "page" ? 24 : 0);
      assert.equal(clock.pending(), 0);
    } finally {
      s.close();
    }
  }
});

test("leaving or disposing Notes cancels pending searches, including late callbacks", async () => {
  for (const dispose of [false, true]) {
    const calls: Record<string, unknown>[] = [];
    const s = await setup(async (name, args) => {
      if (name === "storybloq_notes") calls.push({ ...args });
      return basic(name, args);
    });
    const clock = searchClock(s.dom.window);
    try {
      s.click("nav-notes");
      await tick();
      calls.length = 0;
      s.change("notes-search", "context");
      if (dispose) s.view.dispose();
      else s.click("nav-board");
      assert.equal(clock.pending(), 0);
      for (const run of clock.callbacks) run();
      clock.advance(250);
      await tick();
      assert.equal(calls.length, 0);
      if (!dispose) {
        s.click("nav-notes");
        await tick();
        assert.deepEqual(
          calls.map((c) => c.query),
          ["context"],
        );
      }
    } finally {
      s.close();
    }
  }
});

test("dirty note search schedules nothing until explicit discard", async () => {
  const calls: Record<string, unknown>[] = [];
  const s = await setup(async (name, args) => {
    if (name === "storybloq_notes") calls.push({ ...args });
    return basic(name, args);
  });
  const clock = searchClock(s.dom.window);
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-title", "Preserve my draft");
    calls.length = 0;
    s.change("notes-search", "context");
    assert.equal(clock.pending(), 0);
    s.click("note-keep-editing");
    clock.advance(250);
    assert.equal(calls.length, 0);
    assert.equal(
      (s.d.getElementById("note-title") as HTMLInputElement).value,
      "Preserve my draft",
    );
    assert.equal(
      (s.d.getElementById("notes-search") as HTMLInputElement).value,
      "",
    );
    s.change("notes-search", "context");
    s.click("note-discard-edits");
    assert.equal(calls.length, 0);
    clock.advance(250);
    await tick();
    assert.deepEqual(
      calls.map((c) => c.query),
      ["context"],
    );
    assert.equal(s.d.getElementById("note-editor")!.hidden, true);
  } finally {
    s.close();
  }
});

test("failed note reads offer read-only retry without claiming an uncertain save", async () => {
  let attempts = 0;
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_detail" && ++attempts === 1)
      return { isError: true };
    return basic(name, args);
  });
  try {
    await s.open();
    assert.match(
      s.d.getElementById("note-preview")!.textContent!,
      /could not load/i,
    );
    assert.doesNotMatch(
      s.d.getElementById("note-preview")!.textContent!,
      /save|draft/i,
    );
    const retry = s.d.getElementById("note-retry") as HTMLButtonElement;
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    s.click("note-retry");
    await tick();
    assert.match(
      s.d.getElementById("note-preview")!.textContent!,
      /Preserve context/,
    );
    assert.equal(s.d.getElementById("note-retry")!.hidden, true);
  } finally {
    s.close();
  }
});

test("failed list and editable-field reads use load wording", async () => {
  const s = await setup(async (name, args) =>
    name === "storybloq_note_editor" ? { isError: true } : basic(name, args),
  );
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    assert.match(
      s.d.getElementById("note-edit-status")!.textContent!,
      /could not load/i,
    );
    assert.doesNotMatch(
      s.d.getElementById("note-edit-status")!.textContent!,
      /save could not/,
    );
  } finally {
    s.close();
  }
  const list = await setup(async (name, args) =>
    name === "storybloq_notes" ? { isError: true } : basic(name, args),
  );
  try {
    list.click("nav-notes");
    await tick();
    assert.match(
      list.d.getElementById("notes-error")!.textContent!,
      /could not load/i,
    );
    assert.doesNotMatch(
      list.d.getElementById("notes-error")!.textContent!,
      /save|draft/i,
    );
  } finally {
    list.close();
  }
});

test("message-less save failure still preserves the uncertain draft warning", async () => {
  const s = await setup(async (name, args) =>
    name === "storybloq_note_save" ? { isError: true } : basic(name, args),
  );
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-title", "Keep this draft");
    s.click("save-note");
    await tick();
    assert.equal(
      s.d.getElementById("note-edit-status")!.textContent,
      "The save could not be confirmed. Your draft is preserved. Reload before retrying.",
    );
    assert.equal(
      (s.d.getElementById("note-title") as HTMLInputElement).value,
      "Keep this draft",
    );
  } finally {
    s.close();
  }
});

test("a late retry cannot replace a newer note selection", async () => {
  let attempts = 0;
  let finish: ((value: Awaited<ReturnType<Call>>) => void) | undefined;
  const second = {
    ...card,
    id: "N-002",
    displayId: "N-002",
    title: "Second note",
  };
  const s = await setup(async (name, args) => {
    if (name === "storybloq_notes")
      return {
        _meta: {
          notes: { items: [card, second], total: 2, offset: 0, limit: 24 },
        },
      };
    if (name === "storybloq_note_detail") {
      if (args.id === "N-002")
        return {
          _meta: {
            note: {
              ...second,
              revision,
              content: "Second body",
              offset: 0,
              nextOffset: null,
            },
          },
        };
      if (++attempts === 1) return { isError: true };
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("note-retry");
    await tick();
    s.d.querySelector<HTMLButtonElement>('[data-note-id="N-002"]')!.click();
    await tick();
    assert.ok(finish);
    finish(await basic("storybloq_note_detail", { id: "N-001" }));
    await tick();
    assert.equal(
      s.d.getElementById("note-detail-title")!.textContent,
      "Second note",
    );
    assert.equal(
      s.d.getElementById("note-preview")!.textContent,
      "Second body",
    );
    assert.equal(s.d.getElementById("note-retry")!.hidden, true);
  } finally {
    s.close();
  }
});

const draftDigest = "d".repeat(64);
const replaceRefusal = (extra: Record<string, unknown> = {}) => ({
  isError: true,
  _meta: {
    editError: {
      code: "confirm_replace_required",
      message: "Saving would replace most of this long note.",
      revision,
      draftDigest,
      ...extra,
    },
  },
});
const hidden = (s: { d: Document }, id: string) =>
  s.d.getElementById(id)!.hidden;
test("a destructive-replace refusal opens a confirm step and confirm resubmits the exact draft", async () => {
  const saves: any[] = [];
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_save") {
      saves.push(args);
      return saves.length === 1
        ? replaceRefusal()
        : {
            _meta: {
              editor: {
                ...editor,
                revision: "c".repeat(64),
                fields: { ...editor.fields, content: "Short" },
              },
            },
          };
    }
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    assert.equal(hidden(s, "note-confirm-replace"), true);
    s.change("note-content", "Short");
    s.click("save-note");
    await tick();
    assert.deepEqual(saves, [
      { id: "N-001", revision, patch: { content: "Short" } },
    ]);
    assert.equal(hidden(s, "note-confirm-replace"), false);
    assert.equal(s.d.activeElement!.id, "note-confirm-replace-title");
    assert.equal(
      (s.d.getElementById("note-content") as HTMLTextAreaElement).value,
      "Short",
    );
    s.click("note-confirm-replace-save");
    await tick();
    assert.deepEqual(saves[1], {
      id: "N-001",
      revision,
      patch: {
        content: "Short",
        confirmReplace: true,
        confirmDraftDigest: draftDigest,
      },
    });
    assert.equal(saves.length, 2);
    assert.equal(hidden(s, "note-confirm-replace"), true);
    assert.equal(s.d.activeElement!.id, "note-detail-title");
  } finally {
    s.close();
  }
});
test("cancelling or editing the draft voids replace consent without writing", async () => {
  const saves: any[] = [];
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_save") {
      saves.push(args);
      return replaceRefusal();
    }
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-content", "Short");
    s.click("save-note");
    await tick();
    s.click("note-confirm-replace-cancel");
    await tick();
    assert.equal(hidden(s, "note-confirm-replace"), true);
    assert.equal(saves.length, 1);
    assert.equal(
      (s.d.getElementById("note-content") as HTMLTextAreaElement).value,
      "Short",
    );
    s.click("note-confirm-replace-save");
    await tick();
    assert.equal(saves.length, 1);
    s.click("save-note");
    await tick();
    assert.equal(hidden(s, "note-confirm-replace"), false);
    s.change("note-content", "Short, then edited");
    assert.equal(hidden(s, "note-confirm-replace"), true);
    s.click("note-confirm-replace-save");
    await tick();
    assert.equal(saves.length, 2);
    s.click("save-note");
    await tick();
    assert.deepEqual(saves[2], {
      id: "N-001",
      revision,
      patch: { content: "Short, then edited" },
    });
  } finally {
    s.close();
  }
});
test("only a well-formed confirm_replace_required refusal opens the confirm step", async () => {
  const responses = [
    {
      isError: true,
      _meta: {
        editError: {
          code: "invalid_input",
          message: "Check content, tags and status.",
          revision,
          draftDigest,
        },
      },
    },
    replaceRefusal({ draftDigest: "not-a-digest" }),
    replaceRefusal({ revision: "e".repeat(64) }),
    replaceRefusal({ draftDigest: undefined }),
  ];
  const saves: any[] = [];
  const s = await setup(async (name, args) => {
    if (name === "storybloq_note_save") {
      saves.push(args);
      return responses[saves.length - 1];
    }
    return basic(name, args);
  });
  try {
    await s.open();
    s.click("edit-note");
    await tick();
    s.change("note-content", "Short");
    for (let i = 0; i < responses.length; i++) {
      s.click("save-note");
      await tick();
      assert.equal(hidden(s, "note-confirm-replace"), true, String(i));
      assert.equal(
        (s.d.getElementById("note-content") as HTMLTextAreaElement).value,
        "Short",
      );
    }
    assert.equal(saves.length, responses.length);
  } finally {
    s.close();
  }
});
