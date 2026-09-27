/**
 * T-534: every Storybloq writer of a Claude Code settings file takes one lock
 * derived from the path its write lands on. An alias and the canonical
 * spelling must agree on that lock before the file exists too, or two writers
 * on initial setup overwrite each other.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalSettingsPath, settingsLockPath, withSettingsWriteLock } from "../../src/core/settings-write-lock.js";
import { enableFunctionHooksEnv, registerPreCompactHook } from "../../src/cli/commands/setup-skill.js";

let dir: string;
let realDir: string;
let aliasDir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "t534-settings-lock-")));
  realDir = join(dir, "real");
  mkdirSync(realDir);
  aliasDir = join(dir, "alias");
  symlinkSync(realDir, aliasDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("canonicalSettingsPath", () => {
  it("resolves an absent file through an aliased parent", () => {
    const canonical = join(realDir, "settings.json");
    expect(canonicalSettingsPath(join(aliasDir, "settings.json"))).toBe(canonical);
    expect(settingsLockPath(join(aliasDir, "settings.json"))).toBe(settingsLockPath(canonical));
  });

  it("follows a dangling symlink to its target", () => {
    const target = join(realDir, "target.json");
    const link = join(dir, "settings.json");
    symlinkSync(join("alias", "target.json"), link);
    expect(existsSync(target)).toBe(false);
    expect(canonicalSettingsPath(link)).toBe(target);
    expect(settingsLockPath(link)).toBe(settingsLockPath(target));
  });

  it("appends a missing tail to the nearest existing ancestor", () => {
    expect(canonicalSettingsPath(join(aliasDir, "a", "b", "settings.json"))).toBe(join(realDir, "a", "b", "settings.json"));
  });

  it("gives up on a symlink cycle", () => {
    const a = join(dir, "loop-a");
    const b = join(dir, "loop-b");
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(canonicalSettingsPath(a)).toBeNull();
    expect(settingsLockPath(a)).toBeNull();
  });

  it("terminates on a cycle through a parent (a -> a/child), and every writer skips it", async () => {
    const a = join(dir, "a");
    symlinkSync(join(a, "child"), a);
    expect(canonicalSettingsPath(a)).toBeNull();
    expect(canonicalSettingsPath(join(a, "settings.json"))).toBeNull();
    expect(await withSettingsWriteLock(a, "busy", async () => "ran")).toBe("busy");
    expect(await registerPreCompactHook(a, "/usr/local/bin/storybloq")).toBe("skipped");
    expect(await enableFunctionHooksEnv(join(a, "settings.json"))).toBe("skipped");
    expect(readdirSync(dir).sort()).toEqual(["a", "alias", "real"]);
  });
});

describe("withSettingsWriteLock", () => {
  it("an alias writer waits on the lock a canonical writer holds for an absent file", async () => {
    let release!: () => void;
    const holding = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const first = withSettingsWriteLock(join(realDir, "settings.json"), "busy", async () => {
      entered();
      await holding;
      return "first";
    });
    await inside;
    const second = await withSettingsWriteLock(join(aliasDir, "settings.json"), "busy", async () => "second", 200);
    expect(second).toBe("busy");
    release();
    expect(await first).toBe("first");
    expect(await withSettingsWriteLock(join(aliasDir, "settings.json"), "busy", async () => "second", 200)).toBe("second");
  }, 15_000);

  it("concurrent writers via the alias and the canonical path both land on an initially absent file", async () => {
    const canonical = join(realDir, "settings.json");
    const alias = join(aliasDir, "settings.json");
    expect(existsSync(canonical)).toBe(false);
    const [hook, env] = await Promise.all([
      registerPreCompactHook(alias, "/usr/local/bin/storybloq"),
      enableFunctionHooksEnv(canonical),
    ]);
    expect(hook).toBe("registered");
    expect(env).toBe("set");
    const settings = JSON.parse(readFileSync(canonical, "utf-8")) as {
      hooks?: Record<string, unknown>;
      env?: Record<string, unknown>;
    };
    expect(settings.hooks?.PreCompact).toBeDefined();
    expect(Object.keys(settings.env ?? {})).toHaveLength(1);
  }, 15_000);
});
