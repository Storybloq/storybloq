import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  readFile,
  writeFile,
  symlink,
  rm,
  rename,
  cp,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { fixture } from "./fixture.js";

const note = (id = "N-001", extra = {}) => ({
  id,
  title: "Authored note",
  content: "Useful authored content",
  tags: ["design"],
  status: "active",
  createdDate: "2026-09-29",
  updatedDate: "2026-09-29",
  updatedAt: "2026-09-29T12:00:00Z",
  ...extra,
});
async function session() {
  const f = await fixture();
  await mkdir(join(f.root, ".story/notes"));
  await f.put("notes/N-001.json", note());
  const server = createServer(f.root, "<h1>Notes</h1>"),
    client = new Client({ name: "notes-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as any;
  const read = async (id = "N-001") => {
    const r = await call("storybloq_note_editor", { id });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.deepEqual(r.content, []);
    assert.match(r._meta.editor.revision, /^[a-f0-9]{64}$/);
    return r._meta.editor;
  };
  const list = async (args: Record<string, unknown> = {}) => {
    const r = await call("storybloq_notes", args);
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.deepEqual(r.content, []);
    return r._meta.notes;
  };
  const disk = async (id = "N-001") =>
    JSON.parse(
      await readFile(join(f.root, ".story/notes", id + ".json"), "utf8"),
    );
  return {
    ...f,
    call,
    read,
    list,
    disk,
    tools: () => client.listTools(),
    close: async () => {
      await client.close();
      await server.close();
      await f.cleanup();
    },
  };
}
test("notes support mixed identities, full search, filters, deterministic order and bounded cards", async () => {
  const s = await session();
  try {
    const hash = "n-0123456789abcdef";
    await s.put(
      "notes/" + hash + ".json",
      note(hash, {
        displayId: "N-002",
        title: "Latest idea",
        updatedDate: "2026-09-30",
        content: "x".repeat(1000) + " searchable tail",
        tags: Array.from({ length: 8 }, (_, i) => "tag" + i),
        privateExtension: "PRIVATE_NOTE_FIELD",
      }),
    );
    await s.put("notes/N-003.json", note("N-003", { status: "archived" }));
    await s.put("notes/N-004.json", note("N-004", { lifecycle: "deleted" }));
    const active = await s.list();
    assert.deepEqual(
      active.items.map((n: any) => n.id),
      [hash, "N-001"],
    );
    assert.equal(active.total, 2);
    assert.ok(active.items[0].preview.length <= 240);
    assert.equal(active.items[0].tags.length, 6);
    assert.equal(active.items[0].hiddenTags, 2);
    assert.ok(!JSON.stringify(active).includes("PRIVATE_NOTE_FIELD"));
    assert.ok(!JSON.stringify(active).includes(s.root));
    for (const query of ["n-002", "LATEST IDEA", "searchable tail", "TAG7"])
      assert.deepEqual(
        (await s.list({ query })).items.map((n: any) => n.id),
        [hash],
      );
    assert.equal((await s.list({ status: "all" })).total, 3);
    assert.deepEqual(
      (await s.list({ status: "archived" })).items.map((n: any) => n.id),
      ["N-003"],
    );
    const page = await s.list({ limit: 1, offset: 1 });
    assert.deepEqual(
      page.items.map((n: any) => n.id),
      ["N-001"],
    );
    assert.equal(page.total, 2);
  } finally {
    await s.close();
  }
});
test("note save preserves unknown fields and other files while applying canonical normalization and dates", async () => {
  const s = await session();
  try {
    await s.put(
      "notes/N-001.json",
      note("N-001", { privateExtension: { keep: true } }),
    );
    const before = await readFile(join(s.root, ".story/tickets/T-001.json"));
    const e = await s.read();
    assert.ok(!JSON.stringify(e).includes("privateExtension"));
    const dateBefore = new Date().toLocaleDateString("en-CA");
    const result = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: {
        title: " ",
        tags: ["Design", "design", "  docs  "],
        content: "Updated authored content",
      },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const saved = await s.disk();
    assert.equal(saved.title, null);
    assert.deepEqual(saved.tags, ["design", "docs"]);
    assert.equal(saved.content, "Updated authored content");
    assert.ok(
      [dateBefore, new Date().toLocaleDateString("en-CA")].includes(
        saved.updatedDate,
      ),
    );
    assert.equal(saved.createdDate, "2026-09-29");
    assert.deepEqual(saved.privateExtension, { keep: true });
    assert.deepEqual(
      await readFile(join(s.root, ".story/tickets/T-001.json")),
      before,
    );
    assert.equal(result._meta.editor.revision, (await s.read()).revision);
    assert.notEqual(result._meta.editor.revision, e.revision);
  } finally {
    await s.close();
  }
});
test("note archive and unarchive are explicit acknowledged saves and tags can be cleared", async () => {
  const s = await session();
  try {
    let e = await s.read();
    const archived = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { status: "archived", tags: [] },
    });
    assert.equal(archived.isError, undefined, JSON.stringify(archived));
    assert.equal((await s.list()).total, 0);
    assert.equal((await s.list({ status: "archived" })).total, 1);
    assert.deepEqual((await s.disk()).tags, []);
    e = archived._meta.editor;
    const restored = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { status: "active" },
    });
    assert.equal(restored.isError, undefined, JSON.stringify(restored));
    assert.equal((await s.list()).total, 1);
  } finally {
    await s.close();
  }
});
test("two old note revisions cannot both write and the losing draft cannot overwrite", async () => {
  const s = await session();
  try {
    const e = await s.read();
    const results = await Promise.all(
      ["First", "Second"].map((title) =>
        s.call("storybloq_note_save", {
          id: e.id,
          revision: e.revision,
          patch: { title },
        }),
      ),
    );
    assert.equal(results.filter((r) => !r.isError).length, 1);
    assert.equal(
      results.filter(
        (r) => r.isError && r._meta?.editError?.code === "conflict",
      ).length,
      1,
    );
    const winner = results.find((r) => !r.isError);
    assert.equal((await s.disk()).title, winner._meta.editor.fields.title);
  } finally {
    await s.close();
  }
});
test("long note preview pages preserve surrogate pairs and title-only save preserves the full body", async () => {
  const s = await session();
  try {
    const content = "a".repeat(15999) + "😀" + "Body ".repeat(10000);
    await s.put("notes/N-001.json", note("N-001", { content }));
    const e = await s.read();
    assert.ok(e.limitedFields.includes("content"));
    let assembled = "",
      offset = 0,
      pages = 0,
      revision: string | undefined;
    do {
      assert.ok(
        ++pages <= Math.ceil(content.length / 15999),
        "note page count must stay bounded",
      );
      const r = await s.call("storybloq_note_detail", {
        id: e.id,
        offset,
        ...(revision ? { revision } : {}),
      });
      assert.equal(r.isError, undefined, JSON.stringify(r));
      const page = r._meta.note;
      assert.ok(page.content.length <= 16000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.content));
      assert.equal(page.offset, offset);
      assembled += page.content;
      revision ??= page.revision;
      assert.equal(page.revision, revision);
      if (page.nextOffset !== null) {
        assert.ok(page.content.length > 0);
        assert.equal(page.nextOffset, offset + page.content.length);
        assert.ok(
          page.nextOffset > offset && page.nextOffset <= content.length,
        );
      }
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(assembled, content);
    const saved = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { title: "Small edit" },
    });
    assert.equal(saved.isError, undefined, JSON.stringify(saved));
    assert.equal((await s.disk()).content, content);
  } finally {
    await s.close();
  }
});
test("changed note detail pages refuse assembly with the old revision", async () => {
  const s = await session();
  try {
    await s.put(
      "notes/N-001.json",
      note("N-001", { content: "Body ".repeat(10000) }),
    );
    const first = await s.call("storybloq_note_detail", {
      id: "N-001",
      offset: 0,
    });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    await s.put(
      "notes/N-001.json",
      note("N-001", { content: "Different ".repeat(6000) }),
    );
    const next = await s.call("storybloq_note_detail", {
      id: "N-001",
      offset: first._meta.note.nextOffset,
      revision: first._meta.note.revision,
    });
    assert.equal(next.isError, true);
    assert.equal(next._meta.editError.code, "conflict");
  } finally {
    await s.close();
  }
});
test("note patch rejects protected fields and malformed content without changing bytes", async () => {
  const s = await session();
  try {
    const e = await s.read(),
      path = join(s.root, ".story/notes/N-001.json"),
      before = await readFile(path);
    for (const patch of [
      { id: "N-002" },
      { updatedDate: "2000-01-01" },
      { lifecycle: "deleted" },
      { content: " " },
      { content: "x".repeat(48001) },
      { title: "x".repeat(2001) },
      { tags: Array(201).fill("tag") },
      { tags: ["x".repeat(65)] },
      { previousDisplayIds: ["N-099"] },
      { status: "deleted" },
    ]) {
      const r = await s.call("storybloq_note_save", {
        id: e.id,
        revision: e.revision,
        patch,
      });
      assert.equal(r.isError, true, JSON.stringify(patch));
      assert.deepEqual(await readFile(path), before);
    }
  } finally {
    await s.close();
  }
});
test("oversized note titles and tags remain preserved when another field is edited", async () => {
  const s = await session();
  try {
    const title = "x".repeat(2500),
      tags = Array.from({ length: 201 }, (_, i) => "tag" + i);
    await s.put("notes/N-001.json", note("N-001", { title, tags }));
    const e = await s.read();
    assert.ok(e.limitedFields.includes("title"));
    assert.ok(e.limitedFields.includes("tags"));
    const r = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { content: "A smaller editable update" },
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const saved = await s.disk();
    assert.equal(saved.title, title);
    assert.deepEqual(saved.tags, tags);
    assert.equal(saved.content, "A smaller editable update");
  } finally {
    await s.close();
  }
});
test("invalid UTF8 note bytes refuse reads and old-revision saves without normalization", async () => {
  const s = await session();
  try {
    await s.put("notes/N-001.json", note("N-001", { extension: "BAD_UTF8" }));
    const e = await s.read(),
      path = join(s.root, ".story/notes/N-001.json"),
      bytes = await readFile(path);
    bytes[bytes.indexOf(Buffer.from("BAD_UTF8"))] = 0xff;
    await writeFile(path, bytes);
    const read = await s.call("storybloq_note_editor", { id: e.id });
    assert.equal(read.isError, true);
    const save = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { title: "Do not normalize untouched bytes" },
    });
    assert.equal(save.isError, true);
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await s.close();
  }
});
test("missing notes are empty and malformed, swapped and oversized notes fail with preserved bytes", async () => {
  for (const mode of [
    "missing",
    "malformed",
    "symlink",
    "oversize",
    "identity",
  ]) {
    const s = await session();
    try {
      const path = join(s.root, ".story/notes/N-001.json");
      if (mode === "missing")
        await rm(join(s.root, ".story/notes"), { recursive: true });
      if (mode === "malformed")
        await writeFile(path, '{"private":"PRIVATE_SECRET"');
      if (mode === "symlink") {
        await rm(path);
        await symlink("/etc/passwd", path);
      }
      if (mode === "oversize")
        await s.put(
          "notes/N-001.json",
          note("N-001", { content: "x".repeat(1048576) }),
        );
      if (mode === "identity") await s.put("notes/N-001.json", note("N-002"));
      const before = mode === "missing" ? null : await readFile(path);
      const r = await s.call("storybloq_notes");
      if (mode === "missing") {
        assert.equal(r.isError, undefined, JSON.stringify(r));
        assert.equal(r._meta.notes.total, 0);
      } else {
        assert.equal(r.isError, true);
        assert.deepEqual(await readFile(path), before);
        assert.ok(!JSON.stringify(r).includes("PRIVATE_SECRET"));
        assert.ok(!JSON.stringify(r).includes(s.root));
      }
    } finally {
      await s.close();
    }
  }
});
test("canonical note formatting cannot exceed the readable file byte limit", async () => {
  const s = await session();
  try {
    const empty = note("N-001", { padding: "" });
    await s.put("notes/N-001.json", {
      ...empty,
      padding: "x".repeat(1048576 - Buffer.byteLength(JSON.stringify(empty))),
    });
    const e = await s.read(),
      path = join(s.root, ".story/notes/N-001.json"),
      before = await readFile(path);
    assert.equal(before.length, 1048576);
    const r = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { title: "Changed title" },
    });
    assert.equal(r.isError, true);
    assert.equal(r._meta.editError.code, "invalid_input");
    assert.deepEqual(await readFile(path), before);
  } finally {
    await s.close();
  }
});
test("note updates account for every note in the aggregate ledger byte limit", async () => {
  const s = await session();
  try {
    let used = 0;
    for (const name of [
      "config.json",
      "roadmap.json",
      "tickets/T-001.json",
      "issues/ISS-001.json",
      "notes/N-001.json",
    ])
      used += (await readFile(join(s.root, ".story", name))).length;
    let remaining = 32 * 1024 * 1024 - 100 - used;
    for (let i = 0; i < 32; i++) {
      const id = "N-" + (100 + i),
        empty = note(id, { padding: "" }),
        base = Buffer.byteLength(JSON.stringify(empty)),
        size = i === 31 ? remaining : 1048576;
      assert.ok(size >= base && size <= 1048576);
      await s.put("notes/" + id + ".json", {
        ...empty,
        padding: "x".repeat(size - base),
      });
      remaining -= size;
    }
    assert.equal(remaining, 0);
    const e = await s.read(),
      path = join(s.root, ".story/notes/N-001.json"),
      before = await readFile(path),
      config = await readFile(join(s.root, ".story/config.json"));
    const r = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { title: "x".repeat(2000) },
    });
    assert.equal(r.isError, true);
    assert.equal(r._meta.editError.code, "invalid_input");
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(
      await readFile(join(s.root, ".story/config.json")),
      config,
    );
  } finally {
    await s.close();
  }
});
test("unresolved note conflicts and future ledgers refuse old-revision saves", async () => {
  for (const mode of ["conflict", "future"]) {
    const s = await session();
    try {
      const e = await s.read();
      if (mode === "conflict")
        await s.put(
          "notes/N-001.json",
          note("N-001", {
            _conflicts: [
              {
                fieldPath: "content",
                kind: "field",
                base: "Base content",
                ours: "Our content",
                theirs: "Their content",
              },
            ],
          }),
        );
      else {
        const config = JSON.parse(
          await readFile(join(s.root, ".story/config.json"), "utf8"),
        );
        await s.put("config.json", { ...config, schemaVersion: 999 });
      }
      const path = join(s.root, ".story/notes/N-001.json"),
        before = await readFile(path);
      const r = await s.call("storybloq_note_save", {
        id: e.id,
        revision: e.revision,
        patch: { title: "Must remain unwritable" },
      });
      assert.equal(r.isError, true);
      assert.deepEqual(await readFile(path), before);
    } finally {
      await s.close();
    }
  }
});

