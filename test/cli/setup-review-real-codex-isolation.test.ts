/**
 * ISS-1457, opt-in (STORYBLOQ_REAL_CODEX=1, binary at STORYBLOQ_REAL_CODEX_BIN):
 * every route by which codex 0.163.0 starts something its user or a project
 * configured, planted as an MCP server or hook that writes a marker, run once
 * without the isolation flags (the marker appears: the route is real) and once
 * through the real launch builder (no marker). Scratch HOME, CODEX_HOME and
 * TMPDIR, the probe's dummy key, the provider at a closed 127.0.0.1 port, so
 * nothing leaves the machine. The ordinary suite never depends on this file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexArgs, PROBE_KEY_ENV, probeOverrides } from "../../src/core/setup-review-backends.js";

const REAL = process.env.STORYBLOQ_REAL_CODEX === "1";
const BIN = process.env.STORYBLOQ_REAL_CODEX_BIN ?? "";
const BYPASS = "--dangerously-bypass-hook-trust";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function closedPort(): Promise<number> {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => res(port));
    });
  });
}

interface Rig {
  readonly root: string;
  readonly home: string;
  readonly codexHome: string;
  readonly proj: string;
  readonly exec: string;
  readonly marker: string;
}

function rig(): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sr-real-iso-")));
  roots.push(root);
  for (const d of ["home", "codex-home", "tmp", "proj/sub/exec", "work"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
  return { root, home: join(root, "home"), codexHome: join(root, "codex-home"), proj: join(root, "proj"), exec: join(root, "proj", "sub", "exec"), marker: join(root, "MARKER") };
}

const mcpToml = (marker: string): string => `[mcp_servers.sentinel]\ncommand = "/bin/sh"\nargs = ["-c", "touch ${marker}; sleep 20"]\n`;
const hooksJson = (marker: string): string =>
  JSON.stringify({ hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop"].map((ev) => [ev, [{ hooks: [{ type: "command", command: `touch ${marker}` }] }]])) });
const trust = (dir: string): string => `[projects."${realpathSync(dir)}"]\ntrust_level = "trusted"\n`;
const gitInit = (r: Rig, dir: string): void => {
  spawnSync("/usr/bin/git", ["init", "-q", dir], { env: { HOME: r.home, PATH: "/usr/bin:/bin" } });
};
/** Appends a TOML fragment once: a table repeated by two routes would make the whole file invalid. */
const append = (path: string, text: string): void => {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (!before.includes(text)) writeFileSync(path, before ? `${before}\n${text}` : text);
};

function plugin(r: Rig): void {
  const mkt = join(r.root, "mkt");
  const mcp = JSON.stringify({ mcpServers: { sentinel: { command: "/bin/sh", args: ["-c", `touch ${r.marker}; sleep 20`] } } });
  const manifest = JSON.stringify({ name: "p", version: "0.0.1", description: "d" });
  const market = JSON.stringify({ name: "m", owner: { name: "x" }, plugins: [{ name: "p", source: "./p", description: "d" }] });
  for (const [path, text] of [
    [join(mkt, ".claude-plugin", "marketplace.json"), market], [join(mkt, ".agents", "plugins", "marketplace.json"), market],
    [join(mkt, "p", ".mcp.json"), mcp], [join(mkt, "p", ".codex-plugin", "plugin.json"), manifest],
    [join(r.codexHome, "plugins", "cache", "m", "p", "0.0.1", ".mcp.json"), mcp], [join(r.codexHome, "plugins", "cache", "m", "p", "0.0.1", ".codex-plugin", "plugin.json"), manifest],
  ] as const) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  append(join(r.codexHome, "config.toml"), `[marketplaces.m]\nsource_type = "local"\nsource = "${mkt}"\n\n[plugins."p@m"]\nenabled = true\n`);
}

