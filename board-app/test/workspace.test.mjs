import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { layoutFederation } from "../src/federation-layout.js";
import { mountWorkspace } from "../src/workspace-view.js";

const key = "a".repeat(64),
  group = "b".repeat(64),
  handover = "c".repeat(64);
const phases = [
  {
    key,
    name: "First release",
    label: "01",
    status: "inprogress",
    current: true,
  },
];
const card = {
  key: "ticket:T-001",
  id: "T-001",
  displayId: "T-001",
  title: "One ticket",
  kind: "tickets",
  blocked: false,
  severity: null,
  description: "Work",
  tags: ["Task"],
  phaseKey: key,
};
const overview = {
  project: "Demo",
  loadedAt: "2026-09-30T12:00:00Z",
  currentPhase: { id: "p1", name: "First release", status: "inprogress" },
  isOrchestrator: true,
  phases,
  hasUnphased: true,
  summary: { total: 1, complete: 0, blocked: 0, openIssues: 0, severity: {} },
  limit: 6,
  columns: {
    open: { items: [card], total: 1, offset: 0 },
    inProgress: { items: [], total: 0, offset: 0 },
    done: { items: [], total: 0, offset: 0 },
  },
};
const history = {
  phases,
  hasUnphased: true,
  loadedAt: "2026-09-30T12:00:00Z",
  groups: {
    items: [{ key: group, date: "2026-09-30", title: "2 handovers", count: 2 }],
    total: 1,
    offset: 0,
    limit: 10,
  },
  milestones: [
    {
      key: "d".repeat(64),
      phaseKey: key,
      title: "Foundation",
      label: "01",
      summary: "Complete",
      date: "2026-09-29",
    },
  ],
};
const federation = {
  isOrchestrator: true,
  scannedAt: "2026-09-30T11:00:00Z",
  warnings: [],
  nodes: [
    {
      name: "library",
      kind: "library",
      role: "Shared code",
      stack: "Swift",
      summary: "Foundation",
      health: "green",
      cache: null,
      cacheState: "missing",
    },
    {
      name: "app",
      kind: "app",
      role: "Mac experience",
      stack: "SwiftUI",
      summary: "Project view",
      health: "yellow",
      cacheState: "stale",
      cache: {
        ticketCount: 10,
        completeTickets: 6,
        openTickets: 4,
        issueCount: 2,
        openIssues: 1,
        lastHandoverDate: "2026-09-29",
        lastHandoverTitle: "Work",
        reachable: true,
      },
    },
  ],
  edges: [
    { type: "build", from: "library", to: "app" },
    { type: "runtime", from: "app", to: "library", via: "events" },
  ],
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const payload = (name, data) => ({ _meta: { [name]: data } });
async function setup(call) {
  const dom = new JSDOM(await readFile("src/app.html", "utf8"));
  const d = dom.window.document;
  const view = mountWorkspace(d, call);
  view.receive(payload("overview", overview));
  return {
    dom,
    d,
    view,
    click: (id) => d.getElementById(id).click(),
    close: () => {
      view.dispose();
      dom.window.close();
    },
  };
}
const basic = (name) =>
  Promise.resolve(
    name === "storybloq_timeline"
      ? payload("history", history)
      : name === "storybloq_federation"
        ? payload("federation", federation)
        : payload("overview", overview),
  );
test("ready Timeline and Nodes polling never reads the inactive board", async () => {
  const calls = [];
  const s = await setup((name) => {
    calls.push(name);
    return basic(name);
  });
  try {
    for (const nav of ["nav-timeline", "nav-nodes"]) {
      s.click(nav);
      await tick();
      const before = calls.filter(
        (n) => n === "storybloq_board_overview",
      ).length;
      s.view.autoRefresh();
      await tick();
      assert.equal(
        calls.filter((n) => n === "storybloq_board_overview").length,
        before,
      );
    }
  } finally {
    s.close();
  }
});

test("workspace navigation ignores late history and pauses board polling off the board", async () => {
  const calls = [];
  let resolveHistory;
  const s = await setup((name, args) => {
    calls.push({ name, args });
    return name === "storybloq_timeline"
      ? new Promise((r) => {
          resolveHistory = r;
        })
      : basic(name);
  });
  try {
    s.click("nav-timeline");
    await tick();
    const count = calls.length;
    s.view.autoRefresh();
    await tick();
    assert.equal(calls.length, count);
    s.click("nav-board");
    await tick();
    resolveHistory(payload("history", history));
    await tick();
    assert.equal(s.d.getElementById("board-screen").hidden, false);
    assert.equal(s.d.getElementById("timeline-screen").hidden, true);
    assert.equal(s.d.querySelectorAll(".history-group").length, 0);
    assert.equal(
      s.d.getElementById("nav-board").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(calls.at(-1).name, "storybloq_board_overview");
  } finally {
    s.close();
  }
});
test("chronological history opens a day inspector, pages children and returns from inert Markdown", async () => {
  const calls = [];
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    if (name === "storybloq_timeline") return payload("history", history);
    if (name === "storybloq_timeline_group")
      return payload("handovers", {
        items: [{ key: handover, title: "Session work", date: "2026-09-30" }],
        total: 2,
        offset: args.offset ?? 0,
        limit: 1,
      });
    if (name === "storybloq_handover_detail")
      return payload("handover", {
        key: handover,
        title: "Session work",
        date: "2026-09-30",
        truncated: false,
        content:
          "# Handover\n\n**Decision** and `code`.\n\n- A change\n- Another\n\n<script>unsafe()</script>\n\n[bad](javascript:unsafe()) ![secret](https://example.com/private)",
      });
    return payload("overview", overview);
  });
  try {
    s.click("nav-timeline");
    await tick();
    assert.doesNotMatch(
      s.d.getElementById("history-list").textContent,
      /Foundation/,
    );
    assert.equal(s.d.getElementById("history-phases"), null);
    assert.equal(
      calls.filter((c) => /timeline_group|handover_detail/.test(c.name)).length,
      0,
    );
    const disclosure = s.d.querySelector(".history-group");
    disclosure.click();
    await tick();
    assert.equal(calls.at(-1).name, "storybloq_timeline_group");
    assert.equal(calls.at(-1).args.group, group);
    const row = s.d.querySelector(".handover-row");
    row.focus();
    row.click();
    await tick();
    const detail = s.d.getElementById("history-detail");
    assert.equal(detail.hidden, false);
    assert.equal(s.d.activeElement.id, "history-detail-title");
    assert.match(detail.textContent, /Decision/);
    assert.equal(detail.querySelector("script,img,a"), null);
    assert.ok(detail.querySelector("strong"));
    assert.ok(detail.querySelector("code"));
    assert.ok(detail.querySelector("ul li"));
    s.d.querySelector(".history-back").click();
    await tick();
    const next = s.d.querySelector(".group-next");
    next.focus();
    next.click();
    await tick();
    assert.equal(calls.at(-1).args.offset, 1);
    assert.ok(s.d.activeElement.classList.contains("group-previous"));
    s.d.querySelector(".handover-row").click();
    await tick();
    s.d.querySelector(".history-back").click();
    await tick();
    assert.equal(calls.at(-1).args.offset, 1);
    assert.ok(
      calls
        .filter((c) => /timeline/.test(c.name))
        .every((c) => c.args.phase === "all"),
    );
    s.d.getElementById("history-detail").dispatchEvent(
      new s.d.defaultView.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    );
    assert.equal(s.d.getElementById("history-detail").hidden, true);
    assert.equal(s.d.activeElement, disclosure);
  } finally {
    s.close();
  }
});
test("history empty and read errors retain refresh controls without phase UI", async () => {
  let fail = false;
  const s = await setup(async (name) =>
    name === "storybloq_timeline"
      ? fail
        ? {
            isError: true,
            _meta: {
              boardError: {
                code: "storybloq_board_error",
                message: "Finish the local transaction, then refresh.",
              },
            },
          }
        : payload("history", {
            ...history,
            groups: { items: [], total: 0, offset: 0, limit: 10 },
            milestones: [],
          })
      : basic(name),
  );
  try {
    s.click("nav-timeline");
    await tick();
    assert.match(
      s.d.getElementById("history-list").textContent,
      /No handovers/,
    );
    assert.equal(s.d.getElementById("history-phases"), null);
    fail = true;
    s.click("refresh");
    await tick();
    assert.match(
      s.d.getElementById("history-error").textContent,
      /local transaction/,
    );
    assert.equal(s.d.getElementById("refresh").disabled, false);
    assert.equal(s.d.getElementById("history-next").disabled, true);
  } finally {
    s.close();
  }
});
test("closed or navigated-away handover requests cannot restore an inspector", async () => {
  let resolveDetail;
  const s = await setup(async (name) =>
    name === "storybloq_timeline_group"
      ? payload("handovers", {
          items: [{ key: handover, title: "Work", date: "2026-09-30" }],
          total: 1,
          offset: 0,
          limit: 10,
        })
      : name === "storybloq_handover_detail"
        ? new Promise((r) => {
            resolveDetail = r;
          })
        : basic(name),
  );
  try {
    s.click("nav-timeline");
    await tick();
    s.d.querySelector(".history-group").click();
    await tick();
    s.d.querySelector(".handover-row").click();
    await tick();
    s.click("history-close");
    resolveDetail(
      payload("handover", {
        key: handover,
        title: "Work",
        date: null,
        content: "LATE",
        truncated: false,
      }),
    );
    await tick();
    assert.equal(s.d.getElementById("history-detail").hidden, true);
    assert.ok(
      !s.d.getElementById("history-detail-body").textContent.includes("LATE"),
    );
    s.d.querySelector(".history-group").click();
    await tick();
    s.d.querySelector(".handover-row").click();
    await tick();
    s.click("nav-board");
    await tick();
    resolveDetail(
      payload("handover", {
        key: handover,
        title: "Work",
        date: null,
        content: "LATE AGAIN",
        truncated: false,
      }),
    );
    await tick();
    assert.equal(s.d.getElementById("history-detail").hidden, true);
  } finally {
    s.close();
  }
});
test("federation offers an accessible node list, cached labels, directed relations and active-ticket paging", async () => {
  const calls = [];
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    if (name === "storybloq_node_detail")
      return payload("node", {
        ...federation.nodes[1],
        buildsAfter: ["library"],
        requiredBy: [],
        runtimeOutgoing: [federation.edges[1]],
        runtimeIncoming: [],
        preview: {
          state: "ready",
          items: [
            {
              displayId: args.offset ? "T-002" : "T-001",
              title: "Active work",
              status: "inprogress",
            },
          ],
          total: 2,
          offset: args.offset ?? 0,
          limit: 1,
          message: null,
        },
      });
    return basic(name);
  });
  try {
    s.click("nav-nodes");
    await tick();
    assert.equal(s.d.getElementById("nodes-screen").hidden, false);
    assert.equal(s.d.querySelectorAll(".node-card").length, 2);
    assert.ok(s.d.querySelector('svg[aria-label="Federation relationships"]'));
    assert.match(s.d.getElementById("nodes-list").textContent, /stale/i);
    assert.match(s.d.getElementById("nodes-list").textContent, /cached/i);
    const row = s.d.querySelector('[data-node="app"].node-card');
    row.focus();
    row.click();
    await tick();
    assert.equal(calls.at(-1).name, "storybloq_node_detail");
    assert.deepEqual(calls.at(-1).args, { name: "app", offset: 0, limit: 10 });
    assert.equal(s.d.activeElement.id, "node-detail-title");
    assert.match(s.d.getElementById("node-detail").textContent, /Builds after/);
    assert.match(s.d.getElementById("node-detail").textContent, /library/);
    assert.match(
      s.d.getElementById("node-detail").textContent,
      /Runtime links/,
    );
    assert.match(s.d.getElementById("node-detail").textContent, /T-001/);
    s.click("node-preview-next");
    await tick();
    assert.equal(calls.at(-1).args.offset, 1);
    assert.match(s.d.getElementById("node-detail").textContent, /T-002/);
    s.click("node-close");
    assert.equal(s.d.activeElement, row);
  } finally {
    s.close();
  }
});
test("non-orchestrator navigation hides Nodes and teardown makes all pending results inert", async () => {
  let resolveHistory;
  let callCount = 0;
  const s = await setup((name) => {
    callCount++;
    return name === "storybloq_timeline"
      ? new Promise((r) => {
          resolveHistory = r;
        })
      : basic(name);
  });
  try {
    s.view.receive(payload("overview", { ...overview, isOrchestrator: false }));
    assert.equal(s.d.getElementById("nav-nodes").hidden, true);
    s.click("nav-timeline");
    await tick();
    s.view.dispose();
    resolveHistory(payload("history", history));
    await tick();
    const count = callCount;
    s.view.autoRefresh();
    s.click("nav-board");
    await tick();
    assert.equal(callCount, count);
    assert.equal(s.d.querySelectorAll(".history-group").length, 0);
  } finally {
    s.close();
  }
});
const nodePayload = (name, marker = "CURRENT", offset = 0) =>
  payload("node", {
    ...federation.nodes.find((n) => n.name === name),
    buildsAfter: [],
    requiredBy: [],
    runtimeIncoming: [],
    runtimeOutgoing: [],
    preview: {
      state: "ready",
      items: [{ displayId: "T-001", title: marker, status: "open" }],
      total: 2,
      offset,
      limit: 1,
    },
  });
