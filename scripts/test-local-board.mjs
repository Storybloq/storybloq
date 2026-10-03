import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// May point at an isolated unpacked npm artifact, never at a project ledger.
const packageRoot = process.env.STORYBLOQ_TEST_PACKAGE_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

test("installed local plugin paths exist and setup uses its task-bound canonical profile", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "storybloq");
  const mcp = JSON.parse(await readFile(join(packageRoot, manifest.mcpServers), "utf8"));
  assert.deepEqual(mcp.mcpServers.storybloq_board, { command: "storybloq", args: ["--board-mcp"] });
  await access(join(packageRoot, manifest.skills, "storybloq/SKILL.md"));
  await access(join(packageRoot, manifest.interface.composerIcon));
  await access(join(packageRoot, manifest.interface.logo));
  const dir = await mkdtemp(join(tmpdir(), "storybloq-package-local-cli-"));
  const a = join(dir, "a"), b = join(dir, "b");
  await mkdir(a); await mkdir(b);
  const run = (cwd, args) => exec(process.execPath, [join(packageRoot, "dist/cli.js"), "--local-cli", ...args], {
    cwd, timeout: 15000,
    env: { PATH: process.env.PATH ?? "", STORYBLOQ_PROJECT_ROOT: a, CLAUDESTORY_PROJECT_ROOT: a },
  });
  try {
    await run(a, ["init", "--name", "A", "--format", "json"]);
    const first = await readFile(join(a, ".story/config.json"));
    const results = await Promise.allSettled(["B-one", "B-two"].map((name) => run(b, ["init", "--name", name])));
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(results.filter((x) => x.status === "rejected").length, 1);
    const config = JSON.parse(await readFile(join(b, ".story/config.json"), "utf8"));
    const roadmap = JSON.parse(await readFile(join(b, ".story/roadmap.json"), "utf8"));
    assert.ok(["B-one", "B-two"].includes(config.project));
    assert.equal(roadmap.title, config.project);
    assert.deepEqual(await readFile(join(a, ".story/config.json")), first);
    const recap = await run(b, ["recap", "--format", "json"]);
    assert.equal(recap.stderr, "");
    assert.ok(JSON.parse(recap.stdout).data);
    await assert.rejects(run(b, ["init", "--force"]));
    await assert.rejects(run(b, ["reference", "--board-mcp"]));
    await assert.rejects(run(b, ["status"]));
    assert.match((await run(b, ["reference"])).stdout, /storybloq/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
    assert.equal(result.structuredContent.localCli.version, 1);
    assert.equal(result.structuredContent.localCli.command, await realpath(process.execPath));
    assert.deepEqual(result.structuredContent.localCli.args, [await realpath(join(packageRoot, "dist/cli.js")), "--local-cli"]);
    assert.equal(result.structuredContent.localCli.sha256, createHash("sha256").update(await readFile(join(packageRoot, "dist/cli.js"))).digest("hex"));
    const standalone = new Client({ name: "unmarked-runtime-probe", version: "1" });
    try {
      await standalone.connect(new StdioClientTransport({
        command: process.execPath, args: [join(packageRoot, "dist/board/server.js"), "--local"], cwd,
        env: { PATH: process.env.PATH ?? "" }, stderr: "pipe",
      }));
      const legacy = await standalone.callTool({ name: "storybloq_board", arguments: {} });
      assert.equal(legacy.structuredContent.localCli, undefined);
    } finally { await standalone.close(); }
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
    const opened = await clients[1].callTool({ name: "storybloq_board", arguments: {} });
    assert.equal(opened.structuredContent.localCli.version, 1);
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