/** Each route plants one integration and names the folder codex starts in. */
const ROUTES: Record<string, (r: Rig) => void> = {
  "user config MCP": (r) => append(join(r.codexHome, "config.toml"), mcpToml(r.marker)),
  "trusted project config at the folder": (r) => {
    mkdirSync(join(r.exec, ".codex"), { recursive: true });
    writeFileSync(join(r.exec, ".codex", "config.toml"), mcpToml(r.marker));
    append(join(r.codexHome, "config.toml"), trust(r.exec));
  },
  "trusted project config at a git ancestor": (r) => {
    gitInit(r, r.proj);
    mkdirSync(join(r.proj, ".codex"), { recursive: true });
    writeFileSync(join(r.proj, ".codex", "config.toml"), mcpToml(r.marker));
    append(join(r.codexHome, "config.toml"), trust(r.proj));
  },
  "trusted project config nested between the git root and the folder": (r) => {
    gitInit(r, r.proj);
    mkdirSync(join(r.proj, "sub", ".codex"), { recursive: true });
    writeFileSync(join(r.proj, "sub", ".codex", "config.toml"), mcpToml(r.marker));
    append(join(r.codexHome, "config.toml"), trust(r.proj));
  },
  "CODEX_HOME hooks.json": (r) => writeFileSync(join(r.codexHome, "hooks.json"), hooksJson(r.marker)),
  "[hooks] in config.toml": (r) => append(join(r.codexHome, "config.toml"), `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "touch ${r.marker}"\n[[hooks.UserPromptSubmit]]\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "touch ${r.marker}"\n`),
  "trusted project hooks.json": (r) => {
    gitInit(r, r.proj);
    mkdirSync(join(r.proj, ".codex"), { recursive: true });
    writeFileSync(join(r.proj, ".codex", "hooks.json"), hooksJson(r.marker));
    append(join(r.codexHome, "config.toml"), trust(r.proj));
  },
  plugin,
};

/** Runs codex once from `exec`, with the hook-trust bypass when asked, and says whether the marker appeared. */
async function launch(r: Rig, isolated: boolean, bypass: boolean, extra: string[] = []): Promise<boolean> {
  const port = await closedPort();
  const built = codexArgs(join(r.root, "work", "schema.json"), join(r.root, "work", "out.json"), [...probeOverrides(port, "0".repeat(32)), ...extra]);
  writeFileSync(join(r.root, "work", "schema.json"), JSON.stringify({ type: "object" }));
  const withoutFlags = isolated ? built : stripIsolation(built);
  const argv = bypass ? [withoutFlags[0]!, BYPASS, ...withoutFlags.slice(1)] : withoutFlags;
  spawnSync(BIN, argv, {
    cwd: r.exec, input: "probe\n", timeout: 25_000, killSignal: "SIGKILL",
    env: { HOME: r.home, CODEX_HOME: r.codexHome, TMPDIR: join(r.root, "tmp"), PATH: "/usr/bin:/bin", [PROBE_KEY_ENV]: "storybloq-probe-not-a-credential" },
  });
  spawnSync("/usr/bin/pkill", ["-f", `touch ${r.marker}`]);
  return existsSync(r.marker);
}

/** The launch with the isolation flags taken out, every other argument as built. */
function stripIsolation(built: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < built.length; i++) {
    if (built[i] === "--disable" && (built[i + 1] === "hooks" || built[i + 1] === "plugins")) {
      i++;
      continue;
    }
    if (built[i] === "--ignore-user-config" || built[i] === "--ignore-rules") continue;
    out.push(built[i]!);
  }
  return out;
}

describe.runIf(REAL)("codex starts nothing its user or a project configured (ISS-1457, opt-in)", () => {
  it("the binary is the characterised one", () => {
    expect(spawnSync(BIN, ["--version"], { encoding: "utf-8", env: { PATH: "/usr/bin:/bin" } }).stdout.trim()).toBe("codex-cli 0.163.0");
  });

  for (const [name, plant] of Object.entries(ROUTES)) {
    it(`${name}: real without the flags, closed by the launch as built, even with the hook-trust bypass`, async () => {
      const bare = rig();
      plant(bare);
      expect(await launch(bare, false, true)).toBe(true);
      const built = rig();
      plant(built);
      expect(await launch(built, true, false)).toBe(false);
      const bypassed = rig();
      plant(bypassed);
      expect(await launch(bypassed, true, true)).toBe(false);
    }, 120_000);
  }

  it("a -c MCP server is real, which is why the launch never passes one", async () => {
    const r = rig();
    const extra = ["-c", `mcp_servers.sentinel={ command = "/bin/sh", args = ["-c", "touch ${r.marker}; sleep 20"] }`];
    expect(await launch(r, true, false, extra)).toBe(true);
    expect(codexArgs("/s", "/o").some((a) => /mcp_servers/.test(a))).toBe(false);
  }, 60_000);

  it("every route at once: the launch as built starts none, with or without the bypass", async () => {
    for (const bypass of [false, true]) {
      const r = rig();
      for (const plant of Object.values(ROUTES)) plant(r);
      expect(await launch(r, true, bypass)).toBe(false);
    }
    const bare = rig();
    for (const plant of Object.values(ROUTES)) plant(bare);
    expect(await launch(bare, false, false)).toBe(true);
  }, 180_000);
});
