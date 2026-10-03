import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  symlink,
  readdir,
  rm,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readLedgerSnapshot } from "../src/ledger-reader.js";
import { readBoard, page, detail } from "../src/board.js";
import { createServer, RESOURCE_URI } from "../src/server.js";
import { fixture, ticket, issue } from "./fixture.js";
import { overviewPage, initialQuery } from "../src/overview.js";
test("canonical derivations, lifecycle, mixed IDs, projection and pagination", async () => {
  const f = await fixture();
  try {
    await f.put("tickets/T-001.json", ticket("T-001", { status: "complete" }));
    await f.put(
      "tickets/t-0123456789abcdef.json",
      ticket("t-0123456789abcdef", {
        displayId: "T-002",
        parentTicket: "T-001",
        status: "inprogress",
      }),
    );
    await f.put(
      "tickets/T-003.json",
      ticket("T-003", { lifecycle: "deleted" }),
    );
    const b = await readBoard(f.root);
    assert.equal(b.tickets.length, 2);
    assert.equal(b.tickets.find((t) => t.id === "T-001")?.status, "inprogress");
    assert.equal(b.phases[0].status, "inprogress");
    assert.equal(
      page(b, {
        kind: "tickets",
        limit: 1,
        offset: 0,
        query: "",
        status: "all",
      }).items.length,
      1,
    );
    assert.equal(
      page(b, {
        kind: "tickets",
        query: "T-002",
        status: "all",
        limit: 100,
        offset: 0,
      }).total,
      1,
    );
    assert.equal(detail(b, "tickets", "t-0123456789abcdef").displayId, "T-002");
    assert.ok(!JSON.stringify(b).includes("DO_NOT_EXPOSE"));
    assert.ok(!JSON.stringify(b).includes(f.root));
  } finally {
    await f.cleanup();
  }
});
test("Git-omitted empty ticket and issue collections load without creating directories", async () => {
  for (const absent of [["tickets"], ["issues"], ["tickets", "issues"]]) {
    const f = await fixture();
    try {
      for (const dir of absent)
        await rm(join(f.root, ".story", dir), { recursive: true });
      const before = await readdir(join(f.root, ".story"));
      const b = await readBoard(f.root);
      assert.equal(b.tickets.length, absent.includes("tickets") ? 0 : 1);
      assert.equal(b.issues.length, absent.includes("issues") ? 0 : 1);
      assert.deepEqual(await readdir(join(f.root, ".story")), before);
      const proof = await readLedgerSnapshot(f.root, () => null);
      await proof.revalidate();
      const restored = absent[0]!;
      await mkdir(join(f.root, ".story", restored));
      await assert.rejects(
        proof.revalidate(),
        /project changed while loading/i,
      );
      await f.put(
        `${restored}/${restored === "tickets" ? "T-002" : "ISS-002"}.json`,
        restored === "tickets" ? ticket("T-002") : issue("ISS-002"),
      );
      const after = await readBoard(f.root);
      assert.equal(
        restored === "tickets" ? after.tickets.length : after.issues.length,
        1,
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("collection paths that exist as links or files still fail closed", async () => {
  for (const dir of ["tickets", "issues"]) {
    for (const shape of ["file", "link", "dangling"]) {
      const f = await fixture();
      try {
        const path = join(f.root, ".story", dir);
        await rm(path, { recursive: true });
        if (shape === "file") await writeFile(path, "not a directory");
        else
          await symlink(
            shape === "link" ? f.root : join(f.root, "missing"),
            path,
          );
        await assert.rejects(readBoard(f.root));
      } finally {
        await f.cleanup();
      }
    }
  }
});
test("malformed, pending transaction, symlink and oversize data fail closed", async () => {
  for (const mode of ["malformed", "journal", "symlink", "oversize"]) {
    const f = await fixture();
    try {
      const p = join(f.root, ".story/tickets/T-001.json");
      if (mode === "malformed") await writeFile(p, '{"private":"SECRET"');
      if (mode === "journal") await f.put(".txn.json", { secret: "SECRET" });
      if (mode === "symlink")
        await symlink("/etc/passwd", join(f.root, ".story/tickets/T-002.json"));
      if (mode === "oversize")
        await f.put(
          "tickets/T-001.json",
          ticket("T-001", { description: "x".repeat(1024 * 1024) }),
        );
      await assert.rejects(
        readBoard(f.root),
        (e) =>
          !String(e).includes(f.root) &&
          !String(e).includes("SECRET") &&
          (mode !== "oversize" || String(e).includes("1 MiB")),
      );
    } finally {
      await f.cleanup();
    }
  }
});
test("MCP exposes read-only UI tools, resource and sanitized failures without writes", async () => {
  const f = await fixture();
  const server = createServer(f.root, "<!doctype html><h1>Board</h1>");
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    const before = await inventory(f.root);
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 17);
    for (const t of tools) {
      assert.equal(
        t.annotations?.readOnlyHint,
        ![
          "storybloq_item_save",
          "storybloq_ticket_reopen",
          "storybloq_note_save",
        ].includes(t.name),
      );
      assert.equal(
        t.annotations?.destructiveHint,
        [
          "storybloq_item_save",
          "storybloq_ticket_reopen",
          "storybloq_note_save",
        ].includes(t.name),
      );
    }
    for (const t of tools) {
      assert.equal((t._meta?.ui as any)?.resourceUri, RESOURCE_URI);
      if (t.name !== "storybloq_board")
        assert.deepEqual((t._meta?.ui as any)?.visibility, ["app"]);
    }
    assert.deepEqual(
      (
        tools.find((t) => t.name === "storybloq_board")?._meta?.[
          "openai/ui"
        ] as any
      )?.entrypoints,
      [{ type: "global" }, { type: "thread" }],
    );
    const open = await client.callTool({
      name: "storybloq_board",
      arguments: {},
    });
    assert.equal(open.isError, undefined);
    assert.ok(open._meta?.overview);
    assert.ok(
      !JSON.stringify(open.structuredContent).includes("Ship the board"),
    );
    const resource = await client.readResource({ uri: RESOURCE_URI });
    assert.match(
      String("text" in resource.contents[0] ? resource.contents[0].text : ""),
      /Board/,
    );
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(resource.contents[0]._meta?.ui, {
      csp: { connectDomains: [], resourceDomains: [] },
    });
    const list = await client.callTool({
      name: "storybloq_board_list",
      arguments: { kind: "tickets" },
    });
    assert.ok(list._meta?.board);
    const overview = await client.callTool({
      name: "storybloq_board_overview",
      arguments: { limit: 1 },
    });
    assert.equal(
      (overview._meta?.overview as any).columns.open.items.length,
      1,
    );
    const wirePhase = (overview._meta?.overview as any).phases[0].key;
    const phaseResponse = await client.callTool({
      name: "storybloq_board_overview",
      arguments: { phase: wirePhase },
    });
    assert.equal(phaseResponse.isError, undefined);
    assert.equal((phaseResponse._meta?.overview as any).columns.open.total, 1);
    const removedPhase = await client.callTool({
      name: "storybloq_board_overview",
      arguments: { phase: "f".repeat(64) },
    });
    assert.equal(removedPhase.isError, true);
    assert.match(JSON.stringify(removedPhase._meta), /Select that phase again/);
    assert.ok(!JSON.stringify(overview).includes("DO_NOT_EXPOSE"));
    const excessive = await client.callTool({
      name: "storybloq_board_overview",
      arguments: { limit: 21 },
    });
    assert.equal(excessive.isError, true);
    const invalid = await client.callTool({
      name: "storybloq_board_detail",
      arguments: { kind: "tickets", id: "../../etc/passwd" },
    });
    assert.equal(invalid.isError, true);
    const item = await client.callTool({
      name: "storybloq_board_detail",
      arguments: { kind: "tickets", id: "T-001" },
    });
    assert.equal(item.isError, undefined);
    assert.equal(
      (item._meta?.item as any).description,
      "A useful project board",
    );
    assert.deepEqual(await inventory(f.root), before);
    await writeFile(join(f.root, ".story/tickets/T-001.json"), "SECRET");
    const failure = await client.callTool({
      name: "storybloq_board",
      arguments: {},
    });
    assert.equal(failure.isError, true);
    assert.ok(!JSON.stringify(failure).includes("SECRET"));
    assert.ok(!JSON.stringify(failure).includes(f.root));
  } finally {
    await client.close();
    await server.close();
    await f.cleanup();
  }
});

test("overview preserves leaf identity, lifecycle and bounded pages", async () => {
  const f = await fixture();
  try {
    const tickets = [
      ticket("T-001", { status: "complete" }),
      ticket("t-0123456789abcdef", {
        displayId: "T-002",
        parentTicket: "T-001",
        status: "inprogress",
        blockedBy: ["T-999"],
        order: 1,
      }),
      ticket("T-003", { order: 0 }),
      ticket("T-004", { lifecycle: "deleted" }),
      ticket("T-005", { status: "complete" }),
    ];
    const issues = [
      issue(),
      issue("ISS-002", { severity: "critical" }),
      issue("ISS-003", { status: "resolved" }),
    ];
    for (const t of tickets) await f.put(`tickets/${t.id}.json`, t);
    for (const i of issues) await f.put(`issues/${i.id}.json`, i);
    const board = (await readBoard(f.root)).overview;
    assert.deepEqual(board.columns.open.items.map((i) => i.id).sort(), [
      "ISS-001",
      "ISS-002",
      "T-003",
    ]);
    assert.equal(board.columns.inProgress.items[0].blocked, true);
    assert.equal(board.columns.inProgress.items[0].id, "t-0123456789abcdef");
    assert.equal(board.columns.inProgress.items[0].displayId, "T-002");
    assert.equal(board.summary.total, 3);
    assert.equal(board.summary.complete, 1);
    assert.equal(board.summary.openIssues, 2);
    assert.equal(board.summary.severity.critical, 1);
    const filtered = overviewPage(board, {
      ...initialQuery,
      kind: "issues",
      query: "ISS",
      limit: 1,
      open: 10000,
    });
    assert.equal(filtered.columns.open.total, 2);
    assert.equal(filtered.columns.open.offset, 1);
    assert.equal(filtered.columns.open.items.length, 1);
    assert.equal(filtered.summary.openIssues, 2);
    assert.equal(
      overviewPage(board, { ...initialQuery, query: "absent", open: 6 }).columns
        .open.offset,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test("hidden retired and invalidated checkpoints keep canonical counts, phases and blockers", async () => {
  const f = await fixture();
  const checkpoint = {
    kind: "decision",
    owner: "Amir",
    question: "Proceed?",
    evidenceRefs: [],
    lifecycle: "retired",
    retiredAt: "2026-09-30",
    revision: 1,
    digest: "0".repeat(64),
    generation: 1,
    history: [],
  };
  try {
    await f.put("tickets/T-001.json", ticket("T-001", { status: "complete" }));
    await f.put(
      "tickets/T-002.json",
      ticket("T-002", { ownerCheckpoint: checkpoint }),
    );
    let board = (await readBoard(f.root)).overview;
    assert.equal(board.summary.complete, 2);
    assert.equal(board.summary.total, 2);
    assert.equal(board.currentPhase, null);
    assert.equal(board.columns.open.total, 1); // Fixture issue remains open.
    assert.equal(board.columns.done.total, 1);
    await f.put(
      "tickets/T-003.json",
      ticket("T-003", { blockedBy: ["T-002"] }),
    );
    board = (await readBoard(f.root)).overview;
    assert.equal(board.columns.open.items[0].blocked, false);
    await f.put(
      "tickets/T-002.json",
      ticket("T-002", {
        status: "complete",
        ownerCheckpoint: {
          ...checkpoint,
          lifecycle: "active",
          retiredAt: undefined,
        },
      }),
    );
    board = (await readBoard(f.root)).overview;
    assert.equal(board.summary.complete, 1);
    assert.equal(board.summary.blocked, 1);
    assert.equal(board.currentPhase?.status, "inprogress");
    assert.equal(board.columns.open.items[0].blocked, true);
    assert.ok(!JSON.stringify(board).includes("Proceed?"));
  } finally {
    await f.cleanup();
  }
});
test("bounds, future schemas, directory symlinks and duplicate IDs are rejected", async () => {
  for (const mode of ["future", "phases", "directory", "duplicate"]) {
    const f = await fixture();
    try {
      if (mode === "future") {
        const c = JSON.parse(
          await readFile(join(f.root, ".story/config.json"), "utf8"),
        );
        await f.put("config.json", { ...c, schemaVersion: 999 });
      }
      if (mode === "phases") {
        const r = JSON.parse(
          await readFile(join(f.root, ".story/roadmap.json"), "utf8"),
        );
        await f.put("roadmap.json", {
          ...r,
          phases: Array.from({ length: 201 }, (_, i) => ({
            ...r.phases[0],
            id: `p${i}`,
          })),
        });
      }
      if (mode === "duplicate") await f.put("tickets/duplicate.json", ticket());
      if (mode === "directory") {
        const { rename } = await import("node:fs/promises");
        await rename(join(f.root, ".story/tickets"), join(f.root, "outside"));
        await symlink(join(f.root, "outside"), join(f.root, ".story/tickets"));
      }
      await assert.rejects(readBoard(f.root));
    } finally {
      await f.cleanup();
    }
  }
});
test("description truncation and stable pages remain bounded", async () => {
  const f = await fixture();
  try {
    await f.put(
      "tickets/T-001.json",
      ticket("T-001", { description: "x".repeat(13000) }),
    );
    for (let i = 2; i < 104; i++)
      await f.put(`tickets/T-${i}.json`, ticket(`T-${i}`));
    const b = await readBoard(f.root);
    assert.equal(detail(b, "tickets", "T-001").truncated, true);
    assert.equal(detail(b, "tickets", "T-001").description.length, 12001);
    const p = page(b, {
      kind: "tickets",
      query: "",
      status: "open",
      offset: 100,
      limit: 100,
    });
    assert.equal(p.total, 103);
    assert.equal(p.items.length, 3);
    assert.ok(!("description" in p.items[0]));
  } finally {
    await f.cleanup();
  }
});
test("actual stdio entrypoint initializes and reads a fixture", async () => {
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const f = await fixture();
  const c = new Client({ name: "stdio-probe", version: "1" });
  try {
    await c.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/server.js"],
        env: { STORYBLOQ_PROJECT_ROOT: f.root },
        stderr: "pipe",
      }),
    );
    const r = await c.callTool({ name: "storybloq_board", arguments: {} });
    assert.equal(
      (r.structuredContent as Record<string, unknown>)?.project,
      "Demo project",
    );
    assert.equal(r.isError, undefined);
  } finally {
    await c.close();
    await f.cleanup();
  }
});

async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string, prefix: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        result[name + "/"] = "directory";
        await walk(join(path, entry.name), name + "/");
      } else
        result[name] = createHash("sha256")
          .update(await readFile(join(path, entry.name)))
          .digest("hex");
    }
  }
  await walk(join(root, ".story"), "");
  return result;
}

