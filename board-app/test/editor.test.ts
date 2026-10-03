import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  rm,
  readdir,
  symlink,
  rename,
  mkdir,
  writeFile,
  cp,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { fixture, ticket, issue } from "./fixture.js";
import { TicketSchema } from "../../src/models/ticket.js";
import {
  checkpointDigest,
  parseOwnerCheckpoint,
  checkpointReleases,
} from "../../src/core/owner-checkpoint.js";

async function session() {
  const f = await fixture();
  const server = createServer(f.root, "<h1>Board</h1>");
  const client = new Client({ name: "editor-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as any;
  const editor = async (kind = "tickets", id = "T-001") => {
    const r = await call("storybloq_item_editor", { kind, id });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.deepEqual(r.content, []);
    assert.match(r._meta.editor.revision, /^[a-f0-9]{64}$/);
    return r._meta.editor;
  };
  const disk = async (path = "tickets/T-001.json") =>
    JSON.parse(await readFile(join(f.root, ".story", path), "utf8"));
  return {
    ...f,
    call,
    editor,
    disk,
    close: async () => {
      await client.close();
      await server.close();
      await f.cleanup();
    },
  };
}

test("malformed UTF-8 cannot be silently normalized into an editable record", async () => {
  const s = await session();
  try {
    const path = join(s.root, ".story/tickets/T-001.json");
    await s.put(
      "tickets/T-001.json",
      ticket("T-001", { extension: "BROKEN_UTF8" }),
    );
    const e = await s.editor();
    const source = JSON.stringify(
      ticket("T-001", { extension: "BROKEN_UTF8" }),
    );
    const marker = Buffer.from("BROKEN_UTF8"),
      bytes = Buffer.from(source);
    bytes[bytes.indexOf(marker)] = 0xff;
    await writeFile(path, bytes);
    const result = await s.call("storybloq_item_editor", {
      kind: "tickets",
      id: "T-001",
    });
    assert.equal(result.isError, true);
    assert.deepEqual(await readFile(path), bytes);
    const save = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "Must not normalize" },
    });
    assert.equal(save.isError, true);
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await s.close();
  }
});

test("UTF8 validation retains the existing refusal of a BOM-prefixed ledger document", async () => {
  const s = await session();
  try {
    const path = join(s.root, ".story/tickets/T-001.json"),
      bytes = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify(ticket())),
      ]);
    await writeFile(path, bytes);
    const r = await s.call("storybloq_item_editor", {
      kind: "tickets",
      id: "T-001",
    });
    assert.equal(r.isError, true);
    assert.deepEqual(await readFile(path), bytes);
  } finally {
    await s.close();
  }
});

test("editor returns complete editable values and opaque revisions without protected metadata", async () => {
  const s = await session();
  try {
    const body = "long authored text ".repeat(1200);
    await s.put(
      "tickets/T-001.json",
      ticket("T-001", {
        description: body,
        secretExtension: "PRIVATE_EXTENSION",
      }),
    );
    const e = await s.editor();
    assert.equal(e.fields.description, body);
    assert.equal(e.fields.title, "Ship the board");
    assert.ok(!JSON.stringify(e).includes("PRIVATE_EXTENSION"));
    const other = await s.editor("issues", "ISS-001");
    assert.equal(other.fields.impact, "Refresh should recover");
    assert.notEqual(other.revision, e.revision);
  } finally {
    await s.close();
  }
});