test("stale board results cannot change federation navigation after leaving and returning", async () => {
  const pending = [];
  const s = await setup((name) =>
    name === "storybloq_board_overview"
      ? new Promise((resolve) => pending.push(resolve))
      : basic(name),
  );
  try {
    s.click("refresh");
    await tick();
    s.click("nav-timeline");
    await tick();
    s.click("nav-board");
    await tick();
    pending[1](payload("overview", overview));
    await tick();
    assert.equal(s.d.getElementById("nav-nodes").hidden, false);
    pending[0](payload("overview", { ...overview, isOrchestrator: false }));
    await tick();
    assert.equal(s.d.getElementById("nav-nodes").hidden, false);
  } finally {
    s.close();
  }
});
test("node details ignore superseded, closed, navigated-away and disposed requests and recover after errors", async () => {
  const pending = [];
  const s = await setup((name, args) =>
    name === "storybloq_node_detail"
      ? new Promise((resolve, reject) =>
          pending.push({ resolve, reject, args }),
        )
      : basic(name),
  );
  try {
    s.click("nav-nodes");
    await tick();
    const row = (name) => s.d.querySelector(`.node-card[data-node="${name}"]`);
    row("library").click();
    row("app").click();
    pending[1].resolve(nodePayload("app", "CURRENT APP"));
    await tick();
    pending[0].resolve(nodePayload("library", "OLD LIBRARY"));
    await tick();
    assert.equal(s.d.getElementById("node-detail-title").textContent, "app");
    assert.ok(
      !s.d
        .getElementById("node-detail-body")
        .textContent.includes("OLD LIBRARY"),
    );
    row("library").click();
    s.click("node-close");
    pending[2].resolve(nodePayload("library", "CLOSED"));
    await tick();
    assert.equal(s.d.getElementById("node-detail").hidden, true);
    row("app").click();
    s.click("nav-board");
    await tick();
    pending[3].resolve(nodePayload("app", "NAVIGATED"));
    await tick();
    assert.equal(s.d.getElementById("node-detail").hidden, true);
    s.click("nav-nodes");
    await tick();
    row("app").click();
    pending[4].reject(new Error("Read unavailable"));
    await tick();
    assert.match(
      s.d.getElementById("node-detail-body").textContent,
      /Node details could not load/,
    );
    s.click("node-close");
    row("app").click();
    pending[5].resolve(nodePayload("app", "RECOVERED"));
    await tick();
    assert.match(
      s.d.getElementById("node-detail-body").textContent,
      /RECOVERED/,
    );
    row("library").click();
    s.view.dispose();
    pending[6].resolve(nodePayload("library", "DISPOSED"));
    await tick();
    assert.equal(s.d.getElementById("node-detail").hidden, true);
    assert.ok(
      !s.d.getElementById("node-detail-body").textContent.includes("DISPOSED"),
    );
  } finally {
    s.close();
  }
});
test("node paging restores a lost pager focus but respects a move to Close", async () => {
  let page;
  const s = await setup((name, args) =>
    name === "storybloq_node_detail"
      ? args.offset
        ? new Promise((resolve) => {
            page = resolve;
          })
        : Promise.resolve(nodePayload(args.name))
      : basic(name),
  );
  try {
    s.click("nav-nodes");
    await tick();
    s.d.querySelector('.node-card[data-node="app"]').click();
    await tick();
    s.d.getElementById("node-preview-next").focus();
    s.click("node-preview-next");
    s.d.getElementById("node-close").focus();
    page(nodePayload("app", "PAGE", 1));
    await tick();
    assert.equal(s.d.activeElement.id, "node-close");
    s.d.getElementById("node-preview-previous").focus();
    s.click("node-preview-previous");
    await tick();
    assert.equal(s.d.activeElement.id, "node-preview-next");
  } finally {
    s.close();
  }
});
test("failed date paging focuses retry and successful retry focuses the first result", async () => {
  let rejectPage;
  let fail = true;
  const s = await setup((name, args) => {
    if (name !== "storybloq_timeline_group") return basic(name);
    if (args.offset && fail)
      return new Promise((_, reject) => {
        rejectPage = reject;
      });
    return Promise.resolve(
      payload("handovers", {
        items: [
          {
            key: handover,
            title: args.offset ? "Second" : "First",
            date: "2026-09-30",
          },
        ],
        offset: args.offset ?? 0,
        total: 2,
        limit: 1,
      }),
    );
  });
  try {
    s.click("nav-timeline");
    await tick();
    s.d.querySelector(".history-group").click();
    await tick();
    const next = s.d.querySelector(".group-next");
    next.focus();
    next.click();
    rejectPage(new Error("raw transport detail"));
    await tick();
    const retry = [...s.d.querySelectorAll("#history-detail button")].find(
      (b) => b.textContent === "Try again",
    );
    assert.equal(s.d.activeElement, retry);
    assert.match(
      s.d.getElementById("history-status").textContent,
      /Date group could not load/,
    );
    fail = false;
    retry.click();
    await tick();
    assert.equal(s.d.activeElement, s.d.querySelector(".handover-row"));
    assert.equal(
      s.d.activeElement.querySelector(".handover-title").textContent,
      "Second",
    );
  } finally {
    s.close();
  }
});
test("failed node paging recovers removed focus to Close without stealing newly moved focus", async () => {
  let rejectPage;
  const s = await setup((name, args) =>
    name === "storybloq_node_detail"
      ? args.offset
        ? new Promise((_, reject) => {
            rejectPage = reject;
          })
        : Promise.resolve(nodePayload(args.name))
      : basic(name),
  );
  try {
    s.click("nav-nodes");
    await tick();
    s.d.querySelector('.node-card[data-node="app"]').click();
    await tick();
    s.d.getElementById("node-preview-next").focus();
    s.click("node-preview-next");
    rejectPage(new Error("raw transport detail"));
    await tick();
    assert.equal(s.d.activeElement.id, "node-close");
    assert.match(
      s.d.getElementById("nodes-status").textContent,
      /Node details could not load/,
    );
    s.click("node-close");
    s.d.querySelector('.node-card[data-node="app"]').click();
    await tick();
    s.d.getElementById("node-preview-next").focus();
    s.click("node-preview-next");
    s.d.getElementById("refresh").focus();
    rejectPage(new Error("raw transport detail"));
    await tick();
    assert.equal(s.d.activeElement.id, "refresh");
  } finally {
    s.close();
  }
});
test("failed handover reads announce a sanitized error without moving focus", async () => {
  const s = await setup((name) =>
    name === "storybloq_handover_detail"
      ? Promise.reject(new Error("raw transport detail"))
      : name === "storybloq_timeline_group"
        ? Promise.resolve(
            payload("handovers", {
              items: [{ key: handover, title: "Work", date: "2026-09-30" }],
              offset: 0,
              limit: 10,
              total: 1,
            }),
          )
        : basic(name),
  );
  try {
    s.click("nav-timeline");
    await tick();
    s.d.querySelector(".history-group").click();
    await tick();
    s.d.querySelector(".handover-row").click();
    await tick();
    assert.match(
      s.d.getElementById("history-status").textContent,
      /Handover could not load/,
    );
    assert.ok(!s.d.body.textContent.includes("raw transport detail"));
    assert.equal(s.d.activeElement.id, "history-detail-title");
  } finally {
    s.close();
  }
});
test("automatic view refresh preserves focused date summaries and node cards", async () => {
  const s = await setup(basic);
  try {
    s.click("nav-timeline");
    await tick();
    s.d.querySelector(".history-group").focus();
    s.view.autoRefresh();
    await tick();
    assert.equal(s.d.activeElement.dataset.group, group);
    s.click("nav-nodes");
    await tick();
    s.d.querySelector('.node-card[data-node="app"]').focus();
    s.view.autoRefresh();
    await tick();
    assert.equal(s.d.activeElement.dataset.node, "app");
  } finally {
    s.close();
  }
});

