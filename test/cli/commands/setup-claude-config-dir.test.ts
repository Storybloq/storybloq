/**
 * ISS-1270: `storybloq setup --client claude` installs into CLAUDE_CONFIG_DIR
 * when it is set: the /story skill, the old /prime cleanup, the Mods copy, the
 * function-hooks switch in settings.json, and the bridge registration's read of
 * `.claude.json`. The fake HOME's copies are never touched. Every case builds
 * its own scratch HOME and scratch override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BRIDGE = "codex-bridge";
const saved: Record<string, string | undefined> = {};
let home: string;
let cfg: string;
let bridgeEntry: string;
let out: string[];

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "iss1270-setup-")));
  cfg = join(home, "cfg");
  for (const k of ["HOME", "USERPROFILE", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Empty PATH: no storybloq or claude binary, so setup registers nothing
  // with a real client and the bridge registration reports `claude` missing.
  process.env.PATH = "";
  process.env.CODEX_HOME = join(home, ".codex");
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const packageDir = join(home, "node_modules", "codex-claude-bridge");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  bridgeEntry = join(packageDir, "dist", "index.js");
  writeFileSync(bridgeEntry, "// bridge\n");
  vi.resetModules();
  vi.doMock("../../../src/core/bridge-resolve.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/core/bridge-resolve.js")>();
    return { ...actual, resolveBundledBridge: () => ({ kind: "installed", packageDir, entry: bridgeEntry, version: "1.8.0" }) };
  });
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../../../src/core/bridge-resolve.js");
  vi.resetModules();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function foreignRegistry(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: { [BRIDGE]: { command: "/opt/other/bridge", args: [] } } }));
}

async function setup(): Promise<string> {
  const { handleSetup } = await import("../../../src/cli/commands/setup-skill.js");
  await handleSetup({ client: "claude", skipHooks: true });
  return out.join("");
}

describe("setup --client claude follows CLAUDE_CONFIG_DIR (ISS-1270)", () => {
  it("installs the skill, Mods copy and switch under the override, and cleans only the override's /prime", async () => {
    if (process.platform === "win32") return;
    mkdirSync(join(home, ".claude", "skills", "prime"), { recursive: true });
    mkdirSync(join(cfg, "skills", "prime"), { recursive: true });
    const text = await setup();

    expect(existsSync(join(cfg, "skills", "story", "SKILL.md")), text).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "story"))).toBe(false);
    expect(existsSync(join(cfg, "skills", "prime"))).toBe(false);
    expect(existsSync(join(home, ".claude", "skills", "prime"))).toBe(true);
    expect(existsSync(join(cfg, "skills", "storybloq", "hooks", "mod.ts")), text).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "storybloq"))).toBe(false);
    expect(text).toContain(`Installed Mods (function hooks) at ${join(cfg, "skills", "storybloq")}/`);
    const settings = JSON.parse(readFileSync(join(cfg, "settings.json"), "utf-8")) as { env?: Record<string, unknown> };
    expect(settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS).toBe("1");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("the bridge registration reads the override's .claude.json, not HOME's", async () => {
    if (process.platform === "win32") return;
    foreignRegistry(join(home, ".claude.json"));
    const text = await setup();
    // The override has no entry, so setup goes on to `claude mcp add`, which
    // is not on PATH. Reading HOME's registry would have left it alone.
    expect(text).toContain("Codex review bridge not registered -- `claude` CLI not found in PATH.");
    expect(text).not.toContain("left alone");
  });

  it("a foreign entry in the override's .claude.json is what setup leaves alone", async () => {
    if (process.platform === "win32") return;
    foreignRegistry(join(cfg, ".claude.json"));
    const text = await setup();
    expect(text).toContain(`${BRIDGE} is registered at user scope with a different command`);
  });

  it("an override set explicitly to ~/.claude reads ~/.claude/.claude.json, not ~/.claude.json", async () => {
    if (process.platform === "win32") return;
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    foreignRegistry(join(home, ".claude", ".claude.json"));
    const text = await setup();
    expect(text).toContain(`${BRIDGE} is registered at user scope with a different command`);
  });
});

describe("settings.json writers default to the override (ISS-1270)", () => {
  it("registerSessionIntelStartHook installs into the override even when HOME already holds the canonical entry", async () => {
    // HOME holds exactly one canonical intel-start entry for this binary with
    // the full matcher, the override holds none. A writer that inspected
    // HOME would answer "exists" and leave the override without the hook.
    const { registerSessionIntelStartHook } = await import("../../../src/cli/commands/setup-skill.js");
    const bin = "/opt/sb/bin/storybloq";
    const homeSettings = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(await registerSessionIntelStartHook(homeSettings, bin)).toBe("registered");
    const homeBefore = readFileSync(homeSettings, "utf-8");

    expect(await registerSessionIntelStartHook(undefined, bin)).toBe("registered");
    const written = readFileSync(join(cfg, "settings.json"), "utf-8");
    expect(written).toContain("intel-start");
    expect(written).toContain("startup|resume|clear|compact");
    expect(readFileSync(homeSettings, "utf-8")).toBe(homeBefore);
  });

  it("defaultSettingsPath and enableFunctionHooksEnv use the override", async () => {
    const { defaultSettingsPath } = await import("../../../src/core/hook-migration.js");
    const { enableFunctionHooksEnv } = await import("../../../src/cli/commands/setup-skill.js");
    expect(defaultSettingsPath()).toBe(join(cfg, "settings.json"));
    expect(await enableFunctionHooksEnv()).toBe("set");
    expect(existsSync(join(cfg, "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});
