import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  realpath,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture } from "./fixture.js";
import { captureLocalContext } from "../src/local-context.js";
import { createLocalServer } from "../src/local-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function connect(root: string) {
  const server = await createLocalServer(root, "<p>Local board</p>");
  const client = new Client({ name: "local-context-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(left);
  await client.connect(right);
  return client;
}
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

test("local discovery pins canonical worktree root and ignores demo overrides", async () => {
  const a = await fixture();
  const b = await fixture();
  const oldRoot = process.env.STORYBLOQ_PROJECT_ROOT;
  const oldLegacy = process.env.CLAUDESTORY_PROJECT_ROOT;
  try {
    git(a.root, "init", "--quiet");
    const nested = join(a.root, "src");
    await mkdir(nested);
    process.env.STORYBLOQ_PROJECT_ROOT = b.root;
    process.env.CLAUDESTORY_PROJECT_ROOT = b.root;
    const context = captureLocalContext(nested);
    assert.equal(context.resolve(), await realpath(a.root));
    assert.equal(context.boundary, await realpath(a.root));
    process.env.STORYBLOQ_PROJECT_ROOT = "/missing";
    assert.equal(context.resolve(), await realpath(a.root));
  } finally {
    if (oldRoot === undefined) delete process.env.STORYBLOQ_PROJECT_ROOT;
    else process.env.STORYBLOQ_PROJECT_ROOT = oldRoot;
    if (oldLegacy === undefined) delete process.env.CLAUDESTORY_PROJECT_ROOT;
    else process.env.CLAUDESTORY_PROJECT_ROOT = oldLegacy;
    await a.cleanup();
    await b.cleanup();
  }
});

test("missing nested repository never attaches to the parent ledger and detects setup", async () => {
  const parent = await fixture();
  try {
    const child = join(parent.root, "child");
    await mkdir(child);
    git(child, "init", "--quiet");
    const context = captureLocalContext(child);
    assert.equal(context.resolve(), null);
    await mkdir(join(child, ".story"));
    await writeFile(join(child, ".story/config.json"), "{}");
    assert.equal(context.resolve(), await realpath(child));
  } finally {
    await parent.cleanup();
  }
});

test("incomplete nested ledger is a terminal error, not setup or parent fallback", async () => {
  const parent = await fixture();
  try {
    git(parent.root, "init", "--quiet");
    const child = join(parent.root, "src");
    await mkdir(join(child, ".story"), { recursive: true });
    assert.throws(() => captureLocalContext(child).resolve(), /incomplete/i);
  } finally {
    await parent.cleanup();
  }
});

test("dangling ledger symlink cannot route the nested task to a parent project", async () => {
  const parent = await fixture();
  try {
    git(parent.root, "init", "--quiet");
    const child = join(parent.root, "broken-ledger");
    await mkdir(child);
    await symlink(join(child, "missing"), join(child, ".story"));
    assert.throws(() => captureLocalContext(child).resolve(), /incomplete/i);
  } finally {
    await parent.cleanup();
  }
});

test("nonrepository launch does not select a ledger above its task directory", async () => {
  const parent = await fixture();
  try {
    const child = join(parent.root, "plain");
    await mkdir(child);
    assert.equal(captureLocalContext(child).resolve(), null);
  } finally {
    await parent.cleanup();
  }
});

test("an invalid ancestor Git marker cannot authorize parent ledger discovery", async () => {
  const parent = await fixture();
  try {
    await writeFile(join(parent.root, ".git"), "gitdir: /missing-repository\n");
    const child = join(parent.root, "plain");
    await mkdir(child);
    assert.equal(captureLocalContext(child).resolve(), null);
  } finally {
    await parent.cleanup();
  }
});

test("actual Git worktree discovers its own ledger and ignores inherited Git routing", async () => {
  const parent = await fixture();
  const oldGitDir = process.env.GIT_DIR;
  try {
    git(parent.root, "init", "--quiet");
    git(
      parent.root,
      "-c",
      "user.name=Synthetic probe",
      "-c",
      "user.email=probe@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "Synthetic fixture",
    );
    const worktree = join(parent.root, "worktree");
    git(parent.root, "worktree", "add", "--detach", worktree);
    const nested = join(worktree, "src");
    await mkdir(nested);
    process.env.GIT_DIR = join(parent.root, ".git");
    const context = captureLocalContext(nested);
    assert.equal(context.boundary, await realpath(worktree));
    assert.equal(context.resolve(), null);
    await mkdir(join(worktree, ".story"));
    await writeFile(join(worktree, ".story/config.json"), "{}");
    assert.equal(context.resolve(), await realpath(worktree));
  } finally {
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
    await parent.cleanup();
  }
});

test("missing ledger offers guidance, rejects partial setup and activates after completion", async () => {
  const parent = await fixture();
  let client: Client | undefined;
  try {
    const child = join(parent.root, "new-project");
    await mkdir(child);
    git(child, "init", "--quiet");
    client = await connect(child);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      ["storybloq_board"],
    );
    const missing = await client.callTool({
      name: "storybloq_board",
      arguments: {},
    });
    assert.equal((missing.structuredContent as any).setupRequired, true);
    await mkdir(join(child, ".story"));
    assert.equal(
      (await client.callTool({ name: "storybloq_board", arguments: {} }))
        .isError,
      true,
    );
    await writeFile(join(child, ".story/config.json"), "{}");
    assert.equal(
      (await client.callTool({ name: "storybloq_board", arguments: {} }))
        .isError,
      true,
    );
    for (const d of ["tickets", "issues"])
      await mkdir(join(child, ".story", d));
    for (const f of ["config.json", "roadmap.json"])
      await writeFile(
        join(child, ".story", f),
        await readFile(join(parent.root, ".story", f)),
      );
    const ready = await Promise.all(
      [1, 2].map(() =>
        client!.callTool({
          name: "storybloq_board",
          arguments: {},
        }),
      ),
    );
    for (const result of ready)
      assert.equal((result.structuredContent as any).ready, true);
    assert.equal((await client.listTools()).tools.length, 17);
    const overviewTool = (await client.listTools()).tools.find(
      (t) => t.name === "storybloq_board_overview",
    )!;
    assert.deepEqual((overviewTool._meta?.ui as any).visibility, [
      "model",
      "app",
    ]);
    const overview = await client.callTool({
      name: "storybloq_board_overview",
      arguments: {},
    });
    assert.deepEqual(overview.structuredContent, overview._meta);
    const board = await client.callTool({
      name: "storybloq_board",
      arguments: {},
    });
    assert.equal((board.structuredContent as any).project, "Demo project");
    assert.equal((board.structuredContent as any).tickets, 0);
  } finally {
    await client?.close();
    await parent.cleanup();
  }
});