test("ticket Save uses canonical dates, phase keys and the existing legacy filename", async () => {
  const s = await session();
  try {
    await s.put(
      "tickets/T-001.json",
      ticket("T-001", { secretExtension: { keep: true } }),
    );
    const e = await s.editor();
    const r = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: {
        title: "Revised",
        description: "Full authored body",
        type: "feature",
        phase: e.phases[0].key,
        status: "complete",
      },
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const saved = await s.disk();
    assert.equal(saved.title, "Revised");
    assert.equal(saved.description, "Full authored body");
    assert.equal(saved.type, "feature");
    assert.equal(saved.phase, "p1");
    assert.equal(saved.status, "complete");
    assert.match(saved.completedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(saved.secretExtension, { keep: true });
    assert.notEqual(r._meta.editor.revision, e.revision);
    assert.equal(r._meta.editor.fields.title, saved.title);
  } finally {
    await s.close();
  }
});

test("issue Save preserves unknown fields and derives resolution dates", async () => {
  const s = await session();
  try {
    await s.put("issues/ISS-001.json", issue("ISS-001", { extension: 42 }));
    const e = await s.editor("issues", "ISS-001");
    const r = await s.call("storybloq_item_save", {
      kind: "issues",
      id: e.id,
      revision: e.revision,
      patch: {
        title: "Resolved failure",
        impact: "Authored impact",
        severity: "critical",
        resolution: "Fixed and verified",
        status: "resolved",
        phase: null,
      },
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const saved = await s.disk("issues/ISS-001.json");
    assert.equal(saved.impact, "Authored impact");
    assert.equal(saved.resolution, "Fixed and verified");
    assert.equal(saved.status, "resolved");
    assert.equal(saved.severity, "critical");
    assert.match(saved.resolvedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(saved.extension, 42);
  } finally {
    await s.close();
  }
});

test("two simultaneous saves from one revision cannot both overwrite the record", async () => {
  const s = await session();
  try {
    const e = await s.editor();
    const results = await Promise.all(
      ["First", "Second"].map((title) =>
        s.call("storybloq_item_save", {
          kind: "tickets",
          id: e.id,
          revision: e.revision,
          patch: { title },
        }),
      ),
    );
    assert.equal(results.filter((r) => !r.isError).length, 1);
    const conflict = results.find((r) => r.isError);
    assert.equal(conflict._meta.editError.code, "conflict");
    assert.equal(
      (await s.disk()).title,
      results.find((r) => !r.isError)._meta.editor.fields.title,
    );
  } finally {
    await s.close();
  }
});

test("oversized authored fields remain intact when saving a smaller editable field", async () => {
  const s = await session();
  try {
    const body = "x".repeat(60000);
    await s.put("tickets/T-001.json", ticket("T-001", { description: body }));
    const e = await s.editor();
    assert.ok(e.limitedFields.includes("description"));
    assert.ok(e.fields.description.length <= 48000);
    const r = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "Small change" },
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.equal((await s.disk()).description, body);
  } finally {
    await s.close();
  }
});

test("completed ordinary tickets require explicit Reopen rather than forcing an ordinary Save", async () => {
  const s = await session();
  try {
    await s.put(
      "tickets/T-001.json",
      ticket("T-001", { status: "complete", completedDate: "2026-09-30" }),
    );
    const e = await s.editor();
    const before = await readFile(
      join(s.root, ".story/tickets/T-001.json"),
      "utf8",
    );
    const ordinary = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { status: "open" },
    });
    assert.equal(ordinary.isError, true);
    assert.equal(
      await readFile(join(s.root, ".story/tickets/T-001.json"), "utf8"),
      before,
    );
    const reopen = await s.call("storybloq_ticket_reopen", {
      id: e.id,
      revision: e.revision,
    });
    assert.equal(reopen.isError, undefined, JSON.stringify(reopen));
    assert.equal((await s.disk()).status, "open");
    assert.equal((await s.disk()).completedDate, null);
  } finally {
    await s.close();
  }
});

test("hashed records keep their canonical filenames while preserving display IDs and unknown fields", async () => {
  const s = await session(),
    id = "t-0000000000000001";
  try {
    await rm(join(s.root, ".story/tickets/T-001.json"));
    await s.put(
      "tickets/" + id + ".json",
      ticket(id, { displayId: "T-100", privateExtension: 7 }),
    );
    const e = await s.editor("tickets", id);
    const r = await s.call("storybloq_item_save", {
      kind: "tickets",
      id,
      revision: e.revision,
      patch: { title: "Edited hash" },
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.deepEqual(await readdir(join(s.root, ".story/tickets")), [
      id + ".json",
    ]);
    const saved = await s.disk("tickets/" + id + ".json");
    assert.equal(saved.displayId, "T-100");
    assert.equal(saved.privateExtension, 7);
    assert.equal(
      (await s.editor("tickets", id)).revision,
      r._meta.editor.revision,
    );
  } finally {
    await s.close();
  }
});

test("protected patches and invalid dependencies fail without changing bytes", async () => {
  const s = await session();
  try {
    const e = await s.editor(),
      path = join(s.root, ".story/tickets/T-001.json"),
      before = await readFile(path, "utf8");
    for (const patch of [
      { claimedBySession: "foreign" },
      { ownerCheckpoint: null },
      { id: "T-002" },
      { force: true, status: "open" },
      { blockedBy: ["T-999"] },
    ]) {
      const r = await s.call("storybloq_item_save", {
        kind: "tickets",
        id: e.id,
        revision: e.revision,
        patch,
      });
      assert.equal(r.isError, true);
      assert.equal(await readFile(path, "utf8"), before);
    }
  } finally {
    await s.close();
  }
});

test("residual claims and checkpoints cannot use the owner Reopen authority", async () => {
  const s = await session();
  try {
    for (const protectedFields of [
      { claimedBySession: "foreign" },
      { claimedBySession: "" },
      { ownerCheckpoint: null },
    ]) {
      await s.put(
        "tickets/T-001.json",
        ticket("T-001", {
          status: "complete",
          completedDate: "2026-09-30",
          ...protectedFields,
        }),
      );
      const e = await s.editor(),
        path = join(s.root, ".story/tickets/T-001.json"),
        before = await readFile(path, "utf8");
      assert.equal(e.canReopen, false);
      const r = await s.call("storybloq_ticket_reopen", {
        id: e.id,
        revision: e.revision,
      });
      assert.equal(r.isError, true);
      assert.equal(await readFile(path, "utf8"), before);
    }
  } finally {
    await s.close();
  }
});

test("canonical formatting growth cannot make a previously readable file exceed its byte limit", async () => {
  const s = await session();
  try {
    const empty = ticket("T-001", { padding: "" });
    await s.put("tickets/T-001.json", {
      ...empty,
      padding: "x".repeat(1048576 - Buffer.byteLength(JSON.stringify(empty))),
    });
    const e = await s.editor(),
      path = join(s.root, ".story/tickets/T-001.json"),
      before = await readFile(path, "utf8");
    assert.equal(Buffer.byteLength(before), 1048576);
    const r = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "Changed" },
    });
    assert.equal(r.isError, true);
    assert.equal(r._meta.editError.code, "invalid_input");
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await s.close();
  }
});