test("notes tools are app-only and transport only bounded private metadata", async () => {
  const s = await session();
  try {
    const inventory = await s.tools();
    for (const name of [
      "storybloq_notes",
      "storybloq_note_detail",
      "storybloq_note_editor",
      "storybloq_note_save",
    ]) {
      const tool = inventory.tools.find((t) => t.name === name);
      assert.ok(tool, name);
      assert.deepEqual((tool._meta as any).ui.visibility, ["app"]);
      assert.equal(
        tool.annotations?.readOnlyHint,
        name !== "storybloq_note_save",
      );
    }
    await s.put(
      "notes/N-001.json",
      note("N-001", {
        content: "PRIVATE_FULL_BODY",
        unknownCredential: "PRIVATE_EXTENSION",
      }),
    );
    const e = await s.read();
    for (const name of [
      "storybloq_notes",
      "storybloq_note_detail",
      "storybloq_note_editor",
    ]) {
      const result = await s.call(
        name,
        name === "storybloq_notes" ? {} : { id: e.id },
      );
      assert.deepEqual(result.content, []);
      assert.equal(result.structuredContent, undefined);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_EXTENSION"));
    }
    const limit = await s.call("storybloq_notes", { limit: 25 });
    assert.equal(limit.isError, true);
  } finally {
    await s.close();
  }
});

