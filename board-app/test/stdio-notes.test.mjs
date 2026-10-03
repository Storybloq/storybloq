import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("built stdio server persists canonical note saves with exact readback and preservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "storybloq-stdio-notes-"));
  const client = new Client({ name: "notes-stdio-probe", version: "1" });
  const put = (file, value) =>
    writeFile(join(root, ".story", file), JSON.stringify(value));
  const bytes = (file) => readFile(join(root, ".story", file));
  const disk = async (file) =>
    JSON.parse(await readFile(join(root, ".story", file), "utf8"));
  const id = "n-0123456789abcdef",
    file = "notes/" + id + ".json";
  const body =
    "a".repeat(15999) +
    "😀" +
    "Full authored context.\n".repeat(3000) +
    "searchable private tail";
  const note = (id, extra = {}) => ({
    id,
    title: "Original note",
    content: "Original full content",
    tags: ["design"],
    status: "active",
    createdDate: "2026-09-29",
    updatedDate: "2026-09-29",
    updatedAt: "2026-09-29T12:00:00Z",
    ...extra,
  });
  try {
    for (const dir of ["tickets", "issues", "notes"])
      await mkdir(join(root, ".story", dir), { recursive: true });
    await put("config.json", {
      version: 1,
      schemaVersion: 4,
      project: "Disposable notes probe",
      type: "app",
      language: "ts",
      features: {
        tickets: true,
        issues: true,
        notes: true,
        handovers: true,
        roadmap: true,
        reviews: true,
      },
    });
    await put("roadmap.json", {
      title: "Roadmap",
      date: "2026-09-29",
      phases: [],
      blockers: [],
    });
    await put("tickets/T-001.json", {
      id: "T-001",
      title: "Unrelated ticket",
      description: "Unchanged authored description",
      type: "task",
      status: "open",
      phase: null,
      order: 1,
      createdDate: "2026-09-29",
      completedDate: null,
      blockedBy: [],
    });
    await put("issues/ISS-001.json", {
      id: "ISS-001",
      title: "Unrelated issue",
      status: "open",
      severity: "low",
      components: [],
      impact: "Unchanged",
      resolution: null,
      location: [],
      discoveredDate: "2026-09-29",
      resolvedDate: null,
      relatedTickets: [],
    });
    await put("notes/N-001.json", note("N-001"));
    await put(
      file,
      note(id, {
        displayId: "N-002",
        content: body,
        privateExtension: { preserve: "exactly" },
      }),
    );
    const unrelated = new Map();
    for (const path of [
      "config.json",
      "roadmap.json",
      "tickets/T-001.json",
      "issues/ISS-001.json",
      "notes/N-001.json",
    ])
      unrelated.set(path, await bytes(path));
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
        env: { STORYBLOQ_PROJECT_ROOT: root },
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 17);
    for (const name of [
      "storybloq_notes",
      "storybloq_note_detail",
      "storybloq_note_editor",
      "storybloq_note_save",
    ])
      assert.deepEqual(
        tools.find((tool) => tool.name === name)._meta.ui.visibility,
        ["app"],
      );
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.deepEqual(result.content, []);
      assert.equal(result.structuredContent, undefined);
      return result;
    };
    const edit = async (id) => {
      const result = await call("storybloq_note_editor", { id });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return result._meta.editor;
    };
    const page = await call("storybloq_notes", {
      query: "SEARCHABLE PRIVATE TAIL",
    });
    assert.equal(page.isError, undefined, JSON.stringify(page));
    assert.deepEqual(
      page._meta.notes.items.map((item) => item.id),
      [id],
    );
    assert.ok(!JSON.stringify(page).includes("privateExtension"));
    const original = await edit(id);
    assert.ok(original.limitedFields.includes("content"));
    const saved = await call("storybloq_note_save", {
      id,
      revision: original.revision,
      patch: {
        title: "Persisted through actual stdio",
        tags: [" Design ", "design", "Docs"],
        status: "archived",
      },
    });
    assert.equal(saved.isError, undefined, JSON.stringify(saved));
    const stored = await disk(file);
    assert.equal(stored.title, "Persisted through actual stdio");
    assert.equal(stored.content, body);
    assert.deepEqual(stored.tags, ["design", "docs"]);
    assert.equal(stored.status, "archived");
    assert.deepEqual(stored.privateExtension, { preserve: "exactly" });
    assert.equal(stored.createdDate, "2026-09-29");
    assert.equal(saved._meta.editor.revision, (await edit(id)).revision);
    for (const [path, before] of unrelated)
      assert.deepEqual(await bytes(path), before, path);
    const archive = await call("storybloq_notes", { status: "archived" });
    assert.deepEqual(
      archive._meta.notes.items.map((note) => note.id),
      [id],
    );
    const restored = await call("storybloq_note_save", {
      id,
      revision: saved._meta.editor.revision,
      patch: { status: "active" },
    });
    assert.equal(restored.isError, undefined, JSON.stringify(restored));
    assert.equal((await disk(file)).status, "active");
    const beforeConflict = await bytes(file);
    const rejected = await call("storybloq_note_save", {
      id,
      revision: original.revision,
      patch: { title: "Stale overwrite" },
    });
    assert.equal(rejected.isError, true);
    assert.equal(rejected._meta.editError.code, "conflict");
    assert.deepEqual(await bytes(file), beforeConflict);
    let content = "",
      offset = 0,
      pages = 0,
      revision;
    do {
      assert.ok(
        ++pages <= Math.ceil(body.length / 15999),
        "note page count must stay bounded",
      );
      const result = await call("storybloq_note_detail", {
        id,
        offset,
        ...(revision ? { revision } : {}),
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const page = result._meta.note;
      assert.equal(page.offset, offset);
      revision ??= page.revision;
      assert.equal(page.revision, revision);
      assert.ok(page.content.length <= 16000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.content));
      if (page.nextOffset !== null) {
        assert.ok(page.content.length > 0);
        assert.equal(page.nextOffset, offset + page.content.length);
        assert.ok(page.nextOffset > offset && page.nextOffset <= body.length);
      }
      content += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(content, body);
    const small = await edit("N-001");
    const cleared = await call("storybloq_note_save", {
      id: "N-001",
      revision: small.revision,
      patch: {
        title: null,
        tags: [],
        content: "**Decision**\n\nUpdated full authored body.",
      },
    });
    assert.equal(cleared.isError, undefined, JSON.stringify(cleared));
    const smallDisk = await disk("notes/N-001.json");
    assert.equal(smallDisk.title, null);
    assert.deepEqual(smallDisk.tags, []);
    assert.equal(
      smallDisk.content,
      "**Decision**\n\nUpdated full authored body.",
    );
    assert.deepEqual(await bytes(file), beforeConflict);
    for (const [path, before] of unrelated)
      if (path !== "notes/N-001.json")
        assert.deepEqual(await bytes(path), before, path);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
