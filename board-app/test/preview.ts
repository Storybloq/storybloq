// Fixture-only browser harness. Never bundled into the MCP resource.
import { mountWorkspace } from "../src/workspace-view.js";
import type { ItemEditor, EditableValue } from "../src/editor-types.js";
import type { NoteCard, NoteEditor } from "../src/notes-types.js";
import type { SessionsPayload, PresenceRow } from "../src/sessions-types.js";
import { parseStatus } from "../src/session-status.js";
import {
  presenceActivity,
  supervision,
  milestoneProjection,
} from "../src/session-projection.js";
import {
  columns,
  initialQuery,
  type Overview,
  type Card,
} from "../src/board-types.js";
const pluginPhase = "a".repeat(64),
  releasePhase = "b".repeat(64);
const make = (
  id: string,
  title: string,
  kind: Card["kind"] = "tickets",
  blocked = false,
  severity: string | null = null,
  phaseKey: string | null = pluginPhase,
): Card => ({
  key: `${kind === "tickets" ? "ticket" : "issue"}:${id}`,
  id,
  displayId: id,
  title,
  kind,
  blocked,
  severity,
  phaseKey,
  description:
    "Keep project work, decisions and progress together in the repository so the next session can continue.",
  tags: [
    kind === "tickets" ? "feature" : "issue",
    phaseKey === pluginPhase ? "ChatGPT plugin" : "Release",
    ...(blocked ? ["Blocked"] : []),
    ...(severity ? [severity] : []),
  ],
});
const groups = {
  open: [
    make("T-542", "Bring the board into ChatGPT"),
    make(
      "T-540",
      "Verify the private tunnel connection",
      "tickets",
      true,
      null,
      null,
    ),
    make("T-548", "Carry decisions into the next session"),
    make("T-544", "Review release readiness"),
    make("T-545", "Keep the project ledger portable"),
    make("ISS-014", "Reconnect after a local restart", "issues", false, "high"),
    make(
      "ISS-015",
      "Refresh after the project changes",
      "issues",
      false,
      "medium",
    ),
  ],
  inProgress: [
    make("T-543", "Bring the Mac board and phase rail to ChatGPT"),
    make(
      "T-536",
      "Prepare the 1.16 release",
      "tickets",
      false,
      null,
      releasePhase,
    ),
    make("T-537", "Make owner checkpoints visible", "tickets", true),
    make("ISS-013", "Preserve focus during a refresh", "issues", false, "high"),
  ],
  done: [
    make("T-539", "Add the private project board prototype"),
    make("T-538", "Preserve context across sessions"),
    make("T-535", "Unify project status across clients"),
    make("T-534", "Keep the review loop independent"),
    make(
      "ISS-012",
      "Handle a missing project gracefully",
      "issues",
      false,
      "medium",
    ),
    make(
      "ISS-011",
      "Show reconciled ticket identities",
      "issues",
      false,
      "low",
    ),
  ],
};
const board: Overview = {
  project: "Storybloq",
  isOrchestrator: true,
  loadedAt: new Date().toISOString(),
  currentPhase: { id: "plugin", name: "ChatGPT plugin", status: "inprogress" },
  phases: [
    {
      key: "c".repeat(64),
      name: "Project foundation",
      label: "01",
      status: "complete",
      current: false,
    },
    {
      key: pluginPhase,
      name: "ChatGPT plugin",
      label: "02",
      status: "inprogress",
      current: true,
    },
    {
      key: releasePhase,
      name: "Release",
      label: "03",
      status: "inprogress",
      current: false,
    },
    {
      key: "d".repeat(64),
      name: "Quality and polish",
      label: "04",
      status: "notstarted",
      current: false,
    },
  ],
  hasUnphased: true,
  summary: {
    total: 524,
    complete: 502,
    blocked: 2,
    openIssues: 3,
    severity: { critical: 0, high: 2, medium: 1, low: 0 },
  },
  columns: Object.fromEntries(
    columns.map((c) => [
      c,
      { items: groups[c], total: groups[c].length, offset: 0 },
    ]),
  ) as Overview["columns"],
  limit: 6,
};
const url = new URL(location.href);
document.querySelector(".eyebrow")!.textContent = "Local preview · sample data";
if (url.searchParams.get("theme") === "dark")
  document.documentElement.dataset.theme = "dark";
