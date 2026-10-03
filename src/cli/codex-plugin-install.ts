import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  acquireProjectLockAsync,
  releaseProjectLock,
} from "../core/project-lock.js";

const exec = promisify(execFile);
const namespace = "storybloq-local";
const owner = "storybloq-local-codex-v1\n";
type HostResult = {
  marketplaces?: { name: string; root: string }[];
  pluginId?: string;
  installedPath?: string;
};
export interface CodexPluginInstallOptions {
  packageRoot: string;
  home?: string;
  runCodex?: (args: string[]) => Promise<HostResult>;
  lockDeadlineMs?: number;
}
async function regularFile(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Storybloq installation assets must be regular files.");
  return readFile(path);
}
async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Storybloq plugin storage must be a real directory.");
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
async function verifyFiles(
  root: string,
  files: Map<string, Buffer>,
): Promise<void> {
  await directory(root);
  async function visit(path: string, relative = ""): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink())
        await visit(join(path, entry.name), name);
      else if (!files.has(name))
        throw new Error(
          "Installed Storybloq plugin verification found unexpected files.",
        );
    }
  }
  await visit(root);
  for (const [name, bytes] of files) {
    if (!(await regularFile(join(root, name))).equals(bytes))
      throw new Error(
        "Installed Storybloq plugin bytes do not match this runtime. Retry installation.",
      );
  }
}

async function preparePlugin(packageRoot: string) {
  const pkg = await realpath(packageRoot);
  const metadata = JSON.parse(
    (await regularFile(join(pkg, "package.json"))).toString(),
  );
  if (metadata.name !== "@storybloq/storybloq")
    throw new Error("This is not an installed Storybloq package.");
  const node = await realpath(process.execPath),
    cli = await realpath(join(pkg, "dist/cli.js"));
  const runtime = await regularFile(cli);
  const board = await regularFile(join(pkg, "dist/board/server.js"));
  const html = await regularFile(join(pkg, "dist/board/board.html"));
  const files = new Map<string, Buffer>();
  for (const name of [
    ".codex-plugin/plugin.json",
    ".codex-plugin/ASSETS.md",
    ".codex-plugin/icon.png",
    "skills/storybloq/SKILL.md",
    "LICENSE",
    "NOTICE",
  ])
    files.set(name, await regularFile(join(pkg, name)));
  const manifest = JSON.parse(
    files.get(".codex-plugin/plugin.json")!.toString(),
  );
  if (
    manifest.name !== "storybloq" ||
    manifest.version !== metadata.version ||
    manifest.mcpServers !== "./.codex-plugin/mcp.json" ||
    manifest.skills !== "./skills"
  )
    throw new Error(
      "Storybloq plugin metadata does not match this installation.",
    );
  files.set(
    ".codex-plugin/mcp.json",
    Buffer.from(
      JSON.stringify(
        {
          mcpServers: {
            storybloq_board: { command: node, args: [cli, "--board-mcp"] },
          },
        },
        null,
        2,
      ) + "\n",
    ),
  );
  const digest = createHash("sha256")
    .update(node)
    .update(process.version)
    .update(cli)
    .update(runtime)
    .update(board)
    .update(html);
  for (const [name, bytes] of files) digest.update(name).update(bytes);
  const id = digest.digest("hex");
  return { files, id };
}

async function publishPlugin(
  root: string,
  parent: string,
  files: Map<string, Buffer>,
  id: string,
) {
  if (await absent(root)) {
    const stage = await mkdtemp(join(parent, ".codex-plugin-stage-"));
    try {
      await writeFile(join(stage, ".storybloq-owner"), owner, {
        flag: "wx",
        mode: 0o600,
      });
      await mkdir(join(stage, "plugins"));
      await mkdir(join(stage, ".agents/plugins"), { recursive: true });
      await rename(stage, root);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  await directory(root);
  if ((await regularFile(join(root, ".storybloq-owner"))).toString() !== owner)
    throw new Error("Storybloq cannot replace an unowned plugin directory.");
  await directory(join(root, "plugins"));
  await directory(join(root, ".agents"));
  await directory(join(root, ".agents/plugins"));
  const source = join(root, "plugins", id);
  if (await absent(source)) {
    const stage = await mkdtemp(join(root, "plugins/.stage-"));
    try {
      for (const [name, bytes] of files) {
        const pieces = name.split("/");
        pieces.pop();
        if (pieces.length)
          await mkdir(join(stage, ...pieces), { recursive: true });
        await writeFile(join(stage, name), bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
      await verifyFiles(stage, files);
      await rename(stage, source);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  await verifyFiles(source, files);
  const catalog = Buffer.from(
    JSON.stringify(
      {
        name: namespace,
        plugins: [
          {
            name: "storybloq",
            source: { source: "local", path: `./plugins/${id}` },
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_INSTALL",
            },
            category: "Productivity",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  const stage = await mkdtemp(join(root, ".catalog-stage-"));
  try {
    await writeFile(join(stage, "marketplace.json"), catalog, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(
      join(stage, "marketplace.json"),
      join(root, ".agents/plugins/marketplace.json"),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Explicit installation only. No project selection, hooks or CLI housekeeping. */
export async function installCodexPlugin(
  options: CodexPluginInstallOptions,
): Promise<{ installedPath: string; marketplaceRoot: string }> {
  const { files, id } = await preparePlugin(options.packageRoot);
  const home = await realpath(options.home ?? homedir()),
    parent = join(home, ".storybloq");
  if (await absent(parent)) {
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  // Validate the parent before the shared lock helper can write through it.
  await directory(parent);
  const lock = await acquireProjectLockAsync(
    join(parent, "codex-plugin-install.lock"),
    { deadlineMs: options.lockDeadlineMs },
  );
  try {
    const root = join(parent, "codex-plugin");
    const run =
      options.runCodex ??
      (async (args: string[]) => {
        try {
          const result = await exec("codex", ["plugin", ...args, "--json"], {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          });
          return JSON.parse(result.stdout) as HostResult;
        } catch {
          throw new Error(
            "Codex plugin installation could not finish. Install the Codex CLI, then retry storybloq-codex install.",
          );
        }
      });
    const existing = await run(["marketplace", "list"]);
    if (!Array.isArray(existing.marketplaces))
      throw new Error("Codex did not return its local marketplace inventory.");
    const collision = existing.marketplaces.find((m) => m.name === namespace);
    if (
      collision &&
      resolve(collision.root) !== root &&
      (await realpath(collision.root)) !== root
    )
      throw new Error(
        "The storybloq-local marketplace is owned by a different installation. Resolve that registration before retrying.",
      );
    await publishPlugin(root, parent, files, id);
    await run(["marketplace", "add", root]);
    const installed = await run(["add", `storybloq@${namespace}`]);
    if (
      installed.pluginId !== `storybloq@${namespace}` ||
      typeof installed.installedPath !== "string"
    )
      throw new Error("Codex did not confirm the installed Storybloq plugin.");
    await verifyFiles(installed.installedPath, files);
    return { installedPath: installed.installedPath, marketplaceRoot: root };
  } finally {
    releaseProjectLock(lock);
  }
}
