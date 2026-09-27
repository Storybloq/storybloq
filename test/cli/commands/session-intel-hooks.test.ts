/**
 * T-499 build 7: session-intel hook registration matrix.
 *
 * registerSessionIntelStartHook (SessionStart, every source, sync, 5 s) and
 * registerSessionIntelPromptHook (UserPromptSubmit, empty matcher, sync, 10 s),
 * the un-gated reconcile ensureSessionIntelHooksRegistered (kill-switch aware,
 * T-424 shape), the legacy-basename sweep for both, and the count carrier.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerSessionIntelStartHook,
  registerSessionIntelPromptHook,
  ensureSessionIntelHooksRegistered,
} from "../../../src/cli/commands/setup-skill.js";
import {
  INTELSTART_SUBCOMMAND,
  INTELPROMPT_SUBCOMMAND,
  SESSION_INTEL_SESSIONSTART_MATCHER,
  INTELSTART_HOOK_TIMEOUT_SECONDS,
  INTELPROMPT_HOOK_TIMEOUT_SECONDS,
  SESSIONSTART_SUBCOMMAND,
  PRECOMPACT_SUBCOMMAND,
  STOP_SUBCOMMAND,
  formatHookCommand,
  countLegacyHooks,
  sweepLegacyHooks,
} from "../../../src/core/hook-migration.js";
import { isSessionIntelGloballyDisabled } from "../../../src/core/global-config.js";

const BIN = "/usr/local/bin/storybloq";
const START_CMD = formatHookCommand(BIN, INTELSTART_SUBCOMMAND);
const PROMPT_CMD = formatHookCommand(BIN, INTELPROMPT_SUBCOMMAND);
const RESUME_CMD = formatHookCommand(BIN, SESSIONSTART_SUBCOMMAND);

interface Entry { type: string; command: string; timeout?: number; async?: boolean }
interface MatcherGroup { matcher?: string; hooks: Entry[] }
interface Settings { hooks?: Record<string, MatcherGroup[]> }

let dir: string;
let globalDir: string;
let settingsPath: string;
let savedGlobalDir: string | undefined;

const readSettings = (): Settings => JSON.parse(readFileSync(settingsPath, "utf-8")) as Settings;
const groups = (hookType: string): MatcherGroup[] => readSettings().hooks?.[hookType] ?? [];
const groupFor = (hookType: string, matcher: string) => groups(hookType).find((g) => (g.matcher ?? "") === matcher);
const entriesWith = (hookType: string, command: string) => groups(hookType).flatMap((g) => g.hooks.filter((h) => h.command === command));

/** A settings.json as installed by current setup plus the T-424 groups. */
function writeCurrentInstallSettings(): void {
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PreCompact: [{ matcher: "", hooks: [{ type: "command", command: formatHookCommand(BIN, PRECOMPACT_SUBCOMMAND) }] }],
      SessionStart: [
        { matcher: "compact", hooks: [{ type: "command", command: RESUME_CMD }] },
        { matcher: "resume", hooks: [{ type: "command", command: RESUME_CMD }] },
      ],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: formatHookCommand(BIN, STOP_SUBCOMMAND), async: true }] }],
    },
  }, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t499-hooks-"));
  globalDir = mkdtempSync(join(tmpdir(), "t499-hooks-global-"));
  settingsPath = join(dir, "settings.json");
  savedGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
  process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
});