// Check geometric behavior independently of the layout's lane implementation.
function assertRoutesClear(layout) {
  const inside = (p, box) =>
    p.x > box.x + 0.01 &&
    p.x < box.x + box.width - 0.01 &&
    p.y > box.y + 0.01 &&
    p.y < box.y + box.height - 0.01;
  for (const route of layout.routes) {
    const tokens = route.path.match(/[MLQ]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g);
    let i = 0,
      current,
      start;
    while (i < tokens.length) {
      const cmd = tokens[i++];
      const point = () => ({ x: Number(tokens[i++]), y: Number(tokens[i++]) });
      if (cmd === "M") {
        current = start = point();
        continue;
      }
      const control = point(),
        end = cmd === "Q" ? point() : control;
      for (let step = 0; step <= 30; step++) {
        const t = step / 30,
          u = 1 - t;
        const p =
          cmd === "Q"
            ? {
                x: u * u * current.x + 2 * u * t * control.x + t * t * end.x,
                y: u * u * current.y + 2 * u * t * control.y + t * t * end.y,
              }
            : { x: current.x * u + end.x * t, y: current.y * u + end.y * t };
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        assert.ok(
          p.x >= 0 && p.x <= layout.width && p.y >= 0 && p.y <= layout.height,
        );
        for (const box of layout.nodes)
          assert.equal(
            inside(p, box),
            false,
            `${route.edge.from} -> ${route.edge.to} crosses ${box.name}`,
          );
      }
      current = end;
    }
    for (const [name, endpoint] of [
      [route.edge.from, start],
      [route.edge.to, current],
    ]) {
      const box = layout.nodes.find((n) => n.name === name);
      const onVerticalSide =
        (Math.abs(endpoint.x - box.x) < 0.01 ||
          Math.abs(endpoint.x - box.x - box.width) < 0.01) &&
        endpoint.y >= box.y &&
        endpoint.y <= box.y + box.height;
      const onHorizontalSide =
        (Math.abs(endpoint.y - box.y) < 0.01 ||
          Math.abs(endpoint.y - box.y - box.height) < 0.01) &&
        endpoint.x >= box.x &&
        endpoint.x <= box.x + box.width;
      assert.ok(
        onVerticalSide || onHorizontalSide,
        `${name} link endpoint must touch its card`,
      );
    }
  }
}

