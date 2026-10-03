import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// May point at an isolated unpacked npm artifact, never at a project ledger.
const packageRoot = process.env.STORYBLOQ_TEST_PACKAGE_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));

test("installed CLI exposes a local board without source files or startup keys", async () => {
  await access(join(packageRoot, "dist/board/server.js"));
  await access(join(packageRoot, "dist/board/board.html"));
  const cwd = await mkdtemp(join(tmpdir(), "storybloq-package-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(packageRoot, "dist/cli.js"), "--board-mcp"],
    cwd,
    env: { PATH: process.env.PATH ?? "", STORYBLOQ_PROJECT_ROOT: "/missing-demo" },
    stderr: "pipe",
  });
  const client = new Client({ name: "clean-package-probe", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["storybloq_board"]);
    const result = await client.callTool({ name: "storybloq_board", arguments: {} });
    assert.equal(result.structuredContent.setupRequired, true);
    const resource = await client.readResource({ uri: "ui://storybloq/board-v1.html" });
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0].text, /Storybloq/);
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("installed board saves through canonical handlers into its own project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "storybloq-package-edit-"));
  const roots = [join(directory, "a"), join(directory, "b")];
  const clients = [];
  const file = (root) => join(root, ".story/tickets/T-001.json");
  try {
    for (const root of roots) {
      await mkdir(join(root, ".story/tickets"), { recursive: true });
      await mkdir(join(root, ".story/issues"));
      await writeFile(join(root, ".story/config.json"), JSON.stringify({
        version: 1, schemaVersion: 4, project: root.endsWith("a") ? "A" : "B",
        type: "app", language: "ts",
        features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
      }));
      await writeFile(join(root, ".story/roadmap.json"), JSON.stringify({
        title: "Roadmap", date: "2026-10-02", phases: [], blockers: [],
      }));
      await writeFile(file(root), JSON.stringify({
        id: "T-001", title: "Original", description: "Preserve this body",
        type: "task", status: "open", phase: null, order: 10,
        createdDate: "2026-10-02", completedDate: null, blockedBy: [],
      }));
      const client = new Client({ name: "package-edit-probe", version: "1" });
      clients.push(client);
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(packageRoot, "dist/cli.js"), "--board-mcp"], cwd: root,
        env: { PATH: process.env.PATH ?? "", STORYBLOQ_PROJECT_ROOT: roots[0] },
        stderr: "pipe",
      }));
      assert.equal((await client.listTools()).tools.length, 17);
    }
    const original = await readFile(file(roots[0]));
    const editor = await clients[1].callTool({
      name: "storybloq_item_editor", arguments: { kind: "tickets", id: "T-001" },
    });
    assert.equal(editor.isError, undefined);
    const saved = await clients[1].callTool({
      name: "storybloq_item_save", arguments: {
        kind: "tickets", id: "T-001", revision: editor._meta.editor.revision,
        patch: { title: "Saved from installed board" },
      },
    });
    assert.equal(saved.isError, undefined);
    const actual = JSON.parse(await readFile(file(roots[1]), "utf8"));
    assert.equal(actual.title, "Saved from installed board");
    assert.equal(actual.description, "Preserve this body");
    assert.deepEqual(await readFile(file(roots[0])), original);
    const core = new Client({ name: "installed-core-probe", version: "1" });
    clients.push(core);
    await core.connect(new StdioClientTransport({
      command: process.execPath, args: [join(packageRoot, "dist/cli.js"), "--mcp"],
      cwd: roots[1], env: { PATH: process.env.PATH ?? "" }, stderr: "pipe",
    }));
    assert.ok((await core.listTools()).tools.some((tool) => tool.name === "storybloq_status"));
    const status = await core.callTool({ name: "storybloq_status", arguments: {} });
    assert.notEqual(status.isError, true);
    assert.ok(status.content.some((part) => part.type === "text" && part.text.startsWith("# B\n")));
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