test("later note pages require a revision and selectors cannot escape the configured project", async () => {
  const s = await session();
  try {
    await s.put(
      "notes/N-001.json",
      note("N-001", { content: "x".repeat(20000) }),
    );
    const first = await s.call("storybloq_note_detail", {
      id: "N-001",
      offset: 0,
    });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.equal(first._meta.note.nextOffset, 16000);
    const path = join(s.root, ".story/notes/N-001.json"),
      before = await readFile(path);
    for (const args of [
      { id: "N-001", offset: 16000 },
      { id: "N-001", offset: 1, revision: "a".repeat(64) },
      { id: "../config", offset: 0 },
      { id: "x".repeat(81), offset: 0 },
      { id: "N-001", offset: -1 },
    ])
      assert.equal(
        (await s.call("storybloq_note_detail", args)).isError,
        true,
        JSON.stringify(args),
      );
    assert.deepEqual(await readFile(path), before);
  } finally {
    await s.close();
  }
});

test("a replaced project root refuses note writes without touching replacement data", async () => {
  const s = await session(),
    old = s.root + "-original";
  let moved = false;
  try {
    const e = await s.read();
    await rename(s.root, old);
    moved = true;
    // The replacement is a complete, valid, byte-identical project. Only its
    // root inode changes, so revision/JSON/missing-file guards cannot mask it.
    await cp(old, s.root, { recursive: true });
    const replacement = join(s.root, ".story/notes/N-001.json");
    const before = await readFile(replacement);
    const r = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { title: "Must refuse" },
    });
    assert.equal(r.isError, true);
    assert.equal(r._meta.editError.code, "unavailable");
    assert.deepEqual(await readFile(replacement), before);
    assert.equal(
      JSON.parse(await readFile(join(old, ".story/notes/N-001.json"), "utf8"))
        .title,
      "Authored note",
    );
  } finally {
    if (moved) {
      await rm(s.root, { recursive: true, force: true });
      await rename(old, s.root);
    }
    await s.close();
  }
});