test("federation map layers build dependencies and routes branches, skips and runtime returns outside cards", () => {
  const names = ["a", "b", "c", "d", "isolated"];
  const edges = [
    { type: "build", from: "a", to: "b" },
    { type: "build", from: "a", to: "c" },
    { type: "build", from: "b", to: "d" },
    { type: "build", from: "c", to: "d" },
    { type: "build", from: "a", to: "d" },
    { type: "runtime", from: "d", to: "a", via: "events" },
    { type: "runtime", from: "b", to: "a", via: "http" },
    { type: "runtime", from: "a", to: "b", via: "events" },
    { type: "runtime", from: "c", to: "b", via: "queue" },
    { type: "runtime", from: "b", to: "c", via: "reply" },
    { type: "runtime", from: "c", to: "c", via: "loop" },
  ];
  const layout = layoutFederation(names, edges),
    byName = new Map(layout.nodes.map((n) => [n.name, n]));
  assert.equal(layout.routes.length, edges.length);
  assert.ok(byName.get("a").x < byName.get("b").x);
  assert.equal(byName.get("b").x, byName.get("c").x);
  assert.ok(byName.get("c").x < byName.get("d").x);
  assert.equal(new Set(layout.routes.map((r) => r.path)).size, edges.length);
  assert.deepEqual(
    layoutFederation([...names].reverse(), [...edges].reverse()),
    layout,
  );
  assertRoutesClear(layout);
});

