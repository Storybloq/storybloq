/**
 * ISS-570 G3 + ISS-590 tests for skill-version-marker.
 *
 * The auto-refresh path runs on every CLI invocation and must:
 *   (15) sweep legacy-basename hook entries exactly once when the
 *        marker advances from a prior version to the running CLI.
 *   (16) skip the sweep when resolveStorybloqBin() returns null
 *        (no canonical storybloq bin to re-register against).
 *   (17) not throw if the sweep itself throws; log to stderr and
 *        continue so the user's command is never blocked.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { shouldRefresh } from "../../src/core/skill-version-marker.js";

// ISS-1091 (R4/round-3): the auto-refresh path (isSkillStale) must never
// downgrade. shouldRefresh is the pure decision function, final round-3
// form -- fail closed on a non-plain running version, otherwise compare
// through the marker's numeric core plus a same-core suffix tiebreak so a
// release can finalize its own prerelease without ever refreshing backward.
describe("shouldRefresh (upgrade-only fix, round-3 final form)", () => {
  it("refreshes when the marker is missing", () => {
    expect(shouldRefresh("1.1.6", null)).toBe(true);
  });

  it("refreshes when the marker has no parseable numeric core at all (genuine garbage)", () => {
    expect(shouldRefresh("1.1.6", "not-a-version")).toBe(true);
  });

  it("does not refresh when running equals the marker (plain, equal)", () => {
    expect(shouldRefresh("1.1.6", "1.1.6")).toBe(false);
  });

  it("refreshes on a plain upgrade", () => {
    expect(shouldRefresh("1.2.0", "1.1.6")).toBe(true);
  });

  it("does not refresh on a plain downgrade", () => {
    expect(shouldRefresh("1.1.0", "1.2.0")).toBe(false);
  });

  it("fails closed: a prerelease-shaped running version never refreshes over a plain marker", () => {
    expect(shouldRefresh("1.13.0-beta", "1.13.0")).toBe(false);
  });

  it("closes the round-3 blocker: plain running version never refreshes over a HIGHER-core prerelease marker", () => {
    expect(shouldRefresh("1.13.0", "2.0.0-beta.1")).toBe(false);
  });

  it("refreshes when a plain release finalizes its own-core prerelease marker", () => {
    expect(shouldRefresh("2.0.0", "2.0.0-beta.1")).toBe(true);
  });
});

// Consequence-level: pins that isSkillStale actually CALLS shouldRefresh
// rather than its own independent comparison -- the direct matrix above
// proves the helper computes the right verdicts, this proves the public
// seam integrates it. Meaningful RED against today's code: the current
// strict-inequality check reports a downgrade as stale (refreshes
// backward), which is exactly the defect this fix closes.
describe("isSkillStale wired through shouldRefresh (consequence-level)", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-marker-stale-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not report stale on a downgrade (marker newer than the running CLI)", async () => {
    const skillDir = join(tempDir, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# stub\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), "1.2.0\n", "utf-8");

    const { isSkillStale } = await import("../../src/core/skill-version-marker.js");
    expect(isSkillStale("1.1.0", "claude")).toBe(false);
  });
});

describe("autoRefreshSkillIfStale with legacy hook sweep", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-marker-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalCodexHome = process.env.CODEX_HOME;
    process.env.HOME = tempDir;
    // Pre-create the skill dir + an out-of-date marker so isSkillStale
    // returns true. SKILL.md presence is required for isSkillStale to
    // proceed past the "skill not installed" guard.
    const skillDir = join(tempDir, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# stub\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    // Pre-create the settings dir for the sweep to write into.
    await mkdir(join(tempDir, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await rm(tempDir, { recursive: true, force: true });
    // Clear Vitest's module cache so dynamic imports inside the tested
    // function re-resolve against the real modules for the next test.
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doUnmock("../../src/core/hook-migration.js");
  });

  it("autoRefreshSkillIfStale invokes sweepLegacyHooks exactly once when marker advances", async () => {
    // Put a fake executable storybloq on PATH so resolveStorybloqBin
    // returns a non-null value.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    // Seed settings.json with stale claudestory entries.
    const settingsPath = join(tempDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
        SessionStart: [{ matcher: "compact", hooks: [
          { type: "command", command: "claudestory session resume-prompt" },
        ]}],
        Stop: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory hook-status", async: true },
        ]}],
      },
    }, null, 2), "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");
    expect(refreshed).toBe(true);

    // The marker should now reflect the new running version.
    const { readFile } = await import("node:fs/promises");
    const marker = (await readFile(join(tempDir, ".claude", "skills", "story", ".storybloq-version"), "utf-8")).trim();
    expect(marker).toBe("1.1.6");

    // The claudestory hook entries should be gone AND the canonical
    // storybloq entries should now be present (sweep + register).
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    };
    const pre = settings.hooks.PreCompact?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    const start = settings.hooks.SessionStart?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    const stop = settings.hooks.Stop?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    expect(pre.some((c) => c.includes("claudestory"))).toBe(false);
    expect(start.some((c) => c.includes("claudestory"))).toBe(false);
    expect(stop.some((c) => c.includes("claudestory"))).toBe(false);
    expect(pre).toContain(`${binPath} session compact-prepare`);
    expect(start).toContain(`${binPath} session resume-prompt`);
    expect(stop).toContain(`${binPath} hook-status`);
  });

  it("autoRefreshSkillIfStale leaves the legacy hook types absent but installs the limit hooks (no legacy to migrate)", async () => {
    // User intentionally removed hooks or installed skill-only. When there is
    // nothing to migrate, the count-gated legacy sweep must NOT re-add the
    // PreCompact/SessionStart(compact)/Stop hooks. The T-424 limit hooks are
    // the deliberate exception: ensureLimitHooksRegistered runs UNCONDITIONALLY
    // on version advance (the sweep can never install an absent hook type, so
    // upgrades would otherwise never reach the installed base); its opt-out is
    // the global kill switch, not hook absence.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const settingsPath = join(tempDir, ".claude", "settings.json");
    // Settings with unrelated top-level keys and NO hooks section at all.
    const original = JSON.stringify({
      permissions: { allow: ["Bash(git status)"] },
      model: "opus",
    }, null, 2);
    await writeFile(settingsPath, original, "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");
    expect(refreshed).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content) as {
      permissions: unknown;
      model: unknown;
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    // Unrelated keys preserved exactly.
    expect(settings.permissions).toEqual({ allow: ["Bash(git status)"] });
    expect(settings.model).toBe("opus");
    // Legacy hook types stay absent (user intent preserved)...
    expect(settings.hooks?.PreCompact).toBeUndefined();
    expect(settings.hooks?.Stop).toBeUndefined();
    // ...but the limit hooks are installed: StopFailure(rate_limit) plus the
    // SessionStart "resume" group and nothing else.
    expect(settings.hooks?.StopFailure).toEqual([
      { matcher: "rate_limit", hooks: [{ type: "command", command: `${binPath} session limit-stop` }] },
    ]);
    expect(settings.hooks?.SessionStart).toEqual([
      { matcher: "resume", hooks: [{ type: "command", command: `${binPath} session resume-prompt` }] },
    ]);
  });

  it("autoRefreshSkillIfStale does NOT install limit hooks when the global kill switch is set", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const globalDir = join(tempDir, "storybloq-global");
    await mkdir(globalDir, { recursive: true });
    await writeFile(join(globalDir, "config.json"), JSON.stringify({ limitResume: { enabled: false } }), "utf-8");
    const savedGlobal = process.env.STORYBLOQ_GLOBAL_DIR;
    process.env.STORYBLOQ_GLOBAL_DIR = globalDir;
    try {
      const settingsPath = join(tempDir, ".claude", "settings.json");
      await writeFile(settingsPath, JSON.stringify({ model: "opus" }, null, 2), "utf-8");

      const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
      expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);

      const { readFile } = await import("node:fs/promises");
      const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
      expect(settings.hooks).toBeUndefined();
    } finally {
      if (savedGlobal === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
      else process.env.STORYBLOQ_GLOBAL_DIR = savedGlobal;
    }
  });

  it("autoRefreshSkillIfStale honors reconcileLimitHooks:false (setup --skip-hooks not defeated by refresh)", async () => {
    // `setup --skip-hooks` threads reconcileLimitHooks:false through the pre-
    // command version refresh; a stale refresh must NOT install limit hooks over
    // hook-free settings, or the skip would be silently undone.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const settingsPath = join(tempDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ model: "opus" }, null, 2), "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    // The skill refresh still runs (returns true); only the limit-hook
    // reconciliation is suppressed.
    expect(await autoRefreshSkillIfStale("1.1.6", { reconcileLimitHooks: false })).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      model: unknown;
      hooks?: Record<string, unknown>;
    };
    expect(settings.model).toBe("opus"); // unrelated keys preserved
    expect(settings.hooks?.StopFailure).toBeUndefined();
    expect(settings.hooks?.SessionStart).toBeUndefined();
  });

  it("autoRefreshSkillIfStale refreshes a stale Codex ~/.agents skill install", async () => {
    await rm(join(tempDir, ".claude", "skills", "story"), { recursive: true, force: true });
    const codexSkillDir = join(tempDir, ".agents", "skills", "story");
    await mkdir(codexSkillDir, { recursive: true });
    await writeFile(join(codexSkillDir, "SKILL.md"), "# stale codex stub\n", "utf-8");
    await writeFile(join(codexSkillDir, ".storybloq-version"), "1.1.0\n", "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");

    expect(refreshed).toBe(true);
    const marker = (await readFile(join(codexSkillDir, ".storybloq-version"), "utf-8")).trim();
    const skill = await readFile(join(codexSkillDir, "SKILL.md"), "utf-8");
    expect(marker).toBe("1.1.6");
    expect(skill).toContain("Storybloq - Project Context");
  });

  it("autoRefreshSkillIfStale adds client identity without changing Codex approval choices", async () => {
    await rm(join(tempDir, ".claude", "skills", "story"), { recursive: true, force: true });
    const codexSkillDir = join(tempDir, ".agents", "skills", "story");
    await mkdir(codexSkillDir, { recursive: true });
    await writeFile(join(codexSkillDir, "SKILL.md"), "# stale codex stub\n", "utf-8");
    await writeFile(join(codexSkillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    const codexHome = join(tempDir, ".codex");
    await mkdir(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, [
      "[mcp_servers.storybloq]",
      'command = "storybloq"',
      'args = ["--mcp"]',
      "",
      "[mcp_servers.storybloq.tools.storybloq_status]",
      'approval_mode = "ask"',
      "",
    ].join("\n"), "utf-8");
    process.env.CODEX_HOME = codexHome;

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");

    expect(refreshed).toBe(true);
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain('STORYBLOQ_CLIENT = "codex"');
    expect(config).toContain("[mcp_servers.storybloq.tools.storybloq_status]\napproval_mode = \"ask\"");
    expect(config).not.toContain("[mcp_servers.storybloq.tools.storybloq_node_list]");
  });

  it("autoRefreshSkillIfStale does not create orphan Codex MCP config when the server is absent", async () => {
    await rm(join(tempDir, ".claude", "skills", "story"), { recursive: true, force: true });
    const codexSkillDir = join(tempDir, ".agents", "skills", "story");
    await mkdir(codexSkillDir, { recursive: true });
    await writeFile(join(codexSkillDir, "SKILL.md"), "# stale codex stub\n", "utf-8");
    await writeFile(join(codexSkillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    const codexHome = join(tempDir, ".codex");
    await mkdir(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    const original = [
      "[features]",
      "hooks = true",
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf-8");
    process.env.CODEX_HOME = codexHome;

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");

    expect(refreshed).toBe(true);
    const config = await readFile(configPath, "utf-8");
    expect(config).toBe(original);
  });

  it("autoRefreshSkillIfStale migrates existing Codex hooks to compact-aware matchers", async () => {
    await rm(join(tempDir, ".claude", "skills", "story"), { recursive: true, force: true });
    const codexSkillDir = join(tempDir, ".agents", "skills", "story");
    await mkdir(codexSkillDir, { recursive: true });
    await writeFile(join(codexSkillDir, "SKILL.md"), "# stale codex stub\n", "utf-8");
    await writeFile(join(codexSkillDir, ".storybloq-version"), "1.1.0\n", "utf-8");

    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const codexHome = join(tempDir, ".codex");
    await mkdir(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    const hooksPath = join(codexHome, "hooks.json");
    await writeFile(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "startup|resume|clear",
          hooks: [
            { type: "command", command: `${binPath} session resume-prompt --codex-hook-json` },
          ],
        }],
      },
    }, null, 2), "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");

    expect(refreshed).toBe(true);
    const settings = JSON.parse(await readFile(hooksPath, "utf-8")) as {
      hooks: { SessionStart: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    const oldGroup = settings.hooks.SessionStart.find((g) => g.matcher === "startup|resume|clear");
    const currentGroup = settings.hooks.SessionStart.find((g) => g.matcher === "startup|resume|clear|compact");
    expect(oldGroup).toBeUndefined();
    expect(currentGroup?.hooks.map((h) => h.command)).toEqual([
      `${binPath} session resume-prompt --codex-hook-json`,
    ]);
  });

  it("autoRefreshSkillIfStale does not create Codex hooks when none existed", async () => {
    await rm(join(tempDir, ".claude", "skills", "story"), { recursive: true, force: true });
    const codexSkillDir = join(tempDir, ".agents", "skills", "story");
    await mkdir(codexSkillDir, { recursive: true });
    await writeFile(join(codexSkillDir, "SKILL.md"), "# stale codex stub\n", "utf-8");
    await writeFile(join(codexSkillDir, ".storybloq-version"), "1.1.0\n", "utf-8");

    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const codexHome = join(tempDir, ".codex");
    await mkdir(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    const hooksPath = join(codexHome, "hooks.json");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");

    expect(refreshed).toBe(true);
    expect(existsSync(hooksPath)).toBe(false);
  });

  it("autoRefreshSkillIfStale heals fully when all three legacy hook types are present", async () => {
    // Regression: a user whose settings contained claudestory hooks for
    // all three types (the common "migrated from @anthropologies/claudestory
    // then uninstalled it" case) must end up with canonical storybloq
    // hooks across all three types after self-heal, not just claudestory
    // entries removed.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const settingsPath = join(tempDir, ".claude", "settings.json");
    // All three legacy hook types present, no storybloq hooks anywhere.
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
        SessionStart: [{ matcher: "compact", hooks: [
          { type: "command", command: "claudestory session resume-prompt" },
        ]}],
        Stop: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory hook-status", async: true },
        ]}],
      },
    }, null, 2), "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");
    expect(refreshed).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    };
    const pre = settings.hooks.PreCompact?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    const start = settings.hooks.SessionStart?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    const stop = settings.hooks.Stop?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    // claudestory gone AND canonical storybloq hooks present across all three types.
    expect(pre.some((c) => c.includes("claudestory"))).toBe(false);
    expect(start.some((c) => c.includes("claudestory"))).toBe(false);
    expect(stop.some((c) => c.includes("claudestory"))).toBe(false);
    expect(pre).toContain(`${binPath} session compact-prepare`);
    expect(start).toContain(`${binPath} session resume-prompt`);
    expect(stop).toContain(`${binPath} hook-status`);
  });

  it("autoRefreshSkillIfStale only registers canonical hooks for types that had legacy entries", async () => {
    // Partial-config regression: if the user has a legacy claudestory
    // PreCompact hook but NO SessionStart or Stop entries (deliberately
    // removed or never registered), the self-heal must migrate only
    // the PreCompact type and leave SessionStart / Stop absent.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const settingsPath = join(tempDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
        // No SessionStart, no Stop.
      },
    }, null, 2), "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");
    expect(refreshed).toBe(true);

    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: Record<string, unknown>
    };
    const pre = (settings.hooks.PreCompact as Array<{ hooks: Array<{ command: string }> }> | undefined)
      ?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    // claudestory gone, canonical PreCompact present.
    expect(pre.some((c) => c.includes("claudestory"))).toBe(false);
    expect(pre).toContain(`${binPath} session compact-prepare`);
    // Stop was not migrated, so it stays absent. SessionStart's ONLY entry is
    // the T-424 limit "resume" group (installed unconditionally on version
    // advance); the compact-matcher group was not migrated and stays absent.
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.hooks.SessionStart).toEqual([
      { matcher: "resume", hooks: [{ type: "command", command: `${binPath} session resume-prompt` }] },
    ]);
    expect(settings.hooks.StopFailure).toEqual([
      { matcher: "rate_limit", hooks: [{ type: "command", command: `${binPath} session limit-stop` }] },
    ]);
  });

  it("autoRefreshSkillIfStale skips hook sweep when resolveStorybloqBin returns null", async () => {
    // Empty PATH + HOME without any candidate dirs causes
    // resolveStorybloqBin to return null.
    process.env.PATH = "";

    const settingsPath = join(tempDir, ".claude", "settings.json");
    const beforeJson = JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
      },
    }, null, 2);
    await writeFile(settingsPath, beforeJson, "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");
    expect(refreshed).toBe(true);

    // claudestory entry should still be present: no bin means no sweep.
    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    };
    const cmds = settings.hooks.PreCompact?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    expect(cmds).toContain("claudestory session compact-prepare");
  });

  it("autoRefreshSkillIfStale preserves claudestory hook if registration throws after legacy was detected", async () => {
    // Ordering regression: register runs BEFORE sweep. If register
    // throws, the sweep never ran, so the user's original claudestory
    // hook is still there. Better than half-migrated-missing-canonical.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    const settingsPath = join(tempDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
      },
    }, null, 2), "utf-8");

    // Mock setup-skill so registerPreCompactHook throws.
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../src/cli/commands/setup-skill.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/cli/commands/setup-skill.js")>(
        "../../src/cli/commands/setup-skill.js"
      );
      return {
        ...actual,
        registerPreCompactHook: async () => { throw new Error("registration failed"); },
      };
    });

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    const refreshed = await autoRefreshSkillIfStale("1.1.6");
    expect(refreshed).toBe(true);

    // Legacy hook should still be present because sweep never ran.
    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    };
    const pre = settings.hooks.PreCompact?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
    expect(pre).toContain("claudestory session compact-prepare");

    vi.doUnmock("../../src/cli/commands/setup-skill.js");
  });

  it("autoRefreshSkillIfStale does not throw when sweep throws (logs + continues)", async () => {
    // Put a fake storybloq on PATH so the sweep branch is entered.
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    // Mock hook-migration's sweepLegacyHooks to throw while preserving the
    // constants that setup-skill imports during the refresh path.
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../src/core/hook-migration.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/core/hook-migration.js")>(
        "../../src/core/hook-migration.js",
      );
      return {
        ...actual,
        countLegacyHooks: async () => ({ PreCompact: 1, SessionStart: 0, Stop: 0 }),
        sweepLegacyHooks: async () => { throw new Error("boom"); },
      };
    });

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    // Must not throw.
    const refreshed = await autoRefreshSkillIfStale("1.1.6");
    expect(refreshed).toBe(true);
  });
});
