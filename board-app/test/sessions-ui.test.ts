import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { mountWorkspace } from "../src/workspace-view.js";
import type { Call } from "../src/view-utils.js";

const loadedAt = new Date().toISOString();
const empty = {
  loadedAt,
  status: { kind: "inactive" },
  presence: {
    items: [],
    total: 0,
    offset: 0,
    limit: 20,
    unread: 0,
    malformed: 0,
    unsupported: 0,
  },
};
const row = {
  sessionId: "interactive",
  startedAt: loadedAt,
  lastEventAt: loadedAt,
  source: "resume",
  activity: { state: "working", visible: true, animates: true },
  openTools: [
    { id: "tool", tool: "Read", target: "src/app.ts", startedAt: loadedAt },
  ],
  arrangements: [],
  supervision: null,
  milestone: {
    kind: "implementing",
    at: loadedAt,
    label: "Implementing",
    note: null,
    elapsedSeconds: 0,
    clockAnomaly: false,
    overdue: false,
    selfReported: true,
  },
  arrangementPresenceTruncated: false,
};
const active = {
  ...empty,
  status: {
    kind: "active",
    record: {
      sessionId: "11111111-1111-4111-8111-111111111111",
      state: "CODE_REVIEW",
      substage: "Independent review",
      observedAt: loadedAt,
      startedAt: loadedAt,
      source: "hook",
      claudeStatus: "waiting_for_input",
      branch: "codex/plugin",
      derivedStatus: "needsInput",
      currentWork: {
        id: "ISS-003",
        title: "Fix refresh",
        kind: "issue",
        tag: "high",
      },
      queue: {
        completed: 1,
        total: 2,
        fraction: 0.5,
        items: [
          { id: "T-001", status: "done" },
          { id: "ISS-003", status: "current" },
        ],
      },
      completedThisSession: ["T-001"],
      runningSubprocesses: [
        {
          pid: 42,
          category: "review",
          stage: "CODE_REVIEW",
          startedAt: loadedAt,
        },
      ],
      alerts: [
        {
          kind: "waiting",
          tone: "madder",
          title: "Input needed",
          detail: "Waiting for your input",
        },
      ],
      contextPressure: "high",
      tokenPressure: {
        state: "advisory",
        pctBucket: null,
        ceilingSource: "unknown",
        ceilingConfidence: null,
        compactNeeded: false,
      },
      telemetryAvailable: false,
      truncated: false,
    },
  },
  presence: { ...empty.presence, items: [row], total: 1 },
};
const overview = {
  project: "Demo",
  loadedAt,
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
async function setup(call: Call) {
  const dom = new JSDOM(await readFile("src/app.html", "utf8")),
    d = dom.window.document;
  const view = mountWorkspace(d, async (name, args) =>
    name === "storybloq_board_overview"
      ? { _meta: { overview } }
      : call(name, args),
  );
  view.receive({ _meta: { overview } });
  const click = (id: string) => {
    const el = d.getElementById(id) as HTMLButtonElement;
    assert.ok(el, id + " exists");
    el.click();
  };
  const open = async () => {
    click("nav-sessions");
    await tick();
  };
  return {
    dom,
    d,
    view,
    click,
    open,
    close: () => {
      view.dispose();
      dom.window.close();
    },
  };
}
test("Sessions renders active issue, stage, queue, subprocess and truthful pressure labels as inert data", async () => {
  const unsafe = {
    ...active,
    status: {
      ...active.status,
      record: {
        ...active.status.record,
        currentWork: {
          ...active.status.record.currentWork,
          title: "<img src=x onerror=alert(1)>",
        },
      },
    },
  };
  const s = await setup(async () => ({ _meta: { sessions: unsafe } }));
  try {
    await s.open();
    const screen = s.d.getElementById("sessions-screen")!;
    assert.equal(screen.hidden, false);
    assert.match(screen.textContent!, /ISS-003/);
    assert.match(screen.textContent!, /CODE_REVIEW/);
    assert.match(screen.textContent!, /Independent review/);
    assert.match(screen.textContent!, /1.*2/);
    assert.match(screen.textContent!, /review/);
    assert.match(screen.textContent!, /Input needed/);
    assert.match(screen.textContent!, /Guide.*high/i);
    assert.match(screen.textContent!, /Token.*advisory/i);
    assert.doesNotMatch(screen.textContent!, /\d+%/);
    assert.match(screen.textContent!, /Recorded/);
    assert.equal(screen.querySelector("img,script,iframe"), null);
    assert.equal(s.d.activeElement!.id, "nav-sessions");
    assert.match(s.d.getElementById("sessions-live")!.textContent!, /input/i);
  } finally {
    s.close();
  }
});
test("interactive presence renders without an autonomous session and explains uncertain activity", async () => {
  const v = {
    ...empty,
    presence: {
      ...empty.presence,
      items: [
        {
          ...row,
          lastEventAt: new Date(Date.now() - 120000).toISOString(),
          activity: { state: "maybeWorking", visible: true, animates: false },
          supervision: "Supervising -- worker active",
        },
      ],
      total: 1,
      unread: 2,
      malformed: 1,
      unsupported: 1,
    },
  };
  const s = await setup(async () => ({ _meta: { sessions: v } }));
  try {
    await s.open();
    const text = s.d.getElementById("sessions-screen")!.textContent!;
    assert.match(text, /No autonomous session/i);
    assert.match(text, /interactive/);
    assert.match(text, /Read/);
    assert.match(text, /src\/app.ts/);
    assert.match(text, /may.*working|possibly.*working/i);
    assert.match(text, /Supervising/);
    assert.match(text, /Self.reported/i);
    assert.match(text, /unread|not read/i);
    assert.match(text, /unsupported|newer/i);
  } finally {
    s.close();
  }
});
test("missing, malformed and unsupported status keep Refresh and Sessions navigation usable", async () => {
  for (const kind of ["missing", "malformed", "unsupported"]) {
    const s = await setup(async () => ({
      _meta: { sessions: { ...empty, status: { kind } } },
    }));
    try {
      await s.open();
      assert.match(
        s.d.getElementById("sessions-screen")!.textContent!,
        new RegExp(kind, "i"),
      );
      assert.equal(
        (s.d.getElementById("refresh") as HTMLButtonElement).disabled,
        false,
      );
      s.click("nav-board");
      assert.equal(s.d.getElementById("sessions-screen")!.hidden, true);
    } finally {
      s.close();
    }
  }
});
test("failed refresh retains last data with stale notice and stable focus, while repeated errors are quiet", async () => {
  let fail = false;
  const s = await setup(async () =>
    fail
      ? {
          isError: true,
          _meta: {
            boardError: {
              code: "storybloq_board_error",
              message: "Runtime changed. Refresh again.",
            },
          },
        }
      : { _meta: { sessions: active } },
  );
  try {
    await s.open();
    const focused = s.d.getElementById("refresh")!;
    focused.focus();
    assert.equal(s.d.activeElement, focused);
    fail = true;
    s.click("refresh");
    await tick();
    assert.match(
      s.d.getElementById("sessions-stale")!.textContent!,
      /stale|previous/i,
    );
    assert.match(
      s.d.getElementById("sessions-screen")!.textContent!,
      /ISS-003/,
    );
    assert.equal(s.d.activeElement, focused);
    const error = s.d.getElementById("sessions-error")!,
      before = error.textContent;
    let mutations = 0;
    const observer = new s.dom.window.MutationObserver(() => mutations++);
    observer.observe(error, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    s.view.autoRefresh();
    await tick();
    assert.equal(error.textContent, before);
    assert.equal(mutations, 0);
    observer.disconnect();
  } finally {
    s.close();
  }
});
test("unchanged polls do not announce; activity changes and roster removal announce once", async () => {
  let value: any = active;
  const s = await setup(async () => ({ _meta: { sessions: value } }));
  try {
    await s.open();
    const region = s.d.getElementById("sessions-live")!;
    let mutations = 0;
    const observer = new s.dom.window.MutationObserver(() => mutations++);
    observer.observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    s.view.autoRefresh();
    await tick();
    assert.equal(mutations, 0);
    value = {
      ...active,
      presence: {
        ...active.presence,
        items: [
          {
            ...row,
            lastEventAt: new Date(Date.now() - 600000).toISOString(),
            openTools: [],
            activity: { state: "unknown", visible: true, animates: false },
          },
        ],
      },
    };
    s.view.autoRefresh();
    await tick();
    assert.equal(mutations, 1);
    assert.match(region.textContent!, /activity|unknown/i);
    value = { ...active, presence: { ...empty.presence } };
    s.view.autoRefresh();
    await tick();
    assert.equal(mutations, 2);
    assert.match(region.textContent!, /removed|no longer/i);
    s.view.autoRefresh();
    await tick();
    assert.equal(mutations, 2);
    observer.disconnect();
  } finally {
    s.close();
  }
});
test("visible-only polling never overlaps and late navigation/disposed responses are ignored", async () => {
  let calls = 0,
    hold = false,
    finish: ((v: any) => void) | undefined;
  const s = await setup(async () => {
    calls++;
    return hold
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { _meta: { sessions: empty } };
  });
  try {
    s.view.autoRefresh();
    assert.equal(calls, 0);
    await s.open();
    hold = true;
    s.view.autoRefresh();
    assert.equal(calls, 2);
    s.view.autoRefresh();
    s.click("refresh");
    assert.equal(calls, 2);
    s.click("nav-board");
    finish!({ _meta: { sessions: active } });
    await tick();
    assert.equal(s.d.getElementById("sessions-screen")!.hidden, true);
    assert.doesNotMatch(
      s.d.getElementById("sessions-screen")!.textContent!,
      /ISS-003/,
    );
    await s.open();
    assert.equal(calls, 3);
    s.view.dispose();
    finish!({ _meta: { sessions: active } });
    await tick();
    assert.doesNotMatch(
      s.d.getElementById("sessions-screen")!.textContent!,
      /ISS-003/,
    );
  } finally {
    s.close();
  }
});
test("presence pagination forwards bounded offset and keeps focus on a visible page control", async () => {
  const offsets: number[] = [];
  const s = await setup(async (_name, args) => {
    const offset = Number(args.offset ?? 0);
    offsets.push(offset);
    return {
      _meta: {
        sessions: {
          ...empty,
          presence: {
            ...empty.presence,
            items: [{ ...row, sessionId: offset ? "last" : "first" }],
            total: 21,
            offset,
          },
        },
      },
    };
  });
  try {
    await s.open();
    s.d.getElementById("sessions-next")!.focus();
    s.click("sessions-next");
    await tick();
    assert.deepEqual(offsets, [0, 20]);
    assert.match(s.d.getElementById("sessions-screen")!.textContent!, /last/);
    assert.equal(s.d.activeElement!.isConnected, true);
    assert.equal(s.d.activeElement!.closest("[hidden]"), null);
    assert.equal(s.d.activeElement!.id, "sessions-previous");
    assert.equal((s.d.activeElement as HTMLButtonElement).disabled, false);
  } finally {
    s.close();
  }
});
for (const rejectOld of [false, true])
  test(
    "new visible generation wins over old " +
      (rejectOld ? "failure" : "success"),
    async () => {
      const requests: {
        resolve: (v: any) => void;
        reject: (e: any) => void;
      }[] = [];
      const s = await setup(
        async () =>
          new Promise((resolve, reject) => requests.push({ resolve, reject })),
      );
      try {
        s.click("nav-sessions");
        assert.equal(requests.length, 1);
        s.click("nav-board");
        s.click("nav-sessions");
        assert.equal(
          requests.length,
          2,
          "reenter must allow a fresh generation",
        );
        requests[1].resolve({ _meta: { sessions: active } });
        await tick();
        const region = s.d.getElementById("sessions-live")!,
          announcement = region.textContent;
        if (rejectOld) requests[0].reject(new Error("old failure"));
        else requests[0].resolve({ _meta: { sessions: empty } });
        await tick();
        assert.match(
          s.d.getElementById("sessions-screen")!.textContent!,
          /ISS-003/,
        );
        assert.equal(region.textContent, announcement);
        assert.equal(s.d.getElementById("sessions-error")!.textContent, "");
      } finally {
        s.close();
      }
    },
  );

test("paging intent survives an in-flight automatic read in both directions", async () => {
  const offsets: number[] = [];
  let hold = false;
  let finish: ((v: any) => void) | undefined;
  const page = (offset: number) => ({
    _meta: {
      sessions: {
        ...empty,
        presence: {
          ...empty.presence,
          items: [{ ...row, sessionId: offset ? "last" : "first" }],
          total: 21,
          offset,
        },
      },
    },
  });
  const s = await setup(async (_name, args) => {
    const offset = Number(args.offset ?? 0);
    offsets.push(offset);
    return hold
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : page(offset);
  });
  try {
    await s.open();
    for (const [control, expected, focus] of [
      ["sessions-next", 20, "sessions-previous"],
      ["sessions-previous", 0, "sessions-next"],
    ] as const) {
      hold = true;
      s.view.autoRefresh();
      const oldOffset = offsets.at(-1)!;
      const before = offsets.length;
      s.d.getElementById(control)!.focus();
      s.click(control);
      assert.equal(
        offsets.length,
        before,
        "queued page does not overlap the read",
      );
      hold = false;
      finish!(page(oldOffset));
      await tick();
      await tick();
      assert.equal(
        offsets.at(-1),
        expected,
        "latest page intent is dispatched",
      );
      assert.equal(offsets.length, before + 1);
      assert.equal(s.d.activeElement!.id, focus);
      assert.equal((s.d.activeElement as HTMLButtonElement).disabled, false);
    }
  } finally {
    s.close();
  }
});

test("roster shrink moves disabled pager focus to the Sessions heading", async () => {
  for (const total of [1, 0]) {
    let value = {
      ...empty,
      presence: { ...empty.presence, items: [row], total: 21 },
    };
    const s = await setup(async () => ({ _meta: { sessions: value } }));
    try {
      await s.open();
      s.d.getElementById("sessions-next")!.focus();
      value = {
        ...empty,
        presence: { ...empty.presence, items: total ? [row] : [], total },
      };
      s.view.autoRefresh();
      await tick();
      assert.equal(s.d.activeElement!.id, "sessions-title");
    } finally {
      s.close();
    }
  }
});

for (const kind of ["inactive", "missing"])
  test(
    "active status becoming " + kind + " announces once with unchanged roster",
    async () => {
      let value: any = active;
      const s = await setup(async () => ({ _meta: { sessions: value } }));
      try {
        await s.open();
        const region = s.d.getElementById("sessions-live")!;
        let mutations = 0;
        const observer = new s.dom.window.MutationObserver(() => mutations++);
        observer.observe(region, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        value = { ...active, status: { kind } };
        s.view.autoRefresh();
        await tick();
        assert.equal(mutations, 1);
        assert.match(
          region.textContent!,
          kind === "inactive" ? /no.*active/i : /missing|unavailable/i,
        );
        assert.doesNotMatch(region.textContent!, /Input needed/);
        s.view.autoRefresh();
        await tick();
        assert.equal(mutations, 1);
        observer.disconnect();
      } finally {
        s.close();
      }
    },
  );