test("duplicate visible note identities refuse projection until locally reconciled", async () => {
  const s = await session();
  try {
    assert.equal((await s.list()).total, 1);
    const id = "n-0123456789abcdef";
    await s.put("notes/" + id + ".json", note(id, { displayId: "N-001" }));
    const path = join(s.root, ".story/notes/N-001.json"),
      before = await readFile(path);
    const r = await s.call("storybloq_notes");
    assert.equal(r.isError, true);
    assert.deepEqual(await readFile(path), before);
  } finally {
    await s.close();
  }
});

test("oversized visible note labels stay within the browser metadata boundary", async () => {
  const s = await session();
  try {
    await s.put(
      "notes/N-001.json",
      note("N-001", { displayId: "N-" + "x".repeat(100) }),
    );
    const list = await s.list();
    const editor = await s.read();
    const preview = await s.call("storybloq_note_detail", {
      id: "N-001",
      offset: 0,
    });
    assert.equal(preview.isError, undefined, JSON.stringify(preview));
    for (const value of [list.items[0], editor, preview._meta.note]) {
      assert.equal(value.id, "N-001");
      assert.ok(
        value.displayId.length <= 80,
        "bounded display label must remain renderable",
      );
    }
  } finally {
    await s.close();
  }
});

test("revision-bound later preview pages do not reread the whole ledger", async () => {
  const s = await session();
  const originalOpen = fs.promises.open;
  let opens = 0;
  try {
    await s.put(
      "notes/N-001.json",
      note("N-001", { content: "Long body ".repeat(6000) }),
    );
    for (let i = 10; i < 20; i++)
      await s.put("notes/N-" + i + ".json", note("N-" + i));
    fs.promises.open = async (...args) => {
      opens++;
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    const first = await s.call("storybloq_note_detail", {
      id: "N-001",
      offset: 0,
    });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.ok(
      opens >= 15,
      "the counter must observe the initial full guarded ledger read",
    );
    opens = 0;
    const next = await s.call("storybloq_note_detail", {
      id: "N-001",
      offset: first._meta.note.nextOffset,
      revision: first._meta.note.revision,
    });
    assert.equal(next.isError, undefined, JSON.stringify(next));
    assert.ok(
      opens <= 1,
      "unchanged later pages must reuse a revalidated bounded revision snapshot, opened=" +
        opens,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    await s.close();
  }
});

test("a warmed note preview refuses unsafe ledger changes on later pages", async () => {
  for (const mode of ["content", "future", "conflict", "symlink", "journal"]) {
    const s = await session();
    try {
      await s.put(
        "notes/N-001.json",
        note("N-001", { content: "x".repeat(20000) }),
      );
      const first = await s.call("storybloq_note_detail", {
        id: "N-001",
        offset: 0,
      });
      assert.equal(first.isError, undefined, JSON.stringify(first));
      assert.equal(first._meta.note.nextOffset, 16000);
      if (mode === "content")
        await s.put(
          "notes/N-001.json",
          note("N-001", { content: "y".repeat(20000) }),
        );
      else if (mode === "future") {
        const config = JSON.parse(
          await readFile(join(s.root, ".story/config.json"), "utf8"),
        );
        await s.put("config.json", { ...config, schemaVersion: 999 });
      } else if (mode === "conflict")
        await s.put(
          "notes/N-002.json",
          note("N-002", {
            _conflicts: [
              {
                fieldPath: "title",
                kind: "field",
                base: "Base",
                ours: "Our",
                theirs: "Their",
              },
            ],
          }),
        );
      else if (mode === "symlink") {
        await s.put("notes/N-002.json", note("N-002"));
        await rm(join(s.root, ".story/notes/N-001.json"));
        await symlink(
          join(s.root, ".story/notes/N-002.json"),
          join(s.root, ".story/notes/N-001.json"),
        );
      } else await s.put(".txn.json", { pending: true });
      const selectedPath = join(s.root, ".story/notes/N-001.json");
      const before = await readFile(selectedPath);
      const next = await s.call("storybloq_note_detail", {
        id: "N-001",
        offset: first._meta.note.nextOffset,
        revision: first._meta.note.revision,
      });
      assert.equal(next.isError, true, mode);
      assert.equal(
        next._meta?.note,
        undefined,
        mode + " must not return a stale page",
      );
      assert.deepEqual(
        await readFile(selectedPath),
        before,
        mode + " must remain read-only",
      );
    } finally {
      await s.close();
    }
  }
});

test(
  "interleaved preview selections keep their captured revision and preserve a newer cache",
  { timeout: 5000 },
  async () => {
    for (const failOlder of [false, true]) {
      const s = await session();
      const originalLstat = fs.promises.lstat,
        originalOpen = fs.promises.open;
      let release!: () => void, entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      let intercepted = false,
        rejectOlderRead = false,
        opens = 0;
      const canonicalRoot = await realpath(s.root);
      try {
        await s.put(
          "notes/N-001.json",
          note("N-001", { content: "A".repeat(40000) }),
        );
        await s.put(
          "notes/N-002.json",
          note("N-002", { content: "B".repeat(40000) }),
        );
        const a = await s.call("storybloq_note_detail", {
          id: "N-001",
          offset: 0,
        });
        assert.equal(a.isError, undefined, JSON.stringify(a));
        fs.promises.lstat = (async (
          ...args: Parameters<typeof originalLstat>
        ) => {
          if (
            !intercepted &&
            String(args[0]) === join(canonicalRoot, ".story/config.json")
          ) {
            intercepted = true;
            entered();
            await resume;
            if (failOlder)
              throw new Error("Simulated older snapshot probe failure");
          }
          return originalLstat(...args);
        }) as typeof originalLstat;
        fs.promises.open = async (...args) => {
          opens++;
          if (
            rejectOlderRead &&
            String(args[0]) === join(canonicalRoot, ".story/notes/N-001.json")
          )
            throw new Error("Simulated older snapshot recovery failure");
          return originalOpen(...args);
        };
        syncBuiltinESMExports();
        const older = s.call("storybloq_note_detail", {
          id: "N-001",
          offset: 16000,
          revision: a._meta.note.revision,
        });
        await paused;
        const b = await s.call("storybloq_note_detail", {
          id: "N-002",
          offset: 0,
        });
        assert.equal(b.isError, undefined, JSON.stringify(b));
        rejectOlderRead = failOlder;
        release();
        const oldResult = await older;
        if (failOlder) assert.equal(oldResult.isError, true);
        else {
          assert.equal(oldResult.isError, undefined, JSON.stringify(oldResult));
          assert.equal(oldResult._meta.note.id, "N-001");
          assert.equal(oldResult._meta.note.revision, a._meta.note.revision);
          assert.equal(oldResult._meta.note.content, "A".repeat(16000));
        }
        opens = 0;
        const newer = await s.call("storybloq_note_detail", {
          id: "N-002",
          offset: 16000,
          revision: b._meta.note.revision,
        });
        assert.equal(newer.isError, undefined, JSON.stringify(newer));
        assert.equal(newer._meta.note.id, "N-002");
        assert.equal(newer._meta.note.revision, b._meta.note.revision);
        assert.equal(newer._meta.note.content, "B".repeat(16000));
        assert.equal(
          opens,
          0,
          "an older request must not evict the newer valid cache",
        );
      } finally {
        release?.();
        fs.promises.lstat = originalLstat;
        fs.promises.open = originalOpen;
        syncBuiltinESMExports();
        await s.close();
      }
    }
  },
);
// The save's own refusal code, or the tool schema's rule codes when the
// protocol layer refused the arguments before the save ran.
function refusal(r: any): string {
  if (r._meta?.editError) return r._meta.editError.code;
  const text = String(r.content?.[0]?.text ?? "");
  assert.match(text, /Input validation error: Invalid arguments for tool storybloq_note_save/);
  const codes = [...text.matchAll(/"code": "([a-z_]+)"/g)].map((m) => m[1]);
  return "schema:" + [...new Set(codes)].join(",");
}
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
test("board note save keeps main's destructive-replace guard at its real thresholds", async () => {
  const s = await session();
  try {
    await s.put("notes/N-002.json", note("N-002", { content: "x".repeat(999) }));
    await s.put("notes/N-003.json", note("N-003", { content: "x".repeat(1000) }));
    await s.put("notes/N-004.json", note("N-004", { content: "x".repeat(1000) }));
    const under = await s.read("N-002");
    const small = await s.call("storybloq_note_save", {
      id: under.id,
      revision: under.revision,
      patch: { content: "y" },
    });
    assert.equal(small.isError, undefined, JSON.stringify(small));
    assert.equal((await s.disk("N-002")).content, "y");
    const exact = await s.read("N-003");
    const fifth = await s.call("storybloq_note_save", {
      id: exact.id,
      revision: exact.revision,
      patch: { content: "y".repeat(200) },
    });
    assert.equal(fifth.isError, undefined, JSON.stringify(fifth));
    assert.equal((await s.disk("N-003")).content, "y".repeat(200));
    const guarded = await s.read("N-004"),
      path = join(s.root, ".story/notes/N-004.json"),
      before = await readFile(path),
      draft = "y".repeat(199);
    const refused = await s.call("storybloq_note_save", {
      id: guarded.id,
      revision: guarded.revision,
      patch: { content: draft, title: "Not yet" },
    });
    assert.equal(refused.isError, true);
    assert.equal(refused._meta.editError.code, "confirm_replace_required");
    assert.equal(refused._meta.editError.revision, guarded.revision);
    assert.equal(refused._meta.editError.draftDigest, digest(draft));
    assert.ok(!refused._meta.editError.message.includes("yyyyy"));
    assert.deepEqual(await readFile(path), before);
    const confirmed = await s.call("storybloq_note_save", {
      id: guarded.id,
      revision: guarded.revision,
      patch: {
        content: draft,
        title: "Now",
        confirmReplace: true,
        confirmDraftDigest: digest(draft),
      },
    });
    assert.equal(confirmed.isError, undefined, JSON.stringify(confirmed));
    const saved = await s.disk("N-004");
    assert.equal(saved.content, draft);
    assert.equal(saved.title, "Now");
    assert.ok(!("confirmReplace" in saved));
    assert.ok(!("confirmDraftDigest" in saved));
  } finally {
    await s.close();
  }
});
test("board replace consent binds the exact draft and the reviewed revision", async () => {
  const s = await session();
  try {
    await s.put("notes/N-001.json", note("N-001", { content: "x".repeat(5000) }));
    const e = await s.read(),
      path = join(s.root, ".story/notes/N-001.json"),
      before = await readFile(path),
      draft = "short replacement";
    for (const [patch, code] of [
      [{ content: draft, confirmReplace: true }, "invalid_input"],
      [
        { content: draft, confirmReplace: true, confirmDraftDigest: "0".repeat(64) },
        "invalid_input",
      ],
      [
        {
          content: draft + " edited",
          confirmReplace: true,
          confirmDraftDigest: digest(draft),
        },
        "invalid_input",
      ],
      [{ content: draft, confirmDraftDigest: digest(draft) }, "invalid_input"],
      // Consent alone is not an edit: the schema's refine rule refuses it.
      [{ confirmReplace: true, confirmDraftDigest: digest(draft) }, "schema:custom"],
      [{ title: "Only title", confirmReplace: true, confirmDraftDigest: digest(draft) }, "invalid_input"],
      // The strict schema refuses a mode key before the save runs.
      [{ content: draft, mode: "append" }, "schema:unrecognized_keys"],
      [{ content: draft, mode: "replace" }, "schema:unrecognized_keys"],
    ] as const) {
      const r = await s.call("storybloq_note_save", {
        id: e.id,
        revision: e.revision,
        patch,
      });
      assert.equal(r.isError, true, JSON.stringify(patch));
      assert.equal(refusal(r), code, JSON.stringify([patch, r]));
      assert.deepEqual(await readFile(path), before, JSON.stringify(patch));
    }
    const moved = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: { title: "Moved on" },
    });
    assert.equal(moved.isError, undefined, JSON.stringify(moved));
    const afterMove = await readFile(path);
    const stale = await s.call("storybloq_note_save", {
      id: e.id,
      revision: e.revision,
      patch: {
        content: draft,
        confirmReplace: true,
        confirmDraftDigest: digest(draft),
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(stale._meta.editError.code, "conflict");
    assert.deepEqual(await readFile(path), afterMove);
  } finally {
    await s.close();
  }
});
test("unrelated note validation failures never ask for replace confirmation", async () => {
  const s = await session();
  try {
    await s.put("notes/N-001.json", note("N-001", { content: "x".repeat(5000) }));
    const e = await s.read(),
      path = join(s.root, ".story/notes/N-001.json"),
      before = await readFile(path);
    // Blank content reaches the canonical CLI validation; the rest are
    // refused by the tool schema before the save runs.
    for (const [patch, code] of [
      [{ content: " " }, "invalid_input"],
      [{ content: "\n\t" }, "invalid_input"],
      [{ tags: ["x".repeat(65)] }, "schema:too_big"],
      [{ status: "deleted" }, "schema:invalid_enum_value"],
      [{ content: "x".repeat(48001) }, "schema:too_big"],
    ] as const) {
      const r = await s.call("storybloq_note_save", {
        id: e.id,
        revision: e.revision,
        patch,
      });
      assert.equal(r.isError, true, JSON.stringify(patch));
      assert.equal(refusal(r), code, JSON.stringify([patch, r]));
      assert.equal(r._meta?.editError?.draftDigest, undefined);
      assert.deepEqual(await readFile(path), before);
    }
  } finally {
    await s.close();
  }
});
