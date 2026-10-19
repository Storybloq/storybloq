/**
 * ISS-1408: the validate helper runs one named claude (STORYBLOQ_TEST_CLAUDE,
 * else the one beside node), never whichever PATH finds first, refuses a
 * client that is misconfigured or older than the proven version, and on
 * failure names the claude that ran, its version and what validate printed.
 * Shim scripts stand in for the real client, so no real client runs here.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PATH_ENV, MIN_CLAUDE_VERSION, claudeValidate, resolveClaude } from "./claude-validate.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-shim-"));
  dirs.push(dir);
  return dir;
}

/** A claude shim in a fresh dir; every run touches `marker` so a test can tell whether it ran at all. */
function shim(versionLine: string, validateExit = 0, mode = 0o755): { dir: string; path: string; marker: string } {
  const dir = tempDir();
  const path = join(dir, "claude");
  const marker = join(dir, "ran");
  writeFileSync(
    path,
    `#!/bin/sh\ntouch "${marker}"\nif [ "$1" = "--version" ]; then echo "${versionLine}"; exit 0; fi\necho "SHIM-STDOUT-LINE ${dir}"\necho "SHIM-STDERR-LINE" >&2\nexit ${validateExit}\n`,
    { mode },
  );
  return { dir, path, marker };
}

const CURRENT = `${MIN_CLAUDE_VERSION} (Claude Code)`;

/** An env naming `claude` (or leaving the variable unset), with `pathFirst` ahead of the usual PATH. */
function envWith(claude: string | undefined, pathFirst?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[CLAUDE_PATH_ENV];
  if (claude !== undefined) env[CLAUDE_PATH_ENV] = claude;
  if (pathFirst !== undefined) env.PATH = `${pathFirst}:${process.env.PATH ?? ""}`;
  return env;
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  return "";
}

describe("claudeValidate (ISS-1408)", () => {
  it("returns validate's stdout when it passes", () => {
    const named = shim(CURRENT);
    expect(claudeValidate("/nowhere", envWith(named.path))).toBe(`SHIM-STDOUT-LINE ${named.dir}\n`);
  });

  it("on failure names the resolved claude, its version, the exit and both streams", () => {
    const named = shim(CURRENT, 1);
    const message = thrown(() => claudeValidate("/nowhere", envWith(named.path)));
    expect(message).toContain("claude plugin validate /nowhere failed (exit 1)");
    expect(message).toContain(`claude: ${named.path}`);
    expect(message).toContain(`version: ${CURRENT}`);
    expect(message).toContain(`stdout:\nSHIM-STDOUT-LINE ${named.dir}`);
    expect(message).toContain("stderr:\nSHIM-STDERR-LINE");
  });

  it("runs the named claude even when another claude is first on PATH", () => {
    const named = shim(CURRENT);
    const onPath = shim(CURRENT);
    expect(claudeValidate("/nowhere", envWith(named.path, onPath.dir))).toBe(`SHIM-STDOUT-LINE ${named.dir}\n`);
    expect(existsSync(onPath.marker)).toBe(false);
  });

  it("with the variable unset, runs the claude beside node, not the one first on PATH", () => {
    const beside = shim(CURRENT);
    const onPath = shim(CURRENT);
    const nodePath = join(beside.dir, "node");
    expect(resolveClaude(envWith(undefined, onPath.dir), nodePath)).toEqual({ found: true, path: beside.path, version: CURRENT });
    expect(claudeValidate("/nowhere", envWith(undefined, onPath.dir), nodePath)).toBe(`SHIM-STDOUT-LINE ${beside.dir}\n`);
    expect(existsSync(onPath.marker)).toBe(false);
  });

  it("with the variable unset and no claude beside node, reports not found and never runs the one on PATH", () => {
    const onPath = shim(CURRENT);
    const nodeDir = tempDir();
    const env = envWith(undefined, onPath.dir);
    const result = resolveClaude(env, join(nodeDir, "node"));
    expect(result.found).toBe(false);
    const reason = result.found ? "" : result.reason;
    expect(reason).toContain(CLAUDE_PATH_ENV);
    expect(reason).toContain(join(nodeDir, "claude"));
    expect(reason).toContain("PATH is not searched");
    expect(thrown(() => claudeValidate("/nowhere", env, join(nodeDir, "node")))).toBe(reason);
    expect(existsSync(onPath.marker)).toBe(false);
  });

  it("refuses a variable that is relative, missing or not executable, without falling back", () => {
    const onPath = shim(CURRENT);
    const beside = shim(CURRENT);
    const nodePath = join(beside.dir, "node");
    const notExecutable = shim(CURRENT, 0, 0o644);
    expect(thrown(() => resolveClaude(envWith("claude", onPath.dir), nodePath))).toMatch(/must be an absolute path/);
    expect(thrown(() => resolveClaude(envWith(join(tempDir(), "claude"), onPath.dir), nodePath))).toMatch(/is not an executable file/);
    expect(thrown(() => resolveClaude(envWith(notExecutable.path, onPath.dir), nodePath))).toMatch(/is not an executable file/);
    expect(existsSync(onPath.marker)).toBe(false);
    expect(existsSync(beside.marker)).toBe(false);
  });

  it("refuses a client that does not identify as Claude Code or is older than the proven version", () => {
    for (const line of ["9.9.9 (Shim Code)", "2.1.303", "Claude Code 2.1.303", "2.1.302 (Claude Code)", "2.0.999 (Claude Code)", "1.99.999 (Claude Code)"]) {
      const named = shim(line);
      expect(thrown(() => claudeValidate("/nowhere", envWith(named.path))), line).toMatch(/did not identify Claude Code|older than the 2\.1\.303/);
    }
  });

  it("accepts the proven version and anything newer, compared as numbers", () => {
    for (const line of [CURRENT, "2.1.1000 (Claude Code)", "2.10.0 (Claude Code)", "10.0.0 (Claude Code)"]) {
      const named = shim(line);
      expect(resolveClaude(envWith(named.path)), line).toEqual({ found: true, path: named.path, version: line });
    }
  });
});
