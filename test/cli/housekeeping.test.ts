/**
 * ISS-590 integration test: the real CLI startup path
 * (`preCommandHousekeeping`) must sweep legacy-basename hook entries
 * when the skill-version marker advances. This exercises the same
 * code path that `cli/index.ts:runCli` runs before dispatching the
 * user's command, so a fresh `npm install -g @storybloq/storybloq`
 * plus any normal invocation (e.g. `storybloq status`) self-heals
 * stale claudestory hooks without the user having to run
 * `storybloq setup-skill`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// T-534: housekeeping runs the usage-limit retirement, which cleans up the
// global dir and normalises sessions of the current project. Every path it can
// reach is pinned inside the fixture: HOME, the global dir, the project root
// (explicit, so discovery never walks up from the runner's cwd into a real
// checkout), the cwd itself, and CODEX_HOME: the skill auto-refresh writes
// $CODEX_HOME/skills/story, config.toml and the Codex hooks, so a run from
// inside Codex would otherwise reach the operator's install.
const ISOLATED_ENV = ["HOME", "PATH", "CODEX_HOME", "STORYBLOQ_GLOBAL_DIR", "STORYBLOQ_PROJECT_ROOT", "CLAUDESTORY_PROJECT_ROOT"] as const;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("preCommandHousekeeping end-to-end", () => {
  let tempDir: string;
  let projectDir: string;
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-housekeeping-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    savedEnv = Object.fromEntries(ISOLATED_ENV.map((k) => [k, process.env[k]]));
    savedCwd = process.cwd();
    projectDir = join(tempDir, "project");
    await mkdir(join(projectDir, ".story"), { recursive: true });
    await writeFile(join(projectDir, ".story", "config.json"), "{}\n", "utf-8");
    process.env.HOME = tempDir;
    process.env.CODEX_HOME = join(tempDir, ".codex");
    process.env.STORYBLOQ_GLOBAL_DIR = join(tempDir, ".claude", "storybloq");
    process.env.STORYBLOQ_PROJECT_ROOT = projectDir;
    delete process.env.CLAUDESTORY_PROJECT_ROOT;
    process.chdir(projectDir);
    const skillDir = join(tempDir, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# stub\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    await mkdir(join(tempDir, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    for (const k of ISOLATED_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("pins every retirement target inside the fixture before any housekeeping runs (T-534)", async () => {
    const { storybloqGlobalDir } = await import("../../src/core/global-config.js");
    const { discoverProjectRoot } = await import("../../src/core/project-root-discovery.js");
    const { skillTargets, codexConfigPath: markerCodexConfigPath } = await import("../../src/core/skill-version-marker.js");
    const { codexConfigPath, codexHooksPath } = await import("../../src/cli/commands/setup-skill.js");
    const { defaultSettingsPath } = await import("../../src/core/hook-migration.js");
    const { realpathSync } = await import("node:fs");
    const realTemp = realpathSync(tempDir);
    expect(inside(tempDir, storybloqGlobalDir())).toBe(true);
    // The skill auto-refresh and hook reconcile targets, Claude and Codex.
    for (const target of skillTargets()) expect(inside(tempDir, target.dir)).toBe(true);
    for (const path of [markerCodexConfigPath(), codexConfigPath(), codexHooksPath(), defaultSettingsPath()]) {
      expect(inside(tempDir, path)).toBe(true);
    }
    const root = discoverProjectRoot();
    expect(root).not.toBeNull();
    expect(inside(realTemp, realpathSync(root!))).toBe(true);
    expect(inside(realTemp, realpathSync(process.cwd()))).toBe(true);
  });

  it("preCommandHousekeeping sweeps legacy hooks end-to-end via the real CLI entrypoint", async () => {
    // Put a real-enough storybloq on PATH so resolveStorybloqBin
    // succeeds (non-null).
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;

    // Seed settings.json with three stale claudestory hook entries
    // matching the subcommands the sweep targets.
    const settingsPath = join(tempDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        PreCompact: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory session compact-prepare" },
        ]}],
        SessionStart: [{ matcher: "compact", hooks: [
          { type: "command", command: "/Users/fake/.nvm/versions/node/v20/bin/claudestory session resume-prompt" },
        ]}],
        Stop: [{ matcher: "", hooks: [
          { type: "command", command: "claudestory hook-status", async: true },
        ]}],
      },
    }, null, 2), "utf-8");

    // Invoke the exact function cli/index.ts runs before dispatching
    // any user command.
    const { preCommandHousekeeping } = await import("../../src/cli/housekeeping.js");
    await preCommandHousekeeping("1.1.6");

    // (a) marker advanced to the running version
    const marker = (await readFile(join(tempDir, ".claude", "skills", "story", ".storybloq-version"), "utf-8")).trim();
    expect(marker).toBe("1.1.6");

    // (b) all three claudestory entries are gone
    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      permissions?: unknown;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    };
    const allCommands = [
      ...(settings.hooks.PreCompact ?? []),
      ...(settings.hooks.SessionStart ?? []),
      ...(settings.hooks.Stop ?? []),
    ].flatMap((g) => g.hooks.map((h) => h.command));
    expect(allCommands.some((c) => c.includes("claudestory"))).toBe(false);

    // (c) canonical storybloq hooks were registered for each of the three
    //     hook types the sweep targets. Without this, users who had only
    //     claudestory hooks would end up with no hooks at all.
    expect(allCommands.some((c) => c === `${binPath} session compact-prepare`)).toBe(true);
    expect(allCommands.some((c) => c === `${binPath} session resume-prompt`)).toBe(true);
    expect(allCommands.some((c) => c === `${binPath} hook-status`)).toBe(true);

    // (d) unrelated top-level settings preserved
    expect(settings.permissions).toEqual({ allow: ["Bash(git status)"] });
  });

  async function seedBinAndHookFreeSettings(): Promise<{ binPath: string; settingsPath: string }> {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const binPath = join(binDir, "storybloq");
    await writeFile(binPath, "#!/bin/sh\n", "utf-8");
    await chmod(binPath, 0o755);
    process.env.PATH = binDir;
    const settingsPath = join(tempDir, ".claude", "settings.json");
    await writeFile(settingsPath, JSON.stringify({ model: "opus" }, null, 2), "utf-8");
    return { binPath, settingsPath };
  }

  it("threads `setup --skip-hooks` through housekeeping: no hooks installed", async () => {
    // The CLI entry point must honor the explicit opt-out end-to-end: the
    // version-refresh reconcile may not install hooks over hook-free settings.
    const { settingsPath } = await seedBinAndHookFreeSettings();
    const { preCommandHousekeeping } = await import("../../src/cli/housekeeping.js");
    await preCommandHousekeeping("1.1.6", ["setup", "--skip-hooks"]);

    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as { hooks?: Record<string, unknown> };
    expect(settings.hooks?.StopFailure).toBeUndefined();
    expect(settings.hooks?.SessionStart).toBeUndefined();
    expect((settings.hooks as Record<string, unknown> | undefined)?.UserPromptSubmit).toBeUndefined();
    // T-534: `--skip-hooks` also skips the retirement, so nothing is recorded.
    expect(existsSync(join(tempDir, ".claude", "storybloq", ".limit-retired-v1"))).toBe(false);
  });

  it("retires the limit hooks through housekeeping for an ordinary invocation and installs none (T-534)", async () => {
    const { binPath, settingsPath } = await seedBinAndHookFreeSettings();
    await writeFile(settingsPath, JSON.stringify({
      model: "opus",
      hooks: {
        StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: `${binPath} session limit-stop` }] }],
        SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: `${binPath} session resume-prompt` }] }],
      },
    }, null, 2), "utf-8");

    const { preCommandHousekeeping } = await import("../../src/cli/housekeeping.js");
    await preCommandHousekeeping("1.1.6", ["status"]);
    await preCommandHousekeeping("1.1.6", ["status"]);

    const settings = JSON.parse(await readFile(settingsPath, "utf-8")) as {
      model?: string;
      hooks?: { StopFailure?: unknown; SessionStart?: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(settings.model).toBe("opus");
    expect(settings.hooks?.StopFailure).toBeUndefined();
    expect((settings.hooks?.SessionStart ?? []).find((g) => g.matcher === "resume")).toBeUndefined();
    // T-499: the session-intel hooks still arrive through the same pass.
    const intelStart = (settings.hooks?.SessionStart ?? []).find((g) => g.matcher === "startup|resume|clear|compact");
    expect(intelStart?.hooks).toEqual([{ type: "command", command: `${binPath} session intel-start`, timeout: 5 }]);
    const prompt = (settings.hooks as { UserPromptSubmit?: Array<{ matcher: string; hooks: unknown[] }> } | undefined)?.UserPromptSubmit;
    expect(prompt).toEqual([{ matcher: "", hooks: [{ type: "command", command: `${binPath} session intel-prompt`, timeout: 10 }] }]);
    // The retirement finished once and recorded it.
    const marker = JSON.parse(await readFile(join(tempDir, ".claude", "storybloq", ".limit-retired-v1"), "utf-8")) as { cliVersion: string };
    expect(marker.cliVersion).toBe("1.1.6");
  });
});

// ISS-777: pure predicate deciding when the CLI skips preCommandHousekeeping
// (which does an awaited skill refresh + a background npm-registry fetch).
// Programmatic entry points (git merge driver, Claude hooks) must skip so they
// never phone the npm registry per invocation; interactive commands keep it.
describe("shouldSkipHousekeeping (ISS-777)", () => {
  it("skips the git merge driver", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["merge-driver", "%O", "%A", "%B"])).toBe(true);
  });

  it("skips the hook-status Stop hook", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["hook-status"])).toBe(true);
  });

  it("skips the hook-bus-tool PostToolUse hook (T-427)", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["hook-bus-tool"])).toBe(true);
  });

  it("skips session compact-prepare (PreCompact hook)", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["session", "compact-prepare"])).toBe(true);
  });

  it("skips session resume-prompt (SessionStart hook)", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["session", "resume-prompt"])).toBe(true);
  });

  it("skips session intel-start and intel-prompt (T-499 SessionStart and UserPromptSubmit hooks)", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["session", "intel-start"])).toBe(true);
    expect(shouldSkipHousekeeping(["session", "intel-prompt"])).toBe(true);
    // The query surface is interactive and keeps housekeeping.
    expect(shouldSkipHousekeeping(["session", "intel"])).toBe(false);
  });

  it("does NOT skip interactive session subcommands", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["session", "list"])).toBe(false);
    expect(shouldSkipHousekeeping(["session"])).toBe(false);
  });

  it("does NOT skip ordinary commands", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping(["status"])).toBe(false);
    expect(shouldSkipHousekeeping(["repair"])).toBe(false);
  });

  it("does NOT skip an empty argv", async () => {
    const { shouldSkipHousekeeping } = await import("../../src/cli/housekeeping.js");
    expect(shouldSkipHousekeeping([])).toBe(false);
  });
});
