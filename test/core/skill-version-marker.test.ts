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
import { readFile, writeFile, mkdir, rm, chmod, rename } from "node:fs/promises";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { shouldRefresh, readSkillMarker, SKILL_MARKER_FILE, SKILL_MARKER_MAX_BYTES } from "../../src/core/skill-version-marker.js";
import { probeRead } from "./health/subprocess-probe.js";

const MARKER_MODULE = fileURLToPath(new URL("../../src/core/skill-version-marker.ts", import.meta.url));

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

  it("autoRefreshSkillIfStale leaves the legacy hook types absent and installs no limit hooks (no legacy to migrate)", async () => {
    // User intentionally removed hooks or installed skill-only. When there is
    // nothing to migrate, the count-gated legacy sweep must NOT re-add the
    // PreCompact/SessionStart(compact)/Stop hooks. T-534: the usage-limit
    // hooks are retired, so the refresh installs none; only the session-intel
    // hooks reconcile un-gated.
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
    expect(settings.hooks?.StopFailure).toBeUndefined();
    // T-499: the session-intel hooks reconcile un-gated.
    expect(settings.hooks?.SessionStart).toEqual([
      { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: `${binPath} session intel-start`, timeout: 5 }] },
    ]);
    expect(settings.hooks?.UserPromptSubmit).toEqual([
      { matcher: "", hooks: [{ type: "command", command: `${binPath} session intel-prompt`, timeout: 10 }] },
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
    await writeFile(join(globalDir, "config.json"), JSON.stringify({ limitResume: { enabled: false }, sessionIntel: { enabled: false } }), "utf-8");
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
    // Stop was not migrated, so it stays absent, and the compact-matcher
    // group was not migrated either. T-534: no limit hook is installed; the
    // intel-start group is the only SessionStart entry (T-499, un-gated).
    expect(settings.hooks.Stop).toBeUndefined();
    expect(settings.hooks.SessionStart).toEqual([
      { matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: `${binPath} session intel-start`, timeout: 5 }] },
    ]);
    expect(settings.hooks.StopFailure).toBeUndefined();
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