if (url.searchParams.has("empty"))
  for (const c of columns)
    board.columns[c] = { items: [], offset: 0, total: 0 };
function page(args = initialQuery): Overview {
  return {
    ...board,
    columns: Object.fromEntries(
      columns.map((c) => {
        const rows = board.columns[c].items.filter(
          (i) =>
            (args.kind === "all" || i.kind === args.kind) &&
            (args.phase === "all" ||
              (args.phase === "unphased"
                ? i.phaseKey === null
                : i.phaseKey === args.phase)) &&
            `${i.displayId} ${i.title} ${i.description} ${i.tags.join(" ")}`
              .toLowerCase()
              .includes(args.query.toLowerCase()),
        );
        const offset = Math.min(
          args[c],
          Math.max(0, Math.ceil(rows.length / args.limit) - 1) * args.limit,
        );
        return [
          c,
          {
            items: rows.slice(offset, offset + args.limit),
            total: rows.length,
            offset,
          },
        ];
      }),
    ) as Overview["columns"],
  };
}
let revisionNumber = 10;
const revision = () => (++revisionNumber).toString(16).padStart(64, "0");
const editors = new Map<string, ItemEditor>();
for (const column of columns)
  for (const card of groups[column]) {
    const status =
      column === "open"
        ? "open"
        : column === "inProgress"
          ? "inprogress"
          : card.kind === "tickets"
            ? "complete"
            : "resolved";
    editors.set(card.key, {
      kind: card.kind,
      id: card.id,
      displayId: card.displayId,
      revision: revision(),
      fields:
        card.kind === "tickets"
          ? {
              title: card.title,
              description:
                "Project context stays in your repository.\n\nThis fixture supports edits in browser memory only. Keep the complete authored body when changing a title.",
              type: "feature",
              status,
              phase: card.phaseKey,
              blockedBy: [],
              crossNodeBlockedBy: [],
            }
          : {
              title: card.title,
              impact:
                "Keep the local project usable after a refresh or reconnect.",
              resolution: column === "done" ? "Verified in the fixture" : null,
              severity: card.severity,
              status,
              phase: card.phaseKey,
            },
      phases: board.phases.map((p) => ({ key: p.key, name: p.name })),
      limitedFields: [],
      canReopen: card.kind === "tickets" && column === "done",
    });
  }
let forceConflict = url.searchParams.has("conflict"),
  forceSaveError = url.searchParams.has("saveError");