afterEach(async () => {
  if (savedGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
  else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobalDir;
  await rm(dir, { recursive: true, force: true });
  await rm(globalDir, { recursive: true, force: true });
});

describe("registerSessionIntelStartHook", () => {
  it("registers one synchronous, 5 s entry under the every-source matcher, beside the compact and resume groups", async () => {
    writeCurrentInstallSettings();
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("registered");
    const g = groupFor("SessionStart", SESSION_INTEL_SESSIONSTART_MATCHER);
    expect(g?.hooks).toEqual([{ type: "command", command: START_CMD, timeout: INTELSTART_HOOK_TIMEOUT_SECONDS }]);
    expect(g?.hooks[0]).not.toHaveProperty("async");
    expect(INTELSTART_HOOK_TIMEOUT_SECONDS).toBe(5);
    expect(groupFor("SessionStart", "compact")?.hooks).toHaveLength(1);
    expect(groupFor("SessionStart", "resume")?.hooks).toHaveLength(1);
  });

  it("is idempotent", async () => {
    await registerSessionIntelStartHook(settingsPath, BIN);
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("exists");
    expect(entriesWith("SessionStart", START_CMD)).toHaveLength(1);
  });

  it("skips when a group covering EVERY source already carries the command (no double-fire)", async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: START_CMD }] }] } }));
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("exists");
    expect(entriesWith("SessionStart", START_CMD)).toHaveLength(1);
  });

  /** How many times a SessionStart `source` would run `command` under the current settings. */
  function firesFor(source: string, command: string): number {
    return groups("SessionStart").filter((g) => new RegExp(`^(?:${g.matcher ?? ""})$`).test(source) || (g.matcher ?? "") === "").flatMap((g) => g.hooks.filter((h) => h.command === command)).length;
  }

  it("normalizes a partial-coverage entry: the command moves into the one canonical group and every source fires it exactly once; other hooks in that group stay", async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: START_CMD }, { type: "command", command: RESUME_CMD }] }] } }));
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("registered");
    expect(entriesWith("SessionStart", START_CMD)).toHaveLength(1);
    expect(groupFor("SessionStart", SESSION_INTEL_SESSIONSTART_MATCHER)?.hooks).toEqual([{ type: "command", command: START_CMD, timeout: 5 }]);
    expect(groupFor("SessionStart", "compact")?.hooks).toEqual([{ type: "command", command: RESUME_CMD }]);
    for (const src of ["startup", "resume", "clear", "compact"]) expect(firesFor(src, START_CMD)).toBe(1);
  });

  it("normalizes groups that only COLLECTIVELY cover the sources into one execution per source", async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [
      { matcher: "startup|resume", hooks: [{ type: "command", command: START_CMD }] },
      { matcher: "clear|compact", hooks: [{ type: "command", command: START_CMD }, { type: "command", command: "/opt/other/hook" }] },
    ] } }));
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("registered");
    expect(entriesWith("SessionStart", START_CMD)).toHaveLength(1);
    expect(entriesWith("SessionStart", "/opt/other/hook")).toHaveLength(1);
    for (const src of ["startup", "resume", "clear", "compact"]) expect(firesFor(src, START_CMD)).toBe(1);
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("exists");
  });

  it("normalizes a canonical group PLUS a stray partial entry (the round-1 state) and duplicates inside a full-coverage group", async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [
      { matcher: SESSION_INTEL_SESSIONSTART_MATCHER, hooks: [{ type: "command", command: START_CMD, timeout: 5 }] },
      { matcher: "compact", hooks: [{ type: "command", command: START_CMD }, { type: "command", command: RESUME_CMD }] },
    ] } }));
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("registered");
    expect(entriesWith("SessionStart", START_CMD)).toHaveLength(1);
    expect(groupFor("SessionStart", "compact")?.hooks).toEqual([{ type: "command", command: RESUME_CMD }]);
    for (const src of ["startup", "resume", "clear", "compact"]) expect(firesFor(src, START_CMD)).toBe(1);

    writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [
      { matcher: "", hooks: [{ type: "command", command: START_CMD }, { type: "command", command: "/opt/other/hook" }, { type: "command", command: START_CMD }] },
    ] } }));
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("registered");
    expect(entriesWith("SessionStart", START_CMD)).toHaveLength(1);
    expect(entriesWith("SessionStart", "/opt/other/hook")).toHaveLength(1);
    for (const src of ["startup", "resume", "clear", "compact"]) expect(firesFor(src, START_CMD)).toBe(1);
    expect(await registerSessionIntelStartHook(settingsPath, BIN)).toBe("exists");
  });
});

describe("registerSessionIntelPromptHook", () => {
  it("registers one synchronous, 10 s entry under the empty matcher and is idempotent", async () => {
    expect(await registerSessionIntelPromptHook(settingsPath, BIN)).toBe("registered");
    expect(groups("UserPromptSubmit")).toEqual([{ matcher: "", hooks: [{ type: "command", command: PROMPT_CMD, timeout: INTELPROMPT_HOOK_TIMEOUT_SECONDS }] }]);
    expect(INTELPROMPT_HOOK_TIMEOUT_SECONDS).toBe(10);
    expect(await registerSessionIntelPromptHook(settingsPath, BIN)).toBe("exists");
    expect(entriesWith("UserPromptSubmit", PROMPT_CMD)).toHaveLength(1);
  });

  it("leaves a foreign UserPromptSubmit entry in place", async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "/opt/other/hook" }] }] } }));
    await registerSessionIntelPromptHook(settingsPath, BIN);
    expect(entriesWith("UserPromptSubmit", "/opt/other/hook")).toHaveLength(1);
    expect(entriesWith("UserPromptSubmit", PROMPT_CMD)).toHaveLength(1);
  });
});