test("cycles retain all projects, put downstream projects later and ignore absent endpoints", () => {
  const names = [
    "__proto__",
    "b",
    "dependent",
    "disconnected",
    "a very long project name ".repeat(8),
  ];
  const edges = [
    { type: "build", from: "__proto__", to: "b" },
    { type: "build", from: "b", to: "__proto__" },
    { type: "build", from: "b", to: "dependent" },
    { type: "runtime", from: "b", to: "b" },
    { type: "build", from: "missing", to: "b" },
    { type: "runtime", from: "b", to: "missing" },
  ];
  const layout = layoutFederation(names, edges),
    get = (name) => layout.nodes.find((n) => n.name === name);
  assert.equal(layout.nodes.length, names.length);
  assert.equal(layout.routes.length, 4);
  assert.equal(get("__proto__").layer, get("b").layer);
  assert.ok(get("dependent").layer > get("b").layer);
  assertRoutesClear(layout);
  assert.deepEqual(layoutFederation([], []).nodes, []);
  assert.equal(layoutFederation(["one"], []).routes.length, 0);
});

test("maximum federation topology has bounded canvas and route sizes without dropping links", () => {
  const names = Array.from({ length: 200 }, (_, i) => `project-${i}`);
  const edges = names
    .slice(1)
    .map((name, i) => ({ type: "build", from: names[i], to: name }));
  for (let i = edges.length; i < 2000; i++)
    edges.push({
      type: "runtime",
      from: names[i % 200],
      to: names[(i * 13 + 7) % 200],
      via: `channel-${i}`,
    });
  const layout = layoutFederation(names, edges);
  assert.equal(layout.nodes.length, 200);
  assert.equal(layout.routes.length, 2000);
  assert.ok(layout.width < 80000 && layout.height < 35000);
  assert.ok(
    layout.routes.every(
      (r) => r.path.length < 1000 && !/NaN|Infinity/.test(r.path),
    ),
  );
  assertRoutesClear({
    ...layout,
    routes: layout.routes.filter((_, i) => i % 100 === 0),
  });
});

