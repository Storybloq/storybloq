/**
 * ISS-1270: Claude's config dir follows CLAUDE_CONFIG_DIR, and every path and
 * display string derives from that one resolution. Every case uses its own
 * scratch HOME and scratch override; none points the variable at a real
 * configuration.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeConfigDir, claudeConfigDisplay, claudeJsonPath, claudeSettingsPath } from "../../src/core/claude-config-dir.js";

const saved: Record<string, string | undefined> = {};
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "iss1270-home-"));
  for (const k of ["HOME", "CLAUDE_CONFIG_DIR"]) saved[k] = process.env[k];
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(home, { recursive: true, force: true });
});

describe("claudeConfigDir and friends (ISS-1270)", () => {
  it("unset: ~/.claude, with .claude.json beside it", () => {
    expect(claudeConfigDir()).toBe(join(home, ".claude"));
    expect(claudeSettingsPath()).toBe(join(home, ".claude", "settings.json"));
    expect(claudeJsonPath()).toBe(join(home, ".claude.json"));
    expect(claudeConfigDisplay("skills", "story")).toBe("~/.claude/skills/story");
  });

  it("set: the override, with .claude.json inside it, and the display names the override", () => {
    const cfg = join(home, "cfg");
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(claudeConfigDir()).toBe(cfg);
    expect(claudeSettingsPath()).toBe(join(cfg, "settings.json"));
    expect(claudeJsonPath()).toBe(join(cfg, ".claude.json"));
    expect(claudeConfigDisplay("skills", "story")).toBe(join(cfg, "skills", "story"));
  });

  it("empty: treated as unset, never the cwd", () => {
    process.env.CLAUDE_CONFIG_DIR = "";
    expect(claudeConfigDir()).toBe(join(home, ".claude"));
    expect(claudeJsonPath()).toBe(join(home, ".claude.json"));
    expect(claudeConfigDisplay("settings.json")).toBe("~/.claude/settings.json");
  });

  it("relative: resolved against the cwd", () => {
    process.env.CLAUDE_CONFIG_DIR = "rel-cfg";
    expect(claudeConfigDir()).toBe(resolve("rel-cfg"));
    expect(claudeJsonPath()).toBe(join(resolve("rel-cfg"), ".claude.json"));
  });

  it("an override set explicitly to ~/.claude still puts .claude.json inside it", () => {
    process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
    expect(claudeJsonPath()).toBe(join(home, ".claude", ".claude.json"));
  });

  it("is read on every call: scratch A, then scratch B, then unset, with no module reset", () => {
    const a = join(home, "a");
    const b = join(home, "b");
    process.env.CLAUDE_CONFIG_DIR = a;
    expect([claudeConfigDir(), claudeJsonPath(), claudeConfigDisplay("x")]).toEqual([a, join(a, ".claude.json"), join(a, "x")]);
    process.env.CLAUDE_CONFIG_DIR = b;
    expect([claudeConfigDir(), claudeJsonPath(), claudeConfigDisplay("x")]).toEqual([b, join(b, ".claude.json"), join(b, "x")]);
    delete process.env.CLAUDE_CONFIG_DIR;
    expect([claudeConfigDir(), claudeJsonPath(), claudeConfigDisplay("x")]).toEqual([join(home, ".claude"), join(home, ".claude.json"), "~/.claude/x"]);
  });
});
