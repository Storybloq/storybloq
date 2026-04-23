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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("preCommandHousekeeping end-to-end", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `storybloq-housekeeping-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    process.env.HOME = tempDir;
    const skillDir = join(tempDir, ".claude", "skills", "story");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# stub\n", "utf-8");
    await writeFile(join(skillDir, ".storybloq-version"), "1.1.0\n", "utf-8");
    await mkdir(join(tempDir, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(tempDir, { recursive: true, force: true });
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
});