test("known federation metadata and safe relationship buttons survive an active-work read failure", async () => {
  let reject;
  const s = await setup((name) =>
    name === "storybloq_node_detail"
      ? new Promise((_, r) => (reject = r))
      : basic(name),
  );
  try {
    s.click("nav-nodes");
    await tick();
    s.d.querySelector('.node-card[data-node="app"]').click();
    const body = s.d.getElementById("node-detail-body");
    for (const text of [
      "SwiftUI",
      "Mac experience",
      "Project view",
      "Needs attention",
      "stale",
      "6/10",
      "Last handover",
      "library",
      "events",
      "Loading node work",
    ])
      assert.ok(body.textContent.includes(text), text);
    reject(new Error("private path must not render"));
    await tick();
    assert.match(body.textContent, /Project view/);
    assert.match(body.textContent, /Node details could not load/);
    assert.ok(!body.textContent.includes("private path"));
    body.querySelector(".node-relation").click();
    assert.equal(
      s.d.getElementById("node-detail-title").textContent,
      "library",
    );
  } finally {
    s.close();
  }
});

test("relationship navigation selects the target and detached or closed relationship handlers do nothing", async () => {
  const calls = [];
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    if (name === "storybloq_node_detail")
      return {
        _meta: {
          node: {
            ...nodePayload(args.name)._meta.node,
            buildsAfter: args.name === "app" ? ["library"] : [],
            requiredBy: args.name === "library" ? ["app"] : [],
          },
        },
      };
    return basic(name);
  });
  try {
    s.click("nav-nodes");
    await tick();
    s.d.querySelector('.node-card[data-node="app"]').click();
    await tick();
    let row = s.d.querySelector(".node-relation");
    row.click();
    await tick();
    assert.equal(
      s.d.getElementById("node-detail-title").textContent,
      "library",
    );
    assert.equal(
      s.d
        .querySelector('.node-card[data-node="library"]')
        .getAttribute("aria-pressed"),
      "true",
    );
    let count = calls.length;
    row.onclick();
    assert.equal(calls.length, count);
    row = s.d.querySelector(".node-relation");
    s.click("node-close");
    count = calls.length;
    row.onclick();
    assert.equal(calls.length, count);
    assert.equal(s.d.querySelectorAll(".is-selected,.is-unrelated").length, 0);
    s.d.querySelector('.node-card[data-node="app"]').click();
    await tick();
    row = s.d.querySelector(".node-relation");
    s.click("node-preview-next");
    await tick();
    count = calls.length;
    row.onclick();
    assert.equal(calls.length, count);
    row = s.d.querySelector(".node-relation");
    s.click("refresh");
    await tick();
    count = calls.length;
    row.onclick();
    assert.equal(calls.length, count);
    s.d.querySelector('.node-card[data-node="app"]').click();
    await tick();
    row = s.d.querySelector(".node-relation");
    s.click("nav-board");
    await tick();
    count = calls.length;
    row.onclick();
    assert.equal(calls.length, count);
  } finally {
    s.close();
  }
});

test("map selection highlights only incident links, and untrusted names and link labels stay text", async () => {
  const odd = '<img src=x onerror="attack()">';
  const f = {
    ...federation,
    nodes: [...federation.nodes, { ...federation.nodes[0], name: odd }],
    edges: [
      ...federation.edges,
      {
        type: "runtime",
        from: "library",
        to: odd,
        via: "<script>attack()</script>",
      },
    ],
  };
  const s = await setup(async (name) =>
    name === "storybloq_federation"
      ? payload("federation", f)
      : name === "storybloq_node_detail"
        ? { isError: true }
        : basic(name),
  );
  try {
    s.click("nav-nodes");
    await tick();
    s.d.querySelector('.node-card[data-node="app"]').click();
    await tick();
    assert.equal(
      s.d.querySelectorAll(".federation-edge.is-selected").length,
      2,
    );
    assert.equal(
      s.d.querySelectorAll(".federation-edge.is-unrelated").length,
      1,
    );
    s.d.querySelector('.node-card[data-node="library"]').click();
    await tick();
    const body = s.d.getElementById("node-detail-body");
    assert.ok(body.textContent.includes(odd));
    assert.ok(body.textContent.includes("<script>attack()</script>"));
    assert.equal(body.querySelector("img,script,a"), null);
    [...body.querySelectorAll(".node-relation")]
      .find((b) => b.textContent.includes(odd))
      .click();
    assert.equal(s.d.getElementById("node-detail-title").textContent, odd);
  } finally {
    s.close();
  }
});