test("simultaneous local servers retain their own project and survive reconnect", async () => {
  const a = await fixture(),
    b = await fixture();
  const clients: Client[] = [];
  try {
    const config = JSON.parse(
      await readFile(join(b.root, ".story/config.json"), "utf8"),
    );
    await b.put("config.json", { ...config, project: "Second project" });
    clients.push(...(await Promise.all([connect(a.root), connect(b.root)])));
    const values = await Promise.all(
      clients.map((c) =>
        c.callTool({ name: "storybloq_board", arguments: {} }),
      ),
    );
    assert.deepEqual(
      values.map((v) => (v.structuredContent as any).project),
      ["Demo project", "Second project"],
    );
    await clients[0].close();
    clients[0] = await connect(a.root);
    assert.equal(
      (
        (await clients[0].callTool({ name: "storybloq_board", arguments: {} }))
          .structuredContent as any
      ).project,
      "Demo project",
    );
    // A pinned connection must fail if its ledger disappears, not choose another root.
    await rm(join(a.root, ".story"), { recursive: true });
    assert.equal(
      (await clients[0].callTool({ name: "storybloq_board", arguments: {} }))
        .isError,
      true,
    );
    assert.equal(
      (
        (await clients[1].callTool({ name: "storybloq_board", arguments: {} }))
          .structuredContent as any
      ).project,
      "Second project",
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await a.cleanup();
    await b.cleanup();
  }
});

test("local tools expose conversational results and preserve revision conflicts", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".story/notes"));
  await f.put("notes/N-001.json", {
    id: "N-001",
    title: "Local note",
    content: "Original",
    tags: [],
    status: "active",
    createdDate: "2026-10-04",
    updatedDate: "2026-10-04",
    privateExtension: "NEVER_SHARE_EXTENSION",
  });
  const client = await connect(f.root);
  const call = async (name: string, args = {}) =>
    (await client.callTool({ name, arguments: args })) as any;
  try {
    for (const tool of (await client.listTools()).tools.filter(
      (t) => t.name !== "storybloq_board",
    )) {
      assert.deepEqual(
        (tool._meta?.ui as any)?.visibility,
        ["model", "app"],
        tool.name,
      );
      assert.ok(tool.outputSchema, tool.name);
    }
    const item = await call("storybloq_board_detail", {
      kind: "tickets",
      id: "T-001",
    });
    assert.equal(item.structuredContent.item.title, "Ship the board");
    assert.deepEqual(JSON.parse(item.content[0].text), item.structuredContent);
    const read = await call("storybloq_note_editor", { id: "N-001" });
    const editor = read.structuredContent.editor;
    assert.match(editor.revision, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(read).includes("NEVER_SHARE_EXTENSION"));
    const saved = await call("storybloq_note_save", {
      id: "N-001",
      revision: editor.revision,
      patch: { content: "Saved through model tool" },
    });
    assert.equal(saved.isError, undefined);
    assert.notEqual(saved.structuredContent.editor.revision, editor.revision);
    const path = join(f.root, ".story/notes/N-001.json");
    const disk = await readFile(path, "utf8");
    assert.equal(JSON.parse(disk).content, "Saved through model tool");
    assert.equal(JSON.parse(disk).privateExtension, "NEVER_SHARE_EXTENSION");
    const stale = await call("storybloq_note_save", {
      id: "N-001",
      revision: editor.revision,
      patch: { content: "Stale overwrite" },
    });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.editError.code, "conflict");
    assert.deepEqual(
      JSON.parse(stale.content[0].text),
      stale.structuredContent,
    );
    assert.equal(await readFile(path, "utf8"), disk);
  } finally {
    await client.close();
    await f.cleanup();
  }
});

test("opening a local browser declares its listener side effect", async () => {
  const f = await fixture();
  const server = await createLocalServer(
    f.root,
    "<p>Board</p>",
    undefined,
    async () => "http://127.0.0.1:1/#test",
  );
  const client = new Client({ name: "annotation-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "storybloq_board",
    )!;
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
  } finally {
    await client.close();
    await server.close();
    await f.cleanup();
  }
});