test("aggregate prepared-byte growth is refused before persistence even when the target is small", async () => {
  const s = await session();
  try {
    let used = 0;
    for (const name of [
      "config.json",
      "roadmap.json",
      "tickets/T-001.json",
      "issues/ISS-001.json",
    ])
      used += (await readFile(join(s.root, ".story", name))).length;
    let remaining = 32 * 1024 * 1024 - 100 - used;
    for (let i = 0; i < 32; i++) {
      const id = "T-" + (100 + i),
        empty = ticket(id, { padding: "" }),
        base = Buffer.byteLength(JSON.stringify(empty));
      const size = i === 31 ? remaining : 1048576;
      assert.ok(size >= base && size <= 1048576);
      await s.put("tickets/" + id + ".json", {
        ...empty,
        padding: "x".repeat(size - base),
      });
      remaining -= size;
    }
    assert.equal(remaining, 0);
    const e = await s.editor(),
      path = join(s.root, ".story/tickets/T-001.json"),
      before = await readFile(path, "utf8");
    const r = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "x".repeat(2000) },
    });
    assert.equal(r.isError, true);
    assert.equal(r._meta.editError.code, "invalid_input");
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await s.close();
  }
});

test("filename mismatches, deleted records and unsupported schema versions never become writable editors", async () => {
  const s = await session();
  try {
    await s.put("tickets/T-001.json", ticket("T-002"));
    let r = await s.call("storybloq_item_editor", {
      kind: "tickets",
      id: "T-002",
    });
    assert.equal(r.isError, true);
    await s.put(
      "tickets/T-001.json",
      ticket("T-001", { lifecycle: "deleted" }),
    );
    r = await s.call("storybloq_item_editor", { kind: "tickets", id: "T-001" });
    assert.equal(r.isError, true);
    await s.put("tickets/T-001.json", ticket());
    const config = JSON.parse(
      await readFile(join(s.root, ".story/config.json"), "utf8"),
    );
    await s.put("config.json", { ...config, schemaVersion: 999 });
    r = await s.call("storybloq_item_editor", { kind: "tickets", id: "T-001" });
    assert.equal(r.isError, true);
  } finally {
    await s.close();
  }
});

