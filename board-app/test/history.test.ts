import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import {
  transientHistory,
  readHistoryIndex,
  historyPage,
} from "../src/history.js";
import { fixture, ticket } from "./fixture.js";

async function connect(root: string) {
  const server = createServer(root, "<h1>Board</h1>");
  const client = new Client({ name: "history-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
async function historyFixture() {
  const f = await fixture();
  await mkdir(join(f.root, ".story/handovers"));
  const put = (name: string, text = "# Handover\n\nRecorded work.") =>
    writeFile(join(f.root, ".story/handovers", name), text);
  return { ...f, handover: put };
}
test("history groups filenames, pages children, uses phase ticket dates and completed milestones", async () => {
  const f = await historyFixture();
  const c = await connect(f.root);
  try {
    await f.put("roadmap.json", {
      title: "Roadmap",
      date: "2026-09-29",
      blockers: [],
      phases: [
        {
          id: "p1",
          label: "01",
          name: "First",
          description: "",
          summary: "Foundation",
        },
        { id: "empty", label: "02", name: "Empty", description: "" },
      ],
    });
    await f.put(
      "tickets/T-001.json",
      ticket("T-001", {
        createdDate: "2026-09-20",
        status: "complete",
        completedDate: "2026-09-22",
      }),
    );
    await f.put(
      "tickets/T-002.json",
      ticket("T-002", { phase: null, createdDate: "2026-09-28" }),
    );
    for (const name of [
      "2026-09-30-newest.md",
      "2026-09-21-01-first.md",
      "2026-09-21-02-second.md",
      "undated.md",
      "2026-99-99-invalid.md",
    ])
      await f.handover(name);
    const r: any = await c.client.callTool({
      name: "storybloq_timeline",
      arguments: {},
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.content, []);
    const h = r._meta.history;
    assert.deepEqual(
      h.groups.items.map((g: any) => [g.date, g.count]),
      [
        ["2026-09-30", 1],
        ["2026-09-21", 2],
        [null, 2],
      ],
    );
    assert.equal(h.groups.items[0].title, "2026-09-30");
    assert.deepEqual(h.groups.items[0].previewTitles, ["newest"]);
    assert.deepEqual(Object.keys(h.groups.items[0].singleHandover).sort(), [
      "date",
      "key",
      "title",
    ]);
    assert.equal(h.groups.items[0].singleHandover.title, "newest");
    assert.deepEqual(h.groups.items[1].previewTitles, [
      "02 second",
      "01 first",
    ]);
    assert.equal(h.groups.items[1].singleHandover, undefined);
    assert.equal(h.groups.items[2].title, "Unknown date");
    assert.equal(h.milestones[0].date, "2026-09-22");
    assert.equal(h.milestones[0].title, "First");
    assert.ok(!JSON.stringify(r).includes(f.root));
    assert.ok(!JSON.stringify(r).includes("DO_NOT_EXPOSE"));
    const key = h.phases[0].key;
    const filtered: any = await c.client.callTool({
      name: "storybloq_timeline",
      arguments: { phase: key },
    });
    assert.deepEqual(
      filtered._meta.history.groups.items.map((g: any) => g.date),
      ["2026-09-21"],
    );
    const empty: any = await c.client.callTool({
      name: "storybloq_timeline",
      arguments: { phase: h.phases[1].key },
    });
    assert.equal(empty._meta.history.groups.total, 0);
    const unphased: any = await c.client.callTool({
      name: "storybloq_timeline",
      arguments: { phase: "unphased" },
    });
    assert.equal(unphased._meta.history.groups.total, 0);
    const group = h.groups.items[1].key;
    const first: any = await c.client.callTool({
      name: "storybloq_timeline_group",
      arguments: { group, limit: 1 },
    });
    assert.equal(first._meta.handovers.total, 2);
    assert.equal(first._meta.handovers.items[0].title, "02 second");
    const next: any = await c.client.callTool({
      name: "storybloq_timeline_group",
      arguments: { group, limit: 1, offset: 1 },
    });
    assert.equal(next._meta.handovers.items[0].title, "01 first");
    assert.match(next._meta.handovers.items[0].key, /^[a-f0-9]{64}$/);
    const detail: any = await c.client.callTool({
      name: "storybloq_handover_detail",
      arguments: { id: next._meta.handovers.items[0].key },
    });
    assert.match(detail._meta.handover.content, /Recorded work/);
    await rm(join(f.root, ".story/handovers/2026-09-21-01-first.md"));
    const removed: any = await c.client.callTool({
      name: "storybloq_handover_detail",
      arguments: { id: next._meta.handovers.items[0].key },
    });
    assert.equal(removed.isError, true);
  } finally {
    await c.close();
    await f.cleanup();
  }
});
test("handover boundaries reject symlinks, oversized and path arguments without reading or writing elsewhere", async () => {
  for (const mode of ["symlink", "oversize", "directory-link", "journal"]) {
    const f = await historyFixture();
    const c = await connect(f.root);
    let outside: string | undefined;
    try {
      const target = join(f.root, ".story/handovers/2026-09-30-work.md");
      if (mode === "symlink") await symlink("/etc/passwd", target);
      else if (mode === "oversize")
        await writeFile(target, "x".repeat(1048577));
      else if (mode === "directory-link") {
        // An isolated directory holding one valid handover, so only the link
        // itself can refuse it.
        outside = await mkdtemp(join(tmpdir(), "handovers-outside-"));
        await writeFile(
          join(outside, "2026-09-30-outside.md"),
          "# Handover\n\nRecorded work.",
        );
        await rm(join(f.root, ".story/handovers"), { recursive: true });
        await symlink(outside, join(f.root, ".story/handovers"));
      } else await f.put(".txn.json", { secret: "DO_NOT_EXPOSE" });
      const r: any = await c.client.callTool({
        name: "storybloq_timeline",
        arguments: {},
      });
      if (mode === "oversize") {
        assert.equal(r.isError, undefined);
        const g: any = await c.client.callTool({
          name: "storybloq_timeline_group",
          arguments: { group: r._meta.history.groups.items[0].key },
        });
        const body: any = await c.client.callTool({
          name: "storybloq_handover_detail",
          arguments: { id: g._meta.handovers.items[0].key },
        });
        assert.equal(body.isError, true);
      } else assert.equal(r.isError, true);
      assert.ok(!JSON.stringify(r).includes(f.root));
      assert.ok(!JSON.stringify(r).includes("DO_NOT_EXPOSE"));
      const escaped: any = await c.client.callTool({
        name: "storybloq_handover_detail",
        arguments: { id: "../../config.json" },
      });
      assert.equal(escaped.isError, true);
    } finally {
      await c.close();
      await f.cleanup();
      if (outside) await rm(outside, { recursive: true, force: true });
    }
  }
});
test("missing history is empty and bounded body preview remains unchanged on disk", async () => {
  const f = await fixture();
  const c = await connect(f.root);
  try {
    const empty: any = await c.client.callTool({
      name: "storybloq_timeline",
      arguments: {},
    });
    assert.equal(empty._meta.history.groups.total, 0);
    await mkdir(join(f.root, ".story/handovers"));
    const path = join(f.root, ".story/handovers/2026-09-30-large.md"),
      text = "# Large\n" + "x".repeat(50000);
    await writeFile(path, text);
    const h: any = await c.client.callTool({
      name: "storybloq_timeline",
      arguments: { limit: 1 },
    });
    const g: any = await c.client.callTool({
      name: "storybloq_timeline_group",
      arguments: { group: h._meta.history.groups.items[0].key },
    });
    const r: any = await c.client.callTool({
      name: "storybloq_handover_detail",
      arguments: { id: g._meta.handovers.items[0].key },
    });
    assert.equal(r._meta.handover.truncated, true);
    assert.ok(r._meta.handover.content.length <= 48001);
    assert.equal(await readFile(path, "utf8"), text);
  } finally {
    await c.close();
    await f.cleanup();
  }
});

test("concurrent history pages share a validated transient read without caching completed data", async () => {
  const f = await historyFixture();
  try {
    await f.handover("2026-09-30-first.md");
    await f.handover("undated.md");
    let calls = 0,
      release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshot = transientHistory(f.root, async (root) => {
      calls++;
      await barrier;
      return readHistoryIndex(root);
    });
    const a = snapshot(),
      b = snapshot();
    assert.equal(calls, 1);
    assert.equal(a, b);
    release();
    const [first, second] = await Promise.all([a, b]);
    assert.equal(
      historyPage(first, { phase: "all", offset: 0, limit: 1 }).groups.total,
      2,
    );
    assert.equal(
      historyPage(second, { phase: "all", offset: 1, limit: 1 }).groups.items[0]
        .date,
      null,
    );
    await f.handover("2026-09-29-added.md");
    const updated = await snapshot();
    assert.equal(calls, 2);
    assert.equal(
      historyPage(updated, { phase: "all", offset: 0, limit: 10 }).groups.total,
      3,
    );
  } finally {
    await f.cleanup();
  }
});

test("date summaries bound preview titles and never need handover bodies", async () => {
  const f = await historyFixture();
  try {
    for (let i = 0; i < 5; i++)
      await f.handover(
        `2026-09-30-${i}-session.md`,
        "PRIVATE_BODY" + "x".repeat(1048577),
      );
    const h = historyPage(await readHistoryIndex(f.root), {
      phase: "all",
      offset: 0,
      limit: 10,
    });
    const group = h.groups.items[0];
    assert.equal(group.count, 5);
    assert.deepEqual(group.previewTitles, [
      "4 session",
      "3 session",
      "2 session",
    ]);
    assert.equal(group.singleHandover, undefined);
    assert.ok(!JSON.stringify(h).includes("PRIVATE_BODY"));
    assert.ok(!JSON.stringify(h).includes(".md"));
    assert.ok(!JSON.stringify(h).includes(f.root));
  } finally {
    await f.cleanup();
  }
});
