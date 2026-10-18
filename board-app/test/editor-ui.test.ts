import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { mountWorkspace } from "../src/workspace-view.js";
import type { Call } from "../src/view-utils.js";
const phase = "a".repeat(64),
  revision = "b".repeat(64);
const card = {
  key: "ticket:T-001",
  id: "T-001",
  displayId: "T-001",
  title: "Original",
  kind: "tickets",
  blocked: false,
  severity: null,
  description: "Short preview",
  tags: [],
  phaseKey: phase,
};
const overview = {
  project: "Demo",
  loadedAt: "2026-09-30T12:00:00Z",
  currentPhase: { id: "p1", name: "First", status: "inprogress" },
  phases: [
    {
      key: phase,
      name: "First",
      label: "01",
      status: "inprogress",
      current: true,
    },
  ],
  hasUnphased: false,
  summary: { total: 1, complete: 0, blocked: 0, openIssues: 0, severity: {} },
  limit: 6,
  columns: {
    open: { items: [card], total: 1, offset: 0 },
    inProgress: { items: [], total: 0, offset: 0 },
    done: { items: [], total: 0, offset: 0 },
  },
};
const editor = {
  kind: "tickets",
  id: "T-001",
  displayId: "T-001",
  revision,
  fields: {
    title: "Original",
    description: "Full body ".repeat(1600),
    type: "task",
    status: "open",
    phase,
    blockedBy: [],
    crossNodeBlockedBy: [],
  },
  limitedFields: [],
  phases: [{ key: phase, name: "First" }],
  canReopen: false,
};
const basic: Call = async (name) => ({
  _meta:
    name === "storybloq_item_editor"
      ? { editor }
      : name === "storybloq_board_detail"
        ? { item: { description: "Short preview", truncated: true } }
        : { overview },
});
const tick = () => new Promise((r) => setTimeout(r, 0));
async function setup(call: Call = basic, board = overview) {
  const dom = new JSDOM(await readFile("src/app.html", "utf8")),
    d = dom.window.document,
    view = mountWorkspace(d, call);
  view.receive({ _meta: { overview: board } });
  d.querySelector<HTMLButtonElement>(".item")!.click();
  await tick();
  const click = (id: string) => {
    const b = d.getElementById(id) as HTMLButtonElement;
    assert.ok(b, id + " exists");
    b.click();
  };
  const change = (id: string, text: string) => {
    const input = d.getElementById(id) as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  return {
    dom,
    d,
    view,
    click,
    change,
    close: () => {
      view.dispose();
      dom.window.close();
    },
  };
}
test("Edit loads full text, saves changed fields only and disables duplicate pending saves", async () => {
  let resolveSave: any;
  const calls: any[] = [];
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    return name === "storybloq_item_save"
      ? new Promise<any>((resolve) => {
          resolveSave = resolve;
        })
      : basic(name, args);
  });
  try {
    s.click("edit-item");
    await tick();
    assert.equal(s.d.activeElement!.id, "edit-title");
    assert.equal(
      (s.d.getElementById("edit-description") as HTMLTextAreaElement).value,
      editor.fields.description,
    );
    s.change("edit-title", "Changed");
    s.click("save-item");
    assert.equal(
      (s.d.getElementById("save-item") as HTMLButtonElement).disabled,
      true,
    );
    assert.deepEqual(calls.at(-1).args, {
      kind: "tickets",
      id: "T-001",
      revision,
      patch: { title: "Changed" },
    });
    resolveSave({
      _meta: {
        editor: {
          ...editor,
          revision: "c".repeat(64),
          fields: { ...editor.fields, title: "Changed" },
        },
      },
    });
    await tick();
    assert.equal(s.d.activeElement!.id, "detail-title");
    assert.match(s.d.getElementById("detail-title")!.textContent!, /Changed/);
    assert.equal(s.d.getElementById("detail")!.hidden, false);
  } finally {
    s.close();
  }
});
test("conflict preserves draft and focuses a connected comparison heading", async () => {
  const s = await setup(async (name, args) =>
    name === "storybloq_item_save"
      ? {
          isError: true,
          _meta: {
            editError: {
              code: "conflict",
              message: "This item changed. Your draft is preserved.",
            },
          },
        }
      : basic(name, args),
  );
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-title", "My draft");
    s.click("save-item");
    await tick();
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "My draft",
    );
    assert.equal(s.d.activeElement!.id, "edit-conflict-title");
    assert.equal(s.d.activeElement!.isConnected, true);
    assert.match(
      s.d.getElementById("edit-status")!.textContent!,
      /draft is preserved/i,
    );
  } finally {
    s.close();
  }
});
for (const [currentPhase, expected] of [
  [phase, "Renamed phase"],
  [null, "Unphased"],
  ["c".repeat(64), "Phase unavailable"],
] as const) {
  test(`conflict comparison renders ${expected} without exposing a phase key`, async () => {
    let reads = 0;
    const s = await setup(async (name, args) => {
      if (name === "storybloq_item_save")
        return {
          isError: true,
          _meta: {
            editError: { code: "conflict", message: "Changed elsewhere." },
          },
        };
      if (name === "storybloq_item_editor" && ++reads > 1)
        return {
          _meta: {
            editor: {
              ...editor,
              fields: { ...editor.fields, phase: currentPhase },
              phases: [{ key: phase, name: "Renamed phase" }],
            },
          },
        };
      return basic(name, args);
    });
    try {
      s.click("edit-item");
      await tick();
      s.change("edit-title", "My draft");
      s.click("save-item");
      await tick();
      const comparison = s.d.getElementById("current-values")!.textContent!;
      assert.ok(comparison.includes(`Phase: ${expected}`));
      assert.doesNotMatch(comparison, /[a-f0-9]{64}/);
      assert.equal(
        (s.d.getElementById("edit-title") as HTMLInputElement).value,
        "My draft",
      );
    } finally {
      s.close();
    }
  });
}
test("dirty Escape and navigation require explicit discard while refresh retains draft", async () => {
  const s = await setup();
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-title", "Unsaved");
    s.d.getElementById("edit-title")!.dispatchEvent(
      new s.dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(s.d.getElementById("detail")!.hidden, false);
    assert.equal(s.d.getElementById("edit-discard")!.hidden, false);
    s.click("keep-editing");
    assert.equal(s.d.activeElement!.id, "edit-title");
    s.click("refresh");
    await tick();
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "Unsaved",
    );
    s.click("nav-timeline");
    assert.equal(s.d.getElementById("board-screen")!.hidden, false);
    s.click("discard-edits");
    await tick();
    assert.equal(s.d.getElementById("timeline-screen")!.hidden, false);
    assert.equal(s.d.activeElement!.id, "nav-timeline");
    assert.equal(s.d.activeElement!.isConnected, true);
  } finally {
    s.close();
  }
});
test("clicking the current Board screen keeps a dirty editor without a discard prompt", async () => {
  const s = await setup();
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-title", "Unsaved");
    s.click("nav-board");
    assert.equal(s.d.getElementById("board-screen")!.hidden, false);
    assert.equal(s.d.getElementById("edit-discard")!.hidden, true);
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "Unsaved",
    );
  } finally {
    s.close();
  }
});
test("Cancel restores Edit focus and oversized fields remain disabled without entering the patch", async () => {
  const s = await setup(async (name, args) =>
    name === "storybloq_item_editor"
      ? { _meta: { editor: { ...editor, limitedFields: ["description"] } } }
      : basic(name, args),
  );
  try {
    s.click("edit-item");
    await tick();
    assert.equal(
      (s.d.getElementById("edit-description") as HTMLTextAreaElement).disabled,
      true,
    );
    s.change("edit-title", "Draft");
    s.click("cancel-item");
    assert.equal(s.d.activeElement!.id, "edit-item");
  } finally {
    s.close();
  }
});
test("a pending save prevents navigation and a disposed view ignores its late acknowledgement", async () => {
  let resolveSave: any;
  const s = await setup(async (name, args) =>
    name === "storybloq_item_save"
      ? new Promise<any>((resolve) => {
          resolveSave = resolve;
        })
      : basic(name, args),
  );
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-title", "Pending");
    s.click("save-item");
    s.click("nav-timeline");
    assert.equal(s.d.getElementById("board-screen")!.hidden, false);
    s.view.dispose();
    const before = s.d.getElementById("detail-title")!.textContent;
    resolveSave({
      _meta: {
        editor: { ...editor, fields: { ...editor.fields, title: "Late" } },
      },
    });
    await tick();
    assert.equal(s.d.getElementById("detail-title")!.textContent, before);
  } finally {
    s.close();
  }
});
test("a discard prompt left open during a pending save cannot discard or navigate until the save settles", async () => {
  let resolveSave: any;
  const calls: string[] = [];
  const s = await setup(async (name, args) => {
    calls.push(name);
    return name === "storybloq_item_save"
      ? new Promise<any>((resolve) => {
          resolveSave = resolve;
        })
      : basic(name, args);
  });
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-title", "Pending");
    s.click("nav-timeline");
    assert.equal(s.d.getElementById("edit-discard")!.hidden, false);
    s.click("save-item");
    assert.equal(
      (s.d.getElementById("discard-edits") as HTMLButtonElement).disabled,
      true,
    );
    s.click("discard-edits");
    // The handler refuses on its own too, not only through the disabled control.
    const discard = s.d.getElementById("discard-edits") as HTMLButtonElement;
    discard.onclick!.call(
      discard,
      new s.dom.window.MouseEvent("click") as unknown as PointerEvent,
    );
    await tick();
    assert.equal(s.d.getElementById("board-screen")!.hidden, false);
    assert.equal(s.d.getElementById("timeline-screen")!.hidden, true);
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "Pending",
    );
    resolveSave({
      _meta: {
        editor: { ...editor, fields: { ...editor.fields, title: "Pending" } },
      },
    });
    await tick();
    assert.equal(s.d.getElementById("timeline-screen")!.hidden, true);
    assert.equal(calls.filter((c) => c === "storybloq_item_save").length, 1);
  } finally {
    s.close();
  }
});
test("an edit made after the reopen confirmation opens is not silently dropped by confirming", async () => {
  const calls: any[] = [];
  const completed = {
    ...editor,
    canReopen: true,
    fields: { ...editor.fields, status: "complete" },
  };
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    if (name === "storybloq_item_editor")
      return { _meta: { editor: completed } };
    if (name === "storybloq_ticket_reopen") return { _meta: { editor } };
    return basic(name, args);
  });
  try {
    s.click("edit-item");
    await tick();
    s.click("reopen-item");
    assert.equal(s.d.getElementById("reopen-confirmation")!.hidden, false);
    s.change("edit-title", "Late edit");
    s.click("confirm-reopen");
    await tick();
    assert.equal(
      calls.some((c) => c.name === "storybloq_ticket_reopen"),
      false,
    );
    assert.equal(s.d.getElementById("edit-discard")!.hidden, false);
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "Late edit",
    );
    s.click("keep-editing");
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "Late edit",
    );
    s.click("reopen-item");
    s.click("discard-edits");
    assert.equal(s.d.getElementById("reopen-confirmation")!.hidden, false);
    s.click("confirm-reopen");
    await tick();
    assert.deepEqual(
      calls.find((c) => c.name === "storybloq_ticket_reopen").args,
      { id: "T-001", revision },
    );
  } finally {
    s.close();
  }
});
test("ticket reopening is a separate deliberate action with no arbitrary update fields", async () => {
  const calls: any[] = [];
  const completed = {
    ...editor,
    canReopen: true,
    fields: { ...editor.fields, status: "complete" },
  };
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    if (name === "storybloq_item_editor")
      return { _meta: { editor: completed } };
    if (name === "storybloq_ticket_reopen") return { _meta: { editor } };
    return basic(name, args);
  });
  try {
    s.click("edit-item");
    await tick();
    assert.equal(
      (s.d.getElementById("edit-status-field") as HTMLSelectElement).disabled,
      true,
    );
    s.click("reopen-item");
    assert.equal(
      calls.some((c) => c.name === "storybloq_ticket_reopen"),
      false,
    );
    assert.equal(s.d.getElementById("reopen-confirmation")!.hidden, false);
    s.click("confirm-reopen");
    await tick();
    assert.deepEqual(
      calls.find((c) => c.name === "storybloq_ticket_reopen").args,
      { id: "T-001", revision },
    );
    assert.equal(
      calls.some((c) => c.name === "storybloq_item_save"),
      false,
    );
  } finally {
    s.close();
  }
});
test("an issue editor submits impact, severity and resolution through the issue tool contract", async () => {
  const item = {
    ...editor,
    kind: "issues",
    id: "ISS-001",
    displayId: "ISS-001",
    fields: {
      title: "Original issue",
      impact: "Full impact",
      resolution: null,
      severity: "high",
      status: "open",
      phase,
    },
  };
  const issueCard = {
    ...card,
    key: "issue:ISS-001",
    kind: "issues",
    id: "ISS-001",
    displayId: "ISS-001",
  };
  let saved: any;
  const s = await setup(
    async (name, args) => {
      if (name === "storybloq_item_editor") return { _meta: { editor: item } };
      if (name === "storybloq_item_save") {
        saved = args;
        return {
          _meta: {
            editor: {
              ...item,
              fields: { ...item.fields, ...(args.patch as object) },
            },
          },
        };
      }
      return basic(name, args);
    },
    {
      ...overview,
      columns: {
        ...overview.columns,
        open: { items: [issueCard], total: 1, offset: 0 },
      },
    },
  );
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-impact", "Revised impact");
    s.change("edit-severity", "critical");
    s.change("edit-resolution", "Fixed and verified");
    s.click("save-item");
    await tick();
    assert.deepEqual(saved, {
      kind: "issues",
      id: "ISS-001",
      revision,
      patch: {
        impact: "Revised impact",
        severity: "critical",
        resolution: "Fixed and verified",
      },
    });
  } finally {
    s.close();
  }
});
test("a saved item can leave its phase filter while the inspector remains and Close restores phase focus", async () => {
  let saved = false;
  const s = await setup(async (name, args) => {
    if (name === "storybloq_item_save") {
      saved = true;
      return {
        _meta: {
          editor: {
            ...editor,
            revision: "c".repeat(64),
            fields: { ...editor.fields, phase: null },
          },
        },
      };
    }
    if (name === "storybloq_board_overview" && saved)
      return {
        _meta: {
          overview: {
            ...overview,
            columns: {
              ...overview.columns,
              open: { items: [], total: 0, offset: 0 },
            },
          },
        },
      };
    return basic(name, args);
  });
  try {
    (s.d.querySelector(`[data-phase="${phase}"]`) as HTMLButtonElement).click();
    await tick();
    s.d.querySelector<HTMLButtonElement>(".item")!.click();
    await tick();
    s.click("edit-item");
    await tick();
    s.change("edit-phase", "");
    s.click("save-item");
    await tick();
    assert.equal(s.d.querySelector(".item"), null);
    assert.equal(s.d.getElementById("detail")!.hidden, false);
    assert.equal(s.d.activeElement!.id, "detail-title");
    assert.equal(
      (s.d.getElementById("edit-item") as HTMLButtonElement).disabled,
      false,
    );
    s.click("close-detail");
    assert.equal((s.d.activeElement as HTMLElement).dataset.phase, phase);
  } finally {
    s.close();
  }
});
test("uncertain save failure keeps draft values and announces a safe error", async () => {
  const s = await setup(async (name, args) => {
    if (name === "storybloq_item_save")
      throw new Error("PRIVATE transport detail");
    return basic(name, args);
  });
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-title", "Keep this draft");
    s.click("save-item");
    await tick();
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "Keep this draft",
    );
    assert.equal(
      (s.d.getElementById("save-item") as HTMLButtonElement).disabled,
      false,
    );
    assert.match(
      s.d.getElementById("edit-status")!.textContent!,
      /could not be confirmed.*draft is preserved/i,
    );
    assert.ok(!s.d.body.textContent!.includes("PRIVATE transport detail"));
  } finally {
    s.close();
  }
});

test("filter selection preserves a dirty draft until discard and keeps the accepted label on cancel", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    return basic(name, args);
  });
  try {
    s.click("edit-item");
    await tick();
    s.change("edit-title", "Unsaved");
    const count = calls.length;
    s.click("filter-toggle");
    s.click("issues");
    assert.equal(s.d.getElementById("filter-options")!.hidden, true);
    assert.equal(s.d.getElementById("edit-discard")!.hidden, false);
    assert.equal(s.d.getElementById("filter-label")!.textContent, "Filter");
    assert.equal(calls.length, count);
    s.click("keep-editing");
    assert.equal(
      (s.d.getElementById("edit-title") as HTMLInputElement).value,
      "Unsaved",
    );
    assert.equal(s.d.activeElement!.id, "filter-toggle");
    s.click("filter-toggle");
    s.click("issues");
    s.click("discard-edits");
    await tick();
    assert.equal(calls.at(-1)!.args.kind, "issues");
    assert.equal(
      s.d.getElementById("filter-label")!.textContent,
      "Filter: Issues",
    );
    assert.equal(s.d.getElementById("detail")!.hidden, true);
  } finally {
    s.close();
  }
});