describe("ensureSessionIntelHooksRegistered", () => {
  it("installs both hooks on a current install (upgrade path) and reports unchanged afterwards", async () => {
    writeCurrentInstallSettings();
    expect(await ensureSessionIntelHooksRegistered(settingsPath, BIN)).toEqual({ changed: true, action: "installed" });
    expect(groupFor("SessionStart", SESSION_INTEL_SESSIONSTART_MATCHER)?.hooks).toHaveLength(1);
    expect(groups("UserPromptSubmit")).toHaveLength(1);
    expect(await ensureSessionIntelHooksRegistered(settingsPath, BIN)).toEqual({ changed: false, action: "unchanged" });
  });

  it("removes both hooks when the global kill switch is set, leaving every other group; idempotent while disabled", async () => {
    writeCurrentInstallSettings();
    await ensureSessionIntelHooksRegistered(settingsPath, BIN);
    expect(isSessionIntelGloballyDisabled()).toBe(false);
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ sessionIntel: { enabled: false } }));
    expect(isSessionIntelGloballyDisabled()).toBe(true);

    expect(await ensureSessionIntelHooksRegistered(settingsPath, BIN)).toEqual({ changed: true, action: "removed" });
    expect(entriesWith("SessionStart", START_CMD)).toHaveLength(0);
    expect(entriesWith("UserPromptSubmit", PROMPT_CMD)).toHaveLength(0);
    expect(groupFor("SessionStart", "compact")?.hooks).toHaveLength(1);
    expect(groupFor("SessionStart", "resume")?.hooks).toHaveLength(1);
    expect(groups("PreCompact")).toHaveLength(1);
    expect(groups("Stop")).toHaveLength(1);
    expect(await ensureSessionIntelHooksRegistered(settingsPath, BIN)).toEqual({ changed: false, action: "unchanged" });
  });

  it("the limit-resume kill switch does not disable the intel hooks, and vice versa", async () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ limitResume: { enabled: false } }));
    expect(await ensureSessionIntelHooksRegistered(settingsPath, BIN)).toEqual({ changed: true, action: "installed" });
  });

  it("registers on fresh settings from scratch and returns unchanged with no resolvable bin", async () => {
    expect(await ensureSessionIntelHooksRegistered(settingsPath, BIN)).toEqual({ changed: true, action: "installed" });
    expect(groups("UserPromptSubmit")).toHaveLength(1);
    expect(groupFor("SessionStart", SESSION_INTEL_SESSIONSTART_MATCHER)?.hooks).toHaveLength(1);
  });
});

describe("legacy sweep for the intel hooks", () => {
  it("counts a legacy-basename UserPromptSubmit entry; the sweep removes both legacy intel entries and the reconcile installs the canonical ones", async () => {
    const legacyStart = formatHookCommand("/old/path/claudestory", INTELSTART_SUBCOMMAND);
    const legacyPrompt = formatHookCommand("/old/path/claudestory", INTELPROMPT_SUBCOMMAND);
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: SESSION_INTEL_SESSIONSTART_MATCHER, hooks: [{ type: "command", command: legacyStart, timeout: 5 }] }],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: legacyPrompt, timeout: 10 }, { type: "command", command: "/opt/other/hook" }] }],
      },
    }));
    const counts = await countLegacyHooks(BIN, settingsPath);
    expect(counts).toMatchObject({ UserPromptSubmit: 1, PreCompact: 0, Stop: 0, StopFailure: 0 });
    // The sweep only removes legacy entries (it never installs); the un-gated
    // reconcile is what puts the canonical entries back.
    expect(await sweepLegacyHooks(BIN, settingsPath)).toBe(2);
    expect(entriesWith("SessionStart", legacyStart)).toHaveLength(0);
    expect(entriesWith("UserPromptSubmit", legacyPrompt)).toHaveLength(0);
    expect(entriesWith("UserPromptSubmit", "/opt/other/hook")).toHaveLength(1);
    expect(await ensureSessionIntelHooksRegistered(settingsPath, BIN)).toEqual({ changed: true, action: "installed" });
    expect(groupFor("SessionStart", SESSION_INTEL_SESSIONSTART_MATCHER)?.hooks).toEqual([{ type: "command", command: START_CMD, timeout: 5 }]);
    expect(entriesWith("UserPromptSubmit", PROMPT_CMD)).toEqual([{ type: "command", command: PROMPT_CMD, timeout: 10 }]);
    expect(entriesWith("UserPromptSubmit", "/opt/other/hook")).toHaveLength(1);
    // Clean settings: nothing to count or sweep.
    expect((await countLegacyHooks(BIN, settingsPath)).UserPromptSubmit).toBe(0);
    expect(await sweepLegacyHooks(BIN, settingsPath)).toBe(0);
  });
});
