import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  rm,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// May point at an isolated unpacked npm artifact, never at a project ledger.
const packageRoot =
  process.env.STORYBLOQ_TEST_PACKAGE_ROOT ??
  fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

test("installed local plugin paths exist and setup uses its task-bound canonical profile", async () => {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "storybloq");
  const mcp = JSON.parse(
    await readFile(join(packageRoot, manifest.mcpServers), "utf8"),
  );
  assert.deepEqual(mcp.mcpServers.storybloq_board, {
    command: "storybloq",
    args: ["--board-mcp"],
  });
  await access(join(packageRoot, manifest.skills, "storybloq/SKILL.md"));
  await access(join(packageRoot, manifest.interface.composerIcon));
  await access(join(packageRoot, manifest.interface.logo));
  const dir = await mkdtemp(join(tmpdir(), "storybloq-package-local-cli-"));
  const a = join(dir, "a"),
    b = join(dir, "b");
  await mkdir(a);
  await mkdir(b);
  const run = (cwd, args) =>
    exec(
      process.execPath,
      [join(packageRoot, "dist/cli.js"), "--local-cli", ...args],
      {
        cwd,
        timeout: 15000,
        env: {
          PATH: process.env.PATH ?? "",
          STORYBLOQ_PROJECT_ROOT: a,
          CLAUDESTORY_PROJECT_ROOT: a,
        },
      },
    );
  try {
    await run(a, ["init", "--name", "A", "--format", "json"]);
    const first = await readFile(join(a, ".story/config.json"));
    const results = await Promise.allSettled(
      ["B-one", "B-two"].map((name) => run(b, ["init", "--name", name])),
    );
    assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(results.filter((x) => x.status === "rejected").length, 1);
    const config = JSON.parse(
      await readFile(join(b, ".story/config.json"), "utf8"),
    );
    const roadmap = JSON.parse(
      await readFile(join(b, ".story/roadmap.json"), "utf8"),
    );
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
    env: {
      PATH: process.env.PATH ?? "",
      STORYBLOQ_PROJECT_ROOT: "/missing-demo",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "clean-package-probe", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["storybloq_board"],
    );
    const result = await client.callTool({
      name: "storybloq_board",
      arguments: {},
    });
    assert.equal(result.structuredContent.setupRequired, true);
    assert.equal(result.structuredContent.localCli.version, 1);
    assert.equal(
      result.structuredContent.localCli.command,
      await realpath(process.execPath),
    );
    assert.deepEqual(result.structuredContent.localCli.args, [
      await realpath(join(packageRoot, "dist/cli.js")),
      "--local-cli",
    ]);
    assert.equal(
      result.structuredContent.localCli.sha256,
      createHash("sha256")
        .update(await readFile(join(packageRoot, "dist/cli.js")))
        .digest("hex"),
    );
    const standalone = new Client({
      name: "unmarked-runtime-probe",
      version: "1",
    });
    try {
      await standalone.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(packageRoot, "dist/board/server.js"), "--local"],
          cwd,
          env: { PATH: process.env.PATH ?? "" },
          stderr: "pipe",
        }),
      );
      const legacy = await standalone.callTool({
        name: "storybloq_board",
        arguments: {},
      });
      assert.equal(legacy.structuredContent.localCli, undefined);
    } finally {
      await standalone.close();
    }
    const resource = await client.readResource({
      uri: "ui://storybloq/board-v1.html",
    });
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
      await writeFile(
        join(root, ".story/config.json"),
        JSON.stringify({
          version: 1,
          schemaVersion: 4,
          project: root.endsWith("a") ? "A" : "B",
          type: "app",
          language: "ts",
          features: {
            tickets: true,
            issues: true,
            handovers: true,
            roadmap: true,
            reviews: true,
          },
        }),
      );
      await writeFile(
        join(root, ".story/roadmap.json"),
        JSON.stringify({
          title: "Roadmap",
          date: "2026-10-02",
          phases: [],
          blockers: [],
        }),
      );
      await writeFile(
        file(root),
        JSON.stringify({
          id: "T-001",
          title: "Original",
          description: "Preserve this body",
          type: "task",
          status: "open",
          phase: null,
          order: 10,
          createdDate: "2026-10-02",
          completedDate: null,
          blockedBy: [],
        }),
      );
      const client = new Client({ name: "package-edit-probe", version: "1" });
      clients.push(client);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(packageRoot, "dist/cli.js"), "--board-mcp"],
          cwd: root,
          env: {
            PATH: process.env.PATH ?? "",
            STORYBLOQ_PROJECT_ROOT: roots[0],
          },
          stderr: "pipe",
        }),
      );
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 17);
      assert.equal(tools.find(t => t.name === "storybloq_board").annotations.readOnlyHint, false);
      for (const tool of tools.filter(t => t.name !== "storybloq_board")) {
        assert.deepEqual(tool._meta.ui.visibility, ["model", "app"]);
        assert.ok(tool.outputSchema);
      }
    }
    const original = await readFile(file(roots[0]));
    const opened = await clients[1].callTool({
      name: "storybloq_board",
      arguments: {},
    });
    assert.equal(opened.structuredContent.localCli.version, 1);
    const editor = await clients[1].callTool({
      name: "storybloq_item_editor",
      arguments: { kind: "tickets", id: "T-001" },
    });
    assert.equal(editor.isError, undefined);
    const saved = await clients[1].callTool({
      name: "storybloq_item_save",
      arguments: {
        kind: "tickets",
        id: "T-001",
        revision: editor.structuredContent.editor.revision,
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
    await core.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(packageRoot, "dist/cli.js"), "--mcp"],
        cwd: roots[1],
        env: { PATH: process.env.PATH ?? "" },
        stderr: "pipe",
      }),
    );
    assert.ok(
      (await core.listTools()).tools.some(
        (tool) => tool.name === "storybloq_status",
      ),
    );
    const status = await core.callTool({
      name: "storybloq_status",
      arguments: {},
    });
    assert.notEqual(status.isError, true);
    assert.ok(
      status.content.some(
        (part) => part.type === "text" && part.text.startsWith("# B\n"),
      ),
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed board isolates Git worktrees, rejects stale edits and survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storybloq-worktree-matrix-"));
  const main = join(dir, "main"),
    tree = join(dir, "worktree");
  const clients = [];
  const env = {
    PATH: process.env.PATH ?? "",
    STORYBLOQ_PROJECT_ROOT: main,
    CLAUDESTORY_PROJECT_ROOT: main,
  };
  const cli = join(packageRoot, "dist/cli.js");
  const git = (args, cwd = main) =>
    execFileSync("git", args, {
      cwd,
      env: { PATH: process.env.PATH ?? "" },
      stdio: "pipe",
    });
  const file = (root) => join(root, ".story/tickets/T-001.json");
  async function connect(root) {
    const client = new Client({
      name: "worktree-isolation-proof",
      version: "1",
    });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "--board-mcp"],
      cwd: join(root, "nested"),
      env,
      stderr: "pipe",
    });
    transport.stderr.on("data", (chunk) => process.stderr.write(chunk));
    await client.connect(transport);
    return client;
  }
  async function call(client, name, args = {}) {
    return client.callTool({ name, arguments: args });
  }
  try {
    await mkdir(main);
    git(["init"]);
    git(["config", "user.name", "Storybloq probe"]);
    git(["config", "user.email", "probe@example.invalid"]);
    execFileSync(
      process.execPath,
      [cli, "--local-cli", "init", "--name", "Main"],
      { cwd: main, env, stdio: "pipe" },
    );
    const ticket = {
      id: "T-001",
      title: "Seed",
      description: "Preserve this body",
      type: "task",
      status: "open",
      phase: null,
      order: 1,
      createdDate: "2026-10-02",
      completedDate: null,
      blockedBy: [],
    };
    await writeFile(file(main), JSON.stringify(ticket));
    git(["add", ".story"]);
    git(["commit", "-m", "Disposable fixture"]);
    git(["worktree", "add", "-b", "probe-worktree", tree]);
    for (const root of [main, tree]) await mkdir(join(root, "nested"));
    const config = JSON.parse(
      await readFile(join(tree, ".story/config.json"), "utf8"),
    );
    config.project = "Worktree";
    await writeFile(join(tree, ".story/config.json"), JSON.stringify(config));
    const [a, b] = await Promise.all([connect(main), connect(tree)]);
    assert.equal(
      (await call(a, "storybloq_board")).structuredContent.project,
      "Main",
    );
    assert.equal(
      (await call(b, "storybloq_board")).structuredContent.project,
      "Worktree",
    );
    const before = await readFile(file(main));
    const editor = await call(b, "storybloq_item_editor", {
      kind: "tickets",
      id: "T-001",
    });
    const save = await call(b, "storybloq_item_save", {
      kind: "tickets",
      id: "T-001",
      revision: editor.structuredContent.editor.revision,
      patch: { title: "Worktree saved" },
    });
    assert.notEqual(save.isError, true);
    assert.equal(
      JSON.parse(await readFile(file(tree), "utf8")).title,
      "Worktree saved",
    );
    assert.deepEqual(await readFile(file(main)), before);
    const stale = await call(b, "storybloq_item_editor", {
      kind: "tickets",
      id: "T-001",
    });
    const external = JSON.parse(await readFile(file(tree), "utf8"));
    external.title = "Concurrent canonical file edit";
    await writeFile(file(tree), JSON.stringify(external));
    const concurrent = await readFile(file(tree));
    const rejected = await call(b, "storybloq_item_save", {
      kind: "tickets",
      id: "T-001",
      revision: stale.structuredContent.editor.revision,
      patch: { title: "Stale draft" },
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(await readFile(file(tree)), concurrent);
    assert.deepEqual(await readFile(file(main)), before);
    assert.equal(rejected.structuredContent.editError.code, "conflict");
    const fresh = await call(b, "storybloq_item_editor", {
      kind: "tickets",
      id: "T-001",
    });
    const retry = await call(b, "storybloq_item_save", {
      kind: "tickets",
      id: "T-001",
      revision: fresh._meta.editor.revision,
      patch: { title: "Reviewed retry" },
    });
    assert.notEqual(retry.isError, true);
    await b.close();
    const restarted = await connect(tree);
    assert.equal(
      (await call(restarted, "storybloq_board")).structuredContent.project,
      "Worktree",
    );
    const restartedEditor = await call(restarted, "storybloq_item_editor", {
      kind: "tickets",
      id: "T-001",
    });
    assert.equal(restartedEditor._meta.editor.fields.title, "Reviewed retry");
    assert.deepEqual(await readFile(file(main)), before);
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await rm(dir, { recursive: true, force: true });
  }
});

