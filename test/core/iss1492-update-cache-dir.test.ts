/**
 * ISS-1492: the update-check cache follows STORYBLOQ_GLOBAL_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude,
 * while the durable global dir (storybloqGlobalDir) deliberately keeps ignoring CLAUDE_CONFIG_DIR.
 *
 * The end-to-end rows run the built CLI under `env -i` with a temp HOME. No network: a test-only module
 * preloaded through NODE_OPTIONS replaces fetch with a stub answering one version.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { storybloqGlobalDir, updateCacheDir } from "../../src/core/global-config.js";
import { cachePath } from "../../src/core/update-check.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(PKG, "dist", "cli.js");
const KEYS = ["CLAUDE_CONFIG_DIR", "STORYBLOQ_GLOBAL_DIR"] as const;

describe("ISS-1492 resolution", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("unset: the cache stays at the old path, so existing users keep it", () => {
    expect(cachePath()).toBe(join(homedir(), ".claude", "storybloq", "update-check.json"));
  });
  it("CLAUDE_CONFIG_DIR: the cache follows Claude's config dir", () => {
    process.env.CLAUDE_CONFIG_DIR = "/x/cfg";
    expect(updateCacheDir()).toBe("/x/cfg/storybloq");
    expect(cachePath()).toBe("/x/cfg/storybloq/update-check.json");
  });
  it("STORYBLOQ_GLOBAL_DIR wins, alone and over CLAUDE_CONFIG_DIR", () => {
    process.env.STORYBLOQ_GLOBAL_DIR = "/x/g";
    expect(cachePath()).toBe("/x/g/update-check.json");
    process.env.CLAUDE_CONFIG_DIR = "/x/cfg";
    expect(cachePath()).toBe("/x/g/update-check.json");
  });
  it("empty values fall through and never resolve to the cwd", () => {
    process.env.STORYBLOQ_GLOBAL_DIR = "";
    process.env.CLAUDE_CONFIG_DIR = "";
    expect(updateCacheDir()).toBe(join(homedir(), ".claude", "storybloq"));
    process.env.CLAUDE_CONFIG_DIR = "/x/cfg";
    expect(updateCacheDir()).toBe("/x/cfg/storybloq");
  });
  it("storybloqGlobalDir() still ignores CLAUDE_CONFIG_DIR (durable state; a unify must be deliberate)", () => {
    process.env.CLAUDE_CONFIG_DIR = "/x/cfg";
    expect(storybloqGlobalDir()).toBe(join(homedir(), ".claude", "storybloq"));
    process.env.STORYBLOQ_GLOBAL_DIR = "/x/g";
    expect(storybloqGlobalDir()).toBe("/x/g");
  });
});

describe("ISS-1492 end to end: where a real command writes the cache", () => {
  let root: string;
  let stub: string;
  const files = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (rel: string): void => {
      const p = join(dir, rel);
      if (!existsSync(p)) return;
      if (statSync(p).isDirectory()) { for (const n of readdirSync(p).sort()) walk(rel ? `${rel}/${n}` : n); } else out.push(rel);
    };
    walk("");
    return out;
  };
  const cli = (cwd: string, home: string, args: string[], extra: Record<string, string>): number | null =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd, encoding: "utf-8", timeout: 60_000,
      env: { HOME: home, PATH: "/usr/bin:/bin", NODE_OPTIONS: `--import=${stub}`, ...extra },
    }).status;
  const runStatus = (extra: Record<string, string>): { home: string; base: string } => {
    const base = mkdtempSync(join(root, "case-"));
    const home = join(base, "home");
    const work = join(base, "work");
    mkdirSync(home); mkdirSync(work);
    expect(cli(work, home, ["init", "--name", "p"], extra)).toBe(0);
    expect(cli(work, home, ["status"], extra)).toBe(0);
    return { home, base };
  };
  const cacheAt = (p: string): string => JSON.parse(readFileSync(p, "utf-8")).latestVersion;

  beforeAll(() => {
    expect(existsSync(CLI)).toBe(true);
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "iss1492-"));
    stub = join(root, "fetch-stub.mjs");
    writeFileSync(stub, 'globalThis.fetch = async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200, headers: { "content-type": "application/json" } });\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("CLAUDE_CONFIG_DIR: the cache lands in the config dir and nothing of the cache is under HOME/.claude", () => {
    const cfg = join(root, "cfg");
    const { home } = runStatus({ CLAUDE_CONFIG_DIR: cfg });
    expect(cacheAt(join(cfg, "storybloq", "update-check.json"))).toBe("9.9.9");
    // Only storybloqGlobalDir()'s durable state (the T-534 retirement marker) may sit under HOME/.claude.
    expect(files(join(home, ".claude")).filter((f) => !f.startsWith("storybloq/.limit-retired"))).toEqual([]);
  }, 120_000);
  it("STORYBLOQ_GLOBAL_DIR: the cache lands there and nothing at all is under HOME/.claude", () => {
    const g = join(root, "g");
    const { home } = runStatus({ STORYBLOQ_GLOBAL_DIR: g });
    expect(cacheAt(join(g, "update-check.json"))).toBe("9.9.9");
    // No file at all, and not even an empty storybloq directory: the cache write makes only its own parent.
    // (HOME/.claude itself is Claude's config dir, which STORYBLOQ_GLOBAL_DIR does not move.)
    expect(files(join(home, ".claude"))).toEqual([]);
    expect(existsSync(join(home, ".claude", "storybloq"))).toBe(false);
  }, 120_000);
  it("both unset: the cache stays at HOME/.claude/storybloq, as today", () => {
    const { home } = runStatus({});
    expect(cacheAt(join(home, ".claude", "storybloq", "update-check.json"))).toBe("9.9.9");
  }, 120_000);
});