test("timeline singleton metadata opens directly, legacy and unknown dates stay usable", async () => {
  const calls = [];
  const rows = [
    {
      key: group,
      date: "2026-09-30",
      title: "2026-09-30",
      count: 1,
      previewTitles: ["A decision"],
      singleHandover: {
        key: handover,
        title: "A decision",
        date: "2026-09-30",
      },
    },
    { key: "legacy", date: "2026-09-29", title: "2026-09-29", count: 1 },
    {
      key: "unknown",
      date: null,
      title: "Unknown date",
      count: 4,
      previewTitles: ["<img src=x>", "Earlier work", "Another session"],
    },
  ];
  const s = await setup(async (name, args) => {
    calls.push({ name, args });
    if (name === "storybloq_timeline")
      return payload("history", {
        ...history,
        groups: { items: rows, total: 3, offset: 0, limit: 10 },
      });
    if (name === "storybloq_handover_detail")
      return payload("handover", {
        content: "Recorded decision",
        truncated: false,
      });
    if (name === "storybloq_timeline_group")
      return payload("handovers", {
        items: [],
        total: 0,
        offset: 0,
        limit: 10,
      });
    return basic(name);
  });
  try {
    s.click("nav-timeline");
    await tick();
    const dates = [...s.d.querySelectorAll(".history-group")];
    assert.deepEqual(
      dates.map((b) => b.dataset.group),
      [group, "legacy", "unknown"],
    );
    const expectedDate = new Intl.DateTimeFormat(undefined, {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date("2026-09-30T00:00:00Z"));
    assert.ok(dates[0].textContent.includes(expectedDate));
    assert.match(dates[0].textContent, /A decision/);
    assert.match(dates[2].textContent, /Unknown date/);
    assert.match(dates[2].textContent, /1 more/);
    assert.equal(dates[2].querySelector("img"), null);
    assert.equal(
      calls.filter((c) => /timeline_group|handover_detail/.test(c.name)).length,
      0,
    );
    dates[0].click();
    await tick();
    assert.equal(calls.at(-1).name, "storybloq_handover_detail");
    assert.equal(calls.at(-1).args.id, handover);
    assert.equal(s.d.querySelector(".history-back"), null);
    s.click("history-close");
    assert.equal(s.d.activeElement, dates[0]);
    dates[1].click();
    await tick();
    assert.equal(calls.at(-1).name, "storybloq_timeline_group");
    assert.equal(calls.at(-1).args.phase, "all");
    assert.match(
      s.d.getElementById("history-detail-body").textContent,
      /No handovers/,
    );
  } finally {
    s.close();
  }
});

test("superseded day responses, close, refresh and navigation cannot restore stale lists", async () => {
  for (const action of ["select", "close", "refresh", "navigate", "dispose"]) {
    const pending = [];
    const s = await setup((name, args) => {
      if (name === "storybloq_timeline")
        return Promise.resolve(
          payload("history", {
            ...history,
            groups: {
              ...history.groups,
              items: [
                ...history.groups.items,
                {
                  key: "second",
                  date: "2026-09-29",
                  title: "2026-09-29",
                  count: 2,
                },
              ],
              total: 2,
            },
          }),
        );
      if (name === "storybloq_timeline_group")
        return new Promise((resolve) => pending.push({ args, resolve }));
      return basic(name);
    });
    try {
      s.click("nav-timeline");
      await tick();
      const dates = s.d.querySelectorAll(".history-group");
      dates[0].click();
      await tick();
      if (action === "select") dates[1].click();
      if (action === "close") s.click("history-close");
      if (action === "refresh") s.click("refresh");
      if (action === "navigate") s.click("nav-nodes");
      if (action === "dispose") s.view.dispose();
      await tick();
      pending[0].resolve(
        payload("handovers", {
          items: [{ key: handover, title: "STALE DAY", date: null }],
          total: 1,
          limit: 10,
          offset: 0,
        }),
      );
      await tick();
      assert.doesNotMatch(
        s.d.getElementById("history-detail-body").textContent,
        /STALE DAY/,
      );
      if (action === "select") {
        pending[1].resolve(
          payload("handovers", {
            items: [{ key: handover, title: "Current day", date: null }],
            total: 1,
            limit: 10,
            offset: 0,
          }),
        );
        await tick();
        assert.match(
          s.d.getElementById("history-detail-body").textContent,
          /Current day/,
        );
        assert.equal(dates[0].getAttribute("aria-pressed"), "false");
        assert.equal(dates[1].getAttribute("aria-pressed"), "true");
      } else assert.equal(s.d.getElementById("history-detail").hidden, true);
    } finally {
      s.close();
    }
  }
});

test("day paging and retry never take focus from Close after the user moves it", async () => {
  let finish;
  let attempts = 0;
  const page = {
    items: [{ key: handover, title: "Work", date: null }],
    offset: 0,
    limit: 1,
    total: 2,
  };
  const s = await setup((name, args) => {
    if (name !== "storybloq_timeline_group") return basic(name);
    if (!attempts++) return Promise.resolve(payload("handovers", page));
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    s.click("nav-timeline");
    await tick();
    s.d.querySelector(".history-group").click();
    await tick();
    const next = s.d.querySelector(".group-next");
    next.focus();
    next.click();
    s.d.getElementById("history-close").focus();
    finish({ isError: true });
    await tick();
    assert.equal(s.d.activeElement.id, "history-close");
    const retry = s.d.querySelector(".group-retry");
    retry.focus();
    retry.click();
    s.d.getElementById("history-close").focus();
    finish(payload("handovers", { ...page, offset: 1 }));
    await tick();
    assert.equal(s.d.activeElement.id, "history-close");
  } finally {
    s.close();
  }
});

test("refresh disables old date actions and pagers until a successful replacement", async () => {
  let pending,
    fail = false;
  const calls = [];
  const s = await setup((name, args) => {
    calls.push({ name, args });
    if (name === "storybloq_timeline")
      return fail
        ? new Promise((resolve) => {
            pending = resolve;
          })
        : Promise.resolve(
            payload("history", {
              ...history,
              groups: { ...history.groups, total: 12 },
            }),
          );
    return basic(name);
  });
  try {
    s.click("nav-timeline");
    await tick();
    fail = true;
    s.click("refresh");
    const before = calls.length;
    s.d.querySelector(".history-group").click();
    s.click("history-next");
    assert.equal(calls.length, before);
    pending({ isError: true });
    await tick();
    assert.equal(s.d.querySelector(".history-group").disabled, true);
    assert.equal(s.d.getElementById("history-next").disabled, true);
    fail = false;
    s.click("refresh");
    await tick();
    assert.equal(s.d.querySelector(".history-group").disabled, false);
    assert.equal(s.d.getElementById("history-next").disabled, false);
  } finally {
    s.close();
  }
});

test("an arriving inspector body reveals itself only while its heading retains focus", async () => {
  let finish;
  const s = await setup((name) =>
    name === "storybloq_timeline_group"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : basic(name),
  );
  try {
    let reveals = 0;
    s.d.getElementById("history-detail").scrollIntoView = () => reveals++;
    s.click("nav-timeline");
    await tick();
    const page = payload("handovers", {
      items: [],
      total: 0,
      offset: 0,
      limit: 10,
    });
    s.d.querySelector(".history-group").click();
    finish(page);
    await tick();
    assert.equal(reveals, 1);
    s.d.querySelector(".history-group").click();
    s.d.getElementById("history-close").focus();
    finish(page);
    await tick();
    assert.equal(reveals, 1);
    assert.equal(s.d.activeElement.id, "history-close");
  } finally {
    s.close();
  }
});

test("retained day and handover controls cannot reopen a closed or replaced inspector", async () => {
  for (const control of [
    ".history-back",
    ".handover-row",
    ".group-next",
    ".group-retry",
  ]) {
    for (const action of ["close", "select"]) {
      const calls = [];
      const s = await setup(async (name, args) => {
        calls.push({ name, args });
        if (name === "storybloq_timeline")
          return payload("history", {
            ...history,
            groups: {
              ...history.groups,
              items: [
                ...history.groups.items,
                {
                  key: "second",
                  date: "2026-09-29",
                  count: 2,
                  title: "2026-09-29",
                },
              ],
              total: 2,
            },
          });
        if (name === "storybloq_timeline_group")
          return control === ".group-retry" && args.group === group
            ? { isError: true }
            : payload("handovers", {
                items: [{ key: handover, title: "Work", date: null }],
                offset: 0,
                limit: 1,
                total: 2,
              });
        if (name === "storybloq_handover_detail")
          return payload("handover", { content: "Work", truncated: false });
        return basic(name);
      });
      try {
        s.click("nav-timeline");
        await tick();
        const dates = s.d.querySelectorAll(".history-group");
        dates[0].click();
        await tick();
        if (control === ".history-back") {
          s.d.querySelector(".handover-row").click();
          await tick();
        }
        const retained = s.d.querySelector(control);
        const handler = retained.onclick;
        if (action === "close") s.click("history-close");
        else dates[1].click();
        await tick();
        const before = calls.length,
          heading = s.d.getElementById("history-detail-title").textContent;
        handler.call(retained, new s.d.defaultView.MouseEvent("click"));
        await tick();
        assert.equal(calls.length, before, `${control} after ${action}`);
        assert.equal(
          s.d.getElementById("history-detail-title").textContent,
          heading,
        );
        assert.equal(
          s.d.getElementById("history-detail").hidden,
          action === "close",
        );
      } finally {
        s.close();
      }
    }
  }
});