// T-502: the marker read is bounded, so the shared self-heal path cannot hang
// on a FIFO planted at the marker's name or slurp an oversized replacement.
describe("readSkillMarker is bounded (T-502)", () => {
  it("exposes a cap and a stable file name", () => {
    expect(SKILL_MARKER_MAX_BYTES).toBe(65_536);
    expect(SKILL_MARKER_FILE).toBe(".storybloq-version");
  });

  // In a CHILD under a SIGKILL deadline: a blocking-read regression would
  // freeze the worker's event loop, so a Vitest timeout could never fire and
  // the suite would hang instead of failing.
  it("returns null for a FIFO at the marker path instead of blocking", { timeout: 40_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "storybloq-marker-fifo-"));
    try {
      const dir = join(home, ".claude", "skills", "story");
      mkdirSync(dir, { recursive: true });
      const marker = join(dir, SKILL_MARKER_FILE);
      if (spawnSync("mkfifo", [marker], { stdio: "ignore" }).status !== 0) return;
      const probe = probeRead({
        moduleFile: MARKER_MODULE,
        exportName: "readSkillMarker",
        path: "claude",
        timeoutMs: 20_000,
        env: { HOME: home },
      });
      expect(probe.timedOut).toBe(false);
      expect(probe.status).toBe(0);
      expect(probe.value).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns null for a marker over the cap", () => {
    const home = mkdtempSync(join(tmpdir(), "storybloq-marker-big-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = join(home, ".claude", "skills", "story");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SKILL_MARKER_FILE), "1".repeat(SKILL_MARKER_MAX_BYTES + 1));
      expect(readSkillMarker("claude")).toBeNull();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ISS-1233 (first half): the function-hooks switch follows the Mods refresh
//
// An upgrade that only runs `npm install -g` never reaches `storybloq setup`,
// so the version-marker refresh is the whole of what an existing install gets.
// It already re-copies the Mods; a copy the client is not allowed to load is
// inert, so the refresh writes the same settings switch the installer does,
// under the same rule: a value already in the file is never overwritten.
// ---------------------------------------------------------------------------

describe("the Mods refresh writes the function-hooks switch (ISS-1233)", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let originalCodexHome: string | undefined;
  let settingsPath: string;
  /** What the refresh said, so a failing assertion names the reason. */
  let err: string[];
  let stderrSpy: { mockRestore: () => void } | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-marker-fnhooks-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalCodexHome = process.env.CODEX_HOME;
    process.env.HOME = tempDir;
    // Pin CODEX_HOME inside the fixture too: a developer or CI shell with it
    // set would let this refresh reach state outside the fixture, and the
    // Codex targets must be judged against this HOME like the Claude one.
    process.env.CODEX_HOME = join(tempDir, ".codex");
    // No storybloq on PATH: the hook registrars have no binary to register
    // and write nothing, which is what lets the "leave it alone" case below
    // assert byte identity on the whole file.
    const emptyBin = join(tempDir, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    process.env.PATH = emptyBin;

    // A stale skill dir, so the refresh runs at all.
    const skillDir = join(tempDir, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# stub\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    // A Mods copy, so `modsInstalled()` is true and the refresh has one to
    // refresh. The refresh replaces this stub with the real copy.
    const modsHooks = join(tempDir, ".claude", "skills", "storybloq", "hooks");
    await mkdir(modsHooks, { recursive: true });
    await writeFile(join(modsHooks, "mod.ts"), "// stub\n", "utf-8");
    settingsPath = join(tempDir, ".claude", "settings.json");

    err = [];
    const { vi } = await import("vitest");
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(async () => {
    stderrSpy?.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await rm(tempDir, { recursive: true, force: true });
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doUnmock("../../src/core/mods-install.js");
  });

  /** The written value, or null, with the refresh's own log in the message. */
  async function writtenSwitch(): Promise<unknown> {
    if (!existsSync(settingsPath)) return null;
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as { env?: Record<string, unknown> };
    return settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS ?? null;
  }

  it("writes env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 when settings.json has no such key", async () => {
    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);

    // The refresh's own stderr rides along in the message: a failure here
    // then names its reason instead of being a bare missing file.
    expect(await writtenSwitch(), err.join("")).toBe("1");
  });

  it("writes the switch even when the Mods re-copy itself fails", async () => {
    // The copy on disk is loadable whether or not today's re-copy worked, and
    // a transient failure must not be what leaves the dashboard dark: the
    // next invocation finds the marker current and never returns here.
    // M-SWITCH-BEHIND-COPY puts the switch back inside the copy's try.
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../src/core/mods-install.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/core/mods-install.js")>();
      return { ...actual, installMods: async () => { throw new Error("disk full (simulated)"); } };
    });

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);

    expect(err.join("")).toContain("Mods refresh failed (non-fatal): disk full (simulated)");
    expect(await writtenSwitch(), err.join("")).toBe("1");
  });

  it("leaves an explicit \"0\" alone, rewriting nothing", async () => {
    // Unusual formatting on purpose: any rewrite reformats it, so this is a
    // byte comparison and not a value comparison.
    const original = `{\n    "env": {\n        "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "0"\n    }\n}\n`;
    await writeFile(settingsPath, original, "utf-8");

    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);

    expect(await readFile(settingsPath, "utf-8"), err.join("")).toBe(original);
  });
});

// ISS-1302: the package version does not move on a rebuild (the build injects
// package.json's version), so a copy refreshed only on a version change kept a
// day-old procedure after `duet spawn` shipped. The copy now follows a content
// fingerprint of the bundle, recorded in a sidecar beside the version marker;
// the version rules (upgrade refreshes, no downgrade, prerelease fails closed)
// are unchanged and the fingerprint decides only at an equal plain version.
describe("ISS-1302: the installed copy follows a content fingerprint of the bundled skill", () => {
  let tempDir: string;
  let bundle: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let originalCodexHome: string | undefined;
  let err: string[];
  let stderrSpy: { mockRestore: () => void } | null = null;
  const skillDir = () => join(tempDir, ".claude", "skills", "story");

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-fingerprint-${randomUUID()}`);
    bundle = join(tempDir, "bundle");
    await mkdir(join(bundle, "design"), { recursive: true });
    await writeFile(join(bundle, "SKILL.md"), "# bundle v1\n", "utf-8");
    await writeFile(join(bundle, "duet-mode.md"), "spawn text\n", "utf-8");
    await writeFile(join(bundle, "design", "design.md"), "design\n", "utf-8");
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalCodexHome = process.env.CODEX_HOME;
    process.env.HOME = tempDir;
    process.env.CODEX_HOME = join(tempDir, ".codex");
    // No storybloq on PATH: the refresh copies the skill and records the
    // markers; the hook reconciles it gates on a resolved binary stay out.
    const empty = join(tempDir, "empty-bin");
    await mkdir(empty, { recursive: true });
    process.env.PATH = empty;
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../src/cli/commands/setup-skill.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/cli/commands/setup-skill.js")>();
      return { ...actual, resolveSkillSourceDir: () => bundle };
    });
    err = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as never);
  });

  afterEach(async () => {
    stderrSpy?.mockRestore();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await rm(tempDir, { recursive: true, force: true });
    const { vi } = await import("vitest");
    vi.doUnmock("../../src/cli/commands/setup-skill.js");
    vi.resetModules();
  });

  /** A copy exactly as the running CLI would have written it for the current bundle. */
  async function installCurrent(version: string): Promise<void> {
    const { skillSourceFingerprint, SKILL_FINGERPRINT_FILE } = await import("../../src/core/skill-version-marker.js");
    await mkdir(join(skillDir(), "design"), { recursive: true });
    await writeFile(join(skillDir(), "SKILL.md"), await readFile(join(bundle, "SKILL.md")));
    await writeFile(join(skillDir(), "duet-mode.md"), await readFile(join(bundle, "duet-mode.md")));
    await writeFile(join(skillDir(), "design", "design.md"), await readFile(join(bundle, "design", "design.md")));
    await writeFile(join(skillDir(), ".storybloq-version"), `${version}\n`, "utf-8");
    await writeFile(join(skillDir(), SKILL_FINGERPRINT_FILE), `${skillSourceFingerprint(bundle)}\n`, "utf-8");
  }

  async function mtimes(): Promise<Map<string, number>> {
    const { stat, readdir } = await import("node:fs/promises");
    const out = new Map<string, number>();
    for (const rel of await readdir(skillDir(), { recursive: true })) out.set(String(rel), (await stat(join(skillDir(), String(rel)))).mtimeMs);
    return out;
  }

  it("shouldRefresh: at an equal plain version the fingerprint decides; every version rule is unchanged", () => {
    const a = "sha256:" + "a".repeat(64);
    const b = "sha256:" + "b".repeat(64);
    expect(shouldRefresh("1.1.6", "1.1.6", { installed: a, bundled: b })).toBe(true);
    expect(shouldRefresh("1.1.6", "1.1.6", { installed: a, bundled: a })).toBe(false);
    expect(shouldRefresh("1.1.6", "1.1.6", { installed: null, bundled: a })).toBe(true); // a copy from before the sidecar: once
    expect(shouldRefresh("1.1.6", "1.1.6", { installed: a, bundled: null })).toBe(false); // an unreadable bundle proves nothing
    expect(shouldRefresh("1.1.6", "1.1.6")).toBe(false); // no content known: the version alone decides, as before
    expect(shouldRefresh("1.1.0", "1.2.0", { installed: a, bundled: b })).toBe(false); // never a downgrade
    expect(shouldRefresh("1.2.0-beta", "1.2.0", { installed: a, bundled: b })).toBe(false); // prerelease fails closed
    expect(shouldRefresh("1.2.0", "1.1.6", { installed: a, bundled: a })).toBe(true); // an upgrade still refreshes
  });

  it("the fingerprint covers every bundled file by path and bytes", async () => {
    const { skillSourceFingerprint } = await import("../../src/core/skill-version-marker.js");
    const first = skillSourceFingerprint(bundle);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(skillSourceFingerprint(bundle)).toBe(first);
    await writeFile(join(bundle, "design", "design.md"), "desigm\n", "utf-8");
    const bumped = skillSourceFingerprint(bundle);
    expect(bumped).not.toBe(first);
    await writeFile(join(bundle, "design", "design.md"), "design\n", "utf-8");
    expect(skillSourceFingerprint(bundle)).toBe(first);
    await rename(join(bundle, "duet-mode.md"), join(bundle, "duet-mode2.md"));
    expect(skillSourceFingerprint(bundle)).not.toBe(first);
    expect(skillSourceFingerprint(join(tempDir, "missing"))).toBeNull();
  });

  it("bump one byte of a bundled file: the next invocation refreshes the copy at the same version and says why; the one after rewrites nothing", async () => {
    await installCurrent("1.1.6");
    const { autoRefreshSkillIfStale, skillSourceFingerprint, SKILL_FINGERPRINT_FILE } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false); // current copy: nothing to do
    await writeFile(join(bundle, "SKILL.md"), "# bundle v2\n", "utf-8");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);
    expect(await readFile(join(skillDir(), "SKILL.md"), "utf-8")).toBe("# bundle v2\n");
    expect((await readFile(join(skillDir(), SKILL_FINGERPRINT_FILE), "utf-8")).trim()).toBe(skillSourceFingerprint(bundle));
    expect(await readFile(join(skillDir(), ".storybloq-version"), "utf-8")).toBe("1.1.6\n"); // old readers still see one version line
    expect(err.join("")).toContain("refreshed skill files at ~/.claude/skills/story/ to match CLI v1.1.6 (same version, bundled skill changed)");
    const before = await mtimes();
    err.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false);
    expect(await mtimes()).toEqual(before);
    expect(err.join("")).not.toContain("refreshed skill files");
  });

  it("a copy with no sidecar, or a malformed one, at the same version is refreshed once and then left alone", async () => {
    await installCurrent("1.1.6");
    const { autoRefreshSkillIfStale, skillSourceFingerprint, SKILL_FINGERPRINT_FILE } = await import("../../src/core/skill-version-marker.js");
    await rm(join(skillDir(), SKILL_FINGERPRINT_FILE));
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);
    expect((await readFile(join(skillDir(), SKILL_FINGERPRINT_FILE), "utf-8")).trim()).toBe(skillSourceFingerprint(bundle));
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false);
    await writeFile(join(skillDir(), SKILL_FINGERPRINT_FILE), "not a fingerprint\n", "utf-8");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(true);
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false);
  });

  it("an older CLI never refreshes over a newer copy whatever the bundle holds; a version advance keeps its own wording", async () => {
    await installCurrent("1.2.0");
    await writeFile(join(bundle, "SKILL.md"), "# older bundle\n", "utf-8");
    const { autoRefreshSkillIfStale } = await import("../../src/core/skill-version-marker.js");
    expect(await autoRefreshSkillIfStale("1.1.6")).toBe(false);
    expect(await readFile(join(skillDir(), "SKILL.md"), "utf-8")).toBe("# bundle v1\n");
    expect(await autoRefreshSkillIfStale("1.3.0")).toBe(true);
    expect(err.join("")).toContain("to match CLI v1.3.0\n");
    expect(err.join("")).not.toContain("same version");
  });
});
