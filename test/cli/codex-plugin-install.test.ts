import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  cp,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installCodexPlugin } from "../../src/cli/codex-plugin-install.js";

import * as fsPromises from "node:fs/promises";
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

describe("local Codex plugin installer", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fsPromises.lstat).mockImplementation(actual.lstat);
    for (const dir of dirs.splice(0))
      await rm(dir, { recursive: true, force: true });
  });
  async function fixture() {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "storybloq-installer-")),
    );
    dirs.push(dir);
    const home = join(dir, "home"),
      pkg = join(dir, "package");
    await mkdir(home);
    await mkdir(join(pkg, "dist/board"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@storybloq/storybloq", version: "1.16.0" }),
    );
    await writeFile(join(pkg, "LICENSE"), "License");
    await writeFile(join(pkg, "NOTICE"), "Notice");
    await writeFile(join(pkg, "dist/cli.js"), "installed runtime");
    await writeFile(join(pkg, "dist/board/server.js"), "board runtime");
    await writeFile(join(pkg, "dist/board/board.html"), "board UI");
    await cp(join(process.cwd(), ".codex-plugin"), join(pkg, ".codex-plugin"), {
      recursive: true,
    });
    await cp(
      join(process.cwd(), "skills/storybloq"),
      join(pkg, "skills/storybloq"),
      { recursive: true },
    );
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "marketplace" && args[1] === "list")
        return { marketplaces: [] };
      if (args[0] === "marketplace")
        return { marketplaceName: "storybloq-local" };
      const market = JSON.parse(
        await readFile(
          join(
            home,
            ".storybloq/codex-plugin/.agents/plugins/marketplace.json",
          ),
          "utf8",
        ),
      );
      return {
        pluginId: "storybloq@storybloq-local",
        installedPath: join(
          home,
          ".storybloq/codex-plugin",
          market.plugins[0].source.path,
        ),
      };
    };
    return { dir, home, pkg, calls, run };
  }
  it("default runner invokes the Codex plugin command group", async () => {
    const f = await fixture();
    const bin = join(f.dir, "bin"),
      log = join(f.dir, "argv.jsonl");
    await mkdir(bin);
    const executable = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] !== "plugin" || args.at(-1) !== "--json") process.exit(61);