const notes = [
  {
    id: "N-141",
    title: "Keep context close to the work",
    content:
      "# A board that carries context\n\n**Decision:** bring the Mac experience into ChatGPT.\n\n- Show the phases and current work\n- Keep handovers, notes and sessions close by\n- Save edits only when the project confirms them\n\n```text\nRead → Decide → Build → Review\n```",
    tags: ["design", "chatgpt", "continuity"],
    status: "active",
    updatedDate: "2026-10-01",
    revision: revision(),
  },
  {
    id: "N-140",
    title: "One project, several agents",
    content:
      "# Working together\n\nThe project ledger is the common ground. Tools report what happened; the record carries the decisions into the next session.",
    tags: [
      "federation",
      "agents",
      "review",
      "coordination",
      "notes",
      "workflow",
      "mac",
      "plugin",
    ],
    status: "active",
    updatedDate: "2026-09-30",
    revision: revision(),
  },
  {
    id: "N-139",
    title: "Long-form design record",
    content:
      "# Long-form context\n\n" +
      "Preserve every authored paragraph when changing the title.\n\n".repeat(
        1000,
      ),
    tags: ["preservation"],
    status: "active",
    updatedDate: "2026-09-29",
    revision: revision(),
  },
  {
    id: "N-138",
    title: null,
    content:
      "# Early direction\n\nA quiet workspace with warm paper, clear hierarchy and room for the work.",
    tags: ["archive", "design"],
    status: "archived",
    updatedDate: "2026-09-28",
    revision: revision(),
  },
] as {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  status: "active" | "archived";
  updatedDate: string;
  revision: string;
}[];
const noteCard = (note: (typeof notes)[number]): NoteCard => ({
  id: note.id,
  displayId: note.id,
  title: note.title,
  preview:
    note.content.length > 240 ? note.content.slice(0, 239) + "…" : note.content,
  tags: note.tags.slice(0, 6),
  hiddenTags: Math.max(0, note.tags.length - 6),
  status: note.status,
  updatedDate: note.updatedDate,
});
const noteEditor = (note: (typeof notes)[number]): NoteEditor => ({
  kind: "notes",
  id: note.id,
  displayId: note.id,
  revision: note.revision,
  fields: {
    title: note.title,
    content:
      note.content.length > 48000
        ? note.content.slice(0, 47999) + "…"
        : note.content,
    tags: note.tags,
    status: note.status,
  },
  limitedFields: note.content.length > 48000 ? ["content"] : [],
  updatedDate: note.updatedDate,
});
let sessionReads = 0;
function demoSessions(offset: number): SessionsPayload {
  const now = Date.now(),
    stamp = (ago: number) => new Date(now - ago).toISOString();
  const mode = new URLSearchParams(location.search).get("session");
  let status: SessionsPayload["status"] = parseStatus(
    JSON.stringify({
      schemaVersion: 1,
      sessionActive: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
      state: "CODE_REVIEW",
      substage: "Independent review",
      observedAt: stamp(12000),
      startedAt: stamp(54 * 60000),
      substageStartedAt: stamp(7 * 60000),
      source: "hook",
      ticket: null,
      currentIssue: {
        id: "ISS-013",
        title: "Preserve focus during a refresh",
        severity: "high",
      },
      targetWork: ["T-543", "T-544", "T-545", "T-546", "ISS-013"],
      completedThisSession: ["T-543", "T-544"],
      claudeStatus: "waiting_for_input",
      alive: true,
      lastMcpCall: stamp(25000),
      lastGuideCall: stamp(40000),
      healthState: "waiting-on-dialog",
      branch: "codex/chatgpt-plugin",
      contextPressure: "high",
      tokenPressure: {
        state: "advisory",
        pctBucket: null,
        ceilingSource: "model",
        ceilingConfidence: "low",
        compactNeeded: false,
      },
      runningSubprocesses: [
        {
          pid: 2451,
          category: "review",
          stage: "CODE_REVIEW",
          startedAt: stamp(60000),
        },
      ],
      lastReviewVerdict: {
        stage: "CODE_REVIEW",
        round: 2,
        verdict: "revise",
        findingCount: 1,
        criticalCount: 0,
        majorCount: 1,
        suggestionCount: 0,
        durationMs: 12000,
        summary:
          "Keep keyboard focus on the same visible control after refreshing.",
      },
      recentDeferrals: { total: 1, critical: 0 },
    }),
    now,
  );
  if (mode === "interactive") status = { kind: "inactive" };
  if (mode === "missing" || mode === "malformed" || mode === "unsupported")
    status = { kind: mode };
  if (mode === "empty")
    return {
      loadedAt: stamp(0),
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
  const items: PresenceRow[] = Array.from(
    { length: mode === "pages" ? 25 : 2 },
    (_, i) => {
      const openTools =
        i % 2
          ? [
              {
                id: "tool",
                tool: "Build",
                target: null,
                startedAt: stamp(180000),
              },
            ]
          : [
              {
                id: "tool",
                tool: "Read",
                target: "src/sessions-view.ts",
                startedAt: stamp(6000),
              },
            ];
      const times = {
        startedAt: stamp((i + 1) * 30 * 60000),
        lastEventAt: stamp(i % 2 ? 180000 : 6000),
        openTools,
      };
      const arrangements =
        i % 2
          ? []
          : [
              {
                arrangementId: "a-0123456789abcdef",
                role: "pen",
                lifecycle: "active",
                supervising: { workerActive: true },
              },
            ];
      return {
        sessionId:
          i === 0
            ? "codex-design"
            : i === 1
              ? "claude-release"
              : "session-" + String(i).padStart(2, "0"),
        ...times,
        source: "resume",
        agentCount: i % 2 ? 1 : 0,
        activity: presenceActivity(times, now),
        arrangements,
        supervision: supervision(arrangements),
        arrangementPresenceTruncated: false,
        milestone: milestoneProjection(
          {
            kind: i % 2 ? "implementing" : "reviewing",
            at: stamp(i % 2 ? 1200000 : 45000),
            note:
              i % 2
                ? "Checking the next release item."
                : "Reviewing the Mac parity increment.",
          },
          now,
        ),
      };
    },
  );
  const page = Math.min(
    offset,
    items.length ? Math.floor((items.length - 1) / 20) * 20 : 0,
  );
  return {
    loadedAt: stamp(0),
    status,
    presence: {
      items: items.slice(page, page + 20),
      total: items.length,
      offset: page,
      limit: 20,
      unread: mode === "malformed" ? 2 : 0,
      malformed: mode === "malformed" ? 1 : 0,
      unsupported: mode === "unsupported" ? 1 : 0,
    },
  };
}
const view = mountWorkspace(document, async (name, args) => {
  if (name === "storybloq_sessions") {
    const mode = new URLSearchParams(location.search).get("session");
    if (mode === "failure" || (mode === "stale" && sessionReads++ > 0))
      throw new Error("Fixture transport failure");
    return { _meta: { sessions: demoSessions(Number(args.offset ?? 0)) } };
  }
  if (name === "storybloq_notes") {
    const query = String(args.query ?? "").toLowerCase(),
      status = args.status ?? "active";
    const items = notes.filter(
      (note) =>
        (status === "all" || status === note.status) &&
        [note.id, note.title ?? "", note.content, ...note.tags].some((value) =>
          value.toLowerCase().includes(query),
        ),
    );
    return {
      _meta: {
        notes: {
          items: items.map(noteCard),
          total: items.length,
          offset: 0,
          limit: 24,
        },
      },
    };
  }
  if (
    [
      "storybloq_note_detail",
      "storybloq_note_editor",
      "storybloq_note_save",
    ].includes(name)
  ) {
    const note = notes.find((note) => note.id === args.id);
    if (!note)
      return {
        isError: true,
        _meta: {
          editError: {
            code: "unavailable",
            message: "This fixture note is unavailable.",
          },
        },
      };
    if (name === "storybloq_note_save") {
      if (forceSaveError) {
        forceSaveError = false;
        throw new Error("Fixture transport failure");
      }
      if (forceConflict) {
        forceConflict = false;
        note.title = "Changed in another session";
        note.revision = revision();
      }
      if (args.revision !== note.revision)
        return {
          isError: true,
          _meta: {
            editError: {
              code: "conflict",
              message:
                "This note changed. Your draft is preserved. Compare the current values.",
            },
          },
        };
      const patch = args.patch as Record<string, EditableValue>;
      if (patch.title !== undefined)
        note.title =
          typeof patch.title === "string" && patch.title.trim()
            ? patch.title
            : null;
      if (typeof patch.content === "string") note.content = patch.content;
      if (Array.isArray(patch.tags))
        note.tags = [
          ...new Set(
            patch.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
          ),
        ];
      if (patch.status === "active" || patch.status === "archived")
        note.status = patch.status;
      note.updatedDate = new Date().toLocaleDateString("en-CA");
      note.revision = revision();
      return { _meta: { editor: noteEditor(note) } };
    }
    if (name === "storybloq_note_editor")
      return { _meta: { editor: noteEditor(note) } };
    const offset = Number(args.offset ?? 0);
    let end = Math.min(offset + 16000, note.content.length);
    if (
      end < note.content.length &&
      /[\uD800-\uDBFF]/.test(note.content[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(note.content[end])
    )
      end--;
    if (args.revision && args.revision !== note.revision)
      return {
        isError: true,
        _meta: {
          editError: {
            code: "conflict",
            message: "Note changed while reading. Reload to try again.",
          },
        },
      };
    return {
      _meta: {
        note: {
          ...noteCard(note),
          revision: note.revision,
          content: note.content.slice(offset, end),
          offset,
          nextOffset: end < note.content.length ? end : null,
        },
      },
    };
  }
  if (
    [
      "storybloq_item_editor",
      "storybloq_item_save",
      "storybloq_ticket_reopen",
    ].includes(name)
  ) {
    const kind = name === "storybloq_ticket_reopen" ? "tickets" : args.kind;
    const key = `${kind === "tickets" ? "ticket" : "issue"}:${args.id}`;
    const editor = editors.get(key);
    if (!editor)
      return {
        isError: true,
        _meta: {
          editError: {
            code: "unavailable",
            message: "This fixture item is unavailable.",
          },
        },
      };
    if (name !== "storybloq_item_editor") {
      if (forceSaveError) {
        forceSaveError = false;
        throw new Error("Fixture transport failure");
      }
      if (forceConflict) {
        forceConflict = false;
        editor.fields.title = "Changed in another session";
        editor.revision = revision();
      }
      if (args.revision !== editor.revision)
        return {
          isError: true,
          _meta: {
            editError: {
              code: "conflict",
              message:
                "This item changed. Your draft is preserved. Reload to compare current values.",
            },
          },
        };
      const patch =
        name === "storybloq_ticket_reopen"
          ? { status: "open" }
          : (args.patch as Record<string, EditableValue>);
      Object.assign(editor.fields, patch);
      editor.revision = revision();
      editor.canReopen =
        kind === "tickets" && editor.fields.status === "complete";
      for (const column of columns) {
        const index = groups[column].findIndex((card) => card.key === key);
        if (index < 0) continue;
        const [card] = groups[column].splice(index, 1);
        card.title = String(editor.fields.title);
        card.description = String(
          editor.fields.description ?? editor.fields.impact,
        );
        card.phaseKey = editor.fields.phase as string | null;
        const target =
          editor.fields.status === "open"
            ? "open"
            : editor.fields.status === "inprogress"
              ? "inProgress"
              : "done";
        groups[target].push(card);
        break;
      }
    }
    return { _meta: { editor: structuredClone(editor) } };
  }
  const group = "e".repeat(64);
  const nodes = [
    {
      name: "models",
      kind: "library",
      role: "Shared project models",
      stack: "Swift",
      summary: "Canonical ledger schemas and relationships",
      health: "green",
      cacheState: "fresh",
      cache: {
        ticketCount: 24,
        completeTickets: 22,
        openTickets: 2,
        issueCount: 3,
        openIssues: 1,
        lastHandoverDate: "2026-09-30",
        lastHandoverTitle: "Preserve project context",
        reachable: true,
      },
    },
    {
      name: "mac",
      kind: "app",
      role: "The human workspace",
      stack: "SwiftUI",
      summary: "Board, timeline, notes and running sessions",
      health: "yellow",
      cacheState: "stale",
      cache: {
        ticketCount: 80,
        completeTickets: 74,
        openTickets: 6,
        issueCount: 4,
        openIssues: 2,
        lastHandoverDate: "2026-09-29",
        lastHandoverTitle: "Bring the board to ChatGPT",
        reachable: true,
      },
    },
    {
      name: "plugin",
      kind: "app",
      role: "Storybloq in ChatGPT",
      stack: "TypeScript",
      summary: "The same project context in a new surface",
      health: "grey",
      cacheState: "missing",
      cache: null,
    },
  ];
  const edges = [
    { type: "build", from: "models", to: "mac" },
    { type: "build", from: "models", to: "plugin" },
    { type: "runtime", from: "plugin", to: "mac", via: "Local ledger" },
  ];
  const historyDays = [
    {
      key: "3".repeat(64),
      date: "2026-10-02",
      titles: [
        "Federation map and connected projects",
        "A quieter, more focused workspace",
        "Performance and interaction polish",
        "Typography across the workspace",
      ],
    },
    {
      key: "4".repeat(64),
      date: "2026-10-01",
      titles: ["Bringing the Mac experience to ChatGPT"],
    },
    {
      key: group,
      date: "2026-09-30",
      titles: ["Mac board and phases", "Plugin design handover"],
    },
    {
      key: "5".repeat(64),
      date: "2026-09-29",
      titles: ["A board that carries context"],
    },
    {
      key: "6".repeat(64),
      date: "2026-09-28",
      titles: ["Project foundation", "Keeping decisions close to the code"],
    },
  ].map((day) => ({
    ...day,
    rows: day.titles.map((title, i) => ({
      key: day.key.slice(0, 63) + i.toString(16),
      title,
      date: day.date,
    })),
  }));
  if (name === "storybloq_timeline")
    return {
      _meta: {
        history: {
          phases: board.phases,
          hasUnphased: true,
          loadedAt: new Date().toISOString(),
          groups: {
            items: historyDays.map((day) => ({
              key: day.key,
              date: day.date,
              title: day.date,
              count: day.rows.length,
              previewTitles: day.titles.slice(0, 3),
              ...(day.rows.length === 1 ? { singleHandover: day.rows[0] } : {}),
            })),
            total: historyDays.length,
            offset: 0,
            limit: 10,
          },
          milestones: [],
        },
      },
    };
  if (name === "storybloq_timeline_group") {
    const rows = historyDays.find((day) => day.key === args.group)?.rows ?? [];
    return {
      _meta: {
        handovers: { items: rows, total: rows.length, offset: 0, limit: 10 },
      },
    };
  }
  if (name === "storybloq_handover_detail") {
    const row = historyDays
      .flatMap((day) => day.rows)
      .find((row) => row.key === args.id);
    return {
      _meta: {
        handover: {
          ...row,
          truncated: false,
          content:
            "# " +
            (row?.title ?? "Handover") +
            "\n\n**Decision:** use the Mac app as the design and behavior reference.\n\n- Keep project work and progress together\n- Carry decisions into the next session\n- Make connections between projects visible\n\n## Verification\n\nThis preview uses sample data. The real handover stays in your project.\n\n```text\nRead → Decide → Build → Review\n```",
        },
      },
    };
  }
  if (name === "storybloq_federation")
    return {
      _meta: {
        federation: {
          isOrchestrator: true,
          nodes,
          edges,
          warnings: [],
          scannedAt: new Date(Date.now() - 600000).toISOString(),
        },
      },
    };
  if (name === "storybloq_node_detail")
    return {
      _meta: {
        node: {
          ...nodes.find((n) => n.name === args.name),
          buildsAfter: args.name === "models" ? [] : ["models"],
          requiredBy: args.name === "models" ? ["mac", "plugin"] : [],
          runtimeIncoming: edges.filter(
            (e) => e.type === "runtime" && e.to === args.name,
          ),
          runtimeOutgoing: edges.filter(
            (e) => e.type === "runtime" && e.from === args.name,
          ),
          preview: {
            state: "ready",
            items: [
              {
                id: "T-544",
                displayId: "T-544",
                title: "Handover timeline and federation",
                status: "inprogress",
              },
              {
                id: "T-545",
                displayId: "T-545",
                title: "Edit tickets and issues",
                status: "open",
              },
            ],
            total: 2,
            offset: 0,
            limit: 10,
          },
        },
      },
    };
  if (name === "storybloq_board_detail") {
    const item = columns
      .flatMap((c) => groups[c])
      .find((i) => i.id === args.id && i.kind === args.kind);
    return {
      _meta: {
        item: {
          ...item,
          description:
            editors.get(item?.key ?? "")?.fields.description ??
            editors.get(item?.key ?? "")?.fields.impact,
          status: editors.get(item?.key ?? "")?.fields.status,
          truncated: false,
        },
      },
    };
  }
  return { _meta: { overview: page(args as unknown as typeof initialQuery) } };
});
view.receive({ _meta: { overview: page() } });