test("Mac board sorts mixed phases and recent completions, filters and searches full bodies without leaking them", async () => {
  const f = await fixture();
  try {
    await f.put("roadmap.json", {
      title: "Roadmap",
      date: "2026-09-29",
      blockers: [],
      phases: [
        { id: "p2", label: "02", name: "Second", description: "" },
        { id: "p1", label: "01", name: "First", description: "" },
      ],
    });
    await f.put(
      "tickets/T-001.json",
      ticket("T-001", {
        type: "feature",
        order: 1,
        description: "x".repeat(1000) + " PRIVATE_SEARCH_MARKER",
      }),
    );
    await f.put(
      "tickets/T-002.json",
      ticket("T-002", { phase: "p2", order: 3 }),
    );
    await f.put(
      "tickets/T-003.json",
      ticket("T-003", { phase: null, order: 0 }),
    );
    await f.put(
      "tickets/T-004.json",
      ticket("T-004", {
        status: "complete",
        completedDate: "2026-09-28",
        phase: "p2",
      }),
    );
    await f.put(
      "tickets/T-005.json",
      ticket("T-005", {
        status: "complete",
        completedDate: "2026-09-30",
        phase: null,
      }),
    );
    await f.put(
      "issues/ISS-001.json",
      issue("ISS-001", { phase: "p2", order: 2, components: ["cache"] }),
    );
    await f.put(
      "issues/ISS-002.json",
      issue("ISS-002", {
        status: "resolved",
        resolvedDate: "2026-09-29",
        phase: "p1",
      }),
    );
    const b = (await readBoard(f.root)).overview;
    assert.deepEqual(
      b.columns.open.items.map((i) => i.id),
      ["ISS-001", "T-002", "T-001", "T-003"],
    );
    assert.deepEqual(
      b.columns.done.items.map((i) => i.id),
      ["T-005", "ISS-002", "T-004"],
    );
    const phases = (b as any).phases;
    assert.deepEqual(
      phases.map((p: any) => p.name),
      ["Second", "First"],
    );
    assert.match(phases[0].key, /^[a-f0-9]{64}$/);
    const selected = overviewPage(b, {
      ...initialQuery,
      phase: phases[0].key,
    } as any);
    assert.deepEqual(
      selected.columns.open.items.map((i) => i.id),
      ["ISS-001", "T-002"],
    );
    const unphased = overviewPage(b, {
      ...initialQuery,
      phase: "unphased",
    } as any);
    assert.deepEqual(
      unphased.columns.open.items.map((i) => i.id),
      ["T-003"],
    );
    const body = overviewPage(b, {
      ...initialQuery,
      query: "PRIVATE_SEARCH_MARKER",
    });
    assert.deepEqual(
      body.columns.open.items.map((i) => i.id),
      ["T-001"],
    );
    assert.ok(!JSON.stringify(body).includes("PRIVATE_SEARCH_MARKER"));
    assert.ok(!("search" in body));
    assert.ok((body.columns.open.items[0] as any).description.length <= 321);
    for (const query of ["feature", "cache", "Second"])
      assert.ok(
        overviewPage(b, { ...initialQuery, query }).columns.open.total > 0,
      );
    assert.throws(
      () => overviewPage(b, { ...initialQuery, phase: "f".repeat(64) } as any),
      /Select that phase again/,
    );
  } finally {
    await f.cleanup();
  }
});