test("a swapped target symlink is refused while leaving the external file untouched", async () => {
  const s = await session(),
    external = await fixture();
  try {
    const e = await s.editor(),
      target = join(s.root, ".story/tickets/T-001.json"),
      outside = join(external.root, ".story/tickets/T-001.json"),
      before = await readFile(outside, "utf8");
    await rm(target);
    await symlink(outside, target);
    const r = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "Forbidden" },
    });
    assert.equal(r.isError, true);
    assert.equal(await readFile(outside, "utf8"), before);
  } finally {
    await s.close();
    await external.cleanup();
  }
});

test("replacing the startup root at the same path requires reconnecting before editing", async () => {
  const s = await session();
  const moved = s.root + "-moved";
  try {
    const e = await s.editor();
    await rename(s.root, moved);
    await mkdir(s.root);
    await cp(join(moved, ".story"), join(s.root, ".story"), {
      recursive: true,
    });
    const source = join(moved, ".story/tickets/T-001.json"),
      replacement = join(s.root, ".story/tickets/T-001.json"),
      before = await readFile(source);
    const r = await s.call("storybloq_item_editor", {
      kind: "tickets",
      id: "T-001",
    });
    assert.equal(r.isError, true);
    assert.match(r._meta.editError.message, /connection changed/i);
    const save = await s.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "Wrong project" },
    });
    assert.equal(save.isError, true);
    assert.match(save._meta.editError.message, /connection changed/i);
    assert.deepEqual(await readFile(source), before);
    assert.deepEqual(await readFile(replacement), before);
  } finally {
    await s.close();
    await rm(moved, { recursive: true, force: true });
  }
});

test("ordinary Save cannot complete a foreign-claimed ticket or an unresolved checkpoint dependent", async () => {
  for (const mode of ["claim", "checkpoint"]) {
    const s = await session();
    try {
      if (mode === "claim")
        await s.put(
          "tickets/T-001.json",
          ticket("T-001", {
            status: "inprogress",
            claimedBySession: "2b53d2fd-8f92-4cb4-b459-1df54474adc7",
            claim: {
              user: "other@example.test",
              branch: "main",
              since: "2026-09-30T12:00:00Z",
            },
          }),
        );
      else {
        const content = {
          kind: "decision",
          question: "Ship?",
          evidenceRefs: [],
        };
        const checkpoint = ticket("T-002", {
          ownerCheckpoint: {
            ...content,
            owner: "owner",
            lifecycle: "active",
            revision: 1,
            digest: checkpointDigest(content),
            generation: 1,
            history: [],
          },
        });
        const parsed = parseOwnerCheckpoint(checkpoint);
        assert.equal(parsed.kind, "ok");
        assert.equal(checkpointReleases(TicketSchema.parse(checkpoint)), false);
        await s.put("tickets/T-002.json", checkpoint);
        await s.put(
          "tickets/T-001.json",
          ticket("T-001", { blockedBy: ["T-002"] }),
        );
      }
      const files = [
        "tickets/T-001.json",
        "issues/ISS-001.json",
        ...(mode === "checkpoint" ? ["tickets/T-002.json"] : []),
      ];
      const before = await Promise.all(
        files.map((path) => readFile(join(s.root, ".story", path))),
      );
      const e = await s.editor();
      const r = await s.call("storybloq_item_save", {
        kind: "tickets",
        id: e.id,
        revision: e.revision,
        patch: { status: "complete" },
      });
      assert.equal(r.isError, true, mode + ": " + JSON.stringify(r));
      for (const [i, path] of files.entries())
        assert.deepEqual(
          await readFile(join(s.root, ".story", path)),
          before[i],
        );
    } finally {
      await s.close();
    }
  }
});