test("installed browser closes with its task and reuses one endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storybloq-browser-lifetime-"));
  const client = new Client({ name: "viewer-lifetime", version: "1" });
  try {
    await exec(
      process.execPath,
      [
        join(packageRoot, "dist/cli.js"),
        "--local-cli",
        "init",
        "--name",
        "Viewer",
      ],
      { cwd: dir, env: { PATH: "/usr/bin:/bin" } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(packageRoot, "dist/cli.js"), "--board-mcp"],
        cwd: dir,
        env: { PATH: "/usr/bin:/bin" },
        stderr: "pipe",
      }),
    );
    const one = await client.callTool({
        name: "storybloq_board",
        arguments: {},
      }),
      two = await client.callTool({ name: "storybloq_board", arguments: {} });
    assert.equal(
      one.structuredContent.localBrowser.url,
      two.structuredContent.localBrowser.url,
    );
    const u = new URL(one.structuredContent.localBrowser.url);
    assert.equal(u.hostname, "127.0.0.1");
    assert.match(u.hash, /^#[a-f0-9]{64}$/);
    const page = await fetch(u.origin);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy"),
      /form-action 'none'/,
    );
    assert.match(await page.text(), /sandbox="allow-scripts allow-forms"/);
    assert.equal(
      (await fetch(u.origin + "/api", { method: "POST", body: "{}" })).status,
      403,
    );
    await client.close();
    await assert.rejects(fetch(u.origin));
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing optional viewer asset preserves bootstrap and native board resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storybloq-browser-optional-"));
  const client = new Client({ name: "optional-viewer", version: "1" });
  try {
    const { cp, symlink } = await import("node:fs/promises"),
      { dirname } = await import("node:path");
    const runtime = join(dir, "runtime");
    await mkdir(runtime);
    for (const name of ["server.js", "board.html"])
      await cp(join(packageRoot, "dist/board", name), join(runtime, name));
    await writeFile(
      join(runtime, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    let parent = packageRoot;
    while (true) {
      try {
        await access(join(parent, "node_modules/@modelcontextprotocol/sdk"));
        break;
      } catch {
        const next = dirname(parent);
        if (next === parent) throw Error("Dependency root missing");
        parent = next;
      }
    }
    await symlink(
      join(parent, "node_modules"),
      join(runtime, "node_modules"),
      "dir",
    );
    const project = join(dir, "project");
    await mkdir(project);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(runtime, "server.js"), "--local"],
        cwd: project,
        env: { PATH: "/usr/bin:/bin" },
        stderr: "pipe",
      }),
    );
    assert.equal(
      (await client.callTool({ name: "storybloq_board", arguments: {} }))
        .structuredContent.setupRequired,
      true,
    );
    await exec(
      process.execPath,
      [
        join(packageRoot, "dist/cli.js"),
        "--local-cli",
        "init",
        "--name",
        "Optional browser",
      ],
      { cwd: project, env: { PATH: "/usr/bin:/bin" } },
    );
    assert.equal(
      (await client.callTool({ name: "storybloq_board", arguments: {} }))
        .structuredContent.ready,
      true,
    );
    const board = await client.callTool({
      name: "storybloq_board",
      arguments: {},
    });
    assert.equal(board.isError, undefined);
    assert.equal(board.structuredContent.project, "Optional browser");
    assert.equal(board.structuredContent.localBrowser, undefined);
    assert.match(
      (await client.readResource({ uri: "ui://storybloq/board-v1.html" }))
        .contents[0].text,
      /Storybloq/,
    );
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