if (args[1] === "marketplace") console.log(JSON.stringify(args[2] === "list" ? { marketplaces: [] } : {}));
else {
 const root = ${JSON.stringify(join(f.home, ".storybloq/codex-plugin"))};
 const market = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json")));
 console.log(JSON.stringify({ pluginId: "storybloq@storybloq-local", installedPath: path.join(root, market.plugins[0].source.path) }));
}
`;
    await writeFile(join(bin, "codex"), executable, { mode: 0o700 });
    const previous = process.env.PATH;
    process.env.PATH = bin + ":" + (previous ?? "");
    try {
      await installCodexPlugin({ packageRoot: f.pkg, home: f.home });
      const calls = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((args) => args.slice(0, 3))).toEqual([
        ["plugin", "marketplace", "list"],
        ["plugin", "marketplace", "add"],
        ["plugin", "add", "storybloq@storybloq-local"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });
  it("binds installed Node/CLI and reuses an owned marketplace without project roots", async () => {
    const f = await fixture();
    const result = await installCodexPlugin({
      packageRoot: f.pkg,
      home: f.home,
      runCodex: f.run,
    });
    const mcp = JSON.parse(
      await readFile(
        join(result.installedPath, ".codex-plugin/mcp.json"),
        "utf8",
      ),
    );
    expect(mcp.mcpServers.storybloq_board).toEqual({
      command: await realpath(process.execPath),
      args: [await realpath(join(f.pkg, "dist/cli.js")), "--board-mcp"],
    });
    expect(mcp.mcpServers.storybloq_board.env).toBeUndefined();
    const repeated = await installCodexPlugin({
      packageRoot: f.pkg,
      home: f.home,
      runCodex: f.run,
    });
    expect(repeated.installedPath).toBe(result.installedPath);
    expect(f.calls.filter((c) => c[0] === "add")).toHaveLength(2);
  });
  it.each(["parent-link", "root-link", "unowned-root"])(
    "refuses %s before host writes",
    async (shape) => {
      const f = await fixture();
      const parent = join(f.home, ".storybloq");
      if (shape === "parent-link") await symlink(f.pkg, parent);
      else {
        await mkdir(parent);
        if (shape === "root-link")
          await symlink(f.pkg, join(parent, "codex-plugin"));
        else await mkdir(join(parent, "codex-plugin"));
      }
      await expect(
        installCodexPlugin({
          packageRoot: f.pkg,
          home: f.home,
          runCodex: f.run,
        }),
      ).rejects.toThrow();
      expect(
        f.calls.every((c) => c[0] === "marketplace" && c[1] === "list"),
      ).toBe(true);
    },
  );
  it("refuses another owner's matching marketplace namespace", async () => {
    const f = await fixture();
    await expect(
      installCodexPlugin({
        packageRoot: f.pkg,
        home: f.home,
        runCodex: async (args) => {
          f.calls.push(args);
          return { marketplaces: [{ name: "storybloq-local", root: f.pkg }] };
        },
      }),
    ).rejects.toThrow(/another|different|owned/i);
    expect(f.calls).toHaveLength(1);
  });
  it("rejects stale host cache output and permits a complete retry", async () => {
    const f = await fixture();
    await expect(
      installCodexPlugin({
        packageRoot: f.pkg,
        home: f.home,
        runCodex: async (args) =>
          args[0] === "add"
            ? { pluginId: "storybloq@storybloq-local", installedPath: f.pkg }
            : f.run(args),
      }),
    ).rejects.toThrow(/match|verification|installed/i);
    await expect(
      installCodexPlugin({ packageRoot: f.pkg, home: f.home, runCodex: f.run }),
    ).resolves.toHaveProperty("installedPath");
  });
  it("holds distinct runtime publication until successful installed-cache verification settles", async () => {
    const f = await fixture(),
      next = join(f.dir, "next-package"),
      cache = join(f.dir, "cache");
    await cp(f.pkg, next, { recursive: true });
    await writeFile(
      join(next, "skills/storybloq/SKILL.md"),
      "Updated installed skill",
    );
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fsPromises.lstat).mockImplementation(async (...args) => {
      if (args[0] === cache) {
        entered();
        await gate;
      }
      return actual.lstat(...args);
    });
    const first = installCodexPlugin({
      packageRoot: f.pkg,
      home: f.home,
      runCodex: async (args) => {
        const result = await f.run(args);
        if (args[0] === "add" && result.installedPath) {
          await cp(result.installedPath, cache, { recursive: true });
          return { ...result, installedPath: cache };
        }
        return result;
      },
    });
    void first.catch(() => {});
    await waiting;
    const catalog = join(
      f.home,
      ".storybloq/codex-plugin/.agents/plugins/marketplace.json",
    );
    const before = await readFile(catalog);
    const secondCalls: string[][] = [];
    try {
      await expect(
        installCodexPlugin({
          packageRoot: next,
          home: f.home,
          lockDeadlineMs: 30,
          runCodex: async (args) => {
            secondCalls.push(args);
            return f.run(args);
          },
        }),
      ).rejects.toThrow();
      expect(secondCalls).toEqual([]);
      expect(await readFile(catalog)).toEqual(before);
    } finally {
      release();
      await first.catch(() => {});
    }
    const installed = await first;
    expect(
      await readFile(
        join(installed.installedPath, "skills/storybloq/SKILL.md"),
        "utf8",
      ),
    ).not.toBe("Updated installed skill");
    const updated = await installCodexPlugin({
      packageRoot: next,
      home: f.home,
      runCodex: f.run,
    });
    expect(await readFile(catalog)).not.toEqual(before);
    expect(
      await readFile(
        join(updated.installedPath, "skills/storybloq/SKILL.md"),
        "utf8",
      ),
    ).toBe("Updated installed skill");
  });
  it("holds installation admission through host verification and releases after a failure", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = installCodexPlugin({
      packageRoot: f.pkg,
      home: f.home,
      runCodex: async (args) => {
        if (args[0] === "add") {
          entered();
          await gate;
          throw new Error("host unavailable");
        }
        return f.run(args);
      },
    });
    void first.catch(() => {});
    await waiting;
    const before = await readFile(
      join(f.home, ".storybloq/codex-plugin/.agents/plugins/marketplace.json"),
    );
    const secondCalls: string[][] = [];
    try {
      await expect(
        installCodexPlugin({
          packageRoot: f.pkg,
          home: f.home,
          lockDeadlineMs: 30,
          runCodex: async (args) => {
            secondCalls.push(args);
            return f.run(args);
          },
        }),
      ).rejects.toThrow();
      expect(secondCalls).toEqual([]);
      expect(
        await readFile(
          join(
            f.home,
            ".storybloq/codex-plugin/.agents/plugins/marketplace.json",
          ),
        ),
      ).toEqual(before);
    } finally {
      release();
      await first.catch(() => {});
    }
    await expect(first).rejects.toThrow("host unavailable");
    await expect(
      installCodexPlugin({ packageRoot: f.pkg, home: f.home, runCodex: f.run }),
    ).resolves.toHaveProperty("installedPath");
  });
});
