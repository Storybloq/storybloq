import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { mountBoard } from "../src/view.js";
import { startAutoRefresh } from "../src/polling.js";
import { columns, type Overview, type Card } from "../src/board-types.js";
const card: Card = {
  key: "ticket:T-001",
  id: "T-001",
  displayId: "T-001",
  title: "<img src=x onerror=alert(1)>",
  kind: "tickets",
  blocked: false,
  severity: null,
  description: "A description <script>inert()</script>",
  tags: ["task", "<img src=x>"],
  phaseKey: null,
};
const data: Overview = {
  project: "Demo",
  loadedAt: "2026-09-29T12:00:00Z",
  currentPhase: null,
  phases: [],
  hasUnphased: true,
  summary: {
    total: 1,
    complete: 0,
    blocked: 0,
    openIssues: 1,
    severity: { high: 1 },
  },
  limit: 6,
  columns: {
    open: { items: [card], total: 1, offset: 0 },
    inProgress: { items: [], total: 0, offset: 0 },
    done: { items: [], total: 0, offset: 0 },
  },
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const result = (overview = data) => ({ _meta: { overview } });
async function setup(call: Parameters<typeof mountBoard>[1]) {
  const dom = new JSDOM(await readFile("src/app.html", "utf8"));
  const d = dom.window.document,
    view = mountBoard(d, call);
  const click = (id: string) =>
    (d.getElementById(id) as HTMLButtonElement).click();
  return { dom, d, view, click };
}
test("Mac phase rail selects and toggles phases without losing search or type, resets pages and preserves focus", async () => {
  const calls: any[] = [];
  const phased = {
    ...data,
    phases: [
      {
        key: "a".repeat(64),
        name: "First",
        label: "01",
        status: "inprogress",
        current: true,
      },
    ],
    hasUnphased: true,
    columns: Object.fromEntries(
      columns.map((c) => [c, { items: [card], offset: 0, total: 20 }]),
    ) as Overview["columns"],
  };
  const { d, view, click, dom } = await setup(async (_name, args) => {
    calls.push(args);
    return result({
      ...phased,
      columns: Object.fromEntries(
        columns.map((c) => [
          c,
          { ...phased.columns[c], offset: Number(args[c]) },
        ]),
      ) as Overview["columns"],
    });
  });
  view.receive(result(phased as any));
  click("issues");
  await tick();
  (d.getElementById("search") as HTMLInputElement).value = "needle";
  d.getElementById("search-form")!.dispatchEvent(
    new dom.window.Event("submit", { cancelable: true }),
  );
  await tick();
  for (const column of columns) {
    click(`${column}-next`);
    await tick();
  }
  assert.equal(calls.at(-1).open, 6);
  assert.equal(calls.at(-1).inProgress, 6);
  assert.equal(calls.at(-1).done, 6);
  const phase = d.querySelector(
    '[data-phase="' + "a".repeat(64) + '"]',
  ) as HTMLButtonElement;
  assert.ok(phase);
  phase.focus();
  phase.click();
  await tick();
  assert.equal(calls.at(-1).phase, "a".repeat(64));
  assert.equal(calls.at(-1).kind, "issues");
  assert.equal(calls.at(-1).query, "needle");
  assert.equal(calls.at(-1).open, 0);
  assert.equal(calls.at(-1).inProgress, 0);
  assert.equal(calls.at(-1).done, 0);
  assert.equal((d.activeElement as HTMLElement).dataset.phase, "a".repeat(64));
  assert.equal(d.activeElement!.getAttribute("aria-pressed"), "true");
  (d.activeElement as HTMLButtonElement).click();
  await tick();
  assert.equal(calls.at(-1).phase, "all");
  (d.querySelector('[data-phase="unphased"]') as HTMLButtonElement).click();
  await tick();
  assert.equal(calls.at(-1).phase, "unphased");
  view.dispose();
  dom.window.close();
});
test("an active Unphased filter keeps its toggle after the last unphased item gains a phase", async (t) => {
  const calls: any[] = [];
  let unphasedLeft = true;
  const { d, view, dom } = await setup(async (_name, args) => {
    calls.push(args);
    return result({ ...data, hasUnphased: unphasedLeft });
  });
  t.after(() => {
    view.dispose();
    dom.window.close();
  });
  view.receive(result());
  const toggle = () =>
    d.querySelector('[data-phase="unphased"]') as HTMLButtonElement | null;
  toggle()!.click();
  await tick();
  assert.equal(calls.at(-1).phase, "unphased");
  unphasedLeft = false;
  await view.refresh();
  assert.equal(calls.at(-1).phase, "unphased");
  assert.ok(toggle(), "the active filter stays visible and clearable");
  assert.equal(toggle()!.getAttribute("aria-pressed"), "true");
  toggle()!.click();
  await tick();
  assert.equal(calls.at(-1).phase, "all");
  assert.equal(toggle(), null);
});
test("attention and muted text remain readable on normal and changed Fabric cards in both themes", async () => {
  const html = await readFile("src/app.html", "utf8");
  const luminance = (hex: string) => {
    const channels = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const themes = [
    html.match(/:root\s*\{([^}]+)\}/)![1],
    html.match(/html\[data-theme="dark"\]\s*\{([^}]+)\}/)![1],
  ];
  for (const css of themes) {
    const token = (name: string) =>
      css.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{6})`))![1];
    for (const text of ["danger", "muted"])
      for (const background of ["card", "wash", "paper"]) {
        const a = luminance(token(text)),
          b = luminance(token(background));
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        assert.ok(
          ratio >= 4.5,
          `${text} on ${background}: ${ratio.toFixed(2)}:1`,
        );
      }
  }
});
test("inert content, details, close focus and error recovery", async () => {
  let fail = false;
  const s = await setup(async (name) => {
    if (fail) throw Error("untrusted raw error");
    return name.endsWith("detail")
      ? {
          _meta: {
            item: { description: "<script>bad()</script>", truncated: false },
          },
        }
      : result();
  });
  const { d, view, click, dom } = s;
  view.receive(result());
  assert.equal(d.querySelector(".board img"), null);
  assert.equal(d.querySelector(".tags img"), null);
  assert.match(d.querySelector(".description")!.textContent!, /<script>/);
  const row = d.querySelector(".item") as HTMLButtonElement;
  row.click();
  await tick();
  assert.equal(row.getAttribute("aria-pressed"), "true");
  assert.ok(
    d.getElementById("board-layout")!.classList.contains("detail-open"),
  );
  assert.equal(d.activeElement?.id, "detail-title");
  assert.match(d.getElementById("detail")!.textContent!, /<script>/);
  assert.equal(d.querySelector("#detail script"), null);
  click("close-detail");
  assert.equal(row.getAttribute("aria-pressed"), "false");
  assert.ok(
    !d.getElementById("board-layout")!.classList.contains("detail-open"),
  );
  assert.equal(d.activeElement, row);
  assert.equal(d.getElementById("detail")!.hidden, true);
  fail = true;
  click("refresh");
  await tick();
  assert.match(d.getElementById("status")!.textContent!, /could not/i);
  assert.ok(!d.body.textContent!.includes("untrusted raw error"));
  assert.equal((d.querySelector(".item") as HTMLButtonElement).disabled, true);
  fail = false;
  click("refresh");
  await tick();
  assert.match(d.getElementById("status")!.textContent!, /1 matching/);
  view.dispose();
  dom.window.close();
});
test("late board results cannot replace current results or enable obsolete rows", async () => {
  const pending: ((r: any) => void)[] = [];
  let details = 0;
  const { d, view, click, dom } = await setup((name) => {
    if (name.endsWith("detail")) details++;
    return new Promise((r) => pending.push(r));
  });
  view.receive(result());
  const old = d.querySelector(".item") as HTMLButtonElement;
  click("refresh");
  click("issues");
  old.click();
  assert.equal(details, 0);
  assert.equal(old.disabled, true);
  pending[1](result({ ...data, project: "Newest" }));
  await tick();
  pending[0](result({ ...data, project: "Old" }));
  await tick();
  assert.equal(d.getElementById("project")!.textContent, "Newest");
  view.dispose();
  dom.window.close();
});
test("mixed rows route canonical kind and ID; closed or superseded details never return", async () => {
  const calls: any[] = [],
    pending: ((r: any) => void)[] = [];
  const issue: Card = {
    ...card,
    key: "issue:i-0123456789abcdef",
    id: "i-0123456789abcdef",
    displayId: "ISS-001",
    kind: "issues",
    severity: "high",
  };
  const { d, view, click, dom } = await setup((name, args) => {
    calls.push({ name, args });
    return new Promise((r) => pending.push(r));
  });
  view.receive(
    result({
      ...data,
      columns: {
        ...data.columns,
        open: { items: [card, issue], total: 2, offset: 0 },
      },
    }),
  );
  d.querySelectorAll<HTMLButtonElement>(".item")[1].click();
  assert.deepEqual(calls[0].args, { kind: "issues", id: issue.id });
  click("close-detail");
  pending[0]({ _meta: { item: { description: "OBSOLETE" } } });
  await tick();
  assert.ok(!d.body.textContent!.includes("OBSOLETE"));
  d.querySelector<HTMLButtonElement>(".item")!.click();
  click("refresh");
  pending[2](result());
  await tick();
  pending[1]({ _meta: { item: { description: "OLD DETAIL" } } });
  await tick();
  assert.equal(d.getElementById("detail")!.hidden, true);
  assert.ok(!d.body.textContent!.includes("OLD DETAIL"));
  view.dispose();
  dom.window.close();
});
test("independent pagination, applied search, kind filters and empty states", async () => {
  const calls: any[] = [];
  const large = {
    ...data,
    columns: {
      ...data.columns,
      open: { ...data.columns.open, total: 9000 },
      done: { ...data.columns.done, total: 20 },
    },
  };
  const { d, view, click, dom } = await setup(async (_name, args) => {
    calls.push(args);
    return result({
      ...large,
      columns: Object.fromEntries(
        columns.map((c) => [
          c,
          { ...large.columns[c], offset: Number(args[c]) },
        ]),
      ) as Overview["columns"],
    });
  });
  view.receive(result(large));
  click("open-next");
  await tick();
  click("done-next");
  await tick();
  assert.equal(calls[1].open, 6);
  assert.equal(calls[1].done, 6);
  assert.equal(calls[1].inProgress, 0);
  const search = d.getElementById("search") as HTMLInputElement;
  search.value = "blocked";
  assert.equal(calls.length, 2);
  d.getElementById("search-form")!.dispatchEvent(
    new dom.window.Event("submit", { cancelable: true }),
  );
  await tick();
  assert.equal(calls[2].query, "blocked");
  assert.equal(calls[2].open, 0);
  assert.equal(calls[2].done, 0);
  click("tickets");
  await tick();
  assert.equal(calls[3].kind, "tickets");
  assert.equal(
    d.getElementById("tickets")!.getAttribute("aria-pressed"),
    "true",
  );
  assert.match(d.getElementById("issue-count")!.textContent!, /Whole project/);
  assert.match(
    d.getElementById("inProgress-items")!.textContent!,
    /No matching/,
  );
  view.dispose();
  dom.window.close();
});
test("controlled server repair messages are actionable and raw content stays hidden", async () => {
  const { d, view, click, dom } = await setup(async () => ({
    isError: true,
    _meta: {
      boardError: {
        code: "storybloq_board_error",
        message: "A transaction is pending. Finish it locally.",
      },
    },
  }));
  view.receive(result());
  click("refresh");
  await tick();
  assert.match(d.getElementById("error")!.textContent!, /Finish it locally/);
  view.dispose();
  dom.window.close();
});
test("polling cadence, visibility, busy/detail suppression, initial result and teardown", async () => {
  let callback!: () => void,
    duration = 0,
    schedules = 0,
    cancellations = 0,
    visible = true;
  const calls: any[] = [],
    pending: ((r: any) => void)[] = [];
  const { d, view, click, dom } = await setup((name, args) => {
    calls.push({ name, args });
    return new Promise((r) => pending.push(r));
  });
  const stop = startAutoRefresh(
    () => view.autoRefresh(),
    () => visible,
    (fn, ms) => {
      schedules++;
      callback = fn;
      duration = ms;
      return 42;
    },
    (timer) => {
      assert.equal(timer, 42);
      cancellations++;
    },
  );
  assert.equal(duration, 30000);
  assert.equal(schedules, 1);
  callback();
  assert.equal(calls.length, 0);
  view.receive(result());
  assert.equal(calls.length, 0);
  visible = false;
  callback();
  assert.equal(calls.length, 0);
  visible = true;
  callback();
  callback();
  assert.equal(calls.length, 1);
  pending[0](result());
  await tick();
  d.querySelector<HTMLButtonElement>(".item")!.click();
  callback();
  assert.equal(calls.length, 2);
  click("close-detail");
  callback();
  assert.equal(calls.length, 3);
  stop();
  stop();
  view.dispose();
  callback();
  view.autoRefresh();
  assert.equal(calls.length, 3);
  assert.equal(cancellations, 1);
  pending[2](result({ ...data, project: "After disposal" }));
  await tick();
  assert.equal(d.getElementById("project")!.textContent, "Demo");
  dom.window.close();
});
test("background refresh preserves row focus and only real state changes highlight", async () => {
  const changed = {
    ...data,
    columns: {
      ...data.columns,
      open: { ...data.columns.open, items: [{ ...card, blocked: true }] },
    },
  };
  const { d, view, dom } = await setup(async () => result(changed));
  view.receive(result());
  assert.equal(d.querySelector(".changed"), null);
  d.querySelector<HTMLButtonElement>(".item")!.focus();
  view.autoRefresh();
  await tick();
  assert.equal((d.activeElement as HTMLElement).dataset.key, card.key);
  assert.equal(d.querySelectorAll(".changed").length, 1);
  view.autoRefresh();
  await tick();
  assert.equal(d.querySelector(".changed"), null);
  view.dispose();
  dom.window.close();
});

test("background refresh restores browser-blurred focus but respects newly moved focus", async () => {
  let finish!: (r: any) => void;
  const { d, view, dom } = await setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  view.receive(result());
  d.querySelector<HTMLButtonElement>(".item")!.focus();
  view.autoRefresh();
  // Native browsers can blur a focused button when it becomes disabled.
  d.body.tabIndex = -1;
  d.body.focus();
  finish(result());
  await tick();
  assert.equal((d.activeElement as HTMLElement).dataset.key, card.key);
  view.autoRefresh();
  d.getElementById("search")!.focus();
  finish(result());
  await tick();
  assert.equal(d.activeElement?.id, "search");
  view.dispose();
  dom.window.close();
});

test("manual pagination restores a nearby pager when its button becomes unavailable", async () => {
  let finish!: (r: any) => void;
  const { d, view, click, dom } = await setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  view.receive(
    result({
      ...data,
      columns: { ...data.columns, open: { ...data.columns.open, total: 7 } },
    }),
  );
  d.getElementById("open-next")!.focus();
  click("open-next");
  d.body.tabIndex = -1;
  d.body.focus();
  finish(
    result({
      ...data,
      columns: {
        ...data.columns,
        open: { items: [card], total: 7, offset: 6 },
      },
    }),
  );
  await tick();
  assert.equal(d.activeElement?.id, "open-previous");
  view.dispose();
  dom.window.close();
});

test("detail completion is announced without moving focus again", async () => {
  let finish!: (r: any) => void;
  const { d, view, dom } = await setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  view.receive(result());
  d.querySelector<HTMLButtonElement>(".item")!.click();
  d.getElementById("close-detail")!.focus();
  finish({
    _meta: { item: { description: "Loaded content", truncated: false } },
  });
  await tick();
  assert.match(d.getElementById("status")!.textContent!, /Details loaded/);
  assert.equal(d.activeElement?.id, "close-detail");
  view.dispose();
  dom.window.close();
});

test("responsive columns keep DOM reading order aligned with visual order and remove listeners", async () => {
  const dom = new JSDOM(await readFile("src/app.html", "utf8"));
  const d = dom.window.document;
  let callback!: () => void,
    removed = 0;
  const media = {
    matches: true,
    addEventListener(_name: string, fn: () => void) {
      callback = fn;
    },
    removeEventListener() {
      removed++;
    },
  };
  Object.defineProperty(dom.window, "matchMedia", { value: () => media });
  const view = mountBoard(d, async () => result());
  assert.equal(
    d.querySelector(".board")!.firstElementChild?.id,
    "inProgress-column",
  );
  media.matches = false;
  callback();
  assert.equal(d.querySelector(".board")!.firstElementChild?.id, "open-column");
  view.dispose();
  assert.equal(removed, 1);
  dom.window.close();
});

test("type filter disclosure dismisses without reads and applies a visible selection beside search", async () => {
  const calls: any[] = [];
  const { d, dom, view, click } = await setup(async (_name, args) => {
    calls.push(args);
    return result();
  });
  try {
    view.receive(result());
    const trigger = d.getElementById("filter-toggle")!;
    const panel = d.getElementById("filter-options")!;
    const input = d.getElementById("search") as HTMLInputElement;
    assert.ok(d.getElementById("search-form")!.contains(trigger));
    assert.equal(panel.hidden, true);
    trigger.focus();
    click("filter-toggle");
    assert.equal(panel.hidden, false);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    d.getElementById("issues")!.focus();
    d.getElementById("issues")!.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(panel.hidden, true);
    assert.equal(d.activeElement, trigger);
    click("filter-toggle");
    input.focus();
    assert.equal(panel.hidden, true);
    click("filter-toggle");
    d.body.click();
    assert.equal(panel.hidden, true);
    assert.equal(calls.length, 0);
    input.value = "needle";
    d.getElementById("search-form")!.dispatchEvent(
      new dom.window.Event("submit", { cancelable: true }),
    );
    await tick();
    click("filter-toggle");
    click("issues");
    await tick();
    assert.equal(calls.at(-1).kind, "issues");
    assert.equal(calls.at(-1).query, "needle");
    assert.equal(calls.at(-1).open, 0);
    assert.equal(panel.hidden, true);
    assert.equal(trigger.textContent!.trim(), "Filter: Issues");
    assert.equal(d.activeElement, trigger);
    assert.equal(
      d.getElementById("issues")!.getAttribute("aria-pressed"),
      "true",
    );
    const before = calls.length;
    click("filter-toggle");
    click("issues");
    await tick();
    assert.equal(calls.length, before);
    click("filter-toggle");
    click("all");
    await tick();
    assert.equal(trigger.textContent!.trim(), "Filter");
    assert.equal(calls.at(-1).kind, "all");
  } finally {
    view.dispose();
    dom.window.close();
  }
});

test("filter disclosure closes on deactivation and disposed controls cannot change it or request data", async () => {
  let calls = 0;
  const { d, dom, view, click } = await setup(async () => {
    calls++;
    return result();
  });
  try {
    const trigger = d.getElementById("filter-toggle")!;
    const panel = d.getElementById("filter-options")!;
    trigger.focus();
    click("filter-toggle");
    view.setActive(false);
    assert.equal(panel.hidden, true);
    click("filter-toggle");
    click("issues");
    assert.equal(panel.hidden, true);
    assert.equal(calls, 0);
    view.setActive(true);
    click("filter-toggle");
    assert.equal(panel.hidden, false);
    view.dispose();
    assert.equal(panel.hidden, true);
    click("filter-toggle");
    click("issues");
    d.body.click();
    assert.equal(panel.hidden, true);
    assert.equal(calls, 0);
  } finally {
    view.dispose();
    dom.window.close();
  }
});