test("duplicate phases fail closed; long phase IDs remain bounded and selectable", async () => {
  const f = await fixture();
  try {
    const phase = {
      id: "p".repeat(65536),
      label: "L".repeat(1000),
      name: "N".repeat(1000),
      description: "",
    };
    await f.put("roadmap.json", {
      title: "Roadmap",
      date: "2026-09-29",
      blockers: [],
      phases: [phase],
    });
    await f.put("tickets/T-001.json", ticket("T-001", { phase: phase.id }));
    const b = (await readBoard(f.root)).overview;
    const selected = overviewPage(b, {
      ...initialQuery,
      phase: (b as any).phases[0].key,
    } as any);
    assert.equal(selected.columns.open.items[0].id, "T-001");
    assert.ok(JSON.stringify(selected).length < 5000);
    await f.put("roadmap.json", {
      title: "Roadmap",
      date: "2026-09-29",
      blockers: [],
      phases: [phase, phase],
    });
    await assert.rejects(readBoard(f.root), /Duplicate phase/);
  } finally {
    await f.cleanup();
  }
});

test("Mac current phase is the first in-progress phase, with additional active phases retained", async () => {
  const f = await fixture();
  try {
    const phases = ["p0", "p1", "p2", "p3"].map((id) => ({
      id,
      label: id,
      name: id,
      description: "",
    }));
    await f.put("roadmap.json", {
      title: "Roadmap",
      date: "2026-09-29",
      blockers: [],
      phases,
    });
    await f.put("tickets/T-001.json", ticket("T-001", { phase: "p0" }));
    await f.put(
      "tickets/T-002.json",
      ticket("T-002", { phase: "p1", status: "inprogress" }),
    );
    await f.put(
      "tickets/T-003.json",
      ticket("T-003", { phase: "p2", status: "complete" }),
    );
    await f.put(
      "tickets/T-004.json",
      ticket("T-004", { phase: "p3", status: "inprogress" }),
    );
    const b = (await readBoard(f.root)).overview;
    assert.equal(b.currentPhase?.id, "p1");
    assert.deepEqual(
      b.phases.map((p) => [p.status, p.current]),
      [
        ["notstarted", false],
        ["inprogress", true],
        ["complete", false],
        ["inprogress", false],
      ],
    );
  } finally {
    await f.cleanup();
  }
});
test("a valid ticket exactly at the file limit is accepted", async () => {
  const f = await fixture();
  try {
    const base = ticket("T-001", { description: "" });
    const overhead = Buffer.byteLength(JSON.stringify(base));
    await f.put("tickets/T-001.json", {
      ...base,
      description: "x".repeat(1048576 - overhead),
    });
    assert.equal((await readBoard(f.root)).tickets.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("deleted display identities remain in the canonical reference graph", async () => {
  const f = await fixture();
  try {
    await f.put(
      "tickets/T-001.json",
      ticket("T-001", { previousDisplayIds: ["T-009"] }),
    );
    await f.put(
      "tickets/T-002.json",
      ticket("T-002", { displayId: "T-009", lifecycle: "deleted" }),
    );
    await f.put(
      "tickets/T-003.json",
      ticket("T-003", { parentTicket: "T-009" }),
    );
    const overview = (await readBoard(f.root)).overview;
    assert.equal(overview.summary.total, 2);
    assert.deepEqual(
      overview.columns.open.items
        .filter((i) => i.kind === "tickets")
        .map((i) => i.id)
        .sort(),
      ["T-001", "T-003"],
    );
  } finally {
    await f.cleanup();
  }
});

test("overview caps huge display labels while preserving canonical detail identity", async () => {
  const f = await fixture();
  try {
    await f.put(
      "tickets/T-001.json",
      ticket("T-001", { displayId: "T-" + "9".repeat(65536) }),
    );
    await f.put(
      "issues/ISS-001.json",
      issue("ISS-001", { displayId: "ISS-" + "8".repeat(65536) }),
    );
    const board = await readBoard(f.root);
    const overview = overviewPage(board.overview, initialQuery);
    for (const card of overview.columns.open.items) {
      assert.ok(card.displayId.length <= 81);
      assert.equal(detail(board, card.kind, card.id).id, card.id);
    }
    assert.ok(JSON.stringify(overview).length < 3000);
  } finally {
    await f.cleanup();
  }
});
