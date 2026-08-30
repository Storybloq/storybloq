import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { E2ECliFixture, runE2ECli, parseE2EJson, type RunE2ECliResult } from "./e2e-cli.js";

describe("E2ECliFixture", () => {
  let fixture: E2ECliFixture | undefined;
  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("isolates HOME/USERPROFILE/CODEX_HOME/STORYBLOQ_GLOBAL_DIR/XDG_CONFIG_HOME to fixture-owned scratch paths", async () => {
    fixture = await E2ECliFixture.create();
    const env = fixture.env();
    expect(env.HOME).toBe(fixture.home);
    expect(env.USERPROFILE).toBe(fixture.home);
    expect(env.CODEX_HOME).toBe(fixture.codexHome);
    expect(env.STORYBLOQ_GLOBAL_DIR).toBe(fixture.globalDir);
    expect(env.XDG_CONFIG_HOME).toBe(fixture.xdgConfigHome);
    // codexHome/globalDir/xdgConfigHome are its own scratch subdirs -- CODEX_HOME
    // isn't accidentally left equal to HOME (which would collapse the codexCompat
    // skill target's isolation back onto real HOME's own .codex fallback).
    expect(fixture.codexHome).not.toBe(fixture.home);
    expect(fixture.globalDir).not.toBe(fixture.home);
    expect(fixture.xdgConfigHome).not.toBe(fixture.home);
    // Never the real developer HOME.
    expect(fixture.home).not.toBe(homedir());
  });

  it("sets STORYBLOQ_DISABLE_WAKER_SPAWN=1 unconditionally", async () => {
    fixture = await E2ECliFixture.create();
    expect(fixture.env().STORYBLOQ_DISABLE_WAKER_SPAWN).toBe("1");
  });

  it("merges caller-supplied overrides that aren't protected vars", async () => {
    fixture = await E2ECliFixture.create();
    const env = fixture.env({ SHIM_LOG: "/tmp/whatever.log" });
    expect(env.SHIM_LOG).toBe("/tmp/whatever.log");
  });

  it("create() produces EXISTING, empty scratch directories, not just unrealized paths (P2)", async () => {
    fixture = await E2ECliFixture.create();
    for (const dir of [fixture.home, fixture.codexHome, fixture.globalDir, fixture.xdgConfigHome]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it.each(["HOME", "USERPROFILE", "CODEX_HOME", "STORYBLOQ_GLOBAL_DIR", "XDG_CONFIG_HOME"] as const)(
    "rejects any caller override of %s unconditionally (F12/P3)",
    async (key) => {
      fixture = await E2ECliFixture.create();
      expect(() => fixture!.env({ [key]: "/somewhere/else" })).toThrow(/not permitted/);
    },
  );

  it("even an override that resolves inside the fixture's own root is rejected (F12 -- no carve-out)", async () => {
    fixture = await E2ECliFixture.create();
    expect(() => fixture!.env({ HOME: fixture!.home })).toThrow(/not permitted/);
  });

  describe("recordResult / trackChild + assertNoHousekeepingNotices (F6/F8)", () => {
    it("does not throw when no recorded result contains a forbidden notice", async () => {
      fixture = await E2ECliFixture.create();
      fixture.recordResult({ stdout: '{"version":1,"data":{}}', stderr: "" });
      fixture.trackChild({ stdout: "ok", stderr: "" });
      expect(() => fixture!.assertNoHousekeepingNotices()).not.toThrow();
    });

    it("throws when a recorded stdout matches the skill-refresh notice pattern", async () => {
      fixture = await E2ECliFixture.create();
      fixture.recordResult({
        stdout: "storybloq: refreshed skill files at ~/.claude/skills/story/ to match CLI v9.9.9\n",
        stderr: "",
      });
      expect(() => fixture!.assertNoHousekeepingNotices()).toThrow(/skill refresh/);
    });

    it("throws when a recorded stderr matches the codex mcp config refresh notice pattern", async () => {
      fixture = await E2ECliFixture.create();
      fixture.recordResult({
        stdout: "",
        stderr: "storybloq: refreshed Codex Storybloq MCP config on version advance\n",
      });
      expect(() => fixture!.assertNoHousekeepingNotices()).toThrow(/codex mcp config refresh/);
    });

    it("throws when a recorded stderr matches the codex hook refresh notice pattern", async () => {
      fixture = await E2ECliFixture.create();
      fixture.recordResult({
        stdout: "",
        stderr: "storybloq: refreshed 2 Codex hook entries on version advance\n",
      });
      expect(() => fixture!.assertNoHousekeepingNotices()).toThrow(/codex hook refresh/);
    });

    it("trackChild is an alias for recordResult", async () => {
      fixture = await E2ECliFixture.create();
      fixture.trackChild({ stdout: "storybloq: refreshed skill files at x to match CLI v1.0.0\n", stderr: "" });
      expect(() => fixture!.assertNoHousekeepingNotices()).toThrow(/skill refresh/);
    });
  });
});

describe("runE2ECli", () => {
  let fixture: E2ECliFixture | undefined;
  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("spawns the built CLI under the fixture's isolated env and separates stdout/stderr", async () => {
    fixture = await E2ECliFixture.create();
    const result = runE2ECli(fixture, ["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stderr).toBe("");
  });

  it("auto-records the result on the fixture (no housekeeping notice under a fresh, empty HOME)", async () => {
    fixture = await E2ECliFixture.create();
    runE2ECli(fixture, ["--version"]);
    expect(() => fixture!.assertNoHousekeepingNotices()).not.toThrow();
  });

  it("throws spawnSync's own error (e.g. ENOENT) instead of silently returning a null status (P4)", async () => {
    fixture = await E2ECliFixture.create();
    // A nonexistent cwd makes spawnSync itself fail before the child ever runs.
    expect(() => runE2ECli(fixture!, ["--version"], { cwd: join(fixture!.root, "does-not-exist") })).toThrow(
      /ENOENT/,
    );
  });

  it("defaults stdin to ignored (no opts.input) without hanging", async () => {
    fixture = await E2ECliFixture.create();
    // --version never reads stdin; this proves the default ignore doesn't
    // otherwise change well-behaved output, and (per the 30s test timeout)
    // that the call doesn't hang waiting on an open, never-closed stdin pipe.
    const result = runE2ECli(fixture, ["--version"]);
    expect(result.status).toBe(0);
  });

  it("actually delivers opts.input to the child's stdin when provided (verified end-to-end, not assumed)", async () => {
    // Node's stdio[0]="ignore" SUPPRESSES `input` rather than being overridden
    // by it (confirmed directly against plain node, not just against dist/cli.js)
    // -- runE2ECli must switch off the ignore-stdin default whenever opts.input
    // is supplied, or every future input-driven call site would silently see
    // an empty stdin. `note update --stdin` is a real command that reads its
    // content from stdin, so this exercises the real code path, not a stand-in.
    fixture = await E2ECliFixture.create();
    // Scoped under fixture.root so afterEach's fixture.cleanup() removes it too --
    // no separate tmpdir to leak.
    const projectDir = join(fixture.root, "stdin-test-project");
    mkdirSync(projectDir, { recursive: true });
    const init = runE2ECli(fixture, ["init", "--name", "stdin-test", "--type", "npm"], { cwd: projectDir });
    expect(init.status, init.stderr).toBe(0);
    const create = runE2ECli(fixture, ["note", "create", "--content", "original", "--format", "json"], {
      cwd: projectDir,
    });
    expect(create.status, create.stderr).toBe(0);
    const noteId = parseE2EJson<{ data: { id: string } }>(create).data.id;

    const update = runE2ECli(fixture, ["note", "update", noteId, "--stdin", "--format", "json"], {
      cwd: projectDir,
      input: "piped content",
    });
    expect(update.status, update.stderr).toBe(0);

    const show = runE2ECli(fixture, ["note", "get", noteId, "--format", "json"], { cwd: projectDir });
    expect(parseE2EJson<{ data: { content: string } }>(show).data.content).toBe("piped content");
  });
});

describe("parseE2EJson", () => {
  it("parses stdout only, never stderr (fix direction d)", () => {
    const result: RunE2ECliResult = {
      status: 0,
      stdout: '{"version":1,"data":{"ok":true}}',
      stderr: "storybloq: refreshed skill files at ~/.claude/skills/story/ to match CLI v9.9.9\n",
    };
    expect(parseE2EJson<{ version: number; data: { ok: boolean } }>(result)).toEqual({
      version: 1,
      data: { ok: true },
    });
  });
});
